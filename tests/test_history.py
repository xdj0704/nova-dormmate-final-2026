"""history.py 的测试：十列历史行的写法，以及 core 挂上它之后写了什么（Phase7）。

运行：
    py -3.14 -m unittest tests.test_history -v

**不连 broker。** 递一个假 client，把 core 当机器摇：喂报文，看它往 CSV 里追加了
什么。真 broker 那条链路归 tests/broker_selftest.py 管。

这个文件不 import 别的测试模块（各测试文件之间不互相依赖是这个仓库的规矩）：
下面那个 FakeClient 和 payload_text 是有意重复的十几行 —— 从 tests/test_core.py
借过来的话，改那边的假 client 会连带把这边弄红，而报出来的错在这边看着莫名其妙。
"""

from __future__ import annotations

import csv
import io
import json
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

import core
import history
import rules

ROOT = Path(__file__).resolve().parent.parent

# 固定的"现在"，和 test_core.py 一个口径：传进去而不是让它读 time.time()，
# 否则「离线 30 秒」这类判定会跟着跑得多快而飘。
NOW = 1_700_000_000.0

# data/ 下那几份手写 CSV 的表头是它，Phase7 定的那九列加 Phase8 D5 追加的
# agree 也是它 —— 两处必须是同一个顺序，不然同一批数据在两种文件里长得不一样。
#
# agree 是**追加在末尾**的（不是插在 ml_label 后面）：前九列的位置一个字都没动，
# 因为 history.py 的文件头承诺过「人拿 Excel 打开时看的是位置」。加在中间的话，
# 之前照着列号读这些 CSV 的脚本全都会读错一格，而且不会报错。
EXPECTED_HEADER = ["time", "nodeId", "temperature", "humidity", "status",
                   "ml_label", "event_id", "event_state", "source", "agree"]


def payload_text(node_id="dorm-a", temperature=31, humidity=78, status="偏热",
                 when="2026-09-22 20:30:00", **extra) -> str:
    body = {
        "nodeId": node_id, "temperature": temperature, "humidity": humidity,
        "status": status, "time": when,
    }
    body.update(extra)
    return json.dumps(body, ensure_ascii=False)


def topic_of(node_id: str) -> str:
    """topic 由 config 拼，测试里不自己写 —— 形状改过一回了。"""
    import config
    return config.topic_for(node_id)


class FakeClient:
    def __init__(self) -> None:
        self.published: list[dict] = []

    def publish(self, topic, payload=None, qos=0, retain=False, properties=None):
        self.published.append({"topic": topic, "payload": payload})
        return None

    def subscribe(self, topic, qos=0, options=None, properties=None):
        return (0, 1)


class _Message:
    def __init__(self, topic: str, payload: bytes) -> None:
        self.topic = topic
        self.payload = payload


class _StubJudge:
    """假判官，只给「core 的接线对不对」这件事用（真模型那套归 test_ml_judge.py）。

    它**不说**「像不像历史」，一律判 abnormal —— 那件事这里不关心。
    但 `ml_agree` 必须**真算**：它是「规则和 ML 是不是同一个结论」，
    规则那一半读的是 record 里 core 自己算好的 status。
    core 的接线只要有一处把布尔写反了，这里就会红。
    """

    enabled = True

    def judge(self, record):
        ml_normal = False                     # 一律判「不像历史常态」
        rule_normal = record.get("status") == rules.STATUS_NORMAL
        return {
            "ml_label": "abnormal",
            "ml_text": "与历史明显不同",
            "ml_agree": rule_normal == ml_normal,
        }

    def take_error(self):
        return None

    def describe(self):
        return "替身判官（测试用）"


class HistoryCase(unittest.TestCase):
    """共用的家什：临时目录、读回 CSV 的小工具、造 core 的工厂。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.path = self.tmp / "history.csv"
        self.addCleanup(self._tmp.cleanup)

    # -- 读回来 -----------------------------------------------------------

    def read_raw(self) -> bytes:
        return self.path.read_bytes()

    def read_rows(self) -> list[list[str]]:
        """数据行（不含表头）。用 csv 模块读，省得自己切引号。"""
        return list(csv.reader(io.StringIO(self.read_text()))) [1:]

    def read_text(self) -> str:
        """按 UTF-8 **去掉 BOM** 读出来 —— csv 模块不认 BOM，留着的话
        第一列列名会变成 "\\ufefftime"。analysis/analysis.py 读文件走的是
        encoding="utf-8-sig"，同一个理。"""
        return self.read_raw().decode("utf-8-sig")

    def header_of_file(self) -> list[str]:
        return next(csv.reader(io.StringIO(self.read_text())))

    def column(self, name: str) -> list[str]:
        return [row[EXPECTED_HEADER.index(name)] for row in self.read_rows()]

    # -- 造 core ---------------------------------------------------------

    def make_core(self, **overrides):
        """按**真实的那份** core/config.json 造一个 core（不用手写的假配置）。"""
        cfg = core.load_config()
        cfg.update(overrides)
        client = FakeClient()
        return core.Core(cfg, client=client, quiet=True,
                         history_path=self.path), client

    def deliver(self, c, client, node_id="dorm-a", temperature=31, humidity=78,
                status="偏热", when="2026-09-22 20:30:00", **extra) -> None:
        """走 on_message 这条真路径投一条报文（和 broker 送来时一模一样）。"""
        raw = payload_text(node_id, temperature, humidity, status, when,
                           **extra).encode("utf-8")
        c.on_message(client, None, _Message(topic_of(node_id), raw))


# ======================================================================
# A. writer 本身
# ======================================================================

class TestHeader(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = Path(self._tmp.name) / "h.csv"

    def test_ten_columns_in_order(self):
        self.assertEqual(list(history.HEADER), EXPECTED_HEADER,
                         "十列的名字和顺序定死了，下游按列名读、人按位置看")

    def test_header_literal_matches_expectation(self):
        """上一条测的是 history.HEADER 本身。这一条把期望值**再写一遍**成字符串，
        防的是「两边一起被改错」——只测 HEADER 的话，十列改成十一列也没人吭一声。"""
        self.assertEqual(
            "time,nodeId,temperature,humidity,status,ml_label,event_id,"
            "event_state,source,agree", ",".join(EXPECTED_HEADER))

    def test_written_header_is_the_same_ten(self):
        w = history.HistoryWriter(self.path)
        w.append({"time": "2026-09-22 20:30:00", "nodeId": "dorm-a",
                  "temperature": 25, "humidity": 60, "status": "正常"})
        w.close()
        with io.open(self.path, encoding="utf-8-sig", newline="") as fh:
            self.assertEqual(fh.readline().rstrip("\r\n"),
                             ",".join(EXPECTED_HEADER))

    def test_bom_is_written_once(self):
        """data/ 下那几份 CSV 都是 UTF-8 BOM。BOM 只该有一个，而且只在开头 ——
        append 模式下用 utf-8-sig 编码的话，每开一次都会再补一个。"""
        w = history.HistoryWriter(self.path)
        w.append({"time": "t1", "nodeId": "dorm-a"})
        w.close()
        again = history.HistoryWriter(self.path)
        again.append({"time": "t2", "nodeId": "dorm-a"})
        again.close()

        raw = self.path.read_bytes()
        self.assertEqual(raw[:3], b"\xef\xbb\xbf", "开头没有 BOM")
        self.assertEqual(raw.count(b"\xef\xbb\xbf"), 1, "BOM 不止一个")

    def test_header_only_once_across_reopen(self):
        """core 重启一次就重写一份表头的话，文件中间会冒出一行表头。"""
        for stamp in ("t1", "t2", "t3"):
            w = history.HistoryWriter(self.path)
            w.append({"time": stamp, "nodeId": "dorm-a"})
            w.close()
        text = self.path.read_text(encoding="utf-8-sig")
        self.assertEqual(text.count("time,nodeId,temperature"), 1)
        self.assertEqual(len(text.strip().splitlines()), 4)   # 表头 + 三行

    def test_an_old_nine_column_file_stops_the_writer(self):
        """Phase8 D5 之前的九列文件：**停下**，不往上接十格的行。

        这份文件是只追加的档案，九列表头会继续吃十格的行 —— 读的时候 agree
        落进 csv 的 restkey 被静默丢掉，Excel 里多出一个没名字的列，而日志
        一句都不说。所以就地把话说明白，由写的人决定是留档还是重开一份。
        """
        before = b"\xef\xbb\xbf" + (
            "time,nodeId,temperature,humidity,status,ml_label,event_id,"
            "event_state,source\r\n").encode("utf-8")
        self.path.write_bytes(before)

        w = history.HistoryWriter(self.path)
        self.assertFalse(w.append({"time": "t1", "nodeId": "dorm-a"}),
                         "旧格式的文件还在往里写")
        self.assertFalse(w.enabled)
        self.assertEqual(self.path.read_bytes(), before, "旧文件被动了")

        message = w.take_error()
        self.assertIn("9 列", message)
        self.assertIn("10 列", message)
        self.assertIn("agree", message, "得让人知道差的是哪一列")

    def test_it_does_not_raise_on_an_old_format_file(self):
        """停写走的是**返回值**，不是异常 —— core 每收一条遥测都调一次 append。

        _open() 停写之后 self._writer 是 None，append 里紧接着的 writerow 会抛
        AttributeError，而那一层只接 OSError / csv.Error —— 这个洞会让 core
        崩在一条读不上来的历史文件上，而它和「宿舍是不是偏热」没有关系。
        """
        self.path.write_text("time,nodeId\r\n", encoding="utf-8", newline="")
        w = history.HistoryWriter(self.path)
        self.assertFalse(w.append({"time": "t1", "nodeId": "dorm-a"}))
        self.assertIn("已停写", w.describe())

    def test_a_matching_header_keeps_appending(self):
        """表头对得上就照常接着写 —— 别把「重启之后续上」这条路给堵了。"""
        first = history.HistoryWriter(self.path)
        first.append({"time": "t1", "nodeId": "dorm-a"})
        first.close()

        again = history.HistoryWriter(self.path)
        self.assertTrue(again.append({"time": "t2", "nodeId": "dorm-a"}))
        again.close()
        text = self.path.read_text(encoding="utf-8-sig")
        self.assertEqual(len(text.strip().splitlines()), 3)   # 表头 + 两行

    def test_crlf_every_line_no_bare_lf(self):
        """data/ 下那几份 CSV 都是 CRLF（.gitattributes 给 data/*.csv 定的）。
        混进裸 LF 的话，Excel 打开是一些、记事本打开是另一些。"""
        w = history.HistoryWriter(self.path)
        w.append({"time": "t1", "nodeId": "dorm-a"})
        w.append({"time": "t2", "nodeId": "dorm-a"})
        w.close()
        raw = self.path.read_bytes()
        self.assertEqual(raw.count(b"\r\n"), 3, "表头 + 两行 = 三个 CRLF")
        self.assertEqual(raw.count(b"\n"), 3, "有裸 LF")


class TestRowOf(unittest.TestCase):
    """一格一格地看：row_of() 是纯函数，不用碰文件。"""

    def row(self, **record) -> list[str]:
        return history.HistoryWriter(None).row_of(record)

    def test_full_record(self):
        row = self.row(time="2026-09-22 20:30:00", nodeId="dorm-b",
                       temperature=31, humidity=78, status="偏热",
                       source="sim")
        self.assertEqual(row, ["2026-09-22 20:30:00", "dorm-b", "31", "78",
                               "偏热", "", "", "", "sim", ""])

    def test_numbers_are_trimmed_like_the_handwritten_csvs(self):
        """25.0 写成 25、57.60 写成 57.6 —— 和 data/ 下那几份一个口径。
        不归一的话，同一列里会同时出现 25 和 25.0，看着像两种东西。"""
        self.assertEqual(self.row(temperature=25)[2], "25")
        self.assertEqual(self.row(temperature=25.0)[2], "25")
        self.assertEqual(self.row(temperature=23.5)[2], "23.5")
        self.assertEqual(self.row(humidity=57.6)[3], "57.6")

    def test_missing_is_empty_not_none(self):
        row = self.row(nodeId="dorm-a")
        self.assertEqual(row[2], "", "缺的温度写成了别的东西")
        self.assertNotIn("None", row)

    def test_bool_is_not_a_number(self):
        """bool 是 int 的子类，但「温度是 True」没有意义。"""
        self.assertEqual(self.row(temperature=True)[2], "")

    def test_ml_label_comes_from_core_and_is_empty_when_it_did_not_judge(self):
        """ml_label 是 core **在线判的**（Phase8 D5，理由见 history.py 文件头）。

        writer 自己不造这个值：记录上没有 ml_label 就写空 ——
        **留空表示「没判」，不是「判成正常」**。这一条钉的就是后半句：
        没判的时候那一格必须和「有值」长得不一样。"""
        self.assertEqual(self.row(time="t", nodeId="dorm-a")[5],
                         history.ML_LABEL_EMPTY)
        self.assertEqual(history.ML_LABEL_EMPTY, "")
        self.assertEqual(self.row(time="t", nodeId="dorm-a", ml_label="abnormal")[5],
                         "abnormal")

    def test_agree_is_a_string_token_not_a_bool(self):
        """第 10 列必须是 yes / no 两个词，不能是 Python 的 True/False。

        `_cell()` 把 bool 当缺值打成空串（「温度是 True 没有意义」，见
        test_bool_is_not_a_number），写个真布尔进去这一格就**永远是空的**——
        而「没判」和「判了不一致」在这份 CSV 里就长得一模一样了。
        所以 core 那边挂在 record 上的是布尔 ml_agree，翻译成 yes/no 只发生在
        `_agree_cell()` 这一处。"""
        self.assertEqual(self.row(time="t", ml_agree=True)[9], history.AGREE_YES)
        self.assertEqual(self.row(time="t", ml_agree=False)[9], history.AGREE_NO)
        self.assertEqual(self.row(time="t", ml_agree=None)[9], history.AGREE_EMPTY)
        # 自己拿字符串写进去的那条老路也不通：读的是 ml_agree 这个键
        self.assertEqual(self.row(time="t", agree="yes")[9], "")
        self.assertEqual([history.AGREE_YES, history.AGREE_NO], ["yes", "no"])

    def test_no_ml_verdict_means_agree_is_empty_too(self):
        """没判 ML 的记录，agree 也一定空着。

        这两个空在报告里是分开讲的（「没判」不是「判了不一致」），
        所以不能出现「有 agree 没 ml_label」这种半截状态 ——
        core 那边是一次写三个键、成对出现的。"""
        row = self.row(time="t", nodeId="dorm-a")
        self.assertEqual([row[5], row[9]], ["", ""])

    def test_event_columns(self):
        row = history.HistoryWriter(None).row_of(
            {"time": "t", "nodeId": "dorm-a"},
            event_id="dorm-a-20260922-203000", event_state="OPEN")
        self.assertEqual(row[6], "dorm-a-20260922-203000")
        self.assertEqual(row[7], "OPEN")

    def test_row_width_equals_header(self):
        """行宽和表头对不上的话，csv 读出来会错位 —— 而错位以后
        「湿度」那一列里其实是状态，看不出来。"""
        self.assertEqual(len(self.row(nodeId="dorm-a")), len(history.HEADER))
        self.assertEqual(len(self.row()), len(history.HEADER))


class TestWriterLifecycle(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)

    def test_disabled_when_no_path(self):
        """path=None 就是**不碰磁盘**（和 Core 的 events_path 同一个默认）。"""
        w = history.HistoryWriter(None)
        self.assertFalse(w.enabled)
        self.assertFalse(w.append({"time": "t", "nodeId": "dorm-a"}))
        self.assertIsNone(w.path)

    def test_enabled_flag_off(self):
        w = history.HistoryWriter(self.tmp / "h.csv", enabled=False)
        self.assertFalse(w.append({"time": "t", "nodeId": "dorm-a"}))
        self.assertFalse((self.tmp / "h.csv").exists(), "关掉了还是建了文件")

    def test_creates_parent_directory(self):
        w = history.HistoryWriter(self.tmp / "deep" / "deeper" / "h.csv")
        self.assertTrue(w.append({"time": "t", "nodeId": "dorm-a"}))
        w.close()
        self.assertTrue((self.tmp / "deep" / "deeper" / "h.csv").exists())

    def test_close_is_idempotent(self):
        w = history.HistoryWriter(self.tmp / "h.csv")
        w.append({"time": "t", "nodeId": "dorm-a"})
        w.close()
        w.close()          # 第二次不该抛
        self.assertEqual(w.rows, 1)

    def test_rows_counts_only_written_ones(self):
        w = history.HistoryWriter(self.tmp / "h.csv")
        self.assertEqual(w.append_all([{"time": str(i)} for i in range(5)]), 5)
        self.assertEqual(w.rows, 5)
        w.close()

    def test_describe_says_what_happened(self):
        self.assertIn("不写", history.HistoryWriter(None).describe())
        w = history.HistoryWriter(self.tmp / "h.csv")
        w.append({"time": "t", "nodeId": "dorm-a"})
        self.assertIn("1", w.describe())
        w.close()

    # -- 写不进去的时候 ---------------------------------------------------

    def test_write_failure_does_not_raise_and_stops(self):
        """磁盘满、文件被 Excel 独占、目录被删 —— 这些和「宿舍是不是偏热」
        没有关系，不能让它们把 core 带走。

        这里让路径指向一个**目录**：open(path, "a") 会 IsADirectoryError，
        正好是「打不开」这一类。
        """
        w = history.HistoryWriter(self.tmp)
        self.assertFalse(w.append({"time": "t", "nodeId": "dorm-a"}))
        self.assertIsNotNone(w.error)
        self.assertFalse(w.enabled, "出错之后应该停写")

        # 停写之后接着喂：不抛、不返回成功，也不再把错误攒起来
        self.assertFalse(w.append({"time": "t2", "nodeId": "dorm-a"}))
        self.assertEqual(w.rows, 0)

    def test_error_is_reported_once(self):
        """core 只在出错那一刻打一行日志 —— 每条都打的话现场日志会被刷满。"""
        w = history.HistoryWriter(self.tmp)
        w.append({"time": "t", "nodeId": "dorm-a"})
        self.assertIsNotNone(w.take_error())
        self.assertIsNone(w.take_error(), "同一条错误被取了两次")

    def test_no_error_when_nothing_went_wrong(self):
        w = history.HistoryWriter(self.tmp / "h.csv")
        self.addCleanup(w.close)
        w.append({"time": "t", "nodeId": "dorm-a"})
        self.assertIsNone(w.take_error())


# ======================================================================
# B. core 挂上 writer 之后
# ======================================================================

class TestCoreWiring(HistoryCase):
    def test_off_by_default(self):
        """默认不碰磁盘：造一个 Core 不等于「现在该往 data/ 写文件了」。"""
        cfg = core.load_config()
        c = core.Core(cfg, client=FakeClient(), quiet=True)
        self.assertIsNone(c.history_path)
        self.assertFalse(c.history_writer.enabled)

    def test_one_valid_message_writes_one_row(self):
        c, client = self.make_core()
        self.deliver(c, client, node_id="dorm-b", temperature=25, humidity=80,
                     status="偏湿", when="2026-09-22 20:30:00", source="sim")
        c.history_writer.close()

        self.assertEqual(len(self.read_rows()), 1)
        self.assertEqual(self.column("time"), ["2026-09-22 20:30:00"])
        self.assertEqual(self.column("nodeId"), ["dorm-b"])
        self.assertEqual(self.column("temperature"), ["25"])
        self.assertEqual(self.column("humidity"), ["80"])
        self.assertEqual(self.column("status"), ["偏湿"])
        self.assertEqual(self.column("source"), ["sim"])

    def test_header_is_the_ten_columns(self):
        c, client = self.make_core()
        self.deliver(c, client)
        c.history_writer.close()
        self.assertEqual(self.header_of_file(), EXPECTED_HEADER)

    def test_status_column_is_computed_not_copied(self):
        """**红线**：status 必须由温湿度算。报文里报「正常」而实际是偏热时，
        CSV 里那列必须写 core 算出来的「偏热」。

        照抄报文里那个 status 的话，网页端哪天规则写错了，这份历史表会跟着
        一起错 —— 而且错得**看不出来**：每一行都有个看起来很像样的状态。
        """
        c, client = self.make_core()
        self.deliver(c, client, temperature=31, humidity=60, status="正常")
        c.history_writer.close()
        self.assertEqual(self.column("status"), ["偏热"])

    def test_regression_cases_all_land_in_the_csv(self):
        """老师给的四组回归数据走一遍，逐行对 —— 和 status_rules.py 那四组同源。"""
        cases = [
            (25, 60, "正常"), (16, 60, "偏冷"),
            (31, 60, "偏热"), (25, 80, "偏湿"),
        ]
        c, client = self.make_core()
        for temperature, humidity, _expected in cases:
            self.deliver(c, client, temperature=temperature, humidity=humidity,
                         status="正常")
        c.history_writer.close()
        self.assertEqual(self.column("temperature"),
                         [str(t) for t, _h, _s in cases])
        self.assertEqual(self.column("status"), [s for _t, _h, s in cases])

    def test_rejected_message_is_not_written(self):
        """校验不过的报文不进历史 —— 它是「现场数据」，不是「有人发了什么」。"""
        c, client = self.make_core()
        bad = json.dumps({"nodeId": "dorm-a", "temperature": "不热",
                          "humidity": 60, "status": "正常",
                          "time": "2026-09-22 20:30:00"}, ensure_ascii=False)
        c.on_message(client, None, _Message(topic_of("dorm-a"), bad.encode("utf-8")))
        self.deliver(c, client)          # 一条合法的
        c.history_writer.close()
        self.assertEqual(len(self.read_rows()), 1)


class TestEventColumnsInCsv(HistoryCase):
    """event_id / event_state 两列的时点 —— 这是这一步最容易写错的地方。"""

    def feed(self, c, client, statuses, start_minute=0):
        """按顺序喂一串状态。每 5 分钟一条，和现场一个节奏。

        start_minute 是从 20:00 起算的**分钟偏移**，不是分钟数本身 ——
        拿 "20:%02d:00" 拼的话，偏移一过 59 就拼出 "20:100:00" 这种
        连时间都不是的字符串，core 会按「time 格式不对」把它整条丢掉，
        而测试会红在一条跟时间无关的断言上。
        """
        base = datetime(2026, 9, 22, 20, 0, 0)
        for index, status in enumerate(statuses):
            moment = (base + timedelta(minutes=start_minute + index * 5)).strftime(
                "%Y-%m-%d %H:%M:%S")
            temperature, humidity = {
                "偏热": (31, 60), "正常": (25, 60),
            }[status]
            self.deliver(c, client, temperature=temperature, humidity=humidity,
                         status=status, when=moment)

    def test_opening_row_carries_the_new_case_id(self):
        """开案的那一条异常读数**自己**就该带着刚开出来的案号 ——
        它属于那条案卷，它是案卷的第一条。"""
        c, client = self.make_core()
        self.feed(c, client, ["正常", "偏热"])
        c.history_writer.close()

        event_id, event_state = self.column("event_id"), self.column("event_state")
        self.assertEqual(event_id[0], "", "还没开案的那条不该有案号")
        self.assertTrue(event_id[1].startswith("dorm-a-"), event_id[1])
        self.assertEqual(event_state[1], "OPEN")
        self.assertEqual(event_id[1], c.event_book.events[-1].event_id,
                         "CSV 里的案号不是 event_book 里那个")

    def test_rows_inside_the_case_share_the_id(self):
        c, client = self.make_core()
        self.feed(c, client, ["正常", "偏热", "偏热", "偏热"])
        c.history_writer.close()
        ids = self.column("event_id")
        self.assertEqual(ids[0], "")
        self.assertEqual(len(set(ids[1:])), 1, "同一段异常里换过案号")

    def test_closing_row_still_carries_the_case(self):
        """凑够 N 条正常的那一条（recoverConsecutiveNormal=3）是**验证数据**，
        它属于那条案卷 —— 结案之后 open_event() 就没了，得靠「进来时记下的
        那一条」把它接上。"""
        recover = core.load_config()["recoverConsecutiveNormal"]
        c, client = self.make_core()
        self.feed(c, client, ["正常", "偏热"] + ["正常"] * (recover - 1))
        case_id = c.event_book.events[-1].event_id

        # 第 recover 条正常 —— 就是它把案子收掉的
        self.feed(c, client, ["正常"], start_minute=5 * 20)
        c.history_writer.close()

        rows = self.read_rows()
        last = rows[-1]
        self.assertEqual(last[EXPECTED_HEADER.index("event_id")], case_id,
                         "收案那条把案号丢了")
        self.assertEqual(last[EXPECTED_HEADER.index("event_state")], "RECOVERED",
                         "收案那条记的该是收成什么状态")

    def test_plain_reading_after_the_case_has_no_id(self):
        """案子结掉之后的普通读数留空 —— 拿 last_for() 攀一条早就结掉的案子
        是编：那一条读数跟那条案卷没有关系。"""
        recover = core.load_config()["recoverConsecutiveNormal"]
        c, client = self.make_core()
        self.feed(c, client, ["正常", "偏热"] + ["正常"] * recover)
        self.feed(c, client, ["正常", "正常"], start_minute=5 * 30)
        c.history_writer.close()

        event_id = self.column("event_id")
        event_state = self.column("event_state")
        self.assertEqual(event_id[-1], "")
        self.assertEqual(event_state[-1], "")

    def test_without_models_both_ml_columns_stay_empty(self):
        """没配模型目录时，ml_label 和 agree 两列**每一行都是空的**。

        Phase8 D5 起 ml_label 不再「永远是空」了（core 会在线判），但**没模型**
        的时候仍然空 —— 而留空的意思是「没判」，不是「判成正常」。
        这一条守的就是这个默认：make_core() 没传 model_dir，于是 MlJudge
        什么都不加载，一个标签都不许出现在 CSV 里。
        """
        c, client = self.make_core()
        self.assertFalse(c.ml_judge.enabled, "没传 model_dir 就不该去读模型")
        self.feed(c, client, ["正常", "偏热", "偏热", "正常", "正常", "正常"])
        c.history_writer.close()
        self.assertEqual(set(self.column("ml_label")), {""},
                         "没模型却在 ml_label 里造了值")
        self.assertEqual(set(self.column("agree")), {""},
                         "没判 ML 却写了 agree —— 「没判」和「判了不一致」"
                         "在这份 CSV 里必须长得不一样")

    def test_a_verdict_from_core_lands_in_both_columns(self):
        """core 判了的时候，第 6 列和第 10 列**成对**落下来。

        判官是个替身（真模型那套归 tests/test_ml_judge.py），这一条测的是
        core 的接线：判词挂到那条 record 上之后，CSV 和快照两条出口都看得见，
        而且看见的是同一个结论。

        agree 那两个值故意取成一 no 一 yes —— 只测一个方向的话，
        把布尔写反了这个测试照样绿。"""
        c, client = self.make_core()
        c.ml_judge = _StubJudge()
        self.deliver(c, client, temperature=31, humidity=78, status="偏热")
        self.deliver(c, client, temperature=25, humidity=60, status="正常")
        c.history_writer.close()

        self.assertEqual(self.column("ml_label"), ["abnormal", "abnormal"])
        # 偏热那条：规则说异常、ML 也说异常 -> 一致（yes）
        # 正常那条：规则说正常、ML 说异常     -> 不一致（no）
        self.assertEqual(self.column("agree"),
                         [history.AGREE_YES, history.AGREE_NO],
                         "两边是同一个结论才是 yes —— 这个对应关系写反了")

    def test_file_survives_a_core_restart(self):
        """core 重启是常事（改完代码重跑）。重启之后接着 append，
        表头不许再来一份，行也不许丢。"""
        c, client = self.make_core()
        self.feed(c, client, ["正常", "偏热"])
        c.history_writer.close()

        c2, client2 = self.make_core()
        self.feed(c2, client2, ["偏热"], start_minute=5 * 20)
        c2.history_writer.close()

        self.assertEqual(len(self.read_rows()), 3)
        self.assertEqual(self.header_of_file(), EXPECTED_HEADER)
        self.assertEqual(
            self.path.read_text(encoding="utf-8-sig").count("time,nodeId"), 1,
            "重启后又写了一次表头")

    def test_two_nodes_keep_their_own_cases(self):
        """三间房是三条独立的案卷，别把 dorm-a 的案号写到 dorm-b 的行上。"""
        c, client = self.make_core()
        self.deliver(c, client, node_id="dorm-a", temperature=31, humidity=60,
                     status="偏热", when="2026-09-22 20:00:00")
        self.deliver(c, client, node_id="dorm-b", temperature=25, humidity=80,
                     status="偏湿", when="2026-09-22 20:00:05")
        c.history_writer.close()

        ids = dict(zip(self.column("nodeId"), self.column("event_id")))
        self.assertNotEqual(ids["dorm-a"], ids["dorm-b"])
        self.assertTrue(ids["dorm-a"].startswith("dorm-a-"))
        self.assertTrue(ids["dorm-b"].startswith("dorm-b-"))


if __name__ == "__main__":
    unittest.main()
