"""publish_one：手动发一条 + 故障注入（--topic / --raw / --clear）。

分两层测：
  * build_message() —— 参数变成字符串这一步，纯函数，不需要 broker
  * main() —— 拿一个假的 mqtt.Client 顶掉真连接，验证「实际发出去的
    topic / payload / qos / retain」是什么。真连 broker 的那一段不测
    （那是 paho 和 Mosquitto 的事，连真 broker 的自检在 broker_selftest.py）。

    py -3.14 -m unittest discover -s tests -t .
"""

from __future__ import annotations

import io
import json
import os
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from simulator import publish_one  # noqa: E402

OK = 0   # mqtt.MQTT_ERR_SUCCESS 的值


class FakeInfo:
    rc = OK

    def wait_for_publish(self, timeout=None):
        return True


class FakeClient:
    """顶掉真的 mqtt.Client：把发出去的东西记下来，别真连。"""

    last = None

    def __init__(self, *args, **kwargs):
        self.client_id = kwargs.get("client_id")
        self.published = []
        self.connected = None
        self.stopped = False
        FakeClient.last = self

    def username_pw_set(self, *args, **kwargs):
        pass

    def connect(self, host, port, keepalive=60):
        self.connected = (host, port)

    def loop_start(self):
        pass

    def loop_stop(self):
        self.stopped = True

    def disconnect(self):
        pass

    def publish(self, topic, payload, qos=0, retain=False):
        self.published.append({"topic": topic, "payload": payload,
                               "qos": qos, "retain": retain})
        return FakeInfo()


class PublishOneCase(unittest.TestCase):
    def setUp(self):
        # last 是类属性，上一个用例建的客户端会留在这儿 —— 不清掉，
        # 「压根没建客户端」这种断言就会看到上一位留下的那个。
        FakeClient.last = None

    def build(self, argv):
        return publish_one.build_message(publish_one.parse_args(argv))

    def run_main(self, argv):
        buf = io.StringIO()
        with mock.patch.object(publish_one.mqtt, "Client", FakeClient), \
                redirect_stdout(buf), redirect_stderr(buf):
            code = publish_one.main(argv)
        return code, buf.getvalue(), FakeClient.last


class TestBuildMessage(PublishOneCase):
    def test_正常一条的字段和状态(self):
        payload = json.loads(self.build(["--node", "dorm-b",
                                         "--temperature", "33", "--humidity", "55"]))
        self.assertEqual(payload["nodeId"], "dorm-b")
        self.assertEqual(payload["temperature"], 33.0)
        self.assertEqual(payload["humidity"], 55.0)
        self.assertEqual(payload["status"], "偏热")      # 由规则算出来
        self.assertEqual(payload["source"], "manual")    # 手动发的标记不一样
        self.assertEqual(payload["seq"], 0)              # 默认不参与序列

    def test_状态还是算出来的不是传进来的(self):
        # 想手工塞一个错的 status 也塞不进去：根本没有这个参数
        payload = json.loads(self.build(["--temperature", "31", "--humidity", "80"]))
        self.assertEqual(payload["status"], "偏热")      # 不是偏湿

    def test_seq和source能指定(self):
        payload = json.loads(self.build(["--temperature", "25", "--humidity", "60",
                                         "--seq", "7", "--source", "probe"]))
        self.assertEqual(payload["seq"], 7)
        self.assertEqual(payload["source"], "probe")

    def test_time能指定(self):
        payload = json.loads(self.build(["--temperature", "25", "--humidity", "60",
                                         "--time", "2026-09-22 20:00:00"]))
        self.assertEqual(payload["time"], "2026-09-22 20:00:00")

    def test_time格式不对时说人话(self):
        with self.assertRaises(ValueError) as ctx:
            self.build(["--temperature", "25", "--humidity", "60", "--time", "2026/09/22"])
        self.assertIn("--time 要写成", str(ctx.exception))

    def test_缺温湿度时说人话(self):
        with self.assertRaises(ValueError) as ctx:
            self.build(["--node", "dorm-a"])
        self.assertIn("--temperature", str(ctx.exception))
        self.assertIn("--raw", str(ctx.exception))       # 顺带告诉还有另一条路

    def test_只给温度也不够(self):
        with self.assertRaises(ValueError):
            self.build(["--temperature", "25"])

    def test_raw原样发出去一个字符都不改(self):
        raw = '  {这不是 json，还有前后空格}  '
        self.assertEqual(self.build(["--raw", raw]), raw)

    def test_raw不用给温湿度(self):
        self.assertEqual(self.build(["--raw", "{}"]), "{}")

    def test_raw时给了温湿度会被忽略并提示(self):
        buf = io.StringIO()
        with redirect_stderr(buf):
            message = self.build(["--temperature", "25", "--humidity", "60",
                                  "--raw", '{"a":1}'])
        self.assertEqual(message, '{"a":1}')             # raw 赢
        self.assertIn("--temperature/--humidity 被忽略", buf.getvalue())

    def test_clear发的是空消息(self):
        self.assertEqual(self.build(["--clear", "--node", "dorm-b"]), "")

    def test_clear和raw不能同时给(self):
        with self.assertRaises(ValueError) as ctx:
            self.build(["--clear", "--raw", "{}"])
        self.assertIn("别同时给", str(ctx.exception))


class TestTopic(unittest.TestCase):
    def test_默认按约定拼(self):
        args = publish_one.parse_args(["--node", "dorm-c", "--temperature", "25",
                                       "--humidity", "60"])
        self.assertIsNone(args.topic)                     # 没给就按约定
        from config import topic_for
        self.assertEqual(topic_for(args.node), "dormmate/v1/nodes/dorm-c/telemetry")

    def test_topic能覆盖(self):
        args = publish_one.parse_args(["--topic", "dormmate/v1/nodes/dorm-x/telemetry",
                                       "--raw", "{}"])
        self.assertEqual(args.topic, "dormmate/v1/nodes/dorm-x/telemetry")


class TestMain(PublishOneCase):
    def test_发出去的是约定topic和不保留(self):
        code, _, client = self.run_main(["--node", "dorm-b",
                                         "--temperature", "33", "--humidity", "55"])
        self.assertEqual(code, 0)
        self.assertEqual(client.connected, ("localhost", 1883))
        self.assertEqual(len(client.published), 1)
        sent = client.published[0]
        self.assertEqual(sent["topic"], "dormmate/v1/nodes/dorm-b/telemetry")
        self.assertEqual(sent["qos"], 1)
        self.assertFalse(sent["retain"])                  # 故障消息默认不留
        self.assertEqual(json.loads(sent["payload"])["nodeId"], "dorm-b")

    def test_topic能覆盖成别的(self):
        _, _, client = self.run_main(["--topic", "dormmate/v1/nodes/dorm-z/telemetry",
                                      "--raw", "{}"])
        self.assertEqual(client.published[0]["topic"], "dormmate/v1/nodes/dorm-z/telemetry")

    def test_坏的json照样发出去(self):
        # 这是 D4 的手段：工具不能替看板把关，坏数据要真的上线路
        _, _, client = self.run_main(["--node", "dorm-a", "--raw", "{这不是 json"])
        self.assertEqual(client.published[0]["payload"], "{这不是 json")

    def test_clear带retain不带就删不掉(self):
        _, _, client = self.run_main(["--clear", "--node", "dorm-b"])
        sent = client.published[0]
        self.assertEqual(sent["payload"], "")
        self.assertTrue(sent["retain"])
        self.assertEqual(sent["topic"], "dormmate/v1/nodes/dorm-b/telemetry")

    def test_retain要显式开(self):
        _, _, client = self.run_main(["--temperature", "25", "--humidity", "60",
                                      "--retain"])
        self.assertTrue(client.published[0]["retain"])

    def test_dry_run不连broker(self):
        buf = io.StringIO()
        with mock.patch.object(publish_one.mqtt, "Client", FakeClient), \
                redirect_stdout(buf):
            code = publish_one.main(["--temperature", "25", "--humidity", "60",
                                     "--dry-run"])
        self.assertEqual(code, 0)
        self.assertIsNone(FakeClient.last)                # 压根没建客户端
        self.assertIn("不连接 MQTT", buf.getvalue())

    def test_参数错了退出码2而且不发(self):
        code, out, client = self.run_main(["--node", "dorm-a"])
        self.assertEqual(code, 2)
        self.assertIsNone(client)
        self.assertIn("[错误]", out)

    def test_连不上时退出码1(self):
        class RefusingClient(FakeClient):
            def connect(self, host, port, keepalive=60):
                raise OSError("拒绝连接")

        buf = io.StringIO()
        with mock.patch.object(publish_one.mqtt, "Client", RefusingClient), \
                redirect_stdout(buf), redirect_stderr(buf):
            code = publish_one.main(["--temperature", "25", "--humidity", "60"])
        self.assertEqual(code, 1)
        self.assertIn("连不上", buf.getvalue())
        self.assertIn("mosquitto", buf.getvalue())        # 顺手告诉人怎么起 broker


if __name__ == "__main__":
    unittest.main(verbosity=2)
