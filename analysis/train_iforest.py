"""Phase8 D5：每个宿舍各训一个 Isolation Forest，模型落到 models/（joblib）。

运行（在项目根下、或任何别的目录下都行）：

    py -3.14 analysis/train_iforest.py
    py -3.14 analysis/train_iforest.py --csv data/history.csv --out-dir models
    py -3.14 analysis/train_iforest.py --min-rows 20
    py -3.14 analysis/train_iforest.py --dry-run

【为什么是一个宿舍一个模型，不是一个模型管三个】
Isolation Forest 判的是「这条读数跟**它见过的那些**像不像」。三个宿舍的平时
水平本来就不同（dorm-a 常年 25/60，dorm-c 可能整体偏冷），混在一起训的话
「dorm-c 平时就是这样」会被当成异常，反过来 dorm-a 的一条离群读数又会被另外
两个宿舍的读数稀释掉。按 nodeId 分开训，模型比的是「跟这间宿舍**自己**的平时
像不像」——「与历史明显不同」这句话里的「历史」，指的就是同一个宿舍的历史。

【构造样本不进训练集】
source 归为「构造样本」的行全部跳过（判据见 is_constructed()，分类表在
analysis/make_report.py 的 SOURCE_KINDS，全项目只有那一份）。理由不是洁癖：
构造样本是**故意造出来**要去触发「规则和 ML 判得不一样」的，把它们的极端值
训进去，模型就会认为那些值是这个宿舍的常态，之后判它们 normal —— 案例复现
不出来，而且一句错都不报。

【顺序】（搞反了会怎样写在 README 的 Phase8 那一节）
    1. 起 broker 和 core
    2. 跑模拟器灌历史（source=sim）→ core 写 data/history.csv
    3. 跑本脚本训练 → models/*.joblib
    4. **重启 core**：MlJudge 是启动时扫 models/ 的，不重启加载不到刚训出来的模型
    5. 跑 simulator/replay_samples.py 导入构造样本
    6. 跑 analysis/make_report.py 出报告

【产物】
    models/<nodeId>.joblib   一个宿舍一份
    models/MANIFEST.json     这次是用哪份 CSV 训的、每个宿舍用了几条、跳了几条、
                             以及 sklearn 的版本（模型加载失败时对照它就够了）

models/ 是训练产物，不入库（见 .gitignore）—— 它由这份 CSV 唯一决定，
重跑一次就有，而每次都提交一遍会让 diff 变成噪声。

用 py -3.14 跑（pandas / scikit-learn 都没有 32 位 Windows 包）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

# 项目根 = 本文件的上一级。每个模块开头都自己推一遍，不靠当前工作目录。
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from analysis import analysis, make_report, ml  # noqa: E402  —— 必须在调整完 sys.path 之后

# 默认输入就是 core 写的那份历史表（和 make_report.py 同一个默认值）。
DEFAULT_CSV = ROOT / "data" / "history.csv"

# 模型目录。相对路径按项目根解析（走 analysis.resolve_csv）。
DEFAULT_OUT_DIR = ROOT / "models"

MANIFEST_NAME = "MANIFEST.json"

# 节点名要能直接当文件名用。**不合法就跳过那个宿舍**，不要做转义：
# 转义要有一套「怎么写进去、怎么读回来」的对应规则，而节点名是配置里的东西
# （core/config.json 的 nodes），起名的人本来就能起个正常的。
# 更要紧的是防 ../ 这类穿越 —— cores 的节点名将来要是来自外部，这里就是入口。
NODE_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")

# 终端里那些说明。和 analysis.py 一样：Windows 中文控制台是 GBK，
# 编码兜不住时降级成替换字符，别让脚本崩在 print 上。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="replace", line_buffering=True)


# ---------------------------------------------------------------- 分类与分组

def is_constructed(source) -> bool:
    """这一行的 source 算不算「构造样本」。

    **判据只有这一处**：拿 make_report 那张分类表比对。这么写是为了让
    「哪些 token 算构造样本」全项目只有一份答案 —— 自己在这里列一遍
    （构造/构造样本/sample/samples/manual/constructed）的话，那张表以后
    加一个词，这边就悄悄少跳过一类，而它不会报错，只会训出一个错的模型。

    空值和不认识的 token 一律**不算**构造样本：不认识的更可能是现场数据，
    把它当构造样本丢掉，等于用一份少了数据的基准去判断所有读数。
    """
    raw = analysis._clean(source)
    if not raw:
        return False
    return make_report.SOURCE_KINDS.get(raw.lower()) == make_report.CONSTRUCTED_KIND


def keep_for_training(df, path: Path):
    """去掉构造样本。返回 (剩下的行, 跳过了几条)。

    没有 source 列时**停下**，不是「当成都不是构造样本」：后者在
    「这份 CSV 正好混了构造样本」时会静默地把它们训进去 —— 而这份 CSV
    有没有混，从这个判据本身看不出来。宁可现在停下来问一句。
    """
    if "source" not in df.columns:
        raise SystemExit(
            f"{path} 里没有 source 列，分不出哪些是构造样本，不训练。\n"
            "构造样本是故意造出来触发「规则和 ML 判得不一样」的，把它们训进去，"
            "模型就会认为那些极端值是常态，之后反过来判它们正常 —— 案例复现不出来，"
            "而且一句错都不报。core 写的那份 data/history.csv 一直带着 source 列。"
        )
    mask = df["source"].map(is_constructed)
    return df[~mask], int(mask.sum())


def split_by_node(df, path: Path):
    """按 nodeId 切成 {节点名: 子表}；没有 nodeId 列时停下。

    sort=True：报告的表格行序要稳定，读的人才能前后两次对比着看。
    groupby 默认就是排好序的，写出来是想让这个「故意」看得见。
    """
    column = make_report.node_column(df)
    if column is None:
        raise SystemExit(
            f"{path} 里没有 nodeId 列，分不出每个宿舍的模型。\n"
            "一个宿舍一个模型是这一步的口径（理由见本文件开头）：混在一起训的话，"
            "「dorm-c 平时就是这样」会被当成异常。"
        )
    return column, {str(name): group for name, group in df.groupby(column, sort=True)}


def model_file_name(node: str) -> str | None:
    """节点名 -> 模型文件名；不能安全当文件名用的返回 None（调用方跳过该节点）。"""
    return f"{node}.joblib" if NODE_NAME_RE.match(node) else None


# ---------------------------------------------------------------- 落盘

def _joblib():
    """延迟 import joblib —— 没装时要给一句人话，不是一串 traceback。"""
    try:
        import joblib
    except ImportError as exc:
        raise SystemExit(
            f"没装 joblib：{exc}\n"
            "它随 scikit-learn 一起装上（scikit-learn 依赖它）。"
            "装一下（必须 64 位解释器）：py -3.14 -m pip install -r requirements.txt"
        ) from exc
    return joblib


def _tmp_of(path: Path) -> Path:
    return path.with_name(path.name + ".tmp")


def dump_model(model, path: Path) -> None:
    """写模型文件。**先写 .tmp 再替换** —— 训练到一半断电留下的半截文件，
    下次加载时报出来的错（unpickling 之类）跟「文件坏了」看不出关系。

    收尾那段 finally 是给写失败准备的：异常路径上也要把 .tmp 清掉，
    否则 models/ 里会留一个既不叫 .joblib、也没人会读的残骸。
    """
    tmp = _tmp_of(path)
    try:
        _joblib().dump(model, tmp)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def write_manifest(out_dir: Path, payload: dict) -> Path:
    """写 MANIFEST.json（同样先 .tmp 再替换）。"""
    path = out_dir / MANIFEST_NAME
    tmp = _tmp_of(path)
    # ensure_ascii=False：节点名和文件名都是给人看的，中文原样写。
    # 末尾补一个换行，免得 git 报「\ No newline at end of file」。
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    try:
        tmp.write_text(text, encoding="utf-8", newline="\n")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()
    return path


def sklearn_version() -> str:
    """记进 MANIFEST 的版本号。

    它不是一个装饰：joblib.load 出来的模型对 sklearn 版本敏感，换了版本加载
    报错时，第一件要对照的事就是「训练时是什么版本」。取不到就记空串，
    不为了这一格让训练失败 —— 模型已经训出来了。
    """
    try:
        import sklearn
    except ImportError:                     # pragma: no cover - build_model 先拦了
        return ""
    return str(getattr(sklearn, "__version__", ""))


# ---------------------------------------------------------------- 训练

def train_all(df_all, csv_path: Path, out_dir: Path, min_rows: int,
              dry_run: bool = False) -> dict:
    """按节点各训一个模型，返回一份「这次干了什么」的结果字典。

    结果字典被 main() 拿去打印和写 MANIFEST，也被测试直接断言 —— 所以它里面
    只有内置类型（json.dumps 能直接吃）。
    """
    # 先整体确认一次有 source 列：分不出构造样本就不该动手。
    # 下面每个节点还会各自过滤一遍（这里只是把「没有这一列」这件事尽早说清楚）。
    keep_for_training(df_all, csv_path)
    _, groups = split_by_node(df_all, csv_path)

    models: dict[str, tuple] = {}
    nodes: dict[str, dict] = {}
    skipped: dict[str, str] = {}

    for node, group in groups.items():
        usable, constructed = keep_for_training(group, csv_path)
        info = {
            "rows": int(len(group)),
            "constructedSkipped": constructed,
            "trained": False,
            "file": "",
        }
        nodes[node] = info

        name = model_file_name(node)
        if name is None:
            skipped[node] = f"节点名 {node!r} 不能直接当文件名用（只允许字母数字和 _ -）"
            continue

        # 可用条数不够就不训。这一条同时覆盖了「这个宿舍全是构造样本」：
        # 那时候 usable 是空的，0 < min_rows 自然成立，不需要单独判一次。
        if len(usable) < min_rows:
            skipped[node] = f"可用的历史只有 {len(usable)} 条，少于下限 {min_rows} 条"
            continue

        # 温湿度两列怎么取、空值怎么报，走 ml.py 那一份（全项目只这一处）。
        frame = ml._feature_frame(usable, csv_path, f"{node} 的历史")
        # 拟合走 ml.build_model()：模型参数、缺 sklearn 时那句话，都在它那儿。
        # 这里再写一遍 IsolationForest(**MODEL_PARAMS) 的话，「参数只有一份」
        # 就变成「两份，希望它们一直一样」。
        #
        # 交进去的是**纯二维数组**（to_numpy），不是那个 DataFrame。两者训出来的
        # 模型 predict 逐个相同（已实测），差别只在模型记不记列名：记了列名
        # （feature_names_in_），将来 core 拿 [[t, h]] 去 predict 时 sklearn 每次都
        # 会告警「X does not have valid feature names」—— core 是每收一条遥测判一次、
        # 一跑几小时的那种进程，这条告警会一直刷屏，把要说的话淹掉。
        # （离线那条链 analysis/ml.py 直接用 DataFrame，它是一次性脚本，无所谓。）
        models[node] = (ml.build_model(frame.to_numpy()), name)
        info["trained"] = True
        info["file"] = name

    if not dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)
        for node, (model, name) in models.items():
            dump_model(model, out_dir / name)

    return {
        "csv": str(csv_path),
        "outDir": str(out_dir),
        "minRows": int(min_rows),
        "dryRun": bool(dry_run),
        "nodes": nodes,
        "skipped": skipped,
        "trainedCount": len(models),
    }


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    csv_path = analysis.resolve_csv(args.csv)
    out_dir = analysis.resolve_csv(args.out_dir)

    if not csv_path.exists():
        raise SystemExit(
            f"找不到 CSV：{csv_path}\n"
            "这份表是 core 边收遥测边写出来的。先让 core 收几条：\n"
            "    start_broker.bat\n"
            "    py -3.14 core.py\n"
            "    py -3.14 simulator/simulator.py --all-nodes\n"
            "（或者用 --csv 指到别的 CSV，比如 data/day_sim.csv）"
        )

    # 读 CSV 走 analysis.load()：BOM、缺列、温湿度不是数字，都在那儿把关。
    df = analysis.load(csv_path)
    if len(df) == 0:
        raise SystemExit(f"{csv_path} 只有表头，一行数据都没有，训不出模型。")

    result = train_all(df, csv_path, out_dir, args.min_rows, dry_run=args.dry_run)
    result["sklearn"] = sklearn_version()
    result["generatedAt"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    result["features"] = list(ml.FEATURES)
    result["params"] = dict(ml.MODEL_PARAMS)

    _print_result(result)

    if args.dry_run:
        print("\n--dry-run：只算不写，models/ 一个字节都没动。")
        return 0

    if result["trainedCount"] == 0:
        # 一个模型都没出：不抛异常，但退出码非零 —— 这条命令是流水线里的一步，
        # 非零能让「跑完了但什么都没出」在脚本里看得见，而不是等到看板上一行 ML
        # 都没有再回来找原因。
        print("\n一个模型都没训出来。先看上面每一条的跳过原因，"
              "多半是历史条数不够（--min-rows 可以调低）或者这份 CSV 里全是构造样本。")
        return 1

    path = write_manifest(out_dir, result)
    print(f"\n清单：{path}")
    print(f"共 {result['trainedCount']} 个模型写到 {out_dir}")
    print("记住：core 是**启动时**扫 models/ 的，训完要重启 core 才会加载到。")
    return 0


def _print_result(result: dict) -> None:
    """逐节点一行 + 末尾一句。不用 ✓/✗：Windows 控制台 GBK 会崩。"""
    print(f"历史：{result['csv']}")
    print(f"训练下限：每个宿舍至少 {result['minRows']} 条可用历史\n")

    for node in sorted(result["nodes"]):
        info = result["nodes"][node]
        kept = info["rows"] - info["constructedSkipped"]
        tail = f"（共 {info['rows']} 条，其中构造样本 {info['constructedSkipped']} 条）"
        if info["trained"]:
            print(f"  {node}：用 {kept} 条训练 → {info['file']} {tail}")
        else:
            print(f"  {node}：跳过 —— {result['skipped'][node]} {tail}")

    trained = result["trainedCount"]
    if trained == 0:
        print("\n本次没有写出任何模型。")
    else:
        print(f"\n{'将写出' if result['dryRun'] else '已写出'} {trained} 个模型。")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="DormMate Phase8：按 nodeId 分别训练 Isolation Forest，模型落 models/",
    )
    parser.add_argument("--csv", default=str(DEFAULT_CSV),
                        help=f"输入 CSV，相对路径按项目根解析（默认 {DEFAULT_CSV}）")
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR),
                        help=f"模型写到哪个目录，同上（默认 {DEFAULT_OUT_DIR}）")
    parser.add_argument("--min-rows", type=int, default=ml.SMALL_TRAIN_ROWS,
                        help=f"每个宿舍至少要有多少条可用历史才训"
                             f"（默认 {ml.SMALL_TRAIN_ROWS}，和 Step 9-2 的小样本实验同一个数）")
    parser.add_argument("--dry-run", action="store_true",
                        help="只算不写：打印会训出什么，但不动 models/")
    return parser.parse_args(argv)


if __name__ == "__main__":
    sys.exit(main())
