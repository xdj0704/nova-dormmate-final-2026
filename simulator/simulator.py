"""Phase1 数据源：模拟宿舍环境数据，按统一 JSON 格式通过 MQTT 发布。

用法示例：
    py -3.14 -m simulator.simulator --all-nodes --interval 2
    py -3.14 -m simulator.simulator --nodes dorm-a,dorm-b --interval 2
    py -3.14 -m simulator.simulator --mode cooling --interval 2
    py -3.14 -m simulator.simulator --script simulator/scenarios/phase1_demo.json
    py -3.14 -m simulator.simulator --dry-run --count 4
    py -3.14 -m simulator.simulator --node dorm-b          # 还是可以只发一个

一轮（tick）= 给每个选中的节点各发一条，间隔 --interval 秒。所以
`--count 4` 是「发 4 轮」；只选了一个节点时它就等于「发 4 条」。

关于「恢复」：cooling 模式只是让温度自己降下来，看板上的状态变化完全由
后续收到的这条新数据决定 —— 没有任何按钮能把事件直接置成已恢复。协议上
也保证得了这一点：这条消息的 seq 一定比上一条大。
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import paho.mqtt.client as mqtt

# 直接 `py -3.14 simulator/simulator.py` 也让它能跑：那种跑法 sys.path[0] 是
# simulator/ 目录本身，上层的 config / status_rules 就找不到了。用 -m 跑不受影响。
# （README 里写的是 -m 的写法，这里只是兜底，省得有人按老习惯直接指文件路径。）
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import (  # noqa: E402
    DEFAULT_NODE_ID,
    MQTT_HOST,
    MQTT_PASSWORD,
    MQTT_TCP_PORT,
    MQTT_USERNAME,
    NODE_IDS,
    PUBLISH_INTERVAL,
    QOS,
    RETAIN,
    TIME_FORMAT,
    topic_for,
)
from status_rules import compute_status  # noqa: E402

# Windows 控制台兜底：某些代码页下中文/箭头会抛 UnicodeEncodeError 直接崩掉。
# 只把无法编码的字符替换掉，不影响正常输出。
# line_buffering：输出重定向到文件/管道时也能实时看到，方便截图进报告。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="replace", line_buffering=True)

# ---- 数据来源标记 ----
# source 用来区分「这条是谁发的」：模拟器发的、人手发的，排查时一眼能看出来。
SOURCE_SIM = "sim"
SOURCE_MANUAL = "manual"

# 演示序列：依次覆盖全部 4 种 status，取值与回归测试数据一致
DEMO_SEQUENCE = [
    (16.0, 60.0),  # 偏冷
    (25.0, 60.0),  # 正常
    (25.0, 80.0),  # 偏湿
    (31.0, 78.0),  # 偏热
]

# cooling 模式：从偏热开始，每轮降 COOLING_STEP 度，降到 COOLING_TARGET 就停。
# 湿度保持不变，这样状态只会因为「温度越过 30」而变 —— 演示时归因清楚：
# 33 → 31（还是偏热）→ 29（变正常），是温度在起作用，不是湿度。
COOLING_START = (33.0, 70.0)
COOLING_TARGET = 24.0
COOLING_STEP = 2.0


class ScriptError(ValueError):
    """剧本文件有问题。文案是给人看的，直接打到终端上。"""


@dataclass
class NodeState:
    """一个节点的发布状态。seq 每发一条加一，从 1 开始。

    为什么 seq 要按节点分开数：它是「这个节点第几条」，不是「这个进程第几条」。
    看板拿它判「这条比上一条新」，两个节点各自成序才说得通。
    """

    node_id: str
    seq: int = 0
    step: int = 0

    def next_seq(self) -> int:
        self.seq += 1
        return self.seq


def build_payload(node_id: str, temperature: float, humidity: float,
                  now: datetime | None = None, seq: int = 0,
                  source: str = SOURCE_SIM) -> dict:
    """按统一 JSON 结构组装一条数据；status 永远由规则算出，不接受外部传入。

    统一 JSON 的五个字段（nodeId/temperature/humidity/status/time）原样保留、
    顺序不变，seq 和 source 追加在后面。多出来的字段老读者会忽略，不会坏。
    """
    temperature = round(float(temperature), 1)
    humidity = round(float(humidity), 1)
    payload = {
        "nodeId": node_id,
        "temperature": temperature,
        "humidity": humidity,
        "status": compute_status(temperature, humidity),
        "time": (now or datetime.now()).strftime(TIME_FORMAT),
        "seq": int(seq),
        "source": str(source),
    }
    # 自检：防止以后有人绕过 compute_status 直接写 status
    assert payload["status"] == compute_status(temperature, humidity)
    return payload


def dumps(payload: dict) -> str:
    """ensure_ascii=False 才能让 status 里的中文正常显示。"""
    return json.dumps(payload, ensure_ascii=False)


def demo_sample(step: int) -> tuple[float, float]:
    """演示序列循环取。"""
    return DEMO_SEQUENCE[step % len(DEMO_SEQUENCE)]


def random_sample() -> tuple[float, float]:
    return round(random.uniform(8.0, 38.0), 1), round(random.uniform(30.0, 95.0), 1)


def cooling_sample(step: int, start: tuple[float, float] = COOLING_START,
                   target: float = COOLING_TARGET,
                   step_size: float = COOLING_STEP) -> tuple[float, float]:
    """风扇降温：温度每轮降 step_size，降到 target 就保持。

    保持住而不是继续降到 18 以下，是为了不把「偏冷」也带出来 ——
    这个模式演示的是「从偏热回到正常」，多一个状态反而看不清。
    """
    temperature = max(target, float(start[0]) - step * float(step_size))
    return round(temperature, 1), round(float(start[1]), 1)


def load_script(path: str | Path) -> tuple[list[tuple[str, float, float]], float | None]:
    """读 json 剧本 → ([(nodeId, 温度, 湿度), ...], 剧本自带的间隔或 None)。

    格式（frames 里的 comment 字段是给人看的，会被忽略）：
        {"interval": 2,
         "frames": [{"node": "dorm-a", "temperature": 31, "humidity": 78},
                    {"node": "dorm-b", "temperature": 16, "humidity": 60, "repeat": 2}]}

    repeat 默认 1。每轮只消费一帧，所以剧本写几帧就发几条。
    帧里没有 node 就用 dorm-a —— 只有一个宿舍的剧本不用每帧都重复写。
    """
    file = Path(path)
    if not file.exists():
        raise ScriptError(f"找不到剧本文件：{file}")

    try:
        raw = json.loads(file.read_text(encoding="utf-8"))
    except UnicodeDecodeError:
        raise ScriptError(f"{file.name} 不是 UTF-8 编码（多半是存成了 GBK）") from None
    except json.JSONDecodeError as exc:
        raise ScriptError(f"{file.name} 不是合法的 JSON：{exc}") from None

    if not isinstance(raw, dict):
        raise ScriptError(f"{file.name} 最外层要是一个对象 {{...}}，现在是 {type(raw).__name__}")

    frames = raw.get("frames")
    if not isinstance(frames, list) or not frames:
        raise ScriptError(f"{file.name} 里没有 frames，或 frames 是空的 —— 至少要有一帧")

    out: list[tuple[str, float, float]] = []
    for i, frame in enumerate(frames, 1):
        if not isinstance(frame, dict):
            raise ScriptError(f"{file.name} 第 {i} 帧不是对象")
        if "temperature" not in frame or "humidity" not in frame:
            # 只有 comment 的帧是合法的，直接跳过
            if set(frame) <= {"comment"}:
                continue
            raise ScriptError(f"{file.name} 第 {i} 帧缺 temperature 或 humidity")
        node = str(frame.get("node", DEFAULT_NODE_ID))
        try:
            temperature = float(frame["temperature"])
            humidity = float(frame["humidity"])
        except (TypeError, ValueError):
            raise ScriptError(
                f"{file.name} 第 {i} 帧的温度/湿度不是数字："
                f"{frame['temperature']!r} / {frame['humidity']!r}"
            ) from None
        repeat = frame.get("repeat", 1)
        if not isinstance(repeat, int) or isinstance(repeat, bool) or repeat < 1:
            raise ScriptError(f"{file.name} 第 {i} 帧的 repeat 要是 ≥1 的整数，现在是 {repeat!r}")
        out.extend([(node, temperature, humidity)] * repeat)

    if not out:
        raise ScriptError(f"{file.name} 的 frames 里没有一帧是真的数据")

    interval = raw.get("interval")
    if interval is not None:
        try:
            interval = float(interval)
        except (TypeError, ValueError):
            raise ScriptError(f"{file.name} 的 interval 不是数字：{raw['interval']!r}") from None
        if interval <= 0:
            raise ScriptError(f"{file.name} 的 interval 要大于 0，现在是 {interval}")
    return out, interval


def resolve_nodes(args: argparse.Namespace) -> list[str]:
    """把 --node / --nodes / --all-nodes 三种写法归一成一个节点列表。"""
    picked = []
    if args.all_nodes:
        picked.append("--all-nodes")
    if args.nodes:
        picked.append("--nodes")
    if args.node:
        picked.append("--node")
    if len(picked) > 1:
        raise ScriptError(f"{'、'.join(picked)} 只能用一个，别同时给")

    if args.all_nodes:
        return list(NODE_IDS)
    if args.nodes:
        nodes = [n.strip() for n in args.nodes.split(",") if n.strip()]
        if not nodes:
            raise ScriptError("--nodes 是空的，写成 --nodes dorm-a,dorm-b 这样")
        return nodes
    return [args.node or DEFAULT_NODE_ID]


def warn_unknown_nodes(nodes: list[str]) -> None:
    """不在约定的三个节点里只警告、不拦 —— 故意留的口子（D4 要用）。

    拿 dorm-z 发数据是看板那边「未知节点必须被挡掉」那条红线的测试手段，
    拦掉就演示不了了。所以这里只说一声，不拦。
    """
    unknown = [n for n in nodes if n not in NODE_IDS]
    if unknown:
        print(f"[警告] {'、'.join(unknown)} 不在约定节点 {NODE_IDS} 里，"
              f"看板会把它当成未知节点记一条错误日志、不给它建卡片")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="simulator.simulator",
        description="DormMate 环境数据模拟发布器（Phase1）",
    )
    p.add_argument("--node", default=None, help="只发一个节点，如 --node dorm-b")
    p.add_argument("--nodes", default=None, help="发多个节点，逗号分隔，如 --nodes dorm-a,dorm-b")
    p.add_argument("--all-nodes", action="store_true", help=f"等价于 --nodes {','.join(NODE_IDS)}")
    p.add_argument("--host", default=MQTT_HOST, help="MQTT Broker 地址")
    p.add_argument("--port", type=int, default=MQTT_TCP_PORT, help="MQTT TCP 端口")
    p.add_argument("--interval", type=float, default=PUBLISH_INTERVAL,
                   help=f"每轮间隔秒数（默认 {PUBLISH_INTERVAL}，Phase1 演示用 --interval 2）")
    p.add_argument("--mode", choices=("demo", "random", "cooling"), default="demo",
                   help="demo=固定序列（覆盖 4 种状态）；random=随机值；cooling=风扇降温")
    p.add_argument("--cool-step", type=float, default=COOLING_STEP,
                   help=f"cooling 模式每轮降几度（默认 {COOLING_STEP}）")
    p.add_argument("--script", default=None,
                   help="读 json 剧本文件跑场景，如 simulator/scenarios/phase1_demo.json")
    p.add_argument("--count", type=int, default=0, help="发几轮，0 表示一直发")
    p.add_argument("--dry-run", action="store_true", help="只打印，不连 MQTT")
    return p.parse_args(argv)


def _connect(args: argparse.Namespace, client_id: str) -> mqtt.Client | None:
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
    if MQTT_USERNAME:
        client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
    try:
        client.connect(args.host, args.port, keepalive=60)
    except OSError as exc:
        print(f"[错误] 连不上 {args.host}:{args.port} —— {exc}", file=sys.stderr)
        print("       请先启动 Mosquitto：mosquitto -c mosquitto/dormmate.conf -v",
              file=sys.stderr)
        return None
    client.loop_start()
    print(f"[MQTT] 已连接 {args.host}:{args.port}")
    return client


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    # 剧本与模式二选一：剧本自带每一帧的温湿度，再叠一个 --mode 只会打架
    script_frames: list[tuple[str, float, float]] = []
    if args.script:
        if args.mode != "demo":
            print("[错误] --script 和 --mode 只能用一个：剧本里已经写好了每一帧的数据",
                  file=sys.stderr)
            return 2
        try:
            script_frames, script_interval = load_script(args.script)
        except ScriptError as exc:
            print(f"[错误] {exc}", file=sys.stderr)
            return 2
        if script_interval is not None and args.interval == PUBLISH_INTERVAL:
            # 用户在命令行没显式写 --interval 时，听剧本的
            args.interval = script_interval

    try:
        nodes = resolve_nodes(args)
    except ScriptError as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return 2

    if script_frames:
        # 剧本里出现的节点都要有 seq 计数器，哪怕命令行一个都没选
        nodes = list(dict.fromkeys(nodes + [f[0] for f in script_frames]))
    warn_unknown_nodes(nodes)

    mode_label = f"剧本 {Path(args.script).name}" if script_frames else args.mode
    print(f"[DormMate] 节点={'、'.join(nodes)}  模式={mode_label}  "
          f"间隔={args.interval}s  topic={topic_for(nodes[0])}")
    print("           订阅用通配符：dormmate/v1/nodes/+/telemetry")

    # 一个进程只开一根连接，三个节点共用它 —— 三根连接没必要，还多三份重连逻辑。
    # 想分成三个进程跑也行（老写法），client_id 按节点拼，互相不会顶下线。
    client = None
    if not args.dry_run:
        client_id = (f"dormmate-sim-{nodes[0]}" if len(nodes) == 1
                     else f"dormmate-sim-{len(nodes)}nodes")
        client = _connect(args, client_id)
        if client is None:
            return 1
    else:
        print("[Dry-run] 不连接 MQTT，只打印 JSON")

    # demo 模式下给每个节点一个错开的起点，否则三个节点每轮取到的是同一组数值，
    # 看板上三张卡一模一样，看不出「三个宿舍各不相同」。第 i 个节点从序列的第
    # i 项开始：dorm-a 偏冷、dorm-b 正常、dorm-c 偏湿，正好各占一种。
    states = {
        node: NodeState(node, step=(i if args.mode == "demo" and not script_frames else 0))
        for i, node in enumerate(nodes)
    }
    sent = 0
    ticks = 0
    frame_index = 0
    try:
        while args.count == 0 or ticks < args.count:
            # 这一轮要发哪些节点、各自的温湿度
            if script_frames:
                # 剧本：每轮消费一帧，帧里写的是哪个节点就发哪个。
                # 剧本跑完就收工，不循环 —— 场景演示要的是一遍跑完的确定结果。
                if frame_index >= len(script_frames):
                    break
                frame = script_frames[frame_index]
                frame_index += 1
                plan = [(frame[0], frame[1], frame[2])]
            else:
                plan = []
                for node in nodes:
                    state = states[node]
                    if args.mode == "random":
                        temperature, humidity = random_sample()
                    elif args.mode == "cooling":
                        temperature, humidity = cooling_sample(
                            state.step, step_size=args.cool_step)
                    else:
                        temperature, humidity = demo_sample(state.step)
                    plan.append((node, temperature, humidity))

            for node, temperature, humidity in plan:
                state = states[node]
                payload = build_payload(node, temperature, humidity,
                                        seq=state.next_seq())
                message = dumps(payload)
                # 记下这一轮用掉了第几次采样，下一轮才有新值
                state.step += 1

                if client is not None:
                    info = client.publish(topic_for(node), message, qos=QOS, retain=RETAIN)
                    if info.rc != mqtt.MQTT_ERR_SUCCESS:
                        print(f"[警告] 发布失败 rc={info.rc}", file=sys.stderr)

                sent += 1
                flag = "→" if client is not None else " "
                print(f"[{sent:>4}] {flag} {topic_for(node)}  {message}")

            ticks += 1
            if args.count == 0 or ticks < args.count:
                time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n[DormMate] 已停止")
    finally:
        if client is not None:
            client.loop_stop()
            client.disconnect()

    if script_frames:
        print(f"[DormMate] 剧本跑完，共 {sent} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
