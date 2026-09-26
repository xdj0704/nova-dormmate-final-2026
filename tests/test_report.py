"""analysis/report.py 的测试：Markdown 渲染、表格转义、写文件、结论。

    py -3.14 -m unittest discover -s tests -t . -v

报告是 summary 的纯函数，所以大部分测试是"给一个 summary，看渲染出来的文本"——
生成时间一律传固定值，输出才能逐字节比对。
"""

from __future__ import annotations

import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import pandas as pd

from analysis import analysis, report, rules

STAMP = "2026-09-26 14:00:00"
BOM = chr(0xFEFF)
HEADER = "time,temperature,humidity,status"


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


def summary_of(rows: list[tuple], csv_path: str = "x.csv") -> dict:
    """行列表 -> summary（走真实的 analyze + summarize，不手搓字典）。"""
    df = analysis.add_rule_status(frame_from(rows))
    with redirect_stdout(io.StringIO()):
        return analysis.summarize(df, Path(csv_path), verbose=False)


def four_rows() -> list[tuple]:
    """四种状态各一条 —— 占比都是 25.0%。"""
    return [
        ("2026-09-22 20:30:00", 16.0, 60.0, "偏冷"),
        ("2026-09-22 20:30:05", 25.0, 60.0, "正常"),
        ("2026-09-22 20:30:10", 31.0, 60.0, "偏热"),
        ("2026-09-22 20:30:15", 25.0, 80.0, "偏湿"),
    ]


def write_csv(text: str, name: str = "t.csv") -> Path:
    """写一个带 BOM 的临时 CSV，模拟网页导出的文件。"""
    path = Path(tempfile.mkdtemp()) / name
    path.write_text(BOM + text, encoding="utf-8", newline="")
    return path


class TestRenderSections(unittest.TestCase):
    def test_该有的段落都有(self):
        text = report.render(summary_of(four_rows()), STAMP)

        for heading in [
            "# DormMate 宿舍环境分析报告",
            "## 状态分布",
            "## 规则一致性",
            "## 需要关注的记录",
            "## 结论",
        ]:
            with self.subTest(heading=heading):
                self.assertIn(heading, text)

    def test_开头写明是自动生成的(self):
        text = report.render(summary_of(four_rows()), STAMP)
        self.assertIn("analysis/report.py 生成", text)
        self.assertIn("请勿手改", text)

    def test_表头信息(self):
        text = report.render(summary_of(four_rows()), STAMP)

        self.assertIn("- 数据文件：`x.csv`", text)
        self.assertIn("- 记录数：4", text)
        self.assertIn("- 时间范围：2026-09-22 20:30:00 ~ 2026-09-22 20:30:15", text)
        self.assertIn("- 温度：16 ~ 31 ℃", text)
        self.assertIn("- 湿度：60 ~ 80 %", text)
        self.assertIn(f"- 生成时间：{STAMP}", text)

    def test_只有一条记录时时间范围不重复打印两遍(self):
        text = report.render(summary_of([("2026-09-22 20:30:00", 25.0, 60.0, "正常")]), STAMP)
        self.assertIn("- 时间范围：2026-09-22 20:30:00", text)
        self.assertNotIn("2026-09-22 20:30:00 ~ 2026-09-22 20:30:00", text)

    def test_状态分布表带条数和占比(self):
        text = report.render(summary_of(four_rows()), STAMP)

        self.assertIn("| 状态 | 条数 | 占比 |", text)
        for name in ["偏冷", "偏热", "偏湿", "正常"]:
            self.assertIn(f"| {name} | 1 | 25.0% |", text)
        self.assertIn("| **合计** | **4** | **100.0%** |", text)

    def test_说明状态是重算的(self):
        text = report.render(summary_of(four_rows()), STAMP)
        self.assertIn("rule_status", text)

    def test_报告里不写建议文案(self):
        # 建议的唯一出处是网页那边的 getAdvice()，这一侧只列数据
        text = report.render(summary_of(four_rows()), STAMP)
        for advice in ["注意保暖", "注意通风", "开窗通风", "环境良好"]:
            with self.subTest(advice=advice):
                self.assertNotIn(advice, text)


class TestRenderConsistency(unittest.TestCase):
    def test_一致时没有警告(self):
        text = report.render(summary_of(four_rows()), STAMP)
        self.assertIn("4 行的 `status` 和规则重算结果一致。", text)
        self.assertNotIn("⚠", text)

    def test_不一致时打警告并点名两个规则文件(self):
        rows = [
            ("2026-09-22 20:30:00", 25.0, 60.0, "正常"),
            ("2026-09-22 20:30:05", 31.0, 80.0, "偏湿"),      # 规则说是偏热
        ]
        text = report.render(summary_of(rows), STAMP)

        self.assertIn("⚠", text)
        self.assertIn("1 / 2 行的 `status` 和规则重算结果不一致", text)
        self.assertIn("shared/rules.js", text)
        self.assertIn("status_rules.py", text)
        self.assertIn("| 2026-09-22 20:30:05 | 31 | 80 | 偏湿 | 偏热 |", text)

    def test_不一致时结论里也提一句(self):
        rows = [("2026-09-22 20:30:05", 31.0, 80.0, "偏湿")]
        summary = summary_of(rows)
        self.assertTrue(any("对不上" in bullet for bullet in report.conclusions(summary)))


class TestRenderAttention(unittest.TestCase):
    def test_列出需要关注的记录(self):
        summary = summary_of(four_rows())
        text = report.render(summary, STAMP)

        self.assertIn("3 条（占 75.0%）", text)
        self.assertIn("| 2026-09-22 20:30:00 | 16 | 60 | 偏冷 |", text)
        self.assertIn("| 2026-09-22 20:30:10 | 31 | 60 | 偏热 |", text)
        self.assertIn("| 2026-09-22 20:30:15 | 25 | 80 | 偏湿 |", text)

    def test_全正常时说没有要关注的(self):
        summary = summary_of([("2026-09-22 20:30:00", 25.0, 60.0, "正常")])
        text = report.render(summary, STAMP)
        self.assertIn(f"没有，全部是「{rules.STATUS_NORMAL}」。", text)


class TestRenderEdgeCases(unittest.TestCase):
    def test_空表不炸也不出现nan(self):
        summary = summary_of([])
        text = report.render(summary, STAMP)

        self.assertEqual(summary["records"], 0)
        self.assertNotIn("nan", text.lower())
        self.assertIn("- 记录数：0", text)
        self.assertIn("- 时间范围：（没有记录）", text)
        self.assertIn("- 温度：（没有记录）", text)
        self.assertIn("没有数据行", text)

    def test_表格里的竖线会被转义(self):
        # 字段里带竖线会把 Markdown 表格切歪；CSV 内容是网页拼的，谁都能写进来
        summary = summary_of([("2026-09-22 20:30:00", 16.0, 60.0, "偏冷")])
        summary["attention"][0]["time"] = "a|b"

        text = report.render(summary, STAMP)

        self.assertIn(r"a\|b", text)
        self.assertNotIn("| a|b |", text)

    def test_换行也不会把表格断成两半(self):
        summary = summary_of([("2026-09-22 20:30:00", 16.0, 60.0, "偏冷")])
        summary["attention"][0]["time"] = "a\nb"
        self.assertIn("| a b |", report.render(summary, STAMP))

    def test_不传生成时间时用当前时间(self):
        text = report.render(summary_of(four_rows()))
        self.assertIn("- 生成时间：", text)
        self.assertNotIn("- 生成时间：None", text)

    def test_渲染两次结果一样(self):
        summary = summary_of(four_rows())
        self.assertEqual(
            report.render(summary, STAMP),
            report.render(summary, STAMP),
        )

    def test_不修改传进来的summary(self):
        summary = summary_of(four_rows())
        before = {key: value for key, value in summary.items() if key != "attention"}
        attention_before = [dict(item) for item in summary["attention"]]

        report.render(summary, STAMP)

        self.assertEqual({k: v for k, v in summary.items() if k != "attention"}, before)
        self.assertEqual(summary["attention"], attention_before)


class TestConclusions(unittest.TestCase):
    def test_最多的状态(self):
        rows = [("t1", 16.0, 60.0, "偏冷"), ("t2", 16.0, 60.0, "偏冷"),
                ("t3", 25.0, 60.0, "正常")]
        bullets = report.conclusions(summary_of(rows))
        self.assertTrue(any("「偏冷」" in b and "2 条" in b for b in bullets), bullets)

    def test_并列时说明是并列(self):
        bullets = report.conclusions(summary_of(four_rows()))
        self.assertTrue(any("并列最多" in b for b in bullets), bullets)

    def test_关注条数和占比(self):
        bullets = report.conclusions(summary_of(four_rows()))
        self.assertTrue(any("需要关注 3 条" in b and "75.0%" in b for b in bullets), bullets)

    def test_极值踩到阈值才提(self):
        hot = report.conclusions(summary_of([("t1", 31.0, 60.0, "偏热")]))
        self.assertTrue(any("31" in b and "阈值" in b for b in hot), hot)

        mild = report.conclusions(summary_of([("t1", 25.0, 60.0, "正常")]))
        self.assertFalse(any("阈值" in b for b in mild), mild)

    def test_空表给一句人话(self):
        bullets = report.conclusions(summary_of([]))
        self.assertEqual(len(bullets), 1)
        self.assertIn("没有数据行", bullets[0])


class TestWrite(unittest.TestCase):
    def test_写文件并建目录(self):
        out = Path(tempfile.mkdtemp()) / "sub" / "deep" / "r.md"
        summary = summary_of(four_rows())

        written = report.write(summary, out, STAMP)

        self.assertEqual(written, out)
        self.assertTrue(out.is_file())
        self.assertEqual(out.read_text(encoding="utf-8"), report.render(summary, STAMP))

    def test_换行是LF不是CRLF(self):
        out = Path(tempfile.mkdtemp()) / "r.md"
        report.write(summary_of(four_rows()), out, STAMP)
        self.assertNotIn(b"\r\n", out.read_bytes())

    def test_是utf8_中文不乱码(self):
        out = Path(tempfile.mkdtemp()) / "r.md"
        report.write(summary_of(four_rows()), out, STAMP)
        self.assertIn("状态分布", out.read_text(encoding="utf-8"))


class TestMain(unittest.TestCase):
    def test_端到端生成一份报告(self):
        csv = write_csv(
            f"{HEADER}\r\n"
            "2026-09-22 20:30:00,16,60,偏冷\r\n"
            "2026-09-22 20:30:05,31,78,偏热\r\n"
        )
        out = Path(tempfile.mkdtemp()) / "out" / "report.md"

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = report.main([str(csv), "-o", str(out)])

        self.assertEqual(code, 0)
        self.assertTrue(out.is_file())
        text = out.read_text(encoding="utf-8")
        self.assertIn("# DormMate 宿舍环境分析报告", text)
        self.assertIn("- 记录数：2", text)
        self.assertIn("报告已写入", buf.getvalue())

    def test_输出路径的相对路径也按项目根展开(self):
        self.assertEqual(
            report.DEFAULT_OUT,
            analysis.ROOT / "reports" / "dormmate-report.md",
        )
        self.assertEqual(
            analysis.resolve_csv("reports/x.md"),
            analysis.ROOT / "reports" / "x.md",
        )


class TestSampleReport(unittest.TestCase):
    """拿真实的样例数据出一份报告，看整条链路通不通。"""

    def setUp(self):
        if not analysis.DEFAULT_CSV.is_file():
            self.skipTest("data/dormmate.csv 不存在（演示数据，可以没有）")
        df = analysis.add_rule_status(analysis.load(analysis.DEFAULT_CSV))
        with redirect_stdout(io.StringIO()):
            self.summary = analysis.summarize(df, analysis.DEFAULT_CSV, verbose=False)
        self.text = report.render(self.summary, STAMP)

    def test_记录数和状态都对得上(self):
        self.assertEqual(self.summary["records"], 12)
        self.assertEqual(self.summary["status_counts"]["正常"], 3)
        self.assertIn("- 记录数：12", self.text)

    def test_样例数据规则是一致的_不该有警告(self):
        self.assertEqual(self.summary["mismatches"], [])
        self.assertNotIn("⚠", self.text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
