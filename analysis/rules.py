"""analysis 侧的规则入口 —— judge_status() 和 4 组回归自测。

这里【不重抄】规则。规则实现只有一份，在项目根的 status_rules.py；
本文件把它转成分析层用的名字 judge_status，再补一个自测入口 run_tests()。

重抄一份的代价不是多打几行字，而是以后改规则时必然漏改其中一处：
发布端按新规则发「偏热」、分析端按旧规则判成「偏湿」，两边都"没报错"。
所以这里只做转发，连阈值都是从根模块借过来的，不存在两份数字。

直接运行就跑自测：

    py -3.14 analysis/rules.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# 项目根 = 本文件的上一级。用 __file__ 推导，不靠当前工作目录，
# 这样在任何目录下运行都能 import 到根目录的 status_rules。
_ROOT = Path(__file__).resolve().parent.parent
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
    "run_tests",
    "REGRESSION_CASES",
    "STATUS_COLD",
    "STATUS_HOT",
    "STATUS_HUMID",
    "STATUS_NORMAL",
    "TEMP_LOW",
    "TEMP_HIGH",
    "HUMIDITY_HIGH",
]

# 老师给的 4 组回归数据：(温度, 湿度, 期望状态)
REGRESSION_CASES = [
    (25, 60, STATUS_NORMAL),
    (16, 60, STATUS_COLD),
    (31, 60, STATUS_HOT),
    (25, 80, STATUS_HUMID),
]


def run_tests() -> bool:
    """用 4 组回归数据自测 judge_status，打印表格，返回是否全部通过。

    只打印，不写文件、不连 MQTT。输出里不用 ✓/✗ 这类符号：
    Windows 控制台常是 GBK，编码表里没有它们会直接把脚本打崩。
    """
    print("analysis/rules.py 回归自测")
    print("（judge_status 转发自项目根的 status_rules.compute_status）")
    print()

    failed = 0
    for temperature, humidity, expected in REGRESSION_CASES:
        actual = judge_status(temperature, humidity)
        ok = actual == expected
        if not ok:
            failed += 1
        print(
            f"  {temperature:>5} ℃ / {humidity:>5} %"
            f"  ->  期望 {expected}  实际 {actual}  [{'通过' if ok else '不通过'}]"
        )

    total = len(REGRESSION_CASES)
    print()
    print(f"{total - failed}/{total} 通过")
    return failed == 0


if __name__ == "__main__":
    # 全通过退出码 0，有失败退出码 1 —— 方便挂到别的脚本里
    raise SystemExit(0 if run_tests() else 1)
