"""Step 9-2：C1 + C2 —— Isolation Forest 与固定规则的对照。

用一段「平时的历史」（data/dorm-a_history_sim.csv）当基准训练一个 Isolation
Forest，再拿它去判断一批新读数（data/new_samples.csv）「像不像平时见过的」；
同时把固定规则（rules.judge_status）的判断并排放着，看两者什么时候不一致。

跑一遍看看：

    py -3.14 analysis/ml.py
    py -3.14 analysis/ml.py data/dorm-a_history_sim.csv data/new_samples.csv

【模型只用历史那一份 fit】这不是图省事，是这一步的全部意义。把新数据也丢进
fit，模型就会用「新数据自己」来定义什么叫正常 —— 一条离谱的读数会顺手把正常
范围拉大一点，于是它自己就不那么离谱了。9-1 把两份数据分开放，防的正是这件事。

【两种口径各自在说什么】

  * rules.judge_status 说的是「温湿度有没有越过那三条线」（18 / 30 / 75）。
    它只有三个数字，跟这个宿舍平时读数长什么样无关，换一批数据也还是那三条线。
  * Isolation Forest 说的是「这条读数跟历史里那些比，有多容易被单独隔出来」。
    它不知道什么叫「偏热」，只知道什么叫「跟平时不一样」。

不一致的地方正是这一步要看的地方：29 ℃ / 72 % 一条线都没越（规则说正常），
可历史一直是 24~26 ℃ / 55~65 %，它离那片云很远 —— ML 会说「与历史明显不同」。

参数就是题目给的三个，一个都没动：n_estimators=100、contamination="auto"、
random_state=42。**没有为了凑出不一致去改参数或数据** —— 不一致是真出现了才报，
没出现就如实说没出现（见 render_comparison）。random_state 定死之后，
同一份数据跑多少次，这张对照表一个字都不差。

【两种不一致，方向不一样，都要报】
  ① 规则说正常、ML 说与历史明显不同 —— 题目要找的就是这一种（表里专门标出来）。
  ② 规则说异常、ML 说接近常态 —— 反过来那一种：越过了线，但这条线在历史里
     出现过很多次（比如历史本来就常常偏湿），ML 不觉得稀奇。
  两种都算「不一致」，所以统计的时候两边都数。

【门槛是 0，不是 model.offset_】predict 给 ±1 的规则是「decision_function 算出来
的分数 < 0」（sklearn 1.9.1 的源码里就一句 is_inlier[decision_func < 0] = -1）。
模型上还有个 offset_，contamination="auto" 时它等于 -0.5 —— 但那是 score_samples
那条老口径用的数，不是 predict 的切法。照 offset_ 写说明书的话，屏幕上会出现
「分数 -0.045 也算正常」这种和旁边那张表正好相反的话。所以这个门限定成常量
ML_THRESHOLD，并且每次都由 _check_threshold() 照着实际标签核一遍：将来 sklearn
换了切法，当场报错，而不是让那句话悄悄变成假的。

【「与历史明显不同」没听上去那么重】contamination="auto" 是不指定异常比例，
门槛于是不落在历史那片云的外沿上：拿模型回看它自己学的那 40 条历史，40 条里
18 条也会被判 -1。所以这句的意思是「分数落在门槛的另一侧」，不是「这条读数
离谱」—— 命令行上把 18 这个数一并打出来，表里给出分数也是为了让人自己看差多少。
26 ℃ / 62 % 那条分数 -0.0564，离门槛只差一点点；29 ℃ / 72 % 是 -0.123，
那才是真的走出去了。

Step 9-4 的「小样本实验」在文件后半段：同样这两份数据，只用历史的前 8 条训练一个
模型，同一批新数据再判一次，和整段历史训出来的结果并排。跑 `py -3.14 analysis/ml.py`
时接在对照表后面一起打出来。它只报数，不下结论 —— 哪一条判得不理想、为什么，
是看过输出之后写的（那份手写的说明放在 data/ml_note.txt，由 analysis.py 放进报告）。

用 py -3.14 而不是 python：PATH 上的 python 是 32 位解释器，pandas / scikit-learn
装不上（scikit-learn 依赖的 scipy 同样没有 32 位 Windows 包）。
"""

from __future__ import annotations

import sys
from pathlib import Path

# 项目根 = 本文件的上一级。每个模块开头都自己推一遍，不靠当前工作目录 ——
# 本模块会被 analysis.py import、也会被测试单独 import，谁先谁后说不好。
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from analysis import rules  # noqa: E402  —— 必须在上面调整完 sys.path 之后

__all__ = [
    "run_ml",
    "small_sample_experiment",
    "merge_sides",
    "build_model",
    "compare_rows",
    "find_mismatches",
    "find_reverse",
    "render_comparison",
    "ml_text",
    "FEATURES",
    "MODEL_PARAMS",
    "ML_INLIER",
    "ML_OUTLIER",
    "ML_INLIER_TEXT",
    "ML_OUTLIER_TEXT",
    "ML_STATUS_NORMAL",
    "ML_STATUS_ABNORMAL",
    "ML_STATUS",
    "ML_THRESHOLD",
    "MISMATCH_TEXT",
    "NO_ROWS_TEXT",
    "SMALL_TRAIN_ROWS",
    "DIFFERS_TEXT",
]

# 交给模型的两列。只这两列，不加派生特征（差、均值之类）——
# 题目说的就是「拿温湿度这两维跟历史比」，多造几个特征会让「为什么被判异常」
# 变得说不清：分数是六维空间里的距离，可人只能看见温度和湿度。
FEATURES = ["temperature", "humidity"]

# 题目给的三个参数，原样放着。改这里的数就等于改结论，不能顺手「优化」。
MODEL_PARAMS = {"n_estimators": 100, "contamination": "auto", "random_state": 42}

# sklearn 的约定：predict 给 1 = 正常，-1 = 异常。
# 写成常量而不是在代码里散着写 1 / -1 —— 「哪个数是异常」写反过一次就很难看出来，
# 因为两种写法都能跑出结果。
ML_INLIER = 1
ML_OUTLIER = -1

ML_INLIER_TEXT = "接近历史常态"
ML_OUTLIER_TEXT = "与历史明显不同"

ML_TEXT = {ML_INLIER: ML_INLIER_TEXT, ML_OUTLIER: ML_OUTLIER_TEXT}

# 落进 CSV / 快照的**机器可读**判词（Phase8 D5）。和上面那两句中文是两码事：
#   * 1 / -1        —— predict() 的家，sklearn 内部的说法，只在进程里活。
#   * normal/abnormal —— 写进 data/history.csv 第 6 列和 state 快照的家。
#   * 接近历史常态   —— 给人看的家（report/ml_result.json 的 mlStatus、快照的 mlText）。
# 为什么要 ASCII 而不是直接用中文那两句：CSV 是**数据**，读它的是
# analysis/make_report.py 的 ml_section()，那边的判据是
# `label.lower() in ("normal", "正常", "ok")` —— 它不是全项目唯一的判据，
# 但把「接近历史常态」写进去的话，那一句会把这个词判成**不正常**，
# 于是每一行都高亮成「两边不一致」。ASCII 的两个词那条判据本来就能认，
# 而且和已经提交的 data/constructed_samples.csv 是同一套写法。
ML_STATUS_NORMAL = "normal"
ML_STATUS_ABNORMAL = "abnormal"
ML_STATUS = {ML_INLIER: ML_STATUS_NORMAL, ML_OUTLIER: ML_STATUS_ABNORMAL}

# predict 的判决门槛：分数低于它的判 -1。sklearn 1.9.1 的 IsolationForest.predict
# 就是拿 0 切的（is_inlier[decision_func < 0] = -1），跟 model.offset_ 没关系 ——
# contamination="auto" 时 offset_ 是 -0.5，照它写会写出和实际标签对不上的说明。
# 写死一个常量是有代价的（库换了切法这句话就变成假的），所以下面有
# _check_threshold() 每次拿实际标签核一遍兜着。
ML_THRESHOLD = 0.0

# 对照表「备注」列里的短标记。表和句子说的是同一件事的两种长度：
# 句子里写全「规则判断为正常、ML 认为与历史明显不同」，表里那格放不下。
MISMATCH_TEXT = "规则说正常，ML 说不同"

# 一条新数据都没有时说的话。这时候说「未出现不一致」是句真话，但是在骗人 ——
# 和「还没有收到数据 ≠ 都正常」是同一条：没对照过，不等于对照完了没差别。
NO_ROWS_TEXT = "新数据一条都没有，没有可对照的东西。"

DEFAULT_HISTORY = ROOT / "data" / "dorm-a_history_sim.csv"
DEFAULT_NEW = ROOT / "data" / "new_samples.csv"

# 小样本实验（Step 9-4）用几条历史训练。题目说的是前 8 条。
SMALL_TRAIN_ROWS = 8

# 并排表「备注」那一列的字：同一批新数据，两种训练量给出的判断不一样。
#
# 【不能借 MISMATCH_TEXT 来用】那一串说的是主表里的「规则说正常，ML 说不同」，
# 命令行上有一处按出现次数数它的检查（tests/test_ml.py 的 test_不一致的行有标记）。
# 借来用的话，主表那两处标记会被数成四处。两件事本来也不是一回事：这一列说的是
# 「换了个训练量，ML 自己改口了」，跟规则怎么看一点关系都没有。
DIFFERS_TEXT = "两边判断不同"

NORMAL = rules.STATUS_NORMAL


# ---------------------------------------------------------------- 小工具

def _clock(text: str) -> str:
    """'2026-09-23 11:20:00' -> '11:20'。

    和 daily_summary._clock 同一个切法。那是个两行的助手，为一个下划线名字
    跨模块 import 不值当；格式不对时切出来的是原串，看得见问题在哪。
    """
    return text[11:16] if len(text) >= 16 else text


def ml_text(label) -> str:
    """1 -> 「接近历史常态」，-1 -> 「与历史明显不同」。

    认不出来的标签原样写出来，不猜一个说法 —— predict 只会给 ±1，
    真出现别的值说明调用方传错了东西，这时候应该看见那个值。
    """
    return ML_TEXT.get(int(label), f"(不认识的标签 {label})")


def score_is_outlier(score) -> bool:
    """分数是不是在门槛的另一侧（该判 -1）。"""
    return float(score) < ML_THRESHOLD


def _check_threshold(labels, scores) -> None:
    """核对一遍预测出来的 ±1 确实就是「分数 < 0」切出来的。

    这个检查是为了让上面那句说明不至于变成假话：ML_THRESHOLD 是个写死的常量，
    将来 sklearn 换一种切法（这个库在 offset_ 和 0 之间就换过一次），
    命令行上「分数低于它就判 -1」会继续照常打印，而旁边的标签已经不是那个意思了。
    报错而不是猜一个值：真到那一天，要的是有人去看 predict 现在怎么切的。
    """
    for label, score in zip(labels, scores):
        expected = ML_OUTLIER if score_is_outlier(score) else ML_INLIER
        if int(label) != expected:
            raise RuntimeError(
                f"sklearn 的 predict 给的是 {int(label)}，而分数 "
                f"{float(score):.4f} 按门槛 {ML_THRESHOLD:g} 该给 {expected} ——"
                "predict 的判决规则变了（不再等于「分数 < 0」），"
                "analysis/ml.py 里 ML_THRESHOLD 那句说明要跟着改。"
            )


# ---------------------------------------------------------------- 对照（纯函数）

def compare_rows(records, labels, scores) -> list[dict]:
    """规则判断和 ML 判断并排成对照行（纯函数，不碰 pandas / sklearn）。

    records 是 [(nodeId, time, temperature, humidity, rule_status), ...]，
    labels / scores 是模型逐条给出的结果，顺序和 records 对齐。

    每行给出两个布尔值 rule_normal / ml_normal，而不是只给一句现成的说法：
    「两边一致吗」有四种组合（正常/异常 × 正常/异常），存成两个布尔值的话
    两个方向的不一致都能现算出来，存成一个字符串就只能认出其中一种。

    数字都转成内置类型（int / float）：numpy 的 float64 不是 JSON 能直接
    序列化的类型，而这份结果是要交给报告那一侧用的。
    """
    rows = []
    for record, label, score in zip(records, labels, scores):
        node_id, moment, temperature, humidity, rule_status = record
        rule_normal = rule_status == NORMAL
        ml_normal = int(label) == ML_INLIER
        rows.append({
            "nodeId": node_id,
            "time": moment,
            "temperature": temperature,
            "humidity": humidity,
            "rule_status": rule_status,
            "rule_normal": rule_normal,
            "ml_label": int(label),
            "ml_normal": ml_normal,
            "ml_text": ml_text(label),
            # 分数保留 4 位小数：这个数要同时出现在命令行和报告里，
            # 留全精度的话两边打印出来的长度不一样，看着像两个值。
            "score": round(float(score), 4),
            "mismatch": rule_normal and not ml_normal,
        })
    return rows


def find_mismatches(rows) -> list[dict]:
    """规则说正常、ML 说与历史明显不同的行 —— 题目要找的就是这一种。"""
    return [row for row in rows if row["mismatch"]]


def find_reverse(rows) -> list[dict]:
    """反过来那一种：规则说异常、ML 说接近常态。

    不算「要找的」，但报「不一致有几条」的时候得把它数进去 ——
    只数一个方向的话，遇到反过来的情况会报「未出现不一致」，那就说反了。
    """
    return [row for row in rows if not row["rule_normal"] and row["ml_normal"]]


def _brief(row) -> str:
    """句子里指某一条数据用的一小串：11:30（29 ℃ / 72 %）。"""
    return (f"{_clock(row['time'])}（"
            f"{row['temperature']:g} ℃ / {row['humidity']:g} %）")


def render_comparison(rows) -> str:
    """把对照结果说成一句话。

    和 daily_summary 那句摘要一样，算一次、渲染两次：命令行和报告共用这一句。
    各拼一份的话，屏幕上和报告里迟早变成两句话 —— 而那种不一致没人会去核对。

    「一条新数据都没有」和「对照完了没差别」必须说成两句不同的话。
    """
    if not rows:
        return NO_ROWS_TEXT

    forward = find_mismatches(rows)
    reverse = find_reverse(rows)

    if not forward and not reverse:
        return (f"本次测试未出现规则与 ML 不一致：{len(rows)} 条新数据，"
                "固定规则和 Isolation Forest 的看法完全一样。")

    parts = [f"{len(rows)} 条新数据里，规则与 ML 不一致的有 "
             f"{len(forward) + len(reverse)} 条。"]
    if forward:
        parts.append("规则判断为正常、ML 认为与历史明显不同的有 "
                     + "、".join(_brief(row) for row in forward) + "。")
    if reverse:
        parts.append("规则判断为异常（"
                     + "、".join(row["rule_status"] for row in reverse)
                     + "）、ML 却认为接近历史常态的有 "
                     + "、".join(_brief(row) for row in reverse) + "。")
    parts.append("两种口径本来就会在这类数据上分岔：固定规则只看有没有越过那三条线，"
                 "ML 比的是跟平时的历史像不像。")
    return "".join(parts)


# ---------------------------------------------------------------- 读数据

def _require_rows(df, path, what: str) -> None:
    """一份数据一行都没有时说人话。

    空文件交给 sklearn 报的是「Found array with 0 sample(s)」—— 看得出是空的，
    看不出是哪个文件空的。历史那份尤其要说清楚：它是基准，没有基准就无从对照。
    """
    if len(df) == 0:
        raise ValueError(f"{what}里一行数据都没有（{path} 只有表头），算不出对照表。")


def _feature_frame(df, path, what: str):
    """取温湿度两列交给模型。空着的值在这里拦下并说人话。

    只查空值。缺列和「不是数字」都由 analysis.load() 把关（那是全项目唯一读
    CSV 的地方，查在那儿三条路都用得上），这里再查一遍就是一段永远不会触发的
    代码 —— 而不会触发的检查比没有检查更糟：看代码的人会以为它管用。

    空值不同：load() 允许空格子（空格子有含义，会算成「缺失」），但算距离算
    不了空格子。不拦的话，sklearn 报的是「Input X contains NaN」——看得出是
    NaN，看不出是哪一条，而「哪一条缺了值」才是要找的东西。
    """
    frame = df[FEATURES]
    if frame.isna().any().any():
        index = frame[frame.isna().any(axis=1)].index[0]
        moment = (str(df.loc[index, "time"]) if "time" in df.columns
                  else f"第 {index + 1} 行")
        raise ValueError(f"{what}里 {moment} 这条的温湿度是空的（{path}）—— "
                         "缺一个值就算不出它离历史有多远。")
    return frame


def _records(df) -> list[tuple]:
    """DataFrame -> [(nodeId, time, temperature, humidity, rule_status), ...]。

    状态取的是 analysis.add_rule_status() 重算出来的那一列，不是 CSV 里那列
    原始 status —— 全项目只有这一条口径（CSV 是网页写的，规则实现可能不同步，
    真不同步了该由 analysis.find_mismatches() 报出来，不该让这边跟着一起错）。

    延迟 import 的理由和 daily_summary 一样：analysis.py 以后要 import 本模块
    拼报告，顶层互相 import 会谁也先进不来。
    """
    from analysis import analysis as report

    has_node = "nodeId" in df.columns
    return [
        (report._clean(row.nodeId) if has_node else "",
         report._clean(row.time),
         report._number(row.temperature),
         report._number(row.humidity),
         report._clean(row.rule_status))
        for row in df.itertuples()
    ]


def _load_pair(history_csv, new_csv):
    """两份 CSV -> (history, new, history_path, new_path)。

    读法和复核都走 analysis.py：CSV 怎么读（utf-8-sig 吃 BOM、缺列报人话）、
    status 一律用规则重算，这两条各只有一处实现。run_ml 和
    small_sample_experiment 共用这一份 —— 各写一遍的话，两张表里的「规则」
    那一列迟早会不是同一个口径。

    「一份是空的」也在这儿拦下（_require_rows）。
    """
    from analysis import analysis as report

    history_path = report.resolve_csv(str(history_csv))
    new_path = report.resolve_csv(str(new_csv))

    history = report.add_rule_status(report.load(history_path))
    new = report.add_rule_status(report.load(new_path))

    _require_rows(history, history_path, "历史")
    _require_rows(new, new_path, "新数据")
    return history, new, history_path, new_path


# ---------------------------------------------------------------- 模型

def build_model(x_history):
    """在历史那一份上 fit 一个 Isolation Forest，返回训练好的模型。

    没装 scikit-learn 时给一句人话（和 analysis._pyplot() 报「没装 matplotlib」
    同一个路数），而不是甩一串 traceback。

    没有做标准化：Isolation Forest 每一刀都是在某一维的取值范围内随机切的，
    温度整体乘个系数不会改变切出来的形状，做一遍 min-max 只是多一步。
    """
    try:
        from sklearn.ensemble import IsolationForest
    except ImportError as exc:
        raise SystemExit(
            f"没装 scikit-learn：{exc}\n"
            "装一下（必须 64 位解释器）：py -3.14 -m pip install scikit-learn"
        ) from exc

    model = IsolationForest(**MODEL_PARAMS)
    model.fit(x_history)
    return model


def _flagged(forest, frame) -> int:
    """模型回看自己学过的那些，判了几条 -1。

    写成一趟数而不是 `(forest.predict(frame) == ML_OUTLIER).sum()`：后者要
    predict 返回的是 numpy 数组（sklearn 确实给数组），换成别的实现——哪怕是
    测试里一个假模型给个列表——`list == -1` 会当场变成一个 False，
    再 .sum() 就是「bool 没有 sum」这种和本意毫无关系的报错。
    """
    return sum(1 for label in forest.predict(frame) if int(label) == ML_OUTLIER)


def _judge(forest, x_new, records) -> list[dict]:
    """训好的模型判一批新数据 -> 对照行。

    predict、decision_function、门槛核对这三步合成一处：小样本实验要拿两个
    训练量各判一次（见 small_sample_experiment），散着抄两遍的话，第二套漏掉
    _check_threshold 就会悄悄发出去 —— 而命令行上那句「分数 < 0 判 -1」照常打印。
    """
    labels = forest.predict(x_new)
    scores = forest.decision_function(x_new)
    _check_threshold(labels, scores)
    return compare_rows(records, labels, scores)


def run_ml(history_csv, new_csv) -> dict:
    """历史当基准、新数据待判断，跑一遍对照。返回的结果只有内置类型，
    可以直接 json.dumps，也可以直接交给报告那一侧拼区块。

    返回的字典：
        history_file / new_file      两个文件的绝对路径
        history_rows / new_rows      各多少条
        history_flagged              模型回看历史自己，40 条里判了几条 -1（见下）
        features                     用了哪两列
        params                       模型参数（原样带上，报告里要写出来）
        threshold                    判决门槛（分数低于它判 -1）
        rows                         逐条对照：原始值 + 给人看的说法
        mismatches                   规则说正常、ML 说不同的行
        reverse                      规则说异常、ML 说接近常态的行
        text                         一句话（命令行和报告共用）

    关于 history_flagged：拿训练好的模型回头看它自己学的那 40 条历史，也会有
    一批被判 -1（contamination="auto" 不指定异常比例，门槛就不在云的外沿上）。
    这个数不参与任何判断，但它是这张表的读法说明 —— 不知道它的话，
    「ML 认为与历史明显不同」很容易被读成「这条读数离谱」。
    """
    history, new, history_path, new_path = _load_pair(history_csv, new_csv)

    x_history = _feature_frame(history, history_path, "历史")
    x_new = _feature_frame(new, new_path, "新数据")

    forest = build_model(x_history)
    rows = _judge(forest, x_new, _records(new))

    return {
        "history_file": str(history_path),
        "new_file": str(new_path),
        "history_rows": len(history),
        "new_rows": len(new),
        "history_flagged": _flagged(forest, x_history),
        "features": list(FEATURES),
        "params": dict(MODEL_PARAMS),
        "threshold": ML_THRESHOLD,
        "rows": rows,
        "mismatches": find_mismatches(rows),
        "reverse": find_reverse(rows),
        "text": render_comparison(rows),
    }


# ---------------------------------------------------------------- 小样本实验（Step 9-4）

def merge_sides(rows_full, rows_small) -> list[dict]:
    """两套判断逐条并排（纯函数，不碰 pandas / sklearn）。

    两个入参是 compare_rows() 两次的输出：一份是整段历史训出来的，
    一份是只用前几行训出来的。判的是**同一批新数据**，所以顺序一样、条数一样。

    两套的键名会撞（都有 ml_text / score / ml_normal），并排时各加一个前缀：
    full_ 是完整那一套，small_ 是小样本那一套。原始的那几列（时刻、读数、
    规则状态）只留一份 —— 两边判的是同一条数据，存两份迟早会对不上。

    differs 是这张表存在的理由：它比的是**两个模型**的看法，跟规则无关。
    规则怎么看是 full_mismatch / small_mismatch 那两个（各自表里高亮的判据）。
    """
    if len(rows_full) != len(rows_small):
        raise ValueError(
            f"两套判断的条数不一样（{len(rows_full)} 对 {len(rows_small)}）——"
            " 能并排的前提是它们判的是同一批新数据，条数对不上说明调用方拿错了东西。"
        )

    merged = []
    for full, small in zip(rows_full, rows_small):
        row = {key: full[key] for key in
               ("nodeId", "time", "temperature", "humidity",
                "rule_status", "rule_normal")}
        for prefix, side in (("full", full), ("small", small)):
            row[prefix + "_text"] = side["ml_text"]
            row[prefix + "_score"] = side["score"]
            row[prefix + "_normal"] = side["ml_normal"]
            # 这一套里规则和 ML 说不到一块儿（两个方向都算，和表里高亮一个判据）
            row[prefix + "_mismatch"] = side["rule_normal"] != side["ml_normal"]
        row["differs"] = full["ml_normal"] != small["ml_normal"]
        merged.append(row)
    return merged


def small_sample_experiment(history_csv, new_csv,
                            train_rows=SMALL_TRAIN_ROWS) -> dict:
    """只用历史的前 N 条训练，同一批新数据再判一次，和用整段历史的结果并排。

    返回的字典（命令行拿它打印）：
        history_rows / train_rows    历史一共几条、这一套只用了几条
        same_as_full                 训练行数和整段历史一样多（没有「小」可言了）
        history_flagged              完整模型回看它学过的那些，判了几条 -1
        train_flagged                小样本模型回看它学过的那些，判了几条 -1
        rows                         逐条并排，见 merge_sides
        differs                      两个模型看法不一样的行
        full_text / small_text       两套各自的结论那句话（render_comparison）
        full_inconsistent / small_inconsistent
                                     两套各自「规则与 ML 不一致」的条数（两个方向都算）
        params / threshold           两个模型共用的参数和判决门槛

    【完整那一套不另算一遍】它就是把 run_ml() 的结果拿来用：命令行上面那张表、
    报告里那张表、这里的「完整」那一列，三处说的必须是同一组数。各算一遍的话，
    参数、随机种子、读法任何一处不同都会让它们分岔 —— 而那种不一致没人会去核对。

    【两个模型的参数一模一样】连 random_state=42 都一样，差别只有训练行数。
    种子各给各的话，「判断不同」就分不清是样本少了还是随机流不一样了；
    这一节要看的正是样本量的影响，别的变量得按住。

    【「前 N 条」是文件里的前 N 行】按 CSV 的行序取，不按时间重排 ——
    重排的话「前 8 条」会随数据里的时间戳变，而这里要的是一个能重复的实验。
    行序和 FeatureFrame 的列序都不会变，所以取 x_history 的前 N 行和
    history.head(N) 是同一批数据。
    """
    if train_rows < 1:
        raise ValueError(
            f"小样本实验至少要 1 条训练数据，给的是 {train_rows} ——"
            " 一条都没有就 fit 不出模型（sklearn 只会报「0 sample(s)」）。"
        )

    history, new, history_path, new_path = _load_pair(history_csv, new_csv)

    x_history = _feature_frame(history, history_path, "历史")
    x_new = _feature_frame(new, new_path, "新数据")
    records = _records(new)

    full_forest = build_model(x_history)
    full_rows = _judge(full_forest, x_new, records)

    # 小样本那一侧：同一份历史，只取前 N 行。历史不够 N 条时有几条用几条 ——
    # 这不是错误，报出来的是实际用了几条（train_rows）。
    x_small = x_history.head(train_rows)
    small_forest = build_model(x_small)
    small_rows = _judge(small_forest, x_new, records)

    rows = merge_sides(full_rows, small_rows)
    return {
        "history_file": str(history_path),
        "new_file": str(new_path),
        "history_rows": len(history),
        "new_rows": len(new),
        "train_rows": len(x_small),
        "same_as_full": len(x_small) == len(history),
        "history_flagged": _flagged(full_forest, x_history),
        "train_flagged": _flagged(small_forest, x_small),
        "params": dict(MODEL_PARAMS),
        "threshold": ML_THRESHOLD,
        "rows": rows,
        "differs": [row for row in rows if row["differs"]],
        "full_text": render_comparison(full_rows),
        "small_text": render_comparison(small_rows),
        "full_inconsistent": (len(find_mismatches(full_rows))
                              + len(find_reverse(full_rows))),
        "small_inconsistent": (len(find_mismatches(small_rows))
                               + len(find_reverse(small_rows))),
    }


# ---------------------------------------------------------------- 入口

# 对照表的列。数字列右对齐（见 _table 的 right 参数），这样位数不同也对得齐；
# 「备注」那一列只在不一致的行上有字，空着就是一致。
TABLE_HEADER = ["时间", "温度 ℃", "湿度 %", "规则", "ML", "分数", "备注"]


def _small_header(result) -> list:
    """并排表的表头。两列数各自的训练条数写进表头里 —— 这张表看的就是训练量。"""
    return ["时间", "温度 ℃", "湿度 %", "规则",
            f"完整 {result['history_rows']} 条", "分数",
            f"小样本 {result['train_rows']} 条", "分数", "备注"]


def _print_small_sample(result) -> None:
    """把 small_sample_experiment() 的结果并排打出来（Step 9-4）。

    数字和表格都走 analysis.py 里那一份（中文按两列宽算、31.0 打成 31）：
    上面那张对照表就是用它打的，这里再抄一份的话两张表的数字写法会各自跑偏。
    """
    from analysis import analysis as report

    print(f"小样本实验（Step 9-4）：只用历史的前 {result['train_rows']} 条训练，"
          "同一批新数据再判一次")
    print(f"　　　两个模型的参数一模一样（{_params_text(result['params'])}），"
          "差别只有训练条数")
    if result["same_as_full"]:
        # 历史本来就没几条：这时候两列是同一个模型。不说这一句的话，人会对着
        # 两列一样的数字猜「小样本到底差在哪」。
        print(f"　　　注意：历史一共就只有 {result['history_rows']} 条，"
              "「前 N 条」已经等于整段历史，这两列没有可比的东西")
    print()
    print("训练量对照：")
    for label, used, flagged in (
            (f"完整 {result['history_rows']} 条", result["history_rows"],
             result["history_flagged"]),
            (f"小样本 {result['train_rows']} 条", result["train_rows"],
             result["train_flagged"])):
        print(f"  {label}：回看自己学过的 {used} 条，"
              f"其中 {flagged} 条也会被判「{ML_OUTLIER_TEXT}」")
    print()

    print("并排对照表：")
    report._table(
        [_small_header(result)]
        + [[row["time"], report._num(row["temperature"]),
            report._num(row["humidity"]), row["rule_status"],
            row["full_text"], report._num(row["full_score"]),
            row["small_text"], report._num(row["small_score"]),
            DIFFERS_TEXT if row["differs"] else ""]
           for row in result["rows"]],
        right=(1, 2, 5, 7),
    )
    print()
    print(f"规则与 ML 不一致的条数：完整 {result['history_rows']} 条训练 "
          f"{result['full_inconsistent']} 条，"
          f"小样本 {result['train_rows']} 条训练 {result['small_inconsistent']} 条")
    changed = f"{result['new_rows']} 条里有 {len(result['differs'])} 条"
    if result["differs"]:
        changed += f"（表里标了「{DIFFERS_TEXT}」）"
    print(f"两种训练量判断不同的：{changed}")
    print()
    print("结论（同一批新数据，两种训练量各说一句）：")
    print(f"  完整 {result['history_rows']} 条训练：{result['full_text']}")
    print(f"  小样本 {result['train_rows']} 条训练：{result['small_text']}")


def _params_text(params) -> str:
    """模型参数 -> 'n_estimators=100、contamination='auto'、random_state=42'。

    从 params 里拼，不手写一遍 —— 手写的话，改了 MODEL_PARAMS 而忘了改这句话，
    屏幕上写的就不是实际用的参数了。
    """
    return "、".join(f"{name}={value!r}" for name, value in params.items())


def _main(argv: list[str] | None = None) -> int:
    import argparse

    from analysis import analysis as report

    parser = argparse.ArgumentParser(
        description="Isolation Forest 判断新数据像不像历史常态，并与固定规则对照",
    )
    parser.add_argument("history", nargs="?", default=str(DEFAULT_HISTORY),
                        help=f"当基准的历史数据（默认 {DEFAULT_HISTORY}）")
    parser.add_argument("new", nargs="?", default=str(DEFAULT_NEW),
                        help=f"待判断的新数据（默认 {DEFAULT_NEW}）")
    args = parser.parse_args(argv)

    try:
        result = run_ml(args.history, args.new)
    except ValueError as exc:
        # 空文件 / 缺列 / 有空格子。parser.error() 会打印用法再退出，
        # 比抛一个 traceback 让人去猜是哪个文件强。
        parser.error(str(exc))

    print(f"历史：{result['history_file']}（{result['history_rows']} 条）")
    print(f"新数据：{result['new_file']}（{result['new_rows']} 条）")
    print(f"模型：IsolationForest({_params_text(result['params'])}）")
    print(f"　　　fit 只用历史那一份，新数据不参与训练")
    print(f"判决门槛：分数 < {result['threshold']:g} 判 {ML_OUTLIER}"
          f"（也就是「{ML_OUTLIER_TEXT}」），越小越异常")
    # 这一行是这张表的读法说明，不是判决的一部分：门槛松到能把历史自己切掉一半时，
    # 「与历史明显不同」就不该被读成「这条读数离谱」。数不出来的话，报告里那句
    # 「ML 认为与历史明显不同」就会被当成硬结论。
    print(f"门槛松紧：拿模型回看它学过的 {result['history_rows']} 条历史，"
          f"其中 {result['history_flagged']} 条也会被判「{ML_OUTLIER_TEXT}」")
    print("　　　　contamination='auto' 不指定异常比例，门槛就不落在历史那片云的外沿上")
    print()

    print("对照表：")
    # 表格和数字都走 analysis.py 里那一份（中文按两列宽算、31.0 打成 31）：
    # 这两条规则命令行上已经有一份实现，这里再抄一份的话，两张表的数字写法
    # 会各自慢慢跑偏。
    report._table(
        [TABLE_HEADER]
        + [[row["time"], report._num(row["temperature"]),
            report._num(row["humidity"]), row["rule_status"], row["ml_text"],
            report._num(row["score"]),
            MISMATCH_TEXT if row["mismatch"] else ""]
           for row in result["rows"]],
        right=(1, 2, 5),
    )
    print()
    print("结论：")
    print(f"  {result['text']}")

    # 小样本实验（Step 9-4）：同一批数据、同一组参数，只用前 8 条历史训练再判一次。
    # 和上面那张表并排看，差的就是训练量。
    print()
    try:
        small = small_sample_experiment(args.history, args.new)
    except ValueError as exc:
        # 上面那张表已经打出来了，这一节降级成一句话就行 —— 不必把整个命令
        # 变成非零退出（`&& 下一步` 会就此断掉，而错的只是这一段）。
        print(f"小样本实验：这一段没跑\n  {exc}")
    else:
        _print_small_sample(small)
    return 0


if __name__ == "__main__":
    # 管道 / 重定向时 Windows 控制台可能不是 UTF-8，中文别让它把脚本打崩
    for _stream in (sys.stdout, sys.stderr):
        if hasattr(_stream, "reconfigure"):
            _stream.reconfigure(errors="replace", line_buffering=True)
    raise SystemExit(_main())
