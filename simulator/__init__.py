"""simulator 包：Phase1 的数据源与手动发布工具。

    py -3.14 -m simulator.simulator      三个节点，每 2 秒一轮
    py -3.14 -m simulator.publish_one    手动发一条（含故障注入）

这里把 simulator.simulator 的公开名字转发出来，好处是两种写法都能用：

    from simulator import build_payload      # 老写法（tests/test_status_rules.py 就是这么写的）
    from simulator.simulator import build_payload

之所以不只留一种：顶层那个 simulator.py 搬进包里之后，`from simulator import
build_payload` 会因为 simulator 变成了包而解析不到 —— 除非在这里转发一次。
代价只是这一个文件，收益是已有调用方一行都不用改。
"""

from __future__ import annotations

# 只登记名字，不在这里 import —— 见下面 __getattr__ 的说明。
__all__ = [
    "COOLING_START",
    "COOLING_STEP",
    "COOLING_TARGET",
    "DEMO_SEQUENCE",
    "SOURCE_MANUAL",
    "SOURCE_SIM",
    "NodeState",
    "ScriptError",
    "build_payload",
    "cooling_sample",
    "demo_sample",
    "dumps",
    "load_script",
    "main",
    "parse_args",
    "random_sample",
]


def __getattr__(name: str):
    """按需转发到 simulator.simulator（PEP 562）。

    为什么不在这里直接 `from .simulator import ...`：那样 `py -3.14 -m
    simulator.simulator` 会先把子模块 import 一遍、再执行一遍，Python 会打一句
    RuntimeWarning（「found in sys.modules after import of package」）。功能不受
    影响，但演示时终端里挂一句警告很难解释。改成惰性转发之后，-m 是干净的，
    `from simulator import build_payload` 也照样能用。
    """
    if name in __all__:
        from . import simulator as _sim
        return getattr(_sim, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
