"""rules.py 的测试：状态判定的转发 + 优先排序的四步判据。

运行：
    py -3.14 -m unittest tests.test_rules_priority -v
或：
    py -3.14 tests/test_rules_priority.py

**这个文件的核心不是「rules.py 能算对」，而是「它和 JS 算的是同一件事」。**
优先排序在两个语言里各写了一遍（core 要发快照，页面要显示），
期望值只留一份在 tests/fixtures/priority_cases.json，两边都读它。
tests/logic.test.js 里有一段读同一份文件 —— 改了 rules.py 而没改那边，
或者反过来，两边总有一边会红。
"""

from __future__ import annotations

import ast
import io
import json
import os
import sys
import tokenize
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import rules  # noqa: E402
import status_rules  # noqa: E402
from rules import (  # noqa: E402
    NodeView,
    format_duration,
    pick_priority,
    rank_priority,
    severity_of,
)

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "priority_cases.json"


def load_fixture() -> dict:
    with FIXTURE.open(encoding="utf-8") as handle:
        return json.load(handle)


FIX = load_fixture()


def views_of(case: dict) -> list[NodeView]:
    """把 fixture 里一条用例的 nodes 变成 NodeView。

    名字里的 durationSec 在这里显式换成 duration 参数 —— 单位换算只在这一处，
    出现第二次就说明有人的秒和毫秒要打架了。
    """
    return [
        NodeView(
            node_id=node["nodeId"],
            status=node["status"],
            count=node["count"],
            duration=node["durationSec"],
        )
        for node in case["nodes"]
    ]


def strip_comments_and_docstrings(source: str) -> str:
    """去掉注释和**文档字符串**之后剩下的源码，用来查「有没有写死节点名」。

    为什么不能图省事把字符串字面量全删掉：「写死节点名」最典型的形态正是

        if node_id == "dorm-a": ...

    那也是字符串字面量，一起删掉的话这个检查就永远绿，等于没有。
    所以只删两种：`#` 注释，和真正的文档字符串（模块 / 类 / 函数的
    第一个表达式语句）。剩下的字符串一个字都不动。
    """
    tree = ast.parse(source)

    # 文档字符串本身是字符串字面量，只能按行号认出来，不能按「是不是字符串」认
    doc_lines: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(
            node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
        ):
            continue
        body = getattr(node, "body", None)
        if (
            body
            and isinstance(body[0], ast.Expr)
            and isinstance(body[0].value, ast.Constant)
            and isinstance(body[0].value.value, str)
        ):
            doc = body[0].value
            end = doc.end_lineno or doc.lineno
            doc_lines.update(range(doc.lineno, end + 1))

    kept: list[str] = []
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type == tokenize.COMMENT:
            continue
        if token.type == tokenize.STRING and token.start[0] in doc_lines:
            continue
        kept.append(token.string)
    return "\n".join(kept)


class TestFixtureIsThere(unittest.TestCase):
    """期望表本身也要检查 —— 它坏掉的样子是「一条都跑不到」。"""

    def test_fixture_loaded(self):
        self.assertGreaterEqual(len(FIX["cases"]), 8)
        self.assertGreaterEqual(len(FIX["duration"]), 10)

    def test_fixture_lives_next_to_the_tests(self):
        self.assertTrue(FIXTURE.is_file(), f"期望表不见了：{FIXTURE}")


class TestJudgeStatusIsForwarded(unittest.TestCase):
    """judge_status 必须是 status_rules.compute_status **本人**，不是抄了一份。

    抄一份的话，将来改阈值只改一边，core 按旧规则判、发布端按新规则发，
    两边都不报错，只是同一份温湿度有两个 status。用 is 断言比用值断言狠：
    值一样也可能是两份实现，is 只认同一份。
    """

    def test_judge_status_is_the_same_object(self):
        self.assertIs(rules.judge_status, status_rules.compute_status)

    def test_thresholds_are_borrowed_not_copied(self):
        self.assertEqual(rules.TEMP_LOW, status_rules.TEMP_LOW)
        self.assertEqual(rules.TEMP_HIGH, status_rules.TEMP_HIGH)
        self.assertEqual(rules.HUMIDITY_HIGH, status_rules.HUMIDITY_HIGH)

    def test_regression_data_through_the_forwarder(self):
        """四组回归数据走一遍转发口 —— 和 analysis/rules.py 的自测同一个口径。"""
        for temperature, humidity, expected in [
            (25, 60, "正常"),
            (16, 60, "偏冷"),
            (31, 60, "偏热"),
            (25, 80, "偏湿"),
        ]:
            with self.subTest(temperature=temperature, humidity=humidity):
                self.assertEqual(rules.judge_status(temperature, humidity), expected)

    def test_hot_beats_humid(self):
        """31℃/80% 是偏热不是偏湿 —— 规则 2 先于规则 3，这条最容易写反。"""
        self.assertEqual(rules.judge_status(31, 80), "偏热")


class TestFormatDuration(unittest.TestCase):
    """时长说法和 JS 的 fmtDuration(ms) 逐字对齐 —— 期望值也是共用的那份。"""

    def test_shared_table(self):
        for row in FIX["duration"]:
            with self.subTest(seconds=row["seconds"]):
                self.assertEqual(format_duration(row["seconds"]), row["expect"])

    def test_seconds_and_ms_agree(self):
        """同一段时长，按秒喂给 Python、按毫秒喂给 JS，说出的话必须一样。

        这里只做 Python 这一半（JS 那一半在 logic.test.js 里）。之所以要有这条：
        「两边对齐」这件事最容易在**边界**上破掉 —— 59.9 秒到底算不算 1 分钟。
        """
        # 59.9 秒：JS 那边是 floor(59900/1000)=59 -> 不到 1 分钟
        self.assertEqual(format_duration(59.9), "不到 1 分钟")
        self.assertEqual(format_duration(60), "1 分钟")

    def test_bad_input_is_not_a_crash(self):
        """脏数据说的是「不到 1 分钟」，不是抛异常，也不是负数。"""
        for bad in [None, "60", True, False, float("nan"), float("inf"), -5, -0.5]:
            with self.subTest(bad=bad):
                self.assertEqual(format_duration(bad), "不到 1 分钟")


class TestSeverity(unittest.TestCase):
    def test_default_weights_cover_all_four_statuses(self):
        self.assertEqual(
            sorted(rules.SEVERITY_WEIGHTS.items()),
            sorted([("偏热", 3), ("偏湿", 2), ("偏冷", 1), ("正常", 0)]),
        )

    def test_hot_over_humid_over_cold(self):
        self.assertGreater(severity_of("偏热"), severity_of("偏湿"))
        self.assertGreater(severity_of("偏湿"), severity_of("偏冷"))
        self.assertGreater(severity_of("偏冷"), severity_of("正常"))

    def test_unknown_status_is_zero_not_a_crash(self):
        self.assertEqual(severity_of("不知道"), 0)
        self.assertEqual(severity_of(None), 0)


class TestSharedPriorityCases(unittest.TestCase):
    """共用期望表上的每一条。JS 那边读的是同一份文件。"""

    def test_every_case(self):
        for case in FIX["cases"]:
            with self.subTest(case=case["name"]):
                ranked = rank_priority(views_of(case))

                self.assertEqual(
                    [node.node_id for node in ranked],
                    case["order"],
                    f"{case['name']}：顺序不对",
                )
                self.assertEqual(
                    [node.rank for node in ranked],
                    list(range(1, len(ranked) + 1)),
                )
                for node in ranked:
                    self.assertEqual(
                        node.reason,
                        case["reasons"][node.node_id],
                        f"{case['name']}：{node.node_id} 的理由不对",
                    )

    def test_no_extra_reasons_in_table(self):
        """表里多写的理由条目 = 有节点没被排出来，或者期望值抄错了地方。"""
        for case in FIX["cases"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(
                    sorted(case["reasons"].keys()),
                    sorted(case["order"]),
                )

    def test_pick_priority_is_the_head(self):
        for case in FIX["cases"]:
            with self.subTest(case=case["name"]):
                top = pick_priority(views_of(case))
                head = rank_priority(views_of(case))
                if not case["order"]:
                    self.assertIsNone(top)
                else:
                    self.assertEqual(top, head[0])


class TestOnlyAbnormalNodesAreRanked(unittest.TestCase):
    """正常节点不进这一栏，也不该因为「它更严重」被选进来。"""

    def test_count_zero_is_filtered(self):
        ranked = rank_priority([
            NodeView("dorm-a", "偏热", 0, 999.0),   # 时长再长，正常就不算
            NodeView("dorm-b", "偏冷", 1, 60.0),
        ])
        self.assertEqual([node.node_id for node in ranked], ["dorm-b"])

    def test_empty_input_is_empty_list_not_none(self):
        """全部正常就是这种情形。返回 None 的话，每个调用方都得多一个分支。"""
        self.assertEqual(rank_priority([]), [])

    def test_none_entries_are_skipped(self):
        ranked = rank_priority([None, NodeView("dorm-b", "偏热", 2, 60.0)])
        self.assertEqual([node.node_id for node in ranked], ["dorm-b"])

    def test_negative_count_treated_as_not_abnormal(self):
        """和 JS 的 `abnormalCount > 0` 同一个判据，负数不算异常。"""
        self.assertEqual(rank_priority([NodeView("dorm-a", "偏热", -3, 60.0)]), [])


class TestDeterminismAndPurity(unittest.TestCase):
    def test_input_order_does_not_matter(self):
        """同一份数据换个到达顺序，结果必须一字不差。

        这是第 4 步（nodeId 字典序）存在的唯一理由：不是为了「更准」，
        是为了**确定**。少了它，dict 的遍历顺序一变就换了个人。
        """
        case = [c for c in FIX["cases"] if c["name"].startswith("第 1 步：")][0]
        forward = views_of(case)
        backward = list(reversed(forward))

        a = [(n.node_id, n.reason) for n in rank_priority(forward)]
        b = [(n.node_id, n.reason) for n in rank_priority(backward)]
        self.assertEqual(a, b)

    def test_called_twice_same_answer(self):
        case = FIX["cases"][2]
        self.assertEqual(rank_priority(views_of(case)), rank_priority(views_of(case)))

    def test_input_not_mutated(self):
        views = [NodeView("dorm-a", "偏热", 2, 60.0), NodeView("dorm-b", "偏冷", 1, 120.0)]
        snapshot = list(views)
        rank_priority(views)
        self.assertEqual(views, snapshot)

    def test_returns_new_objects_not_the_inputs(self):
        view = NodeView("dorm-a", "偏热", 2, 60.0)
        ranked = rank_priority([view])
        self.assertIsNot(ranked[0], view)


class TestWeightsOverride(unittest.TestCase):
    """权重可以被 core/config.json 覆盖（JS 那边写死，所以这条只在 Python 侧）。"""

    def test_override_changes_the_winner(self):
        """时长和次数都打平，只比严重度。把权重翻过来，赢家就得换人。"""
        views = [
            NodeView("dorm-a", "偏冷", 3, 360.0),
            NodeView("dorm-b", "偏热", 3, 360.0),
        ]
        default = rank_priority(views)
        self.assertEqual([n.node_id for n in default], ["dorm-b", "dorm-a"])

        flipped = rank_priority(views, weights={"偏冷": 9, "偏热": 1})
        self.assertEqual([n.node_id for n in flipped], ["dorm-a", "dorm-b"])
        # 理由跟着一起翻 —— 排序按新权重、说法按旧权重是最坏的一种不一致
        self.assertIn("更要紧", flipped[0].reason)
        self.assertIn("偏冷", flipped[0].reason)

    def test_missing_status_falls_back_to_zero(self):
        """覆盖表里没写的状态当 0，不炸也不猜。"""
        views = [
            NodeView("dorm-a", "偏冷", 1, 60.0),
            NodeView("dorm-b", "偏热", 1, 60.0),
        ]
        ranked = rank_priority(views, weights={"偏热": 5})
        self.assertEqual([n.node_id for n in ranked], ["dorm-b", "dorm-a"])

    def test_severity_field_follows_the_weights_used(self):
        views = [NodeView("dorm-a", "偏冷", 1, 60.0)]
        self.assertEqual(rank_priority(views)[0].severity, 1)
        self.assertEqual(rank_priority(views, weights={"偏冷": 7})[0].severity, 7)


class TestNoNodeNameIsHardcoded(unittest.TestCase):
    """「优先关注节点禁止写死」—— 节点从数据里来，不是从这个文件里来。

    查的是**源码**，不是行为：写死一个 default 节点、或者在理由里硬编一个名字，
    在只有那三个节点的场景里都测不出来，得等到换了节点才暴露。
    """

    def test_source_code_has_no_node_id(self):
        text = strip_comments_and_docstrings(
            (ROOT / "rules.py").read_text(encoding="utf-8")
        )
        self.assertNotIn(
            "dorm-", text,
            "rules.py 的代码里出现了节点名。节点是数据里来的，"
            "这个文件不该认识任何一个具体节点。",
        )

    def test_the_checker_can_actually_fail(self):
        """先证明这个检查**有牙**，再说上面那条通过有意义。

        一个永远绿的检查比没有检查更坏：它让人以为这件事被盯着。
        所以这里喂两段人造源码，一段该放过、一段该抓到 ——
        「抓不到真写法」和「把注释里的例子也抓了」两种坏法各钉一条。
        """
        with_comment_only = '''
def rank(nodes):
    """赢家写进理由，例如「dorm-b 已连续偏热 7 分钟」。"""
    # 以前这里写过 if node_id == "dorm-a"
    return sorted(nodes)
'''
        self.assertNotIn(
            "dorm-", strip_comments_and_docstrings(with_comment_only),
            "注释和文档字符串里的例子不该被当成写死",
        )

        with_hardcoded = '''
def rank(nodes):
    """排序。"""
    for node in nodes:
        if node.node_id == "dorm-a":
            return node
'''
        self.assertIn(
            "dorm-", strip_comments_and_docstrings(with_hardcoded),
            "代码里写死的节点名必须被抓到 —— 漏掉的话这个检查就是摆设",
        )

    def test_a_fourth_node_works_just_as_well(self):
        """fixture 里只有 dorm-a/b/c。换个名字，四步判据照样成立。"""
        ranked = rank_priority([
            NodeView("宿舍-2", "偏冷", 1, 60.0),
            NodeView("宿舍-1", "偏冷", 1, 60.0),
        ])
        # 时长和次数都一样 -> 字典序。中文按码位排，'1' 在 '2' 前面
        self.assertEqual([n.node_id for n in ranked], ["宿舍-1", "宿舍-2"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
