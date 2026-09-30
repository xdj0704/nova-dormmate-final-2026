"""DormMate 统一配置（发布端与前端约定都集中在这里）。"""

from __future__ import annotations

import os

# ---- MQTT ----
MQTT_HOST = os.environ.get("DORMMATE_MQTT_HOST", "localhost")
MQTT_TCP_PORT = 1883   # MQTTX / Python 发布端
MQTT_WS_PORT = 9001    # 浏览器（WebSocket）
MQTT_USERNAME = os.environ.get("DORMMATE_MQTT_USER") or None
MQTT_PASSWORD = os.environ.get("DORMMATE_MQTT_PASS") or None

# ---- 节点 ----
DEFAULT_NODE_ID = "dorm-a"                 # M1–M4 只围绕一个宿舍
NODE_IDS = ["dorm-a", "dorm-b", "dorm-c"]  # M5 起启用

TOPIC_PATTERN = "dormmate/v1/nodes/+/telemetry"  # 前端订阅用


def topic_for(node_id: str) -> str:
    """dorm-a -> dormmate/v1/nodes/dorm-a/telemetry"""
    return f"dormmate/v1/nodes/{node_id}/telemetry"


# ---- Core（业务大脑）----
# core 的配置在 core/config.json（节点、阈值、权重、超时…）。
# **topic 字符串只有这一处出处**，core 也从这里取，不自己拼 ——
# 第二处拼 topic 就意味着改一边漏一边，而两边的失配是静默的。
STATE_TOPIC = "dormmate/v1/state"              # retained：全局状态快照
REJECT_TOPIC = "dormmate/v1/log/reject"        # 非法报文，retain=False
CORE_STATUS_TOPIC = "dormmate/v1/core/status"  # retained：core 在线状态（遗嘱）
CORE_CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "core", "config.json"
)


# ---- 数据 ----
PUBLISH_INTERVAL = 5.0                     # 发布间隔（秒）
TIME_FORMAT = "%Y-%m-%d %H:%M:%S"          # 固定格式，勿改
# 统一 JSON 的前五个字段，顺序不要动（Phase1 起在后面追加 seq / source）
PAYLOAD_KEYS = ("nodeId", "temperature", "humidity", "status", "time", "seq", "source")
QOS = 1
RETAIN = True                              # 保留最后一条，后开的看板能立刻看到数值
