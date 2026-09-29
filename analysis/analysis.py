"""DormMate 数据分析 —— Step 2-2 读取统计 / Step 2-3 规则复核 + 状态统计 /
Step 2-4 趋势图 / Step 2-5 HTML 报告。

运行（在项目根下、或任何别的目录下都行）：

    py -3.14 analysis/analysis.py
    py -3.14 analysis/analysis.py data/dormmate.csv
    py -3.14 analysis/analysis.py --no-plot        # 不画 trend.png
    py -3.14 analysis/analysis.py --no-report      # 不出 report.html

输入就是网页上「导出 CSV」那个文件：表头 time,temperature,humidity,status，
带 UTF-8 BOM。把下载到的 dormmate.csv 放进 data/ 目录即可。

Step 2-3 干的事：不信 CSV 里的 status，每行都用 rules.judge_status 重算一遍存进
rule_status；两边对不上就打警告（说明 Web 和 Python 的规则不同步了）；再统计每种
状态的数量、列出所有不是「正常」的记录，最后整理成一个 summary 字典给生成报告用。

Step 2-4 干的事：把温度和湿度随时间的变化画成折线图，存到 report/trend.png。
温度走左轴、湿度走右轴（两个量单位不一样，共用一根轴会互相挤扁），并把统一规则
的三条阈值（18 ℃ / 30 ℃ / 75 %）画成虚线，一眼能看出哪几段越了界。

Step 2-5 干的事：把 summary 和趋势图拼成一份 report/report.html，用浏览器就能看。
报告里的数字全部来自 summary（也就是全来自这次算出来的数据），一个都不写死。
后面要加的「事件复盘」「ML 异常分析」按 sections 参数往里塞，见 build_report()。

Step 8-2 干的事：报告末尾加一块「今日摘要」——按宿舍把这一天里的连续异常段
说成人话（「dorm-b 14:10 起持续偏热 40 分钟后恢复」）。分段算法在
analysis/daily_summary.py，报告这边只负责把算好的那段话和事件明细摆进 HTML。
摘要用的 df 就是手上这一份（已经 add_rule_status 过），不另读一次文件 ——
同一份报告上下两截说的必须是同一份数据。

用 py -3.14 而不是 python：PATH 上的 python 是 32 位解释器，
pandas 和 matplotlib 都不发布 32 位 Windows 包，装不上。64 位那个两个都装好了。
"""

from __future__ import annotations

import argparse
import html
import math
import sys
import unicodedata
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

# 项目根 = 本文件的上一级。用 __file__ 推导，不靠当前工作目录 ——
# 这样在哪个目录下敲这条命令，都能定位到 data/dormmate.csv。
ROOT = Path(__file__).resolve().parent.parent

# 把项目根放进 sys.path 才能 import 到 analysis 包和根目录的 status_rules。
# 直接 `py -3.14 analysis/analysis.py` 跑的时候，sys.path[0] 是 analysis/ 而不是
# 项目根；不补这一下，"from analysis import rules" 会 ModuleNotFoundError。
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from analysis import daily_summary, rules  # noqa: E402  —— 必须在上面调整完 sys.path 之后

DEFAULT_CSV = ROOT / "data" / "dormmate.csv"

# Step 8-2 的「模拟日数据」：由 analysis/make_sim_data.py 生成，带 nodeId 列，
# 一天三个宿舍。它是演示「今日摘要」用的那份输入。
DEFAULT_SIM = ROOT / "data" / "day_sim.csv"

# time 列的统一格式（网页 formatTime() 写出来的就是这个）。
# 画图时要把这串文本 parse 回 datetime 才能放到横轴上：strptime 给死格式，
# 比 dateutil 那种"猜"要稳 —— 猜错了会把 09-22 当成 22 月，或者悄悄换成今天。
TIME_FORMAT = "%Y-%m-%d %H:%M:%S"

# 导出的 CSV 必须有的列，缺了就是文件不对，别让它一路 KeyError 下去
REQUIRED_COLUMNS = ["time", "temperature", "humidity", "status"]

# 状态统计的固定顺序：按统一规则的判断顺序排（先判的先列）。
# 不用出现次数排序 —— 报告每次跑出来的行序要一样，才好前后对比。
STATUS_ORDER = [
    rules.STATUS_COLD,
    rules.STATUS_HOT,
    rules.STATUS_HUMID,
    rules.STATUS_NORMAL,
]

# rule_status 等于它的都算「不用关注」，其余全进关注列表
NORMAL = rules.STATUS_NORMAL

# 温湿度单元格是空的时候 pandas 读成 NaN，而 NaN 和任何数比大小都是 False ——
# 直接丢给规则会被一路走到最后判成「正常」。报告里出现这种假数据最要命，
# 所以缺失单独标出来，让它同时出现在状态统计和关注列表里。
#
# 值的本尊在 analysis/daily_summary.py：分段的算法要知道「哪种值算没有可用数据」
# 才能跳过它，算法在哪家、常量就放哪家。这里指过去，全项目仍然只有一份定义。
MISSING = daily_summary.MISSING

# 表格最多打印多少行。截断的只是打印，summary 里永远是完整的。
MAX_PRINT = 20

# Windows 中文控制台常见的是 GBK。这里会打印 CSV 里的任意内容
# （包括 status 的中文），编码兜不住时降级成替换字符，别让脚本崩在 print 上。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="replace", line_buffering=True)


# ---------------------------------------------------------------- 打印小工具

def _width(text: str) -> int:
    """字符串的显示宽度：中文/全角按 2 列算，其余按 1 列。"""
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)


def _pad(text: str, width: int) -> str:
    """左对齐补空格到指定显示宽度。

    不能直接用 str.ljust：它数的是字符个数，中文也算 1 个，
    补出来的表格在终端里是歪的。
    """
    return text + " " * max(0, width - _width(text))


def _rpad(text: str, width: int) -> str:
    """右对齐 —— 数字列用这个，位数不同也对得齐。"""
    return " " * max(0, width - _width(text)) + text


def _widths(rows: list[list[str]]) -> list[int]:
    """每列取最宽的那个单元格作为列宽。"""
    return [max(_width(str(row[i])) for row in rows) for i in range(len(rows[0]))]


def _table(rows: list[list[str]], right: tuple[int, ...] = ()) -> None:
    """打印一张表：rows[0] 当表头，第二行起是数据；right 里的列右对齐。"""
    widths = _widths(rows)
    for index, row in enumerate(rows):
        cells = [
            _rpad(str(cell), width) if column in right else _pad(str(cell), width)
            for column, (cell, width) in enumerate(zip(row, widths))
        ]
        print("  " + "  ".join(cells).rstrip())
        if index == 0:
            print("  " + "  ".join("-" * width for width in widths))


def _clean(value) -> str:
    """单元格转成干净字符串。空单元格是 NaN，别让它变成字面的 "nan"。"""
    if pd.isna(value):
        return ""
    return str(value).strip()


def _number(value):
    """转成 python 的 float；缺失返回 None。

    numpy 的 int64/float64 不是 JSON 能直接序列化的类型，后面要拿 summary
    生成报告，在这里先转成内置类型。NaN 也不能留着 —— json.dumps 会吐出
    非法的 `NaN` 字面量。
    """
    return None if pd.isna(value) else float(value)


def _num(value) -> str:
    """:g 让 31.0 打成 31、25.5 保持 25.5；缺失打成 —。"""
    return "—" if value is None else f"{value:g}"


def format_percent(part: int, whole: int) -> str:
    """占比，一位小数。没有记录时给「—」—— 除零会算出 nan，写进报告就成了 nan%。

    放在这里是为了只有一份：Markdown 报告（analysis/report.py）和 HTML 报告
    都调它，不然两边一个 25.0% 一个 25.00%，同一份数据两个说法。
    """
    if whole <= 0:
        return "—"
    return f"{part / whole * 100:.1f}%"


def format_range(summary: dict) -> str:
    """数据的时间范围，给报告抬头用。同样只有一份，两个报告共用。"""
    first, last = summary.get("time_first", ""), summary.get("time_last", "")
    if not first and not last:
        return "（没有记录）"
    if first == last:
        return first
    return f"{first} ~ {last}"


def _row_dict(row) -> dict:
    """一行 -> JSON 友好的 dict（time / temperature / humidity / status / rule_status）。"""
    return {
        "time": _clean(row.time),
        "temperature": _number(row.temperature),
        "humidity": _number(row.humidity),
        "status": _clean(row.status),
        "rule_status": _clean(row.rule_status),
    }


# ---------------------------------------------------------------- 读文件

def resolve_csv(raw: str) -> Path:
    """把命令行的文件参数变成绝对路径。

    相对路径按【项目根】展开，不是按当前工作目录 —— 这样
    `py -3.14 analysis/analysis.py data/dormmate.csv` 在哪个目录下敲都一样。
    绝对路径原样使用。
    """
    path = Path(raw).expanduser()
    return path if path.is_absolute() else ROOT / path


def load(csv_path: Path) -> pd.DataFrame:
    """读 CSV。文件不存在或表头不对时，抛 SystemExit 并给一句人话。"""
    if not csv_path.exists():
        raise SystemExit(
            f"找不到 CSV：{csv_path}\n"
            f"先在网页上点「导出 CSV」，把下载到的 {DEFAULT_CSV.name} "
            f"放进 {DEFAULT_CSV.parent} 目录。"
        )

    # encoding="utf-8-sig"：导出的文件开头有 UTF-8 BOM。
    # 用默认的 utf-8 读的话，第一列列名会变成 "\uFEFFtime" 而不是 "time"，
    # 取 df["time"] 就会 KeyError。utf-8-sig 会把这个 BOM 吃掉。
    df = pd.read_csv(csv_path, encoding="utf-8-sig")

    missing = [name for name in REQUIRED_COLUMNS if name not in df.columns]
    if missing:
        raise SystemExit(
            f"CSV 缺少列：{'、'.join(missing)}\n"
            f"表头应该是：{','.join(REQUIRED_COLUMNS)}\n"
            f"实际读到：{','.join(map(str, df.columns))}"
        )

    return df


# ---------------------------------------------------------------- 规则复核

def _judge_row(row) -> str:
    """算一行的 rule_status；温湿度缺失时返回 MISSING。"""
    if pd.isna(row.temperature) or pd.isna(row.humidity):
        return MISSING
    return rules.judge_status(row.temperature, row.humidity)


def add_rule_status(df: pd.DataFrame) -> pd.DataFrame:
    """新增一列 rule_status：每一行都用 rules.judge_status 重算一遍。

    重算而不是信 CSV 里的 status —— CSV 是 Web 端（shared/rules.js）写的，
    这次重算走的是 Python 端（status_rules.py）。两边本该给出同样的结果，
    对不上就说明规则实现不同步了，find_mismatches() 专门把它们挑出来。

    返回新的 DataFrame，不改传进来的那个。
    """
    out = df.copy()
    out["rule_status"] = [_judge_row(row) for row in out.itertuples()]
    return out


def find_mismatches(df: pd.DataFrame) -> list[dict]:
    """挑出 CSV 里的 status 和规则重算结果不一致的行。

    需要 df 已经带上 rule_status 列（add_rule_status() 生成）。
    """
    return [
        _row_dict(row)
        for row in df.itertuples()
        if _clean(row.status) != _clean(row.rule_status)
    ]


def count_statuses(df: pd.DataFrame) -> dict:
    """统计每种 rule_status 出现了几次。

    四种状态都会出现在结果里，没有的是 0 —— 报告里少一行会让人以为漏统计了。
    顺序固定按 STATUS_ORDER，不按次数排。CSV 里万一出现规则之外的怪值也留着，
    不悄悄吞掉。
    """
    counts = {name: 0 for name in STATUS_ORDER}
    for value, number in df["rule_status"].value_counts().items():
        counts[str(value)] = int(number)
    return counts


def find_attention(df: pd.DataFrame) -> list[dict]:
    """所有需要关注的记录 —— rule_status 不是「正常」的都算。

    需要 df 已经带上 rule_status 列（add_rule_status() 生成）。
    """
    return [
        _row_dict(row)
        for row in df.itertuples()
        if _clean(row.rule_status) != NORMAL
    ]


def time_range(df: pd.DataFrame) -> tuple[str, str]:
    """最早 / 最晚的时间，空单元格不计。没有可用的时间就返回两个空串。

    time 的格式是固定的 YYYY-MM-DD HH:mm:ss，位数对齐、字段由大到小，
    所以字符串比大小就是时间先后，不用再 parse 成 datetime。
    """
    values = [text for text in (_clean(value) for value in df["time"]) if text]
    if not values:
        return "", ""
    return min(values), max(values)


# ---------------------------------------------------------------- 打印报告段

def print_consistency(mismatches: list[dict], records: int) -> None:
    """打印规则复核结果：一致就一句话，不一致就打警告 + 明细。"""
    print()

    if records == 0:
        print("规则复核：没有数据行，跳过。")
        return

    if not mismatches:
        print(f"规则复核：{records} 行的 status 和规则算出来的一致。")
        return

    print(f"!! 警告：{len(mismatches)} / {records} 行的 status 和规则算出来的不一致")
    print("   Web 端用 shared/rules.js，Python 端用 status_rules.py，")
    print("   两边对不上多半是只改了一边 —— 同步完规则再重新导出一份 CSV。")
    print()

    rows = [["时间", "温度 ℃", "湿度 %", "CSV 里的 status", "规则算出"]]
    for item in mismatches[:MAX_PRINT]:
        rows.append([
            item["time"] or "—",
            _num(item["temperature"]),
            _num(item["humidity"]),
            item["status"] or "（空）",
            item["rule_status"] or "（空）",
        ])
    _table(rows)

    if len(mismatches) > MAX_PRINT:
        print(f"  …还有 {len(mismatches) - MAX_PRINT} 行"
              f"，完整列表在 summary['mismatches'] 里")


def print_status_counts(counts: dict, records: int) -> None:
    """打印状态统计表。"""
    print()
    print("状态统计（rule_status，按规则重算）：")

    rows = [["状态", "条数"]]
    rows += [[name, str(number)] for name, number in counts.items()]
    rows.append(["合计", str(records)])
    _table(rows, right=(1,))


def print_attention(attention: list[dict]) -> None:
    """打印需要关注的记录。"""
    print()

    if not attention:
        print(f"需要关注的记录：没有，全部是「{NORMAL}」。")
        return

    print(f"需要关注的记录（rule_status 不是「{NORMAL}」）：{len(attention)} 条")

    rows = [["时间", "温度 ℃", "湿度 %", "状态"]]
    for item in attention[:MAX_PRINT]:
        rows.append([
            item["time"] or "—",
            _num(item["temperature"]),
            _num(item["humidity"]),
            item["rule_status"] or "（空）",
        ])
    _table(rows)

    if len(attention) > MAX_PRINT:
        print(f"  …还有 {len(attention) - MAX_PRINT} 条"
              f"，完整列表在 summary['attention'] 里")


# ---------------------------------------------------------------- 汇总

def _stats(df: pd.DataFrame) -> dict:
    """算记录数和温湿度极值，不打印。describe() 和 summarize(verbose=False) 都走它。"""
    stats = {
        "records": len(df),
        "temp_max": None,
        "temp_min": None,
        "humidity_max": None,
        "humidity_min": None,
    }

    if df.empty:
        # 只有表头也是合法输入，不要对空列求 max
        return stats

    stats["temp_max"] = _number(df["temperature"].max())
    stats["temp_min"] = _number(df["temperature"].min())
    stats["humidity_max"] = _number(df["humidity"].max())
    stats["humidity_min"] = _number(df["humidity"].min())

    return stats


def describe(df: pd.DataFrame) -> dict:
    """打印记录数和温湿度极值，顺便把统计结果返回出去（方便以后被调用）。"""
    stats = _stats(df)

    print(f"记录数：{stats['records']}")

    if df.empty:
        print("（文件里只有表头，没有数据行）")
        return stats

    # 用 _num() 而不是 f"{...:g}"：整列都是空的时候极值是 None，
    # 直接上 :g 会 TypeError，_num() 会打成「—」
    print(f"温度：最高 {_num(stats['temp_max'])} ℃    最低 {_num(stats['temp_min'])} ℃")
    print(f"湿度：最高 {_num(stats['humidity_max'])} %    最低 {_num(stats['humidity_min'])} %")

    return stats


def summarize(df: pd.DataFrame, csv_path: Path | None = None,
              verbose: bool = True) -> dict:
    """把统计整理成一个 summary 字典，后面生成报告要用。

    顺便把报告几个段落打印出来：基础统计、规则复核、状态统计、需要关注的记录。
    verbose=False 就只返回字典不打印 —— analysis/report.py 只要数据，
    不要再往屏幕上刷一份终端表格。

    df 需要已经带上 rule_status 列（add_rule_status() 生成）；没带就自己补。

    返回的字典只有 python 内置类型（str / int / float / None / list / dict），
    可以直接 json.dumps 出去存成报告数据。键和顺序是固定的：
    file / records / time_first / time_last / temp_max / temp_min /
    humidity_max / humidity_min / status_counts / mismatches / attention
    """
    if "rule_status" not in df.columns:
        df = add_rule_status(df)

    mismatches = find_mismatches(df)
    attention = find_attention(df)
    first, last = time_range(df)
    stats = describe(df) if verbose else _stats(df)

    summary = {
        "file": None if csv_path is None else str(csv_path),
        "records": stats["records"],
        "time_first": first,
        "time_last": last,
        "temp_max": stats["temp_max"],
        "temp_min": stats["temp_min"],
        "humidity_max": stats["humidity_max"],
        "humidity_min": stats["humidity_min"],
        "status_counts": count_statuses(df),
        "mismatches": mismatches,
        "attention": attention,
    }

    if verbose:
        # 报告顺序：基础统计 -> 规则复核 -> 状态统计 -> 需要关注。
        # 复核紧跟基础统计，是因为一旦两边规则不一致，后面所有数字都要先打个问号。
        print_consistency(mismatches, summary["records"])
        print_status_counts(summary["status_counts"], summary["records"])
        print_attention(attention)

    return summary


# ---------------------------------------------------------------- 趋势图

# matplotlib 默认的 DejaVu Sans 里没有汉字，不换字体的话标题、轴标签全画成
# 方块。按平台常见的中文字体依次试，matplotlib 会用列表里第一个装了的。
# 只设 font.sans-serif 就够：font.family 默认就是 sans-serif。
CJK_FONTS = ["Microsoft YaHei", "SimHei", "PingFang SC", "Arial Unicode MS"]

# 图存到这儿。注意是单数 report/ —— 课程要求写的就是 report/trend.png，
# 和 Markdown 报告的 reports/（analysis/report.py 写的）不是一个目录。
# 想合成一个目录，把这两个常量改成同一个名字就行。
DEFAULT_TREND = ROOT / "report" / "trend.png"

TREND_TITLE = "宿舍环境变化趋势"

# 温度走左轴、湿度走右轴，各自的轴标签和刻度染成跟线一样的颜色，看线就知道
# 该读哪边的刻度。两条线的点形状也不同（圆点 / 方块）：印成黑白也分得清，
# 不只靠颜色区分。
TEMP_COLOR = "#C1440E"
HUMIDITY_COLOR = "#1F6FB2"
GRID_COLOR = "#DDDDDD"

# 不弹窗的后端：只写文件。以后挂到 CI 上跑（没有显示器）也能出图。
BACKEND = "Agg"
FIG_SIZE = (10, 5)
DPI = 150
LINE_WIDTH = 1.8

# 所有点的时间都一样（比如只有一行数据）时，横轴跨度是 0，AutoDateLocator
# 挑不出刻度间隔会一直警告。给它撑开一个 60 秒的窗口，点就落在正中间。
SINGLE_POINT_WINDOW = timedelta(seconds=30)


def _parse_time(text: str):
    """'2026-09-22 20:30:00' -> datetime；空串或格式不对返回 None。"""
    try:
        return datetime.strptime(text, TIME_FORMAT)
    except ValueError:
        return None


def _value(value) -> float:
    """画图用的数：缺失给 nan，让折线在那儿断开，而不是连成一条假的直线。"""
    number = _number(value)
    return math.nan if number is None else number


def trend_series(df: pd.DataFrame) -> dict:
    """把 DataFrame 整理成画图要的几条列表。

    纯数据、不碰 matplotlib —— 这样不用装 matplotlib 也能单测这里。

    - time 空着、或不是 YYYY-MM-DD HH:mm:ss 的行放不到横轴上，计入 skipped：
      不画，但也不闷声丢掉，画完会把行数打出来。
    - 温度和湿度分开看：温度空着但湿度有值的行，湿度那个点照样画。
    - 按时间升序排。CSV 是追加写的，正常本来就按时间，但把几份导出的文件拼在
      一起就可能乱序，乱序画出来的折线会来回折返、很难看。

    返回 {"times": [datetime], "temperature": [float], "humidity": [float],
          "skipped": int}
    """
    points: list[tuple] = []
    skipped = 0

    for row in df.itertuples():
        when = _parse_time(_clean(row.time))
        if when is None:
            skipped += 1
            continue
        points.append((when, _value(row.temperature), _value(row.humidity)))

    points.sort(key=lambda point: point[0])

    return {
        "times": [point[0] for point in points],
        "temperature": [point[1] for point in points],
        "humidity": [point[2] for point in points],
        "skipped": skipped,
    }


def _date_format(series: dict) -> str:
    """横轴的时间格式。跨度不到一天就只打时分秒 —— 标签越短越不容易挤。"""
    times = series["times"]
    if len(times) < 2 or times[-1] - times[0] < timedelta(days=1):
        return "%H:%M:%S"
    return "%m-%d %H:%M"


def _pyplot():
    """导入 pyplot 并设好中文显示，返回 plt 模块。

    在这里 import 而不是文件顶部：没装 matplotlib 时，读 CSV、统计、规则复核
    照样能用，只有画图这一步会停，而且提示里直接给安装命令。

    后端用 Agg：只写文件、不弹窗口，所以不用 plt.show()，也不会卡在窗口上。
    """
    try:
        import matplotlib
    except ImportError:
        raise SystemExit(
            "没装 matplotlib，画不了趋势图。\n"
            "装上再跑：py -3.14 -m pip install matplotlib"
        ) from None

    matplotlib.use(BACKEND)
    import matplotlib.pyplot as plt  # noqa: E402  —— 必须在 use() 之后 import

    plt.rcParams["font.sans-serif"] = list(CJK_FONTS)
    # 负号也走字体：不关掉的话，刻度上的 -5 会显示成方块
    plt.rcParams["axes.unicode_minus"] = False
    return plt


def find_cjk_font() -> str | None:
    """CJK_FONTS 里第一个真装了的字体名；一个都没有返回 None。

    字体列表是交给 matplotlib 依次去试的，它不会告诉你最后用了哪个 ——
    装没装得自己查，不然中文变成方块了还找不到原因。
    """
    from matplotlib import font_manager

    available = {font.name for font in font_manager.fontManager.ttflist}
    return next((name for name in CJK_FONTS if name in available), None)


def _print_trend_note(out_path: Path, series: dict) -> None:
    """打印画图结果：中文字体找到没、存到哪、几个点、哪些行没画进去。"""
    font = find_cjk_font()
    if font is None:
        print(f"!! 警告：{CJK_FONTS[0]} 等中文字体一个都没装，图上的中文会是方块")
    else:
        print(f"中文字体：{font}")

    print(f"趋势图：{out_path}（{len(series['times'])} 个点，"
          f"{out_path.stat().st_size // 1024} KB）")

    for name, values in (("温度", series["temperature"]),
                         ("湿度", series["humidity"])):
        count = sum(1 for value in values if math.isnan(value))
        if count:
            print(f"  {name}有 {count} 个点是空的，折线在那儿断开")

    if series["skipped"]:
        print(f"  {series['skipped']} 行的时间是空的或不是 {TIME_FORMAT} 格式，没画进去")


def plot_trend(df: pd.DataFrame, out_path: Path | None = None,
               verbose: bool = True) -> Path:
    """画温度、湿度随时间变化的折线图，存成 PNG，返回写出的路径。

    温度走左轴、湿度走右轴。twinx() 出来的两根纵轴共用同一根横轴，但刻度
    各归各的 —— ℃ 是十几到三十几，% 是六十到八十，塞进一根轴里会互相挤扁。

    目录不存在会自动创建，所以可以直接指到还没建的 report/ 下。
    一行数据都没有时也照样出一张图（上面写着「没有可绘制的数据」）：
    报告里引用的图片路径不该时有时无。
    """
    plt = _pyplot()
    from matplotlib import dates as mdates
    from matplotlib import ticker

    out_path = DEFAULT_TREND if out_path is None else Path(out_path)
    series = trend_series(df)
    has_data = bool(series["times"])

    fig, ax = plt.subplots(figsize=FIG_SIZE, dpi=DPI)

    # 左轴：温度
    if has_data:
        ax.plot(series["times"], series["temperature"], color=TEMP_COLOR,
                linewidth=LINE_WIDTH, marker="o", markersize=3.5, label="温度 ℃")
    ax.set_title(TREND_TITLE)
    ax.set_xlabel("时间")
    ax.set_ylabel("温度 (℃)", color=TEMP_COLOR)
    ax.tick_params(axis="y", labelcolor=TEMP_COLOR)

    # 右轴：湿度
    ax2 = ax.twinx()
    if has_data:
        ax2.plot(series["times"], series["humidity"], color=HUMIDITY_COLOR,
                 linewidth=LINE_WIDTH, marker="s", markersize=3.5, label="湿度 %")
    ax2.set_ylabel("湿度 (%)", color=HUMIDITY_COLOR)
    ax2.tick_params(axis="y", labelcolor=HUMIDITY_COLOR)

    # 统一规则的三条阈值画成虚线，并写进图例：哪几段越了界一眼能看出来，
    # 报告里解释"为什么这一段要关注"时也不用再报一遍数字。
    for value in (rules.TEMP_LOW, rules.TEMP_HIGH):
        ax.axhline(value, color=TEMP_COLOR, linestyle=":", linewidth=1,
                   alpha=0.55, label=f"温度阈值 {value:g} ℃")
    ax2.axhline(rules.HUMIDITY_HIGH, color=HUMIDITY_COLOR, linestyle=":",
                linewidth=1, alpha=0.55,
                label=f"湿度阈值 {rules.HUMIDITY_HIGH:g} %")

    # 网格画在折线下面，别盖住数据
    ax.grid(True, color=GRID_COLOR, linewidth=0.6)
    ax.set_axisbelow(True)

    # 刻度用 %g 打：湿度的 60.0 打成 60，该留小数的 62.5 还是 62.5。
    # 不去动 locator —— 温湿度范围窄的时候，整数 locator 会只剩一两个刻度。
    for axis in (ax, ax2):
        axis.yaxis.set_major_formatter(ticker.FormatStrFormatter("%g"))

    if has_data:
        # 横轴标签是"09-22 20:30"这种长文本，点一多就挤成一团。
        # 两件事一起做：限制刻度个数，再把标签斜过来右对齐。
        ax.xaxis.set_major_locator(mdates.AutoDateLocator(maxticks=8))
        ax.xaxis.set_major_formatter(mdates.DateFormatter(_date_format(series)))

        # 撑开横轴必须排在读刻度标签【之前】：get_xticklabels() 会立刻让
        # locator 按当前的横轴范围算一次刻度，而那时范围还是 0 宽，警告已经
        # 打出去了。先给范围再问标签，顺序反了压不住。
        if series["times"][-1] == series["times"][0]:
            center = series["times"][0]
            ax.set_xlim(center - SINGLE_POINT_WINDOW, center + SINGLE_POINT_WINDOW)

        ax.tick_params(axis="x", labelrotation=30)
        for label in ax.get_xticklabels():
            label.set_horizontalalignment("right")

        # 两根轴的图例要合起来手工拼：legend() 只看自己那根轴，
        # 直接 ax.legend() 只会出现温度那一项，湿度就丢了。
        handles, labels = [], []
        for axis in (ax, ax2):
            axis_handles, axis_labels = axis.get_legend_handles_labels()
            handles += axis_handles
            labels += axis_labels
        # 摆到横轴下方而不是图里面：数据是折线不是柱状，曲线会走到图例底下，
        # 放里面总有一段线被盖住（loc="best" 也只是挑个盖得最少的角落）。
        # 图例挂在轴外面，tight_layout() 会把下边距撑开给它让位。
        ax.legend(handles, labels, loc="upper center", bbox_to_anchor=(0.5, -0.22),
                  ncol=len(handles), frameon=False, fontsize=9)
    else:
        ax.set_xticks([])   # 没数据，别让横轴打出一串 1970 年的刻度
        ax.text(0.5, 0.5, "没有可绘制的数据", transform=ax.transAxes,
                ha="center", va="center", fontsize=14, color="#888888")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()      # 斜过来的横轴标签容易超出画布，让它自己收紧边距
    fig.savefig(out_path)
    plt.close(fig)          # 不关的话，同一个进程里反复画图会一直堆在内存里

    if verbose:
        _print_trend_note(out_path, series)

    return out_path


# ---------------------------------------------------------------- HTML 报告

# 报告和趋势图放在同一个目录：<img src="trend.png"> 是相对路径，两个文件分开
# 就成断图了。所以默认都在 report/ 下，整个目录拷到哪都能直接打开。
DEFAULT_REPORT_HTML = ROOT / "report" / "report.html"

# 写进 <img src> 的相对文件名。用相对路径而不是绝对路径：报告是要拷走给人看的，
# 绝对路径到别人机器上必然是断的。
TREND_FILE = "trend.png"

REPORT_TITLE = "DormMate 宿舍环境报告"

# 状态统计里那四个色点。跟趋势图的「温度橙 / 湿度蓝」不是一套语义（那边区分的是
# 量，这边区分的是状态），而且每行都带状态名，认状态靠字不靠颜色。
# 没见过的状态（CSV 里冒出规则之外的怪值）用灰的。
STATUS_COLORS = {
    rules.STATUS_COLD: "#1F6FB2",
    rules.STATUS_HOT: "#C1440E",
    rules.STATUS_HUMID: "#2E7D6F",
    rules.STATUS_NORMAL: "#4E7A2E",
}
FALLBACK_COLOR = "#8A8F98"

# 一点手写 CSS，没有模板引擎也没有框架。整体是"文档"而不是"仪表盘"：
# 白底、细线、字大，打印出来也看得清。
REPORT_CSS = """\
:root { --ink: #1f2328; --muted: #6a737d; --line: #e1e4e8; --panel: #f6f8fa; }
* { box-sizing: border-box; }
body {
  max-width: 900px; margin: 0 auto; padding: 32px 20px 64px;
  font: 15px/1.7 "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
  color: var(--ink); background: #fff;
}
h1 { margin: 0 0 6px; font-size: 24px; }
h2 { margin: 32px 0 12px; padding-bottom: 6px; font-size: 18px;
     border-bottom: 1px solid var(--line); }
p { margin: 8px 0; }
.meta { margin: 0; color: var(--muted); font-size: 13px; }
.path { word-break: break-all; }
.note { color: var(--muted); font-size: 13px; }
.empty { color: var(--muted); font-size: 14px; }
.cards { display: flex; flex-wrap: wrap; gap: 12px; margin: 16px 0; }
.card { flex: 1 1 150px; padding: 12px 14px; background: var(--panel);
        border: 1px solid var(--line); border-radius: 8px; }
.card .label { display: block; color: var(--muted); font-size: 12px; }
.card .value { display: block; margin-top: 2px; font-size: 22px; font-weight: 600; }
.card .value small { font-size: 13px; font-weight: 400; color: var(--muted); }
table { width: 100%; margin: 8px 0; border-collapse: collapse; font-size: 14px; }
th, td { padding: 6px 10px; border: 1px solid var(--line); text-align: left; }
th { background: var(--panel); font-weight: 600; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.total td { font-weight: 600; }
.dot { display: inline-block; width: 8px; height: 8px; margin-right: 6px;
       border-radius: 50%; }
.bar { display: block; height: 8px; min-width: 3px; border-radius: 4px; }
.warn { padding: 10px 14px; margin: 16px 0; font-size: 14px; background: #fff5f5;
        border-left: 4px solid #C1440E; border-radius: 0 6px 6px 0; }
img { max-width: 100%; height: auto; border: 1px solid var(--line);
      border-radius: 8px; }
@media print { body { max-width: none; } h2 { break-after: avoid; } }
"""


def _esc(value) -> str:
    """要插进 HTML 的文本一律走这里。

    summary 里的字符串全都来自 CSV —— 那是网页导出、也可能有人手打进去的。
    里面出现 < > & " 会把标签撑破：轻则排版乱掉，重则注入一段脚本。
    数字和 None 也会走到这儿，所以先 str()；None 打成「—」而不是 "None"。
    """
    return "—" if value is None else html.escape(str(value), quote=True)


def _html_table(header: list, rows: list[list],
                right: tuple[int, ...] = ()) -> str:
    """表头 + 数据行 -> HTML 表格。每个单元格都转义。rows 为空时给一句占位。"""
    def cell(tag: str, text, index: int) -> str:
        style = ' class="num"' if index in right else ""
        return f"<{tag}{style}>{_esc(text)}</{tag}>"

    out = ["<table>", "<thead><tr>"]
    out += [cell("th", text, index) for index, text in enumerate(header)]
    out.append("</tr></thead>")

    if not rows:
        out.append(f'<tbody><tr><td colspan="{len(header)}" class="empty">'
                   f"（没有记录）</td></tr></tbody>")
    else:
        out.append("<tbody>")
        for row in rows:
            out.append("<tr>")
            out += [cell("td", text, index) for index, text in enumerate(row)]
            out.append("</tr>")
        out.append("</tbody>")

    out.append("</table>")
    return "\n".join(out)


def table_section(title: str, header: list, rows: list[list],
                  right: tuple[int, ...] = ()) -> dict:
    """拼一个「额外区块」：一张带标题的表格。

    后面要加的「事件复盘」「今日摘要」「ML 异常分析」直接用它，然后
    build_report(summary, [...]) 塞进去就行，不用改 build_report。

    返回的就是 sections 里的一项：{"title": ..., "html": ...}
    """
    return {"title": title, "html": _html_table(header, rows, right)}


def _section(title: str, body: str) -> str:
    """一个带标题的区块。标题转义，body 原样插入（那是本文件自己拼的 HTML）。"""
    return f"<section>\n<h2>{_esc(title)}</h2>\n{body}\n</section>"


def _section_block(item: dict) -> str:
    """sections 列表里的一项 -> HTML。

    约定：title 是纯文本（会被转义），html 是已经拼好的 HTML（原样插入，
    不转义，所以里面要填数据得自己先过 _esc）。
    """
    return _section(item.get("title", ""), item.get("html", ""))


def _header_block(summary: dict, generated_at: str) -> str:
    """标题 + 生成时间 + 数据来源文件名 + 数据时间范围。"""
    path = summary.get("file")
    name = Path(path).name if path else "（未指定）"
    full = f' <span class="path">({_esc(path)})</span>' if path else ""
    return (
        f"<h1>{_esc(REPORT_TITLE)}</h1>\n"
        f'<p class="meta">生成时间：{_esc(generated_at)}　·　'
        f"数据来源：{_esc(name)}{full}　·　"
        f"数据时间范围：{_esc(format_range(summary))}</p>"
    )


def _mismatch_note(summary: dict) -> str:
    """规则复核没通过时，在最上面插一条横幅；通过就没这一块。

    CSV 里的 status 是 Web 端（shared/rules.js）写的，报告里的状态是 Python 端
    （status_rules.py）重算的。两边对不上说明规则没同步 —— 这种报告不该安安静静
    地发出去，所以横幅放在摘要之前，先看见它再看见数字。
    """
    mismatches = summary.get("mismatches") or []
    if not mismatches:
        return ""
    return (
        f'<p class="warn">规则复核没通过：{len(mismatches)} 行的 status 和规则'
        f"算出来的不一致。Web 端用 shared/rules.js，Python 端用 status_rules.py，"
        f"两边对不上多半是只改了一边 —— 同步完规则再重新导出一份 CSV。"
        f"具体哪几行在命令行输出里。</p>"
    )


def _summary_block(summary: dict) -> str:
    """摘要：记录数、温湿度极值（卡片）+ 各状态数量（带占比和分布条）。"""
    records = summary.get("records", 0)
    counts = summary.get("status_counts") or {}

    cards = [
        ("记录数", _num(records), "条"),
        ("温度最高", _num(summary.get("temp_max")), "℃"),
        ("温度最低", _num(summary.get("temp_min")), "℃"),
        ("湿度最高", _num(summary.get("humidity_max")), "%"),
        ("湿度最低", _num(summary.get("humidity_min")), "%"),
    ]
    card_html = "".join(
        f'<div class="card"><span class="label">{_esc(label)}</span>'
        f'<span class="value">{_esc(value)} <small>{_esc(unit)}</small></span></div>'
        for label, value, unit in cards
    )

    rows = []
    for name, number in counts.items():
        color = STATUS_COLORS.get(name, FALLBACK_COLOR)
        bar = ""
        if number > 0 and records > 0:
            # 分布条的宽度是按条数算出来的，不是写死的百分比
            bar = (f'<span class="bar" style="width:{number / records * 100:.1f}%;'
                   f'background:{color}"></span>')
        rows.append(
            f"<tr>"
            f'<td><span class="dot" style="background:{color}"></span>{_esc(name)}</td>'
            f'<td class="num">{_esc(number)}</td>'
            f'<td class="num">{_esc(format_percent(number, records))}</td>'
            f"<td>{bar}</td>"
            f"</tr>"
        )
    rows.append(
        f'<tr class="total"><td>合计</td>'
        f'<td class="num">{_esc(records)}</td>'
        f'<td class="num">{_esc(format_percent(records, records))}</td>'
        f"<td></td></tr>"
    )

    table = (
        "<table><thead><tr>"
        '<th>状态</th><th class="num">条数</th><th class="num">占比</th>'
        "<th>分布</th></tr></thead><tbody>"
        + "".join(rows)
        + "</tbody></table>"
    )

    return _section(
        "摘要",
        f'<div class="cards">{card_html}</div>\n'
        f'<p class="note">状态一律按统一规则重算（rule_status），'
        f"不采用 CSV 里写的 status。</p>\n"
        f"{table}",
    )


def _attention_block(summary: dict) -> str:
    """需要关注的记录：rule_status 不是「正常」的全部列出来。"""
    attention = summary.get("attention") or []
    note = (f'<p class="note">rule_status 不是「{_esc(NORMAL)}」的都算，'
            f"共 {len(attention)} 条。</p>")

    if not attention:
        return _section("需要关注的记录",
                        note + f'<p class="empty">没有，全部是「{_esc(NORMAL)}」。</p>')

    rows = [
        [item["time"] or "—", _num(item["temperature"]), _num(item["humidity"]),
         item["rule_status"] or "（空）"]
        for item in attention
    ]
    return _section("需要关注的记录", note + _html_table(
        ["时间", "温度 ℃", "湿度 %", "状态"], rows, right=(1, 2)))


def _trend_block(trend_path: Path) -> str:
    """趋势图。图不在（--no-plot 或画图那步失败）就给一句占位，不留断图。"""
    if trend_path.exists():
        return _section("趋势图",
                        f'<img src="{TREND_FILE}" alt="温度与湿度随时间的变化">')
    return _section("趋势图", f'<p class="empty">没有 {_esc(TREND_FILE)}'
                              f"（用了 --no-plot，或者画图那步没成功）。</p>")


# ---------------------------------------------------------------- 今日摘要区块

# 事件明细表的列。和 daily_summary 返回的那几个字段一一对应 ——
# 「持续（分钟）」右对齐，数字列对不齐的话一列看着像两列。
EVENT_HEADER = ["宿舍", "开始", "结束", "持续（分钟）", "异常类型", "结果"]


def daily_summary_section(daily: dict) -> dict:
    """「今日摘要」区块（Step 8-2）。返回 sections 里的一项。

    参数是 daily_summary.summarize_frame() 算好的那个字典，不是 DataFrame ——
    命令行上也要把这段话打出来（见 main），一句话算两遍容易有两份说法，
    所以算一次、渲染两次。

    数据里没有 nodeId 列时（比如 data/dormmate.csv 是从单节点看板导出的），
    区块照样出，但说的是一句实话：这份数据没法按宿舍分开。
    """
    # 数据来源要注明。值是从 CSV 的 source 列读出来的，不写死 ——
    # 写死的话，拿现场数据跑出来的报告也会自称「模拟日数据」。
    body = [f'<p class="note">数据来源：{_esc(daily["source"])}</p>']

    if not daily["nodes"]:
        # 分不了组（没有 nodeId 列）：那句话本身就是在说这件事，压低一号显示
        body.append(f'<p class="empty">{_esc(daily["text"])}</p>')
        return {"title": "今日摘要", "html": "\n".join(body)}

    body.append(f"<p>{_esc(daily['text'])}</p>")

    if not daily["events"]:
        # 有数据、只是一段异常都没有。那句话已经把话说完了，不摆一张空表。
        return {"title": "今日摘要", "html": "\n".join(body)}

    rows = [
        [event["nodeId"], event["start"], event["end"],
         _num(event["minutes"]), event["status"],
         "已恢复" if event["recovered"] else "仍未恢复"]
        for event in daily["events"]
    ]
    body.append(_html_table(EVENT_HEADER, rows, right=(3,)))
    return {"title": "今日摘要", "html": "\n".join(body)}


def _document(body: str) -> str:
    """把各个区块包成一份完整的 HTML 文档。

    <meta charset="utf-8"> 是必需的：报告是 file:// 直接打开的，没有 HTTP 头
    告诉浏览器编码，全靠这一行。
    """
    return (
        "<!DOCTYPE html>\n"
        '<html lang="zh-CN">\n'
        "<head>\n"
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{_esc(REPORT_TITLE)}</title>\n"
        f"<style>\n{REPORT_CSS}</style>\n"
        "</head>\n"
        "<body>\n"
        f"{body}\n"
        "</body>\n"
        "</html>\n"
    )


def build_report(summary: dict, sections: list[dict] | None = None,
                 generated_at: str | None = None,
                 trend_path: Path | None = None) -> str:
    """把 summary 拼成一份完整的 HTML 报告字符串。

    sections 是「额外区块」列表，每项 {"title": 标题, "html": 一段 HTML}，
    按顺序接在趋势图后面。后面要加的「事件复盘」「今日摘要」「ML 异常分析」都
    从这里进来，build_report 本身不用动；拼表格用 table_section() 最省事。

    报告里没有一个写死的数字：记录数、极值、各状态条数、占比、关注条数，
    全部来自 summary —— 也就是全部来自这次真正读到的数据。

    generated_at 不传就取当前时间；传进来是为了测试能给定固定值，好逐字节比对。

    trend_path 只用来判断图在不在（在就 <img>，不在就一句占位），真正写进
    src 的永远是 TREND_FILE 这个相对文件名 —— 报告和图画在同一个目录里。
    """
    stamp = generated_at or datetime.now().strftime(TIME_FORMAT)
    trend_path = DEFAULT_TREND if trend_path is None else Path(trend_path)

    blocks = [
        _header_block(summary, stamp),
        _mismatch_note(summary),
        _summary_block(summary),
        _attention_block(summary),
        _trend_block(trend_path),
    ]
    # 额外区块按传入顺序排在最后。以后加功能往这个列表里塞，不动上面的
    blocks += [_section_block(item) for item in (sections or [])]

    return _document("\n".join(block for block in blocks if block))


def write_report(summary: dict, out_path: Path | None = None,
                 sections: list[dict] | None = None,
                 generated_at: str | None = None) -> Path:
    """把 build_report() 拼好的 HTML 写进文件，返回写出的路径。

    目录不存在会自动创建。编码 UTF-8 且【不带 BOM】：<meta charset="utf-8">
    已经告诉浏览器编码了，再加 BOM 反而可能被某些解析器当成正文的第一个字符。
    换行统一 LF，免得同一个文件在 Windows 和别处 diff 出满屏差异。
    """
    out_path = DEFAULT_REPORT_HTML if out_path is None else Path(out_path)
    text = build_report(summary, sections, generated_at,
                        trend_path=out_path.parent / TREND_FILE)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(text, encoding="utf-8", newline="\n")
    return out_path


# ---------------------------------------------------------------- 入口

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="DormMate：读取导出的 CSV，复核规则、做统计、画趋势图、出 HTML 报告",
    )
    parser.add_argument(
        "csv",
        nargs="?",
        default=str(DEFAULT_CSV),
        help=f"CSV 文件路径，相对路径按项目根解析（默认 {DEFAULT_CSV}）",
    )
    parser.add_argument(
        "--no-plot",
        action="store_true",
        help=f"不生成 {DEFAULT_TREND.name}（报告里趋势图的位置改成一句占位）",
    )
    parser.add_argument(
        "--no-report",
        action="store_true",
        help=f"不生成 {DEFAULT_REPORT_HTML.name}",
    )
    args = parser.parse_args(argv)

    csv_path = resolve_csv(args.csv)
    df = add_rule_status(load(csv_path))

    # 中文列宽按两个字符算，表头和内容才对得齐（默认按一个算，会错位）
    pd.set_option("display.unicode.east_asian_width", True)

    print(f"文件：{csv_path}")
    print()
    print("前 5 行：")
    print(df.head())
    print()

    summary = summarize(df, csv_path)

    print()
    if args.no_plot:
        print(f"跳过 {DEFAULT_TREND.name}（--no-plot）")
    else:
        # 先画图再出报告：报告要判断 trend.png 在不在，顺序反了会拿到上一轮
        # 留下的旧图，或者误报"图没生成"
        plot_trend(df)

    # 今日摘要只算一次：下面命令行要打出来，报告里也要放进去。
    # 两处各算一遍的话，屏幕上和报告里有可能不是同一句话（口径一变就分叉），
    # 而且那种不一致没人会去核对。
    daily = daily_summary.summarize_frame(df, file=str(csv_path))

    print()
    print(f"今日摘要（数据来源：{daily['source']}）：")
    print(f"  {daily['text']}")

    if args.no_report:
        print(f"跳过 {DEFAULT_REPORT_HTML.name}（--no-report）")
        return 0

    print()
    report_path = write_report(summary, sections=[daily_summary_section(daily)])
    print(f"报告：{report_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
