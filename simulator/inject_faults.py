"""D4 故障注入：把数据链路会遇到的坏情况各喂一条，看每一路被谁挡住、留下什么记录。

一键全跑（先起 broker、core.py、看板，再跑这条）：

    py -3.14 -m simulator.inject_faults

只看清单、不连 broker：

    py -3.14 -m simulator.inject_faults --list

只跑其中几条：

    py -3.14 -m simulator.inject_faults --only 1 --only 3

只发不核对：

    py -3.14 -m simulator.inject_faults --no-verify

默认带自检：脚本自己订 `dormmate/v1/log/reject`，核对每一条该被拒的报文
**真的**被 core 记下来了，最后打一张表。所以「拦住了」不是嘴上说的，是当场
看出来的 —— core.py 没在跑的话，那张表会全红，它也不会假装绿。

一条数据怎么才算好、怎么才算坏，由 core.py 说了算，这里一个字都不判。
`tests/test_inject_faults.py` 把下面这张清单逐条喂给 `core.validate_message`
跑一遍，所以清单和 core 的判据不会各说各话。

清单里第 0 条是**正常对照**：全都能拦住，也可能是"什么都拦" —— 得有一条
确定能通过的，才能说明拦下来的那几条是因为坏，不是因为工具坏了。
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import paho.mqtt.client as mqtt

# 见 simulator/simulator.py 里同一段注释：让「直接指文件路径」和「-m 包名」两种
# 跑法都能找到上层的 config。这里用绝对导入，两种跑法通吃。
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config  # noqa: E402
from simulator import publish_one  # noqa: E402

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="replace", line_buffering=True)


# --------------------------------------------------------------------------
# 故障清单
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Fault:
    """一条故障。

    `outcome` 说的是**core 该拿它怎么办**，只有三种：

      * `reject`   —— 不是我们要的数据，拒收，并且往 log/reject 记一条。
      * `pass`     —— 是合法数据，收下（哪怕数值很离谱，见第 5 条）。
      * `silent`   —— 既不是数据也不是坏数据（清 retained 的空报文），
                      记一笔就走，**不发 reject**。
      * `unrouted` —— **core 根本收不到这条**。topic 形状不对的报文落在
                      订阅之外，它连"拒绝"的机会都没有（见第 7 条）。

    `keyword` 是 `reject` 时 core 的理由里该出现的那几个字。钉住它而不是只数
    「reject 上有几条」，是因为「三条都在」和「三条都因为对的原因在」是两件事：
    topic 和报文对不上的那条如果是因为 JSON 写坏了才被拒，自检照样会绿。
    """

    number: int
    title: str
    args: tuple[str, ...]
    expect: str
    outcome: str
    keyword: str = ""

    @property
    def command(self) -> str:
        return "py -3.14 -m simulator.publish_one " + " ".join(self.args)


FAULTS: tuple[Fault, ...] = (
    Fault(
        0, "正常对照",
        ("--node", "dorm-b", "--temperature", "25", "--humidity", "60"),
        "收下，看板 dorm-b 那张卡刷新成 25℃ / 60% / 正常",
        "pass",
    ),
    Fault(
        1, "非法 JSON",
        ("--node", "dorm-a", "--raw", "{这不是 json"),
        "拒收，reject 上记一条「JSON 解析失败」",
        "reject", "JSON 解析失败",
    ),
    Fault(
        2, "合法 JSON 但缺字段",
        ("--node", "dorm-a", "--raw", '{"nodeId":"dorm-a"}'),
        "拒收，reject 上把缺哪些字段逐条列出来",
        "reject", "缺少",
    ),
    Fault(
        3, "topic 里的节点和报文里的对不上",
        (
            "--topic", "dormmate/v1/nodes/dorm-a/telemetry",
            "--raw", '{"nodeId":"dorm-b","temperature":25,"humidity":60,'
                     '"status":"正常","time":"2026-09-22 20:00:00"}',
        ),
        "core 拒收；看板那边**只警告不丢弃**（这条数据本身没问题，"
        "错的是它的来路）",
        "reject", "topic 里是",
    ),
    Fault(
        4, "未知节点",
        ("--node", "dorm-z", "--temperature", "25", "--humidity", "60"),
        "core 拒收（快照里没有 dorm-z 的位置）；看板记一条「未知节点」；"
        "**web/ 会照画不误** —— 它订阅通配符、来几个画几个，是设计如此",
        "reject", "未知节点",
    ),
    Fault(
        5, "数值离谱",
        ("--node", "dorm-c", "--temperature", "99", "--humidity", "200"),
        "**收下**，判成偏热。判据管的是「这是不是我们要的那种数据」，"
        "不管这个数在物理上合不合理 —— 99℃ 在规则上就是偏热，报出来是对的",
        "pass",
    ),
    Fault(
        6, "顶层不是对象",
        ("--node", "dorm-a", "--raw", "[1, 2, 3]"),
        "拒收。JSON.parse 眼里 `[1,2,3]` 是合法 JSON，但它不是我们要的东西",
        "reject", "不是对象",
    ),
    Fault(
        7, "topic 形状不对",
        (
            "--topic", "dormmate/v1/dorm-a",
            "--raw", '{"nodeId":"dorm-a","temperature":25,"humidity":60,'
                     '"status":"正常","time":"2026-09-22 20:00:00"}',
        ),
        "**core 根本收不到**：它订的是 dormmate/v1/nodes/+/telemetry，"
        "这条只有三段，落在订阅之外。所以第 1 道判据（topic 形状）在真链路上"
        "演示不出来，只有直接调 validate_message 才测得到（tests/test_core.py）"
        "—— **这不是漏洞**：core 订成 dormmate/# 的话，任何人在 broker 上发的"
        "测试话题都会灌进来",
        "unrouted",
    ),
    Fault(
        8, "清 retained 的空报文",
        ("--clear", "--node", "dorm-b"),
        "既不是数据也不是坏数据：core 打一行 `[保留]`、记一笔 "
        "`counters.retainedCleared`，**不发 reject**",
        "silent",
    ),
)


def args_for(fault: Fault) -> argparse.Namespace:
    """交给 publish_one 去解析 —— 参数怎么拼、默认值是什么，只有它一个出处。"""
    return publish_one.parse_args(list(fault.args))


def topic_for(fault: Fault) -> str:
    a = args_for(fault)
    return a.topic or config.topic_for(a.node)


def payload_for(fault: Fault) -> str:
    return publish_one.build_message(args_for(fault))


def retain_for(fault: Fault) -> bool:
    a = args_for(fault)
    return bool(a.retain or a.clear)


# --------------------------------------------------------------------------
# 核对：这条坏报文，core 真的记下来了吗
# --------------------------------------------------------------------------

def reject_matches(body: dict, topic: str, payload: str) -> bool:
    """一条 reject 是不是刚才发的那条？

    比的是 **topic + payload 全文**，不是「有几条 reject」：连着跑九条故障，
    只数条数的话，第 2 条没被拒、第 3 条被拒了两次，总数照样对得上。
    """
    return body.get("topic") == topic and body.get("payload") == payload


def reason_text(body: dict) -> str:
    return "；".join(str(r) for r in body.get("reasons") or ())


class Watch:
    """订 log/reject，把 core 记下来的坏报文收在一张表里。

    订阅是**异步**的：`subscribe()` 返回只代表请求发出去了，broker 那边还没
    认。不等它真的生效就发第一条的话，那一条的 reject 会在订阅生效前发出来
    —— 收不到，然后被报成「core 没拒收」。core 其实拒了。这种假警报只在慢
    机器上出现，最难查，所以在 `on_subscribe` 上压一个 Event。
    """

    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self.received: list[dict] = []
        self._lock = threading.Lock()
        self._ready = threading.Event()
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                                 client_id="dormmate-inject")
        if config.MQTT_USERNAME:
            self.client.username_pw_set(config.MQTT_USERNAME, config.MQTT_PASSWORD)
        self.client.on_subscribe = self._on_subscribe
        self.client.on_message = self._on_message

    def _on_subscribe(self, client, userdata, mid, reason_codes, properties) -> None:
        self._ready.set()

    def _on_message(self, client, userdata, message) -> None:
        try:
            body = json.loads(message.payload.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            body = {"topic": None, "reasons": [], "payload": None}
        if not isinstance(body, dict):
            body = {"topic": None, "reasons": [], "payload": None}
        with self._lock:
            self.received.append(body)

    def open(self, timeout: float = 5.0) -> None:
        self.client.connect(self.host, self.port, keepalive=30)
        self.client.loop_start()
        self.client.subscribe(config.REJECT_TOPIC, qos=1)
        if not self._ready.wait(timeout):
            raise TimeoutError(f"{timeout:.0f} 秒内没能订上 {config.REJECT_TOPIC}")

    def close(self) -> None:
        self.client.loop_stop()
        self.client.disconnect()

    def snapshot(self) -> list[dict]:
        with self._lock:
            return list(self.received)

    def expect(self, predicate, timeout: float) -> dict | None:
        """等一条满足 predicate 的 reject 出现。超时返回 None。"""
        deadline = time.monotonic() + timeout
        while True:
            for body in self.snapshot():
                if predicate(body):
                    return body
            if time.monotonic() >= deadline:
                return None
            time.sleep(0.02)


# --------------------------------------------------------------------------
# 打印
# --------------------------------------------------------------------------

MARK = {
    "reject": "[拒收]",
    "pass": "[放行]",
    "silent": "[保留]",
    "unrouted": "[不投递]",
}


def print_plan(fault: Fault, topic: str, payload: str, retain: bool) -> None:
    print(f"\n#{fault.number} {fault.title}  {MARK[fault.outcome]}")
    print(f"    命令  {fault.command}")
    print(f"    topic {topic}  retain={retain}")
    print(f"    实发  {payload!r}")
    print(f"    期望  {fault.expect}")


def print_faults(faults: tuple[Fault, ...]) -> None:
    print(f"D4 故障注入清单（{len(faults)} 条）")
    for f in faults:
        print(f"  #{f.number} {MARK[f.outcome]} {f.title}")
        print(f"      {f.command}")
        print(f"      期望：{f.expect}")


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="simulator.inject_faults",
        description="D4 故障注入：一次把该坏的东西都坏一遍，并核对 core 有没有拦住",
    )
    p.add_argument("--only", type=int, action="append", default=None, metavar="N",
                   help="只跑第 N 条（可重复给；不给就是全跑）")
    p.add_argument("--list", action="store_true", help="只打清单，不连 broker")
    p.add_argument("--dry-run", action="store_true", help="打印要发什么，不连 broker")
    p.add_argument("--no-verify", dest="verify", action="store_false",
                   help="只发不核对（core.py 没起的时候用）")
    p.add_argument("--timeout", type=float, default=3.0,
                   help="每条 reject 最多等几秒，默认 3")
    p.add_argument("--grace", type=float, default=0.4,
                   help="放行/保留那几条等多久确认「真的没有 reject」，默认 0.4 秒")
    p.add_argument("--host", default=config.MQTT_HOST, help="MQTT Broker 地址")
    p.add_argument("--port", type=int, default=config.MQTT_TCP_PORT, help="MQTT TCP 端口")
    return p.parse_args(argv)


def pick(faults: tuple[Fault, ...], only: list[int] | None) -> tuple[Fault, ...]:
    if not only:
        return faults
    wanted = set(only)
    return tuple(f for f in faults if f.number in wanted)


def run(fault: Fault, watch: Watch, timeout: float, grace: float) -> tuple[bool, str]:
    """发一条，然后核对。返回 (过没过, 给人看的一句话)。"""
    topic = topic_for(fault)
    payload = payload_for(fault)          # 只算一次：里面的 time 是"此刻"，
    retain = retain_for(fault)            # 算两次就对不上号了

    print_plan(fault, topic, payload, retain)
    info = watch.client.publish(topic, payload, qos=config.QOS, retain=retain)
    info.wait_for_publish(timeout=5)

    found = watch.expect(lambda b: reject_matches(b, topic, payload),
                         timeout if fault.outcome == "reject" else grace)

    if fault.outcome == "reject":
        if found is None:
            return False, ("没等到 reject。core.py 起了吗？它没在跑的话没人会拦 —— "
                           "起 core 再跑一遍")
        text = reason_text(found)
        if fault.keyword and fault.keyword not in text:
            return False, f"被拒了，但理由不对：{text!r}（该出现 {fault.keyword!r}）"
        return True, f"core 拒收：{text}"

    if found is not None:
        return False, f"不该被拒的，却收到了 reject：{reason_text(found)}"
    if fault.outcome == "pass":
        return True, "没人拒收（正确）"
    if fault.outcome == "unrouted":
        return True, "没人拒收（正确：这条落在 core 的订阅之外，它收不到）"
    return True, f"没人拒收（正确，core 那边打的是一行 [保留]）"


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if args.list:
        print_faults(FAULTS)
        return 0

    faults = pick(FAULTS, args.only)
    if not faults:
        print(f"[错误] --only 里没有一条对得上：清单是 "
              f"{[f.number for f in FAULTS]}", file=sys.stderr)
        return 2

    if args.dry_run:
        for f in faults:
            print_plan(f, topic_for(f), payload_for(f), retain_for(f))
        print("\n[Dry-run] 不连接 MQTT")
        return 0

    print(f"D4 故障注入：{len(faults)} 条 -> {args.host}:{args.port}")
    print("看这几处：core.py 的终端（[拒收] / [保留]）、看板的消息日志、"
          "MQTTX 订阅 dormmate/v1/log/reject")

    watch = Watch(args.host, args.port)
    try:
        watch.open()
    except (OSError, TimeoutError) as exc:
        print(f"[错误] 连不上 {args.host}:{args.port} —— {exc}", file=sys.stderr)
        print("       请先启动 Mosquitto：mosquitto -c mosquitto/dormmate.conf -v",
              file=sys.stderr)
        return 3

    results: list[tuple[Fault, bool, str]] = []
    try:
        for f in faults:
            if args.verify:
                passed, note = run(f, watch, args.timeout, args.grace)
            else:
                topic, payload = topic_for(f), payload_for(f)
                print_plan(f, topic, payload, retain_for(f))
                watch.client.publish(topic, payload, qos=config.QOS,
                                     retain=retain_for(f)).wait_for_publish(timeout=5)
                passed, note = True, "只发不核对（--no-verify）"
            results.append((f, passed, note))
            print(f"    -> {note}")
    finally:
        watch.close()

    if not args.verify:
        return 0

    print("\n核对结果")
    bad = 0
    for f, passed, note in results:
        if not passed:
            bad += 1
        print(f"  {'PASS' if passed else 'FAIL'}  #{f.number} {f.title}")
    print(f"\n{len(results) - bad}/{len(results)} 条符合预期")
    if bad:
        print("红的那些不是脚本的问题：要么 core.py 没在跑，要么它对这条的"
              "处理和大家以为的不一样 —— 两种都值得当场看清楚")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
