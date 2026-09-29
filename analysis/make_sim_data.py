"""Step 8-2 数据源：生成「模拟日数据」data/day_sim.csv。
（Step 9-1 起，同一次运行还多写两份：dorm-a 的平时历史、6 条待判断新数据。）

运行（在项目根下、或任何别的目录下都行）：

    py -3.14 analysis/make_sim_data.py
    py -3.14 analysis/make_sim_data.py --seed 7
    py -3.14 analysis/make_sim_data.py --hot-start 14:30 --humid-start 21:00
    py -3.14 analysis/make_sim_data.py --out data/other.csv

一次运行出三份文件，都写在 --out 那个目录里，列完全一样：

    day_sim.csv              这一天三个宿舍的完整数据（864 行，2 个事件）
    dorm-a_history_sim.csv   dorm-a 的 40 条「平时」历史（条条正常）
    new_samples.csv          6 条「待判断新数据」

后两份是 Step 9-1 要用的输入：一份基准，加一批等着照基准判断的新读数。
【分开放】是这一步的硬要求 —— 新数据混进历史里，「拿历史当基准去判断新数据」
就变成了拿自己判断自己。两份文件的时间首尾相接（历史的末点 + 5 分钟 = 新数据第一条），
所以画在一条时间轴上也接得上，但各自落在自己的文件里。

为什么要有这么一个文件：dashboard 导出的 dormmate.csv 是「点一下、发一条」攒出来的，
时间戳全挤在几秒里，看不出「持续了多久」。要看「14:10 起持续偏热 40 分钟后恢复」
这种话对不对，得先有一份像样的一天数据。
`simulator.py` 是往 MQTT 上实时发的，真要跑一天也不现实 —— 所以这里直接照着一天的
时间轴把采样点摆出来，不连网、不等时间。

输出的列：nodeId,time,temperature,humidity,status,source。
status 【不写死】，每一行都用 analysis/rules.py 转发的 rules.judge_status 算 ——
和发布端（simulator.py 的 compute_status）、网页端（shared/rules.js）同一条规则，
只是入口不同。source 一律「模拟」，报告那边靠这一列说明数据来源。

三个宿舍都是「正常打底 + 少数几段异常」，默认这一天有 2 个事件：

    dorm-b  下午连续偏热约 40 分钟后恢复
    dorm-c  晚间开始偏湿，一直到这一天结束都还没恢复

随机种子固定（默认 2350），所以同一个种子跑多少次，出来的 CSV 一个字节都不差。
换 --seed 或 --hot-start / --humid-start，摘要就会跟着变 —— 这正是这一步要验证的事。

后两份的日期是 --date 的【后一天】，不是 --date 本身（见 history_day()）：
同一天同一时刻，day_sim.csv 里 dorm-a 是一个读数、这份历史里是另一个读数
（两条互不相干的随机流），并排一放像在吵架。错开一天，各说各的、各自自洽。

用 py -3.14 而不是 python：PATH 上的 python 是 32 位解释器，pandas 装不上。
本文件本身只用标准库，但它要调用 pandas 版的 daily_summary，跟着整套工具链用同一个解释器。
"""

from __future__ import annotations

import argparse
import random
import sys
from datetime import date as Date
from datetime import datetime, time as Time
from datetime import timedelta
from pathlib import Path

# 项目根 = 本文件的上一级。每个脚本开头都自己推一遍，不靠当前工作目录 ——
# 这样 `py -3.14 analysis/make_sim_data.py` 在哪个目录下敲都一样。
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from analysis import rules  # noqa: E402  —— 必须在上面调整完 sys.path 之后
from config import NODE_IDS, TIME_FORMAT  # noqa: E402

# ---------------------------------------------------------------- 可调参数

# 固定种子。改它就等于换一份「同一天、不同抖动、事件时刻也不同」的数据。
#
# 2350 是挑出来的，不是随手写的：它让默认这份数据正好落在需求里那两句例子的
# 时刻上（dorm-b 14:10、dorm-c 21:30），把摘要和例子并排一放就知道实现没跑偏。
# 想换一组数据随时 --seed <别的数>；换种子之后摘要里的时刻会跟着变，
# 这也正是「改了数据摘要必须跟着变」那条要求的验证方式。
SEED = 2350

# 这一天。摘要里的「14:10」全部由这里 + 采样间隔推出来，没有一处写死。
DAY = "2026-09-22"

# 采样间隔（分钟）。一天 24 小时 = 288 个点/节点。
# 取 5 而不是 60：事件时长要能被间隔整除才数得准。
# 「14:10 起 40 分钟」= 14:10 到 14:50 共 9 个点，14:50 − 14:10 正好 40 分钟；
# 间隔取 60 的话，40 分钟这种时长根本落不到采样点上。
INTERVAL = 5

SOURCE = "模拟"

COLUMNS = ["nodeId", "time", "temperature", "humidity", "status", "source"]

DEFAULT_OUT = ROOT / "data" / "day_sim.csv"

# 正常时段的取值。温度 22~25 ℃、湿度 52~64 %，离三条阈值（18 / 30 / 75）
# 都留着距离 —— 抖动不会把一条正常数据甩到异常那边去。否则「dorm-a 全天整体
# 正常」这句话就时真时假，而且「换种子摘要变不变」也变成看运气了。
BASE_TEMPERATURE = (23.5, 1.5)   # (中心, 半径)
BASE_HUMIDITY = (58.0, 6.0)

# 事件取值。同样离阈值留距离：偏热段温度 31~33 ℃（阈值 30，全都 ≥ 30），
# 偏湿段湿度 78~86 %（阈值 75，全都 ≥ 75）。
# 故意不写成「围着阈值抖」—— 那样会抖出几个 29.8 / 74.6 的正常点，
# 一段连续的异常被切成好几段，「持续 40 分钟」直接散架。
HOT_TEMPERATURE = (31.0, 33.0)
HUMID_HUMIDITY = (78.0, 86.0)
HUMID_TEMPERATURE = (24.0, 26.0)

# 事件开始时刻从这个窗口里挑（挑到的位置再对齐到采样点上）。
# 挑的是开始时刻、不是整段长度 —— 时长由 --hot-minutes 定死，这样「约 40 分钟」
# 不会因为换了种子就变成 35 或者 55。
HOT_WINDOW = ("13:00", "15:00")
HUMID_WINDOW = ("20:00", "22:00")

HOT_MINUTES = 40

HOT_NODE = "dorm-b"
HUMID_NODE = "dorm-c"

# ------------------------------------------- Step 9-1：平时历史 + 待判断新数据

# 这两份和 day_sim.csv 是同一个脚本出的，但【另起一条随机流】—— 种子字符串里
# 带 history 字样（见 build_history）。这样动这里的常数，day_sim.csv 一个字节
# 都不会跟着挪。那份文件有逐字节的测试钉着，跟着变就说不清「到底改了什么」。
HISTORY_NODE = "dorm-a"
HISTORY_COUNT = 40
HISTORY_START = "08:00"

# 「平时」的取值：温度 24~26 ℃、湿度 55~65 %。整段离三条阈值（18 / 30 / 75）
# 都远，所以 40 条里一条异常都抖不出来 —— 这正是「平时」该有的样子。
# 反过来，要是贴着阈值抖，「这 40 条全是正常」这句话就变成看运气了。
HISTORY_TEMPERATURE = (24.0, 26.0)
HISTORY_HUMIDITY = (55.0, 65.0)

# 6 条待判断的新数据：(温度, 湿度)。【写死】—— 这是题目给的输入，不是造出来的，
# 所以 build_new_samples() 一个随机数都不抽，换 --seed 也不动它们。
NEW_SAMPLES = [(25, 60), (26, 62), (29, 72), (31, 60), (25, 80), (17, 60)]

# 这两份的文件名。跟 day_sim.csv 放同一个目录（--out 挪到哪，它们跟到哪），
# 名字固定 —— 后面几步要按名字找它们。
HISTORY_NAME = "dorm-a_history_sim.csv"
SAMPLES_NAME = "new_samples.csv"


# ---------------------------------------------------------------- 时间轴

def sample_times(day: Date, step: int = INTERVAL) -> list[datetime]:
    """这一天里所有的采样时刻：00:00 起，每 step 分钟一个，到 23:55 为止。

    到 23:55 就停 —— 再往后一步就是第二天 00:00 了，那是下一天的数据。
    """
    moments = []
    moment = datetime.combine(day, Time(0, 0))
    while moment.date() == day:
        moments.append(moment)
        moment += timedelta(minutes=step)
    return moments


def parse_hm(text: str) -> Time:
    """'14:30' -> datetime.time(14, 30)。格式不对就抛 ValueError，由 main() 报出去。"""
    hour, _, minute = text.partition(":")
    return Time(int(hour), int(minute))


def align(moment: datetime, step: int = INTERVAL) -> datetime:
    """把时刻往后对齐到采样点上。

    对齐很重要：开始时刻不落在采样点上，第一条异常数据就会晚于它，
    摘要里说的「14:10 起」和 CSV 里最早那条异常数据对不上。
    往后取整而不是往前 —— 事件从「不早于用户说的那个时刻」的第一个采样点开始。
    """
    extra = moment.minute % step
    return moment if extra == 0 else moment + timedelta(minutes=step - extra)


def pick_start(rng: random.Random, day: Date, window: tuple) -> datetime:
    """在 window 里按种子随机挑一个开始时刻，对齐到采样点上。"""
    candidates = []
    moment = datetime.combine(day, parse_hm(window[0]))
    high = datetime.combine(day, parse_hm(window[1]))
    while moment <= high:
        candidates.append(moment)
        moment += timedelta(minutes=INTERVAL)
    return candidates[rng.randrange(len(candidates))]


# ---------------------------------------------------------------- 造数据

def _record(node_id: str, moment: datetime, temperature: float,
            humidity: float) -> dict:
    """一条记录。status 一律现算，不接受外部传入。"""
    return {
        "nodeId": node_id,
        "time": moment.strftime(TIME_FORMAT),
        "temperature": temperature,
        "humidity": humidity,
        "status": rules.judge_status(temperature, humidity),
        "source": SOURCE,
    }


def build_node(rng: random.Random, node_id: str, day: Date,
               hot: tuple | None = None,
               humid: datetime | None = None) -> list[dict]:
    """一个节点这一天的全部采样点。

    hot 是 (第一个异常采样点, 最后一个异常采样点)，【两端都算在内】——
    「持续 40 分钟」= 这两端相差 40 分钟，中间 9 个点（13:50 到 14:30）。

    rng 在每个采样点上固定抽 2 个数（温度和湿度的基准值），抽完再看要不要被
    事件盖掉。**不管有没有事件都照抽** —— 不然事件窗口一变，后面所有采样点
    用到的随机数就全错位了，改一个参数等于把整份数据搅乱，没法解释
    「到底换了什么导致摘要变了」。
    """
    rows = []
    for moment in sample_times(day):
        temperature = round(rng.uniform(BASE_TEMPERATURE[0] - BASE_TEMPERATURE[1],
                                       BASE_TEMPERATURE[0] + BASE_TEMPERATURE[1]), 1)
        humidity = round(rng.uniform(BASE_HUMIDITY[0] - BASE_HUMIDITY[1],
                                    BASE_HUMIDITY[0] + BASE_HUMIDITY[1]), 1)

        if hot is not None and hot[0] <= moment <= hot[1]:
            temperature = round(rng.uniform(*HOT_TEMPERATURE), 1)
        elif humid is not None and moment >= humid:
            # 偏湿段一路铺到这一天结束，所以没有结束时刻 —— 摘要里那句
            # 「目前仍未恢复」就是从这儿来的。
            # 温度压到 26 ℃ 以下：温度一过 30 就先判偏热了（统一规则是
            # 按顺序判、前面命中就不再往下看），这个事件就不再是「偏湿」。
            humidity = round(rng.uniform(*HUMID_HUMIDITY), 1)
            temperature = round(rng.uniform(*HUMID_TEMPERATURE), 1)

        rows.append(_record(node_id, moment, temperature, humidity))
    return rows


def build_rows(seed: int = SEED, day_text: str = DAY,
               hot_start: str | None = None, humid_start: str | None = None,
               hot_minutes: int = HOT_MINUTES) -> list[dict]:
    """三个节点这一天的所有行，按（时间, 节点名）排好。

    按时间交错着排，不是「一个节点写完了再写下一个」—— 真实的多节点导出就是
    三个宿舍的消息混在一起按时序落下来的，day_sim.csv 也照这个来。
    这样 daily_summary 那边必须真的「按节点分组」才能算对，分组写漏了立刻现形。
    """
    day = Date.fromisoformat(day_text)
    rows = []

    for node_id in NODE_IDS:
        # 每个节点一条独立的随机流。用 (seed, node_id) 拼出来的字符串做种子：
        # random.seed(str) 内部走 sha512，跨进程、跨机器都稳定。
        # 换成 hash(node_id) 就完了 —— 字符串哈希每个进程都不一样
        # （PYTHONHASHSEED），同一份参数跑两次能出两份数据。
        rng = random.Random(f"dormmate-day-{seed}-{node_id}")

        hot = None
        humid = None

        if node_id == HOT_NODE:
            # 先照常抽一个，再决定用哪个 —— 这样传不传 --hot-start，
            # 这个节点消耗的随机数个数都一样，抖动不会跟着变。
            start = pick_start(rng, day, HOT_WINDOW)
            if hot_start:
                start = align(datetime.combine(day, parse_hm(hot_start)))
            hot = (start, start + timedelta(minutes=hot_minutes))

        if node_id == HUMID_NODE:
            start = pick_start(rng, day, HUMID_WINDOW)
            if humid_start:
                start = align(datetime.combine(day, parse_hm(humid_start)))
            humid = start

        rows += build_node(rng, node_id, day, hot, humid)

    # 同一条 time 上按节点名定序：用固定的码元序，不跟着区域设置走
    rows.sort(key=lambda row: (row["time"], row["nodeId"]))
    return rows


# ------------------------------------------- Step 9-1：平时历史 + 待判断新数据

def history_day(day_text: str = DAY) -> Date:
    """这两份数据自己那一天：day_sim 的【后一天】。

    为什么不跟 day_sim 同一天：同一天同一时刻，day_sim.csv 里 dorm-a 是一个读数、
    这份历史里是另一个读数（两条随机流各抽各的），并排一放像在吵架 ——
    而「为什么同一个宿舍在 08:05 有两个温度」是个解释不清的问题。
    错开一天就没这回事：两份数据各说各的，各自都是自洽的。
    """
    return Date.fromisoformat(day_text) + timedelta(days=1)


def history_times(day: Date, count: int = HISTORY_COUNT) -> list[datetime]:
    """历史那 40 个采样时刻：HISTORY_START 起，每 INTERVAL 分钟一个。

    从 08:00 起、40 个点、5 分钟一个 —— 末点正好 11:15，新数据接着从 11:20 开始。
    起点写成常数（不是 00:00）：白天有人在宿舍的时段读起来更像「平时的记录」，
    而且和 day_sim 那边的事件时刻（14:10 / 21:30）不挨着，不会让人误以为有关联。
    """
    first = datetime.combine(day, parse_hm(HISTORY_START))
    return [first + timedelta(minutes=INTERVAL * index) for index in range(count)]


def build_history(seed: int = SEED, day_text: str = DAY) -> list[dict]:
    """dorm-a 的 40 条「平时」历史，按时间先后排好。

    单独一条随机流（种子里带 history 字样），不去碰 day_sim 那三条 ——
    否则改这里一个常数，data/day_sim.csv 就会跟着变，而那份文件的测试是
    逐字节比对的，改完之后「是谁动了它」得查半天。
    """
    rng = random.Random(f"dormmate-history-{seed}-{HISTORY_NODE}")
    return [
        _record(HISTORY_NODE, moment,
                round(rng.uniform(*HISTORY_TEMPERATURE), 1),
                round(rng.uniform(*HISTORY_HUMIDITY), 1))
        for moment in history_times(history_day(day_text))
    ]


def build_new_samples(day_text: str = DAY) -> list[dict]:
    """6 条「待判断新数据」，接着历史的末点往下排。

    开始时刻是由历史推出来的（末点 + 一个间隔），不写死：改了 HISTORY_COUNT
    或者 INTERVAL，新数据跟着走，不会突然和历史最后一条撞在同一个时刻上 ——
    「新数据不能混进历史里」这条要求，第一个该守住的就是时间不重叠。

    没有 seed 参数：这 6 条是题目给的输入，一个随机数都不抽。
    """
    first = history_times(history_day(day_text))[-1] + timedelta(minutes=INTERVAL)
    return [
        _record(HISTORY_NODE, first + timedelta(minutes=INTERVAL * index),
                temperature, humidity)
        for index, (temperature, humidity) in enumerate(NEW_SAMPLES)
    ]


# ---------------------------------------------------------------- 写文件

def to_csv_text(rows: list[dict]) -> str:
    """行列表 -> CSV 文本（不含 BOM，换行是 CRLF）。

    行尾用 CRLF：RFC 4180 就是这么定的，Excel 打开也规矩。
    只写 CRLF、不写裸 LF —— 混着来会让 diff 里每一行都变成改动。
    """
    lines = [",".join(COLUMNS)]
    lines += [",".join(str(row[name]) for name in COLUMNS) for row in rows]
    return "\r\n".join(lines) + "\r\n"


def write_csv(rows: list[dict], out_path: Path) -> Path:
    """写 CSV，带 UTF-8 BOM。

    带 BOM 是因为网页「导出 CSV」那份就是从 BOM 开始的，analysis.load() 用
    utf-8-sig 读它。这里跟着来，读文件的代码就只有一条路要走。
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(to_csv_text(rows), encoding="utf-8-sig", newline="")
    return out_path


def daily_text(rows: list[dict]) -> str:
    """把刚造出来的行喂给 daily_summary，拿回那句摘要。

    没有先把 rows 写成 CSV 再读回来：这里要的是「不打文件也能先看一眼」。
    算法是同一套（daily_summary 那几个函数），所以这里说的话和报告里写的话
    必然一致 —— 两份摘要说法不一样是最难查的一类错。
    """
    import pandas as pd

    from analysis import daily_summary

    frame = pd.DataFrame(rows)
    # _record() 的 status 本来就是 rules.judge_status 算出来的，这里原样当作
    # rule_status 用。daily_summary 只认 rule_status 这一列（那是「规则重算过」
    # 的固定名字），所以不能少了这一步。
    frame["rule_status"] = frame["status"]
    events = daily_summary.find_daily_events(frame)
    return daily_summary.render_daily_summary(events, sorted(set(frame["nodeId"])))


# ---------------------------------------------------------------- 入口

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="生成 DormMate「模拟日数据」（一天，三个宿舍，固定随机种子）",
    )
    parser.add_argument("--seed", type=int, default=SEED,
                        help=f"随机种子（默认 {SEED}），换一个摘要就跟着变")
    parser.add_argument("--date", default=DAY,
                        help=f"哪一天，YYYY-MM-DD（默认 {DAY}）")
    parser.add_argument("--hot-start", default=None,
                        help="偏热事件的开始时刻 HH:MM（默认在 "
                             f"{HOT_WINDOW[0]}~{HOT_WINDOW[1]} 里按种子挑）")
    parser.add_argument("--humid-start", default=None,
                        help="偏湿事件的开始时刻 HH:MM（默认在 "
                             f"{HUMID_WINDOW[0]}~{HUMID_WINDOW[1]} 里按种子挑）")
    parser.add_argument("--hot-minutes", type=int, default=HOT_MINUTES,
                        help=f"偏热事件持续多少分钟（默认 {HOT_MINUTES}）。"
                             f"取 {INTERVAL} 的整数倍 —— 采样点每 {INTERVAL} 分钟一个，"
                             "不整除的部分落不到点上，实际时长会短一截")
    parser.add_argument("--out", default=str(DEFAULT_OUT),
                        help=f"日数据写到哪（相对路径按项目根解析，默认 {DEFAULT_OUT}）。"
                             f"另外两份（{HISTORY_NAME}、{SAMPLES_NAME}）"
                             "也写在同一个目录里")
    args = parser.parse_args(argv)

    try:
        rows = build_rows(args.seed, args.date, args.hot_start, args.humid_start,
                          args.hot_minutes)
        history = build_history(args.seed, args.date)
        samples = build_new_samples(args.date)
    except ValueError as exc:
        # 时间格式写错了（--date 或 --hot-start / --humid-start）。
        # parser.error() 会打印用法再退出，比抛一个 traceback 让人去猜是哪个参数强。
        parser.error(str(exc))

    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = ROOT / out_path
    # 另两份跟着日数据走：同一个目录、固定的文件名。这样 --out 一挪，
    # 三份一起挪，不会出现「日数据在临时目录、历史还写在项目里」这种事
    # （测试跑 main() 的时候就是靠这条不往仓库里写东西）。
    history_path = out_path.with_name(HISTORY_NAME)
    samples_path = out_path.with_name(SAMPLES_NAME)

    write_csv(rows, out_path)
    write_csv(history, history_path)
    write_csv(samples, samples_path)

    print(f"种子 {args.seed}　日期 {args.date}　间隔 {INTERVAL} 分钟/点")
    print(f"节点 {len(NODE_IDS)} 个：{'、'.join(NODE_IDS)}")
    print(f"共 {len(rows)} 行（每个节点 {len(rows) // len(NODE_IDS)} 行）")
    print(f"已写入：{out_path}")
    print(f"已写入：{history_path}"
          f"（{HISTORY_NODE} 的 {len(history)} 条平时历史，{history[0]['time']} 起）")
    print(f"已写入：{samples_path}"
          f"（{len(samples)} 条待判断新数据，{samples[0]['time']} 起）")

    # 顺手把这份数据算出来的摘要打出来。这一步就是为了让人看见：
    # 换 --seed 或 --hot-start 之后摘要确实跟着变了。
    # 「改了数据摘要却没变」是最难发现的一类错 —— 报告照样生成、照样能打开。
    print()
    print("今日摘要：")
    print(f"  {daily_text(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
