"""手动发一条处理指令 —— 相当于前端那个「开始处理」按钮。

    py -3.14 -m simulator.send_cmd --node dorm-b                      # 按下处理
    py -3.14 -m simulator.send_cmd --node dorm-b --time "2026-09-22 20:02:30"
    py -3.14 -m simulator.send_cmd --node dorm-b --dry-run            # 只打印
    py -3.14 -m simulator.send_cmd --node dorm-z                      # 未知节点，core 会拒
    py -3.14 -m simulator.send_cmd --node dorm-b --raw '{"nodeId":"dorm-b","action":"open"}'
    py -3.14 -m simulator.send_cmd --clear --node dorm-b              # 清掉保留的指令

发到 dormmate/v1/cmd，payload 形状：

    {"nodeId": "dorm-b", "action": "handle", "time": "...", "source": "manual"}

**这条命令最要紧的地方是它办不到什么。** 它没有 temperature、没有 humidity，
更没有 status —— 指令能说的话只有「对哪个节点、干什么、什么时候」。
所以「我处理完了已经好了」在这条路上连个字段都找不到：core 收到之后只会把
事件从待处理推到处理中，那个节点到底恢复没有，只能由**后面收到的遥测数据**
说了算。默认是 `--dry-run` 的话就不用担心发错，可惜它不是默认。

retain 一律 False（`--retain` 都不给这个选项）：指令是此刻发生的动作。
保留住的话，下次 core 一重连就先把这条半小时前的 handle 又收一遍，
于是在没人按按钮的时候，日志里冒出一个动作。

`--retain` 唯一有意义的场合是 `--clear`（清除必须带 retain，否则删不掉）——
和 publish_one 一样。要构造「坏指令」的场景走 D4 那套（simulator/inject_faults.py），
这个文件只管发出**一条好的**指令。
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import paho.mqtt.client as mqtt

# 见 simulator/simulator.py 里同一段注释：让「直接指文件路径」和「-m 包名」两种
# 跑法都能找到上层的 config / events。这里用绝对导入，两种跑法通吃。
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import (  # noqa: E402
    CMD_TOPIC,
    DEFAULT_NODE_ID,
    MQTT_HOST,
    MQTT_PASSWORD,
    MQTT_TCP_PORT,
    MQTT_USERNAME,
    QOS,
    TIME_FORMAT,
)
from events import COMMANDS, HANDLE  # noqa: E402  —— 合法 action 的真源在 events.py
from simulator.simulator import (  # noqa: E402
    SOURCE_MANUAL,
    build_command_payload,
    dumps,
)

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="replace", line_buffering=True)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="simulator.send_cmd",
        description="手动发一条处理指令到 dormmate/v1/cmd（相当于前端按下处理按钮）",
    )
    p.add_argument("--node", default=DEFAULT_NODE_ID, help=f"节点 ID（默认 {DEFAULT_NODE_ID}）")
    p.add_argument("--action", default=HANDLE, choices=COMMANDS,
                   help=f"动作，目前只有 {HANDLE}（合法取值来自 events.py）")
    p.add_argument("--time", default=None,
                   # help 里的 % 要写成 %%：argparse 会把 help 当格式串跑一遍
                   # help % params，直接塞 %Y-%m-%d 进去会报「badly formed help string」。
                   help=f"时间，默认此刻；格式固定 {TIME_FORMAT.replace('%', '%%')}")
    p.add_argument("--source", default=SOURCE_MANUAL, help=f"来源标记，默认 {SOURCE_MANUAL}")
    p.add_argument("--raw", default=None,
                   help="整条指令原样发出去，一个字符都不改（构造坏指令用）")
    p.add_argument("--clear", action="store_true",
                   help="往指令 topic 发一条空的 retained 消息，清掉之前留下的保留消息")
    p.add_argument("--host", default=MQTT_HOST, help="MQTT Broker 地址")
    p.add_argument("--port", type=int, default=MQTT_TCP_PORT, help="MQTT TCP 端口")
    p.add_argument("--qos", type=int, choices=(0, 1, 2), default=QOS, help=f"QoS（默认 {QOS}）")
    p.add_argument("--dry-run", action="store_true", help="只打印，不连 MQTT")
    return p.parse_args(argv)


def build_message(args: argparse.Namespace) -> str:
    """把参数变成要发出去的那串字符。校验失败抛 ValueError。"""
    if args.clear:
        if args.raw is not None:
            raise ValueError("--clear 和 --raw 不是一回事：--clear 发的是空消息，别同时给")
        return ""                                    # 空 payload + retain = 清除保留消息

    if args.raw is not None:
        return args.raw                              # 原样，一个字符都不改

    moment = None
    if args.time is not None:
        # 先自己校验一次格式，免得发出一个格式不对的 time。
        # core 那边会拒，但拒了之后得回去看日志才知道是这里写错了。
        try:
            moment = datetime.strptime(args.time, TIME_FORMAT)
        except ValueError:
            raise ValueError(f"--time 要写成 {TIME_FORMAT} 这样，收到的是 {args.time!r}") from None

    payload = build_command_payload(args.node, args.action, now=moment, source=args.source)
    return dumps(payload)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    try:
        message = build_message(args)
    except ValueError as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return 2

    retain = args.clear                          # 只有清除才 retain，见文件头
    action = "清除保留消息" if args.clear else f"发指令 {args.action}"
    print(f"[DormMate] {action}  topic={CMD_TOPIC}  qos={args.qos}  retain={retain}")
    print(f"           payload={message!r}")

    if args.dry_run:
        print("[Dry-run] 不连接 MQTT")
        return 0

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                         client_id=f"dormmate-cmd-{args.node}")
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
        info = client.publish(CMD_TOPIC, message, qos=args.qos, retain=retain)
        info.wait_for_publish(timeout=5)
    finally:
        client.loop_stop()
        client.disconnect()

    if info.rc != mqtt.MQTT_ERR_SUCCESS:
        print(f"[错误] 发送失败 rc={info.rc}", file=sys.stderr)
        return 1
    print("[MQTT] 已发送 —— core 那边会打一行「[指令] ...」，那一行才是它收到了的凭据")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
