"""ml_judge.py 的测试：core 收到一条遥测时那句 ML 判词是怎么来的（Phase8 D5）。

    py -3.14 -m unittest tests.test_ml_judge -v
    py -3.14 -m unittest discover -s tests -t .

**绝大多数用例不装模型**：这个类的接口只有「读一批 .joblib、拿 predict 判一次」，
所以下面用几个几行的假模型就够了 —— `predict` 返回什么、`score_samples` 返回什么
全由测试说了算。真模型那一套（训练、参数、可复现）归 tests/test_train_iforest.py。

重点盯四件事：

  1. **判不了就是 None**，不是「判成 normal」。model_dir=None、目录不存在、
     目录里没模型、这个宿舍没模型、缺温湿度、模型给了不认识的标签 ——
     六种情况一个都不能自己编一个标签出来。CSV 那两列留空 = **没判**。
  2. **判决只走 model.predict()**。见 test_it_follows_predict_not_score_samples ——
     sklearn 的 predict 拿 decision_function < 0 切，和 score_samples < 0 是两套
     口径，实测在同一行上会分家。这条断言就是防有人改回去。
  3. **判词不拖垮 core**：模型坏了、预测抛异常，都只是这条链停用 + 记一句话，
     不往上抛。core 该判规则还判规则。
  4. **一个模型坏了不牵连别的宿舍**。三个 .joblib 里坏一个，另外两个照用 ——
     把小事故放大成三个宿舍都没有 ML，是这里最容易犯的错。
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import ml_judge
import rules

try:
    import joblib

    HAS_JOBLIB = True
except ImportError:                      # pragma: no cover
    HAS_JOBLIB = False


NORMAL = rules.STATUS_NORMAL


# ---------------------------------------------------------------- 假模型

class FakeModel:
    """只实现 predict 的模型。判词全看它返回什么，和 sklearn 无关。"""

    def __init__(self, label, predicted=None) -> None:
        self.label = label
        self.seen: list[list[float]] = []
        self.predicted = predicted if predicted is not None else []

    def predict(self, X):
        # 记下来：调用方到底把哪几个数递进来了（顺序不能反）。
        self.predicted.extend([list(row) for row in X])
        return [self.label for _ in X]


class DisagreeingModel(FakeModel):
    """predict 和 score_samples **故意说得不一样**的那种模型。

    sklearn 1.9.1 的 IsolationForest 就是这样：`predict` 拿
    `decision_function < 0` 切，而 `decision_function = score_samples - offset_`，
    `contamination="auto"` 时 `offset_` 是 -0.5 —— 于是
    `score_samples < 0` 是**另一套口径**。这个替身把两套口径摆在同一行上，
    谁被调用一眼可见。
    """

    def __init__(self, label, score) -> None:
        super().__init__(label)
        self.score = score
        self.score_called = 0
        self.decision_called = 0

    def score_samples(self, X):
        self.score_called += 1
        return [self.score for _ in X]

    def decision_function(self, X):
        self.decision_called += 1
        return [self.score for _ in X]


class ExplodingModel:
    def predict(self, X):                      # noqa: N803 —— 对齐 sklearn 的形参名
        raise RuntimeError("模型文件坏了")


class StrangeModel:
    """给了个 predict 只该给 1 或 -1 —— 它给了 0。"""

    def predict(self, X):
        return [0 for _ in X]


# ---------------------------------------------------------------- 家什

def record(temperature=31, humidity=78, status="偏热", node="dorm-a") -> dict:
    return {"nodeId": node, "temperature": temperature, "humidity": humidity,
            "status": status, "time": "2026-09-24 09:00:00"}


def judge_with(models: dict, model_dir=None, enabled: bool = True) -> ml_judge.MlJudge:
    """造一个**已经加载完**的判官，模型由调用方直接塞进去。

    这样跳过扫目录那一段：绝大多数用例要测的是「判得对不对」，
    不是「文件读得对不对」（后者另有几条用例，真的写 .joblib）。
    """
    judge = ml_judge.MlJudge(model_dir or Path("没有这个目录"), enabled=enabled)
    judge._loaded = True                  # 别再去扫磁盘
    judge.enabled = enabled
    judge.models.update(models)
    return judge


# ======================================================================
# A. 没配就没这功能
# ======================================================================

class TestDisabled(unittest.TestCase):
    def test_no_model_dir_means_no_ml_at_all(self):
        """model_dir=None = 不判 ML（和 Core 的 history_path 同一个默认）。

        这是**默认值**，测试里每造一个 Core 都去读一遍 joblib 的话，
        几千个用例就是几千次磁盘 I/O —— 所以这条默认必须守住。
        """
        judge = ml_judge.MlJudge(None)
        self.assertFalse(judge.enabled)
        self.assertIsNone(judge.judge(record()))
        self.assertIsNone(judge.take_error(), "没配模型不是错误，不该记一条")
        self.assertEqual(judge.describe(), "不判 ML（没给模型目录）")

    def test_enabled_false_stays_disabled(self):
        judge = ml_judge.MlJudge(Path("随便"), enabled=False)
        self.assertFalse(judge.enabled)
        # 造一个假 Core 时常用；塞了模型也不许判。
        judge.models["dorm-a"] = FakeModel(1)
        self.assertIsNone(judge.judge(record()))

    def test_a_missing_directory_is_not_an_error(self):
        """模型目录不存在**不是错误**：没跑过训练脚本的时候它本来就不存在。

        记成 error 的话，core 每次启动都会打一句「出错了」—— 而那不是出错，
        只是这个功能还没启用。所以走 describe()，take_error() 是空的。
        """
        with tempfile.TemporaryDirectory() as tmp:
            judge = ml_judge.MlJudge(Path(tmp) / "还没训过")
        self.assertIsNone(judge.judge(record()), "目录不在却在判")
        self.assertIsNone(judge.take_error(), "「还没训过」不是错误")
        self.assertIn("还不存在", judge.describe())
        self.assertIn("train_iforest.py", judge.describe(), "得说清怎么办")

    def test_an_empty_directory_is_not_an_error_either(self):
        with tempfile.TemporaryDirectory() as tmp:
            judge = ml_judge.MlJudge(tmp)
            self.assertIsNone(judge.judge(record()))
        self.assertIsNone(judge.take_error())
        self.assertIn("一个 .joblib 都没有", judge.describe())


# ======================================================================
# B. 判得对不对
# ======================================================================

class TestVerdict(unittest.TestCase):
    def test_inlier_is_normal_and_agree_follows_the_rule(self):
        """predict 给 1 -> normal；agree = 「规则和 ML 是不是同一个结论」。

        四条组合都要走一遍：**只测一个方向的话，把布尔写反了照样绿**。
        """
        cases = [
            (1, "正常", "normal", True, "两边都说没事"),
            (1, "偏热", "normal", False, "规则说异常、ML 说没事"),
            (-1, "正常", "abnormal", False, "规则说没事、ML 说异常"),
            (-1, "偏热", "abnormal", True, "两边都说异常"),
        ]
        for label, status, want_label, want_agree, why in cases:
            with self.subTest(why):
                judge = judge_with({"dorm-a": FakeModel(label)})
                verdict = judge.judge(record(status=status))
                self.assertEqual(verdict["ml_label"], want_label, why)
                self.assertEqual(verdict["ml_agree"], want_agree, why)

    def test_the_text_comes_from_ml_py(self):
        """给人看的那句中文取的是 ml.ml_text()，不在这里另写一份。

        看板直接把它贴出来 —— 两处各写一遍的话，同一个模型在报告里和看板上
        会叫两个名字。
        """
        from analysis import ml
        judge = judge_with({"dorm-a": FakeModel(-1)})
        self.assertEqual(judge.judge(record())["ml_text"], ml.ml_text(-1))
        judge = judge_with({"dorm-a": FakeModel(1)})
        self.assertEqual(judge.judge(record())["ml_text"], ml.ml_text(1))

    def test_it_passes_the_two_features_in_order(self):
        """递进去的必须是 [温度, 湿度] —— 反了的话模型会在错的轴上切，
        而它照样返回 1 或 -1，**一句错都不报**。"""
        model = FakeModel(1)
        judge_with({"dorm-a": model}).judge(record(temperature=31, humidity=78))
        self.assertEqual(model.predicted, [[31, 78]])

    def test_it_follows_predict_not_score_samples(self):
        """**判决只走 model.predict()** —— 这一条是防有人改回去的。

        sklearn 1.9.1 的 predict 拿 `decision_function < 0` 切，而
        `decision_function = score_samples - offset_`，`contamination="auto"`
        时 `offset_` 是 -0.5。在 data/dorm-a_history_sim.csv -> data/new_samples.csv
        上实测差 1/6 行（25/60 那条：predict 判 1、score_samples 是 -0.465）。

        所以这里造一个**两套口径说法相反**的模型：predict 说 -1（异常），
        score_samples 说 +0.5（没事）。结论必须跟着 predict 走。
        """
        model = DisagreeingModel(label=-1, score=0.5)
        verdict = judge_with({"dorm-a": model}).judge(record())
        self.assertEqual(verdict["ml_label"], "abnormal", "跟着 score_samples 走了")
        self.assertEqual(model.score_called, 0, "不该碰 score_samples")
        self.assertEqual(model.decision_called, 0,
                         "也不该自己去比 decision_function —— 那是 predict 内部的事")

    def test_no_model_for_this_node_is_not_an_error(self):
        """这个宿舍没模型 = 没判，不是错误，也不影响别的宿舍。

        训练时可用历史不够的宿舍就是这种（--min-rows）。把它记成错误的话，
        core 日志里会出现一条根本不存在的故障。
        """
        judge = judge_with({"dorm-b": FakeModel(1)})
        self.assertIsNone(judge.judge(record(node="dorm-a")))
        self.assertIsNone(judge.take_error())
        self.assertIsNotNone(judge.judge(record(node="dorm-b")), "别的宿舍被牵连了")

    def test_a_node_that_was_never_seen_is_not_an_error(self):
        judge = judge_with({"dorm-a": FakeModel(1)})
        self.assertIsNone(judge.judge(record(node="dorm-z")))
        self.assertIsNone(judge.take_error())

    def test_missing_readings_are_not_judged(self):
        """缺温湿度算不出「离历史有多远」。

        core 校验报文时已经把非数字挡掉了，这里兜的是「字段在、值是空」
        那一类。缺值不是错误，也**不该停用整条链** —— 下一条读数还有得判。
        """
        judge = judge_with({"dorm-a": FakeModel(1)})
        self.assertIsNone(judge.judge(record(temperature=None)))
        self.assertIsNone(judge.judge(record(humidity=None)))
        self.assertIsNone(judge.take_error())
        self.assertTrue(judge.enabled, "缺一条读数就把整条链停了")
        self.assertIsNotNone(judge.judge(record()), "后面那条还该照判")


# ======================================================================
# C. 判不出来不拖垮 core
# ======================================================================

class TestFailure(unittest.TestCase):
    def test_a_predicting_error_stops_the_chain_and_reports_once(self):
        """预测抛异常：记一句话、停用、**不往上抛**。

        core 是每收一条遥测判一次、一跑几小时的进程。一条读数判不了不是事故，
        而「每条遥测刷一行日志」会把真正要说的话淹掉 —— 所以是「停用 + 报一次」。
        """
        judge = judge_with({"dorm-a": ExplodingModel()})
        self.assertIsNone(judge.judge(record()))
        message = judge.take_error()
        self.assertIsNotNone(message)
        self.assertIn("dorm-a", message, "得说清是哪个宿舍的模型")
        self.assertIsNone(judge.take_error(), "同一条错误只报一次")
        self.assertFalse(judge.enabled)
        self.assertIsNone(judge.judge(record()), "停用之后一律不判")

    def test_an_unknown_label_stops_the_chain_too(self):
        """predict 只该给 1 或 -1。给了别的，写个默认值进 CSV 就是编。"""
        judge = judge_with({"dorm-a": StrangeModel()})
        self.assertIsNone(judge.judge(record()))
        self.assertIn("不认识的标签", judge.take_error())
        self.assertFalse(judge.enabled)

    def test_describe_says_why_it_stopped(self):
        judge = judge_with({"dorm-a": ExplodingModel()})
        judge.judge(record())
        self.assertTrue(judge.describe().startswith("不判 ML："))
        self.assertIn("预测时出错", judge.describe())


# ======================================================================
# D. 真的从磁盘上加载（要 joblib）
# ======================================================================

@unittest.skipUnless(HAS_JOBLIB, "没装 joblib")
class TestLoading(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def test_it_loads_every_joblib_in_the_directory(self):
        """文件名（去掉后缀）就是节点名 —— 训练端和加载端认的是同一个约定。"""
        joblib.dump({"which": "dorm-a"}, self.dir / "dorm-a.joblib")
        joblib.dump({"which": "dorm-b"}, self.dir / "dorm-b.joblib")
        # 不是 .joblib 的文件不该被当成模型读进来
        (self.dir / "MANIFEST.json").write_text("{}", encoding="utf-8")

        judge = ml_judge.MlJudge(self.dir)
        judge._ensure()
        self.assertEqual(sorted(judge.models), ["dorm-a", "dorm-b"])
        self.assertIsNone(judge.take_error())
        self.assertIn("加载了 2 个模型", judge.describe())

    def test_one_broken_model_does_not_take_down_the_others(self):
        """三个 .joblib 里坏一个：另外两个照用，只记一次。

        一个文件读不了就让另外两个宿舍也没有 ML，是把小事故放大。
        """
        joblib.dump({"which": "dorm-a"}, self.dir / "dorm-a.joblib")
        joblib.dump({"which": "dorm-c"}, self.dir / "dorm-c.joblib")
        # 不是 pickle 的一堆字节。别拿「半截 pickle」当坏文件：
        # b"\x80\x04K\x01." 其实是**合法的** pickle（协议 4 + 整数 1），
        # joblib 会老老实实把它读成 1 —— 那样这条用例就变成了空转。
        (self.dir / "dorm-b.joblib").write_bytes(b"not a joblib file")

        judge = ml_judge.MlJudge(self.dir)
        judge._ensure()
        self.assertEqual(sorted(judge.models), ["dorm-a", "dorm-c"])
        self.assertTrue(judge.enabled, "还有能用的模型，不该整条停用")
        self.assertIn("dorm-b.joblib", judge.take_error())

    def test_all_broken_stops_the_chain(self):
        (self.dir / "dorm-a.joblib").write_bytes(b"not a joblib file")
        judge = ml_judge.MlJudge(self.dir)
        judge._ensure()
        self.assertEqual(judge.models, {})
        self.assertFalse(judge.enabled)
        self.assertIn("一个都加载不了", judge.describe())

    def test_loading_happens_once(self):
        """_ensure 幂等：判一千条读数不该读一千次磁盘。"""
        joblib.dump({"which": "dorm-a"}, self.dir / "dorm-a.joblib")
        judge = ml_judge.MlJudge(self.dir)
        judge._ensure()
        first = judge.models["dorm-a"]
        judge._ensure()
        self.assertIs(judge.models["dorm-a"], first, "又读了一遍")

    def test_a_real_isolation_forest_judges_a_real_record(self):
        """真模型走一遍：predict 的结论就是判词的结论（不经过 joblib.load 的替身）。"""
        from analysis import ml
        model = ml.build_model([[24 + index * 0.1, 60 + index * 0.1] for index in range(20)])
        joblib.dump(model, self.dir / "dorm-a.joblib")

        judge = ml_judge.MlJudge(self.dir)
        for temperature, humidity in ((25, 60), (31, 78), (5, 5)):
            expected = int(model.predict([[temperature, humidity]])[0])
            verdict = judge.judge(record(temperature=temperature, humidity=humidity))
            self.assertEqual(verdict["ml_label"], ml.ML_STATUS[expected],
                             f"{temperature}/{humidity} 这条和 predict 对不上")


if __name__ == "__main__":
    unittest.main()
