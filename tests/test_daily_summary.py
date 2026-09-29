"""Step 8-2 的测试：模拟日数据的生成、连续异常段、今日摘要、报告区块。

    py -3.14 -m unittest discover -s tests -t . -v

需要 pandas（装在 64 位 Python 3.14 里），所以用 py -3.14 跑。
"""

from __future__ import annotations

import io
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

import pandas as pd

import status_rules
from analysis import analysis, daily_summary, make_sim_data, rules

BOM = chr(0xFEFF)

# 一天里几条真实存在的时间，省得每个用例都从 00:00 铺起
T = "2026-09-22 %s:00"


def frame(rows, columns=("nodeId", "time", "rule_status")) -> pd.DataFrame:
    """(nodeId, time, rule_status) 三元组 -> DataFrame。

    temperature / humidity 一律留空：这几个用例关心的是分段，不是数值。
    """
    data = {name: [row[index] for row in rows] for index, name in enumerate(columns)}
    return pd.DataFrame(data)


def full_frame(rows) -> pd.DataFrame:
    """(nodeId, time, temperature, humidity, status) -> 带 rule_status 的 DataFrame。

    rule_status 直接抄 status —— 这些用例是手写的数据，status 就当它是
    规则算出来的。真实路径上 rule_status 由 add_rule_status() 现算，
    那条路在 TestBuildDailySummary 里单独测。
    """
    data = {
        "nodeId": [row[0] for row in rows],
        "time": [row[1] for row in rows],
        "temperature": [row[2] for row in rows],
        "humidity": [row[3] for row in rows],
        "status": [row[4] for row in rows],
    }
    out = pd.DataFrame(data)
    out["rule_status"] = out["status"]
    return out


def write_csv(text: str, name: str = "day.csv", bom: bool = True) -> Path:
    """把文本写成临时 CSV，默认带 BOM，模拟网页导出的文件。"""
    path = Path(tempfile.mkdtemp()) / name
    path.write_text((BOM if bom else "") + text, encoding="utf-8", newline="")
    return path


def capture(func, *args, **kwargs) -> str:
    buf = io.StringIO()
    with redirect_stdout(buf):
        func(*args, **kwargs)
    return buf.getvalue()


# ---------------------------------------------------------------- 小工具


class TestCell(unittest.TestCase):
    def test_普通值转字符串并去空白(self):
        self.assertEqual(daily_summary._cell("  dorm-a  "), "dorm-a")
        self.assertEqual(daily_summary._cell(31), "31")

    def test_NaN和None都给空串(self):
        self.assertEqual(daily_summary._cell(float("nan")), "")
        self.assertEqual(daily_summary._cell(None), "")

    def test_数字NaN不会被打成字符串nan(self):
        # str(nan) 是 'nan'，四个字母 —— 报告里出现这个东西没人知道是什么
        self.assertNotEqual(daily_summary._cell(float("nan")), "nan")


class TestClock(unittest.TestCase):
    def test_切出时分(self):
        self.assertEqual(daily_summary._clock("2026-09-22 14:10:00"), "14:10")

    def test_太短就原样返回(self):
        # 宁可把原样显示出来让人看见格式不对，也不要抛异常把整段摘要搞没
        self.assertEqual(daily_summary._clock("14:10"), "14:10")
        self.assertEqual(daily_summary._clock(""), "")


class TestMinutes(unittest.TestCase):
    def test_正常相减(self):
        self.assertEqual(
            daily_summary._minutes("2026-09-22 14:10:00", "2026-09-22 14:50:00"), 40)

    def test_跨天(self):
        self.assertEqual(
            daily_summary._minutes("2026-09-22 23:55:00", "2026-09-23 00:15:00"), 20)

    def test_解析不出来给None而不是0(self):
        # 给 0 的话摘要会写「持续 0 分钟」，看着像个真实测量值
        self.assertIsNone(daily_summary._minutes("", "2026-09-22 14:50:00"))
        self.assertIsNone(daily_summary._minutes("2026-09-22 14:10:00", "上午"))
        self.assertIsNone(daily_summary._minutes(None, None))

    def test_时长文本(self):
        self.assertEqual(daily_summary._duration_text(40), "40 分钟")
        self.assertEqual(daily_summary._duration_text(0), "0 分钟")
        self.assertEqual(daily_summary._duration_text(None), "时长未知")


# ---------------------------------------------------------------- 找事件


class TestFindDailyEvents(unittest.TestCase):
    def test_一段异常后面恢复正常(self):
        df = frame([
            ("dorm-b", T % "14:10", "偏热"),
            ("dorm-b", T % "14:30", "偏热"),
            ("dorm-b", T % "14:50", "偏热"),
            ("dorm-b", T % "14:55", "正常"),
        ])
        events = daily_summary.find_daily_events(df)

        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(event["nodeId"], "dorm-b")
        self.assertEqual(event["start"], T % "14:10")
        self.assertEqual(event["end"], T % "14:50")
        self.assertEqual(event["minutes"], 40)
        self.assertEqual(event["status"], "偏热")
        self.assertEqual(event["count"], 3)
        self.assertTrue(event["recovered"])

    def test_结束仍异常就是没恢复(self):
        df = frame([
            ("dorm-c", T % "21:30", "偏湿"),
            ("dorm-c", T % "23:55", "偏湿"),
        ])
        events = daily_summary.find_daily_events(df)
        self.assertFalse(events[0]["recovered"])

    def test_正常结尾不算恢复不了(self):
        # 最后一条是正常 —— 这一段确实结束了
        df = frame([
            ("dorm-b", T % "14:10", "偏热"),
            ("dorm-b", T % "14:15", "正常"),
        ])
        self.assertTrue(daily_summary.find_daily_events(df)[0]["recovered"])

    def test_段里换状态类型不改口(self):
        # 段里从偏热变成偏湿仍然是同一段，类型取【开段时】那个。
        # 取最后那个的话，摘要会说「14:10 起持续偏湿」——14:10 明明是偏热。
        df = frame([
            ("dorm-b", T % "14:10", "偏热"),
            ("dorm-b", T % "14:15", "偏热"),
            ("dorm-b", T % "14:20", "偏湿"),
            ("dorm-b", T % "14:25", "偏湿"),
            ("dorm-b", T % "14:30", "正常"),
        ])
        event = daily_summary.find_daily_events(df)[0]
        self.assertEqual(event["status"], "偏热")
        self.assertEqual(event["count"], 4)
        # 最后一条异常是 14:25（14:30 已经正常了），所以是 15 分钟不是 20
        self.assertEqual(event["minutes"], 15)

    def test_起点不动(self):
        # 段里再来异常数据只是延长，起点不许往后挪
        df = frame([
            ("dorm-b", T % "14:10", "偏热"),
            ("dorm-b", T % "14:20", "偏热"),
            ("dorm-b", T % "14:30", "偏热"),
        ])
        self.assertEqual(daily_summary.find_daily_events(df)[0]["start"], T % "14:10")

    def test_同一节点两段(self):
        df = frame([
            ("dorm-b", T % "09:00", "偏冷"),
            ("dorm-b", T % "09:10", "正常"),
            ("dorm-b", T % "14:10", "偏热"),
            ("dorm-b", T % "14:50", "正常"),
        ])
        events = daily_summary.find_daily_events(df)
        self.assertEqual([e["start"] for e in events], [T % "09:00", T % "14:10"])
        self.assertEqual([e["status"] for e in events], ["偏冷", "偏热"])

    def test_节点之间互不串(self):
        # 两个节点交替出现，各自算各的段
        df = frame([
            ("dorm-a", T % "14:10", "偏热"),
            ("dorm-b", T % "14:20", "偏湿"),
            ("dorm-a", T % "14:30", "偏热"),
            ("dorm-b", T % "14:40", "偏湿"),
            ("dorm-a", T % "14:50", "正常"),
            ("dorm-b", T % "15:00", "正常"),
        ])
        events = daily_summary.find_daily_events(df)
        self.assertEqual([(e["nodeId"], e["count"], e["status"]) for e in events],
                         [("dorm-a", 2, "偏热"), ("dorm-b", 2, "偏湿")])

    def test_缺失值行既不开始也不结束段(self):
        # 温湿度缺一个就判不出状态，那不是环境异常，是「没有可用数据」。
        # 和看板一致：脏报文整条丢掉，正在进行的段不受影响。
        df = frame([
            ("dorm-b", T % "14:00", "偏热"),
            ("dorm-b", T % "14:05", daily_summary.MISSING),
            ("dorm-b", T % "14:10", "偏热"),
            ("dorm-b", T % "14:15", "正常"),
        ])
        events = daily_summary.find_daily_events(df)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["start"], T % "14:00")
        self.assertEqual(events[0]["end"], T % "14:10")
        self.assertEqual(events[0]["count"], 2)
        self.assertTrue(events[0]["recovered"])

    def test_只有缺失值不产生事件(self):
        df = frame([
            ("dorm-b", T % "14:00", daily_summary.MISSING),
            ("dorm-b", T % "14:05", daily_summary.MISSING),
        ])
        self.assertEqual(daily_summary.find_daily_events(df), [])

    def test_缺失值结尾不把已恢复的段改回未恢复(self):
        # 顺序是「异常 → 正常 → 缺失」。收尾那一步只看还【开着】的段，
        # 已经记成 recovered 的那条不能被后面一行脏数据改写。
        df = frame([
            ("dorm-b", T % "14:10", "偏热"),
            ("dorm-b", T % "14:15", "正常"),
            ("dorm-b", T % "14:20", daily_summary.MISSING),
        ])
        events = daily_summary.find_daily_events(df)
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0]["recovered"])

    def test_全是正常就没有事件(self):
        df = frame([
            ("dorm-a", T % "00:00", "正常"),
            ("dorm-a", T % "12:00", "正常"),
            ("dorm-a", T % "23:55", "正常"),
        ])
        self.assertEqual(daily_summary.find_daily_events(df), [])

    def test_空表也没有事件(self):
        self.assertEqual(daily_summary.find_daily_events(frame([])), [])

    def test_nodeId缺失归到未知节点(self):
        # 悄悄丢掉那几行的话，它底下的异常段会凭空消失，
        # 而总事件数照样报出来 —— 对不上账
        df = frame([
            ("", T % "14:10", "偏热"),
            ("", T % "14:50", "正常"),
        ])
        events = daily_summary.find_daily_events(df)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["nodeId"], daily_summary.UNKNOWN_NODE)

    def test_nodeId是NaN也归到未知节点(self):
        df = frame([
            (float("nan"), T % "14:10", "偏热"),
            (float("nan"), T % "14:50", "正常"),
        ])
        self.assertEqual(daily_summary.find_daily_events(df)[0]["nodeId"],
                         daily_summary.UNKNOWN_NODE)

    def test_minutes按时间算不按条数(self):
        # 两条数据也可能隔 40 分钟：采样间隔不均匀时按条数算就错了
        df = frame([
            ("dorm-b", T % "14:10", "偏热"),
            ("dorm-b", T % "14:50", "偏热"),
            ("dorm-b", T % "14:55", "正常"),
        ])
        event = daily_summary.find_daily_events(df)[0]
        self.assertEqual(event["count"], 2)
        self.assertEqual(event["minutes"], 40)

    def test_时间解析不出来时minutes是None(self):
        df = frame([
            ("dorm-b", "上午", "偏热"),
            ("dorm-b", "下午", "正常"),
        ])
        self.assertIsNone(daily_summary.find_daily_events(df)[0]["minutes"])

    def test_顺序固定按节点名再按开始时间(self):
        # 报告每次跑出来的行序要一样才好前后对比。
        # 文件里故意把 dorm-a 早的那段摆在后面，看排出来是不是按开始时间。
        df = frame([
            ("dorm-c", T % "14:10", "偏湿"),
            ("dorm-a", T % "09:00", "偏冷"),
            ("dorm-a", T % "09:05", "正常"),
            ("dorm-a", T % "06:00", "偏冷"),
            ("dorm-a", T % "06:05", "正常"),
            ("dorm-b", T % "14:10", "偏热"),
        ])
        events = daily_summary.find_daily_events(df)
        self.assertEqual([(e["nodeId"], e["start"]) for e in events], [
            ("dorm-a", T % "06:00"),
            ("dorm-a", T % "09:00"),
            ("dorm-b", T % "14:10"),
            ("dorm-c", T % "14:10"),
        ])

    def test_开始时间相同时按节点名定序(self):
        # 光按开始时间排是不够的：dorm-c 这一段的收尾比 dorm-b 早，
        # 所以它在列表里本来排在前面。而定序的规则是「先按节点名」，
        # 两条开始时间一样时必须把 dorm-b 摆前面 ——
        # 不然同一份数据在两台机器上（Python 的 sort 稳定）看着可能不一样。
        df = frame([
            ("dorm-c", T % "14:10", "偏湿"),
            ("dorm-c", T % "14:20", "正常"),
            ("dorm-b", T % "14:10", "偏热"),
            ("dorm-b", T % "14:20", "正常"),
        ])
        events = daily_summary.find_daily_events(df)
        self.assertEqual([e["nodeId"] for e in events], ["dorm-b", "dorm-c"])

    def test_没有正常数据隔开就仍是一段(self):
        # 接连两条异常数据就是同一段，哪怕时间往回走 —— 和看板一致，
        # 这边也不排序、不做乱序保护（见 README「已知限制」）
        df = frame([
            ("dorm-a", T % "09:00", "偏冷"),
            ("dorm-a", T % "06:00", "偏冷"),
        ])
        events = daily_summary.find_daily_events(df)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["start"], T % "09:00")
        self.assertEqual(events[0]["end"], T % "06:00")
        self.assertEqual(events[0]["count"], 2)

    def test_不改传进来的表(self):
        df = frame([("dorm-b", T % "14:10", "偏热")])
        before = df.copy(deep=True)
        daily_summary.find_daily_events(df)
        pd.testing.assert_frame_equal(df, before)

    def test_缺rule_status列就报错说清楚(self):
        df = pd.DataFrame({"nodeId": ["dorm-b"], "time": [T % "14:10"],
                           "status": ["偏热"]})
        with self.assertRaises(SystemExit) as caught:
            daily_summary.find_daily_events(df)
        self.assertIn("add_rule_status", str(caught.exception))

    def test_缺nodeId列就报错说清楚(self):
        df = pd.DataFrame({"time": [T % "14:10"], "rule_status": ["偏热"]})
        with self.assertRaises(SystemExit) as caught:
            daily_summary.find_daily_events(df)
        self.assertIn("nodeId", str(caught.exception))

    def test_不认CSV里那列原始status(self):
        # 只有 status 列（没重算过）的表必须被拒，不能悄悄拿它当依据 ——
        # 网页那边改了规则这边不跟着改，摘要会照着旧规则说得头头是道
        df = pd.DataFrame({"nodeId": ["dorm-b"], "time": [T % "14:10"],
                           "status": ["偏热"], "rule_status": ["正常"]})
        self.assertEqual(daily_summary.find_daily_events(df), [])


# ---------------------------------------------------------------- 生成句子


class TestRenderDailySummary(unittest.TestCase):
    def test_需求里那两句例子(self):
        events = [
            {"nodeId": "dorm-b", "start": T % "14:10", "end": T % "14:50",
             "minutes": 40, "status": "偏热", "count": 9, "recovered": True},
            {"nodeId": "dorm-c", "start": T % "21:30", "end": T % "23:55",
             "minutes": 145, "status": "偏湿", "count": 30, "recovered": False},
        ]
        self.assertEqual(
            daily_summary.render_daily_summary(events, ["dorm-a", "dorm-b", "dorm-c"]),
            "dorm-a 全天整体正常；dorm-b 14:10 起持续偏热 40 分钟后恢复；"
            "dorm-c 21:30 出现偏湿，目前仍未恢复。今日共 2 次需要关注的环境事件。")

    def test_都没有事件(self):
        self.assertEqual(
            daily_summary.render_daily_summary([], ["dorm-a", "dorm-b", "dorm-c"]),
            "dorm-a 全天整体正常；dorm-b 全天整体正常；dorm-c 全天整体正常。"
            "今日没有需要关注的环境事件。")

    def test_一个节点都没有数据(self):
        # 「没有数据」不是「正常」—— 这句话和看板那边同一个口径
        self.assertEqual(daily_summary.render_daily_summary([], []),
                         "这一天没有收到任何节点的数据。")

    def test_没收到数据的节点不会被说成正常(self):
        # 只有 dorm-a 有数据时，句子里不许冒出 dorm-b
        events = [{"nodeId": "dorm-a", "start": T % "09:00", "end": T % "09:10",
                   "minutes": 10, "status": "偏冷", "count": 3, "recovered": True}]
        text = daily_summary.render_daily_summary(events, ["dorm-a"])
        self.assertEqual(text, "dorm-a 09:00 起持续偏冷 10 分钟后恢复。"
                              "今日共 1 次需要关注的环境事件。")
        self.assertNotIn("dorm-b", text)

    def test_一个节点两段用又出现(self):
        events = [
            {"nodeId": "dorm-b", "start": T % "09:00", "end": T % "09:10",
             "minutes": 10, "status": "偏冷", "count": 3, "recovered": True},
            {"nodeId": "dorm-b", "start": T % "14:10", "end": T % "14:50",
             "minutes": 40, "status": "偏热", "count": 9, "recovered": True},
        ]
        self.assertEqual(
            daily_summary.render_daily_summary(events, ["dorm-b"]),
            "dorm-b 09:00 起持续偏冷 10 分钟后恢复，14:10 又出现偏热，"
            "持续 40 分钟后恢复。今日共 2 次需要关注的环境事件。")

    def test_两段里后一段没恢复(self):
        events = [
            {"nodeId": "dorm-b", "start": T % "09:00", "end": T % "09:10",
             "minutes": 10, "status": "偏冷", "count": 3, "recovered": True},
            {"nodeId": "dorm-b", "start": T % "21:30", "end": T % "23:55",
             "minutes": 145, "status": "偏湿", "count": 30, "recovered": False},
        ]
        self.assertEqual(
            daily_summary.render_daily_summary(events, ["dorm-b"]),
            "dorm-b 09:00 起持续偏冷 10 分钟后恢复，21:30 又出现偏湿，"
            "目前仍未恢复。今日共 2 次需要关注的环境事件。")

    def test_节点顺序按固定码元序(self):
        events = [
            {"nodeId": "south-2", "start": T % "09:00", "end": T % "09:10",
             "minutes": 10, "status": "偏冷", "count": 1, "recovered": True},
            {"nodeId": "north-1", "start": T % "09:00", "end": T % "09:10",
             "minutes": 10, "status": "偏冷", "count": 1, "recovered": True},
        ]
        text = daily_summary.render_daily_summary(events, ["south-2", "north-1"])
        self.assertTrue(text.startswith("north-1 "), text)

    def test_events里多出来的节点会被补进句子(self):
        # 计数和说法必须对得上：总数里算了一笔，句子里就得说在哪
        events = [{"nodeId": "dorm-z", "start": T % "14:10", "end": T % "14:50",
                   "minutes": 40, "status": "偏热", "count": 9, "recovered": True}]
        text = daily_summary.render_daily_summary(events, ["dorm-a"])
        self.assertIn("dorm-z 14:10", text)
        self.assertIn("dorm-a 全天整体正常", text)

    def test_句号收尾(self):
        events = [{"nodeId": "dorm-b", "start": T % "14:10", "end": T % "14:50",
                   "minutes": 40, "status": "偏热", "count": 9, "recovered": True}]
        for text in (daily_summary.render_daily_summary(events, ["dorm-b"]),
                     daily_summary.render_daily_summary([], ["dorm-b"]),
                     daily_summary.render_daily_summary([], [])):
            with self.subTest(text=text):
                self.assertTrue(text.endswith("。"))

    def test_数字都来自事件不写死(self):
        # 同一句话，换一个时长和一个节点名，说法要跟着变
        events = [{"nodeId": "dorm-q", "start": T % "07:05", "end": T % "07:20",
                   "minutes": 15, "status": "偏湿", "count": 4, "recovered": True}]
        text = daily_summary.render_daily_summary(events, ["dorm-q"])
        self.assertIn("dorm-q 07:05 起持续偏湿 15 分钟后恢复", text)

    def test_时长算不出来时说清楚(self):
        events = [{"nodeId": "dorm-b", "start": T % "14:10", "end": "??",
                   "minutes": None, "status": "偏热", "count": 2, "recovered": True}]
        text = daily_summary.render_daily_summary(events, ["dorm-b"])
        self.assertIn("起持续偏热 时长未知后恢复", text)

    def test_连着算两遍一字不差(self):
        events = [{"nodeId": "dorm-b", "start": T % "14:10", "end": T % "14:50",
                   "minutes": 40, "status": "偏热", "count": 9, "recovered": True}]
        self.assertEqual(daily_summary.render_daily_summary(events, ["dorm-b"]),
                         daily_summary.render_daily_summary(events, ["dorm-b"]))


# ---------------------------------------------------------------- 数据来源


class TestSourceNote(unittest.TestCase):
    def test_全是模拟(self):
        df = pd.DataFrame({"source": ["模拟", "模拟"]})
        self.assertIn("模拟日数据", daily_summary.source_note(df))

    def test_没有source列(self):
        df = pd.DataFrame({"time": [T % "14:10"]})
        self.assertIn("没有 source 列", daily_summary.source_note(df))

    def test_列是空的(self):
        df = pd.DataFrame({"source": [None, float("nan")]})
        self.assertIn("是空的", daily_summary.source_note(df))

    def test_混合来源如实列出来(self):
        # 一份真数据混了几行模拟的，不能整份自称「模拟日数据」
        df = pd.DataFrame({"source": ["模拟", "现场"]})
        note = daily_summary.source_note(df)
        self.assertIn("模拟", note)
        self.assertIn("现场", note)
        self.assertNotIn("模拟日数据", note)


# ---------------------------------------------------------------- 汇总


class TestSummarizeFrame(unittest.TestCase):
    def test_有nodeId时句子和事件都齐(self):
        df = full_frame([
            ("dorm-a", T % "00:00", 24.0, 55.0, "正常"),
            ("dorm-b", T % "14:10", 31.0, 60.0, "偏热"),
            ("dorm-b", T % "14:50", 31.0, 60.0, "偏热"),
            ("dorm-b", T % "14:55", 24.0, 60.0, "正常"),
        ])
        summary = daily_summary.summarize_frame(df, file="x.csv")
        self.assertEqual(summary["file"], "x.csv")
        self.assertEqual(summary["records"], 4)
        self.assertEqual(summary["nodes"], ["dorm-a", "dorm-b"])
        self.assertEqual(len(summary["events"]), 1)
        self.assertEqual(
            summary["text"],
            "dorm-a 全天整体正常；dorm-b 14:10 起持续偏热 40 分钟后恢复。"
            "今日共 1 次需要关注的环境事件。")

    def test_没有nodeId列时给一句实话(self):
        df = full_frame([("dorm-a", T % "00:00", 24.0, 55.0, "正常")])
        df = df.drop(columns=["nodeId"])
        summary = daily_summary.summarize_frame(df)
        self.assertEqual(summary["nodes"], [])
        self.assertEqual(summary["events"], [])
        self.assertIn("没有 nodeId 列", summary["text"])

    def test_返回的都是内置类型(self):
        import json

        df = full_frame([
            ("dorm-b", T % "14:10", 31.0, 60.0, "偏热"),
            ("dorm-b", T % "14:50", 31.0, 60.0, "偏热"),
        ])
        # json.dumps 挂掉就说明混进了 numpy 类型（报告要序列化它）
        json.dumps(daily_summary.summarize_frame(df))

    def test_不改传进来的表(self):
        df = full_frame([("dorm-b", T % "14:10", 31.0, 60.0, "偏热")])
        before = df.copy(deep=True)
        daily_summary.summarize_frame(df)
        pd.testing.assert_frame_equal(df, before)


# ---------------------------------------------------------------- 读文件那一路


class TestBuildDailySummary(unittest.TestCase):
    HEADER = "nodeId,time,temperature,humidity,status,source"

    def test_读一份带BOM的CSV(self):
        path = write_csv(
            f"{self.HEADER}\r\n"
            "dorm-a,2026-09-22 00:00:00,24,55,正常,模拟\r\n"
            "dorm-b,2026-09-22 14:10:00,31,60,偏热,模拟\r\n"
            "dorm-b,2026-09-22 14:50:00,31,60,偏热,模拟\r\n"
            "dorm-b,2026-09-22 14:55:00,24,60,正常,模拟\r\n")
        summary = daily_summary.build_daily_summary(path)

        self.assertEqual(summary["records"], 4)
        self.assertEqual(summary["nodes"], ["dorm-a", "dorm-b"])
        self.assertIn("模拟日数据", summary["source"])
        self.assertEqual(
            summary["text"],
            "dorm-a 全天整体正常；dorm-b 14:10 起持续偏热 40 分钟后恢复。"
            "今日共 1 次需要关注的环境事件。")

    def test_status一律按规则重算(self):
        # CSV 里写「正常」，但 31 ℃ 按规则是偏热。信 CSV 的话这一段就没了。
        path = write_csv(
            f"{self.HEADER}\r\n"
            "dorm-b,2026-09-22 14:10:00,31,60,正常,模拟\r\n"
            "dorm-b,2026-09-22 14:50:00,31,60,正常,模拟\r\n"
            "dorm-b,2026-09-22 14:55:00,24,60,正常,模拟\r\n")
        summary = daily_summary.build_daily_summary(path)

        self.assertEqual(len(summary["events"]), 1)
        self.assertEqual(summary["events"][0]["status"],
                         status_rules.STATUS_HOT)
        self.assertEqual(summary["events"][0]["minutes"], 40)

    def test_温湿度缺失的行不算事件(self):
        path = write_csv(
            f"{self.HEADER}\r\n"
            "dorm-b,2026-09-22 14:10:00,,,偏热,模拟\r\n"
            "dorm-b,2026-09-22 14:50:00,,,偏热,模拟\r\n")
        self.assertEqual(daily_summary.build_daily_summary(path)["events"], [])

    def test_相对路径按项目根展开(self):
        summary = daily_summary.build_daily_summary("data/day_sim.csv")
        self.assertEqual(Path(summary["file"]),
                         analysis.ROOT / "data" / "day_sim.csv")

    def test_文件不存在时报人话(self):
        with self.assertRaises(SystemExit) as caught:
            daily_summary.build_daily_summary("data/no-such-file.csv")
        self.assertIn("找不到 CSV", str(caught.exception))

    def test_缺列时报人话(self):
        path = write_csv("time,temperature\r\n2026-09-22 14:10:00,31\r\n")
        with self.assertRaises(SystemExit) as caught:
            daily_summary.build_daily_summary(path)
        self.assertIn("CSV 缺少列", str(caught.exception))

    def test_命令行入口打印摘要(self):
        path = write_csv(
            f"{self.HEADER}\r\n"
            "dorm-b,2026-09-22 14:10:00,31,60,偏热,模拟\r\n"
            "dorm-b,2026-09-22 14:50:00,31,60,偏热,模拟\r\n"
            "dorm-b,2026-09-22 14:55:00,24,60,正常,模拟\r\n")
        text = capture(daily_summary._main, [str(path)])

        self.assertIn("今日摘要：", text)
        self.assertIn("14:10 起持续偏热 40 分钟后恢复", text)
        self.assertIn("事件明细：", text)
        self.assertIn("已恢复", text)

    def test_命令行入口对没有事件的也说人话(self):
        path = write_csv(
            f"{self.HEADER}\r\n"
            "dorm-a,2026-09-22 00:00:00,24,55,正常,模拟\r\n")
        text = capture(daily_summary._main, [str(path)])
        self.assertIn("今日没有需要关注的环境事件", text)
        self.assertNotIn("事件明细：", text)


# ---------------------------------------------------------------- 模拟日数据


class TestMakeSimData(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = make_sim_data.build_rows()

    def test_列的顺序固定(self):
        self.assertEqual(make_sim_data.COLUMNS,
                         ["nodeId", "time", "temperature", "humidity",
                          "status", "source"])
        self.assertEqual(
            make_sim_data.to_csv_text(self.rows).split("\r\n")[0],
            "nodeId,time,temperature,humidity,status,source")

    def test_source全是模拟(self):
        self.assertEqual({row["source"] for row in self.rows}, {"模拟"})

    def test_每一行的status都由规则算出来(self):
        for row in self.rows:
            with self.subTest(nodeId=row["nodeId"], time=row["time"]):
                self.assertEqual(
                    row["status"],
                    rules.judge_status(row["temperature"], row["humidity"]))

    def test_三个节点各一整天(self):
        counts = {}
        for row in self.rows:
            counts[row["nodeId"]] = counts.get(row["nodeId"], 0) + 1
        self.assertEqual(set(counts), {"dorm-a", "dorm-b", "dorm-c"})
        self.assertEqual(set(counts.values()), {288})

    def test_时间从零点到最后五点(self):
        times = sorted({row["time"] for row in self.rows})
        self.assertEqual(times[0], "2026-09-22 00:00:00")
        self.assertEqual(times[-1], "2026-09-22 23:55:00")
        self.assertEqual(len(times), 288)

    def test_按时间和节点名排好(self):
        keys = [(row["time"], row["nodeId"]) for row in self.rows]
        self.assertEqual(keys, sorted(keys))

    def test_同一个种子两次一模一样(self):
        self.assertEqual(make_sim_data.to_csv_text(self.rows),
                         make_sim_data.to_csv_text(make_sim_data.build_rows()))

    def test_跨进程也是同一个种子同一份数据(self):
        """同一个种子，换一个进程跑，出来的文件必须一个字节都不差。

        为什么非得起子进程：`random.seed(str)` 内部走 sha512，不依赖
        PYTHONHASHSEED；但要是有人图省事写成 `hash(node_id)`，字符串哈希
        每个进程都不一样，同一个进程里两次调用却又是稳定的 ——
        那样这个测试才是唯一能发现它的地方。
        两个进程故意给不同的 PYTHONHASHSEED，把这条差异放大出来。
        """
        folder = Path(tempfile.mkdtemp())
        script = str(analysis.ROOT / "analysis" / "make_sim_data.py")
        produced = []
        for index, out in enumerate((folder / "a.csv", folder / "b.csv")):
            done = subprocess.run(
                [sys.executable, script, "--out", str(out)],
                cwd=str(analysis.ROOT), capture_output=True,
                env=dict(os.environ, PYTHONHASHSEED=str(index + 1)))
            self.assertEqual(done.returncode, 0, done.stderr)
            produced.append(out.read_bytes())

        self.assertEqual(produced[0], produced[1])

    def test_换种子数据就不同(self):
        other = make_sim_data.build_rows(seed=make_sim_data.SEED + 1)
        self.assertNotEqual(make_sim_data.to_csv_text(self.rows),
                            make_sim_data.to_csv_text(other))

    def test_至少两个事件(self):
        events = daily_summary.find_daily_events(
            pd.DataFrame(self.rows).assign(rule_status=lambda df: df["status"]))
        self.assertGreaterEqual(len(events), 2)

    def test_dorm_b偏热四十分钟后恢复(self):
        events = self._events()
        self.assertEqual(len(events), 2)
        hot = [e for e in events if e["status"] == "偏热"][0]
        self.assertEqual(hot["nodeId"], "dorm-b")
        self.assertEqual(hot["minutes"], make_sim_data.HOT_MINUTES)
        self.assertTrue(hot["recovered"])

    def test_dorm_c偏湿到结束仍未恢复(self):
        humid = [e for e in self._events() if e["status"] == "偏湿"][0]
        self.assertEqual(humid["nodeId"], "dorm-c")
        self.assertFalse(humid["recovered"])
        self.assertEqual(humid["end"], "2026-09-22 23:55:00")

    def test_dorm_a全天没有事件(self):
        self.assertEqual([e for e in self._events() if e["nodeId"] == "dorm-a"], [])

    def test_正常段不会被抖成异常(self):
        # 抖动幅度必须离三条阈值都留着距离，否则「换种子摘要变不变」就看运气了
        for row in self.rows:
            if row["nodeId"] != "dorm-a":
                continue
            with self.subTest(time=row["time"]):
                self.assertEqual(row["status"],
                                 status_rules.STATUS_NORMAL)

    def test_事件段里没有一个正常点(self):
        # 同理：事件段的取值也要整段都在阈值另一侧，不然一段会被切成几段
        events = self._events()
        hot = [e for e in events if e["status"] == "偏热"][0]
        inside = [row for row in self.rows
                  if row["nodeId"] == "dorm-b" and hot["start"] <= row["time"] <= hot["end"]]
        self.assertEqual(len(inside), hot["count"])
        self.assertTrue(all(row["status"] == "偏热" for row in inside))

    def test_CSV用CRLF且没有裸LF(self):
        text = make_sim_data.to_csv_text(self.rows)
        self.assertNotIn("\n", text.replace("\r\n", ""))
        self.assertTrue(text.endswith("\r\n"))

    def test_写出来的文件带BOM而且能读回来(self):
        path = Path(tempfile.mkdtemp()) / "day.csv"
        make_sim_data.write_csv(self.rows, path)

        self.assertEqual(path.read_bytes()[:3], b"\xef\xbb\xbf")
        # 读回来必须还是 864 行 —— BOM 没吃掉的话第一列列名会变成 "﻿nodeId"
        self.assertEqual(len(analysis.load(path)), len(self.rows))

    def test_写文件会建目录(self):
        path = Path(tempfile.mkdtemp()) / "sub" / "day.csv"
        make_sim_data.write_csv(self.rows, path)
        self.assertTrue(path.is_file())

    def test_指定开始时刻就落在那儿(self):
        rows = make_sim_data.build_rows(hot_start="14:30")
        events = daily_summary.find_daily_events(
            pd.DataFrame(rows).assign(rule_status=lambda df: df["status"]))
        hot = [e for e in events if e["status"] == "偏热"][0]
        self.assertEqual(hot["start"], "2026-09-22 14:30:00")

    def test_没对齐到采样点的时刻往后取整(self):
        # 14:12 不是采样点。窗口末端是由开始时刻推出来的（开始 + 40 分钟），
        # 所以开始时刻不对齐，末端也不对齐 —— 最后一个异常采样点就会落在
        # 14:50 而不是 14:55，时长白白少 5 分钟。
        # 光看 start 是看不出对齐没对齐的（数据本来也只能从采样点开始），
        # 必须连 minutes 一起钉住。
        rows = make_sim_data.build_rows(hot_start="14:12")
        events = daily_summary.find_daily_events(
            pd.DataFrame(rows).assign(rule_status=lambda df: df["status"]))
        hot = [e for e in events if e["status"] == "偏热"][0]
        self.assertEqual(hot["start"], "2026-09-22 14:15:00")
        self.assertEqual(hot["end"], "2026-09-22 14:55:00")
        self.assertEqual(hot["minutes"], make_sim_data.HOT_MINUTES)

    def test_只改dorm_b的事件不动别的节点(self):
        base = make_sim_data.build_rows()
        moved = make_sim_data.build_rows(hot_start="14:30")

        def others(rows):
            return [r for r in rows if r["nodeId"] != "dorm-b"]

        self.assertEqual(make_sim_data.to_csv_text(others(base)),
                         make_sim_data.to_csv_text(others(moved)))

    def test_改事件时长摘要跟着变(self):
        rows = make_sim_data.build_rows(hot_minutes=20)
        text = make_sim_data.daily_text(rows)
        self.assertIn("14:10 起持续偏热 20 分钟后恢复", text)

    def test_换种子摘要跟着变(self):
        base = make_sim_data.daily_text(make_sim_data.build_rows())
        other = make_sim_data.daily_text(make_sim_data.build_rows(seed=7))
        self.assertNotEqual(base, other)
        # 变的必须是句子里的时刻，不是标点或者别的什么
        self.assertIn("14:10", base)
        self.assertIn("14:20", other)

    def test_默认那组正好是需求例子里那句(self):
        # 数据会变、句子不能写死，但默认这份数据是挑过的，
        # 它就该长成需求里那两句例子的样子 —— 对不上一眼就知道哪里跑偏了
        self.assertEqual(
            make_sim_data.daily_text(self.rows),
            "dorm-a 全天整体正常；dorm-b 14:10 起持续偏热 40 分钟后恢复；"
            "dorm-c 21:30 出现偏湿，目前仍未恢复。今日共 2 次需要关注的环境事件。")

    def test_命令行入口会打印摘要(self):
        out = Path(tempfile.mkdtemp()) / "day.csv"
        text = capture(make_sim_data.main, ["--out", str(out)])

        self.assertIn("今日摘要：", text)
        self.assertIn("14:10 起持续偏热 40 分钟后恢复", text)
        self.assertTrue(out.is_file())

    def test_时间格式写错时给用法而不是traceback(self):
        # argparse 的 error() 会往 stderr 打一段用法，接住它 ——
        # 不然这段字会混进测试输出，看着像测试自己出了错
        buf = io.StringIO()
        with redirect_stderr(buf), self.assertRaises(SystemExit):
            make_sim_data.main(["--hot-start", "下午三点"])
        self.assertIn("usage:", buf.getvalue())

    def _events(self):
        df = pd.DataFrame(self.rows)
        df["rule_status"] = df["status"]
        return daily_summary.find_daily_events(df)


class TestSampleDayFile(unittest.TestCase):
    """data/day_sim.csv 是跟着仓库走的演示数据，必须和生成脚本对得上。"""

    def setUp(self):
        if not analysis.DEFAULT_SIM.is_file():
            self.skipTest("data/day_sim.csv 不存在（演示数据，可以没有）")
        self.df = analysis.load(analysis.DEFAULT_SIM)

    def test_和重新生成的一模一样(self):
        # 对不上就说明有人手改过文件，或者改了脚本没重新生成
        self.assertEqual(make_sim_data.to_csv_text(make_sim_data.build_rows()),
                         make_sim_data.to_csv_text(self.df.to_dict("records")))

    def test_每一行都带source(self):
        self.assertEqual(set(self.df["source"]), {"模拟"})


# ---------------------------------------------------------------- 报告区块


class TestReportSection(unittest.TestCase):
    def _daily(self, day_file: Path) -> dict:
        df = analysis.add_rule_status(analysis.load(day_file))
        return daily_summary.summarize_frame(df, file=str(day_file))

    def test_区块标题和来源都在(self):
        daily = self._daily(analysis.DEFAULT_SIM)
        section = analysis.daily_summary_section(daily)

        self.assertEqual(section["title"], "今日摘要")
        self.assertIn("数据来源：模拟日数据", section["html"])
        self.assertIn("14:10 起持续偏热 40 分钟后恢复", section["html"])
        self.assertIn("仍未恢复", section["html"])

    def test_事件明细表的列和行(self):
        section = analysis.daily_summary_section(self._daily(analysis.DEFAULT_SIM))
        html = section["html"]

        for name in analysis.EVENT_HEADER:
            with self.subTest(column=name):
                self.assertIn(name, html)
        self.assertIn("<td>dorm-b</td>", html)
        self.assertIn('<td class="num">40</td>', html)

    def test_每一行的结果和它自己的事件对上(self):
        # 只断言「html 里有『已恢复』三个字」是不够的：两个词不管怎么配
        # 都会同时出现。要比到【行】上 —— 说反了的话每行的意思是反的，
        # 而页面上照样有两个词，扫一眼看不出来。
        html = analysis.daily_summary_section(
            self._daily(analysis.DEFAULT_SIM))["html"]
        body = html[html.index("<tbody>"):html.index("</tbody>")]

        def row_of(node):
            return [chunk for chunk in body.split("<tr>")
                    if f"<td>{node}</td>" in chunk][0]

        self.assertIn("已恢复", row_of("dorm-b"))
        self.assertNotIn("仍未恢复", row_of("dorm-b"))
        self.assertIn("仍未恢复", row_of("dorm-c"))
        self.assertNotIn("已恢复", row_of("dorm-c"))

    def test_一个事件都没有时只给一句话不摆空表(self):
        path = write_csv(
            "nodeId,time,temperature,humidity,status,source\r\n"
            "dorm-a,2026-09-22 00:00:00,24,55,正常,模拟\r\n")
        section = analysis.daily_summary_section(self._daily(path))

        self.assertIn("今日没有需要关注的环境事件", section["html"])
        self.assertNotIn("<table>", section["html"])

    def test_没有nodeId列时说清楚(self):
        path = write_csv("time,temperature,humidity,status\r\n"
                         "2026-09-22 00:00:00,24,55,正常\r\n")
        section = analysis.daily_summary_section(self._daily(path))

        self.assertIn("没有 nodeId 列", section["html"])
        self.assertNotIn("模拟日数据", section["html"])

    def test_装进报告里(self):
        daily = self._daily(analysis.DEFAULT_SIM)
        summary = analysis.summarize(
            analysis.add_rule_status(analysis.load(analysis.DEFAULT_SIM)),
            analysis.DEFAULT_SIM, verbose=False)
        html = analysis.build_report(summary, sections=[
            analysis.daily_summary_section(daily)],
            generated_at="2026-09-22 23:59:00", trend_path=Path("有没有都行.png"))

        self.assertIn("<h2>今日摘要</h2>", html)
        self.assertIn("数据来源：模拟日数据", html)

    def test_报告里那句和命令行那句逐字相同(self):
        # main() 里就这一段话算一次、渲染两次。分头算的话屏幕上和报告里
        # 可能不是同一句 —— 而那种不一致没人会去核对
        daily = self._daily(analysis.DEFAULT_SIM)
        summary = analysis.summarize(
            analysis.add_rule_status(analysis.load(analysis.DEFAULT_SIM)),
            analysis.DEFAULT_SIM, verbose=False)
        html = analysis.build_report(summary, generated_at="2026-09-22 23:59:00",
                                     trend_path=Path("有没有都行.png"),
                                     sections=[analysis.daily_summary_section(daily)])
        self.assertIn(daily["text"], html)

    def test_端到端跑一遍报告里有今日摘要(self):
        if not analysis.DEFAULT_SIM.is_file():
            self.skipTest("data/day_sim.csv 不存在（演示数据，可以没有）")

        folder = Path(tempfile.mkdtemp())
        trend, report = folder / "trend.png", folder / "report.html"
        original_trend, original_report = analysis.DEFAULT_TREND, analysis.DEFAULT_REPORT_HTML
        analysis.DEFAULT_TREND, analysis.DEFAULT_REPORT_HTML = trend, report
        try:
            text = capture(analysis.main,
                           [str(analysis.DEFAULT_SIM), "--no-plot"])
        finally:
            analysis.DEFAULT_TREND, analysis.DEFAULT_REPORT_HTML = original_trend, original_report

        self.assertIn("今日摘要", text)
        html = report.read_text(encoding="utf-8")
        self.assertIn("<h2>今日摘要</h2>", html)
        self.assertIn("数据来源：模拟日数据", html)

    def test_main不许另读一次文件(self):
        """main 必须用手上那份 df 算摘要，不能回头再读一遍 CSV。

        换个写法（daily_summary.build_daily_summary(csv_path)）【行为上完全一样】：
        同一份文件读两遍，答案必然相同。所以这是个结构上的要求，只能靠打桩钉住。

        为什么值得钉：真放它去读第二遍，两处口径一旦分叉（比如以后
        summarize_frame 多了个只用得上 df 的参数），屏幕上和报告里就会变成
        两句话，而那种不一致没人会去核对 —— 报告照样生成、照样能打开。
        """
        if not analysis.DEFAULT_SIM.is_file():
            self.skipTest("data/day_sim.csv 不存在（演示数据，可以没有）")

        folder = Path(tempfile.mkdtemp())
        original_trend, original_report = analysis.DEFAULT_TREND, analysis.DEFAULT_REPORT_HTML
        analysis.DEFAULT_TREND, analysis.DEFAULT_REPORT_HTML = \
            folder / "trend.png", folder / "report.html"
        try:
            with mock.patch.object(daily_summary, "build_daily_summary",
                                   side_effect=AssertionError("main 另读了一次文件")):
                capture(analysis.main, [str(analysis.DEFAULT_SIM), "--no-plot"])
        finally:
            analysis.DEFAULT_TREND, analysis.DEFAULT_REPORT_HTML = original_trend, original_report

    def test_换一组数据报告里的时刻跟着变(self):
        # 「改了模拟数据，摘要必须跟着变化」——这条是在报告这一层验的
        folder = Path(tempfile.mkdtemp())
        day_file = folder / "day.csv"
        make_sim_data.write_csv(make_sim_data.build_rows(), day_file)

        before = self._daily(day_file)["text"]
        make_sim_data.write_csv(make_sim_data.build_rows(hot_start="16:05"), day_file)
        after = self._daily(day_file)["text"]

        self.assertIn("14:10", before)
        self.assertIn("16:05", after)
        self.assertNotEqual(before, after)
        self.assertIn("16:05 起持续偏热 40 分钟后恢复", after)


if __name__ == "__main__":
    unittest.main()
