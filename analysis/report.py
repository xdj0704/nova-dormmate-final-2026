"""DormMate 分析报告 —— 把 summary 渲染成 Markdown。

运行：

    py -3.14 analysis/report.py
    py -3.14 analysis/report.py data/dormmate.csv
    py -3.14 analysis/report.py data/dormmate.csv -o reports/dormmate-report.md

报告是 summary 的**纯函数**：render() 只吃 analysis.summarize() 返回的那个字典，
不再回头碰 DataFrame。统计口径全在 summarize() 一处，要出别的格式（HTML / docx）
时换的只是这一层渲染，数字一个都不会变。

生成时间由参数传进来（不传才取当前时间），这样测试里能给定一个固定值，
输出可以逐字节比对。

用 py -3.14 而不是 python：PATH 上的 python 是 32 位解释器，
pandas 不发布 32 位 Windows 包，装不上。
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

# 项目根 = 本文件的上一级。这里必须自己推一遍，不能指望 import analysis 之后再问它要
# —— 下面那句 import 本身就需要项目根已经在 sys.path 上。
#
# 为什么非要补：`py -3.14 analysis/report.py` 跑的时候 sys.path[0] 是 analysis/，
# 而那个目录里正好有个 analysis.py。于是 `from analysis import ...` 会把这个【文件】
# 当成模块导入（而不是项目根下的 analysis 包），接着报
# "cannot import name 'rules' from 'analysis'" —— 报错信息会把人往"重名"上带，
# 其实是搜索路径的顺序问题。ROOT 插到最前面，包就赢过同名的文件了。
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

# 复用 analysis.py 里的项目根、读取和统计，别再抄一遍
from analysis import analysis, rules  # noqa: E402  —— 必须在上面调整完 sys.path 之后

# 全项目统一的时间格式，和网页的 formatTime()、发布端的 strftime 是同一套
STAMP = "%Y-%m-%d %H:%M:%S"

DEFAULT_OUT = analysis.ROOT / "reports" / "dormmate-report.md"

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="replace", line_buffering=True)


# ---------------------------------------------------------------- 小工具

def _cell(value) -> str:
    """表格单元格。

    竖线会把 Markdown 表格切歪，换行会直接把表格断成两半 —— CSV 里的字段
    是网页那边拼出来的，谁都可以往里写这两个字符。
    """
    text = "—" if value is None else str(value)
    return text.replace("|", "\\|").replace("\n", " ").strip()


def _table(header: list[str], rows: list[list[str]], right: tuple[int, ...] = ()) -> list[str]:
    """Markdown 表格。right 里的列右对齐（数字列用）。"""
    lines = [
        "| " + " | ".join(_cell(name) for name in header) + " |",
        "|" + "|".join(" ---: " if i in right else " --- " for i in range(len(header))) + "|",
    ]
    lines += ["| " + " | ".join(_cell(value) for value in row) + " |" for row in rows]
    return lines


def _percent(part: int, whole: int) -> str:
    """占比。实现只有一份，在 analysis.format_percent —— HTML 报告也用那个，
    不然同一份数据一份报告写 25.0%、另一份写 25.00%。"""
    return analysis.format_percent(part, whole)


def _range_text(summary: dict) -> str:
    """时间范围。同样转发到 analysis.format_range，两个报告一个说法。"""
    return analysis.format_range(summary)


def _extreme(low, high, unit: str) -> str:
    if low is None and high is None:
        return "（没有记录）"
    return f"{low:g} ~ {high:g} {unit}"


# ---------------------------------------------------------------- 各段落

def _head(summary: dict, generated_at: str) -> list[str]:
    return [
        f"- 数据文件：`{summary['file']}`",
        f"- 记录数：{summary['records']}",
        f"- 时间范围：{_range_text(summary)}",
        f"- 温度：{_extreme(summary['temp_min'], summary['temp_max'], '℃')}",
        f"- 湿度：{_extreme(summary['humidity_min'], summary['humidity_max'], '%')}",
        f"- 生成时间：{generated_at}",
    ]


def _status_section(summary: dict) -> list[str]:
    records = summary["records"]
    counts = summary["status_counts"]

    rows = [[name, str(number), _percent(number, records)] for name, number in counts.items()]
    rows.append(["**合计**", f"**{records}**", f"**{_percent(records, records)}**"])

    return [
        "## 状态分布",
        "",
        *_table(["状态", "条数", "占比"], rows, right=(1, 2)),
        "",
        "> 状态是用统一规则从温度/湿度**重算**出来的（`rule_status`），不是照抄 CSV 里的 `status`。",
    ]


def _consistency_section(summary: dict) -> list[str]:
    records = summary["records"]
    mismatches = summary["mismatches"]

    lines = ["## 规则一致性", ""]

    if records == 0:
        lines.append("没有数据行，跳过。")
        return lines

    if not mismatches:
        lines.append(f"{records} 行的 `status` 和规则重算结果一致。")
        return lines

    lines += [
        f"⚠ **{len(mismatches)} / {records} 行的 `status` 和规则重算结果不一致。**",
        "",
        "Web 端（`shared/rules.js`）和 Python 端（`status_rules.py`）的规则不同步了，",
        "多半是只改了一边。下面的统计一律按**规则重算**的口径给出。",
        "",
        *_table(
            ["时间", "温度 ℃", "湿度 %", "CSV 里的 status", "规则算出"],
            [
                [
                    item["time"] or "—",
                    # 复用 analysis 那边的 _num()：31.0 打成 31，缺失打成 —。
                    # 自己再写一遍的话，同一份文档里表头写 16、表格里写 16.0。
                    analysis._num(item["temperature"]),
                    analysis._num(item["humidity"]),
                    item["status"] or "（空）",
                    item["rule_status"] or "（空）",
                ]
                for item in mismatches
            ],
            right=(1, 2),
        ),
    ]
    return lines


def _attention_section(summary: dict) -> list[str]:
    records = summary["records"]
    attention = summary["attention"]

    lines = ["## 需要关注的记录", ""]

    if not attention:
        lines.append(f"没有，全部是「{rules.STATUS_NORMAL}」。")
        return lines

    lines += [
        f"{len(attention)} 条（占 {_percent(len(attention), records)}）"
        f"，即 `rule_status` 不是「{rules.STATUS_NORMAL}」的记录：",
        "",
        *_table(
            ["时间", "温度 ℃", "湿度 %", "状态"],
            [
                [
                    item["time"] or "—",
                    analysis._num(item["temperature"]),
                    analysis._num(item["humidity"]),
                    item["rule_status"] or "（空）",
                ]
                for item in attention
            ],
            right=(1, 2),
        ),
    ]
    return lines


def conclusions(summary: dict) -> list[str]:
    """结论。全部从 summary 里的数字推出来，不写死判断。

    这里**不做**「该开窗还是该除湿」这类建议 —— 建议文案的唯一出处是网页那边的
    getAdvice()（shared/rules.js）。在这一侧另写一份，改规则时必然漏改一处。
    """
    records = summary["records"]
    if records == 0:
        return ["文件里没有数据行，先确认导出的 CSV 是不是空的。"]

    bullets = []

    if summary["mismatches"]:
        bullets.append(
            f"有 **{len(summary['mismatches'])} / {records}** 行的 `status` 和规则算出来的对不上，"
            f"先查规则同步（`shared/rules.js` 对比 `status_rules.py`）—— "
            f"这份报告的数字是按规则重算的，两边不一致说明网页那边可能一直在写错的状态。"
        )

    counts = summary["status_counts"]
    top = max(counts.values())
    winners = [name for name, number in counts.items() if number == top]
    if len(winners) == 1:
        bullets.append(
            f"出现最多的是「{winners[0]}」，{top} 条，占 {_percent(top, records)}。"
        )
    else:
        joined = "、".join(f"「{name}」" for name in winners)
        bullets.append(f"{joined}并列最多，各 {top} 条，占 {_percent(top, records)}。")

    attention = len(summary["attention"])
    bullets.append(
        f"需要关注 {attention} 条，占 {_percent(attention, records)}"
        f"（`rule_status` 不是「{rules.STATUS_NORMAL}」的都算）。"
    )

    # 极值踩到阈值时才提一句，阈值直接取规则里的常量，不另写数字
    if summary["temp_max"] is not None and summary["temp_max"] >= rules.TEMP_HIGH:
        bullets.append(
            f"温度最高 {summary['temp_max']:g} ℃，已达到「{rules.STATUS_HOT}」的阈值 "
            f"{rules.TEMP_HIGH:g} ℃。"
        )
    if summary["humidity_max"] is not None and summary["humidity_max"] >= rules.HUMIDITY_HIGH:
        bullets.append(
            f"湿度最高 {summary['humidity_max']:g} %，已达到「{rules.STATUS_HUMID}」的阈值 "
            f"{rules.HUMIDITY_HIGH:g} %。"
        )

    return bullets


# ---------------------------------------------------------------- 渲染

def render(summary: dict, generated_at: str | None = None) -> str:
    """把 summary 渲染成 Markdown 文本。

    generated_at 不传就取当前时间；测试里传固定值，输出就能逐字节比对。
    """
    stamp = generated_at or datetime.now().strftime(STAMP)

    lines = [
        "<!-- 本文件由 analysis/report.py 生成，请勿手改。",
        f"     重新生成：py -3.14 analysis/report.py {summary['file']} -->",
        "",
        "# DormMate 宿舍环境分析报告",
        "",
        *_head(summary, stamp),
        "",
        *_status_section(summary),
        "",
        *_consistency_section(summary),
        "",
        *_attention_section(summary),
        "",
        "## 结论",
        "",
        *[f"- {bullet}" for bullet in conclusions(summary)],
        "",
    ]
    return "\n".join(lines)


def write(summary: dict, out_path: Path, generated_at: str | None = None) -> Path:
    """渲染并写文件，返回写出去的路径。目录不存在就建。"""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # 换行固定 LF：Markdown 走 LF，Windows 的 CRLF 会让 diff 变脏
    out_path.write_text(render(summary, generated_at), encoding="utf-8", newline="\n")
    return out_path


# ---------------------------------------------------------------- 入口

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="DormMate：读取导出的 CSV，生成 Markdown 分析报告",
    )
    parser.add_argument(
        "csv",
        nargs="?",
        default=str(analysis.DEFAULT_CSV),
        help=f"CSV 文件路径，相对路径按项目根解析（默认 {analysis.DEFAULT_CSV}）",
    )
    parser.add_argument(
        "-o", "--output",
        default=str(DEFAULT_OUT),
        help=f"报告输出路径，相对路径同样按项目根解析（默认 {DEFAULT_OUT}）",
    )
    args = parser.parse_args(argv)

    csv_path = analysis.resolve_csv(args.csv)
    out_path = analysis.resolve_csv(args.output)

    # verbose=False：统计报告段由 analysis.py 自己带着打印，
    # 这里只要 Markdown，不要再往屏幕上刷一份终端表格
    df = analysis.add_rule_status(analysis.load(csv_path))
    summary = analysis.summarize(df, csv_path, verbose=False)

    write(summary, out_path)

    print(render(summary))
    print(f"报告已写入：{out_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
