"""D2 的三套剧本：不是给人读的演示稿，是**能被断言**的测试。

剧本本身只说了「发什么」，说不了「所以优先关注变成了谁」。所以这里把每套剧本
逐帧喂给 core，把每一步的结论记下来，再拿它跟预期的轨迹对 —— 剧本里任何一帧
改动（改个数、调个时间、换个顺序）都会在这里现形。

这样做的理由：另写一份「预期结果」的文档是没用的，它不会因为剧本变了而变红。
而「优先关注跟着数据自己变」这件事，恰恰是这一阶段要证的东西。

预期轨迹只记**换人的那几步**（同一个人连续领先不重复记），因为
「没有乱跳」也是结论的一部分：中间那些空档正好证明了它稳。

    py -3.14 -m unittest tests.test_scenarios -v
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config  # noqa: E402
import core  # noqa: E402
from simulator.simulator import build_payload, load_script  # noqa: E402

SCENARIOS = Path(__file__).resolve().parent.parent / "simulator" / "scenarios"

# 固定一个墙上时间喂给每一条报文：这样「在线」这件事是确定的，
# 轨迹就只反映「数据说了什么」，不受跑的时候机器快慢影响。
NOW = 1_700_000_000.0


def run_script(name: str) -> tuple[list[tuple[str, str, str | None, str]], int]:
    """跑一套剧本 → (换人轨迹, 帧数)。

    轨迹的每一项是 (报文时间, 触发它的节点, 换成了谁, 那时的理由)。
    「换成了谁」为 None = 没有任何节点需要优先关注。
    """
    frames, _ = load_script(SCENARIOS / f"{name}.json")
    c = core.Core(core.load_config(), client=None, quiet=True)

    trace: list[tuple[str, str, str | None, str]] = []
    previous = object()          # 哨兵：和「还没有优先关注」区分开
    for frame in frames:
        payload = build_payload(frame.node, frame.temperature, frame.humidity,
                                now=frame.time, seq=1)
        c.handle_message(config.topic_for(frame.node),
                         json.dumps(payload, ensure_ascii=False), now_wall=NOW)
        top = c.priority(now_wall=NOW)
        winner = top.node_id if top else None
        if winner != previous:
            trace.append((
                payload["time"], frame.node, winner,
                top.reason if top else "没有需要优先关注的节点",
            ))
            previous = winner
    return trace, len(frames)


def load_raw(name: str) -> dict:
    return json.loads((SCENARIOS / f"{name}.json").read_text(encoding="utf-8"))


def frame_rows(name: str) -> list[dict]:
    """剧本里真正的数据帧（跳过只有 comment 的排版帧）。"""
    return [f for f in load_raw(name)["frames"]
            if "temperature" in f and "humidity" in f]


class TestCase1(unittest.TestCase):
    """时长决出，然后靠恢复交出去。"""

    def test_轨迹(self):
        trace, frames = run_script("d2_case1")
        self.assertEqual(frames, 15)
        self.assertEqual(
            [(t, winner) for t, _, winner, _ in trace],
            [
                ("2026-09-22 20:00:00", None),      # 第一条正常，还没什么可看的
                ("2026-09-22 20:00:00", "dorm-b"),  # b 起了一段，c 还没到
                ("2026-09-22 20:09:00", "dorm-c"),  # b 凑够三条正常 → 交接
                ("2026-09-22 20:15:00", None),      # c 也结束 → 空
            ],
        )

    def test_dormb恢复路上的两条不算数(self):
        """收到第 1、2 条正常时，优先关注不许换人 —— 这一段还没结束。"""
        trace, _ = run_script("d2_case1")
        # 20:07 和 20:08 各投了一条正常，轨迹里却没有这两步
        self.assertNotIn("2026-09-22 20:07:00", [t for t, *_ in trace])
        self.assertNotIn("2026-09-22 20:08:00", [t for t, *_ in trace])

    def test_第一条异常自己就是赢家(self):
        _, _, winner, reason = run_script("d2_case1")[0][1]
        self.assertEqual((winner, reason),
                         ("dorm-b", "已连续偏热 不到 1 分钟（1 次），是目前唯一的异常节点"))


class TestCase2(unittest.TestCase):
    """四步判据各显一次，每一次的理由都得说在点子上。"""

    def test_轨迹(self):
        trace, frames = run_script("d2_case2")
        self.assertEqual(frames, 17)
        self.assertEqual(
            [(t, winner) for t, _, winner, _ in trace],
            [
                ("2026-09-22 20:00:00", "dorm-a"),   # 全平 → 第 4 步字典序
                ("2026-09-22 20:01:00", "dorm-b"),   # 第 2 步：时长并列，条数多
                ("2026-09-22 20:06:00", "dorm-a"),   # 第 1 步：时长
                ("2026-09-22 20:12:00", "dorm-b"),   # 第 1 步：b 那一段没断过
                ("2026-09-22 20:15:00", "dorm-a"),   # b 恢复结束 → 交接
                ("2026-09-22 20:20:00", None),
            ],
        )

    def test_每一步的理由说的是真的那一步(self):
        trace, _ = run_script("d2_case2")
        reasons = {t: reason for t, _, _, reason in trace}
        # 第 2 步赢的那次，理由必须提「次数」，不能含糊成「持续时间最长」
        self.assertIn("持续时间和 dorm-a 一样长，异常次数最多",
                      reasons["2026-09-22 20:01:00"])
        # 第 1 步赢的那几次，理由就是「持续时间最长」
        self.assertIn("持续时间最长", reasons["2026-09-22 20:06:00"])
        self.assertIn("持续时间最长", reasons["2026-09-22 20:12:00"])

    def test_并列时靠字典序定下来(self):
        """前四步全平那一刻，结论是 a 而不是 b，靠的是 nodeId 顺序。

        这一步只在快照里看得见（赢家没变，日志不打印），所以这里直接看快照。
        """
        frames, _ = load_script(SCENARIOS / "d2_case2.json")
        c = core.Core(core.load_config(), client=None, quiet=True)
        for frame in frames[:2]:                      # a 和 b 各来一条，完全并列
            payload = build_payload(frame.node, frame.temperature, frame.humidity,
                                    now=frame.time, seq=1)
            c.handle_message(config.topic_for(frame.node),
                             json.dumps(payload, ensure_ascii=False), now_wall=NOW)

        snapshot = c.snapshot(now_wall=NOW)
        self.assertEqual(snapshot["priority"]["nodeId"], "dorm-a")
        self.assertIn("和 dorm-b 完全并列，按节点名顺序排在前面",
                      snapshot["priority"]["reason"])

    def test_安静过的节点只要这一段没结束时长就还在涨(self):
        """20:12 那一步：b 中间空了 11 分钟，但这一段没结束，于是反超 a。

        拿「多久没收到消息」当时长的话，b 该是最短的；正是这条断言把
        「时长 = 这一段从开始到现在」这个定义钉住。
        """
        trace, _ = run_script("d2_case2")
        step = [x for x in trace if x[0] == "2026-09-22 20:12:00"][0]
        self.assertEqual((step[1], step[2]), ("dorm-b", "dorm-b"))
        self.assertIn("12 分钟", step[3])


class TestCase3(unittest.TestCase):
    """时长和条数全打平，由严重度决出。"""

    def test_轨迹(self):
        trace, frames = run_script("d2_case3")
        self.assertEqual(frames, 14)
        self.assertEqual(
            [(t, winner) for t, _, winner, _ in trace],
            [
                ("2026-09-22 20:00:00", "dorm-a"),   # a 先到，那一刻只有它异常
                ("2026-09-22 20:00:00", "dorm-b"),   # b 一到，严重度把 b 顶上去
                ("2026-09-22 20:08:00", "dorm-a"),   # b 攒够三条正常 → 交接
                ("2026-09-22 20:14:00", None),
            ],
        )

    def test_严重度那一步真的被走到了(self):
        trace, _ = run_script("d2_case3")
        step = [x for x in trace if x[2] == "dorm-b"][0]
        self.assertEqual(step[1], "dorm-b")
        self.assertIn("偏湿比偏冷更要紧", step[3])

    def test_第一条理由说的是唯一而不是时长最长(self):
        # 只有一个异常节点时，比时长那一步根本没发生过，不能说「持续时间最长」
        trace, _ = run_script("d2_case3")
        self.assertIn("是目前唯一的异常节点", trace[0][3])


class TestScriptsAreConsistent(unittest.TestCase):
    """三套剧本共同要满足的硬条件 —— 不满足的话，上面那些预期全是幻觉。"""

    NAMES = ("d2_case1", "d2_case2", "d2_case3")

    def test_每套剧本都用上了三个节点(self):
        for name in self.NAMES:
            with self.subTest(script=name):
                used = {f["node"] for f in frame_rows(name)}
                self.assertEqual(used, set(config.NODE_IDS))

    def test_每个节点的时间都往前走(self):
        """同一个节点后一帧的时间不许比前一帧早。

        core 用报文时间算时长，倒着来的时间会算出负数（被夹到 0），
        于是「持续了多久」变成一句空话，而且不报错。
        """
        for name in self.NAMES:
            for node in config.NODE_IDS:
                with self.subTest(script=name, node=node):
                    times = [f["time"] for f in frame_rows(name) if f["node"] == node]
                    self.assertEqual(times, sorted(times))

    def test_每套剧本至少换两次人(self):
        """「优先关注跟着数据自己变」是这一阶段要证的事，只换一次不够。"""
        for name in self.NAMES:
            with self.subTest(script=name):
                trace, _ = run_script(name)
                winners = [w for _, _, w, _ in trace]
                # 相邻重复已经合并过了，所以这里数的是「不同的人/状态」
                self.assertGreaterEqual(len(winners), 3, f"{name} 只换了 {len(winners)-1} 次")

    def test_每套剧本都从有异常走到没有异常(self):
        """结尾必须是「三个都正常」——收尾状态得看得见，方便截图。"""
        for name in self.NAMES:
            with self.subTest(script=name):
                trace, _ = run_script(name)
                self.assertIsNone(trace[-1][2])

    def test_描述和注释是给人看的(self):
        for name in self.NAMES:
            with self.subTest(script=name):
                raw = load_raw(name)
                self.assertTrue(raw.get("description"))
                self.assertTrue(raw.get("_note"))
                self.assertGreater(raw.get("interval", 0), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
