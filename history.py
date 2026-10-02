"""历史行落盘 —— 每收到一条**合法**遥测，往 data/history.csv 追加一行（Phase7）。

它和 events.py 是一对：events.py 记「出过哪些事」（一条案卷一行，状态机会变），
这里记「每一条读数」（一条报文一行，只追加、从不修改）。离线分析读的就是这份 ——
`analysis/make_report.py --csv data/history.csv`。

【为什么是 append-only】
这份文件是「档案」，不是「状态」：一行写下去就不再动它。所以没有「重写整个文件」
这一步（events.json 有，它得随状态机改），也就没有「跑到一半崩了文件是半截的」
那种事 —— 最坏情况是最后一行没写全，删掉重来即可。

【ml_label 与 agree 两列（Phase8 D5 起是 core 在线判的）】
Phase7 的时候这九列里 ml_label 一列**core 一律写空串**，当时的理由是「core 里
没有 ML，猜一个标签写进去就是在报告里伪造一个模型判断」。Phase8 D5 把那条链接上了：
core 收到每条遥测时，拿**这个宿舍自己的**模型判一次，结论落在这两列里。

  * `ml_label`（第 6 列）：`normal` / `abnormal`。**留空表示「没判」** ——
    这个宿舍没有模型、没装 scikit-learn、或者这条读数缺温湿度。
    留空**不是**「判成正常」：一个是「没判」，一个是「判了说没事」，
    报告里必须能分开，所以这一列绝不拿默认值去填。
  * `agree`（第 10 列）：`yes` / `no` —— 固定规则和 ML 是不是同一个结论。
    有判词才有这一格：`ml_label` 空 ⟹ `agree` 也空。

词表为什么是 ASCII 而不是中文：这份 CSV 是**数据**，读它的是
`analysis/make_report.py`（那边的判据是 `label.lower() in ("normal", "正常", "ok")`）。
给人看的中文判词（「接近历史常态」/「与历史明显不同」）在快照的 mlText 和报告的
表格里，不往这份 CSV 里塞。已提交的 data/constructed_samples.csv 也是这套写法。

**和离线那条链的关系**：`analysis/ml.py`（Step 9-2）是**离线**的，跑完写
`report/ml_result.json`，不回填这份 CSV。两条链用的是同一套模型参数，而且
**都只能用 `model.predict()` 判决** —— 用 `score_samples` 是另一套口径，
同一行读数会给出不同结论（详见 ml_judge.py 的文件头）。

【两个字段的时点】event_id / event_state 取的是「这条读数落在哪条案卷里」：
跟着这条报文更新完之后，这个节点**开着**的那条事件。开案的**第一条**异常读数
自己就带着刚开出来的案号（它属于那条案卷），把案卷收掉的那最后一条正常读数
也还带着那条案卷的编号（它是验证数据）。两条都不占的读数（一段异常之外的
普通读数）留空 —— 不拿 last_for() 去攀一条早就结掉的案子，那是编。

用 py -3.14 跑（core 就是这么起的）。
"""

from __future__ import annotations

import csv
import os
from pathlib import Path
from typing import Any, Iterable, Mapping

# 列顺序就是 Phase7 定的那九列，**不许改顺序也不许改名字**：
# 下游 analysis/make_report.py 按列名读，但人拿 Excel 打开时看的是位置。
#
# Phase8 D5 在**末尾追加**了第十列 agree（固定规则和 ML 是不是一个结论）。
# 追加在末尾而不是插在 ml_label 旁边，正是为了上面那句「看的是位置」：
# 往前插一格，Excel 里从那一列起整排人看到的都是错位的东西。
HEADER: tuple[str, ...] = (
    "time",
    "nodeId",
    "temperature",
    "humidity",
    "status",
    "ml_label",
    "event_id",
    "event_state",
    "source",
    "agree",
)

# 「这一行没判 ML」在这份 CSV 里长什么样 —— 空串。写成常量而不是散在各处写 ""：
# 留空是一个**有含义的值**（「没判」，不是「判成正常」），它得有个名字。
ML_LABEL_EMPTY = ""

# agree 的两个词（第 10 列）。**必须是字符串**，不能是 Python 的 True/False：
# 下面 _cell() 把 bool 当缺值打成空串（理由在它的注释里），写个真布尔进去的话
# 这一格永远是空的 —— 而「没判」和「判了不一致」在这份 CSV 里就长得一模一样了。
AGREE_YES = "yes"
AGREE_NO = "no"
AGREE_EMPTY = ""

# 这一列怎么读，交给报告去说。这里只提供那句话，避免两处各写一份说法。
ML_LABEL_NOTE = (
    "ml_label 是 core 在线判的（Phase8 D5）：这个宿舍有模型就是 normal/abnormal，"
    "没模型、没装 scikit-learn、或这条没判成时留空 —— 留空是「没判」，"
    "不是「判成正常」"
)

# 换行用 CRLF：data/ 下那几份 CSV 都是 CRLF + UTF-8 BOM（Excel 直接双击打开
# 中文不乱码，也是 .gitattributes 给 data/*.csv 定的口径）。
NEWLINE = "\r\n"

# 写在文件最前面的 BOM。用 utf-8 编码写 U+FEFF 出来的就是 EF BB BF 三个字节 ——
# 不能用 utf-8-sig 编码：那个在 append 模式下每开一次文件都会再补一个 BOM，
# core 重启几次之后文件中间就会多出几个空字节。
BOM = chr(0xFEFF)


def _cell(value: Any) -> str:
    """一格的值 -> 文本。

    数字走 %g：25.0 打成 "25"、57.60 打成 "57.6"，和 data/ 下那几份手写 CSV
    一个口径（那边就是 25 / 23.5 这种写法）。不这么归一的话，同一份文件里
    会同时出现 25 和 25.0，按列看像是两种东西。缺值打成空串，不是 "None"。
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        # bool 是 int 的子类，但「温度是 True」没有意义，当缺值处理
        return ""
    if isinstance(value, float):
        return f"{value:g}"
    if isinstance(value, int):
        return str(value)
    return str(value)


class HistoryWriter:
    """往一份 CSV 追加历史行。

    `path=None` 就是**不碰磁盘**（和 Core 的 events_path 同一个默认、同一个理由）：
    造一个 Core 不等于「现在该往 data/ 写文件了」，跑测试的时候更不该。
    真正跑起来的那条路（core.run()）显式把 config.HISTORY_PATH 递进来。

    【写不进去不许拖垮 core】磁盘满了、文件被 Excel 独占打开着、目录被删了 ——
    这些都发生过，而它们和「宿舍是不是偏热」没有关系。所以出错时：
    记下那句话、把这个 writer 关掉、之后每条静默跳过，让 core 接着跑。
    那句话由 take_error() 取一次，core 拿它打一行日志（只在出错当时打一次，
    不然现场每秒一条遥测会把日志刷满）。
    """

    def __init__(self, path: str | os.PathLike[str] | None = None,
                 enabled: bool = True) -> None:
        self.path = None if path is None else Path(path)
        self.enabled = bool(enabled) and self.path is not None
        self.rows = 0                 # 这个进程写过多少行
        self.error: str | None = None
        self._error_taken = False
        self._handle = None
        self._writer: Any = None

    # -- 打开 / 关闭 -------------------------------------------------------

    def _header_in_file(self) -> tuple[str, ...] | None:
        """文件第一行的表头。空文件 / 读不了 -> None。"""
        try:
            with open(self.path, "r", encoding="utf-8-sig", newline="") as handle:
                first = handle.readline()
        except OSError:             # 读不了就交给 _open 原来的路子（接着写）
            return None
        if not first.strip():
            return None
        return tuple(cell.strip() for cell in next(csv.reader([first])))

    def _open(self) -> None:
        """第一次写之前把文件打开，表头该补就补；**旧格式的文件停下**。"""
        size = self.path.stat().st_size if self.path.exists() else 0

        # 非空的文件：它的表头必须是**现在这一版**。Phase8 D5 在末尾追加了
        # agree，而这份文件是只追加的档案（见文件头）—— 旧的九列表头会继续
        # 吃十格的行：读的时候 agree 落进 csv 的 restkey 被静默丢掉，Excel 里
        # 多出一个没名字的列，而日志一句都不说。就地补一列要重写整个档案
        # （违背 append-only），所以停下、把两条路说清楚，由写的人决定。
        if size:
            header = self._header_in_file()
            if header is not None and header != HEADER:
                self._fail(
                    f"{self.path} 里是旧格式的表头（{len(header)} 列："
                    f"{'、'.join(header)}），现在写的是 {len(HEADER)} 列"
                    f"（{'、'.join(HEADER)}）。这份文件只追加、没法就地补一列 ——"
                    f" 把它改名留档、或者删掉，让 core 重新开一份。")
                return

        self.path.parent.mkdir(parents=True, exist_ok=True)
        # newline="" 是 csv 模块要求的：不关掉换行翻译，Windows 上会写成
        # \r\r\n，每一行后面多一个空行。
        self._handle = open(self.path, "a", encoding="utf-8", newline="")
        self._writer = csv.writer(self._handle, lineterminator=NEWLINE)

        # 「要不要补表头」看的是**文件本身**空不空，不是「这个进程写过没有」：
        # core 重启一次就重新 append 一份表头的话，文件中间会冒出一行表头，
        # 读的人只会以为后面那些是另一张表。
        if size == 0:
            self._handle.write(BOM)
            self._writer.writerow(HEADER)

    def close(self) -> None:
        """收尾。反复调用没关系（run() 的 finally 和 atexit 都可能调）。"""
        if self._handle is None:
            return
        try:
            self._handle.close()
        except OSError as exc:      # pragma: no cover - 关不掉也只能算了
            self._fail(f"关不上 {self.path}：{exc}")
        finally:
            self._handle = None
            self._writer = None

    # -- 失败处理 ----------------------------------------------------------

    def _fail(self, message: str) -> None:
        """记下出错原因并停写。**不抛异常** —— 理由见类文档。"""
        self.error = message
        self.enabled = False
        self.close()

    def take_error(self) -> str | None:
        """取一次出错原因（取过就没了）。core 拿它打日志，只打一次。"""
        if self.error is None or self._error_taken:
            return None
        self._error_taken = True
        return self.error

    # -- 写 ---------------------------------------------------------------

    def row_of(self, record: Mapping[str, Any], event_id: str = "",
               event_state: str = "") -> list[str]:
        """一条校验通过的报文 -> 一行十格。单独开出来是为了能直接测。

        ml_label / agree 两格读的是 core 挂在**这条** record 上的 ml_label /
        ml_agree（挂在哪儿见 core.Core._judge_ml）。没挂就是没判，两格都空 ——
        不给默认值：「没判」和「判成正常」必须长得不一样。
        """
        return [
            _cell(record.get("time")),
            _cell(record.get("nodeId")),
            _cell(record.get("temperature")),
            _cell(record.get("humidity")),
            _cell(record.get("status")),
            _cell(record.get("ml_label", ML_LABEL_EMPTY)),
            _cell(event_id),
            _cell(event_state),
            _cell(record.get("source")),
            self._agree_cell(record),
        ]

    def _agree_cell(self, record: Mapping[str, Any]) -> str:
        """ml_agree（布尔）-> CSV 那一格（yes / no / 空）。

        「布尔 -> 两个词」这个翻译只在这一处做。挪到 core 里做的话，快照里那个
        字段也会变成字符串，而前端判它用的是 `agree ? … : …` ——
        JS 里 "no" 是**真值**，整列会反过来。
        """
        value = record.get("ml_agree")
        if value is None:
            return AGREE_EMPTY
        return AGREE_YES if value else AGREE_NO

    def append(self, record: Mapping[str, Any], event_id: str = "",
               event_state: str = "") -> bool:
        """追加一行。成功 True；已经停写了（或一开始就 disabled）False。"""
        if not self.enabled:
            return False
        try:
            if self._writer is None:
                self._open()
                if self._writer is None:    # _open 把它停了（表头是旧格式）
                    return False
            self._writer.writerow(self.row_of(record, event_id, event_state))
            # 每条都 flush：这份文件是给离线分析读的，而 core 可能一连跑几小时。
            # 攒在缓冲区里的话，「core 明明在收数据，CSV 还是空的」——
            # 而这正是验收时会看到的场面。
            self._handle.flush()
        except (OSError, csv.Error) as exc:
            self._fail(f"写不进 {self.path}：{exc}")
            return False
        self.rows += 1
        return True

    def append_all(self, records: Iterable[Mapping[str, Any]]) -> int:
        """一批。返回真写进去的条数（出错时剩下的直接放弃）。"""
        written = 0
        for record in records:
            if not self.append(record):
                break
            written += 1
        return written

    # -- 给人看的 ---------------------------------------------------------

    def describe(self) -> str:
        """一行状态说明，core 启动时打。"""
        if self.path is None:
            return "不写历史 CSV（没给路径）"
        if not self.enabled:
            return f"{self.path}　**已停写**：{self.error}"
        return f"{self.path}　本次已写 {self.rows} 行"
