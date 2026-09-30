"""DormMate 规则层：状态判定 + 优先排序。

**这个文件只干两件事，而且只有一件是它自己实现的：**

1. `judge_status()` —— **不在这里实现**。规则的真源是项目根的
   `status_rules.py`（一个语言只有一份），这里只做转发，连阈值都是从那边
   借来的。理由和 `analysis/rules.py` 一模一样：重抄一份的代价不是多打几行字，
   而是以后改规则时必然漏改一处 —— 发布端按新规则发「偏热」、core 按旧规则
   判成「偏湿」，两边都"没报错"。

2. `rank_priority()` —— **在这里实现**，Python 侧只有这一份。
   JS 侧 `dashboard/logic.js` 的 `ranked()` / `basisFor()` / `lostTo()` 是同一套
   规则，两边都不是「各自看着办」：它们的期望值钉在同一份
   `tests/fixtures/priority_cases.json` 上，Python 和 Node 各读一遍、
   逐条对上才算过。改这里的时候，那份 json 和 logic.js 要一起改。

优先顺序（四步，前一步分不出胜负才看下一步）：

    1) 连续异常时长，长的优先
    2) 时长一样，比这段里的异常条数，多的优先
    3) 还一样，比严重度：偏热 > 偏湿 > 偏冷（权重可在 core/config.json 里调）
    4) 全部并列，按 nodeId 字典序

第 4 步不是为了「更准」，是为了**确定**：同样一份数据永远得到同一个结果，
不会因为 dict 的遍历顺序变了就换了个人。所以这里**不许出现任何节点名**——
节点从数据里来，不是从这个文件里来。
"""

from __future__ import annotations

import math
import sys
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Iterable, Mapping, Sequence

# 项目根 = 本文件所在目录。用 __file__ 推导，不靠当前工作目录，
# 这样从任何地方 import rules 都能找到根目录的 status_rules。
_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from status_rules import (  # noqa: E402  —— 必须在上面调整完 sys.path 之后
    HUMIDITY_HIGH,
    STATUS_COLD,
    STATUS_HOT,
    STATUS_HUMID,
    STATUS_NORMAL,
    TEMP_HIGH,
    TEMP_LOW,
    compute_status as judge_status,
)

__all__ = [
    "judge_status",
    "rank_priority",
    "pick_priority",
    "NodeView",
    "RankedNode",
    "SEVERITY_WEIGHTS",
    "severity_of",
    "format_duration",
    "basis_for",
    "lost_to",
    "STATUS_COLD",
    "STATUS_HOT",
    "STATUS_HUMID",
    "STATUS_NORMAL",
    "TEMP_LOW",
    "TEMP_HIGH",
    "HUMIDITY_HIGH",
]

# 严重度权重：数字越大越该先看。
# 这一档只在「时长和条数都打平」时才轮得到，所以它出现的场合很少，
# 但排在前面的两步分不出胜负时，总得有个确定的说法。
# 取值和 web/style.css 里那四档状态色的角色是同一个意思：
#   偏热 = critical / 偏湿 = serious / 偏冷 = warning / 正常 = good（不参与排序）
# core/config.json 的 priority.severity 会覆盖这一份（缺哪个状态就用这里的）。
SEVERITY_WEIGHTS: dict[str, int] = {
    STATUS_HOT: 3,
    STATUS_HUMID: 2,
    STATUS_COLD: 1,
    STATUS_NORMAL: 0,
}


@dataclass(frozen=True)
class NodeView:
    """排序要用到的、一个节点的全部信息（算好了递进来，这里不读时间）。

    duration 是**秒**（浮点）。JS 那边用的是毫秒，两边只差一个 ×1000，
    换算放在 core 侧做，排序这一层不掺和单位。
    """

    node_id: str
    status: str
    count: int = 0
    duration: float = 0.0


@dataclass(frozen=True)
class RankedNode:
    """排好序的一条。reason 说的是这一条**当前的位次是怎么来的**：

    * 第一名：凭什么赢（`basis_for`）
    * 其余：输在哪一步（`lost_to`，对着第一名说）

    两种说法都不许含糊成「它更严重」这种话 —— 排序的每一步都要能指着
    具体那条数据说清楚，否则这个「优先关注」就只是个玄学。
    """

    node_id: str
    status: str
    count: int
    duration: float
    severity: int
    rank: int
    reason: str


def severity_of(status: str, weights: Mapping[str, int] | None = None) -> int:
    """查一个状态的严重度。不认识的状态当 0（不猜、也不炸）。"""
    table = weights if weights is not None else SEVERITY_WEIGHTS
    return int(table.get(status, 0))


def format_duration(seconds: float) -> str:
    """把秒数说成人话。**逐字对齐** `dashboard/logic.js` 的 fmtDuration(ms)。

    对齐这件事是有代价的：JS 那边收的是毫秒、这边收的是秒，很容易各写各的，
    于是同一段时长在页面上是「20 分钟」、在 core 的快照里是「20 分」。
    两个出口说的是同一件事，就不能有两套说法。

    JS 那边是 ms/1000 向下取整，所以这边也先向下取整到整秒再说：
    59.9 秒 -> 「不到 1 分钟」（不是「1 分钟」）。
    """
    if not isinstance(seconds, (int, float)) or isinstance(seconds, bool):
        total = 0
    elif not math.isfinite(seconds) or seconds <= 0:
        total = 0
    else:
        total = int(seconds)          # 向下取整：负数已在上面拦掉

    if total < 60:
        return "不到 1 分钟"

    minutes = total // 60
    if minutes < 60:
        return f"{minutes} 分钟"

    hours = minutes // 60
    rest = minutes % 60
    return f"{hours} 小时" if rest == 0 else f"{hours} 小时 {rest} 分钟"


def _sort_key(view: NodeView, weights: Mapping[str, int]) -> tuple:
    """四步判据的排序键。

    duration 取负是因为 Python 的 sort 是升序，而这三项都是「大的排前面」。
    最后一项是 node_id 本身（正序）。
    """
    return (
        -float(view.duration),
        -int(view.count),
        -severity_of(view.status, weights),
        str(view.node_id),
    )


def basis_for(winner: RankedNode, ranked: Sequence[RankedNode]) -> str:
    """拼出「凭什么」那半句 —— **不含节点名**。

    不含节点名是因为有两处要用它，而两处节点名的位置不一样：
    快照里是「dorm-b 已连续偏热 20 分钟（4 次），持续时间最长」，
    依据那半句是「优先关注 dorm-b：已连续…」—— 名字在「优先关注 …：」那里
    已经说过了，再说一遍就成了「优先关注 dorm-b：dorm-b 已连续…」。

    尾巴必须如实说明**赢在哪一步**。一律写「持续时间最长」是不行的：
    时长打平、靠条数赢的那次，说它「持续时间最长」就是假话。
    """
    head = (
        f"已连续{winner.status} {format_duration(winner.duration)}"
        f"（{winner.count} 次）"
    )

    if len(ranked) <= 1:
        # 只有一个异常节点时，下面那几步一步都没比过。
        # 写「持续时间最长」是在说一件没发生过的事。
        return head + "，是目前唯一的异常节点"

    others = list(ranked)[1:]
    # 跟它一样长的那些。为空 = 它就是最长的，赢在时长这一步。
    tied = [o for o in others if o.duration == winner.duration]
    if not tied:
        return head + "，持续时间最长"

    # 只跟**时长相同**的那些比条数。跟所有人比是错的：一个只异常了一分钟
    # 但有 99 条消息的节点，条数比谁都多，却根本没进到比条数这一步。
    top = tied[0]
    if winner.count > top.count:
        return head + f"，持续时间和 {top.node_id} 一样长，异常次数最多"

    # 再只跟**时长和条数都一样**的那些比严重度。
    same = [o for o in tied if o.count == winner.count]
    if same and winner.severity > same[0].severity:
        return (
            head
            + f"，持续时间和 {same[0].node_id} 一样长、异常次数也一样，"
              f"但{winner.status}比{same[0].status}更要紧"
        )

    # 四步全平。这里已经是最后的兜底，写的就是实话。
    peer = same[0].node_id if same else top.node_id
    return head + f"，和 {peer} 完全并列，按节点名顺序排在前面"


def lost_to(other: RankedNode, top: RankedNode) -> str:
    """一个排在后面的异常节点，为什么排在后面。

    尾巴同样要如实说**输在哪一步**：挨个字比过去、该第几步倒下就写第几步。
    一律写「但只持续 X 分钟」是错的 —— 时长打平、靠条数赢的那一轮，
    那个节点根本没有「只持续」这回事，这么写会让看的人以为排序是乱的。

    严重度那一档比的是**已经算好的 severity 字段**，不是拿 status 现查一遍：
    权重是 core/config.json 里配的，现查就会退回模块里那份默认值 ——
    改了配置之后，排序按新权重要紧、说出来的理由按旧权重，两边不一致
    而且不报错。
    """
    if other.duration < top.duration:
        return f"虽然{other.status}，但只持续 {format_duration(other.duration)}"
    if other.count < top.count:
        return (
            f"也{other.status}，持续时间和它一样长，"
            f"但只有 {other.count} 条异常数据"
        )
    if other.severity < top.severity:
        return (
            f"也{other.status}，时长和次数都跟它一样，"
            f"但{other.status}没有{top.status}要紧"
        )
    return f"也{other.status}，时长和次数都跟它一样，按节点名顺序排在后面"


def rank_priority(
    nodes: Iterable[NodeView],
    weights: Mapping[str, int] | None = None,
) -> list[RankedNode]:
    """把异常节点排好序，每条带上「它这个位次是怎么来的」。

    只接受**已经在异常中的**节点：正常节点不该出现在这一栏里，
    也不该因为「它更严重」而被选进来。传进来的东西一个都不改。

    空输入返回空列表（全部正常就是这种情形），不返回 None ——
    调用方不用为「没有重点」这件事再写一个分支。
    """
    views = [v for v in nodes if v is not None and int(v.count) > 0]
    if not views:
        return []

    table = weights if weights is not None else SEVERITY_WEIGHTS
    ordered = sorted(views, key=lambda v: _sort_key(v, table))

    # 先把每条的基本字段算出来（reason 还空着），再补理由：
    # 理由要看到**整张表**才说得清，所以不能一边排一边算。
    entries = [_as_ranked(v, i, table) for i, v in enumerate(ordered, start=1)]

    # 第一名：凭什么赢。后面每条的 lost_to 都要对着它说，所以先算它。
    head = replace(entries[0], reason=basis_for(entries[0], entries))
    return [head] + [
        replace(node, reason=lost_to(node, head)) for node in entries[1:]
    ]


def _as_ranked(view: NodeView, rank: int, weights: Mapping[str, int]) -> RankedNode:
    """把 NodeView 补成 RankedNode（reason 留空）—— 理由要整张表才算得出来。"""
    return RankedNode(
        node_id=view.node_id,
        status=view.status,
        count=int(view.count),
        duration=float(view.duration),
        severity=severity_of(view.status, weights),
        rank=rank,
        reason="",
    )


def pick_priority(
    nodes: Iterable[NodeView],
    weights: Mapping[str, int] | None = None,
) -> RankedNode | None:
    """最该先看的那个。全部正常时返回 None。

    这是 `rank_priority()[0]` 的别名，单独留一个名字是因为调用方绝大多数
    只关心「是谁」，而 `rank_priority` 的返回值里带着整张表。
    """
    ranked = rank_priority(nodes, weights)
    return ranked[0] if ranked else None


if __name__ == "__main__":
    # 直接跑就跑那 4 组回归数据 —— 和 analysis/rules.py 的自测同一个口径。
    cases = [
        (25, 60, STATUS_NORMAL),
        (16, 60, STATUS_COLD),
        (31, 60, STATUS_HOT),
        (25, 80, STATUS_HUMID),
    ]
    print("rules.py 回归自测（judge_status 转发自 status_rules.compute_status）")
    print()
    failed = 0
    for temperature, humidity, expected in cases:
        actual = judge_status(temperature, humidity)
        ok = actual == expected
        if not ok:
            failed += 1
        print(
            f"  {temperature:>5} ℃ / {humidity:>5} %"
            f"  ->  期望 {expected}  实际 {actual}  [{'通过' if ok else '不通过'}]"
        )
    print()
    print(f"{len(cases) - failed}/{len(cases)} 通过")
    raise SystemExit(0 if failed == 0 else 1)
