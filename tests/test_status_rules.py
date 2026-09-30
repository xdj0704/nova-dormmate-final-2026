"""状态判定回归测试。

运行：
    python -m unittest discover -s tests -t . -v
或：
    python tests/test_status_rules.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import unittest
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from simulator import build_payload, dumps  # noqa: E402
from status_rules import compute_status  # noqa: E402

TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")


class TestStatusRegression(unittest.TestCase):
    """老师给的 4 条回归数据：任何改动后必须全绿。"""

    def test_25_60_is_normal(self):
        self.assertEqual(compute_status(25, 60), "正常")

    def test_16_60_is_cold(self):
        self.assertEqual(compute_status(16, 60), "偏冷")

    def test_31_60_is_hot(self):
        self.assertEqual(compute_status(31, 60), "偏热")

    def test_25_80_is_humid(self):
        self.assertEqual(compute_status(25, 80), "偏湿")


class TestStatusPriority(unittest.TestCase):
    """优先级：偏冷 > 偏热 > 偏湿 > 正常。"""

    def test_hot_beats_humid(self):
        # 约定里点名的例子：31/80 是偏热，不是偏湿
        self.assertEqual(compute_status(31, 80), "偏热")

    def test_cold_beats_humid(self):
        self.assertEqual(compute_status(10, 90), "偏冷")

    def test_cold_beats_hot_range(self):
        self.assertEqual(compute_status(0, 60), "偏冷")

    def test_humid_only_when_comfortable_temperature(self):
        self.assertEqual(compute_status(24, 100), "偏湿")


class TestBoundaries(unittest.TestCase):
    """边界值是 <、>= 的分界点，最容易被改错。"""

    def test_18_is_not_cold(self):
        self.assertEqual(compute_status(18, 60), "正常")

    def test_17_9_is_cold(self):
        self.assertEqual(compute_status(17.9, 60), "偏冷")

    def test_30_is_hot(self):
        self.assertEqual(compute_status(30, 60), "偏热")

    def test_29_9_is_normal(self):
        self.assertEqual(compute_status(29.9, 60), "正常")

    def test_75_is_humid(self):
        self.assertEqual(compute_status(25, 75), "偏湿")

    def test_74_9_is_normal(self):
        self.assertEqual(compute_status(25, 74.9), "正常")


class TestPayloadShape(unittest.TestCase):
    """统一 JSON：字段名、类型、time 格式，一个都不能错。"""

    def setUp(self):
        self.payload = build_payload("dorm-a", 31, 78)

    def test_keys_exact(self):
        # 统一 JSON 的前五个字段原样、顺序不动；Phase1 在后面追加 seq / source
        self.assertEqual(
            list(self.payload.keys()),
            ["nodeId", "temperature", "humidity", "status", "time", "seq", "source"],
        )

    def test_types(self):
        self.assertIsInstance(self.payload["nodeId"], str)
        self.assertIsInstance(self.payload["temperature"], float)
        self.assertIsInstance(self.payload["humidity"], float)
        self.assertIsInstance(self.payload["status"], str)
        self.assertIsInstance(self.payload["time"], str)
        self.assertIsInstance(self.payload["seq"], int)
        self.assertIsInstance(self.payload["source"], str)

    def test_seq_and_source_defaults(self):
        # 不给就用默认值：seq=0（不参与序列）、source=sim
        self.assertEqual(self.payload["seq"], 0)
        self.assertEqual(self.payload["source"], "sim")

    def test_status_matches_rule(self):
        self.assertEqual(self.payload["status"], "偏热")

    def test_time_format(self):
        self.assertRegex(self.payload["time"], TIME_RE)
        # 再确认它真的能被解析回来
        datetime.strptime(self.payload["time"], "%Y-%m-%d %H:%M:%S")

    def test_status_never_taken_from_caller(self):
        # 传错的值也算得出来，且结果由规则决定
        self.assertEqual(build_payload("dorm-a", 16, 90)["status"], "偏冷")
        self.assertEqual(build_payload("dorm-a", 25, 60)["status"], "正常")

    def test_json_is_readable_chinese(self):
        raw = dumps(self.payload)
        self.assertIn("偏热", raw)          # 中文没有被转义成 \uXXXX
        self.assertNotIn("\\u", raw)
        self.assertEqual(json.loads(raw), self.payload)

    def test_node_id_is_echoed(self):
        self.assertEqual(build_payload("dorm-b", 25, 60)["nodeId"], "dorm-b")


class TestTopicConvention(unittest.TestCase):
    def test_topic_pattern(self):
        from config import TOPIC_PATTERN, topic_for

        self.assertEqual(topic_for("dorm-a"), "dormmate/v1/nodes/dorm-a/telemetry")
        # 约定的 <nodeId> 位置与订阅通配符对得上：都在第 4 段（下标 3）
        self.assertEqual(TOPIC_PATTERN, "dormmate/v1/nodes/+/telemetry")
        self.assertEqual(topic_for("dorm-a").split("/")[3], "dorm-a")
        self.assertEqual(topic_for("dorm-a").split("/")[4], "telemetry")


if __name__ == "__main__":
    unittest.main(verbosity=2)
