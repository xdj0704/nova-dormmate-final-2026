"""M1 数据源：生成宿舍环境数据，按统一 JSON 格式通过 MQTT 发布。

用法示例：
    python simulator.py                      # dorm-a，演示序列，每 5 秒一条
    python simulator.py --dry-run --count 4  # 只在终端打印，不连 MQTT
    python simulator.py --mode random        # 随机温度/湿度
    python simulator.py --node dorm-b        # 换个节点（M5 用）
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from datetime import datetime

import paho.mqtt.client as mqtt

from config import (
    DEFAULT_NODE_ID,
    MQTT_HOST,
    MQTT_PASSWORD,
    MQTT_TCP_PORT,
    MQTT_USERNAME,
    PUBLISH_INTERVAL,
    QOS,
    RETAIN,
    TIME_FORMAT,
    topic_for,
)
from status_rules import compute_status

# Windows 控制台兜底：某些代码页下中文/箭头会抛 UnicodeEncodeError 直接崩掉。
# 只把无法编码的字符替换掉，不影响正常输出。
# line_buffering：输出重定向到文件/管道时也能实时看到，方便截图进报告。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="replace", line_buffering=True)

# 演示序列：依次覆盖全部 4 种 status，取值与回归测试数据一致
DEMO_SEQUENCE = [
    (16.0, 60.0),  # 偏冷
    (25.0, 60.0),  # 正常
    (25.0, 80.0),  # 偏湿
    (31.0, 78.0),  # 偏热
]


def build_payload(node_id: str, temperature: float, humidity: float,
                  now: datetime | None = None) -> dict:
    """按统一 JSON 结构组装一条数据；status 永远由规则算出，不接受外部传入。"""
    temperature = round(float(temperature), 1)
    humidity = round(float(humidity), 1)
    payload = {
        "nodeId": node_id,
        "temperature": temperature,
        "humidity": humidity,
        "status": compute_status(temperature, humidity),
        "time": (now or datetime.now()).strftime(TIME_FORMAT),
    }
    # 自检：防止以后有人绕过 compute_status 直接写 status
    assert payload["status"] == compute_status(temperature, humidity)
    return payload


def random_sample() -> tuple[float, float]:
    return round(random.uniform(8.0, 38.0), 1), round(random.uniform(30.0, 95.0), 1)


def dumps(payload: dict) -> str:
    """ensure_ascii=False 才能让 status 里的中文正常显示。"""
    return json.dumps(payload, ensure_ascii=False)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="DormMate 环境数据模拟发布器")
    p.add_argument("--node", default=DEFAULT_NODE_ID, help="节点 ID（默认 dorm-a）")
    p.add_argument("--host", default=MQTT_HOST, help="MQTT Broker 地址")
    p.add_argument("--port", type=int, default=MQTT_TCP_PORT, help="MQTT TCP 端口")
    p.add_argument("--interval", type=float, default=PUBLISH_INTERVAL, help="发布间隔秒数")
    p.add_argument("--mode", choices=("demo", "random"), default="demo",
                   help="demo=固定序列（覆盖 4 种状态）；random=随机值")
    p.add_argument("--count", type=int, default=0, help="发布条数，0 表示一直发")
    p.add_argument("--dry-run", action="store_true", help="只打印，不连 MQTT")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    topic = topic_for(args.node)
    print(f"[DormMate] 节点={args.node}  Topic={topic}  模式={args.mode}")

    client = None
    if not args.dry_run:
        client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=f"dormmate-sim-{args.node}",
        )
        if MQTT_USERNAME:
            client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
        try:
            client.connect(args.host, args.port, keepalive=60)
        except OSError as exc:
            print(f"[错误] 连不上 {args.host}:{args.port} —— {exc}", file=sys.stderr)
            print("       请先启动 Mosquitto：mosquitto -c mosquitto/dormmate.conf -v",
                  file=sys.stderr)
            return 1
        client.loop_start()
        print(f"[MQTT] 已连接 {args.host}:{args.port}")
    else:
        print("[Dry-run] 不连接 MQTT，只打印 JSON")

    sent = 0
    try:
        while args.count == 0 or sent < args.count:
            if args.mode == "random":
                temperature, humidity = random_sample()
            else:
                temperature, humidity = DEMO_SEQUENCE[sent % len(DEMO_SEQUENCE)]

            payload = build_payload(args.node, temperature, humidity)
            message = dumps(payload)

            if client is not None:
                info = client.publish(topic, message, qos=QOS, retain=RETAIN)
                if info.rc != mqtt.MQTT_ERR_SUCCESS:
                    print(f"[警告] 发布失败 rc={info.rc}", file=sys.stderr)

            sent += 1
            flag = "→" if client is not None else " "
            print(f"[{sent:>4}] {flag} {message}")

            if args.count == 0 or sent < args.count:
                time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n[DormMate] 已停止")
    finally:
        if client is not None:
            client.loop_stop()
            client.disconnect()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
