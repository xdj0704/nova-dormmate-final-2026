"""Step 9-2 的测试：Isolation Forest 与固定规则的对照。

    py -3.14 -m unittest discover -s tests -t . -v

分两半：对照、成句、口径那几件是纯函数，跟 sklearn 无关；真跑模型的那几条
要 scikit-learn，没装就整类跳过（和 test_analysis 里要 matplotlib 那几条
一个路数）——没装 sklearn 时「规则那一半」仍然该能测。
"""

from __future__ import annotations

import io
import json
import os
import random
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

import pandas as pd

from analysis import analysis, ml

try:
    import sklearn  # noqa: F401

    HAS_SKLEARN = True
except ImportError:
    HAS_SKLEARN = False

BOM = chr(0xFEFF)
HEADER = "nodeId,time,temperature,humidity,status,source"

# 真数据跑出来的那六个结果（sklearn 1.9.1 + random_state=42）。
# 这是 README 里那张对照表的内容，所以钉在这里：升级 scikit-learn 之后它可能变，
# 变了这条会红，红的正是「README 那张表过期了」这件事。
REAL_LABELS = [1, -1, -1, -1, -1, -1]
REAL_SCORES = [0.0347, -0.0564, -0.123, -0.0823, -0.0933, -0.045]
REAL_STATUSES = ["正常", "正常", "正常", "偏热", "偏湿", "偏冷"]
REAL_MISMATCH_TIMES = ["2026-09-23 11:25:00", "2026-09-23 11:30:00"]
REAL_HISTORY_FLAGGED = 18

# 归一化用的一行：规则说正常、ML 也说接近常态
# （单元格数必须和 HEADER 对齐：少一个的话 pandas 会把第一列拿去当索引，
#   整行往左错一格 —— 数据悄悄错位比报错难查多了）
GOOD = ("dorm-a", "2026-09-23 11:20:00", 25.0, 60.0, "正常", "模拟")


def record(rule_status, moment="2026-09-23 11:20:00",
           temperature=25.0, humidity=60.0, node="dorm-a") -> tuple:
    """造一条 (nodeId, time, temperature, humidity, rule_status) —— compare_rows 的输入。"""
    return (node, moment, temperature, humidity, rule_status)


def compare(records, labels, scores=None):
    """compare_rows 的简写：分数默认给一串「按标签该有的样子」的数。"""
    if scores is None:
        scores = [0.05 if label == 1 else -0.05 for label in labels]
    return ml.compare_rows(records, labels, scores)


def write_csv(rows, name="t.csv", header=HEADER, dir_path=None) -> Path:
    """把若干行写成临时 CSV（带 BOM + CRLF，和网页导出的一致）。"""
    path = Path(dir_path or tempfile.mkdtemp()) / name
    text = "\r\n".join([header] + [",".join(str(cell) for cell in row) for row in rows]) + "\r\n"
    path.write_text(BOM + text, encoding="utf-8", newline="")
    return path


def wide_history() -> list[tuple]:
    """一份取值比较宽的历史（20~29 ℃ / 50~70 %）。

    造它出来是为了有一个「居中的新数据两边都判正常」的场景 —— 真数据那份
    （24~26 ℃ / 55~65 %）抖动很小，随便一条新读数都会被 ML 挑出来。
    """
    rng = random.Random(7)
    return [("dorm-a", "2026-09-23 08:%02d:00" % index,
             round(rng.uniform(20, 29), 1), round(rng.uniform(50, 70), 1), "正常", "模拟")
            for index in range(40)]


def centered_new() -> list[tuple]:
    """六条都落在上面那份历史的中间（25 ℃ / 60 %），规则和 ML 都该说正常。"""
    return [("dorm-a", "2026-09-23 11:%02d:00" % index, 25.0, 60.0, "正常", "模拟")
            for index in range(6)]


def bare(rows) -> list[tuple]:
    """去掉 nodeId / source，只留 time,temperature,humidity,status 四格。

    四格的行要配四列的表头 —— 单元格数和表头对不上时 pandas 会把第一列拿去当
    索引、整行往左错一格，数据悄悄错位，比报错难查多了。
    """
    return [(moment, temp, hum, status) for _, moment, temp, hum, status, _ in rows]


def capture(func, *args, **kwargs):
    """接住函数打印的内容和它给的退出码，返回 (文本, 退出码)。

    SystemExit 的消息分两种：argparse 走的标准错误（"ml.py: error: ..."）在
    抛之前就打印了，直接收到；analysis.load() 那种 SystemExit("一句人话") 是
    让解释器去打印的 —— 这里得替它打印，不然断言什么也看不见。

    没抛异常时，退出码取函数自己的返回值（_main 跑成功返回 0）。这里必须看返回值：
    不看的写法（code 停在 0 上）对着「跑成功了也返回 1」一点反应都没有 ——
    命令行上 `python analysis/ml.py && 下一步` 就再也不会执行了。
    """
    out, err = io.StringIO(), io.StringIO()
    code = 0
    with redirect_stdout(out), redirect_stderr(err):
        try:
            code = func(*args, **kwargs)
        except SystemExit as exc:
            code = exc.code
            if isinstance(code, str):
                err.write(str(code) + "\n")
                code = 1
    return out.getvalue() + err.getvalue(), 0 if code is None else code


class TestConstants(unittest.TestCase):
    """题目给的那几个数，一个都不许动。"""

    def test_模型参数就是题目给的三个(self):
        self.assertEqual(ml.MODEL_PARAMS, {
            "n_estimators": 100, "contamination": "auto", "random_state": 42,
        })

    def test_参数没有多也没有少(self):
        # 多一个参数（比如 bootstrap）也算改了题目 —— 结论就不一样了
        self.assertEqual(len(ml.MODEL_PARAMS), 3)

    def test_只用温湿度两列(self):
        self.assertEqual(ml.FEATURES, ["temperature", "humidity"])

    def test_判决门槛是0(self):
        self.assertEqual(ml.ML_THRESHOLD, 0.0)

    def test_predict的约定了写成常量(self):
        self.assertEqual((ml.ML_INLIER, ml.ML_OUTLIER), (1, -1))
        self.assertEqual(ml.ML_INLIER_TEXT, "接近历史常态")
        self.assertEqual(ml.ML_OUTLIER_TEXT, "与历史明显不同")

    def test_两种不一致的说法都在(self):
        self.assertEqual(ml.MISMATCH_TEXT, "规则说正常，ML 说不同")
        self.assertIn("没有可对照", ml.NO_ROWS_TEXT)

    def test_默认路径指向data里那两份(self):
        self.assertEqual(ml.DEFAULT_HISTORY.name, "dorm-a_history_sim.csv")
        self.assertEqual(ml.DEFAULT_NEW.name, "new_samples.csv")
        self.assertEqual(ml.DEFAULT_HISTORY.parent.name, "data")


class TestMlText(unittest.TestCase):
    """predict 的 ±1 翻成人话。"""

    def test_1是接近常态(self):
        self.assertEqual(ml.ml_text(1), "接近历史常态")

    def test_负1是与历史不同(self):
        self.assertEqual(ml.ml_text(-1), "与历史明显不同")

    def test_字符串数字也认(self):
        # 结果是要 json 出去给报告用的，回来的路上完全可能是字符串
        self.assertEqual(ml.ml_text("1"), "接近历史常态")

    def test_不认识的标签原样写出来(self):
        # 不猜一个说法：真出现别的值，说明调用方传错了东西，要看见那个值
        self.assertEqual(ml.ml_text(0), "(不认识的标签 0)")
        self.assertIn("7", ml.ml_text(7))


class TestScoreIsOutlier(unittest.TestCase):
    """分数和门槛的关系。"""

    def test_负分算异常(self):
        self.assertTrue(ml.score_is_outlier(-0.123))

    def test_正分不算异常(self):
        self.assertFalse(ml.score_is_outlier(0.0347))

    def test_恰好0不算异常(self):
        # sklearn 是 decision_function < 0 判 -1，不是 <= —— 0 落在「正常」那一侧
        self.assertFalse(ml.score_is_outlier(0.0))

    def test_负零也不算(self):
        self.assertFalse(ml.score_is_outlier(-0.0))


class TestCheckThreshold(unittest.TestCase):
    """门槛那句话得跟实际标签对得上。"""

    def test_对得上时不吭声(self):
        self.assertIsNone(ml._check_threshold([1, -1], [0.05, -0.05]))

    def test_标签和分数对不上就报错(self):
        # sklearn 哪天换了切法（这个库在 offset_ 和 0 之间换过一次），
        # 屏幕上那句「分数低于它就判 -1」就变成假话了 —— 要有人去看
        with self.assertRaises(RuntimeError) as caught:
            ml._check_threshold([-1], [0.05])
        message = str(caught.exception)
        self.assertIn("predict", message)
        self.assertIn("ML_THRESHOLD", message)
        self.assertIn("0.0500", message)        # 把当时那个分数写出来，好去翻原始数据
        self.assertIn("1", message)             # 以及它该给哪个标签

    def test_分数恰好0而标签是负1也报错(self):
        with self.assertRaises(RuntimeError):
            ml._check_threshold([-1], [0.0])

    def test_空的两串不报错(self):
        self.assertIsNone(ml._check_threshold([], []))


class TestCompareRows(unittest.TestCase):
    """对照行：两个布尔值 + 一条给人看的说法。"""

    def test_四种组合(self):
        rows = compare(
            [record("正常"), record("正常"), record("偏热"), record("偏热")],
            [1, -1, 1, -1],
        )
        self.assertEqual([(r["rule_normal"], r["ml_normal"]) for r in rows],
                         [(True, True), (True, False), (False, True), (False, False)])
        self.assertEqual([r["mismatch"] for r in rows], [False, True, False, False])

    def test_规则说正常ML说不同才算不一致(self):
        rows = compare([record("正常"), record("偏热")], [1, -1])
        self.assertEqual(ml.find_mismatches(rows), [])
        self.assertEqual([r["mismatch"] for r in rows], [False, False])

    def test_原始值原样带着(self):
        row = compare([("dorm-b", "2026-09-23 11:20:00", 31.0, 60.0, "偏热")], [-1])[0]
        self.assertEqual(row["nodeId"], "dorm-b")
        self.assertEqual(row["time"], "2026-09-23 11:20:00")
        self.assertEqual(row["temperature"], 31.0)
        self.assertEqual(row["humidity"], 60.0)
        self.assertEqual(row["rule_status"], "偏热")

    def test_ml那一列的说法也跟着标签(self):
        rows = compare([record("正常"), record("正常")], [1, -1])
        self.assertEqual([r["ml_text"] for r in rows], ["接近历史常态", "与历史明显不同"])

    def test_顺序跟着给的顺序(self):
        rows = compare(
            [record("正常", "2026-09-23 11:20:00"), record("正常", "2026-09-23 11:30:00")],
            [-1, 1],
        )
        self.assertEqual([r["time"][11:16] for r in rows], ["11:20", "11:30"])
        self.assertEqual([r["ml_label"] for r in rows], [-1, 1])

    def test_分数四舍五入到四位(self):
        row = compare([record("正常")], [1], [0.03456789])[0]
        self.assertEqual(row["score"], 0.0346)

    def test_结果能直接json序列化(self):
        # 报告那一侧要拿它拼区块。numpy 的 int64 / float64 走到 json.dumps
        # 会当场炸，所以每条都必须是内置类型。
        rows = compare([record("正常")], [1])
        for row in rows:
            self.assertIs(type(row["ml_label"]), int)
            self.assertIs(type(row["score"]), float)
            self.assertIs(type(row["rule_normal"]), bool)
        json.dumps(rows)

    def test_一条数据也没有时是空表(self):
        self.assertEqual(ml.compare_rows([], [], []), [])


class TestFind(unittest.TestCase):
    """两个方向的不一致各挑一次。"""

    def rows(self):
        return compare(
            [record("正常"), record("正常"), record("偏热"), record("偏湿")],
            [1, -1, 1, -1],
        )

    def test_正向只挑规则正常ML异常的(self):
        self.assertEqual([r["time"] for r in ml.find_mismatches(self.rows())],
                         ["2026-09-23 11:20:00"])

    def test_反向只挑规则异常ML正常的(self):
        rows = ml.find_reverse(self.rows())
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["rule_status"], "偏热")

    def test_两边都判异常的不算不一致(self):
        rows = compare([record("偏热")], [-1])
        self.assertEqual(ml.find_mismatches(rows), [])
        self.assertEqual(ml.find_reverse(rows), [])

    def test_空表两个都空(self):
        self.assertEqual((ml.find_mismatches([]), ml.find_reverse([])), ([], []))


class TestRenderComparison(unittest.TestCase):
    """一句话：命令行和报告共用这一句。"""

    def test_都对得上时说没出现不一致(self):
        rows = compare([record("正常"), record("偏热")], [1, -1])
        self.assertIn("本次测试未出现规则与 ML 不一致", ml.render_comparison(rows))
        self.assertNotIn("不一致的有", ml.render_comparison(rows))

    def test_没有新数据时不说没出现不一致(self):
        # 「一条数据都没有」说成「没出现不一致」是句真话但在骗人 ——
        # 没对照过，不等于对照完了没差别
        text = ml.render_comparison([])
        self.assertEqual(text, ml.NO_ROWS_TEXT)
        self.assertNotIn("本次测试未出现", text)

    def test_正向不一致点名到时刻和读数(self):
        text = ml.render_comparison(compare([record("正常")], [-1]))
        self.assertIn("规则判断为正常、ML 认为与历史明显不同", text)
        # 连着的这一串整体比：时刻只取时分、读数去掉小数尾巴、中间用（）、
        # 温度湿度按「℃ / %」排 —— 分开断言的话，「时刻带上了日期」
        # 或者「写成 25.0 ℃」都照样能过
        self.assertIn("11:20（25 ℃ / 60 %）", text)
        self.assertNotIn("2026-09-23", text)
        self.assertNotIn("25.0", text)
        self.assertNotIn("本次测试未出现", text)
        self.assertNotIn("ML 却认为接近历史常态", text)   # 没有反向的，就别提反向

    def test_两条不一致时都点了名还按顺序(self):
        rows = compare(
            [record("正常", "2026-09-23 11:25:00", 26, 62),
             record("正常", "2026-09-23 11:30:00", 29, 72)],
            [-1, -1],
        )
        self.assertIn("11:25（26 ℃ / 62 %）、11:30（29 ℃ / 72 %）", ml.render_comparison(rows))

    def test_反向不一致也要报出来(self):
        # 只数一个方向的话，遇到反过来的情况会报「未出现不一致」，那就说反了
        text = ml.render_comparison(compare([record("偏湿")], [1]))
        self.assertIn("ML 却认为接近历史常态", text)
        self.assertIn("偏湿", text)
        self.assertNotIn("本次测试未出现", text)
        self.assertNotIn("规则判断为正常、ML 认为与历史明显不同的有", text)  # 没有正向的

    def test_两个方向一起出现时数是和(self):
        text = ml.render_comparison(compare([record("正常"), record("偏湿")], [-1, 1]))
        # 连着小标题一起比：只断言「不一致的有 2 条」的话，
        # 「6 条新数据里」那半句丢了也照样过
        self.assertIn("2 条新数据里，规则与 ML 不一致的有 2 条。", text)
        self.assertIn("规则判断为正常", text)
        self.assertIn("ML 却认为接近历史常态", text)

    def test_总带上那句为什么会对不上(self):
        text = ml.render_comparison(compare([record("正常")], [-1]))
        self.assertIn("固定规则只看有没有越过那三条线", text)
        self.assertIn("跟平时的历史像不像", text)


class TestClockAndParams(unittest.TestCase):
    """两行的助手。"""

    def test_取到时分(self):
        self.assertEqual(ml._clock("2026-09-23 11:20:00"), "11:20")

    def test_不是那个格式就原样返回(self):
        # 切不动就看得见问题在哪，而不是悄悄给出个错的时刻
        self.assertEqual(ml._clock("11:20"), "11:20")
        self.assertEqual(ml._clock(""), "")

    def test_参数那行从参数字典拼出来(self):
        self.assertEqual(ml._params_text({"n_estimators": 100, "contamination": "auto"}),
                         "n_estimators=100、contamination='auto'")

    def test_改了参数字典这句话就跟着变(self):
        # 手写一遍的话，改了 MODEL_PARAMS 而忘了改这句话，
        # 屏幕上写的就不是实际用的参数了
        self.assertEqual(ml._params_text({"a": 1}), "a=1")
        self.assertEqual(ml._params_text({}), "")


class TestRequireRows(unittest.TestCase):
    """一份数据一行都没有时说人话。"""

    def test_空表报错并说清是哪个文件(self):
        with self.assertRaises(ValueError) as caught:
            ml._require_rows(pd.DataFrame({"time": []}), Path("x.csv"), "历史")
        self.assertIn("一行数据都没有", str(caught.exception))
        self.assertIn("x.csv", str(caught.exception))

    def test_报的是哪一份空(self):
        for what in ("历史", "新数据"):
            with self.assertRaises(ValueError) as caught:
                ml._require_rows(pd.DataFrame(), Path("x.csv"), what)
            self.assertTrue(str(caught.exception).startswith(what))

    def test_有不报(self):
        self.assertIsNone(ml._require_rows(pd.DataFrame({"time": ["t"]}), Path("x"), "历史"))


class TestFeatureFrame(unittest.TestCase):
    """取两列交给模型。"""

    def frame(self, rows):
        return pd.DataFrame(rows, columns=["time", "temperature", "humidity", "status"])

    def test_只拿温湿度两列(self):
        frame = self.frame([["2026-09-23 11:20:00", 25.0, 60.0, "正常"]])
        out = ml._feature_frame(frame, Path("x.csv"), "新数据")
        self.assertEqual(list(out.columns), ml.FEATURES)

    def test_别的列不进来(self):
        frame = self.frame([["2026-09-23 11:20:00", 25.0, 60.0, "正常"]])
        frame["source"] = ["模拟"]
        self.assertEqual(list(ml._feature_frame(frame, Path("x.csv"), "新数据").columns),
                         ml.FEATURES)

    def test_列的顺序不影响(self):
        # 按名字取列，不按位置 —— CSV 的列序是导出时定的，不该左右结果
        frame = pd.DataFrame({"humidity": [60.0], "temperature": [25.0],
                              "time": ["2026-09-23 11:20:00"]})
        out = ml._feature_frame(frame, Path("x.csv"), "新数据")
        self.assertEqual(list(out.columns), ["temperature", "humidity"])

    def test_空格子报错并点名是哪一条(self):
        # 空格子放在【第二条】：只报一条的话，「永远报第一条」也能过 ——
        # 那正是这条消息最容易写错的地方（空格子在第三条时报的是第一条）
        frame = self.frame([["2026-09-23 11:20:00", 25.0, 60.0, "正常"],
                            ["2026-09-23 11:25:00", None, 60.0, "(缺失)"]])
        with self.assertRaises(ValueError) as caught:
            ml._feature_frame(frame, Path("x.csv"), "历史")
        self.assertIn("2026-09-23 11:25:00", str(caught.exception))
        self.assertNotIn("11:20", str(caught.exception))
        self.assertIn("x.csv", str(caught.exception))
        self.assertIn("缺一个值", str(caught.exception))

    def test_湿度空格子也报(self):
        # 空的可能是温度那一格，也可能是湿度那一格，两个都要拦 ——
        # 而且每行只空一格：两格都空的用例证明不了哪一格在管用
        for index, name in ((1, "temperature"), (2, "humidity")):
            with self.subTest(字段=name):
                cells = [25.0, 60.0, "正常"]
                cells[index - 1] = None
                frame = self.frame([["2026-09-23 11:20:00", 25.0, 60.0, "正常"],
                                    ["2026-09-23 11:25:00"] + cells])
                with self.assertRaises(ValueError):
                    ml._feature_frame(frame, Path("x.csv"), "历史")

    def test_一个空格子都没有就不报(self):
        frame = self.frame([["2026-09-23 11:20:00", 25.0, 60.0, "正常"]])
        self.assertIsNotNone(ml._feature_frame(frame, Path("x.csv"), "新数据"))


class TestMissingSklearn(unittest.TestCase):
    """没装 scikit-learn 时给一句人话，不甩 traceback。

    这条不挂 skipUnless：装了要测（把 import 打断），没装也要测（本来就没有）。
    """

    def test_没装时给一句人话(self):
        frame = pd.DataFrame({"temperature": [25.0], "humidity": [60.0]})
        # sys.modules 里放个 None：Python 见到它会直接抛 ImportError，
        # 等于模拟一次「这个包没装」
        with mock.patch.dict(sys.modules, {"sklearn": None, "sklearn.ensemble": None}):
            with self.assertRaises(SystemExit) as caught:
                ml.build_model(frame)
        message = str(caught.exception)
        self.assertIn("scikit-learn", message)
        self.assertIn("pip install", message)
        self.assertIn("py -3.14", message)


@unittest.skipUnless(HAS_SKLEARN, "需要 scikit-learn")
class TestBuildModel(unittest.TestCase):
    """fit 一个模型。"""

    def model(self):
        frame = pd.DataFrame({"temperature": [25.0] * 20, "humidity": [60.0] * 20})
        return ml.build_model(frame)

    def test_参数就是那三个(self):
        params = self.model().get_params()
        for name, value in ml.MODEL_PARAMS.items():
            self.assertEqual(params[name], value)

    def test_真的fit过了(self):
        model = self.model()
        self.assertTrue(hasattr(model, "estimators_"))

    def test_模型真的建起来了(self):
        # 只钉形状：抽出多少个 estimator、认几列。
        # **「拿哪一份数据 fit 的」在这里看不出来**（estimators_ 的个数、n_features_in_
        # 都不会因为多喂了一层数据而变），那件事由 TestRunMlSynthetic 里那条
        # 「交给模型的只有历史那一份」用探针盯着。
        model = self.model()
        self.assertEqual(len(model.estimators_), ml.MODEL_PARAMS["n_estimators"])
        self.assertEqual(model.n_features_in_, len(ml.FEATURES))


@unittest.skipUnless(HAS_SKLEARN, "需要 scikit-learn")
class TestRunMlReal(unittest.TestCase):
    """拿 data/ 里那两份真数据跑一遍 —— 这张表就是 README 里那张。"""

    @classmethod
    def setUpClass(cls):
        cls.result = ml.run_ml(ml.DEFAULT_HISTORY, ml.DEFAULT_NEW)

    def test_两份文件各多少条(self):
        self.assertEqual(self.result["history_rows"], 40)
        self.assertEqual(self.result["new_rows"], 6)
        self.assertEqual(len(self.result["rows"]), 6)

    def test_文件路径是绝对路径(self):
        for key in ("history_file", "new_file"):
            self.assertTrue(Path(self.result[key]).is_absolute())

    def test_规则那一列是重算的(self):
        self.assertEqual([row["rule_status"] for row in self.result["rows"]], REAL_STATUSES)

    def test_ML那一列(self):
        self.assertEqual([row["ml_label"] for row in self.result["rows"]], REAL_LABELS)
        self.assertEqual([row["ml_text"] for row in self.result["rows"]],
                         ["接近历史常态"] + ["与历史明显不同"] * 5)

    def test_分数(self):
        self.assertEqual([row["score"] for row in self.result["rows"]], REAL_SCORES)

    def test_不一致的就是1125和1130那两条(self):
        # 这一步的重点：29 ℃ / 72 % 一条线都没越（规则说正常），
        # 但离历史那一片（24~26 ℃ / 55~65 %）很远 —— ML 说与历史明显不同
        self.assertEqual([row["time"] for row in self.result["mismatches"]],
                         REAL_MISMATCH_TIMES)
        self.assertEqual([row["rule_status"] for row in self.result["mismatches"]],
                         ["正常", "正常"])

    def test_没有反方向的不一致(self):
        self.assertEqual(self.result["reverse"], [])

    def test_门槛是0(self):
        self.assertEqual(self.result["threshold"], 0.0)

    def test_参数原样带在结果里(self):
        self.assertEqual(self.result["params"], ml.MODEL_PARAMS)
        self.assertEqual(self.result["features"], ml.FEATURES)

    def test_门槛松紧那个数(self):
        # 「与历史明显不同」没听上去那么重：contamination='auto' 不指定异常比例，
        # 拿模型回看它自己学过的 40 条历史，18 条也会被判 -1。
        # 这个数写在命令行上，也写在 README 里，所以钉住。
        self.assertEqual(self.result["history_flagged"], REAL_HISTORY_FLAGGED)
        self.assertIs(type(self.result["history_flagged"]), int)

    def test_那句话和单独算的一致(self):
        # 命令行和报告必须是同一句话，各拼一份迟早会变成两句
        self.assertEqual(self.result["text"], ml.render_comparison(self.result["rows"]))

    def test_那句话说的是这条数据(self):
        self.assertIn("不一致的有 2 条", self.result["text"])
        self.assertIn("11:25", self.result["text"])
        self.assertIn("11:30", self.result["text"])

    def test_结果能直接json序列化(self):
        self.assertIn('"text"', json.dumps(self.result))

    def test_每格都是内置类型(self):
        # json.dumps 认 numpy 的 float64（它是 float 的子类），所以光靠
        # 「能 dump 出去」证明不了什么 —— 类型要单独看：报告那边以后要做
        # 判断或者再算一遍，拿到 numpy 的标量会到处出洋相
        for row in self.result["rows"]:
            self.assertIs(type(row["temperature"]), float)
            self.assertIs(type(row["humidity"]), float)
            self.assertIs(type(row["score"]), float)
            self.assertIs(type(row["ml_label"]), int)
            self.assertIs(type(row["time"]), str)

    def test_门槛核对了才发结果(self):
        # _check_threshold 在数据一致时一句话都不说，很容易被当成摆设删掉 ——
        # 删了就再也没有东西看着 sklearn 的切法了
        with mock.patch.object(ml, "_check_threshold", wraps=ml._check_threshold) as spy:
            ml.run_ml(ml.DEFAULT_HISTORY, ml.DEFAULT_NEW)
        spy.assert_called_once()

    def test_nodeId也带出来了(self):
        self.assertEqual({row["nodeId"] for row in self.result["rows"]}, {"dorm-a"})

    def test_同一个结果跑两次一样(self):
        # random_state=42 定死之后，这张表该一个字都不差
        again = ml.run_ml(ml.DEFAULT_HISTORY, ml.DEFAULT_NEW)
        self.assertEqual([row["score"] for row in again["rows"]],
                         [row["score"] for row in self.result["rows"]])
        self.assertEqual(again["history_flagged"], self.result["history_flagged"])


@unittest.skipUnless(HAS_SKLEARN, "需要 scikit-learn")
class TestRunMlSynthetic(unittest.TestCase):
    """自己造两份数据，把真数据上碰不到的分支走一遍。"""

    def test_两边都说正常时不报不一致(self):
        result = ml.run_ml(
            write_csv(wide_history(), "h.csv"),
            write_csv(centered_new(), "n.csv"),
        )
        self.assertEqual(result["mismatches"], [])
        self.assertEqual(result["reverse"], [])
        self.assertIn("本次测试未出现规则与 ML 不一致", result["text"])
        self.assertEqual([row["ml_label"] for row in result["rows"]], [1] * 6)

    def test_CSV里的status说了不算(self):
        # CSV 是网页写的，这一列可能和 Python 端的规则不同步。
        # 对照表里那一列必须是重算出来的 —— 拿 CSV 里的值，对出来的东西没有意义。
        liar = write_csv([("dorm-a", "2026-09-23 11:20:00", 31.0, 60.0, "正常")], "lie.csv")
        row = ml.run_ml(ml.DEFAULT_HISTORY, liar)["rows"][0]
        self.assertEqual(row["rule_status"], "偏热")
        self.assertFalse(row["rule_normal"])

    def test_没有nodeId列也能跑(self):
        header = "time,temperature,humidity,status"
        result = ml.run_ml(
            write_csv(bare(wide_history()), "h.csv", header=header),
            write_csv(bare(centered_new()), "n.csv", header=header),
        )
        self.assertEqual(result["rows"][0]["nodeId"], "")

    def test_交给模型的只有历史那一份(self):
        # 结构性守卫：run_ml 交给 build_model 的必须是历史那一份。
        # 光看模型里有几个 estimator 是看不出这一点的 —— 新数据要是也丢进去 fit，
        # 模型会拿新数据自己来定义什么叫正常（一条离谱的读数顺手把正常范围拉大，
        # 于是它自己就不离谱了），而 estimators_ 的个数一个都不会变。
        seen = []
        real = ml.build_model

        def spy(x_history):
            seen.append(x_history.copy())
            return real(x_history)

        history = wide_history()
        # 新数据故意挑一条历史里绝不可能出现的读数：它真被丢进 fit 的话，
        # 下面那两句断言当场就红
        new = [("dorm-a", "2026-09-23 11:20:00", 55.0, 5.0, "正常", "模拟")]
        with mock.patch.object(ml, "build_model", spy):
            ml.run_ml(write_csv(history, "h.csv"), write_csv(new, "n.csv"))

        self.assertEqual(len(seen), 1, "build_model 该被调一次")
        frame = seen[0]
        self.assertEqual(len(frame), len(history))
        self.assertEqual(list(frame.columns), ml.FEATURES)
        self.assertNotIn(55.0, frame["temperature"].tolist())
        self.assertNotIn(5.0, frame["humidity"].tolist())

    def test_列的顺序变了结果不变(self):
        # 按名字取列，不按位置 —— CSV 的列序是导出时定的，不该左右结果
        header = "time,temperature,humidity,status"
        plain = bare(centered_new())
        swapped = [(t, hm, tp, st) for t, tp, hm, st in plain]
        forward = ml.run_ml(write_csv(bare(wide_history()), "h.csv", header=header),
                            write_csv(plain, "n.csv", header=header))
        backward = ml.run_ml(write_csv(bare(wide_history()), "h2.csv", header=header),
                             write_csv(swapped, "n2.csv", header="time,humidity,temperature,status"))
        self.assertEqual([row["ml_label"] for row in backward["rows"]],
                         [row["ml_label"] for row in forward["rows"]])
        self.assertEqual([row["score"] for row in backward["rows"]],
                         [row["score"] for row in forward["rows"]])

    def test_列里夹着别的列也认(self):
        # 温湿度不在最前面（前面夹了 source、后面跟着 nodeId）也要认
        rows = [("模拟", hm, tp, t, st) for _, t, tp, hm, st, _ in centered_new()]
        result = ml.run_ml(
            write_csv(wide_history(), "h.csv"),
            write_csv(rows, "n.csv", header="source,humidity,temperature,time,status"),
        )
        self.assertEqual(result["new_rows"], 6)
        self.assertEqual([row["ml_label"] for row in result["rows"]], [1] * 6)

    def test_历史是空的时候说人话(self):
        with self.assertRaises(ValueError) as caught:
            ml.run_ml(write_csv([], "h.csv"), write_csv(centered_new(), "n.csv"))
        self.assertTrue(str(caught.exception).startswith("历史"))
        self.assertIn("只有表头", str(caught.exception))

    def test_新数据是空的时候说人话(self):
        with self.assertRaises(ValueError) as caught:
            ml.run_ml(write_csv(wide_history(), "h.csv"), write_csv([], "n.csv"))
        self.assertTrue(str(caught.exception).startswith("新数据"))

    def test_新数据里有空格子时说人话(self):
        rows = centered_new()
        rows[2] = ("dorm-a", "2026-09-23 11:30:00", "", 60.0, "正常")
        with self.assertRaises(ValueError) as caught:
            ml.run_ml(write_csv(wide_history(), "h.csv"), write_csv(rows, "n.csv"))
        self.assertIn("2026-09-23 11:30:00", str(caught.exception))

    def test_只有一条数据也要能跑完(self):
        # 只有一条历史、一条新数据也要能跑完，不许悄悄崩在什么空数组上
        result = ml.run_ml(
            write_csv([("dorm-a", "2026-09-23 08:00:00", 25.0, 60.0, "正常", "模拟")], "h.csv"),
            write_csv([GOOD], "n.csv"),
        )
        self.assertEqual(len(result["rows"]), 1)
        self.assertEqual(result["history_flagged"], 0)


class TestMergeSides(unittest.TestCase):
    """两种训练量的并排（纯函数，不用 sklearn）。"""

    def sides(self, labels_full, labels_small, rule_statuses=None):
        """两套判断，同一条数：labels_full 是完整那一套的 ±1，labels_small 是小样本那套。"""
        statuses = rule_statuses or ["正常"] * len(labels_full)
        records = [record(status, moment="2026-09-23 11:%02d:00" % index)
                   for index, status in enumerate(statuses)]
        return (compare(records, labels_full), compare(records, labels_small))

    def test_两套的说法都在同一行上(self):
        full, small = self.sides([1], [-1])
        row = ml.merge_sides(full, small)[0]
        self.assertEqual(row["full_text"], ml.ML_INLIER_TEXT)
        self.assertEqual(row["small_text"], ml.ML_OUTLIER_TEXT)
        self.assertEqual(row["full_score"], full[0]["score"])
        self.assertEqual(row["small_score"], small[0]["score"])

    def test_前缀分得开(self):
        full, small = self.sides([1], [-1])
        row = ml.merge_sides(full, small)[0]
        self.assertTrue(row["full_normal"])
        self.assertFalse(row["small_normal"])

    def test_原始那几列只留一份(self):
        # 两边判的是同一条数据，原始值存两份迟早会对不上
        full, small = self.sides([1], [1])
        row = ml.merge_sides(full, small)[0]
        self.assertEqual(row["time"], "2026-09-23 11:00:00")
        self.assertNotIn("full_time", row)
        self.assertNotIn("small_time", row)

    def test_differs只比两个模型的看法(self):
        # 关键：differs 跟规则无关。规则说正常、两个模型也都说不同 —— 那不是 differs，
        # 那是两套各自的 mismatch（规则和 ML 说不到一块儿）。
        full, small = self.sides([-1, 1], [-1, 1])
        rows = ml.merge_sides(full, small)
        self.assertEqual([row["differs"] for row in rows], [False, False])
        self.assertTrue(rows[0]["full_mismatch"])
        self.assertTrue(rows[0]["small_mismatch"])

    def test_改口的那条标出来(self):
        full, small = self.sides([1, 1, -1], [-1, 1, -1])
        self.assertEqual([row["differs"] for row in ml.merge_sides(full, small)],
                         [True, False, False])

    def test_条数对不上就报错(self):
        full, small = self.sides([1, 1], [1])
        with self.assertRaises(ValueError) as caught:
            ml.merge_sides(full, small)
        self.assertIn("2 对 1", str(caught.exception))

    def test_空表给空表(self):
        self.assertEqual(ml.merge_sides([], []), [])

    def test_每格都是内置类型(self):
        # 这份结果要交给命令行和报告，numpy 的 float64 在那儿打印出来是另一个样子
        full, small = self.sides([1, -1], [-1, -1])
        for row in ml.merge_sides(full, small):
            for key, value in row.items():
                self.assertIsInstance(value, (str, int, float, bool), key)
        json.dumps(ml.merge_sides(full, small))


@unittest.skipUnless(HAS_SKLEARN, "需要 scikit-learn")
class TestSmallSampleReal(unittest.TestCase):
    """真数据上的小样本实验（Step 9-4）。"""

    @classmethod
    def setUpClass(cls):
        cls.result = ml.small_sample_experiment(ml.DEFAULT_HISTORY, ml.DEFAULT_NEW)

    def test_只用前八条训练(self):
        self.assertEqual(self.result["train_rows"], ml.SMALL_TRAIN_ROWS)
        self.assertEqual(self.result["history_rows"], 40)
        self.assertFalse(self.result["same_as_full"])

    def test_完整那一列就是run_ml那一套(self):
        # 上面那张表、报告里那张表、这里的「完整 40 条」那一列，三处必须是同一组数。
        # 各算一遍的话，参数、种子、读法任何一处不同都会让它们分岔。
        plain = ml.run_ml(ml.DEFAULT_HISTORY, ml.DEFAULT_NEW)
        self.assertEqual(self.result["full_text"], plain["text"])
        for row, plain_row in zip(self.result["rows"], plain["rows"]):
            self.assertEqual(row["full_text"], plain_row["ml_text"])
            self.assertEqual(row["full_score"], plain_row["score"])
            self.assertEqual(row["full_mismatch"],
                             plain_row["rule_normal"] != plain_row["ml_normal"])

    def test_两个模型真的都在历史那份上fit的(self):
        # 结构性守卫：fit 两次，第二次只能用前 8 条。
        # 光比两列结果看是看不出这一点的 —— 小样本那一列要是也拿 40 条训出来，
        # 数字会跟「完整」那列一模一样，看着反倒最正常。
        seen = []
        real = ml.build_model

        def spy(x_history):
            seen.append(x_history.copy())
            return real(x_history)

        with mock.patch.object(ml, "build_model", spy):
            ml.small_sample_experiment(ml.DEFAULT_HISTORY, ml.DEFAULT_NEW)

        self.assertEqual(len(seen), 2, "两个训练量该各 fit 一次")
        full_frame, small_frame = seen
        self.assertEqual(len(full_frame), 40)
        self.assertEqual(len(small_frame), ml.SMALL_TRAIN_ROWS)
        # 「前 8 条」是文件里的前 8 行：逐行对上，不是随便取的 8 条
        self.assertEqual(small_frame.reset_index(drop=True).to_dict("list"),
                         full_frame.head(ml.SMALL_TRAIN_ROWS)
                         .reset_index(drop=True).to_dict("list"))

    def test_两个模型的参数一模一样(self):
        # 差别只能有训练条数。种子各给各的话，「判断不同」就分不清是样本少了
        # 还是随机流不一样了 —— 这一节要看的正是样本量的影响。
        models = []
        real = ml.build_model

        def spy(x_history):
            model = real(x_history)
            models.append(model)
            return model

        with mock.patch.object(ml, "build_model", spy):
            ml.small_sample_experiment(ml.DEFAULT_HISTORY, ml.DEFAULT_NEW)

        self.assertEqual(models[0].get_params(), models[1].get_params())
        self.assertEqual(models[0].get_params()["random_state"], 42)

    def test_门槛松紧两套各一个数(self):
        self.assertEqual(self.result["history_flagged"], REAL_HISTORY_FLAGGED)
        self.assertLessEqual(self.result["train_flagged"], ml.SMALL_TRAIN_ROWS)

    def test_差的条数就是differs的长度(self):
        differs = [row for row in self.result["rows"] if row["differs"]]
        self.assertEqual(self.result["differs"], differs)
        # 方向和 full/small 两列一致：说「两边判断不同」的行，两列真的不一样
        for row in self.result["differs"]:
            self.assertNotEqual(row["full_normal"], row["small_normal"])

    def test_两套的结论句各自跟着自己那套数(self):
        # 句子里的「不一致 N 条」就是各自那个数 —— 小样本那句要是抄了完整的数，
        # 这里会红。两个方向的数合起来才是那句话里的数。
        for prefix in ("full", "small"):
            counted = self.result[prefix + "_inconsistent"]
            sentence = self.result[prefix + "_text"]
            if counted:
                self.assertIn(f"不一致的有 {counted} 条", sentence)
            else:
                self.assertIn("未出现规则与 ML 不一致", sentence)

    def test_不一致条数两个方向都数(self):
        # 和 render_comparison 那句里说的「不一致 N 条」是同一个数
        for prefix in ("full", "small"):
            counted = sum(1 for row in self.result["rows"]
                          if row[prefix + "_mismatch"])
            self.assertEqual(self.result[prefix + "_inconsistent"], counted)

    def test_每格都是内置类型(self):
        for key, value in self.result.items():
            if key in ("rows", "differs"):
                continue
            self.assertIsInstance(value, (str, int, float, bool, dict), key)
        json.dumps(self.result)

    def test_一样跑两次结果一样(self):
        again = ml.small_sample_experiment(ml.DEFAULT_HISTORY, ml.DEFAULT_NEW)
        self.assertEqual(again["rows"], self.result["rows"])
        self.assertEqual(again["train_flagged"], self.result["train_flagged"])


@unittest.skipUnless(HAS_SKLEARN, "需要 scikit-learn")
class TestSmallSampleSynthetic(unittest.TestCase):
    """自己造数据，把真数据上碰不到的分支走一遍。"""

    def test_历史不够八条时有几条用几条(self):
        result = ml.small_sample_experiment(
            write_csv(wide_history()[:3], "h.csv"),
            write_csv(centered_new(), "n.csv"),
        )
        self.assertEqual(result["train_rows"], 3)
        self.assertEqual(result["history_rows"], 3)
        self.assertTrue(result["same_as_full"])

    def test_正好八条时也说没有可比的东西(self):
        result = ml.small_sample_experiment(
            write_csv(wide_history()[:8], "h.csv"),
            write_csv(centered_new(), "n.csv"),
        )
        self.assertEqual(result["train_rows"], 8)
        self.assertTrue(result["same_as_full"])

    def test_两列真的是两套判断(self):
        # 拿假模型把两种判断钉死。真数据上这两个训练量恰好判得一样也说不定，
        # 用它来证明「并排的是两套判断」就成了碰运气。这里让前 8 条训出来的那个
        # 模型一律说 -1、完整那个一律说 1 —— 两列就必须一列一种说法。
        class Stub:
            def __init__(self, label, score):
                self.label, self.score = label, score

            def predict(self, frame):
                return [self.label] * len(frame)

            def decision_function(self, frame):
                return [self.score] * len(frame)

        calls = []

        def fake(x_history):
            calls.append(len(x_history))
            # 标签和分数的符号要对得上：_judge 里那道门槛核对会当场拆穿假的
            return (Stub(ml.ML_OUTLIER, -0.5)
                    if len(x_history) == ml.SMALL_TRAIN_ROWS else Stub(ml.ML_INLIER, 0.5))

        with mock.patch.object(ml, "build_model", fake):
            result = ml.small_sample_experiment(write_csv(wide_history(), "h.csv"),
                                                write_csv(centered_new(), "n.csv"))

        self.assertEqual(calls, [40, ml.SMALL_TRAIN_ROWS])
        self.assertEqual([row["full_text"] for row in result["rows"]],
                         [ml.ML_INLIER_TEXT] * result["new_rows"])
        self.assertEqual([row["small_text"] for row in result["rows"]],
                         [ml.ML_OUTLIER_TEXT] * result["new_rows"])
        self.assertEqual(len(result["differs"]), result["new_rows"])

    def test_训练条数不合法时说人话(self):
        with self.assertRaises(ValueError) as caught:
            ml.small_sample_experiment(write_csv(wide_history(), "h.csv"),
                                       write_csv(centered_new(), "n.csv"), train_rows=0)
        self.assertIn("至少要 1 条", str(caught.exception))

    def test_历史是空的时候说人话(self):
        with self.assertRaises(ValueError) as caught:
            ml.small_sample_experiment(write_csv([], "h.csv"),
                                       write_csv(centered_new(), "n.csv"))
        self.assertTrue(str(caught.exception).startswith("历史"))

    def test_新数据是空的时候说人话(self):
        with self.assertRaises(ValueError) as caught:
            ml.small_sample_experiment(write_csv(wide_history(), "h.csv"),
                                       write_csv([], "n.csv"))
        self.assertTrue(str(caught.exception).startswith("新数据"))

    def test_新数据里有空格子时说人话(self):
        rows = centered_new()
        rows[2] = ("dorm-a", "2026-09-23 11:30:00", "", 60.0, "正常")
        with self.assertRaises(ValueError) as caught:
            ml.small_sample_experiment(write_csv(wide_history(), "h.csv"),
                                       write_csv(rows, "n.csv"))
        self.assertIn("2026-09-23 11:30:00", str(caught.exception))


@unittest.skipUnless(HAS_SKLEARN, "需要 scikit-learn")
class TestMain(unittest.TestCase):
    """命令行入口。"""

    def test_默认那两个文件(self):
        text, code = capture(ml._main, [])
        self.assertEqual(code, 0)
        self.assertIn("dorm-a_history_sim.csv", text)
        self.assertIn("new_samples.csv", text)

    def test_把模型和参数写出来(self):
        text, _ = capture(ml._main, [])
        self.assertIn("n_estimators=100", text)
        self.assertIn("contamination='auto'", text)
        self.assertIn("random_state=42", text)
        self.assertIn("fit 只用历史那一份", text)

    def test_把门槛和门槛松紧写出来(self):
        text, _ = capture(ml._main, [])
        self.assertIn("判决门槛：分数 < 0 判 -1", text)
        self.assertIn(f"其中 {REAL_HISTORY_FLAGGED} 条也会被判", text)

    def test_表头七列(self):
        text, _ = capture(ml._main, [])
        for name in ("时间", "温度 ℃", "湿度 %", "规则", "ML", "分数", "备注"):
            self.assertIn(name, text)

    def test_六条数据都在表里(self):
        text, _ = capture(ml._main, [])
        for moment in ("11:20", "11:25", "11:30", "11:35", "11:40", "11:45"):
            self.assertIn(moment, text)
        # 表里的数字不带小数尾巴（31.0 打成 31）—— 25.0 这种写法一个都不该有
        self.assertNotIn(".0 ", text)

    def test_不一致的行有标记(self):
        text, _ = capture(ml._main, [])
        self.assertEqual(text.count(ml.MISMATCH_TEXT), len(REAL_MISMATCH_TIMES))

    def test_结论那句和函数返回的是一句(self):
        text, _ = capture(ml._main, [])
        self.assertIn(ml.run_ml(ml.DEFAULT_HISTORY, ml.DEFAULT_NEW)["text"], text)

    def test_并排打出两种训练量(self):
        text, code = capture(ml._main, [])
        self.assertEqual(code, 0)
        self.assertIn("小样本实验", text)
        self.assertIn("训练量对照：", text)
        self.assertIn("并排对照表：", text)
        self.assertIn(f"小样本 {ml.SMALL_TRAIN_ROWS} 条", text)
        self.assertIn("完整 40 条", text)       # 默认那份历史就是 40 条

    def test_并排那两套结论句都打出来了(self):
        # 两句都是函数算的那两句，不是命令行上另拼的
        text, _ = capture(ml._main, [])
        result = ml.small_sample_experiment(ml.DEFAULT_HISTORY, ml.DEFAULT_NEW)
        self.assertIn(result["full_text"], text)
        self.assertIn(result["small_text"], text)
        # 上面 test_六条数据都在表里 那条 NotIn(".0 ") 查的是整段输出，
        # 小样本这一段也在里面 —— 所以这一段里的数字也必须走 _num()

    def test_并排表的备注只标两边改口的那些行(self):
        # 主表那 2 处标记是上面 test_不一致的行有标记 数着的：这一列要是借用
        # 同一串字，「规则和 ML 一致不一致」跟「换个训练量改不改口」就成了一句话，
        # 那 2 处也会变成 4 处。
        self.assertNotEqual(ml.DIFFERS_TEXT, ml.MISMATCH_TEXT)
        text, _ = capture(ml._main, [])
        self.assertEqual(text.count(ml.MISMATCH_TEXT), len(REAL_MISMATCH_TIMES))
        result = ml.small_sample_experiment(ml.DEFAULT_HISTORY, ml.DEFAULT_NEW)
        self.assertEqual(text.count(ml.DIFFERS_TEXT), len(result["differs"]))

    def test_指定别的文件时小样本那一段也跟着(self):
        text, code = capture(ml._main, [str(write_csv(wide_history(), "h.csv")),
                                        str(write_csv(centered_new(), "n.csv"))])
        self.assertEqual(code, 0)
        self.assertIn("小样本实验", text)
        self.assertIn("完整 40 条", text)      # 表头跟着传进来的历史走

    def test_可以指定别的两个文件(self):
        history = write_csv(wide_history(), "h.csv")
        new = write_csv(centered_new(), "n.csv")
        text, code = capture(ml._main, [str(history), str(new)])
        self.assertEqual(code, 0)
        self.assertIn("本次测试未出现规则与 ML 不一致", text)
        self.assertNotIn(str(ml.DEFAULT_HISTORY), text)

    def test_相对路径按项目根展开(self):
        text, code = capture(ml._main, ["data/dorm-a_history_sim.csv", "data/new_samples.csv"])
        self.assertEqual(code, 0)
        self.assertIn(str(ml.DEFAULT_HISTORY), text)

    def test_文件不在时说人话(self):
        text, code = capture(ml._main, ["data/没有这个文件.csv", "data/new_samples.csv"])
        self.assertNotEqual(code, 0)
        self.assertIn("找不到 CSV", text)

    def test_新数据是空文件时不是抛tracleback(self):
        empty = write_csv([], "empty.csv")
        text, code = capture(ml._main, [str(ml.DEFAULT_HISTORY), str(empty)])
        self.assertNotEqual(code, 0)
        self.assertIn("一行数据都没有", text)
        self.assertNotIn("Traceback", text)

    def test_温湿度不是数字时也不是抛tracleback(self):
        bad = write_csv([("dorm-a", "2026-09-23 11:20:00", "不热", 60, "正常")], "bad.csv")
        text, code = capture(ml._main, [str(ml.DEFAULT_HISTORY), str(bad)])
        self.assertNotEqual(code, 0)
        self.assertIn("不是数字的值", text)
        self.assertIn("不热", text)
        self.assertNotIn("Traceback", text)

    def test_某一行多写一个逗号时报的也是人话(self):
        # 列数对不上时 pandas 会把第一列拿去当索引，行号/时刻都可能不是整数或字符串。
        # 这种文件要报「哪一列读不出数字」，不能反过来在报错的路上再崩一次
        # （报错时报错，比原来那个错难查得多）。
        ragged = write_csv([("dorm-a", "2026-09-23 11:20:00", 25, 60, "正常", "模拟", "多的一格")],
                           "ragged.csv")
        text, code = capture(ml._main, [str(ml.DEFAULT_HISTORY), str(ragged)])
        self.assertNotEqual(code, 0)
        self.assertNotIn("Traceback", text)
        self.assertIn("CSV", text)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace", line_buffering=True)
    unittest.main()
