"""train_iforest.py 的测试：按 nodeId 分别训练，构造样本一律不进训练集（Phase8 D5）。

    py -3.14 -m unittest tests.test_train_iforest -v
    py -3.14 -m unittest discover -s tests -t .

要 scikit-learn（和它带来的 joblib / numpy），所以用 py -3.14 跑；
没装时**整类跳过**而不是报错 —— 和 matplotlib 那几条一个待遇：
少一个可选的依赖不该让整个测试套件红掉。

重点盯四件事：

  1. **构造样本不进训练集**。这是本步骤唯一一条「错了也不报」的判据：
     把构造样本的极端值训进去，模型就认为那是常态，之后反过来判它们 normal，
     案例复现不出来 —— 而训练脚本会正常退出、模型文件也正常写出来。
  2. **分不出就不train**：没有 source 列、没有 nodeId 列，都当场停下（SystemExit），
     不是「当成都不是构造样本」接着跑。
  3. **一个宿舍一个文件**，节点名不能直接当文件名用时跳过它（防 ../ 这类穿越）。
  4. **同样的输入训两次，产物逐字节相同**（random_state=42）——
     不然每次重跑都是一份新 diff，而且「换一批数据效果变没变」就没法比。
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import ml_judge
from analysis import analysis, make_report, ml, train_iforest
from status_rules import compute_status

try:
    import sklearn  # noqa: F401

    HAS_SKLEARN = True
except ImportError:                      # pragma: no cover
    HAS_SKLEARN = False


# 和 history.py 的 HEADER 同一个顺序（十列）。
HEADER = ("time", "nodeId", "temperature", "humidity", "status", "ml_label",
          "event_id", "event_state", "source", "agree")


def values_of(node, temperature, humidity, source, when="2026-09-23 14:00:00"):
    """一行该有的东西，**按列名**放。"""
    return {"time": when, "nodeId": node, "temperature": temperature,
            "humidity": humidity, "status": compute_status(temperature, humidity),
            "source": source}


def row_for(header, node, temperature, humidity, source="sim",
            when="2026-09-23 14:00:00"):
    """按**给定的表头**排一行（少一列就少一格）。

    少列的那几条用例必须走这个，不能拿十格的行去配九列的表头：那样每格都会
    整体挪一位，'正常' 跑到 humidity 那一列去 —— 报出来的是「温湿度不是数字」，
    而真正想测的是「没有 source 列」。这个坑真踩过一次。
    """
    values = values_of(node, temperature, humidity, source, when)
    return tuple(values.get(name, "") for name in header)


def row_of(node, temperature, humidity, source, when="2026-09-23 14:00:00"):
    return row_for(HEADER, node, temperature, humidity, source, when)


def sim(node, temperature, humidity, when="2026-09-23 14:00:00"):
    return row_of(node, temperature, humidity, "sim", when)


def constructed(node, temperature, humidity, when="2026-09-24 09:00:00"):
    return row_of(node, temperature, humidity, "constructed", when)


def write_csv(path: Path, rows, header=HEADER) -> Path:
    text = ",".join(header) + "\n"
    text += "\n".join(",".join(str(cell) for cell in row) for row in rows)
    text += "\n"
    path.write_text(text, encoding="utf-8", newline="\n")
    return path


def spread(node: str, count: int, base_temperature: float = 25.0,
           base_humidity: float = 60.0):
    """`count` 条**各不相同的**正常读数。

    全一样的读数训出来的森林退化得厉害（谁都像谁都谁也不像谁），
    所以拿来测量的历史稍微散开一点 —— 这不是为了「让结果好看」，
    真实的历史本来就散着（模拟器 `--mode random` 就是 8~38 ℃ / 30~95 %）。
    """
    return [sim(node, base_temperature + index * 0.3, base_humidity + index * 0.4,
                f"2026-09-23 14:{index:02d}:00") for index in range(count)]


class TrainCase:
    """几份临时 CSV 的家什。**不是** TestCase —— 它自己一条用例都没有，
    挂成 TestCase 只会让 unittest 多加载一个空壳。下面的类各自
    `(TrainCase, unittest.TestCase)`。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.csv = self.dir / "history.csv"
        self.out = self.dir / "models"

    def train(self, rows, **kwargs):
        """只跑 train_all（不写 MANIFEST —— 那是 main() 干的活）。"""
        write_csv(self.csv, rows)
        return train_iforest.train_all(
            analysis.load(self.csv), self.csv, self.out,
            kwargs.pop("min_rows", 3), **kwargs)

    def run_main(self, rows, out=None, *flags) -> int:
        """写 CSV 再跑一整遍命令行，返回退出码。

        要验 MANIFEST 的用例得走这条：清单是 main() 写的，train_all 只负责
        拟合和落模型。拆成两个函数是故意的（清单里记的是「这次是怎么跑起来的」，
        不是「模型是什么」），所以测哪一层就用哪一层的入口。
        """
        write_csv(self.csv, rows)
        return train_iforest.main(["--csv", str(self.csv),
                                   "--out-dir", str(out or self.out), *flags])


# ======================================================================
# A. 「哪些行算构造样本」—— 全项目唯一一份判据
# ======================================================================

class TestIsConstructed(unittest.TestCase):
    """判据只有一处：拿 make_report.SOURCE_KINDS 比对。

    下面每个 token 都钉一遍 —— 自己在这里列第二份清单的话，
    那张表以后加一个词，这边会悄悄少跳过一类，而且不报错。
    """

    def test_the_known_constructed_tokens(self):
        for token in ("构造", "构造样本", "sample", "samples", "manual",
                      "constructed", "CONSTRUCTED", " 构造样本 "):
            with self.subTest(token):
                self.assertTrue(train_iforest.is_constructed(token), token)

    def test_the_things_that_are_not_constructed(self):
        """模拟器和剧本是**训练材料**，不是构造样本 —— 它们必须留在训练集里。

        这一条和上面一条一样重要：全判成构造样本的话，训练集就空了，
        而脚本只会说「可用的历史不足」，看着像数据不够，其实是判据写宽了。
        """
        for token in ("sim", "模拟", "模拟数据", "day_sim", "script", "cmd",
                      "web", "ui", "页面"):
            with self.subTest(token):
                self.assertFalse(train_iforest.is_constructed(token), token)

    def test_empty_and_unknown_are_not_constructed(self):
        """空值和不认识的 token 一律**不算**构造样本。

        不认识的更可能是现场数据。把它当构造样本丢掉，等于用一份少了数据的
        基准去判断所有读数 —— 而报告里只会显示「少了几条」，看不出错在哪。
        """
        for value in ("", None, "  ", "现场采集", "unknown"):
            with self.subTest(value):
                self.assertFalse(train_iforest.is_constructed(value), value)

    def test_it_uses_the_same_table_as_the_report(self):
        """这条判据和报告里那份分类表必须是**同一张**。

        两处各列一遍的话，报告说「构造样本 3 条」而训练时跳过了 5 条，
        谁都发现不了。
        """
        self.assertEqual(
            {token for token, kind in make_report.SOURCE_KINDS.items()
             if kind == make_report.CONSTRUCTED_KIND
             and train_iforest.is_constructed(token)},
            {token for token, kind in make_report.SOURCE_KINDS.items()
             if kind == make_report.CONSTRUCTED_KIND},
        )


# ======================================================================
# B. 缺列就停下
# ======================================================================

class TestRefuses(TrainCase, unittest.TestCase):
    def test_no_source_column_stops(self):
        """没有 source 列 = 分不出构造样本。

        这时**不能**当「全都是训练材料」接着跑：那份 CSV 到底混没混构造样本，
        从这个判据本身看不出来 —— 而猜错是静默的。
        """
        path = self.dir / "history.csv"
        header = [name for name in HEADER if name != "source"]
        write_csv(path, [row_for(header, "dorm-a", 25, 60)], header=header)
        with self.assertRaises(SystemExit) as caught:
            train_iforest.train_all(analysis.load(path), path, self.out, 1)
        self.assertIn("没有 source 列", str(caught.exception))

    def test_no_node_column_stops(self):
        path = self.dir / "history.csv"
        header = [name for name in HEADER if name != "nodeId"]
        write_csv(path, [row_for(header, "dorm-a", 25, 60)], header=header)
        with self.assertRaises(SystemExit) as caught:
            train_iforest.train_all(analysis.load(path), path, self.out, 1)
        self.assertIn("没有 nodeId 列", str(caught.exception))


# ======================================================================
# C. 谁训了、谁跳过了
# ======================================================================

class TestWhoGetsTrained(TrainCase, unittest.TestCase):
    def test_constructed_rows_are_skipped_and_counted(self):
        """构造样本被排除在训练集之外，而且**数得清楚**跳了几条。

        「跳了几条」是要写进 MANIFEST 的：只看输出文件的话，
        一个宿舍用了 3 条还是 30 条训出来的模型长得一模一样。
        """
        result = self.train(
            spread("dorm-a", 5) + [constructed("dorm-a", 5, 20),
                                   constructed("dorm-a", 38, 95)])

        info = result["nodes"]["dorm-a"]
        self.assertEqual(info["rows"], 7)
        self.assertEqual(info["constructedSkipped"], 2)
        self.assertTrue(info["trained"])

    def test_a_node_under_the_floor_is_skipped_not_trained(self):
        """可用历史不够就**不训**（也不是拿几条凑合训一个）。

        几条读数训出来的森林等于把「见过的那几条」背下来，
        之后判什么都是异常 —— 而文件照样写出来，看不出它有毛病。
        """
        result = self.train(spread("dorm-a", 2) + spread("dorm-b", 5), min_rows=3)
        self.assertNotIn("dorm-a", [n for n, i in result["nodes"].items() if i["trained"]])
        self.assertIn("只有 2 条", result["skipped"]["dorm-a"])
        self.assertTrue(result["nodes"]["dorm-b"]["trained"])
        self.assertEqual(result["trainedCount"], 1)

    def test_a_node_that_is_all_constructed_is_skipped_by_the_same_rule(self):
        """全构造样本的宿舍：走的是**同一条**判据（可用 0 条 < 下限）。

        不需要第二个分支 —— 多一个分支就多一处会走偏的地方。
        """
        result = self.train(spread("dorm-a", 5)
                            + [constructed("dorm-c", 16, 60)] * 4, min_rows=3)
        self.assertFalse(result["nodes"]["dorm-c"]["trained"])
        self.assertEqual(result["nodes"]["dorm-c"]["constructedSkipped"], 4)
        self.assertIn("只有 0 条", result["skipped"]["dorm-c"])

    def test_everything_skipped_gives_a_non_zero_exit_code(self):
        """一个模型都没出：**不抛异常**，但退出码非零。

        这条命令是流水线里的一步，「跑完了但什么都没出」得在脚本里看得见 ——
        等到看板上一条 ML 都没有再回来找原因就太晚了。
        """
        code = self.run_main([constructed("dorm-a", 5, 20)] * 4)
        self.assertEqual(code, 1)
        self.assertFalse((self.out / "MANIFEST.json").exists(),
                         "一个都没训出来还是写了清单")

    def test_a_node_name_that_cannot_be_a_file_name_is_skipped(self):
        """节点名不能直接当文件名用时跳过**那一个**宿舍，不做转义。

        转义要有一套「怎么写进去、怎么读回来」的对应规则，而节点名是配置里的
        东西 —— 起名的人本来就能起个正常的。更要紧的是防 ../ 这类穿越。
        """
        self.assertIsNone(train_iforest.model_file_name("../dorm-a"))
        self.assertIsNone(train_iforest.model_file_name("dorm a"))
        self.assertIsNone(train_iforest.model_file_name("dorm/a"))
        self.assertEqual(train_iforest.model_file_name("dorm-a_1"), "dorm-a_1.joblib")

    def test_an_unsafe_node_name_does_not_stop_the_others(self):
        result = self.train(spread("dorm-a", 5) + spread("../evil", 5), min_rows=3)
        self.assertTrue(result["nodes"]["dorm-a"]["trained"])
        self.assertIn("../evil", result["skipped"])
        self.assertEqual(result["trainedCount"], 1)


# ======================================================================
# D. 落盘（要 sklearn）
# ======================================================================

@unittest.skipUnless(HAS_SKLEARN, "没装 scikit-learn")
class TestOutput(TrainCase, unittest.TestCase):
    def test_it_writes_one_file_per_node_and_a_manifest(self):
        rows = spread("dorm-a", 5) + spread("dorm-b", 5, 28, 70)
        self.assertEqual(self.run_main(rows, self.out, "--min-rows", "3"), 0)

        self.assertEqual(sorted(p.name for p in self.out.glob("*.joblib")),
                         ["dorm-a.joblib", "dorm-b.joblib"])
        self.assertEqual(self.list_scratch(), [], "留下了 .tmp 残骸")

        manifest = json.loads((self.out / "MANIFEST.json").read_text(encoding="utf-8"))
        for key in ("csv", "outDir", "minRows", "nodes", "skipped", "trainedCount",
                    "features", "params", "sklearn"):
            self.assertIn(key, manifest, "清单少了这一格，看的人就得自己去猜")
        self.assertEqual(manifest["minRows"], 3)
        self.assertEqual(manifest["features"], ["temperature", "humidity"])
        self.assertEqual(manifest["sklearn"], train_iforest.sklearn_version())
        # 参数一份：训练端不重写一遍 MODEL_PARAMS，清单里记的是 ml.py 那份
        # （见 train_all 里的注释）—— 记下来的和真正用的必须是同一个。
        self.assertEqual(manifest["params"], dict(ml.MODEL_PARAMS))
        self.assertEqual(manifest["nodes"]["dorm-a"]["file"], "dorm-a.joblib")

    def test_drying_run_writes_nothing(self):
        self.assertEqual(
            self.run_main(spread("dorm-a", 5), self.out, "--min-rows", "3", "--dry-run"),
            0)
        self.assertFalse(self.out.exists(), "--dry-run 动了 models/")

    def test_training_twice_gives_byte_identical_models(self):
        """同一份 CSV 训两次，模型逐字节相同（random_state=42）。

        不然每次重跑都是一份新 diff，「换一批数据之后效果变没变」也没法比 ——
        两次的随机性会把要看的那点差别盖掉。

        **清单不参加逐字节比较**：里面的 generatedAt 是跑的时刻，天生不同。
        要比的是清单里那些决定产物的格（参数、特征、每个宿舍用了几条），
        所以下面是把它读成 JSON 再比 —— 拿字符串比的话，这条用例只会在
        「恰好同一秒跑完两次」时绿。
        """
        rows = spread("dorm-a", 6) + spread("dorm-b", 6, 28, 70)
        first, second = self.dir / "models-1", self.dir / "models-2"
        self.assertEqual(self.run_main(rows, first, "--min-rows", "3"), 0)
        self.assertEqual(self.run_main(rows, second, "--min-rows", "3"), 0)

        for name in ("dorm-a.joblib", "dorm-b.joblib"):
            with self.subTest(name):
                self.assertEqual((first / name).read_bytes(),
                                 (second / name).read_bytes(), name)

        left = json.loads((first / "MANIFEST.json").read_text(encoding="utf-8"))
        right = json.loads((second / "MANIFEST.json").read_text(encoding="utf-8"))
        # generatedAt 是跑的时刻；outDir 是这次写到哪儿 —— 两次本来就不同
        # （正是这条用例在拿两个目录比）。剩下的格子才是「这次是怎么训的」。
        for payload in (left, right):
            payload.pop("generatedAt")
            payload.pop("outDir")
        self.assertEqual(left, right, "两次训练记下来的不是同一件事")

    def test_the_judge_follows_the_model_it_just_trained(self):
        """训出来的模型**真的被判官用上了**：判词 == 这个模型自己的 predict。

        这里**故意不断言**「历史正中间那条一定判 normal」。实测：二十来条合成
        历史训出来的森林，score_samples 落在 -0.45 上下，而
        `contamination="auto"` 的 offset_ 是 -0.5 —— 阈值正好压在这一簇中间，
        里外都有一半的点被判 abnormal。那是 sklearn 在这个数据规模下的脾气
        （也正因如此 D5 才要拿真实历史去训、才要单独做案例分析），不是判官的对错。
        钉死一个标签，等于把「sklearn 怎么切这一刀」抄进测试：换个版本就红，
        而且红得没道理。

        要钉的是这条链：模型加载、递进去的两列顺序、1/-1 到 normal/abnormal 的映射。
        另外顺手确认这组探针把两个方向都走到了 —— 只走到一个方向的话，
        映射写反了也照样绿。

        探针拿的是**它自己那二十条历史**再加几条明显离群的：模型判自己见过的
        读数，正反两边都会有（实测二十条里十三条 normal、七条 abnormal）——
        这七条恰好把 D5 的题目摆在这儿：训练集里的读数照样可能被判 abnormal。
        """
        import joblib
        history = spread("dorm-a", 20)
        self.train(history, min_rows=3)
        judge = ml_judge.MlJudge(self.out)
        model = joblib.load(self.out / "dorm-a.joblib")

        probes = [(float(row[2]), float(row[3])) for row in history]
        probes += [(5, 5), (18.5, 58), (31, 78), (38, 95)]

        seen = set()
        for temperature, humidity in probes:
            with self.subTest(f"{temperature}/{humidity}"):
                expected = ml.ML_STATUS[int(model.predict([[temperature, humidity]])[0])]
                seen.add(expected)
                verdict = judge.judge({
                    "nodeId": "dorm-a", "temperature": temperature,
                    "humidity": humidity,
                    "status": compute_status(temperature, humidity)})
                self.assertIsNotNone(verdict, "刚训出来的模型加载不了")
                self.assertEqual(verdict["ml_label"], expected)

        self.assertEqual(seen, {"normal", "abnormal"},
                         "这组探针只走到一个方向，等于只测了一半")

    def list_scratch(self) -> list[str]:
        return sorted(p.name for p in self.out.glob("*.tmp"))


if __name__ == "__main__":
    unittest.main()
