"""DormMate core —— 唯一业务大脑。

    py -3.14 core.py                  # 连本机 broker，跑起来
    py -3.14 core.py --check          # 只核对配置，不连 broker（0=对得上，1=对不上）
    py -3.14 core.py --config 别的.json
    py -3.14 core.py --quiet          # 只报拒绝和快照，不逐条报收到的数据

这个文件要**替全校所有的前端做判断**。所以它自己不渲染任何东西，
只做五件事：

    1) 收：订阅 dormmate/v1/nodes/+/telemetry，校验每一条报文
    2) 判：status 一律用 rules.judge_status 重算，**不信报文里写的值**
    3) 排：把异常节点交给 rules.rank_priority，得出「最该先看的是谁、为什么」
    4) 管：异常段开成一条事件（events.py），前端的 handle 指令把它推到「处理中」，
       之后靠**新收到的报文**判它恢复还是没恢复
    5) 发：retained 快照发到 dormmate/v1/state，坏报文发到 dormmate/v1/log/reject
       （清 retained 的那条空报文既不是数据也不是坏报文，只记一笔——见
       validate_message 第 2 步前面那段）

两条订阅：遥测那一条是数据，`dormmate/v1/cmd` 那一条是指令。on_message 按
topic 分派（`message.topic == config.CMD_TOPIC` 走 handle_command）。

四条红线在代码里的落点（改这个文件之前先看一遍）：

  * **不许写死节点。** 节点从 core/config.json 来，代码里出现 dorm-a 就是错的。
    「优先关注」由数据算出来，不是 here 挑一个。
  * **status 由温湿度算。** 报文里那个 status 只用来对一对，不一致就以算的为准
    并记账（counters.statusMismatch），永远不把它当成结论。
  * **恢复要等新数据。** 不是「按个按钮就算好了」—— 恢复判据是**后来收到的**
    连续 N 条正常报文（N = core/config.json 的 recoverConsecutiveNormal）。
    代码上的落点：`handle_command()` 里**一行都不碰 self.nodes**，它只能让
    事件从 OPEN 转 HANDLING；写下 RECOVERED 的只有 `EventBook.observe()`。
  * **不手工改结果。** 快照里的每个数字都是当场从内存里算的，没有任何一处
    是写死的常量。

为什么是单线程：paho 的 `loop()` 会在**当前线程**里回调 on_message，
所以「收到消息」和「发布快照」天然串行，node 状态不需要加锁。
如果改用 loop_start() 开后台线程，下面这些 `node.xxx =` 就全都有了
数据竞争 —— 而它跑起来看着还是对的，只是偶尔算错一次。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import paho.mqtt.client as mqtt

# 项目根 = 本文件所在目录。用 __file__ 推导，不靠当前工作目录。
_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import config  # noqa: E402
import events  # noqa: E402
import history  # noqa: E402
import ml_judge  # noqa: E402
import rules  # noqa: E402
from status_rules import compute_status  # noqa: E402

# 统一 JSON 的 time 格式，固定 YYYY-MM-DD HH:mm:ss。
# 用正则先卡形状，再交给 strptime 卡真假（2026-13-45 这种形状对、日期不对）。
TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")

# 快照格式版本。前端将来读 dormmate/v1/state 时按这个字段挑解析方式，
# 免得以后字段变了，旧页面把新快照读成一堆 undefined 还不报错。
#
# 2：E3 起多三块 —— 每个节点多一个 history（趋势图的数据源）、顶层多
#    events（事件表）和 rejects（被拒绝日志）、以及 focus（谁被点名了）。
#    加字段本身是向后兼容的（旧页面读不到就当没有），但**「前端只订快照
#    就够不够」这件事变了** —— 旧页面订的是遥测，新页面一条都不订，
#    这正是版本号该站出来说的那种变化。
#
# 3：到现在还没有。Phase8 D5 给每个节点和每条 history 各加了 ML 那三格
#    （mlLabel/mlText/agree），但版本号**不动** —— 加的同样是「旧页面读不到
#    就当没有」的字段，而前端**订阅的方式一个字都没变**（还是只订
#    dormmate/v1/state 这一条）。加字段不升版本、「订阅模型变了」才升，
#    这就是这个数字一直以来的口径。
#
#    Phase9 D4 又加了三处（顶层 core 那一块、每个节点 offlineSec /
#    offlineText 两格），同一条口径，还是 **2**：旧页面读不到这几格，
#    画出来就是没有离线提示 —— 而它本来也没有。
SNAPSHOT_VERSION = 2

# 快照里最多带几条事件。屏幕上放不下 eventsMax（200）条，全带上就是每发一次
# 快照重发一遍整本卷宗。**这只是发出去的那一份的上限**：summary 里的 total
# 永远是真的总数，被截掉的条数在 dropped 里 —— 少报比多报危险，看见 20 条
# 而以为一共就 20 条，正好会让「这个宿舍一直出问题」这件事消失。要看全部的
# 人读 data/events.json。
SNAPSHOT_EVENTS_MAX = 20

# 快照里最多带几条「被拒绝」的记录。和 REJECT_PAYLOAD_MAX（单条报文截多长）
# 是两个方向的限制：那个管一条多长，这个管一共几条。两个都得有 ——
# 只截长度的话，一个不停发坏数据的设备能把快照撑到几十 MB。
SNAPSHOT_REJECTS_MAX = 20

# 指令动词。`events.COMMANDS` 是**会去改事件状态**的那一组（目前只有 handle）；
# 另外两个都不在那一组里，原因各不相同：
#   focus    —— 一行都不碰事件簿。它改的是「谁被点名了」，那是展示用的
#               注意力，不是宿舍的状况。
#   snapshot —— 碰事件簿，但**只追加一笔、一个状态都不动**（Phase6 E2）。
# 三组拼起来才是 core 认的全部动词，而 validate_command 拿到的就是这一份。
#
# 分组的依据是「改不改事件状态」，不是「重不重要」：SNAPSHOT 之所以没进
# events.COMMANDS，正是因为它不该被当成一次状态迁移 —— 哪天有人想写
# 「拍照即视为开始处理」，那张照片得先绕过这个分组才行。
FOCUS = "focus"
COMMANDS = events.COMMANDS + (FOCUS, events.SNAPSHOT)

# 写进拒绝日志的原始报文最多留这么多个字符。原样全存的话，
# 一条 1 MB 的垃圾能把日志刷没，而看的人只需要认出来「这是谁发的什么鬼」。
REJECT_PAYLOAD_MAX = 200

# 「还没打印过」的哨兵。用它而不是 None，是因为 None 本身是一个
# 合法的结论（「没有需要优先处理的节点」）。见 Core.report。
_UNSET = object()


# --------------------------------------------------------------------------
# 时间
# --------------------------------------------------------------------------

def parse_time(text: Any) -> datetime | None:
    """把 "2026-09-22 20:30:00" 解析成 datetime。解析不了返回 None。

    刻意**不**返回 epoch 秒：算时长用两个 datetime 相减
    （`(end - start).total_seconds()`），这样跨夏令时也不会差一小时。
    换成 `.timestamp()` 再相减就没有这个保证 —— 它对两个时刻各用了一次
    当时的本地偏移量。
    """
    if not isinstance(text, str) or not TIME_RE.match(text):
        return None
    try:
        return datetime.strptime(text, config.TIME_FORMAT)
    except ValueError:
        # 形状对但日期假：2026-13-45 10:99:99
        return None


def format_time(when: datetime | float | None = None) -> str:
    """格式化成统一 JSON 里那个 time。默认取此刻（本地时间）。"""
    if when is None:
        when = datetime.now()
    elif isinstance(when, (int, float)):
        when = datetime.fromtimestamp(when)
    return when.strftime(config.TIME_FORMAT)


# --------------------------------------------------------------------------
# topic
# --------------------------------------------------------------------------

def parse_topic(topic: Any) -> str | None:
    """从 topic 里取出节点名，取不到返回 None。

    约定 dormmate/v1/nodes/<nodeId>/telemetry，严格 5 段。
    和四个前端里的 topicNode() 是同一套判据 —— 一边放宽、一边收紧的话，
    同一条报文会在页面里显示、在 core 里被拒绝（或者反过来），
    而两边各自看都「没毛病」。

    形状拼接的唯一出处是 config.topic_for()，这里只做反解。
    """
    text = "" if topic is None else str(topic)
    parts = text.split("/")
    if len(parts) != 5:
        return None
    if parts[0] != "dormmate" or parts[1] != "v1" or parts[2] != "nodes":
        return None
    if parts[4] != "telemetry" or parts[3] == "":
        return None
    return parts[3]


# --------------------------------------------------------------------------
# 校验
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Verdict:
    """一条报文的校验结论。

    ok=False 时 record 是 None、reasons 非空，调用方负责把 reasons 发到
    reject topic。ok=True 时也可能带 notes —— 那是「能用，但有问题」的情形
    （最典型的是报文里的 status 和规则算出来的不一致），不能因为有问题就丢，
    也不能装作没看见。

    还有一种**既不是数据也不是错**的：ignored=True。它只有一种来源 ——
    空 payload，也就是 MQTT 里「清掉一条保留消息」的做法（见 validate_message
    第 2 步）。这种消息 ok 也是 False（它确实没有 record），但调用方要先看
    ignored：**不许发 reject topic**，reasons 里那句话只是给人看的。
    """

    ok: bool
    record: dict[str, Any] | None = None
    reasons: tuple[str, ...] = ()
    notes: tuple[str, ...] = ()
    ignored: bool = False


# 必填字段和它们的类型。顺序就是统一 JSON 里那五个的顺序 ——
# 少了哪一个、哪一个类型不对，都要说得出名字。
REQUIRED_FIELDS: tuple[tuple[str, type], ...] = (
    ("nodeId", str),
    ("temperature", (int, float)),
    ("humidity", (int, float)),
    ("status", str),
    ("time", str),
)


def validate_message(
    topic: Any,
    payload_text: Any,
    node_ids: tuple[str, ...] | list[str],
) -> Verdict:
    """校验一条报文。过了就是 Verdict(ok=True, record=...)，否则带理由。

    校验顺序是**从外到内**的，前面过不了就不看后面：
    topic 形状 -> JSON -> 顶层是对象 -> 五个字段齐不齐、类型对不对
    -> 数值是不是有限数 -> time 格式 -> 节点认不认识 -> topic 和报文说的
    是不是同一个节点。

    这九道之外还有一条**放行**（不是判据，所以不占编号）：长度为 0 的 payload
    是「清掉一条保留消息」，不是报文 —— 见下面第 2 步前面那一段注释。

    最后那一条在 core 这里和前端**故意不一样**：前端只警告不丢弃
    （页面上挂一条可疑数据，看的人自己判断），core 直接拒收。理由是这条
    数据进了内存之后会被当成真的：算时长、算优先级、进快照，然后被所有
    前端读走。到那时候已经没有任何地方能想起来「它当初 topic 就不对」。
    """
    # 1) topic 形状
    topic_id = parse_topic(topic)
    if topic_id is None:
        return Verdict(False, reasons=(
            f"topic 形状不对：{topic!r}，约定是 dormmate/v1/nodes/<nodeId>/telemetry",
        ))

    # 空报文（清 retained）—— **不是报文，也不是坏报文**，先摘出去。
    # MQTT 里「清掉一条 retained」的做法就是往同一个 topic 发一条
    #    **长度为 0** 的保留消息：broker 删掉存的那条，同时把它转发给当前在线的
    #    订阅者 —— 于是 core 会真的收到一条空 payload。
    #
    #    它不是数据，也不是坏数据（`publish_one --clear` 就是干这个的，而
    #    README 里跑剧本的第 ① 步正是清 retained）。按坏数据处理的话，每清一次
    #    就往 reject topic 灌三条假警报，而排查表里写着「reject 有流量就该查」——
    #    照着自己写的步骤做，看到一个查不出原因的警报。
    #
    #    只认长度为 0：空白字符不是清 retained，那是真写坏了，照旧拒收。
    if payload_text == "":
        return Verdict(
            False, ignored=True,
            reasons=(f"{topic_id} 的保留消息被清掉了（空报文），不当作数据",),
        )

    # 2) JSON
    if not isinstance(payload_text, str):
        return Verdict(False, reasons=("报文不是文本，没法按 UTF-8 JSON 解析",))
    try:
        payload = json.loads(payload_text)
    except ValueError as exc:
        return Verdict(False, reasons=(f"JSON 解析失败：{exc}",))

    # 3) 顶层得是个对象。JSON.parse 眼里 'null' / '123' / '"x"' / '[1]' 都是合法 JSON，
    #    但都不是我们要的东西，不先挡掉的话下面读字段会读到一堆 None。
    if not isinstance(payload, dict):
        return Verdict(False, reasons=(
            f"payload 顶层不是对象（收到 {type(payload).__name__}）",
        ))

    # 4) 字段齐不齐、类型对不对
    problems: list[str] = []
    for key, expected in REQUIRED_FIELDS:
        if key not in payload:
            problems.append(f"缺少 {key}")
            continue
        value = payload[key]
        # bool 是 int 的子类，True 能当温度用 —— 这不是我们想要的
        if isinstance(value, bool) or not isinstance(value, expected):
            names = (
                expected.__name__ if isinstance(expected, type)
                else "/".join(t.__name__ for t in expected)
            )
            problems.append(f"{key} 应为 {names}，实际是 {type(value).__name__}")
    if problems:
        return Verdict(False, reasons=tuple(problems))

    # 5) 数值必须是有限数。json 里写不出 NaN，但 Python 的 json.loads 认
    #    NaN / Infinity 这两个裸词（这是它对 JSON 标准的让步），所以拦得住。
    for key in ("temperature", "humidity"):
        value = float(payload[key])
        if value != value or value in (float("inf"), float("-inf")):
            problems.append(f"{key} 不是有限数（{payload[key]!r}）")
    if problems:
        return Verdict(False, reasons=tuple(problems))

    # 6) time 格式
    if parse_time(payload["time"]) is None:
        return Verdict(False, reasons=(
            f"time 格式不对：{payload['time']!r}，应是 YYYY-MM-DD HH:mm:ss",
        ))

    # 7) 节点认不认识。不认识的节点没有地方可写 —— 快照里没有它的位置
    if payload["nodeId"] not in tuple(node_ids):
        return Verdict(False, reasons=(
            f"未知节点 {payload['nodeId']!r}，配置里只有 {list(node_ids)}",
        ))

    # 8) topic 说的和报文说的必须是同一个节点
    if topic_id != payload["nodeId"]:
        return Verdict(False, reasons=(
            f"topic 里是 {topic_id}，报文里是 {payload['nodeId']}，拒收",
        ))

    temperature = float(payload["temperature"])
    humidity = float(payload["humidity"])

    # 9) status 重算。**不信任报文里那个值**，一律用规则算。
    #    不一致不算「非法报文」—— 温湿度本身是好的，数据能用，
    #    所以只记一条 note，由调用方警告 + 计数，不往 reject 里丢。
    expected = rules.judge_status(temperature, humidity)
    notes: tuple[str, ...] = ()
    if payload["status"] != expected:
        notes = (
            f"status 不一致：收到「{payload['status']}」，规则算出「{expected}」，以规则为准",
        )

    record: dict[str, Any] = {
        "nodeId": payload["nodeId"],
        "temperature": temperature,
        "humidity": humidity,
        "status": expected,
        "time": payload["time"],
    }
    # seq / source 是 Phase1 追加的，可有可无；有就带上，类型不对就当没有
    seq = payload.get("seq")
    if isinstance(seq, int) and not isinstance(seq, bool):
        record["seq"] = seq
    source = payload.get("source")
    if isinstance(source, str):
        record["source"] = source

    return Verdict(True, record=record, notes=notes)


# --------------------------------------------------------------------------
# 指令（前端 -> core）
# --------------------------------------------------------------------------

# 指令的必填字段。这里比遥测少得多，因为指令是**人按出来的**，
# 不是传感器报上来的 —— 只有一个「对哪个节点、干什么」。
COMMAND_FIELDS: tuple[tuple[str, type], ...] = (
    ("nodeId", str),
    ("action", str),
)

# 每种动作**只对自己**额外要的字段（Phase6 E2）。上面那张表是所有指令都有的
# 那两样，这一张按 action 分。
#
# 为什么不干脆往上面那张表里加：往 handle / focus 上要一个 width 毫无意义，
# 而「指令缺字段」那条报错会变成对一条 handle 也喊「缺少 width」。分开之后，
# 每种动作要什么、缺了报什么，都是它自己的事。
#
# 这几个都是**必填**的，因为 snapshot 这条指令存在的全部意义就是「报上来一份
# 快照文件的信息」：缺了宽高和字节数，core 记下的只是一行「拍过照」的空话，
# 事后既对不上那张图，也说不清是哪一张。
COMMAND_FIELDS_BY_ACTION: dict[str, tuple[tuple[str, type], ...]] = {
    events.SNAPSHOT: (
        ("stamp", str),      # 快门按下去那一刻（前端报的，core 不自己造）
        ("width", int),
        ("height", int),
        ("bytes", int),
    ),
}

# 可选的附加字段：给了就原样记进案卷，不给不影响这条指令成立。
# 三个都是字符串 —— 水印那一行的长度上限在 events.WATERMARK_MAX_CHARS。
COMMAND_OPTIONAL_FIELDS_BY_ACTION: dict[str, tuple[tuple[str, type], ...]] = {
    events.SNAPSHOT: (
        ("eventId", str),    # 前端以为的那条案卷，core 只拿它**对账**
        ("watermark", str),
        ("file", str),
    ),
}


def validate_command(
    topic: Any,
    payload_text: Any,
    node_ids: tuple[str, ...] | list[str],
    commands: tuple[str, ...] | list[str] = COMMANDS,
) -> Verdict:
    """校验一条前端指令。过了就是 Verdict(ok=True, record=...)。

    和 validate_message 是一路的（同样的九道里挑出该有的那几道，同样的
    Verdict、同样的 reasons），但**判据不同**，所以另起一个函数而不是加参数：
    指令少了 time 不是错（core 用自己的时钟补），多了个不认识的 action 是错
    （一个不认识的动词没法猜大意 —— 猜错了就是替前端做主）。

    record 里带着 action，但**不带任何节点的状态**：这个函数能看的东西里
    没有温度湿度，它也就没法替数据说话。红线在这一层就已经成立。
    """
    # 1) topic 必须正好是那一条。指令不是遥测，没有通配符的余地：
    #    dormmate/v1/cmd/dorm-a 这种「看着更整齐」的写法会被拒 ——
    #    节点在 payload 里已经有了，topic 里再来一份就是第二个出处。
    if topic != config.CMD_TOPIC:
        return Verdict(False, reasons=(
            f"不是指令 topic：{topic!r}，指令的约定是 {config.CMD_TOPIC}",
        ))

    # 空报文：和遥测那边同一个做法（清 retained）。指令这条 topic 是
    # retain=False 发的，正常情况下不会出现，但「不会出现」和「不用处理」
    # 是两件事 —— 真收到一条空的，按坏报文拒掉会让 reject 里多一条查不出的
    # 假警报，而它其实什么都不是。
    if payload_text == "":
        return Verdict(
            False, ignored=True,
            reasons=(f"{config.CMD_TOPIC} 上收到空报文（清 retained），不当作指令",),
        )

    # 2) JSON
    if not isinstance(payload_text, str):
        return Verdict(False, reasons=("指令不是文本，没法按 UTF-8 JSON 解析",))
    try:
        payload = json.loads(payload_text)
    except ValueError as exc:
        return Verdict(False, reasons=(f"指令 JSON 解析失败：{exc}",))

    # 3) 顶层是对象
    if not isinstance(payload, dict):
        return Verdict(False, reasons=(
            f"指令 payload 顶层不是对象（收到 {type(payload).__name__}）",
        ))

    # 4) 字段齐不齐、类型对不对
    problems: list[str] = []
    for key, expected in COMMAND_FIELDS:
        if key not in payload:
            problems.append(f"指令缺少 {key}")
            continue
        value = payload[key]
        if isinstance(value, bool) or not isinstance(value, expected):
            problems.append(
                f"指令 {key} 应为 {expected.__name__}，实际是 {type(value).__name__}"
            )
    if problems:
        return Verdict(False, reasons=tuple(problems))

    # 5) 节点认不认识 —— 和遥测同一条理由：不认识的节点没有地方可写。
    #    这里还要防一件事：事件文件的路径是按节点名分文件的吗？不是，
    #    所以更要挡住，否则会开出一条 nodeId 是乱码、谁也结不掉的事件。
    if payload["nodeId"] not in tuple(node_ids):
        return Verdict(False, reasons=(
            f"指令未知节点 {payload['nodeId']!r}，配置里只有 {list(node_ids)}",
        ))

    # 6) action 认不认识。**不做大小写折叠、不做同义词**：
    #    「Handle」「处理」「开始处理」一律拒收，理由写清目前只有哪几种。
    #    松一点看着更"友好"，但下一步就是有人发 'Handle' 之后
    #    「按了没反应」而日志里一条拒绝都没有（它被折叠后接受了）——
    #    那种错只能靠读代码发现。
    if payload["action"] not in tuple(commands):
        return Verdict(False, reasons=(
            f"指令不认识的 action {payload['action']!r}，目前只有 {list(commands)}"
            "（大小写不折叠：'Handle' 和 'handle' 不是一回事）",
        ))

    # 6b) 这个动作额外要的字段（目前只有 snapshot 要）。
    #     放在 action 认过之后 —— 不然一条 action 写错的报文会被报成
    #     「缺少 stamp」，而真正的问题是那个动词根本不存在。
    extras: dict[str, Any] = {}
    for key, expected in COMMAND_FIELDS_BY_ACTION.get(payload["action"], ()):
        if key not in payload:
            problems.append(f"{payload['action']} 指令缺少 {key}")
            continue
        value = payload[key]
        if isinstance(value, bool) or not isinstance(value, expected):
            problems.append(
                f"{payload['action']} 指令 {key} 应为 {expected.__name__}，"
                f"实际是 {type(value).__name__}"
            )
            continue
        # 宽高字节数都得是正数：0×0 的照片和 0 字节的文件都不存在，
        # 收下来的话案卷上会写着一行「0×0」而没人知道该拿它怎么办。
        if expected is int and value <= 0:
            problems.append(f"{payload['action']} 指令 {key} 要是个正数，实际是 {value}")
            continue
        extras[key] = value

    for key, expected in COMMAND_OPTIONAL_FIELDS_BY_ACTION.get(payload["action"], ()):
        value = payload.get(key)
        if value is None:
            continue
        # 给了但类型不对 -> 拒，不是悄悄丢掉。丢掉的话前端以为记上了，
        # 而案卷里那一格是空的，事后对不上还得回头查这一条。
        if isinstance(value, bool) or not isinstance(value, expected):
            problems.append(
                f"{payload['action']} 指令 {key} 应为 {expected.__name__}，"
                f"实际是 {type(value).__name__}"
            )
            continue
        extras[key] = value

    # snapshot 的 stamp 是「快门那一刻」，和 time 一样要是个能读的时刻。
    # 它比 time 更要紧：time 是 core 自己会补的，stamp 补不出来 ——
    # core 收到这条指令的时候，照片早就拍完了。
    stamp = extras.get("stamp")
    if stamp is not None and parse_time(stamp) is None:
        problems.append(
            f"snapshot 指令 stamp 格式不对：{stamp!r}，应是 YYYY-MM-DD HH:mm:ss"
        )

    if problems:
        return Verdict(False, reasons=tuple(problems))

    # 7) time 是可选的：给了就得是那个格式，不给由 core 补上此刻。
    #    可选是因为指令是"当前这一刻发生的动作"，前端不该被迫自己造一个时间；
    #    允许给，是为了剧本能复现出固定的时刻（d3_event.json 就是这么写死的）。
    when = payload.get("time")
    if when is not None:
        if not isinstance(when, str) or parse_time(when) is None:
            return Verdict(False, reasons=(
                f"指令 time 格式不对：{when!r}，应是 YYYY-MM-DD HH:mm:ss",
            ))

    record: dict[str, Any] = {
        "nodeId": payload["nodeId"],
        "action": payload["action"],
        "time": when,                     # None = 让 core 用自己的时钟补
    }
    source = payload.get("source")
    if isinstance(source, str):
        record["source"] = source
    record.update(extras)

    return Verdict(True, record=record)


# --------------------------------------------------------------------------
# 节点状态
# --------------------------------------------------------------------------

@dataclass
class NodeState:
    """一个节点在 core 内存里的全部状态。

    **两个时钟，别弄混**（这是这个类里最容易写错的地方）：

      * `last_seen` 是**墙上时间**（收到这条报文的那一刻，time.time()）——
        它回答的是「这个节点还在发数据吗」，只有跟"现在"比才有意义，
        所以不能用报文里的 time：报文里的 time 可以随便编、可以是三天前的。
      * `abnormal_start` 是**报文时间**（那条异常报文的 time 字段）——
        它回答的是「这段异常从什么时候开始」，必须用数据自己说的时间，
        否则同一份剧本每次跑出来的时长都不一样，测试也写不出定值。
        这里和前端 logic.js 的 abnormalDuration 是同一个口径。

    `abnormal_count` 只数**这段异常里的异常条数**，正常报文不加它 ——
    它和时长的分母要保持一致（都是这一段里的），不然「5 分钟 9 次」
    这种数字摆在一起会让人以为漏了几条。
    """

    node_id: str
    history_max: int = 50
    history: deque[dict[str, Any]] = field(default_factory=deque)
    latest: dict[str, Any] | None = None
    last_seen: float | None = None          # 墙上时间
    abnormal_start: datetime | None = None  # 报文时间
    abnormal_count: int = 0
    # 这一段异常里**最后一条异常报文**的状态。注意它和 self.status 不是一回事：
    # 恢复路上（已经开始收正常数据、但还没凑够 N 条）self.status 是「正常」，
    # 而 abnormal_status 还是「偏热」。优先关注说的是「这一段」，用的是后者 ——
    # 否则会说出「已连续正常 7 分钟（3 次），持续时间最长」这种自相矛盾的话。
    abnormal_status: str | None = None
    consecutive_normal: int = 0
    seen_any: bool = False

    def __post_init__(self) -> None:
        # deque 的 maxlen 就是「历史上限」，超了自动丢最老的 ——
        # 不用自己 splice，也就不会出现「忘了丢」导致内存慢慢涨。
        if not isinstance(self.history, deque) or self.history.maxlen != self.history_max:
            self.history = deque(self.history, maxlen=self.history_max)

    # -- 状态推进 ----------------------------------------------------------

    def apply(self, record: dict[str, Any], now_wall: float, recover_after: int) -> None:
        """把一条**已经校验通过**的报文写进这个节点。"""
        self.seen_any = True
        self.latest = record
        self.last_seen = now_wall
        self.history.append(record)

        if record["status"] == rules.STATUS_NORMAL:
            self.consecutive_normal += 1
            # 恢复判据：连着 N 条正常才算这一段的结束。
            # N 就是 core/config.json 的 recoverConsecutiveNormal。
            # 为什么不是「一条正常就结束」：现场那台风扇一开，温度是一条一条
            # 往下走的，中间抖一条 17.9℃ 就判「已恢复」的话，事件表里会留下
            # 一串开了又关、关了又开的记录，而实际上没恢复。
            if self.abnormal_count > 0 and self.consecutive_normal >= recover_after:
                self.abnormal_start = None
                self.abnormal_count = 0
                self.abnormal_status = None
        else:
            # 异常报文：连续正常计数**清零**，但这一段的起点不动。
            # 也就是说「异常 -> 正常 -> 异常」在没凑够 N 条正常时，
            # 算**同一段**还在继续，而不是新开一段 —— 这正是连续异常的语义。
            self.consecutive_normal = 0
            if self.abnormal_count == 0:
                self.abnormal_start = parse_time(record["time"])
            # 段内从偏热漂到偏湿时跟着变：说的必须是这一段**最近**是什么状况，
            # 拿最早那条去说，日志里的「已连续偏热」就成了过去时。
            self.abnormal_status = record["status"]
            self.abnormal_count += 1

    # -- 读出来的东西 ------------------------------------------------------

    @property
    def status(self) -> str | None:
        """最新一条的状态。**一条都没收到时是 None，不是「正常」**。

        「还没收到数据」和「正常」是两件事。默认成「正常」的话，看板上
        三个节点全是绿的，而实际上一条数据都没来过 —— 这是最坏的一种
        「看着一切正常」。
        """
        return None if self.latest is None else self.latest["status"]

    def is_abnormal(self) -> bool:
        return self.abnormal_count > 0

    def normals_until_recovery(self, recover_after: int) -> int | None:
        """这一段异常**还差几条正常**才算结束；没有开着的段就返回 None。

        「还差几条」是要打给人看的：日志里只写「收到一条正常」的话，看的人
        没法知道那一条到底算不算数（要凑够 N 条），只能自己回去数。
        """
        if self.abnormal_count == 0:
            return None
        return max(0, recover_after - self.consecutive_normal)

    def duration_seconds(self) -> float:
        """这段异常持续了**多少秒**（浮点）。没有异常段时是 0。

        用最新那条报文的 time 当终点（不管它是正常还是异常）：这一段还没
        结束，说明它延续到了现在收到的这条。用「最后一条异常报文」当终点的话，
        「异常 -> 正常 -> 正常（还没凑够 N）」那段时间会凭空消失。
        """
        if self.abnormal_start is None or self.latest is None:
            return 0.0
        end = parse_time(self.latest["time"])
        if end is None:
            return 0.0
        delta = (end - self.abnormal_start).total_seconds()
        return delta if delta > 0 else 0.0

    def offline_since(self, now_wall: float) -> float | None:
        """已经多久没收到这个节点的数据了（秒）。从没收到过返回 None。"""
        if self.last_seen is None:
            return None
        return now_wall - self.last_seen

    def is_online(self, now_wall: float, timeout: float) -> bool:
        """还在发数据吗。

        一次都没收到过的节点算**离线** —— 它不是"在线但没有异常"，
        它是"我们什么都不知道"。这两件事在快照里必须分得开。
        """
        if self.last_seen is None:
            return False
        return (now_wall - self.last_seen) <= timeout

    def view(self) -> rules.NodeView:
        """交给 rules.rank_priority 的那份输入。

        单位在这里从秒（core 内部）变成 rules 要的秒 —— 前端的 JS 用的是毫秒，
        换算只在各自的边界上做一次，排序那一层不掺和单位。

        status 给的是**这一段异常的**状态（abnormal_status），不是最新那条读数的
        状态。恢复路上一旦拿最新读数去说，理由就变成了「已连续正常 7 分钟」——
        一个正被列为「异常节点」的宿舍，理由是「连续正常」，看的人只会当成 bug。
        严重度那一步也跟着这条走：比的是「这一段有多严重」。
        """
        return rules.NodeView(
            node_id=self.node_id,
            status=self.abnormal_status or self.status or rules.STATUS_NORMAL,
            count=self.abnormal_count,
            duration=self.duration_seconds(),
        )


# --------------------------------------------------------------------------
# Core
# --------------------------------------------------------------------------

@dataclass
class Counters:
    received: int = 0
    rejected: int = 0
    status_mismatch: int = 0
    # 收到过几条「清 retained」的空报文。它既不是 received 也不是 rejected：
    # 不数它的话，broker 明明投递了 15 条、快照上只有 14 条，差的那一条
    # 在任何地方都看不见 —— 这个项目里「看不见的东西才叫丢」。
    retained_cleared: int = 0
    # 收下的指令条数（含「按了但没有对应事件」的那种 —— 那条指令本身是好的，
    # 只是没案子可办）。它在快照里，是为了回答一个具体的问题：
    # 「前端到底把话说到了没有」。按钮按下去没反应时，先看这个数变没变。
    commands: int = 0
    # 被拒的指令。和 rejected 分开数：遥测被拒说明现场设备在发坏数据，
    # 指令被拒说明前端在发坏指令 —— 该去查的地方根本不是一处。
    command_rejected: int = 0


class Core:
    """业务大脑本体。不碰网络细节，client 由外面递进来（测试递假的那个）。

    这样切一刀是为了能离线测：真 broker 起不起得来、能不能收到消息，
    和「收到之后算得对不对」是两件事，混在一起测的话，
    前者坏一次就把后者的测试一起带红，什么都看不出来。
    """

    def __init__(
        self,
        cfg: dict[str, Any],
        client: Any | None = None,
        quiet: bool = False,
        events_path: str | Path | None = None,
        history_path: str | Path | None = None,
        model_dir: str | Path | None = None,
    ) -> None:
        self.cfg = cfg
        self.nodes: dict[str, NodeState] = {
            node_id: NodeState(node_id, history_max=cfg["historyMax"])
            for node_id in cfg["nodes"]
        }
        self.counters = Counters()
        self.client = client
        self.quiet = quiet
        self._last_state_payload: str | None = None
        # 上一次把快照**发出去**的时刻（墙上时间）。心跳那一步拿它算间隔 ——
        # 见 heartbeat()。None = 这个 Core 还一条快照都没发过。
        self._last_state_at: float | None = None
        # 上一次打过的「重点」是谁。初值用 _UNSET 而不是 None ——
        # None 是「没有重点」这个**合法结论**，两者不能混：
        # 混了的话，一上来就"没有重点"的那次永远打不出来。
        self._last_priority_node: object = _UNSET
        self.offline: list[str] = []   # 上一次 tick 时判定为离线的节点

        # ---- E3：被点名的节点（移动端按下「聚焦」，或看板上点一下某个宿舍）----
        # 它不是「宿舍的状况」，是「大家现在都在看哪一个」—— 所以：
        #   * 不进 nodes，不进 ranked，**不参与优先级排序**（一个被点名的宿舍
        #     不会因为被点名就变成最该处理的那个，那样排序就成了谁按谁有理）；
        #   * 不落盘。重启之后谁都没被点名，从头开始，这是对的：它是当下这一屋子
        #     人在看什么，不是历史事实。
        # 形状是 None（没人被点名）或 {"nodeId":…, "by":…, "at":…}。
        self.focus: dict[str, Any] | None = None

        # ---- E3：最近被拒的几条报文 ----
        # 为什么在内存里存一份而不只是发到 REJECT_TOPIC：前端要「只订一条
        # dormmate/v1/state」就得让被拒绝日志跟着快照一起来。存最近
        # SNAPSHOT_REJECTS_MAX 条，超了丢最老的（和事件簿同一个做法）。
        self.rejects: deque[dict[str, Any]] = deque(maxlen=SNAPSHOT_REJECTS_MAX)
        # 一共拒过多少条。快照里那几条是**最近**的，这个数是**总共**的 ——
        # 两个都发，看的人才知道「这 20 条是全部还是最新的 20 条」。
        self.rejects_total = 0

        # ---- 事件（D3）----
        # events_path 默认 None = **不碰磁盘**。这个默认是刻意的：一个 Core
        # 被造出来不等于「现在该往 data/ 里写文件了」，跑测试的时候更不该。
        # 真正跑起来的那条路（run()）显式把 config.EVENTS_PATH 递进来。
        event_cfg = cfg.get("events") or {}
        self.events_path = None if events_path is None else Path(events_path)
        self.event_book = events.EventBook(
            nodes=cfg["nodes"],
            recover_after=cfg["recoverConsecutiveNormal"],
            verify_after=event_cfg.get("verifyConsecutiveAbnormal", 3),
            events_max=event_cfg.get("eventsMax", 200),
            verify_max=event_cfg.get("eventsVerifyMax", 50),
            path=self.events_path,
        )
        # 读历史事件的那句话**不在这里打**：__init__ 每造一个 Core 都会被调用
        # （测试里几千次），在这儿 print 会把测试输出刷没。存下来，由 run() 打。
        self.events_load_message = self.event_book.load()

        # ---- 历史行（Phase7）----
        # 默认同样是 None = 不碰磁盘，理由和上面一模一样：造一个 Core 不等于
        # 「现在该往 data/ 里写文件了」，跑测试的时候更不该。run() 显式递路径。
        #
        # 名字叫 history_writer 而不是 history：NodeState 上已经有一个 history
        # （内存里最近 N 条，给趋势图用的），两个都叫 history 的话，
        # 「self.history」在哪个类里是什么意思，读的人得先数一层。
        self.history_path = None if history_path is None else Path(history_path)
        self.history_writer = history.HistoryWriter(self.history_path)

        # ---- 在线 ML 判决（Phase8 D5）----
        # 默认同样是 None = **不判 ML**，理由和上面两条一样：造一个 Core 不等于
        # 「现在该去 models/ 找模型了」。它比上面两条更该守着这个默认 ——
        # 测试里每造一个 Core 都去读一遍 joblib 的话，几千个用例就是几千次磁盘 I/O。
        # 真正跑起来的那条路（run()）显式把 config.MODELS_DIR 递进来。
        #
        # 它**自己不存状态**：判词直接写在 record 上，跟着那条读数一起进
        # NodeState.history 和 CSV。另存一份就有两份真相 —— 而这两份一不一致，
        # 是不会有任何报错的。
        self.ml_judge = ml_judge.MlJudge(model_dir)

    # -- 生命周期 ----------------------------------------------------------

    @property
    def weights(self) -> dict[str, int]:
        """严重度权重。取自配置，缺的状态由 rules 里那份默认值兜底。"""
        table = dict(rules.SEVERITY_WEIGHTS)
        table.update(self.cfg.get("priority", {}).get("severity", {}))
        return table

    @property
    def state_stale_after_sec(self) -> int | None:
        """「多久没收到新快照，就该怀疑 core 没了」—— 秒。心跳关掉时是 None。

        取心跳间隔的 **3 倍**：连着三次都没来才说话。一次网络抖动、一次
        进程被系统换出去几十毫秒、一次 GC 停顿，都不该把整页变成「core
        没声了」；而三次全丢的概率低得多。

        这个数**由 core 算好放进快照**（core.staleAfterSec），三个前端照读 ——
        各自写一遍的话，「多久算久」在三个屏幕上会是三个答案，而它们并排摆着。

        None 的含义是「判不了」（配置把 stateHeartbeatSec 写成 0 了），
        **不是**「永远不算久」。页面必须把这两件事分开说。
        """
        heartbeat = self.cfg["stateHeartbeatSec"]
        return 3 * heartbeat if heartbeat > 0 else None

    # -- 收 -----------------------------------------------------------------

    def handle_message(self, topic: Any, payload_text: Any, now_wall: float | None = None) -> Verdict:
        """收到一条报文：校验 -> 判状态 -> 存 -> 重算优先级 -> 发快照。

        `now_wall` 可以传进来（测试用固定值），默认才是真正的此刻。
        """
        if now_wall is None:
            now_wall = time.time()

        verdict = validate_message(topic, payload_text, self.cfg["nodes"])

        if verdict.ignored:
            # 清 retained 的空报文：记一笔就走。不改任何节点的状态 ——
            # 这条消息说的是「broker 存的那一份删了」，跟这个宿舍现在
            # 什么状况一点关系都没有，拿它去动历史或结算一段才是错的。
            self.counters.retained_cleared += 1
            # 计数变了就重发一次（E3）。这个 counter 在快照里，而前端从 E3 起
            # **只订快照**：不重发的话页面上那个数会停在上一回的值上，直到下一
            # 条遥测才跳 —— 中间正好是「刚清完 retained、页面上还写着收到过 1 条」
            # 那一段。这一步以前漏着（快照里只有 counters 时没什么人看那个数），
            # 现在页面上要显示了，就得跟着发。
            self.publish_state(now_wall)
            return verdict

        if not verdict.ok:
            self.counters.rejected += 1
            self.publish_reject(topic, verdict.reasons, payload_text, now_wall)
            return verdict

        self.counters.received += 1
        if verdict.notes:
            self.counters.status_mismatch += 1

        record = verdict.record
        assert record is not None  # ok=True 时一定有 record
        node = self.nodes.get(record["nodeId"])
        if node is None:
            # validate_message 已经查过节点名了，走不到这里。
            # 留着是因为「查过了」和「这里不用防」是两件事。
            self.counters.rejected += 1
            self.publish_reject(
                topic, (f"未知节点 {record['nodeId']!r}",), payload_text, now_wall
            )
            return Verdict(False, reasons=(f"未知节点 {record['nodeId']!r}",))

        # 在线 ML 判决（Phase8 D5）。**必须在 node.apply 之前**：它判的是
        # 「这条读数像不像这个宿舍的平时」，而 apply 跑完之后这条读数就已经
        # 成了「历史」的一部分 —— 顺序反了，判的就变成「像不像含它自己的历史」。
        #
        # 判词挂在 record 上，不新增 NodeState 属性：NodeState.history 是
        # **同一批 dict 的 deque（同一个引用）**，所以这一份计算能喂三个消费者
        # —— 快照的节点级 mlLabel/mlText/agree、快照里逐行的 history、以及
        # CSV 的 ml_label / agree 两列。挂属性的话这三处都得再挑一遍，
        # 「怎么算一致」就有了第二份实现。
        #
        # 判不了时 ml_judge 返回 None，这里一个键都不加 —— CSV 那两列留空。
        # **留空 ≠ 判成正常**：一个是「没判」，一个是「判了说没事」。
        self._judge_ml(record)

        node.apply(record, now_wall, self.cfg["recoverConsecutiveNormal"])
        # 事件状态机跟在后面吃**同一份**判据：它读 node.abnormal_count /
        # consecutive_normal，不自己再数一遍。数两遍等于有两份真相，
        # 改一处漏一处的时候，「事件说恢复了、core 说还在异常」这种事
        # 不会有任何报错。
        #
        # 顺序也是定的：先 apply 再 observe。反过来的话这里读到的是**上一条**
        # 报文留下的计数，事件会比数据慢一条 —— 而慢的正好是恢复/未恢复
        # 那一条，也就是唯一要紧的那条。
        # 这一条读数落在哪条案卷里？两头都要看一眼：案卷可能被这条报文
        # **开出来**（异常段的第一条），也可能被它**收掉**（凑够 N 条正常的那一条）。
        # 所以先记下「进来时开着的那条」，写完再看一眼「出去时开着的那条」——
        # 后者管开案那一种（第一条异常读数自己就该带着刚开出来的案号），
        # 前者管收案那一种（那条正常读数还是验证数据，属于那条案卷）。
        # 不去拿 last_for() 攀一条早就结掉的案子：那是编。
        case_before = self.event_book.open_event(record["nodeId"])

        reason = self._reason_for(record["nodeId"], now_wall)
        for line in self.event_book.observe(node, record, reason=reason):
            log("事件", line)

        # 「它是什么时候被选成当前重点的」—— 记到它开着的那条事件上（E3）。
        # 放在 observe **之后**：那条消息得先把事件开出来，才有可能在它身上
        # 记这一笔（顺序反了的话，开案那一刻永远记不上）。时间用这条报文的
        # time 而不是此刻 —— 事件表里别的时刻都是报文时间，混两种时间的话
        # 同一行上会出现「起点在 20:30、被注意在 20:31」而其实只差一条。
        top = self.priority(now_wall)
        if top is not None:
            self.event_book.mark_priority(
                top.node_id,
                when=record.get("time") or format_time(now_wall),
                reason=top.reason,
            )

        # 历史行落盘（Phase7）。放在这儿而不是 handle_message 一进来就写：
        # event_id 要的是「这条读数落在哪条案卷里」，而那得等 observe 跑完才知道。
        # 换句话说，这一行写下去的时候，这条报文引起的变化**都已经落定了**。
        self._write_history(record, case_before)

        # 每收一条就重算并（内容变了才）重发快照。放在这里而不是放到
        # 主循环里定时发：定时发的话，两次发布之间收到的那几条数据
        # 在快照上永远看不见，而它们可能正好是把重点换掉的那两条。
        self.publish_state(now_wall)
        return verdict

    def _reason_for(self, node_id: str, now_wall: float | None = None) -> str | None:
        """这个节点**此刻**该被优先关注的理由（不在异常里就是 None）。

        事件把这句话记进 priority_reasons —— 「业务大脑当初为什么盯上它」
        得由业务大脑自己说，events.py 算不出这个（它手里没有整张排序表，
        也不该有）。
        """
        for entry in self.ranked(now_wall):
            if entry.node_id == node_id:
                return entry.reason
        return None

    def _write_history(self, record: dict[str, Any], case_before: Any = None) -> None:
        """把一条**已经校验通过**的报文追加进历史 CSV（Phase7）。

        写的是「读数」不是「状态」：一行下去就不改了，所以这里不重写整个文件、
        也不用关心上一次写到哪儿了（不像 events.json 那本要随状态机改）。

        `case_before` 是进这个方法之前那个节点开着的事件（可能没有）。挑案卷的
        规矩见调用点 —— 一句话：**能把这条读数归到某条案卷上就归，归不上就留空**，
        不为了「这一列不留空」去编一个案号。
        """
        case = self.event_book.open_event(record["nodeId"]) or case_before
        self.history_writer.append(
            record,
            event_id="" if case is None else case.event_id,
            event_state="" if case is None else case.state,
        )
        # 写不进去（磁盘满 / 被 Excel 占着 / 目录没了）**不许拖垮 core**：
        # 那件事和「宿舍是不是偏热」没有关系，而这台 core 还得接着判状态。
        # 所以只在出错那一刻打一行，之后静默跳过 —— 每条都打的话日志会被刷满。
        message = self.history_writer.take_error()
        if message is not None:
            log("历史", f"{message} —— 以后不再写 CSV，core 照常跑")

    def _judge_ml(self, record: dict[str, Any]) -> None:
        """给这条读数补上 ML 判词（Phase8 D5）。判不了就一个键都不补。

        补的是三个键，跟着 record 一路走到底（快照和 CSV 都读它）：
            ml_label   "normal" / "abnormal"           —— CSV 第 6 列、快照 mlLabel
            ml_text    「接近历史常态」/「与历史明显不同」 —— 快照 mlText，给人看
            ml_agree   规则和 ML 是不是同一个结论        —— CSV 第 10 列、快照 agree

        收尾照抄 _write_history：**出错不抛异常**。模型文件坏了、没装
        scikit-learn、预测时抛异常 —— 这些和「这个宿舍现在偏不偏热」一点关系都
        没有，不能因此让 core 停下判状态。所以原因在这里取一次打成一行日志，
        之后 ml_judge 内部静默跳过（理由见 ml_judge.py 的文件头）。
        每条都打的话，日志会被同一句话刷满，真正要看的「谁又偏热了」就淹了。
        """
        verdict = self.ml_judge.judge(record)
        if verdict is not None:
            record.update(verdict)
        message = self.ml_judge.take_error()
        if message is not None:
            log("ML", f"{message} —— 以后不再判 ML，core 照常跑")

    # -- 指令 ---------------------------------------------------------------

    def handle_command(
        self,
        topic: Any,
        payload_text: Any,
        now_wall: float | None = None,
    ) -> Verdict:
        """收到一条前端指令：校验 -> 按动词分派 -> 打一行日志。

        三个动词走的是**三条不同的路**，分开写而不是塞进一个动词表：

        * `handle` —— 前端说「我在处理了」。能变的只有事件的状态
          （OPEN -> HANDLING）；这个宿舍到底好没好，只能由后面收到的遥测
          数据说了算。**这个方法一行都不碰 self.nodes。**
        * `focus` —— 前端说「大家都看这个」。只动 self.focus，**一行都不碰
          事件簿**：被点名不是事件动作，它不该在案卷上留下任何痕迹，
          更不该给出一条绕过验证窗口的路。
        * `snapshot` —— 前端说「我拍了一张」（Phase6 E2）。只往开着的那条
          事件的 snapshots 里**追加一笔**，state / verify / recovered_at
          一个都不动：一张照片证明不了这个宿舍好了，它也绝不能顺手把
          OPEN 推成 HANDLING。（这就是 SNAPSHOT 没进 events.COMMANDS
          的原因，见那个常量的注释。）

        三条路的共同点是都不改 self.nodes —— 红线在这一层依然成立。
        """
        if now_wall is None:
            now_wall = time.time()

        verdict = validate_command(topic, payload_text, self.cfg["nodes"])

        if verdict.ignored:
            self.counters.retained_cleared += 1
            # 和 handle_message 那边同一条理由：计数变了就重发一次快照。
            self.publish_state(now_wall)
            return verdict

        if not verdict.ok:
            self.counters.command_rejected += 1
            self.publish_reject(topic, verdict.reasons, payload_text, now_wall)
            return verdict

        self.counters.commands += 1
        record = verdict.record
        assert record is not None  # ok=True 时一定有 record
        node_id = record["nodeId"]
        who = record.get("source") or "来源未标"

        if record["action"] == FOCUS:
            message = self.set_focus(node_id, source=record.get("source"), now_wall=now_wall)
            log("指令", f"{node_id} focus（{who}）-> 接受：{message}")
            return verdict

        if record["action"] == events.SNAPSHOT:
            # 第一条**碰得到案卷、但一个状态都不动**的动词。三条路分开写而不是
            # 合成一张动词表，好处在这一眼看得见：handle 那条会改 state，这条
            # 只会往 snapshots 里追加一笔，focus 那条连事件簿都不碰。
            accepted, message = self.event_book.record_snapshot(
                node_id,
                # 和 handle 同一条口径：动作什么时候发生的问发它的人（没给就
                # 用 core 的此刻），core 什么时候收到的由 core 自己带在
                # snapshots 那条记录里（record_snapshot 内部取 now_text()）。
                when=record.get("time") or format_time(now_wall),
                source=record.get("source"),
                event_id=record.get("eventId"),
                stamp=record.get("stamp"),
                watermark=record.get("watermark"),
                file=record.get("file"),
                width=record.get("width"),
                height=record.get("height"),
                size=record.get("bytes"),
            )
            log("指令", (
                f"{node_id} snapshot（{who}）-> "
                f"{'接受' if accepted else '没接受'}：{message}"
            ))
            # 重发快照。事件那条的 cameraCount 变了 —— 前端拍完照只会说
            # 「已经发出去」，要等这一帧回来才敢说「core 登记上了」。
            # 没接受时也发：计数和日志变了，而前端只订这一条 topic。
            self.publish_state(now_wall)
            return verdict

        accepted, message = self.event_book.apply_action(
            node_id,
            action=record["action"],
            # 指令没给 time 就由 core 补此刻 —— 「动作是什么时候发生的」
            # 只能问收到它的人，不能问发它的人。
            when=record.get("time") or format_time(now_wall),
            source=record.get("source"),
            reason=self._reason_for(node_id, now_wall),
        )
        log("指令", (
            f"{node_id} {record['action']}（{who}）-> "
            f"{'接受' if accepted else '没接受'}：{message}"
        ))
        # **重发快照**。E3 起快照里有 events（事件表）和 counters，这两个都因为
        # 这条指令变了：事件从 OPEN 变成 HANDLING、指令计数 +1。不重发的话，
        # 看板上那条事件会一直写着「待处理」，直到下一条遥测过来才跳 ——
        # 而「按了按钮，事件变成处理中」正是这一步要给人看的东西。
        #
        # 注意这**不是**在改节点状态：上面那句 assertEqual 测的就是这个，
        # 重发出去的那一份里 nodes 和 priority 一个字都没动（红线）。
        self.publish_state(now_wall)
        return verdict

    def set_focus(
        self,
        node_id: str,
        source: str | None = None,
        now_wall: float | None = None,
    ) -> str:
        """点名一个节点（或再点一次取消）。返回要说给日志听的那句话。

        **同一个节点点两次 = 取消**，不是「再点一次没反应」。理由是得有办法
        取消：没有取消的话，焦点一旦设上就再也没有任何一条报文能把它改掉 ——
        演示到一半想回到「谁也不看」，只能重启 core。这个判断放在这里而不是
        放在前端，是因为前端不许自己算（而且两个前端各算一次迟早会不一样）。

        焦点**不参与优先级排序**，也不改任何节点的状态：被点名的宿舍还是
        原来那个 status、原来那个 rank。「大家都在看它」和「它最该处理」
        是两件事，合成一件之后，谁按了按钮谁就成了最该处理的。
        """
        if now_wall is None:
            now_wall = time.time()

        node_id = str(node_id)
        if self.focus is not None and self.focus.get("nodeId") == node_id:
            self.focus = None
            message = "取消焦点（同一个人点了第二次）"
        else:
            self.focus = {
                "nodeId": node_id,
                "by": source or "来源未标",
                "at": format_time(now_wall),
            }
            message = f"焦点切到 {node_id}"

        # 快照里现在有 focus 这一块了，所以这一次**必须**重发：
        # 移动端点了「聚焦」而看板的焦点没跟过来，跨端联动就是假的。
        # force=True 是因为内容确实变了（变了才走到这里）——用 force 是为了
        # 把「这一步发生的本身要让人看见」写明确，不靠 payload 比较来兜。
        self.publish_state(now_wall, force=True)
        return message

    # -- 排 -----------------------------------------------------------------

    def views(self, now_wall: float | None = None) -> list[rules.NodeView]:
        """参与排序的节点：**在线**且当前这一段是异常。

        离线的节点不参与。它的数据停在半小时前了，拿它去和刚发来的数据比
        「谁更该先看」，等于把一个已经不知道现状的宿舍排在还在恶化的宿舍前面。
        它照样出现在快照的 nodes 里，online=false —— 看不见的东西才叫丢。

        now_wall 允许是 None（用此刻）—— 因为这一串方法经常被
        priority() 一步带下来，而优先级查询从调用方看是「就现在问一下」，
        不该逼每个调用点都先算一个时间戳再传进来。
        """
        if now_wall is None:
            now_wall = time.time()
        timeout = self.cfg["offlineTimeoutSec"]
        return [
            node.view()
            for node in self.nodes.values()
            if node.is_online(now_wall, timeout) and node.is_abnormal()
        ]

    def ranked(self, now_wall: float | None = None) -> list[rules.RankedNode]:
        return rules.rank_priority(self.views(now_wall), weights=self.weights)

    def priority(self, now_wall: float | None = None) -> rules.RankedNode | None:
        ranked = self.ranked(now_wall)
        return ranked[0] if ranked else None

    # -- 快照 ---------------------------------------------------------------

    def snapshot(self, now_wall: float | None = None) -> dict[str, Any]:
        """全局状态快照。每一个数字都是当场算的，没有一个是存下来的。"""
        if now_wall is None:
            now_wall = time.time()

        timeout = self.cfg["offlineTimeoutSec"]
        ranked = {node.node_id: node for node in self.ranked(now_wall)}
        top = self.priority(now_wall)

        nodes: list[dict[str, Any]] = []
        for node_id, node in self.nodes.items():
            duration = node.duration_seconds()
            online = node.is_online(now_wall, timeout)
            # 「已经多久没收到这个节点的数据了」。两格的口径和 durationSec /
            # durationText 那一对一样：秒给机器、文本给人，免得三个前端各写
            # 一遍「多长算多久」的格式化，又出第二、第三套说法。
            #
            # 在线、以及**一次都没收到过**的节点，这两格都是 None：
            #   * 在线 —— 这个数没有意义（它没掉线）
            #   * 没收到过 —— 「不知道」不是「离线了 3 分钟」（见 is_online）
            silent = node.offline_since(now_wall)
            offline_sec = None if online or silent is None else round(silent, 3)
            entry: dict[str, Any] = {
                "nodeId": node_id,
                "online": online,
                # status 可能是 None：**还没收到过数据** ≠ 正常
                "status": node.status,
                "temperature": None if node.latest is None else node.latest["temperature"],
                "humidity": None if node.latest is None else node.latest["humidity"],
                "time": None if node.latest is None else node.latest["time"],
                # 在线 ML 的判词（Phase8 D5）。和上面几格一样取自「最近那条读数」，
                # 所以**一条数据都没收到时是 None**，不能读成「判成正常」。
                # 收到了但这条没判成（这个宿舍没模型 / 没装 scikit-learn）时也是
                # None —— 前端两种情况都按「没有 ML 结论」渲染，与 CSV 那列留空
                # 是同一个口径。
                "mlLabel": None if node.latest is None else node.latest.get("ml_label"),
                # 中文判词由 core 算好递出来（ml.ml_text）。让前端拿 normal/abnormal
                # 自己翻一句人话，就是把「这个结论怎么叫」复制出第二份 ——
                # 而两份说法的第一次不一致，不会有任何报错。
                "mlText": None if node.latest is None else node.latest.get("ml_text"),
                "agree": None if node.latest is None else node.latest.get("ml_agree"),
                # 秒是给机器算的，durationText 是给人看的 —— 两个都给，
                # 免得前端自己再写一遍「多长算多久」的格式化，又出第二套说法
                "abnormalCount": node.abnormal_count,
                "durationSec": round(duration, 3),
                # 只有**在这一段异常里**才说时长。一个正常节点 duration 也是 0，
                # 按 format_duration 会说成「不到 1 分钟」—— 那是在说一件
                # 没发生过的事。这和「一条数据都没有 ≠ 正常」是同一条原则。
                "durationText": (
                    rules.format_duration(duration) if node.is_abnormal() else None
                ),
                "reason": ranked[node_id].reason if node_id in ranked else None,
                "lastSeen": None if node.last_seen is None else format_time(node.last_seen),
                # 离线多久了（D4）。在线 / 没收到过时是 None，见上面那段。
                "offlineSec": offline_sec,
                "offlineText": (
                    None if offline_sec is None else rules.format_duration(offline_sec)
                ),
                "historyCount": len(node.history),
                # 趋势图的数据源（E3）。前端从这一步起**不再订遥测**，所以图上
                # 的点必须跟着快照一起来 —— 不然页面刷一下，图上就一条线都没有，
                # 得干等几分钟才看得出走势（而「刚刚是不是在降」正是最该看的时候）。
                #
                # 每条只留画图要用的四个字段：完整报文里的 seq / source 在这里
                # 一个都用不到，而这份东西是每个周期都要重发一遍的。
                "history": [
                    {
                        "time": item.get("time"),
                        "temperature": item.get("temperature"),
                        "humidity": item.get("humidity"),
                        "status": item.get("status"),
                        # 逐行的 ML 判词（Phase8 D5）。节点级那三格只说得清「最近
                        # 一条」，而看板的实时对照表要的是**每一行**两边各判了什么
                        # —— 构造样本回放时同一屏上就同时有判得一致和判得不一致的
                        # 行，只给最近一条的话，前面那几条的结论一转身就没了。
                        # 没判成的那几行同样是 None，前端跳过不画。
                        "mlLabel": item.get("ml_label"),
                        "mlText": item.get("ml_text"),
                        "agree": item.get("ml_agree"),
                    }
                    for item in node.history
                ],
            }
            nodes.append(entry)

        return {
            "v": SNAPSHOT_VERSION,
            "time": format_time(now_wall),
            # ---- core 自己的心跳（Phase9 D4）----
            #
            # 【这一块存在的唯一理由】页面上要能看出「core 还在不在」。
            # 判据不能是「收没收到快照」：快照是 **retained** 的，core 死了之后
            # broker 手里那一份还在，后开的页面照样会收到它 —— 而它长得和活着
            # 的时候一模一样。所以判据只能是「收到的那一帧有多旧」。
            #
            # 三格的分工：
            #   epochMs       这一帧是**什么时候**的（毫秒）。前端拿自己的表
            #                 跟它一比就知道旧不旧。用毫秒整数而不是那串
            #                 "%Y-%m-%d %H:%M:%S"，是因为后者要前端自己解析，
            #                 而带不带时区、按谁的时区解，两个浏览器能给两个答案。
            #   staleAfterSec 超过多少秒没收到更新的帧就该怀疑 core 没了。
            #                 **由 core 算好**（见 state_stale_after_sec），
            #                 三个前端照读 —— 各自写一遍就是三个答案。
            #                 null = 心跳被配置关掉了，这时前端该说「判不了」。
            #   online        **恒为 true，别拿它判活**。它只可能由活着的 core
            #                 写下来，死了就没人写了 —— 所以它证明不了任何事，
            #                 retained 的那一帧会一直带着它。留着这一格是为了
            #                 让「core 状态」这件事在这份快照里有个名字，
            #                 真正判活的是上面那两格。
            "core": {
                "online": True,
                "epochMs": int(round(now_wall * 1000)),
                "staleAfterSec": self.state_stale_after_sec,
            },
            # 谁被点名了（E3）。null = 没人被点名 —— 那是「大家看默认那个」，
            # 不是「不知道谁被点名了」，所以两个前端都得把这个 null 认成
            # 「回落到 priority」，不能认成「什么都别高亮」。
            "focus": None if self.focus is None else dict(self.focus),
            "priority": None if top is None else {
                "nodeId": top.node_id,
                "status": top.status,
                "severity": top.severity,
                "abnormalCount": top.count,
                "durationSec": round(top.duration, 3),
                "durationText": rules.format_duration(top.duration),
                "reason": top.reason,
            },
            "nodes": nodes,
            # 事件表（E3）。**只发最近 SNAPSHOT_EVENTS_MAX 条**，但 summary 里的
            # total 是真的总数 —— 前端那行「共 N 条」读的是 summary，不是数组长度。
            "events": self.event_book.view(limit=SNAPSHOT_EVENTS_MAX),
            # 被拒绝日志（E3）。前端只订这一条 topic，所以这份跟着快照走；
            # REJECT_TOPIC 照发不误，给 MQTTX 和命令行用。
            "rejects": {
                "total": self.rejects_total,     # 一共拒过多少条
                "kept": len(self.rejects),       # 这几条是最近 kept 条里的
                "items": [dict(item) for item in self.rejects],
            },
            "counters": {
                "received": self.counters.received,
                "rejected": self.counters.rejected,
                "statusMismatch": self.counters.status_mismatch,
                "retainedCleared": self.counters.retained_cleared,
                "commands": self.counters.commands,
                "commandRejected": self.counters.command_rejected,
            },
        }

    def publish_state(self, now_wall: float | None = None, force: bool = False) -> bool:
        """把快照发到 dormmate/v1/state（retained）。发布了返回 True。

        只在**内容变了**的时候发。每条都发的话，一个 2 秒一条的模拟器
        会让这条 topic 每秒刷一次，而绝大多数时候内容一个字都没变 ——
        抓包截图上全是一样的报文，真正变化的那一条反而看不出来。

        `force=True` 用于启动和离线判定之后：那时候内容**可能**没变
        （比如 time 变了但别的都没变），但这一步发生的本身就得让人看见。
        """
        if now_wall is None:
            now_wall = time.time()
        payload = json.dumps(self.snapshot(now_wall), ensure_ascii=False, sort_keys=False)
        if not force and payload == self._last_state_payload:
            return False
        self._last_state_payload = payload
        # 记下「发出去的那一刻」，心跳拿它算间隔。**记在这里而不是调用点**：
        # 发快照有好几条路（收到遥测、拒收、切焦点、掉线），漏记任何一条，
        # 心跳就会在那条路上多发一次 —— 而多发是看不出来的。
        self._last_state_at = now_wall
        self.publish(config.STATE_TOPIC, payload, retain=True)
        return True

    def heartbeat(self, now_wall: float | None = None) -> bool:
        """到点了就重发一帧快照，**哪怕内容一个字都没变**。发了返回 True。

        【为什么需要它】见 snapshot 里 core 那一块的注释：判活的唯一依据是
        「这一帧有多旧」，那就必须保证活着的时候帧一定是新的。而 publish_state
        只在内容变了才发 —— 内容里带着 time，所以有活动的时候一秒一条，
        安静的时候几分钟一条都没有（刚起 core、模拟器还没开就是这种）。
        没有心跳的话，那种安静会被页面读成「core 没了」。

        【多久算到点】core/config.json 的 stateHeartbeatSec，写 0 = 关掉。
        关掉之后快照里 core.staleAfterSec 是 null，页面说「判不了」——
        比让它随便挑一个数猜要诚实。

        【为什么单独一个方法，不塞进 tick()】tick() 的语义是「看看哪个节点
        掉线了、返回这一轮新掉的」，纯状态推进；心跳是「往外发一条」。
        两件事混在一起之后，写 tick 的测试就得同时关心发没发报文。
        """
        heartbeat_sec = self.cfg["stateHeartbeatSec"]
        if heartbeat_sec <= 0:
            return False
        if now_wall is None:
            now_wall = time.time()
        if self._last_state_at is not None and now_wall - self._last_state_at < heartbeat_sec:
            return False
        self.publish_state(now_wall, force=True)
        return True

    # -- 发 -----------------------------------------------------------------

    def publish(self, topic: str, payload: str, retain: bool) -> None:
        if self.client is None:
            return
        self.client.publish(topic, payload, qos=self.cfg.get("_qos", config.QOS), retain=retain)

    def publish_reject(
        self,
        topic: Any,
        reasons: tuple[str, ...],
        payload_text: Any,
        now_wall: float | None = None,
    ) -> None:
        """把一条非法报文记到 dormmate/v1/log/reject。

        **retain=False**（显式写出来，不靠 paho 的默认值）：
        这是一条日志，不是一份状态。保留住的话，后开的人一订阅就收到
        一条半小时前的「某某报文非法」，会以为现在还在出错。

        另外这里**不回显原始报文全文** —— 只留前面一段。一来日志是给人看的，
        二来把来路不明的字节原样转发出门不是个好习惯。
        """
        body = {
            "time": format_time(),
            "topic": None if topic is None else str(topic),
            "reasons": list(reasons),
            "payload": self._clip(payload_text),
        }
        self.publish(config.REJECT_TOPIC, json.dumps(body, ensure_ascii=False), retain=False)

        # 同一份东西也留在内存里，供快照带着走（E3）。**是同一份，不是另攒一份**：
        # 页面上的被拒绝面板和 MQTTX 里抓到的那条必须逐字一致，否则「页面上没
        # 显示」和「根本没发出来」这两种情况在排查时分不出来。
        self.rejects.append(body)
        self.rejects_total += 1

        # **重发一次快照**。前端从 E3 起只订 dormmate/v1/state，被拒绝面板读的是
        # 快照里那份 —— 这里不重发的话，那条日志发到 REJECT_TOPIC 上就没了，
        # 页面上永远看不见（面板是死的，而且**不报错**）。
        #
        # 放在这里而不是放在三个调用点：拒收有好几条路（遥测坏报文、未知节点、
        # 坏指令），漏掉任何一条就是「某一种拒收页面上看不到」—— 收在这一个
        # 出口上，将来加第四条路也不会漏。
        self.publish_state(now_wall)

    @staticmethod
    def _clip(payload_text: Any) -> str:
        text = "" if payload_text is None else str(payload_text)
        if len(text) <= REJECT_PAYLOAD_MAX:
            return text
        return text[:REJECT_PAYLOAD_MAX] + f"…（后面还有 {len(text) - REJECT_PAYLOAD_MAX} 个字符）"

    # -- 心跳 ---------------------------------------------------------------

    def tick(self, now_wall: float | None = None) -> list[str]:
        """每次循环调用一次：看看有没有节点掉线了。

        返回**新**判定为离线的节点名（这一轮才掉的那些）。已经记过的
        不再返回 —— 不然每 0.5 秒报一次「dorm-c 离线」，日志里就只看得见这一句了。
        """
        if now_wall is None:
            now_wall = time.time()

        timeout = self.cfg["offlineTimeoutSec"]
        # 只报「收到过数据、后来又安静了」的节点。一次都没收到过的节点
        # 报「离线」是错的 —— 它可能压根还没启动，说它离线会让人去查一个
        # 根本不存在的问题。它的状态在快照里是 online=false + status=null，
        # 那是「还不知道」，不是「掉了」。
        went_offline = [
            node_id for node_id, node in self.nodes.items()
            if node.last_seen is not None
            and not node.is_online(now_wall, timeout)
            and node_id not in self.offline
        ]
        self.offline = [
            node_id for node_id, node in self.nodes.items()
            if node.last_seen is not None and not node.is_online(now_wall, timeout)
        ]

        if went_offline:
            # 掉线会改变「谁在参与排序」，所以快照必须重发 —— 哪怕
            # 节点自己的状态一个字没变。
            self.publish_state(now_wall, force=True)
        return went_offline

    # -- paho 回调 ----------------------------------------------------------

    def on_connect(
        self,
        client: Any,
        userdata: Any,
        flags: Any,
        reason_code: Any,
        properties: Any = None,
    ) -> None:
        """连上了（**包括断线重连**）：重新订阅、重新上报自己在线。

        每次重连都要重订，不能只在第一次订：broker 重启、网络断一下，
        session 就没了，而 client 对象还在、程序还在跑、日志也不报错，
        只是从此一条消息都收不到。这是「看着一切正常」里最难查的一种。
        """
        if getattr(reason_code, "is_failure", False):
            log("连接", f"连不上 broker：{reason_code}")
            return
        client.subscribe(config.TOPIC_PATTERN, qos=self.cfg.get("_qos", config.QOS))
        # 指令那条也一起订。漏订这一条的现象特别难查：core 一切正常、
        # 遥测照收、快照照发，只是前端按了半天按钮，日志里一个字都没有 ——
        # 看起来像前端坏了。所以两处订阅写在一起，加订阅的时候不会漏掉一条。
        client.subscribe(config.CMD_TOPIC, qos=self.cfg.get("_qos", config.QOS))
        log("连接", f"已连接，订阅 {config.TOPIC_PATTERN} 和 {config.CMD_TOPIC}")
        # 先把自己标成在线，再发第一份快照：顺序反过来的话，
        # 订阅方有可能先看到快照、再看到 core 离线（那还是上一条遗嘱）。
        self.publish(
            config.CORE_STATUS_TOPIC,
            json.dumps({"core": "online", "time": format_time()}, ensure_ascii=False),
            retain=True,
        )
        self.publish_state(force=True)

    def on_disconnect(
        self,
        client: Any,
        userdata: Any,
        flags: Any = None,
        reason_code: Any = None,
        properties: Any = None,
    ) -> None:
        log("连接", f"与 broker 断开：{reason_code}")

    def on_message(self, client: Any, userdata: Any, message: Any) -> None:
        text = message.payload.decode("utf-8", errors="replace")

        # 按 topic 分派。判据是**精确相等**，不是 startswith：
        # 通配符那条订阅和这条指令 topic 号段完全不同，将来加第二条指令 topic
        # 的时候，「以 dormmate/v1/cmd 开头就算指令」会让 dormmate/v1/cmd-log
        # 这种 topic 悄悄走进来处理。
        if message.topic == config.CMD_TOPIC:
            self._on_command_message(message, text)
            return

        verdict = self.handle_message(message.topic, text)

        if verdict.ignored:
            log("保留", f"{message.topic} -> " + "；".join(verdict.reasons))
            return

        if not verdict.ok:
            log("拒绝", f"{message.topic} -> " + "；".join(verdict.reasons))
            return

        record = verdict.record
        assert record is not None
        node = self.nodes[record["nodeId"]]

        if not self.quiet:
            line = (
                f"{record['nodeId']} {record['temperature']:g}℃/"
                f"{record['humidity']:g}% {record['status']}"
            )
            if node.is_abnormal():
                # 开着的那一段里，这一条可能是异常、也可能是「正在往正常走」。
                # 两种情况分开说：正常的那条如果还写「第 N 条异常」，看的人会
                # 以为是又恶化了，而实际上它是恢复路上的第一条。
                if record["status"] == rules.STATUS_NORMAL:
                    left = node.normals_until_recovery(
                        self.cfg["recoverConsecutiveNormal"])
                    line += f"（正常，还差 {left} 条正常才算这一段结束）"
                else:
                    line += (
                        f"，这段已持续 {rules.format_duration(node.duration_seconds())}"
                        f"（第 {node.abnormal_count} 条异常）"
                    )
            if verdict.notes:
                line += "  [注意] " + "；".join(verdict.notes)
            log("数据", line)

        # 每收一条就把「现在该看谁」打一行。这是 core 作为业务大脑的对外结论，
        # 不打印的话，日志里只有一堆原始数据，得自己心算才知道重点变了没有。
        self.report()

    def _on_command_message(self, message: Any, text: str) -> None:
        """指令那条路上的回调尾巴：打日志。

        遥测那条路要 report()（重点可能换人了），这条路**不要**：
        指令不改变任何节点的数据，重点不可能因为一条指令而换人。
        （真要换，只能是新数据来了 —— 也就是遥测那条路的事。）
        """
        verdict = self.handle_command(message.topic, text)

        if verdict.ignored:
            log("保留", f"{message.topic} -> " + "；".join(verdict.reasons))
            return

        if not verdict.ok:
            log("拒绝", f"{message.topic} -> " + "；".join(verdict.reasons))
            return
        # 成功那条已经在 handle_command 里打过「指令」一行了，这里不再重复。

    def report(self, now_wall: float | None = None) -> str:
        """把当前的重点打一行 —— **只在换人的时候**。

        比的是「是谁」，不是那整句话。整句话里含时长，而时长每收一条都在涨
        （「不到 1 分钟」→「1 分钟」→「2 分钟」…），拿它当判据的话
        每一条都会「变了」，等于没判。时长涨了不是新闻，换人才是新闻。
        代价是：同一个节点还在首位、但赢的理由从时长变成了次数时，
        这一行不吭声 —— 那种信息在快照的 reason 里，不在日志里。

        每条都打的话，三节点 2 秒一条的模拟器会让日志里全是同一句
        「重点 dorm-b」，而真正该被看见的那一次（换成了 dorm-c）夹在中间，
        翻日志都翻不出来。

        返回值是这一行的文字，方便测试直接断言，不用去抓 stdout。
        """
        top = self.priority(now_wall)
        line = "没有需要优先处理的节点" if top is None else f"{top.node_id} —— {top.reason}"
        node_id: str | None = None if top is None else top.node_id
        if node_id != self._last_priority_node:
            self._last_priority_node = node_id
            log("重点", line)
        return line


# --------------------------------------------------------------------------
# 日志
# --------------------------------------------------------------------------

def log(kind: str, text: str) -> None:
    """一行一条，格式固定，方便截图和按前缀过滤。

    只用中文和 ASCII：控制台是 GBK，✓ / ✗ / ⑫ 这类字符一 print 就抛
    UnicodeEncodeError，而且是在演示到一半的时候。
    """
    print(f"[{format_time()}] [{kind}] {text}", flush=True)


# --------------------------------------------------------------------------
# 配置
# --------------------------------------------------------------------------

def load_config(path: str | Path | None = None) -> dict[str, Any]:
    """读 core/config.json 并检查它自己是否自洽（不涉及规则真源）。

    分成两步是刻意的：
      * 这里只查「这份文件自己完不完整」（缺字段、类型不对、节点列表空）
      * 和 status_rules / config.py 的一致性由 check_against_sources() 查
    两种错的原因和改法完全不同，混在一个报错里说不清楚该改哪儿。
    """
    target = Path(path) if path else Path(config.CORE_CONFIG_PATH)
    if not target.is_file():
        raise ConfigError(f"找不到配置文件：{target}")

    try:
        with target.open(encoding="utf-8") as handle:
            cfg = json.load(handle)
    except ValueError as exc:
        raise ConfigError(f"{target} 不是合法的 JSON：{exc}") from exc

    if not isinstance(cfg, dict):
        raise ConfigError(f"{target} 的顶层应该是一个对象")

    problems: list[str] = []

    nodes = cfg.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        problems.append("nodes 应该是非空的列表")
    elif any(not isinstance(n, str) or not n for n in nodes):
        problems.append("nodes 里每一项都得是非空字符串")
    elif len(set(nodes)) != len(nodes):
        problems.append(f"nodes 里有重复：{nodes}")

    thresholds = cfg.get("thresholds")
    if not isinstance(thresholds, dict):
        problems.append("thresholds 应该是一个对象")
    else:
        for key in ("temperatureLow", "temperatureHigh", "humidityHigh"):
            value = thresholds.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                problems.append(f"thresholds.{key} 应该是数字")

    severity = cfg.get("priority", {}).get("severity") if isinstance(cfg.get("priority"), dict) else None
    if not isinstance(severity, dict) or not severity:
        problems.append("priority.severity 应该是非空的对象")
    elif any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in severity.values()):
        problems.append("priority.severity 的每个值都应该是数字")

    for key, minimum in (
        ("offlineTimeoutSec", 1),
        ("recoverConsecutiveNormal", 1),
        ("historyMax", 1),
        # D4 的快照心跳。**下限是 0 而不是 1**：0 是有含义的合法值
        # （关掉心跳），快照里 core.staleAfterSec 会变成 null，
        # 页面会说「判不了」——那是如实回答，不是错误。
        ("stateHeartbeatSec", 0),
    ):
        value = cfg.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
            problems.append(f"{key} 应该是不小于 {minimum} 的整数")

    loop = cfg.get("loop")
    if not isinstance(loop, dict):
        problems.append("loop 应该是一个对象")
    else:
        value = loop.get("timeoutSec")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
            problems.append("loop.timeoutSec 应该是正数")

    # events 是 D3 新增的一块。这里**要求它必须在**，不是「不给就用默认值」：
    # 默认值会让「配置里写错了键名」（eventsVerifyMax 写成 eventsVerify）变成
    # 一个静默的行为差异 —— 文件里写着 20，跑起来按 50 走，谁也不报错。
    event_cfg = cfg.get("events")
    if not isinstance(event_cfg, dict):
        problems.append("events 应该是一个对象（verifyConsecutiveAbnormal / eventsMax / eventsVerifyMax）")
    else:
        for key in ("verifyConsecutiveAbnormal", "eventsMax", "eventsVerifyMax"):
            value = event_cfg.get(key)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                problems.append(f"events.{key} 应该是不小于 1 的整数")

    if problems:
        raise ConfigError(
            f"{target} 有问题：\n  - " + "\n  - ".join(problems)
        )
    return cfg


def check_against_sources(cfg: dict[str, Any]) -> None:
    """核对那些「在别处也有一个出处」的参数。对不上就抛 ConfigError。

    为什么不是「以某一方为准」：这两处都是人手写的，谁对谁错只有人知道。
    悄悄选一边的后果是另一边的数字从此没人看 —— 直到某天它被当真。
    所以这里不选，报错，并把两边都打出来。

    不用 assert：assert 在 `python -O` 下会被整段去掉，
    于是这道检查在最需要它的时候（有人为了"跑快点"加了 -O）恰好不存在。
    """
    problems: list[str] = []

    # 阈值 vs status_rules.py（规则的真源）
    pairs = (
        ("temperatureLow", rules.TEMP_LOW, "TEMP_LOW"),
        ("temperatureHigh", rules.TEMP_HIGH, "TEMP_HIGH"),
        ("humidityHigh", rules.HUMIDITY_HIGH, "HUMIDITY_HIGH"),
    )
    for key, source_value, source_name in pairs:
        mine = cfg["thresholds"][key]
        if float(mine) != float(source_value):
            problems.append(
                f"  thresholds.{key} = {mine}，但 status_rules.{source_name} = {source_value}"
                "（status_rules.py 是规则的真源，改阈值要改那边，再同步这一份）"
            )

    # 节点列表 vs config.py
    if list(cfg["nodes"]) != list(config.NODE_IDS):
        problems.append(
            f"  nodes = {cfg['nodes']}，但 config.NODE_IDS = {config.NODE_IDS}"
            "（两处的节点列表必须一致，否则 core 会把某个节点当成未知节点拒收，"
            "而模拟器还在照常发它的数据）"
        )

    if problems:
        raise ConfigError("配置和别处的出处对不上：\n" + "\n".join(problems))


class ConfigError(Exception):
    """配置有问题。报错要说清改哪个文件的哪一行，不能只说「配置错了」。"""


def resolve_broker(cfg: dict[str, Any]) -> dict[str, Any]:
    """broker 连接参数。core/config.json 里写 null 就用 config.py 那份。

    「null 就跟着 config.py」而不是「两边必须相等」：换 broker 时只要设一个
    DORMMATE_MQTT_HOST 环境变量，不用同时改两个文件 —— 而"要同时改两个文件"
    正是那种一定会漏一个的设计。
    """
    broker = cfg.get("broker", {}) or {}
    return {
        "host": broker.get("host") or config.MQTT_HOST,
        "port": int(broker.get("port") or config.MQTT_TCP_PORT),
        "qos": int(broker.get("qos") if broker.get("qos") is not None else config.QOS),
        "keepalive": int(broker.get("keepaliveSec") or 30),
    }


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------

def build_client(cfg: dict[str, Any], broker: dict[str, Any]) -> mqtt.Client:
    """造一个 paho v2 的 client，带上遗嘱（LWT）。

    遗嘱必须**在 connect 之前**设好：它存在 CONNECT 报文里，
    连上之后再设就只对下一次连接有效 —— 也就是说这一次进程被 kill 掉的时候，
    broker 广播的还是上一条遗嘱（或者是根本没有）。
    """
    # CallbackAPIVersion.VERSION2 是 paho 2.x 要求的写法。
    # 不写的话它会退回 v1 的回调签名（on_connect 少一个 properties 参数），
    # 然后在你收到第一条消息时才抛 TypeError —— 离出错的地方已经十万八千里。
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="dormmate-core",
        protocol=mqtt.MQTTv311,
    )
    if config.MQTT_USERNAME:
        client.username_pw_set(config.MQTT_USERNAME, config.MQTT_PASSWORD)

    # ---- 遗嘱：core 掉线时由 broker 替它发这一条 ----
    # 这是「core 是否在线」唯一靠得住的判据：进程被 kill -9、断电、拔网线，
    # 都没有机会执行任何清理代码，只有 broker 发现 keepalive 超时后
    # 能替它把这条 retained 报文发出去。写在 try/finally 里发是不行的。
    client.will_set(
        config.CORE_STATUS_TOPIC,
        json.dumps({"core": "offline", "time": format_time()}, ensure_ascii=False),
        qos=broker["qos"],
        retain=True,
    )
    return client


def heartbeat_text(cfg: dict[str, Any]) -> str:
    """心跳那一句话，给人看。启动日志和 `--check` 两处共用一份说法。

    单独开一个函数是因为那句话有两种形态（开着 / 关掉），而两处各写一遍
    「if 0 then X else Y」的话，迟早有一处忘了改 —— 启动日志说「心跳 5 秒」、
    --check 说「心跳关」，两个都在屏幕上，谁也不知道该信哪个。
    """
    heartbeat = cfg["stateHeartbeatSec"]
    if heartbeat <= 0:
        return "关掉了（快照里 staleAfterSec 会是 null，页面会说判不了）"
    return f"{heartbeat}s（超过 {heartbeat * 3}s 没新帧，页面就说 core 没声了）"


def run(cfg: dict[str, Any], quiet: bool = False) -> int:
    broker = resolve_broker(cfg)
    # _qos 单独塞进去：Core 里只认 cfg，不该让它再去读一遍 config.py。
    # 加下划线是明说「这不是配置文件的字段，是运行期算出来递进来的」。
    cfg = dict(cfg, _qos=broker["qos"])

    # events_path 显式递进来。Core 的默认是「不碰磁盘」——
    # 「真正跑起来」这个决定是在这里下的，不能藏在构造函数里。
    core = Core(cfg, quiet=quiet, events_path=config.EVENTS_PATH,
                history_path=config.HISTORY_PATH, model_dir=config.MODELS_DIR)
    client = build_client(cfg, broker)
    core.client = client
    client.on_connect = core.on_connect
    client.on_disconnect = core.on_disconnect
    client.on_message = core.on_message

    log("启动", (
        f"连 {broker['host']}:{broker['port']}，"
        f"{len(cfg['nodes'])} 个节点 {'/'.join(cfg['nodes'])}，"
        f"离线超时 {cfg['offlineTimeoutSec']}s，"
        f"快照心跳 {heartbeat_text(cfg)}，"
        f"连续 {cfg['recoverConsecutiveNormal']} 条正常算恢复，"
        f"处理后再连续 {cfg['events']['verifyConsecutiveAbnormal']} 条异常算没治好"
    ))
    # 读历史事件的结果在这里打 —— 起来的时候必须让人看见「这一叠是从哪儿接上的」。
    log("事件", f"{core.events_path.name}：{core.events_load_message}")
    # 历史 CSV 是**追加**的，所以「这一次接着哪一份往下写」也要让人看见：
    # 是新起一份，还是接在昨天那份后面继续加，验收时这两件事完全不一样。
    log("历史", f"{core.history_path.name}："
                f"{'接在已有文件后面写' if core.history_path.exists() else '新起一份，先写表头'}"
                f"　（{config.HISTORY_PATH}）")
    # ML 这条链（Phase8 D5）同样要在启动时说清楚自己是什么状态。三句话分别是
    # 「加载了 N 个模型」/「还没跑过训练脚本」/「出错了，这条链停了」——
    # 对应「会判」「没判」「不判」，而不是一律无声无息。
    # 这一句同时**触发加载**（MlJudge 是懒加载的），所以「加载了几个模型」不会
    # 拖到第一条遥测才发生 —— 那时候人已经不看日志了。
    log("ML", core.ml_judge.describe())
    try:
        client.connect(broker["host"], broker["port"], keepalive=broker["keepalive"])
    except OSError as exc:
        log("启动", f"连不上 {broker['host']}:{broker['port']} —— {exc}")
        log("启动", "broker 起来了吗？跑 start_broker.bat，或先跑 tests/broker_selftest.py 验一下")
        return 2

    timeout = cfg["loop"]["timeoutSec"]
    try:
        while True:
            # loop(timeout) 会阻塞着处理网络事件，on_message 就在这里面被回调。
            # 轮询式写法的好处：主循环的每一步都是串行的，状态不需要加锁。
            client.loop(timeout=timeout)
            went_offline = core.tick()
            for node_id in went_offline:
                log("离线", f"{node_id} 超过 {cfg['offlineTimeoutSec']}s 没有新数据，"
                            "不再参与优先排序（数据保留在快照里）")
            # 心跳（D4）。安静的时候也把快照重发一遍，否则「页面收到的最后一帧
            # 有多旧」这件事就判不出来 —— 判活靠的是它。
            core.heartbeat()
    except KeyboardInterrupt:
        log("退出", "收到 Ctrl+C，正在下线")
    finally:
        # 正常退出时自己把离线状态发出去，不等遗嘱 —— 遗嘱是给
        # 「来不及说话」的那种情况用的。主动说一声比等 broker 超时快，
        # keepalive 是 30 秒，订阅方没必要多等这 30 秒。
        core.publish(
            config.CORE_STATUS_TOPIC,
            json.dumps({"core": "offline", "time": format_time()}, ensure_ascii=False),
            retain=True,
        )
        # 历史 CSV 收尾。每条都 flush 过，所以这里关不关都不会丢数据 ——
        # 关是因为 Windows 上一个进程攥着的文件，Excel 是打不开的，
        # 而「一边跑 core 一边翻那份 CSV」正是验收时会做的事。
        core.history_writer.close()

        client.disconnect()
        client.loop(timeout=0.5)   # 把 disconnect 真正送出去
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="DormMate core —— 订阅遥测、判定状态、发布优先关注与全局快照",
    )
    parser.add_argument("--config", default=None, help="配置文件路径（默认 core/config.json）")
    parser.add_argument("--check", action="store_true",
                        help="只读配置并核对，不连 broker")
    parser.add_argument("--quiet", action="store_true", help="不逐条打印收到的数据")
    args = parser.parse_args(argv)

    try:
        cfg = load_config(args.config)
        check_against_sources(cfg)
    except ConfigError as exc:
        # 配置问题**必须**让进程失败退出，不能「先跑起来再说」：
        # 一个阈值对不上的 core 会安安静静地按错的规则判上一整场演示。
        print(f"配置有问题，没有启动：\n{exc}", file=sys.stderr)
        return 1

    if args.check:
        broker = resolve_broker(cfg)
        print("配置核对通过：")
        print(f"  节点          {cfg['nodes']}")
        print(f"  阈值          和 status_rules.py 一致"
              f"（{cfg['thresholds']['temperatureLow']}/"
              f"{cfg['thresholds']['temperatureHigh']}/"
              f"{cfg['thresholds']['humidityHigh']}）")
        print(f"  严重度权重    {cfg['priority']['severity']}")
        print(f"  离线超时      {cfg['offlineTimeoutSec']} 秒")
        print(f"  快照心跳      {heartbeat_text(cfg)}")
        print(f"  恢复判据      连续 {cfg['recoverConsecutiveNormal']} 条正常")
        print(f"  未恢复判据    处理后再连续 "
              f"{cfg['events']['verifyConsecutiveAbnormal']} 条异常")
        print(f"  历史上限      {cfg['historyMax']} 条 / 节点")
        print(f"  事件文件      {config.EVENTS_PATH}")
        print(f"  历史文件      {config.HISTORY_PATH}（每收一条合法遥测追加一行）")
        print(f"                最多留 {cfg['events']['eventsMax']} 条事件，"
              f"每条最多 {cfg['events']['eventsVerifyMax']} 条验证数据")
        # ML 这条链的状态也报出来（Phase8 D5）。放在事件那两行**之后**：
        # 「最多留 N 条」说的是上面那个事件文件，插在它俩中间就把一对拆散了。
        print(f"  ML 模型目录   {config.MODELS_DIR}")
        print(f"                {ml_judge.MlJudge(config.MODELS_DIR).describe()}")
        print(f"  broker        {broker['host']}:{broker['port']} qos={broker['qos']}")
        print(f"  topic         订阅 {config.TOPIC_PATTERN}")
        print(f"                指令 {config.CMD_TOPIC}（retain=False）")
        print(f"                快照 {config.STATE_TOPIC}（retained）")
        print(f"                拒绝 {config.REJECT_TOPIC}（retain=False）")
        print(f"                在线 {config.CORE_STATUS_TOPIC}（retained + 遗嘱）")
        return 0

    return run(cfg, quiet=args.quiet)


if __name__ == "__main__":
    raise SystemExit(main())
