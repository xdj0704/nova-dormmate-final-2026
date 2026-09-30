"""D4 故障注入：清单站不站得住，以及命令行那几条路。

这里**不连 broker**（连真 broker 的那种自检是 `simulator.inject_faults` 自己的
`--verify`）。测的是清单本身：

  1. **每一条喂给 `core.validate_message`，结论必须和清单上写的那个 `outcome`
     对得上。** 这条最重要 —— 那份清单是给人照着演示的，它和 core 各说各话的话，
     演示当场翻车，而且翻在别人面前。
  2. 每一条的参数 `publish_one` 真的吃得下（清单里写错一个 flag，这里就红）。
  3. 清单宣称的性质：第 3 条的 topic 节点和报文节点确实不一样、第 4 条的节点确实
     不在名单里、第 6 条确实是**合法** JSON 但不是对象、第 7 条真的落在订阅之外。
  4. 两个前端对「未知节点」的处理**不一样**，而且是设计如此：`dashboard/` 有名单、
     `web/` 没有。这条是拿源码查的 —— README 上写着这句话，哪天悄悄变了得有人知道。
  5. 命令行的几条路：`--list` / `--dry-run` 不连 broker、`--only` 会筛、给错条数返回 2。

    py -3.14 -m unittest discover -s tests -t .
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config  # noqa: E402
import core  # noqa: E402
from simulator import inject_faults, publish_one  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

OUTCOMES = {"reject", "pass", "silent", "unrouted"}


def fault_by_number(number: int) -> inject_faults.Fault:
    for f in inject_faults.FAULTS:
        if f.number == number:
            return f
    raise AssertionError(f"清单里没有 #{number}")


def verdict_of(fault: inject_faults.Fault) -> core.Verdict:
    return core.validate_message(inject_faults.topic_for(fault),
                                 inject_faults.payload_for(fault),
                                 config.NODE_IDS)


# --------------------------------------------------------------------------
# 1. 清单和 core 的判据对得上吗
# --------------------------------------------------------------------------

class TestFaultsMatchCore(unittest.TestCase):
    """清单上写着「core 会拒收」，core 就真的得拒收 —— 而且是**因为对的原因**。"""

    def test_reject_faults_are_really_rejected(self):
        for fault in inject_faults.FAULTS:
            if fault.outcome != "reject":
                continue
            with self.subTest(fault=fault.number):
                verdict = verdict_of(fault)
                self.assertFalse(verdict.ok, f"#{fault.number} 清单说该拒收，core 却收下了")
                self.assertFalse(verdict.ignored, f"#{fault.number} 不该走「清 retained」那条放行")
                self.assertIsNone(verdict.record)
                self.assertTrue(verdict.reasons, f"#{fault.number} 拒收了却没说理由")

    def test_reject_reasons_contain_the_listed_keyword(self):
        """只数「reject 上有几条」是不够的：三条都在 ≠ 三条都因为对的原因在。

        第 3 条（topic 和报文对不上）如果是因为 JSON 写坏了才被拒，光数条数
        照样绿 —— 而演示时那句理由是当着人念出来的。"""
        for fault in inject_faults.FAULTS:
            if fault.outcome != "reject":
                continue
            with self.subTest(fault=fault.number):
                text = "；".join(verdict_of(fault).reasons)
                self.assertIn(fault.keyword, text,
                              f"#{fault.number} 的理由里没有 {fault.keyword!r}：{text}")

    def test_pass_faults_are_really_accepted(self):
        for fault in inject_faults.FAULTS:
            if fault.outcome != "pass":
                continue
            with self.subTest(fault=fault.number):
                verdict = verdict_of(fault)
                self.assertTrue(verdict.ok, f"#{fault.number} 清单说该放行，core 却拒收了："
                                            f"{verdict.reasons}")
                self.assertIsNotNone(verdict.record)

    def test_silent_fault_is_the_retained_clear(self):
        """清 retained 那条：ok 是 False（它确实没有 record），但 ignored 是 True。"""
        fault = fault_by_number(8)
        self.assertEqual(fault.outcome, "silent")
        verdict = verdict_of(fault)
        self.assertFalse(verdict.ok)
        self.assertTrue(verdict.ignored)
        self.assertEqual(inject_faults.payload_for(fault), "")

    def test_unrouted_fault_would_be_rejected_if_it_ever_arrived(self):
        """第 7 条落在订阅之外、core 收不到 —— 但**假如**收到了，第 1 道判据会拦下它。

        这两件事要分开说：清单上写的是「收不到」，不是「拦住了」。写成后者的话，
        演示时会去找一条根本不存在的 reject。"""
        fault = fault_by_number(7)
        self.assertEqual(fault.outcome, "unrouted")
        verdict = verdict_of(fault)
        self.assertFalse(verdict.ok)
        self.assertIn("topic 形状不对", "；".join(verdict.reasons))


# --------------------------------------------------------------------------
# 2. 清单本身的性质
# --------------------------------------------------------------------------

class TestFaultList(unittest.TestCase):
    def test_numbers_are_unique_and_ascending(self):
        numbers = [f.number for f in inject_faults.FAULTS]
        self.assertEqual(numbers, sorted(numbers))
        self.assertEqual(len(numbers), len(set(numbers)))

    def test_every_fault_says_what_it_expects(self):
        for fault in inject_faults.FAULTS:
            with self.subTest(fault=fault.number):
                self.assertTrue(fault.title.strip())
                self.assertTrue(fault.expect.strip(), f"#{fault.number} 没写期望")
                self.assertIn(fault.outcome, OUTCOMES)
                self.assertTrue(fault.args, f"#{fault.number} 没有任何参数")
                for a in fault.args:
                    self.assertIsInstance(a, str)

    def test_only_reject_faults_carry_a_keyword(self):
        for fault in inject_faults.FAULTS:
            with self.subTest(fault=fault.number):
                if fault.outcome == "reject":
                    self.assertTrue(fault.keyword, f"#{fault.number} 是拒收却没写理由关键词")
                else:
                    self.assertEqual(fault.keyword, "", f"#{fault.number} 不拒收，却写了关键词")

    def test_there_is_a_control_case_that_passes(self):
        """全都能拦住，也可能是「什么都拦」—— 得有一条确定能通过的当对照。"""
        self.assertTrue(any(f.outcome == "pass" for f in inject_faults.FAULTS))

    def test_every_faults_args_are_accepted_by_publish_one(self):
        """参数怎么拼只有 publish_one 一个出处；清单里写错一个 flag 这里就红。

        `parse_args` 认不出来会直接 SystemExit —— 不用断言，跑得到就是吃得下。"""
        for fault in inject_faults.FAULTS:
            with self.subTest(fault=fault.number):
                payload = inject_faults.payload_for(fault)
                self.assertIsInstance(payload, str)

    def test_command_line_string_is_runnable(self):
        for fault in inject_faults.FAULTS:
            with self.subTest(fault=fault.number):
                self.assertTrue(fault.command.startswith(
                    "py -3.14 -m simulator.publish_one --"))

    def test_retain_is_only_on_for_the_clear_fault(self):
        """故障消息 retain 上去的话，之后每开一次看板都先看到那条坏数据。"""
        for fault in inject_faults.FAULTS:
            with self.subTest(fault=fault.number):
                if fault.outcome == "silent":
                    self.assertTrue(inject_faults.retain_for(fault), "清 retained 必须带 retain")
                else:
                    self.assertFalse(inject_faults.retain_for(fault),
                                     f"#{fault.number} 不该 retain")

    # ---- 每条宣称的性质，逐条验 ----

    def test_fault_1_is_really_not_json(self):
        with self.assertRaises(ValueError):
            json.loads(inject_faults.payload_for(fault_by_number(1)))

    def test_fault_2_is_valid_json_but_missing_fields(self):
        body = json.loads(inject_faults.payload_for(fault_by_number(2)))
        self.assertIsInstance(body, dict)          # 是合法 JSON
        self.assertNotIn("temperature", body)      # 只是缺东西
        self.assertNotIn("time", body)

    def test_fault_3_topic_and_payload_disagree(self):
        fault = fault_by_number(3)
        topic_node = inject_faults.topic_for(fault).split("/")[3]
        body = json.loads(inject_faults.payload_for(fault))
        self.assertNotEqual(topic_node, body["nodeId"])
        # 报文本身是完好的 —— 错的是它的来路，所以看板那边只警告不丢弃
        self.assertEqual(body["temperature"], 25)
        self.assertEqual(body["status"], "正常")

    def test_fault_4_uses_a_node_outside_the_list(self):
        fault = fault_by_number(4)
        self.assertNotIn("dorm-z", config.NODE_IDS)
        self.assertIn("dorm-z", fault.args)

    def test_fault_5_is_wild_but_legal_and_judged_hot(self):
        """第 5 条不是「坏报文」，是一条**合法但离谱**的读数。

        判据管的是「这是不是我们要的那种数据」（形状 / 类型 / 来路），不管这个数
        在物理上合不合理。所以 99℃ 会被如实收下、如实判成偏热 —— core 里没有
        任何范围校验。要拦的话得先定义"合理范围"是哪个范围、超了算拒收还是打标，
        那是另一套需求（手动录入那一侧有 -20~60 的范围校验，因为那是人手打的字）。"""
        fault = fault_by_number(5)
        self.assertEqual(fault.outcome, "pass")
        record = verdict_of(fault).record
        self.assertEqual(record["temperature"], 99.0)
        self.assertEqual(record["humidity"], 200.0)
        self.assertEqual(record["status"], "偏热")

    def test_fault_6_is_valid_json_but_not_an_object(self):
        body = json.loads(inject_faults.payload_for(fault_by_number(6)))
        self.assertIsInstance(body, list)

    def test_fault_7_topic_cannot_match_cores_subscription(self):
        """`+` 只匹配一层，所以段数不同就一定收不到 —— 前提是 pattern 里没有 `#`。

        有 `#` 的话段数规则就不成立了，所以那条也一起钉住。"""
        self.assertNotIn("#", config.TOPIC_PATTERN)
        topic = inject_faults.topic_for(fault_by_number(7))
        self.assertNotEqual(len(topic.split("/")),
                            len(config.TOPIC_PATTERN.split("/")))


# --------------------------------------------------------------------------
# 3. 两个前端对「未知节点」的处理不一样（设计如此）
# --------------------------------------------------------------------------

class TestFrontEndsDifferOnUnknownNode(unittest.TestCase):
    """节点名单在三个页面里的来路不一样：`web/` 自己收遥测攒，另两个只认快照。

    Step E3-2 之前，看板里有一份写死的 NODE_IDS 名单（三节点横向对比，版面就是
    三张卡），收到名单外的节点直接挡掉。那一轮看板改成**只订 core 的快照**，
    名单跟着没了 —— 「现在有哪几个节点」是 core 说了算（快照里的 nodes 数组），
    页面按那个数组画，一个不多一个不少。E3-3 的移动端走的是同一条路。

    所以差别从「谁有名单」变成了「谁在管节点」：`web/` 是从一条条遥测报文里
    **现攒**出节点清单（所以来几个画几个，多一个也画得下）；看板和移动端是等
    core 算好整帧发过来（所以它们连一个节点名都不认识）。

    README 上写着这句话，所以这里拿源码把它钉住 —— 哪天有人又在前端写死一份
    名单，这一条会红，提醒去把文档一起改。"""

    def test_dashboard_never_hardcodes_a_node_list(self):
        src = (ROOT / "dashboard" / "dashboard.js").read_text(encoding="utf-8")
        self.assertNotIn("NODE_IDS", src)
        # 卡片是按快照里的数组画的，节点名从报文里来
        self.assertIn("snapshot.nodes", src)

    def test_web_discovers_nodes_from_telemetry(self):
        src = (ROOT / "web" / "script.js").read_text(encoding="utf-8")
        self.assertNotIn("NODE_IDS", src)
        self.assertIn("telemetry", src)

    def test_mobile_renders_from_the_snapshot_too(self):
        """移动端（E3-3）：和看板同一个来路，而且**共用同一份判断**。

        这里查的是「有没有第二条实现」这件事 —— 页面各有各的皮，但
        「谁是重点、处理到哪一步」只能有一份代码。logic.js 里那几个是纯函数，
        复制一份到 mobile/ 下面也跑得起来，跑起来之后两个屏幕的说法迟早会岔开，
        而岔开的那一刻没有任何报错（两边都在正常显示，只是显示的结论不一样）。"""
        src = (ROOT / "mobile" / "mobile.js").read_text(encoding="utf-8")
        self.assertNotIn("NODE_IDS", src)
        self.assertIn("snapshot.nodes", src)
        # 复用的是看板那一份，不是第二份实现
        self.assertIn("from '../dashboard/logic.js'", src)
        for name in ("readSnapshot", "focusBanner", "actionState"):
            self.assertNotIn(f"function {name}", src, f"mobile.js 里不该有第二份 {name}")

    def test_mobile_page_has_no_way_to_type_data_in(self):
        """E3 的硬约束「禁止两边手动输入数据伪造同步效果」，落在页面上就是：
        这个页面里不能有任何地方能敲数字进去。

        查的是**去掉注释之后**的那一份：这个页面的注释里到处在讲「不许手动
        输入」「不要伪造同步」，拿原文去查，讲解这件事的句子自己就会命中。"""
        html = (ROOT / "mobile" / "index.html").read_text(encoding="utf-8")
        html = re.sub(r"<!--.*?-->", "", html, flags=re.S)
        for tag in ("<input", "<textarea", "<select", "<form"):
            self.assertNotIn(tag, html, f"移动端页面上出现了 {tag}：数据只能来自 core")


# --------------------------------------------------------------------------
# 4. 命令行
# --------------------------------------------------------------------------

class FakeInfo:
    def __init__(self):
        self.rc = 0

    def wait_for_publish(self, timeout=None):
        return True


class FakeMessage:
    def __init__(self, text):
        self.payload = text.encode("utf-8")


class FakeClient:
    """顶掉真的 mqtt.Client，必要时**顺便扮一下 core**。

    方法按订阅到的 topic 拼一条 reject 回来 —— 这样 run() 那一整条路（发出、
    等、比对 topic+payload、比理由关键词）都能在不起 broker 的情况下跑一遍。
    """

    last = None

    def __init__(self, *args, **kwargs):
        self.published = []
        self.subscribed = []
        self.on_subscribe = None        # paho 的 Client 建出来时也是 None
        self.on_message = None
        self.playing_core = False       # True 时 publish() 会立刻回一条 reject
        self.reason = "拒收"
        FakeClient.last = self

    def username_pw_set(self, *args, **kwargs):
        pass

    def connect(self, host, port, keepalive=30):
        self.host, self.port = host, port

    def loop_start(self):
        pass

    def loop_stop(self):
        pass

    def disconnect(self):
        pass

    def subscribe(self, topic, qos=0):
        self.subscribed.append((topic, qos))
        # 真 broker 是异步认订阅的；这里立刻认，等着的是 Watch.open 里那个 Event
        if self.on_subscribe:
            self.on_subscribe(self, None, 1, [0], None)

    def publish(self, topic, payload, qos=0, retain=False):
        self.published.append((topic, payload, qos, retain))
        if self.playing_core:
            body = {"time": "2026-09-22 20:00:00", "topic": topic,
                    "reasons": [self.reason], "payload": payload}
            if self.on_message:
                self.on_message(self, None, FakeMessage(json.dumps(body, ensure_ascii=False)))
        return FakeInfo()


class TestCommandLine(unittest.TestCase):
    def test_list_does_not_connect(self):
        def boom(*args, **kwargs):
            raise AssertionError("--list 不该连 broker")

        buf = io.StringIO()
        with mock.patch.object(inject_faults.mqtt, "Client", boom), redirect_stdout(buf):
            code = inject_faults.main(["--list"])
        self.assertEqual(code, 0)
        for fault in inject_faults.FAULTS:
            self.assertIn(fault.title, buf.getvalue())

    def test_dry_run_does_not_connect(self):
        def boom(*args, **kwargs):
            raise AssertionError("--dry-run 不该连 broker")

        buf = io.StringIO()
        with mock.patch.object(inject_faults.mqtt, "Client", boom), redirect_stdout(buf):
            code = inject_faults.main(["--dry-run"])
        self.assertEqual(code, 0)
        self.assertIn("Dry-run", buf.getvalue())

    def test_unknown_number_is_a_usage_error(self):
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(buf):
            code = inject_faults.main(["--only", "99"])
        self.assertEqual(code, 2)
        self.assertIn("--only", buf.getvalue())

    def test_connect_failure_says_how_to_start_the_broker(self):
        class Refusing(FakeClient):
            def connect(self, host, port, keepalive=30):
                raise OSError("connection refused")

        buf = io.StringIO()
        with mock.patch.object(inject_faults.mqtt, "Client", Refusing), \
                redirect_stdout(buf), redirect_stderr(buf):
            code = inject_faults.main([])
        self.assertEqual(code, 3)
        self.assertIn("mosquitto", buf.getvalue())


class TestRunAgainstAFakeCore(unittest.TestCase):
    """run() 那一整条路：发出、等、比对、判。core 用一个假的顶着。"""

    def setUp(self):
        # run() 会打印那份计划 —— 测试跑起来的时候不该把它混进 discover 的输出里
        self._out = io.StringIO()
        self._redir = redirect_stdout(self._out)
        self._redir.__enter__()

        self.client = FakeClient()
        self.watch = inject_faults.Watch("127.0.0.1", 1883)
        self.watch.client = self.client
        self.client.on_subscribe = self.watch._on_subscribe
        self.client.on_message = self.watch._on_message
        self.client.subscribe(config.REJECT_TOPIC, qos=1)

    def tearDown(self):
        self._redir.__exit__(None, None, None)

    def test_reject_fault_passes_when_core_answers(self):
        fault = fault_by_number(1)
        self.client.playing_core = True
        self.client.reason = fault.keyword
        passed, note = inject_faults.run(fault, self.watch, timeout=1.0, grace=0.1)
        self.assertTrue(passed, note)
        self.assertIn(fault.keyword, note)

    def test_reject_fault_fails_when_nobody_answers(self):
        """core 没起的时候，喊的不能是「拦住了」—— 得说清是没人拦。"""
        fault = fault_by_number(1)
        self.client.playing_core = False
        passed, note = inject_faults.run(fault, self.watch, timeout=0.2, grace=0.05)
        self.assertFalse(passed)
        self.assertIn("core.py", note)

    def test_reject_fault_fails_on_the_wrong_reason(self):
        """拒了，但拒错了原因 —— 也要红。光数条数是抓不住这件事的。"""
        fault = fault_by_number(4)                    # 该因为「未知节点」被拒
        self.client.playing_core = True
        self.client.reason = "JSON 解析失败"           # 却是别的原因
        passed, note = inject_faults.run(fault, self.watch, timeout=1.0, grace=0.1)
        self.assertFalse(passed)
        self.assertIn(fault.keyword, note)

    def test_pass_fault_fails_if_it_gets_rejected(self):
        fault = fault_by_number(0)
        self.client.playing_core = True
        passed, note = inject_faults.run(fault, self.watch, timeout=0.2, grace=0.2)
        self.assertFalse(passed)
        self.assertIn("不该被拒", note)

    def test_pass_fault_passes_when_nobody_rejects_it(self):
        fault = fault_by_number(5)
        self.client.playing_core = False
        passed, note = inject_faults.run(fault, self.watch, timeout=0.2, grace=0.05)
        self.assertTrue(passed, note)

    def test_unrouted_fault_says_it_never_arrives(self):
        fault = fault_by_number(7)
        self.client.playing_core = False
        passed, note = inject_faults.run(fault, self.watch, timeout=0.2, grace=0.05)
        self.assertTrue(passed, note)
        self.assertIn("收不到", note)

    def test_silent_fault_mentions_the_retained_log_line(self):
        fault = fault_by_number(8)
        self.client.playing_core = False
        passed, note = inject_faults.run(fault, self.watch, timeout=0.2, grace=0.05)
        self.assertTrue(passed, note)
        self.assertIn("保留", note)
        # 清 retained 必须真的带 retain 发出去，否则删不掉 broker 上那条
        self.assertTrue(self.client.published[0][3])

    def test_matching_is_by_topic_and_payload_not_by_count(self):
        """比对的是 topic + payload 全文，不是「reject 上有几条」。

        连着跑九条，只数条数的话：第 2 条没被拒、第 3 条被拒了两次，总数照样对。
        这条直接验那个纯函数。"""
        body = {"topic": "dormmate/v1/nodes/dorm-a/telemetry", "payload": "x"}
        self.assertTrue(inject_faults.reject_matches(body, body["topic"], "x"))
        self.assertFalse(inject_faults.reject_matches(body, body["topic"], "y"))
        self.assertFalse(inject_faults.reject_matches(body, "别的/topic", "x"))
        self.assertFalse(inject_faults.reject_matches({}, body["topic"], "x"))

    def test_reason_text_survives_a_broken_body(self):
        self.assertEqual(inject_faults.reason_text({}), "")
        self.assertEqual(inject_faults.reason_text({"reasons": None}), "")
        self.assertEqual(inject_faults.reason_text({"reasons": ["a", "b"]}), "a；b")


class TestWatchEatsGarbage(unittest.TestCase):
    """reject topic 上收到一条不是 JSON 的东西时，不能把脚本打挂。"""

    def test_non_json_message_is_ignored(self):
        watch = inject_faults.Watch("127.0.0.1", 1883)
        watch._on_message(None, None, FakeMessage("这不是 json"))
        self.assertEqual(len(watch.received), 1)
        self.assertIsNone(watch.received[0]["topic"])

    def test_json_that_is_not_an_object_is_ignored(self):
        watch = inject_faults.Watch("127.0.0.1", 1883)
        watch._on_message(None, None, FakeMessage("[1,2,3]"))
        self.assertEqual(watch.received[0]["payload"], None)

    def test_expect_returns_none_after_the_timeout(self):
        watch = inject_faults.Watch("127.0.0.1", 1883)
        self.assertIsNone(watch.expect(lambda b: True, timeout=0.05))


if __name__ == "__main__":
    unittest.main(verbosity=2)
