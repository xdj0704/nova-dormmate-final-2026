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
CMD_TOPIC = "dormmate/v1/cmd"                  # 前端 -> core 的指令，retain=False
CORE_CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "core", "config.json"
)

# ---- 事件（D3）----
# 事件文件放在 data/ 下，和别的产物一个地方，验收时一眼能找到。
# 这是**运行期产生的数据**，不是源码：它进了 .gitignore，
# 历史上跑出来的事件留在本机，不往仓库里塞。
EVENTS_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data", "events.json"
)


# ---- 历史行（Phase7）----
# core 每收到一条**合法**遥测就往这儿 append 一行，十列见 history.py 的 HEADER
# （Phase8 D5 起最后一列是 agree，之前是九列）。
# 它是**离线分析的输入**：
#
#     py -3.14 analysis/make_report.py --csv data/history.csv
#
# 和 events.json 一样，这份也是运行期产生的数据、不是源码，所以同样进 .gitignore：
# 它一秒一行、每次跑都在变，入库的话每回演示完都多一个「改动」，真正要提交的
# 输入（data/ 下那几份 *_sim.csv）反而被淹掉。要看内容就自己跑一遍 core。
HISTORY_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data", "history.csv"
)


# ---- 模型（Phase8 D5）----
# core 启动时扫这个目录，每个 <nodeId>.joblib 管一个宿舍的「像不像它自己平时」。
# 里面那份是 analysis/train_iforest.py 的训练产物：
#
#     py -3.14 analysis/train_iforest.py --csv data/history.csv --out-dir models
#
# 和 events.json / history.csv 的区别：那两份是 core **写出来**的，这份是 core
# **读进去**的。但入不入库这件事一样 —— 它由那份 CSV 唯一决定，重跑一条命令就有，
# 而 .joblib 是二进制、每灌一批新历史就整份变样，进仓库只会把真正要提交的东西
# 淹在 diff 里（见 .gitignore 的 models/ 那一段）。
#
# 目录不存在**不是错误**：没跑过训练脚本的时候它本来就不存在。那时 core 照常判
# 规则，只是 CSV 的 ml_label 一列留空 —— **留空 = 没判，不是判成正常**。
# 启动时那句「加载了几个模型 / 为什么没判」由 ml_judge.MlJudge.describe() 报出来。
MODELS_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "models"
)


# ---- 数据 ----
PUBLISH_INTERVAL = 5.0                     # 发布间隔（秒）
TIME_FORMAT = "%Y-%m-%d %H:%M:%S"          # 固定格式，勿改
# 统一 JSON 的前五个字段，顺序不要动（Phase1 起在后面追加 seq / source）
PAYLOAD_KEYS = ("nodeId", "temperature", "humidity", "status", "time", "seq", "source")
QOS = 1
RETAIN = True                              # 保留最后一条，后开的看板能立刻看到数值
