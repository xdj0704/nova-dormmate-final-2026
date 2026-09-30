"""手动发一条节点数据 —— 排查用，也是 D4 故障注入的工具。

正常发一条：
    py -3.14 -m simulator.publish_one --node dorm-b --temperature 33 --humidity 55
    py -3.14 -m simulator.publish_one --node dorm-b --temperature 25 --humidity 60

故意发坏的（D4 用，看板应该挡住，只记一条错误日志）：
    # 1) 非法 JSON
    py -3.14 -m simulator.publish_one --node dorm-a --raw '{这不是 json'
    # 2) 合法 JSON 但缺字段
    py -3.14 -m simulator.publish_one --node dorm-a --raw '{"nodeId":"dorm-a"}'
    # 3) nodeId 和 topic 对不上
    py -3.14 -m simulator.publish_one --topic dormmate/v1/nodes/dorm-a/telemetry \
        --raw '{"nodeId":"dorm-b","temperature":25,"humidity":60,"status":"正常","time":"2026-09-22 20:00:00"}'
    # 4) 未知节点
    py -3.14 -m simulator.publish_one --node dorm-z --temperature 25 --humidity 60
    # 5) 数值离谱
    py -3.14 -m simulator.publish_one --node dorm-a --temperature 99 --humidity 200

清掉一条 retained 消息（发过 retained 才需要）：
    py -3.14 -m simulator.publish_one --clear --node dorm-b

两个刻意的默认值：
  * retain 默认关。故障消息要是被保留，之后每开一个看板都先看到这条坏数据，
    还得手动清；要保留就显式写 --retain。
  * seq 默认 0（= 不参与序列）。--seq 用来手工构造「这条比上一条旧」这种情形，
    验证看板的时间/序号新鲜度判断。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import paho.mqtt.client as mqtt

# 见 simulator/simulator.py 里同一段注释：让「直接指文件路径」和「-m 包名」两种
# 跑法都能找到上层的 config / status_rules。这里用绝对导入，两种跑法通吃。
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import (  # noqa: E402
    DEFAULT_NODE_ID,
    MQTT_HOST,
    MQTT_PASSWORD,
    MQTT_TCP_PORT,
    MQTT_USERNAME,
    QOS,
    TIME_FORMAT,
    topic_for,
)
from simulator.simulator import SOURCE_MANUAL, build_payload, dumps  # noqa: E402

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="replace", line_buffering=True)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="simulator.publish_one",
        description="手动发一条 MQTT 节点数据（可注入故障）",
    )
    p.add_argument("--node", default=DEFAULT_NODE_ID, help=f"节点 ID（默认 {DEFAULT_NODE_ID}）")
    p.add_argument("--topic", default=None,
                   help="自己指定 topic，默认按约定拼 dormmate/v1/nodes/<nodeId>/telemetry")
    p.add_argument("--temperature", type=float, default=None, help="温度 ℃")
    p.add_argument("--humidity", type=float, default=None, help="湿度 %%")
    p.add_argument("--time", default=None,
                   # help 里的 % 要写成 %%：argparse 会把 help 当格式串跑一遍
                   # help % params，直接塞 %Y-%m-%d 进去会报「badly formed help string」。
                   help=f"时间，默认此刻；格式固定 {TIME_FORMAT.replace('%', '%%')}")
    p.add_argument("--seq", type=int, default=0, help="序号，默认 0（不参与序列）")
    p.add_argument("--source", default=SOURCE_MANUAL, help=f"来源标记，默认 {SOURCE_MANUAL}")
    p.add_argument("--raw", default=None,
                   help="整条报文原样发出去，不做任何校验和补全 —— 故障注入用")
    p.add_argument("--clear", action="store_true",
                   help="往 topic 发一条空的 retained 消息，清掉之前留下的保留消息")
    p.add_argument("--host", default=MQTT_HOST, help="MQTT Broker 地址")
    p.add_argument("--port", type=int, default=MQTT_TCP_PORT, help="MQTT TCP 端口")
    p.add_argument("--qos", type=int, choices=(0, 1, 2), default=QOS, help=f"QoS（默认 {QOS}）")
    p.add_argument("--retain", action="store_true", help="保留这条消息（默认不保留）")
    p.add_argument("--dry-run", action="store_true", help="只打印，不连 MQTT")
    return p.parse_args(argv)


def build_message(args: argparse.Namespace) -> str:
    """把参数变成要发出去的那串字符。校验失败抛 ValueError。"""
    if args.clear:
        if args.raw is not None:
            raise ValueError("--clear 和 --raw 不是一回事：--clear 发的是空消息，别同时给")
        return ""                                     # 空 payload + retain = 清除保留消息

    if args.raw is not None:
        if args.temperature is not None or args.humidity is not None:
            print("[提示] 用了 --raw，--temperature/--humidity 被忽略（报文原样发出去）",
                  file=sys.stderr)
        return args.raw                               # 原样，一个字符都不改

    if args.temperature is None or args.humidity is None:
        raise ValueError("要给出 --temperature 和 --humidity（或者用 --raw 直接给整条报文）")

    now = None
    if args.time is not None:
        # 交给 build_payload 之前先自己校验一次格式，免得发出一个格式不对的 time
        from datetime import datetime
        try:
            now = datetime.strptime(args.time, TIME_FORMAT)
        except ValueError:
            raise ValueError(f"--time 要写成 {TIME_FORMAT} 这样，收到的是 {args.time!r}") from None

    payload = build_payload(args.node, args.temperature, args.humidity,
                            now=now, seq=args.seq, source=args.source)
    return dumps(payload)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    topic = args.topic or topic_for(args.node)

    try:
        message = build_message(args)
    except ValueError as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return 2

    retain = args.retain or args.clear               # 清除必须带 retain，否则删不掉
    action = "清除保留消息" if args.clear else "发布"
    print(f"[DormMate] {action}  topic={topic}  qos={args.qos}  retain={retain}")
    print(f"           payload={message!r}")

    if args.dry_run:
        print("[Dry-run] 不连接 MQTT")
        return 0

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                         client_id=f"dormmate-one-{args.node}")
    if MQTT_USERNAME:
        client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
    try:
        client.connect(args.host, args.port, keepalive=30)
    except OSError as exc:
        print(f"[错误] 连不上 {args.host}:{args.port} —— {exc}", file=sys.stderr)
        print("       请先启动 Mosquitto：mosquitto -c mosquitto/dormmate.conf -v",
              file=sys.stderr)
        return 1

    client.loop_start()
    try:
        info = client.publish(topic, message, qos=args.qos, retain=retain)
        info.wait_for_publish(timeout=5)
    finally:
        client.loop_stop()
        client.disconnect()

    if info.rc != mqtt.MQTT_ERR_SUCCESS:
        print(f"[错误] 发送失败 rc={info.rc}", file=sys.stderr)
        return 1
    print("[MQTT] 已发送")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
