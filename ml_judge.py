"""在线 ML 判决 —— core 收到一条遥测，就拿这个宿舍自己的模型判一次（Phase8 D5）。

它和 history.py / events.py 是一对：那两个是「把这条读数记下来」，这里是
「给这条读数判一句」。判词落进 `data/history.csv` 的 ml_label / agree 两列，
也进 `dormmate/v1/state` 快照，看板和报告都读它。

【为什么在项目根，不叫 core/ml.py】
需求写的是 `core/ml.py`，但 `core/` 是个**同名 import 陷阱**：它和项目根的
core.py 重名，Python 的查找顺序是「包优先于同名的 .py」——`core/` 里一旦多了
个 `__init__.py`，`import core` 拿到的就是那个包，而且**不报错**，几千行业务
逻辑整段失效。所以 `core/` 目录一直只有 config.json 一个文件，还有一条测试
（tests/test_core.py 的 TestImportTrap）专门盯着这件事。
放项目根、和 history.py / rules.py / events.py 并列，是同一类东西；
真要写进 core/ 的话还得用 importlib 按文件路径加载（core 不是包，`import
core.ml` 会 ModuleNotFoundError），为一个文件名搭一个反常规的加载器不划算。

【判决只走 model.predict()，不走 score_samples()】
sklearn 1.9.1 的 `IsolationForest.predict` 是拿 `decision_function < 0` 切的，
而 `decision_function = score_samples - offset_`，`contamination="auto"` 时
`offset_` 是 -0.5 —— 所以 `score_samples < 0` 是**另一套口径**，两者不等价。
在 data/dorm-a_history_sim.csv → data/new_samples.csv 上实测差 1/6 行
（25/60 那条：predict 判 1，score_samples 是 -0.465 < 0）。
analysis/ml.py（Step 9-2 那条离线链）统一用 predict，这里也必须用 predict ——
同一个模型、同一行读数，两条链给出不同结论的话，看板和报告会互相打脸，
而两边看上去都「跑成功」了。

在线这条路**不需要分数**，所以不调 decision_function、也不做 ml.py 里那个
_check_threshold 核对（那是离线表要印分数才需要的）。

【判不出来不许拖垮 core】
模型目录不存在、没装 scikit-learn、某个 .joblib 坏了、预测时抛异常 ——
这些都和「宿舍是不是偏热」没有关系。所以照 history.HistoryWriter 那一套：
记下那句话、停下这条链、之后每条静默跳过，让 core 接着跑。
那句话由 take_error() 取一次，core 拿它打一行日志。
「这个宿舍没有模型」不算错误：没模型就是**没判**，CSV 那一列留空 ——
留空和「判成 normal」在报告里必须能分开。

用 py -3.14 跑（core 就是这么起的）。
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Mapping

# 项目根 = 本文件的上一级。core.py 就在旁边，测试也会单独 import 本模块，
# 所以路径自己推一遍，不靠当前工作目录。
ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import rules  # noqa: E402  —— 必须在调整完 sys.path 之后
from analysis import ml  # noqa: E402  —— 同上

# 模型文件的扩展名。写在这里而不是散着写 "*.joblib"：训练端
# （analysis/train_iforest.py）和加载端认的必须是同一个后缀。
MODEL_SUFFIX = ".joblib"


class MlJudge:
    """一个宿舍一个模型，收到读数就判一次。

    `model_dir=None` 就是**不判 ML**（和 Core 的 history_path 同一个默认、
    同一个理由）：造一个 Core 不等于「现在该去 models/ 找模型了」，
    跑测试的时候更不该。真正跑起来的那条路（core.run()）显式把
    config.MODELS_DIR 递进来。
    """

    def __init__(self, model_dir: str | Path | None = None,
                 enabled: bool = True) -> None:
        self.model_dir = None if model_dir is None else Path(model_dir)
        self.enabled = bool(enabled) and self.model_dir is not None
        self.models: dict[str, Any] = {}
        self.error: str | None = None
        self._error_taken = False
        self._loaded = False
        # 「为什么没判」里不是错误的那几种（目录还没有、里面没模型）。
        # 和 error 分开：那两种情况 take_error() 不该报，describe() 该说清楚。
        self._note: str | None = None

    # -- 加载 --------------------------------------------------------------

    def _ensure(self) -> None:
        """第一次要用时把模型扫进来。幂等 —— describe() 和 judge() 都会调。

        延迟到这一步而不是 __init__ 里做，是为了让「造一个 Core」保持廉价：
        __init__ 里读几十兆 joblib 的话，测试里每造一个 Core 都要付一次。
        core.run() 启动时会打印 describe()，所以真正跑起来的那一刻它就已经加载了
        —— 「加载了几个模型」这件事不会拖到第一条遥测才发生。
        """
        if self._loaded:
            return
        self._loaded = True

        if not self.enabled:
            return

        if not self.model_dir.is_dir():
            # 模型目录是**训练产物**，没跑过 train_iforest.py 的时候本来就不存在。
            # 这不是错误，是「这个功能还没启用」，所以走 _note 不走 error。
            self._note = (f"{self.model_dir} 还不存在"
                          f"（跑一次 py -3.14 analysis/train_iforest.py 就有了）")
            self.enabled = False
            return

        try:
            import joblib
        except ImportError as exc:
            self._stop(
                f"没装 joblib：{exc}"
                "（装一下：py -3.14 -m pip install -r requirements.txt）"
            )
            return

        files = sorted(self.model_dir.glob(f"*{MODEL_SUFFIX}"))
        if not files:
            self._note = f"{self.model_dir} 里一个 {MODEL_SUFFIX} 都没有"
            self.enabled = False
            return

        broken: list[str] = []
        for path in files:
            try:
                self.models[path.stem] = joblib.load(path)
            except Exception as exc:            # noqa: BLE001  —— 见下
                # 这里**故意**接 Exception：这是另一个进程、另一次运行写出来的
                # 二进制文件，能坏的方式太多（sklearn 版本变了报 ImportError、
                # 写到一半断电报 EOFError/pickle 的 UnpicklingError…），
                # 逐个列出来只会漏。坏一个只跳过那一个节点，其余照用 ——
                # 一个文件坏了就让另外两个宿舍也没了 ML，那是把小事故放大。
                broken.append(f"{path.name}（{exc}）")

        if broken:
            self._record("加载不了 " + "、".join(broken))

        if not self.models:
            # 全都加载失败：没有可用的模型，这条链等于没起来。
            self._stop(f"{self.model_dir} 里的模型一个都加载不了")

    # -- 失败处理 ----------------------------------------------------------

    def _record(self, message: str) -> None:
        """记下这句话等 core 取一次。**不停用**（还有别的模型能用）。"""
        self.error = message
        # 上一次取过之后又来了一条新的，就得能再报一次。
        self._error_taken = False

    def _stop(self, message: str) -> None:
        """记下原因并停用这条链。**不抛异常** —— 理由见文件头。"""
        self._record(message)
        self.enabled = False

    def take_error(self) -> str | None:
        """取一次出错原因（取过就没了）。core 拿它打日志，只打一次。"""
        if self.error is None or self._error_taken:
            return None
        self._error_taken = True
        return self.error

    # -- 判 ----------------------------------------------------------------

    def judge(self, record: Mapping[str, Any]) -> dict | None:
        """一条 record -> {ml_label, ml_text, ml_agree}；判不了返回 None。

        返回 None 的四种情况：这条链停用了 / 这个宿舍没有模型 /
        这条读数缺温湿度 / 模型给了个不认识的标签。四种都是**没判**，
        调用方（core）不往 record 上写任何键，CSV 那两列留空。
        """
        self._ensure()
        if not self.enabled:
            return None

        node = str(record.get("nodeId"))
        model = self.models.get(node)
        if model is None:
            # 训练时这个宿舍的可用历史不够（或者当时只训了别的宿舍）。
            # 不是错误：没模型就是没判。
            return None

        temperature = record.get("temperature")
        humidity = record.get("humidity")
        if temperature is None or humidity is None:
            # 缺值算不出「离历史有多远」。core 校验报文时已经把非数字挡掉了，
            # 这里兜的是「字段在、值是空」那一类，不为此停用整条链。
            return None

        try:
            label = int(model.predict([[temperature, humidity]])[0])
        except Exception as exc:                # noqa: BLE001  —— 同上，模型的错
            self._stop(f"用 {node} 的模型预测时出错：{exc}")
            return None

        if label not in ml.ML_STATUS:
            # predict 只该给 1 或 -1。给了别的，说明这个模型不是我们训的那个
            # （或者 sklearn 换了约定）—— 此时写个默认值进 CSV 就是编。
            self._stop(f"{node} 的模型给出了不认识的标签 {label!r}"
                       f"（预期 {ml.ML_INLIER} 或 {ml.ML_OUTLIER}）")
            return None

        ml_normal = label == ml.ML_INLIER
        rule_normal = str(record.get("status")) == rules.STATUS_NORMAL
        return {
            "ml_label": ml.ML_STATUS[label],        # CSV 第 6 列（normal / abnormal）
            "ml_text": ml.ml_text(label),           # 给人看的（快照 mlText）
            "ml_agree": rule_normal == ml_normal,   # CSV 第 10 列（yes / no）
        }

    # -- 给人看的 ----------------------------------------------------------

    def describe(self) -> str:
        """一行状态说明，core 启动时打。**会触发加载**（见 _ensure 的文档）。"""
        self._ensure()
        if self.model_dir is None:
            return "不判 ML（没给模型目录）"
        if not self.enabled:
            return f"不判 ML：{self.error or self._note or '已停用'}"
        return (f"{self.model_dir}　加载了 {len(self.models)} 个模型："
                + "、".join(sorted(self.models)))
