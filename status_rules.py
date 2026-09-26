"""DormMate 状态判定规则 —— 全项目唯一真源。

规则按顺序判断，命中即停（顺序不可调换）：
    1) temperature <  18          -> 偏冷
    2) temperature >= 30          -> 偏热
    3) humidity    >= 75          -> 偏湿
    4) 其余                       -> 正常

注意 31℃/80% 应为「偏热」而非「偏湿」：规则 2 先于规则 3。
"""

from __future__ import annotations

# 状态取值（被写进 JSON 的 status 字段）
STATUS_COLD = "偏冷"
STATUS_HOT = "偏热"
STATUS_HUMID = "偏湿"
STATUS_NORMAL = "正常"

# 阈值
TEMP_LOW = 18.0
TEMP_HIGH = 30.0
HUMIDITY_HIGH = 75.0


def compute_status(temperature: float, humidity: float) -> str:
    """按统一约定由温度/湿度算出 status。"""
    if temperature < TEMP_LOW:
        return STATUS_COLD
    if temperature >= TEMP_HIGH:
        return STATUS_HOT
    if humidity >= HUMIDITY_HIGH:
        return STATUS_HUMID
    return STATUS_NORMAL
