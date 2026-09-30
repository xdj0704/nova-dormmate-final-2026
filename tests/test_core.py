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
import rules  # noqa: E402

# 固定的"现在"。传进去而不是让代码读 time.time()，否则「30 秒算离线」
# 这条测试会跟着跑得多快而飘。
NOW = 1_700_000_000.0

NODES = ("dorm-a", "dorm-b", "dorm-c")


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
        self.assertEqual(sorted(snapshot["nodes"][0]), [
            "abnormalCount", "durationSec", "durationText", "historyCount",
            "humidity", "lastSeen", "nodeId", "online", "reason", "status",
            "temperature", "time",
        ])
        self.assertEqual([n["nodeId"] for n in snapshot["nodes"]], list(NODES))
        self.assertEqual(snapshot["counters"],
                         {"received": 1, "rejected": 0, "statusMismatch": 0})

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
        self.assertEqual(client.subscribed, [(config.TOPIC_PATTERN, config.QOS)])
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
