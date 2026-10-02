"""Phase7 的测试：analysis/make_report.py（CSV + 事件 JSON -> 一份单文件报告）。

    py -3.14 -m unittest tests.test_make_report
    py -3.14 -m unittest discover -s tests -t .

这份测试刻意**不 import 别的测试模块**（tests/ 下几个文件互相独立，谁坏了就红
谁那一个，不会连坐）。要的假数据在这儿现造。

重点验的几件事，都是「报告会不会说谎」那一类：

  * **报告里的数字全部来自这次读到的输入** —— 换一份 CSV，记录数、极值、平均、
    状态分布、图上点数全都得跟着变。所以有一类是「两份输入 -> 两份报告，逐项
    比出不同」，专门盯那种偷偷写死的数字。
  * **两条断线**：温湿度缺值要断开，相邻读数隔太远（超过自身采样间隔中位数的
    若干倍）**也要**断开。少断后者的话，matplotlib 会老老实实连出一条横贯
    19 小时的直线 —— 图上看不出任何异常，读起来却是「整夜平稳且一直在测」。
  * **照片只数 kind == camera 的**：案卷的 snapshots 里还混着状态迁移的记录，
    不筛的话一次「开案」在时间线上会变成「拍了一张照片」。
  * **没跑 ML 就说没跑**：ml_label 整列空着时，那一段只出一句占位，绝不出一张
    空表，更不拿规则算出来的状态去填那一列假装模型也这么判。
  * **单文件**：报告里不许有指向外部的 src/href/script —— 拷到任何地方都该能打开。

要 pandas 和 matplotlib，所以用 py -3.14 跑（32 位的 python 装不上这两个）。
没装 matplotlib 时，画图那几条整类跳过而不是报错：报告这一层该降级，不该崩。
"""

from __future__ import annotations

import base64
import io
import json
import re
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import pandas as pd

from analysis import analysis, make_report, rules
from status_rules import compute_status

try:
    import matplotlib  # noqa: F401

    HAS_MPL = True
except ImportError:
    HAS_MPL = False

# PNG 的头 8 个字节。内嵌的那张图到底是不是一张真 PNG，看它就够了 ——
# 比"长度大于 1000"之类的判据硬气得多。
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

BOM = chr(0xFEFF)

# 十列，和 history.py 的 HEADER 一字不差。这儿抄一份**不是**为了省一次 import：
# 抄写的这份就是判据 —— 哪天 history.py 改了列名，这条会红。
#
# 第 10 列 agree 是 Phase8 D5 追加在**末尾**的（不是插在 ml_label 后面）：
# 人和 Excel 看的是位置，插在中间会把之前照着列号读这些 CSV 的东西全部读错一格。
HISTORY_HEADER = ("time", "nodeId", "temperature", "humidity", "status",
                  "ml_label", "event_id", "event_state", "source", "agree")

REPO = Path(__file__).resolve().parent.parent


def frame(rows: list[dict]) -> pd.DataFrame:
    """一串 dict -> 带 rule_status 的 DataFrame（和真流程一样先过一遍规则）。"""
    return analysis.add_rule_status(pd.DataFrame(rows))


def history_frame() -> pd.DataFrame:
    """一份 9 列的小历史表：三个宿舍，dorm-a 有一段偏热。

    时间跨 2026-09-23 14:00~14:15（5 分钟一条），没有大间隔 —— 要测断开那条
    另有专门的用例自己造数据。
    """
    rows = [
        # dorm-a：正常 -> 偏热两条（开案、验证）
        ("2026-09-23 14:00:00", "dorm-a", 25, 60, "", "", ""),
        ("2026-09-23 14:05:00", "dorm-a", 31, 60, "", "dorm-a-1", "OPEN"),
        ("2026-09-23 14:10:00", "dorm-a", 33, 58, "", "dorm-a-1", "OPEN"),
        ("2026-09-23 14:15:00", "dorm-a", 26, 60, "", "dorm-a-1", "RECOVERED"),
        # dorm-b：一直偏湿
        ("2026-09-23 14:00:00", "dorm-b", 25, 80, "", "", ""),
        ("2026-09-23 14:05:00", "dorm-b", 26, 82, "", "dorm-b-1", "OPEN"),
        # dorm-c：偏冷
        ("2026-09-23 14:00:00", "dorm-c", 16, 60, "", "", ""),
    ]
    return frame([
        {"time": time, "nodeId": node, "temperature": temp, "humidity": hum,
         "status": compute_status(temp, hum), "ml_label": ml,
         "event_id": eid, "event_state": state, "source": "构造样本"}
        for time, node, temp, hum, ml, eid, state in rows
    ])


def events_doc() -> dict:
    """一份手写的 events.json，五个节点类型都占上。

    特意放了两条 snapshots：一条 kind == camera（照片），一条**没有 kind**
    （状态迁移）—— 时间线必须只出前一条。
    """
    return {
        "v": 1,
        "summary": {"OPEN": 1, "HANDLING": 1, "RECOVERED": 1, "UNRESOLVED": 0,
                    "total": 1, "dropped": 0},
        "events": [
            {
                "event_id": "dorm-a-20260923-140500",
                "nodeId": "dorm-a",
                "start_time": "2026-09-23 14:05:00",
                "problem": "连续偏热",
                "priority_time": "2026-09-23 14:05:00",
                "priority_reason": "目前唯一的异常节点",
                "actions": [
                    {"time": "2026-09-23 14:07:00", "action": "handle",
                     "source": "script", "accepted": True, "note": ""},
                    {"time": "2026-09-23 14:08:00", "action": "handle",
                     "source": "web", "accepted": False, "note": "该宿舍没有未结案的事件"},
                ],
                "snapshots": [
                    # 状态迁移：没有 kind 这个键
                    {"time": "2026-09-23 14:05:00", "state": "OPEN"},
                    # 照片：kind == camera，stamp 和 time 不一样
                    {"kind": "camera", "time": "2026-09-23 14:09:00",
                     "stamp": "2026-09-23 14:08:57",
                     "file": "dorm-a-20260923-140500-20260923140857.png",
                     "width": 640, "height": 480, "size": 20480,
                     "watermark": "dorm-a · 事件 …"},
                ],
                "recovered_at": "2026-09-23 14:15:00",
                "result": "处理后连续 3 条正常，已恢复",
                "state": "RECOVERED",
            },
        ],
    }


def write_events(doc, tmp: Path, name: str = "events.json") -> Path:
    path = tmp / name
    path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8",
                    newline="\n")
    return path


def body_of(html: str, title: str) -> str:
    """从报告里抠出某个 <h2> 区块的正文。抠不到就断言失败 —— 静默返回空串的话，
    下面那些"里面应该有 X"的断言会以最难查的方式红。"""
    marker = f"<h2>{title}</h2>"
    if marker not in html:
        raise AssertionError(f"报告里没有「{title}」这一块")
    return html.split(marker, 1)[1].split("</section>", 1)[0]


def rows_of(html: str) -> list[list[str]]:
    """把一段 HTML 里的表格行抠成纯文本。<td class="num"> 也要认 —— 只匹配
    <td> 的话数字列会整列消失，验证就变成了"看着对，其实没比到"。

    每行第一个元素是这一行的 class（没有 class 就是空串），后面才是单元格 ——
    高亮那几条要靠它认行。"""
    out = []
    for attrs, inner in re.findall(r"<tr([^>]*)>(.*?)</tr>", html, re.S):
        cells = [re.sub("<[^>]+>", "", cell)
                 for cell in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", inner, re.S)]
        out.append(["" if attrs.strip() == "" else attrs.strip()] + cells)
    return out


def records_card(html: str) -> str:
    """摘要里「记录数」那张卡片上的数字。

    整张卡片的模板是 `<span class="value">7 <small>条</small></span>` ——
    中间**隔着标签**，所以 `assertIn("7 条", html)` 是断不出来的（它在任何
    输入下都失败）。要按"记录数"这张卡去取，才真的比到了那个数字。
    """
    found = re.search(r'<span class="label">记录数</span>'
                      r'<span class="value">(.*?)<small>', html, re.S)
    if found is None:
        raise AssertionError("报告里没有「记录数」那张卡片")
    return re.sub("<[^>]+>", "", found.group(1)).strip()


# ======================================================================
# 一、每个节点的温湿度统计
# ======================================================================

class TestNodeStats(unittest.TestCase):
    def test_one_row_per_node_sorted_by_name(self):
        stats = make_report.node_stats(history_frame())
        self.assertEqual(["dorm-a", "dorm-b", "dorm-c"],
                         [item["nodeId"] for item in stats])

    def test_min_max_and_average(self):
        stats = {item["nodeId"]: item for item in make_report.node_stats(history_frame())}
        a = stats["dorm-a"]
        self.assertEqual(4, a["records"])
        self.assertEqual(25, a["temp_min"])
        self.assertEqual(33, a["temp_max"])
        self.assertAlmostEqual((25 + 31 + 33 + 26) / 4, a["temp_avg"])
        self.assertEqual(58, a["humidity_min"])
        self.assertEqual(60, a["humidity_max"])

    def test_average_ignores_missing_values(self):
        """缺的那几条不参与平均，也不当 0 算。

        当 0 算的话，一个缺了半天的宿舍平均温度会莫名其妙很低 —— 而报告上
        什么都看不出来，那个数字看着完全正常。
        """
        df = frame([
            {"time": "2026-09-23 14:00:00", "nodeId": "dorm-a",
             "temperature": 30, "humidity": 60, "status": "偏热"},
            {"time": "2026-09-23 14:05:00", "nodeId": "dorm-a",
             "temperature": None, "humidity": 60, "status": "偏热"},
            {"time": "2026-09-23 14:10:00", "nodeId": "dorm-a",
             "temperature": 20, "humidity": 60, "status": "正常"},
        ])
        item = make_report.node_stats(df)[0]
        self.assertEqual(3, item["records"])        # 条数是这一组的全部
        self.assertAlmostEqual(25.0, item["temp_avg"])   # 平均只来自两条

    def test_a_node_with_no_readings_shows_a_dash_not_zero(self):
        df = frame([
            {"time": "2026-09-23 14:00:00", "nodeId": "dorm-a",
             "temperature": None, "humidity": None, "status": ""},
        ])
        item = make_report.node_stats(df)[0]
        self.assertIsNone(item["temp_min"])
        self.assertIsNone(item["temp_avg"])
        row = make_report.node_stats_rows([item])[0]
        self.assertEqual(["dorm-a", "1", "0", "1", "—", "—", "—", "—", "—", "—"],
                         row)

    def test_abnormal_count_uses_recomputed_rule_status(self):
        """异常条数按**规则重算**的结果数，不采信 CSV 里写的 status。

        这份数据里 CSV 的 status 一列故意写错（"正常"），规则算出来是偏热 ——
        异常条数必须是 1。跟着 CSV 那一列走的话，报告会替一份写坏的 CSV 圆谎。
        """
        df = frame([{"time": "2026-09-23 14:00:00", "nodeId": "dorm-a",
                     "temperature": 31, "humidity": 60, "status": "正常"}])
        self.assertEqual("偏热", df.loc[0, "rule_status"])
        self.assertEqual(1, make_report.node_stats(df)[0]["abnormal"])

    def test_a_missing_reading_is_not_an_anomaly(self):
        """温湿度没报全的那一行既不是正常、也不是异常 —— 它算「缺读数」。

        混进异常里的话，「异常 5 条」到底指五次异常还是五次掉线就看不出来了；
        而这两件事要人做的事完全不一样（一个去现场，一个去查链路）。
        """
        df = frame([
            {"time": "2026-09-23 14:00:00", "nodeId": "dorm-a",
             "temperature": None, "humidity": 60, "status": "正常"},
            {"time": "2026-09-23 14:05:00", "nodeId": "dorm-a",
             "temperature": 31, "humidity": 60, "status": "偏热"},
        ])
        item = make_report.node_stats(df)[0]
        self.assertEqual(1, item["missing"])
        self.assertEqual(1, item["abnormal"])

    def test_the_three_counts_add_up(self):
        """条数 = 正常 + 异常条数 + 缺读数。摆在一张表里的三个数必须能对账。"""
        df = frame([
            {"time": "2026-09-23 14:00:00", "nodeId": "dorm-a", "temperature": 25,
             "humidity": 60, "status": "正常"},
            {"time": "2026-09-23 14:05:00", "nodeId": "dorm-a", "temperature": 31,
             "humidity": 60, "status": "偏热"},
            {"time": "2026-09-23 14:10:00", "nodeId": "dorm-a",
             "temperature": None, "humidity": None, "status": ""},
            {"time": "2026-09-23 14:15:00", "nodeId": "dorm-a", "temperature": 25,
             "humidity": 80, "status": "偏湿"},
        ])
        item = make_report.node_stats(df)[0]
        # 四行：正常、偏热、缺读数、偏湿 -> 异常 2（偏热 + 偏湿）、缺 1、正常 1
        self.assertEqual(2, item["abnormal"])
        self.assertEqual(1, item["missing"])
        normal = item["records"] - item["abnormal"] - item["missing"]
        self.assertEqual(1, normal)
        self.assertEqual(4, normal + item["abnormal"] + item["missing"])

    def test_an_empty_row_is_not_counted_as_a_zero_degree_reading(self):
        """缺读数不参与极值 —— 当成 0 度算的话，「温度最低 0 ℃」会挂在报告上，
        而这个宿舍从来没报过 0 度。"""
        df = frame([
            {"time": "2026-09-23 14:00:00", "nodeId": "dorm-a",
             "temperature": None, "humidity": 60, "status": "正常"},
            {"time": "2026-09-23 14:05:00", "nodeId": "dorm-a", "temperature": 25,
             "humidity": 60, "status": "正常"},
        ])
        self.assertEqual(25, make_report.node_stats(df)[0]["temp_min"])

    def test_without_a_node_column_everything_lands_in_one_group(self):
        df = frame([{"time": "2026-09-23 14:00:00", "temperature": 25,
                     "humidity": 60, "status": "正常"}])
        stats = make_report.node_stats(df)
        self.assertEqual([make_report.NO_NODE], [item["nodeId"] for item in stats])
        self.assertEqual(1, stats[0]["records"])

    def test_row_width_matches_the_header(self):
        rows = make_report.node_stats_rows(make_report.node_stats(history_frame()))
        for row in rows:
            self.assertEqual(len(make_report.NODE_HEADER), len(row))

    def test_abnormal_and_missing_have_their_own_columns(self):
        self.assertIn("异常条数", make_report.NODE_HEADER)
        self.assertIn("缺读数", make_report.NODE_HEADER)

    def test_section_renders_one_table(self):
        section = make_report.node_stats_section(
            make_report.node_stats(history_frame()), 7)
        self.assertEqual("每个宿舍的温湿度", section["title"])
        self.assertEqual(4, len(rows_of(section["html"])))   # 表头 + 三行

    def test_section_says_so_when_there_is_only_one_group(self):
        one = make_report.node_stats(frame([
            {"time": "2026-09-23 14:00:00", "temperature": 25, "humidity": 60,
             "status": "正常"}]))
        self.assertIn(make_report.NO_NODE,
                      make_report.node_stats_section(one, 1)["html"])


# ======================================================================
# 二、断线（缺值 / 隔得太远）
# ======================================================================

class TestBreakLongGaps(unittest.TestCase):
    def stamp(self, minute: int) -> object:
        from datetime import datetime, timedelta
        return datetime(2026, 9, 23, 14, 0, 0) + timedelta(minutes=minute)

    def points(self, minutes: list[int]) -> list[tuple]:
        return [(self.stamp(m), 25.0, 60.0) for m in minutes]

    def test_uniform_spacing_is_left_alone(self):
        points = self.points([0, 5, 10, 15, 20])
        self.assertEqual(0, make_report.break_long_gaps(points))
        self.assertEqual(5, len(points))

    def test_a_night_long_gap_gets_a_break(self):
        """5 分钟一条的数据里插一段 19 小时的空档 —— 必须断开。

        不断的话，matplotlib 会把 14:15 和第二天 09:00 连成一条直线：整张图
        看不出任何异常，读起来却是「这一夜温度很稳」。这正是缺值连成直线
        那个老问题，只是更不容易被发现（数据本身一个缺值都没有）。
        """
        points = self.points([0, 5, 10, 15] + [15 + 19 * 60, 15 + 19 * 60 + 5])
        self.assertEqual(1, make_report.break_long_gaps(points))
        # 断口插在最后一段的前面：断点自己那两个值是 nan
        self.assertEqual(7, len(points))
        self.assertTrue(pd.isna(points[4][1]))
        self.assertTrue(pd.isna(points[4][2]))

    def test_several_gaps_are_all_broken(self):
        points = self.points([0, 5, 10] + [10 + 600, 10 + 605] + [10 + 1200])
        self.assertEqual(2, make_report.break_long_gaps(points))
        self.assertEqual(8, len(points))

    def test_exactly_the_limit_is_not_a_break(self):
        """判据是「大于」而不是「大于等于」：正好 6 倍还当它是同一段。

        这条是给「连着漏掉几条」留的余量。写成 >= 的话，一条规律采集但偶尔
        漏报的数据会在每个漏报处都开口子，图碎成一地孤点。

        注意点数是**六条**而不是三条：基准是间隔的**中位数**，只有两三个点时
        那个中位数就是那一处间隔自己，它永远也超不过自己的六倍 —— 拿三个点来
        验这条，验到的只是"中位数等于自己"这件废话。
        """
        # 前五个间隔都是 5 分钟（中位数 = 5，上限 = 30），最后一个正好 30
        self.assertEqual(
            0, make_report.break_long_gaps(self.points([0, 5, 10, 15, 20, 25, 55])))

    def test_one_minute_past_the_limit_does_break(self):
        self.assertEqual(
            1, make_report.break_long_gaps(self.points([0, 5, 10, 15, 20, 25, 56])))

    def test_all_points_at_the_same_moment_is_not_a_break(self):
        """同一时刻连着几条（中位数间隔 0）时不断。

        中位数为 0 时"正常间隔"就是 0，按倍数算下去每一处都该断 ——
        那不是发现了异常，那是判据自己除了零。
        """
        points = self.points([0, 0, 0, 0])
        self.assertEqual(0, make_report.break_long_gaps(points))

    def test_two_points_are_never_broken(self):
        """两个点之间无所谓断不断，它本来就是一条线段。"""
        points = self.points([0, 600])
        self.assertEqual(0, make_report.break_long_gaps(points))

    def test_median_ignores_one_huge_gap(self):
        """间隔里混一个大空档时，基准得是中位数 —— 均值会被那个空档自己拽偏，
        正好把要找的东西平均掉。"""
        # 5 分钟一条共 6 条（5 个间隔），再来一个 600 分钟的间隔：
        # 中位数还是 5 分钟，那一处该断；均值会被拉到 ~104 分钟，按它算就不断了。
        points = self.points([0, 5, 10, 15, 20, 25, 25 + 600])
        self.assertEqual(1, make_report.break_long_gaps(points))

    def test_only_two_intervals_uses_the_smaller_one(self):
        """三个点（两个间隔）时基准取较小的那个。

        取中位数的话它拿的是较大的那个间隔，而它永远超不过自己的六倍 ——
        一段只有三个点、横跨一夜的数据就永远断不开，正好躲过这条判据。
        """
        self.assertEqual(5 * 60, make_report.sampling_basis(
            self.points([0, 5, 5 + 19 * 60])))

    def test_three_or_more_intervals_uses_the_median(self):
        # 300, 300, 36000 秒 -> 中位数 300
        self.assertEqual(300, make_report.sampling_basis(
            self.points([0, 5, 10, 10 + 600])))

    def test_same_moment_readings_are_not_a_zero_basis(self):
        """同一时刻的读数（间隔 0）不参与基准 —— 拿 0 当基准的话，
        下一个正间隔怎样都算"隔得太远"。"""
        self.assertEqual(0.0, make_report.sampling_basis(self.points([0, 0, 0])))
        # 夹了三个同一时刻的读数，基准仍然该是那 5 分钟
        self.assertEqual(300, make_report.sampling_basis(
            self.points([0, 0, 5, 5, 10])))


class TestSeriesByNode(unittest.TestCase):
    def test_one_series_per_node_in_name_order(self):
        series = make_report.series_by_node(history_frame())
        self.assertEqual(["dorm-a", "dorm-b", "dorm-c"],
                         [item["nodeId"] for item in series])
        self.assertEqual([4, 2, 1], [len(item["times"]) for item in series])

    def test_each_series_is_sorted_by_time(self):
        """乱序输入也要画成顺序的折线 —— 乱序画出来会来回折返。"""
        df = frame([
            {"time": "2026-09-23 14:10:00", "nodeId": "dorm-a", "temperature": 30,
             "humidity": 60, "status": "偏热"},
            {"time": "2026-09-23 14:00:00", "nodeId": "dorm-a", "temperature": 20,
             "humidity": 60, "status": "正常"},
            {"time": "2026-09-23 14:05:00", "nodeId": "dorm-a", "temperature": 25,
             "humidity": 60, "status": "正常"},
        ])
        item = make_report.series_by_node(df)[0]
        self.assertEqual([20.0, 25.0, 30.0], item["temperature"])
        self.assertEqual(sorted(item["times"]), item["times"])

    def test_unparseable_time_is_counted_not_dropped_silently(self):
        df = frame([
            {"time": "2026-09-23 14:00:00", "nodeId": "dorm-a", "temperature": 25,
             "humidity": 60, "status": "正常"},
            {"time": "昨天下午", "nodeId": "dorm-a", "temperature": 25,
             "humidity": 60, "status": "正常"},
        ])
        item = make_report.series_by_node(df)[0]
        self.assertEqual(1, item["skipped"])
        self.assertEqual(1, len(item["times"]))

    def test_colours_follow_the_node_not_the_row_count(self):
        """颜色跟着宿舍走，不跟着"第几条线"走。

        按序号取色的话，少一个宿舍就会让后面每个宿舍换一种颜色 ——
        两张报告摆在一起，同一个宿舍是两种颜色。
        """
        full = make_report.series_by_node(history_frame())
        colors = {item["nodeId"]: item["color"] for item in full}
        self.assertEqual(len(set(colors.values())), len(colors))

        # 去掉 dorm-b：剩下两个的颜色必须还是原来那两个
        subset = history_frame()
        subset = subset[subset["nodeId"] != "dorm-b"]
        for item in make_report.series_by_node(subset):
            self.assertEqual(colors[item["nodeId"]], item["color"])

    def test_a_node_outside_the_registry_takes_a_spare_colour(self):
        """列表之外的节点填剩下的空位，不会撞上三个真宿舍。"""
        colors = make_report.assign_colors(["dorm-a", "dorm-b", "dorm-c", "dorm-d"])
        self.assertEqual(4, len(set(colors.values())))
        self.assertEqual(make_report.NODE_COLORS[0], colors["dorm-a"])
        self.assertEqual(make_report.NODE_COLORS[2], colors["dorm-c"])
        self.assertNotIn(colors["dorm-d"],
                         [colors["dorm-a"], colors["dorm-b"], colors["dorm-c"]])

    def test_a_spare_colour_given_up_by_an_absent_node_can_be_reused(self):
        """dorm-b 不在时它那一槽空出来，可以让给列表之外的节点。"""
        colors = make_report.assign_colors(["dorm-a", "dorm-c", "dorm-d"])
        self.assertEqual(make_report.NODE_COLORS[1], colors["dorm-d"])

    def test_running_out_of_colours_reuses_the_last_one(self):
        """调色板用完时宁可重色，也不让两个节点换位置 —— 重色看得见。"""
        names = [f"node-{index}" for index in range(len(make_report.NODE_COLORS) + 2)]
        colors = make_report.assign_colors(names)
        self.assertEqual(len(names), len(colors))
        self.assertEqual(make_report.NODE_COLORS[-1], colors[names[-1]])

    def test_gaps_are_reported_per_node(self):
        df = frame([
            {"time": "2026-09-23 14:00:00", "nodeId": "dorm-a", "temperature": 25,
             "humidity": 60, "status": "正常"},
            {"time": "2026-09-23 14:05:00", "nodeId": "dorm-a", "temperature": 25,
             "humidity": 60, "status": "正常"},
            {"time": "2026-09-24 09:00:00", "nodeId": "dorm-a", "temperature": 25,
             "humidity": 60, "status": "正常"},
            {"time": "2026-09-23 14:00:00", "nodeId": "dorm-b", "temperature": 25,
             "humidity": 60, "status": "正常"},
        ])
        by_node = {item["nodeId"]: item for item in make_report.series_by_node(df)}
        self.assertEqual(1, by_node["dorm-a"]["gaps"])
        self.assertEqual(0, by_node["dorm-b"]["gaps"])


# ======================================================================
# 三、趋势图（内嵌 base64）
# ======================================================================

@unittest.skipUnless(HAS_MPL, "没装 matplotlib —— 画图那几条跳过")
class TestTrendImage(unittest.TestCase):
    def test_returns_a_data_url_holding_a_real_png(self):
        url, note, reason = make_report.plot_trend_base64(history_frame())
        self.assertIsNone(reason)
        self.assertTrue(url.startswith("data:image/png;base64,"))
        raw = base64.b64decode(url.split(",", 1)[1])
        self.assertTrue(raw.startswith(PNG_MAGIC), "内嵌的不是一张 PNG")

    def test_note_counts_lines_and_points(self):
        url, note, reason = make_report.plot_trend_base64(history_frame())
        self.assertIn("3 条线", note)
        self.assertIn("7 个点", note)

    def test_note_mentions_the_gaps_when_there_are_any(self):
        df = frame([
            {"time": "2026-09-23 14:00:00", "nodeId": "dorm-a", "temperature": 25,
             "humidity": 60, "status": "正常"},
            {"time": "2026-09-23 14:05:00", "nodeId": "dorm-a", "temperature": 25,
             "humidity": 60, "status": "正常"},
            {"time": "2026-09-24 09:00:00", "nodeId": "dorm-a", "temperature": 25,
             "humidity": 60, "status": "正常"},
        ])
        url, note, reason = make_report.plot_trend_base64(df)
        self.assertIn("断开", note)
        # 断口不算点：三个读数，插一个 nan 进去，报的仍然该是 3 个点
        self.assertIn("3 个点", note)

    def test_empty_data_still_draws_an_image(self):
        """一条能画的都没有也照样出图 —— 报告里那张图的位置不该时有时无。"""
        df = frame([{"time": "昨天", "nodeId": "dorm-a", "temperature": 25,
                     "humidity": 60, "status": "正常"}])
        url, note, reason = make_report.plot_trend_base64(df)
        self.assertIsNone(reason)
        self.assertTrue(url.startswith("data:image/png;base64,"))
        self.assertIn("1 条没有可用的 time", note)

    def test_missing_matplotlib_degrades_instead_of_crashing(self):
        """没装 matplotlib 时返回原因，交给区块降级 —— 报告其余部分照常出。

        _pyplot() 抛的是 SystemExit（它用 SystemExit 报"装不上"这种环境问题），
        不是 Exception，所以这里必须按 SystemExit 接住。
        """
        with mock.patch.object(analysis, "_pyplot",
                               side_effect=SystemExit("没装 matplotlib")):
            url, note, reason = make_report.plot_trend_base64(history_frame())
        self.assertIsNone(url)
        self.assertEqual("没装 matplotlib", reason)

    def test_section_degrades_to_one_line(self):
        with mock.patch.object(analysis, "_pyplot",
                               side_effect=SystemExit("没装 matplotlib")):
            section = make_report.trend_section(history_frame())
        self.assertIn("没装 matplotlib", section["html"])
        self.assertNotIn("data:image/png", section["html"])

    def test_section_inlines_the_image_and_never_an_external_file(self):
        section = make_report.trend_section(history_frame())
        self.assertIn('src="data:image/png;base64,', section["html"])
        self.assertNotIn("trend.png", section["html"])


# ======================================================================
# 四、数据来源（模拟 / 构造样本 / …）
# ======================================================================

class TestSourceBreakdown(unittest.TestCase):
    def breakdown(self, values: list[str]):
        df = frame([
            {"time": f"2026-09-23 14:{index:02d}:00", "nodeId": "dorm-a",
             "temperature": 25, "humidity": 60, "status": "正常", "source": value}
            for index, value in enumerate(values)
        ])
        return make_report.source_breakdown(df)

    def test_the_simulators_word_is_simulated_data(self):
        text = self.breakdown(["模拟", "模拟"])["text"]
        self.assertIn("模拟数据", text)

    def test_a_constructed_sample_is_not_simulated_data(self):
        """构造样本不等于模拟数据。

        这两个词都有个"模"字、也都能算"不是真数据"，但报告开头那句话是给人看的
        结论：手写的样本说成模拟器跑出来的，等于把这份数据的来路说错。
        """
        result = self.breakdown(["构造样本", "构造样本"])
        self.assertIn("构造样本", result["text"])
        self.assertNotIn("模拟数据", result["text"])
        self.assertEqual([["构造样本", "构造样本", "2", "100.0%"]], result["rows"])

    def test_the_english_constructed_token_lands_in_the_same_bucket(self):
        """`constructed` 和「构造样本」必须归到**同一类**。

        屏幕上看到的是中文那份（data/constructed_samples.csv 的 source），
        但 Phase8 D5 的构造样本 JSON 里写的是英文 `constructed`
        （simulator/replay_samples.py 发的就是它）。
        两句话说法不同、指的是同一件事 —— 归不到一类的话，
        同一批数据在报告里会算成两种来源，而且**训练脚本跳不跳过它**也看这张表
        （analysis/train_iforest.py 的 is_constructed 走的就是 SOURCE_KINDS）。
        """
        english = self.breakdown(["constructed", "constructed"])
        self.assertEqual(english["rows"], [["constructed", "构造样本", "2", "100.0%"]])
        # 比的是「归到哪一类」那一格：原值那一格本来就该各显示各的
        # （报告会把没见过的 source 原样列出来，见下面那条用例）。
        self.assertEqual([row[1:] for row in english["rows"]],
                         [row[1:] for row in self.breakdown(["构造样本"] * 2)["rows"]])

    def test_mixed_sources_are_broken_down_not_averaged(self):
        result = self.breakdown(["模拟", "sim", "构造样本"])
        self.assertIn("混了几种来源", result["text"])
        self.assertIn("模拟数据 2 条", result["text"])
        self.assertIn("构造样本 1 条", result["text"])

    def test_an_unknown_source_is_counted_but_not_guessed(self):
        """没见过的 source 归到「未归类」，原值照样列出来。

        猜一个（比方说把所有陌生的值都算成"模拟数据"）是这份报告最不该做的事：
        事后谁都发现不了，而"这份数据是模拟的还是现采的"正是读报告的人最先
        要判断的那件事。
        """
        result = self.breakdown(["现场采集"])
        self.assertEqual([["现场采集", make_report.UNKNOWN_SOURCE, "1", "100.0%"]],
                         result["rows"])
        self.assertIn("都没在已知分类里", result["text"])
        self.assertIn("现场采集", result["text"])

    def test_known_and_unknown_together_still_shows_both(self):
        result = self.breakdown(["模拟", "现场采集"])
        self.assertEqual(2, len(result["rows"]))
        self.assertIn(make_report.UNKNOWN_SOURCE,
                      [row[1] for row in result["rows"]])

    def test_a_missing_source_column_says_so(self):
        df = frame([{"time": "2026-09-23 14:00:00", "temperature": 25,
                     "humidity": 60, "status": "正常"}])
        result = make_report.source_breakdown(df)
        self.assertEqual([], result["rows"])
        self.assertIn("没有 source 列", result["text"])

    def test_an_empty_cell_is_its_own_row(self):
        result = self.breakdown(["模拟", ""])
        self.assertIn("（空）", [row[0] for row in result["rows"]])

    def test_section_lists_the_raw_values_next_to_the_verdict(self):
        section = make_report.source_section(history_frame())
        self.assertIn("CSV 里的 source", section["html"])
        self.assertIn("构造样本", section["html"])


# ======================================================================
# 五、事件时间线
# ======================================================================

class TestTimeline(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.doc = events_doc()
        self.entries = make_report.timeline_entries(self.doc)

    def kinds(self) -> list[str]:
        return [item["kind"] for item in self.entries]

    def test_all_five_milestones_come_out(self):
        self.assertEqual([make_report.OPENING, make_report.PRIORITY,
                          make_report.ACTION, make_report.ACTION,
                          make_report.PHOTO, make_report.CLOSING], self.kinds())

    def test_they_are_in_time_order(self):
        times = [item["time"] for item in self.entries]
        self.assertEqual(sorted(times), times)

    def test_only_camera_snapshots_count_as_photos(self):
        """同一条案卷的 snapshots 里还混着状态迁移的记录，它们没有 kind。

        不筛的话，那次「开案」会变成时间线上的一条「现场快照」—— 一次开案被
        读成拍了一张照片，而报告上完全看不出哪里不对。
        """
        photos = [item for item in self.entries if item["kind"] == make_report.PHOTO]
        self.assertEqual(1, len(photos))
        self.assertIn("dorm-a-20260923-140500-20260923140857.png", photos[0]["text"])
        # 那条没有 kind 的记录，一个字都不该出现在报告里
        self.assertNotIn("state", photos[0]["text"])

    def test_a_photo_uses_cores_clock_and_keeps_the_shutter_time(self):
        """时间线的时刻取 time（core 的钟），stamp（快门）不一样就一并写出来。

        stamp 是前端报的、可能空着；time 一定在。取 stamp 的话，缺一个时刻
        那一行会从时间线上静默消失 —— 而"照片拍了"这件事恰恰是复盘要看的。
        """
        photo = [item for item in self.entries
                 if item["kind"] == make_report.PHOTO][0]
        self.assertEqual("2026-09-23 14:09:00", photo["time"])
        self.assertIn("14:08:57", photo["text"])

    def test_a_refused_command_is_labelled_as_refused(self):
        refusals = [item for item in self.entries
                    if item["kind"] == make_report.ACTION
                    and "没受理" in item["text"]]
        self.assertEqual(1, len(refusals))
        self.assertIn("该宿舍没有未结案的事件", refusals[0]["text"])

    def test_a_photo_without_a_stamp_does_not_lose_the_line(self):
        doc = events_doc()
        doc["events"][0]["snapshots"] = [
            {"kind": "camera", "time": "2026-09-23 14:09:00", "file": "x.png"}]
        photos = [item for item in make_report.timeline_entries(doc)
                  if item["kind"] == make_report.PHOTO]
        self.assertEqual(1, len(photos))
        self.assertEqual("2026-09-23 14:09:00", photos[0]["time"])

    def test_two_runs_give_the_same_order(self):
        """同一份输入两次整理出的顺序必须一样。

        报告是拿来前后对比的，顺序飘了就没法比 —— 而喂进来的字典顺序、
        dict 的哈希随机化都足以让排序不稳。
        """
        self.assertEqual([item["text"] for item in self.entries],
                         [item["text"] for item in make_report.timeline_entries(self.doc)])

    def test_an_event_without_a_close_has_no_closing_row(self):
        doc = events_doc()
        doc["events"][0].pop("recovered_at")
        doc["events"][0].pop("result")
        doc["events"][0]["state"] = "OPEN"
        self.assertNotIn(make_report.CLOSING,
                         [item["kind"] for item in make_report.timeline_entries(doc)])

    def test_an_event_with_broken_fields_does_not_crash(self):
        """events.json 是运行期写的，字段缺一两个也得能出报告。"""
        doc = {"events": [{"event_id": None, "nodeId": None, "actions": [None, 1],
                           "snapshots": [None, "x", {"kind": "camera"}]}]}
        entries = make_report.timeline_entries(doc)
        self.assertIsInstance(entries, list)

    def test_section_prints_the_rows(self):
        section = make_report.timeline_section(self.doc, None)
        self.assertEqual("事件时间线", section["title"])
        self.assertIn("开案：连续偏热", section["html"])
        # 表头 + 六个节点
        self.assertEqual(7, len(rows_of(section["html"])))

    def test_section_says_which_kinds_there_are(self):
        section = make_report.timeline_section(self.doc, None)
        for kind in (make_report.OPENING, make_report.PRIORITY, make_report.ACTION,
                     make_report.PHOTO, make_report.CLOSING):
            self.assertIn(kind, section["html"])

    def test_section_degrades_when_the_file_could_not_be_read(self):
        section = make_report.timeline_section(None, "没有 events.json（还没开过案子）")
        self.assertIn("没有 events.json", section["html"])
        self.assertIn("不影响统计和趋势", section["html"])

    def test_a_huge_timeline_is_capped_and_says_so(self):
        doc = {"events": [dict(events_doc()["events"][0],
                              event_id=f"e{index:04d}",
                              start_time=f"2026-09-23 {index % 24:02d}:00:00")
                          for index in range(make_report.TIMELINE_MAX)]}
        section = make_report.timeline_section(doc, None)
        self.assertIn("只画了前", section["html"])
        self.assertLessEqual(len(rows_of(section["html"])), make_report.TIMELINE_MAX + 1)


class TestLoadEvents(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def test_a_missing_file_is_a_reason_not_a_crash(self):
        data, reason = make_report.load_events(self.dir / "没有这个.json")
        self.assertIsNone(data)
        self.assertIn("没有这个.json", reason)

    def test_broken_json_is_a_reason(self):
        path = self.dir / "events.json"
        path.write_text('{"events": [', encoding="utf-8")   # 写到一半被 Ctrl+C
        data, reason = make_report.load_events(path)
        self.assertIsNone(data)
        self.assertIn("不是合法的 JSON", reason)

    def test_the_wrong_shape_is_a_reason(self):
        path = write_events({"v": 1}, self.dir)
        data, reason = make_report.load_events(path)
        self.assertIsNone(data)
        self.assertIn("形状不对", reason)

    def test_a_good_file_comes_back_whole(self):
        path = write_events(events_doc(), self.dir)
        data, reason = make_report.load_events(path)
        self.assertIsNone(reason)
        self.assertEqual(1, len(data["events"]))


class TestDisjointSpan(unittest.TestCase):
    def summary(self, first, last):
        return {"time_first": first, "time_last": last}

    def entries(self, times):
        return [{"time": time} for time in times]

    def test_overlapping_spans_say_nothing(self):
        self.assertIsNone(make_report.disjoint_span(
            self.summary("2026-09-23 14:00:00", "2026-09-23 14:15:00"),
            self.entries(["2026-09-23 14:05:00", "2026-09-24 09:00:00"])))

    def test_touching_spans_say_nothing(self):
        """首尾相接（一段的末尾正好是另一段的开头）不算不重叠。"""
        self.assertIsNone(make_report.disjoint_span(
            self.summary("2026-09-23 14:00:00", "2026-09-23 14:15:00"),
            self.entries(["2026-09-23 14:15:00"])))

    def test_disjoint_spans_say_something(self):
        note = make_report.disjoint_span(
            self.summary("2026-09-23 14:00:00", "2026-09-23 14:15:00"),
            self.entries(["2026-09-30 16:10:00"]))
        self.assertIsNotNone(note)
        self.assertIn("两段不重叠", note)
        self.assertIn("2026-09-23 14:00:00", note)
        self.assertIn("2026-09-30 16:10:00", note)

    def test_no_entries_means_nothing_to_compare(self):
        self.assertIsNone(make_report.disjoint_span(
            self.summary("2026-09-23 14:00:00", "2026-09-23 14:15:00"), []))

    def test_no_summary_means_nothing_to_compare(self):
        self.assertIsNone(make_report.disjoint_span(
            None, self.entries(["2026-09-30 16:10:00"])))

    def test_an_empty_csv_says_nothing(self):
        self.assertIsNone(make_report.disjoint_span(
            self.summary("", ""), self.entries(["2026-09-30 16:10:00"])))

    def test_the_section_shows_the_warning(self):
        section = make_report.timeline_section(
            events_doc(), None,
            self.summary("2026-09-01 10:00:00", "2026-09-01 10:05:00"))
        self.assertIn('class="warn"', section["html"])


# ======================================================================
# 六、Rule-ML 对比（预留）
# ======================================================================

class TestMlSection(unittest.TestCase):
    def with_labels(self, labels: list[str]):
        rows = []
        for index, (label, temp, hum) in enumerate(zip(
                labels, [25, 25, 31, 25], [60, 61, 60, 80])):
            rows.append({"time": f"2026-09-24 09:{index * 5:02d}:00",
                         "nodeId": "dorm-a", "temperature": temp, "humidity": hum,
                         "status": compute_status(temp, hum), "ml_label": label})
        return frame(rows)

    def test_no_column_is_a_placeholder_not_a_table(self):
        df = frame([{"time": "2026-09-24 09:00:00", "temperature": 25,
                     "humidity": 60, "status": "正常"}])
        section = make_report.ml_section(df)
        self.assertNotIn("<table>", section["html"])
        self.assertIn("连 ml_label 这一列都没有", section["html"])
        # 还得说清**真正的输入长什么样**：Phase8 D5 起 core 写的那份
        # data/history.csv 一直带着 ml_label 和 agree 两列。
        self.assertIn("data/history.csv", section["html"])

    def test_an_all_empty_column_is_a_placeholder(self):
        section = make_report.ml_section(self.with_labels(["", "", "", ""]))
        self.assertNotIn("<table>", section["html"])
        self.assertIn("整列都是空的", section["html"])

    def test_the_placeholder_does_not_claim_there_is_a_column_when_there_is_none(self):
        """两种"没有"的说法不能混。一份压根没有这一列的 CSV，要是先说
        「没有这一列」再说「这一列整列都是空的」，报告自己打自己。"""
        section = make_report.ml_section(frame([
            {"time": "2026-09-24 09:00:00", "temperature": 25, "humidity": 60,
             "status": "正常"}]))
        self.assertNotIn("整列都是空的", section["html"])

    def test_a_filled_column_gives_a_table(self):
        section = make_report.ml_section(self.with_labels(["normal", "", "", ""]))
        self.assertIn("<table>", section["html"])
        self.assertIn("CSV 里的 ml_label", section["html"])

    def test_only_the_rows_with_a_label_are_listed(self):
        section = make_report.ml_section(
            self.with_labels(["normal", "", "abnormal", ""]))
        # 表头 + 两行有值的
        self.assertEqual(3, len(rows_of(section["html"])))

    def test_a_disagreement_is_highlighted(self):
        """规则说正常、ml_label 说不是 —— 这一行要高亮。"""
        section = make_report.ml_section(
            self.with_labels(["abnormal", "", "", ""]))
        self.assertIn(analysis.MISMATCH_CLASS, section["html"])

    def test_the_reverse_disagreement_is_also_highlighted(self):
        """规则说偏热、ml_label 说 normal —— 反过来的那一种也要高亮。

        只高亮前一种的话，它在这张表里看着和「两边都同意」一模一样。
        """
        section = make_report.ml_section(
            self.with_labels(["", "", "normal", ""]))
        highlighted = [row for row in rows_of(section["html"])
                       if analysis.MISMATCH_CLASS in row[0]]
        self.assertEqual(1, len(highlighted))
        self.assertEqual("不是", highlighted[0][-1])

    def test_agreement_is_not_highlighted(self):
        section = make_report.ml_section(
            self.with_labels(["normal", "正常", "", ""]))
        self.assertNotIn(analysis.MISMATCH_CLASS, section["html"])

    def test_the_cell_count_is_the_header_count(self):
        section = make_report.ml_section(self.with_labels(["normal", "", "", ""]))
        for row in rows_of(section["html"]):
            self.assertEqual(len(make_report.ML_HEADER), len(row) - 1)

    def test_the_values_in_the_table_come_from_the_csv(self):
        """表里的 ml_label 是 CSV 里写着的那几个字，报告不加工也不翻译。"""
        section = make_report.ml_section(
            self.with_labels(["异常-湿度", "", "", ""]))
        self.assertIn("异常-湿度", section["html"])


    def test_the_agree_column_is_cross_checked_when_it_is_there(self):
        """CSV 带了 agree 那一列时，报告要**逐行重算**再比一遍。

        这是派生值入列之后该有的代价：status 靠 add_rule_status 重算复核，
        agree 照同一个先例 —— 不然被人改过的那一格谁也看不出来。
        这里第 2 行故意写反：31/60 是偏热（规则说异常）、ml_label 又写着
        normal（ML 说没事），两边其实**不一样**，可 agree 那一格写着 yes。
        """
        rows = [
            {"time": "2026-09-24 09:00:00", "temperature": 25, "humidity": 60,
             "status": "正常", "ml_label": "normal", "agree": "yes"},
            {"time": "2026-09-24 09:05:00", "temperature": 31, "humidity": 60,
             "status": "偏热", "ml_label": "normal", "agree": "yes"},
        ]
        section = make_report.ml_section(frame(rows))
        self.assertIn('class="warn"', section["html"])
        self.assertIn("该是 no", section["html"])

    def test_agree_that_all_matches_says_so_out_loud(self):
        rows = [{"time": "2026-09-24 09:00:00", "temperature": 25, "humidity": 60,
                 "status": "正常", "ml_label": "normal", "agree": "yes"}]
        section = make_report.ml_section(frame(rows))
        self.assertNotIn('class="warn"', section["html"])
        self.assertIn("全部对得上", section["html"])


# ======================================================================
# 六之二、案例分析（Phase8 D5）
# ======================================================================

def case_frame(extra, history=None) -> pd.DataFrame:
    """一份给 case_section 用的 CSV。

    `history` 是**非构造样本**的历史读数（source=sim），用来算每个宿舍的参照区间；
    `extra` 是要分析的那些行 —— 构造样本、带 ml_label。

    这样分开摆是有意的：这一块全部的本事就是「拿历史当参照看这条落在里面还是外面」，
    所以「哪些算历史」必须能单独控制，才能测出构造样本有没有被算进去。
    """
    rows = list(history or [])
    rows += extra
    return frame(rows)


def sim_row(node, temperature, humidity, when="2026-09-23 14:00:00"):
    return {"time": when, "nodeId": node, "temperature": temperature,
            "humidity": humidity, "status": compute_status(temperature, humidity),
            "ml_label": "", "source": "sim"}


def sample_row(node, temperature, humidity, label, when="2026-09-24 09:00:00"):
    return {"time": when, "nodeId": node, "temperature": temperature,
            "humidity": humidity, "status": compute_status(temperature, humidity),
            "ml_label": label, "source": "constructed"}


# dorm-a 平时的读数范围：24~31 ℃ / 58~80 %。后面拿它当参照。
DORM_A_HISTORY = [
    sim_row("dorm-a", 24, 58), sim_row("dorm-a", 31, 80),
    sim_row("dorm-a", 27, 66), sim_row("dorm-a", 29, 72),
]


class TestCaseSection(unittest.TestCase):
    """案例分析：两边判得不一样的那些行，以及每个宿舍的参照区间。

    这一块里**没有一个数字是手写的** —— 方向、区间、条数全部从传进来的那份 df
    现算。所以下面每条用例都是「造一份 CSV -> 看它推出来什么」。
    """

    def case_table_rows(self, df) -> list[list[str]]:
        """案例分析那张表的**数据行**（rows_of 每行第一个元素是 class，掐掉）。

        先断言表头就是 CASE_HEADER：不然取到的可能是下面那张「参照区间」表，
        而那张表的列完全不一样 —— 「按列名取」会当场取到别的东西。
        """
        rows = rows_of(make_report.case_section(df)["html"])
        self.assertEqual(rows[0][1:], make_report.CASE_HEADER,
                         "案例分析这张表的表头变了 —— 下面的按列名取全要跟着改")
        return [row[1:] for row in rows[1:]]

    def test_both_directions_get_their_own_row(self):
        """正反两个方向各一行，而且各自标着是哪个方向。

        合成一句「不一致」的话，读的人分不出这条是「规则太粗」还是
        「ML 太严」—— 而这两件事要去查的地方完全不同。
        """
        df = case_frame([
            sample_row("dorm-a", 18.5, 58, "abnormal", "2026-09-24 09:00:00"),
            sample_row("dorm-a", 31, 60, "normal", "2026-09-24 09:05:00"),
        ], DORM_A_HISTORY)
        rows = self.case_table_rows(df)
        self.assertEqual(len(rows), 2)
        self.assertEqual([row[make_report.CASE_HEADER.index("方向")] for row in rows],
                         [make_report.CASE_FORWARD, make_report.CASE_REVERSE])

    def test_the_agreeing_row_is_not_in_the_table(self):
        """两边判得一样的行不进这张表 —— 它只是「差异」那个清单。

        混进去的话，「N 行两边不一样」和表里行数对不上，读的人会开始怀疑
        到底哪几行才是要看的。
        """
        df = case_frame([
            sample_row("dorm-a", 25, 60, "normal", "2026-09-24 09:00:00"),
            sample_row("dorm-a", 31, 60, "normal", "2026-09-24 09:05:00"),
        ], DORM_A_HISTORY)
        rows = self.case_table_rows(df)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][make_report.CASE_HEADER.index("时间")],
                         "2026-09-24 09:05:00")
        self.assertEqual(rows[0][make_report.CASE_HEADER.index("方向")],
                         make_report.CASE_REVERSE)

    def test_the_reference_range_comes_from_non_constructed_rows(self):
        """参照区间取的是**非构造样本**的历史，构造样本自己不算历史。

        算进去的话区间会被这批专挑出来的极端值撑大 —— 而这张表要说的正是
        「这条越没越界」，区间一被撑大就什么都看不出来了，而且是静默的。
        """
        df = case_frame([
            # 这条 5/20 要是算进历史，dorm-a 的区间会变成 5–31 ℃ / 20–80 %
            sample_row("dorm-a", 5, 20, "normal", "2026-09-24 09:00:00"),
            sample_row("dorm-a", 31, 60, "normal", "2026-09-24 09:05:00"),
        ], DORM_A_HISTORY)
        html = make_report.case_section(df)["html"]
        self.assertIn("24–31 ℃ / 58–80 %", html)
        self.assertNotIn("5–31", html)

    def test_each_row_carries_its_own_nodes_range(self):
        """两个宿舍各带各的区间 —— 别把 dorm-a 的历史写到 dorm-b 那行上。"""
        df = case_frame([
            sample_row("dorm-a", 18.5, 58, "abnormal"),
            sample_row("dorm-b", 25, 60, "abnormal"),
        ], DORM_A_HISTORY + [sim_row("dorm-b", 20, 40), sim_row("dorm-b", 22, 45)])
        html = make_report.case_section(df)["html"]
        self.assertIn("24–31 ℃ / 58–80 %", html)
        self.assertIn("20–22 ℃ / 40–45 %", html)

    def test_a_node_with_no_history_is_said_not_guessed(self):
        """某个宿舍没有可参照的历史时如实写一句，不给一个看起来像区间的数字。

        dorm-c 只出现在构造样本里（没有历史），它那一行最后一格必须是把话说破的
        那一句 —— 留空的话，读的人分不清是「没历史」还是「这一格漏画了」。
        """
        df = case_frame([sample_row("dorm-c", 16, 60, "normal")], DORM_A_HISTORY)
        rows = self.case_table_rows(df)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][make_report.CASE_HEADER.index("该宿舍历史区间")],
                         "（这个宿舍没有可参照的历史）")

    def test_a_csv_without_any_history_is_said_too(self):
        """整份 CSV 一条参照读数都没有（全是构造样本）时，也如实说。

        这时出的是「参照区间」那段话（差异清单为空，走到的是同一个出口）。
        """
        df = case_frame([sample_row("dorm-a", 25, 60, "normal")])
        html = make_report.case_section(df)["html"]
        self.assertIn("没有可用作参照的历史读数", html)
        # 那句话要把「算不算历史」的判据说清楚，不然读的人会以为数据丢了。
        self.assertIn("不是构造样本", html)

    def test_the_thresholds_are_read_from_the_rules_not_written_here(self):
        """说明里那三条线取的是 rules 里的常量。

        把数字抄进这份文件的话，改规则的时候报告会继续说旧的线 ——
        而报告是拿给人当下判断用的，说错线的位置比不写更糟。
        所以这里把三条线临时改掉，看报告跟不跟着走。
        """
        df = case_frame([sample_row("dorm-a", 25, 60, "normal")], DORM_A_HISTORY)
        with mock.patch.object(rules, "TEMP_LOW", 7), \
                mock.patch.object(rules, "TEMP_HIGH", 44), \
                mock.patch.object(rules, "HUMIDITY_HIGH", 91):
            html = make_report.case_section(df)["html"]
        for patched in ("7", "44", "91"):
            self.assertIn(patched, html)
        for original in (str(rules.TEMP_LOW), str(rules.HUMIDITY_HIGH)):
            self.assertNotIn(original, html)

    def test_no_verdicts_says_so_and_still_gives_the_ranges(self):
        """一行判词都没有时，说明白为什么，区间照样给出来。

        区间不是判词的附庸：它是「这个宿舍平时什么样」这个事实，
        有没有模型都成立。这时出的是**参照区间**那张表，不是案例分析表 ——
        差异清单是空的，但「平时什么样」还有得看。
        """
        df = case_frame([], DORM_A_HISTORY)
        section = make_report.case_section(df)
        self.assertIn("一行 ml_label 都没有", section["html"])
        self.assertIn("24–31 ℃ / 58–80 %", section["html"])
        self.assertEqual(rows_of(section["html"])[0][1:],
                         ["宿舍", "参照条数", "温湿度区间"])

    def test_verdicts_without_a_disagreement_says_that_too(self):
        """有判词、但两边一条都没分家 —— 也**如实说**，还要给出复现的办法。

        「没对照过」和「对照完没差别」是两件事。后者不说清的话，
        看报告的人会以为这一块漏跑了。
        """
        df = case_frame([sample_row("dorm-a", 25, 60, "normal")], DORM_A_HISTORY)
        html = make_report.case_section(df)["html"]
        self.assertIn("没有任何一条两边判得不一样", html)
        self.assertIn("replay_samples.py", html)
        self.assertIn("24–31 ℃ / 58–80 %", html)

    def test_the_table_is_not_highlighted(self):
        """整张表都是「不一样」的行，所以不高亮任何一行。

        高亮在这份报告里一贯表示「两种口径说法不同」；这儿每一行都是那种行，
        标了等于没标，还会把上一节「规则复核」那个 warn 的意思冲淡。
        """
        df = case_frame([
            sample_row("dorm-a", 18.5, 58, "abnormal"),
            sample_row("dorm-a", 31, 60, "normal"),
        ], DORM_A_HISTORY)
        html = make_report.case_section(df)["html"]
        self.assertNotIn(analysis.MISMATCH_CLASS, html)

    def test_the_header_is_the_declared_one(self):
        """表头就是 CASE_HEADER 那八列，一格不差。

        报告里这一块的列名是**声明出来的常量**，不是散在拼 HTML 那几个地方 ——
        改列的时候改一处，测试和报告一起跟着走。
        """
        df = case_frame([sample_row("dorm-a", 18.5, 58, "abnormal")], DORM_A_HISTORY)
        section = make_report.case_section(df)
        self.assertEqual(section["title"], make_report.CASE_TITLE)
        header = rows_of(section["html"])[0]
        # [0] 是那一行的 class；表头行没有 class，所以正好是从 [1] 起的八格。
        self.assertEqual(header[0], "")
        self.assertEqual(header[1:], make_report.CASE_HEADER)

    def test_it_comes_right_after_the_ml_table(self):
        """顺序：对照表在前、解释在后（「表 → 释」）。

        反过来的话，读的人先看到一堆解释，不知道那些话在说哪几行。
        """
        df = case_frame([sample_row("dorm-a", 18.5, 58, "abnormal")], DORM_A_HISTORY)
        # 事件那一份**故意用不存在的路径**：这一条测的是区块顺序，
        # 「案卷文件找不到」正是这条链最常见的真实情况（还没跑过 core）。
        events_data, events_reason = make_report.load_events(
            Path("这个文件不存在.json"))
        sections = make_report.built_sections(
            df, events_data, events_reason, make_report.node_stats(df),
            analysis.summarize(df, Path("in.csv"), verbose=False))
        titles = [section["title"] for section in sections]
        self.assertEqual(titles[-2:], [make_report.ML_TITLE, make_report.CASE_TITLE])


# ======================================================================
# 七、整份报告
# ======================================================================

class TestBuildReport(unittest.TestCase):
    def build(self, df=None, doc=None, reason=None, summary=None, stamp=None):
        df = history_frame() if df is None else df
        summary = summary or analysis.summarize(df, verbose=False)
        return make_report.build_report(df, summary, doc, reason,
                                        stamp or "2026-09-30 17:00:00")

    def test_the_title_is_replaced_everywhere(self):
        html = self.build()
        title = make_report.report_title(analysis.summarize(history_frame(), verbose=False))
        self.assertIn(f"<title>{title}</title>", html)
        self.assertIn(f"<h1>{title}</h1>", html)
        self.assertNotIn(analysis.REPORT_TITLE, html)

    def test_the_title_names_the_file_that_was_actually_read(self):
        """标题里那一格是**真正读的那个 CSV**，不是写死的 history.csv。

        写死的话，第二、第三份报告就在说一件没发生的事：data/day_sim.csv 是
        make_sim_data.py 生成的，它根本没经过 core。
        """
        df = history_frame()
        summary = analysis.summarize(df, Path("data/day_sim.csv"), verbose=False)
        head = self.build(df=df, summary=summary).split("<h1>")[1].split("</h1>")[0]
        self.assertEqual(head, "DormMate 离线分析报告（Phase7：day_sim.csv → 本报告）")
        self.assertNotIn("history.csv", head)

    def test_a_missing_file_says_unspecified(self):
        """summary 里没有 file（比如直接喂一个 DataFrame）时说的是「未指定」，
        和 analysis.py 页头那句一个口径 —— 不编一个文件名出来。"""
        self.assertEqual(
            make_report.report_title({}),
            "DormMate 离线分析报告（Phase7：（未指定） → 本报告）")

    def test_a_pesky_filename_is_escaped(self):
        """文件名是直接拼进 <title> / <h1> 的，所以得先转义 ——
        一个带 & 的 CSV 名不该把报告的两个标题弄坏。"""
        title = make_report.report_title({"file": "C:/tmp/a&b<c.csv"})
        self.assertIn("a&amp;b&lt;c.csv", title)
        self.assertNotIn("a&b<c.csv", title)

    def test_a_changed_title_shape_is_caught(self):
        """analysis.py 那边要是把标题写成了三处（或多处），当场报出来，
        不要交一份标题半新半旧的报告。"""
        original = analysis._document
        self.addCleanup(setattr, analysis, "_document", original)
        analysis._document = lambda body: "<h1>x</h1>"      # 一处都没有
        with self.assertRaises(SystemExit):
            self.build()

    def test_every_section_is_there(self):
        html = self.build()
        for title in ("摘要", "数据来源", "每个宿舍的温湿度", "趋势图",
                      "事件时间线", "今日摘要", "Rule-ML 对比", "需要关注的记录"):
            self.assertIn(f"<h2>{title}</h2>", html)

    def test_it_is_a_single_file(self):
        """没有外部 src / href / script / link —— 拷到任何地方都该能直接打开。"""
        html = self.build()
        for attr in re.findall(r'(?:src|href)="([^"]*)"', html):
            self.assertTrue(attr.startswith("data:"),
                            f"报告里有一个指向外部的 {attr!r}")
        self.assertNotIn("<script", html)
        self.assertNotIn("<link", html)

    def test_the_image_is_inlined(self):
        html = self.build()
        self.assertIn("data:image/png;base64,", html)

    def test_the_same_input_gives_the_same_bytes(self):
        """同一个 generated_at、同一份输入，两次必须逐字节一样。

        不一样的话，报告就没法做"这次和上次有什么不同"的对比 ——
        而它每次跑出来的生成时间本来就是变的，所以只有钉住时间才比得了。
        """
        self.assertEqual(self.build(), self.build())

    def test_the_numbers_all_come_from_the_input(self):
        """换一份 CSV，报告里的每一个数字都得跟着变。

        这一条是冲着"偷偷写死"去的：记录数、极值、平均、状态条数、图上点数，
        没有一个是报告自己编的。
        """
        small = self.build(df=history_frame())
        big = history_frame()
        big = pd.concat([big, big], ignore_index=True)
        other = self.build(df=big, summary=analysis.summarize(big, verbose=False))
        self.assertNotEqual(small, other)
        self.assertEqual("7", records_card(small))
        self.assertEqual("14", records_card(other))

    def test_a_report_without_events_still_works(self):
        html = self.build(doc=None, reason="没有 events.json")
        self.assertIn("没有 events.json", html)
        self.assertIn("<h2>趋势图</h2>", html)

    def test_the_generated_time_shows_up(self):
        self.assertIn("2026-09-30 17:00:00", self.build())


class TestWriteReport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def test_it_creates_the_directory(self):
        out = self.dir / "深" / "一层" / "report.html"
        df = history_frame()
        make_report.write_report(df, analysis.summarize(df, verbose=False),
                                 None, None, out)
        self.assertTrue(out.exists())

    def test_it_writes_utf8_without_a_bom_and_with_lf(self):
        """和 analysis.write_report 一个口径：UTF-8 不带 BOM、LF。

        带 BOM 的 HTML 浏览器认，但 `<meta charset="utf-8">` 和 BOM 同时出现时
        有的工具（还有 git 的二进制嗅探）会犯迷糊；CRLF 则会让每一行在 diff 里
        都显示成改过。
        """
        out = self.dir / "report.html"
        df = history_frame()
        make_report.write_report(df, analysis.summarize(df, verbose=False),
                                 None, None, out)
        raw = out.read_bytes()
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"), "报告不该带 BOM")
        self.assertNotIn(b"\r\n", raw, "报告的换行该是 LF")


# ======================================================================
# 八、命令行
# ======================================================================

class TestMain(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def write_csv(self, name: str = "in.csv") -> Path:
        path = self.dir / name
        # 最后那个空字段是 agree：这两行的 ml_label 都是空的，所以它也该空着
        # ——「没判」在 CSV 里必须看得出来（见 history.py 的 AGREE_EMPTY）。
        # 有判词的样本归 TestCaseSection 那一段，这一份只管命令行这条路。
        text = ",".join(HISTORY_HEADER) + "\n" + "\n".join([
            "2026-09-23 14:00:00,dorm-a,25,60,正常,,,,构造样本,",
            "2026-09-23 14:05:00,dorm-a,31,60,偏热,,dorm-a-1,OPEN,构造样本,",
        ]) + "\n"
        path.write_text(text, encoding="utf-8", newline="\n")
        return path

    def run_main(self, argv: list[str]) -> str:
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            make_report.main(argv)
        return buffer.getvalue()

    def test_it_writes_the_report_it_was_asked_for(self):
        out = self.dir / "out.html"
        text = self.run_main(["--csv", str(self.write_csv()),
                              "--events", str(self.dir / "没有.json"),
                              "--out", str(out)])
        self.assertTrue(out.exists())
        self.assertIn("报告已写入", text)

    def test_a_missing_csv_explains_the_phase7_chain(self):
        """缺 CSV 的提示要指向**这条链**的输入（core 写的那份），
        不能沿用 analysis.py 那句"去网页上点导出" —— 照着那句做会白忙一场。"""
        with self.assertRaises(SystemExit) as caught:
            make_report.main(["--csv", str(self.dir / "没有.csv")])
        message = str(caught.exception)
        self.assertIn("core.py", message)
        self.assertIn("simulator", message)

    def test_the_default_output_is_not_the_analysis_report(self):
        """默认输出**故意**不是 report/report.html：那一份是 analysis.py 的产物。

        两个脚本往同一个文件上写的话，后跑的那个会静默覆盖前一个，而文件名
        一样、看不出换过作者。
        """
        self.assertNotEqual(Path("report") / "report.html",
                            Path(make_report.DEFAULT_OUT).relative_to(make_report._ROOT))

    def test_the_defaults_point_at_the_history_csv_and_the_event_file(self):
        self.assertEqual("history.csv", Path(make_report.DEFAULT_CSV).name)
        self.assertEqual("events.json", Path(make_report.DEFAULT_EVENTS).name)

    def test_relative_paths_resolve_against_the_project_root(self):
        """相对路径按**项目根**展开，不是按当前工作目录。

        所以 `py -3.14 analysis/make_report.py --csv data/history.csv` 在哪个
        目录下敲都一样。这里用真的相对路径，而不是把绝对路径递进去了再说
        "验的是相对路径" —— 后者什么都没验。
        """
        out = self.dir / "out.html"
        self.run_main(["--csv", "data/constructed_samples.csv",
                       "--out", str(out)])
        self.assertTrue(out.exists())
        self.assertIn("构造样本", out.read_text(encoding="utf-8"))

    def test_it_prints_the_per_node_numbers(self):
        out = self.dir / "out.html"
        text = self.run_main(["--csv", str(self.write_csv()), "--out", str(out)])
        self.assertIn("2 条记录", text)
        self.assertIn("dorm-a", text)
        self.assertIn("31", text)

    def test_it_says_so_when_the_events_file_is_missing(self):
        out = self.dir / "out.html"
        text = self.run_main(["--csv", str(self.write_csv()),
                              "--events", str(self.dir / "没有.json"),
                              "--out", str(out)])
        self.assertIn("事件：没读到", text)


# ======================================================================
# 九、提交进仓库的那份构造样本
# ======================================================================

class TestConstructedSampleFile(unittest.TestCase):
    """data/constructed_samples.csv 是要提交的**输入**，它自己也得守住几条规矩。"""

    PATH = REPO / "data" / "constructed_samples.csv"

    def setUp(self):
        if not self.PATH.exists():
            self.fail(f"没有了 {self.PATH.name} —— 它是要提交的输入，不是运行期产物")
        self.raw = self.PATH.read_bytes()
        self.text = self.raw.decode("utf-8-sig")

    def test_it_is_crlf_with_a_bom(self):
        self.assertTrue(self.raw.startswith(b"\xef\xbb\xbf"), "缺 UTF-8 BOM")
        self.assertEqual(0, self.raw.count(b"\n") - self.raw.count(b"\r\n"),
                         "混进了裸 LF")

    def test_the_columns_are_the_ten_history_columns_in_order(self):
        self.assertEqual(",".join(HISTORY_HEADER),
                         self.text.splitlines()[0])

    def test_every_status_matches_the_rule(self):
        """每行的 status 都得是统一规则算出来的。

        这份文件里的 status 是生成脚本按规则算的；哪天规则改了、而这份没重跑，
        报告开头那条「规则复核」横幅会第一个炸出来 —— 与其等到那时候，不如
        在这儿红掉。
        """
        import csv as csv_module
        for row in csv_module.DictReader(io.StringIO(self.text)):
            temperature = float(row["temperature"])
            humidity = float(row["humidity"])
            self.assertEqual(compute_status(temperature, humidity), row["status"],
                             f'{row["time"]} 这一行的 status 和规则对不上')

    def test_its_source_is_a_constructed_sample_not_simulated_data(self):
        """手写的就是手写的。写成「模拟」的话，报告开头会说这份数据是模拟器
        跑出来的 —— 那是把来路说错。

        **按列名读，不按 `split(",")[-1]`**：Phase8 D5 在末尾加了 agree，
        取「最后一格」取到的就是 yes / no 了 —— 那样这个断言会照样绿，
        而它守的那件事（source 是不是构造样本）一个字都没查。
        """
        import csv as csv_module
        sources = {row["source"] for row in csv_module.DictReader(io.StringIO(self.text))}
        self.assertNotIn("模拟", sources)
        self.assertEqual(sources, {"构造样本"})

    def test_its_agree_column_matches_what_the_report_recomputes(self):
        """这份输入的第 10 列 agree 是**算出来的**，不是手敲的。

        它是「派生值 + 重算复核」这套办法的第二个样本（第一个是 status）：
        报告里那句复核就是拿这一列和「规则 + ml_label 现算」逐行比的。
        横竖两个方向各要有一条 —— 只写 yes 的话，把布尔写反了这条照样绿。
        """
        import csv as csv_module
        rows = list(csv_module.DictReader(io.StringIO(self.text)))
        written = {row["time"]: row["agree"] for row in rows if row["agree"]}
        self.assertEqual(len(written), 3, f"有 agree 的行数变了：{written}")
        self.assertEqual(sorted(written.values()), ["no", "no", "yes"])
        for row in rows:
            if not row["ml_label"]:
                self.assertEqual(row["agree"], "",
                                 f'{row["time"]} 没判 ML 却写了 agree')
        # 最后落到报告那条链上：复核一条都不该报错。
        df = analysis.add_rule_status(analysis.load(self.PATH))
        labels = [analysis._clean(value) for value in df["ml_label"]]
        self.assertEqual(make_report.agree_check(df, labels)["bad"], [])

    def test_it_has_labels_for_the_reserved_section(self):
        """这份样本存在的理由之一：让「Rule-ML 对比」那块真的跑起来。"""
        rows = analysis.add_rule_status(analysis.load(self.PATH))
        labels = [analysis._clean(value) for value in rows["ml_label"]]
        self.assertGreater(sum(1 for label in labels if label), 0)

    def test_it_contains_at_least_one_disagreement_to_highlight(self):
        """没有一处不一致的话，那个高亮等于没验。"""
        rows = analysis.add_rule_status(analysis.load(self.PATH))
        rules_normal = rows["rule_status"] == rules.STATUS_NORMAL
        labels = rows["ml_label"].fillna("").astype(str).str.strip()
        ml_normal = labels.str.lower().isin(["normal", "正常", "ok"])
        disagreements = (rules_normal != ml_normal) & (labels != "")
        self.assertGreater(int(disagreements.sum()), 0)

    def test_it_covers_all_four_regression_values(self):
        """四组回归数据（25/60、16/60、31/60、25/80）在这份样本里都出现一遍。"""
        rows = analysis.load(self.PATH)
        pairs = {(float(row.temperature), float(row.humidity))
                 for row in rows.itertuples()}
        for expected in [(25, 60), (16, 60), (31, 60), (25, 80)]:
            self.assertIn(expected, pairs)


if __name__ == "__main__":
    unittest.main()
