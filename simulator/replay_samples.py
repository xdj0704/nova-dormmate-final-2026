"""回放构造样本 —— 把 data/constructed_samples.json 里的读数按顺序发一遍（Phase8 D5）。

    py -3.14 -m simulator.replay_samples
    py -3.14 -m simulator.replay_samples --file data/constructed_samples.json
    py -3.14 -m simulator.replay_samples --dry-run          # 不连 broker，只打印
    py -3.14 -m simulator.replay_samples --interval 1

【它是干什么用的】
这组读数是**故意挑出来**让「固定规则」和「IsolationForest」给出不同结论的：
规则只看「越没越线」（三条阈值），ML 只看「和这个宿舍平时像不像」。发进去之后，
core 会给每条读数盖上 ML 判词，接着 data/history.csv 的第 6 列和第 10 列就有值了，
报告里那张对照表和「案例分析」板块讲的就是这批数据。

【为什么单开一个脚本，不塞进 simulator.py 的剧本机制】
  1. 剧本的 Frame 是 frozen 的、里面**没有 source**，要透传就得动 load_script、
     主循环和两个测试文件 —— 为一件独立的事改主链路不划算；
  2. 构造样本的生命周期是「**训练之后**再喂」：先有历史、才有模型，然后才拿它去
     试这个模型。塞进 scenarios/ 会和剧本回放（source=script，只给指令帧用）混起来，
     source 这个字段的语义就糊了；
  3. 独立脚本能**无条件**给每条报文打上 source=constructed，不依赖「记得在帧里写」。

【顺序不能反】
构造样本必须在**训练之后**喂：
    1. start_broker.bat
    2. py -3.14 core.py
    3. py -3.14 -m simulator.simulator --all-nodes     # 灌历史，source=sim
    4. py -3.14 analysis/train_iforest.py              # 按历史训每个宿舍的模型
    5. 重启 core                                        # 模型是启动时加载的
    6. 本脚本                                           # 喂构造样本，看两边分家
反了会怎样：训练时这些极端值会被当成「这个宿舍的常态」学进去，之后 ML 反而判它们
「正常」—— 案例复现不出来，而且**一句错都不报**。训练脚本会跳过它们（判据见
analysis/make_report.py 的 SOURCE_KINDS），但那是补救，不是可以反着来的理由。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import paho.mqtt.client as mqtt

# 直接 `py -3.14 simulator/replay_samples.py` 也让它能跑：那种跑法 sys.path[0]
# 是 simulator/ 目录本身，上层的 config 找不到。用 -m 跑不受影响（README 写的是 -m）。
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import (  # noqa: E402
    MQTT_HOST,
    MQTT_PASSWORD,
    MQTT_TCP_PORT,
    MQTT_USERNAME,
    QOS,
    TIME_FORMAT,
    topic_for,
)
from simulator.simulator import (  # noqa: E402
    SOURCE_CONSTRUCTED,
    build_payload,
    dumps,
)

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="replace", line_buffering=True)

# 默认输入。和 analysis/make_report.py 用的是同一份 —— 它既是这份脚本的输入，
# 也是需求 4 要交的那个文件，所以它入库（data/ 下的 *_sim.csv 也一样）。
DEFAULT_FILE = Path(__file__).resolve().parent.parent / "data" / "constructed_samples.json"

# 两条报文之间隔多久。0.3 秒够 core 一条条处理完并各写一行 ——
# 一股脑发完的话，快照里只会留下最后一条，看板上那几行对照就看不清了。
DEFAULT_INTERVAL = 0.3

REQUIRED_FIELDS = ("node", "temperature", "humidity")


class SampleError(ValueError):
    """构造样本文件有问题。文案是给人看的，直接打到终端上。"""


def load_samples(path: Path) -> dict:
    """读样本文件。形状不对就抛 SampleError（带一句人话）。

    校验做得细一点是值得的：这份文件的用途就是**触发差异**，
    一个字段名写错（比如把 node 写成 nodeId）会让整批样本按同一个节点发出去，
    而现场看上去只是「案例分析里怎么没有 dorm-b」—— 那要查很久。
    """
    if not path.exists():
        raise SampleError(
            f"找不到样本文件：{path}\n"
            f"这份是随 Phase8 D5 一起提交的输入，默认在 data/constructed_samples.json。"
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SampleError(f"读不了 {path}：{exc}") from None

    if not isinstance(data, dict):
        raise SampleError(f"{path} 的最外层应该是一个对象，收到的是 {type(data).__name__}")

    samples = data.get("samples")
    if not isinstance(samples, list) or not samples:
        raise SampleError(f"{path} 里没有 samples 数组（或者它是空的），没有东西可发。")

    for index, sample in enumerate(samples):
        where = f"第 {index + 1} 条样本"
        if not isinstance(sample, dict):
            raise SampleError(f"{path} {where}不是一个对象。")
        for field in REQUIRED_FIELDS:
            if field not in sample:
                raise SampleError(
                    f"{path} {where}少了 {field!r}（要有 {list(REQUIRED_FIELDS)}；"
                    "节点那个字段叫 node，不是 nodeId）"
                )
        for field in ("temperature", "humidity"):
            value = sample[field]
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise SampleError(f"{path} {where}的 {field} 要是个数字，收到的是 {value!r}")
        if "time" in sample:
            _parse_time(sample["time"], path, where)

    return data


def _parse_time(text, path: Path, where: str) -> datetime:
    """time 字段按统一格式解析。格式不对就抛 —— 不猜、也不改成「现在」。"""
    try:
        return datetime.strptime(str(text), TIME_FORMAT)
    except ValueError:
        raise SampleError(
            f"{path} {where}的 time 要写成 {TIME_FORMAT} 这样，收到的是 {text!r}"
        ) from None


def source_of(data: dict) -> str:
    """这份样本用的 source。

    **写死成 constructed，而且不许文件把它改掉**：这个标记是「训练时跳过」的判据，
    让它可配等于让「这批样本进不进训练集」变成一件取决于 JSON 里某个字段的事。
    文件里显式写了别的值就当场停下，不静默用它 —— 那正是会出事的写法。
    """
    declared = data.get("source", SOURCE_CONSTRUCTED)
    if str(declared) != SOURCE_CONSTRUCTED:
        raise SampleError(
            f"样本文件里的 source 是 {declared!r}，但构造样本只能是 "
            f"{SOURCE_CONSTRUCTED!r}。\n"
            "这个标记是「训练时跳过它们」的判据（analysis/make_report.py 的 "
            "SOURCE_KINDS）：换成别的词，训练脚本就认不出它们是构造样本，"
            "会把它们当常态训进模型 —— 之后 ML 反过来判它们正常，案例复现不出来，"
            "而且一句错都不报。"
        )
    return SOURCE_CONSTRUCTED


def build_messages(data: dict, start: datetime | None = None,
                   interval: float | None = None,
                   seq_base: int = 0, path: Path | None = None) -> list[dict]:
    """样本 -> 一串「要发什么」。**不碰网络**，所以测试可以直接调它。

    每一项：{"node", "topic", "payload"(dict), "text"(要发出去的字符串)}

    时间的规矩只有两条：
      * 样本自带 time 的，原样用它 —— 那是造这批样本的人挑的时候，最该尊重；
      * 没带 time 的，按 `start + 序号 × interval` 排。
    都在「现在」时刻的话，几毫秒内发出去的几条报文时间会一模一样，
    报告里那几行的先后就只能靠运气了。
    """
    step = DEFAULT_INTERVAL if interval is None else float(interval)
    base = start or datetime.now()
    where = path or Path("<样本>")
    source = source_of(data)

    messages = []
    for index, sample in enumerate(data["samples"]):
        node = str(sample["node"])
        when = (_parse_time(sample["time"], where, f"第 {index + 1} 条样本")
                if "time" in sample
                else base + timedelta(seconds=step * index))
        payload = build_payload(node, sample["temperature"], sample["humidity"],
                                now=when, seq=seq_base + index + 1, source=source)
        messages.append({
            "node": node,
            "topic": topic_for(node),
            "payload": payload,
            "text": dumps(payload),
        })
    return messages


def print_plan(messages: list[dict], interval: float) -> None:
    """发之前把要发的东西按行摆出来。**先看后发** —— 这批报文是要进 CSV 和报告的。"""
    print(f"[DormMate] 构造样本 {len(messages)} 条，source={SOURCE_CONSTRUCTED}，"
          f"间隔 {interval:g}s")
    for item in messages:
        payload = item["payload"]
        print(f"  {item['topic']}")
        print(f"    {payload['temperature']}℃ / {payload['humidity']}%"
              f"  {payload['status']}  {payload['time']}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="simulator.replay_samples",
        description="回放 Phase8 D5 的构造样本（source=constructed）",
    )
    p.add_argument("--file", default=str(DEFAULT_FILE),
                   help=f"样本 JSON（默认 {DEFAULT_FILE}）")
    p.add_argument("--interval", type=float, default=None,
                   help=f"两条之间的秒数，默认取文件里的 interval，再不行 {DEFAULT_INTERVAL}")
    p.add_argument("--host", default=MQTT_HOST, help="MQTT Broker 地址")
    p.add_argument("--port", type=int, default=MQTT_TCP_PORT, help="MQTT TCP 端口")
    p.add_argument("--qos", type=int, choices=(0, 1, 2), default=QOS, help=f"QoS（默认 {QOS}）")
    p.add_argument("--dry-run", action="store_true", help="只打印，不连 MQTT")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    path = Path(args.file)
    if not path.is_absolute():
        path = Path(__file__).resolve().parent.parent / path

    try:
        data = load_samples(path)
        interval = args.interval if args.interval is not None \
            else float(data.get("interval", DEFAULT_INTERVAL))
        messages = build_messages(data, interval=interval, path=path)
    except (SampleError, ValueError) as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return 2

    if interval < 0:
        print("[错误] --interval 不能是负数", file=sys.stderr)
        return 2

    print_plan(messages, interval)
    print(f"[提示] 这 {len(messages)} 条带着 source={SOURCE_CONSTRUCTED} 进 "
          "data/history.csv，训练时会被跳过（见 analysis/train_iforest.py）。")

    if args.dry_run:
        print("[Dry-run] 不连接 MQTT")
        return 0

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="dormmate-samples")
    if MQTT_USERNAME:
        client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
    try:
        client.connect(args.host, args.port, keepalive=30)
    except OSError as exc:
        print(f"[错误] 连不上 {args.host}:{args.port} —— {exc}", file=sys.stderr)
        print("       先跑 start_broker.bat（或者 mosquitto -c mosquitto/dormmate.conf -v）",
              file=sys.stderr)
        return 1

    client.loop_start()
    sent = 0
    try:
        for index, item in enumerate(messages):
            # retain 不打开：这些样本是**一次读数**，不是「这个宿舍现在的状态」。
            # 保留的话，之后每开一个看板都先看到 18.5℃ 这条，还得手动清。
            info = client.publish(item["topic"], item["text"],
                                  qos=args.qos, retain=False)
            info.wait_for_publish(timeout=5)
            if info.rc != mqtt.MQTT_ERR_SUCCESS:
                print(f"[错误] 第 {index + 1} 条发送失败 rc={info.rc}", file=sys.stderr)
                return 1
            sent += 1
            if index < len(messages) - 1:
                time.sleep(interval)
    finally:
        client.loop_stop()
        client.disconnect()

    print(f"[MQTT] 已发送 {sent} 条")
    print("[下一步] core 会给每条判一次 ML，结果落在 data/history.csv 第 6 列和第 10 列。"
          " 看报告：py -3.14 analysis/make_report.py --csv data/history.csv")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
