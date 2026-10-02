"""replay_samples.py 的测试：构造样本发出去时长什么样（Phase8 D5）。

    py -3.14 -m unittest tests.test_replay_samples -v
    py -3.14 -m unittest discover -s tests -t .

**一条用例都不连 broker**：要验的是「发什么」，不是「发得出去配不出去」。
`--dry-run` 那条走完整条 main()（除了连网那一段），其余全直接调 build_messages。

重点盯四件事：

  1. **每条报文的 source 都是 constructed**，而且**不看样本里写没写** ——
     这个标记是「训练时跳过它们」的判据。漏一批，训练时那些极端值就会被当成
     常态学进去，之后 ML 反过来判它们正常：案例复现不出来，还一句错都不报。
     文件里显式声明了别的 source 要**当场停下**，不许静默照用。
  2. **样本自带的 time 原样用**。造这批样本的人挑的就是这些时刻；
     改成「现在」的话，几毫秒内发完的几条时间戳会一模一样，
     报告里那几行的先后就只能靠运气了。
  3. **status 由规则算出**，不从文件里读 —— 这份 JSON 里根本没有 status 字段，
     报文里那个必须等于 compute_status(温, 湿)。
  4. **文件坏了给人话、退出码 2**，不是甩一个 traceback。这份文件的用途就是
     触发差异，一个字段名写错（nodeId 写成 node）会让整批样本按同一个节点发出去，
     而现场只表现为「案例分析里怎么没有 dorm-b」—— 那要查很久。
"""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

import config
from simulator import replay_samples
from status_rules import compute_status

ROOT = Path(__file__).resolve().parent.parent
REAL_FILE = ROOT / "data" / "constructed_samples.json"


def sample(node="dorm-a", temperature=25, humidity=60, **extra):
    return {"node": node, "temperature": temperature, "humidity": humidity, **extra}


def payload_of(data: dict, **kwargs) -> dict:
    """只造一条样本时，拿回那条报文本身。"""
    return replay_samples.build_messages(data, **kwargs)[0]["payload"]


class SampleFileCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def write(self, payload, name="samples.json") -> Path:
        path = self.dir / name
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return path


# ======================================================================
# A. 仓库里那份真实样本
# ======================================================================

class TestTheCommittedFile(unittest.TestCase):
    """data/constructed_samples.json 是需求 4 要交的输入，它自己也得站得住。"""

    def setUp(self) -> None:
        self.data = replay_samples.load_samples(REAL_FILE)

    def test_it_loads_and_declares_the_constructed_source(self):
        self.assertEqual(self.data["source"], "constructed")
        self.assertEqual(replay_samples.source_of(self.data), "constructed")

    def test_it_covers_all_three_nodes(self):
        """三个宿舍都要有 —— 只喂 dorm-a 的话，「同一个模型判不同宿舍」这件事
        在报告里就没法对照（同一组温湿度、不同宿舍的 ML 结论可能不同）。"""
        nodes = {str(s["node"]) for s in self.data["samples"]}
        self.assertEqual(nodes, {"dorm-a", "dorm-b", "dorm-c"})

    def test_every_sample_carries_a_time(self):
        """样本自带 time：这些时刻是挑样本的人定的，脚本不该自己编。"""
        for index, item in enumerate(self.data["samples"]):
            with self.subTest(index):
                self.assertIn("time", item)

    def test_every_message_is_marked_constructed(self):
        """整份文件走一遍：条数对得上，而且**每一条**都带 constructed。

        单独抽一条来验是不够的：漏标记多半是漏在某一支分支上
        （比如「样本自己写了 source 就听它的」），那样只有那几条会错。
        """
        messages = replay_samples.build_messages(self.data, path=REAL_FILE)
        self.assertEqual(len(messages), len(self.data["samples"]))
        for item in messages:
            with self.subTest(item["node"]):
                self.assertEqual(item["payload"]["source"], "constructed")


# ======================================================================
# B. 文件形状不对就给人话
# ======================================================================

class TestBadFiles(SampleFileCase):
    def test_a_missing_file_says_where_it_should_be(self):
        with self.assertRaises(replay_samples.SampleError) as caught:
            replay_samples.load_samples(self.dir / "没有这个.json")
        self.assertIn("constructed_samples.json", str(caught.exception))

    def test_a_file_that_is_not_json(self):
        path = self.dir / "坏.json"
        path.write_text("这不是 JSON", encoding="utf-8")
        with self.assertRaises(replay_samples.SampleError) as caught:
            replay_samples.load_samples(path)
        self.assertIn("读不了", str(caught.exception))

    def test_no_samples_array(self):
        for payload in ({}, {"samples": []}, {"samples": "dorm-a"}):
            with self.subTest(payload):
                with self.assertRaises(replay_samples.SampleError):
                    replay_samples.load_samples(self.write(payload))

    def test_a_sample_missing_a_field_names_the_field(self):
        """字段名写错要指名道姓地说出来。

        这份文件里节点那个字段叫 `node`（不是别处的 nodeId）——
        写错的话整批样本会按同一个节点发出去，现场只表现为
        「案例分析里怎么没有 dorm-b」。
        """
        path = self.write({"samples": [{"nodeId": "dorm-a", "temperature": 25,
                                       "humidity": 60}]})
        with self.assertRaises(replay_samples.SampleError) as caught:
            replay_samples.load_samples(path)
        message = str(caught.exception)
        self.assertIn("node", message)
        self.assertIn("nodeId", message, "得把最容易写错的那个名字点出来")

    def test_non_numeric_readings_are_refused(self):
        """温湿度不是数字就停下。

        放过去的话，这一条会一路走到 build_payload 的 round(float(...)) 上崩掉 ——
        报的是「could not convert string to float」，看不出是哪一条样本。
        """
        for field in ("temperature", "humidity"):
            with self.subTest(field):
                bad = sample(**{field: "25"})
                with self.assertRaises(replay_samples.SampleError) as caught:
                    replay_samples.load_samples(self.write({"samples": [bad]}))
                self.assertIn(field, str(caught.exception))

    def test_true_is_not_a_number_here(self):
        """`True` 在 Python 里是 int 的子类 —— 不单独挡一下就被当 1 收下了。

        这和 history._cell() 把布尔当成缺值打空是同一种毛病：
        布尔不是读数，它只是恰好能参与运算。
        """
        with self.assertRaises(replay_samples.SampleError):
            replay_samples.load_samples(self.write({"samples": [sample(temperature=True)]}))

    def test_a_bad_time_is_refused_not_replaced(self):
        path = self.write({"samples": [sample(time="2026/09/26 10:00")]})
        with self.assertRaises(replay_samples.SampleError) as caught:
            replay_samples.load_samples(path)
        self.assertIn("time", str(caught.exception))

    def test_a_declared_source_other_than_constructed_stops_everything(self):
        """文件里声明了别的 source：**当场停下**，不静默用它。

        静默照用是最糟的写法 —— 脚本照跑、报文照发、CSV 照写，
        只是训练时这批样本不再被跳过。而那一头一句话都不会说。
        """
        with self.assertRaises(replay_samples.SampleError) as caught:
            replay_samples.source_of({"source": "sim"})
        message = str(caught.exception)
        self.assertIn("sim", message)
        self.assertIn("训练", message, "得说清这个标记是给谁用的、坏了会怎样")

    def test_no_source_declared_means_constructed(self):
        self.assertEqual(replay_samples.source_of({"samples": []}), "constructed")


# ======================================================================
# C. 要发的报文长什么样
# ======================================================================

class TestMessages(unittest.TestCase):
    def test_source_is_stamped_on_every_message(self):
        """样本里**没有** source 字段，报文里也必须每一条都是 constructed。"""
        data = {"samples": [sample(), sample(node="dorm-b"), sample(node="dorm-c")]}
        self.assertNotIn("source", data["samples"][0])
        for item in replay_samples.build_messages(data):
            with self.subTest(item["node"]):
                self.assertEqual(item["payload"]["source"], "constructed")

    def test_the_samples_own_time_is_used_verbatim(self):
        when = "2026-09-26 10:00:00"
        self.assertEqual(payload_of({"samples": [sample(time=when)]})["time"], when)

    def test_samples_without_a_time_are_spread_out(self):
        """没带 time 的按 `起点 + 序号 × 间隔` 排，一条比一条晚。

        挤在同一个时刻的话，报告里这几行的先后就只能靠运气，
        而「先规则后 ML」的对照表正是要按顺序读的。
        """
        start = datetime(2026, 9, 26, 10, 0, 0)
        data = {"samples": [sample(), sample(), sample()]}
        messages = replay_samples.build_messages(data, start=start, interval=2.0)
        self.assertEqual([item["payload"]["time"] for item in messages],
                         ["2026-09-26 10:00:00", "2026-09-26 10:00:02",
                          "2026-09-26 10:00:04"])

    def test_seq_is_what_tells_them_apart_under_a_second_apart(self):
        """默认间隔 0.3 秒，而统一格式只写到秒 —— 这几条的 time 会是同一个值。

        记下来是因为它会咬人：拿 time 当唯一键（比如「同一时刻只留最后一条」）
        的话，一批间隔小于一秒的样本会被当成同一条。先后由 seq 定，
        而**要交的那份 constructed_samples.json 每条都自带了 time，一秒一条**，
        所以真跑的时候这一步不会碰上。
        """
        start = datetime(2026, 9, 26, 10, 0, 0)
        messages = replay_samples.build_messages(
            {"samples": [sample(), sample()]}, start=start, interval=0.3)
        self.assertEqual([item["payload"]["time"] for item in messages],
                         ["2026-09-26 10:00:00"] * 2)
        self.assertEqual([item["payload"]["seq"] for item in messages], [1, 2])

    def test_the_status_comes_from_the_rule_not_the_file(self):
        """这份 JSON 里根本没有 status 字段，报文里那个必须是规则现算的。"""
        cases = [(18.5, 58, "正常"), (29.5, 60, "正常"), (31, 78, "偏热"),
                 (25, 80, "偏湿"), (16, 60, "偏冷")]
        for temperature, humidity, want in cases:
            with self.subTest(f"{temperature}/{humidity}"):
                payload = payload_of({"samples": [sample(temperature=temperature,
                                                         humidity=humidity)]})
                self.assertEqual(payload["status"], want)
                self.assertEqual(payload["status"],
                                 compute_status(temperature, humidity))

    def test_the_topic_is_the_node_telemetry_topic(self):
        """topic 按 dormmate/v1 规范，且必须是**这个样本自己的**节点。

        写死成 dorm-a 的话，构造样本全都会挂到 dorm-a 名下 ——
        而现场看上去只是「dorm-c 一条数据都没有」。
        """
        data = {"samples": [sample(node="dorm-a"), sample(node="dorm-c")]}
        for item in replay_samples.build_messages(data):
            with self.subTest(item["node"]):
                self.assertEqual(item["topic"], config.topic_for(item["node"]))
                self.assertEqual(item["topic"],
                                 f"dormmate/v1/nodes/{item['node']}/telemetry")

    def test_the_text_is_the_payload(self):
        """发出去的字符串和 payload 是同一份东西，不是各写一遍。"""
        item = replay_samples.build_messages({"samples": [sample()]})[0]
        self.assertEqual(json.loads(item["text"]), item["payload"])

    def test_the_rounding_happens_once(self):
        """保留一位小数在 build_payload 里做 —— 这里不该再凑一遍。"""
        payload = payload_of({"samples": [sample(temperature=18.456, humidity=58.44)]})
        self.assertEqual(payload["temperature"], 18.5)
        self.assertEqual(payload["humidity"], 58.4)

    def test_seq_starts_at_one_by_default(self):
        messages = replay_samples.build_messages({"samples": [sample(), sample()]})
        self.assertEqual([item["payload"]["seq"] for item in messages], [1, 2])

    def test_seq_base_is_honoured(self):
        """继续上一次的编号用（和 simulator 的 seq_base 一个口径）。"""
        messages = replay_samples.build_messages({"samples": [sample()]}, seq_base=40)
        self.assertEqual(messages[0]["payload"]["seq"], 41)


# ======================================================================
# D. 命令行（不连 broker）
# ======================================================================

def run(argv) -> tuple[int, str]:
    """跑一遍 main()，把 stdout **和 stderr** 一起收回来。

    出错那几句是打到 stderr 的（脚本自己分开了，好让人把计划看到底）——
    这里合并，因为要验的是「有没有说人话」，不是它打在哪个流上。
    """
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        return replay_samples.main(argv), out.getvalue()


class TestCommandLine(SampleFileCase):
    def test_dry_run_prints_the_plan_and_does_not_connect(self):
        """--dry-run 走完整条 main()（除了连网那一段），退出码 0。

        这一条是自测的主力：没有 broker 也能看出发的是什么。
        """
        path = self.write({"samples": [sample(node="dorm-a", temperature=18.5,
                                              humidity=58),
                                       sample(node="dorm-b")]})
        code, text = run(["--file", str(path), "--dry-run"])
        self.assertEqual(code, 0)
        self.assertIn("[Dry-run] 不连接 MQTT", text)
        self.assertIn("dormmate/v1/nodes/dorm-a/telemetry", text)
        self.assertIn("constructed", text)

    def test_dry_run_on_the_committed_file(self):
        code, text = run(["--file", str(REAL_FILE), "--dry-run"])
        self.assertEqual(code, 0)
        self.assertIn("构造样本 7 条", text)

    def test_a_broken_file_exits_two_instead_of_raising(self):
        """坏文件走**退出码**，不是异常 —— 它是流水线里的一步。"""
        path = self.write({"samples": [{"nodeId": "dorm-a", "temperature": 25,
                                        "humidity": 60}]})
        code, text = run(["--file", str(path), "--dry-run"])
        self.assertEqual(code, 2)
        self.assertIn("[错误]", text)

    def test_a_missing_file_exits_two(self):
        code, _ = run(["--file", str(self.dir / "没有这个.json"), "--dry-run"])
        self.assertEqual(code, 2)

    def test_a_negative_interval_is_refused(self):
        """负间隔会在 time.sleep 里抛 ValueError（还是那句「sleep length must be
        non-negative」），看不出是谁传的。所以在发之前就拦下。"""
        path = self.write({"samples": [sample()]})
        code, text = run(["--file", str(path), "--interval", "-1", "--dry-run"])
        self.assertEqual(code, 2)
        self.assertIn("--interval", text)

    def test_the_interval_comes_from_the_file_when_not_given(self):
        """文件里的 interval 是这批样本自己的节奏，命令行没给就听它的。

        走 main() 而不是自己把 `data["interval"]` 取出来递给 build_messages ——
        后者是我自己重写一遍那段逻辑，测了个寂寞。
        """
        path = self.write({"interval": 2.5, "samples": [sample()]})
        code, text = run(["--file", str(path), "--dry-run"])
        self.assertEqual(code, 0)
        self.assertIn("间隔 2.5s", text)

    def test_the_interval_flag_overrides_the_file(self):
        path = self.write({"interval": 2.5, "samples": [sample()]})
        code, text = run(["--file", str(path), "--interval", "1", "--dry-run"])
        self.assertEqual(code, 0)
        self.assertIn("间隔 1s", text)
        self.assertNotIn("间隔 2.5s", text)

    def test_a_relative_path_is_resolved_against_the_project_root(self):
        """`--file data/constructed_samples.json` 在哪个目录下敲都一样。

        真的换个目录再敲（chdir 到临时目录）—— 不换目录的话，这条用例在
        「按当前工作目录解析」那种写法下也照样是绿的，等于没测。
        """
        with contextlib.chdir(self.dir):
            code, text = run(["--file", "data/constructed_samples.json", "--dry-run"])
        self.assertEqual(code, 0)
        self.assertIn("构造样本 7 条", text)


if __name__ == "__main__":
    unittest.main()
