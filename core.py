"""DormMate core —— 唯一业务大脑。

    py -3.14 core.py                  # 连本机 broker，跑起来
    py -3.14 core.py --check          # 只核对配置，不连 broker（0=对得上，1=对不上）
    py -3.14 core.py --config 别的.json
    py -3.14 core.py --quiet          # 只报拒绝和快照，不逐条报收到的数据

这个文件要**替全校所有的前端做判断**。所以它自己不渲染任何东西，
只做四件事：

    1) 收：订阅 dormmate/v1/nodes/+/telemetry，校验每一条报文
    2) 判：status 一律用 rules.judge_status 重算，**不信报文里写的值**
    3) 排：把异常节点交给 rules.rank_priority，得出「最该先看的是谁、为什么」
    4) 发：retained 快照发到 dormmate/v1/state，坏报文发到 dormmate/v1/log/reject
       （清 retained 的那条空报文既不是数据也不是坏报文，只记一笔——见
       validate_message 第 2 步前面那段）

四条红线在代码里的落点（改这个文件之前先看一遍）：

  * **不许写死节点。** 节点从 core/config.json 来，代码里出现 dorm-a 就是错的。
    「优先关注」由数据算出来，不是 here 挑一个。
  * **status 由温湿度算。** 报文里那个 status 只用来对一对，不一致就以算的为准
    并记账（counters.statusMismatch），永远不把它当成结论。
  * **恢复要等新数据。** 不是「按个按钮就算好了」—— 恢复判据是**后来收到的**
    连续 N 条正常报文（N = core/config.json 的 recoverConsecutiveNormal）。
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
import rules  # noqa: E402
from status_rules import compute_status  # noqa: E402

# 统一 JSON 的 time 格式，固定 YYYY-MM-DD HH:mm:ss。
# 用正则先卡形状，再交给 strptime 卡真假（2026-13-45 这种形状对、日期不对）。
TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")

# 快照格式版本。前端将来读 dormmate/v1/state 时按这个字段挑解析方式，
# 免得以后字段变了，旧页面把新快照读成一堆 undefined 还不报错。
SNAPSHOT_VERSION = 1

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


class Core:
    """业务大脑本体。不碰网络细节，client 由外面递进来（测试递假的那个）。

    这样切一刀是为了能离线测：真 broker 起不起得来、能不能收到消息，
    和「收到之后算得对不对」是两件事，混在一起测的话，
    前者坏一次就把后者的测试一起带红，什么都看不出来。
    """

    def __init__(self, cfg: dict[str, Any], client: Any | None = None, quiet: bool = False) -> None:
        self.cfg = cfg
        self.nodes: dict[str, NodeState] = {
            node_id: NodeState(node_id, history_max=cfg["historyMax"])
            for node_id in cfg["nodes"]
        }
        self.counters = Counters()
        self.client = client
        self.quiet = quiet
        self._last_state_payload: str | None = None
        # 上一次打过的「重点」是谁。初值用 _UNSET 而不是 None ——
        # None 是「没有重点」这个**合法结论**，两者不能混：
        # 混了的话，一上来就"没有重点"的那次永远打不出来。
        self._last_priority_node: object = _UNSET
        self.offline: list[str] = []   # 上一次 tick 时判定为离线的节点

    # -- 生命周期 ----------------------------------------------------------

    @property
    def weights(self) -> dict[str, int]:
        """严重度权重。取自配置，缺的状态由 rules 里那份默认值兜底。"""
        table = dict(rules.SEVERITY_WEIGHTS)
        table.update(self.cfg.get("priority", {}).get("severity", {}))
        return table

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
            return verdict

        if not verdict.ok:
            self.counters.rejected += 1
            self.publish_reject(topic, verdict.reasons, payload_text)
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
                topic, (f"未知节点 {record['nodeId']!r}",), payload_text
            )
            return Verdict(False, reasons=(f"未知节点 {record['nodeId']!r}",))

        node.apply(record, now_wall, self.cfg["recoverConsecutiveNormal"])
        # 每收一条就重算并（内容变了才）重发快照。放在这里而不是放到
        # 主循环里定时发：定时发的话，两次发布之间收到的那几条数据
        # 在快照上永远看不见，而它们可能正好是把重点换掉的那两条。
        self.publish_state(now_wall)
        return verdict

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
            entry: dict[str, Any] = {
                "nodeId": node_id,
                "online": node.is_online(now_wall, timeout),
                # status 可能是 None：**还没收到过数据** ≠ 正常
                "status": node.status,
                "temperature": None if node.latest is None else node.latest["temperature"],
                "humidity": None if node.latest is None else node.latest["humidity"],
                "time": None if node.latest is None else node.latest["time"],
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
                "historyCount": len(node.history),
            }
            nodes.append(entry)

        return {
            "v": SNAPSHOT_VERSION,
            "time": format_time(now_wall),
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
            "counters": {
                "received": self.counters.received,
                "rejected": self.counters.rejected,
                "statusMismatch": self.counters.status_mismatch,
                "retainedCleared": self.counters.retained_cleared,
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
        payload = json.dumps(self.snapshot(now_wall), ensure_ascii=False, sort_keys=False)
        if not force and payload == self._last_state_payload:
            return False
        self._last_state_payload = payload
        self.publish(config.STATE_TOPIC, payload, retain=True)
        return True

    # -- 发 -----------------------------------------------------------------

    def publish(self, topic: str, payload: str, retain: bool) -> None:
        if self.client is None:
            return
        self.client.publish(topic, payload, qos=self.cfg.get("_qos", config.QOS), retain=retain)

    def publish_reject(self, topic: Any, reasons: tuple[str, ...], payload_text: Any) -> None:
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
        log("连接", f"已连接，订阅 {config.TOPIC_PATTERN}")
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


def run(cfg: dict[str, Any], quiet: bool = False) -> int:
    broker = resolve_broker(cfg)
    # _qos 单独塞进去：Core 里只认 cfg，不该让它再去读一遍 config.py。
    # 加下划线是明说「这不是配置文件的字段，是运行期算出来递进来的」。
    cfg = dict(cfg, _qos=broker["qos"])

    core = Core(cfg, quiet=quiet)
    client = build_client(cfg, broker)
    core.client = client
    client.on_connect = core.on_connect
    client.on_disconnect = core.on_disconnect
    client.on_message = core.on_message

    log("启动", (
        f"连 {broker['host']}:{broker['port']}，"
        f"{len(cfg['nodes'])} 个节点 {'/'.join(cfg['nodes'])}，"
        f"离线超时 {cfg['offlineTimeoutSec']}s，"
        f"连续 {cfg['recoverConsecutiveNormal']} 条正常算恢复"
    ))
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
        print(f"  恢复判据      连续 {cfg['recoverConsecutiveNormal']} 条正常")
        print(f"  历史上限      {cfg['historyMax']} 条 / 节点")
        print(f"  broker        {broker['host']}:{broker['port']} qos={broker['qos']}")
        print(f"  topic         订阅 {config.TOPIC_PATTERN}")
        print(f"                快照 {config.STATE_TOPIC}（retained）")
        print(f"                拒绝 {config.REJECT_TOPIC}（retain=False）")
        print(f"                在线 {config.CORE_STATUS_TOPIC}（retained + 遗嘱）")
        return 0

    return run(cfg, quiet=args.quiet)


if __name__ == "__main__":
    raise SystemExit(main())
