"""D3 事件状态机 —— 「发现异常 -> 处理 -> 验证 -> 恢复」的闭环。

    节点出现异常（连续异常的**第一条**）
        |
        v
      OPEN（待处理） --收到 handle--> HANDLING（处理中）
                                          |
                  后来的报文连续 N 条正常 --+--> RECOVERED（已恢复）
                  后来的报文连续 M 条异常 --+--> UNRESOLVED（未恢复）

四条红线在这个文件里的落点（改这里之前先看一遍）：

  * **点按钮不算恢复。** `apply_action()` 只有一种结果：OPEN -> HANDLING。
    整个文件里唯一能写下 RECOVERED 的地方是 `observe()` 里那条「连续 N 条
    正常」，而 `observe()` 只吃**后来收到的报文**，吃不到前端的话。
    所以「按一下就好了」在这份代码里做不到 —— 不是靠约定，是根本没有那条路。
    `apply_action()` 连 `node` 都拿不到，它没有能力去改节点状态。
  * **不许写死节点。** 事件跟着节点自己的异常段走，节点名单从
    core/config.json 来（`Core` 把 `cfg["nodes"]` 递进来）。
  * **门槛从配置来。** 连续几条正常算恢复（`recoverConsecutiveNormal`，
    和 core 判「异常段结束」用的是同一个数）、连续几条异常算没治好
    （`verifyConsecutiveAbnormal`）、最多留几条事件（`eventsMax`）、
    每条事件最多留几条验证数据（`eventsVerifyMax`），都在 core/config.json。
  * **结果不许手工改。** `result` / `verify` / `snapshots` 全是当场从收到的报文
    里算出来的，没有一个字是编的。要改说法就改配置或改数据，然后重跑。

字段名说明：`event_id` / `verify_from` / `start_time` 这些是任务书里原样给的，
和项目其它地方的 camelCase 不一致。这里**照抄任务书**，免得验收时对不上号；
`to_json()` 出来的就是这份 json，不多包一层。

这个文件不 import core.py。`observe()` 收的是一个「长得像 NodeState」的东西
（鸭子类型：`node_id` / `abnormal_count` / `abnormal_start` / `consecutive_normal`
/ `duration_seconds()`），所以 core 可以放心 import 它，反过来不行。
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping

# 见 simulator/simulator.py 里同一段注释：让「直接指文件路径」和「-m 包名」两种
# 跑法都能找到同级的 config / status_rules。本文件在项目根，直接用绝对导入。
if __package__ in (None, ""):                      # pragma: no cover - 直接跑文件用
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import config  # noqa: E402
from status_rules import STATUS_NORMAL  # noqa: E402

# ---------------------------------------------------------------------------
# 状态
# ---------------------------------------------------------------------------

OPEN = "OPEN"                 # 待处理：异常段已经成型，还没人管
HANDLING = "HANDLING"         # 处理中：handle 指令到了，正拿后续报文验证
RECOVERED = "RECOVERED"       # 已恢复：后续连续 N 条正常（**只有数据能写这个**）
UNRESOLVED = "UNRESOLVED"     # 未恢复：处理之后连续 M 条依旧异常

STATES = (OPEN, HANDLING, RECOVERED, UNRESOLVED)
TERMINAL_STATES = (RECOVERED, UNRESOLVED)

# 前端能发的指令。目前只有一条 —— 别的动作（到场、开门开窗…）要先想清楚
# 它们在状态机上是什么，再加，别先把开关装上。
HANDLE = "handle"
COMMANDS = (HANDLE,)

# 前端拍了一张现场快照，要挂到案卷上（Phase6 E2）。
#
# **它不在 COMMANDS 里**，这是有意的：上面那个元组的含义是「会去改事件状态
# 的那一组」，而这一条**一个状态都不动** —— 它只往 snapshots 里追加一笔。
# 和 core 那边的 `focus` 是同一种东西：是个动作，但不进状态机。
# （core.py 拼出来的那张完整清单是 `events.COMMANDS + (FOCUS, SNAPSHOT)`。）
SNAPSHOT = "snapshot"

# 案卷里那条**相机**记录靠这个字段认。
#
# 为什么不用「有没有 state」来区分：状态迁移那几条（开案 / 转处理 / 结案）
# 每条都带 "state"，相机这几条不带 —— 拿「缺了某个字段」当类型标记，以后
# 再加一种记录（录音？到场照片？）就得重新猜一遍。写一个显式的 kind，
# 读的人一眼看得出来这是什么，加新种类也只是多一个取值。
CAMERA = "camera"

# 水印那一行字是**浏览器画的**（那是画，不是判），原样留档是为了事后能拿它
# 和照片上那行字对。但案卷是 core 的文件，长度得由 core 说了算 —— 不截的话，
# 前端一句话就能把 data/events.json 撑大，而且每次 fsync 都要把那一坨再写一遍。
WATERMARK_MAX_CHARS = 200

# 事件文件版本。读到别的版本不当坏文件处理（字段是往前兼容的），
# 只是记一笔，方便以后真要改格式时能认出旧文件。
EVENTS_VERSION = 1

# 一条事件最多留几条快照。状态迁移就那么几次（开/转处理/结案），
# 正常一条事件只有四五条，20 条是「绝不可能碰到」的上限，碰到了也不静默丢。
SNAPSHOT_MAX = 20

# 落盘的节流。验证数据每来一条都要写文件的话，2 秒一条数据 × 3 个节点
# 就是一秒钟好几次 fsync —— 这点数据不值得。状态迁移（开/结案）强制落盘，
# 中间的验证数据攒够 SAVE_MIN_INTERVAL 秒再写。
SAVE_MIN_INTERVAL = 1.0


def now_text() -> str:
    """此刻，写成报文里那个固定格式。"""
    return datetime.now().strftime(config.TIME_FORMAT)


def parse_time(text: str) -> datetime | None:
    """把 `YYYY-MM-DD HH:mm:ss` 读回 datetime。读不动返回 None（不猜）。"""
    try:
        return datetime.strptime(str(text), config.TIME_FORMAT)
    except (ValueError, TypeError):
        return None


def make_event_id(node_id: str, start: datetime | str) -> str:
    """`dorm-b-20260922-203000` 这样的 id。

    用「节点 + 异常段开始的时刻」拼，不用自增序号 —— core 重启之后序号从哪
    接着数是个说不清的问题，而同一节点同一秒只可能开一条事件（异常段的第一条
    只来一次），拼出来天然唯一，重跑剧本也稳定。
    """
    when = parse_time(start) if isinstance(start, str) else start
    stamp = when.strftime("%Y%m%d-%H%M%S") if when else "00000000-000000"
    return f"{node_id}-{stamp}"


def human_duration(start: str, end: str) -> str:
    """两个报文时间之间有多长，说成人话。算不动就返回空串（不编数）。"""
    a, b = parse_time(start), parse_time(end)
    if a is None or b is None:
        return ""
    seconds = (b - a).total_seconds()
    if seconds < 0:
        return ""
    minutes = int(seconds) // 60
    if minutes < 60:
        return f"{minutes} 分钟"
    hours, rest = divmod(minutes, 60)
    return f"{hours} 小时" if rest == 0 else f"{hours} 小时 {rest} 分钟"


# ---------------------------------------------------------------------------
# 一条事件
# ---------------------------------------------------------------------------


@dataclass
class Event:
    """一条事件。字段名照抄任务书。

    任务书列了 11 个字段，这里多三个，都是**这条事件自己身上**的记账：

    * `state` —— 任务书用「事件状态」这个词，总得有个字段装它。
    * `end_time` —— 结案时刻（RECOVERED 时和 recovered_at 是同一个值）。
      留一个通用的「结束了」字段，以后加 UNRESOLVED 之外的结案方式不用改结构。
    * `verify_dropped` / `snapshots_dropped` —— 被上限挤掉的条数。`verify` 满了
      会丢最老的，丢了就在这儿记一笔，免得看文件的人以为验证数据只有这么多。

    `consumed` 和 `pending_abnormal` 是**运行期**的记账，不落盘。core 重启后
    从文件里读回来的事件只会是已经结案的（见 `load()`），所以它们丢了不影响
    任何结果：

    * `consumed` —— 这条事件一共吃过几条报文。`verify_from` 就是「按下 handle
      那一刻的 consumed」。
    * `pending_abnormal` —— 处理之后**连续**来了几条异常。它必须是个真计数器，
      不能靠「把 verify 从最新往回数」算出来：verify 有上限（eventsVerifyMax），
      满了会丢最老的，而 thresholds 和上限是两个独立的配置项 —— 一旦上限比
      阈值小，往回数就永远数不够，「没治好」再也判不出来，而且不报错
      （这个坑是写测试的时候真踩到的，见 tests/test_events.py 里那条
      test_pending_count_survives_the_cap）。
    """

    event_id: str
    node_id: str
    start_time: str
    problem: str
    state: str = OPEN
    priority_reasons: list[str] = field(default_factory=list)
    # 「它是什么时候被选成当前重点的、当时页面上写的是什么」。
    # 和 priority_reasons 不是一回事：那个是每次状态迁移时记的几句话（最多 5 句），
    # 这个是**第一次**成为重点那一刻的快照，只记一次（E3 起由 core 调
    # mark_priority 填）。复盘要看的是「当初为什么盯上它」，而不是「最后一句
    # 理由是什么」—— 后者在最上面那条栏里一直是最新的。
    priority_time: str | None = None
    priority_reason: str = ""
    actions: list[dict] = field(default_factory=list)
    verify_from: int | None = None
    verify: list[dict] = field(default_factory=list)
    snapshots: list[dict] = field(default_factory=list)
    recovered_at: str | None = None
    end_time: str | None = None
    result: str = ""
    verify_dropped: int = 0
    snapshots_dropped: int = 0
    consumed: int = 0
    pending_abnormal: int = 0

    # -- 读写 ---------------------------------------------------------------

    @property
    def is_open(self) -> bool:
        """还没结案（OPEN / HANDLING）。"""
        return self.state not in TERMINAL_STATES

    @property
    def handled(self) -> bool:
        """有没有人真的按过「开始处理」（按了但没被接受的不算）。"""
        return any(a.get("accepted") for a in self.actions)

    def to_json(self) -> dict[str, Any]:
        """落盘用的字典。字段顺序按任务书列的顺序，多出来的排后面。"""
        return {
            "event_id": self.event_id,
            "nodeId": self.node_id,
            "start_time": self.start_time,
            "problem": self.problem,
            "priority_reasons": list(self.priority_reasons),
            "priority_time": self.priority_time,
            "priority_reason": self.priority_reason,
            "actions": [dict(a) for a in self.actions],
            "verify": [dict(v) for v in self.verify],
            "verify_from": self.verify_from,
            "snapshots": [dict(s) for s in self.snapshots],
            "recovered_at": self.recovered_at,
            "result": self.result,
            "state": self.state,
            "end_time": self.end_time,
            "verify_dropped": self.verify_dropped,
            "snapshots_dropped": self.snapshots_dropped,
        }

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> "Event":
        """从文件里读回来。字段缺了就按默认值走，读不懂的抛 ValueError。

        **这里不替文件圆谎**：`state` 只认四个值，认不出来就抛 —— 悄悄改成
        OPEN 会让一条本来已经结案的事件又"活"过来，那种错比读不出来更难查。
        """
        if not isinstance(data, Mapping):
            raise ValueError(f"一条事件应该是个对象，收到 {type(data).__name__}")

        node_id = str(data.get("nodeId") or data.get("node_id") or "").strip()
        event_id = str(data.get("event_id") or "").strip()
        start_time = str(data.get("start_time") or "").strip()
        if not node_id or not event_id or not start_time:
            raise ValueError("事件缺 nodeId / event_id / start_time")

        state = str(data.get("state") or OPEN).strip().upper()
        if state not in STATES:
            raise ValueError(f"事件状态不认识：{data.get('state')!r}")

        def _records(key: str) -> list[dict]:
            raw = data.get(key)
            if not isinstance(raw, list):
                return []
            return [dict(item) for item in raw if isinstance(item, Mapping)]

        verify = _records("verify")
        verify_from = data.get("verify_from")
        if not isinstance(verify_from, int) or isinstance(verify_from, bool):
            verify_from = None

        snapshot = cls(
            event_id=event_id,
            node_id=node_id,
            start_time=start_time,
            problem=str(data.get("problem") or ""),
            state=state,
            priority_reasons=[str(x) for x in (data.get("priority_reasons") or [])],
            priority_time=data.get("priority_time") or None,
            priority_reason=str(data.get("priority_reason") or ""),
            actions=_records("actions"),
            verify_from=verify_from,
            verify=verify,
            snapshots=_records("snapshots"),
            recovered_at=data.get("recovered_at") or None,
            end_time=data.get("end_time") or None,
            result=str(data.get("result") or ""),
            verify_dropped=int(data.get("verify_dropped") or 0),
            snapshots_dropped=int(data.get("snapshots_dropped") or 0),
        )
        # consumed 不落盘，从能对上的部分倒推回来。只影响「读回来之后再按 handle
        # 时 verify_from 从几开始」—— 而读回来的开放事件会被 load() 直接结案，
        # 走不到那一步。留着是为了万一以后要留开放事件，账面别是负的。
        snapshot.consumed = (verify_from or 0) + len(verify) + snapshot.verify_dropped
        return snapshot

    # -- 给人看的视图（E3）-------------------------------------------------

    def view(self) -> dict[str, Any]:
        """给前端渲染用的紧凑视图。**和 `to_json()` 是两件事**。

        `to_json()` 是落盘那份：要能一字不差地读回来，所以 `verify` /
        `snapshots` 那些数组一条不落。这份是**发到 MQTT 上给屏幕看的**：每个
        字段都对应看板事件表上的某一格，字段名也照抄那张表的列名
        （nodeId / startTime / problem / priorityTime / priorityReason /
        action / actionTime / recoverTime / result）——

        为什么字段名要跟前端对齐而不是让前端自己映射：前端那 9 个列名是
        **导出 CSV 的表头**，改了它 CSV 的表头就跟着变，而 CSV 是交给别人看的
        东西。名字对齐意味着「换数据源」这件事在前端只动读取那几行，渲染和
        导出一个字都不用改。

        `verify` / `snapshots` 一律不进这份视图：它们只增不减，发一次快照就
        要把整条案卷重发一遍，而事件表一个格子都用不到。要细看案卷的人去读
        `data/events.json`（那才是它该在的地方）。
        """
        first = next((a for a in self.actions if a.get("accepted")), None)
        return {
            "event_id": self.event_id,
            "nodeId": self.node_id,
            "state": self.state,
            "startTime": self.start_time,
            "problem": self.problem,
            "priorityTime": self.priority_time,
            "priorityReason": self.priority_reason,
            "action": first.get("action") if first else None,
            "actionTime": first.get("time") if first else None,
            "actionSource": first.get("source") if first else None,
            "recoverTime": self.recovered_at,
            "endTime": self.end_time,
            "result": self.result,
            # 处理之后来了几条异常 —— 「验证中 2/3」就是拿它和 verify_after 比的。
            # 前端不自己数 verify 数组：那个数组有上限，满了会丢最老的，
            # 数出来的结果和判定用的那个计数器不是一回事。
            "abnormalAfter": self.pending_abnormal,
            "verifyCount": len(self.verify),
            # 这条事件上登了几张现场快照（Phase6 E2）。**只报个数，不报内容** ——
            # snapshots 里那几条记录（含前端画的水印字）一律不进这份视图，
            # 理由和上面那段一样：这份是每个周期都要重发一遍的东西，而「拍了
            # 几张」一格就能说清。要细看是哪几张，去读 data/events.json。
            #
            # 报了它，前端才有东西可对账：页面拍完照只能说「已经发出去」，
            # 「core 真的登记上了」得等下一帧快照里这个数涨了才算数 ——
            # 和「点完处理按钮画面不动」是同一条规矩。
            "cameraCount": self.camera_count,
        }

    # -- 记账 ---------------------------------------------------------------

    def add_snapshot(self, entry: Mapping[str, Any]) -> None:
        """留一条快照。满了就丢**最老的那条**（开案那条永远留着）。"""
        self.snapshots.append(dict(entry))
        while len(self.snapshots) > SNAPSHOT_MAX:
            del self.snapshots[1]
            self.snapshots_dropped += 1

    def add_camera(self, entry: Mapping[str, Any]) -> dict[str, Any]:
        """在案卷上登一张现场快照（Phase6 E2）。返回真正写进去的那一条。

        和上面那些走 `add_snapshot` 的调用是同一本账、同一个上限 —— 一条事件
        从开案到结案本来就只写四五条，相机再挤进来几张也不会把开案那条顶掉
        （`add_snapshot` 永远留 `[0]`）。

        这里只写案卷，**一个状态字段都不碰**（state / verify / recovered_at
        全不动）。想加一句「拍了照就算处理过了」的捷径，得先绕过这一层。
        """
        record: dict[str, Any] = {"kind": CAMERA}
        record.update(dict(entry))
        self.add_snapshot(record)
        return record

    @property
    def camera_count(self) -> int:
        """这条事件上登了几张**相机**快照。

        不能直接写 `len(self.snapshots)` —— 那个数里混着开案 / 转处理 / 结案
        那几条状态迁移记录，报给前端的会是「3 张」，而人一张照片都没拍过。
        """
        return sum(1 for item in self.snapshots if item.get("kind") == CAMERA)

    def note_reason(self, reason: str | None) -> None:
        """记一句「业务大脑为什么盯上它」。重复的不记，最多留 5 句。

        只在状态迁移的时候记（开案 / 转处理 / 结案），所以条数天然很少；
        5 是兜底，不是目标。
        """
        text = str(reason or "").strip()
        if not text or (self.priority_reasons and self.priority_reasons[-1] == text):
            return
        self.priority_reasons.append(text)
        while len(self.priority_reasons) > 5:
            del self.priority_reasons[0]


# ---------------------------------------------------------------------------
# 一叠事件
# ---------------------------------------------------------------------------


class EventBook:
    """所有节点的事件叠在一起，外加读写 data/events.json。

    一个节点**同时最多一条开着的事件**（`self._open[node_id]`）。异常段结束
    （连续 N 条正常）才结案，所以同一条异常段不管持续多久都只对应一条事件 ——
    否则「连续偏热两小时」会被切成几十条事件，验证窗口也就被切碎了。
    """

    def __init__(
        self,
        nodes: Iterable[str],
        recover_after: int,
        verify_after: int,
        events_max: int = 200,
        verify_max: int = 50,
        path: str | os.PathLike[str] | None = None,
        clock: Any = None,
    ) -> None:
        self.nodes = tuple(str(n) for n in nodes)
        self.recover_after = max(1, int(recover_after))
        self.verify_after = max(1, int(verify_after))
        self.events_max = max(1, int(events_max))
        self.verify_max = max(1, int(verify_max))
        self.path = Path(path) if path else None
        self.clock = clock or time.monotonic

        self.events: list[Event] = []
        self.dropped = 0                     # 被 eventsMax 挤掉的老事件条数
        self._open: dict[str, Event] = {}
        self._dirty = False
        self._last_save = 0.0

    # -- 查询 ---------------------------------------------------------------

    def open_event(self, node_id: str) -> Event | None:
        """这个节点现在开着的那条事件。没有就是 None。"""
        return self._open.get(node_id)

    def last_for(self, node_id: str) -> Event | None:
        """这个节点最近的一条事件（不管结没结案）—— 用来把话说清楚。"""
        for event in reversed(self.events):
            if event.node_id == node_id:
                return event
        return None

    def summary(self) -> dict[str, int]:
        counts = {state: 0 for state in STATES}
        for event in self.events:
            counts[event.state] = counts.get(event.state, 0) + 1
        counts["total"] = len(self.events)
        counts["dropped"] = self.dropped
        return counts

    def view(self, limit: int | None = None) -> dict[str, Any]:
        """快照里那一块「事件」（E3）。

        **顺序是从旧到新**（和 self.events 一样）—— 这一条是给**读数据的程序**
        定的，不是给屏幕定的。CSV 导出、report 那些要把整段复盘的都按这个顺序
        从头往下看。

        屏幕上要的是反过来的（最近发生的在最上面），那一步由前端做
        （`dashboard/dashboard.js` 里 `snapshot.events.events.slice().reverse()`，
        表格和导出的 CSV 用的是同一个顺序）。规矩是「**core 发正序、要倒着看谁需要谁自己翻**」，
        不是「谁先画谁定秩序」：core 要是跟着某个前端改成倒序，
        report 那条不画表格的路就跟着被牵着走，而它根本不该知道屏幕长什么样。

        `limit` 只截**发出去的那一份**：`summary` 里的 total 仍然是真的总数 ——
        屏幕上放不下 200 条，但「一共发生过多少条」不能因此少报。
        """
        if limit is None:
            picked = self.events
        elif int(limit) > 0:
            # 取**最后** limit 条（最近的那些），顺序不变
            picked = self.events[-int(limit):]
        else:
            picked = []
        return {
            "summary": self.summary(),
            "dropped": self.dropped,
            "events": [event.view() for event in picked],
        }

    # -- 状态机 -------------------------------------------------------------

    def observe(self, node: Any, record: Mapping[str, Any],
                reason: str | None = None) -> list[str]:
        """吃一条**通过校验的**报文，推动状态机。返回要说给日志听的话。

        调用点在 core 里 `node.apply(...)` **之后**：那时 NodeState 已经吃完
        这条报文了，`abnormal_count` / `consecutive_normal` 说的都是「含这条在内」
        的情况，这里只管照着判，不再自己数一遍。自己再数一遍就是第二份真相，
        总有一天会和 core 那份对不上。
        """
        changes: list[str] = []
        node_id = str(node.node_id)
        event = self._open.get(node_id)

        if event is None:
            # 只认**异常段的第一条**。不认 `> 0` 是因为：UNRESOLVED 结案之后
            # 这条异常段还没结束，后面的数据会接着来；要是按「> 0」开案，
            # 一条数据开一条事件，同一次异常能开出几十条来。
            if int(node.abnormal_count) == 1:
                event = self._open_event(node, record, reason)
                changes.append(
                    f"开事件 {event.event_id}（{event.problem}），待处理"
                )
            return changes

        # 处理中的案子，后面每一条报文都是验证数据 —— 正常的也要收，
        # 否则「处理后正常了几条」这件事在文件里看不到（只看得到最后结案那一条）。
        if event.state == HANDLING:
            self._record_verify(event, record)

        if int(node.abnormal_count) == 0:
            # 异常段已结束 —— NodeState 是在「连续 N 条正常」凑齐那一刻把它清零的，
            # 所以走到这里等价于「恢复条件成立」，而不是「这条碰巧正常」。
            changes.append(self._close_recovered(event, record, reason))
            return changes

        if event.state == HANDLING:
            # 判「没治好」只看**处理之后**新来的数据，处理之前的异常一条都不算
            # （那些是当初开案的原因，不是处理的结果）。
            pending = event.pending_abnormal
            if pending >= self.verify_after:
                changes.append(self._close_unresolved(event, record, reason))
            elif pending:
                changes.append(
                    f"{event.event_id} 验证中：处理后连续第 {pending}/{self.verify_after} 条"
                    f"异常（{record.get('status')}）"
                )
            else:
                # 0 条异常 = 这条正常。报「距离恢复还差几条」比报「0/3 条异常」
                # 有用得多 —— 演示的时候这一行就是那个倒计时。
                left = max(0, self.recover_after - int(getattr(node, "consecutive_normal", 0)))
                changes.append(
                    f"{event.event_id} 验证中：这条 {record.get('status')}，"
                    f"再连续 {left} 条正常就判恢复"
                )

        # 验证数据是**攒着**的：一条一条 fsync 不值当，所以这里走节流写。
        # 但必须真有一次 —— 只在开案/结案那几处 force 写的话，一条处理了很久
        # 的案子（比如「一直没治好」那种，要等第 M 条异常才结案）中间收的
        # 验证数据全在内存里，core 一被杀就没了，文件里只剩下「处理中」加上
        # 空荡荡的 verify。
        self._dirty = True
        self.save()
        return changes

    def mark_priority(
        self,
        node_id: str,
        when: str | None = None,
        reason: str | None = None,
    ) -> Event | None:
        """「这一刻它成了当前重点」—— 记到它开着的那条事件上。改动过就返回那条事件。

        **和 apply_action 是两件事，别混**：那个是前端按了按钮（把 OPEN 变成
        HANDLING），这个是业务大脑自己排完序之后说「现在是它」。前者要人动手，
        每一条异常都可能有；后者由 core 判定，同样一条事件只会记一次。

        **只记第一次**（已经记过就返回 None 不动）。复盘想回答的是「这个宿舍
        是什么时候被注意到的、当时是因为什么」，而不是「最后一句理由是什么」——
        后者在最上面那条栏里一直是最新的，不必再存一份。

        **不碰任何状态**：不改 state、不改 verify、不改 recovered_at。它只是
        在案卷边上写一行「此刻它在最前面」。写成 `_close_*` 那种改状态的函数
        就会在这里打开一条绕过验证窗口的路。
        """
        event = self._open.get(str(node_id))
        if event is None:
            return None
        if event.priority_time:
            return None
        stamp = str(when or "").strip()
        if not stamp:
            return None

        event.priority_time = stamp
        event.priority_reason = str(reason or "").strip()
        self._dirty = True
        # 走节流写：这个方法在每条异常报文后面都会被调到一次，逐条 fsync 不划算。
        # 真到结案那一刻有 force 写兜着，中间掉电最多丢一条「它成了重点」——
        # 而那条在下一个重点出现时会被重新记一遍。
        self.save()
        return event

    def apply_action(
        self,
        node_id: str,
        action: str = HANDLE,
        when: str | None = None,
        source: str | None = None,
        note: str = "",
        reason: str | None = None,
    ) -> tuple[bool, str]:
        """前端按下了「开始处理」。**只能把 OPEN 变成 HANDLING。**

        返回 `(接没接受, 要说给日志听的话)`。这个函数看不到 NodeState，
        也不返回任何能改节点状态的东西 —— 红线在这里是**结构上**成立的。
        """
        node_id = str(node_id)
        stamp = when or now_text()
        event = self._open.get(node_id)

        if event is None:
            last = self.last_for(node_id)
            tail = f"（上一条 {last.event_id} 已经是 {last.state}）" if last else "（这个节点还没有过事件）"
            return False, f"{node_id} 现在没有开着的事件，这条 {action} 没有对应的案子{tail}"

        if event.state != OPEN:
            # 已经在处理中：记一笔「又按了一次」，但**不重置验证窗口**。
            # 重置的话，连按几次就能一直把「连续 M 条依旧异常」那句判据往后推，
            # 事件永远判不出 UNRESOLVED —— 那验证环节就白设了。
            event.actions.append({
                "time": stamp, "action": action, "source": source,
                "accepted": False,
                "note": "已经在处理中，这一次没有重置验证窗口",
            })
            self._dirty = True
            self.save(force=True)
            return False, (
                f"{event.event_id} 已经在处理中（{event.actions[0].get('time')} 开始），"
                f"又记了一次动作，验证窗口不动"
            )

        event.state = HANDLING
        event.verify_from = event.consumed
        event.actions.append({
            "time": stamp, "action": action, "source": source,
            "accepted": True, "note": note,
        })
        event.note_reason(reason)
        event.add_snapshot({
            "time": stamp, "state": HANDLING, "status": "处理中",
            # verify_from 是 0 起数的第几条，写在字段里就够了；这句话是给人看的，
            # 说「从这条之后」比「从第 1 条之后」不容易被读成「第二条」。
            "note": f"收到 {action}，从这条之后的报文开始算验证数据",
        })
        self._dirty = True
        self.save(force=True)
        return True, (
            f"{event.event_id} 转「处理中」，等后续 {self.verify_after} 条异常 / "
            f"{self.recover_after} 条正常来判"
        )

    def record_snapshot(
        self,
        node_id: str,
        *,
        when: str | None = None,
        source: str | None = None,
        event_id: str | None = None,
        stamp: str | None = None,
        watermark: str | None = None,
        file: str | None = None,
        width: int | None = None,
        height: int | None = None,
        size: int | None = None,
    ) -> tuple[bool, str]:
        """前端拍了一张现场快照，登到这一间**开着的那条事件**上（Phase6 E2）。

        返回 `(接没接受, 要说给日志听的话)`。和 `apply_action` 一样，这个函数
        看不到 NodeState，也不返回任何能改节点状态的东西 —— 红线在这里依然是
        **结构上**成立的：一张照片证明不了这个宿舍好了。

        三件事说清楚：

        * **挂在哪条事件上，由 core 说了算。** 前端可以在 `event_id` 里
          写上它以为的那条，core 拿它**只做对账**：对不上就拒，不会照着
          前端说的去改归属。理由和 `validate_command` 里那条一样 ——
          谁的地盘谁做主，前端说错了要报出来，不能顺着改。
        * **两个时间都记。** `stamp` 是快门按下去那一刻（前端报的），
          `time` 是 core 收到这条指令的那一刻（core 自己的钟）。和
          `handle` 那条路一个口径：动作什么时候发生的只能问发它的人，
          core 什么时候知道的只能问 core。
        * **前端画的水印只留档，不当判据。** 那行字是画上去的，不是算出来
          的；core 不检查它写对一个字没有（check 了也没什么可做的）。它被
          截到 `WATERMARK_MAX_CHARS`，因为案卷是 core 的文件。
        """
        node_id = str(node_id)
        event = self._open.get(node_id)

        if event is None:
            last = self.last_for(node_id)
            tail = (
                f"（上一条 {last.event_id} 已经是 {last.state}）" if last
                else "（这个节点还没有过事件）"
            )
            return False, f"{node_id} 现在没有未结案的事件，这张快照没地方可挂{tail}"

        wanted = str(event_id or "").strip()
        if wanted and wanted != event.event_id:
            return False, (
                f"eventId 对不上：这条快照说是 {wanted}，"
                f"core 手里开着的是 {event.event_id} —— 挂在哪条案卷上由 core 说了算，"
                f"不照着前端说的改"
            )

        text = str(watermark or "")
        if len(text) > WATERMARK_MAX_CHARS:
            text = text[:WATERMARK_MAX_CHARS]

        record = event.add_camera({
            "time": str(when or now_text()),
            "eventId": event.event_id,
            "nodeId": node_id,
            "stamp": str(stamp or ""),
            "watermark": text,
            "file": str(file or ""),
            "width": width,
            "height": height,
            "size": size,
            "source": str(source or ""),
            "note": "现场快照（Phase6 E2）",
        })
        self._dirty = True
        # force=True：这一步的**全部意义**就是「案卷上多了一笔」，
        # 掉电丢了这一条，就只剩浏览器里那张图和一个没登记过的文件名。
        self.save(force=True)

        pixels = f"{width}×{height}" if width and height else "尺寸未报"
        return True, (
            f"{event.event_id} 登下第 {event.camera_count} 张现场快照"
            f"（{pixels}，{record.get('stamp') or '时刻未报'}）"
        )

    # -- 内部：开案与结案 ---------------------------------------------------

    def _open_event(self, node: Any, record: Mapping[str, Any],
                    reason: str | None) -> Event:
        node_id = str(node.node_id)
        start = str(getattr(node, "abnormal_start", None) or record.get("time") or now_text())
        event = Event(
            event_id=make_event_id(node_id, start),
            node_id=node_id,
            start_time=start,
            problem=f"连续{record.get('status')}",
        )
        event.consumed = 1                       # 开案这条就算第一条，见 _pending_abnormal
        event.note_reason(reason)
        event.add_snapshot({
            "time": record.get("time"),
            "state": OPEN,
            "status": record.get("status"),
            "temperature": record.get("temperature"),
            "humidity": record.get("humidity"),
            "abnormalCount": int(node.abnormal_count),
            # 开案这条**没有**「持续多久」这回事：起点就是这一条，两个时间
            # 是同一个。写 "0 分钟" 是在说一件没发生过的事 —— 和快照里
            # 「正常节点不写 durationText」是同一条原则。
            "durationText": None,
            "note": "异常段成型，开案",
        })
        self.events.append(event)
        self._open[node_id] = event
        self._trim()
        self._dirty = True
        self.save(force=True)
        return event

    def _record_verify(self, event: Event, record: Mapping[str, Any]) -> None:
        """把处理之后收到的一条报文记进验证数据，并推进「连续几条异常」。

        两件事分开做：`verify` 是**存档**（有上限，超了丢最老的），
        `pending_abnormal` 是**判据**（没有上限，一直数到结案）。
        拿存档去当判据是不行的 —— 存档会丢数据，而判据丢一次就永远判不出来。
        """
        event.consumed += 1
        event.verify.append({
            "time": record.get("time"),
            "temperature": record.get("temperature"),
            "humidity": record.get("humidity"),
            "status": record.get("status"),
        })
        while len(event.verify) > self.verify_max:
            del event.verify[0]
            event.verify_dropped += 1

        if record.get("status") == STATUS_NORMAL:
            event.pending_abnormal = 0
        else:
            event.pending_abnormal += 1
        self._dirty = True

    def _close_recovered(self, event: Event, record: Mapping[str, Any],
                         reason: str | None) -> str:
        """异常段结束 —— **这里，也只有这里，写下 RECOVERED。**

        `recovered_at` 取的是**报文里那个 time**，不是 core 的墙上时间：
        这栏说的是「数据什么时候恢复正常的」，两个出口（事件文件、看板）
        对同一件事要是一个说法。
        """
        end = str(record.get("time") or now_text())
        event.state = RECOVERED
        event.recovered_at = end
        event.end_time = end
        event.note_reason(reason)
        spent = human_duration(event.start_time, end)
        if event.handled:
            event.result = (
                f"处理后连续 {self.recover_after} 条正常，已恢复"
                f"（验证数据 {len(event.verify) + event.verify_dropped} 条）"
            )
        else:
            event.result = (
                f"没人处理，数据自己恢复：连续 {self.recover_after} 条正常"
                + (f"，异常持续 {spent}" if spent else "")
            )
        event.add_snapshot({
            "time": end, "state": RECOVERED,
            "status": record.get("status"),
            "temperature": record.get("temperature"),
            "humidity": record.get("humidity"),
            "durationText": spent,
            "note": f"连续 {self.recover_after} 条正常，结案",
        })
        self._close(event)
        return f"{event.event_id} -> {RECOVERED}：{event.result}"

    def _close_unresolved(self, event: Event, record: Mapping[str, Any],
                          reason: str | None) -> str:
        """处理之后连续 M 条依旧异常 —— 没治好，如实结案。"""
        end = str(record.get("time") or now_text())
        event.state = UNRESOLVED
        event.end_time = end
        event.note_reason(reason)
        event.result = (
            f"处理后连续 {self.verify_after} 条依旧异常"
            f"（最后一条 {record.get('status')}），事件未恢复"
        )
        event.add_snapshot({
            "time": end, "state": UNRESOLVED,
            "status": record.get("status"),
            "temperature": record.get("temperature"),
            "humidity": record.get("humidity"),
            "durationText": human_duration(event.start_time, end),
            "note": f"处理后连续 {self.verify_after} 条异常，结案",
        })
        self._close(event)
        return f"{event.event_id} -> {UNRESOLVED}：{event.result}"

    def _close(self, event: Event) -> None:
        self._open.pop(event.node_id, None)
        self._dirty = True
        self.save(force=True)

    def _trim(self) -> None:
        """事件条数封顶。**只挤已经结案的**，开着的宁可超一点也不丢。"""
        while len(self.events) > self.events_max:
            for index, event in enumerate(self.events):
                if not event.is_open:
                    del self.events[index]
                    self.dropped += 1
                    break
            else:
                return

    # -- 落盘 ---------------------------------------------------------------

    def to_json(self) -> dict[str, Any]:
        return {
            "v": EVENTS_VERSION,
            "savedAt": now_text(),
            "dropped": self.dropped,
            "summary": self.summary(),
            "events": [event.to_json() for event in self.events],
        }

    def save(self, force: bool = False) -> bool:
        """写文件。返回「这次真写了吗」。

        写 `.tmp` 再 `os.replace` 换过去：中途断电/被杀，要么是老的完整文件，
        要么是新的完整文件，不会留下半个 json。
        """
        if self.path is None or not self._dirty:
            return False
        now = self.clock()
        if not force and (now - self._last_save) < SAVE_MIN_INTERVAL:
            return False

        body = json.dumps(self.to_json(), ensure_ascii=False, indent=2)
        tmp = self.path.with_name(self.path.name + ".tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            # newline="\n" 写死：默认的换行转换会让同一份文件在 Windows 上
            # 变成 CRLF，git 每次都报「整文件都改了」。
            with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(body + "\n")
            os.replace(tmp, self.path)
        except OSError as exc:
            print(f"[事件] 写 {self.path} 失败：{exc}", file=sys.stderr)
            return False

        self._last_save = now
        self._dirty = False
        return True

    def load(self) -> str:
        """启动时读回历史事件。返回一句给人看的话。

        读回来的**开放事件会被就地结案成 UNRESOLVED**：core 重启意味着中间那段
        报文没人收，验证窗口再也凑不齐了。让它一直挂着的话，文件里会留下一条
        永远 OPEN 的案子，看上去像「还在处理」—— 那是假话。结案理由写清楚是
        重启导致的，别赖给数据。
        """
        if self.path is None:
            return "内存模式（没给事件文件路径），不读也不写"

        if not self.path.exists():
            return f"还没有 {self.path.name}，从零开始"

        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            bad = self.path.with_name(self.path.name + ".bad")
            try:
                os.replace(self.path, bad)
                moved = f"，已挪到 {bad.name}"
            except OSError:
                moved = ""
            return f"{self.path.name} 读不出来（{exc}）{moved}，从零开始"

        if not isinstance(data, Mapping) or not isinstance(data.get("events"), list):
            bad = self.path.with_name(self.path.name + ".bad")
            try:
                os.replace(self.path, bad)
                moved = f"，已挪到 {bad.name}"
            except OSError:
                moved = ""
            return f"{self.path.name} 里没有 events 数组{moved}，从零开始"

        loaded, broken = [], 0
        for item in data["events"]:
            try:
                loaded.append(Event.from_json(item))
            except (ValueError, TypeError):
                broken += 1

        self.events = loaded
        self.dropped = int(data.get("dropped") or 0)
        self._open = {}

        stale = 0
        for event in self.events:
            if not event.is_open:
                continue
            stale += 1
            event.state = UNRESOLVED
            event.end_time = event.end_time or now_text()
            event.result = (
                f"core 重启，中间那段报文没人收，验证窗口凑不齐了 —— 按未恢复结案"
                f"（重启前状态 {event.event_id} 停在处理中）"
            )
            event.add_snapshot({
                "time": event.end_time, "state": UNRESOLVED,
                "note": "启动时发现是没结案的旧事件，结案",
            })

        if stale or broken:
            self._dirty = True
            self.save(force=True)

        parts = [f"读回 {len(self.events)} 条事件"]
        if data.get("v") not in (None, EVENTS_VERSION):
            parts.append(f"（文件版本 {data.get('v')}，当前 {EVENTS_VERSION}）")
        if stale:
            parts.append(f"，其中 {stale} 条没结案的旧事件按未恢复结案")
        if broken:
            parts.append(f"，{broken} 条读不懂已跳过")
        return "".join(parts)


# ---------------------------------------------------------------------------
# 自测：不连 MQTT、不开 core，纯内存把状态机走一遍
# ---------------------------------------------------------------------------


class _FakeNode:
    """照 NodeState 那几栏拼一个假的，只为了让 events.py 能自己跑起来。"""

    def __init__(self, node_id: str, recover_after: int) -> None:
        self.node_id = node_id
        self.recover_after = recover_after
        self.abnormal_start = None
        self.abnormal_count = 0
        self.consecutive_normal = 0

    def apply(self, time_text: str, status: str) -> None:
        if status == STATUS_NORMAL:
            self.consecutive_normal += 1
            if self.abnormal_count and self.consecutive_normal >= self.recover_after:
                self.abnormal_start = None
                self.abnormal_count = 0
        else:
            self.consecutive_normal = 0
            if self.abnormal_count == 0:
                self.abnormal_start = time_text
            self.abnormal_count += 1


def _self_test() -> int:
    """把任务书那条复现路径在内存里走一遍：偏热 -> handle -> 正常 -> RECOVERED。

    外加一条对照：handle 之后继续异常，必须判 UNRESOLVED。
    """
    recover_after, verify_after = 3, 3
    book = EventBook(["dorm-b"], recover_after, verify_after, path=None)
    node = _FakeNode("dorm-b", recover_after)
    failed = 0

    def step(minute: int, status: str) -> list[str]:
        time_text = f"2026-09-22 20:{minute:02d}:00"
        temperature, humidity = (33.0, 55.0) if status != STATUS_NORMAL else (25.0, 60.0)
        node.apply(time_text, status)
        record = {"nodeId": "dorm-b", "temperature": temperature,
                  "humidity": humidity, "status": status, "time": time_text}
        return book.observe(node, record, reason="已连续偏热 5 分钟（3 次），持续时间最长")

    def check(what: str, got: Any, want: Any) -> None:
        nonlocal failed
        ok = got == want
        failed += 0 if ok else 1
        print(f"  [{'通过' if ok else '不通过'}] {what}：期望 {want!r} 实际 {got!r}")

    print("events.py 自测（内存里走一遍，不连 MQTT）")
    print()
    print("剧本一：异常 -> handle -> 连续正常 -> 自动恢复")
    for minute in range(30, 33):
        step(minute, "偏热")
    event = book.open_event("dorm-b")
    check("异常段第 3 条开出 OPEN", event.state if event else None, OPEN)
    check("开案时间 = 异常段第一条的时间", event.start_time if event else None, "2026-09-22 20:30:00")

    accepted, message = book.apply_action("dorm-b", HANDLE, when="2026-09-22 20:33:00",
                                          source="selftest")
    print(f"  handle 被接受={accepted}  {message}")
    check("handle 只把它推到 HANDLING", event.state, HANDLING)
    check("handle 没写 recovered_at", event.recovered_at, None)

    for minute in range(33, 36):
        changes = step(minute, STATUS_NORMAL)
        for line in changes:
            print(f"    {line}")
    check("连续 3 条正常后自动 RECOVERED", event.state, RECOVERED)
    check("recovered_at 取报文里的时间", event.recovered_at, "2026-09-22 20:35:00")
    print(f"  result = {event.result}")

    print()
    print("剧本二：handle 之后继续异常 -> 未恢复（对照，证明验证环节真的在判）")
    node2 = _FakeNode("dorm-b", recover_after)
    book2 = EventBook(["dorm-b"], recover_after, verify_after, path=None)
    for minute in range(40, 42):
        node2.apply(f"2026-09-22 20:{minute:02d}:00", "偏热")
        book2.observe(node2, {"nodeId": "dorm-b", "temperature": 33.0, "humidity": 55.0,
                              "status": "偏热", "time": f"2026-09-22 20:{minute:02d}:00"})
    second = book2.open_event("dorm-b")
    book2.apply_action("dorm-b", HANDLE, when="2026-09-22 20:42:00", source="selftest")
    for minute in range(42, 45):
        node2.apply(f"2026-09-22 20:{minute:02d}:00", "偏热")
        for line in book2.observe(node2, {"nodeId": "dorm-b", "temperature": 33.0,
                                          "humidity": 55.0, "status": "偏热",
                                          "time": f"2026-09-22 20:{minute:02d}:00"}):
            print(f"    {line}")
    check("处理后又来 3 条异常 -> UNRESOLVED", second.state, UNRESOLVED)
    check("未恢复就不该有 recovered_at", second.recovered_at, None)
    print(f"  result = {second.result}")

    print()
    print(f"{'全部通过' if failed == 0 else f'{failed} 处不通过'}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(_self_test())
