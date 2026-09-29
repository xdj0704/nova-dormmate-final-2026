"""Step 8-2：B3 今日摘要。

把一天的数据按节点找出「连续异常段」当成环境事件，再串成一段人话：

    dorm-a 全天整体正常；dorm-b 14:10 起持续偏热 40 分钟后恢复；
    dorm-c 21:30 出现偏湿，目前仍未恢复。今日共 2 次需要关注的环境事件。

这份摘要和看板上的「当前总览 / 判断依据」说的是同一件事，只是时间尺度不同：
看板说「现在正在持续多久」（还没结束），这里说「这一天发生过哪几段、后来好没好」。

单独跑一遍看看：

    py -3.14 analysis/daily_summary.py
    py -3.14 analysis/daily_summary.py data/day_sim.csv

【连续异常段】的定义和看板那边（dashboard/logic.js 的 nextAbnormal）是同一套：
一条不是「正常」的数据开一段，段里再来异常数据只是延长它（起点不动），
来一条正常数据就算这一段结束了。所以：

  * 「持续 40 分钟」= 这一段里【最后一条】异常数据的时间 −【第一条】异常数据的时间。
    和看板上「已持续 X 分钟」是同一个口径 —— 两边对不上才叫奇怪。
  * 「异常类型」取【开段时】那个状态。段里从偏热变成偏湿仍然是同一段，
    类型不改口 —— 看板 7-4 记事件时也是这么定的（problem 保持开案时那个）。
  * 没有「恢复」= 文件读完了这一段还开着。看板那边是 abnormalCount 还没归零。

【为什么这里有一句延迟 import】analysis/analysis.py 要 import 本模块来拼报告里的
「今日摘要」区块；如果本模块在顶层 import 回 analysis，两个模块就谁也先进不来
（先跑 analysis.py 卡在 import daily_summary，先跑 daily_summary.py 卡在 import
analysis）。所以只在真正要读文件的那几个函数里延迟 import —— 上面那些纯函数
（find_daily_events / render_daily_summary / source_note）本来也不需要它们。

用 py -3.14 而不是 python：PATH 上的 python 是 32 位解释器，pandas 装不上。
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

# 项目根 = 本文件的上一级。每个模块开头都自己推一遍，不靠当前工作目录 ——
# 本模块会被 analysis.py import、也会被测试单独 import，谁先谁后说不好。
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pandas as pd  # noqa: E402  —— 必须在上面调整完 sys.path 之后

from analysis import rules  # noqa: E402
from config import TIME_FORMAT  # noqa: E402

__all__ = [
    "find_daily_events",
    "render_daily_summary",
    "summarize_frame",
    "build_daily_summary",
    "source_note",
    "MISSING",
    "NORMAL",
    "SIMULATED",
    "UNKNOWN_NODE",
]

# 时间字段的统一格式（和发布端 strftime、网页 formatTime() 同一套）
TIME_FORMAT_IN = TIME_FORMAT

NORMAL = rules.STATUS_NORMAL

# 温湿度缺一个就判不出状态。analysis.py 里 add_rule_status() 就是往这一列写它的。
#
# 这个常量的家在【本模块】而不是 analysis.py：判断「哪种值算没有可用数据」
# 是分段算法的事（见下面 find_daily_events 的注释），algorithm 在哪家、常量在哪家。
# analysis.MISSING 指回这里，全项目仍然只有一份定义。
MISSING = "(缺失)"

# 节点名缺失时归到这一档，而不是悄悄丢掉那几行 ——
# 丢掉的话它下面的异常段会凭空消失，而总事件数照样报出来，对不上账。
UNKNOWN_NODE = "(未知节点)"

# source 列里表示「这不是现场采集的真数据」的那个值，由 make_sim_data.py 写入
SIMULATED = "模拟"

NODE_COLUMN = "nodeId"

# 规则重算过的状态列名。固定由 analysis.add_rule_status() 生成。
# 不认 CSV 里那列原始 status —— 网页那边规则改了、这边没改的话，
# 摘要会照着旧规则说得头头是道。
STATUS_COLUMN = "rule_status"

# CSV 里没有 nodeId 列时说的话。这份数据没法按宿舍分开，摘要就无从谈起。
NO_NODE_COLUMN_TEXT = (
    f"这份 CSV 里没有 {NODE_COLUMN} 列，没法按宿舍分开算今日摘要。"
    "先在网页上导出一份带 nodeId 的数据。"
)


# ---------------------------------------------------------------- 小工具

def _cell(value) -> str:
    """单元格 -> 去掉首尾空白的字符串。NaN / None / 空串一律给空串。"""
    if value is None or pd.isna(value):
        return ""
    return str(value).strip()


def _clock(text: str) -> str:
    """'2026-09-22 14:10:00' -> '14:10'。

    直接切字符串而不是 strptime 再 strftime：这里只是把时刻抄进句子里，
    格式不对时切出来的是原串（看得见问题），而 parse 失败就只能给一句
    「解析不出来」，反倒看不清原样是什么。
    """
    return text[11:16] if len(text) >= 16 else text


def _minutes(start: str, end: str) -> int | None:
    """两串时间差多少分钟。任一端解析不出来就返回 None（不猜一个数出来）。"""
    try:
        first = datetime.strptime(start, TIME_FORMAT_IN)
        last = datetime.strptime(end, TIME_FORMAT_IN)
    except (ValueError, TypeError):
        return None
    return int((last - first).total_seconds() // 60)


def _duration_text(minutes) -> str:
    """持续多久。算不出来就明说，不写「0 分钟」冒充一个数。"""
    return "时长未知" if minutes is None else f"{minutes} 分钟"


# ---------------------------------------------------------------- 找事件

def find_daily_events(df, node_column: str = NODE_COLUMN,
                      status_column: str = STATUS_COLUMN) -> list[dict]:
    """按节点找出「连续异常段」，一段就是一次环境事件。

    df 必须已经带上 rule_status 列（analysis.add_rule_status() 生成）。
    行按【文件里的顺序】处理，和看板那边一样不排序 —— 见 README「已知限制」
    里「报文没有乱序保护」那条，同一个口径。

    返回的每一项：
        nodeId    哪个宿舍
        start     这一段的【第一条】异常数据的时间
        end       这一段的【最后一条】异常数据的时间
        minutes   end − start，分钟；时间解析不出来时是 None
        status    异常类型，取【开段时】那个状态
        count     这一段里有几条异常数据
        recovered 这一段后面有没有出现过正常数据

    顺序固定按（节点名, 开始时间）。报告每次跑出来的行序要一样才好前后对比。
    """
    if status_column not in df.columns:
        raise SystemExit(
            f"find_daily_events() 需要 {status_column} 列（规则重算过的状态）。\n"
            "先用 analysis.add_rule_status(df) 补上 —— 直接读 CSV 里那列 status 的话，"
            "网页端规则改了这边不会跟着改，摘要会照着旧规则说得头头是道。"
        )
    if node_column not in df.columns:
        raise SystemExit(
            f"find_daily_events() 需要 {node_column} 列才能按宿舍分组。\n"
            f"（调用方可以先看一眼 {NODE_COLUMN!r} 在不在，再决定要不要出这一块。）"
        )

    events: list[dict] = []
    running: dict[str, dict] = {}   # 节点名 -> 这个节点正在开着的那一段

    for node_value, status_value, moment_value in zip(
            df[node_column], df[status_column], df["time"]):
        node = _cell(node_value) or UNKNOWN_NODE
        status = _cell(status_value)
        moment = _cell(moment_value)

        if status == MISSING:
            # 温湿度缺一个就没法判。这不是「环境异常」，是「没有可用数据」，
            # 所以既不开段、也不结段：和看板一致 —— 那边脏报文整条丢掉，
            # 正在进行的异常段起点不动，也不会因为中间空了一块就断成两截。
            continue

        if status == NORMAL:
            segment = running.pop(node, None)
            if segment is not None:
                segment["recovered"] = True
                events.append(segment)
            continue

        segment = running.get(node)
        if segment is None:
            running[node] = {
                "nodeId": node,
                "start": moment,
                "end": moment,
                # 开段时那个状态。段里从偏热变成偏湿也【不改口】——
                # 这是同一段连续异常，改口的话摘要会说「14:10 起持续偏湿」，
                # 而 14:10 那会儿明明是偏热。
                "status": status,
                "count": 1,
                "recovered": False,
            }
        else:
            segment["end"] = moment
            segment["count"] += 1

    # 文件读完了还开着的段：到这一天结束都没恢复正常
    events += [running[node] for node in sorted(running)]

    for event in events:
        event["minutes"] = _minutes(event["start"], event["end"])

    events.sort(key=lambda event: (event["nodeId"], event["start"]))
    return events


# ---------------------------------------------------------------- 生成句子

def _event_phrase(event: dict, first: bool) -> str:
    """一次事件的说法。

    第一个和后面的说法不一样，是为了「一个节点一天两段」时读得通：
    「dorm-b 14:10 起持续偏热 40 分钟后恢复，19:20 又出现偏湿，目前仍未恢复」。
    后一段如果也说「19:20 起持续偏湿」，「起」字就分不清是起什么，
    所以后面那几段统一用「又出现……」的说法。
    """
    clock = _clock(_cell(event.get("start")))
    status = _cell(event.get("status"))
    length = _duration_text(event.get("minutes"))

    if first:
        if event.get("recovered"):
            return f"{clock} 起持续{status} {length}后恢复"
        # 「目前」指的是这份数据记到的最后一刻。一整天的文件里就是「到这一天结束」，
        # 措辞和工作台上那句话保持一致。
        return f"{clock} 出现{status}，目前仍未恢复"

    if event.get("recovered"):
        return f"{clock} 又出现{status}，持续 {length}后恢复"
    return f"{clock} 又出现{status}，目前仍未恢复"


def render_daily_summary(events: list[dict], node_ids) -> str:
    """事件列表 + 出现过数据的节点 -> 一段今日摘要。

    node_ids 要单独传进来，因为一个节点可能【一个事件都没有】——
    这种节点在 events 里根本不出现，不传就漏了它的「全天整体正常」，
    或者更糟：不漏它，但把它算成「没有数据」。两者不是一回事。

    节点顺序按固定的码元序（sorted），不跟着区域设置走。
    """
    if not events and not node_ids:
        return "这一天没有收到任何节点的数据。"

    # 计数和说法必须对得上：万一 events 里冒出一个 node_ids 没提到的节点，
    # 就把它补进来，而不是让它在总数里算一笔却不吭声。
    order = sorted(set(_cell(node) or UNKNOWN_NODE for node in node_ids)
                   | {event["nodeId"] for event in events})

    by_node: dict[str, list[dict]] = {}
    for event in events:
        by_node.setdefault(event["nodeId"], []).append(event)

    clauses = []
    for node in order:
        mine = by_node.get(node, [])
        if not mine:
            # 这个节点这一天有数据、且一段异常都没有。
            # （没有数据的节点根本不在 order 里，不会被说成「正常」。）
            clauses.append(f"{node} 全天整体正常")
        else:
            said = "，".join(_event_phrase(event, index == 0)
                            for index, event in enumerate(mine))
            clauses.append(f"{node} {said}")

    head = "；".join(clauses) + "。"

    if not events:
        return head + "今日没有需要关注的环境事件。"
    return head + f"今日共 {len(events)} 次需要关注的环境事件。"


# ---------------------------------------------------------------- 数据来源

def source_note(df, column: str = "source") -> str:
    """这一块底下那句「数据来源」。

    从数据的 source 列读出来，不在代码里写死「模拟日数据」——
    写死的话，拿真数据跑出来的报告也会自称是模拟的。
    """
    if column not in df.columns:
        return (f"CSV 里没有 {column} 列，看不出这份数据是现场采集的还是模拟出来的")

    values = sorted({_cell(value) for value in df[column]} - {""})
    if not values:
        return f"{column} 列是空的，看不出这份数据是现场采集的还是模拟出来的"
    if values == [SIMULATED]:
        return f"模拟日数据（{column} 列全是「{SIMULATED}」，不是现场采集的真数据）"
    return "、".join(values)


# ---------------------------------------------------------------- 入口

def summarize_frame(df, file: str | None = None) -> dict:
    """DataFrame -> 这一天的摘要（纯函数，不读文件）。

    df 需要已经带上 rule_status 列。analysis.py 就是走这条 —— 它手上的 df
    已经算过一遍规则了，再读一次文件、再算一遍是白费，两遍还可能不一致。

    返回的字典只有内置类型，可以直接 json.dumps：
        file / records / nodes / events / text / source
    """
    summary = {
        "file": file,
        "records": len(df),
        "nodes": [],
        "events": [],
        "text": NO_NODE_COLUMN_TEXT,
        "source": source_note(df),
    }
    if NODE_COLUMN not in df.columns:
        return summary

    nodes = sorted({_cell(value) or UNKNOWN_NODE for value in df[NODE_COLUMN]})
    events = find_daily_events(df)

    summary["nodes"] = nodes
    summary["events"] = events
    summary["text"] = render_daily_summary(events, nodes)
    return summary


def build_daily_summary(csv_path) -> dict:
    """读一份 CSV，返回这一天的摘要和事件明细。

    单个入口，参数就是一个路径 —— 报告之外的地方（脚本、测试、以后别的界面）
    想单独要一句摘要时用它，不用自己接 load / add_rule_status 那一串。

    读和复核都走 analysis.py，本模块一份也不重抄：CSV 的读法（utf-8-sig 吃 BOM、
    缺列报人话）和「status 一律用规则重算」这两条规则各只有一处实现。

    延迟 import 的理由见文件头。
    """
    from analysis import analysis as report   # 延迟 import

    path = report.resolve_csv(str(csv_path))
    df = report.add_rule_status(report.load(path))
    return summarize_frame(df, file=str(path))


def _main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description="打印一份 CSV 的今日摘要（默认 data/day_sim.csv）",
    )
    parser.add_argument("csv", nargs="?", default=str(ROOT / "data" / "day_sim.csv"),
                        help="CSV 文件路径，相对路径按项目根解析")
    args = parser.parse_args(argv)

    summary = build_daily_summary(args.csv)

    print(f"文件：{summary['file']}")
    print(f"记录数：{summary['records']}")
    print(f"数据来源：{summary['source']}")
    print()
    print("今日摘要：")
    print(f"  {summary['text']}")

    if summary["events"]:
        print()
        print("事件明细：")
        for event in summary["events"]:
            result = "已恢复" if event["recovered"] else "仍未恢复"
            print(f"  {event['nodeId']}  {event['start']} → {event['end']}"
                  f"  {event['minutes']} 分钟  {event['status']}  {result}"
                  f"（{event['count']} 个异常点）")
    return 0


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        if hasattr(_stream, "reconfigure"):
            _stream.reconfigure(errors="replace", line_buffering=True)
    raise SystemExit(_main())
