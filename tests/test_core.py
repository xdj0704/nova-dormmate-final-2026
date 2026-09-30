"""core.py 的测试：校验、拒收、状态机、快照、离线判定、遗嘱。

运行：
    py -3.14 -m unittest tests.test_core -v

**不连 broker。** 网络能不能通和「收到之后算得对不对」是两件事，
混在一起测的话，broker 没起来会把后者的测试一起带红，什么都看不出来。
所以这里递进去一个假 client，把 core 当成一台机器来摇：
喂报文，看它往哪条 topic 发了什么、内存里的状态变成了什么样。

真 broker 那条链路由 tests/broker_selftest.py 负责（它不属于单元测试，
名字也不以 test_ 开头，所以离线跑测试时不会被收进来）。
"""

from __future__ import annotations

import contextlib
import importlib.util
import inspect
import io
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import config  # noqa: E402
import core  # noqa: E402
import events  # noqa: E402
import rules  # noqa: E402

# 固定的"现在"。传进去而不是让代码读 time.time()，否则「30 秒算离线」
# 这条测试会跟着跑得多快而飘。
NOW = 1_700_000_000.0

NODES = ("dorm-a", "dorm-b", "dorm-c")

# 「一份最小的、合法的快照文件信息」长什么样 —— 字段清单**从 core 自己那张表
# 推出来**，不在这边再抄一份。抄一份的话，core 哪天给某个动作加了个必填字段，
# 这边还是老的，测试会红在一个跟它没关系的地方，而且报出来的理由（缺少某个
# 字段）看不出是测试没跟上。
#
# 只补**必填**那几个：可选字段（eventId / watermark / file）不给就是不给，
# 「缺席也算合法」正是它们存在的意思。值挑最小的合法值（1 / 一个能读的时刻），
# 不是挑一个好看的数字 —— 这条测试问的是「过不过得了」，不是「记下来长什么样」。
COMMAND_SAMPLE_FIELDS = {
    action: {
        key: ("2026-09-30 20:30:00" if key == "stamp" else 1)
        for key, _expected in fields
    }
    for action, fields in core.COMMAND_FIELDS_BY_ACTION.items()
}


def command_body(node_id: str = "dorm-a", action: str = "handle", **extra) -> str:
    """一条指令的 payload 文本。额外字段按动作补最小的那几个。"""
    body = {"nodeId": node_id, "action": action}
    body.update(COMMAND_SAMPLE_FIELDS.get(action, {}))
    body.update(extra)
    return json.dumps(body, ensure_ascii=False)


def payload_text(node_id: str = "dorm-a", temperature: float = 31,
                 humidity: float = 78, status: str = "偏热",
                 when: str = "2026-09-22 20:30:00", **extra) -> str:
    body = {
        "nodeId": node_id, "temperature": temperature, "humidity": humidity,
        "status": status, "time": when,
    }
    body.update(extra)
    return json.dumps(body, ensure_ascii=False)


def topic_of(node_id: str) -> str:
    """用 config.topic_for 拼 —— 测试里也不自己拼 topic。

    自己拼的话，topic 形状一改（改过一回了），测试可能还在用旧形状喂数据，
    而 core 拒收它、测试却以为是在测别的东西。
    """
    return config.topic_for(node_id)


class FakeClient:
    """把 publish / subscribe 记下来。core 想做什么，这里都留得下证据。"""

    def __init__(self) -> None:
        self.published: list[dict] = []
        self.subscribed: list[tuple] = []

    def publish(self, topic, payload=None, qos=0, retain=False, properties=None):
        self.published.append({
            "topic": topic, "payload": payload, "qos": qos, "retain": retain,
        })
        return None

    def subscribe(self, topic, qos=0, options=None, properties=None):
        self.subscribed.append((topic, qos))
        return (0, 1)

    # -- 查询用的 --------------------------------------------------------

    def on(self, topic: str) -> list[dict]:
        return [m for m in self.published if m["topic"] == topic]

    def last_on(self, topic: str) -> dict:
        got = self.on(topic)
        assert got, f"没有往 {topic} 发过东西"
        return got[-1]

    def state_payloads(self) -> list[dict]:
        return [json.loads(m["payload"]) for m in self.on(config.STATE_TOPIC)]


def make_core(**overrides) -> tuple[core.Core, FakeClient]:
    """按**真实的那份** core/config.json 造一个 core。

    不用手写的假配置：那样测的是假配置，而真正会出问题的是磁盘上那份
    （比如有人把 recoverConsecutiveNormal 改成 3 之后忘了跑测试）。
    """
    cfg = core.load_config()
    cfg.update(overrides)
    client = FakeClient()
    return core.Core(cfg, client=client, quiet=True), client


def deliver(c: core.Core, client: FakeClient, node_id: str, temperature: float,
            humidity: float, status: str, when: str) -> None:
    """走 on_message 这条真路径投一条报文 —— 和 broker 送过来时一模一样。

    和直接调 handle_message 的差别：on_message 多做两件事 ——
    把 payload 按 UTF-8 解码，以及打完数据之后调 report()。
    「解码」和「该不该打那一行重点」都只有在这条路上才测得到。
    """
    raw = payload_text(node_id, temperature, humidity, status, when).encode("utf-8")
    c.on_message(client, None, _Message(topic_of(node_id), raw))


class TestImportTrap(unittest.TestCase):
    """core.py 和 core/ 目录同名 —— 这个坑要有人盯着。

    Python 的查找顺序是「包优先于同名的 .py」：core/ 里一旦多了个
    __init__.py，`import core` 拿到的就是那个包，而且**不报错**。
    core.py 里几千行业务逻辑会整段失效，import 却"成功"了。
    （core/ 目前只有 config.json，那个目录本身没问题。）
    """

    def test_core_resolves_to_core_py(self):
        spec = importlib.util.find_spec("core")
        self.assertIsNotNone(spec)
        self.assertTrue(
            str(spec.origin).endswith("core.py"),
            f"import core 拿到的不是 core.py，而是 {spec.origin}"
            "—— core/ 目录下多半被加了个 __init__.py",
        )

    def test_core_dir_has_no_init(self):
        self.assertFalse(
            (ROOT / "core" / "__init__.py").exists(),
            "core/__init__.py 一出现，import core 就会静默地指向那个包",
        )

    def test_core_dir_only_holds_config(self):
        names = sorted(p.name for p in (ROOT / "core").iterdir())
        self.assertEqual(names, ["config.json"])


class TestParseTopic(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(core.parse_topic("dormmate/v1/nodes/dorm-a/telemetry"), "dorm-a")

    def test_rejects_old_three_segment(self):
        self.assertIsNone(core.parse_topic("dormmate/dorm-a/env"))

    def test_rejects_missing_v1(self):
        self.assertIsNone(core.parse_topic("dormmate/nodes/dorm-a/telemetry"))

    def test_rejects_wrong_tail(self):
        self.assertIsNone(core.parse_topic("dormmate/v1/nodes/dorm-a/env"))

    def test_rejects_extra_segment(self):
        self.assertIsNone(core.parse_topic("dormmate/v1/nodes/a/b/telemetry"))

    def test_rejects_empty_node(self):
        self.assertIsNone(core.parse_topic("dormmate/v1/nodes//telemetry"))

    def test_rejects_junk(self):
        for junk in (None, "", "随便什么", 123, "dormmate/v1/nodes/dorm-a"):
            with self.subTest(junk=junk):
                self.assertIsNone(core.parse_topic(junk))

    def test_agrees_with_config_topic_for(self):
        """反解出来的节点名，得和 config.topic_for 拼出来的对得上。"""
        for node_id in NODES:
            with self.subTest(node_id=node_id):
                self.assertEqual(core.parse_topic(topic_of(node_id)), node_id)


class TestValidate(unittest.TestCase):
    def test_happy_path_recomputes_status(self):
        verdict = core.validate_message(topic_of("dorm-a"), payload_text(), NODES)
        self.assertTrue(verdict.ok)
        self.assertEqual(verdict.record["status"], "偏热")
        self.assertEqual(verdict.notes, ())

    def test_status_is_recomputed_not_trusted(self):
        """报文里写「正常」，温湿度是 31/78 —— 结论必须是规则算的「偏热」。"""
        verdict = core.validate_message(
            topic_of("dorm-a"), payload_text(status="正常"), NODES
        )
        self.assertTrue(verdict.ok, "status 不一致不该拒收：温湿度本身是好的")
        self.assertEqual(verdict.record["status"], "偏热")
        self.assertEqual(len(verdict.notes), 1)
        self.assertIn("以规则为准", verdict.notes[0])

    def test_regression_data_through_validate(self):
        """四组回归数据从校验口走一遍，status 全部由规则算出。"""
        for temperature, humidity, expected in [
            (25, 60, "正常"), (16, 60, "偏冷"), (31, 60, "偏热"), (25, 80, "偏湿"),
        ]:
            with self.subTest(temperature=temperature, humidity=humidity):
                text = json.dumps({
                    "nodeId": "dorm-a", "temperature": temperature,
                    "humidity": humidity, "status": "正常",  # 故意全写错
                    "time": "2026-09-22 20:30:00",
                }, ensure_ascii=False)
                verdict = core.validate_message(topic_of("dorm-a"), text, NODES)
                self.assertTrue(verdict.ok)
                self.assertEqual(verdict.record["status"], expected)

    def test_bad_json(self):
        verdict = core.validate_message(topic_of("dorm-a"), "{不是 json", NODES)
        self.assertFalse(verdict.ok)
        self.assertIn("JSON 解析失败", verdict.reasons[0])

    def test_top_level_must_be_object(self):
        for text in ("null", "123", '"x"', "[1]", "true"):
            with self.subTest(text=text):
                verdict = core.validate_message(topic_of("dorm-a"), text, NODES)
                self.assertFalse(verdict.ok)
                self.assertIn("顶层不是对象", verdict.reasons[0])

    def test_missing_field(self):
        body = json.loads(payload_text())
        del body["humidity"]
        verdict = core.validate_message(
            topic_of("dorm-a"), json.dumps(body, ensure_ascii=False), NODES
        )
        self.assertFalse(verdict.ok)
        self.assertIn("缺少 humidity", verdict.reasons[0])

    def test_wrong_type(self):
        cases = [
            ("temperature", "31"), ("humidity", None), ("nodeId", 5),
            ("status", 3), ("time", 20260922),
        ]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                body = json.loads(payload_text())
                body[key] = value
                verdict = core.validate_message(
                    topic_of("dorm-a"), json.dumps(body, ensure_ascii=False), NODES
                )
                self.assertFalse(verdict.ok)
                self.assertTrue(
                    any(key in reason for reason in verdict.reasons),
                    f"理由里该提到 {key}：{verdict.reasons}",
                )

    def test_bool_is_not_a_number(self):
        """True 在 Python 里是 int 的子类 —— 不能当温度用。"""
        body = json.loads(payload_text())
        body["temperature"] = True
        verdict = core.validate_message(
            topic_of("dorm-a"), json.dumps(body, ensure_ascii=False), NODES
        )
        self.assertFalse(verdict.ok)

    def test_nan_and_infinity(self):
        """Python 的 json.loads 认 NaN / Infinity 这两个裸词。"""
        for token in ("NaN", "Infinity", "-Infinity"):
            with self.subTest(token=token):
                text = ('{"nodeId":"dorm-a","temperature":' + token
                        + ',"humidity":60,"status":"正常","time":"2026-09-22 20:30:00"}')
                verdict = core.validate_message(topic_of("dorm-a"), text, NODES)
                self.assertFalse(verdict.ok)
                self.assertIn("不是有限数", verdict.reasons[0])

    def test_time_format(self):
        for bad in ("2026/09/22 20:30:00", "2026-09-22", "2026-09-22 20:30",
                    "2026-13-45 10:99:99", "2026-09-22T20:30:00"):
            with self.subTest(bad=bad):
                verdict = core.validate_message(
                    topic_of("dorm-a"), payload_text(when=bad), NODES
                )
                self.assertFalse(verdict.ok)
                self.assertIn("time 格式不对", verdict.reasons[0])

    def test_unknown_node(self):
        verdict = core.validate_message(
            topic_of("dorm-z"), payload_text(node_id="dorm-z"), NODES
        )
        self.assertFalse(verdict.ok)
        self.assertIn("未知节点", verdict.reasons[0])

    def test_topic_and_payload_node_must_match(self):
        """这条在 core 这里比前端**严**：前端只警告，core 直接拒收。

        前端挂一条可疑数据只是不好看；core 收下来就算成真的了 ——
        算时长、排优先级、进快照，然后被所有前端读走，
        到那时候已经没有任何地方记得「它当初 topic 就不对」。
        """
        verdict = core.validate_message(
            topic_of("dorm-b"), payload_text(node_id="dorm-a"), NODES
        )
        self.assertFalse(verdict.ok)
        self.assertIn("topic 里是 dorm-b", verdict.reasons[0])
        self.assertIn("拒收", verdict.reasons[0])

    def test_bad_topic_shape_is_rejected(self):
        verdict = core.validate_message("dormmate/dorm-a/env", payload_text(), NODES)
        self.assertFalse(verdict.ok)
        self.assertIn("topic 形状不对", verdict.reasons[0])

    def test_reasons_are_all_collected(self):
        """一次把话说全，不让人改一条跑一趟。"""
        body = {"nodeId": "dorm-a", "temperature": "x", "status": 3}
        verdict = core.validate_message(
            topic_of("dorm-a"), json.dumps(body, ensure_ascii=False), NODES
        )
        self.assertFalse(verdict.ok)
        # 缺 humidity / time 两条，加上类型不对的两条，一共四条
        self.assertEqual(len(verdict.reasons), 4, verdict.reasons)

    def test_seq_and_source_are_optional(self):
        verdict = core.validate_message(topic_of("dorm-a"), payload_text(), NODES)
        self.assertNotIn("seq", verdict.record)
        self.assertNotIn("source", verdict.record)

        with_extra = core.validate_message(
            topic_of("dorm-a"), payload_text(seq=7, source="simulator"), NODES
        )
        self.assertEqual(with_extra.record["seq"], 7)
        self.assertEqual(with_extra.record["source"], "simulator")

    def test_seq_of_wrong_type_is_dropped_not_rejected(self):
        """附加字段类型不对就丢掉，不因此拒收 —— 那五个才是必需的。"""
        verdict = core.validate_message(
            topic_of("dorm-a"), payload_text(seq="7", source=9), NODES
        )
        self.assertTrue(verdict.ok)
        self.assertNotIn("seq", verdict.record)
        self.assertNotIn("source", verdict.record)


class TestRejectPublishing(unittest.TestCase):
    def test_reject_goes_to_the_reject_topic(self):
        c, client = make_core()
        c.handle_message(topic_of("dorm-a"), "{不是 json", now_wall=NOW)
        self.assertEqual(len(client.on(config.REJECT_TOPIC)), 1)

    def test_reject_is_not_retained(self):
        """日志不保留。保留住的话，后开的人一订阅就看到一条半小时前的
        「某某报文非法」，会以为现在还在出错。"""
        c, client = make_core()
        c.handle_message(topic_of("dorm-a"), "{不是 json", now_wall=NOW)
        self.assertIs(client.last_on(config.REJECT_TOPIC)["retain"], False)

    def test_reject_body_has_what_a_person_needs(self):
        c, client = make_core()
        c.handle_message(topic_of("dorm-b"), payload_text(node_id="dorm-a"), now_wall=NOW)
        body = json.loads(client.last_on(config.REJECT_TOPIC)["payload"])
        self.assertEqual(body["topic"], topic_of("dorm-b"))
        self.assertTrue(body["reasons"])
        self.assertIn("topic 里是 dorm-b", body["reasons"][0])
        self.assertEqual(len(body["time"]), 19)   # YYYY-MM-DD HH:mm:ss

    def test_long_payload_is_clipped(self):
        c, client = make_core()
        junk = json.dumps({"nodeId": "x" * 5000}, ensure_ascii=False)
        c.handle_message(topic_of("dorm-a"), junk, now_wall=NOW)
        body = json.loads(client.last_on(config.REJECT_TOPIC)["payload"])
        self.assertLess(len(body["payload"]), core.REJECT_PAYLOAD_MAX + 100)
        self.assertIn("后面还有", body["payload"])

    def test_rejected_message_touches_no_node(self):
        c, client = make_core()
        c.handle_message(topic_of("dorm-b"), "不是 json", now_wall=NOW)
        self.assertEqual(list(c.nodes["dorm-b"].history), [])
        self.assertIsNone(c.nodes["dorm-b"].latest)
        self.assertEqual(c.counters.rejected, 1)
        self.assertEqual(c.counters.received, 0)

    def test_mismatch_is_not_rejected_but_counted(self):
        """status 不一致：不丢，但要记账 —— 发布端坏了得有人看得见。"""
        c, client = make_core()
        verdict = c.handle_message(
            topic_of("dorm-a"), payload_text(status="正常"), now_wall=NOW
        )
        self.assertTrue(verdict.ok)
        self.assertEqual(c.counters.status_mismatch, 1)
        self.assertEqual(c.counters.received, 1)
        self.assertEqual(client.on(config.REJECT_TOPIC), [])


class TestRetainedClear(unittest.TestCase):
    """空 payload = 清掉一条保留消息（MQTT 的做法），不是报文。

    这一条是从演示现场冒出来的：README 里跑剧本的第 ① 步就是清 retained，
    而 core 当时把 broker 转发过来的那条空消息判成「JSON 解析失败」、
    发去了 reject topic —— 照着自己写的步骤做，看到三条查不出原因的假警报
    （排查表里恰好写着「reject 有流量就该查」）。
    """

    def test_empty_payload_is_not_rejected(self):
        c, client = make_core()
        verdict = c.handle_message(topic_of("dorm-a"), "", now_wall=NOW)

        self.assertTrue(verdict.ignored)
        self.assertFalse(verdict.ok)          # 没有 record，所以 ok 不能是 True
        self.assertIsNone(verdict.record)
        self.assertEqual(client.on(config.REJECT_TOPIC), [])
        self.assertEqual(c.counters.rejected, 0)
        self.assertEqual(c.counters.received, 0)
        self.assertEqual(c.counters.retained_cleared, 1)

    def test_it_touches_no_node(self):
        """**不改节点状态** —— 它说的是「broker 存的那份删了」，
        跟这个宿舍现在什么状况一点关系都没有。"""
        c, client = make_core()
        c.handle_message(topic_of("dorm-a"), payload_text(), now_wall=NOW)
        before = list(c.nodes["dorm-a"].history)

        c.handle_message(topic_of("dorm-a"), "", now_wall=NOW)

        self.assertEqual(list(c.nodes["dorm-a"].history), before)
        self.assertEqual(c.nodes["dorm-a"].abnormal_count, 1)  # 那一段还开着

    def test_it_does_republish_the_snapshot(self):
        """但**要重发一次快照** —— E3 起这条和原来相反了。

        原来这里断言的是「不发快照」（那时快照里只有节点的东西，清 retained
        和它们无关）。现在快照里带着 counters，这一次 retain_cleared 加了一，
        而前端只订快照：不重发的话页面上那个数就停在上一回的值上，直到下一条
        遥测才跳 —— 中间那一段正好是「刚清完 retained、页面上还写着收到过几条」。
        这条测试跟着行为一起改了，不是为了让它变绿。
        """
        c, client = make_core()
        c.handle_message(topic_of("dorm-a"), payload_text(), now_wall=NOW)
        count = len(client.state_payloads())

        c.handle_message(topic_of("dorm-a"), "", now_wall=NOW)

        self.assertEqual(len(client.state_payloads()), count + 1)
        self.assertEqual(client.state_payloads()[-1]["counters"]["retainedCleared"], 1)
        # 但节点那部分一个字没变 —— 「不改节点」和「重发快照」是两件事
        self.assertEqual(client.state_payloads()[-1]["nodes"],
                         client.state_payloads()[-2]["nodes"])

    def test_whitespace_is_still_a_bad_message(self):
        """只认长度为 0。空白字符不是「清 retained」，那是真写坏了。"""
        c, client = make_core()
        verdict = c.handle_message(topic_of("dorm-a"), "   ", now_wall=NOW)

        self.assertFalse(verdict.ignored)
        self.assertFalse(verdict.ok)
        self.assertEqual(len(client.on(config.REJECT_TOPIC)), 1)
        self.assertEqual(c.counters.retained_cleared, 0)

    def test_bad_topic_is_still_a_topic_error(self):
        """topic 形状还是先判 —— 顺序是刻意的：先确认这条消息是不是我们这一路的。
        """
        verdict = core.validate_message(
            "dormmate/dorm-a/env", "", NODES
        )
        self.assertFalse(verdict.ignored)
        self.assertIn("topic 形状不对", verdict.reasons[0])

    def test_the_log_line_says_retained_not_rejected(self):
        c, client = make_core()
        c.quiet = False
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            c.on_message(client, None, _Message(topic_of("dorm-a"), b""))

        printed = out.getvalue()
        self.assertIn("[保留]", printed)
        self.assertNotIn("[拒绝]", printed)
        self.assertIn("保留消息被清掉了", printed)

    def test_snapshot_counts_it(self):
        """received 和 rejected 都不动，但也不该凭空少一条 —— 计数里看得见。"""
        c, client = make_core()
        c.handle_message(topic_of("dorm-a"), "", now_wall=NOW)

        counters = c.snapshot(now_wall=NOW)["counters"]
        self.assertEqual(counters["retainedCleared"], 1)
        self.assertEqual(counters["received"], 0)
        self.assertEqual(counters["rejected"], 0)


class TestNodeStateMachine(unittest.TestCase):
    def test_one_abnormal_starts_a_run(self):
        c, _ = make_core()
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b"), now_wall=NOW)
        node = c.nodes["dorm-b"]
        self.assertEqual(node.abnormal_count, 1)
        self.assertEqual(node.abnormal_start, core.parse_time("2026-09-22 20:30:00"))

    def test_run_continues_and_start_does_not_move(self):
        c, _ = make_core()
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b", when="2026-09-22 20:30:00"), now_wall=NOW)
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b", when="2026-09-22 20:35:00"), now_wall=NOW)
        node = c.nodes["dorm-b"]
        self.assertEqual(node.abnormal_count, 2)
        self.assertEqual(node.duration_seconds(), 300.0)

    def test_status_change_inside_the_run_is_still_one_run(self):
        """段内从偏热变偏湿不算新的一段 —— 统计的是「连续异常了多久」。"""
        c, _ = make_core()
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b", when="2026-09-22 20:30:00"), now_wall=NOW)
        c.handle_message(
            topic_of("dorm-b"),
            payload_text("dorm-b", 25, 80, "偏湿", when="2026-09-22 20:34:00"),
            now_wall=NOW,
        )
        node = c.nodes["dorm-b"]
        self.assertEqual(node.abnormal_count, 2)
        self.assertEqual(node.duration_seconds(), 240.0)

    def test_recovery_needs_n_consecutive_normals(self):
        """核心要求：恢复判据是**连续 N 条正常**，不是一条正常。"""
        c, _ = make_core(recoverConsecutiveNormal=3)
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b"), now_wall=NOW)
        for i, minute in enumerate(("20:31:00", "20:32:00"), start=1):
            c.handle_message(
                topic_of("dorm-b"),
                payload_text("dorm-b", 25, 60, "正常", when=f"2026-09-22 {minute}"),
                now_wall=NOW,
            )
            with self.subTest(normal_count=i):
                self.assertTrue(
                    c.nodes["dorm-b"].is_abnormal(),
                    f"只来了 {i} 条正常，还没到 3 条，这一段不算结束",
                )
        c.handle_message(
            topic_of("dorm-b"),
            payload_text("dorm-b", 25, 60, "正常", when="2026-09-22 20:33:00"),
            now_wall=NOW,
        )
        node = c.nodes["dorm-b"]
        self.assertEqual(node.abnormal_count, 0)
        self.assertIsNone(node.abnormal_start)
        self.assertEqual(node.duration_seconds(), 0.0)

    def test_abnormal_in_the_middle_of_the_streak_resets_it(self):
        """「异常 -> 正常 -> 异常」：连续正常计数清零，这一段的起点不动。

        这正是「连续」两个字的含义：中间断了一次，那 N 条就得重新数。
        """
        c, _ = make_core(recoverConsecutiveNormal=3)
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b", when="2026-09-22 20:30:00"), now_wall=NOW)
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b", 25, 60, "正常", when="2026-09-22 20:31:00"), now_wall=NOW)
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b", 25, 60, "正常", when="2026-09-22 20:32:00"), now_wall=NOW)
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b", when="2026-09-22 20:33:00"), now_wall=NOW)
        node = c.nodes["dorm-b"]
        self.assertEqual(node.consecutive_normal, 0)
        self.assertEqual(node.abnormal_count, 2, "这一条算同一段里的第 2 条异常")
        self.assertEqual(
            node.abnormal_start, core.parse_time("2026-09-22 20:30:00"),
            "起点不该被后来的这条改写",
        )

    def test_run_ends_then_a_new_one_starts_from_scratch(self):
        c, _ = make_core(recoverConsecutiveNormal=1)
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b", when="2026-09-22 20:30:00"), now_wall=NOW)
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b", 25, 60, "正常", when="2026-09-22 20:31:00"), now_wall=NOW)
        self.assertFalse(c.nodes["dorm-b"].is_abnormal())
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b", when="2026-09-22 20:40:00"), now_wall=NOW)
        node = c.nodes["dorm-b"]
        self.assertEqual(node.abnormal_count, 1)
        self.assertEqual(node.abnormal_start, core.parse_time("2026-09-22 20:40:00"))

    def test_normal_node_is_not_abnormal(self):
        c, _ = make_core()
        c.handle_message(topic_of("dorm-a"), payload_text("dorm-a", 25, 60, "正常"), now_wall=NOW)
        node = c.nodes["dorm-a"]
        self.assertFalse(node.is_abnormal())
        self.assertEqual(node.duration_seconds(), 0.0)

    def test_no_data_status_is_none_not_normal(self):
        """一条数据都没收到 ≠ 正常。默认成「正常」的话，看板上三个节点
        全是绿的，而实际上一条数据都没来过 —— 最坏的一种「看着一切正常」。"""
        c, _ = make_core()
        self.assertIsNone(c.nodes["dorm-a"].status)
        snapshot = c.snapshot(NOW)
        entry = [n for n in snapshot["nodes"] if n["nodeId"] == "dorm-a"][0]
        self.assertIsNone(entry["status"])
        self.assertIsNone(entry["temperature"])
        self.assertFalse(entry["online"])
        self.assertIsNone(entry["durationText"])

    def test_history_is_capped(self):
        c, _ = make_core(historyMax=3)
        for i in range(5):
            c.handle_message(
                topic_of("dorm-a"),
                payload_text("dorm-a", 25, 60, "正常", when=f"2026-09-22 20:3{i}:00"),
                now_wall=NOW,
            )
        self.assertEqual(len(c.nodes["dorm-a"].history), 3)
        self.assertEqual(c.nodes["dorm-a"].latest["time"], "2026-09-22 20:34:00")

    def test_history_only_grows_for_that_node(self):
        """往 dorm-b 发消息，dorm-a / dorm-c 的历史一个字节都不许变。"""
        c, _ = make_core()
        before = {n: list(c.nodes[n].history) for n in NODES}
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b"), now_wall=NOW)
        self.assertEqual(list(c.nodes["dorm-a"].history), before["dorm-a"])
        self.assertEqual(list(c.nodes["dorm-c"].history), before["dorm-c"])
        self.assertEqual(len(c.nodes["dorm-b"].history), 1)


class TestRecoveringNodeView(unittest.TestCase):
    """恢复路上（已经开始收正常、还没凑够 N 条）的节点，交给排序的是什么。

    这一段的坑很隐蔽：`status` 取最新那条读数的话，一个还在异常里的宿舍
    理由会变成「已连续正常 7 分钟（3 次），持续时间最长」—— 话自相矛盾，
    而且**不报错**。所以这里钉死：排序看的是这一段异常的性质。
    """

    def feed(self, c, node_id, rows):
        for temperature, humidity, when in rows:
            c.handle_message(
                topic_of(node_id),
                payload_text(node_id, temperature, humidity,
                             core.rules.judge_status(temperature, humidity), when),
                now_wall=NOW,
            )

    def test_view_keeps_the_runs_status_not_the_latest_reading(self):
        c, _ = make_core(recoverConsecutiveNormal=3)
        self.feed(c, "dorm-b", [
            (31, 78, "2026-09-22 20:00:00"),
            (25, 60, "2026-09-22 20:01:00"),   # 恢复路上第 1 条正常
        ])
        node = c.nodes["dorm-b"]
        self.assertEqual(node.status, "正常")          # 节点卡片上显示的
        self.assertEqual(node.abnormal_status, "偏热")  # 这一段异常的性质
        self.assertEqual(node.view().status, "偏热")

    def test_the_reason_never_says_consecutive_normal(self):
        c, _ = make_core(recoverConsecutiveNormal=3)
        self.feed(c, "dorm-b", [
            (31, 78, "2026-09-22 20:00:00"),
            (25, 60, "2026-09-22 20:05:00"),
        ])
        top = c.priority(now_wall=NOW)
        self.assertEqual(top.node_id, "dorm-b")
        self.assertIn("已连续偏热 5 分钟（1 次）", top.reason)
        self.assertNotIn("正常", top.reason)

    def test_severity_uses_the_run_not_the_latest_reading(self):
        """严重度那一步也一样：这一段是偏热，就按偏热比，不按刚收到的那条正常比。"""
        c, _ = make_core(recoverConsecutiveNormal=3)
        # 两边时长、条数都卡成一样（都是 300 秒 / 2 条），只剩严重度能分：
        # dorm-a 这一段是偏冷，dorm-b 这一段是偏热。dorm-b 的**最新一条**已经
        # 是「正常」了（恢复路上第 1 条，还没凑够 3 条），按最新读数比的话它的
        # 严重度会掉成 0，赢家就成了 dorm-a —— 那是在拿「刚读到正常」去抹掉
        # 「这一段是偏热」。
        self.feed(c, "dorm-a", [
            (16, 60, "2026-09-22 20:00:00"),
            (16, 60, "2026-09-22 20:05:00"),
        ])
        self.feed(c, "dorm-b", [
            (31, 78, "2026-09-22 20:00:00"),
            (31, 78, "2026-09-22 20:02:00"),
            (25, 60, "2026-09-22 20:05:00"),   # 恢复路上，这一段还没结束
        ])
        top = c.priority(now_wall=NOW)
        self.assertEqual((top.node_id, top.duration, top.count), ("dorm-b", 300.0, 2))
        self.assertEqual(top.severity, 3)
        self.assertEqual(c.nodes["dorm-b"].status, "正常")

    def test_run_status_clears_when_the_run_closes(self):
        c, _ = make_core(recoverConsecutiveNormal=3)
        self.feed(c, "dorm-b", [(31, 78, "2026-09-22 20:00:00")])
        for minute in ("20:01:00", "20:02:00", "20:03:00"):
            self.feed(c, "dorm-b", [(25, 60, f"2026-09-22 {minute}")])
        node = c.nodes["dorm-b"]
        self.assertEqual(node.abnormal_count, 0)
        self.assertIsNone(node.abnormal_status)
        self.assertFalse(node.is_abnormal())

    def test_run_status_follows_a_drift_inside_the_run(self):
        """段内从偏热漂到偏湿：说的是这一段的**最近**状况。"""
        c, _ = make_core()
        self.feed(c, "dorm-b", [
            (31, 78, "2026-09-22 20:00:00"),
            (25, 80, "2026-09-22 20:03:00"),
        ])
        node = c.nodes["dorm-b"]
        self.assertEqual(node.abnormal_status, "偏湿")
        self.assertIn("已连续偏湿 3 分钟（2 次）", c.priority(now_wall=NOW).reason)


class TestDataLogLine(unittest.TestCase):
    """收到一条报文时打的那一行。

    这一行是现场唯一的「正在发生什么」，措辞错了会直接误导人：
    恢复路上的第一条正常如果还写成「第 N 条异常」，看的人会以为又恶化了。
    """

    def capture(self, c: core.Core, calls) -> str:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            for topic, text in calls:
                c.on_message(FakeClient(), None, _Message(topic, text.encode("utf-8")))
        return buf.getvalue()

    def make_fresh(self) -> core.Core:
        # 关掉 quiet：这一行本来就是打给人看的，压掉它就没得测了
        return core.Core(core.load_config(), client=FakeClient(), quiet=False)

    def test_abnormal_line_says_how_long_and_which_one(self):
        c = self.make_fresh()
        out = self.capture(c, [
            (topic_of("dorm-b"), payload_text("dorm-b", when="2026-09-22 20:30:00")),
            (topic_of("dorm-b"), payload_text("dorm-b", when="2026-09-22 20:36:00")),
        ])
        self.assertIn("这段已持续 6 分钟（第 2 条异常）", out)

    def test_normal_line_inside_an_open_run_counts_down(self):
        c = self.make_fresh()
        out = self.capture(c, [
            (topic_of("dorm-b"), payload_text("dorm-b", when="2026-09-22 20:30:00")),
            (topic_of("dorm-b"), payload_text("dorm-b", 25, 60, "正常", when="2026-09-22 20:31:00")),
            (topic_of("dorm-b"), payload_text("dorm-b", 25, 60, "正常", when="2026-09-22 20:32:00")),
        ])
        self.assertIn("还差 2 条正常才算这一段结束", out)
        self.assertIn("还差 1 条正常才算这一段结束", out)
        # 关键：那两条正常的行里不能再出现「第 N 条异常」
        for line in out.splitlines():
            if "还差" in line:
                self.assertNotIn("条异常", line)

    def test_after_the_run_closes_the_line_goes_back_to_plain(self):
        c = self.make_fresh()
        out = self.capture(c, [
            (topic_of("dorm-b"), payload_text("dorm-b", when="2026-09-22 20:30:00")),
            (topic_of("dorm-b"), payload_text("dorm-b", 25, 60, "正常", when="2026-09-22 20:31:00")),
            (topic_of("dorm-b"), payload_text("dorm-b", 25, 60, "正常", when="2026-09-22 20:32:00")),
            (topic_of("dorm-b"), payload_text("dorm-b", 25, 60, "正常", when="2026-09-22 20:33:00")),
            (topic_of("dorm-b"), payload_text("dorm-b", 25, 60, "正常", when="2026-09-22 20:34:00")),
        ])
        last = [ln for ln in out.splitlines() if "20:34" not in ln and "[数据]" in ln][-1]
        self.assertNotIn("还差", last)
        self.assertNotIn("条异常", last)

    def test_normals_until_recovery_is_none_without_a_run(self):
        c = self.make_fresh()
        node = c.nodes["dorm-b"]
        self.assertIsNone(node.normals_until_recovery(3))
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b"), now_wall=NOW)
        self.assertEqual(node.normals_until_recovery(3), 3)


class TestPriority(unittest.TestCase):
    def feed(self, c, node_id, times, temperature=31, humidity=78, status="偏热"):
        for when in times:
            c.handle_message(
                topic_of(node_id),
                payload_text(node_id, temperature, humidity, status, when),
                now_wall=NOW,
            )

    def test_longest_run_wins(self):
        c, _ = make_core()
        self.feed(c, "dorm-a", ["2026-09-22 20:00:00", "2026-09-22 20:03:00"], 16, 60, "偏冷")
        self.feed(c, "dorm-b", ["2026-09-22 20:00:00", "2026-09-22 20:07:00"])
        self.feed(c, "dorm-c", ["2026-09-22 20:00:00", "2026-09-22 20:05:00"], 25, 80, "偏湿")
        top = c.priority(NOW)
        self.assertEqual(top.node_id, "dorm-b")
        self.assertEqual(top.reason, "已连续偏热 7 分钟（2 次），持续时间最长")

    def test_all_normal_means_no_priority(self):
        c, _ = make_core()
        for node_id in NODES:
            c.handle_message(
                topic_of(node_id), payload_text(node_id, 25, 60, "正常"), now_wall=NOW
            )
        self.assertIsNone(c.priority(NOW))
        self.assertEqual(c.ranked(NOW), [])

    def test_offline_node_does_not_win(self):
        """离线节点不参与排序：它的数据停在半小时前了，拿它去和刚发来的
        数据比「谁更该先看」，等于把已经不知道现状的宿舍排在还在恶化的前面。

        dorm-b 的异常段更长，但它失联了 —— 重点是 dorm-c。
        """
        c, _ = make_core(offlineTimeoutSec=60)
        self.feed(c, "dorm-b", ["2026-09-22 20:00:00", "2026-09-22 20:20:00"])
        long_ago = NOW - 3600          # dorm-b 的数据是一小时前收到的
        c.nodes["dorm-b"].last_seen = long_ago
        self.feed(c, "dorm-c", ["2026-09-22 20:00:00", "2026-09-22 20:05:00"], 25, 80, "偏湿")
        top = c.priority(NOW)
        self.assertEqual(top.node_id, "dorm-c")

    def test_offline_node_is_still_in_the_snapshot(self):
        """不参与排序 ≠ 从快照里消失。看不见的东西才叫丢。"""
        c, _ = make_core(offlineTimeoutSec=60)
        self.feed(c, "dorm-b", ["2026-09-22 20:00:00"])
        c.nodes["dorm-b"].last_seen = NOW - 3600
        snapshot = c.snapshot(NOW)
        entry = [n for n in snapshot["nodes"] if n["nodeId"] == "dorm-b"][0]
        self.assertFalse(entry["online"])
        self.assertEqual(entry["status"], "偏热")
        self.assertEqual(entry["abnormalCount"], 1)
        self.assertIsNone(entry["reason"], "离线了就不该还挂在优先表上")

    def test_tick_reports_newly_offline_once(self):
        c, _ = make_core(offlineTimeoutSec=30)
        self.feed(c, "dorm-a", ["2026-09-22 20:00:00"])
        self.assertEqual(c.tick(NOW), [])
        self.assertEqual(c.tick(NOW + 31), ["dorm-a"])
        # 已经报过的不再报 —— 否则每 0.5 秒刷一条，日志里就只剩这一句了
        self.assertEqual(c.tick(NOW + 40), [])

    def test_severity_weights_come_from_config(self):
        """权重取自 core/config.json。把偏冷调到最高，赢家就得换人。"""
        c, _ = make_core()
        c.cfg["priority"]["severity"] = {"偏热": 1, "偏湿": 2, "偏冷": 9, "正常": 0}
        self.feed(c, "dorm-a", ["2026-09-22 20:00:00", "2026-09-22 20:06:00"], 16, 60, "偏冷")
        self.feed(c, "dorm-b", ["2026-09-22 20:00:00", "2026-09-22 20:06:00"])
        self.assertEqual(c.priority(NOW).node_id, "dorm-a")

    def test_report_speaks_only_when_the_answer_changes(self):
        """日志里每一行「重点」都必须是一次真实的换人。

        每条都打的话，一次演示下来几百行一模一样的「重点 dorm-b」，
        而真正该看见的那次换人被埋在中间 —— 这条就是钉住这件事的。

        走 on_message 这条**真路径**（report 是在那里调的），
        不是直接调 report() —— 直接调的话，这一条测的就不是
        「收到数据时会不会说话」，而是「手动喊一嗓子会不会说话」。
        """
        c, client = make_core()          # quiet=True，所以只有「重点」会打出来
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            deliver(c, client, "dorm-b", 31, 78, "偏热", "2026-09-22 20:00:00")
            deliver(c, client, "dorm-b", 31, 78, "偏热", "2026-09-22 20:01:00")
            deliver(c, client, "dorm-b", 31, 78, "偏热", "2026-09-22 20:02:00")
        self.assertEqual(buf.getvalue().count("[重点]"), 1, "三条数据，结论没变，只该说一次")

        with contextlib.redirect_stdout(buf):
            # dorm-c 的段长 9 分钟，超过 dorm-b 的 2 分钟 —— 重点该换人
            deliver(c, client, "dorm-c", 25, 80, "偏湿", "2026-09-22 20:00:00")
            deliver(c, client, "dorm-c", 25, 80, "偏湿", "2026-09-22 20:09:00")
        self.assertEqual(buf.getvalue().count("[重点]"), 2, "换人了，得多说一行")
        self.assertIn("dorm-c —— ", buf.getvalue())

    def test_no_node_name_is_hardcoded_in_core(self):
        """「优先关注节点禁止写死」——查的是源码，不是这一组数据的结果。"""
        import ast
        import io
        import tokenize

        source = (ROOT / "core.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        doc_lines: set[int] = set()
        for node in ast.walk(tree):
            if not isinstance(node, (ast.Module, ast.ClassDef,
                                     ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            body = getattr(node, "body", None)
            if (body and isinstance(body[0], ast.Expr)
                    and isinstance(body[0].value, ast.Constant)
                    and isinstance(body[0].value.value, str)):
                doc = body[0].value
                doc_lines.update(range(doc.lineno, (doc.end_lineno or doc.lineno) + 1))
        kept = [
            t.string for t in tokenize.generate_tokens(io.StringIO(source).readline)
            if t.type != tokenize.COMMENT
            and not (t.type == tokenize.STRING and t.start[0] in doc_lines)
        ]
        self.assertNotIn("dorm-", "\n".join(kept))


class TestSnapshot(unittest.TestCase):
    def test_snapshot_is_published_retained(self):
        c, client = make_core()
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b"), now_wall=NOW)
        message = client.last_on(config.STATE_TOPIC)
        self.assertIs(message["retain"], True)

    def test_snapshot_only_published_when_it_changes(self):
        """每条都发的话，模拟器每 2 秒刷一次而内容一个字没变 ——
        抓包截图上全是一模一样的报文，真正变化的那条反而看不出来。"""
        c, client = make_core()
        c.publish_state(NOW, force=True)
        count = len(client.on(config.STATE_TOPIC))
        self.assertFalse(c.publish_state(NOW), "内容没变，不该再发")
        self.assertEqual(len(client.on(config.STATE_TOPIC)), count)

        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b"), now_wall=NOW)
        self.assertEqual(len(client.on(config.STATE_TOPIC)), count + 1)

    def test_snapshot_shape(self):
        c, client = make_core()
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b"), now_wall=NOW)
        snapshot = client.state_payloads()[-1]

        self.assertEqual(snapshot["v"], core.SNAPSHOT_VERSION)
        self.assertEqual(len(snapshot["time"]), 19)
        self.assertEqual(sorted(snapshot), [
            "counters", "events", "focus", "nodes", "priority", "rejects",
            "time", "v",
        ])
        self.assertEqual(sorted(snapshot["nodes"][0]), [
            "abnormalCount", "durationSec", "durationText", "history",
            "historyCount", "humidity", "lastSeen", "nodeId", "online",
            "reason", "status", "temperature", "time",
        ])
        self.assertEqual([n["nodeId"] for n in snapshot["nodes"]], list(NODES))
        self.assertEqual(snapshot["counters"],
                         {"received": 1, "rejected": 0, "statusMismatch": 0,
                          "retainedCleared": 0, "commands": 0,
                          "commandRejected": 0})
        # history 里每条只留画图要用的四个字段（完整报文里的 seq / source
        # 不进快照 —— 它是每个周期都要重发一遍的）。
        by_id = {n["nodeId"]: n for n in snapshot["nodes"]}
        self.assertEqual(by_id["dorm-b"]["history"], [{
            "time": "2026-09-22 20:30:00", "temperature": 31.0,
            "humidity": 78.0, "status": "偏热",
        }])
        # 一条数据都还没收到的节点：history 是空表而**不是**缺失。
        # 缺失的话前端 `node.history.length` 会当场抛，页面停在半路。
        self.assertEqual(by_id["dorm-a"]["history"], [])

    def test_priority_block(self):
        c, client = make_core()
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b"), now_wall=NOW)
        block = client.state_payloads()[-1]["priority"]
        self.assertEqual(block["nodeId"], "dorm-b")
        self.assertEqual(block["status"], "偏热")
        self.assertEqual(block["severity"], 3)
        self.assertEqual(block["abnormalCount"], 1)
        self.assertEqual(block["durationText"], "不到 1 分钟")
        self.assertEqual(block["reason"], "已连续偏热 不到 1 分钟（1 次），是目前唯一的异常节点")

    def test_priority_is_null_when_all_normal(self):
        c, client = make_core()
        for node_id in NODES:
            c.handle_message(
                topic_of(node_id), payload_text(node_id, 25, 60, "正常"), now_wall=NOW
            )
        self.assertIsNone(client.state_payloads()[-1]["priority"])

    def test_every_node_carries_its_own_reason(self):
        """每条都给理由 —— 「输在哪一步」和「赢在哪一步」一样要说得出来。"""
        c, client = make_core()
        c.handle_message(topic_of("dorm-a"), payload_text("dorm-a", 16, 60, "偏冷", "2026-09-22 20:00:00"), now_wall=NOW)
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b", 31, 78, "偏热", "2026-09-22 20:00:00"), now_wall=NOW)
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b", 31, 78, "偏热", "2026-09-22 20:07:00"), now_wall=NOW)
        snapshot = client.state_payloads()[-1]
        reasons = {n["nodeId"]: n["reason"] for n in snapshot["nodes"]}
        self.assertEqual(reasons["dorm-b"], "已连续偏热 7 分钟（2 次），持续时间最长")
        self.assertEqual(reasons["dorm-a"], "虽然偏冷，但只持续 不到 1 分钟")
        self.assertIsNone(reasons["dorm-c"])

    def test_duration_format_matches_the_shared_table(self):
        """快照里的 durationText 和前端说的是同一套话（共用那份期望表）。

        只抽一条最典型的：7 分钟。全套在 test_rules_priority.py 里。
        """
        c, client = make_core()
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b", when="2026-09-22 20:00:00"), now_wall=NOW)
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b", when="2026-09-22 20:07:00"), now_wall=NOW)
        entry = [n for n in client.state_payloads()[-1]["nodes"] if n["nodeId"] == "dorm-b"][0]
        self.assertEqual(entry["durationText"], rules.format_duration(420))
        self.assertEqual(entry["durationText"], "7 分钟")


class TestFocusCommand(unittest.TestCase):
    """E3 的 focus 指令：移动端切焦点，看板跟着走。

    这里盯的是**红线**在第二个动词上是不是照样成立：focus 只许动
    self.focus，事件簿和节点状态都一个字节都不许变。松掉的话，「按一下
    按钮就把事情办完」会从 handle 那条门缝里溜回来 —— 走 focus 这条。
    """

    def _send(self, c, node_id="dorm-c", action="focus", source="mobile", **extra):
        body = {"nodeId": node_id, "action": action, "source": source}
        body.update(extra)
        return c.handle_command(config.CMD_TOPIC, json.dumps(body), now_wall=NOW)

    def _focus_in_snapshot(self, client):
        return client.state_payloads()[-1]["focus"]

    def test_focus_sets_the_snapshot_field(self):
        c, client = make_core()
        verdict = self._send(c)
        self.assertTrue(verdict.ok)
        # at 用的是**此刻**（core 的时钟），不是报文里那个 time ——
        # 「谁什么时候点的名」只能问收到指令的人。所以这里比的是
        # format_time(NOW)，写死一个时刻的话测试会跟着时区飘。
        self.assertEqual(self._focus_in_snapshot(client), {
            "nodeId": "dorm-c", "by": "mobile", "at": core.format_time(NOW),
        })

    def test_focus_republishes_the_state(self):
        """**这一步必须重发快照** —— 不重发，移动端点了「聚焦」而看板
        永远收不到，跨端联动就是假的（快照只在内容变了时发，而 focus
        正是那种「变了但得有人主动发」的情况）。"""
        c, client = make_core()
        before = len(client.on(config.STATE_TOPIC))
        self._send(c)
        self.assertEqual(len(client.on(config.STATE_TOPIC)), before + 1)

    def test_focus_is_retained_state_not_a_command(self):
        """快照本身仍然是 retained —— 焦点要留给后开页面的人。"""
        c, client = make_core()
        self._send(c)
        self.assertIs(client.last_on(config.STATE_TOPIC)["retain"], True)

    def test_same_node_twice_cancels(self):
        """得有办法取消：没有取消的话，焦点一旦设上就没有任何一条报文
        能把它改掉，演示到一半只能重启 core。"""
        c, client = make_core()
        self._send(c, "dorm-b")
        self._send(c, "dorm-b")
        self.assertIsNone(self._focus_in_snapshot(client))

    def test_switching_to_another_node(self):
        c, client = make_core()
        self._send(c, "dorm-b")
        self._send(c, "dorm-a")
        self.assertEqual(self._focus_in_snapshot(client)["nodeId"], "dorm-a")

    def test_focus_does_not_touch_the_event_book(self):
        """**红线**：被点名不是事件动作。

        拿一条真的开着的事件来看：点完 focus 之后它还是 OPEN、
        actions 还是空的、recovered_at 还是 null。
        """
        c, client = make_core()
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b"), now_wall=NOW)
        event = c.event_book.open_event("dorm-b")
        self.assertIsNotNone(event)
        before = (event.state, list(event.actions), event.recovered_at)

        self._send(c, "dorm-b", action="focus")

        after = (event.state, list(event.actions), event.recovered_at)
        self.assertEqual(after, before)
        self.assertEqual(event.state, events.OPEN)
        self.assertEqual(event.actions, [])
        self.assertIsNone(event.recovered_at)

    def test_handle_command_does_not_change_nodes_or_priority(self):
        """**红线的行为版**（静态那条在 tests/test_events.py 里）。

        E3 之后指令确实会让快照变（events 那块要变、focus 要变），所以
        「指令进来快照不动」这句话不再成立、也就没法再拿它当红线。真正
        不许变的是这两个：**每个节点的状态**和**谁是重点**。按一下按钮就
        让宿舍变正常、或者让自己变成重点，都是从这里漏出去的。
        """
        c, client = make_core()
        c.handle_message(topic_of("dorm-a"), payload_text("dorm-a", 31, 78), now_wall=NOW)
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b", 16, 60, "偏冷"), now_wall=NOW)
        before = client.state_payloads()[-1]
        snapshot_before = (before["nodes"], before["priority"])

        c.handle_command(
            config.CMD_TOPIC,
            json.dumps({"nodeId": "dorm-b", "action": "handle", "source": "dashboard"}),
            now_wall=NOW,
        )

        after = client.state_payloads()[-1]
        self.assertEqual((after["nodes"], after["priority"]), snapshot_before)
        # 变了的是事件那一条（OPEN -> HANDLING），这才是按按钮该有的效果
        self.assertEqual(c.event_book.open_event("dorm-b").state, events.HANDLING)
        self.assertEqual(after["counters"]["commands"], 1)

    def test_focus_does_not_change_who_is_the_priority(self):
        """被点名的宿舍**不因此变成最该处理的**。

        合起来的话，谁按了按钮谁就成了重点 —— 排序就成了「谁按谁有理」。
        """
        c, client = make_core()
        c.handle_message(topic_of("dorm-a"), payload_text("dorm-a", 31, 78), now_wall=NOW)
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b", 16, 60, "偏冷"), now_wall=NOW)
        before = client.state_payloads()[-1]["priority"]

        self._send(c, "dorm-b", action="focus")   # 点名的是**弱**的那个

        self.assertEqual(client.state_payloads()[-1]["priority"], before)
        self.assertEqual(before["nodeId"], "dorm-a")

    def test_focus_cannot_start_handling(self):
        """focus 不许被当成 handle 用：事件不许从 OPEN 变成 HANDLING。"""
        c, client = make_core()
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b"), now_wall=NOW)
        self._send(c, "dorm-b", action="focus")
        self.assertEqual(c.event_book.open_event("dorm-b").state, events.OPEN)

    def test_focus_survives_later_telemetry(self):
        """后面来的数据不许把焦点冲掉 —— 它是「大家在看的那个」，不是
        「最后一条报文是哪个」。"""
        c, client = make_core()
        self._send(c, "dorm-c")
        c.handle_message(topic_of("dorm-a"), payload_text("dorm-a"), now_wall=NOW)
        self.assertEqual(self._focus_in_snapshot(client)["nodeId"], "dorm-c")

    def test_focus_is_not_persisted(self):
        """不落盘：重启之后谁都没被点名。它是当下这一屋子人在看什么，
        不是历史事实。"""
        c, _ = make_core()
        self._send(c, "dorm-b")
        c2, client2 = make_core()
        self.assertIsNone(c2.snapshot(NOW)["focus"])

    def test_focus_is_case_sensitive_like_handle(self):
        """大小写不折叠这条对新的动词一样成立。"""
        c, client = make_core()
        verdict = self._send(c, "dorm-b", action="Focus")
        self.assertFalse(verdict.ok)
        self.assertIn("不认识的 action", " ".join(verdict.reasons))
        self.assertIsNone(c.snapshot(NOW)["focus"])

    def test_focus_rejects_unknown_node(self):
        """不认识的节点还是拒收 —— 快照里出现一个不存在的宿舍名，前端
        会为它画一张永远没有数据的卡片。"""
        c, client = make_core()
        verdict = self._send(c, "dorm-z")
        self.assertFalse(verdict.ok)
        self.assertIn("未知节点", " ".join(verdict.reasons))

    def test_focus_with_wrong_topic_is_rejected(self):
        c, client = make_core()
        verdict = c.handle_command(
            topic_of("dorm-b"),
            json.dumps({"nodeId": "dorm-b", "action": "focus"}),
            now_wall=NOW,
        )
        self.assertFalse(verdict.ok)
        self.assertIsNone(c.snapshot(NOW)["focus"])

    def test_rejected_focus_is_counted_as_a_rejected_command(self):
        """focus 被拒要记在 commandRejected 上，不是记在其它计数上 ——
        页面上那个数是排查「按钮按了没反应」的第一站。"""
        c, client = make_core()
        self._send(c, "dorm-z")
        self.assertEqual(client.state_payloads()[-1]["counters"]["commandRejected"], 1)
        self.assertEqual(client.state_payloads()[-1]["counters"]["commands"], 0)

    def test_focus_without_source_says_so(self):
        c, client = make_core()
        c.handle_command(config.CMD_TOPIC,
                         json.dumps({"nodeId": "dorm-b", "action": "focus"}),
                         now_wall=NOW)
        self.assertEqual(self._focus_in_snapshot(client)["by"], "来源未标")

    def test_all_commands_are_reachable_through_the_same_validator(self):
        """每个动词都得能从 validate_command 过掉 —— 漏登记一个的话，
        那个词会被拒，而理由写的是「目前只有 ['handle']」，看着像没实现。

        最小合法报文**按动作给**（E2）：handle / focus 只要 nodeId + action，
        snapshot 还要一份快照文件的信息。全都用同一个最小报文的话，这条测试
        会退化成「snapshot 缺 stamp」—— 那测的是我没有填字段，不是它能不能过。
        """
        for action in core.COMMANDS:
            verdict = core.validate_command(
                config.CMD_TOPIC, command_body(action=action), NODES,
            )
            self.assertTrue(verdict.ok, f"{action} 过不了校验：{verdict.reasons}")
        self.assertEqual(core.COMMANDS, ("handle", "focus", "snapshot"))


class TestSnapshotCommand(unittest.TestCase):
    """Phase6 E2 的 snapshot 指令：web 页面拍了一张现场快照，要挂到案卷上。

    这里盯的是红线在**第三个动词**上是不是照样成立：snapshot 只许往开着的那条
    事件的 snapshots 里追加一笔，事件状态、节点状态、优先级一个字节都不许动。

    为什么它比 handle 那条更容易松：照片看着像**证据**。「都拍下来了，那就当
    处理过了吧」—— 这一句真写出来，红线就没了，而且不会有任何报错：一个
    按了没按过「开始处理」的宿舍，会顶着一张照片显示成「处理中」。
    """

    def _send(self, c, node_id="dorm-b", action=events.SNAPSHOT, source="web", **extra):
        return c.handle_command(
            config.CMD_TOPIC,
            command_body(node_id, action, source=source, **extra),
            now_wall=NOW,
        )

    def _raw(self, c, body: dict):
        """发一条**一个字段都不补**的报文。

        `command_body` 会自动把 `COMMAND_SAMPLE_FIELDS` 里那几个必填字段填上
        （那是给「所有动作都过得了校验」那条测试用的）。「少一个字段会怎样」
        这条测试要的恰恰是**不填**，所以它得绕开那个便利函数 —— 否则传进去的
        是「缺 stamp 的报文」，发出去的还是齐全的那一份，测试永远绿。
        """
        return c.handle_command(
            config.CMD_TOPIC, json.dumps(body, ensure_ascii=False), now_wall=NOW
        )

    def _logged(self, c, **extra):
        """发一条，把日志里那几行也捞回来 —— 拒绝时那句「为什么」只说给日志听，
        而页面上要显示的就是它（点了没反应是最难查的那种坏）。"""
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            verdict = self._send(c, **extra)
        return verdict, buf.getvalue()

    def _open_a_case(self, c, node_id="dorm-b"):
        """喂一条异常，让这一间开出一条还开着的案卷。"""
        c.handle_message(topic_of(node_id), payload_text(node_id), now_wall=NOW)
        return c.event_book.open_event(node_id)

    def _card(self, snapshot, node_id="dorm-b"):
        """快照里那条案卷的**视图** —— MQTT 上发给屏幕看的那一份。"""
        for item in snapshot["events"]["events"]:
            if item["nodeId"] == node_id:
                return item
        return None

    # ---- 登上去长什么样 ----

    def test_it_lands_on_the_open_event(self):
        c, _client = make_core()
        event = self._open_a_case(c)

        verdict = self._send(c, stamp="2026-09-22 20:31:00",
                             width=640, height=480, bytes=48213, file="shot-1.png")

        self.assertTrue(verdict.ok, verdict.reasons)
        self.assertEqual(event.camera_count, 1)
        shot = event.snapshots[-1]
        self.assertEqual(shot["kind"], events.CAMERA)
        self.assertEqual(shot["eventId"], event.event_id)
        self.assertEqual(shot["nodeId"], "dorm-b")
        self.assertEqual(shot["stamp"], "2026-09-22 20:31:00")
        self.assertEqual((shot["width"], shot["height"]), (640, 480))
        self.assertEqual(shot["size"], 48213)
        self.assertEqual(shot["file"], "shot-1.png")
        self.assertEqual(shot["source"], "web")

    def test_the_two_times_are_both_kept(self):
        """`stamp` 是快门按下去那一刻（前端报的），`time` 是 core 收到那一刻
        （core 自己的钟）。两个都留着 —— 「照片是 20:31 拍的、core 20:33 才
        收到」这件事只有两个时间都在才查得出来。"""
        c, _client = make_core()
        event = self._open_a_case(c)

        self._send(c, stamp="2026-09-22 20:31:00", width=1, height=1, bytes=1)

        shot = event.snapshots[-1]
        self.assertEqual(shot["stamp"], "2026-09-22 20:31:00")
        self.assertEqual(shot["time"], core.format_time(NOW))

    def test_the_command_time_wins_when_it_is_given(self):
        """给了 time 就用它 —— 和 handle 同一条口径：动作什么时候发生的，
        只能问发它的人。"""
        c, _client = make_core()
        event = self._open_a_case(c)

        self._send(c, stamp="2026-09-22 20:31:00", width=1, height=1, bytes=1,
                   time="2026-09-22 20:32:00")

        self.assertEqual(event.snapshots[-1]["time"], "2026-09-22 20:32:00")

    def test_camera_count_shows_up_in_the_snapshot(self):
        """页面拍完照只能说「已经发出去」；「core 真的登记上了」得等下一帧
        快照里这个数涨了才算数 —— 和「点完处理按钮画面不动」是同一条规矩。"""
        c, client = make_core()
        self._open_a_case(c)
        before = self._card(client.state_payloads()[-1])["cameraCount"]

        self._send(c, stamp="2026-09-22 20:31:00", width=1, height=1, bytes=1)

        self.assertEqual(
            (before, self._card(client.state_payloads()[-1])["cameraCount"]), (0, 1))

    def test_the_count_does_not_include_the_state_transitions(self):
        """案卷上本来就躺着几条**状态迁移**记录（开案那条一定在）。
        cameraCount 报的必须只是相机那几张 —— 直接交 `len(self.snapshots)` 上去
        的话，一条刚开案、人一张都没拍过的事件会显示成「1 张」。"""
        c, client = make_core()
        event = self._open_a_case(c)

        self.assertGreaterEqual(len(event.snapshots), 1)          # 开案那一条
        self.assertEqual(self._card(client.state_payloads()[-1])["cameraCount"], 0)

    def test_recording_a_snapshot_republishes_the_state(self):
        """必须重发 —— 前端只订快照这一条 topic，不重发的话那个数一直停在
        上一回的值上，页面会永远停在「已经发出去」。"""
        c, client = make_core()
        self._open_a_case(c)
        before = len(client.on(config.STATE_TOPIC))

        self._send(c, stamp="2026-09-22 20:31:00", width=1, height=1, bytes=1)

        self.assertEqual(len(client.on(config.STATE_TOPIC)), before + 1)

    def test_two_shots_both_stay(self):
        """第二张不顶掉第一张 —— 现场快照是**只增**的。"""
        c, _client = make_core()
        event = self._open_a_case(c)

        self._send(c, stamp="2026-09-22 20:31:00", width=1, height=1, bytes=1, file="a.png")
        self._send(c, stamp="2026-09-22 20:32:00", width=1, height=1, bytes=2, file="b.png")

        shots = [s for s in event.snapshots if s.get("kind") == events.CAMERA]
        self.assertEqual([s["file"] for s in shots], ["a.png", "b.png"])
        self.assertEqual(event.camera_count, 2)

    def test_it_is_counted_as_a_command(self):
        c, _client = make_core()
        self._open_a_case(c)
        before = c.counters.commands

        self._send(c, stamp="2026-09-22 20:31:00", width=1, height=1, bytes=1)

        self.assertEqual(c.counters.commands, before + 1)

    # ---- 红线：拍一张不是一次状态迁移 ----

    def test_it_does_not_touch_the_event_state(self):
        """**红线**。拿一条真开着的案卷看：拍完还是 OPEN、actions 还是空的、
        verify 还是空的、recovered_at 还是 null。"""
        c, _client = make_core()
        event = self._open_a_case(c)
        frozen = (event.state, list(event.actions), list(event.verify), event.recovered_at)

        verdict = self._send(c, stamp="2026-09-22 20:31:00", width=1, height=1, bytes=1)

        self.assertTrue(verdict.ok)
        self.assertEqual(
            (event.state, list(event.actions), list(event.verify), event.recovered_at),
            frozen,
        )
        self.assertEqual(event.state, events.OPEN)

    def test_it_does_not_change_nodes_or_priority(self):
        """**红线的行为版**。快照里确实变了东西（events 那块多了一张、
        counters 里指令数 +1），不许变的是这两个：每个节点的状态、谁是重点。"""
        c, client = make_core()
        c.handle_message(topic_of("dorm-a"), payload_text("dorm-a", 31, 78), now_wall=NOW)
        self._open_a_case(c)
        before = client.state_payloads()[-1]
        frozen = (before["nodes"], before["priority"])

        self._send(c, stamp="2026-09-22 20:31:00", width=1, height=1, bytes=1)

        after = client.state_payloads()[-1]
        self.assertEqual((after["nodes"], after["priority"]), frozen)
        self.assertEqual(c.event_book.open_event("dorm-b").state, events.OPEN)

    def test_a_watermark_that_claims_recovery_changes_nothing(self):
        """水印那行字是**前端画的**。原样留档是为了事后能拿它和照片上那行对，
        不是判据 —— 在里面写「已恢复」也只是多了一行字，案卷的状态一个字不动。
        （这条红了，说明有人开始拿这张图当数据用了。）"""
        c, _client = make_core()
        event = self._open_a_case(c)

        self._send(c, stamp="2026-09-22 20:31:00", width=1, height=1, bytes=1,
                   watermark="dorm-b | 已恢复 | 一切正常")

        self.assertEqual(event.snapshots[-1]["watermark"], "dorm-b | 已恢复 | 一切正常")
        self.assertEqual(event.state, events.OPEN)

    def test_the_code_path_cannot_write_a_state(self):
        """上一条的**静态版**在 tests/test_events.py 的 TestRedLine 里
        （`test_record_snapshot_cannot_write_a_state`）。

        放在那边是因为那个类整组都是「不是行为测试」的结构检查，和
        apply_action / set_focus 那两条并排才看得出是一套规矩。跑一遍只能
        证明「这一次没改」；哪天有人写着「拍够三张就自动转处理中」，上面那几条
        用的还是一条指令，照样全绿。
        """
        src = inspect.getsource(events.EventBook.record_snapshot)
        code = "".join(src.split('"""')[::2])   # 去掉 docstring，留代码
        self.assertNotIn("event.state =", code)

    # ---- 挂不上的那些 ----

    def test_no_open_case_means_it_is_not_attached_and_says_why(self):
        """没开案就没地方挂。**不是静默丢掉** —— 日志里那一行会说清楚为什么。

        注意 `verdict.ok` 在这里是 **True**：这条报文本身是合法的（动作认得、
        字段齐全、时刻读得出来），不合法的是**此刻挂不上去**这件事。这和 handle
        那条路一模一样 —— 「指令合法」和「事情办成了」从来不是一回事，混成一个
        布尔值之后，前端就没法区分「我发错了」和「时候不对」。
        """
        c, _client = make_core()

        verdict, printed = self._logged(c, stamp="2026-09-22 20:31:00",
                                        width=1, height=1, bytes=1)

        self.assertTrue(verdict.ok, verdict.reasons)
        self.assertIn("[指令]", printed)
        self.assertIn("没接受", printed)
        self.assertIn("没有未结案的事件", printed)
        self.assertIn("dorm-b", printed)
        self.assertIn("还没有过事件", printed)          # 连"上一条"都没有

    def test_a_closed_case_cannot_be_reopened(self):
        """结案之后拍的那张挂不上去 —— 已结案的案卷是**封存**的。
        挂上去的话，「这条事件有几张照片」会随着事后补拍一直涨，而复盘想看的
        恰恰是出事那一刻的现场。

        拒绝的措辞里点名了**上一条**是谁、什么状态：光说「没有未结案的事件」
        的话，人还得自己去翻案卷才明白刚才那条是已经结掉的还是压根没开过。
        """
        c, _client = make_core(recoverConsecutiveNormal=1)
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b"), now_wall=NOW)
        event = c.event_book.open_event("dorm-b")
        c.handle_message(topic_of("dorm-b"),
                         payload_text("dorm-b", 25, 60, "正常"), now_wall=NOW)
        self.assertEqual(event.state, events.RECOVERED)
        frozen = list(event.snapshots)

        verdict, printed = self._logged(c, stamp="2026-09-22 20:31:00",
                                        width=1, height=1, bytes=1)

        self.assertTrue(verdict.ok, verdict.reasons)
        self.assertEqual(event.snapshots, frozen)
        self.assertEqual(event.camera_count, 0)
        self.assertIn("没接受", printed)
        self.assertIn(event.event_id, printed)          # 「上一条 … 已经是 RECOVERED」
        self.assertIn(events.RECOVERED, printed)

    def test_an_event_id_that_does_not_match_is_not_attached(self):
        """前端可以在 eventId 里写上它**以为**的那条。core 拿它只做对账：
        对不上就不挂，且**不照着前端说的改归属** —— 谁的地盘谁做主。

        注意这里也**不是**「往对的那条上挂」：前端以为自己看的是 A 案，core
        手里开着的是 B 案，说明中间有人切过焦点。硬挂到 B 上的话，那张照片会
        安安静静地落在一条前端根本不知道的案卷上。
        """
        c, _client = make_core()
        event = self._open_a_case(c)
        frozen = list(event.snapshots)

        verdict, printed = self._logged(c, stamp="2026-09-22 20:31:00",
                                        width=1, height=1, bytes=1,
                                        eventId="dorm-b-19990101-000000")

        self.assertTrue(verdict.ok, verdict.reasons)
        self.assertEqual(event.snapshots, frozen)
        self.assertEqual(event.camera_count, 0)
        self.assertIn("没接受", printed)
        self.assertIn("对不上", printed)
        self.assertIn(event.event_id, printed)

    def test_a_matching_event_id_is_accepted(self):
        c, _client = make_core()
        event = self._open_a_case(c)

        verdict = self._send(c, stamp="2026-09-22 20:31:00", width=1, height=1, bytes=1,
                             eventId=event.event_id)

        self.assertTrue(verdict.ok, verdict.reasons)
        self.assertEqual(event.snapshots[-1]["eventId"], event.event_id)

    # ---- 缺字段与坏字段 ----

    def test_a_missing_piece_of_file_info_is_rejected(self):
        """四样缺一不可，而且**缺哪个就报哪个**。全都报成「快照不合法」的话，
        前端得回来一条条试。

        这里走 `_raw` 而不是 `_send`：`_send` 会把那几个必填字段自动补齐，
        传进去一份「缺 stamp 的报文」发出去的却是齐全的那一份。
        """
        full = {"stamp": "2026-09-22 20:31:00", "width": 640, "height": 480, "bytes": 100}
        for key in full:
            with self.subTest(missing=key):
                c, _client = make_core()
                event = self._open_a_case(c)
                body = {"nodeId": "dorm-b", "action": events.SNAPSHOT}
                body.update({k: v for k, v in full.items() if k != key})
                verdict = self._raw(c, body)
                self.assertFalse(verdict.ok, f"少了 {key} 居然过了")
                self.assertTrue(any(key in r for r in verdict.reasons),
                                f"少了 {key}，理由里却没点名：{verdict.reasons}")
                self.assertEqual(event.camera_count, 0)

    def test_zero_or_negative_numbers_are_rejected(self):
        """0×0 的照片和 0 字节的文件都不存在。收下来的话案卷上会写着一行
        「0×0」，事后没人知道该拿它怎么办。

        只查「拒没拒」不够 —— 拒的理由得点名是哪一格，不然前端只知道
        「这条不行」。"""
        full = {"stamp": "2026-09-22 20:31:00", "width": 640, "height": 480, "bytes": 100}
        for key, bad in (("width", 0), ("height", -1), ("bytes", 0)):
            with self.subTest(field=key, value=bad):
                c, _client = make_core()
                event = self._open_a_case(c)
                body = {"nodeId": "dorm-b", "action": events.SNAPSHOT, **full, key: bad}
                verdict = self._raw(c, body)
                self.assertFalse(verdict.ok, f"{key}={bad} 居然过了")
                self.assertTrue(any(key in r for r in verdict.reasons), verdict.reasons)
                self.assertEqual(event.camera_count, 0)

    def test_a_bad_stamp_is_rejected(self):
        """stamp 补不出来 —— core 收到这条指令的时候，照片早就拍完了。
        所以它必须是个能读的时刻，不能是「刚刚」。"""
        c, _client = make_core()
        event = self._open_a_case(c)
        frozen = list(event.snapshots)

        verdict = self._raw(c, {
            "nodeId": "dorm-b", "action": events.SNAPSHOT,
            "stamp": "刚刚", "width": 640, "height": 480, "bytes": 100,
        })

        self.assertFalse(verdict.ok)
        self.assertTrue(any("stamp" in r for r in verdict.reasons), verdict.reasons)
        self.assertEqual(event.snapshots, frozen)

    def test_a_bad_optional_field_type_is_rejected_not_dropped(self):
        """可选字段给了但类型不对 -> 拒。悄悄丢掉更糟：前端以为记上了，
        而案卷里那一格是空的，事后对不上还得回来查这条。"""
        c, _client = make_core()
        event = self._open_a_case(c)

        verdict = self._raw(c, {
            "nodeId": "dorm-b", "action": events.SNAPSHOT,
            "stamp": "2026-09-22 20:31:00", "width": 640, "height": 480, "bytes": 100,
            "watermark": 12345,
        })

        self.assertFalse(verdict.ok)
        self.assertTrue(any("watermark" in r for r in verdict.reasons), verdict.reasons)
        self.assertEqual(event.camera_count, 0)

    def test_the_watermark_is_clipped(self):
        """案卷是 core 的文件，长度由 core 说了算。不截的话，前端一句话就能把
        data/events.json 撑大，而且每次 fsync 都要把那一坨再写一遍。

        截了也**不报错**：这是留档的一行字，长了截短就完了，没必要让整张
        快照挂不上。
        """
        c, _client = make_core()
        event = self._open_a_case(c)

        verdict = self._send(c, stamp="2026-09-22 20:31:00", width=1, height=1, bytes=1,
                             watermark="很" * (events.WATERMARK_MAX_CHARS + 50))

        self.assertTrue(verdict.ok, verdict.reasons)
        self.assertEqual(len(event.snapshots[-1]["watermark"]), events.WATERMARK_MAX_CHARS)
        self.assertEqual(event.camera_count, 1)

    def test_the_action_is_case_sensitive_like_the_others(self):
        """和 handle / focus 一样不做大小写折叠 —— 松一点看着更友好，下一步
        就是有人发 'Snapshot' 之后「点了没反应」而日志里一条拒绝都没有。"""
        c, _client = make_core()
        self._open_a_case(c)

        verdict = self._send(c, action="Snapshot")

        self.assertFalse(verdict.ok)
        self.assertTrue(any("不认识的 action" in r for r in verdict.reasons),
                        verdict.reasons)

    def test_an_unknown_node_is_rejected_before_anything_else(self):
        """节点名不认识就没有案卷可挂 —— 这一步在 validate_command 里就挡住了，
        和遥测那条路同一个理由。

        顺序也查一下：一条同时「节点名不认识」又「缺 stamp」的报文，报出来的
        应该是节点那一条 —— 报「缺 stamp」的话，人会去补字段，补完还是不行。
        """
        c, _client = make_core()
        self._open_a_case(c)

        verdict = self._raw(c, {"nodeId": "dorm-z", "action": events.SNAPSHOT})

        self.assertFalse(verdict.ok)
        self.assertTrue(any("未知节点" in r for r in verdict.reasons), verdict.reasons)
        self.assertFalse(any("缺少" in r for r in verdict.reasons), verdict.reasons)


class TestSnapshotEventsAndRejects(unittest.TestCase):
    """E3：快照里那两块新内容 —— 事件表和被拒绝日志。"""

    def test_events_block_shape(self):
        c, client = make_core()
        c.handle_message(topic_of("dorm-b"), payload_text("dorm-b"), now_wall=NOW)
        block = client.state_payloads()[-1]["events"]
        self.assertEqual(sorted(block), ["dropped", "events", "summary"])
        self.assertEqual(block["summary"]["total"], 1)
        self.assertEqual(len(block["events"]), 1)

        view = block["events"][0]
        self.assertEqual(view["nodeId"], "dorm-b")
        self.assertEqual(view["state"], events.OPEN)
        self.assertEqual(view["problem"], "连续偏热")
        self.assertEqual(view["startTime"], "2026-09-22 20:30:00")
        # 「什么时候成的重点」：这条数据一来它就是唯一的异常，所以当场记上
        self.assertEqual(view["priorityTime"], "2026-09-22 20:30:00")
        # 还没人按过按钮 —— 那两个字段是 None，不是缺字段（缺了前端
        # 读 e.action 会抛，而这只在「还没按过」时才发生，最不容易发现）
        self.assertIsNone(view["action"])
        self.assertIsNone(view["actionTime"])
        self.assertIsNone(view["recoverTime"])
        self.assertEqual(view["result"], "")
        # 案卷那两摞数组**不进快照**（只增不减，每发一次快照就要重发一遍）
        self.assertNotIn("verify", view)
        self.assertNotIn("snapshots", view)

    def test_events_block_is_empty_before_anything_happens(self):
        c, client = make_core()
        c.publish_state(NOW, force=True)
        block = client.state_payloads()[-1]["events"]
        self.assertEqual(block["events"], [])
        self.assertEqual(block["summary"]["total"], 0)

    def test_events_are_capped_but_the_total_is_not(self):
        """截的是**发出去的那一份**，total 永远是真的总数。

        少报比多报危险：看见 20 条而以为一共就 20 条，正好会让「这个
        宿舍一直出问题」这件事消失。
        """
        c, client = make_core()
        # 直接往事件簿里塞，不靠喂报文（那要几百条数据）
        for i in range(core.SNAPSHOT_EVENTS_MAX + 5):
            c.event_book.events.append(events.Event(
                event_id=f"dorm-a-20260922-{i:06d}", node_id="dorm-a",
                start_time="2026-09-22 20:30:00", problem="连续偏热",
                state=events.RECOVERED,
            ))
        block = c.snapshot(NOW)["events"]
        self.assertEqual(len(block["events"]), core.SNAPSHOT_EVENTS_MAX)
        self.assertEqual(block["summary"]["total"], core.SNAPSHOT_EVENTS_MAX + 5)
        # 留的是**最近**的那些，顺序不变（先发生的在前）
        self.assertEqual(block["events"][-1]["event_id"],
                         f"dorm-a-20260922-{core.SNAPSHOT_EVENTS_MAX + 4:06d}")

    def test_rejects_block_shape(self):
        c, client = make_core()
        c.publish_state(NOW, force=True)
        block = client.state_payloads()[-1]["rejects"]
        self.assertEqual(sorted(block), ["items", "kept", "total"])
        self.assertEqual((block["total"], block["kept"], block["items"]), (0, 0, []))

    def test_rejects_carry_the_same_body_as_the_published_one(self):
        """页面上那条和 MQTTX 里抓到的那条必须**逐字一致** —— 不然
        「页面上没显示」和「根本没发出来」在排查时分不出来。"""
        c, client = make_core()
        c.handle_message("dormmate/v1/nodes/dorm-b/telemetry", "{不是 JSON", now_wall=NOW)

        published = json.loads(client.last_on(config.REJECT_TOPIC)["payload"])
        in_snapshot = client.state_payloads()[-1]["rejects"]["items"][-1]
        self.assertEqual(in_snapshot, published)

    def test_rejects_total_counts_beyond_the_ring(self):
        c, client = make_core()
        for i in range(core.SNAPSHOT_REJECTS_MAX + 3):
            c.handle_message(topic_of("dorm-b"), f"{{坏报文 {i}", now_wall=NOW)
        block = client.state_payloads()[-1]["rejects"]
        self.assertEqual(block["total"], core.SNAPSHOT_REJECTS_MAX + 3)
        self.assertEqual(block["kept"], core.SNAPSHOT_REJECTS_MAX)
        self.assertEqual(len(block["items"]), core.SNAPSHOT_REJECTS_MAX)
        # 留下的是最近那几条
        self.assertIn(str(core.SNAPSHOT_REJECTS_MAX + 2), block["items"][-1]["payload"])

    def test_rejected_commands_land_in_the_same_panel(self):
        """被拒的**指令**和坏报文进的是同一个面板。它们是两件事（一个
        该去查前端、一个该去查设备），所以 topic 字段照着发出来 ——
        看的人从那一栏就能分出是谁的错。"""
        c, client = make_core()
        c.handle_command(config.CMD_TOPIC,
                         json.dumps({"nodeId": "dorm-z", "action": "focus"}),
                         now_wall=NOW)
        items = client.state_payloads()[-1]["rejects"]["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["topic"], config.CMD_TOPIC)

    def test_retained_clear_is_not_a_reject(self):
        """清 retained 的空报文不该出现在被拒绝面板里 —— 它什么都不是，
        摆上去就是一条查不出的假警报。"""
        c, client = make_core()
        c.handle_message(topic_of("dorm-b"), "", now_wall=NOW)
        self.assertEqual(client.state_payloads()[-1]["rejects"]["items"], [])


class TestLifespanAndLwt(unittest.TestCase):
    def test_will_is_set_before_connect(self):
        """遗嘱必须在 connect 之前设好 —— 它存在 CONNECT 报文里。

        连上之后再设只对下一次连接有效：也就是说这一次进程被 kill 掉的时候，
        broker 广播的还是上一条遗嘱（或者根本没有）。
        """
        cfg = core.load_config()
        broker = core.resolve_broker(cfg)
        client = core.build_client(cfg, broker)

        # paho 2.x 把遗嘱拆成这几个私有字段存着（没有公开的读法）：
        # _will 只是个「设过没有」的布尔，正文分别在 _will_topic / _will_payload。
        # topic 和 payload 存的是 bytes —— 遗嘱是要原样塞进 CONNECT 报文的。
        self.assertTrue(client._will, "没有设遗嘱，core 崩了不会有人知道")
        self.assertEqual(client._will_topic, config.CORE_STATUS_TOPIC.encode("utf-8"))
        self.assertIs(client._will_retain, True)
        self.assertEqual(client._will_qos, broker["qos"])
        body = json.loads(client._will_payload.decode("utf-8"))
        self.assertEqual(body["core"], "offline")

    def test_on_connect_subscribes_and_announces_online(self):
        c, client = make_core()
        c.on_connect(client, None, {}, _ReasonCode(ok=True), None)
        # 两条订阅：遥测是指令之外的那条。指令漏订的现象是「前端按了没反应、
        # 而 core 日志里一个字都没有」，所以它必须在这次断言里钉住。
        self.assertEqual(client.subscribed, [(config.TOPIC_PATTERN, config.QOS),
                                             (config.CMD_TOPIC, config.QOS)])
        body = json.loads(client.last_on(config.CORE_STATUS_TOPIC)["payload"])
        self.assertEqual(body["core"], "online")
        self.assertIs(client.last_on(config.CORE_STATUS_TOPIC)["retain"], True)

    def test_on_connect_republishes_first_snapshot(self):
        """重连之后要把快照补上，不能等"下一条数据" —— 下一条可能是五分钟以后，
        而这段时间里所有前端读到的都是断开之前那份。"""
        c, client = make_core()
        c.on_connect(client, None, {}, _ReasonCode(ok=True), None)
        self.assertEqual(len(client.on(config.STATE_TOPIC)), 1)

    def test_failed_connect_does_not_subscribe(self):
        c, client = make_core()
        c.on_connect(client, None, {}, _ReasonCode(ok=False), None)
        self.assertEqual(client.subscribed, [])
        self.assertEqual(client.on(config.STATE_TOPIC), [])

    def test_on_message_decodes_utf8(self):
        """线上跑的是 UTF-8 字节。按 GBK 解出来会是乱码，而且不报错。"""
        c, client = make_core()
        raw = payload_text("dorm-b").encode("utf-8")
        message = _Message(topic_of("dorm-b"), raw)
        with contextlib.redirect_stdout(io.StringIO()):
            c.on_message(client, None, message)
        self.assertEqual(c.nodes["dorm-b"].latest["status"], "偏热")


class _ReasonCode:
    """paho 的 ReasonCode 替身。只用得到 is_failure 这一个属性。"""

    def __init__(self, ok: bool) -> None:
        self.is_failure = not ok

    def __str__(self) -> str:
        return "Success" if not self.is_failure else "Connection refused"


class _Message:
    def __init__(self, topic: str, payload: bytes) -> None:
        self.topic = topic
        self.payload = payload


class TestConfigChecks(unittest.TestCase):
    def test_shipped_config_passes(self):
        cfg = core.load_config()
        core.check_against_sources(cfg)      # 不抛异常就算过

    def test_wrong_threshold_is_caught(self):
        cfg = core.load_config()
        cfg["thresholds"]["temperatureLow"] = 20
        with self.assertRaises(core.ConfigError) as caught:
            core.check_against_sources(cfg)
        text = str(caught.exception)
        self.assertIn("temperatureLow", text)
        self.assertIn("status_rules", text, "得说清改哪一边")

    def test_wrong_node_list_is_caught(self):
        cfg = core.load_config()
        cfg["nodes"] = ["dorm-a"]
        with self.assertRaises(core.ConfigError):
            core.check_against_sources(cfg)

    def test_missing_file(self):
        with self.assertRaises(core.ConfigError) as caught:
            core.load_config("没有这个文件.json")
        self.assertIn("找不到配置文件", str(caught.exception))

    def test_bad_json_file(self):
        target = ROOT / "tests" / "_tmp_bad_config.json"
        try:
            target.write_text("{不是 json", encoding="utf-8")
            with self.assertRaises(core.ConfigError):
                core.load_config(target)
        finally:
            target.unlink(missing_ok=True)

    def test_field_type_problems(self):
        cases = [
            ("offlineTimeoutSec", 0), ("offlineTimeoutSec", "30"),
            ("recoverConsecutiveNormal", True), ("historyMax", -1),
            ("nodes", []), ("nodes", "dorm-a"), ("nodes", ["dorm-a", "dorm-a"]),
            ("thresholds", []), ("priority", {}),
        ]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                cfg = core.load_config()
                cfg[key] = value
                with self.assertRaises(core.ConfigError):
                    _revalidate(cfg)

    def test_broker_defaults_follow_config_py(self):
        """core/config.json 里写 null = 跟着 config.py（也就跟着环境变量走）。"""
        cfg = core.load_config()
        broker = core.resolve_broker(cfg)
        self.assertEqual(broker["host"], config.MQTT_HOST)
        self.assertEqual(broker["port"], config.MQTT_TCP_PORT)
        self.assertEqual(broker["qos"], config.QOS)

    def test_broker_override_wins_when_set(self):
        cfg = core.load_config()
        cfg["broker"] = {"host": "10.0.0.9", "port": 1884, "qos": 0, "keepaliveSec": 10}
        broker = core.resolve_broker(cfg)
        self.assertEqual((broker["host"], broker["port"], broker["qos"]), ("10.0.0.9", 1884, 0))


def _revalidate(cfg: dict) -> None:
    """把一份（测试改坏了的）配置按 load_config 的字段检查过一遍。

    正常路径上这份检查在读文件的那一步就做完了 —— 所以这里用同一份代码，
    而不是在测试里重抄一遍字段规则（抄的那份永远不会跟着主代码一起改）。
    """
    target = ROOT / "tests" / "_tmp_revalidate.json"
    try:
        target.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
        core.load_config(target)
    finally:
        target.unlink(missing_ok=True)


class TestCheckCli(unittest.TestCase):
    def test_check_mode_exits_zero(self):
        # --check 会把核对结果打到 stdout（那正是它的用途），
        # 测试里接走它，别把 test 输出刷得看不出哪条是哪条
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(core.main(["--check"]), 0)

    def test_check_mode_fails_on_broken_config(self):
        target = ROOT / "tests" / "_tmp_cli_config.json"
        try:
            cfg = core.load_config()
            cfg["thresholds"]["humidityHigh"] = 99
            target.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(core.main(["--check", "--config", str(target)]), 1)
        finally:
            target.unlink(missing_ok=True)

    def test_runs_from_any_working_directory(self):
        """用 __file__ 找项目根，不靠当前工作目录。

        演示时常见的跑法是 `cd ..; py -3.14 "DormMate Final/nova-.../core.py"`，
        这时 cwd 在别处 —— 靠相对路径的话，它会在 import 那一步就炸。
        """
        result = subprocess.run(
            [sys.executable, str(ROOT / "core.py"), "--check"],
            cwd=str(ROOT.parent), capture_output=True, text=True,
            encoding="utf-8", errors="replace",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
