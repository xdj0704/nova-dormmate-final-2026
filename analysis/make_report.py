"""DormMate 离线分析链的出口 —— CSV + 事件 JSON 进，一份 report.html 出（Phase7）。

运行（在项目根下、或任何别的目录下都行）：

    py -3.14 analysis/make_report.py
    py -3.14 analysis/make_report.py --csv data/history.csv
    py -3.14 analysis/make_report.py --csv data/day_sim.csv --out report/day.html

三个参数：

    --csv     要分析的 CSV（默认 data/history.csv，也就是 core 写的那份）
    --events  事件文件（默认 data/events.json，core 自己写的）
    --out     报告写到哪（默认 report/history-report.html）

【这条链是怎么接上的】

    core.py ──每条合法遥测追加一行──> data/history.csv ─┐
    core.py ──事件状态机随状态改──> data/events.json  ─┴─> 本脚本 ──> report.html

两头都是**读文件**，不连 broker、不 import core 的运行期状态：报告是事后复盘，
它必须能在 core 早就关掉、broker 早就停了的时候照样出得来。

【报告是数据的纯函数】
换一份 CSV 重跑，报告里每一个数字都跟着变 —— 记录数、极值、平均、每张表的行、
图上那几条线，没有一个是写死的。所以「手工改 report.html」在这条链上没有意义：
下一次跑就没了。哪一处不对就去改输入或改代码，然后重跑。

【和 analysis/analysis.py 是什么关系】
不是替换，是**另一种装订**。读 CSV（utf-8-sig 吃 BOM、缺列报人话、温湿度查数字）
和「status 一律用规则重算」这两条规矩只有一处实现，就在 analysis.py 里，这里
`from analysis import analysis` 直接用，一行都不重抄。凡是要出 HTML 的地方
（区块、表格、转义、配色、文档骨架）也全走 analysis.py 里那几个函数。

本文件真正新写的只有四样，都是 Phase7 要的、analysis.py 没有的：

  1. 每个节点一行 的温湿度统计（最低 / 最高 / 平均）
  2. 趋势图**内嵌**进 HTML（base64 的 data: URL），不是旁边放个 trend.png
  3. 事件时间线（读 events.json，把一条案卷摊成「开案 / 定重点 / 指令 / 快照 / 结案」）
  4. Rule-ML 对比表 + 案例分析（CSV 的 ml_label 列有值就出表，空着就如实说「没判」；
     **空着不等于判成正常**，这句区别写在那两块自己的说明里）

【为什么图要内嵌】
analysis.py 出的 report/report.html 里是 `<img src="trend.png">` —— 把那份 html
单独拷给别人就是一张断图。Phase7 明确要求单文件：报告拷到哪都能直接打开、
不用连带一个 png。代价是 html 大几百 KB，一份报告换来这点体积是划算的。

用 py -3.14 而不是 python：PATH 上的 python 是 32 位解释器，
pandas 和 matplotlib 都不发布 32 位 Windows 包，装不上。
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

# 项目根 = 本文件的上一级。这里必须自己推一遍，不能指望 import analysis 之后再问它要
# —— 下面那句 import 本身就需要项目根已经在 sys.path 上（理由见 analysis/report.py：
# analysis/ 目录里有个同名文件 analysis.py，包和文件会打架）。
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from analysis import analysis, daily_summary, rules  # noqa: E402

# 全项目统一的时间格式，和网页的 formatTime()、core 的 strftime 是同一套
STAMP = analysis.TIME_FORMAT

# core 写的那份历史表。默认值就指它 —— 这条链的入口。
DEFAULT_CSV = _ROOT / "data" / "history.csv"

# 事件文件，和 core 的 config.EVENTS_PATH 是同一个文件。这里写死这个相对路径
# 而不是 import config：analysis/ 这一层不该因为出一份报告就依赖 core 那边的模块
# （config.py 会读环境变量、还带着 broker 那一堆）。路径是接口，够用了。
DEFAULT_EVENTS = _ROOT / "data" / "events.json"

# 默认输出。**故意不是 report/report.html**：那一份是 analysis/analysis.py 的产物
# （Step 2-5 起，和它旁边的 trend.png 是一对）。两个脚本往同一个文件上写的话，
# 后跑的那个会静默把前一个覆盖掉，而文件名一样、看不出换过作者。
DEFAULT_OUT = _ROOT / "report" / "history-report.html"

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="replace", line_buffering=True)


# ======================================================================
# 一、每个节点的温湿度统计
# ======================================================================

# 没有 nodeId 列时（data/dormmate.csv 是从单节点看板导出的那种）算在这一组里。
# 括号是刻意的：它看起来就不像一个宿舍名，不会有人以为真有这么一间。
NO_NODE = "（未标宿舍）"

# 统计表的列。「异常条数」和「缺读数」是**两列**，不是一个数：温湿度没报全的
# 那一行算不出状态，它既不是正常也不是异常，把两种数混进一格，读的人没法核账
# （条数 = 正常 + 异常 + 缺读数，这一列一列摆着，对不对得上自己就能看）。
# 数字列全部右对齐 —— 对不齐的话，一列看着像两列。
NODE_HEADER = ["宿舍", "条数", "异常条数", "缺读数",
               "温度最低 ℃", "温度最高 ℃", "温度平均 ℃",
               "湿度最低 %", "湿度最高 %", "湿度平均 %"]


def node_column(df) -> str | None:
    """df 里表示「哪一间」的列名；没有就是 None。"""
    return "nodeId" if "nodeId" in df.columns else None


def node_stats(df) -> list[dict]:
    """按节点分组算统计。返回的每一项：

        nodeId / records / abnormal / missing / temp_min / temp_max / temp_avg /
        humidity_min / humidity_max / humidity_avg

    平均值的口径：**按有效值算**（缺的那几条不参与），条数就是参与的那几条 ——
    把空值当 0 算进去的话，一个缺了半天的宿舍平均温度会莫名其妙地低。
    一行有效值都没有时三个统计量都是 None，报告里打成「—」，不是 0。

    「异常条数」数的是**规则重算**的结果，不是 CSV 里那列 status（口径见
    analysis.py）；rule_status 为「(缺失)」的那些单独算进「缺读数」，不混在
    异常里 —— 一条没报上来的读数和一条报上来的偏热读数，是两件事。

    排序按节点名，不按条数：报告每次跑出来的行序要一样，才好前后对比。
    """
    column = node_column(df)
    groups: dict[str, list] = {}
    for index, row in enumerate(df.itertuples()):
        name = NO_NODE if column is None else (analysis._clean(getattr(row, column)) or NO_NODE)
        groups.setdefault(name, []).append(index)

    out = []
    for name in sorted(groups):
        rows = df.iloc[groups[name]]
        temperatures = [v for v in (analysis._number(x) for x in rows["temperature"])
                        if v is not None]
        humidities = [v for v in (analysis._number(x) for x in rows["humidity"])
                      if v is not None]
        statuses = [analysis._clean(value) for value in rows["rule_status"]]
        missing = sum(1 for value in statuses if value == analysis.MISSING)
        abnormal = sum(1 for value in statuses
                       if value not in (rules.STATUS_NORMAL, analysis.MISSING, ""))
        out.append({
            "nodeId": name,
            "records": len(rows),
            "abnormal": abnormal,
            "missing": missing,
            "temp_min": min(temperatures) if temperatures else None,
            "temp_max": max(temperatures) if temperatures else None,
            "temp_avg": analysis._number(sum(temperatures) / len(temperatures))
            if temperatures else None,
            "humidity_min": min(humidities) if humidities else None,
            "humidity_max": max(humidities) if humidities else None,
            "humidity_avg": analysis._number(sum(humidities) / len(humidities))
            if humidities else None,
        })
    return out


def node_stats_rows(stats: list[dict]) -> list[list[str]]:
    """统计 -> 表格行。格式化一律走 analysis._num（31.0 打成 31、缺失打成 —）。"""
    return [
        [
            item["nodeId"],
            analysis._num(item["records"]),
            analysis._num(item["abnormal"]),
            analysis._num(item["missing"]),
            analysis._num(item["temp_min"]), analysis._num(item["temp_max"]),
            analysis._num(item["temp_avg"]),
            analysis._num(item["humidity_min"]), analysis._num(item["humidity_max"]),
            analysis._num(item["humidity_avg"]),
        ]
        for item in stats
    ]


def node_stats_section(stats: list[dict], records: int) -> dict:
    """「每个宿舍的温湿度」区块。返回 sections 里的一项。"""
    body = [
        f'<p class="note">按宿舍分组。平均值只拿<strong>有值的那些条</strong>去算'
        f"（缺的几条不参与，也不当 0 算），所以「条数」是这一组的总条数，"
        f"而平均值可能来自其中一部分。</p>",
        f'<p class="note">「异常条数」按规则重算的结果数，不采用 CSV 里写的 '
        f'status；温或湿有一个没报的那几行算不出来状态，单独记在'
        f'「缺读数」里 —— <strong>没报上来的读数和报上来的偏热读数不是一件事</strong>，'
        f'混成一格的话「异常 5 条」到底是五次异常还是五次掉线就看不出来了。'
        f"三个数应当对得上：条数 = 正常 + 异常条数 + 缺读数。</p>",
    ]
    body.append(analysis._html_table(
        NODE_HEADER, node_stats_rows(stats), right=tuple(range(1, len(NODE_HEADER)))))

    if len(stats) <= 1 and records:
        # 只有一组时不说这句话也不影响读，但说了更省事：读的人不用自己数
        # 「是不是漏了几个宿舍」。
        body.append(f'<p class="note">这份数据里只有一组'
                    f'（{analysis._esc(stats[0]["nodeId"])}）。</p>')
    return {"title": "每个宿舍的温湿度", "html": "\n".join(body)}


# ======================================================================
# 二、趋势图（内嵌 base64）
# ======================================================================

# 一条线一个颜色。这一组是**跑过校验**的固定顺序（不是挑好看的）：
# 亮度带、彩度下限、色盲相邻间距、正常视觉间距、与底色的对比度，五项一起过；
# 那张「与底色对比度」上有一处 WARN，要求"标签或表格补足"——本报告两条都有
# （图例把每条线的名字写全了，下面那张每宿舍统计表也把每个数摆全了）。
# 换颜色之前先把新的一组丢给校验脚本跑一遍：肉眼看着"够不一样"的两条线，
# 在红绿色盲眼里可能是同一条。
NODE_COLORS = ("#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300")

# 三个真宿舍**钉死**在头三槽。为什么不让颜色跟着"第几条线"走：那样子集一变，
# 后面每个宿舍都会换一种颜色 —— 拿只含 dorm-a/dorm-c 的报告去和昨天三间的
# 报告对照，同一个 dorm-c 是两种颜色，而图上看不出哪儿不对。
# 后三槽留给列表之外的节点（真多出第四间时它不会撞上面三间）；
# 调色板用完了才允许重色 —— 那时候宁可重色，也不能让两条线换位置，
# 因为重色看得见，换位置看不见。
NODE_COLOR_START = {"dorm-a": 0, "dorm-b": 1, "dorm-c": 2}


def assign_colors(names: list[str]) -> dict[str, str]:
    """节点名（已排序）-> 颜色。登记表里的先用自己那一槽，其余填剩下的空位。"""
    colors: dict[str, str] = {}
    taken = set()
    for name in names:
        start = NODE_COLOR_START.get(name)
        if start is not None:
            colors[name] = NODE_COLORS[start]
            taken.add(start)

    spare = [index for index in range(len(NODE_COLORS)) if index not in taken]
    unknown = [name for name in names if name not in colors]
    for name, index in zip(unknown, spare):
        colors[name] = NODE_COLORS[index]
    # zip 截断在短的那一边：备用的槽比没登记的节点少时，剩下的分不到颜色。
    for name in unknown[len(spare):]:
        colors[name] = NODE_COLORS[-1]
    return colors

# 阈值线的颜色。和 analysis.py 的图不同，这里两条线不靠颜色区分温度/湿度
# （那是子图标题的活），所以阈值统一用中性的灰 —— 它是个参考线，不是数据。
THRESHOLD_COLOR = "#8A8F98"
GRID_COLOR = analysis.GRID_COLOR
FIG_SIZE = (10.5, 7.5)
DPI = 120
LINE_WIDTH = 1.6

# 两条相邻读数隔多久算「中间没读数」，进而把折线断开。
# 基准是这个节点自己的**采样间隔中位数**（不是写死的秒数）：模拟器 5 秒一条、
# 历史表一秒一条、手写样本 5 分钟一条，写死一个秒数只对得上一份数据。
# 倍数取 6 是留够丢包的余量 —— 连着漏掉三五条还不至于在图上开一个口子。
GAP_FACTOR = 6

# 断点用的值。matplotlib 遇到 nan 就不画那一段，也不画那个点 ——
# 折线在那儿张开一个口子，正是「这中间没有读数」该有的样子。
NAN = float("nan")


def series_by_node(df) -> list[dict]:
    """按节点拆成几条折线。

    每一项：nodeId / times（datetime 列表）/ temperature / humidity /
            skipped / gaps / color。

    【两种"断开"】温湿度缺值的给 nan，让折线在那儿断开；**相邻两条离得太远**
    的中间也补一个 nan（倍数见 GAP_FACTOR），同样断开。后一种容易被忘掉：
    数据本身没有缺值，只是那天夜里没人采集 —— 不断开的话 matplotlib 会老老实实
    连成一条横贯 19 小时的直线，读起来正是「整夜平稳，而且我们一直在测」。
    这句谎话和「缺值连成直线」是一回事，只是更不容易被发现。

    analysis.trend_series() 是把整份 df 当成一条线用的（它对着单节点导出的
    CSV 写的）。三个宿舍的读数交错在一份文件里，画成一条线会来回横跳 ——
    所以在这一层按节点拆开，一个宿舍一条线。
    """
    column = node_column(df)
    groups: dict[str, list] = {}
    for index, row in enumerate(df.itertuples()):
        name = NO_NODE if column is None else (analysis._clean(getattr(row, column)) or NO_NODE)
        groups.setdefault(name, []).append(index)

    names = sorted(groups)
    colors = assign_colors(names)

    out = []
    for name in names:
        rows = df.iloc[groups[name]]
        points: list[tuple] = []
        skipped = 0
        for row in rows.itertuples():
            moment = analysis._parse_time(analysis._clean(row.time))
            if moment is None:
                skipped += 1
                continue
            points.append((moment, analysis._value(row.temperature),
                           analysis._value(row.humidity)))
        # 按时间升序 —— 和 analysis.trend_series() 同一个理由：CSV 是追加写的、
        # 正常本来就按时间，但把几份文件拼在一起就可能乱序，乱序画出来的折线
        # 会来回折返。三个一起排（不是只排时间），温湿度才不会错位。
        points.sort(key=lambda point: point[0])

        gaps = break_long_gaps(points)
        out.append({
            "nodeId": name,
            "times": [point[0] for point in points],
            "temperature": [point[1] for point in points],
            "humidity": [point[2] for point in points],
            "skipped": skipped,
            "gaps": gaps,
            "color": colors[name],
        })
    return out


def sampling_basis(points: list[tuple]) -> float:
    """这一个节点"平时隔多久来一条"的估计。返回秒数，估不出来时返回 0。

    取**正的**相邻间隔的中位数：中位数对「偶尔漏几条」不敏感，而均值会被那个
    大间隔自己拽偏（正好把要找的东西平均掉 —— 用一个包含了病灶的数字当基准，
    是这类判据最容易犯的错）。

    正间隔不足三个时改用其中最小的那个，理由是**中位数在两三个点上不好使**：
    只有两个间隔时中位数取的是较大的那个，而它永远也超不过自己的六倍 ——
    一段只有三个点、横跨一夜的数据因此永远断不开，正好躲过这条判据想抓的东西。
    只有两个点时，最小的那个间隔是这个节点唯一能拿出来的"平时多久一条"。

    一个正间隔都没有（所有读数同一时刻）时返回 0：那时候"正常间隔"就是 0，
    按倍数算下去每一处都该断，图会碎成一地孤点 —— 那不是发现了异常，
    那是判据自己除了零。
    """
    deltas = sorted(delta for delta in
                    ((points[i + 1][0] - points[i][0]).total_seconds()
                     for i in range(len(points) - 1))
                    if delta > 0)
    if not deltas:
        return 0.0
    if len(deltas) < 3:
        return deltas[0]
    return deltas[len(deltas) // 2]


def break_long_gaps(points: list[tuple]) -> int:
    """把间隔过大的相邻两点之间插一个 nan 点（**原地改 points**），返回插了几处。

    基准见 sampling_basis()（这个节点自己的采样间隔，不是写死的秒数）。
    """
    if len(points) < 3:
        return 0        # 两个点之间无所谓断不断，它就是一条线段

    basis = sampling_basis(points)
    if basis <= 0:
        return 0
    limit = basis * GAP_FACTOR

    gaps = 0
    for index in range(len(points) - 1, 0, -1):
        # 从后往前插：正着插的话，插进去的元素会把后面还没检查的下标全挪一位。
        if (points[index][0] - points[index - 1][0]).total_seconds() > limit:
            points.insert(index, (points[index - 1][0], NAN, NAN))
            gaps += 1
    return gaps


def plot_trend_base64(df):
    """画趋势图，返回 (data URL, 说明文字, 出错原因)。

    成功时是 ("data:image/png;base64,...", "...", None)；
    画不了时是 (None, None, 原因) —— 报告那一段降级成一句话，其余照常出。

    版式：上下两个子图，上面温度、下面湿度，横轴共用。**不是**一根轴画两条线：
    温度是十几到三十几、湿度是六十到八十，塞进一根轴里会互相挤扁（analysis.py
    那份报告用的是左右双轴，那是另一种解法 —— 但双轴的两根刻度谁对谁很容易读错，
    这里数据本来就要按节点拆，干脆拆干净）。
    """
    try:
        plt = analysis._pyplot()
    except SystemExit as exc:
        # _pyplot() 没装 matplotlib 时会 SystemExit 并带一句人话（含安装命令）。
        # 这里把那句话原样当成降级原因 —— 重新写一句就有两种说法了。
        return None, None, str(exc)

    from matplotlib import dates as mdates
    from matplotlib import ticker

    series = series_by_node(df)
    fig, (ax_t, ax_h) = plt.subplots(2, 1, figsize=FIG_SIZE, dpi=DPI, sharex=True)

    handles: list[tuple] = []           # (线, 名字)，图例用
    for axis, key, label, unit, threshold in (
        (ax_t, "temperature", "温度", "℃", (rules.TEMP_LOW, rules.TEMP_HIGH)),
        (ax_h, "humidity", "湿度", "%", (rules.HUMIDITY_HIGH,)),
    ):
        for entry in series:
            if not entry["times"]:
                continue
            line, = axis.plot(entry["times"], entry[key], color=entry["color"],
                              linewidth=LINE_WIDTH, marker="o", markersize=3)
            if axis is ax_t:            # 名字只收一遍，两个子图是同一批线
                handles.append((line, entry["nodeId"]))
        # 统一规则的那几条阈值画成虚线。数值直接取规则里的常量，不在这儿写 18/30/75
        # —— 写死的话，规则改了图还画着旧线，而图看着完全正常。
        for value in threshold:
            axis.axhline(value, color=THRESHOLD_COLOR, linestyle=":", linewidth=1.1)
        # 阈值不进图例，写在纵轴标签里：温度有两条、湿度有一条，加起来五个图例
        # 条目会把图例挤成两行，还得跟标题抢地方。虚线是灰色参考线、不是数据，
        # 它该在哪儿读、读多少，这句话比一个色块说得清楚。
        axis.set_ylabel(f'{label} ({unit})\n虚线＝{label}阈值 '
                        + " / ".join(f"{value:g}" for value in threshold))
        axis.grid(True, color=GRID_COLOR, linewidth=0.6)
        axis.set_axisbelow(True)
        axis.yaxis.set_major_formatter(ticker.FormatStrFormatter("%g"))

    # 图例摆在**整张图**的顶上、标题下面，两个子图共用一份。摆在某个子图的角上
    # 会盖住数据（这份数据里最近的那些点正好在右上角），而且同样的几个名字
    # 上下各来一遍是白占地方。每条线的名字都在这儿 —— 颜色不是唯一的身份来源。
    if handles:
        fig.legend([line for line, _ in handles], [name for _, name in handles],
                   loc="upper center", bbox_to_anchor=(0.5, 0.965),
                   ncol=max(1, len(handles)), fontsize=9, frameon=False)

    fig.suptitle(analysis.TREND_TITLE
                 + "（Phase7：一个宿舍一条线，上下两张子图各画一个量）",
                 fontsize=13, y=0.995)
    ax_h.set_xlabel("时间")

    has_data = any(entry["times"] for entry in series)
    if not has_data:
        # 一行能画的数据都没有也照样出图：报告里那张图的位置不该时有时无。
        ax_t.text(0.5, 0.5, "没有可绘制的数据", transform=ax_t.transAxes,
                  ha="center", va="center", fontsize=14, color="#888888")
        ax_h.set_xticks([])
    else:
        # 横轴标签是"09-22 20:30"这种长文本，点一多就挤成一团：限个数 + 斜过来。
        ax_h.xaxis.set_major_locator(mdates.AutoDateLocator(maxticks=8))
        span = max(entry["times"][-1] for entry in series if entry["times"]) - \
            min(entry["times"][0] for entry in series if entry["times"])
        # 一天以内只报时分。秒对不上任何决策，却把每个标签拉长三分之一 ——
        # 挤到斜着放还叠字。跨天的必须带上日期，不然"09:00"是今天的还是
        # 明天的看不出来。
        ax_h.xaxis.set_major_formatter(mdates.DateFormatter(
            "%H:%M" if span < timedelta(days=1) else "%m-%d %H:%M"))
        ax_h.tick_params(axis="x", labelrotation=30)
        for label in ax_h.get_xticklabels():
            label.set_horizontalalignment("right")

    # rect 把顶上那 11% 让给标题和图例。不给的话 tight_layout 会按「只有坐标轴」
    # 铺满整张图，标题和图例叠在线上 —— 它不管图例这种画在坐标轴外面的东西。
    fig.tight_layout(rect=(0.0, 0.0, 1.0, 0.89))

    # 存进内存再 base64，不落 png：这份报告的卖点是单文件，旁边多一个
    # trend.png 的话，「拷走就断图」那件事又回来了。
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png")
    plt.close(fig)          # 不关的话反复画图会一直堆在内存里
    raw = buffer.getvalue()
    encoded = base64.b64encode(raw).decode("ascii")

    # 「几个点」要减掉插进去的那些 nan —— 它们是断口，不是读数。
    points = sum(len(entry["times"]) - entry["gaps"] for entry in series)
    note = (f"图上有 {len(series)} 条线（一个宿舍一条），共 "
            f"{points} 个点，"
            f"内嵌进 HTML 的是 {len(raw) // 1024} KB 的 PNG"
            f"（base64 之后 {len(encoded) // 1024} KB）。")
    gaps = sum(entry["gaps"] for entry in series)
    if gaps:
        note += (f"另有 {gaps} 处断开：那两段读数之间隔得比这个宿舍平时"
                 f"采样间隔（中位数）的 {GAP_FACTOR} 倍还远，中间是没数据、"
                 f"不是一直平稳，所以没有连成直线。")
    skipped = sum(entry["skipped"] for entry in series)
    if skipped:
        note += f"还有 {skipped} 条没有可用的 time（画不到横轴上），没画。"
    return "data:image/png;base64," + encoded, note, None


def trend_section(df) -> dict:
    """「趋势图」区块。返回 sections 里的一项。"""
    data_url, note, reason = plot_trend_base64(df)

    if data_url is None:
        return {
            "title": "趋势图",
            "html": (f'<p class="empty">这一段没画：{analysis._esc(reason)}</p>\n'
                     f'<p class="note">报告其余部分不受影响 —— 那些数字来自'
                     f"本报告读到的 CSV。</p>"),
        }

    body = [
        '<p class="note">温度、湿度各一个子图，<strong>一个宿舍一条线</strong>'
        "—— 三间房的读数交错在同一份 CSV 里，画成一条线会来回横跳。"
        "虚线是统一规则的阈值（数值取 rules.py 里的常量，不在这里写死）。</p>",
        f'<img alt="各宿舍温度与湿度随时间的变化" src="{data_url}">',
        f'<p class="note">{analysis._esc(note)}</p>',
    ]
    return {"title": "趋势图", "html": "\n".join(body)}


# ======================================================================
# 三、数据来源：模拟数据还是构造样本
# ======================================================================

# CSV 的 source 列 -> 「这是什么数据」。键一律小写（比之前先折叠大小写）。
#
# 为什么不干脆只把原值列出来：报告开头那句「这份数据是模拟的还是现采的」
# 是读报告的人最先要判断的事，而 CSV 里那列可能是 sim / simulator / 模拟
# 三种写法（发布端、剧本、手写样本各一套）。归类是**解释**，原值照样列出来
# ——只归类不列原值的话，「模拟」和「构造样本」被并成一类也看不出来。
# 「构造样本」这个归类名。写成常量是因为它不只是一句给人看的话：
# analysis/train_iforest.py 的「训练时跳过构造样本」判据就是这个字符串
# —— 那张表里归到这一类的那几个 token，一个都不许进训练集。
# 全项目只有这一处字面量：改名字就改这里，判据和显示会一起跟着变。
CONSTRUCTED_KIND = "构造样本"

SOURCE_KINDS = {
    "sim": "模拟数据",
    "simulator": "模拟数据",
    "simulated": "模拟数据",
    "模拟": "模拟数据",
    "模拟数据": "模拟数据",
    "day_sim": "模拟数据",
    "构造": CONSTRUCTED_KIND,
    "构造样本": CONSTRUCTED_KIND,
    "sample": CONSTRUCTED_KIND,
    "samples": CONSTRUCTED_KIND,
    "manual": CONSTRUCTED_KIND,
    # Phase8 D5 的构造样本标的是英文 constructed（题目指定的那一个词），
    # 和上面那几个中文/英文同义词归成同一类。不加这一条的话，它会落进
    # UNKNOWN_SOURCE，而 train_iforest.py 的「跳过构造样本」判据正是拿这张表
    # 做的 —— 判不出来就会拿构造样本去训练，那些极端值会被当常态学进去，
    # 之后 ML 反过来判它们「正常」，案例复现不出来，而且**一句错都不报**。
    "constructed": CONSTRUCTED_KIND,
    "web": "页面录入",
    "ui": "页面录入",
    "页面": "页面录入",
    "script": "剧本回放",
    "cmd": "剧本回放",
}

SOURCE_HEADER = ["CSV 里的 source", "归为", "条数", "占比"]

# 看不出来源时那句话。**不去猜**：把一份来路不明的数据说成「模拟数据」，
# 事后没人能发现，而这正是报告里最不该有的那种错。
UNKNOWN_SOURCE = "未归类"


def source_breakdown(df) -> dict:
    """source 列 -> {rows: [...], kinds: [...], text: 一句话}。

    没有 source 列时如实说出来（老格式的 CSV 确实没有这一列）。
    """
    if "source" not in df.columns:
        return {
            "rows": [],
            "kinds": [],
            "text": "CSV 里没有 source 列，看不出这份数据是模拟的还是现采的。",
        }

    counts: dict[str, int] = {}
    for value in df["source"]:
        raw = analysis._clean(value)
        key = raw or "（空）"
        counts[key] = counts.get(key, 0) + 1

    records = len(df)
    rows = []
    kinds: dict[str, int] = {}
    for raw in sorted(counts):
        kind = SOURCE_KINDS.get(raw.lower(), UNKNOWN_SOURCE)
        kinds[kind] = kinds.get(kind, 0) + counts[raw]
        rows.append([raw, kind, analysis._num(counts[raw]),
                     analysis.format_percent(counts[raw], records)])

    present = [kind for kind in kinds if kind != UNKNOWN_SOURCE]
    if not present:
        text = (f"source 列的 {len(counts)} 种取值都没在已知分类里"
                f"（{ '、'.join(sorted(counts)) }）—— 报告的读者要自己判断"
                f"这份数据是模拟的还是现采的。")
    elif len(kinds) == 1 and not kinds.get(UNKNOWN_SOURCE):
        text = f"这份数据全部是{present[0]}（source 列只有一种取值）。"
    else:
        parts = "、".join(f"{kind} {kinds[kind]} 条"
                         for kind in sorted(kinds, key=lambda k: (-kinds[k], k)))
        text = ("这份数据混了几种来源：" + parts
                + "。逐条的口径看下面那张表 —— 混着的时候，「这份数据是模拟的吗」"
                  "没有一个整答案，得按来源分开说。")
    return {"rows": rows, "kinds": sorted(kinds), "text": text}


def source_section(df) -> dict:
    """「数据来源」区块。放在报告靠前的位置 —— 它限定了后面所有数字的读法。"""
    breakdown = source_breakdown(df)
    body = [f'<p>{analysis._esc(breakdown["text"])}</p>']

    if breakdown["rows"]:
        body.append(analysis._html_table(
            SOURCE_HEADER, breakdown["rows"], right=(2, 3)))
        body.append(
            '<p class="note">「归为」那一列是这张表对 source 的解释，'
            "原值照样列出来。以后真接了现场设备，把它的 source 加进 "
            "SOURCE_KINDS 就行；不加也不影响出报告，只是会算成「未归类」"
            "—— 那是一个<strong>如实</strong>的结果，比猜一个强。</p>")
    return {"title": "数据来源", "html": "\n".join(body)}


# ======================================================================
# 四、事件时间线（读 events.json）
# ======================================================================

# 时间线的列。「时间」排第一是因为整张表按它排 —— 复盘要看的是先后顺序。
TIMELINE_HEADER = ["时间", "宿舍", "案卷", "节点", "说明"]

# 最多画多少个节点。events.json 留 200 条事件，每条 4-5 个节点的话上千行，
# 一份报告不该这么大。截断了就在下面如实说截了多少。
TIMELINE_MAX = 160

# 照片那一类快照的 kind。同一条案的 snapshots 里还混着**状态迁移**的记录
# （开案、恢复…），它们没有 kind —— 只按存在与否去数，会把状态记成照片。
CAMERA_KIND = "camera"

OPENING = "开案"
PRIORITY = "定为重点"
ACTION = "指令"
PHOTO = "现场快照"
CLOSING = "结案"


def load_events(path: Path):
    """读 events.json，返回 (数据, 出错原因)。读不了时数据是 None。

    **读不了不算报告坏了**：这条链的两半是分开的（CSV 是每条读数、事件是每条
    案子），没有事件文件照样能把统计和趋势出完。所以这里不抛，只返回原因，
    由区块如实说一句。
    """
    if not path.exists():
        return None, f"没有 {path.name}（core 还没开过案子，或者路径给错了）"
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        return None, f"读不了 {path.name}：{exc}"
    try:
        data = json.loads(raw)
    except ValueError as exc:
        # 半截文件是最常见的情况：core 正在写的时候被 Ctrl+C。
        return None, f"{path.name} 不是合法的 JSON：{exc}"
    if not isinstance(data, dict) or not isinstance(data.get("events"), list):
        return None, f"{path.name} 的形状不对（顶层应有 v / events 两个键）"
    return data, None


def event_label(event: dict) -> str:
    """一条事件的「类型」说法：结案的说结果，没结案的说它还开着。"""
    state = analysis._clean(event.get("state"))
    if state:
        return state
    return "（没写状态）"


def timeline_entries(data: dict) -> list[dict]:
    """events.json -> 一条条按时间排好的节点。

    每条事件的五个节点（有几个记几个）：
        开案      start_time + problem
        定为重点   priority_time + priority_reason（core 挑它当重点那一刻）
        指令      actions 里的每一条（handle）
        现场快照   snapshots 里 kind == camera 的那些
        结案      recovered_at / end_time + result + state
    """
    entries = []
    for event in data["events"]:
        if not isinstance(event, dict):
            continue
        event_id = analysis._clean(event.get("event_id"))
        node_id = analysis._clean(event.get("nodeId"))

        def add(when, kind, text):
            moment = analysis._clean(when)
            if not moment:
                return
            entries.append({"time": moment, "nodeId": node_id,
                            "eventId": event_id, "kind": kind, "text": text})

        add(event.get("start_time"), OPENING,
            f"开案：{analysis._clean(event.get('problem')) or '（没写类型）'}")

        if analysis._clean(event.get("priority_time")):
            reason = analysis._clean(event.get("priority_reason")) or "（没写理由）"
            add(event.get("priority_time"), PRIORITY, f"被选为当前重点：{reason}")

        for action in event.get("actions") or []:
            if not isinstance(action, dict):
                continue
            who = analysis._clean(action.get("source")) or "来源未标"
            verdict = "受理" if action.get("accepted") else "没受理"
            note = analysis._clean(action.get("note"))
            add(action.get("time"),
                ACTION,
                f"{analysis._clean(action.get('action'))}（{who}）{verdict}"
                + (f"：{note}" if note else ""))

        for snapshot in event.get("snapshots") or []:
            if not isinstance(snapshot, dict) or snapshot.get("kind") != CAMERA_KIND:
                continue
            when = analysis._clean(snapshot.get("time"))
            stamp = analysis._clean(snapshot.get("stamp"))
            detail = analysis._clean(snapshot.get("file")) or "（没写文件名）"
            if snapshot.get("width") and snapshot.get("height"):
                detail += f" {snapshot['width']}×{snapshot['height']}"
            size = snapshot.get("size")
            if isinstance(size, int) and size:
                detail += f"　{size // 1024} KB"
            # stamp 和 time 不是一回事（events.record_snapshot 里写明了）：
            # time 是 core 收到这条指令的钟，stamp 是前端报的快门时刻。
            # 时间线的时刻取 time —— 它一定在，而且是 core 自己的钟；
            # stamp 不一样就一并写出来，两个都留着的信息不该在报告里丢掉。
            if stamp and stamp != when:
                detail += f"　（快门 {stamp}）"
            add(when or stamp, PHOTO, detail)

        closing = analysis._clean(event.get("recovered_at")) \
            or analysis._clean(event.get("end_time"))
        if closing:
            add(closing, CLOSING,
                f"{event_label(event)}"
                + (f"：{analysis._clean(event.get('result'))}"
                   if analysis._clean(event.get("result")) else ""))

    # 排序：先按时刻（固定格式的字符串排序就是时间排序），同一时刻按
    # 宿舍、案卷、节点类型 —— 三个都参与是为了**每次跑出来的顺序都一样**，
    # 不然同一份输入两次生成的报告会不一致。开案必须排在它自己的结案前面：
    # 一条案子如果开案和结案记的是同一时刻（0 分钟的案子），靠 kind 排。
    kind_order = {OPENING: 0, PRIORITY: 1, ACTION: 2, PHOTO: 3, CLOSING: 4}
    entries.sort(key=lambda item: (item["time"], item["nodeId"], item["eventId"],
                                   kind_order.get(item["kind"], 9), item["text"]))
    return entries


def disjoint_span(summary, entries: list[dict]) -> str | None:
    """CSV 和事件文件的时间范围**完全不重叠**时，返回一句要人看的话；否则 None。

    只要是「没重叠」就说，不判断哪种情况更可疑：报告没法知道你是故意拿两份
    数据做对比，还是指错了文件。它只知道这两个时间范围凑不到一起。
    """
    if summary is None or not entries:
        return None
    csv_first = summary.get("time_first") or ""
    csv_last = summary.get("time_last") or ""
    ev_first = min(item["time"] for item in entries)
    ev_last = max(item["time"] for item in entries)
    if not csv_first or not csv_last:
        return None
    # 两段区间不相交 = 一段的末尾在另一段的开头之前。时刻是固定的
    # "YYYY-MM-DD HH:MM:SS"，按字符串比就是按时间比。
    if csv_last < ev_first or ev_last < csv_first:
        return (f"注意：上面那份 CSV 记的是 {csv_first} ~ {csv_last}，"
                f"这个事件文件里的是 {ev_first} ~ {ev_last} —— 两段不重叠，"
                f"多半不是同一场。报告照样出，但别把这两半当成一件事读"
                f"（做对照演示时可以这么配，验收复现时就不是了）。")
    return None


def timeline_section(data, reason, summary=None) -> dict:
    """「事件时间线」区块。读不了 events.json 时降级成一句话。"""
    if data is None:
        return {
            "title": "事件时间线",
            "html": (f'<p class="empty">这一段没出：{analysis._esc(reason)}</p>\n'
                     f'<p class="note">事件那一半（开案 / 处理 / 恢复）来自'
                     f"core 的事件簿，和上面那份 CSV 是两条线 —— "
                     f"它读不到不影响统计和趋势。</p>"),
        }

    entries = timeline_entries(data)
    tally = data.get("summary") if isinstance(data.get("summary"), dict) else {}
    total = tally.get("total", len(data["events"]))
    counts = "、".join(
        f"{state} {tally[state]}" for state in ("OPEN", "HANDLING", "RECOVERED",
                                                "UNRESOLVED")
        if tally.get(state))
    dropped = data.get("dropped") or 0

    body = [
        f'<p class="note">{analysis._esc(str(total))} 条案卷'
        + (f"（{analysis._esc(counts)}）" if counts else "")
        + (f"，另有 {analysis._esc(str(dropped))} 条被上限挤掉" if dropped else "")
        + f"，摊成 {len(entries)} 个时间点。"
          f"「节点」那一列说的是这一行是什么："
          f"{OPENING} / {PRIORITY} / {ACTION} / {PHOTO} / {CLOSING}。</p>",
        '<p class="note">快照只列 <code>kind == "camera"</code> 的那些。'
        "同一条案卷的 snapshots 里还混着<strong>状态迁移</strong>的记录（开案、恢复…），"
        "它们没有 kind 这个键 —— 不筛的话，一次开案会被读成「拍了一张照片」。</p>",
    ]

    # 这两半是不是同一场？CSV 是「读数」，events.json 是「案子」，分别由 core 写、
    # 又是两个文件 —— 拿一份昨天的 CSV 配一份今天的 events.json，报告照样出得来，
    # 而且看着毫无异样。所以时间范围对不上时明说一句：这不是报错（做对比演示时
    # 本来就可能这么配），但读的人有权知道他看的是一场还是两场。
    mismatch = disjoint_span(summary, entries)
    if mismatch:
        body.append(f'<p class="warn">{analysis._esc(mismatch)}</p>')

    if not entries:
        body.append('<p class="empty">这份事件文件里一个时间点都没有。</p>')
        return {"title": "事件时间线", "html": "\n".join(body)}

    shown = entries[:TIMELINE_MAX]
    rows = [[item["time"], item["nodeId"] or "—", item["eventId"] or "—",
             item["kind"], item["text"]] for item in shown]
    # 这一张表**不高亮任何行**。报告里那个高亮色（tr.mismatch）在别处专门表示
    # 「两种口径说法不一致，要人多看一眼」；拿它去标「这一行是结案」的话，
    # 读者按颜色扫下来会把正常的结案当成出了岔子。类型的区别由「节点」那一列
    # 的文字承担 —— 颜色不单独承载信息，本来也是这张表该守的规矩。
    body.append(analysis._html_table(TIMELINE_HEADER, rows))
    if len(entries) > len(shown):
        body.append(f'<p class="note">表里只画了前 {len(shown)} 个时间点'
                    f"（还有 {len(entries) - len(shown)} 个没画）——"
                    f"完整的过程在 data/events.json 里，那份不受这个上限影响。</p>")
    return {"title": "事件时间线", "html": "\n".join(body)}


# ======================================================================
# 五、Rule-ML 对比
# ======================================================================

ML_TITLE = "Rule-ML 对比"

# 这一段的列。左边三列是「这条读数是什么」，中间是规则的说法，右边是 ML 的说法。
ML_HEADER = ["宿舍", "时间", "温度 ℃", "湿度 %", "固定规则", "CSV 里的 ml_label", "一致"]

# 「这一行的 ml_label 说它正常」的判据。只认字符串层面的「同不同」会让
# normal / 正常 / NORMAL 变成三种答案，所以先折叠大小写，再对这几个词。
# 写成常量是因为它有两处用处：出这张表、以及复核 CSV 里的 agree。
ML_NORMAL_WORDS = ("normal", "正常", "ok")

# ml_label 有行空着时那句话。**「没判」和「判成正常」在这一块里必须能分开**，
# 这两句话存在的理由就是这个。
ML_WHY_TEXT = (
    "空着的那些行表示<strong>这一条没判过 ML</strong>，不是判成正常："
    "这个宿舍没有模型（可用历史条数不够、没跑过 analysis/train_iforest.py）、"
    "core 里没装 scikit-learn、或者这条读数缺温湿度 —— 这三种都写不出判词。"
    "另一条链 analysis/ml.py 是<strong>离线</strong>的，跑完写 report/ml_result.json，"
    "不回填这份 CSV；两条链跑的是同一种模型、同一套参数，判决口径也一样。"
)

# 「列在、但整列空着」和「压根没有这一列」是两种情况，说法要分开：
# 一份没有 ml_label 列的 CSV，报告第一句说「CSV 里没有 ml_label 列」，
# 第二句又说「这一列整列都是空的」——两句自己打自己。
ML_EMPTY_TEXT = "CSV 的 ml_label 一列整列都是空的，所以这一段现在没有可比的东西。" + ML_WHY_TEXT

ML_ABSENT_TEXT = ("这份 CSV 里连 ml_label 这一列都没有"
                  "（Phase7 之前的手写样本就是这样），所以这一段没有可比的东西。"
                  "core 写的那份 data/history.csv 从 Phase8 D5 起一直带着 "
                  "ml_label 和 agree 两列。")


def ml_section(df) -> dict:
    """「Rule-ML 对比」区块。返回 sections 里的一项。

    两种走法：
      * CSV 有 ml_label 列、而且至少有一行有值 -> 出对照表，
        两边判断不同的行高亮（和 analysis.py 的 ML 区块同一个色），
        再对 CSV 里的 agree 做一次复核。
      * 那一列不在、或者整列是空的 -> 出说明那句话，讲清为什么没有。

    【这一列的值不是本脚本算的】报告只负责把 CSV 里那两列摆在一起对照。
    把规则重算的结果复制到 ml_label 那一列去假装「ML 也这么判」，
    是这份报告里最容易做、也最不该做的事。
    """
    body = ['<p class="note">两种口径回答的不是同一个问题：<strong>固定规则</strong>'
            "看的是提前写好的三条阈值；<strong>ML</strong> 看的是「和这个宿舍平时"
            "像不像」。对不上不是谁错了 —— 所以这张表只摆事实，不下结论。</p>"]

    if "ml_label" not in df.columns:
        body.append('<p class="empty">报告的输入可以只有「时间 / 温湿度 / 状态」这几列'
                    "（Phase7 之前的手写样本就是这样），这条链不会因为少一列就走不动。"
                    "这一段是给<strong>带了 ml_label 的 CSV</strong> 留的位子。</p>")
        body.append(f'<p class="note">{analysis._esc(ML_ABSENT_TEXT)}</p>')
        return {"title": ML_TITLE, "html": "\n".join(body)}

    labels = [analysis._clean(value) for value in df["ml_label"]]
    filled = [label for label in labels if label]
    if not filled:
        body.append(f'<p class="empty">{analysis._esc(ML_EMPTY_TEXT)}</p>')
        return {"title": ML_TITLE, "html": "\n".join(body)}

    body.append(
        f'<p class="note">这一列的值<strong>来自 CSV</strong>，不是本脚本算的：'
        f"报告只把「规则重算的结果」和「CSV 里写的 ml_label」摆在一起对照。"
        f"共 {len(filled)} 行有 ml_label（还有 {len(labels) - len(filled)} 行空着，"
        f"空着不等于判成正常）。</p>")

    column = node_column(df)
    rows, marks = [], []
    for index, row in enumerate(df.itertuples()):
        rule_status = analysis._clean(row.rule_status)
        label = labels[index]
        if not label:
            continue
        rule_normal = rule_status == rules.STATUS_NORMAL
        # 一致的判据：ml_label 说「正常」而规则也说正常，或者两边都在说「不正常」。
        # 折叠大小写那一步在 ML_NORMAL_WORDS 那里（复核 agree 用的是同一个判据）。
        ml_normal = label.lower() in ML_NORMAL_WORDS
        rows.append([
            (analysis._clean(getattr(row, column)) or "—") if column else "—",
            analysis._clean(row.time), analysis._num(row.temperature),
            analysis._num(row.humidity), rule_status or "（空）", label,
            "是" if rule_normal == ml_normal else "不是",
        ])
        marks.append("" if rule_normal == ml_normal else analysis.MISMATCH_CLASS)

    body.append(analysis._html_table(ML_HEADER, rows, right=(2, 3),
                                     row_classes=marks))
    body.append('<p class="note">高亮的判据是<strong>两种口径对「正常 / 不正常」的'
                "判断不同</strong>，两个方向都算：规则说正常而 ML 说不同，和反过来"
                "那一种。只高亮前一种的话，后一种在表里看着和「两边都同意」"
                "一模一样。</p>")

    # CSV 第 10 列 agree 的复核。这一列是**派生值**（规则正常 == ML 正常），
    # 项目里对派生值一向是重算一遍核对（status 有 analysis.find_mismatches），
    # 这一列照同一个先例办。手改一格在这里会亮，而那一格本身在表里看不出异样
    # —— 上面那张表的「一致」列是按 ml_label 现算的，不读 CSV 那一格。
    check = agree_check(df, labels)
    if check["bad"]:
        shown = check["bad"][:8]
        more = "" if len(check["bad"]) <= len(shown) else f"，还有 {len(check['bad']) - len(shown)} 行"
        body.append(f'<p class="warn">CSV 的 agree 一列有 {len(check["bad"])} 行'
                    "和「规则 + ml_label 现算」的结果对不上："
                    + analysis._esc("；".join(shown) + more)
                    + "。这一列是派生值，对不上只有两种可能：那一格被人改过，"
                      "或者写它的时候用的判据和这份报告不一样。</p>")
    elif check["rows"]:
        body.append(f'<p class="note">CSV 的 agree 一列有 {check["rows"]} 行有值，'
                    "逐行和「规则 + ml_label 现算」的结果核对过，全部对得上。</p>")
    return {"title": ML_TITLE, "html": "\n".join(body)}


def agree_check(df, labels: list[str]) -> dict:
    """CSV 里 agree 那一列，和「规则 + ml_label 现算」的结果逐行比一遍。

    返回 {"rows": 有 agree 的行数, "bad": [对不上的行的说明]}。

    agree 在 CSV 里的两个词是 yes / no（history.py 的 AGREE_YES / AGREE_NO）。
    这里**不 import history.py**：analysis/ 这一层连 config.py 都不依赖
    （理由见文件头），为了两个词把 core 那一侧的模块拖进来不划算；
    两个词在这里各写一次，写错了上面那张表的复核会立刻亮。
    """
    if "agree" not in df.columns:
        return {"rows": 0, "bad": []}

    bad: list[str] = []
    filled = 0
    for index, row in enumerate(df.itertuples()):
        written = analysis._clean(getattr(row, "agree")).lower()
        if not written:
            # 没判的行本来就该空着（ml_label 空 ⟹ agree 空），不参与核对。
            continue
        filled += 1
        label = labels[index]
        if not label:
            bad.append(f"第 {index + 1} 行有 agree 却没有 ml_label")
            continue
        want = _agree_text(
            analysis._clean(row.rule_status) == rules.STATUS_NORMAL,
            label.lower() in ML_NORMAL_WORDS,
        )
        if written != want:
            bad.append(f"第 {index + 1} 行写的是 {written}、该是 {want}")
    return {"rows": filled, "bad": bad}


def _agree_text(rule_normal: bool, ml_normal: bool) -> str:
    """两条判据是不是同一个结论 -> CSV 里那个词。

    只在这一处把「是不是」翻成 yes / no（和 history.py 的 _agree_cell 是同一套
    词，那边管写、这边管核）。两处都各自写死两个词，是有意的：
    复核的价值就在于它**不共用**被复核那段代码的常量 ——
    共用的话，「词表改了」这种错两边会一起改，复核永远说对得上。
    """
    return "yes" if rule_normal == ml_normal else "no"


# ======================================================================
# 六、案例分析：规则和 ML 为什么不一样
# ======================================================================

CASE_TITLE = "案例分析：规则和 ML 为什么不一样"

# 这一段的列。最后两列是这张表存在的理由：方向说清是哪一种不一样，
# 历史区间让「这条落在平时那个范围里没有」一眼可见 —— 没有最后一列，
# 「ML 为什么这么说」就只剩一句断言。
CASE_HEADER = ["宿舍", "时间", "温度 ℃", "湿度 %", "固定规则", "ML", "方向", "该宿舍历史区间"]

# 两个方向分开写，而不是笼统一句「不一致」：这两件事要去查的地方根本不同。
CASE_FORWARD = "规则正常 / ML 说不像"
CASE_REVERSE = "规则异常 / ML 说像"


def is_constructed(value) -> bool:
    """source 这一格算不算「构造样本」。

    判据和 analysis/train_iforest.py 跳过训练的那个是**同一张表**
    （SOURCE_KINDS + CONSTRUCTED_KIND 都在本文件里），所以报告里说的
    「构造样本」和训练时被跳过的那一批永远是同一批 —— 两处各列一遍的话，
    以后加一个 token 会有一边悄悄漏掉，而且不报错。
    """
    raw = analysis._clean(value)
    if not raw:
        return False
    return SOURCE_KINDS.get(raw.lower()) == CONSTRUCTED_KIND


def history_ranges(df, skip_constructed: bool = True) -> dict:
    """每个宿舍「平时」的温湿度区间：{节点: [t_min, t_max, h_min, h_max, 条数]}。

    默认**跳过构造样本**：它们是专门造出来扎在区间外的，算进去会把区间自己撑大
    —— 而这张表要说的正是「这条越没越界」，区间被撑大就什么都看不出来了。

    缺温湿度的那几行不参与（缺一个就算不出一个二维的点）。
    区间取的是历史里的**真的极值**，不是分位数：这一步不做统计推断
    （题目给的边界：不做划分、不调参），只把「历史里出现过的范围」如实摆出来。
    """
    column = node_column(df)
    out: dict[str, list] = {}
    for row in df.itertuples():
        if skip_constructed and is_constructed(getattr(row, "source", None)):
            continue
        temperature = analysis._number(row.temperature)
        humidity = analysis._number(row.humidity)
        if temperature is None or humidity is None:
            continue
        node = (analysis._clean(getattr(row, column)) or NO_NODE) if column else NO_NODE
        box = out.get(node)
        if box is None:
            out[node] = [temperature, temperature, humidity, humidity, 1]
            continue
        box[0] = min(box[0], temperature)
        box[1] = max(box[1], temperature)
        box[2] = min(box[2], humidity)
        box[3] = max(box[3], humidity)
        box[4] += 1
    return out


def _range_text(box) -> str:
    """历史区间 -> 「24–31 ℃ / 58–80 %」；没有可参照的历史时如实说一句。"""
    if box is None:
        return "（这个宿舍没有可参照的历史）"
    return (f"{analysis._num(box[0])}–{analysis._num(box[1])} ℃ / "
            f"{analysis._num(box[2])}–{analysis._num(box[3])} %")


def case_rows(df, labels: list[str]) -> list[dict]:
    """两边判得不一样的那些行。

    两条判据都在这里**现算**，不看 CSV 里的 agree（那一列由 agree_check 单独核）。
    「有没有判词」也现看：没判的行没有「两边」可比，直接跳过。
    """
    column = node_column(df)
    out: list[dict] = []
    for index, row in enumerate(df.itertuples()):
        label = labels[index]
        if not label:
            continue
        rule_status = analysis._clean(row.rule_status)
        rule_normal = rule_status == rules.STATUS_NORMAL
        ml_normal = label.lower() in ML_NORMAL_WORDS
        if rule_normal == ml_normal:
            continue
        out.append({
            "node": (analysis._clean(getattr(row, column)) or NO_NODE) if column else NO_NODE,
            "time": analysis._clean(row.time),
            "temperature": analysis._num(analysis._number(row.temperature)),
            "humidity": analysis._num(analysis._number(row.humidity)),
            "rule_status": rule_status or "（空）",
            "label": label,
            "forward": rule_normal,
        })
    return out


def _ranges_block(ranges: dict) -> str:
    """每个宿舍的历史区间摆成一张表。没有差异行时，它就是这一块的全部内容。"""
    if not ranges:
        return ('<p class="note">这份 CSV 里没有可用作参照的历史读数'
                "（温湿度齐全、而且不是构造样本的行）。</p>")
    rows = [[node, analysis._num(box[4]), _range_text(box)]
            for node, box in sorted(ranges.items())]
    return ('<p class="note">下面是每个宿舍<strong>非构造样本</strong>的温湿度范围'
            "—— 就是规则和 ML 各自要对照的那个「历史」：</p>"
            + analysis._html_table(["宿舍", "参照条数", "温湿度区间"], rows, right=(1,)))


def case_section(df) -> dict:
    """「案例分析」区块：把两边判得不一样的行挑出来，逐个说清差在哪。

    【这一块里没有一个数字是手写的】「可能的原因」不能编。这里能给出的只有两样
    事实：规则判的是「越没越线」（阈值取 analysis.rules，报告里不写死数字），
    ML 判的是「像不像这个宿舍平时」（拿这个宿舍非构造样本的温湿度区间做参照）。
    所以每一行都带上「该宿舍历史区间」，读的人自己就能看出这条落在区间内还是外。

    一条都对不上时**如实说**，不硬凑一个案例出来 —— 「没对照过」和「对照完没差别」
    是两件事（ml.NO_ROWS_TEXT 也是这个口径）。
    """
    labels = ([analysis._clean(value) for value in df["ml_label"]]
              if "ml_label" in df.columns else [""] * len(df))
    filled = [label for label in labels if label]
    ranges = history_ranges(df)

    body = [
        '<p class="note">两条判据回答的不是同一个问题：<strong>固定规则</strong>'
        f"是三条提前写好的线（温度 &lt; {rules.TEMP_LOW} ℃ 算偏冷、"
        f"≥ {rules.TEMP_HIGH} ℃ 算偏热、湿度 ≥ {rules.HUMIDITY_HIGH} % 算偏湿，"
        "按这个顺序先到先判），<strong>ML</strong> 是「这条读数和这个宿舍平时那些"
        "像不像」（IsolationForest 在温度、湿度这两维上切）。规则看的是"
        "<strong>越没越线</strong>，ML 看的是<strong>像不像它自己</strong> —— "
        "两件事本来就不必一致，不一致也不说明谁错了。</p>",
    ]

    if not filled:
        body.append('<p class="empty">这份 CSV 里一行 ml_label 都没有：要么 core 当时'
                    "还没有这个宿舍的模型，要么这份 CSV 根本不是 core 写的。"
                    "没有判词就没有「两边不一样」这回事，这个板块此刻说不出别的。</p>")
        body.append(_ranges_block(ranges))
        return {"title": CASE_TITLE, "html": "\n".join(body)}

    rows = case_rows(df, labels)
    if not rows:
        body.append(f'<p class="empty">这次 {len(filled)} 行有 ML 判词，'
                    "其中<strong>没有任何一条两边判得不一样</strong>。"
                    "这不是漏做：构造样本回放之前，模拟器发的读数大部分同时落在"
                    "规则阈值和历史范围之内，两种判据当然会同意。要复现差异，"
                    "跑一次 <code>py -3.14 simulator/replay_samples.py "
                    "--file data/constructed_samples.json</code>。</p>")
        body.append(_ranges_block(ranges))
        return {"title": CASE_TITLE, "html": "\n".join(body)}

    forward = sum(1 for row in rows if row["forward"])
    reverse = len(rows) - forward
    body.append(
        f"<p>这次 {len(filled)} 行有 ML 判词，其中 <strong>{len(rows)} 行两边不一样</strong>："
        f"{CASE_FORWARD} {forward} 行、{CASE_REVERSE} {reverse} 行。"
        "最后一列是<strong>这个宿舍非构造样本</strong>的温湿度范围 —— "
        "「这条落在历史范围里还是外」，对着它看就有答案了。</p>")

    table_rows = []
    for row in rows:
        table_rows.append([
            row["node"], row["time"], row["temperature"], row["humidity"],
            row["rule_status"], row["label"],
            CASE_FORWARD if row["forward"] else CASE_REVERSE,
            _range_text(ranges.get(row["node"])),
        ])
    # 这张表不高亮任何行：高亮在这个报告里一贯表示「两种口径说法不同」，
    # 而这里**每一行**都是那种行，标了等于没标。两个方向由「方向」那列分开。
    body.append(analysis._html_table(CASE_HEADER, table_rows, right=(2, 3)))
    body.append(
        '<p class="note">这张表整张都是「两边不一样」的行，所以没有再用高亮。'
        "方向上能说的只有一句："
        f"<strong>{CASE_FORWARD}</strong>的多半是这个宿舍的历史样本太单一"
        "（平时读数挤在一小块地方，稍微偏一点就出界），"
        f"<strong>{CASE_REVERSE}</strong>的多半是这个宿舍平时就贴着阈值"
        "（规则按线判它越界，可这种读数在它自己的历史里其实很常见）。"
        "这只是这张表能推出来的解释，是不是这两句，对着最后一列看就知道 ——"
        "每一行的具体数字都在表里，没有一处是报告替读的人下的结论。</p>")
    return {"title": CASE_TITLE, "html": "\n".join(body)}


# ======================================================================
# 拼一份报告
# ======================================================================

# 报告标题。和 analysis.py 那份（REPORT_TITLE）**故意不一样**：两份报告摆在一起时，
# 得一眼看出手上这份是哪条链出来的。
#
# `{csv}` 那一格填的是**这一份报告真正读的那个文件**，不写死 "history.csv"：
# 「换一份 --csv 就整篇重来」正是这个脚本的全部意义，标题要是还印着 history.csv，
# 那第二、第三份报告就在说一件没发生的事 —— data/day_sim.csv 是 make_sim_data.py
# 生成的，它根本没经过 core。填的是 report_title() 算出来的那一份。
PHASE7_TITLE = "DormMate 离线分析报告（Phase7：{csv} → 本报告）"


def report_title(summary: dict) -> str:
    """这一份报告的标题 —— 文件名那一格取自 summary（和页头「数据来源」同一个口径）。

    只放文件名、不放路径：报告是拷来拷去的，一条本机路径留在标题里没有意义。

    名字要过一遍 `_esc`：`dormmate (2).csv` 没事，但一个带 & 的文件名会把
    `<title>` 和 `<h1>` 弄坏 —— 这个标题是**直接拼进 HTML** 的。
    """
    path = summary.get("file")
    name = Path(path).name if path else "（未指定）"
    return PHASE7_TITLE.format(csv=analysis._esc(name))


def built_sections(df, events_data, events_reason, stats, summary) -> list[dict]:
    """除「摘要 / 需要关注」那几块之外的区块，按报告里的顺序排。

    顺序上有一条讲究：**数据来源紧跟标题**。它限定了后面所有数字的读法 ——
    一份构造样本跑出来的状态分布，和一份现场跑了一下午的，含义完全不同。
    """
    return [
        source_section(df),
        node_stats_section(stats, len(df)),
        trend_section(df),
        timeline_section(events_data, events_reason, summary),
        daily_summary_section(df),
        ml_section(df),
        # 「表 → 释」：先给对照表（两边各判了什么），再逐条拆为什么不一样。
        # 反过来的话，读的人先看到一堆解释，不知道那些话在说哪几行。
        case_section(df),
    ]


def daily_summary_section(df) -> dict:
    """「今日摘要」区块。复用 analysis.py 那一块，一份实现两处用。

    数据没有 nodeId 列时 summarize_frame() 会返回一句「这份数据没法按宿舍分开」，
    区块照样出、说的是一句实话（analysis.py 对这一天也是这么处理的）。
    """
    return analysis.daily_summary_section(daily_summary.summarize_frame(df))


def build_report(df, summary, events_data, events_reason,
                 generated_at: str | None = None) -> str:
    """把手上这些东西拼成一份完整的 HTML。**所有数字都从 df / summary 来。**

    analysis.py 的 build_report() 这里用不了：那个函数里有一块 `_trend_block`，
    它写的是 `<img src="trend.png">`（旁边那个文件）。Phase7 要单文件，
    所以趋势图那一块在这里换成 base64 内嵌的版本，其余区块照旧复用。
    """
    stamp = generated_at or datetime.now().strftime(STAMP)
    stats = node_stats(df)

    blocks = [
        analysis._header_block(summary, stamp),
        analysis._mismatch_note(summary),
        analysis._summary_block(summary),
        *[analysis._section_block(item)
          for item in built_sections(df, events_data, events_reason, stats, summary)],
        # 「需要关注的记录」排在最后：它可能很长（几百行），放前面会把
        # 「几个宿舍、各自什么情况」那几块挤到屏幕外面去。
        analysis._attention_block(summary),
    ]
    document = analysis._document("\n".join(block for block in blocks if block))

    # 换标题。_document() 把它同时写在 <title> 和 <h1> 里（一个给标签页、
    # 一个给纸面），analysis.py 那边没有留参数，所以在这里整份替换一次 ——
    # 一处改、两处都跟着变。标题里那个文件名已经过 _esc（见 report_title），
    # 所以按字面替换是安全的；替换数不为 2 说明 analysis.py 那边的标题用法
    # 变了形状，当场报出来，不要交一份标题半新半旧的报告。
    title = report_title(summary)
    replaced = document.count(analysis.REPORT_TITLE)
    if replaced != 2:
        raise SystemExit(f"报告标题出现在 {replaced} 处（预期 2 处：<title> 和 <h1>）"
                         f"—— analysis.py 里的 REPORT_TITLE 用法变了，这里的替换要跟着改")
    return document.replace(analysis.REPORT_TITLE, title)


def write_report(df, summary, events_data, events_reason, out_path: Path,
                 generated_at: str | None = None) -> Path:
    """渲染并写文件。编码 UTF-8、**不带 BOM**、换行 LF（同 analysis.write_report）。"""
    text = build_report(df, summary, events_data, events_reason, generated_at)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(text, encoding="utf-8", newline="\n")
    return out_path


# ======================================================================
# 入口
# ======================================================================

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="DormMate Phase7：读历史 CSV 和事件 JSON，出一份单文件 HTML 报告",
    )
    parser.add_argument("--csv", default=str(DEFAULT_CSV),
                        help=f"输入 CSV，相对路径按项目根解析（默认 {DEFAULT_CSV}）")
    parser.add_argument("--events", default=str(DEFAULT_EVENTS),
                        help=f"事件 JSON，同上（默认 {DEFAULT_EVENTS}）")
    parser.add_argument("--out", default=str(DEFAULT_OUT),
                        help=f"报告写到哪，同上（默认 {DEFAULT_OUT}）")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    csv_path = analysis.resolve_csv(args.csv)
    events_path = analysis.resolve_csv(args.events)
    out_path = analysis.resolve_csv(args.out)

    if not csv_path.exists():
        # analysis.load() 遇到缺文件时给的那句提示是给网页导出的 CSV 写的
        # （「去网页上点导出」）。这条链的 CSV 是 core 自己写的，提示得换一句，
        # 不然照着那句做会白忙一场。
        raise SystemExit(
            f"找不到 CSV：{csv_path}\n"
            f"这一条链的输入是 core 写的那份历史表。先让 core 收几条遥测：\n"
            f"    start_broker.bat\n"
            f"    py -3.14 core.py\n"
            f"    py -3.14 simulator/simulator.py --all-nodes\n"
            f"（或者用 --csv 指到别的 CSV，比如 data/day_sim.csv）"
        )

    df = analysis.add_rule_status(analysis.load(csv_path))
    # verbose=False：终端那几张表由本脚本自己按 Phase7 要的那几项打，
    # 不要 analysis.py 再刷一份（两份数字一样，但看的人会以为是两件事）。
    summary = analysis.summarize(df, csv_path, verbose=False)
    events_data, events_reason = load_events(events_path)

    write_report(df, summary, events_data, events_reason, out_path)

    stats = node_stats(df)
    print(f"读入：{csv_path}")
    print(f"  {len(df)} 条记录，"
          f"{len(stats)} 组（{'、'.join(item['nodeId'] for item in stats)}），"
          f"时间范围 {analysis.format_range(summary)}")
    for item in stats:
        print(f"  {item['nodeId']}：温度 {analysis._num(item['temp_min'])} ~ "
              f"{analysis._num(item['temp_max'])} ℃（平均 "
              f"{analysis._num(item['temp_avg'])}），湿度 "
              f"{analysis._num(item['humidity_min'])} ~ "
              f"{analysis._num(item['humidity_max'])} %（平均 "
              f"{analysis._num(item['humidity_avg'])}），异常 {item['abnormal']} 条")
    print(f"  数据来源：{source_breakdown(df)['text']}")
    if events_data is None:
        print(f"事件：没读到 —— {events_reason}")
    else:
        print(f"事件：{events_path}　"
              f"{len(events_data['events'])} 条案卷，"
              f"{len(timeline_entries(events_data))} 个时间点")
    print(f"报告已写入：{out_path}（{out_path.stat().st_size // 1024} KB，单文件）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
