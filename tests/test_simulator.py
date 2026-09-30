"""Phase1 模拟器：多节点、seq 计数、cooling 降温、json 剧本。

不用起 broker —— 这些都是在测「要发什么」，不是「发得出去吗」。
发送那一层是 paho 的事，真要验就连 broker 跑 simulator/broker_selftest.py。

    py -3.14 -m unittest discover -s tests -t .
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from simulator.simulator import (  # noqa: E402
    COOLING_START,
    COOLING_TARGET,
    DEMO_SEQUENCE,
    SOURCE_MANUAL,
    NodeState,
    ScriptError,
    build_payload,
    cooling_sample,
    demo_sample,
    load_script,
    main,
    parse_args,
    resolve_nodes,
)
from status_rules import compute_status  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEMO_SCRIPT = ROOT / "simulator" / "scenarios" / "phase1_demo.json"


def write_tmp(text: str, suffix: str = ".json", encoding: str = "utf-8") -> Path:
    """写一个临时剧本文件，返回路径（调用方负责删）。"""
    fd, name = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    path = Path(name)
    path.write_text(text, encoding=encoding)
    return path


class TestNodeState(unittest.TestCase):
    """seq 是「这个节点第几条」，所以按节点各数各的。"""

    def test_从1开始(self):
        self.assertEqual(NodeState("dorm-a").next_seq(), 1)

    def test_每发一条加一(self):
        state = NodeState("dorm-a")
        self.assertEqual([state.next_seq() for _ in range(3)], [1, 2, 3])

    def test_两个节点各数各的(self):
        a, b = NodeState("dorm-a"), NodeState("dorm-b")
        a.next_seq()
        a.next_seq()
        self.assertEqual(a.seq, 2)
        self.assertEqual(b.seq, 0)
        self.assertEqual(b.next_seq(), 1)

    def test_step是采样次数与seq无关(self):
        # step 记「取到第几个采样点」，seq 记「第几条消息」。刻意分开：
        # demo 模式给节点错开起点时只动 step，seq 还是老老实实从 1 开始。
        state = NodeState("dorm-a", step=2, seq=7)
        self.assertEqual(demo_sample(state.step), DEMO_SEQUENCE[2])
        self.assertEqual(state.next_seq(), 8)


class TestPayloadPhase1(unittest.TestCase):
    def test_seq和source写进去(self):
        payload = build_payload("dorm-b", 31, 78, seq=5, source=SOURCE_MANUAL)
        self.assertEqual(payload["seq"], 5)
        self.assertEqual(payload["source"], "manual")

    def test_status还是算出来的(self):
        # 写进去的温湿度多离谱都不影响这条：status 只认规则
        self.assertEqual(build_payload("dorm-a", 31, 80)["status"], "偏热")
        self.assertEqual(build_payload("dorm-a", 16, 90)["status"], "偏冷")

    def test_seq给小数也当整数写(self):
        self.assertEqual(build_payload("dorm-a", 25, 60, seq=3.0)["seq"], 3)
        self.assertIsInstance(build_payload("dorm-a", 25, 60, seq=3.0)["seq"], int)


class TestCooling(unittest.TestCase):
    """风扇降温：温度自己降下去，状态随之回到正常。"""

    def test_从偏热一路降到正常(self):
        statuses = [compute_status(*cooling_sample(i)) for i in range(5)]
        self.assertEqual(statuses, ["偏热", "偏热", "正常", "正常", "正常"])

    def test_每轮降固定度数(self):
        temps = [cooling_sample(i)[0] for i in range(4)]
        self.assertEqual(temps, [33.0, 31.0, 29.0, 27.0])

    def test_降到目标就保持不再往下(self):
        temps = [cooling_sample(i)[0] for i in range(12)]
        self.assertEqual(temps[-1], COOLING_TARGET)
        self.assertEqual(temps[-3:], [COOLING_TARGET] * 3)

    def test_不会降到偏冷(self):
        # 这个模式演示的是「从偏热回到正常」，多一个偏冷反而看不清
        self.assertGreaterEqual(min(cooling_sample(i)[0] for i in range(50)), 18.0)

    def test_湿度保持不动(self):
        # 只有温度在变，归因才清楚：状态变了是温度越过 30，不是湿度
        self.assertEqual({cooling_sample(i)[1] for i in range(5)}, {COOLING_START[1]})

    def test_降温幅度可以调(self):
        self.assertEqual(cooling_sample(1, step_size=5)[0], 28.0)


class TestScript(unittest.TestCase):
    """json 剧本：一轮一帧，repeat 展开，comment 跳过。"""

    def test_读出帧序列(self):
        path = write_tmp(json.dumps({
            "frames": [
                {"node": "dorm-a", "temperature": 25, "humidity": 60},
                {"node": "dorm-b", "temperature": 31, "humidity": 78, "repeat": 2},
            ]
        }))
        try:
            frames, interval = load_script(path)
        finally:
            path.unlink()
        self.assertEqual(frames, [
            ("dorm-a", 25.0, 60.0),
            ("dorm-b", 31.0, 78.0),
            ("dorm-b", 31.0, 78.0),
        ])
        self.assertIsNone(interval)

    def test_只写comment的帧跳过(self):
        path = write_tmp(json.dumps({
            "frames": [{"comment": "第一阶段"}, {"temperature": 25, "humidity": 60}]
        }))
        try:
            frames, _ = load_script(path)
        finally:
            path.unlink()
        self.assertEqual(frames, [("dorm-a", 25.0, 60.0)])   # 没写 node 就用 dorm-a

    def test_剧本能带自己的间隔(self):
        path = write_tmp(json.dumps({"interval": 2, "frames": [
            {"temperature": 25, "humidity": 60}]}))
        try:
            _, interval = load_script(path)
        finally:
            path.unlink()
        self.assertEqual(interval, 2.0)

    def test_温湿度原样读成小数(self):
        path = write_tmp(json.dumps({"frames": [
            {"node": "dorm-c", "temperature": "16.5", "humidity": 60}]}))
        try:
            frames, _ = load_script(path)
        finally:
            path.unlink()
        self.assertEqual(frames, [("dorm-c", 16.5, 60.0)])   # 字符串数字也认

    def test_文件不在时说人话(self):
        with self.assertRaises(ScriptError) as ctx:
            load_script(ROOT / "simulator" / "scenarios" / "根本没有这个文件.json")
        self.assertIn("找不到剧本文件", str(ctx.exception))

    def test_不是json时说人话(self):
        path = write_tmp("{这不是 json")
        try:
            with self.assertRaises(ScriptError) as ctx:
                load_script(path)
        finally:
            path.unlink()
        self.assertIn("不是合法的 JSON", str(ctx.exception))

    def test_存成GBK时说人话(self):
        # 记事本另存为「ANSI」就是这个结果。里面得有中文才触发得了解码错误：
        # 纯 ASCII 的 GBK 和 UTF-8 是同一串字节，读得出来。
        path = write_tmp('{"description": "宿舍", "frames": [{"temperature": 25, "humidity": 60}]}',
                         encoding="gbk")
        try:
            with self.assertRaises(ScriptError) as ctx:
                load_script(path)
        finally:
            path.unlink()
        self.assertIn("不是 UTF-8", str(ctx.exception))

    def test_最外层不是对象时说人话(self):
        path = write_tmp('[1, 2, 3]')
        try:
            with self.assertRaises(ScriptError) as ctx:
                load_script(path)
        finally:
            path.unlink()
        self.assertIn("最外层要是一个对象", str(ctx.exception))

    def test_frames是空的说人话(self):
        path = write_tmp('{"frames": []}')
        try:
            with self.assertRaises(ScriptError) as ctx:
                load_script(path)
        finally:
            path.unlink()
        self.assertIn("至少要有一帧", str(ctx.exception))

    def test_帧缺字段时说人话(self):
        path = write_tmp('{"frames": [{"node": "dorm-a", "temperature": 25}]}')
        try:
            with self.assertRaises(ScriptError) as ctx:
                load_script(path)
        finally:
            path.unlink()
        self.assertIn("缺 temperature 或 humidity", str(ctx.exception))

    def test_温度不是数字时说人话(self):
        path = write_tmp('{"frames": [{"temperature": "热", "humidity": 60}]}')
        try:
            with self.assertRaises(ScriptError) as ctx:
                load_script(path)
        finally:
            path.unlink()
        self.assertIn("不是数字", str(ctx.exception))

    def test_repeat不合法时说人话(self):
        for bad in (0, -1, 1.5, True):
            path = write_tmp(json.dumps({"frames": [
                {"temperature": 25, "humidity": 60, "repeat": bad}]}))
            try:
                with self.assertRaises(ScriptError) as ctx:
                    load_script(path)
            finally:
                path.unlink()
            self.assertIn("repeat 要是 ≥1 的整数", str(ctx.exception))

    def test_全是comment也说没数据(self):
        path = write_tmp('{"frames": [{"comment": "只有一句话"}]}')
        try:
            with self.assertRaises(ScriptError) as ctx:
                load_script(path)
        finally:
            path.unlink()
        self.assertIn("没有一帧是真的数据", str(ctx.exception))

    def test_仓库里那份演示剧本是好的(self):
        # 剧本文件本身也要有测试兜着，不然它坏了没人知道
        frames, interval = load_script(DEMO_SCRIPT)
        self.assertEqual(interval, 2.0)
        self.assertEqual([f[0] for f in frames],
                         ["dorm-a", "dorm-b", "dorm-c", "dorm-b", "dorm-b",
                          "dorm-c", "dorm-a", "dorm-a"])
        # 三个节点各出现至少一次，且状态覆盖三种
        statuses = {compute_status(t, h) for _, t, h in frames}
        self.assertEqual(statuses, {"偏冷", "正常", "偏热", "偏湿"})


class TestResolveNodes(unittest.TestCase):
    """--node / --nodes / --all-nodes 三种写法的归一。"""

    def resolve(self, argv):
        return resolve_nodes(parse_args(argv))

    def test_默认一个节点(self):
        self.assertEqual(self.resolve([]), ["dorm-a"])

    def test_单节点(self):
        self.assertEqual(self.resolve(["--node", "dorm-b"]), ["dorm-b"])

    def test_逗号分开多个(self):
        self.assertEqual(self.resolve(["--nodes", "dorm-a,dorm-c"]), ["dorm-a", "dorm-c"])

    def test_逗号两边有空格也认(self):
        self.assertEqual(self.resolve(["--nodes", "dorm-a, dorm-b"]), ["dorm-a", "dorm-b"])

    def test_all_nodes就是三个(self):
        self.assertEqual(self.resolve(["--all-nodes"]), ["dorm-a", "dorm-b", "dorm-c"])

    def test_三种写法同时给就报错(self):
        with self.assertRaises(ScriptError) as ctx:
            self.resolve(["--all-nodes", "--nodes", "dorm-a"])
        self.assertIn("只能用一个", str(ctx.exception))

    def test_nodes是空的说人话(self):
        with self.assertRaises(ScriptError) as ctx:
            self.resolve(["--nodes", " , "])
        self.assertIn("--nodes 是空的", str(ctx.exception))

    def test_未知节点不拦(self):
        # 拿 dorm-z 发数据是 D4 要用的手段（看板必须挡住未知节点），不能拦
        self.assertEqual(self.resolve(["--node", "dorm-z"]), ["dorm-z"])


class TestMainDryRun(unittest.TestCase):
    """跑一遍 main()，看终端上到底打了什么。全程 --dry-run，不碰 broker。"""

    def run_main(self, argv):
        # 正常输出走 stdout、出错走 stderr，这里合到一个缓冲区里一起断言 ——
        # 对使用者来说两条都是终端上看得见的字，不该因为流向不同就断不到。
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(buf):
            code = main(argv)
        return code, buf.getvalue()

    def published(self, out):
        """把终端输出里发出去的那几行解析回 dict。"""
        out_list = []
        for line in out.splitlines():
            if "telemetry  {" in line:
                # 从第一个 { 开始截，别把 { 自己切掉 —— 切掉之后 json.loads
                # 会把裸的 "nodeId" 当成合法字符串收下，错得很安静。
                out_list.append(json.loads(line[line.index("{"):]))
        return out_list

    def test_三节点一轮三条(self):
        code, out = self.run_main(["--all-nodes", "--count", "1", "--dry-run"])
        self.assertEqual(code, 0)
        published = [ln for ln in out.splitlines() if "telemetry  {" in ln]
        self.assertEqual(len(published), 3)
        for node in ("dorm-a", "dorm-b", "dorm-c"):
            self.assertIn(f"dormmate/v1/nodes/{node}/telemetry", out)

    def test_三节点这轮状态各不相同(self):
        # demo 模式错开起点，否则三张卡长得一模一样，演示看不出是三个宿舍
        _, out = self.run_main(["--all-nodes", "--count", "1", "--dry-run"])
        statuses = [ln.split('"status": "')[1].split('"')[0]
                    for ln in out.splitlines() if "telemetry  {" in ln]
        self.assertEqual(statuses, ["偏冷", "正常", "偏湿"])

    def test_seq每轮加一且按节点各数各的(self):
        _, out = self.run_main(["--all-nodes", "--count", "2", "--dry-run", "--interval", "0.01"])
        seqs = self.published(out)
        by_node = {}
        for payload in seqs:
            by_node.setdefault(payload["nodeId"], []).append(payload["seq"])
        self.assertEqual(by_node, {"dorm-a": [1, 2], "dorm-b": [1, 2], "dorm-c": [1, 2]})

    def test_剧本跑完就停不循环(self):
        code, out = self.run_main(["--script", str(DEMO_SCRIPT), "--dry-run",
                                   "--interval", "0.01"])
        self.assertEqual(code, 0)
        published = [ln for ln in out.splitlines() if "telemetry  {" in ln]
        self.assertEqual(len(published), 8)
        self.assertIn("剧本跑完", out)

    def test_剧本和模式不能同时给(self):
        code, out = self.run_main(["--script", str(DEMO_SCRIPT), "--mode", "random",
                                   "--dry-run"])
        self.assertEqual(code, 2)
        self.assertIn("只能用一个", out)

    def test_剧本文件坏了时退出码2(self):
        code, out = self.run_main(["--script", "不存在的剧本.json", "--dry-run"])
        self.assertEqual(code, 2)
        self.assertIn("找不到剧本文件", out)

    def test_同时给两个节点参数时退出码2(self):
        code, out = self.run_main(["--node", "dorm-a", "--nodes", "dorm-b", "--dry-run"])
        self.assertEqual(code, 2)
        self.assertIn("只能用一个", out)

    def test_未知节点只警告不拦(self):
        code, out = self.run_main(["--node", "dorm-z", "--count", "1", "--dry-run"])
        self.assertEqual(code, 0)
        self.assertIn("[警告]", out)
        self.assertIn("dormmate/v1/nodes/dorm-z/telemetry", out)

    def test_cooling模式温度是往下走的(self):
        _, out = self.run_main(["--node", "dorm-b", "--mode", "cooling", "--count", "4",
                                "--dry-run", "--interval", "0.01"])
        temps = [p["temperature"] for p in self.published(out)]
        self.assertEqual(temps, [33.0, 31.0, 29.0, 27.0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
