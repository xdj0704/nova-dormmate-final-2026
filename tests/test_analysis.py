"""analysis/ 的测试：规则转发、路径推导、CSV 读取、基础统计。

    py -3.14 -m unittest discover -s tests -t . -v

需要 pandas（装在 64 位 Python 3.14 里），所以用 py -3.14 跑。
"""

from __future__ import annotations

import io
import json
import logging
import math
import re
import tempfile
import unittest
import warnings
from contextlib import redirect_stdout
from datetime import datetime
from pathlib import Path

import pandas as pd

import status_rules
from analysis import analysis, ml, rules

# 画图那几只用 matplotlib 的测试要跳过而不是报错：matplotlib 是 Step 2-4
# 才引进来的依赖，没装的时候"读 CSV + 统计"这套仍然该能跑能测。
try:
    import matplotlib  # noqa: F401

    HAS_MPL = True
except ImportError:
    HAS_MPL = False

# scikit-learn 是 Step 9-2 才引进来的（ML 那一段）。同理：没装的时候只是
# ML 那一段降级，读 CSV + 统计 + 出报告这条路仍然该能跑能测。
try:
    import sklearn  # noqa: F401

    HAS_SKLEARN = True
except ImportError:
    HAS_SKLEARN = False

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

BOM = chr(0xFEFF)
HEADER = "time,temperature,humidity,status"


def write_csv(text: str, name: str = "t.csv", bom: bool = True) -> Path:
    """把文本写成临时 CSV，默认带 BOM，模拟网页导出的文件。"""
    path = Path(tempfile.mkdtemp()) / name
    path.write_text((BOM if bom else "") + text, encoding="utf-8", newline="")
    return path


def capture(func, *args, **kwargs) -> str:
    """接住函数打印的内容，只返回文本。"""
    buf = io.StringIO()
    with redirect_stdout(buf):
        func(*args, **kwargs)
    return buf.getvalue()


class TestRulesForwarding(unittest.TestCase):
    """analysis/rules.py 必须是转发，不是第二份实现。"""

    def test_judge_status_就是根模块那个函数(self):
        self.assertIs(rules.judge_status, status_rules.compute_status)

    def test_阈值也从根模块借过来(self):
        self.assertEqual(rules.TEMP_LOW, status_rules.TEMP_LOW)
        self.assertEqual(rules.TEMP_HIGH, status_rules.TEMP_HIGH)
        self.assertEqual(rules.HUMIDITY_HIGH, status_rules.HUMIDITY_HIGH)

    def test_四组回归数据(self):
        for temperature, humidity, expected in rules.REGRESSION_CASES:
            with self.subTest(temperature=temperature, humidity=humidity):
                self.assertEqual(rules.judge_status(temperature, humidity), expected)

    def test_回归数据的期望值和老师给的一致(self):
        self.assertEqual(
            rules.REGRESSION_CASES,
            [(25, 60, "正常"), (16, 60, "偏冷"), (31, 60, "偏热"), (25, 80, "偏湿")],
        )

    def test_31度80湿度是偏热不是偏湿(self):
        # 约定里点名的坑：温度规则先命中
        self.assertEqual(rules.judge_status(31, 80), "偏热")

    def test_run_tests_全通过(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            passed = rules.run_tests()
        self.assertTrue(passed)
        self.assertIn("4/4 通过", buf.getvalue())

    def test_run_tests_有失败时返回False(self):
        # 把期望值改错，确认它真的会报失败，而不是永远返回 True
        original = rules.REGRESSION_CASES
        rules.REGRESSION_CASES = [(25, 60, "偏热")]   # 25/60 实际是「正常」
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                passed = rules.run_tests()
        finally:
            rules.REGRESSION_CASES = original

        self.assertFalse(passed)
        self.assertIn("0/1 通过", buf.getvalue())
        self.assertIn("不通过", buf.getvalue())


class TestResolveCsv(unittest.TestCase):
    """相对路径按项目根展开，这样在任何目录下运行都找得到文件。"""

    def test_默认文件在项目根的_data_下(self):
        self.assertEqual(analysis.DEFAULT_CSV, analysis.ROOT / "data" / "dormmate.csv")
        self.assertTrue(analysis.DEFAULT_CSV.is_absolute())

    def test_相对路径按项目根展开(self):
        self.assertEqual(
            analysis.resolve_csv("data/dormmate.csv"),
            analysis.ROOT / "data" / "dormmate.csv",
        )

    def test_绝对路径原样返回(self):
        self.assertEqual(
            analysis.resolve_csv(r"C:\tmp\x.csv"),
            Path(r"C:\tmp\x.csv"),
        )

    def test_项目根就是仓库根(self):
        # analysis/ 的上一级：status_rules.py 和 web/ 都在那儿
        self.assertTrue((analysis.ROOT / "status_rules.py").is_file())
        self.assertTrue((analysis.ROOT / "web").is_dir())


class TestParsesAsNumber(unittest.TestCase):
    """挑「该报哪一格」用的那道判断。

    它和 isinstance 不是一回事，差的正是关键的那一格：pandas 遇到一格文字会把
    整列都读成字符串，于是本来好好的 25 也成了 '25' —— 那种格子按类型判是不对
    的，按内容判才是对的。
    """

    def test_数字算(self):
        for value in (25, 25.5, -5):
            self.assertTrue(analysis._parses_as_number(value), value)

    def test_看着像数字的字符串也算(self):
        # 这一条是关键：改回 isinstance 的话它会红，而红的原因就是「报错了行」
        self.assertTrue(analysis._parses_as_number("25"))
        self.assertTrue(analysis._parses_as_number(" 25 "))

    def test_文字不算(self):
        for value in ("不热", "abc", "", "25℃"):
            self.assertFalse(analysis._parses_as_number(value), value)

    def test_带着引号的数字不算(self):
        self.assertFalse(analysis._parses_as_number("'25'"))


class TestLoad(unittest.TestCase):
    def test_utf8sig_吃掉了BOM_列名是干净的(self):
        path = write_csv(f"{HEADER}\r\n2026-09-22 20:30:00,31,78,偏热\r\n")
        df = analysis.load(path)
        self.assertEqual(list(df.columns), ["time", "temperature", "humidity", "status"])
        # 中文没有乱码 —— 乱码的话这里就会是别的字符串
        self.assertEqual(df["status"][0], "偏热")

    def test_文件确实带BOM_普通读取会看到多出来的字符(self):
        """证明 fixture 里真有 BOM，以及为什么要在 encoding 上做文章。

        注意：这里【不能】拿 pandas 当反面对照 —— pandas 3.x 的 read_csv
        自己就会吃掉 BOM，用 coding="utf-8" 读出来照样是干净的 time。
        换标准库按 utf-8 读才试得出来：第一个字符就是 U+FEFF。

        我们仍然显式写 utf-8-sig：既是要求，也免得依赖 pandas 版本的行为
        （旧版 pandas 和标准库都会把这个 BOM 留在列名里）。
        """
        path = write_csv(f"{HEADER}\r\n2026-09-22 20:30:00,31,78,偏热\r\n")

        self.assertEqual(path.read_bytes()[:3], b"\xef\xbb\xbf")   # 文件头真有 BOM
        with open(path, encoding="utf-8") as handle:
            self.assertTrue(handle.readline().startswith(BOM))     # 标准库会留着它

    def test_没有BOM的文件也能读(self):
        path = write_csv(f"{HEADER}\r\n2026-09-22 20:30:00,25,60,正常\r\n", bom=False)
        df = analysis.load(path)
        self.assertEqual(list(df.columns)[0], "time")

    def test_文件不存在时给一句人话而不是报错栈(self):
        missing = analysis.ROOT / "data" / "根本没有这个文件.csv"
        with self.assertRaises(SystemExit) as ctx:
            analysis.load(missing)
        message = str(ctx.exception)
        self.assertIn("找不到 CSV", message)
        self.assertIn("导出 CSV", message)      # 告诉用户这个文件从哪来

    def test_缺列时指出缺了哪列(self):
        path = write_csv("time,temperature,status\r\n2026-09-22 20:30:00,31,偏热\r\n")
        with self.assertRaises(SystemExit) as ctx:
            analysis.load(path)
        self.assertIn("humidity", str(ctx.exception))

    def test_只有表头也能读(self):
        path = write_csv(f"{HEADER}\r\n")
        df = analysis.load(path)
        self.assertEqual(len(df), 0)

    # 温湿度必须是数字。查在这里而不是查在各处用它的地方：这是全项目唯一读 CSV
    # 的函数，查一遍三条路（analysis / daily_summary / ml）都干净。
    # 不查的话，'不热' 会一路走到 rules.judge_status 里，在 `temperature < 18`
    # 那一行崩成一个 TypeError —— 看得出类型不对，看不出是哪一行哪一列。

    def test_温度是文字时给一句人话(self):
        path = write_csv(f"{HEADER}\r\n2026-09-22 20:30:00,不热,60,正常\r\n")
        with self.assertRaises(SystemExit) as ctx:
            analysis.load(path)
        message = str(ctx.exception)
        self.assertIn("temperature", message)
        self.assertIn("不是数字的值", message)
        self.assertIn("不热", message)

    def test_湿度是文字时也报(self):
        path = write_csv(f"{HEADER}\r\n2026-09-22 20:30:00,25,很干,正常\r\n")
        with self.assertRaises(SystemExit) as ctx:
            analysis.load(path)
        self.assertIn("humidity", str(ctx.exception))

    def test_报出是第几行的哪一刻(self):
        # 表头占第 1 行，所以第一条数据是第 2 行 —— 行号按文本的行数数，
        # 这样用记事本打开就能直接跳过去
        path = write_csv(f"{HEADER}\r\n2026-09-22 20:30:00,不热,60,正常\r\n")
        with self.assertRaises(SystemExit) as ctx:
            analysis.load(path)
        message = str(ctx.exception)
        self.assertIn("第 2 行", message)
        self.assertIn("2026-09-22 20:30:00", message)

    def test_坏值在第几条就说第几行(self):
        # 报的必须是写坏的那一格（abc，第 5 行），不是列里第一格：
        # 一列里混进一格文字时，pandas 会把整列都读成字符串（前面的 25 也成了
        # '25'），按类型挑的话会指着第 2 行的 25 说「这不是数字」，而它明明没事。
        path = write_csv(f"{HEADER}\r\n"
                         "2026-09-22 20:30:00,25,60,正常\r\n"
                         "2026-09-22 21:00:00,26,61,正常\r\n"
                         "2026-09-22 21:30:00,27,62,正常\r\n"
                         "2026-09-22 22:00:00,abc,63,正常\r\n")
        with self.assertRaises(SystemExit) as ctx:
            analysis.load(path)
        message = str(ctx.exception)
        self.assertIn("第 5 行", message)
        self.assertIn("'abc'", message)
        # 时刻也得是这一条的：行号对上了、时刻指着头一条的话，等于把用户往上面
        # 几行引，手改 CSV 的人照着找还是找不到那一格。
        self.assertIn("2026-09-22 22:00:00", message)

    def test_空格子在前面时报的还是后面那格文字(self):
        # 空格子读出来是 nan，而 nan 本身是 numbers.Number，所以它压根进不了
        # 「不是数字」那一堆 —— 它属于「空着」（缺失单独算一档），不属于「写坏了」。
        # 报它没用：用户按报出来的行号去改第 2 行那个空格子，文件还是不认，
        # 因为写字的是第 3 行。
        path = write_csv(f"{HEADER}\r\n"
                         "2026-09-22 20:30:00,,60,正常\r\n"
                         "2026-09-22 21:00:00,不热,61,正常\r\n")
        with self.assertRaises(SystemExit) as ctx:
            analysis.load(path)
        message = str(ctx.exception)
        self.assertIn("'不热'", message)
        self.assertIn("第 3 行", message)
        self.assertNotIn("第 2 行", message)

    def test_带引号的数字也不行(self):
        # '25' 在 Python 里是字符串，一样会在 str < float 上崩 —— 所以判据是
        # 「能不能直接比大小」，不是「看起来像不像数字」
        path = write_csv(f"{HEADER}\r\n2026-09-22 20:30:00,'25',60,正常\r\n")
        with self.assertRaises(SystemExit) as ctx:
            analysis.load(path)
        message = str(ctx.exception)
        self.assertIn("'25'", message)
        self.assertIn("带引号", message)

    def test_空着的值不算不是数字(self):
        # 空格子是有含义的：算不出状态，会单独记成「(缺失)」。
        # 它和「写了个不能比大小的东西」是两回事，不能一起拦掉。
        path = write_csv(f"{HEADER}\r\n2026-09-22 20:30:00,,60,正常\r\n")
        df = analysis.load(path)
        self.assertEqual(len(df), 1)
        self.assertEqual(analysis.add_rule_status(df)["rule_status"][0], analysis.MISSING)

    def test_小数和负数都是数字(self):
        path = write_csv(f"{HEADER}\r\n2026-09-22 20:30:00,-5.5,27.5,偏冷\r\n")
        df = analysis.load(path)
        self.assertEqual(df["temperature"][0], -5.5)


class TestDescribe(unittest.TestCase):
    def frame(self) -> pd.DataFrame:
        return pd.DataFrame({
            "time": ["2026-09-22 20:30:00", "2026-09-22 20:30:05", "2026-09-22 20:30:10"],
            "temperature": [16.0, 25.0, 31.5],
            "humidity": [60.0, 80.0, 45.0],
            "status": ["偏冷", "偏湿", "偏热"],
        })

    def test_统计值(self):
        stats = analysis.describe(self.frame())
        self.assertEqual(stats["records"], 3)
        self.assertEqual(stats["temp_max"], 31.5)
        self.assertEqual(stats["temp_min"], 16.0)
        self.assertEqual(stats["humidity_max"], 80.0)
        self.assertEqual(stats["humidity_min"], 45.0)

    def test_打印了记录数和极值(self):
        text = capture(analysis.describe, self.frame())
        self.assertIn("记录数：3", text)
        self.assertIn("最高 31.5", text)
        self.assertIn("最低 16", text)          # 16.0 打成 16，不拖一个没用的 .0
        self.assertIn("最高 80", text)
        self.assertIn("最低 45", text)

    def test_空表不炸也不求极值(self):
        empty = self.frame().iloc[0:0]
        stats = analysis.describe(empty)
        self.assertEqual(stats["records"], 0)
        self.assertIsNone(stats["temp_max"])
        self.assertIsNone(stats["humidity_min"])


class TestMain(unittest.TestCase):
    def test_端到端跑一遍(self):
        path = write_csv(
            f"{HEADER}\r\n"
            "2026-09-22 20:30:00,16,60,偏冷\r\n"
            "2026-09-22 20:30:05,31,78,偏热\r\n"
        )
        # 两个 --no-*：跑测试不该往项目里的 report/ 写东西。
        # 画图和出报告本身在 TestPlotTrend / TestWriteReport 里单独测，
        # 那边写的是临时目录。
        text = capture(analysis.main, [str(path), "--no-plot", "--no-report"])

        self.assertIn("前 5 行：", text)
        self.assertIn("记录数：2", text)
        self.assertIn("最高 31", text)
        self.assertNotIn("趋势图：", text)
        self.assertNotIn("报告：", text)

    def test_默认会画图并出报告(self):
        if not analysis.DEFAULT_CSV.is_file():
            self.skipTest("data/dormmate.csv 不存在（演示数据，可以没有）")
        if not HAS_MPL:
            self.skipTest("需要 matplotlib")

        folder = Path(tempfile.mkdtemp())
        trend, report = folder / "trend.png", folder / "report.html"
        # 三个产出路径都要挪走：ML 那份 JSON 不挪的话，跑一次测试就往
        # report/ 里重写一遍（generatedAt 跟着变），仓库里那份就成了「跑过测试的」
        original = (analysis.DEFAULT_TREND, analysis.DEFAULT_REPORT_HTML,
                    analysis.DEFAULT_ML_JSON)
        (analysis.DEFAULT_TREND, analysis.DEFAULT_REPORT_HTML,
         analysis.DEFAULT_ML_JSON) = trend, report, folder / "ml_result.json"
        try:
            text = capture(analysis.main, [str(analysis.DEFAULT_CSV)])
        finally:
            (analysis.DEFAULT_TREND, analysis.DEFAULT_REPORT_HTML,
             analysis.DEFAULT_ML_JSON) = original

        self.assertTrue(trend.is_file())
        self.assertTrue(report.is_file())
        self.assertIn("趋势图：", text)
        self.assertIn("报告：", text)
        # 报告里的图是相对路径，而图就写在它旁边 —— 拷走整个目录不会断图
        self.assertIn('<img src="trend.png"', report.read_text(encoding="utf-8"))

    def test_no_report不写HTML(self):
        folder = Path(tempfile.mkdtemp())
        out = folder / "report.html"
        original = analysis.DEFAULT_REPORT_HTML
        analysis.DEFAULT_REPORT_HTML = out
        try:
            text = capture(analysis.main,
                           [str(analysis.DEFAULT_CSV), "--no-plot", "--no-report"])
        finally:
            analysis.DEFAULT_REPORT_HTML = original

        self.assertFalse(out.exists())
        self.assertIn("跳过 report.html", text)

    def test_默认参数能用(self):
        # 不传参数时用的是 data/dormmate.csv，路径解析成项目根下那个
        parser_default = analysis.resolve_csv(str(analysis.DEFAULT_CSV))
        self.assertEqual(parser_default, analysis.DEFAULT_CSV)

    def test_报告里有ML区块_json也在(self):
        if not (ml.DEFAULT_HISTORY.is_file() and ml.DEFAULT_NEW.is_file()):
            self.skipTest("C 部分那两份文件不在（演示数据，可以没有）")
        if not HAS_SKLEARN:
            self.skipTest("需要 scikit-learn")

        folder = Path(tempfile.mkdtemp())
        report, ml_json = folder / "report.html", folder / "ml_result.json"
        original = analysis.DEFAULT_REPORT_HTML, analysis.DEFAULT_ML_JSON
        analysis.DEFAULT_REPORT_HTML, analysis.DEFAULT_ML_JSON = report, ml_json
        try:
            text = capture(analysis.main, [str(analysis.DEFAULT_CSV), "--no-plot"])
        finally:
            analysis.DEFAULT_REPORT_HTML, analysis.DEFAULT_ML_JSON = original

        html = report.read_text(encoding="utf-8")
        self.assertIn("ML 异常分析", html)
        self.assertIn('class="mismatch"', html)      # 两种口径不一致的那两行亮着

        # 命令行上那句和报告里那句是同一句（算一次、渲染两次）
        self.assertIn("ML 辅助判断", text)
        self.assertIn("ML 结果 JSON：", text)

        data = json.loads(ml_json.read_text(encoding="utf-8"))
        self.assertEqual(data["newRows"], 6)
        self.assertEqual(data["newFile"], ml.DEFAULT_NEW.name)
        self.assertIn(data["text"], text)

    def test_降级时报告照常出(self):
        # 把 C 部分那两份指到不存在的地方：ML 那一段降级成一句话，
        # 报告的其余部分（这一份 CSV 的统计）照常出
        folder = Path(tempfile.mkdtemp())
        report, ml_json = folder / "report.html", folder / "ml_result.json"
        originals = (analysis.DEFAULT_REPORT_HTML, analysis.DEFAULT_ML_JSON,
                     ml.DEFAULT_HISTORY, ml.DEFAULT_NEW)
        analysis.DEFAULT_REPORT_HTML = report
        analysis.DEFAULT_ML_JSON = ml_json
        ml.DEFAULT_HISTORY = folder / "没有这份历史.csv"
        ml.DEFAULT_NEW = folder / "也没有这份新数据.csv"
        try:
            text = capture(analysis.main, [str(analysis.DEFAULT_CSV), "--no-plot"])
        finally:
            (analysis.DEFAULT_REPORT_HTML, analysis.DEFAULT_ML_JSON,
             ml.DEFAULT_HISTORY, ml.DEFAULT_NEW) = originals

        html = report.read_text(encoding="utf-8")
        self.assertIn("这一段没跑", html)
        self.assertIn("记录数", html)                # 报告其余部分照常
        self.assertFalse(ml_json.exists())           # 没算出来就不写这份 JSON
        self.assertIn("ML 辅助判断：这一段没跑", text)

    def test_no_report时ML的json也不写(self):
        folder = Path(tempfile.mkdtemp())
        ml_json = folder / "ml_result.json"
        original = analysis.DEFAULT_ML_JSON
        analysis.DEFAULT_ML_JSON = ml_json
        try:
            text = capture(analysis.main,
                           [str(analysis.DEFAULT_CSV), "--no-plot", "--no-report"])
        finally:
            analysis.DEFAULT_ML_JSON = original

        self.assertFalse(ml_json.exists())
        self.assertIn("ML 辅助判断", text)           # 文字照打，只是不落文件


class TestSampleData(unittest.TestCase):
    """data/dormmate.csv 是给演示用的样例，里面的 status 必须和规则对得上。

    文件不在就跳过 —— 它是演示数据，不是代码，删掉不该让测试挂。
    """

    def setUp(self):
        if not analysis.DEFAULT_CSV.is_file():
            self.skipTest("data/dormmate.csv 不存在（演示数据，可以没有）")
        self.df = analysis.load(analysis.DEFAULT_CSV)

    def test_每一行的status都等于规则算出来的(self):
        for row in self.df.itertuples():
            with self.subTest(time=row.time, temperature=row.temperature):
                self.assertEqual(
                    row.status,
                    rules.judge_status(row.temperature, row.humidity),
                )

    def test_覆盖了四种状态(self):
        self.assertEqual(
            set(self.df["status"]),
            {"偏冷", "偏热", "偏湿", "正常"},
        )


def frame_from(rows: list[tuple]) -> pd.DataFrame:
    """(time, temperature, humidity, status) 的行列表 -> DataFrame。"""
    return pd.DataFrame(
        {
            "time": [row[0] for row in rows],
            "temperature": [row[1] for row in rows],
            "humidity": [row[2] for row in rows],
            "status": [row[3] for row in rows],
        }
    )


class TestAddRuleStatus(unittest.TestCase):
    """rule_status 必须是【重算】出来的，不是把 CSV 的 status 抄一遍。"""

    def test_多了一列rule_status_而且在最后(self):
        out = analysis.add_rule_status(
            frame_from([("t1", 25.0, 60.0, "正常")])
        )
        self.assertIn("rule_status", out.columns)
        self.assertEqual(list(out.columns)[-1], "rule_status")

    def test_不改传进来的df(self):
        original = frame_from([("t1", 25.0, 60.0, "正常")])
        columns_before = list(original.columns)

        analysis.add_rule_status(original)

        self.assertEqual(list(original.columns), columns_before)

    def test_四组回归数据都按规则算(self):
        out = analysis.add_rule_status(
            frame_from([
                ("t1", 25.0, 60.0, "正常"),
                ("t2", 16.0, 60.0, "偏冷"),
                ("t3", 31.0, 60.0, "偏热"),
                ("t4", 25.0, 80.0, "偏湿"),
            ])
        )
        self.assertEqual(list(out["rule_status"]), ["正常", "偏冷", "偏热", "偏湿"])

    def test_31度80湿度算成偏热(self):
        out = analysis.add_rule_status(frame_from([("t1", 31.0, 80.0, "偏湿")]))
        self.assertEqual(out["rule_status"][0], "偏热")

    def test_温湿度缺失标成缺失而不是悄悄算成正常(self):
        # NaN 和任何数比大小都是 False，直接丢给规则会一路走到「正常」，
        # 报告里就成了一条假数据。这条就是盯着这个坑。
        out = analysis.add_rule_status(frame_from([("t1", float("nan"), 60.0, "正常")]))
        self.assertEqual(out["rule_status"][0], analysis.MISSING)
        self.assertNotEqual(out["rule_status"][0], "正常")

    def test_湿度缺失也一样(self):
        out = analysis.add_rule_status(frame_from([("t1", 25.0, float("nan"), "正常")]))
        self.assertEqual(out["rule_status"][0], analysis.MISSING)


class TestFindMismatches(unittest.TestCase):
    def test_一致时返回空列表(self):
        df = analysis.add_rule_status(
            frame_from([("t1", 25.0, 60.0, "正常"), ("t2", 31.0, 78.0, "偏热")])
        )
        self.assertEqual(analysis.find_mismatches(df), [])

    def test_挑出对不上的行_字段一起给出(self):
        df = analysis.add_rule_status(
            frame_from([
                ("2026-09-22 20:30:00", 25.0, 60.0, "正常"),
                ("2026-09-22 20:30:05", 31.0, 80.0, "偏湿"),   # 31/80 该是偏热
            ])
        )
        found = analysis.find_mismatches(df)

        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["time"], "2026-09-22 20:30:05")
        self.assertEqual(found[0]["temperature"], 31.0)
        self.assertEqual(found[0]["humidity"], 80.0)
        self.assertEqual(found[0]["status"], "偏湿")        # CSV 里写的
        self.assertEqual(found[0]["rule_status"], "偏热")   # 规则算的

    def test_status为空的行算不一致(self):
        df = analysis.add_rule_status(frame_from([("t1", 25.0, 60.0, float("nan"))]))
        found = analysis.find_mismatches(df)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["status"], "")            # 不是字符串 "nan"

    def test_缺失温湿度的行算不一致(self):
        df = analysis.add_rule_status(frame_from([("t1", float("nan"), 60.0, "正常")]))
        self.assertEqual(len(analysis.find_mismatches(df)), 1)

    def test_结果可以直接json序列化(self):
        df = analysis.add_rule_status(frame_from([("t1", 31.0, 80.0, "偏湿")]))
        json.dumps(analysis.find_mismatches(df), ensure_ascii=False)   # 不抛异常即可


class TestCountStatuses(unittest.TestCase):
    def test_四种状态都在_没有的是0(self):
        df = analysis.add_rule_status(frame_from([("t1", 25.0, 60.0, "正常")]))
        self.assertEqual(
            analysis.count_statuses(df),
            {"偏冷": 0, "偏热": 0, "偏湿": 0, "正常": 1},
        )

    def test_顺序固定_不按出现次数排(self):
        df = analysis.add_rule_status(
            frame_from([
                ("t1", 25.0, 60.0, "正常"),
                ("t2", 25.0, 60.0, "正常"),
                ("t3", 16.0, 60.0, "偏冷"),
            ])
        )
        counts = analysis.count_statuses(df)
        self.assertEqual(list(counts), analysis.STATUS_ORDER)
        self.assertEqual(list(counts), ["偏冷", "偏热", "偏湿", "正常"])

    def test_统计的是rule_status不是CSV的status(self):
        df = analysis.add_rule_status(frame_from([("t1", 31.0, 80.0, "偏湿")]))
        counts = analysis.count_statuses(df)
        self.assertEqual(counts["偏热"], 1)
        self.assertEqual(counts["偏湿"], 0)

    def test_缺失也单独统计_不悄悄吞掉(self):
        df = analysis.add_rule_status(frame_from([("t1", float("nan"), 60.0, "正常")]))
        self.assertEqual(analysis.count_statuses(df)[analysis.MISSING], 1)

    def test_空表全是0(self):
        df = analysis.add_rule_status(frame_from([]))
        self.assertEqual(set(analysis.count_statuses(df).values()), {0})


class TestFindAttention(unittest.TestCase):
    def test_只留不是正常的(self):
        df = analysis.add_rule_status(
            frame_from([
                ("t1", 25.0, 60.0, "正常"),
                ("t2", 16.0, 60.0, "偏冷"),
                ("t3", 25.0, 80.0, "偏湿"),
            ])
        )
        attention = analysis.find_attention(df)
        self.assertEqual([item["rule_status"] for item in attention], ["偏冷", "偏湿"])
        self.assertEqual([item["time"] for item in attention], ["t2", "t3"])

    def test_全正常时是空列表(self):
        df = analysis.add_rule_status(frame_from([("t1", 25.0, 60.0, "正常")]))
        self.assertEqual(analysis.find_attention(df), [])

    def test_按规则算而不是按CSV的status筛(self):
        # CSV 写着「正常」，但 31/80 按规则是偏热 —— 要进关注列表
        df = analysis.add_rule_status(frame_from([("t1", 31.0, 80.0, "正常")]))
        self.assertEqual(len(analysis.find_attention(df)), 1)


class TestTimeRange(unittest.TestCase):
    """时间范围：格式固定，字典序就是时间序，不用 parse 成 datetime。"""

    def test_取最早和最晚(self):
        df = frame_from([
            ("2026-09-22 20:30:10", 25.0, 60.0, "正常"),
            ("2026-09-22 20:30:00", 25.0, 60.0, "正常"),
            ("2026-09-22 20:30:05", 25.0, 60.0, "正常"),
        ])
        self.assertEqual(
            analysis.time_range(df),
            ("2026-09-22 20:30:00", "2026-09-22 20:30:10"),
        )

    def test_跨天也按时间先后(self):
        df = frame_from([
            ("2026-09-22 23:59:59", 25.0, 60.0, "正常"),
            ("2026-09-23 00:00:01", 25.0, 60.0, "正常"),
        ])
        self.assertEqual(
            analysis.time_range(df),
            ("2026-09-22 23:59:59", "2026-09-23 00:00:01"),
        )

    def test_空单元格不算数(self):
        df = frame_from([
            (float("nan"), 25.0, 60.0, "正常"),
            ("2026-09-22 20:30:05", 25.0, 60.0, "正常"),
        ])
        self.assertEqual(analysis.time_range(df), ("2026-09-22 20:30:05",) * 2)

    def test_没有可用时间时返回两个空串(self):
        self.assertEqual(analysis.time_range(frame_from([])), ("", ""))
        self.assertEqual(
            analysis.time_range(frame_from([(float("nan"), 25.0, 60.0, "正常")])),
            ("", ""),
        )


class TestSummarize(unittest.TestCase):
    def good(self) -> pd.DataFrame:
        return analysis.add_rule_status(
            frame_from([
                ("2026-09-22 20:30:00", 25.0, 60.0, "正常"),
                ("2026-09-22 20:30:05", 16.0, 60.0, "偏冷"),
            ])
        )

    def bad(self) -> pd.DataFrame:
        return analysis.add_rule_status(
            frame_from([
                ("2026-09-22 20:30:00", 25.0, 60.0, "正常"),
                ("2026-09-22 20:30:05", 31.0, 80.0, "偏湿"),   # 规则说是偏热
            ])
        )

    def test_返回的键和顺序(self):
        with redirect_stdout(io.StringIO()):
            summary = analysis.summarize(self.good(), Path("x.csv"))
        self.assertEqual(
            list(summary),
            ["file", "records", "time_first", "time_last",
             "temp_max", "temp_min", "humidity_max", "humidity_min",
             "status_counts", "mismatches", "attention"],
        )

    def test_内容对得上(self):
        with redirect_stdout(io.StringIO()):
            summary = analysis.summarize(self.good(), Path("x.csv"))

        self.assertEqual(summary["file"], "x.csv")
        self.assertEqual(summary["records"], 2)
        self.assertEqual(summary["time_first"], "2026-09-22 20:30:00")
        self.assertEqual(summary["time_last"], "2026-09-22 20:30:05")
        self.assertEqual(summary["temp_max"], 25.0)
        self.assertEqual(summary["temp_min"], 16.0)
        self.assertEqual(summary["humidity_max"], 60.0)
        self.assertEqual(summary["humidity_min"], 60.0)
        self.assertEqual(summary["status_counts"]["正常"], 1)
        self.assertEqual(summary["status_counts"]["偏冷"], 1)
        self.assertEqual(summary["status_counts"]["偏热"], 0)
        self.assertEqual(summary["mismatches"], [])
        self.assertEqual(len(summary["attention"]), 1)

    def test_verbose为假时什么都不打印(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            summary = analysis.summarize(self.good(), Path("x.csv"), verbose=False)
        self.assertEqual(buf.getvalue(), "")
        self.assertEqual(summary["records"], 2)          # 数据照样是全的
        self.assertEqual(summary["status_counts"]["正常"], 1)

    def test_verbose为假时也照样补rule_status(self):
        raw = frame_from([("t1", 31.0, 80.0, "偏湿")])
        with redirect_stdout(io.StringIO()):
            summary = analysis.summarize(raw, verbose=False)
        self.assertEqual(summary["status_counts"]["偏热"], 1)

    def test_整个字典能json序列化(self):
        with redirect_stdout(io.StringIO()):
            summary = analysis.summarize(self.bad(), Path("x.csv"))
        text = json.dumps(summary, ensure_ascii=False)
        self.assertIn("偏热", text)

    def test_不传路径时file是None(self):
        with redirect_stdout(io.StringIO()):
            summary = analysis.summarize(self.good())
        self.assertIsNone(summary["file"])

    def test_没有rule_status列时自己补上(self):
        raw = frame_from([("t1", 31.0, 80.0, "偏湿")])
        with redirect_stdout(io.StringIO()):
            summary = analysis.summarize(raw)          # 故意传没算过的 df
        self.assertEqual(summary["status_counts"]["偏热"], 1)
        self.assertEqual(len(summary["mismatches"]), 1)

    def test_一致时不打警告(self):
        text = capture(analysis.summarize, self.good(), Path("x.csv"))
        self.assertIn("规则复核：2 行的 status 和规则算出来的一致", text)
        self.assertNotIn("警告", text)

    def test_不一致时打警告并点名两个规则文件(self):
        text = capture(analysis.summarize, self.bad(), Path("x.csv"))
        self.assertIn("警告", text)
        self.assertIn("1 / 2 行", text)
        # 警告要能指着人去看哪两个文件
        self.assertIn("shared/rules.js", text)
        self.assertIn("status_rules.py", text)
        self.assertIn("偏湿", text)      # CSV 里写的
        self.assertIn("偏热", text)      # 规则算的

    def test_关注列表里不会有正常(self):
        with redirect_stdout(io.StringIO()):
            summary = analysis.summarize(self.bad(), Path("x.csv"))
        self.assertNotIn("正常", [item["rule_status"] for item in summary["attention"]])

    def test_打印了状态统计和关注条数(self):
        text = capture(analysis.summarize, self.good(), Path("x.csv"))
        self.assertIn("状态统计", text)
        self.assertIn("合计", text)
        self.assertIn("需要关注的记录（rule_status 不是「正常」）：1 条", text)

    def test_全部正常时说没有要关注的(self):
        df = analysis.add_rule_status(frame_from([("t1", 25.0, 60.0, "正常")]))
        text = capture(analysis.summarize, df)
        self.assertIn("需要关注的记录：没有", text)

    def test_空表不炸(self):
        empty = analysis.add_rule_status(frame_from([]))
        text = capture(analysis.summarize, empty)
        self.assertIn("没有数据行", text)

        with redirect_stdout(io.StringIO()):
            summary = analysis.summarize(empty)
        self.assertEqual(summary["records"], 0)
        self.assertIsNone(summary["temp_max"])
        self.assertEqual(set(summary["status_counts"].values()), {0})
        self.assertEqual(summary["attention"], [])

    def test_超过打印上限时提示还剩多少条_但summary里不截断(self):
        rows = [(f"t{i}", 16.0, 60.0, "偏冷") for i in range(analysis.MAX_PRINT + 5)]
        df = analysis.add_rule_status(frame_from(rows))

        text = capture(analysis.summarize, df)

        self.assertIn(f"还有 5 条", text)
        with redirect_stdout(io.StringIO()):
            summary = analysis.summarize(df)
        self.assertEqual(len(summary["attention"]), analysis.MAX_PRINT + 5)


class TestTrendSeries(unittest.TestCase):
    """趋势图的数据整理。纯 python，不碰 matplotlib，所以没装也能测。"""

    def test_按时间升序排(self):
        # CSV 是追加写的，正常按时间；但几份导出拼起来就会乱序，
        # 乱序画出来折线会来回折返，所以这里必须重排。
        series = analysis.trend_series(frame_from([
            ("2026-09-22 20:30:10", 25.0, 60.0, "正常"),
            ("2026-09-22 20:30:00", 16.0, 60.0, "偏冷"),
            ("2026-09-22 20:30:05", 31.0, 78.0, "偏热"),
        ]))
        self.assertEqual(
            [when.strftime(analysis.TIME_FORMAT) for when in series["times"]],
            ["2026-09-22 20:30:00",
             "2026-09-22 20:30:05",
             "2026-09-22 20:30:10"],
        )
        self.assertEqual(series["temperature"], [16.0, 31.0, 25.0])

    def test_温湿度各自一条列表(self):
        series = analysis.trend_series(frame_from([
            ("2026-09-22 20:30:00", 16.0, 60.0, "偏冷"),
            ("2026-09-22 20:30:05", 25.0, 80.0, "偏湿"),
        ]))
        self.assertEqual(series["temperature"], [16.0, 25.0])
        self.assertEqual(series["humidity"], [60.0, 80.0])
        self.assertEqual(series["skipped"], 0)

    def test_时间空的行不画并计入skipped(self):
        series = analysis.trend_series(frame_from([
            ("2026-09-22 20:30:00", 16.0, 60.0, "偏冷"),
            (None, 25.0, 60.0, "正常"),
            ("", 31.0, 60.0, "偏热"),
        ]))
        self.assertEqual(len(series["times"]), 1)
        self.assertEqual(series["skipped"], 2)

    def test_时间格式不对的行也计入skipped(self):
        # 不按统一格式写的时间没法和别的行排到一根轴上，宁可跳过也不猜
        series = analysis.trend_series(frame_from([
            ("2026-09-22 20:30:00", 16.0, 60.0, "偏冷"),
            ("2026/09/22 20:30:05", 25.0, 60.0, "正常"),
            ("20:30:10", 31.0, 60.0, "偏热"),
        ]))
        self.assertEqual(len(series["times"]), 1)
        self.assertEqual(series["skipped"], 2)

    def test_温度空但湿度有值照样画湿度(self):
        series = analysis.trend_series(frame_from([
            ("2026-09-22 20:30:00", None, 60.0, "正常"),
            ("2026-09-22 20:30:05", 16.0, None, "偏冷"),
        ]))
        self.assertEqual(len(series["times"]), 2)
        self.assertTrue(math.isnan(series["temperature"][0]))
        self.assertEqual(series["temperature"][1], 16.0)
        self.assertEqual(series["humidity"][0], 60.0)
        self.assertTrue(math.isnan(series["humidity"][1]))

    def test_缺失用nan而不是None(self):
        # 折线里 None 会报错看不清，nan 才会在那个位置断开
        series = analysis.trend_series(frame_from([
            ("2026-09-22 20:30:00", None, None, "正常"),
        ]))
        for value in series["temperature"] + series["humidity"]:
            self.assertIsInstance(value, float)

    def test_空表返回空列表而不是报错(self):
        series = analysis.trend_series(frame_from([]))
        self.assertEqual(series["times"], [])
        self.assertEqual(series["temperature"], [])
        self.assertEqual(series["skipped"], 0)


class TestDateFormat(unittest.TestCase):
    """横轴标签越短越不容易挤：同一天的只打时分秒，跨天的才补月日。"""

    def test_同一天只打时分秒(self):
        series = analysis.trend_series(frame_from([
            ("2026-09-22 20:30:00", 16.0, 60.0, "偏冷"),
            ("2026-09-22 20:31:00", 16.0, 60.0, "偏冷"),
        ]))
        self.assertEqual(analysis._date_format(series), "%H:%M:%S")

    def test_跨天补上月日(self):
        series = analysis.trend_series(frame_from([
            ("2026-09-22 20:30:00", 16.0, 60.0, "偏冷"),
            ("2026-09-24 20:30:00", 16.0, 60.0, "偏冷"),
        ]))
        self.assertEqual(analysis._date_format(series), "%m-%d %H:%M")

    def test_只有一个点时用时分秒(self):
        series = analysis.trend_series(frame_from([
            ("2026-09-22 20:30:00", 16.0, 60.0, "偏冷"),
        ]))
        self.assertEqual(analysis._date_format(series), "%H:%M:%S")


class TestCjkFontList(unittest.TestCase):
    def test_字体列表就是统一约定的那几个(self):
        self.assertEqual(
            analysis.CJK_FONTS,
            ["Microsoft YaHei", "SimHei", "PingFang SC", "Arial Unicode MS"],
        )

    def test_默认存到report目录下的trendpng(self):
        self.assertEqual(analysis.DEFAULT_TREND.name, "trend.png")
        self.assertEqual(analysis.DEFAULT_TREND.parent.name, "report")


@unittest.skipUnless(HAS_MPL, "需要 matplotlib")
class TestPlotTrend(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp())
        self.rows = [
            ("2026-09-22 20:30:00", 16.0, 60.0, "偏冷"),
            ("2026-09-22 20:30:05", 25.0, 60.0, "正常"),
            ("2026-09-22 20:30:10", 31.0, 78.0, "偏热"),
            ("2026-09-22 20:30:15", 25.0, 80.0, "偏湿"),
        ]

    def test_写出一个真的png(self):
        out = self.folder / "t.png"
        self.assertEqual(analysis.plot_trend(frame_from(self.rows), out, verbose=False), out)
        self.assertTrue(out.is_file())
        # 不只看文件在不在：确认真的是 PNG，不是一段报错文本
        self.assertEqual(out.read_bytes()[:8], PNG_MAGIC)

    def test_目录不存在会自动建(self):
        out = self.folder / "深" / "几层" / "t.png"
        analysis.plot_trend(frame_from(self.rows), out, verbose=False)
        self.assertTrue(out.is_file())

    def test_空表也出一张图(self):
        # 报告里引用的图片路径不该时有时无
        out = self.folder / "t.png"
        analysis.plot_trend(frame_from([]), out, verbose=False)
        self.assertEqual(out.read_bytes()[:8], PNG_MAGIC)

    def test_全是空值的行也能出图(self):
        out = self.folder / "t.png"
        analysis.plot_trend(
            frame_from([("2026-09-22 20:30:00", None, None, "正常")]),
            out,
            verbose=False,
        )
        self.assertEqual(out.read_bytes()[:8], PNG_MAGIC)

    def test_设了中文字体并关掉负号方块(self):
        analysis.plot_trend(frame_from(self.rows), self.folder / "t.png", verbose=False)
        plt = analysis._pyplot()
        self.assertEqual(list(plt.rcParams["font.sans-serif"])[:4], analysis.CJK_FONTS)
        self.assertFalse(plt.rcParams["axes.unicode_minus"])

    def test_画完不留下没关掉的figure(self):
        # 反复画图不 close 会一直堆在内存里，几十次之后脚本会越来越慢
        plt = analysis._pyplot()
        for index in range(3):
            analysis.plot_trend(frame_from(self.rows), self.folder / f"t{index}.png",
                                verbose=False)
        self.assertEqual(plt.get_fignums(), [])

    def test_verbose为假时一个字都不打印(self):
        text = capture(analysis.plot_trend, frame_from(self.rows),
                       self.folder / "t.png", verbose=False)
        self.assertEqual(text, "")

    def test_打印里点名字体和点数(self):
        text = capture(analysis.plot_trend, frame_from(self.rows),
                       self.folder / "t.png")
        self.assertIn("趋势图：", text)
        self.assertIn("4 个点", text)
        self.assertIn("中文字体：", text)

    def test_没找到中文字体时打警告(self):
        # 换台没装中文字体的机器（比如 Linux CI）跑，得说清楚为什么是方块，
        # 而不是让人对着图猜。
        # 这一只是故意用不存在的字体画的：matplotlib 会为每个缺字的文本往
        # stderr 刷一行 findfont 警告、再抛一串 Glyph missing。把日志压到
        # ERROR、warning 收起来，别让几十行噪音盖住真正的测试输出。
        quiet = logging.getLogger("matplotlib.font_manager")
        level = quiet.level
        original = analysis.CJK_FONTS
        quiet.setLevel(logging.ERROR)
        analysis.CJK_FONTS = ["绝对不存在的字体"]
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                text = capture(analysis.plot_trend, frame_from(self.rows),
                               self.folder / "t.png")
        finally:
            analysis.CJK_FONTS = original
            quiet.setLevel(level)
        self.assertIn("警告", text)

    def test_只有一个点时横轴自己撑开不报警(self):
        # 所有点时间相同（只有一行数据）时横轴跨度是 0，AutoDateLocator 挑不出
        # 刻度间隔，每画一次就刷一串警告。撑成 60 秒的窗口才行。
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            analysis.plot_trend(frame_from([self.rows[0]]), self.folder / "t.png",
                                verbose=False)
        noisy = [str(item.message) for item in caught
                 if "AutoDateLocator" in str(item.message)]
        self.assertEqual(noisy, [])

    def test_温湿度有点是空的时候打出来(self):
        text = capture(analysis.plot_trend,
                       frame_from([("2026-09-22 20:30:00", None, 60.0, "正常")]),
                       self.folder / "t.png")
        self.assertIn("温度有 1 个点是空的", text)

    def test_时间跳过的行数会打出来(self):
        text = capture(analysis.plot_trend,
                       frame_from([
                           ("2026-09-22 20:30:00", 16.0, 60.0, "偏冷"),
                           ("昨天下午", 25.0, 60.0, "正常"),
                       ]),
                       self.folder / "t.png")
        self.assertIn("1 行的时间是空的", text)


def summary_from(rows: list[tuple], path: Path | None = None) -> dict:
    """行列表 -> summarize() 的返回（不打印）。报告那几只测试都用它。"""
    return analysis.summarize(frame_from(rows), path, verbose=False)


# 三行：一冷一正常一热。关注 2 条，规则复核通过。
REPORT_ROWS = [
    ("2026-09-22 20:30:00", 16.0, 60.0, "偏冷"),
    ("2026-09-22 20:30:05", 25.0, 60.0, "正常"),
    ("2026-09-22 20:30:10", 31.0, 78.0, "偏热"),
]
STAMP = "2026-01-02 03:04:05"


# ------------------------------------------------------ ML 区块（Step 9-3）的桩

# 四条对照行，四种组合各占一条：
#   25/60 两边都说正常 · 26/62 规则说正常而 ML 说不同（题目要找的）
#   31/60 两边都说异常 · 17/60 规则说异常而 ML 说接近常态（反过来的那一种）
# 行本身用 ml.py 里那两个【真】函数造 —— 手抄一份字典的话，键名和分数位数
# 迟早和 run_ml() 给的对不上，而那时候测试还是绿的。
ML_RECORDS = [
    ("dorm-a", "2026-09-23 11:20:00", 25.0, 60.0, "正常"),
    ("dorm-a", "2026-09-23 11:25:00", 26.0, 62.0, "正常"),
    ("dorm-a", "2026-09-23 11:30:00", 31.0, 60.0, "偏热"),
    ("dorm-a", "2026-09-23 11:35:00", 17.0, 60.0, "偏冷"),
]
ML_LABELS = [ml.ML_INLIER, ml.ML_OUTLIER, ml.ML_OUTLIER, ml.ML_INLIER]
ML_SCORES = [0.0347, -0.0564, -0.1230, 0.0120]


def ml_rows(records=None, labels=None, scores=None) -> list[dict]:
    return ml.compare_rows(ML_RECORDS if records is None else records,
                           ML_LABELS if labels is None else labels,
                           ML_SCORES if scores is None else scores)


def ml_result(rows=None, history_rows: int = 40, history_flagged: int = 18,
              history_file: str = "/tmp/ml/dorm-a_history_sim.csv",
              new_file: str = "/tmp/ml/new_samples.csv") -> dict:
    """ml.run_ml() 返回的那个字典。真跑一次要 sklearn，纯渲染的测试不必等它。

    两个路径是【全路径】而不是文件名：报告那一段要把名字截出来（不截的话
    报告里会印出本机目录），这一层桩就把真实形状给上，免得那个截断没人测。
    """
    rows = ml_rows() if rows is None else rows
    return {
        "history_file": history_file,
        "new_file": new_file,
        "history_rows": history_rows,
        "new_rows": len(rows),
        "history_flagged": history_flagged,
        "features": list(ml.FEATURES),
        "params": dict(ml.MODEL_PARAMS),
        "threshold": ml.ML_THRESHOLD,
        "rows": rows,
        "mismatches": ml.find_mismatches(rows),
        "reverse": ml.find_reverse(rows),
        "text": ml.render_comparison(rows),
    }


class TestEsc(unittest.TestCase):
    """要插进 HTML 的文本一律转义 —— summary 里的字符串全都来自 CSV。"""

    def test_尖括号被转义(self):
        self.assertEqual(
            analysis._esc("<script>alert(1)</script>"),
            "&lt;script&gt;alert(1)&lt;/script&gt;",
        )

    def test_引号和与号被转义(self):
        self.assertEqual(analysis._esc('a"b&c'), "a&quot;b&amp;c")

    def test_None打成破折号而不是None(self):
        self.assertEqual(analysis._esc(None), "—")

    def test_数字也能进来(self):
        self.assertEqual(analysis._esc(31.0), "31.0")


class TestFormatHelpers(unittest.TestCase):
    """占比和范围只有一份实现，Markdown 报告和 HTML 报告共用。"""

    def test_占比一位小数(self):
        self.assertEqual(analysis.format_percent(1, 4), "25.0%")
        self.assertEqual(analysis.format_percent(1, 3), "33.3%")

    def test_没有记录时给破折号而不是nan(self):
        self.assertEqual(analysis.format_percent(0, 0), "—")

    def test_范围首尾相同只打一个(self):
        summary = {"time_first": "2026-09-22 20:30:00",
                   "time_last": "2026-09-22 20:30:00"}
        self.assertEqual(analysis.format_range(summary), "2026-09-22 20:30:00")

    def test_范围两头都在(self):
        summary = {"time_first": "2026-09-22 20:30:00",
                   "time_last": "2026-09-22 20:30:55"}
        self.assertEqual(analysis.format_range(summary),
                         "2026-09-22 20:30:00 ~ 2026-09-22 20:30:55")

    def test_范围空的时候给一句人话(self):
        self.assertEqual(analysis.format_range({"time_first": "", "time_last": ""}),
                         "（没有记录）")


class TestHtmlTable(unittest.TestCase):
    def test_表头和数据都在(self):
        text = analysis._html_table(["时间", "状态"], [["t1", "偏冷"]])
        self.assertIn("<th>时间</th>", text)
        self.assertIn("<td>偏冷</td>", text)
        self.assertTrue(text.startswith("<table>"))
        self.assertTrue(text.endswith("</table>"))

    def test_右对齐列是数字列(self):
        text = analysis._html_table(["a", "b"], [["x", "1"]], right=(1,))
        self.assertIn('<th class="num">b</th>', text)
        self.assertIn('<td class="num">1</td>', text)

    def test_空表给占位并跨满整行(self):
        text = analysis._html_table(["a", "b", "c"], [])
        self.assertIn('colspan="3"', text)
        self.assertIn("（没有记录）", text)

    def test_单元格里的尖括号被转义(self):
        text = analysis._html_table(["h"], [["<b>粗</b>"]])
        self.assertNotIn("<b>", text)
        self.assertIn("&lt;b&gt;", text)

    def tbody(self, text: str) -> str:
        """只要数据行那一段 —— <thead><tr> 也含一个 "<tr>"，一起数会多一个。"""
        return text[text.index("<tbody>"):]

    def test_不给row_classes时行上没有class(self):
        # 老的那几个调用方都没给这个参数。默认空串 = 不加 class，
        # 而不是「长度对不上就抛」—— 后者会把每一个老调用方都弄挂。
        text = analysis._html_table(["a", "b"], [["x", "1"], ["y", "2"]])
        body = self.tbody(text)
        self.assertNotIn("<tr class", body)
        self.assertEqual(body.count("<tr>"), 2)     # 两行都是光秃秃的 <tr>

    def test_row_classes按行加上去(self):
        text = analysis._html_table(["a", "b"], [["x", "1"], ["y", "2"], ["z", "3"]],
                                    row_classes=["warn", "", "warn"])
        body = self.tbody(text)
        self.assertEqual(body.count('<tr class="warn">'), 2)
        self.assertEqual(body.count("<tr>"), 1)     # 中间那行还是不加

    def test_空串就是不加class(self):
        body = self.tbody(analysis._html_table(["a"], [["x"]], row_classes=[""]))
        self.assertIn("<tr>", body)
        self.assertNotIn('class=""', body)          # 别留一个空 class 属性

    def test_row_classes个数对不上就抛(self):
        # 少给几个的话高亮会落在别的行上，而那种错看报告时根本看不出来
        with self.assertRaises(ValueError):
            analysis._html_table(["a"], [["x"], ["y"]], row_classes=["warn"])
        with self.assertRaises(ValueError):
            analysis._html_table(["a"], [["x"]], row_classes=["a", "b"])


class TestTableSection(unittest.TestCase):
    """给后面「事件复盘 / 今日摘要 / ML 异常分析」预留的拼装方式。"""

    def test_就是标题加一张表(self):
        item = analysis.table_section("事件复盘", ["时间", "事件"],
                                     [["2026-09-22 20:30", "开门"]])
        self.assertEqual(sorted(item), ["html", "title"])
        self.assertEqual(item["title"], "事件复盘")
        self.assertIn("<table>", item["html"])
        self.assertIn("开门", item["html"])

    def test_表头和数据里的尖括号都被转义(self):
        item = analysis.table_section("<b>标题</b>", ["<i>h</i>"], [["<u>x</u>"]])
        self.assertNotIn("<i>", item["html"])
        self.assertNotIn("<u>", item["html"])


class TestBuildReport(unittest.TestCase):
    def setUp(self):
        self.summary = summary_from(REPORT_ROWS, Path("data/dormmate.csv"))
        self.html = analysis.build_report(self.summary, generated_at=STAMP)

    def test_是一份完整的HTML文档(self):
        self.assertTrue(self.html.startswith("<!DOCTYPE html>"))
        self.assertIn('<html lang="zh-CN">', self.html)
        self.assertIn('<meta charset="utf-8">', self.html)
        self.assertTrue(self.html.rstrip().endswith("</html>"))

    def test_抬头有生成时间数据来源和范围(self):
        self.assertIn(f"生成时间：{STAMP}", self.html)
        self.assertIn("dormmate.csv", self.html)          # 文件名
        self.assertIn("data", self.html)                  # 完整路径也留着
        self.assertIn("2026-09-22 20:30:00 ~ 2026-09-22 20:30:10", self.html)

    def test_生成时间不传就用当前时间(self):
        html = analysis.build_report(self.summary)
        self.assertIn(datetime.now().strftime("%Y-%m-%d %H:%M"), html)

    def test_摘要的数字全部来自summary(self):
        for text in ("31", "16", "78", "60"):
            with self.subTest(value=text):
                self.assertIn(text, self.html)
        # 记录数在卡片里，跟着数据走
        self.assertIn('记录数</span><span class="value">3 ', self.html)

    def test_数据换了报告里的数字跟着换(self):
        other = analysis.build_report(
            summary_from([("2026-09-22 21:00:00", 20.0, 50.0, "正常")]),
            generated_at=STAMP,
        )
        self.assertIn('记录数</span><span class="value">1 ', other)
        self.assertNotIn(">31<", other)     # 上一份里的温度最高值不该出现
        self.assertIn("20", other)

    def test_各状态的条数和占比(self):
        # 3 条里每种出现的状态各 1 条 = 33.3%，没出现的偏湿是 0 条。
        # 只数单元格里的 ">33.3%<"：同一个数字在分布条的 style="width:33.3%"
        # 里还会出现一次，直接数 "33.3%" 会数出双份。
        self.assertEqual(self.html.count(">33.3%<"), 3)
        self.assertIn('<td class="num">0</td>', self.html)
        self.assertIn("0.0%", self.html)
        self.assertIn("合计", self.html)
        self.assertIn("100.0%", self.html)

    def test_占比跟着条数变(self):
        # 4 条里 3 条偏冷 = 75.0%，不是写死的 25%
        html = analysis.build_report(summary_from([
            ("2026-09-22 20:30:00", 16.0, 60.0, "偏冷"),
            ("2026-09-22 20:30:05", 17.0, 60.0, "偏冷"),
            ("2026-09-22 20:30:10", 16.5, 60.0, "偏冷"),
            ("2026-09-22 20:30:15", 25.0, 60.0, "正常"),
        ]), generated_at=STAMP)
        self.assertIn("75.0%", html)
        self.assertIn("25.0%", html)

    def test_关注表格只列不是正常的(self):
        self.assertIn("20:30:00", self.html)      # 偏冷，要列
        self.assertIn("20:30:10", self.html)      # 偏热，要列
        self.assertNotIn("20:30:05", self.html)   # 正常，不该出现
        self.assertIn("共 2 条", self.html)

    def test_没有要关注的记录时说清楚(self):
        html = analysis.build_report(
            summary_from([("2026-09-22 20:30:00", 25.0, 60.0, "正常")]),
            generated_at=STAMP,
        )
        self.assertIn("没有，全部是「正常」", html)
        self.assertIn("共 0 条", html)

    def test_趋势图用相对路径(self):
        # 报告要能整个 report/ 目录拷走，绝对路径到别人机器上就是断图
        self.assertIn('<img src="trend.png"', self.html)

    def test_图不在时给一句占位而不是断图(self):
        folder = Path(tempfile.mkdtemp())
        html = analysis.build_report(self.summary, generated_at=STAMP,
                                     trend_path=folder / "不存在.png")
        self.assertNotIn("<img", html)
        self.assertIn("没有 trend.png", html)

    def test_图在旁边时就是img(self):
        folder = Path(tempfile.mkdtemp())
        (folder / analysis.TREND_FILE).write_bytes(PNG_MAGIC)
        html = analysis.build_report(self.summary, generated_at=STAMP,
                                     trend_path=folder / analysis.TREND_FILE)
        self.assertIn('<img src="trend.png"', html)

    def test_规则不一致时最上面有横幅(self):
        # 31/80 按规则是偏热，CSV 里写成偏湿 —— 规则没同步
        html = analysis.build_report(summary_from([
            ("2026-09-22 20:30:00", 31.0, 80.0, "偏湿"),
        ]), generated_at=STAMP)
        self.assertIn("规则复核没通过", html)
        self.assertIn("shared/rules.js", html)
        self.assertIn("status_rules.py", html)

    def test_规则一致时没有横幅(self):
        self.assertNotIn("规则复核没通过", self.html)

    def test_空数据也能出一份报告(self):
        html = analysis.build_report(summary_from([]), generated_at=STAMP)
        self.assertIn("（没有记录）", html)
        self.assertNotIn("nan%", html)
        self.assertNotIn("None", html)       # 极值是 None，要打成「—」

    def test_不改传进来的summary(self):
        before = json.dumps(self.summary, ensure_ascii=False, sort_keys=True)
        analysis.build_report(self.summary, [analysis.table_section("x", ["a"], [["1"]])],
                              generated_at=STAMP)
        self.assertEqual(
            json.dumps(self.summary, ensure_ascii=False, sort_keys=True), before)

    def test_额外区块按顺序接在趋势图后面(self):
        html = analysis.build_report(self.summary, [
            analysis.table_section("事件复盘", ["时间", "事件"], [["20:30", "开门"]]),
            {"title": "今日摘要", "html": "<p>一句话</p>"},
        ], generated_at=STAMP)
        self.assertLess(html.index("趋势图"), html.index("事件复盘"))
        self.assertLess(html.index("事件复盘"), html.index("今日摘要"))
        self.assertIn("<p>一句话</p>", html)

    def test_区块标题被转义而内容是原样插入的(self):
        # title 是纯文本（转义），html 是我们自己拼的（原样）
        html = analysis.build_report(
            self.summary,
            [{"title": "<b>标题</b>", "html": "<p class='x'>正文</p>"}],
            generated_at=STAMP,
        )
        self.assertIn("&lt;b&gt;标题&lt;/b&gt;", html)
        self.assertIn("<p class='x'>正文</p>", html)

    def test_没有额外区块时不凭空多出东西(self):
        self.assertEqual(self.html.count("<section>"), 3)

    def test_CSV里的怪值不会撑破页面(self):
        html = analysis.build_report(summary_from([
            ("<script>alert(1)</script>", 31.0, 80.0, "偏湿"),
        ]), generated_at=STAMP)
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)


class TestWriteReport(unittest.TestCase):
    def setUp(self):
        self.summary = summary_from(REPORT_ROWS)
        self.folder = Path(tempfile.mkdtemp())

    def test_目录不存在会自动建(self):
        out = self.folder / "深" / "几层" / "report.html"
        self.assertEqual(analysis.write_report(self.summary, out, generated_at=STAMP), out)
        self.assertTrue(out.is_file())

    def test_写出来的内容和build_report一致(self):
        out = self.folder / "report.html"
        analysis.write_report(self.summary, out, generated_at=STAMP)
        # 趋势图那处要对齐：write_report 找的是【报告旁边】那张图，
        # 所以比对时也得把 trend_path 指到同一个临时目录，不然比的是两份
        # 不同的东西（一个 <img>、一个占位）
        self.assertEqual(
            out.read_text(encoding="utf-8"),
            analysis.build_report(self.summary, generated_at=STAMP,
                                  trend_path=self.folder / analysis.TREND_FILE),
        )

    def test_是LF换行不是CRLF(self):
        out = self.folder / "report.html"
        analysis.write_report(self.summary, out, generated_at=STAMP)
        self.assertNotIn(b"\r\n", out.read_bytes())

    def test_是UTF8不带BOM(self):
        out = self.folder / "report.html"
        analysis.write_report(self.summary, out, generated_at=STAMP)
        raw = out.read_bytes()
        self.assertFalse(raw.startswith(BOM.encode("utf-8")))
        self.assertIn("宿舍环境报告", raw.decode("utf-8"))

    def test_默认路径和趋势图在同一个目录(self):
        self.assertEqual(analysis.DEFAULT_REPORT_HTML.name, "report.html")
        self.assertEqual(analysis.DEFAULT_REPORT_HTML.parent,
                         analysis.DEFAULT_TREND.parent)

    def test_按报告所在目录找趋势图(self):
        # 图应该找在报告旁边那一张，不是项目里那张
        out = self.folder / "report.html"
        analysis.write_report(self.summary, out, generated_at=STAMP)
        self.assertIn("没有 trend.png", out.read_text(encoding="utf-8"))


class TestPrintHelpers(unittest.TestCase):
    """表格是按显示宽度补空格的：中文算 2 列，否则终端里表格是歪的。"""

    def test_中文按两列算(self):
        self.assertEqual(analysis._width("偏冷"), 4)
        self.assertEqual(analysis._width("abc"), 3)
        self.assertEqual(analysis._width("a偏"), 3)

    def test_补空格按显示宽度(self):
        self.assertEqual(analysis._width(analysis._pad("偏冷", 6)), 6)
        self.assertEqual(analysis._width(analysis._rpad("3", 6)), 6)

    def test_右对齐是往左边补(self):
        self.assertEqual(analysis._rpad("3", 4), "   3")

    def test_列宽取最宽的那个(self):
        rows = [["状态", "条数"], ["偏冷", "3"]]
        self.assertEqual(analysis._widths(rows), [4, 4])

    def test_数字格式化(self):
        self.assertEqual(analysis._num(31.0), "31")      # 不拖没用的 .0
        self.assertEqual(analysis._num(25.5), "25.5")
        self.assertEqual(analysis._num(None), "—")       # 缺失不打印 "None"

    def test_空单元格转成空串而不是nan(self):
        self.assertEqual(analysis._clean(float("nan")), "")
        self.assertEqual(analysis._clean("  偏热  "), "偏热")


class TestMlSection(unittest.TestCase):
    """「ML 异常分析」区块（Step 9-3）。

    行不是手抄的字典，是 ml.compare_rows() 照着桩数据算出来的 —— 键名、布尔值、
    分数位数都跟 run_ml() 给的一样，测试不会因为抄错一个下划线而空转。
    """

    def section(self, result=None) -> dict:
        return analysis.ml_section(ml_result() if result is None else result)

    def html(self, result=None) -> str:
        return self.section(result)["html"]

    def rows_of(self, html: str) -> list[tuple]:
        """[(温度那一格, 有没有高亮), ...]，按表里的顺序。

        只数「有两行带 class」是不够的：高亮错了行也照样是两行 ——
        而看报告的人只会照着亮的看。
        """
        out = []
        for chunk in html[html.index("<tbody>"):].split("<tr")[1:]:
            marked = chunk.startswith(f' class="{analysis.MISMATCH_CLASS}"')
            cell = re.search(r'<td class="num">([^<]*)</td>', chunk)
            out.append((cell.group(1), marked))
        return out

    def test_标题就是ML异常分析(self):
        self.assertEqual(self.section()["title"], "ML 异常分析")
        self.assertEqual(analysis.ML_TITLE, "ML 异常分析")

    def test_表头就是需求给的那六列(self):
        self.assertEqual(analysis.ML_HEADER,
                         ["宿舍", "温度 ℃", "湿度 %", "固定规则", "ML 判断", "分数"])

    def test_六列按这个顺序排(self):
        # 顺序也钉住：这张表并排看的就是「规则怎么说 / ML 怎么说」，换个位置就说不通了。
        # 从 <table> 往后找：上面那段说明里也有「固定规则」这几个字（是 <strong>，
        # 不是表头），在整篇里找的话会先撞上它。
        table = self.html()
        table = table[table.index("<table>"):]
        places = [table.index(f">{name}<") for name in analysis.ML_HEADER]
        self.assertEqual(places, sorted(places))

    def test_训练数据的来源和条数写出来了(self):
        html = self.html()
        self.assertIn("模拟历史", html)
        self.assertIn("dorm-a_history_sim.csv", html)
        # 连着说，而不是只找「40 条」：下面那句门槛松紧里也有「40 条历史」，
        # 光找数字的话，这儿的 40 换成 4 也照样能过
        self.assertIn("模拟历史，共 40 条", html)

    def test_待判断数据的来源和条数写出来了(self):
        html = self.html()
        self.assertIn("待判断数据", html)
        self.assertIn("new_samples.csv", html)
        # 同理连着说：结论那句「4 条新数据里…」里有「4 条」，只找它就白测了
        self.assertIn("new_samples.csv（4 条）", html)

    def test_不印本机的全路径(self):
        # 桩里给的是 /tmp/ml/... 全路径，报告里只该出现文件名
        html = self.html()
        self.assertNotIn("/tmp", html)

    def test_说了这一段判的不是本报告上面那份CSV(self):
        html = self.html()
        self.assertIn("不是本报告上面那份 CSV", html)
        self.assertIn("C 部分", html)

    def test_那几句说明在(self):
        html = self.html()
        self.assertIn("提前写好的三条阈值", html)
        self.assertIn("和这个宿舍平时像不像", html)
        self.assertIn("ML 只作为辅助判断", html)

    def cells(self, chunk: str) -> list[str]:
        """一段 <tr> 里的每一格（按顺序）。"""
        return re.findall(r"<td[^>]*>(.*?)</td>", chunk, re.S)

    def test_两种口径各说各的(self):
        # 26/62 那一条：固定规则那格是「正常」、ML 那格是「与历史明显不同」。
        # 两列对调的话，这张表就成了「固定规则说与历史明显不同」—— 意思全反了，
        # 而两句话都还在表里，只数「有没有出现」是看不出来的。
        html = self.html()
        chunk = [c for c in html[html.index("<tbody>"):].split("<tr")[1:]
                 if f'class="{analysis.MISMATCH_CLASS}"' in c][0]
        self.assertEqual(self.cells(chunk),
                         ["dorm-a", "26", "62", "正常", "与历史明显不同", "-0.0564"])

    def test_结论那句话里的尖括号也转义(self):
        # 那句结论是 ml.render_comparison() 拼的，里面带着从 CSV 读来的时刻 ——
        # CSV 是外面进来的东西，它不算「自己人写的字符串」。
        # 时刻凑成 16 个字以上：ml._brief 取的是 [11:16]，那副尖括号正好落在里面。
        rows = ml_rows([("dorm-a", "2026-09-23 <b>x  ", 26.0, 62.0, "正常")],
                       [ml.ML_OUTLIER], [-0.06])
        html = self.html(ml_result(rows))
        self.assertNotIn("<b>", html)
        self.assertIn("&lt;b&gt;", html)

    def test_结论就是命令行上那一句(self):
        result = ml_result()
        self.assertIn(analysis._esc(result["text"]), self.html(result))
        # 而且那句话是 ml.render_comparison() 算的，不是这儿另写一句
        self.assertIn("规则判断为正常、ML 认为与历史明显不同的有", self.html(result))

    def test_门槛松紧跟着结果走(self):
        html = self.html(ml_result(history_rows=40, history_flagged=18))
        self.assertIn("40 条历史", html)
        self.assertIn("18 条也会被判", html)

        other = self.html(ml_result(history_rows=8, history_flagged=3))
        self.assertIn("8 条历史", other)
        self.assertIn("3 条也会被判", other)
        self.assertNotIn("18 条", other)

    def test_高亮的就是两边不一致的那两条(self):
        # 26/62：规则说正常、ML 说与历史明显不同（题目要找的那一种）
        # 17/60：反过来的那一种（越过了 18 ℃ 那条线，但这条线在历史里常见）
        # 25/60 和 31/60：两边说的一样，不该亮
        self.assertEqual(self.rows_of(self.html()),
                         [("25", False), ("26", True), ("31", False), ("17", True)])

    def test_读数按数值格式打(self):
        html = self.html()
        self.assertIn('<td class="num">25</td>', html)        # 不是 25.0
        self.assertIn('<td class="num">-0.0564</td>', html)   # 分数保留四位

    def test_分数正好是整数时不拖点0(self):
        # 桩里那几条分数都是小数，0 这种才分得出「过了一道 _num」和「直接打出来」
        rows = ml_rows([("dorm-a", "2026-09-23 11:20:00", 25.0, 60.0, "正常")],
                       [ml.ML_OUTLIER], [0.0])
        self.assertIn('<td class="num">0</td>', self.html(ml_result(rows)))

    def test_没有nodeId的行给破折号(self):
        rows = ml_rows([("", "2026-09-23 11:20:00", 25.0, 60.0, "正常")],
                       [ml.ML_INLIER], [0.031])
        self.assertIn("<td>—</td>", self.html(ml_result(rows)))

    def test_没有新数据时不摆空表(self):
        html = self.html(ml_result(rows=[]))
        self.assertIn(ml.NO_ROWS_TEXT, html)
        self.assertNotIn("<table>", html)

    def test_nodeId里的尖括号被转义(self):
        rows = ml_rows([("dorm-<script>", "2026-09-23 11:20:00", 25.0, 60.0, "正常")],
                       [ml.ML_INLIER], [0.03])
        html = self.html(ml_result(rows))
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)


class TestMlSkipSection(unittest.TestCase):
    """ML 那一段跑不起来时的降级区块。"""

    def test_照实说原因并说报告不受影响(self):
        item = analysis.ml_skip_section("找不到 CSV：data/new_samples.csv")
        self.assertEqual(item["title"], "ML 异常分析")
        self.assertIn("这一段没跑", item["html"])
        self.assertIn("找不到 CSV", item["html"])
        self.assertIn("报告其余部分不受影响", item["html"])

    def test_原因里的尖括号被转义(self):
        html = analysis.ml_skip_section("<b>坏的</b>")["html"]
        self.assertNotIn("<b>", html)
        self.assertIn("&lt;b&gt;", html)


class TestMlResultJson(unittest.TestCase):
    """report/ml_result.json —— 给看板 fetch 的那份（Step 9-3 的进阶项）。"""

    def setUp(self):
        self.folder = Path(tempfile.mkdtemp())
        self.result = ml_result()

    def data(self, result=None) -> dict:
        return analysis.ml_result_json(ml_result() if result is None else result, STAMP)

    def test_键名跟看板那份统一JSON一个约定(self):
        row = self.data()["rows"][0]
        self.assertEqual(row["nodeId"], "dorm-a")
        self.assertEqual(row["time"], "2026-09-23 11:20:00")
        for key in ("nodeId", "time", "temperature", "humidity",
                    "ruleStatus", "mlStatus", "score", "mismatch"):
            self.assertIn(key, row)

    def test_两个口径各自的说法都在行上(self):
        row = self.data()["rows"][1]        # 26/62 那一条
        self.assertEqual(row["ruleStatus"], "正常")
        self.assertEqual(row["mlStatus"], ml.ML_OUTLIER_TEXT)
        self.assertTrue(row["mismatch"])
        self.assertFalse(self.data()["rows"][0]["mismatch"])

    def test_只留文件名不留本机路径(self):
        data = self.data()
        self.assertEqual(data["historyFile"], "dorm-a_history_sim.csv")
        self.assertEqual(data["newFile"], "new_samples.csv")
        # 这份是要提交进仓库的：整份里都不该出现本机目录
        raw = json.dumps(data, ensure_ascii=False)
        self.assertNotIn("/tmp", raw)
        self.assertNotIn(":", data["newFile"])      # 盘符或目录都会带冒号

    def test_温湿度写成整数不写25点0(self):
        row = self.data()["rows"][0]
        self.assertEqual(row["temperature"], 25)
        self.assertIsInstance(row["temperature"], int)

    def test_该是小数的地方还是小数(self):
        rows = ml_rows([("dorm-a", "2026-09-23 11:20:00", 25.5, 60.5, "正常")],
                       [ml.ML_INLIER], [0.25])
        row = self.data(ml_result(rows))["rows"][0]
        self.assertEqual(row["temperature"], 25.5)
        self.assertEqual(row["humidity"], 60.5)

    def test_分数保留四位(self):
        self.assertEqual(self.data()["rows"][0]["score"], 0.0347)

    def test_三个不一致的计数分开放(self):
        data = self.data()
        self.assertEqual(data["mismatchForward"], 1)    # 规则说正常、ML 说不同
        self.assertEqual(data["mismatchReverse"], 1)    # 反过来那一种
        self.assertEqual(data["mismatchTotal"], 2)      # 和 text 里那句对得上
        self.assertIn("不一致的有 2 条", data["text"])

    def test_正向反向的数分开报(self):
        # 上面那个桩正反各一条，是对称的 —— 两个数对调了也照样绿。
        # 这里来一个不对称的：正向 2 条、反向 1 条，三个数就各不相同了。
        rows = ml_rows(
            [("dorm-a", "2026-09-23 11:20:00", 25.0, 60.0, "正常"),
             ("dorm-a", "2026-09-23 11:25:00", 26.0, 62.0, "正常"),
             ("dorm-a", "2026-09-23 11:30:00", 31.0, 60.0, "偏热")],
            [ml.ML_OUTLIER, ml.ML_OUTLIER, ml.ML_INLIER],
            [-0.06, -0.05, 0.02])
        data = self.data(ml_result(rows))
        self.assertEqual(data["mismatchForward"], 2)
        self.assertEqual(data["mismatchReverse"], 1)
        self.assertEqual(data["mismatchTotal"], 3)

    def test_参数门槛和条数都跟着走(self):
        data = self.data()
        self.assertEqual(data["params"], ml.MODEL_PARAMS)
        self.assertEqual(data["threshold"], ml.ML_THRESHOLD)
        self.assertEqual(data["historyRows"], 40)
        self.assertEqual(data["newRows"], 4)
        self.assertEqual(data["historyFlagged"], 18)
        self.assertEqual(data["generatedAt"], STAMP)

    def test_能被json倒出来(self):
        # numpy 的标量倒不出来 —— 这一步拦的是「哪一行忘了转成内置类型」
        self.assertIn("dorm-a", json.dumps(self.data(), ensure_ascii=False))

    def test_写出来能原样读回来(self):
        out = self.folder / "ml_result.json"
        self.assertEqual(analysis.write_ml_result(self.result, out, generated_at=STAMP), out)
        self.assertEqual(json.loads(out.read_text(encoding="utf-8")), self.data())

    def test_目录不存在会自动建(self):
        out = self.folder / "深" / "几层" / "ml_result.json"
        analysis.write_ml_result(self.result, out, generated_at=STAMP)
        self.assertTrue(out.is_file())

    def test_是LF末尾带换行(self):
        out = analysis.write_ml_result(self.result, self.folder / "ml_result.json",
                                       generated_at=STAMP)
        raw = out.read_bytes()
        self.assertNotIn(b"\r", raw)
        self.assertTrue(raw.endswith(b"\n"))

    def test_缩进两格给人看(self):
        # 和 LF、末尾换行一样，这是产物的格式：缩进过才看得出层级，
        # 挤成一行照样能 json.loads，可它是给人和看板两边看的东西
        out = analysis.write_ml_result(self.result, self.folder / "ml_result.json",
                                       generated_at=STAMP)
        lines = out.read_text(encoding="utf-8").splitlines()
        self.assertTrue(lines[1].startswith('  "'), lines[1])
        self.assertFalse(lines[1].startswith('    "'), lines[1])   # 不是四格

    def test_中文原样写进去(self):
        out = analysis.write_ml_result(self.result, self.folder / "ml_result.json",
                                       generated_at=STAMP)
        text = out.read_text(encoding="utf-8")
        self.assertIn("与历史明显不同", text)
        self.assertNotIn("\\u", text)       # ensure_ascii=False，不是一堆 \uXXXX

    def test_默认路径就在报告旁边(self):
        # 两个产物说的是同一件事（同一对文件、同一次判断），放一个目录里找得着
        self.assertEqual(analysis.DEFAULT_ML_JSON.name, "ml_result.json")
        self.assertEqual(analysis.DEFAULT_ML_JSON.parent,
                         analysis.DEFAULT_REPORT_HTML.parent)


if __name__ == "__main__":
    unittest.main(verbosity=2)
