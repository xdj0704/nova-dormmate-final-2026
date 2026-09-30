"""events.py 的测试：事件状态机、持久化，以及**那条红线真的关着**。

运行：
    py -3.14 -m unittest tests.test_events -v

**不连 broker**，也不开 core 的网络那一半。这里做的事是拿**真的 NodeState**
（从 core.py 借来的那一个）喂数据 —— 不自己写一个假的计数器。
假的计数器只能证明「events.py 和我想的一样」，证明不了「events.py 和 core
一样」；而后者才是这里唯一要紧的事：两个东西各数一份「连续几条」，
总有一天会数岔，而且不报错。

这个文件里最该看懂的是 TestRedLine 那几条：它们不是在测行为，
是在**拿源码钉住结构**。
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import config  # noqa: E402
import core  # noqa: E402
import events  # noqa: E402
import simulator.send_cmd as simulator_send_cmd  # noqa: E402
import simulator.simulator as simulator  # noqa: E402
from status_rules import compute_status  # noqa: E402

# 固定的"墙上时间"。events.py 里只有 last_seen 用它，而那个是 core 的事 ——
# 传定值只是不让测试跟着跑得多快而飘。
NOW = 1_700_000_000.0

NODE = "dorm-b"
NODES = ("dorm-a", "dorm-b", "dorm-c")


def record(node_id: str = NODE, temperature: float = 33.0, humidity: float = 55.0,
           when: str = "2026-09-22 20:00:00") -> dict:
    """一条**已经通过校验的**报文 —— 形状和 core.validate_message 的产出一样。

    status 一律由 status_rules 算，测试里也不写死 —— 写死的话，
    一条「33/55 但 status 写着正常」的假报文会在测试里畅通无阻。
    """
    return {
        "nodeId": node_id,
        "temperature": temperature,
        "humidity": humidity,
        "status": compute_status(temperature, humidity),
        "time": when,
    }


class Sim:
    """一个节点 + 一叠事件，按 core 那边的顺序喂数据。

    core.handle_message 的顺序是「先 node.apply，再 observe」—— 这里照抄。
    顺序反过来的话，observe 读到的是上一条报文留下的计数，而慢的那一条
    正好是判恢复/未恢复的那条，也就是唯一要紧的那条。
    """

    def __init__(self, node_id: str = NODE, recover_after: int = 3,
                 verify_after: int = 3, book: events.EventBook | None = None,
                 **book_kw) -> None:
        self.node_id = node_id
        self.recover_after = recover_after
        self.node = core.NodeState(node_id, history_max=book_kw.pop("history_max", 5))
        self.book = book if book is not None else events.EventBook(
            [node_id], recover_after, verify_after, **book_kw)
        self.lines: list[str] = []
        self.records: list[dict] = []

    def feed(self, temperature: float, humidity: float, when: str) -> dict:
        rec = record(self.node_id, temperature, humidity, when)
        self.node.apply(rec, NOW, self.recover_after)
        self.lines.extend(self.book.observe(self.node, rec))
        self.records.append(rec)
        return rec

    def hot(self, when: str) -> dict:
        """一条偏热读数。"""
        return self.feed(33.0, 55.0, when)

    def normal(self, when: str) -> dict:
        """一条正常读数。"""
        return self.feed(25.0, 60.0, when)

    def handle(self, when: str = "2026-09-22 20:10:00", **kw):
        return self.book.apply_action(self.node_id, events.HANDLE, when=when, **kw)

    @property
    def event(self) -> events.Event | None:
        """**开着**的那一条。结案之后它是 None —— 那本身就是一条判据。"""
        return self.book.open_event(self.node_id)

    @property
    def last(self) -> events.Event:
        """最近的一条，不管结没结案。结案之后要断言它的字段就用这个。"""
        event = self.book.last_for(self.node_id)
        assert event is not None, "这个节点还没有过事件"
        return event


def hot_segment(sim: Sim, start_minute: int = 0, count: int = 3) -> None:
    """先造一段成型了的异常（默认 3 条），段起点在上面倒数。"""
    for i in range(count):
        sim.hot(f"2026-09-22 20:{start_minute + i:02d}:00")


# ---------------------------------------------------------------------------
# 常量与工具
# ---------------------------------------------------------------------------


class TestConstants(unittest.TestCase):
    def test_four_states(self):
        self.assertEqual(events.STATES, ("OPEN", "HANDLING", "RECOVERED", "UNRESOLVED"))

    def test_terminal_states_are_the_two_endings(self):
        self.assertEqual(set(events.TERMINAL_STATES), {events.RECOVERED, events.UNRESOLVED})
        for state in events.TERMINAL_STATES:
            self.assertIn(state, events.STATES)

    def test_open_and_handling_are_not_terminal(self):
        self.assertNotIn(events.OPEN, events.TERMINAL_STATES)
        self.assertNotIn(events.HANDLING, events.TERMINAL_STATES)

    def test_only_one_command_for_now(self):
        """动作不能乱加：加一个动作之前得先想清楚它在状态机上是什么。"""
        self.assertEqual(events.COMMANDS, (events.HANDLE,))


class TestMakeEventId(unittest.TestCase):
    def test_from_text_time(self):
        self.assertEqual(events.make_event_id("dorm-b", "2026-09-22 20:30:00"),
                         "dorm-b-20260922-203000")

    def test_from_datetime(self):
        parsed = events.parse_time("2026-09-22 20:30:00")
        self.assertEqual(events.make_event_id("dorm-b", parsed), "dorm-b-20260922-203000")

    def test_same_second_same_id(self):
        """同一节点同一秒只可能开一条事件 —— 这就是它天然唯一的原因。"""
        self.assertEqual(events.make_event_id("dorm-a", "2026-09-22 20:30:00"),
                         events.make_event_id("dorm-a", "2026-09-22 20:30:00"))

    def test_unparsable_time_does_not_crash(self):
        self.assertEqual(events.make_event_id("dorm-a", "不是时间"), "dorm-a-00000000-000000")

    def test_parse_time_rejects_garbage(self):
        for bad in ("", "2026-09-22", "2026-13-45 99:99:99", None, 12345):
            with self.subTest(bad=bad):
                self.assertIsNone(events.parse_time(bad))


class TestHumanDuration(unittest.TestCase):
    def test_minutes(self):
        self.assertEqual(events.human_duration("2026-09-22 20:00:00",
                                              "2026-09-22 20:11:00"), "11 分钟")

    def test_under_a_minute(self):
        self.assertEqual(events.human_duration("2026-09-22 20:00:00",
                                              "2026-09-22 20:00:30"), "0 分钟")

    def test_hours(self):
        self.assertEqual(events.human_duration("2026-09-22 18:00:00",
                                              "2026-09-22 20:00:00"), "2 小时")

    def test_hours_and_minutes(self):
        self.assertEqual(events.human_duration("2026-09-22 18:00:00",
                                              "2026-09-22 20:30:00"), "2 小时 30 分钟")

    def test_backwards_and_garbage_return_empty(self):
        """算不动就返回空串，**不编一个数**出来。"""
        self.assertEqual(events.human_duration("2026-09-22 20:10:00",
                                              "2026-09-22 20:00:00"), "")
        self.assertEqual(events.human_duration("坏的", "2026-09-22 20:00:00"), "")


# ---------------------------------------------------------------------------
# Event 的读写
# ---------------------------------------------------------------------------


class TestEventJson(unittest.TestCase):
    def make(self) -> events.Event:
        return events.Event(event_id="dorm-b-20260922-200000", node_id="dorm-b",
                            start_time="2026-09-22 20:00:00", problem="连续偏热")

    def test_spec_fields_are_all_there(self):
        """任务书列的那 11 个字段，一个都不能少。"""
        body = self.make().to_json()
        for key in ("event_id", "nodeId", "start_time", "problem", "priority_reasons",
                    "actions", "verify", "verify_from", "snapshots", "recovered_at",
                    "result"):
            with self.subTest(key=key):
                self.assertIn(key, body)

    def test_round_trip(self):
        event = self.make()
        event.state = events.HANDLING
        event.verify_from = 4
        event.verify.append({"time": "2026-09-22 20:05:00", "status": "偏热"})
        event.priority_reasons.append("已连续偏热 5 分钟（3 次），持续时间最长")

        again = events.Event.from_json(json.loads(json.dumps(event.to_json(),
                                                             ensure_ascii=False)))
        self.assertEqual(again.event_id, event.event_id)
        self.assertEqual(again.state, events.HANDLING)
        self.assertEqual(again.verify_from, 4)
        self.assertEqual(again.verify, event.verify)
        self.assertEqual(again.priority_reasons, event.priority_reasons)
        self.assertTrue(again.is_open)

    def test_defaults_are_empty_not_none(self):
        event = self.make()
        self.assertEqual(event.priority_reasons, [])
        self.assertEqual(event.actions, [])
        self.assertEqual(event.verify, [])
        self.assertEqual(event.snapshots, [])
        self.assertEqual(event.result, "")
        self.assertIsNone(event.recovered_at)
        self.assertIsNone(event.verify_from)

    def test_missing_id_fields_are_rejected(self):
        for key in ("event_id", "nodeId", "start_time"):
            with self.subTest(key=key):
                body = {"event_id": "x", "nodeId": "dorm-b",
                        "start_time": "2026-09-22 20:00:00", "problem": "连续偏热"}
                del body[key]
                with self.assertRaises(ValueError):
                    events.Event.from_json(body)

    def test_unknown_state_is_rejected_not_silently_reopened(self):
        """读不懂的状态**不许**悄悄当成 OPEN —— 那会让一条结了的案子又"活"过来。"""
        body = {"event_id": "x", "nodeId": "dorm-b",
                "start_time": "2026-09-22 20:00:00", "problem": "连续偏热",
                "state": "已处理好啦"}
        with self.assertRaises(ValueError):
            events.Event.from_json(body)

    def test_non_object_is_rejected(self):
        for bad in ([1, 2], "字符串", None, 7):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    events.Event.from_json(bad)

    def test_garbage_lists_become_empty(self):
        body = {"event_id": "x", "nodeId": "dorm-b",
                "start_time": "2026-09-22 20:00:00", "problem": "连续偏热",
                "verify": "不是列表", "actions": [1, {"time": "t", "action": "handle"}]}
        event = events.Event.from_json(body)
        self.assertEqual(event.verify, [])
        # 不是对象的那些条目被跳过，是对象的留下
        self.assertEqual(len(event.actions), 1)

    def test_non_int_verify_from_becomes_none(self):
        body = {"event_id": "x", "nodeId": "dorm-b",
                "start_time": "2026-09-22 20:00:00", "problem": "连续偏热",
                "verify_from": "3"}
        self.assertIsNone(events.Event.from_json(body).verify_from)


class TestEventBookkeeping(unittest.TestCase):
    def test_snapshots_keep_the_first_one(self):
        """快照封顶时丢**最老的中间那些**，开案那条永远留着。"""
        event = events.Event(event_id="x", node_id=NODE,
                             start_time="2026-09-22 20:00:00", problem="连续偏热")
        event.add_snapshot({"time": "开案", "state": events.OPEN})
        for i in range(events.SNAPSHOT_MAX + 5):
            event.add_snapshot({"time": f"第 {i} 条", "state": events.OPEN})

        self.assertEqual(len(event.snapshots), events.SNAPSHOT_MAX)
        self.assertEqual(event.snapshots[0]["time"], "开案")
        self.assertGreater(event.snapshots_dropped, 0)
        # 丢了的条数要说得出，不然看文件的人以为本来就只有这么多
        self.assertEqual(event.snapshots_dropped, 6)

    def test_notes_dedupe_and_cap(self):
        event = events.Event(event_id="x", node_id=NODE,
                             start_time="2026-09-22 20:00:00", problem="连续偏热")
        event.note_reason("理由 A")
        event.note_reason("理由 A")
        self.assertEqual(event.priority_reasons, ["理由 A"])

        for i in range(8):
            event.note_reason(f"理由 {i}")
        self.assertEqual(len(event.priority_reasons), 5)
        self.assertEqual(event.priority_reasons[-1], "理由 7")

    def test_blank_reason_is_ignored(self):
        event = events.Event(event_id="x", node_id=NODE,
                             start_time="2026-09-22 20:00:00", problem="连续偏热")
        for blank in (None, "", "   "):
            event.note_reason(blank)
        self.assertEqual(event.priority_reasons, [])

    def test_handled_only_counts_accepted_actions(self):
        event = events.Event(event_id="x", node_id=NODE,
                             start_time="2026-09-22 20:00:00", problem="连续偏热")
        event.actions.append({"action": "handle", "accepted": False})
        self.assertFalse(event.handled)
        event.actions.append({"action": "handle", "accepted": True})
        self.assertTrue(event.handled)


# ---------------------------------------------------------------------------
# 开案
# ---------------------------------------------------------------------------


class TestOpenEvent(unittest.TestCase):
    def test_first_abnormal_record_opens(self):
        sim = Sim()
        self.assertIsNone(sim.event)
        sim.hot("2026-09-22 20:00:00")
        self.assertIsNotNone(sim.event)
        self.assertEqual(sim.event.state, events.OPEN)
        self.assertEqual(sim.event.problem, "连续偏热")
        self.assertEqual(sim.event.start_time, "2026-09-22 20:00:00")
        self.assertEqual(sim.event.node_id, NODE)

    def test_later_records_in_the_same_segment_do_not_open_again(self):
        """一条数据开一条事件的话，同一次异常能开出几十条来。"""
        sim = Sim()
        hot_segment(sim, count=5)
        self.assertEqual(len(sim.book.events), 1)

    def test_open_message_is_logged(self):
        sim = Sim()
        sim.hot("2026-09-22 20:00:00")
        self.assertTrue(any("待处理" in line for line in sim.lines))

    def test_event_id_uses_the_segment_start_not_now(self):
        """id 里的时刻是**报文说的**那一段的起点。用墙上时间的话，
        重跑同一份剧本会得到不同的 id，也就没法引用「就是那一条」。"""
        sim = Sim()
        hot_segment(sim, start_minute=30)
        self.assertEqual(sim.event.event_id, "dorm-b-20260922-203000")

    def test_normal_readings_do_not_open_anything(self):
        sim = Sim()
        for i in range(4):
            sim.normal(f"2026-09-22 20:{i:02d}:00")
        self.assertIsNone(sim.event)
        self.assertEqual(sim.book.events, [])

    def test_opening_snapshot_records_the_reading(self):
        sim = Sim()
        sim.hot("2026-09-22 20:00:00")
        first = sim.event.snapshots[0]
        self.assertEqual(first["state"], events.OPEN)
        self.assertEqual(first["status"], "偏热")
        self.assertEqual(first["temperature"], 33.0)
        self.assertEqual(first["abnormalCount"], 1)

    def test_opening_snapshot_has_no_duration(self):
        """开案这条的起点就是它自己 —— 写 "0 分钟" 是在说一件没发生过的事。
        和快照里「正常节点不写 durationText」是同一条原则。"""
        sim = Sim()
        sim.hot("2026-09-22 20:00:00")
        self.assertIsNone(sim.event.snapshots[0]["durationText"])
        # 结案那条就有：这一段从 20:00 一直到 20:12，确实持续了 12 分钟
        sim.handle()
        for i in range(3):
            sim.normal(f"2026-09-22 20:{10 + i:02d}:00")
        self.assertEqual(sim.last.snapshots[-1]["durationText"], "12 分钟")

    def test_segment_start_survives_a_normal_blip(self):
        """异常 -> 正常 -> 异常，没凑够 N 条正常就算同一段（core 的语义）。
        事件必须跟着同一条段走，不能被那一条正常切开两条。"""
        sim = Sim()
        sim.hot("2026-09-22 20:00:00")
        sim.hot("2026-09-22 20:01:00")
        sim.normal("2026-09-22 20:02:00")          # 只 1 条正常，段没结束
        sim.hot("2026-09-22 20:03:00")
        self.assertEqual(len(sim.book.events), 1)
        self.assertEqual(sim.event.start_time, "2026-09-22 20:00:00")

    def test_a_new_segment_opens_a_new_event(self):
        sim = Sim()
        hot_segment(sim, count=3)
        for i in range(3):
            sim.normal(f"2026-09-22 20:{10 + i:02d}:00")     # 段结束
        sim.hot("2026-09-22 20:20:00")                       # 新的段
        self.assertEqual(len(sim.book.events), 2)
        self.assertEqual(sim.event.start_time, "2026-09-22 20:20:00")
        self.assertNotEqual(sim.book.events[0].event_id, sim.event.event_id)


# ---------------------------------------------------------------------------
# handle：只能 OPEN -> HANDLING
# ---------------------------------------------------------------------------


class TestHandle(unittest.TestCase):
    def test_handle_moves_open_to_handling(self):
        sim = Sim()
        hot_segment(sim)
        accepted, message = sim.handle()
        self.assertTrue(accepted)
        self.assertEqual(sim.event.state, events.HANDLING)
        self.assertIn("处理中", message)

    def test_handle_does_not_write_recovered_at(self):
        """**红线**：按钮没有能力写那个字段。"""
        sim = Sim()
        hot_segment(sim)
        sim.handle()
        self.assertIsNone(sim.event.recovered_at)
        self.assertEqual(sim.event.result, "")
        self.assertTrue(sim.event.is_open)

    def test_handle_records_the_action(self):
        sim = Sim()
        hot_segment(sim)
        sim.handle(when="2026-09-22 20:05:00", source="manual", note="到场了")
        action = sim.event.actions[0]
        self.assertEqual(action["action"], events.HANDLE)
        self.assertEqual(action["time"], "2026-09-22 20:05:00")
        self.assertEqual(action["source"], "manual")
        self.assertTrue(action["accepted"])
        self.assertTrue(sim.event.handled)

    def test_handle_without_time_stamps_now(self):
        sim = Sim()
        hot_segment(sim)
        sim.book.apply_action(sim.node_id, events.HANDLE)
        self.assertIsNotNone(events.parse_time(sim.event.actions[0]["time"]))

    def test_handle_with_no_open_event_is_refused_and_says_why(self):
        sim = Sim()
        accepted, message = sim.handle()
        self.assertFalse(accepted)
        self.assertIn("没有开着的事件", message)
        self.assertIn("还没有过事件", message)

    def test_handle_after_close_names_the_closed_event(self):
        sim = Sim()
        hot_segment(sim)
        sim.handle()
        for i in range(3):
            sim.normal(f"2026-09-22 20:{10 + i:02d}:00")
        accepted, message = sim.handle()
        self.assertFalse(accepted)
        self.assertIn(events.RECOVERED, message)
        self.assertIn(sim.book.events[0].event_id, message)

    def test_second_handle_does_not_reset_the_verify_window(self):
        """**这一条是防赖皮的。** 连按几次就能把「连续 M 条依旧异常」
        一路往后推的话，事件永远判不出 UNRESOLVED，验证环节就白设了。"""
        sim = Sim()
        hot_segment(sim)
        sim.handle(when="2026-09-22 20:05:00")
        first_from = sim.event.verify_from

        for minute in (6, 7):
            sim.hot(f"2026-09-22 20:{minute:02d}:00")
        accepted, message = sim.handle(when="2026-09-22 20:08:00")

        self.assertFalse(accepted)
        self.assertEqual(sim.event.verify_from, first_from, "验证窗口被重置了")
        self.assertEqual(len(sim.event.actions), 2)
        self.assertFalse(sim.event.actions[1]["accepted"])
        self.assertIn("验证窗口", sim.event.actions[1]["note"])
        self.assertIn("已经在处理中", message)

        # 第 3 条异常一来，照样结案 —— 没有被那两次连按拖住
        sim.hot("2026-09-22 20:09:00")
        self.assertEqual(sim.last.state, events.UNRESOLVED)

    def test_closed_event_is_no_longer_the_open_one(self):
        """结案之后 _open 里没有它了 —— apply_action 再按就是「没有案子」。"""
        sim = Sim()
        hot_segment(sim)
        sim.handle()
        for i in range(3):
            sim.normal(f"2026-09-22 20:{10 + i:02d}:00")
        self.assertIsNone(sim.book.open_event(sim.node_id))
        self.assertIs(sim.book.last_for(sim.node_id), sim.book.events[0])


# ---------------------------------------------------------------------------
# 恢复：只有数据能写 RECOVERED
# ---------------------------------------------------------------------------


class TestRecovered(unittest.TestCase):
    def test_three_normals_after_handle_close_the_event(self):
        sim = Sim()
        hot_segment(sim)
        sim.handle(when="2026-09-22 20:05:00")
        for i in range(2):
            sim.normal(f"2026-09-22 20:{10 + i:02d}:00")
            self.assertEqual(sim.event.state, events.HANDLING, "还差一条就算恢复了")
        sim.normal("2026-09-22 20:12:00")
        self.assertEqual(sim.last.state, events.RECOVERED)

    def test_recovered_at_is_the_report_time(self):
        """"什么时候恢复的"要问数据，不是问墙上的钟。"""
        sim = Sim()
        hot_segment(sim)
        sim.handle()
        for i in range(3):
            sim.normal(f"2026-09-22 20:{10 + i:02d}:00")
        self.assertEqual(sim.last.recovered_at, "2026-09-22 20:12:00")
        self.assertEqual(sim.last.end_time, "2026-09-22 20:12:00")

    def test_result_after_handle_declares_the_count(self):
        sim = Sim()
        hot_segment(sim)
        sim.handle()
        for i in range(3):
            sim.normal(f"2026-09-22 20:{10 + i:02d}:00")
        self.assertIn("处理后连续 3 条正常", sim.last.result)
        self.assertIn("已恢复", sim.last.result)

    def test_data_alone_can_recover_an_event_nobody_handled(self):
        """没人按过按钮，数据自己回来了 —— 照样结案，而且要如实说是「没人处理」。"""
        sim = Sim()
        hot_segment(sim)
        for i in range(3):
            sim.normal(f"2026-09-22 20:{10 + i:02d}:00")
        self.assertEqual(sim.last.state, events.RECOVERED)
        self.assertFalse(sim.last.handled)
        self.assertIn("没人处理", sim.last.result)

    def test_recovered_event_leaves_the_open_slot(self):
        sim = Sim()
        hot_segment(sim)
        for i in range(3):
            sim.normal(f"2026-09-22 20:{10 + i:02d}:00")
        self.assertIsNone(sim.book.open_event(sim.node_id))
        self.assertFalse(sim.book.events[0].is_open)

    def test_closing_snapshot_carries_the_duration(self):
        sim = Sim()
        hot_segment(sim)
        sim.handle()
        for i in range(3):
            sim.normal(f"2026-09-22 20:{10 + i:02d}:00")
        last = sim.last.snapshots[-1]
        self.assertEqual(last["state"], events.RECOVERED)
        self.assertEqual(last["status"], "正常")
        self.assertEqual(last["durationText"], "12 分钟")


# ---------------------------------------------------------------------------
# 未恢复
# ---------------------------------------------------------------------------


class TestUnresolved(unittest.TestCase):
    def test_three_abnormals_after_handle_close_as_unresolved(self):
        sim = Sim()
        hot_segment(sim)
        sim.handle(when="2026-09-22 20:05:00")
        for minute in (6, 7):
            sim.hot(f"2026-09-22 20:{minute:02d}:00")
            self.assertEqual(sim.event.state, events.HANDLING)
        sim.hot("2026-09-22 20:08:00")
        self.assertEqual(sim.last.state, events.UNRESOLVED)

    def test_unresolved_has_no_recovered_at(self):
        """没恢复就不能有恢复时间 —— 那个字段空着本身就是一句话。"""
        sim = Sim()
        hot_segment(sim)
        sim.handle()
        for minute in (6, 7, 8):
            sim.hot(f"2026-09-22 20:{minute:02d}:00")
        self.assertIsNone(sim.last.recovered_at)
        self.assertIn("未恢复", sim.last.result)
        self.assertIn("处理后连续 3 条依旧异常", sim.last.result)

    def test_abnormals_before_the_handle_do_not_count(self):
        """处理之前那几条异常是**开案的原因**，不是处理的结果，不能算进验证。"""
        sim = Sim()
        hot_segment(sim, count=5)              # 处理前已经有 5 条异常
        sim.handle(when="2026-09-22 20:06:00")
        for minute in (6, 7):
            sim.hot(f"2026-09-22 20:{minute:02d}:00")
        self.assertEqual(sim.event.state, events.HANDLING, "把处理前的算进来了")

    def test_no_second_event_while_the_segment_continues(self):
        """结案之后这一段还没结束，后面的数据不许再开一条 ——
        按「> 0 就开案」写的话，这里会冒出十几条事件。"""
        sim = Sim()
        hot_segment(sim)
        sim.handle()
        for minute in (6, 7, 8):
            sim.hot(f"2026-09-22 20:{minute:02d}:00")
        self.assertEqual(sim.last.state, events.UNRESOLVED)
        for minute in (9, 10, 11):
            sim.hot(f"2026-09-22 20:{minute:02d}:00")
            self.assertIsNone(sim.book.open_event(sim.node_id))
        self.assertEqual(len(sim.book.events), 1)

    def test_a_later_segment_opens_a_fresh_event(self):
        sim = Sim()
        hot_segment(sim)
        sim.handle()
        for minute in (6, 7, 8):
            sim.hot(f"2026-09-22 20:{minute:02d}:00")
        for i in range(3):
            sim.normal(f"2026-09-22 20:{20 + i:02d}:00")     # 这一段结束
        sim.hot("2026-09-22 20:30:00")
        self.assertEqual(len(sim.book.events), 2)
        self.assertEqual(sim.event.state, events.OPEN)

    def test_countdown_is_logged(self):
        sim = Sim()
        hot_segment(sim)
        sim.handle()
        sim.hot("2026-09-22 20:06:00")
        self.assertTrue(any("1/3" in line for line in sim.lines))


# ---------------------------------------------------------------------------
# 验证数据
# ---------------------------------------------------------------------------


class TestVerifyData(unittest.TestCase):
    def test_verify_from_is_none_until_somebody_handles(self):
        sim = Sim()
        hot_segment(sim)
        self.assertIsNone(sim.event.verify_from)

    def test_verify_starts_right_after_the_handle(self):
        sim = Sim()
        hot_segment(sim)
        sim.handle()
        sim.hot("2026-09-22 20:06:00")
        sim.hot("2026-09-22 20:07:00")
        self.assertEqual(sim.event.verify_from, 1)
        self.assertEqual([v["time"] for v in sim.event.verify],
                         ["2026-09-22 20:06:00", "2026-09-22 20:07:00"])

    def test_verify_holds_normals_too(self):
        """恢复路上的正常读数也得留在文件里 —— 只看得到结案那一条的话，
        「正常了几条」这件事在数据里是看不见的。"""
        sim = Sim()
        hot_segment(sim)
        sim.handle()
        for i in range(3):
            sim.normal(f"2026-09-22 20:{10 + i:02d}:00")
        self.assertEqual([v["status"] for v in sim.last.verify],
                         ["正常", "正常", "正常"])

    def test_verify_records_the_reading_not_just_the_status(self):
        sim = Sim()
        hot_segment(sim)
        sim.handle()
        sim.normal("2026-09-22 20:10:00")
        entry = sim.event.verify[0]
        self.assertEqual(entry["temperature"], 25.0)
        self.assertEqual(entry["humidity"], 60.0)
        self.assertEqual(entry["status"], "正常")

    def test_verify_is_capped_and_the_drop_is_counted(self):
        sim = Sim(verify_after=99, book=events.EventBook([NODE], 3, 99, verify_max=4))
        hot_segment(sim)
        sim.handle()
        for i in range(9):
            sim.hot(f"2026-09-22 20:{10 + i:02d}:00")
        self.assertEqual(len(sim.event.verify), 4)
        self.assertEqual(sim.event.verify_dropped, 5)

    def test_pending_count_survives_the_cap(self):
        """**这条是那个运行期计数器的全部理由。**

        verifyMax（存档留几条）和 verifyConsecutiveAbnormal（判据要几条）
        是两个独立的配置项，上限完全可能比阈值小。判据要是靠「把 verify
        从最新往回数」，那么丢过数据之后它永远数不够阈值，UNRESOLVED
        再也判不出来 —— 而且不报错，只是事件一直挂着。

        这里把上限故意配成 2、阈值配成 3：存档只能留两条，判据照样要能
        数到 3 并结案。
        """
        book = events.EventBook([NODE], recover_after=3, verify_after=3, verify_max=2)
        sim = Sim(book=book)
        hot_segment(sim)
        book.apply_action(NODE, events.HANDLE, when="2026-09-22 20:05:00")
        for i in range(3):
            sim.hot(f"2026-09-22 20:{10 + i:02d}:00")

        self.assertEqual(len(sim.last.verify), 2, "存档该按上限裁到 2 条")
        self.assertEqual(sim.last.verify_dropped, 1)
        self.assertEqual(sim.last.state, events.UNRESOLVED,
                         "存档丢过数据，判据就判不出来了 —— 计数器就是为了这个")

    def test_a_normal_resets_the_pending_count(self):
        """连续异常 —— 中间插一条正常就该从头数。"""
        sim = Sim()
        hot_segment(sim)
        sim.handle(when="2026-09-22 20:05:00")
        for minute in (6, 7):
            sim.hot(f"2026-09-22 20:{minute:02d}:00")
        self.assertEqual(sim.event.pending_abnormal, 2)
        sim.normal("2026-09-22 20:08:00")
        self.assertEqual(sim.event.pending_abnormal, 0)
        self.assertEqual(sim.event.state, events.HANDLING)

    def test_recovered_result_counts_the_verify_data(self):
        sim = Sim()
        hot_segment(sim)
        sim.handle()
        for i in range(3):
            sim.normal(f"2026-09-22 20:{10 + i:02d}:00")
        self.assertIn("验证数据 3 条", sim.last.result)


# ---------------------------------------------------------------------------
# 上限与挤掉
# ---------------------------------------------------------------------------


class TestEventsMax(unittest.TestCase):
    def test_oldest_closed_event_is_dropped_first(self):
        book = events.EventBook([NODE], 3, 3, events_max=2)
        sim = Sim(book=book)
        for round_no in range(3):
            base = round_no * 10
            for i in range(3):
                sim.hot(f"2026-09-22 20:{base + i:02d}:00")
            for i in range(3):
                sim.normal(f"2026-09-22 20:{base + 3 + i:02d}:00")
        self.assertEqual(len(book.events), 2)
        self.assertEqual(book.dropped, 1)
        # 留下的是最近的两条
        self.assertEqual([e.start_time for e in book.events],
                         ["2026-09-22 20:10:00", "2026-09-22 20:20:00"])

    def test_open_events_are_never_dropped(self):
        """开着的案子被挤掉 = 它永远结不了案。宁可超一点。"""
        book = events.EventBook([NODE], 3, 3, events_max=1)
        sim = Sim(book=book)
        hot_segment(sim)                       # 开出唯一一条，而且是开着的
        self.assertEqual(len(book.events), 1)
        self.assertEqual(book.dropped, 0)
        self.assertIsNotNone(book.open_event(NODE))

    def test_summary_counts_each_state(self):
        sim = Sim()
        hot_segment(sim)
        summary = sim.book.summary()
        self.assertEqual(summary[events.OPEN], 1)
        self.assertEqual(summary["total"], 1)


# ---------------------------------------------------------------------------
# 持久化
# ---------------------------------------------------------------------------


class TestPersistence(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "events.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_save_writes_readable_chinese(self):
        sim = Sim(book=events.EventBook([NODE], 3, 3, path=self.path))
        hot_segment(sim)
        text = self.path.read_text(encoding="utf-8")
        self.assertIn("连续偏热", text, "ensure_ascii=False 才能让文件里的人话能读")
        self.assertNotIn("\\u", text)

    def test_save_uses_lf_only(self):
        """默认的换行转换会把文件写成 CRLF，git 每次都报「整文件都改了」。"""
        sim = Sim(book=events.EventBook([NODE], 3, 3, path=self.path))
        hot_segment(sim)
        self.assertNotIn(b"\r\n", self.path.read_bytes())

    def test_no_tmp_file_left_behind(self):
        sim = Sim(book=events.EventBook([NODE], 3, 3, path=self.path))
        hot_segment(sim)
        leftovers = [p.name for p in self.path.parent.iterdir() if p.name != "events.json"]
        self.assertEqual(leftovers, [], f"留下了临时文件：{leftovers}")

    def test_file_has_the_toplevel_shape(self):
        sim = Sim(book=events.EventBook([NODE], 3, 3, path=self.path))
        hot_segment(sim)
        body = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(body["v"], events.EVENTS_VERSION)
        self.assertIsInstance(body["events"], list)
        self.assertEqual(body["summary"][events.OPEN], 1)

    def test_load_restores_history(self):
        book1 = events.EventBook([NODE], 3, 3, path=self.path)
        sim = Sim(book=book1)
        hot_segment(sim)
        sim.handle()
        for i in range(3):
            sim.normal(f"2026-09-22 20:{10 + i:02d}:00")

        book2 = events.EventBook([NODE], 3, 3, path=self.path)
        message = book2.load()
        self.assertIn("读回 1 条事件", message)
        self.assertEqual(book2.events[0].state, events.RECOVERED)
        self.assertEqual(book2.events[0].recovered_at, "2026-09-22 20:12:00")
        self.assertEqual(len(book2.events[0].verify), 3)
        self.assertEqual(book2.events[0].actions[0]["action"], events.HANDLE)

    def test_missing_file_is_not_an_error(self):
        book = events.EventBook([NODE], 3, 3, path=self.path)
        self.assertIn("从零开始", book.load())
        self.assertEqual(book.events, [])

    def test_memory_mode_says_so(self):
        book = events.EventBook([NODE], 3, 3, path=None)
        self.assertIn("内存模式", book.load())
        self.assertFalse(book.save(force=True), "内存模式下不该写任何东西")

    def test_corrupt_file_is_moved_aside_not_deleted(self):
        """读不出来的文件**挪走**，不是删掉 —— 那份损坏的文件是证据。"""
        self.path.write_text("{这不是 json", encoding="utf-8")
        book = events.EventBook([NODE], 3, 3, path=self.path)
        message = book.load()
        self.assertIn("读不出来", message)
        self.assertIn(".bad", message)
        self.assertTrue((self.path.parent / "events.json.bad").exists())
        self.assertEqual(book.events, [])

    def test_file_without_events_array_is_moved_aside(self):
        self.path.write_text('{"v": 1, "history": []}', encoding="utf-8")
        book = events.EventBook([NODE], 3, 3, path=self.path)
        self.assertIn("没有 events 数组", book.load())
        self.assertTrue((self.path.parent / "events.json.bad").exists())

    def test_broken_items_are_skipped_with_a_count(self):
        good = {"event_id": "dorm-b-20260922-200000", "nodeId": NODE,
                "start_time": "2026-09-22 20:00:00", "problem": "连续偏热",
                "state": events.RECOVERED, "result": "已恢复"}
        self.path.write_text(json.dumps(
            {"v": 1, "events": [good, {"nodeId": NODE}, "不是对象", [1]]},
            ensure_ascii=False), encoding="utf-8")
        book = events.EventBook([NODE], 3, 3, path=self.path)
        message = book.load()
        self.assertEqual(len(book.events), 1)
        self.assertIn("3 条读不懂已跳过", message)

    def test_unfinished_event_becomes_unresolved_on_startup(self):
        """core 重启 = 中间那段报文没人收，验证窗口凑不齐了。
        让它一直挂着的话，文件里会留下一条永远 OPEN 的案子 ——
        那看上去像「还在处理」，是假话。"""
        body = {"v": 1, "events": [{
            "event_id": "dorm-b-20260922-200000", "nodeId": NODE,
            "start_time": "2026-09-22 20:00:00", "problem": "连续偏热",
            "state": events.HANDLING, "verify_from": 1,
        }]}
        self.path.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")

        book = events.EventBook([NODE], 3, 3, path=self.path)
        message = book.load()
        self.assertIn("1 条没结案的旧事件按未恢复结案", message)
        self.assertEqual(book.events[0].state, events.UNRESOLVED)
        self.assertIn("core 重启", book.events[0].result)
        # 结案之后就得写回去，不然下次启动还会重复结一次
        again = events.EventBook([NODE], 3, 3, path=self.path)
        self.assertIn("读回 1 条事件", again.load())
        self.assertEqual(again.events[0].state, events.UNRESOLVED)

    def test_loading_does_not_reopen_anything(self):
        book = events.EventBook([NODE], 3, 3, path=self.path)
        sim = Sim(book=book)
        hot_segment(sim)
        book.save(force=True)

        book2 = events.EventBook([NODE], 3, 3, path=self.path)
        book2.load()
        self.assertIsNone(book2.open_event(NODE), "读回来的开放事件不该继续开着")

    def test_save_is_throttled_but_force_always_writes(self):
        """每条验证数据都 fsync 一次不值得，但状态迁移必须立刻落盘。"""
        ticks = iter([100.0, 100.2, 100.4, 200.0])
        book = events.EventBook([NODE], 3, 3, path=self.path, clock=lambda: next(ticks))
        sim = Sim(book=book)

        book._dirty = True
        self.assertTrue(book.save())                  # 100.0，第一次写
        book._dirty = True
        self.assertFalse(book.save(), "0.2 秒内不该再写一次")
        book._dirty = True
        self.assertFalse(book.save(), "0.4 秒内也不该")
        book._dirty = True
        self.assertTrue(book.save(), "过了节流窗口就该写")

    def test_save_returns_false_when_nothing_changed(self):
        book = events.EventBook([NODE], 3, 3, path=self.path)
        self.assertFalse(book.save(), "没有改动就不该碰磁盘")

    def test_verify_records_reach_the_disk_before_the_event_closes(self):
        """验证数据不能等结案那一下才落盘。

        只在开案/处理/结案三处 force 写的话，一条进了「处理中」却迟迟结不了案的
        事件（一直治不好那种，要等第 M 条异常才结案），中途收到的验证数据就全在
        内存里 —— core 被 Ctrl-C 或者崩掉，文件里只剩一条「处理中」加一个空的
        `verify`，恰恰把「处理之后到底收了几条、都是什么」这件事丢了。
        """
        ticks = iter(range(1000, 1100))     # 每调一次往前走 1 秒，节流窗口挡不住
        book = events.EventBook([NODE], 3, 3, path=self.path,
                                clock=lambda: float(next(ticks)))
        sim = Sim(book=book)
        hot_segment(sim)                      # 开案：force 写
        sim.handle()                          # 转处理中：force 写
        sim.normal("2026-09-22 20:11:00")     # 一条验证数据 —— 事件这时还开着

        on_disk = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(on_disk["events"][0]["state"], events.HANDLING)
        self.assertEqual(
            [item["status"] for item in on_disk["events"][0]["verify"]], ["正常"],
            "这条验证数据必须已经在文件里 —— 它是「处理之后好了几条」的唯一凭证")


# ---------------------------------------------------------------------------
# 红线：拿源码钉住
# ---------------------------------------------------------------------------


class TestRedLine(unittest.TestCase):
    """**这一组不是行为测试。** 上面那些测的是「现在的行为对不对」，
    这里测的是「以后想改坏也改不坏」—— 两条路都得在。

    行为测试有个天生的漏洞：它只能证明**你想到的那种**绕过被挡住了。
    这两条是结构性的：只要有人加了第二条通往 RECOVERED 的路，
    或者让 handle_command 摸到了节点状态，这里立刻红。
    """

    @classmethod
    def setUpClass(cls):
        cls.source = (ROOT / "events.py").read_text(encoding="utf-8")
        cls.core_source = (ROOT / "core.py").read_text(encoding="utf-8")

    def test_only_one_place_writes_recovered(self):
        hits = [i for i, line in enumerate(self.source.splitlines(), 1)
                if line.strip() == "event.state = RECOVERED"]
        self.assertEqual(len(hits), 1,
                         f"写 RECOVERED 的地方有 {len(hits)} 处，应该只有 1 处")

    def test_that_place_is_close_recovered(self):
        """那唯一一处必须落在 _close_recovered 里 —— 而且那个函数只能被
        observe 调用。改成「谁都能调一下」的话，这里就红了。"""
        lines = self.source.splitlines()
        hit = next(i for i, line in enumerate(lines) if line.strip() == "event.state = RECOVERED")
        owner = next(line.strip() for line in reversed(lines[:hit]) if line.startswith("    def "))
        self.assertTrue(owner.startswith("def _close_recovered("),
                        f"写 RECOVERED 的地方在 {owner} 里，应该只在 _close_recovered 里")

        callers = [i for i, line in enumerate(lines)
                   if "self._close_recovered(" in line and "def " not in line]
        self.assertEqual(len(callers), 1, "结案的入口多于一个")

    def test_apply_action_only_ever_writes_handling(self):
        """apply_action 里对 state 的赋值只有一句，而且是 HANDLING。

        比「不许出现 RECOVERED 这几个字」稳：注释里完全可以提它
        （这里正说着「判不出 UNRESOLVED」），提一句不会把谁改坏，
        真正要紧的是**赋值**。
        """
        body = self._function_body(self.source, "    def apply_action(")
        writes = [line.strip() for line in body.splitlines()
                  if line.strip().startswith("event.state =")]
        self.assertEqual(writes, ["event.state = HANDLING"])

    def test_apply_action_cannot_see_the_node(self):
        """它拿不到 NodeState，也就没有能力去改节点状态 ——
        这是「结构上做不到」，不是「约定上不做」。"""
        head = self.source.split("    def apply_action(")[1].split("    ) -> tuple")[0]
        self.assertNotIn("node:", head)
        self.assertNotIn("NodeState", head)

    def test_close_recovered_is_reached_only_through_observe(self):
        body = self._function_body(self.source, "    def observe(")
        self.assertIn("self._close_recovered(", body)
        self.assertIn("if int(node.abnormal_count) == 0", body)

    def test_handle_command_never_touches_node_state(self):
        """**核心的那一条。** handle_command 里不许出现 self.nodes ——
        出现一次就说明「按钮能改节点状态」这件事离发生只差一行。"""
        body = self._function_body(self.core_source, "    def handle_command(")
        self.assertNotIn("self.nodes", body)
        self.assertNotIn("node.apply", body)
        self.assertNotIn("publish_state", body)

    def test_handle_command_cannot_write_recovered_or_unresolved(self):
        body = self._function_body(self.core_source, "    def handle_command(")
        self.assertNotIn("RECOVERED", body)
        self.assertNotIn("UNRESOLVED", body)
        self.assertNotIn("recovered_at", body)

    def test_telemetry_path_asks_the_same_node_state(self):
        """事件层读的是 core 的那一份计数，不是自己另数一遍。"""
        body = self._function_body(self.core_source, "    def handle_message(")
        self.assertIn("node.apply(", body)
        self.assertIn("self.event_book.observe(", body)
        self.assertLess(body.index("node.apply("), body.index("self.event_book.observe("),
                        "先 apply 再 observe：反过来的话事件会比数据慢一条")

    @staticmethod
    def _function_body(source: str, signature: str) -> str:
        """从 `    def xxx(` 那行开始，到下一个同级 def 为止。

        **先把函数自己的文档字符串摘掉。** 那一句「这个方法一行都不碰
        self.nodes」正好会被「不许出现 self.nodes」这条检查绊倒 ——
        说明这条约束的话反过来触发了这条约束，这类假警报一次就够让人
        把整个检查注释掉了。
        """
        start = source.index(signature)
        rest = source[start + len(signature):]
        open_at = rest.find('"""')
        if open_at != -1:
            close_at = rest.find('"""', open_at + 3)
            if close_at != -1:
                rest = rest[:open_at] + rest[close_at + 3:]
        for marker in ("\n    def ", "\n    @", "\n\n\n"):
            cut = rest.find(marker)
            if cut != -1:
                rest = rest[:cut]
        return rest


# ---------------------------------------------------------------------------
# 和 core 的接线
# ---------------------------------------------------------------------------


def command_text(node_id: str = NODE, action: str = events.HANDLE,
                 when: str | None = None, **extra) -> str:
    body = {"nodeId": node_id, "action": action}
    if when is not None:
        body["time"] = when
    body.update(extra)
    return json.dumps(body, ensure_ascii=False)


class FakeClient:
    """和 test_core 里那个一样：把 core 想发的东西全记下来。"""

    def __init__(self) -> None:
        self.published: list[dict] = []
        self.subscribed: list[tuple] = []

    def publish(self, topic, payload=None, qos=0, retain=False, properties=None):
        self.published.append({"topic": topic, "payload": payload,
                               "qos": qos, "retain": retain})

    def subscribe(self, topic, qos=0):
        self.subscribed.append((topic, qos))

    def on(self, topic: str) -> list[dict]:
        return [p for p in self.published if p["topic"] == topic]


class TestValidateCommand(unittest.TestCase):
    def check(self, topic=None, text="", nodes=NODES):
        return core.validate_command(
            config.CMD_TOPIC if topic is None else topic, text, nodes)

    def test_a_good_command_passes(self):
        verdict = self.check(text=command_text(when="2026-09-22 20:02:30", source="web"))
        self.assertTrue(verdict.ok)
        self.assertEqual(verdict.record["nodeId"], NODE)
        self.assertEqual(verdict.record["action"], events.HANDLE)
        self.assertEqual(verdict.record["time"], "2026-09-22 20:02:30")
        self.assertEqual(verdict.record["source"], "web")

    def test_time_is_optional(self):
        self.assertIsNone(self.check(text=command_text()).record["time"])

    def test_source_is_optional(self):
        self.assertNotIn("source", self.check(text=command_text()).record)

    def test_wrong_topic_is_rejected(self):
        verdict = self.check(topic="dormmate/v1/cmd/dorm-b", text=command_text())
        self.assertFalse(verdict.ok)
        self.assertIn("不是指令 topic", verdict.reasons[0])

    def test_telemetry_topic_is_rejected_too(self):
        """拿遥测那条 topic 发指令也得拒 —— 反过来也一样，两边都不许串。"""
        verdict = self.check(topic=config.topic_for(NODE), text=command_text())
        self.assertFalse(verdict.ok)
        self.assertIn("不是指令 topic", verdict.reasons[0])

    def test_empty_payload_is_ignored_not_rejected(self):
        verdict = self.check(text="")
        self.assertTrue(verdict.ignored)
        self.assertFalse(verdict.ok)
        self.assertEqual(verdict.reasons[0].count("空报文"), 1)

    def test_bad_json_is_rejected(self):
        verdict = self.check(text="{不是 json")
        self.assertIn("指令 JSON 解析失败", verdict.reasons[0])

    def test_top_level_must_be_an_object(self):
        verdict = self.check(text="[1, 2]")
        self.assertIn("顶层不是对象（收到 list）", verdict.reasons[0])

    def test_missing_fields_are_named(self):
        verdict = self.check(text=json.dumps({"nodeId": NODE}))
        self.assertIn("指令缺少 action", verdict.reasons[0])

    def test_wrong_field_type_is_rejected(self):
        verdict = self.check(text=json.dumps({"nodeId": 7, "action": events.HANDLE}))
        self.assertIn("指令 nodeId 应为 str，实际是 int", verdict.reasons[0])

    def test_unknown_node_is_rejected_with_the_known_list(self):
        verdict = self.check(text=command_text(node_id="dorm-z"))
        self.assertIn("指令未知节点 'dorm-z'", verdict.reasons[0])
        self.assertIn("dorm-a", verdict.reasons[0])

    def test_unknown_action_lists_what_exists(self):
        verdict = self.check(text=command_text(action="open"))
        self.assertIn("指令不认识的 action 'open'", verdict.reasons[0])
        self.assertIn("handle", verdict.reasons[0])

    def test_action_is_not_case_folded(self):
        """'Handle' 也得拒 —— 折叠之后「按了没反应」会变成查不出的怪事。"""
        verdict = self.check(text=command_text(action="Handle"))
        self.assertFalse(verdict.ok)
        self.assertIn("大小写", verdict.reasons[0])

    def test_bad_time_format_is_rejected(self):
        verdict = self.check(text=command_text(when="2026/09/22 20:02:30"))
        self.assertIn("指令 time 格式不对", verdict.reasons[0])

    def test_time_shape_but_wrong_date_is_rejected(self):
        verdict = self.check(text=command_text(when="2026-02-30 20:02:30"))
        self.assertFalse(verdict.ok)

    def test_command_carries_no_reading(self):
        """指令里没有温度湿度 —— 拿它描述现场状况连字段都找不到。"""
        record = self.check(text=command_text()).record
        for key in ("temperature", "humidity", "status"):
            self.assertNotIn(key, record)


class TestCoreWiring(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "events.json"
        cfg = core.load_config()
        self.client = FakeClient()
        self.core = core.Core(cfg, client=self.client, quiet=True,
                              events_path=self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def feed(self, node_id=NODE, temperature=33.0, humidity=55.0, when=None):
        when = when or "2026-09-22 20:00:00"
        return self.core.handle_message(
            config.topic_for(node_id),
            json.dumps(record(node_id, temperature, humidity, when), ensure_ascii=False),
            now_wall=NOW)

    def cmd(self, text=None, topic=None, node_id=None, when=None):
        if text is None:
            text = command_text(node_id or NODE, when=when)
        return self.core.handle_command(topic or config.CMD_TOPIC, text)

    def test_telemetry_opens_an_event(self):
        self.feed()
        self.assertEqual(self.core.event_book.open_event(NODE).state, events.OPEN)

    def test_command_moves_it_to_handling(self):
        self.feed()
        self.assertTrue(self.cmd().ok)
        self.assertEqual(self.core.event_book.open_event(NODE).state, events.HANDLING)

    def test_telemetry_then_closes_it_as_recovered(self):
        self.feed()
        self.cmd(when="2026-09-22 20:05:00")
        for i, when in enumerate(("2026-09-22 20:10:00", "2026-09-22 20:11:00",
                                  "2026-09-22 20:12:00")):
            self.feed(temperature=25.0, humidity=60.0, when=when)
        event = self.core.event_book.events[0]
        self.assertEqual(event.state, events.RECOVERED)
        self.assertEqual(event.recovered_at, "2026-09-22 20:12:00")

    def test_event_is_written_to_the_file(self):
        self.feed()
        body = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(len(body["events"]), 1)
        self.assertEqual(body["events"][0]["state"], events.OPEN)

    def test_command_does_not_change_the_node(self):
        """**红线在 core 这一层的形态**：一条指令进来，节点状态一个数字都不变。

        比的是内存里那几栏**和快照里 nodes/priority 那两块**。
        不比整份快照：counters 里的 commands 本来就该 +1（那是记账，
        记的就是「有人按过」这件事），把它算进来是把两件不同的事混在一起。
        """
        self.feed()
        node = self.core.nodes[NODE]
        before = self.core.snapshot(NOW)
        before_node = (node.abnormal_count, node.abnormal_start, node.consecutive_normal)

        self.cmd()
        after = self.core.snapshot(NOW)

        self.assertEqual((node.abnormal_count, node.abnormal_start,
                          node.consecutive_normal), before_node)
        self.assertEqual(after["nodes"], before["nodes"])
        self.assertEqual(after["priority"], before["priority"])

    def test_command_does_not_republish_the_snapshot(self):
        """快照里现在没有事件的字段，指令进来它一个字节都不会变。"""
        self.feed()
        count = len(self.client.on(config.STATE_TOPIC))
        self.cmd()
        self.assertEqual(len(self.client.on(config.STATE_TOPIC)), count)

    def test_command_with_no_event_is_counted_but_not_rejected(self):
        self.feed(temperature=25.0, humidity=60.0)          # 正常，没有案子
        verdict = self.cmd()
        self.assertTrue(verdict.ok, "指令本身是好的，只是没案子可办")
        self.assertEqual(self.core.counters.commands, 1)
        self.assertEqual(self.core.counters.command_rejected, 0)
        self.assertEqual(self.client.on(config.REJECT_TOPIC), [])

    def test_bad_command_goes_to_the_reject_topic(self):
        verdict = self.cmd(text=command_text(action="open"))
        self.assertFalse(verdict.ok)
        self.assertEqual(self.core.counters.command_rejected, 1)
        self.assertEqual(self.core.counters.commands, 0)
        self.assertNotEqual(self.client.on(config.REJECT_TOPIC), [])

    def test_reject_is_not_retained(self):
        self.cmd(text="{不是 json")
        self.assertIs(self.client.on(config.REJECT_TOPIC)[0]["retain"], False)

    def test_counters_show_up_in_the_snapshot(self):
        self.feed()
        self.cmd()
        counters = self.core.snapshot(NOW)["counters"]
        self.assertEqual(counters["commands"], 1)
        self.assertEqual(counters["commandRejected"], 0)
        self.assertEqual(counters["received"], 1)

    def test_junk_on_the_command_topic_does_not_become_telemetry(self):
        """拿指令那条 topic 发一条**看起来像遥测**的报文：
        必须按指令拒掉，绝不能落进节点状态里。"""
        telemetry = json.dumps(record(), ensure_ascii=False)
        self.cmd(text=telemetry)
        self.assertEqual(self.core.counters.command_rejected, 1)
        self.assertEqual(self.core.counters.received, 0)
        self.assertIsNone(self.core.nodes[NODE].latest)

    def test_priority_reason_is_recorded_on_the_event(self):
        self.feed()
        self.assertTrue(self.core.event_book.open_event(NODE).priority_reasons)

    def test_events_load_message_is_available_for_run(self):
        self.assertIn("从零开始", self.core.events_load_message)

    def test_no_path_means_no_file(self):
        c = core.Core(core.load_config(), client=FakeClient(), quiet=True)
        c.handle_message(config.topic_for(NODE),
                         json.dumps(record(), ensure_ascii=False), now_wall=NOW)
        self.assertIn("内存模式", c.events_load_message)

    def test_on_message_routes_the_command_topic(self):
        class Message:
            def __init__(self, topic, payload):
                self.topic = topic
                self.payload = payload.encode("utf-8")

        self.feed()
        self.core.on_message(None, None, Message(config.CMD_TOPIC, command_text()))
        self.assertEqual(self.core.event_book.open_event(NODE).state, events.HANDLING)

    def test_on_message_still_treats_telemetry_as_telemetry(self):
        class Message:
            def __init__(self, topic, payload):
                self.topic = topic
                self.payload = payload.encode("utf-8")

        self.core.on_message(None, None, Message(
            config.topic_for(NODE), json.dumps(record(), ensure_ascii=False)))
        self.assertEqual(self.core.counters.received, 1)
        self.assertEqual(self.core.counters.commands, 0)


class TestEventsConfig(unittest.TestCase):
    def test_events_block_is_required(self):
        """不给默认值：配置里把键名写错（eventsVerifyMax 写成 eventsVerify）
        会变成一个静默的行为差异 —— 文件里写着 20，跑起来按 50 走，谁也不报错。"""
        cfg = core.load_config()
        del cfg["events"]
        problems = _config_problems(cfg)
        self.assertTrue(any("events 应该是一个对象" in p for p in problems), problems)

    def test_events_values_must_be_positive_ints(self):
        for key, value in (("verifyConsecutiveAbnormal", 0),
                           ("eventsMax", "200"),
                           ("eventsVerifyMax", True)):
            with self.subTest(key=key):
                cfg = core.load_config()
                cfg["events"][key] = value
                problems = _config_problems(cfg)
                self.assertTrue(any(key in p for p in problems), problems)

    def test_shipped_values(self):
        cfg = core.load_config()
        self.assertEqual(cfg["events"]["verifyConsecutiveAbnormal"], 3)
        self.assertGreaterEqual(cfg["events"]["eventsMax"], 1)
        self.assertGreaterEqual(cfg["events"]["eventsVerifyMax"], 1)


class TestD3Scenario(unittest.TestCase):
    """d3_event.json 这份剧本**本身**站不站得住。

    放在这个文件里而不是 test_simulator.py：这份剧本是 D3 的交付物，
    它和 events.py 是同一次改动，出问题也该一起红。

    test_replay_through_core 是这一组里最要紧的那条：它把剧本逐帧喂给真的
    Core（不连 broker），最后断言 dorm-b 结在 RECOVERED、dorm-c 结在
    UNRESOLVED。README 里那句「跑一遍看看事件变成已恢复」要是哪天不成立了，
    这条会先红 —— 而不是等到演示那天。
    """

    @classmethod
    def setUpClass(cls):
        cls.path = ROOT / "simulator" / "scenarios" / "d3_event.json"
        cls.steps, cls.interval = simulator.load_script(cls.path)

    def test_it_loads(self):
        self.assertEqual(len(self.steps), 14)
        self.assertEqual(self.interval, 1.0)

    def test_exactly_two_command_frames(self):
        commands = [s for s in self.steps if isinstance(s, simulator.Command)]
        self.assertEqual(len(commands), 2)
        self.assertEqual([c.node for c in commands], [NODE, "dorm-c"])
        self.assertEqual([c.action for c in commands], [events.HANDLE, events.HANDLE])

    def test_only_known_nodes_appear(self):
        """剧本里写了 config.NODE_IDS 之外的节点，core 会整条拒收，
        而现象是「剧本跑完了但什么都没发生」。这里先拦住。"""
        for step in self.steps:
            with self.subTest(node=step.node):
                self.assertIn(step.node, config.NODE_IDS)

    def test_the_timeline_only_moves_forward(self):
        stamps = [events.parse_time(s.time.strftime(config.TIME_FORMAT))
                  for s in self.steps]
        self.assertEqual(stamps, sorted(stamps))

    def test_the_two_acts_are_where_they_should_be(self):
        """第一幕 7 帧（3 条偏热 + 1 条指令 + 3 条正常），第二幕 7 帧，共 14。"""
        self.assertEqual([s.node for s in self.steps[:7]], [NODE] * 7)
        self.assertEqual([s.node for s in self.steps[7:]], ["dorm-c"] * 7)

    def test_first_act_is_hot_then_normal(self):
        """第一幕：先偏热，handle 之后全正常 —— 这条路径必须能走通。"""
        for step in self.steps[:3]:
            self.assertEqual(compute_status(step.temperature, step.humidity), "偏热")
        for step in self.steps[4:7]:
            self.assertEqual(compute_status(step.temperature, step.humidity), "正常")

    def test_second_act_stays_humid(self):
        """第二幕：handle 之后依旧偏湿 —— 对照，证明「按了就好」不存在。"""
        for step in self.steps[11:]:
            self.assertEqual(compute_status(step.temperature, step.humidity), "偏湿")

    def test_a_frame_cannot_be_both_telemetry_and_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.json"
            bad.write_text(json.dumps({"frames": [
                {"node": NODE, "temperature": 31, "humidity": 55, "action": "handle"}]},
                ensure_ascii=False), encoding="utf-8")
            with self.assertRaises(simulator.ScriptError) as caught:
                simulator.load_script(bad)
            self.assertIn("一帧只能说一件事", str(caught.exception))

    def test_a_command_frame_with_an_unknown_action_is_refused_at_load(self):
        """合法 action 的真源是 events.py —— 剧本不该能写出 core 会拒的指令。"""
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.json"
            bad.write_text(json.dumps({"frames": [
                {"node": NODE, "action": "open"}]}, ensure_ascii=False), encoding="utf-8")
            with self.assertRaises(simulator.ScriptError) as caught:
                simulator.load_script(bad)
            self.assertIn("不认识", str(caught.exception))

    def test_repeat_works_on_a_command_frame_too(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rep.json"
            path.write_text(json.dumps({"frames": [
                {"node": NODE, "action": "handle", "repeat": 2}]},
                ensure_ascii=False), encoding="utf-8")
            steps, _ = simulator.load_script(path)
            self.assertEqual(len(steps), 2)
            self.assertTrue(all(isinstance(s, simulator.Command) for s in steps))

    # ---- 端到端：把剧本逐帧喂给真的 Core ----

    def test_replay_through_core(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "events.json"
            client = FakeClient()
            brain = core.Core(core.load_config(), client=client, quiet=True,
                              events_path=path)

            for step in self.steps:
                if isinstance(step, simulator.Command):
                    verdict = brain.handle_command(config.CMD_TOPIC, simulator.dumps(
                        simulator.build_command_payload(step.node, step.action,
                                                        now=step.time)))
                else:
                    verdict = brain.handle_message(
                        config.topic_for(step.node),
                        simulator.dumps(simulator.build_payload(
                            step.node, step.temperature, step.humidity, now=step.time)))
                self.assertTrue(verdict.ok, f"剧本里有一帧被拒了：{step}")

            self.assertEqual(len(brain.event_book.events), 2)
            first, second = brain.event_book.events

            # 第一幕：handle 之后数据回来了 -> 自动恢复
            self.assertEqual(first.node_id, NODE)
            self.assertEqual(first.state, events.RECOVERED)
            self.assertEqual(first.recovered_at, "2026-09-22 20:05:00")
            self.assertEqual(first.start_time, "2026-09-22 20:00:00")
            self.assertTrue(first.handled)
            self.assertEqual(first.verify_from, 1)

            # 第二幕：handle 之后还是异常 -> 未恢复
            self.assertEqual(second.node_id, "dorm-c")
            self.assertEqual(second.state, events.UNRESOLVED)
            self.assertIsNone(second.recovered_at)

            # 两幕的对照就是这一对：都按了 handle，一个绿一个没绿 ——
            # 区别只在那之后收到的数据。
            self.assertNotEqual(first.state, second.state)

            # 落盘文件里也看得到这两条 —— 验收时要看的就是这个文件
            body = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual([e["state"] for e in body["events"]],
                             [events.RECOVERED, events.UNRESOLVED])
            self.assertEqual(body["summary"][events.RECOVERED], 1)
            self.assertEqual(body["summary"][events.UNRESOLVED], 1)

    def test_replay_never_let_a_command_write_recovered(self):
        """**红线的端到端形态**：第一幕的 recovered_at 必须晚于 handle。

        取的是报文时间对比 —— 恢复时刻早于「按下处理」的那一刻，
        就说明那个字段不是数据写上去的。
        """
        with tempfile.TemporaryDirectory() as tmp:
            brain = core.Core(core.load_config(), client=FakeClient(), quiet=True,
                              events_path=Path(tmp) / "events.json")
            for step in self.steps:
                if isinstance(step, simulator.Command):
                    brain.handle_command(config.CMD_TOPIC, simulator.dumps(
                        simulator.build_command_payload(step.node, step.action,
                                                        now=step.time)))
                else:
                    brain.handle_message(
                        config.topic_for(step.node),
                        simulator.dumps(simulator.build_payload(
                            step.node, step.temperature, step.humidity, now=step.time)))

            first = brain.event_book.events[0]
            self.assertGreater(events.parse_time(first.recovered_at),
                               events.parse_time(first.actions[0]["time"]),
                               "恢复时刻在按下处理之前 —— 那个字段不是数据写的")


class TestSendCmd(unittest.TestCase):
    """simulator/send_cmd.py —— 相当于前端那个按钮，所以它也要有测试。"""

    def test_defaults(self):
        args = simulator_send_cmd.parse_args([])
        self.assertEqual(args.node, config.DEFAULT_NODE_ID)
        self.assertEqual(args.action, events.HANDLE)

    def test_message_shape(self):
        args = simulator_send_cmd.parse_args(["--node", NODE, "--time", "2026-09-22 20:02:30",
                                              "--source", "web"])
        body = json.loads(simulator_send_cmd.build_message(args))
        self.assertEqual(body, {"nodeId": NODE, "action": events.HANDLE,
                                "time": "2026-09-22 20:02:30", "source": "web"})

    def test_no_readings_in_the_message(self):
        """指令里没有温度湿度 —— 「我处理完了已经好了」连字段都找不到。"""
        body = json.loads(simulator_send_cmd.build_message(
            simulator_send_cmd.parse_args(["--node", NODE])))
        for key in ("temperature", "humidity", "status"):
            self.assertNotIn(key, body)

    def test_bad_time_is_refused_before_sending(self):
        args = simulator_send_cmd.parse_args(["--time", "20:02:30"])
        with self.assertRaises(ValueError) as caught:
            simulator_send_cmd.build_message(args)
        self.assertIn("--time 要写成", str(caught.exception))

    def test_clear_sends_an_empty_payload(self):
        args = simulator_send_cmd.parse_args(["--clear"])
        self.assertEqual(simulator_send_cmd.build_message(args), "")

    def test_clear_and_raw_cannot_be_combined(self):
        args = simulator_send_cmd.parse_args(["--clear", "--raw", "{}"])
        with self.assertRaises(ValueError):
            simulator_send_cmd.build_message(args)

    def test_raw_goes_through_untouched(self):
        text = '{"nodeId":"dorm-b","action":"open"}'
        args = simulator_send_cmd.parse_args(["--raw", text])
        self.assertEqual(simulator_send_cmd.build_message(args), text)

    def test_unknown_action_is_refused_by_argparse(self):
        # argparse 会往 stderr 打一段用法说明 —— 接走它，别把测试输出刷乱
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                simulator_send_cmd.parse_args(["--action", "open"])

    def test_dry_run_does_not_connect(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(simulator_send_cmd.main(["--node", NODE, "--dry-run"]), 0)


def _config_problems(cfg: dict) -> list[str]:
    """把一份改坏了的配置按 load_config 的字段检查过一遍，收集问题清单。

    走的是同一个 load_config（写进临时文件再读），不是在测试里重抄一遍规则。
    """
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "cfg.json"
        target.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
        try:
            core.load_config(target)
        except core.ConfigError as exc:
            return str(exc).splitlines()
        return []


if __name__ == "__main__":
    unittest.main(verbosity=2)
