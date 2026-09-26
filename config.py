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

TOPIC_PATTERN = "dormmate/+/env"           # 前端订阅用


def topic_for(node_id: str) -> str:
    """dorm-a -> dormmate/dorm-a/env"""
    return f"dormmate/{node_id}/env"


# ---- 数据 ----
PUBLISH_INTERVAL = 5.0                     # 发布间隔（秒）
TIME_FORMAT = "%Y-%m-%d %H:%M:%S"          # 固定格式，勿改
PAYLOAD_KEYS = ("nodeId", "temperature", "humidity", "status", "time")
QOS = 1
RETAIN = True                              # 保留最后一条，后开的看板能立刻看到数值
