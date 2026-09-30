"""Broker 收发自检：TCP 1883 和 WebSocket 9001 各走一遍 QoS 1 往返。

    py -3.14 tests/broker_selftest.py

为什么要有这个：端口在监听 ≠ 消息能收到。1883 开着但没人订阅、或者 9001 的
WebSocket 握手被拒，光看 netstat 是看不出来的 —— 那两种情况下端口照样
LISTENING。这里真的发一条、真的等回一条，两条链路各自闭环才算过。

9001 那条尤其值得跑：浏览器走的就是它，而 WebSocket 是三种连法里最容易坏的
（协议升级、路径、代理），出问题时现象是「网页上啥也不动」，比 MQTTX 难查。

两个刻意的选择：
  * topic 用 dormmate/_selftest/echo，不用 dormmate/v1/nodes/<nodeId>/telemetry
    —— 后者会被看板当成真实环境数据显示出来，自检不该往业务 topic 里灌假数据。
  * 走的是 paho 的 transport="websockets"，也就是替浏览器把那条路先验了。

文件名不以 test_ 开头是有意的：unittest discover 默认只收 test*.py，
所以跑离线测试时不会把它收进去 —— 它需要 broker 真的在跑，不属于单元测试。
改名前想清楚这一点。
"""

import sys
import time

import paho.mqtt.client as mqtt

HOST = "127.0.0.1"
TOPIC = "dormmate/_selftest/echo"
TIMEOUT = 5.0

# 两条链路各是一个「客户端类型」：MQTTX / Python 发布端走前者，浏览器走后者。
LINKS = [
    ("MQTTX-同款", 1883, "tcp"),
    ("浏览器-同款", 9001, "websockets"),
]


def roundtrip(label, port, transport):
    """订阅 → 发布 → 等回自己发的那条。通了返回 True。"""
    got = []
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"selftest-{label}",
        transport=transport,
    )
    if transport == "websockets":
        client.ws_set_options(path="/")
    client.on_message = lambda _c, _u, m: got.append((m.topic, m.payload.decode(), m.qos))

    try:
        client.connect(HOST, port, keepalive=10)
    except OSError as exc:
        print(f"  {label:<12} {HOST}:{port:<5} 连不上：{exc}")
        return False

    client.loop_start()
    try:
        client.subscribe(TOPIC, qos=1)
        time.sleep(0.5)  # 等 SUBACK，不然可能先发后订、收不到自己那条
        payload = f"{label}-{time.strftime('%H:%M:%S')}"
        client.publish(TOPIC, payload, qos=1).wait_for_publish(timeout=TIMEOUT)

        deadline = time.time() + TIMEOUT
        while time.time() < deadline and not got:
            time.sleep(0.05)
    finally:
        client.loop_stop()
        client.disconnect()

    ok = bool(got) and got[0][1] == payload
    print(
        f"  {label:<12} {HOST}:{port:<5} transport={transport:<11} "
        f"{'OK  ' if ok else 'FAIL'} 发={payload!r} 收={got}"
    )
    return ok


def main():
    print(f"Broker 自检（{len(LINKS)} 条链路，各发一条 QoS 1 并等回）")
    results = [roundtrip(*link) for link in LINKS]
    if all(results):
        print("\n结论：两条链路都通了")
        return 0
    print("\n结论：有链路没通，见上面 FAIL —— 先确认 broker 在跑：")
    print(r'  start_broker.bat  （或 mosquitto -c mosquitto\dormmate.conf -v）')
    return 1


if __name__ == "__main__":
    sys.exit(main())
