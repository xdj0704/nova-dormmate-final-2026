# DormMate Final · 多节点宿舍环境助手

## 项目简介

DormMate Final 是一个**宿舍环境监测助手**。它把宿舍的温湿度采集上来，经 MQTT 推到
浏览器，实时显示成一块看板；看板上还能手动录入一组数据做即时分析、把记录导出成 CSV；
再往后是给看板装上"眼睛"和"嘴"—— 现场拍照与语音指令。导出的 CSV 交给 Python 侧读回来，
做规则复核、状态统计、趋势图和 HTML 报告，形成**采集 → 展示 → 导出 → 分析**的闭环。

前端是**纯静态**的（不需要构建、不需要打包工具；三个第三方库 —— mqtt.js、Chart.js、
three.js —— 都各留了一份本地副本，默认走 CDN，现场没网时按下面指出的那几行换成本地文件
即可，不用改别的），后端只有本机一个 Mosquitto Broker，没有服务器程序、没有数据库。

课程 Challenge 项目。看板是**三节点**（`dorm-a` / `dorm-b` / `dorm-c`）的 ——
订阅的是通配符 topic，每个节点各存一份互不相干的状态，来几个节点画几张卡。
`simulator/simulator.py` 一轮给每个选中的节点各发一条：`--all-nodes` 就是三个一起。

## 主要功能

| 模块 | 状态 | 说明 |
|---|---|---|
| 数据源（`simulator/`） | ✅ 已完成（Phase1） | `simulator/simulator.py` 一轮给每个选中的节点各发一条（`--all-nodes` 就是三个一起），另有 `--mode cooling`（风扇降温）、`--mode random`、按 json 剧本跑场景（帧里可以写死 `time`，于是「持续了多久」是可复现的）；`simulator/publish_one.py` 手动发一条，带故障注入（`--topic` / `--raw` / `--clear`）。**status 一律由温湿度按统一规则算出**，模拟器也不例外，报文里没有一处能手工塞状态 |
| 故障注入（`simulator/inject_faults.py`） | ✅ 已完成（Step D4） | 一条命令把该坏的东西都坏一遍（九条：正常对照 / 非法 JSON / 缺字段 / topic 与报文对不上 / 未知节点 / 数值离谱 / 顶层不是对象 / topic 形状不对 / 清 retained 的空报文），**并当场核对 core 有没有真的拦住、拒的理由对不对**。它自己订 `dormmate/v1/log/reject`，跟「reject 上有几条」比的是 **topic + payload 全文**和理由里的关键词，所以「三条都在」和「三条都因为对的原因在」分得清。core 没在跑时那张表全红，它不会假装绿 |
| **业务大脑（`core.py` + `rules.py`）** | ✅ 已完成（Phase2） | 独立进程订阅 `dormmate/v1/nodes/+/telemetry`，逐条**校验**（九道判据，topic 里的 nodeId 和报文里的必须一致，非法报文发去 `dormmate/v1/log/reject`；清 retained 的那条空报文除外）、按统一规则**判状态**（`status` 对不上只记一笔，不拒收）、按节点**存历史**、算出**优先关注**（时长 → 条数 → 严重度 → 字典序，每一步都带一句人话理由），并把全局快照 retained 发到 `dormmate/v1/state`。带遗嘱 LWT：core 一掉线，broker 立刻在 `dormmate/v1/core/status` 上报 `offline`。全部可调参数在 `core/config.json`，启动时与规则真源逐项核对，对不上就拒绝启动 |
| 实时看板（`web/`） | ✅ 已完成（M1） | 通过 WebSocket 订阅 `dormmate/v1/nodes/+/telemetry`，显示温湿度与状态徽章。状态用**颜色 + 图标**双重编码，不靠颜色单独表意；支持深 / 浅色主题 |
| 多节点看板（`dashboard/`） | ✅ 已完成（Step 5-3 / 5-4） | 订阅同一个通配符 topic 把三个节点一次收齐，`dorm-a` / `dorm-b` / `dorm-c` 各一张状态卡 + 一张趋势图（温湿度分两张，不用双 Y 轴）。三个节点各存一份互不相干的状态，改一个不动另外两个 |
| 3D 宿舍实景 | ✅ 已完成（Step 6-1 ~ 6-3） | Three.js 场景嵌在看板里，跟着**当前选中的节点**走：点卡片切节点时，画面、标签、风扇一起切 |
| 优先关注 | ✅ 已完成（Step 7-1，**栏本身已被 8-3 换成顶部那一行**） | 从三个节点里挑出最该先看的那个：先比连续异常时长，一样长比这段的消息条数，还一样按 nodeId 定序。挑法一个字没变（还是 `pickPriority`），只是顶上换成了 8-3 那一行；点它 = 点对应那张卡片，这个行为也留着 |
| 处理动作 | ✅ 已完成（Step 7-2，D3 起还会发指令） | 详情区「开启风扇 / 通风」按钮。按下后节点记「处理中｜风扇已开启」，动作之后收到的数据决定转「已恢复」还是留在「处理中」。卡片、详情区、3D 风扇读的是同一份节点数据。**Step D3 起这一下还会往 `dormmate/v1/cmd` 发一条 `handle`**，core 那边的事件跟着进「处理中」—— 但「好没好」由 core 后面收到的数据判，页面上按不出「已恢复」 |
| 事件记录 + 导出 | ✅ 已完成（Step 7-4 第一部分） | 节点从正常进入异常时开一条事件，恢复时结案，**一行 = 一段连续异常**。九列：开始 / 节点 / 问题 / 优先关注 / 处理动作 / 恢复 / 结果。「导出事件 CSV」也是 CRLF + UTF-8 BOM。第二部分的 `analysis/analysis.py` 事件复盘时间线**还没做** |
| **事件闭环（`events.py`）** | ✅ 已完成（Step D3） | 服务端的事件状态机：`OPEN`（待处理）→ 收到 `dormmate/v1/cmd` 上的 `handle` → `HANDLING`（处理中）→ 后面**连着 N 条正常**自动 `RECOVERED`（已恢复）/ 连着 M 条还是异常自动 `UNRESOLVED`（未恢复）。**恢复与否只看后来收到的报文**，处理指令只能把事件推到「处理中」—— 这条红线在代码里是结构上成立的（`handle_command` 拿不到节点状态，`= RECOVERED` 只有一条路）。事件带验证数据数组、处理前后的快照、优先关注理由，落盘在 `data/events.json`，core 重启会读回来并把没结案的按未恢复收尾 |
| 当前总览 + 判断依据 | ✅ 已完成（Step 8-1，**页面部分已被 8-3 收编**） | 两句人话：B1 说「几个正常、几个需要关注、谁是当前重点」，B2 说「为什么是它、别人为什么不是」。每收到一条报文重算，句子里的节点名、状态、数字**一个都不写死**。Step 8-3 起看板顶部不再渲染这两句（改成「当前重点」一行），函数留在 `logic.js` 里给 `report.html` 那侧用 |
| 四个出口各说各的 | ✅ 已完成（Step 8-3） | 看板顶部一行「当前重点」（谁 / 在不在处理 / 温度往哪走）、3D 场景只表达空间（哪个宿舍、哪个空间要关注）、「语音提醒」按钮念当前最重要的一句、`report.html` 记全过程。**「谁是重点」只有一份实现**（`pickPriority`），四个出口都从它出发 |
| 今日摘要 | ✅ 已完成（Step 8-2） | Python 侧按节点找出**连续异常段**当成环境事件，串成一段人话（「dorm-b 14:10 起持续偏热 40 分钟后恢复；dorm-c 21:30 出现偏湿，目前仍未恢复」），并作为「今日摘要」区块进 `report/report.html`。数据来自模拟日数据 `data/day_sim.csv` |
| 历史数据 + 待判断新数据 | ✅ 已完成（Step 9-1，C 部分的数据准备） | `make_sim_data.py` 一次运行多出两份：`data/dorm-a_history_sim.csv`（dorm-a 的 40 条「平时」历史，条条正常）和 `data/new_samples.csv`（6 条待判断的新读数）。**两份分开放**，新数据不许混进历史里 —— 拿历史当基准去判断新数据时，混在一起就是自己判断自己 |
| ML 与固定规则对照 | ✅ 已完成（Step 9-2，C 部分的 C1 + C2） | `analysis/ml.py`：只用历史 fit 一个 Isolation Forest，对新数据逐条给出「接近历史常态 / 与历史明显不同」**和分数**，同一行并排摆上 `rules.judge_status` 的说法，两边不一致的（规则说正常、ML 说不同）单独点出来。参数按需求原样（`n_estimators=100` / `contamination='auto'` / `random_state=42`），实测 6 条里有 2 条不一致 |
| ML 结果写回报告 | ✅ 已完成（Step 9-3，C 部分的 C3） | `analysis/analysis.py` 的 `main()` 调 `run_ml()`，把结果做成 `sections` 里的**「ML 异常分析」区块**接进 `report.html`（来源与条数、六列对照表、不一致的行高亮、结论那句与命令行逐字相同、门槛松紧），**同时写一份 `report/ml_result.json`** 给看板 fetch。那两份文件读不到、或这台机器没装 scikit-learn 时，**只让这一段降级**成一句「这一段没跑：{原因}」，报告其余部分照常出 |
| 看板读 ML 结果 | ✅ 已完成（Step 9-3 的进阶项） | 看板上多一块**「ML 辅助判断」**：打开页面 `fetch('../report/ml_result.json')` 一次，把 C 部分那句结论和「规则说正常、ML 说不同」的条数摆出来，并**标明它判的不是看板上这些实时读数、是上一次跑 `analysis.py` 时的快照**。读不到（404 / 不是从项目根起的服务器 / 不是那份文件）时只降级成一行「这一段没跑：{原因}」，看板其余部分照常 |
| 手动录入分析 | ✅ 已完成 | 在页面上直接输入一组温湿度，前端按统一规则算出 status 并给出建议文案，带范围校验（温度 -20~60℃，湿度 0~100%） |
| 录入历史 + 导出 CSV | ✅ 已完成 | 表内滚动、表头吸顶；导出为 CRLF 换行 + UTF-8 BOM，Excel / WPS 打开不乱码 |
| Python 分析 | ✅ 已完成（Step 2-2~2-5） | 读 CSV → 规则复核 → 状态统计 → 出 `report/trend.png` 趋势图 → 出 `report/report.html`；支线还能渲染一份 Markdown 报告 |
| 现场快照 | ✅ 已完成（Step 3-1） | 摄像头预览 + 一键拍照，快照显示在页面右侧，标明拍摄时间与分辨率 |
| 语音指令（ASR） | ✅ 已完成（Step 3-2） | 说「朗读」播报当前状态、说「拍照」拍下现场画面，识别到的文字和执行结果显示在页面上 |
| 语音播报（TTS） | ✅ 已完成（Step 3-3） | 说「朗读」用浏览器自带的语音合成真念出来（各节点的温湿度与状态，按 nodeId 排序）。要念的那句话同时显示在「执行结果」那一格 —— 静音、没音箱时靠它确认念了什么 |

每个模块的具体做法、测试条数和踩过的坑，记在下面各自的 Step 小节里。
不清楚某处为什么这么写时，先看那一节的「几个决定」表格。

## 目录结构

```
nova-dormmate-final-2026/    # 仓库根
├── README.md                # 本文档
├── .gitattributes           # 钉住第三方文件的换行，README 里的 sha256 才对得上
├── requirements.txt         # Python 依赖：paho-mqtt + pandas + matplotlib + scikit-learn
├── status_rules.py          # 规则（Python 侧唯一实现，发布端算 status 用）
├── config.py                # Broker / 端口 / Topic / 节点 等统一配置
├── core.py                  # Phase2 业务大脑：校验 / 判状态 / 存历史 / 算优先 / 发快照
├── rules.py                 # Phase2 规则层：judge_status（转发）+ rank_priority（这一步在这实现）
├── events.py                # Step D3 事件状态机：OPEN→HANDLING→RECOVERED/UNRESOLVED，读写 data/events.json
│                            #   恢复与否只看 core 后来收到的报文，处理指令只把事件推到 HANDLING
├── core/
│   └── config.json          # core 的全部可调参数（节点 / 阈值 / 权重 / 离线超时 / 恢复条数 / 事件门槛）
├── simulator/               # Phase1 数据源（是个包：老的 `from simulator import ...` 照旧能用）
│   ├── __init__.py          # 惰性转发 simulator.simulator 的公开名字
│   ├── simulator.py         # 三个节点的数据源：多节点 / cooling 降温 / json 剧本（帧可写死 time）
│   ├── publish_one.py       # 手动发一条 + 故障注入（--topic / --raw / --clear）
│   ├── send_cmd.py          # Step D3：以「前端的身份」发一条 dormmate/v1/cmd（--node / --action）
│   ├── inject_faults.py     # Step D4：把坏报文一次发全，并当场核对 core 有没有真的拦住
│   └── scenarios/
│       ├── phase1_demo.json # 演示剧本：8 帧，四种状态各一次（含 dorm-b 降温那段）
│       ├── d2_case1.json    # Phase2 场景一：时长决出，靠恢复交接（15 帧）
│       ├── d2_case2.json    # Phase2 场景二：时长并列比条数，再被更长的接管（17 帧）
│       ├── d2_case3.json    # Phase2 场景三：时长条数全平，严重度决出（14 帧）
│       └── d3_event.json    # Step D3 剧本：两幕，dorm-b 处理→恢复、dorm-c 处理→未恢复（14 帧）
├── shared/
│   └── rules.js             # 规则（JS 侧唯一实现，前端页面共用一份）
├── analysis/                # Step 2-2/2-3/2-4/2-5/8-2：分析层（是个包，所以有 __init__.py）
│   ├── __init__.py
│   ├── rules.py             # judge_status() —— 转发 status_rules，不重抄规则
│   ├── analysis.py          # 读 CSV + 复核规则 + 状态统计 + summary + 趋势图 + HTML 报告
│   ├── daily_summary.py     # Step 8-2：连续异常段 → 今日摘要（纯函数 + 一个读文件的入口）
│   ├── make_sim_data.py     # Step 8-2：生成模拟日数据（不连网，直接把一天的采样点摆出来）
│   │                        #   Step 9-1 起一次运行出三份：日数据 + 平时历史 + 待判断新数据
│   ├── ml.py                # Step 9-2：Isolation Forest 与固定规则的对照（只用历史 fit）
│   └── report.py            # 把同一个 summary 渲染成 Markdown 报告
├── data/
│   ├── dormmate.csv         # 演示用样例数据（网页「导出 CSV」的文件格式）
│   ├── day_sim.csv          # Step 8-2 的模拟日数据：一天、三个节点、864 行，固定种子生成
│   ├── dorm-a_history_sim.csv  # Step 9-1：dorm-a 的 40 条「平时」历史（全正常，固定种子生成）
│   └── new_samples.csv      # Step 9-1：6 条待判断的新数据（25/60、26/62、29/72、31/60、25/80、17/60）
│                            # （events.json 是 core 自己写的事件记录，运行时产物，不入库 —— 见 .gitignore）
├── report/                  # Step 2-4/2-5 的产物（注意是单数，见下面说明）
│   ├── trend.png            # 温湿度趋势折线图（analysis/analysis.py 的产物）
│   ├── report.html          # HTML 报告，里面的 <img src="trend.png"> 是相对路径
│   └── ml_result.json       # Step 9-3：ML 那一段的结论，给看板 fetch（只留文件名，不含本机路径）
├── reports/
│   └── dormmate-report.md   # Markdown 报告（analysis/report.py 的产物）
├── tests/
│   ├── test_status_rules.py # Python 侧回归测试（23 条）
│   ├── test_analysis.py     # analysis 读取、统计、趋势图、报告与 ML 区块的测试（206 条，需要 pandas / matplotlib）
│   ├── test_report.py       # 报告渲染的测试（30 条，需要 pandas）
│   ├── test_daily_summary.py # 今日摘要 + 模拟日数据 + 平时历史 / 新数据的测试（123 条，需要 pandas）
│   ├── test_ml.py           # Step 9-2：Isolation Forest 对照的测试（124 条，需要 pandas / scikit-learn）
│   ├── broker_selftest.py   # 不是测试用例：手动跑的 Broker 收发自检（TCP + WebSocket 两条通路）
│   ├── test_simulator.py    # Phase1：模拟器（seq / cooling / json 剧本 / 帧写死时间 / 节点归一 / 跑一遍 main）（54 条）
│   ├── test_publish_one.py  # Phase1：publish_one 的报文 / topic / retain / 退出码（22 条，假 mqtt.Client）
│   ├── test_core.py         # Phase2：core 的 topic 解析 / 报文校验 / 拒收 / 清 retained 的空报文 / 状态机 / 优先排序 / 快照 / 遗嘱 / 配置核对（89 条）
│   ├── test_rules_priority.py # Phase2：rules.py 的四步排序 + 理由措辞 + 「不许写死节点名」的静态检查（29 条）
│   ├── test_scenarios.py    # Phase2：把 d2_case1/2/3 逐帧喂给 core，断言「优先关注」的换人轨迹（15 条）
│   ├── test_inject_faults.py # Step D4：故障清单逐条对 core 的判据，外加两个前端对未知节点的差异（37 条，不连 broker）
│   ├── test_events.py       # Step D3：事件状态机 / 落盘读取 / 指令校验 / D3 剧本重放 / 四条红线的静态检查（145 条，不连 broker）
│   ├── fixtures/
│   │   └── priority_cases.json # Python 与 Node 共读的期望表（排序四步 + 时长措辞）
│   ├── rules.test.js        # shared/rules.js 的测试（31 条，纯 Node 无依赖）
│   ├── miniapp-rules.test.js # 小程序 rules.js ↔ shared/rules.js 交叉比对（48 条）
│   ├── logic.test.js        # dashboard/logic.js 的纯函数：解析 / 时长 / 连续异常段 / 挑优先 / 处理状态机 / 事件 / 总览与依据 / 趋势与两个出口 / ML 辅助判断那几句 / 按按钮那行说明（408 条）
│   ├── dashboard.test.js    # dashboard.js 的订阅 / 校验 / 绘图 / 3D 接线 / 当前重点那一行 / 语音提醒 / 处理动作 / 按下去发给 core 的那条指令 / 事件记录与 CSV 导出 / 读 ML 结果（481 条，假 DOM + 假 mqtt + 假 fetch）
│   ├── scene3d.test.js      # 3d/scene.js 与 3d/index.html 的结构（224 条，假 three 模块 + 假 DOM）
│   ├── scene3d-page.test.js # 3d/index.html 里那段模块脚本：MQTT 驱动 3D（65 条）
│   └── script.test.js       # 前端回归测试（150 条，纯 Node 无依赖）
├── mosquitto/dormmate.conf  # Mosquitto 配置：1883(TCP) + 9001(WebSocket)
├── web/                     # M1~M3 单节点看板（纯静态，无需构建）
│   ├── index.html
│   ├── style.css
│   ├── script.js            # 订阅渲染 + 手动录入 + 录入历史 + 导出 CSV + 现场快照 + 语音指令
│   └── vendor/mqtt.min.js   # 本地化的 mqtt.js，不依赖 CDN
├── dashboard/               # M5 多节点看板：dorm-a/b/c 横向对比（纯静态）
│   ├── index.html           # 建容器 + 一张 three 的 importmap（scene.js 里的裸名 three 靠它解析）
│   ├── style.css
│   ├── dashboard.js         # ES 模块：订阅 dormmate/v1/nodes/+/telemetry、校验报文、复核 status、卡片 + 趋势图 + 日志 + 3D 视图 + 当前重点那一行 + 语音提醒 + 处理动作 + fetch 那份 ML 结果
│   ├── logic.js             # 优先关注的算法 + 处理动作的状态机 + 顶部那一行/语音那句的措辞 + ML 那一段的措辞：只放纯函数，不碰 DOM、不读当前时间（ES 模块，单独测）
│   └── lib/
│       ├── mqtt.min.js      # 本地引用：它挂了就一条数据都收不到，所以不走 CDN
│       └── chart.umd.min.js # 备用：Chart.js 默认走 CDN，断网时改成引用这个
├── 3d/                      # M6 三维场景（ES Module + importmap，必须走 http 服务器）
│   ├── index.html           # 容器 + importmap + 节点选择（dorm-a/b/c）+ 订阅 MQTT 筛给当前节点，另留 4 个手动预览按钮
│   ├── scene.js             # createDorm3D(container)：宿舍 + updateScene(status) / setFanOn / setLabel / setFocus（当前重点那圈环）
│   └── lib/three.module.js  # three 0.160.0 的 ESM 单文件，断网时把 importmap 指过来
├── miniapp/                 # M4 微信小程序（用微信开发者工具打开这个目录）
│   ├── app.js / app.json / app.wxss / sitemap.json
│   ├── pages/index/         # 输入温湿度 → 按统一规则显示状态与建议
│   ├── pages/logs/          # 开发者工具自带的日志页
│   ├── components/navigation-bar/
│   ├── utils/rules.js       # 规则（小程序侧实现，CommonJS 的 module.exports）
│   ├── utils/util.js
│   └── project.config.json  # 注意：里面没有 miniprogramRoot，所以打包根就是 miniapp/
├── fixbom.py                # 把源码里误写的字面 BOM 换回可见转义
├── start_broker.bat         # 一键启动 Mosquitto
├── start_web.bat            # 一键启动静态服务器并打开浏览器
└── open_firewall.bat        # 放行 8000/9001 的入站规则（手机访问用，需管理员）
```

规则是**一个语言一份**、各自只有一个文件：Python 侧 `status_rules.py`，
JS 侧 `shared/rules.js`。除此之外任何地方都不应该再出现 `temperature < 18`
这类判断——`tests/script.test.js` 里有一条检查专门盯着这件事。
Python 侧现在有两个 `judge_status`，但只有一份实现：`analysis/rules.py`
是 `status_rules.compute_status` 的**转发**（`import ... as judge_status`），
阈值也是从根模块借的，不存在第二组数字。

## CSS 修改位置

样式全在 `web/style.css`（609 行），**没有引入任何 CSS 框架，纯手写**，
也没有预处理器 —— 改完存盘刷新即可，不需要构建。

### 要改配色，只改文件开头这一处

颜色全部以**角色**（role）命名，收在文件最前面的变量里，下面的组件只引用变量、
不写具体色值。所以换主题不需要翻遍全文。

| 位置 | 内容 |
|---|---|
| `:root`（第 4–22 行） | 版面与墨色：`--page` 页面底色、`--surface-1` 卡片底色、`--text-primary` / `--text-secondary` / `--text-muted` 三级文字、`--hairline` 分隔线、`--border` 描边、`--focus` 聚焦环 |
| `:root` 里的四档状态色（第 18–21 行） | `--status-good` 正常 / `--status-warning` 偏冷 / `--status-serious` 偏湿 / `--status-critical` 偏热 |
| `@media (prefers-color-scheme: dark)`（第 24–36 行） | 跟随系统的深色主题，**只重定义版面与墨色** |
| `:root[data-theme="dark"]`（第 38–48 行） | 点右上角「深色」按钮后的手动主题，优先级高于系统设置 |

⚠ 四档状态色**故意不随主题变化**（深色模式下也是同一组值），改的时候注意这点：
它们代表的是环境状态，不是界面风格。

### 分块位置

每一块开头都有一行 `/* ---------- 名字 ---------- */` 注释，在编辑器里搜中文名就能跳过去：

| 块 | 起始行 |
|---|---|
| 顶栏（标题 / 连接徽章 / 主题按钮） | 第 74 行 |
| 手动录入表单 | 第 146 行 |
| 录入历史表 | 第 234 行 |
| 语音指令 | 第 272 行 |
| 现场快照 | 第 328 行 |
| 节点卡片 | 第 393 行 |
| 空状态 | 第 493 行 |
| 最近消息表 | 第 514 行 |

状态色到具体 class 的绑定在第 486–491 行（`.is-good` / `.is-warning` / `.is-serious` /
`.is-critical` / `.is-unknown`），卡片和徽章的底色 / 描边都从这里的 `--c` 继承下来 ——
所以给一张卡片换状态色，只需要换它外层那个 class，不用碰卡片自己的规则。

## 统一约定

**状态判定（按顺序判断，命中即停 —— 顺序不可调换）**

| 顺序 | 条件 | status |
|---|---|---|
| 1 | `temperature < 18` | 偏冷 |
| 2 | 否则 `temperature >= 30` | 偏热 |
| 3 | 否则 `humidity >= 75` | 偏湿 |
| 4 | 其余 | 正常 |

所以 **31℃ / 80% 是「偏热」而不是「偏湿」**——规则 2 先命中。

**统一 JSON**

```json
{"nodeId":"dorm-a","temperature":31,"humidity":78,"status":"偏热","time":"2026-09-22 20:30:00"}
```

- `status` 永远由 `temperature` / `humidity` 算出，不接受调用方传入。
- `time` 固定 `YYYY-MM-DD HH:mm:ss`。

**回归测试数据**：25/60→正常；16/60→偏冷；31/60→偏热；25/80→偏湿。

**MQTT**：本机 Mosquitto；MQTTX 走 TCP 1883；浏览器走 `ws://<页面所在的地址>:9001`。

| Topic | 谁发 | retained | 说明 |
|---|---|---|---|
| `dormmate/v1/nodes/<nodeId>/telemetry` | 发布端 | 是 | 一条读数 |
| `dormmate/v1/nodes/+/telemetry` | —— | —— | 订阅用（前后端都用这一条） |
| `dormmate/v1/state` | core | 是 | 全局状态快照（Phase2：谁该先看、每个节点现在什么样） |
| `dormmate/v1/cmd` | 前端 | **否** | 指令（Step D3：`{"nodeId":"dorm-b","action":"handle","source":"dashboard","time":"…"}`）。发的人有三个：看板上那个「开启风扇 / 通风」按钮（`source: dashboard`）、`simulator/send_cmd.py`（`manual`）、剧本里的 `handle` 帧（`script`）—— **core 那行 `[指令]` 括号里就是它**。**不 retained** —— 指令是一次性的，留在 broker 上会让下一次起 core 时凭空把某条事件推进「处理中」 |
| `dormmate/v1/log/reject` | core | **否** | 非法报文（清 retained 的那条空报文**不算** —— 它根本不是报文）；坏消息不许留在 broker 上，否则每开一个看板都先看到它 |
| `dormmate/v1/core/status` | core | 是 | core 在线/离线（遗嘱 LWT：core 一掉线，broker 立刻替它发 `offline`） |

topic 字符串**只有 `config.py` 一处出处**（`topic_for` / `TOPIC_PATTERN` / `STATE_TOPIC` …），
`core/config.json` 里刻意不放 —— 放第二份就意味着改 topic 时只改一边，
于是 core 订阅的和前端订阅的是两条不同的 topic，而且两边都不报错，
只是页面上永远没有数据。这个坑在 Phase1 的旧三段式 topic 迁移里已经踩过一次。

**节点**：`dorm-a`、`dorm-b`、`dorm-c`（M5 起启用；M1–M4 只用 dorm-a）。

## 环境准备

```bash
py -3.14 -m pip install -r requirements.txt      # paho-mqtt + pandas + matplotlib
```

### ⚠ 必须用 64 位的 `py -3.14`，不要用 `python`

本机 PATH 上的 `python` 是 **32 位**解释器（`D:\Python\python.exe`），而
**pandas 和 matplotlib 早就不发布 32 位 Windows 包了**。在它上面
`pip install pandas` 会退回源码包，然后因为找不到 MSVC 编译环境
（`Could not find ...vswhere.exe`）失败——报错信息指向编译器，很容易误判成
「缺 VS 构建工具」，其实是位数不对。

所以项目统一到 64 位的 Python 3.14（`C:\Program Files\Python314`）。
本文档里所有 Python 命令都写 `py -3.14`，包括后台常驻的模拟器和静态服务器。

判断当前是哪个解释器：

```bash
py -0p                                    # 列出所有解释器及路径，看位数
python -c "import struct; print(struct.calcsize('P') * 8)"   # 32 就说明踩坑了
```

装完确认一下：

```bash
py -3.14 -c "import pandas, paho.mqtt, matplotlib; print(pandas.__version__, matplotlib.__version__)"
```

Mosquitto 若未安装：

```powershell
winget install --id EclipseFoundation.Mosquitto -e
```

装完重开一个终端，`mosquitto -h` 能出版本号即可。默认安装路径是
`C:\Program Files\mosquitto`，若命令找不到，把这个目录加进 PATH。

### ⚠ 装完必须处理：它会自己占住 1883

Mosquitto 安装程序会顺手注册一个**开机自启的 Windows 服务**（`mosquitto.exe run`），
用默认配置占用 `127.0.0.1:1883`。后果很隐蔽：

> `py -3.14 -m simulator.simulator` 显示发布成功，MQTTX 也能收到数据，
> 但浏览器看板永远没数据 —— 因为模拟器发给的是那个服务，
> 而看板连的是项目自己的 Broker（9001）。

两个 Broker 各管一半，演示时非常像"代码有 bug"。本机已经处理过
（**需要管理员权限**，普通命令行会报"拒绝访问 5"）：

```powershell
net stop mosquitto
sc config mosquitto start=demand
```

`start=demand` 只关掉自启，可执行文件仍在，`mosquitto` 命令照常用。
之后 1883 归 `dormmate.conf` 使用。

换一台机器若出现同样症状，先确认端口归属：

```powershell
netstat -ano | findstr "1883 9001"
```

两个端口的 PID 必须是**同一个进程**，否则就是又分叉了。

## 运行（三个终端）

**① 启动 Broker**

```bash
mosquitto -c mosquitto/dormmate.conf -v
```

必须用这个配置文件。Mosquitto 2.x 默认只监听 localhost 且禁止匿名连接，
不写 `listener 9001` + `protocol websockets`，浏览器就连不上。

**② 启动数据源**

```bash
py -3.14 -m simulator.simulator
```

默认每 5 秒发一条，按 `偏冷 → 正常 → 偏湿 → 偏热` 循环，覆盖全部 4 种状态。

**③ 打开看板**

```bash
py -3.14 -m http.server 8000 --bind 0.0.0.0 --directory .
```

浏览器访问 <http://localhost:8000/web/> 。不要直接双击 `index.html`（`file://` 下
部分浏览器会拦掉 WebSocket）。

⚠ **根目录必须是项目根，不是 `web/`。** 页面里用
`<script src="../shared/rules.js">` 引规则文件，如果根目录设成 `web/`，
`../shared/rules.js` 就跑到服务器根之外了，`http.server` 会拒绝这种越界访问，
规则文件 404，手动录入面板点了没反应（Console 里报 `judgeStatus is not defined`）。
所以地址带一层 `/web/`，看着啰嗦，但这是这条引入路径的直接后果。

⚠ **`--bind 0.0.0.0` 的含义**：监听所有网卡，手机 / 别的电脑才能打开看板
（见下一节）。代价是**整个项目目录**（含 `config.py`、`mosquitto/`、`tests/`）
对同局域网公开，任何人访问 `http://<你的IP>:8000/` 都能看到文件列表。
只想本机用就改成 `--bind 127.0.0.1`；演示完把窗口关掉，或者改回去。

Windows 上也可以用 `start_broker.bat` 和 `start_web.bat` 各点一下。

**用 VS Code 的 Live Server 也行**：工作区打开项目根，右键 `web/index.html` →
「Open with Live Server」，地址是 `http://127.0.0.1:5500/web/index.html`。

根目录的要求和上面 `http.server` 那条**完全一样** —— Live Server 默认以**工作区根**
为服务器根，`../shared/rules.js` 落在根之内，所以能取到。**不要把根设成 `web/`**，
那样 `../` 越界，`rules.js` 404，手动录入点了没反应（症状和排查见上一节）。

两个区别要知道：

- Live Server 默认只绑 `127.0.0.1`（本机），**手机打不开**。要让别的设备访问，
  还是得走上面那条 `--bind 0.0.0.0` 的命令，或者 `start_web.bat`。
- 它带**保存即刷新**。而刷新会清空「录入历史」（见「已知限制」），所以演示时
  改完文件记得先回页面上点一次「导出 CSV」。

端口是 5500 不影响任何东西：`127.0.0.1` 和 `localhost` 一样算安全上下文，
所以摄像头和语音指令照常能用；看板的 Broker 地址按 `location.hostname` 算出来
仍是 `ws://127.0.0.1:9001`，不是写死的端口。

## 让手机 / 别的电脑打开看板

三个端口里，只有 1883 本来就绑在 `0.0.0.0`（M5 多节点要用），
9001 和 8000 默认只在**本机**听得见。要让别的设备访问，三件事缺一不可：

| 步骤 | 做什么 | 不改会怎样 |
|---|---|---|
| 1 | `mosquitto/dormmate.conf` 里 9001 改绑 `0.0.0.0`，重启 Broker | 手机连不上 WebSocket，页面一直「连接中…」 |
| 2 | 静态服务器加 `--bind 0.0.0.0`（`start_web.bat` 已经是了） | 手机打不开页面 |
| 3 | 管理员下双击一次 `open_firewall.bat`，放行入站 8000 / 9001 | 前两步都做了，手机还是转圈——Windows 防火墙默认拦入站 |

然后手机浏览器打开：

```
http://10.102.196.160:8000/web/      # 换成你自己 ipconfig 里的 IPv4
```

本机 IP 用 `ipconfig` 看 `IPv4 地址`（本机现在是 `10.102.196.160`）。
`open_firewall.bat` 跑完也会把它打出来。

### 页面怎么知道该连哪台机器

`web/script.js` 里 broker 地址是**按访问地址算出来的**，不是写死的：

```js
function brokerUrl(hostname) {
  return `ws://${hostname || 'localhost'}:9001`;
}
const BROKER_URL = brokerUrl(location.hostname);
```

- 本机打开 `http://localhost:8000/web/` → 连 `ws://localhost:9001`
- 手机打开 `http://10.102.196.160:8000/web/` → 连 `ws://10.102.196.160:9001`

**这里必须按访问地址算。** 写死 `localhost` 的话，手机浏览器里的 `localhost`
指的是**手机自己**，它会去连手机的 9001，然后一直连不上 —— 而电脑上看一切正常，
这种"只有手机不行"的现象最难查。`tests/script.test.js` 里有 5 条检查盯着这件事，
包括一条「源码里不许再出现写死的 `ws://localhost:9001`」。

`file://` 直开时 `location.hostname` 是空串，`||` 会退回 `localhost` ——
那种打开方式本来就连不上 WebSocket，这里只是别让它拼出 `ws://:9001` 这种烂地址。

### 撤销

```powershell
netsh advfirewall firewall delete rule name="DormMate 8000"
netsh advfirewall firewall delete rule name="DormMate 9001"
```

---

⚠ **1883 故意没有放行。** 配置里是 `allow_anonymous true`（课程演示用的），
开到局域网等于同一个 WiFi 下谁都能往 `dormmate/v1/nodes/+/telemetry` 发布和订阅。
M5 真的需要别的机器发布数据时再手动放行：

```powershell
netsh advfirewall firewall add rule name="DormMate 1883" dir=in action=allow protocol=TCP localport=1883
```

## 用 MQTTX 验证发布端

新建连接：`mqtt://localhost:1883`（TCP），订阅 `dormmate/v1/nodes/+/telemetry`。
应能收到与 `simulator/simulator.py` 终端输出完全一致的 JSON。
发布端用了 retain，所以新订阅者会立刻收到最后一条。

## 跑测试

```bash
py -3.14 -m unittest discover -s tests -t . -v   # ①②③⑪⑫⑬⑭⑮⑯⑰⑱⑲，共 897 条
node tests/rules.test.js                          # ④ 规则 JS 侧，31 条
node tests/scene3d.test.js                        # ⑧ 3D 场景，224 条
node tests/scene3d-page.test.js                   # ⑨ 3D 页面的 MQTT 接线，65 条
node tests/miniapp-rules.test.js                  # ⑥ 两份规则实现交叉比对，48 条
node tests/dashboard.test.js                      # ⑦ 多节点看板，481 条
node tests/logic.test.js                          # ⑩ 优先关注 + 处理动作 + 按按钮那行说明 + 事件记录 + 总览与依据 + 趋势与两个出口 + ML 辅助判断，408 条
node tests/script.test.js                         # ⑤ 页面 JS 侧，150 条
```

`unittest discover` 会把 `tests/` 下十二个 `test_*.py` 一起收进来
（23 + 206 + 54 + 30 + 123 + 124 + 22 + 89 + 29 + 15 + 37 + 145 = 897 条），所以 `py -3.14` 那条要装 pandas 和 matplotlib，
⑫ 那 124 条还要 scikit-learn（没装的话，要真跑模型的那几类会被整类 `skipUnless` 跳过，
纯函数那批照样跑 —— 输出里是 `s` 不是失败）。
`node` 那七条不需要任何依赖，也不用起服务器。

画图那几只测试在开头 `skipUnless(HAS_MPL)`：没装 matplotlib 时会**跳过**
（输出里是 `s` 不是 `.`）而不是报一堆错 —— 读 CSV、统计、复核这几步没它也
能跑，不该被一个画图依赖拖着。真要看图出没出，就看跳过了几条。

| 命令 | 管什么 |
|---|---|
| ① 23 条 | 老师给的 4 条回归数据、优先级（31/80 必须是偏热）、边界值（18/30/75 取等号）、JSON 字段与 time 格式、Topic 约定 |
| ② 206 条 | `analysis/rules.py` 是转发而非第二份实现（`assertIs` 直接比函数对象）、路径按项目根推导、CSV 读取（BOM / 缺列 / 缺文件 / 只有表头）、统计值、样例数据的 status 与规则一致；Step 2-3 的 `rule_status` 重算、不一致行识别（含温湿度缺失不能算成「正常」）、状态计数、关注列表、`summary` 的键与 JSON 可序列化、时间范围、`verbose=False`、表格的中文列宽；Step 2-4 的趋势数据整理（排序 / 跳过的行 / 缺失留 nan）、横轴时间格式、字体列表、写出的确实是 PNG、目录自动创建、空表也出图、画完不留下没关的 figure、横轴跨度为 0 时不刷警告；Step 2-5 的 HTML 转义（`<script>` 撑不破页面）、表格拼装、数字全部来自 summary（换一份数据数字跟着换）、占比与合计、关注表格只列非正常、趋势图的相对路径与占位、规则不一致时的横幅、`sections` 额外区块的顺序与转义约定、写文件的编码 / LF / 目录自动创建；Step 9-2 的温湿度列校验：`_parses_as_number` 判的是**内容**转不转得动（`25` / `'25'` / `' 25 '` 算，`'不热'` / `'abc'` / `''` / `'25℃'` 不算 —— 它和 `isinstance` 差的正是关键的那一格：整列被读成文本之后，本该好好的 `25` 也成了 `'25'`）、温度列是文字时报错、湿度列是文字时报错、**报出来的是第几行**（坏值在第 5 行就说第 5 行，不是列里第一格）、**报的是哪一刻**（只报行号不报时刻等于把人往上面几行引）、**带引号的 `'25'` 也算不是数字**（判据是「能直接比大小」，不是「看起来像不像数字」）、**空着的值不算不是数字**（列里只有空格子时照常读进去，一格都不报）、**空格子在前面时报的还是后面那格文字**（空值放行不算「写坏了」，也不能把报错引到空格子上）、小数和负数照常；Step 9-3 的「ML 异常分析」区块（`TestMlSection` 18 条 + `TestMlSkipSection` 2 条 + `TestMlResultJson` 16 条，另在 `TestHtmlTable` 加 4 条、`TestMain` 加 3 条）：区块标题、**表头就是需求给的那六列、而且按那个顺序排**、两种口径各说各的（26/62 那一行的六格逐格对：`dorm-a` / `26` / `62` / `正常` / `与历史明显不同` / `-0.0564` —— 两列对调的话两句话都还在表里，只查「有没有出现」看不出来）、训练数据与待判断数据各自的**文件名与条数**（断言连着说「模拟历史，共 40 条」「new_samples.csv（4 条）」，不是光找「40 条」：门槛松紧那句里也有「40 条历史」，结论那句里也有「4 条新数据」，只找数字等于没测）、**不印本机的全目录**、说清了这一段判的不是报告上面那份 CSV、那句「ML 只作为辅助判断」的说明在（也钉了「提前写好的三条阈值」和「和这个宿舍平时像不像」两处措辞）、结论那句就是 `ml.render_comparison()` 算出来的那一句（和命令行上逐字相同）、**高亮的正好是两种口径不一致的那两行**（26/62 是正向、17/60 是反向，25/60 和 31/60 不亮 —— 只数「有两行带 class」是抓不住「高亮错行」的，所以是逐行取温度那格来比）、**结论那句话里的尖括号也转义**（时刻是从 CSV 读来的，`ml._brief` 取 `[11:16]` 那一段，所以凑一个把 `<b>` 落在这一段的时刻）、读数按数值格式打（`25` 不是 `25.0`）、**分数正好是整数时不拖 `.0`**、没有 `nodeId` 的行给破折号、门槛松紧跟着结果走（换成 8 条历史 / 3 条被判，那句里的数字跟着变）、**一条新数据都没有时不摆空表**、`nodeId` 里的尖括号被转义；跑不起来时那一块：照实说原因、说「报告其余部分不受影响」、原因里的尖括号也转义；那份 JSON：键名跟看板那份统一 JSON 一个约定（`nodeId` / `time` / `ruleStatus` / `mlStatus` / …）、**只留文件名不留本机路径**（整份里不许出现 `/tmp`，文件名里不许出现冒号）、温湿度写成整数而不写 `25.0`、该是小数的地方还是小数、分数保留四位、**三个不一致的计数分开放**（正反各一条的桩是对称的，对调了看不出来，所以专门给一组「正向 2 条 / 反向 1 条」的）、参数 / 门槛 / 两个条数 / 门槛松紧 / 生成时刻都跟着走、能被 `json.dumps` 倒出来（numpy 标量倒不出来，这一条拦的就是「哪一格忘了转成内置类型」）、写出来能原样读回来、目录不存在会自动建、**是 LF、末尾带换行、缩进两格**、中文原样写进去（`ensure_ascii=False`）、默认路径就在报告旁边；`_html_table` 的 `row_classes`：**不给这个参数时行上不带 class**（老调用方一个都不受影响）、按行加上去、空串就是不加（不留 `class=""`）、**个数和行数对不上就抛**（少给几个的话高亮会落在别的行上）；以及端到端三只：报告里**真的有**这个区块且有不一致的行在亮、命令行和报告说的是同一句、**那两份文件读不到时报告其余部分照常出而 ML 那份 JSON 不写**、`--no-report` 时报告和 JSON 一起跳过 |
| ③ 30 条 | 报告的段落齐全、占比、表格里的竖线/换行转义、空表不出现 `nan%`、写文件的编码与 LF 换行、结论的并列与阈值判断、报告里**不出现**建议文案（那是网页 `getAdvice()` 的活） |
| ⑪ 123 条 | Step 8-2 的今日摘要与模拟日数据。分三块：**分段**（`find_daily_events`）——一条异常数据开一段、段内再来异常只是延长、来一条正常数据才结案、**段里从偏热变偏湿不改口**（说的还是开段时那个类型）、文件读完还开着的段照样收进来并标成未恢复、`minutes` 是**最后一条减第一条**（不是条数乘间隔）、`count` 数的是异常点数、缺 `rule_status` 列时**报人话并退出**（不许偷偷去读 CSV 里那列原始 `status`）、缺 `nodeId` 列时报人话、`nodeId` 为空的行走 `(未知节点)` 这一档而不是被丢掉（丢掉的话它下面的段会凭空消失而总数照样报）、`(缺失)` 的行**既不开段也不结段**（和看板丢掉脏报文同一个口径）、**开始时间相同时按节点名定序**、没有正常数据隔开就仍算一段（乱序不保护，和「报文没有乱序保护」同一条）、`NaN` / `None` / 空串一律当空、时长算不出来时说「时长未知」而不是「0 分钟」；**句子**（`render_daily_summary`）——没有事件的节点说「全天整体正常」、**一个节点都没有数据时说「这一天没有收到任何节点的数据」而不是「都正常」**、一个事件都没有时不说「今日共 0 次」、总事件数等于事件条数（不是节点数）、事件里冒出 `node_ids` 没提到的节点时**补进句子**（不许在总数里算一笔却不吭声）、第 2 段起改口说「又出现」、恢复和不恢复各两句、顺序按码元序；**数据来源**（`source_note`）——`source` 全是「模拟」时说模拟日数据、没有 `source` 列时如实说看不出、**不许写死成「模拟日数据」**（拿真数据跑的报告也会自称是模拟的）；外加两条端到端的：默认那份 `data/day_sim.csv` 的摘要**逐字等于**需求里那句例子，以及 `make_sim_data.py` 生成的 CSV 字节（BOM / CRLF / 无裸 LF / 列顺序 / 行序按时间和节点名交错）、`status` 每一行都和 `rules.judge_status` 算出来的一致、**跨进程也是同一个种子同一份数据**（两个 `PYTHONHASHSEED` 不同的子进程各跑一次，比字节）、换种子 / 换事件时刻后摘要必须跟着变、`--hot-minutes` 取不到采样点时明说、`main()` **不许另读一次文件**（结构守卫，见下）。Step 9-1 的平时历史与新数据：历史正好 40 条、全是 dorm-a、条条都在 24~26 ℃ / 55~65 % 里、**条条都正常**（「平时」的定义，换几个种子也不许抖出一个异常）、时间从 08:00 起每 5 分钟一个正好到 11:15 且中间不跳点、每一行的 `status` 都由 `rules.judge_status` 算出来、**排在 day_sim 的后一天**（同一天同一时刻两份数据会报出两个读数，像在吵架）、同一个种子两次一字不差而换种子就该变；新数据就是题目给的那六条（顺序、数值都钉住）、**`status` 是「正常 正常 正常 偏热 偏湿 偏冷」**（对得上四组回归数据）、时间从 11:20 起正好接在历史末点后面一个间隔、和历史的时刻集**一个都不重叠**、**换 `--seed` 这六条一个字节都不变**（它们是输入，不是造出来的）；两份文件分开：文件名固定、历史里正好 40 条（46 条就说明新数据被并进来了）、异常那几条的取值从区间上就不可能出现在历史里（31 ℃ / 17 ℃ / 80 % 都不在历史的取值范围内，**这是证出来的、不是恰好没撞上**）、`--out` 挪到哪三份就一起挪到哪、`--date` 换一天三份一起换（历史和新数据排在它的后一天）、日数据那份多写了两份文件之后**还是原来那 864 行**、命令行把两份的路径和「从哪一刻起」都打印出来；以及 `data/` 里那两份跟着仓库走的文件**逐字节**等于重新生成的结果（连 BOM 和 CRLF 一起比） |
| ⑫ 124 条 | Step 9-2 的 Isolation Forest 对照。分五块：**常量与约定**——参数就是需求给的三个（`n_estimators=100` / `contamination='auto'` / `random_state=42`，多一个少一个都红）、只用温湿度两列、**判决门槛写的是 0**、`1 = 接近历史常态` / `-1 = 与历史明显不同` 这对约定写成了常量、默认路径指向 `data/` 里那两份；**纯函数**——`ml_text` 认得 `1` / `-1` 也认得 `'1'` 这种形状、不认识的标签原样写出来不假装懂、`score_is_outlier` 只按「小于 0」判（负零不算异常）、**对照表的四种组合**（规则正常/异常 × ML 常态/不同，只有「规则说正常、ML 说不同」才算不一致）、原始值原样带在行里、**分数四舍五入到四位**、结果能直接 `json.dumps`、**每格都是内置类型**（numpy 的 `bool_` / `int64` 不是 JSON 能序列化的东西，跑过一遍才发现）、顺序跟着给的顺序；**门槛核对**——`_check_threshold` 对得上时不吭声、**标签和分数对不上就报错**（而且报的是 `RuntimeError` 不是 `ValueError`：`_main` 会把 `ValueError` 当用法错误吞掉，报错报告不起来比不报更难查）、分数恰好 0 而标签是 -1 也报、空的两串不报；**真数据**——两份各多少条、路径是绝对路径、**规则那一列是 `analysis.add_rule_status()` 重算的**（CSV 里那列 `status` 说了不算）、ML 那一列正好是那六个标签、六个分数逐个钉住、**不一致的就是 11:25 和 11:30 那两条**、反方向一条都没有、参数原样带在结果里、**门槛松紧那个数（拿模型回看 40 条历史里有 18 条被判不同）**、结论那句话和单独算的一致且说的就是这条数据、同一个结果跑两次一字不差；**造的数据**——两边都说正常时不报不一致、**CSV 里 `status` 写着什么不算数**、没有 `nodeId` 列也能跑、列顺序变了结果不变、列里夹着别的列也认、历史 / 新数据是空的时候说人话、新数据里有空格子时说人话、只有一条也要能跑完；**命令行**——默认那两个文件、把模型和参数打出来、把门槛和门槛松紧打出来、表头七列、六条数据都在表里、不一致的行有标记、结论那句和函数返回的是同一句、可以指定别的两个文件（相对路径按项目根展开）、**成功时返回 0**（`capture()` 接的是 `_main` 的返回值：不接的话「跑成功了也返回 1」这种改法一点动静都没有）、文件不在 / 新数据是空文件 / 温湿度不是数字 / 某一行多写一个逗号，四种都报人话而不是甩一串 traceback。另外有一条**结构性守卫**：把 `build_model` 换成探针跑一遍 `run_ml`，断言交给它的那一帧**只有历史那 40 条**、行数等于历史条数、且里面找不到新数据那条 55 ℃ / 5 %。为什么非得这么测：拿新数据一起 fit 的话，「正常」就被新数据自己重新定义了（一条离谱的读数顺手把正常范围拉大，于是它自己就不离谱了），而模型的 `estimators_` 个数、`n_features_in_` 一个都不会变 —— 只看模型本身看不出这件事 |
| ⑬ 54 条 | Phase1 的模拟器（`simulator/simulator.py`）。**seq 计数**——从 1 开始、每发一条加一、两个节点各数各的、`step` 与 `seq` 是两回事（前者记取到第几个采样点，后者记第几条消息）；**报文**——`seq` / `source` 写得进去、`status` 还是算出来的（温湿度多离谱都只认规则）、`seq` 给小数也当整数写；**cooling**——33→31→29 的状态序列正好是「偏热 偏热 正常」、每轮固定降幅、降到 24 就保持不再往下、**怎么降都掉不进偏冷**（这个模式演示的是从偏热回到正常）、湿度一动不动（状态变了只可能是温度越过 30，归因才清楚）、降幅可调；**json 剧本**——帧序列读得对、`repeat` 展开、帧里能写死 `time`（并真的进了报文）、没写 `time` 就是 `None`（用当下时间）、`repeat` 会把时间一起复制、时间写坏了报的是哪一帧、形状对但日期不存在（`2026-02-30`）也拦下、时间不是字符串也拦下、只有 `comment` 的帧跳过、没写 `node` 就用 dorm-a、剧本自带 `interval`、字符串数字也认；坏剧本一律说人话：文件不在 / 不是 JSON / **存成了 GBK** / 最外层不是对象 / frames 空 / 帧缺字段 / 温度不是数字 / `repeat` 是 0、-1、1.5、`true` / 通篇只有 comment；**仓库里那份演示剧本本身也有测试兜着**（帧序和四种状态全覆盖）；**节点归一**——默认 dorm-a、`--nodes` 逗号分隔、逗号后带空格也认、`--all-nodes` 就是三个、三种写法同时给报错、`--nodes` 是空的报错、**未知节点不拦只警告**（拿 dorm-z 发数据是 D4 要用的手段）；以及拿 `--dry-run` 真跑一遍 `main()`：三节点一轮三条、**三个节点的状态各不相同**（错开起点，不然三张卡一模一样）、seq 每轮加一且按节点各数各的、剧本跑完就停不循环、剧本与 `--mode` 不能同时给、剧本坏了返回 2、两个节点参数同时给返回 2、cooling 的温度确实是往下走的 |
| ⑭ 22 条 | Phase1 的 `simulator/publish_one.py`（手动发一条 + 故障注入）。用假客户端顶掉真连接，验的是「实际发出去的 topic / payload / qos / retain」；**报文**——正常一条的字段与状态、`status` 仍然是算出来的（没有参数能手工塞一个错的进去）、`seq` / `source` 能指定、`--time` 能指定且格式不对时说人话、缺温湿度时说人话并顺带告诉人还有 `--raw` 这条路、**`--raw` 原样发出去一个字符都不改**（前后空格都不动）、`--raw` 时还给了温湿度就忽略并提示、`--clear` 发的是空串、`--clear` 与 `--raw` 不能同时给；**topic**——默认按约定拼、`--topic` 能覆盖；**真发一遍**——发出去的是约定 topic 且默认不保留（故障消息要是被 retained，之后每开一个看板都先看到这条坏数据）、坏的 JSON 照样上线（**工具不替 core 把关**，这是 D4 的手段）、`--clear` 必须带 retain 否则删不掉、`--retain` 要显式开、`--dry-run` 压根不建客户端、参数错了返回 2 而且一条都不发、连不上返回 1 并且告诉人怎么起 broker |
| ⑮ 89 条 | Phase2 的 `core.py`（业务大脑）。用假客户端顶掉真连接，走的是真的 `on_message` 那条路（不是直接调内部函数）。**导入陷阱**——`find_spec('core').origin` 必须以 `core.py` 结尾、`core/` 里不许有 `__init__.py`、`core/` 下只该有 `config.json` 一个文件（`core/` 一旦变成包，`import core` 拿到的是那个包而且**不报错**，几千行业务逻辑整段失效）；**topic 解析**——严格五段、多一段少一段都不认、`+` 通配符不算节点名；**报文校验**——九道判据各来一遍（非 JSON / 不是对象 / 缺字段 / 类型不对 / NaN / Infinity / `true` 混进数字 / `time` 少秒 / 日期不存在 / 未知节点 / topic 与报文 nodeId 不一致 / status 与重算不符），**拒收的才发 reject**、reject 的 `retain` 必须是 `False`、payload 超长要截断、`status` 对不上只记 `statusMismatch` 不拒收（数据本身没错，丢掉反而少一条读数）、老师给的 4 条回归数据故意把 status 写错喂进去，四条全被判为「不一致」；**状态机**——首条开一段、起点不动、段内从偏热漂到偏湿仍是同一段、**连续 N 条正常才算结束**、中间插一条异常只清计数不动起点、`normals_until_recovery` 在没有开着的段时是 `None`；**恢复路上的那两条读数**——`status` 是最新读数（正常）而优先关注用的是 `abnormal_status`（偏热），且严重度那一步也按后者比（按前者比的话，一个还在异常里的宿舍理由会写成「已连续正常 7 分钟」，**而且不报错**）；**优先排序**——离线的节点不参与但仍在快照里、`tick()` 只在「收到过又安静了」时报掉线（从没来过的节点是「还不知道」，不是「掉了」）、同一次只报一遍、权重从配置里取、**日志只在换人时打**（比的是节点 id 不是整句话 —— 整句话里嵌着越来越长的时长，拿它当判据每一条都「变了」）；以及一条静态检查：`core.py` 的源码里不许出现任何节点名；**快照**——五块的字段名与类型、全部正常时 `priority` 是 `null`、内容变了才发、`force=True` 例外；**遗嘱**——LWT 在 `connect()` **之前**就设好了（paho 2.x 里遗嘱存在 `_will_topic` / `_will_payload`，`_will` 只是个 bool）、掉线发 `offline`、启动发 `online`；**配置核对**——阈值 / 节点列表 / 恢复条数分别改坏，三种都拒绝启动并且**说的是改哪一边**；**命令行**——`--check` 对得上返回 0 并打出摘要、对不上返回 1 且不连 broker；**清 retained 的空报文**（`--clear` 发的那条）——空 payload 判成 `ignored` 而**不拒收**、`rejected` 和 `received` 都不动、reject topic 一条没有、节点历史与开着的那一段一个字不动、也不因此多发一次快照、计数进 `counters.retainedCleared`、日志打的是 `[保留]` 而不是 `[拒绝]`；**只认长度 0**（空白字符仍按坏报文拒收），topic 形状不对时先报 topic（先确认这条消息是不是我们这一路的） |
| ⑯ 29 条 | Phase2 的 `rules.py`。`judge_status` **就是** `status_rules.compute_status` 那个对象本身（`assertIs`，转发写成「重抄一遍」这里就红）；`rank_priority` 的四步：时长决出、时长打平比条数、条数也平比严重度、全平按字典序，**只有进到某一步的节点才参与那一步的比较**（时长不同的那些根本不该出现在比条数的名单里）、传进来的东西一个都不改、空输入返回空表、`format_duration` 的边界（59.9 秒说「不到 1 分钟」、非数 / 负数 / NaN / 无穷一律「不到 1 分钟」）、理由的两半（第一名说凭什么赢、其余说输在哪一步，都不许含糊成「它更严重」）；**权重可覆盖**（改了权重赢家和措辞一起变）；以及那条静态检查：把注释和**文档字符串**用 `ast` + `tokenize` 剥掉之后，源码里不许出现任何节点名 —— 但**其他字符串字面量要留着**（写死节点名最典型的形态就是 `if node_id == "dorm-a"`，一起删掉这个检查就永远绿了），所以配了一条元测试：只有注释的代码必须通过、`node.node_id == "dorm-a"` 必须被抓出来 |
| ⑰ 15 条 | Phase2 的三套剧本（`simulator/scenarios/d2_case*.json`）。不是给人读的演示稿，是**能被断言**的：每一帧逐帧喂给 core，记下每一步的结论，跟预期的**换人轨迹**对。只记「换人」那几步（同一个人连续领先不重复记），因为「没有乱跳」也是结论的一部分。`d2_case1`：空 → dorm-b → dorm-c → 空（时长决出、靠恢复交接），并断言 20:07 / 20:08 那两条正常**没有**触发换人；`d2_case2`：dorm-a → dorm-b → dorm-a → dorm-b → dorm-a → 空，而且每一步的理由必须是真的那一步（第 2 步赢的那行要提「异常次数最多」，第 1 步赢的那几行才提「持续时间最长」）；`d2_case3`：dorm-a → dorm-b → dorm-a → 空，第 2 步赢的那行要提「偏湿比偏冷更要紧」，第一条理由必须是「唯一的异常节点」而不是「持续时间最长」（只有一个异常节点时，比时长那一步根本没发生过）。另有四条件对所有剧本都成立：三个节点都用上、**同一个节点的时间必须往前走**（core 用报文时间算时长，倒着来的时间会算出负数被夹到 0，「持续了多久」就成了空话而且不报错）、**至少换两次人**（只换一次证不了「跟着数据自己变」）、**结尾必须是三个都正常**（收尾状态要看得见，方便截图） |
| ⑱ 37 条 | Step D4 的故障注入清单（`simulator/inject_faults.py` + `tests/test_inject_faults.py`）。**不连 broker** —— 连真 broker 的那种自检是脚本自己的 `--verify`。这一批测的是**清单站不站得住**：每一条逐条喂给 `core.validate_message`，结论必须和清单上写的那个 `outcome` 对上（`reject` → `ok is False` 且 `ignored is False`；`pass` → `ok is True`；`silent` → `ignored is True` 且发出去的就是空串；`unrouted` → `ok is False` 且理由里有「topic 形状不对」）。**理由关键词也钉住**：第 3 条（topic 和报文对不上）如果是因为 JSON 写坏了才被拒，光数条数照样绿，而演示时那句理由是当着人念出来的。清单本身的性质：编号唯一且递增、每条都写了期望、**只有 `reject` 才带理由关键词**、有一条确定能通过的当对照（全都能拦住也可能是「什么都拦」）、每条参数 `publish_one` 都吃得下、**只有清 retained 那条带 retain**（故障消息被 retained 的话，之后每开一次看板都先看到它）。逐条验它宣称的性质：第 1 条真的 `json.loads` 就报、第 2 条是合法 JSON 只是缺字段、第 3 条 topic 里的节点和报文里的确实不一样**而报文本身是完好的**（所以看板那边只警告不丢弃）、第 4 条的节点确实不在 `config.NODE_IDS` 里、**第 5 条 99℃/200% 被如实收下且判成偏热**（core 里没有任何范围校验）、第 6 条 `[1,2,3]` 是合法 JSON 但不是对象、第 7 条的段数和订阅 pattern 对不上**且 pattern 里没有 `#`**（有 `#` 的话段数规则就不成立了）。两个前端对「未知节点」的差异拿源码钉住：`dashboard/dashboard.js` 有节点名单也有「未知节点」那句话、`web/script.js` 两样都没有 —— README 上写着这是设计如此，哪天有人给 `web/` 也加了名单这一条会红。命令行的几条路（`--list` / `--dry-run` **压根不建客户端**、`--only 99` 返回 2、连不上返回 3 并告诉人怎么起 broker，都是拿一个「一被调用就报错」的假 Client 顶着的）。最后是一整条 `run()`：拿假 Client **顺便扮一下 core**（订上 reject 之后，`publish` 时按 topic + payload 回一条 reject），于是「拒了但拒错了原因也要红」「core 没起时不能喊拦住」「放行的不该收到 reject」「不投递那条说的是收不到」「清 retained 那条说的是 `[保留]` 且确实带了 retain」这些都能在不起 broker 的情况下跑；另有一组直接测比对函数：**比的是 topic + payload 全文，不是「有几条 reject」** —— 连着跑九条，只数条数的话「第 2 条没被拒、第 3 条被拒了两次」总数照样对得上 |
| ⑲ 145 条 | Step D3 的事件状态机（`events.py` + `core.py` 的那几处接线 + `simulator/send_cmd.py` + `d3_event.json`）。**也不连 broker** —— 状态机是纯的，喂数据就行。**开案**：节点第一次异常开一条 `OPEN`、`start_time` 取的是**报文里的 `time`** 不是墙上时间（拿墙上时间的话，剧本里 20:00 那段会被记成今天下午）、同一段里再来异常不另开（`abnormal_count` 不是 1 就一定还在原来那段里）、恢复正常这条事件还挂着（要等连续 N 条正常，不是一条）、开案快照里 `durationText` 是 `null`（起点就是它自己，写「0 分钟」是在说一件没发生过的事）。**处理**：`handle` 把 `OPEN` 推成 `HANDLING` 并在 `actions` 里记一笔、`verify_from` 记的是「从第几条验证数据之后开始算」、在已经 `HANDLING` 的事件上再点一次只多记一笔动作而**不动 `verify_from`**（动了的话验证窗口会被第二次点击推走，前面收的正常数据白算）。**恢复**：要连续 N 条正常（N 取自 `core/config.json`）、恢复那一刻写的是最后那条正常数据的 `time`、`recovered_at` 与 `result` 一起填上、结案快照的 `durationText` 是「起点到这条」的时长。**未恢复**：处理之后连着 N 条还是异常就结案成 `UNRESOLVED`、`recovered_at` 保持 `null`（**不是**写一个空串，看板那边判的是 `null`）、`result` 里说的是最后那条是什么状态。**判据不能被存档数拖累**：`events_verify_max=2` 而门槛是 3 时照样判得出 `UNRESOLVED`（数存档里最后几条的话，第 3 条早就被挤掉了，而 `verify_dropped` 还是 0 —— 这条是真跑出来的，见下）、来一条正常就把这个计数清零（不清零的话「异常 正常 异常 异常」会被算成连着三条异常）。**落盘**：写 `<名>.tmp` 再 `os.replace`、`newline="\n"`、`load()` 把读不动的文件改名成 `.bad` 而不是覆盖掉、坏的那几条跳过并报数、**启动时读到还没结案的事件一律按 `UNRESOLVED` 收尾并在 `result` 里说明是重启造成的**（不然它会永远挂在「处理中」，重启一次变一次）、**验证数据在结案之前就得到文件里**（不是只有开案/结案那两下才写 —— 一条迟迟结不了案的事件，中间收的验证数据要是只在内存里，core 一被杀就全没了，而 `verify` 正是「处理之后好了几条」的唯一凭证；这条是拿真文件读回来断言的，把 `observe()` 末尾那次节流写删掉就红）。**四条红线的静态检查**（拿 `ast` 抠出函数体、剥掉函数自己的 docstring 再查文本）：`apply_action` 里对 `event.state` 只有一处赋值而且是 `= HANDLING`、`event.state = RECOVERED` 这个字符串**只出现在 `_close_recovered` 里**而 `_close_recovered` 只被 `observe` 调、`Core.handle_command` 的函数体里**一次都不出现 `self.nodes`**。**指令校验**：十几种坏指令（topic 不对 / 不是 JSON / 缺 `nodeId` / 缺 `action` / 未知 action / 未知节点 / `time` 写坏）各来一遍，理由清一色带「指令」两个字（不然和报文那条路的拒收理由糊在一起）；`action` **不做大小写归一**（`Handle` 不认，理由里明说了要小写 —— 悄悄认下的话，前端写错了永远没人发现）。**接线**：收到指令只多 `commands` 计数、`core` 收到指令**不发快照**（这一轮事件还没进快照，发了等于说「什么都没变」）、`on_connect` 订的是两个 topic、`on_message` 拿**全等**分路而不是 `startswith`（`dormmate/v1/cmd/foo` 这种长得像的不该被当成指令）。**配置**：`core/config.json` 少了 `events` 那一块时拒绝启动、三个数都得是 ≥1 的整数。**剧本重放**：`d3_event.json` 那 14 帧（3 偏热 → handle → 3 正常 → 3 偏湿 → handle → 3 偏湿）离线喂给一个真 `Core`，断言第一幕 `RECOVERED`、第二幕 `UNRESOLVED`，并且**两幕分别属于哪 7 帧**（`[:7]` 全是 dorm-b、`[7:]` 全是 dorm-c）。`send_cmd.py` 那几条：默认不 retain、`--clear` 必须带 retain、`--raw` 原样发、参数错了返回 2 且一条都不发 |
| ④ 31 条 | `judgeStatus` / `getAdvice` / `runRegressionTests` 的行为，外加"不许用 export、不许碰 DOM"这类约束 |
| ⑤ 150 条 | `validateInput` 的判序、`analyze` 的四种状态与配色 class、`formatTime` 的格式与补零、录入历史的追加与倒序、CSV 的表头/BOM/CRLF/行顺序/空状态、HTML 与 JS 的 id 是否对得上、broker 地址按访问地址拼（本机 / 局域网 IP / 空 hostname）、源码里不再有写死的 `ws://localhost:9001`；Step 3-1 的摄像头：起手标记、`takeSnapshot()` 的三种失败路径与成功路径、画布取视频原始像素而不是 CSS 尺寸、`drawImage` 的实参、第二次拍照是覆盖不是追加、关摄像头时每条 track 都被 `stop()`、`pagehide` 自动关；Step 3-2 的语音：浏览器不支持、`lang`/`continuous`/`interimResults` 三个参数、重复点击被忽略、三个固定指令各自的走向、「拍照」在摄像头没开时走 `takeSnapshot` 的失败分支、字面匹配的边界（「拍张照」不算）、三种错误码都出现在页面上、表里没有的码不被吞、离开页面时 `abort` 且不报错；Step 3-3 的语音播报：一个节点都没收到时念「还没有收到任何节点的数据」而不是「都正常」、按 nodeId 排序（不是按收到的先后）、小数照 `fmt` 的格式念（25.5 不写成 25.50）、**念的是报文里的 `status` 而不是页面自己重算的**（故意把 31℃/78% 那条写成偏湿，规则上它该是偏热 —— 前端重算的话这一条就红）、说「朗读」走完整条链路真的调了 `speak()`、念的就是当前状态那句话、`lang` 是 `zh-CN`、**先 `cancel()` 再 `speak()`**、页面上显示的就是要念的那一句、utterance 留着一个引用（被 GC 掉的话 Chrome 念到一半会停）、第二个节点收到数据之后下一句立刻带上它（不缓存上一句）、浏览器不支持时返回 `{ok:false}` 而不抛异常、不支持时照样把要念的内容写在页面上且压根没碰 `speechSynthesis`、**只有 `speechSynthesis` 没有 `SpeechSynthesisUtterance` 也算不支持**（少查一个就是一条未捕获的 TypeError）、`onerror` 把原始错误码覆盖到页面上（不留一句「正在朗读」的假话）、连错误码都没有时写 `unknown` 不写 `undefined` |
| ⑥ 48 条 | `miniapp/utils/rules.js` 与 `shared/rules.js` 的交叉比对：两份实现分别放进各自的 vm 跑，在 8211 组温湿度（温度 -20~60 步长 0.5 × 湿度 0~100 步长 2）上逐对比 `judgeStatus` 与 `getAdvice`，结果必须完全一致；另有一条守卫确认这个网格真的覆盖到了四种状态，否则「全都一样」可能只是压根没测到 |
| ⑦ 481 条 | `dashboard.js` 配假 DOM + 假 `mqtt` + 假 `fetch` 实跑：三节点数据互不串线（三份 `history` 各归各的）、切节点重绘两张图、脏数据（解析失败 / 缺字段 / 类型不对 / NaN / 未知节点）分别被拦下、`status` 与规则不一致时以规则为准、topic 与 nodeId 不一致时警告但不丢弃、历史上限、清空、MQTT 连接与订阅、Console 打印原始报文（被拦下的那条也要打）、mqtt.js 没加载时的降级提示；Step 6-3 的 3D 接线：**收到别的节点的消息时 3D 一次都不许被调**、切节点立刻改画、收到的 status 是复核之后才交给 3D 的、`renderScene` 的幂等与「3D 建不起来时直接跳过」；Step 7-1 的「优先关注」栏：`abnormalStart` / `abnormalCount` 的维护（首条开段、起点不动、节点之间互不串、来正常数据两个字段一起清零、清零后再异常是新的一段、段里从偏热变偏湿仍是同一段、**报文谎称「正常」但规则算出偏热时段不被打断**）、`abnormalCount > 0` 与 `latest.status !== '正常'` 的等价不变量、页面刚加载时那栏就画好了且说的是「还没有收到数据」而不是「三个都正常」、点那栏走的**是注册在 `#priority` 上的真实委托回调**（`clickFocus()` 模拟的是事件，不是直接调 `selectNode`，所以选择器写错这里会红）且卡片 / 趋势图 / 3D 一起切过去并改口说「正在查看」、以及交给 MQTTX 的那三组数据在 `handleMessage` 上端到端跑一遍；Step 7-2 的处理动作：没数据 / 状态正常时按钮都禁用、偏湿时可按、点在 `#action-fan` 上真实注册的回调、按下之后四个字段各是什么（`actionTime` 取的是**该节点最新那条消息的 `time`**，不是浏览器时间）、卡片上出现独立的 `<span class="card-action">处理中｜风扇已开启</span>` 且**只有被处理的那个节点有**、详情区那行字把「记在哪条数据上 / 之后收到了什么」说清楚、**按下之后先 `updateScene` 再 `setFanOn(true)`**（顺序反了会被 `updateScene` 自己那次盖掉，所以拿偏湿当被测场景 —— 偏热的 `LOOK` 本来就是 `fan: true`，顺序写反也照样绿）、比动作还早的消息不许改写处理状态、动作之后正常了转「已恢复」而再变坏自动退回「处理中」、`actionTime` 不被后来的消息顶掉、两个节点各记各的互不覆盖、**没按过按钮的节点 dashboard 一次都不碰风扇**（不许把偏热本来就转着的按停）、清空后四个字段归零且不再喊「转」、以及「启动那一刻按钮就是灰的、那行字就是『还没有收到数据』」的加载快照；Step 7-4 的事件记录：节点从正常变异常时**开一条**、段内再来异常不另开（起点不动、`problem` 保持开案时那个，哪怕段里从偏热变成偏湿）、`node.event` 和 `events` 里那条**是同一个对象**（存副本的话页面上看不出来，只有导出的 CSV 会是空的）、优先关注只记第一次、**记的是胜出者自己最新那条的 `time` 而不是触发那一轮的报文 `time`**（构造「dorm-a 恢复、dorm-b 上位」的局面，写成 `record.time` 就会看到别人的时间）、处理动作也只记第一次、恢复正常时写 `recoverTime` 并把 `node.event` 摘成 `null`（事件本体留在表里，结案不等于删除）、恢复之后再异常开的是**新的一条**且旧那条一个字段都没被动过、三个节点各记各的、清空把 `events` 一并就地清掉且不留下野引用、启动那一刻表里写着「还没有事件」而导出按钮是灰的；CSV 字节：表头九列顺序、每条一行、最新在前、**只有 CRLF 没有裸 LF**、末尾一个 CRLF、`null` 一律写成空（写成 `null` 四个字母的话 Excel 里看着像真有个值）、半角逗号与双引号按 RFC 4180 转义；以及点一下导出按钮的**真实回调**：造出的 Blob 的 MIME 与 BOM（`'\uFEFF'` 在最前面，少了它中文就是乱码）、造 `<a download="events.csv">`、href 指向那个 objectURL、先插进 body 再点、点完摘掉、**objectURL 延迟 1000ms 才 revoke**（点完立刻 revoke 在部分浏览器里表现为「点了没反应」）；Step 8-1 的总览与依据：`index.html` 里两个容器都在、启动那一刻两句就都画好了且说的是「还没有收到任何节点的数据」而不是「都正常」、**每收到一条报文就重算**（先只喂 dorm-a 说「另有 2 个还没有收到数据」，补齐三个说「都正常」，再喂一条 dorm-b 说的时长从「不到 1 分钟」当场变成 20 分钟 —— 只算一次的话这里会停在旧数字上）、重点恢复之后两句一起换人、被拦下的报文（未知节点 / 解析失败）不改写这两句、**按风扇之后总览当场补出「（风扇已开启，处理中）」**（漏掉风扇回调里那次 `renderInsight()` 的话，这一句要等下一条报文才出现，中间那段时间卡片上写着「处理中｜风扇已开启」、总览里却什么都没有）、两句走的是 `textContent` 而不是 `innerHTML`（节点名是从报文里读来的，`makeEl` 把两个字段分开记，走错路这里就红）、总览点的重点和顶上那条栏是同一个人且依据开头那半句与栏里的原因逐字相同、`renderInsight` 幂等、清空之后两句都回到「还没有收到」；Step 8-3 的顶部那一行：启动那一刻画的就是「还没有收到任何节点的数据」、**每收到一条报文都重算**、重点恢复之后当场换人、**切节点时那一行跟着改口说「正在查看」**、点那一行走的是注册在 `#focus` 上的真实委托回调（`clickFocus()` 模拟的是事件，不是直接调 `selectNode`，选择器写成 `.card` 这里就红）、那条平静话是 `<p>` 而**没有 `data-node`**（点了不该有反应）、那一行的文字里没有状态词、那个状态**图标**（形状）还在、颜色跟着状态走、清空之后回到平静那句；Step 8-3 的语音提醒：按钮按一下念的**只有一句**（不是三段）、念的那句就是 `buildAlert` 现算的、**先 `cancel()` 再 `speak()`**（连点两次不许排队）、`lang` 是 `zh-CN`、同一条报文连点两次念的是同一句、收到新报文之后再点念的是新那句（不许缓存）、按钮上写了刚念过什么、三种平静状态都念平静那句、浏览器不支持时**既念不了也不装作念了**（那行说明如实写「当前浏览器不支持语音合成」）、`speechSynthesis` 有但 `SpeechSynthesisUtterance` 没有时同样走不支持、`onerror` 把原始错误码写进那行说明（`null` 时写 `unknown`）、清空时把那行说明一并擦掉；Step 8-3 的那圈环：启动那一刻是灭的、切到重点那个宿舍之后亮起来、**收到别的节点的报文时**当前这间的环跟着灭掉而 3D 的 `statuses` 一次都没变（证明这圈环有自己的更新时机，不是 `renderScene` 的副产物）、`updateScene`/`setFanOn`/`setFocus` 的调用顺序、清空之后灭掉；Step 9-3 进阶项的「ML 辅助判断」：`index.html` 里那三个容器都在、面板标题就是「ML 辅助判断」、**打开页面就去读那份 JSON 而且只读一次**（假 `fetch` 把每一次调用记下来，比的是 `['../report/ml_result.json']`）、**读回来之前那一块写着「正在读取」而不是空白**（占位那句写在 HTML 里、落在 `#ml-text` 里头 —— 假 DOM 读不到 HTML，所以这一条是拿文件查的）、读回来之前条数那格是空的（不先摆一个「0 条」，那看着像「一条都没差」）、**页面上摆的三样就是 `buildMlNote` 算出来的那三样**（拿真文件跑一遍纯函数再逐字比，页面自己另拼一份这里就红）、**结论那句就是 `report/ml_result.json` 里那一句**（读的是仓库里那份**真**文件，不是测试手写的假 JSON —— 手写的桩在 `analysis.py` 改了字段名之后照样全绿，而真页面上会写「这一段没跑」）、条数里那个数就是真文件里的 `mismatchForward`、说明里写着「不是实时数据」、说明里那两份文件名和时刻与真文件对得上（下面每一条都跟着真文件的数走，`data/` 一改或脚本重跑一遍不用改测试）；**四条出错的路各走一遍**：`fetch` 打不开（离线 / 服务器没起，原因原样写在页面上）、404（说的是「HTTP 404」而不是糊一句「读不到」）、回来不是 JSON（把 `Unexpected token <` 写出来）、文件在那儿但不是 `analysis.py` 写的那份（说「该写的字段」）；这四条走完之后**一个节点、一条事件都没被动过**（这一段不走 MQTT 那条线）、条数那格在降级时是空的、说明里告诉人先跑哪个脚本、再读到一次能摆回来（降级不留痕）；以及 L 段那个「要什么没什么」的上下文里（那边给的是一个注定失败的 `fetch`）这一块也降级成一行字，而不是把整个页面拖垮；Step D3 收尾的「按下去的动作发给 core」：**没连上时一条都不 publish**（连的是一条假连接，发出去也没人收）而本地四个字段照旧记上、页面上如实写「这条指令没发出去（还没连上 broker）……core 那边的事件不会变」、连上之后按一下**正好发一条**到 `dormmate/v1/cmd`、`retain` 必须是 `false`（留着的话下次起 core 会凭空把某条事件推进处理中）、`payload` 的键**正好是** `nodeId` / `action` / `source` / `time` 四个（多一个都红）、`action` 写的是小写 `handle`（core 不做大小写折叠）、`time` 用的是**报文里的时刻**而不是浏览器当前时间、**这条指令里一个结论字段都没有**（逐个点名 `status` / `state` / `result` / `recovered` / `ok` / `normal` 这些名字，塞任何一个进来都红 —— 塞了就等于前端替 core 结案）、发出去了页面上也**不出现「已恢复」**、这一条进 Console（现场确认「到底发出去了没有」）但**一条都不进消息日志**（那边的行数是用来对数的）、报文里 `time` 是空串时按钮仍可点且**不把空串当 `time` 发出去**（core 那边格式不对是整条拒收）、清空时那行说明一并擦掉 |
| ⑧ 224 条 | `3d/scene.js` 配假 `three` 模块 + 假 DOM 实跑（模块里的裸名字 `three` 是不认 importmap 的，测试把那一行 import 改写成指向本地假模块的绝对 file:// URL）：容器查找与报错、renderer 的像素比封顶与尺寸、宿舍每部分的几何 / 朝向 / 摞放关系（床垫正好压在床架上、3 片扇叶互成 120°、窗扇挂在铰链的一侧、支架不在会转的那个 Group 里）、两盏灯与阴影相机、相机参数与 `lookAt`、`updateScene` 四种状态各自改了什么以及切回来有没有残留、不认识的 status 退回「正常」并在控制台警告、`setFanOn` 的归一化与「关掉不归零」、`setLabel` 的覆盖层、动画循环随 dt 累加（**验证转动快慢与帧率无关**）、resize 自适应与 0×0 容器不产生 NaN、dispose 是否真的回收了几何体 / 材质 / 监听（**包括嵌在 Group 里的零件**）、index.html 的 importmap（合法 JSON、出现顺序比的是**标签**位置、版本号）与 4 个按钮的接线、覆盖层那两条关键 CSS、以及 `lib/` 里那份的大小与自包含性；Step 8-3 的「当前重点」那圈环：`focusRing` 存在且 `RingGeometry` 的内半径小于外半径、环比房间小一圈（拿 `floor` 的宽算出一半宽再比）、平躺（绕 X 转 -90°）、抬离地面（免得和地板共面闪烁）、`transparent` + `opacity < 1`、`DoubleSide`、一开始不亮、用的是**不受光的** `MeshBasicMaterial`、颜色**不在**四个状态色里（`style.css` 里那四个值抄进测试里比）、`setFocus` 把传进来的值归一化成布尔再返回（传 `''` / `0` / `undefined` 回来的是 `false`）、只动 `visible`（背景色 / 地板色 / 转轴角度 / 风扇转角 / 覆盖层文字一个都不碰）、来回调是幂等的、`updateScene` 之后环的状态不受影响。22 + 10 个变异（含「灯不能和相机同侧」「改完阴影相机范围要重算投影矩阵」「假模块的 traverse 退回只走一层」「环一开始就亮着」「环借用了状态色」）逐个塞回源码验证过，全部被抓住 |
| ⑨ 65 条 | `3d/index.html` 里那段 `<script type="module">`：**从 HTML 里抠出来**，摘掉 import 换成打桩的 `createDorm3D`，配上假 `mqtt` 和假的按钮桩实跑。盯的就是 Step 6-3 那条规则 —— **画面跟的是「当前选中的宿舍」，不是「最后一个发消息的宿舍」**：给 dorm-b 发消息时 3D 一次都不许被调、切过去才画、而且画的是它最新那条；没收到数据的节点退回「正常」的外观并在覆盖层上如实说明；报文里写错的 `status` 一律以规则算出的为准；脏数据四条（非 JSON / 缺字段 / 类型不对 / 未知节点）一条都不许改到画面；`shared/rules.js` 必须是普通 script 且排在模块之前；6-2 留下的 4 个手动预览按钮仍然可用，且会被下一次真数据顶掉 |
| ⑩ 400 条 | `dashboard/logic.js` 的纯函数逐个钉住：`parseTime` 只认 `YYYY-MM-DD HH:mm:ss`（`/`、`T`、少秒、不补零、前后空格、空串、`null`、数字、中文一律 `NaN`）且按 UTC 折算（同一串在不同时区差几小时这条就红了）、跨零点 / 跨月 / 闰日、`fmtDuration` 的向下取整（4 分 59 秒说「4 分钟」）与非正数兜底、`abnormalDuration` 在起点晚于终点时返回 0 而不是负数、`nextAbnormal` 不改传入的对象 / 认得不完整的 `prev`、以及 `pickPriority` 的整套判定：三组场景、**时长优先于条数（7 分钟的 1 次排在 1 分钟的 99 次前面）**、追平那句话只点**时长相同**的那个（跟所有人比是错的）、**第 3 步比严重度**（偏热 > 偏湿 > 偏冷，权重表和 `rules.py` 的 `SEVERITY_WEIGHTS` 是同一套）、第 4 步是固定码元序而不是跟着区域设置走的 `localeCompare`、四步的期望值由 `tests/fixtures/priority_cases.json` 钉住（Python 和 Node 各读一遍，改一边不改另一边这里就红）。Step 7-2 的处理动作状态机：`beginHandling` 在没有 `latest` / `latest` 是 `null` / 传 `null` 时返回 `null`、按下之后返回的正好是那四个字段、`actionTime` 只认 `latest.time`（`history` 里更早的那条不算）、每次返回新对象且不改传入的节点、`nextHandling` 对「没按过按钮」「不认识的状态」「`actionTime` 或这条的 `time` 解析不出来」一律返回 `null`、**「严格晚于 `actionTime`」**（同一时刻的那条不算，动作就记在它身上）、动作之后正常转「已恢复」而偏冷 / 偏热 / 偏湿一律留在「处理中」、只认 `record.status` 不自己复核、以及来回走一遍：处理中 → 还异常(处理中) → 正常(已恢复) → 又异常(处理中) → 正常(已恢复)。另有守门的静态检查：导出就这 18 个（Step 8-3 起多了 `tempTrend` / `buildFocus` / `buildAlert`，Step 9-3 的进阶项又多了 `buildMlNote` / `mlFetchFailed`；`trendText` / `calmLine` 这两个只负责措辞的助手**不**导出，页面上算那一行和那一句只能走那两个出口）、`ACTION_FAN` **不**导出（那串字只该有一份）、`ranked` / `basisFor` / `reasonFor` / `survey` / `handlingNote` / `lostTo` 这些内部件也都**不**导出（「谁是重点」的排序和「赢在哪一步」的说法各只留一份，导出去的话页面那边就能绕开 `pickPriority` 自己排一遍）、没有 `export default`、源码里不许出现 `document` / `window` / `innerHTML` / 定时器 / `Date.now(`。Step 7-4 的事件四件套：`beginEvent` 在记录是 `null` 或状态为「正常」时返回 `null`（不许造出一个叫「连续正常」的东西）、返回的九列**顺序和 CSV 表头一致**、刚开案时优先关注/处理动作全是 `null` 而 `result` 是**空串**（不是 `'null'` 也不是「进行中」）、三种异常各自拼出的 `problem`；`markPriority` / `markAction` / `closeEvent` 三个都**只记第一次**（第二次再调返回 `null`，已有值不被覆盖）、都挡空值、都返回新对象且不改传进来的那条事件；`markPriority` 在 `reason` 为 `null` / `undefined` 时写空串、是数字时转成字符串；`closeEvent` **不做时间比较**（该不该结案由 `nextAbnormal` 说了算，这里只负责写，代价见「报文没有乱序保护」）；以及把四个函数串起来走完一整段，九列全填齐 —— 那一行就是 CSV 里的一行。Step 8-1 的总览与依据：**一条数据都没有时不说「都正常」**（那是不知道，不是正常）而说「还没有收到任何节点的数据」、`nodes` 是空对象或 `undefined` 也不炸、三个都正常时不写「0 个需要关注」、**三个都不正常时也不写「0 个正常」**、只收到一部分节点时单独说「另有 N 个还没有收到数据」（正常 + 需要关注 + 没数据三个数加起来正好是宿舍数）、一个异常时的两句话、**两个异常时总览多出「dorm-c 出现偏湿」那一笔**、依据逐个对比时输的那个如实说**输在哪一步**（时长更短写「只持续 5 分钟」；时长打平靠次数赢的写「持续时间和它一样长，但只有 2 条异常数据」——写成「只持续 20 分钟」就是假话；完全并列的写「按节点名顺序排在后面」）、处理状态写成一个括号如实报出来且**不参与排序**（同一份数据按不按风扇，「谁是重点、因为什么」一字不变）、状态已经正常却还停在「处理中」的节点不带那个括号、**换成四个宿舍 / 换成 `north-1`、`south-2` 这样的名字照样说得对**（宿舍数取自 `nodes` 的键，不是写死的 3）、**「还有谁异常」按严重程度排而不是按 `nodes` 的键顺序**（`dorm-a/b/c` 恰好和严重程度同序时测不出区别，所以专门造了一组把最严重的放在中间的）、每组都验证总览点的重点和 `pickPriority` 是同一个人、依据开头那半句与栏里的原因**逐字相同**、重点在依据里只说一遍、两句话都以句号收尾、两个函数都不改传进来的 `nodes`、同样输入连着算两遍一字不差。Step 8-3 的两个出口：`tempTrend` **只看最近两条**（前面跌得再狠、最近一次是涨的就是「上升」）、比的是**精确值不设容差**（差 0.1℃ 也算上升，「小于 0.5℃ 算没变」要先定下来多少算没变，那是另一套规则）、**只有一条记录时是空串不是「持平」**（一条数据说不出「在往哪走」，说成「持平」就是把「不知道」说成了「没变」）、`history` 不是数组 / 里头有 `null` / 温度是 `NaN` / 字符串 / `undefined` 一律空串不炸、`buildFocus` 三段拼起来正好是需求里那个例子（`dorm-b｜处理中｜温度正在下降`）、**空的那一段整个不出现**（不留空串也不留两个连着的 ｜）、持平说「温度持平」不是「温度正在持平」、**那一行里没有状态词**（偏热 / 偏冷 / 偏湿 / 已持续一个都不出现，那归卡片徽章、3D 和语音）、**也不写「风扇已开启」**（开了什么是空间动作，那是 3D 的事）、**`handling` 是字符串 `'无'` 时也不拼这一段**（页面里没按过按钮就是这个值，只判 `if (node.handling)` 会拼出「dorm-b｜无｜温度正在下降」）、平静时候那一行**不带句号**（它不是一句话，是个状态标签）；`buildAlert` 平静时那句**带句号**（要念出来得自成一句）、念的是「谁、什么状态、持续了多久」、有趋势就跟着念、正在处理就念出处理状态、**里面一个 ｜ 都没有**（念出来是「竖线」两个字）、不念输赢的理由也不提别的宿舍、每次都句号收尾；两个出口必须**指向同一个人**（12 组数据逐组比开头那个宿舍名，不许「包含」就行）、没有重点时两边说的是同一句平静话、三个函数都不改传进来的 `nodes`、同样输入连着算两遍一字不差；以及那条「走不到的话」的前提：没有重点时 `buildAlert` 走的必须是 calmLine 那条路。Step 9-3 进阶项的 `buildMlNote` / `mlFetchFailed`：返回的就是那三样（`count` / `text` / `note`，键名给死了 —— 页面是照着这三个名字取的，改成 `note.sentence` 之类的话页面上会静悄悄写上去一个 `undefined`，只有这条挡得住）、**结论那句是从 JSON 里原样搬的**（看板不许另写一份结论，否则同一件事就有第二处说法）、条数报的是「规则说正常、ML 说不同」那个数、说明里点明了判的是哪一份新数据、模型拿哪一份训练的、**判的不是看板上这些实时读数**、以及那句 `generatedAt`；**两个方向分开报**（都是 0 说「一条都没差」；只有反向时说的是「规则说异常、ML 说正常：1 条」而**不是**顺着前一句说成「一条都没差」—— 那是句假话；两个方向都有就两句都在）；路径只留文件名（塞一条 `C:\...` 进去不许出现在页面上）、**两个文件名给空了都说「那两份文件」**（一个是空串、一个是 `null`，**两半都要断言到** —— 只断言一半的话 `null` 会印成「null」而测试照样绿，这条是跑变异时才补上的，见下）、**只有空格的文件名也算没给**（`trim()` 过）、条数缺了说「若干」而**不说 0**（0 是「一条都没有」的意思）、没记时刻时说「上一次跑」而不是「undefined 那次」；**坏数据九种**（`null` / `undefined` / 空对象 / 少了结论 / 结论不是字符串 / 少了那个数 / 数是个字符串 / 整个是字符串 / 整个是数组）一律降级成一句「这一段没跑：」且**一样不抛**、降级时那三样照样齐（页面只有一条渲染路径）；`mlFetchFailed` 带着原始原因（`HTTP 404` 原样出现）、带着「这一段没跑」这个和报告里一样的前缀、说明里告诉人跑哪个脚本、原因取不到时也有句实话；两个函数都不改传进来的东西、同样输入连着算两遍一字不差 |

⑤ 的做法是把**真实的** `script.js` 加载进一个最小 DOM 桩里直接调函数，
不是另写一份等价逻辑——否则测的是抄来的那份，不是线上那份。它同时充当
「规则只有一份」的守门人：`script.js` 里一旦又冒出 `computeStatus` 或
`temperature < 18`，⑤ 会直接报错。

② 和 ⑤ 各踩过一次**「检查匹配到自己的注释」**的坑（注释里写了 `export`、
`toLocaleString`，检查就报失败），所以两处都是先把注释剥掉再查语法。

**改 `status_rules.py` 要跑 ①（②③ 顺带一起跑）；改 `shared/rules.js` 要跑 ④，改 `miniapp/utils/rules.js` 要跑 ⑥（两次改完都再确认 ⑤ 还绿）。**

## simulator/ 常用参数

| 参数 | 说明 |
|---|---|
| `--dry-run` | 只打印 JSON，不连 MQTT（没装 Mosquitto 时也能验证格式） |
| `--count 4` | 只发 4 **轮**，方便一次跑完（一轮 = 每个选中的节点各一条） |
| `--node dorm-b` | 只发一个节点 |
| `--nodes dorm-a,dorm-b` | 发指定的几个节点 |
| `--all-nodes` | 三个节点一起发（等价于 `--nodes dorm-a,dorm-b,dorm-c`） |
| `--mode random` | 换成随机温度/湿度 |
| `--mode cooling` | 风扇降温：33 → 31 → 29 → …，降到 24 保持（演示「靠新数据恢复」） |
| `--cool-step 5` | 降温模式每轮降几度（默认 2） |
| `--interval 2` | 改成 2 秒一轮 |
| `--script simulator/scenarios/phase1_demo.json` | 按剧本文件跑场景，跑完就停 |

## Phase1：三个节点一起发、降温模式、json 剧本、publish_one

数据源从「一次一个节点」变成「一轮里每个选中的节点各发一条」，
另外多一个手动工具 `simulator/publish_one.py`（平时手动补一条，主要给 D4 故障注入用）。

### 一轮 = 每个选中的节点各一条

```bash
py -3.14 -m simulator.simulator --all-nodes --interval 2 --count 5
```

`--count` 数的是**轮**：`--all-nodes --count 5` 是 15 条（3 × 5），
`--node dorm-b --count 5` 是 5 条（只有一个节点，一轮就一条）。

看板上三张卡片的初始状态**故意不一样**（dorm-a 偏冷、dorm-b 正常、dorm-c 偏湿）——
三个都从 (25, 60) 起步的话三张卡一模一样，反而看不出「每个节点各存各的」这件事。
实现上就是给每个节点错开一个起点（`NodeState.step`），`SEQ` 还是各数各的。

⚠ 两个都带 `--all-nodes` 的进程同时跑会互相顶下线：多节点时三个节点共用一根连接，
`client_id` 是固定的 `dormmate-sim-3nodes`。要同时跑两份数据就换 `--node` 分开起
（单节点那支的 `client_id` 是按节点拼的，三个单节点进程可以并存）。

### `--mode cooling`：演示「恢复靠新数据，不靠按钮」

```bash
py -3.14 -m simulator.simulator --node dorm-b --mode cooling --interval 2 --count 8
```

33 → 31 → 29 → …，每轮降 2 ℃（`--cool-step 5` 可以改），降到 24 ℃ 就保持。
**湿度一动不动**：这样状态从偏热翻回正常只可能是温度越过 30 那一下，归因才清楚；
目标值 24 ℃ 也离 18 ℃ 很远，怎么降都掉不进偏冷。

这是第 4 条红线的现场道具 —— 在看板上按「处理」按钮，卡片只会变成
「处理中」；真的变回正常，发生在下一条温度 < 30 的报文到达那一刻，
而且那条报文的 `seq` 一定比按按钮时看到的那条大。

### 按 json 剧本跑场景

```bash
py -3.14 -m simulator.simulator --script simulator/scenarios/phase1_demo.json
```

```json
{
  "interval": 2,
  "frames": [
    {"comment": "只有 comment 的帧只是说明，不发送"},
    {"node": "dorm-a", "temperature": 31, "humidity": 78, "comment": "偏热"},
    {"node": "dorm-c", "temperature": 25, "humidity": 80, "repeat": 2}
  ]
}
```

- 一帧一条消息（`repeat: 2` 就是连发两轮），`interval` 写在文件里就不用再敲命令行
- 帧里没写 `node` 就用 dorm-a；`repeat` 只能是 ≥ 1 的整数
- **跑完就停**，不像 `--mode` 那样一直循环 —— 演示脚本要能自己收尾
- 剧本坏了会逐条说人话（文件不在 / 不是 JSON / 存成了 GBK / 缺字段 / `repeat` 是 0 或 1.5），
  不会甩一段 traceback

仓库里那份 `phase1_demo.json` 一共 8 条，四种状态各出现一次（开场三个宿舍各一条：
dorm-a 正常、dorm-b 偏热、dorm-c 偏冷）。它其中一段值得单看：

```
dorm-b  31 / 78 → 偏热
dorm-b  29 / 78 → 偏湿      ← 温度降下来了，状态却是「偏湿」不是「正常」
dorm-b  27 / 78 → 偏湿
```

温度是降了，湿度没动，于是落进规则的第 3 条。这不是 bug，是**判序**的现场：
`31/78` 判偏热（温度那条在前面就命中了），`29/78` 才轮得到湿度。
想演示「降温让状态回到正常」用 `--mode cooling`（那边湿度是恒定的 70）。
### `publish_one.py`：手动发一条 / 故障注入

```bash
py -3.14 -m simulator.publish_one --node dorm-b --temperature 33 --humidity 55
py -3.14 -m simulator.publish_one --node dorm-b --raw '{这不是 json'      # D4：脏报文
py -3.14 -m simulator.publish_one --node dorm-b --temperature 25 --humidity 60 --time "2026-09-22 20:30:00"
py -3.14 -m simulator.publish_one --node dorm-b --clear                    # 清掉 retained
```

| 做法 | 为什么 |
|---|---|
| 默认 **不** retain | 故障注入发的是坏数据，retain 上去之后每开一次看板都先看到它，像闹鬼 |
| `--raw` 一个字符都不改 | 工具**不替 core 把关** —— 坏数据要真的上线，否则测不到 core 拦不拦得住（看板那边只记一条警告，它不负责拦） |
| `--raw` 时给了温湿度会忽略并提示 | 免得人以为那条坏报文里还带着温湿度 |
| `--topic` 能覆盖约定 | 测「topic 和报文里的 nodeId 不一致」这条路要用 |
| `--clear` 会强制带 retain | 不发 retained 空消息删不掉上一条 |
| 退出码 0 / 1 / 2 | 2 是参数写错（一条都不发），1 是连不上 broker（会顺手告诉人怎么起） |

### 自测：只有 dorm-b 那张卡片刷新，节点数据不串线

1. 三个终端起好：broker → `py -3.14 -m simulator.simulator --all-nodes` → 静态服务器
2. 浏览器开 `http://localhost:8000/dashboard/`，等三张卡片都出现数字，记下各自的读数
3. 另开一个终端：

   ```bash
   py -3.14 -m simulator.publish_one --node dorm-b --temperature 35 --humidity 40
   ```

4. 预期：**只有 dorm-b 那张**变了（35 ℃ → 偏热），dorm-a / dorm-c 一个数字都没动，
   各自的历史曲线也不该多出一个点
5. 反向再确认一次：把上面那条换成 `--node dorm-a`，动的就该是 dorm-a 那张

不想开浏览器的话，命令行上也能验 —— 订通配符，比对 topic 里的节点和报文里的 `nodeId`：

```bash
py -3.14 - <<'PY'
import json, time
import paho.mqtt.client as mqtt

got = []
c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="cross-check")
c.on_message = lambda _c, _u, m: got.append((m.topic, m.payload.decode()))
c.connect("127.0.0.1", 1883, keepalive=30)
c.loop_start()
c.subscribe("dormmate/v1/nodes/+/telemetry", qos=1)
time.sleep(20)                      # 这段时间里用 publish_one 发几条
for topic, payload in got:
    print(topic.split("/")[3], "vs", json.loads(payload)["nodeId"])
PY
```

（`<<'PY'` 这段是 Git Bash / WSL 的写法；cmd 和 PowerShell 里存成 `.py` 文件再 `py -3.14 文件名.py` 就行。
`tests/broker_selftest.py` 是另一个更简单的自检：只验「TCP 和 WebSocket 两条通路连得上、发得出、收得回」，
不碰业务 topic。）



两个位置对不上的话，`publish_one --topic` 发出去、看板那边会打印一条警告
（**警告但不丢弃** —— 丢弃的话数据就凭空消失了，更查不出来）。

## Phase2：core.py —— 唯一业务大脑

Phase1 之前，每个前端（网页、小程序、3D）各自算一遍状态、各自挑一遍「该先看谁」。
同一个问题有几份答案，就迟早会有一次答案不一样。Phase2 把这件事收进一个进程：

```
发布端(simulator / publish_one)
        │  dormmate/v1/nodes/<nodeId>/telemetry
        ▼
      core.py  ── 校验 → 判状态 → 存历史 → 算优先 ──┐
        │                                          │
        │  dormmate/v1/state (retained)  ◄─────────┘
        │  dormmate/v1/log/reject        （非法报文，不保留）
        │  dormmate/v1/core/status       （retained，遗嘱）
        ▼
前端只负责渲染（这一阶段的前端还没改过来，见下面「两边暂时不一致」那一段）
```

| 文件 | 干什么 | 不干什么 |
|---|---|---|
| `core.py` | 订阅、校验、推进状态机、算优先、发快照 | 不实现规则（问 `rules.py`） |
| `rules.py` | `judge_status`（转发 `status_rules`）+ `rank_priority` | 不读时间、不碰 MQTT、不知道节点名 |
| `core/config.json` | 节点 / 阈值 / 权重 / 离线超时 / 恢复条数 | 不放 topic 字符串（只在 `config.py` 一处） |

### 起 core

```bash
py -3.14 core.py                  # 正常跑
py -3.14 core.py --quiet          # 只报拒绝和换人，不逐条报收到的数据
py -3.14 core.py --check          # 只核对配置并打印一份摘要，不连 broker
```

`--check` 会拿 `core/config.json` 里的阈值去跟 `status_rules.py` 逐项核对，
对不上就**拒绝启动**并说清改哪一边：

```
配置和别处的出处对不上：
  thresholds.humidityHigh = 99，但 status_rules.HUMIDITY_HIGH = 75.0
  （status_rules.py 是规则的真源，改阈值要改那边，再同步这一份）
```

为什么不干脆只留一份、让 core 去 import：`core/config.json` 里那份是**给人和给报告看的**
（一眼能看到现在用的阈值是多少），而规则的真源必须是 `status_rules.py`。
两份都要有，那就得有人在中间喊一声 —— 喊的这一声就是启动时这次核对。
用 `raise` 不用 `assert`，因为 `python -O` 会把 `assert` 整条删掉，那时候这个检查就等于没有。

### 报文校验：拒收，不是忽略

一条消息进来，依次过这九道，任一道不过就**整条拒收**并发到
`dormmate/v1/log/reject`（`retain=False`，坏消息不许留在 broker 上）：

| # | 查什么 | 例子 |
|---|---|---|
| 1 | topic 形状（严格五段） | `dormmate/nodes/dorm-a/telemetry`（少了 v1） |
| 2 | 是合法 JSON | `{这不是 json` |
| 3 | 最外层是对象 | `[1,2,3]` |
| 4 | 五个字段齐全且类型对 | `temperature` 是 `"热"` |
| 5 | 数值是有限数 | `NaN` / `Infinity` / `true` |
| 6 | `time` 格式 | `2026-09-22 20:30`（少秒） |
| 7 | 节点在节点列表里 | `dorm-z` |
| 8 | **topic 里的 nodeId 和报文里的 nodeId 一致** | topic 是 dorm-a、报文里是 dorm-b |
| 9 | `status` 和重算结果一致 | 写了「正常」但 31/78 是「偏热」 |

第 9 条只记一笔 `statusMismatch`（进快照的 `counters`），**不拒收**：
数据本身没问题，只是发布端算错了，丢掉它反而让现场少一条读数。第 8 条则必须拒收 ——
一条消息说自己是 dorm-a 又说自己是 dorm-b，留下来只会让所有下游都跟着错。

**有一条不在这九道里，而且不是判据，是放行**：长度为 0 的 payload。MQTT 里「清掉一条
保留消息」的做法就是往同一个 topic 发一条空消息（`publish_one --clear` 干的就是这个，
而跑剧本的第 ① 步正是清 retained）：broker 删掉存的那份，同时把它转发给当前在线的
订阅者，于是 core 真的会收到一条空 message。它既不是数据也不是坏数据 —— 不判状态、
不发 reject topic、**不动任何节点的内存**（这条消息说的是「broker 存的那份删了」，
跟这个宿舍现在什么状况没有关系），只在日志里记一行 `[保留]`，并在快照的
`counters.retainedCleared` 里数一笔。

一开始它走的是「JSON 解析失败 → 拒收」那条路，代价是每清一次 retained 就往
`dormmate/v1/log/reject` 灌三条假警报 —— 而下面排查表里写着「reject topic 有流量就该查」。
照着自己写的步骤做，看到一个查不出原因的问题，那比不报还费时间。
**只认长度为 0**：空白字符不是清 retained，那是真写坏了，照旧拒收。

### 优先关注：四步，前一步平了才看下一步

| 步 | 判据 | 理由会这么说 |
|---|---|---|
| 1 | 连续异常**时长**（长优先） | 「……，持续时间最长」 |
| 2 | 时长一样，比这段里的**异常条数** | 「持续时间和 dorm-x 一样长，异常次数最多」 |
| 3 | 还一样，比**严重度**：偏热 > 偏湿 > 偏冷 | 「……异常次数也一样，但偏热比偏湿更要紧」 |
| 4 | 全平，按 nodeId **字典序** | 「和 dorm-x 完全并列，按节点名顺序排在前面」 |

第 4 步不是为了更准，是为了**确定**：同一份数据永远得到同一个结果。
四步的期望值钉在 `tests/fixtures/priority_cases.json` 上，Python 和 Node 各读一遍、
逐条对上才算过 —— 两边各写一套单元测试治不了「改了一边忘了另一边」。

`rules.py` 里**不许出现任何节点名**（`tests/test_rules_priority.py` 会用
`ast` + `tokenize` 把注释和文档字符串剥掉之后逐字检查，节点名只能来自数据）。

「时长」是**这一段从开始到现在**，不是「多久没收到消息」：
中间安静 11 分钟、但这一段一直没结束的话，时长照样在涨。这也是为什么 core 里有两个时钟：
`last_seen` 用墙上时间（判离线），`abnormal_start` 用**报文里的 time**（算时长）。
分开之后，一份跨 15 分钟的剧本可以在 30 秒内跑完，算出来的时长仍然是真的。

### 恢复：连续 3 条正常，不是 1 条

`recoverConsecutiveNormal` 默认 3。日志里恢复路上每一条都会说还差几条：

```
[数据] dorm-b 25℃/60% 正常（正常，还差 2 条正常才算这一段结束）
[数据] dorm-b 25℃/60% 正常（正常，还差 1 条正常才算这一段结束）
[数据] dorm-b 25℃/60% 正常
[重点] dorm-c —— 已连续偏湿 3 分钟（2 次），是目前唯一的异常节点   ← 换人了
```

段中间插一条异常会把「连续正常」计数清零，但**这一段的起点不动** —— 这正是「连续」两个字的含义。
更重要的是：恢复路上那几条正常，**不会**让优先关注马上换人。这一段还没结束，
它还是当前最该看的那个。这也是 D2 三套剧本里都要演一遍的动作。

⚠️ **两边暂时不一致**：`core.py` 是「连续 N 条正常才算结束」，
而 `dashboard/logic.js` 现在是「一条正常就结束」。这是**有意留着**的，
不是漏改：等前端改成读 core 那份 retained 快照（`dormmate/v1/state`）之后，
这个分歧自然就没了 —— 只有一份状态机，就不存在两边不一致。

### 三套剧本：优先关注跟着数据自己走

```bash
# ① 先清掉 retained：上一次跑剩下的最后一条读数会在 core 一订阅上就送过去，
#    看起来就像「凭空多了一段异常」。清完再起 core，日志才是干净的。
#    清的时候 core 还在跑的话会打三行 [保留]（不是 [拒绝]）—— 见上面
#    「报文校验」那节的放行规则：空报文既不算数据也不算坏数据。
py -3.14 -m simulator.publish_one --clear --node dorm-a
py -3.14 -m simulator.publish_one --clear --node dorm-b
py -3.14 -m simulator.publish_one --clear --node dorm-c

# ② 起 core（另开一个终端）
py -3.14 core.py

# ③ 依次跑三套剧本
py -3.14 -m simulator.simulator --script simulator/scenarios/d2_case1.json
py -3.14 -m simulator.simulator --script simulator/scenarios/d2_case2.json
py -3.14 -m simulator.simulator --script simulator/scenarios/d2_case3.json
```

| 剧本 | 演的是 | 「优先关注」的轨迹 |
|---|---|---|
| `d2_case1` | 时长决出 → 靠恢复交接 | dorm-b → dorm-c → 空 |
| `d2_case2` | 时长并列比条数 → 被更长的接管 → 字典序兜底 | dorm-a → dorm-b → dorm-a → dorm-b → dorm-a → 空 |
| `d2_case3` | 时长条数全平 → 严重度决出 | dorm-a → dorm-b → dorm-a → 空 |

三份剧本里每一帧的 `time` 都是写死的（`"time": "2026-09-22 20:06:00"`），
所以「持续了多久」是**可复现的**，跟跑得多快无关；`interval` 只管发得多快。
三套剧本的期望轨迹在 `tests/test_scenarios.py` 里逐帧断言 ——
剧本改一个数就会红，不需要另写一份「预期结果」的文档（那种文档不会随剧本变红）。

### 自测：优先关注自己换人，不用点任何按钮

1. 清 retained → 起 core → 跑 `d2_case1`（步骤见上）。core 已经在跑的时候，
   那三条清 retained 的空报文在 core 终端上是 `[保留]`、reject topic 上一条都不该有
2. 看 core 那个终端，预期出现 4 行 `[重点]`：空 → dorm-b → dorm-c → 空
3. 关键的一步在中间：**20:07 / 20:08 两条正常的行里写着「还差 2 条 / 还差 1 条」，
   而这两行之后 `[重点]` 并没有换人** —— 换人发生在第 3 条正常上。
   整个过程中没有任何人点过「处理」按钮，事件也没有被直接置成已恢复。
4. 再跑 `d2_case2`，预期 6 行 `[重点]`，每一次的理由说的都是**真的那一步**
   （20:01 那行提「异常次数最多」，20:06 那行提「持续时间最长」）。
5. 快照随时可查（retained，后订阅的也能读到当前状态）：

   ```bash
   py -3.14 -m simulator.publish_one --node dorm-a --temperature 31 --humidity 78
   # 然后用 MQTTX 订阅 dormmate/v1/state
   ```

## 手动录入分析

页面顶部的「手动录入分析」面板可以不经过 MQTT，直接输入温度/湿度看判定结果。
校验逻辑在 `web/script.js` 的 `validateInput(tempText, humText)`，按顺序判断：

| 顺序 | 情况 | 提示 |
|---|---|---|
| 1 | 任一为空（含纯空格） | 请输入温度/湿度 |
| 2 | 非数字（`Number.isNaN`） | 请输入数字 |
| 3 | 温度不在 -20~60，或湿度不在 0~100（闭区间） | 温度/湿度超出合理范围（附范围） |

判断顺序不能调换：`Number('')` 的结果是 **0 而不是 NaN**，漏掉第一步的话
空输入会被当成 0℃ 一路算下去。校验不通过时只把提示写进页面上的
`#manual-error`，不进入分析、也不弹窗。

校验通过后由 `analyze()` 调 `shared/rules.js` 的 `judgeStatus()` / `getAdvice()`，
把状态、建议和录入值渲染进 `#manual-result`，并给结果区加上对应状态的颜色 class
（`is-good` / `is-warning` / `is-serious` / `is-critical`）。校验失败时会连这个
class 一起清掉，免得留着上一次的颜色误导人。

### 录入历史（带时间）

每次分析成功后往 `history` 数组 **push** 一条记录，追加而不是覆盖：

```js
{ time: '2026-09-26 20:30:00', temperature: 31, humidity: 78, status: '偏热' }
```

`renderHistory()` 把它渲染成「时间 | 温度℃ | 湿度% | 状态」四列表格，**最新的
在最上面**，标题旁边的 `#history-count` 显示「共 N 条记录」。数组本身是提交顺序
（旧 → 新），倒序只发生在渲染那一步——一条记录只存一份，顺序不写死在数据里。

`time` 由 `formatTime(date)` 生成，手动拼 `YYYY-MM-DD HH:mm:ss`：

- **不用 `toLocaleString()`**。它的输出跟着浏览器和系统区域设置走，中文环境下
  可能给出 `2026/9/26 20:30:00`，连补零都不保证，导出的 CSV 里列对不齐。
- 取的是**本地时间**，和 Python 侧 `datetime.now().strftime('%Y-%m-%d %H:%M:%S')`
  同一套口径——两边的时间会出现在同一张表和同一个 CSV 里。
- 传入无效日期返回空串，不会把 `NaN-NaN-NaN NaN:NaN:NaN` 写到页面上。

历史**只活在内存里，刷新页面就清空**，这是有意的：本步骤约定不落 `localStorage`。
（页面主题用的那个 `localStorage` 是另一回事，跟历史无关。）

`history` 和浏览器的 `window.history` 重名，但它是经典 script 的顶层 `const`，
会在顶层词法作用域里把 `window.history` 遮蔽掉；这份脚本不做 History API 操作，
所以只是重名。

> MQTT 那条链路的记录在另一个数组 `messages` 里，只给「最近消息」表用
> （`renderLog()` 渲染）。两份分开存：`history` 是手动录入的，没有 `nodeId`；
> `messages` 是订阅到的消息，每条带 `nodeId`。

### 导出 CSV

「录入历史」标题右边的那个按钮，把 `history` 导出成 `dormmate.csv`：

| | |
|---|---|
| 数据源 | `history`（**不是** `messages`，节点消息暂时没有导出入口） |
| 表头 | `time,temperature,humidity,status`，固定第一行 |
| 行顺序 | 和页面一致，**最新在前**（两处都走 `historyRows()`，不会各说各话） |
| 编码 | UTF-8 **带 BOM**，Excel / WPS 打开不乱码 |
| 换行 | CRLF（Excel 对 LF 的兼容性不如 CRLF） |
| 文件为空时 | 按钮旁提示「没有可导出的记录」，不产生下载 |

实现要点：

- **BOM 在源码里写作可见的转义 `'\uFEFF'`**，不是那个隐形字符本身。写成字面量的话
  源码里是一段看不见的东西，看着像一对空引号，文件被按 GBK 另存就会坏掉。
  `fixbom.py` 负责把不小心写进去的字面 BOM 换回转义。
- **`URL.revokeObjectURL` 延后 1 秒**。立刻回收的话，部分浏览器会在下载真正开始前
  就把 blob 释放掉，表现是「点了没反应」。
- 字段里含逗号、引号、换行时按 RFC 4180 包双引号（内部引号写成两个）。

> 想连 MQTT 的节点数据一起导出，加个按钮就行 —— 说一声，现在只有历史这一个入口。

### 在 Console 里跑规则回归

看板页面的 Console 里直接执行：

```js
runRegressionTests()
```

会打印一张表，每行是 `组别 / 温度 / 湿度 / 期望 / 实际 / 是否通过`，
最后附一行汇总（9/9 通过）。老师给的 4 条回归数据 + 5 条边界数据都在里面。
它只读不写，不改页面上的任何东西。

### ⚠ 规则有两份实现，必须同步

同一套规则有**两个**语言的实现，因为两边的调用位置不同：

| 文件 | 谁在用 | 什么时候算 status |
|---|---|---|
| `status_rules.py` | `simulator/simulator.py`（发布端）、`analysis/rules.py`（转发） | 发布前算好，写进 JSON 的 `status` 字段 |
| `shared/rules.js` | 网页看板 | 手动录入没有发布端，只能在前端算 |

**实现只有这两份，改任何一边都要同步另一边。** 两边用的是同一批回归数据，
所以任何一边跑绿了都说明规则还是对的：

```bash
py -3.14 -m unittest discover -s tests -t . -v   # Python 侧 186 条
node tests/rules.test.js                         # JS 侧 31 条
```

`analysis/rules.py` **不算第三份实现**：它 `import ... as judge_status`，直接转发
`status_rules.compute_status`，连阈值常量都是从根模块借的。重抄一份的代价不是多打
几行字，而是以后改规则时必然漏改其中一处——发布端按新规则发「偏热」、分析端按旧规则
判成「偏湿」，两边都不报错，只是数据对不上。测试里用 `assertIs` 直接比函数对象，
一旦谁把它改成第二份实现就会红。

JS 侧只有 `shared/rules.js` 这一份。页面从它取函数
（`<script src="../shared/rules.js">`，或者从 `web/` 出发的相对路径），
不要再往别的文件里抄第二份。

## Step 2-2 / 2-3 / 2-4 / 2-5：Python 读取、复核、统计、趋势图与报告

网页上导出 CSV → 用 Python 读回来做统计 → 画一张趋势图、出一份能直接打开的
HTML 报告（另外还有一条 Markdown 报告的支线），闭环就通了。

```bash
py -3.14 analysis/rules.py                        # 规则自测，4/4 通过（退出码 0）
py -3.14 analysis/analysis.py                     # 读默认的 data/dormmate.csv，出图 + 出报告
py -3.14 analysis/analysis.py data/dormmate.csv   # 同上，显式写路径
py -3.14 analysis/analysis.py C:\tmp\别的.csv      # 绝对路径也认
py -3.14 analysis/analysis.py --no-plot           # 不画图（报告里趋势图位置改占位）
py -3.14 analysis/analysis.py --no-report         # 不出 report.html
py -3.14 analysis/report.py                       # 支线：生成 reports/dormmate-report.md
py -3.14 analysis/report.py data/dormmate.csv -o 我的报告.md
```

`analysis/analysis.py` 依次打印：文件路径、`df.head()` 前 5 行、记录数、温湿度极值、
规则复核、状态统计、需要关注的记录、趋势图存到哪、报告存到哪。

| 文件 | 干什么 |
|---|---|
| `analysis/rules.py` | 对外名字是 `judge_status()`，实际是 `status_rules.compute_status` 的转发；`run_tests()` 用 4 组回归数据自测 |
| `analysis/analysis.py` | `load()` 读 CSV、`summarize()` 汇总、`plot_trend()` 出图、`build_report()`/`write_report()` 出 HTML，`main()` 串起来 |
| `analysis/report.py` | `render()` 把**同一个** `summary` 渲染成 Markdown，`write()` 落文件 |

### Step 2-3：规则复核与状态统计

**核心是一条：不信 CSV 里的 `status`。** CSV 是 Web 端（`shared/rules.js`）写的，
分析脚本用 `rules.judge_status`（Python 端）对每一行重算一遍，存进新列 `rule_status`：

```
                  time  temperature  humidity status rule_status
0  2026-09-22 20:30:00           16        60   偏冷        偏冷
1  2026-09-22 20:30:05           25        60   正常        正常
```

两列不一致就打警告，并把对不上的行连字段一起列出来 —— 这说明两个语言侧的规则
不同步了：

```
!! 警告：3 / 5 行的 status 和规则算出来的不一致
   Web 端用 shared/rules.js，Python 端用 status_rules.py，
   两边对不上多半是只改了一边 —— 同步完规则再重新导出一份 CSV。

  时间                 温度 ℃  湿度 %  CSV 里的 status  规则算出
  -------------------  ------  ------  ---------------  --------
  2026-09-22 20:30:05  31      80      偏湿             偏热
```

随后是状态统计（四种状态都在，没有的是 0；顺序按规则的判断顺序固定，不按次数排）
和需要关注的记录（`rule_status` 不是「正常」的）。

| 函数 | 干什么 |
|---|---|
| `add_rule_status(df)` | 加 `rule_status` 列，返回新表，不改传进来的那个 |
| `find_mismatches(df)` | `status` 和 `rule_status` 对不上的行，连字段一起返回 |
| `count_statuses(df)` | 每种状态几条（统计的是 `rule_status`） |
| `find_attention(df)` | `rule_status` 不是「正常」的记录 |
| `summarize(df, path)` | 汇总成 `summary` 字典，顺便把报告段落打印出来 |

**`summary` 字典**（后面生成报告用）：

```python
{
  "file": "C:\\...\\data\\dormmate.csv",
  "records": 12,
  "temp_max": 31.0, "temp_min": 16.0,
  "humidity_max": 80.0, "humidity_min": 60.0,
  "status_counts": {"偏冷": 3, "偏热": 3, "偏湿": 3, "正常": 3},
  "mismatches": [],                    # 不一致的行（一致时是空列表）
  "attention": [ {...}, ... ],         # 需要关注的记录
}
```

里面只有 `str / int / float / None / list / dict`，可以直接 `json.dumps` 落成报告数据
（numpy 的 `int64` / `float64` 序列化不了，所以在 `_number()` 里就转成内置类型了；
`NaN` 也换成了 `None`，否则 `json.dumps` 会吐出非法的 `NaN` 字面量）。

两个容易忽略的点：

- **温湿度单元格空着的时候**，pandas 读成 `NaN`，而 `NaN` 和任何数比大小都是
  `False` —— 直接丢给规则会被一路走到最后判成「正常」。报告里出现这种假数据最要命，
  所以缺失单独标成 `(缺失)`（`analysis.MISSING`），让它同时出现在状态统计和关注列表里。
- **表格打印有上限**（`MAX_PRINT = 20`）。截断的只是打印，`summary["attention"]` 和
  `summary["mismatches"]` 永远是完整的，超出时会提示「…还有 N 条」。

打印表格是按**显示宽度**补空格的（`_width()`：中文算 2 列）。直接用 `str.ljust`
的话中文被算成 1 个字符，终端里表格是歪的。

### Step 2-4：生成 trend.png

`plot_trend()` 把温度和湿度随时间的变化画成折线图，存到 `report/trend.png`，
目录不存在会自动创建。屏幕上会回一句：

```
中文字体：Microsoft YaHei
趋势图：C:\Users\xdj\Desktop\DormMate Final\nova-dormmate-final-2026\report\trend.png（12 个点，119 KB）
```

| 决定 | 为什么 |
|---|---|
| 温度走左轴、湿度走右轴（`twinx()`），轴标签和刻度染成和线一样的颜色 | ℃ 是十几到三十几，% 是六十到八十，塞进一根轴里两条线会互相挤扁。颜色跟着线走，不用看图例也知道该读哪边 |
| 两条线用不同的点形状（圆点 / 方块） | 印成黑白也分得清，不只靠颜色。给分项打分时这条常被夸 |
| 三条阈值画成虚线（18 ℃ / 30 ℃ / 75 %） | 阈值就是判定规则本身，画出来一眼能看出哪几段越了界，报告里解释「为什么这段要关注」时不用再报一遍数字 |
| 横轴标签转 30°、右对齐，刻度最多 8 个，`AutoDateLocator` | 时间戳是"09-22 20:30"这种长文本，点一多就挤成一团 |
| 跨度不到一天只打 `%H:%M:%S`，跨天才补 `%m-%d` | 标签越短越不容易挤 |
| 图例摆在横轴**下方** | 折线会走到图例底下，放图里总有一段线被盖住（`loc="best"` 也只是挑个盖得最少的角落） |
| 后端用 `Agg`，只存文件不弹窗 | 不用 `plt.show()`，脚本不会卡在窗口上；以后挂 CI（没有显示器）也能出图 |
| 画完 `plt.close(fig)` | 不关的话，同一个进程里反复画图会一直堆在内存里 |

**横轴跨度为 0 时要自己撑开**：只有一行数据（或几个点挤在同一秒）时，`AutoDateLocator`
挑不出刻度间隔，会 warning 一句然后自己随便定 —— 每画一次刷一串。所以跨度是 0 时
手动 `set_xlim(±30 秒)`，点落在正中间。这里有个坑：`get_xticklabels()` 会**立刻**
让 locator 按当前横轴范围算一次刻度，所以撑开范围必须排在读刻度标签**之前**，
顺序反了警告照样出（写的时候就是这么踩的）。

中文字体（`analysis.CJK_FONTS`）按 `Microsoft YaHei → SimHei → PingFang SC →
Arial Unicode MS` 依次试，matplotlib 会用列表里第一个装了的。它不会告诉你最后用了
哪个，所以 `find_cjk_font()` 自己去字体表里查一遍，打印用了哪个；一个都没装就警告
一句「图上的中文会是方块」——不然换台机器跑出来全是方块，只能对着图猜。

`--no-plot` 只出统计不画图：没装 matplotlib 时也能拿到统计数字（这时画图那几只
测试会显示成跳过的 `s`，不是失败）。

**`report/` 和 `reports/` 是两个目录**：图在单数的 `report/trend.png`（课程要求写的
就是这个路径），Markdown 报告在多一个 s 的 `reports/dormmate-report.md`。想合成一个
目录，把 `analysis.py` 的 `DEFAULT_TREND` 和 `report.py` 的 `DEFAULT_OUT` 改成同一个
就行，别只改一个。

### Step 2-5：生成 report.html

`build_report(summary, sections)` 把 `summary` 和趋势图拼成一份 HTML，`write_report()`
写到 `report/report.html`。纯字符串拼接，没有模板引擎；CSS 是内联在 `<style>` 里的
一段（白底细线、卡片放摘要、状态分布条），打印出来也看得清。

报告里有：生成时间、数据来源文件名（带上完整路径）、数据时间范围、摘要卡片
（记录数 / 温湿度最高最低）、各状态的数量与占比、需要关注的记录表格、趋势图。

**一个数字都不写死**：记录数、极值、各状态条数、占比、关注条数全部取自 `summary`，
也就是全部来自这次真正读到的数据。换一份 CSV，报告里的数就跟着变——测试里专门
有一条盯着这件事（拿两份数据各出一份，比数字不同）。

| 决定 | 为什么 |
|---|---|
| 所有要插进 HTML 的文本过 `_esc()`（`html.escape`） | `summary` 里的字符串全来自 CSV——网页导出、也可能有人手打。里面出现 `< > & "` 会把标签撑破，轻则排版乱，重则注入脚本。测试里拿 `<script>alert(1)</script>` 当 status 试过，撑不破 |
| `<img src="trend.png">` 用相对路径 | 报告是要拷走给人看的，绝对路径到别人机器上必然是断图。整个 `report/` 目录拷到哪都能直接打开 |
| 图不在时给一句占位而不是留 `<img>` | 用了 `--no-plot`（或画图那步失败）时，报告里会出现一个破图图标，比没有更难解释 |
| 报告和趋势图写在同一个目录 | 相对路径才成立。`write_report(out_path=...)` 会到**报告旁边**找 `trend.png`，不是到项目里找 |
| 规则复核不通过时，最上面插一条红横幅 | CSV 里的 status 是 Web 端写的、报告里的状态是 Python 端重算的，两边不一致说明规则没同步——这种报告不该安安静静地发出去 |
| 编码 UTF-8 且**不带** BOM，换行统一 LF | `<meta charset="utf-8">` 已经交代了编码，再加 BOM 反而可能被某些解析器当成正文第一个字符；LF 是为了同一个文件在 Windows 和别处 diff 不出满屏差异 |

#### `sections`：往报告里加区块的固定方式

后面要加的「事件复盘」「今日摘要」「ML 异常分析」不用改 `build_report`，
往 `sections` 里塞就行。每项就是 `{"title": 标题, "html": 一段 HTML}`，
按顺序接在趋势图后面：

```python
from analysis import analysis, daily_summary, ml

summary = analysis.summarize(analysis.add_rule_status(analysis.load(csv)), csv, verbose=False)

sections = [
    analysis.table_section("事件复盘", ["时间", "事件"], [["20:30:15", "温度越过 30 ℃"]]),
    # 这两个是真接了的那两处：今日摘要是 Step 8-2，ML 区块是 Step 9-3
    analysis.daily_summary_section(daily_summary.summarize_frame(df, file=str(csv))),
    analysis.ml_section(ml.run_ml(ml.DEFAULT_HISTORY, ml.DEFAULT_NEW)),
]
analysis.write_report(summary, sections=sections)
```

`table_section()` 就是把「标题 + 一张表」拼成上面那种 dict，最省事。
**约定**：`title` 是纯文本，会被转义；`html` 是已经拼好的 HTML，**原样插入**
（不转义）——所以往 `html` 里填数据时要自己先过 `analysis._esc()`。

### 附：把 summary 生成 Markdown 报告

（这一节不是课程里的步骤，是顺着 Step 2-3 那句「后面生成报告要用」先做出来的，
交付清单上没有它也不影响。）

`analysis/report.py` 和 HTML 报告吃的是**同一个** `summary`，所以两份报告的数字
必然一致——统计口径只有 `summarize()` 一处。占比（`format_percent`）和时间范围
（`format_range`）这两个格式函数也放在 `analysis.py` 里，两边共用，免得同一份数据
一边写 25.0% 一边写 25.00%。

`analysis/report.py` 把 `summary` 渲染成 Markdown，默认写到
`reports/dormmate-report.md`，同时把内容打印到屏幕上。报告长这样：

```markdown
# DormMate 宿舍环境分析报告

- 数据文件：`C:\...\data\dormmate.csv`
- 记录数：12
- 时间范围：2026-09-22 20:30:00 ~ 2026-09-22 20:30:55
- 温度：16 ~ 31 ℃
- 湿度：60 ~ 80 %
- 生成时间：2026-09-26 14:10:37

## 状态分布

| 状态 | 条数 | 占比 |
| --- | ---: | ---: |
| 偏冷 | 3 | 25.0% |
...
| **合计** | **12** | **100.0%** |
```

段落顺序：表头信息 → 状态分布 → 规则一致性 → 需要关注的记录 → 结论。

**报告是 `summary` 的纯函数。** `render()` 只吃 `analysis.summarize()` 返回的那个字典，
不再回头碰 DataFrame，所以统计口径只有一处。要出别的格式（HTML / docx）时换的只是
渲染层，数字一个都不会变 —— 测试里就是拿一个手搓的 `summary` 直接喂给 `render()` 的。

几个刻意的取舍：

- **结论里只写数据推出来的话，不写建议。** 「该开窗还是该除湿」这类文案的唯一出处是
  网页那边的 `getAdvice()`（`shared/rules.js`）。在这一侧另写一份，改规则时必然漏改
  一处，而且两边会给出不一样的建议。`conclusions()` 只做「最多的是哪个状态」
  「需要关注占几成」「极值踩没踩到阈值」这种从数字直接推出来的判断，阈值也是从
  `rules.TEMP_HIGH` / `rules.HUMIDITY_HIGH` 取的，不另写数字。
- **生成时间是参数。** `render(summary, generated_at=None)` 不传才取当前时间，
  传了就用传的 —— 测试才能逐字节比对输出。
- **表格单元格要转义。** CSV 的字段是网页那边拼的，谁都能往里写竖线和换行，
  一个竖线就能把 Markdown 表格切歪，所以 `_cell()` 会把 `|` 转成 `\|`、换行换成空格。
- **文件用 LF 换行、不带 BOM。** 这是 `.md` 不是 `.csv`，没必要为 Excel 做妥协；
  Windows 上写出 CRLF 会让 diff 变脏。
- **`summarize(verbose=False)`**：报告只要数据，不要再往屏幕上刷一份终端表格。

### 路径规则：相对路径按**项目根**展开

三个脚本都用 `Path(__file__).resolve().parent.parent` 推出项目根，**不看当前工作目录**。
所以在哪儿敲这条命令都一样：

```bash
cd C:\Users\xdj                                  # 跑到项目外面去
py -3.14 "C:\Users\xdj\Desktop\DormMate Final\nova-dormmate-final-2026\analysis\analysis.py" data/dormmate.csv
```

上面这条照样能找到 `C:\Users\xdj\Desktop\DormMate Final\nova-dormmate-final-2026\data\dormmate.csv`。
按工作目录展开的话，这里会去找 `C:\Users\xdj\data\dormmate.csv` 然后报找不到。
`-o` 指定的输出路径也一样按项目根解析。

`analysis/rules.py` 里 `sys.path` 的处理也是同一个原因：它要 `import status_rules`
（在项目根，不在 `analysis/` 里），靠 `__file__` 推出根目录再插进 `sys.path`，
这样从任何目录、以任何方式运行都 import 得到。

### ⚠ 每个脚本开头都要推一遍项目根

`rules.py` / `analysis.py` / `report.py` 三个文件开头都有一段一模一样的：

```python
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
```

看起来是抄了三遍，但**不能删**，删了 `report.py` 会以这种方式崩：

```
ImportError: cannot import name 'rules' from 'analysis'
(consider renaming 'C:\...\analysis\analysis.py' if it has the same name as a library...)
```

原因不是重名，是**搜索路径的顺序**。`py -3.14 analysis/report.py` 跑的时候
`sys.path[0]` 是 `analysis/` 这个目录，而它里面正好有个 `analysis.py` ——
于是 `from analysis import ...` 匹配到的是那个**文件**，不是项目根下的
`analysis` 包。把项目根插到最前面，包才赢过同名的文件。报错信息里那句
「考虑重命名」会把人往错的方向带。

（另一种跑法 `py -3.14 -m analysis.report` 不会有这个问题，因为 `sys.path[0]`
是当前目录。但项目统一用直接执行脚本的写法，所以就都留着这段。）

### 关于 CSV

- 读的时候用 `encoding="utf-8-sig"` 吃掉文件开头的 BOM。不处理的话第一列列名会变成
  `"\uFEFFtime"` 而不是 `"time"`，后面 `df["time"]` 直接 KeyError。
- 有个反直觉的点：**pandas 3.x 的 `read_csv` 自己就会吃掉 BOM**，就算写
  `encoding="utf-8"` 读出来也是干净的。所以别拿 pandas 当「不处理会坏」的反面对照——
  用标准库 `open(..., encoding="utf-8")` 才试得出来。我们仍然显式写 `utf-8-sig`：
  既是要求，也免得依赖 pandas 版本的具体行为。
- 文件不存在、或表头缺列时会打印一句人话（顺带说明「先在网页上点导出 CSV」），
  不是抛一堆调用栈。
- `data/dormmate.csv` 是**演示用的样例**，12 行、覆盖 4 种状态各 3 次，
  由项目自己的 `simulator.DEMO_SEQUENCE` 生成，所以每行的 `status` 一定和规则算出来的一致
  （`tests/test_analysis.py` 里有一条专门核对这件事）。它是数据不是代码，删掉不影响测试。

## Step 3-1：Camera 现场快照

看板上多了一块「现场快照」面板：`打开摄像头` / `拍照` 两个按钮，左边 `<video>`
实时预览，右边显示拍下来的那一张。

**摄像头只在用户点按钮之后才申请。** `getUserMedia()` 必须由用户手势触发，页面
一加载就自动调会被浏览器直接拒掉（而且会平白弹一次权限框）。

**只保存一张。** `snapshot` 每次被新的覆盖，不做连续采集，也不把视频帧留在内存里。

三个函数都在顶层声明 —— 这份文件是经典 script 不是 module，顶层 `function` 会自动
挂到 `window`，所以外面（下一步的语音指令）能直接调：

| 函数 | 干什么 |
|---|---|
| `openCamera()` | 申请权限、开流、等画面就绪；成功返回 `true`，失败把原因写进 `#cam-error` |
| `closeCamera()` | 逐条 `stop()` 掉 track，界面复位 |
| `takeSnapshot()` | 拍一张并覆盖上一张，返回 `{ok, message}` |

### `takeSnapshot()` 为什么返回 `{ok, message}`

下一步的语音指令「拍照」是隔空调它的：用户喊一句，摄像头可能还没开、画面可能还在
初始化。这两种失败得能分辨、也得能播报出去，所以失败时返回的是具体原因而不是
`undefined`：

```js
const result = takeSnapshot();
if (!result.ok) speak(result.message);   // 「摄像头还没打开，先点『打开摄像头』」
```

三种失败各有一句话：`这个页面没有快照区` / `摄像头还没打开，先点「打开摄像头」` /
`画面还没准备好，等一秒再拍`。同一句话也写进页面上的 `#cam-error`，所以语音和
界面显示的永远是同一个原因。返回 `undefined` 的话调用方只能自己猜。

### 几个决定

| 决定 | 为什么 |
|---|---|
| 画布尺寸取 `videoWidth` / `videoHeight`，不取 CSS 尺寸 | 显示尺寸跟着窗口宽度变，用它拍出来的图一会儿大一会儿小，甚至被拉伸 |
| 关闭时逐条 `track.stop()` | 只把 `srcObject` 置空的话画面是没了，但摄像头还开着、指示灯还亮着，别的程序也依然抢不到这个设备 |
| 监听 `pagehide` 自动关，不用 `beforeunload` | 移动端 Safari 常常不触发后者。不关的话指示灯会一直亮到标签页被回收 |
| 同一个按钮兼作开关（开着时文字变「关闭摄像头」） | 不留下关闭入口的话，用户只能去关标签页才能熄掉指示灯 |
| 预览和快照都不裁不拉（没用 `object-fit: cover`） | 预览里看到多少，拍下来就是多少，两块并排才对得上 |
| `<video>` 带 `playsinline muted` | 不加 `playsinline`，iOS Safari 会把它劫持成全屏播放器；`muted` 是因为有声音的自动播放浏览器一律拦 |
| 错误按 `err.name` 分开映射成人话 | 权限被拒要去改浏览器设置、没设备要去插摄像头、被占用要去关掉别的程序 —— 三件事用户要做的事完全不同，笼统一句「打开失败」等于没说 |

错误名一张表在 `CAMERA_ERRORS` 里，同一个原因的新旧名字都列上了（比如
`NotAllowedError` 的老名字是 `PermissionDeniedError`）。表里没有的名字会退回
`打开摄像头失败：<原始 message>`，不至于什么都不显示。

### ⚠ 手机用局域网 IP 打不开摄像头

`getUserMedia` **只在安全上下文里存在**。`localhost` 算安全，手机用
`http://10.102.196.160:8000/web/` 打开就**不算** —— 这时 `navigator.mediaDevices`
整个是 `undefined`，不是「调用失败」，而是「这个接口压根不存在」。

不单独处理的话报错会变成 `Cannot read properties of undefined`，看着完全不像
地址问题。所以申请之前先过一道 `cameraBlockedReason()`：

| 情况 | 页面上的提示 |
|---|---|
| 接口在，但 `!window.isSecureContext` | 当前地址（10.102.196.160:8000）不是安全上下文……本机请用 http://localhost:8000/web/；手机需要 https 或者本机的 localhost |
| 接口整个不存在 | 这个浏览器不支持摄像头（`navigator.mediaDevices` 不存在），换新版 Chrome / Edge |

**这是浏览器的安全策略，不是代码问题，改不了。** 演示时摄像头那一步在本机
`http://localhost:8000/web/` 做。

### 测试

`tests/script.test.js` 里有 32 条盯着这块，靠 DOM 桩里新加的三样东西：

| 桩 | 干什么 |
|---|---|
| `installMediaDevices(mode)` | 造 `navigator.mediaDevices`，四种模式 `ok` / `deny` / `none` / `off`，对应正常、权限被拒、没找到设备、接口不存在 |
| `fakeStream()` | 假的 `MediaStream`，记录每条 track 有没有被 `stop()` |
| `createElement('canvas')` | 记录 `width` / `height` / `drawImage` 的实参，返回固定的 data URL |

所以验到的是「画布开成 1280×720」「`drawImage` 正好调了一次、参数是
`(video, 0, 0, 1280, 720)`」「关摄像头时 track 被停了」「第二次拍照是覆盖不是追加
（画布重开成 640×480）」这类细节，而不只是「函数被调用了」。

两个坑记一下：

- **DOM 桩不解析 HTML。** `<img id="cam-image" hidden>` 里的 `hidden` 属性在桩里
  体现不出来（`stubEl()` 的 `hidden` 默认 `false`）。所以「还没拍照时不出图」不能
  断言 `img.hidden === true` —— 那没有依据。拆成两条：起手状态查 HTML 标记
  （`/<img id="cam-image"[^>]*\shidden/`），失败路径查「没往 `img.src` 里写过东西」。
- **`window.addEventListener` 得补上。** 桩里的 `window` 原本只有 `matchMedia`，
  `pagehide` 一挂上去就 `TypeError: window.addEventListener is not a function`。
  补的是**桩**不是生产代码 —— 真浏览器一定有这个方法。顺带加了 `fireWindow(type)`
  用来在测试里模拟「用户关掉了页面」。

## Step 3-2：ASR 语音指令

页面上多了一块「语音指令」面板：一个按钮 + 两块结果区（识别到的文字 / 执行结果）。

**每次点击只识别一句。** `continuous = false`，拿到结果或出错都让它结束。不做连续听 ——
连续模式下"一句话说完了"由引擎自己判断，教室里一吵就会把旁边的闲聊也识别进来。

用的是浏览器自带的 `SpeechRecognition`（Chrome / Edge 上是 `webkitSpeechRecognition`），
所以**要联网**：Chrome 是把录音传到服务器上识别的，断网直接报 `network`。

| 说 | 走哪 |
|---|---|
| 含「朗读」 | `speakStatus()` |
| 含「拍照」 | `takeSnapshot()` |
| 都不含 | 页面上显示「未识别的指令：<原话>」 |

**按「包含」判断，不是整句相等。** 识别引擎会把标点和语气词一起吐出来（"朗读一下。"），
整句比对永远匹配不上。`VOICE_COMMANDS` 的数组顺序就是判断顺序，第一条命中的赢 ——
说"朗读并且拍照"会走朗读。

> ⚠ 是**字面子串**匹配，不是同义词理解：说「拍张照」**不**触发拍照（里面没有"拍照"
> 这三个字），会显示未识别。这是这一步的约定行为（要求就是"包含拍照"），但演示时
> 得照约定说「拍照」。测试里专门有一条钉住这个边界。

### `speakStatus()` 一开始只打 `console.log`

Step 3-2 那一步它只把"要念的内容"（各节点的温度/湿度和状态）打到控制台，但**返回值
已经是 `{ok, message}`** —— 和 `takeSnapshot()` 同一个形状。这样路由层
（`handleVoiceText`）不用分辨命令是谁，拿到结果直接显示就行。

**Step 3-3 把里面换成真正的朗读时，路由那一层一行都不用改** —— 当时留这个形状就是
为了这个，实测也确实没动过。

### 错误显示的是原始的 `event.error`

不支持、麦克风被拒、`network`，都把**浏览器给的错误码原样写在页面上**，后面再跟一句
人话解释：

```
语音识别出错（not-allowed）：麦克风权限被拒绝了。点地址栏左边的图标，把「麦克风」改成「允许」，然后重试。
```

错误码必须留着，不能用文案替掉：`VOICE_ERRORS` 这张表只是"加一句解释"，而浏览器
各版本一直在加新的错误码 —— 表里没有的（比如 `weird-new-code`）也照样显示成
`语音识别出错（weird-new-code）`，不会被吞掉。测试里专门有一条盯着这件事。

### 几个决定

| 决定 | 为什么 |
|---|---|
| 正在听的时候再点按钮直接忽略 | 连点两次会走到 `start()` 抛 `InvalidStateError`，比安静地忽略第二次点击难解释得多 |
| 按钮文字变「正在听…」，外加一圈 `--focus` 环 | 得让用户知道"现在该说话了"。环用 `--focus` 不用状态色 —— 那四档状态色是留给环境 status 的，"正在听"不是一种环境状态，借来用会让人以为页面在报警 |
| `interimResults = false` | 中间稿会边听边变、闪得厉害，而我们只关心最终那一句 |
| `onresult` 里把 `results` 全拼起来 | 通常只有一条 final，但别假设只有一条 |
| 两个结果区用 `is-placeholder` 类区分占位和真结果 | 由调用方明确传标志位，不去比较文本内容猜"这是不是占位文案"—— 那样迟早会被真结果撞上 |
| 结果区写 `overflow-wrap: anywhere` | 识别结果偶尔是一长串没空格的英文/数字，不换行会把并排的另一块挤扁 |
| `pagehide` 时 `abort()` 会话，并且**先摘掉 `onerror`** | 不掐掉的话麦克风一直开着；而主动 abort 也会触发 `onerror`（`error === 'aborted'`），那是我们自己干的，不该当错误显示给用户 |

### 测试

`tests/script.test.js` 里 28 条，靠一个假的 `SpeechRecognition` 构造函数：`new` 出来的
实例记下 `lang` / `continuous`，`start()` 立刻回调 `onstart`（真浏览器也这样，所以
"按钮变正在听"这条能同步验），测试再手动 `say(text)` / `fail(code)` 模拟识别结果和错误。

覆盖到：浏览器不支持、`lang`/`continuous`/`interimResults` 三个参数、正在听时重复点击
被忽略、三个固定指令各自的走向、「拍照」在摄像头没开时走 `takeSnapshot` 的失败分支、
字面匹配的边界（「拍张照」不算）、`not-allowed` / `network` / `no-speech` 三种错误码都
出现在页面上、表里没有的码不被吞、离开页面时 `abort` 且不报错。

## Step 3-3：语音播报

说一句「朗读」，页面用浏览器自带的 `speechSynthesis` 把当前状态念出来：

```
dorm-a 25℃ 60% 正常；dorm-b 31℃ 78% 偏热
```

和 Step 3-2 的识别不一样：**识别要联网，合成不用**。Chrome 的识别是把录音传到服务器上
做的，断网直接报 `network`；合成的声音就在本机，断网也念得出来。

### 念的是报文里的 `status`，不是页面重算的

这句话必须跟屏幕上那几张卡片一字不差。前端**不许**重算状态 —— 规则在这个项目里只有
一份实现（Python 侧的 `status_rules`），页面和看板都只负责渲染。前端自己再算一遍的话，
屏幕上显示的和耳朵听到的迟早会在某条边界数据上分家，而且**不报错**。

测试里拿 31℃/78% 那条钉住这件事：规则上它算「偏热」，报文里故意写成「偏湿」，
念出来的必须是「偏湿」。

### 按 nodeId 排序，不是按收到的先后

同一份数据念出来的句子必须每次都一样。顺序跟着到达时间跑的话，连"刚才念的和现在念的
是不是同一句"都没法比。一个节点都没收到时念的是「还没有收到任何节点的数据」，
**不是「都正常」** —— 页面刚打开那几秒是**不知道**，说成"正常"就是句假话
（和看板 B1 / B4 同一个口径）。

### 要念的那句话就写在页面上

`speakStatus()` 返回的 `message` **就是要念的那句话本身**（`正在朗读：dorm-a 25℃…`），
不是另写一句提示。静音、没音箱、音量太小的场合，「执行结果」那一格是唯一能确认
"它到底念了什么"的地方；提示语和朗读内容各写各的，那格字就失去意义了。
（看板 8-3 的「语音提醒」也是这么处理的。）

### 几个决定

| 决定 | 为什么 |
|---|---|
| 先 `cancel()` 再 `speak()` | 连着说两次「朗读」，第二句会老实排在队列里等着，等第一句念完（三个节点要好几秒）才开口，而那时念的是**上一次算出来的**内容，早就不算数了。掐掉上一句、立刻念最新的才对 |
| utterance 用一个模块级变量存着 | 不是"记住上一条"（每次都是现算的），是防一个真实的坑：Chrome 里 utterance 被 GC 掉，念到一半会直接停。变量一直指着它，它就活着 |
| `speechSupported()` 查两样东西 | Chrome 上 `speechSynthesis` 一直在，但 `SpeechSynthesisUtterance` 是个构造函数，缺了它 `new` 出来就是 `TypeError`。少查一个的话，不支持的环境里说一句「朗读」就是一条未捕获的异常 —— 界面上只表现为"什么都没发生" |
| 不支持时不装作念了 | 返回 `{ok:false}`，并把要念的内容原样写在「执行结果」那一格。用户至少知道**没念出去的是什么** |
| `onerror` 覆盖掉「正在朗读…」 | 错误是 `speak()` **之后**才来的，那时路由层已经把「正在朗读」显示上去了。不覆盖的话页面会一直声称它在念，而实际上什么都没响。原始错误码写在最前面（和 3-2 的 `VOICE_ERRORS` 同一条原则） |
| 离开页面**不** `cancel()` | 合成不占用任何设备，页面走了声音自己就停；3-2 那边 `pagehide` 必须 `abort()` 是因为麦克风会被一直占着 —— 两件事不一样 |
| 没有单独加一个「朗读」按钮 | 这一步的要求是"识别到朗读就真的念出来"。看板那边的按钮是 8-3 给"不靠语音也能触发"做的，两处不共用代码；`web/` 这边要走按钮的话，在面板上加一个调 `speakStatus()` 的按钮就行 |

### 自测：说一句「朗读」

1. 起 broker、起服务器、起模拟器（见「运行（三个终端）」）。
2. 浏览器打开 `http://localhost:8000/web/`，点「语音指令」，说「朗读」。
3. **该听到**：`dorm-a 25℃ 60% 正常；dorm-b 31℃ 78% 偏热`（念的是当时的数据）。
   「执行结果」那一格里同步写着同一句话 —— 听不到声音时看它。
4. 连说两次「朗读」：第二句**立刻**开口，不会等第一句念完。
5. 让模拟器再发一轮再说一次：念的是刚收到的新数据。
6. 把系统音量关掉再说一次：页面上照样有那句话 —— 这就是它写在页面上的用处。

### 测试

`tests/script.test.js` 里 20 条，靠一个假的 `speechSynthesis`：`speak()` 只把 utterance
记下来（不真念）、`cancel()` 数次数；utterance 上的 `fireError(code)` 模拟"念到一半出错"。
桩分三档 —— 两样都在 / 只有 `speechSynthesis` / 两样都没有 —— 因为"支持到什么程度"
这件事本身就是被测的一条。

覆盖到：没数据时念什么、排序、小数格式、**念的是报文里的 status 不是重算的**、
走完整条链路（点按钮 → 识别 → 路由 → `speakStatus` → `speak()`）、`lang`、
先 `cancel` 再 `speak`、页面上那句话、utterance 的引用、不缓存上一句、
三种支持程度各走一遍、`onerror` 的两种错误码。

## Step 5-3 / 5-4：多节点 Dashboard

`dashboard/` 是和 `web/` 并列的第二个前端，专门看 dorm-a / dorm-b / dorm-c 三个节点：

| | `web/` | `dashboard/` |
|---|---|---|
| 面向 | M1~M3，单个宿舍的完整功能 | M5，三个节点的横向对比 |
| 内容 | 卡片 + 手动录入 + 录入历史 + 导出 CSV + 现场快照 + 语音指令 | 三张节点卡 + 两张趋势图 + 消息日志 |
| 数据 | 订阅同一个通配符 `dormmate/v1/nodes/+/telemetry`；按 `nodeId` 存进一个 Map，**来几个节点就画几张卡** | 订阅同一个通配符，但节点白名单写死在 `dashboard.js` 的 `NODE_IDS`：固定三张卡，还没收到数据的显示「等待数据」，白名单外的节点只记一条错误日志、不建卡 |

打开方式和 `web/` 一样走 8000 端口的静态服务器（`start_web.bat` 或手动起）：

```
http://localhost:8000/dashboard/
```

### 订阅与连接

Topic 用通配符 `dormmate/v1/nodes/+/telemetry`，一条订阅覆盖三个节点 —— 加第四个节点不用改订阅，
只要有人往 `dormmate/dorm-d/env` 发，页面就会自己多出一张卡。真正的节点白名单在
`dashboard.js` 的 `NODE_IDS`，加节点改那一处。

Broker 地址不是写死的 `localhost`，而是跟着页面地址走：

```js
function brokerUrl(hostname) { return 'ws://' + (hostname || 'localhost') + ':9001'; }
```

手机用 `http://10.102.196.160:8000/dashboard/` 打开时会连 `ws://10.102.196.160:9001`。
写死 `localhost` 的话，手机浏览器里的 localhost 指的是手机自己，连不回来。
（`web/script.js` 里也有一份同样的写法，故意各留各的：两个页面互不依赖，为一行代码
共用一个 `shared/` 文件反而要多发一次请求。改的时候两边一起改。）

### 连接状态显示的是 7 种，不是 3 种

顶栏那个圆点配文字的小胶囊，状态由 mqtt.js 的 5 个事件映射而来：

| 事件 | 文案 | 点色 |
|---|---|---|
| 初始 | 连接中… | 黄 |
| `connect` | 已连接 | 绿 |
| `reconnect` | 重连中… | 黄 |
| `close` | 已断开 | 红 |
| `offline` | 已离线 | 红 |
| `error` | 连接失败 | 红 |
| 手动断开 | 未连接 | 红 |

比「连接中 / 已连接 / 已断开」三态细：`reconnect` 和 `error` 都落不到「已断开」上，
混在一起就分不清「正在重试」和「彻底连不上」。

每个回调开头都有一句 `if (!current()) return;`（`current()` 就是 `client === c`）。
这不是多余的 —— 手动断开时旧连接的回调还会补触发一次，不挡掉就会把刚建立的新连接
的状态覆盖成旧的。

`disconnect()` 里先 `client = null` 再 `c.end(true)`：`end()` 会触发 `close`，那时
`client` 已经是 null，回调里的 `current()` 认出「这是被主动断的那根」直接返回，不会
过一会儿又把状态跳回「已断开」。`end(true)` 的 `true` 是停止自动重连。

### mqtt.js 用本地文件，Chart.js 用 CDN —— 这是故意的

同样两个库，引用方式不一样：

| 库 | 引用方式 | 挂了会怎样 |
|---|---|---|
| mqtt.js | `<script src="lib/mqtt.min.js">` | **一条数据都收不到**，整个看板是空的 |
| Chart.js | npmmirror CDN | 只是少两张趋势图，卡片和日志照常用 |

风险不对等，所以对待方式也不一样。现场没网时把 Chart.js 那行换成
`lib/chart.umd.min.js`（文件已经在 `dashboard/lib/` 里放好了），整个页面就完全不依赖
外网。两个文件都是现成的，不必再下一次：

| 文件 | 版本 | 字节数 | sha256 |
|---|---|---|---|
| `dashboard/lib/mqtt.min.js` | 5.10.1 | 329535 | `b088a7f9045df4e478dbc378f41125066e43d9c602755ee4c5cda0f3e9380ba0` |
| `dashboard/lib/chart.umd.min.js` | 4.5.1 | 208522 | `48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a` |

（这几份的字节数和 hash 在 clone 之后同样成立，原因见 Step 6-1 那节的说明。）

CDN 源特意选 **npmmirror** 而不是 jsDelivr —— 实测本机连 jsDelivr 是 0.2 秒直接失败
的连不上。Chart.js 要下 `dist/chart.umd.min.js`，`dist/chart.js` 是 ESM 版，用
`<script src>` 引它 `Chart` 会是 undefined。
（文末「开源组件来源」那张许可证表还是空的，别看成已经填好了。）

### 收到的 `status` 一律复核

`handleMessage` 不信任报文里的 `status`，一律调 `judgeStatus()` 重算，不一致就以规则
为准，并在日志里标成「警告」写清差在哪。这和 Python 侧 `analysis/rules.py` 复核 CSV
是同一个思路 —— 数据在链路上可能被别的东西写坏，显示出去之前再算一遍。

发现异常**不丢报文**：topic 里的节点名和报文里的 `nodeId` 对不上时只警告，节点身份以
报文自己声明的为准（统一 JSON 里 `nodeId` 是必填字段）。真正会丢弃的只有解析失败、
字段缺失、类型不对、数值是 NaN/Infinity、节点名不在 `NODE_IDS` 里这几种。
一条报文只写一行日志，多个问题合并进那一行 —— 否则日志区就不再是「每条消息一行」，
对不上数了。

### Console 会打印每条原始报文

```
[DormMate] 收到 MQTT 原始消息 dormmate/v1/nodes/dorm-a/telemetry {"nodeId":"dorm-a",...}
```

打印点在 `client.on('message')` 这个边界上，**不在 `handleMessage` 里** —— 那边是真实
MQTT 和「模拟三节点数据」按钮共用的，模拟数据混进来冒充实收报文会把排错方向带偏。

排错时先看 Console：「压根没收到消息」和「收到了但被 `handleMessage` 拦下了」是两回事，
而页面上的日志区只记后者，前者完全不显示。

### 关掉模拟器后卡片还有数，这不是 bug

`config.py` 里 `RETAIN = True`（注释写着「保留最后一条，后开的看板能立刻看到数值」），
所以模拟器停了之后再打开页面，仍会立刻收到 Broker 补发的最后一条。这是有意的：演示时
不用先干等。要区分「实时数据」和「补发的旧数据」，看卡片上的时间戳。

### 测试

`tests/dashboard.test.js`，127 条，纯 Node 无依赖。它造了一套假 DOM 和假 `mqtt`
（`connect()` 返回的对象记下注册的 handler 和订阅的 topic），把 `dashboard.js` 真跑起来，
再手动触发 `connect` / `message` 这些回调。

覆盖到：三个节点的数据互不串线（三份 `history` 是不是各归各的）、图表跟着切换节点重绘、
脏数据（解析失败 / 缺字段 / 类型不对 / NaN / 未知节点）分别被拦下、`status` 与规则不一致
时以规则为准、topic 与 nodeId 不一致时警告但不丢弃、历史上限、清空、MQTT 连接与订阅、
以及 mqtt.js 没加载时的降级提示。

`tests/miniapp-rules.test.js` 那 48 条是另一回事：它把 `miniapp/utils/rules.js` 和
`shared/rules.js` 放进两个独立的 vm 各跑一遍，在 8211 组温湿度上逐对比对，防止两份实现
悄悄跑偏。参考「⚠ 规则有两份实现，必须同步」。

## Step 6-1：最小 Three.js 场景

`3d/` 一开始是个独立的最小页面：一块地板 + 一个会转的立方体。还没接数据，先把
「three 在这个项目里跑得起来」立住。

> 场景本身在 **Step 6-2** 已经换成了完整的简化宿舍（地板 / 墙 / 床 / 窗户 / 风扇，
> 并且会随 status 变样子），见下一节。本节留下的是 three 的**接入方式** ——
> importmap、本地化改法、下面那两个坑 —— 这些 6-2 一个字都没改。

```
http://localhost:8000/3d/
```

**必须走 http 服务器，不能像别的页面那样用 file:// 直接打开。** 这个页面用的是
ES Module，`<script type="module">` 受 CORS 约束，file:// 下的模块会被当成跨域
直接拒绝 —— 控制台报一串 CORS 错，场景完全不出现。

### 为什么用 importmap

源码里写的是 `import * as THREE from 'three'` 这种**裸名字**，浏览器不知道去哪儿
找。importmap 就是干这个的：把裸名字映射到真实 URL，于是 CDN 的长地址只出现一次，
将来换成本地路径也只改一行。

三个要注意的：

- **importmap 的内容必须是合法 JSON**，所以里面一行注释都写不了（JSON 没有注释
  语法），说明只能写在 `<script>` 外面。
- **必须出现在第一个 module script 之前**，顺序反了浏览器直接不认。
- 只有以 `./` 或 `../` 开头的映射值才按相对 URL 解析，基准是**页面所在目录** ——
  所以本地路径写 `./lib/three.module.js`，不是 `./3d/lib/three.module.js`。

### 改成本地 three（现场没网时）

文件已经在 `3d/lib/` 里放好了，把 importmap 那一行换成下面这句，其余一个字都不用动：

```json
"three": "./lib/three.module.js"
```

这个改法实测可用（用无头 Edge 截图确认过场景正常渲染）。

| 文件 | 版本 | 字节数 | sha256 |
|---|---|---|---|
| `3d/lib/three.module.js` | 0.160.0 | 1272972 | `76dea8151bc9352aef3528b4262e249b2604f62543828328db978d060d61a495` |

上面这两个数是照**下载下来的文件**算的，`clone` 下来核对也一样 —— 根目录的
`.gitattributes` 把 `3d/lib/` 钉成了 `text eol=lf`。不钉的话，`core.autocrlf=true`
的机器 clone 出来会被换成 CRLF（1272972 变成 1326016 字节），照表核对的人只会以为
自己下错了文件。

这个文件是**自包含**的：内部不再 import 任何东西，所以整张映射表只要有 "three"
一条就够。换成更新的版本时要留意 —— 新版把核心拆去了 `three.core.js`，
只映射 "three" 会报找不到模块。

要重新下载：

```bash
curl -o 3d/lib/three.module.js \
  https://registry.npmmirror.com/three/0.160.0/files/build/three.module.js
```

npm 包里还有一份 `build/three.module.min.js`（670681 字节，压缩过）。功能完全一样，
只是源码挤成一行、报错栈不好读，所以这里留的是未压缩那份。源选 npmmirror 而不是
jsDelivr，理由和 Chart.js 那次一样（见上一节末尾）。

### 这一步踩的两个坑

两个都不报错，只是「看起来没生效」。事后都补了回归测试（下面测试一节里的 ★）。

**① 灯和相机同侧，影子藏在物体背后。**

最初灯放在 `(6, 10, 7)`、相机在 `(6, 5, 9)`，几乎同一侧。阴影落在立方体背离光源
的那一面 —— 也就是**立方体的正后方**，从相机看过去被立方体自己挡得严严实实。
屏幕上一片干净，一丝阴影都没有。

当时去查了 `shadowMap` 配置、换了渲染后端、对比了 SwiftShader 和真实 GPU —— 全是
白费，因为阴影一直在正常渲染。**把灯挪到相机的斜对角就全好了。**

同一个原因还有个副作用：两个可见面都朝光、亮度接近，立方体看着是平的；挪完之后
变成一亮一暗两个面，「立体」感才出来。

> 经验规则：主光偏离相机视线 40°~70°，别和相机同一侧。

**② 改完阴影相机的范围，必须自己重算投影矩阵。**

```js
dirLight.shadow.camera.left = -12;                  // 只改这些是没用的
dirLight.shadow.camera.updateProjectionMatrix();    // 少这一行，上面全部静默失效
```

three 的 `LightShadow.updateMatrices()` 只读现成的 `projectionMatrix`，**不会**替你
调这个方法。漏掉的表现是「改了没反应」：范围还是默认的 ±5，不报错、不警告。

同类的还有两处：

- 相机改完 `aspect` 也要 `camera.updateProjectionMatrix()`，否则画面照样是拉伸的。
- `far` 要罩得住地板。地板 400×400 的远角离相机约 290，`far` 只给 200 会在远处切出
  一道弧形的洞 —— 看起来像「地板缺了一块」，很难联想到是相机参数。但 `near` 也不能
  太小：深度缓冲的精度取决于 `far/near` 的比值。

### 测试

`tests/scene3d.test.js`，198 条，纯 Node 零依赖。

`scene.js` 是 ES Module，`import ... from 'three'` 是个裸名字，Node 不认 importmap；
它还要 `document` / `window`。测试的解法是**把真实的源文件跑起来**：把那一行 import
改写成指向本地假 `three` 模块的绝对 file:// URL，写成 `.mjs` 扔进临时目录再 import，
同时往 `globalThis` 上挂一套假 DOM。不做语法改写、不装任何依赖。

覆盖到：容器查找与报错、renderer 的像素比封顶与尺寸、宿舍每部分的几何与朝向、
两盏灯、相机参数与 `lookAt`、`updateScene` 的四种状态映射、`setFanOn` / `setLabel`、
动画循环随 dt 累加（**验证转动快慢与帧率无关**）、
resize 自适应与 0×0 容器不产生 NaN、dispose 是否真的回收了几何体/材质/监听，
以及 index.html 的 importmap（合法 JSON、出现顺序、版本号）、4 个状态按钮的接线，
和 `lib/` 里那份的大小与自包含性。

★ 那几条都用**变异测试**验过：把对应的 bug 逐个塞回源码，
对应断言准确失败、其余保持全绿。6-1 的两条（删掉 `updateProjectionMatrix()`、
把灯挪回相机同侧）和 6-2 新加的一批一起跑，22 个变异全部被抓住。

## Step 6-2：简化宿舍 + updateScene(status)

6-1 的地板和立方体已经换掉，`3d/scene.js` 现在搭的是一个**简化宿舍**：
地板 + 两面半透明墙 + 床 + 窗户 + 风扇，全靠基本几何体拼出来。

```
http://localhost:8000/3d/
```

页面下方有 4 个按钮（正常 / 偏冷 / 偏热 / 偏湿），点一下就能看到四种状态各改什么。

### 四种状态各自改什么

全在一张 `LOOK` 表里，`updateScene()` 只负责照着贴上去，不写 if/else ——
表能一眼看全四种状态，if 得一行行读。每一行都把各项写全，不做「只写差异、
其余继承默认」那种省略。

| 状态 | 地板 | 窗户 | 风扇 | 灯光 |
|---|---|---|---|---|
| 正常 | 底色 | 关、默认色 | 停 | 白 |
| 偏冷 | 底色 | 关、默认色 | 停 | **两盏灯一起偏蓝** |
| 偏热 | **偏红** | 关、默认色 | **转** | 白 |
| 偏湿 | 底色 | **变蓝 + 打开** | 停 | 白 |

三个不显眼但要紧的地方：

- **偏冷必须两盏灯一起改。** 只改平行光的话，环境光那盏白灯会把蓝调中和掉，
  画面只是稍微冷一点点，看起来像「没生效」。
- **风扇转不转由 `fanOn` 标志位决定，角度由动画循环推进。** 关掉时角度停在原地
  不归零 —— 归零的话风扇会「啪」地跳回起点。「要不要转」和「已经转到哪了」
  是两件事。
- **不认识的 status 不抛异常。** 这个方法的入参迟早来自 MQTT 报文，链路上什么
  都可能传进来，显示层不该因为一个坏值整页崩掉。做法是退回「正常」、在控制台
  把原值打出来，并且**返回实际生效的那个状态**（页面拿它去标按钮高亮）。
  这和 dashboard 那边「脏数据拦下来、记一条警告、其余照常」是同一个思路。

### 搭场景时的三个做法

**① 开窗要绕一条边转，所以给窗户加了个「铰链」父节点。**

直接转 `windowPane` 的话它绕自己的中心转，看起来像块板子在原地打转，不像开窗。
真实窗户是绕**一条边**转的。做法是加一个空 `Group`（`windowPivot`）放在铰链位置，
把窗扇挂在它的一侧（`position.x` = 半个宽），再转这个 Group —— 转轴自然落在左边缘：

```js
windowPivot.position.set(0.3, 2.3, -4.9);   // 铰链在后墙上
windowPane.position.x = 2.6 / 2;            // 挂在铰链的 +X 侧
windowPivot.rotation.y = WINDOW_OPEN_ANGLE; // 转父节点 = 绕边开
```

**想绕非中心点旋转，就给它一个父节点当轴** —— three / GUI 里最常见的招。

开窗角度取的是**负角**（`-π/2.5`）：窗户从铰链沿 +X 伸出去，绕 Y 转负角才朝屋里
（+Z）开；转正角会朝墙外面甩出去、穿墙而过。写反了在截图上一眼能看出来。

**② 风扇分成两层，不能合成一层。**

- `fanMount`：管「摆在哪儿、朝哪边」，还挂着把风扇连到墙上的支架；
- `fan`：只管自己转，里面就是题目要的那个 Group —— 一个中心 + 3 片扇叶。

合成一层的话，扇叶转起来连支架一起转，看着像整台风扇在墙上打滚。

3 片扇叶用 `cos/sin` 撒在半径 0.66 的圆上，**同时把叶片自己也绕 Z 转同样的角度** ——
少了后面那一步，三片叶子的朝向全是水平的，看起来像三根平行棍子而不是风车。

**③ 房间里那两块地，不是一块。**

- 大地面（400×400）负责「接到天边」，让房间不像是浮在虚空里；
- 房间地板（10×10）才是「偏热时变红」的那块，范围必须和房间一样大 —— 再大一点，
  整个视野（包括屋外）会一起变红，就不像「这间宿舍偏热」了。

两块共面的地面会互相闪烁（z-fighting），所以大地面压低 0.02。

墙用的是 `PlaneGeometry` + `DoubleSide`，不用有厚度的 `BoxGeometry`：半透明物体
每多一层就多叠一次透明度，盒子的正反面会让墙色变浑，单个平面正好一层。

### 覆盖层文字：为什么用 HTML 而不是画进 3D

`setLabel()` 写的是一个 `position: absolute` 的 `<div>`，由 `scene.js` 建出来挂进
容器。理由是中文在 canvas 上要自己处理字体和分辨率，而 HTML 这边浏览器全包了，
还自带换行、缩放、无障碍朗读。

代价是两条 CSS 必须写对，写错了都只是「看起来不对」，控制台一声不吭：

- 容器要 `position: relative`，否则覆盖层会飘到 `<body>` 上去、跑到页面左上角；
- 覆盖层要 `pointer-events: none`，否则这层会吃掉鼠标事件 —— 现在盖住的那块没法
  选中，将来想给 3D 加拖拽也拖不动。

两条都有回归测试盯着，而且测试是**剥掉注释之后**再查的：`#scene` 那段注释里正好
写着「position: relative」这几个字，不剥注释的话那条断言永远为真。

### 这一步的验证方式

四种状态各截了一张无头 Edge 的图确认。无头浏览器点不了按钮，所以临时加了一个页面
把状态从 URL 传进去，验完删掉。

「风扇在转」这件事没法靠一张静态图说明，改用**三张不同 `--virtual-time-budget`
的截图**两两比对像素：有差别的区域只有 x 226–400 / y 265–399 —— 正好是风扇本体
加它在地上的影子，其余部分逐像素相同。既证明了它在转，也证明了**只有**它在转。

开窗和转速都没做缓动，是瞬间到位的：按钮点下去要立刻看到变化，而且立刻到位让
「打开了吗」「转了吗」一眼可验、也好写测试。想让开合柔和一点的话，在动画循环里
让 `rotation.y` 朝目标值逼近即可。

### 这一步对测试桩的改动

假 `three` 模块原来只够 6-1 用，这次补了三处。其中一处是**真 bug**，不是补功能：

- **`traverse` 要递归。** 原来只走一层，而扇叶嵌在 `fan` 里、床垫嵌在 `bed` 里 ——
  只走一层的话 dispose 那几条根本走不到那两层，「漏了没回收」检不出来，是**假的**
  通过。改成递归之后，把 traverse 退回一层，那几条会立刻红。
- **材质的 `color` 要转成 `Color` 对象**，不是原样存数字。真 three 就是转的，而
  `updateScene` 要调 `material.color.set(...)`，存数字的话假模块上会炸、
  真浏览器里好好的。
- **`Object3D` 的 `castShadow` / `receiveShadow` / `children` 要预先存在。**
  那两面墙是**不写**这两个属性的，假模块要是只给显式赋过值的对象加，就会拿到
  `undefined`，而真 three 里它们是构造时就有的。

另外，比对 index.html 里 `importmap` 和 module script 的先后时，要**比标签的
位置**而不是找 `importmap` 这个词 —— 注释里也出现过这个词，拿 `indexOf` 找词的话，
两条注释谁前谁后就决定了断言真假。

## Step 6-3：MQTT 驱动 3D + 嵌入 Dashboard

6-2 那个场景只做到「给一个 status，它跟着变」。这一步把 status 接上真实数据源：
`3d/index.html` 自己订阅 MQTT，看板则把同一个场景嵌进详情区。

两边的规矩是同一条：**订阅 `dormmate/v1/nodes/+/telemetry`，但只有「当前选中的那个宿舍」的消息
才交给 `updateScene`**。收到的 `status` 也一律用 `judgeStatus` 复核，报文里写什么都不算数。

### 为什么要按节点筛：三个宿舍挤在一个 topic 里

`dormmate/v1/nodes/+/telemetry` 这个通配符把三个宿舍的数据混在一条流里送过来。
不筛的话，dorm-b 的报文一到，画面就变成 dorm-b 的样子，
而覆盖层上还写着 dorm-a —— 屏幕上看着挺正常，只有盯着那行小字才发现对不上。

筛的动作放在**消息入口的最后一步**，两个页面各一处：

```js
// 3d/index.html
if (data.nodeId === currentNodeId) render();

// dashboard/dashboard.js（handleMessage 里）
if (record.nodeId === currentNodeId) renderScene();
```

### 卡片和图表每次都刷，3D 要挑

同一批数据，看板里的处理方式并不一样：

| | 显示范围 | 刷新时机 |
|---|---|---|
| 卡片、图表、日志 | 三个节点一起显示 | 每来一条消息都刷 |
| 3D 视图 | 只显示当前选中的那个 | **只有当前节点收到消息时才刷** |

区别不在性能，在语义：卡片是「三个宿舍的横向对比」，任何一条新数据都改变了它要表达的东西；
3D 是「我现在盯着的这个宿舍」，别的宿舍的数据进来，它**应该**纹丝不动。
不加这个判断，屏幕上不会报错，但那个「我盯着的」就不成立了。

### 切到还没收到数据的节点

`scene.js` 只认 `正常 / 偏冷 / 偏热 / 偏湿` 四个字，没有「不知道」这一档。
所以这两个页面都得自己决定画什么：

- 场景退回**「正常」的外观** —— 空白或者半成品的样子，看的人分不清是「还没收到」
  还是「页面坏了」，兜个正常态至少是「一间正常的宿舍」。
- 覆盖层上如实写 **「（还没有收到数据）」** —— 外观可以兜底，话不能乱说。

看板另有一层：切节点时立刻从 `nodes[currentNodeId].latest` 重画，
所以切到一个**已经有数据**的节点会马上显示它最新那条的样子，不必等新报文。
这一点和只留一份「当前状态」的做法差别很大：后者在切过去的瞬间画的还是上一个宿舍。

### `3d/index.html` 上多了什么

- **宿舍选择按钮**（dorm-a / dorm-b / dorm-c）—— 和状态按钮分成两组，
  `data-node` 和 `data-status` 各管各的。
- **一行连接状态**，写的是实际连的地址（`已连接 · ws://localhost:9001`）。
  连错机器时这一行是第一个能看出问题的地方。
- 6-2 的 **4 个手动预览按钮保留**：现场没网、Broker 没起来时全靠它演示。
  手动点出来的状态会在覆盖层末尾加一句「（手动预览）」，收到真数据就自动撤掉 ——
  按钮是不经过 Broker 的，得让人分得清屏幕上这个是演示还是实况。
- mqtt.js **直接引 `../dashboard/lib/mqtt.min.js`**，不再拷一份到 `3d/`。
  两个页面本来就在同一个 http 服务器上，同一个文件引两次浏览器只下一次；
  多存一份的代价是升级时要记得改两个地方。
- `shared/rules.js` **必须是普通 `<script>`**。它是个 IIFE，把 `judgeStatus` 挂在
  `globalThis` 上，没有 `export` —— 在模块里 `import` 它拿到的是 `undefined`，
  一调就炸。所以它排在 `<script type="module">` 之前。

### 看板变成 ES 模块，跟着变了三件事

`dashboard.js` 现在有一行 `import { createDorm3D } from '../3d/scene.js'`，
所以 `index.html` 里必须写成 `<script type="module" src="dashboard.js">`。
**但不是把三个 `<script>` 一律改成模块**，要分开看：

1. **`file://` 直接打开不行了。** 模块走 CORS，必须用 http 服务器
   （`http://localhost:8000/dashboard/`），和 `3d/` 那个页面一样。
2. **`dashboard/` 也要有一张 importmap。** importmap 是**文档级**的，认的是「哪个页面」，
   不是「哪个模块」。`scene.js` 里写的是 `import ... from 'three'`，那个裸名字最终是在
   **`dashboard/index.html`** 这张表里查的 —— 少了它，报错出现在 `scene.js` 里，
   看着像是 `3d/` 那边坏了。映射的是裸名字，所以和目录无关，两张表一个字都不用改。
3. **mqtt.js / Chart.js / `shared/rules.js` 仍是普通 script**，而且都排在模块脚本之前。
   mqtt 和 Chart 是 UMD 包，本来就没有 `export`；`rules.js` 同理。这三个名字在
   `dashboard.js` 里是以**全局变量**的形式用的，模块里 `import` 它们只会拿到 `undefined`。

另外，import 的路径是相对**模块自己**算的：`dashboard.js` 在 `dashboard/` 下，
所以写 `../3d/scene.js`。这一点和 importmap 里的相对路径（相对**页面**）不是一套规则，
两个都容易记混。

### 3D 视图的画幅

嵌进看板时，容器是 `height: 380px` 加一个 `max-width: 760px`。
`max-width` 是为画幅比例：相机在 `scene.js` 里是定死的（位置 + 竖直张角 50°），
容器越扁，房间在画面里占的比例越小 —— 铺满整个面板（约 1000×380）时，
房间只占中间一小块，四周全是空地面。760/380 ≈ 2:1，和 `3d/index.html` 那个 `60vh`
的画幅基本一致，同一个相机在两边看到的构图就一样了。

### 这一步的验证方式

除了跑测试，还做了两件事：

**一、变异测试。** 24 个变异逐个塞回源码，全部被抓住。挑几个有代表性的：

- 去掉 `if (data.nodeId === currentNodeId)`，谁的消息都画
- `status` 直接用报文里的，不用 `judgeStatus` 复核
- 切节点时不看该节点的数据，一律画「正常」
- 手动预览的标记不撤销
- `renderScene` 不挡 `dorm3d` 是 `null`（没有 WebGL 时会炸在这一行）
- importmap 排在模块脚本**之后**、mqtt.js 改成 `type="module"`
- 容器 id 和代码里传的对不上

**二、真浏览器 + 真 Broker。** 用 headless Edge 打开页面，
`--dump-dom` 读回来的覆盖层文字是**真的收到 MQTT 之后**渲染出来的：

```
<div class="scene-label">当前宿舍：dorm-a｜状态：偏冷｜16℃ / 60%</div>
<span id="conn-text">已连接 · ws://localhost:9001</span>
```

同一时刻消息日志里有三条，三个宿舍各一条（dorm-a 偏冷 / dorm-b 偏湿 / dorm-c 正常），
而 3D 那句标签停在 dorm-a 上 —— 这一条就是「按节点筛」在真实环境里的证据。
再用一个临时探针页在 5 秒后点一下 dorm-b 的卡片，标签就换成了
`当前宿舍：dorm-b｜状态：偏湿｜25℃ / 80%`，读数也确实换成了 dorm-b 自己的那份。

### 这一步对测试桩的改动

**`dashboard.js` 变成 ES 模块之后，原来的 vm 跑不动了** ——
`vm.runInContext` 只能喂普通脚本，直接喂会抛
`Cannot use import statement outside a module`。处理办法和 `scene3d.test.js` 改写
`three` 那个标识符是一个思路：把 import 那一行摘掉，改用上下文里同名的打桩函数顶上。

摘之前先数一遍，**必须正好一条**，多一条就报出来 —— 将来谁再加一条 import，
要么被一起悄悄摘掉（测了个假的），要么在这里炸一下。原文件里那行到底怎么写，
另有两条静态断言盯着（正则 + 目标文件真的在）。

`3d/index.html` 那边更进一步：那段脚本是**从 HTML 里抠出来跑的**，
不是另抄一份等价代码，所以「页面上真正在跑的东西」和「测的东西」不可能对不上。
按钮也不是手写一份 `['dorm-a','dorm-b','dorm-c']`，而是用正则从 HTML 里读
`data-node` / `data-status` —— HTML 里少写一个按钮，测试就会红。



## Step 7-1：A1 优先关注

三个宿舍同时在报，**先说哪个**？这一步在看板顶上加一条栏回答这件事：
它从三个节点里挑出最该先看的那个，点一下整页（卡片、趋势图、3D）就切过去。

### 挑人的规则

只有异常节点参加比较，按固定的顺序走，前面分出胜负就不再往下看。
下面是 Step 7-1 当时的三步；**Phase2 起在次数和字典序之间多了「严重度」一步**，
完整规则见下面的「优先关注：四步」：

1. **连续异常时长**，长的优先；
2. 时长一样，比**这一段里的消息条数**，多的优先；
3. 还一样，按 `nodeId` 字典序 —— 这一步不是为了「更准」，是为了**确定**：
   同一份数据永远得到同一个结果，不会因为对象键的遍历顺序变了就换了个人。

```
dorm-b 已连续偏热 7 分钟（2 次），持续时间最长
```

### 时长为什么必须从报文里的 `time` 算

**不读浏览器当前时间**，两端都取 JSON 里的 `time`：`最新一条的 time − 这段第一条的 time`。

现场演示时三台机器的钟不一定对得上；手动录进去的历史数据，`time` 也可能是编的。
用「20:00 到 20:07」算出来永远是 7 分钟，跟什么时候跑的没关系 ——
**测试也才写得成定值**，否则每跑一次结果都不一样，等于没测。

`time` 的解析也是自己手写的（`parseTime`）。`new Date('2026-09-22 20:30:00')`
这种写法**不是标准 ISO 8601**（标准的要 `T`），各家引擎给的结果不一致 ——
Safari 历史上直接给 `Invalid Date`。所以用严格正则拆开，再用 `Date.UTC` 拼：
这样同一串在任何时区都是同一个数，加上两端待遇相同，相减之后时区自动抵消。

### 「这段异常」是怎么算的

每个节点维护两个字段，收到消息就更新：

| 字段 | 含义 |
|---|---|
| `abnormalStart` | **当前这段连续异常**第一条消息的 `time` |
| `abnormalCount` | 这段里已经收到了几条 |

收到正常数据时两个一起清零。规矩只有一条但有个坑：判「正不正常」用的是
**复核之后**的状态，不是报文里那个字符串。报文写着 `"status": "正常"`、
但温湿度按规则算出来是偏热时，**这一段不被打断** —— 不然发错一个字段
就能把「已经连续偏热半小时」的记录抹掉。

只有 `abnormalCount` 一个字段说了算「这段还在不在」。要是再拿
`abnormalStart` 空不空当第二个判据，两个字段一旦对不上（比如 `time` 传了空串），
起点会被后来每条消息顶掉，界面上的时长永远停在「不到 1 分钟」，而且**哪儿都不会报错**。

### 那句话为什么不是一句写死的话

尾巴如实说明**赢在哪一步**：赢在时长就写「持续时间最长」；是靠次数追平的写
「持续时间和 X 一样长，异常次数最多」；三步全平了写「和 X 完全并列，
按节点名顺序排在前面」；只有一个异常节点时写「是目前唯一的异常节点」。

一律写「持续时间最长」是不行的 —— 靠次数赢的那次，那句话就是假话，
而这一栏存在的意义正是让人相信这个排序。比次数时也只跟**时长相同**的那些比：
一个只异常了一分钟却有 99 条消息的节点，次数比谁都多，但它根本没进到比次数这一步，
说它「异常次数最多」同样是假话。

### 两种「挑不出人」不是一回事

`pickPriority` 在两种情况下都返回 `null`：**三个都正常**，和**一条数据都还没收到**。
约定就是这样（「没有要优先处理的」），但**话不能一样**：

```
还没有收到任何节点的数据          ← 刚打开页面 / 刚点完清空
三个节点都正常，没有需要优先处理的宿舍   ← 确实收到过数据，且都不异常
```

页面刚打开、还没连上 broker 的那几秒，那三个节点是**不知道**，不是正常。
一开始两种都写「三个都正常」，是真机上看出来的：刷新页面，顶上立刻挂着一句
「三个节点都正常」，而那时一条数据都还没进来。区分放在画的地方做，
纯函数那边不用多一个返回值。

### 算法单独放一个文件

`dashboard/logic.js` 里只有纯函数（`parseTime` / `fmtDuration` / `abnormalDuration` /
`nextAbnormal` / `pickPriority`），**不碰 DOM、不读全局变量、不调 `Date.now()`**，
用 `export` 导出；`dashboard.js` 那边 `import { pickPriority, nextAbnormal }`。

这么分就是为了能直接测：`tests/logic.test.js` 把它当普通文件加载进来逐个调，
不用起 jsdom，也不用起浏览器。源码里「不许出现 `document` / `window` /
`innerHTML` / 定时器 / `Date.now(`」这几条是**测试里的静态断言**盯着，
改回 `Date.now()` 会当场红。

点击是**事件委托**，挂在 `#priority` 容器上，走的是 `selectNode`
—— 和点对应的那张卡片**完全同一条路**，所以卡片、趋势图、3D 一起切过去。
全正常时那栏是个没有 `data-node` 的 `<p>`，这个判断顺手把它挡掉了。

> **⚠ Step 8-3 起 `#priority` 这个容器没有了**，顶上换成 8-3 那一行（`#focus`）。
> 「挑谁」的算法（`pickPriority`）和「点它 = 切节点」（`selectNode`）都原样留着，
> 只是换了个容器挂委托。这一节其余内容记的是 7-1 当时做的事。

### 真机验过

MQTTX 发场景一（下面那组 6 条），headless Edge 读回 DOM：

```
优先关注  dorm-b 已连续偏热 7 分钟（4 次），持续时间最长        正在查看
<div class="scene-label">当前宿舍：dorm-b｜状态：偏热｜31℃ / 60%</div>
```

点那栏之前 `#detail-node` 还是 `dorm-a`，点完变成 `dorm-b`，
卡片上的「查看中」和 3D 的覆盖层一起跟过去。

#### ⚠ 拿 MQTTX 验这几组时，两个坑

**一、先点「清空」，再发下一组。** 三组场景共用 20:00 这个起点，
不清空的话上一组的段会接着往下算，时长和条数全不对。

**二、broker 上有 retain 的旧数据时，时长会算成 0。**
`simulator/simulator.py` 是带 retain 发的（README 上面那节写了），所以新订阅者一上来就会
**立刻收到三条旧报文**。如果那三条的 `time` 比你要发的场景新（比如是今天刚发的、
而场景用的是 2026-09-22），那么每个节点的这段异常就从今天那条开始 ——
拿 9 月 22 日的时间去减，结果是**负数**，`abnormalDuration` 一律返回 0，
栏上于是三个节点「完全并列」。

验的时候我就是这么栽的：日志里数字都对，栏上却写「三个节点都正常」
或者「三个并列」。清掉 retain 就正常了：

```bash
mosquitto_pub -h localhost -p 1883 -t 'dormmate/v1/nodes/dorm-a/telemetry' -r -n
```

（`-r -n` = 发一条空的 retain，等于把这条 retained 消息删掉。三个节点各来一次。）

顺带一提，这也是「先点清空」有用的另一个原因：清空是页面自己的账，
和 broker 上的 retain 无关，两边都干净了才对得上。

### 三组测试数据（MQTTX 直接发）

都发到 `dormmate/v1/nodes/<nodeId>/telemetry`，**`time` 是决定时长的唯一因素**（不是真实时间），
`status` 必须和规则算出来的一致（不一致只会多一条警告，以规则为准）。

**场景一 · 按时长决出优先**（6 条，预期 `dorm-b`，7 分钟最长）

```json
{"nodeId":"dorm-a","temperature":16,"humidity":60,"status":"偏冷","time":"2026-09-22 20:00:00"}
{"nodeId":"dorm-a","temperature":16,"humidity":60,"status":"偏冷","time":"2026-09-22 20:03:00"}
{"nodeId":"dorm-b","temperature":31,"humidity":60,"status":"偏热","time":"2026-09-22 20:00:00"}
{"nodeId":"dorm-b","temperature":31,"humidity":60,"status":"偏热","time":"2026-09-22 20:07:00"}
{"nodeId":"dorm-c","temperature":25,"humidity":80,"status":"偏湿","time":"2026-09-22 20:00:00"}
{"nodeId":"dorm-c","temperature":25,"humidity":80,"status":"偏湿","time":"2026-09-22 20:05:00"}
```

→ `dorm-b 已连续偏热 7 分钟（2 次），持续时间最长`（三段：3 / 7 / 5 分钟）

**场景二 · 时长相同，按次数决出**（7 条，预期 `dorm-b`，都是 6 分钟但 3 条）

```json
{"nodeId":"dorm-a","temperature":16,"humidity":60,"status":"偏冷","time":"2026-09-22 20:00:00"}
{"nodeId":"dorm-a","temperature":16,"humidity":60,"status":"偏冷","time":"2026-09-22 20:06:00"}
{"nodeId":"dorm-b","temperature":31,"humidity":60,"status":"偏热","time":"2026-09-22 20:00:00"}
{"nodeId":"dorm-b","temperature":31,"humidity":60,"status":"偏热","time":"2026-09-22 20:03:00"}
{"nodeId":"dorm-b","temperature":31,"humidity":60,"status":"偏热","time":"2026-09-22 20:06:00"}
{"nodeId":"dorm-c","temperature":25,"humidity":80,"status":"偏湿","time":"2026-09-22 20:00:00"}
{"nodeId":"dorm-c","temperature":25,"humidity":80,"status":"偏湿","time":"2026-09-22 20:06:00"}
```

→ `dorm-b 已连续偏热 6 分钟（3 次），持续时间和 dorm-a 一样长，异常次数最多`
（注意尾巴没有写「持续时间最长」—— 它没有赢在时长那一步）

**场景三 · 全部正常**（3 条，预期栏里说都正常）

```json
{"nodeId":"dorm-a","temperature":25,"humidity":60,"status":"正常","time":"2026-09-22 20:00:00"}
{"nodeId":"dorm-b","temperature":25,"humidity":60,"status":"正常","time":"2026-09-22 20:00:00"}
{"nodeId":"dorm-c","temperature":25,"humidity":60,"status":"正常","time":"2026-09-22 20:00:00"}
```

→ `pickPriority` 返回 `null`，栏里写「三个节点都正常，没有需要优先处理的宿舍」

这三组不只是文档：`tests/dashboard.test.js` 的 N 段把同一份数据
在 `handleMessage` 上**端到端跑一遍**，逐条比对上面前三句原话。
现场照着发会出现什么，测试里已经先验过了。

### 变异测试

14 个变异逐个塞回源码，确认测试变红，再还原（还原后全套必须仍然是绿的）。
包括：正常数据不清零、每条异常都开新段、先比次数再比时长、定序改用
`localeCompare`、去掉「只挑异常节点」的过滤、次数跟所有人比、时长改用 `Date.now()`、
「算不算异常」从 `latest` 上读、`selectNode` / `clearAll` / 启动时忘了重画那栏、
委托的选择器写错、漏掉 `logic.js` 的 import、漏掉 `nextAbnormal` 的赋值。
**14 个全部被抓住。**

其中两个第一次跑时逃掉了，都补了测试：
`localeCompare` 那条在 `dorm-a/b/c` 上给出的顺序和码元序**碰巧一样**，
所以得挑一对能把两种排法分开的名字（`dorm-B` vs `dorm-a`：码元序 `'B' < 'a'`，
本地化排序反过来）才测得出来；启动时那栏画没画，则是补了一条**页面刚加载那一刻的
快照**——后面各段都会往里灌数据，不先存下来就再也看不到那个状态了。
（另有一个逃掉的是我自己变异写错了，那条赋值是个空操作，不是测试的漏洞。）

## Step 7-2：A2 处理动作

看板能挑出「该先管哪个宿舍」之后，下一步是**真的去管一下**。详情区加了一个
「开启风扇 / 通风」按钮，作用在当前正在查看的那个节点上；按下之后卡片、
详情区那行字、3D 里的风扇**一起动**。

> **这一段说的是页面自己那套账。** Step D3 起这个按钮还会往 `dormmate/v1/cmd`
> 发一条 `handle`，core 那边的事件同时进「处理中」—— 那是**另外一本账**，
> 两边的判据和 ID 都不一样（见「已知限制」和 Step D3 那节）。下面这套行为
> 一个字都没变，只是想按一下按钮时**记得 core 那边也动了**。

### 一句话：三处显示读的是同一份数据

每个节点上多四个字段，全在 `dashboard.js` 顶上的 `nodes` 里，**没有第二份副本**：

| 字段 | 含义 |
|---|---|
| `handling` | `"无"` / `"处理中"` / `"已恢复"` |
| `action` | 做了什么，目前固定是 `"风扇已开启"` |
| `actionTime` | 这个动作**记在哪一条数据上**（那条消息的 `time`） |
| `dataAfterAction` | 动作之后收到的那条记录（没收到就是 `null`） |

卡片上那句「处理中｜风扇已开启」、详情区那行字、3D 里风扇转不转，三处**都从
这四个字段读出来**，谁都不另存一份开关。所以不存在「卡片说处理中、风扇却停着」
这种两边打架的可能 —— 想打架也没有第二个地方可以记。

### `actionTime` 用报文里的 `time`，不用浏览器当前时间

和 7-1 算时长同一个理由（三台机器的钟不一定对得上），外加一条：这样
「动作是在哪条数据之后」在卡片和日志上能一条条对上，不用猜。按下按钮时记的
就是**该节点最新那条消息的 `time`**：

```
处理中｜风扇已开启（记在 2026-09-22 20:05:00 这条数据上） · 还没收到动作之后的数据
```

### 「已恢复」看的是动作之后的最新那条

规则只有一条，所以不需要另写一套判断：

```
动作之后最新那条复核下来是「正常」 -> 已恢复
动作之后最新那条还是异常           -> 留在「处理中」
```

环境再变坏就自动退回「处理中」—— 同一条规则走第二遍而已。两个边界值得写下来：

- **`actionTime` 那一条自己不算数**（要**严格**晚于它）。动作就是记在那条数据上的，
  让它立刻把自己判成「已恢复」是错的。
- 动作之后收到一条**正常**的数据就转「已恢复」；转好之后再来一条更晚的异常数据，
  退回「处理中」；再来一条正常，又变回「已恢复」。三种状态之间没有死路。

「动作之后」用的是**复核之后**的 `status`，所以报文里谎称 `"status":"正常"`
骗不过去 —— 复核只有 `shared/rules.js` 一份，`nextHandling` 只读结果不重新判断。

### 按钮什么时候能按

| 当前节点的情况 | 按钮 | 旁边那行字 |
|---|---|---|
| 一条数据都还没收到 | 禁用 | 还没有收到这个节点的数据 |
| 状态正常 | 禁用 | 当前状态正常，不需要处理 |
| 状态异常 | 可按 | （空） |

「已恢复」的节点状态就是正常的，所以那时候按钮同样是灰的 —— 这两条一致。
没有数据时禁用是因为 `actionTime` 根本没地方取。

### 风扇：动作是**叠在**状态之上的

`3d/scene.js` 里风扇有两个来源，都不是这里新加的：

1. **状态要它转** —— `LOOK` 表里「偏热」是 `fan: true`，`updateScene` 内部
   已经调过一次 `setFanOn` 了（`LOOK` 里只有偏热这一档是 `true`）；
2. **有人按过按钮** —— `handling` 不是 `"无"` 就转，不管现在什么状态。

于是 `renderScene()` 里是这么写的，**位置很讲究**：

```js
if (node.handling !== '无') dorm3d.setFanOn(true);   // 必须在 updateScene 之后
```

**必须在 `updateScene` 之后**：`scene.js` 里写着「后调用的那次为准」，
放在前面会被 `updateScene` 自己那次盖掉。而且这条只在「按过按钮」时才动手，
**绝不写 `setFanOn(handling !== '无')`** —— 那样等于对没处理过的偏热节点喊了一声
`setFanOn(false)`，把 Step 6-2 的行为改坏了：一个偏热的宿舍，只要没人点过按钮，
风扇反而不转了。

「已恢复」之后**照样转**（动作开了就一直开着，只有「清空」才停）。清空时不需要
额外写一句 `setFanOn(false)`：那四个字段一归零，`renderScene` 就不再喊「转」，
而当前节点没有数据会退回「正常」这一档，`updateScene` 自己会把风扇停下。

### 卡片上那行为什么不用状态色

`.card-action` 用的是中性墨色加一道左边的小竖线，**不用**那四个状态色。
状态色是**保留给环境状态**的（那枚 badge 已经用掉了），再拿它标处理进度，
同一张卡片上就有两种东西在抢同一个颜色信号 —— 看着像「处理中」也在报警。
不处理过的节点连这一行都不出现，卡片和 7-1 长得一模一样。

### 点击为什么不进消息日志

日志区的约定是「**一条报文一行**」，`action` 是页面上的一次操作、不是收到的一条
报文。混进去之后日志的行数就和收到报文数对不上了，而那个数字是排查时用来对数
的。要做操作记录应该另起一块，不是往这里塞。

**发出去那条指令也不进**（Step D3 起）—— 同一个理由，而且那次是很实在的：
日志里多一行，`#log-count` 那个数就和「这一轮收到了几条报文」对不上了。
它去的地方是 **Console**（`[DormMate] 发出 MQTT 指令 …`），和收到报文那条
边界同一个做法。`dashboard.test.js` 把这两件事分开钉着：发出去的在 Console
里**必须**有、在消息日志里**必须**没有。

### 真机验过

headless Edge 里用**真实**的 MQTT 报文和**真实**的点击驱动，读回 DOM：

```
按钮 disabled        : true                    ← 一条数据都没有
详情区那行字        : 「还没有收到这个节点的数据」

--- dorm-a 25℃/80% 偏湿（这一档 LOOK 里 fan 是 false）---
按钮 disabled        : false
3D 覆盖层           : 「当前宿舍：dorm-a｜状态：偏湿｜25℃ / 80%」

--- 点「开启风扇 / 通风」---
卡片里那段原文      : <span class="card-action">处理中｜风扇已开启</span>
详情区那行字        : 「处理中｜风扇已开启（记在 2026-09-22 20:05:00 这条数据上） · 还没收到动作之后的数据」

--- dorm-a 25℃/60% 正常（动作之后）---
卡片里那段原文      : <span class="card-action">已恢复｜风扇已开启</span>
详情区那行字        : 「已恢复｜风扇已开启（记在 2026-09-22 20:05:00 这条数据上） · 之后收到 2026-09-22 20:09:00：25℃ / 60% 正常」
按钮 disabled        : true
```

**风扇是真转起来了**，不是只看 DOM 猜的：跑两遍同一个探针，报文序列完全一样
（都是偏湿 → 正常），只有一遍点了按钮。两张截图的像素差**全部**集中在扇叶周围
一个 83×73 的方框里（678 个像素变了），画布其余的 288122 个像素**逐字节相同**。
被测场景特意选**偏湿**而不是偏热 —— 偏热的 `LOOK` 本来就是 `fan: true`，
`updateScene` 自己就会把风扇打开，那种情况下顺序写反了也照样绿。

#### ⚠ 无头模式下的两个坑

**一、`--virtual-time-budget` 的时候 `setTimeout` 烧的是虚拟时间。**
第一版探针用 `sleep(900)` 等报文落地，结果真实世界里可能只过了 0 毫秒，
MQTT 一个来回都没走完就去读结果，读到的全是「还没有收到数据」。

**二、光改成轮询还不够。** 虚拟时钟只在「有网络请求悬着」的时候才暂停，
而 `publish` 是发出去了就不管的，浏览器不认为还有请求在飞 —— 80 轮虚拟 100ms
一眨眼跑完。实测就是同样的脚本 `mode=off` 抢到了、`mode=on` 没抢到，**偶发**。
最后是每一轮轮询再夹一个真实的 HTTP 请求当节拍器（`fetch('/dashboard/index.html')`），
请求悬着 → 虚拟时钟暂停 → 这一轮至少花掉几毫秒真实时间，才稳定下来。
等不到仍然打 `TIMEOUT`，不留一个悄悄读空的坑。

**顺带一提**：截图对比不能整图直接相减。卡片上多了一行字，卡片就高了一点，
**下面所有东西整体下移 33 像素** —— 整图相减的话图表、3D 全都在差，风扇那点
差别淹在里面根本看不出来。所以是先各自量出 3D 画布的矩形，再按「相对画布左上角」
的坐标取同一块来比。

### 变异测试

16 个变异逐个塞回源码，确认测试变红，再还原（还原后全套必须仍然是绿的）。
**15 个被抓住**，1 个是**等价变异体**：

| 变异 | 结果 |
|---|---|
| `ACTION_FAN` 那串字改掉 | ✓ dashboard + logic 同时红 |
| 按下时 `dataAfterAction` 就记成 `latest` | ✓ 两套都红 |
| 「严格晚于」放宽成「不早于」 | ✓ logic 红 |
| 无论正常还是异常都判「已恢复」 | ✓ 两套都红 |
| 去掉「按过按钮才管」那道闸 | ✓ logic 红 |
| 卡片上把 `handling` 和 `action` 写反 | ✓ dashboard 红 |
| 按钮的禁用条件写反 | ✓ dashboard 红 |
| 点完不重画 3D | ✓ dashboard 红 |
| 点完不重画详情区那行字 | ✓ dashboard 红 |
| 切节点时不重画那一行 | ✓ dashboard 红 |
| 清空时不重置那四个字段 | ✓ dashboard 红 |
| 收到新消息时不推进处理状态 | ✓ dashboard 红 |
| `setFanOn` 挪到 `updateScene` 之前 | ✓ dashboard 红 |
| 不管按没按过都去写一次风扇 | ✓ dashboard 红（**第一次逃掉了**，见下） |
| 启动时不画那一行 | ✓ dashboard 红 |
| 去掉 `nextHandling` 里那道 NaN 闸 | ✗ 存活 —— **等价变异体** |

最后那条不是测试的漏洞：函数里唯一的用法是 `if (!(t > at)) return null;`，
而 `NaN` 参与任何比较都是 `false`，`!(false)` 就是 `true` —— 也就是说脏时间
**本来就会**走到 `return null`，那道 NaN 闸去掉与否结果完全一样。它留着是为了
把「脏时间不该当 0 硬算」这件事写在明处：哪天有人把比较方向改成 `t < at`，
这道闸就是唯一还拦得住脏时间的东西。**给它补测试是补不出来的**，因为没有任何
输入能让两个版本给出不同的结果。

表里那条「不管按没按过都去写一次风扇」是这次写变异时才发现测试**真漏了**的。
改成 `setFanOn(node.handling !== '无')` 之后，没处理过的偏热节点会被喊一声
`setFanOn(false)`，风扇**反而不转了** —— 实打实的行为退化，可它第一次**逃掉了**：
当时所有断言都只盯着「按过按钮的节点」，没有一条要求 dashboard **别去碰**
没处理过的节点。补了一条：给当前节点喂一条偏热（`handling` 是「无」），
断言 `setFanOn` 的调用次数**一次都没增加**（转不转交给 `updateScene` 那一档）。
补完之后这个变异当场被抓住 —— 表和上面的数字都是补完之后重跑的。

## Step 7-4：A4 事件记录与导出（第一部分）

节点**从正常进入异常**时开一条事件，恢复时结案。一行就是一段连续异常 ——
不是一条报文。页面下半部多了一个「事件记录」区显示全部事件（结过案的也留着），
旁边一个「导出事件 CSV」。

九列，顺序就是导出的列序（也是 `logic.js` 里 `beginEvent` 返回值的字段顺序，
两处由测试钉死）：

| 列 | 什么时候写 |
|---|---|
| `nodeId` | 开案时 |
| `startTime` | 这段异常是从哪条消息开始的 |
| `problem` | 「连续偏热」这一串，**开案时定死，之后不变**（见下） |
| `priorityTime` | 第一次被选为「优先关注」的那一刻，没有就是 `null` |
| `priorityReason` | 那次选它的原因原话，和页面上那条栏里说的是**同一句** |
| `action` / `actionTime` | 按过风扇之后做了什么、记在哪条数据上 |
| `recoverTime` | 这段结束的那条消息的 `time` |
| `result` | `'已恢复'`，还没结案时是**空串** |

### 事件的生命周期就是「异常段」的生命周期

开案和结案的判据，直接复用 Step 7-1 那套 `abnormalCount` 的 0 → 正翻转，
**没有另立一套判断**。绕开它的代价是：「优先关注栏里说的这段」和「事件里
记的这段」会有两个对不上的起点，而它们说的明明是同一件事。

跟这条一起来的一个结论是：**段里状态从偏热变成偏湿，仍然是同一条事件**。
和 7-1「统计的是连续异常、不是连续偏热」是同一个口径。

### `problem` 为什么开案时定死

它是这条事件的**名字**，在复盘的时间线里就摆在 `startTime` 旁边，说的是
「这件事是从什么开始的」。跟着最新状态改的话，一段从偏热恶化成偏湿的经历，
事后看起来像是从头就偏湿的 —— 那是另一件事了。恶化这件事本身在别处看得到
（卡片上的当前状态、趋势图），不必挤进这个名字里。

### `events` 里存的是对象本身，不是副本

`nodes[id].event` 和 `events` 里的那一条**是同一个对象**。所以更新只能就地改：

```js
Object.assign(node.event, markAction(...));   // 对
node.event = { ...node.event, action: x };    // 错
```

写成第二种的话，`events` 里那条永远停在旧值上。**页面上一点异常都看不出来**
（表格本来就是从 `events` 画的，画出来的是同样旧的值），只有导出的 CSV 里
那几列是空的。测试里专门有一条 `nodes['dorm-b'].event === events[0]` 钉住这点。

同理，清空用的是 `events.length = 0` 而不是 `events = []` —— 整个换掉的话，
已经有引用的地方就指向一个被丢弃的数组了。

### 「只记第一次」

`priorityTime` / `priorityReason` 和 `action` / `actionTime` 都是**只记第一次**。
复盘要回答的是「这个宿舍是什么时候被注意到的、当时因为什么」「这件事第一次
被动手是什么时候、做了什么」，不是「最后一次看它时长什么样」。后者在页面顶上
那条栏里一直是最新的，不必再在台账里存一份。

### 记的是胜出者**自己**的时刻

```js
markPriority(won.event, won.latest.time, pick.reason);   // 对
markPriority(won.event, record.time,     pick.reason);   // 错
```

`handleMessage` 每次只算一遍 `pickPriority`，算完喂给「画那条栏」和「记事件」
两处 —— 两处显示的必须是同一句话，算两遍不只是白算，两份还可能对不上。

时间一定要取**胜出者自己**最新那条的 `time`。触发这一轮的报文很可能是**另一个
节点**的：dorm-a 恢复正常那一条，触发的是 dorm-a 的报文，可胜出的是还异常着的
dorm-b。用 `record.time` 就是把 dorm-a 的时间记在了 dorm-b 头上。测试里专门
构造了这个局面（dorm-a 20:00 起异常 20 分钟压着 dorm-b，20:30 恢复 → dorm-b
上位，记的必须是它自己的 20:05 而不是那条报文的 20:30）。

### CSV 的几个约定

- **UTF-8 BOM 必须带**，而且写成转义 `'\uFEFF'`，不写成字面量字符 ——
  否则源码里是一段隐形字符，看起来像个空字符串。少了 BOM，Excel/WPS 会按本地
  代码页解析，`problem` 和 `result` 里的中文就是乱码。这不是纸上谈兵：改这个
  功能的过程里手滑导过一份没带 BOM 的，打开就是 `2026/9/29 13:36,20,60,????`。
- **CRLF 换行，末尾也留一个**（Excel / WPS 对 LF 的兼容性不如 CRLF）。
- **`null` 一律写成空**。`String(null)` 会写出四个字母的 `null`：Excel 里看着
  像真存了一个叫 `null` 的值，Python 那边也判不出「这条还没结束」。
- 半角逗号和双引号按 RFC 4180 转义。真跑起来触发不了（原因里用的是全角「，」），
  但这份文件要喂给 `analysis/analysis.py`，格式错一点那边就解析歪了。
- 行序和屏幕上一致（**最新在前**）。复盘要按时间正着看是 Python 侧自己排的事，
  不靠导出把顺序改掉。

### 导出按钮有两处细节

```js
document.body.appendChild(a); a.click(); document.body.removeChild(a);
setTimeout(() => URL.revokeObjectURL(url), 1000);
```

`<a>` 要**先插进文档再点** —— Firefox 里不插进文档的 `<a>` 点了没反应。
objectURL **不能点完立刻 revoke**：部分浏览器会在下载真正开始前就把 blob 释放掉，
表现出来就是「点了没反应」。留 1 秒再回收。

一条事件都没有时按钮是 `disabled` 的：不然点了会得到一个只有表头的空 CSV，
拿到的人会以为导出坏了。

### 这一步对测试桩的改动

`tests/dashboard.test.js` 的假 DOM 补了 `Blob` / `URL` / `document.createElement` /
`setTimeout` —— 不补的话点导出按钮就是 `ReferenceError`，而「导出的字节到底对不对」
正是这一步最该测的东西。`setTimeout` 是**只记不执行**的：立刻执行就把「隔了一会儿
才 revoke」这个行为测没了，测试自己挑时候触发。

另外那条摘 `import` 的正则跟着改了。`LOGIC_IMPORT` 原来写的是「一行放得下四个名字」
的形状，7-4 加到八个之后源码折成了两行，正则匹配不上 → `import` 没被摘掉 →
`vm` 直接抛 `Cannot use import statement outside a module`。**这是改 import 时漏改的**，
不是新功能的问题：`logic.test.js` 当时是全绿的，红的只有 `dashboard.test.js`。
修法是把分隔符一律写成 `\s`（能匹配换行），不是把正则放宽到「差不多就行」。

### 变异测试

28 个变异逐个塞回源码，确认测试变红，再还原（还原后全套必须仍然是绿的）。
**28 个全部被抓住**，没有存活，没有等价变异体。挑几个说明这一步真正钉住了什么：

| 变异 | 结果 |
|---|---|
| 去掉「正常就不开案」的守卫 | ✓ logic 红（会造出「连续正常」） |
| `problem` 写死成「连续偏热」 | ✓ logic 红 |
| `problem` 改成不拼「连续」 | ✓ logic 红 |
| `startTime` 改用浏览器当前时间 | ✓ logic 红 |
| `result` 初始化成 `null` 而不是空串 | ✓ logic 红 |
| `markPriority` / `markAction` / `closeEvent` 去掉「只记第一次」 | ✓ 三个各自红 |
| `markPriority` 的 `reason` 直接 `String()` | ✓ logic 红（`null` 会变成 `"null"`） |
| `closeEvent` 的 `result` 写成空串 | ✓ logic 红 |
| 每条异常消息都重开一条事件 | ✓ dashboard 红 |
| 新事件 `push` 到表尾（顺序反了） | ✓ dashboard 红 |
| `node.event` 存副本而不是同一个引用 | ✓ dashboard 红 |
| **优先关注的时间用触发报文的 `time`** | ✓ dashboard 红 |
| 结案时不清 `node.event` | ✓ dashboard 红 |
| 点风扇时不把动作写进事件 | ✓ dashboard 红 |
| 清空时不清 `events` | ✓ dashboard 红 |
| 一条事件都没有时不置灰按钮 | ✓ dashboard 红 |
| 渲染时不判空（空状态没有提示行） | ✓ dashboard 红 |
| `csvCell` 不转义半角逗号 | ✓ dashboard 红 |
| CSV 里的 `null` 不转成空 | ✓ dashboard 红 |
| CSV 用 LF 换行、末尾不留 CRLF | ✓ dashboard 红 |
| 导出的 CSV 不带 BOM | ✓ dashboard 红 |
| 导出后立刻 `revoke` | ✓ dashboard 红 |
| `<a>` 不插进 body 直接点 | ✓ dashboard 红 |

**一次「我以为是实现错了、其实是测试写错了」**：P 段第一次跑是 5 条红。
逐条查下来全在测试这边 —— 数行数的正则写的是 `/ev-result/g`，而同一个 `span` 上的
`ev-result--open` / `ev-result--done` 里也含 `ev-result`，一行被数成两行；另外两条是
我把 `events[2]` 当成了旧的 dorm-b（实际那是 dorm-a 那条），又忘了 dorm-a 早在
20:30 就恢复了。实现一处没改。**这五条一个都不是「断言太松所以没抓住 bug」，
是断言写错了方向**，所以修的是断言，不是放宽期望值。

## Step 8-1：B1 当前总览 + B2 判断依据

看板顶部多了两句人话，就在「优先关注」栏下面、三张卡片上面：

```
当前总览
当前 3 个宿舍中，1 个正常，2 个需要关注；dorm-b 已持续偏热 20 分钟，是当前重点；dorm-c 出现偏湿。

判断依据
优先关注 dorm-b：已连续偏热 20 分钟（2 次），持续时间最长；dorm-c 虽然偏湿，但只持续 5 分钟；dorm-a 当前正常。
```

> **⚠ Step 8-3 起看板顶部不再渲染这两块。** 顶上只剩一行「当前重点」
> （谁 / 在不在处理 / 温度往哪走），点它可以切节点。`buildOverview` / `buildReasons`
> 这两个函数**没有删**、测试也还在，它们的去处是 `report.html` 那个出口。
> 这一节的其余内容记的是 8-1 当时做的事，读的时候把这个前提带上。

两句都由 `dashboard/logic.js` 现算，**每收到一条报文重算一次**，一个字都不缓存。
节点名、状态、宿舍数、时长全是算出来的 —— 换成四个宿舍、换成 `north-1` 这种
名字、把 `dorm-b` 改成正常，同一个函数说的还是实话。

### 「谁是重点」只有一份实现

`ranked()` 是这一步新抽出来的：它把当前在异常中的节点按那三步（时长 → 次数 →
nodeId）排好序交给调用方（Phase2 起多了「严重度」那一步，见上）。`pickPriority`、`buildOverview`、`buildReasons`
三处都用它。

各写一份的话，「谁是重点」就有了三个出处 —— 而且**三份都「看着挺对」**，
对不上的时候没有任何地方会报错，只是页面上两句话指着不同的宿舍。
测试里专门拿七组数据逐一验证「总览点的重点 === 优先关注栏说的那个」。

同理，`basisFor()` 是「赢在哪一步」的唯一一份说法，顶上那条栏和 B2 依据
都从它出。栏里是 `dorm-b 已连续偏热 20 分钟（2 次），持续时间最长`，
B2 里是 `优先关注 dorm-b：已连续偏热 20 分钟（2 次），持续时间最长` ——
去掉开头那个节点名之后**逐字相同**（这一条也是测出来的）。

`basisFor` 之前是私有的，而且和 `reasonFor` 是同一个函数。这一步把它拆成
`basisFor`（不带节点名）+ `reasonFor`（拼上节点名），两个仍然都不导出 ——
导出的话页面那边就能自己拼一句「持续时间最长」，页面上两处说法迟早会不一样。

### 「还没有收到数据」不等于「正常」

和 7-1 那条栏是同一个口径：页面刚打开、还没连上 broker 的那几秒，
那三个节点是**不知道**，不是正常。

所以计数是三档而不是两档，而且**为 0 的那一档不写出来**：

| 情况 | 总览说的 |
|---|---|
| 一条数据都没有 | `还没有收到任何节点的数据。` |
| 三个都正常 | `当前 3 个宿舍都正常。` |
| 两个正常、一个没数据 | `当前 3 个宿舍中，2 个正常，另有 1 个还没有收到数据。` |
| 一个正常、一个异常、一个没数据 | `当前 3 个宿舍中，1 个正常，1 个需要关注，另有 1 个还没有收到数据；…` |
| 三个都不正常 | `当前 3 个宿舍中，3 个需要关注；…`（不写「0 个正常」） |

三个数字（正常 / 需要关注 / 没数据）加起来正好是宿舍数 —— 挪走一个都会让
这句话自相矛盾。而「0 个正常」这种写法又长又没信息，所以不写。

计数按 `latest.status` 数，不按 `abnormalCount > 0` 数。两处口径本来应当一致
（由 7-1 那条等价不变量钉住），但「需要关注」这四个字是对着**卡片上那个状态
徽章**说的，所以分母就用徽章读的那个字段 —— 看的人一抬头就能对上，
不用先知道还有另一套计数。

### 处理状态只是报出来，不参与排序

按过风扇的节点会在句子后面多一个括号：

```
…dorm-b 已持续偏热 20 分钟，是当前重点（风扇已开启，处理中）；dorm-c 出现偏湿。
```

**这个括号不影响排序** —— `pickPriority` 连 `handling` 这个字段都不读。
写成「虽然已经开了风扇，但还是先管 dorm-b」那种因果句就是在编：真要按
「有没有人管」排，那是另一套规则，得先定下来。测试里用同一份数据（只差
`handling`）验证「按不按风扇，谁是重点、因为什么，一字不变」。

状态已经正常的节点不带这个括号 —— 那说明风扇是按在旧数据上的，之后来的
那条正常数据比动作还早（见 `nextHandling` 的时间判断），此时「处理中」
没有任何意义。

### B2 的对比必须如实说输在哪一步

和 7-1 那条栏的尾巴同一条原则。挨个字比过去，**该第几步倒下就写第几步**：

| 那个节点输在哪 | B2 里写的 |
|---|---|
| 时长更短 | `虽然偏湿，但只持续 5 分钟` |
| 时长打平，次数更少 | `也偏冷，持续时间和它一样长，但只有 2 条异常数据` |
| 完全并列，按名字定序 | `也偏热，时长和次数都跟它一样，按节点名顺序排在后面` |

一律写「但只持续 X 分钟」是错的 —— 时长打平、靠次数赢的那一轮，那个节点
根本没有「只持续」这回事，这么写会让看的人以为排序是乱的。

### 为什么总览只报不比较

四段结构：**有多少 / 谁最要紧 / 还有谁不正常**。除了重点之外的异常节点
只报「谁还异常、异常成什么样」（`dorm-c 出现偏湿`），为什么先不它们是 B2 的事。

两句都做对比的话，摆在一起读就是车轱辘话。

「还有谁异常」按**严重程度**排，不是按 `nodes` 的键顺序。这一条是靠变异测试
补出来的：原来的测试里 `dorm-a/b/c` 恰好和严重程度同序，把实现改成按键顺序
遍历**照样全绿**，于是专门造了一组「最严重的放在中间」的数据（`dorm-a` 只异常
5 分钟、`dorm-b` 异常 30 分钟、`dorm-c` 异常 20 分钟），两者才分得开。

### 用 textContent，不用 innerHTML

这两句里夹着节点名，而节点名是从 topic / 报文里读来的，不是我们写的常量。
走 `innerHTML` 的话，哪天混进一个 `<` 就把版面撕了。测试用的假 DOM 把
`textContent` 和 `innerHTML` 分开记，所以走错路这里会红。

### 按风扇之后要当场重画

B1 里会报出「（风扇已开启，处理中）」，所以风扇那个回调里也得调一次
`renderInsight()`。漏掉的话，那句状态要等到**下一条报文进来**才出现 ——
中间那段时间卡片上写着「处理中｜风扇已开启」、上面的总览里却什么都没有，
看的人会以为按钮没生效。这一条也是变异测试盯出来的。

### 这一步的验证方式

```bash
node tests/logic.test.js        # 226 条
node tests/dashboard.test.js    # 379 条
```

另外给了三组可以直接用 MQTTX 发的数据，见下面「三组验证数据」。

### 三组验证数据

三组都用 `2026-09-22` 这一天。**按表里的顺序发**（`latest` 取的是最后到的那条，
顺序反了时长就不一样了）。topic 一律 `dormmate/v1/nodes/<nodeId>/telemetry`，TCP 1883。

> 想从头看一遍就先按页面上的「清空」。

**组 1｜三个都正常** —— 验「都正常」那句，而且**不许出现「是当前重点」**

| 顺序 | topic | payload |
|---|---|---|
| 1 | `dormmate/v1/nodes/dorm-a/telemetry` | `{"nodeId":"dorm-a","temperature":25,"humidity":60,"status":"正常","time":"2026-09-22 20:00:00"}` |
| 2 | `dormmate/v1/nodes/dorm-b/telemetry` | `{"nodeId":"dorm-b","temperature":25,"humidity":60,"status":"正常","time":"2026-09-22 20:00:00"}` |
| 3 | `dormmate/v1/nodes/dorm-c/telemetry` | `{"nodeId":"dorm-c","temperature":25,"humidity":60,"status":"正常","time":"2026-09-22 20:00:00"}` |

```
当前总览  当前 3 个宿舍都正常。
判断依据  当前 3 个宿舍都正常，没有要优先处理的宿舍。
```

**组 2｜一个异常、两个正常** —— 验「目前唯一的异常节点」那句，不用比

| 顺序 | topic | payload |
|---|---|---|
| 1 | `dormmate/v1/nodes/dorm-a/telemetry` | `{"nodeId":"dorm-a","temperature":25,"humidity":60,"status":"正常","time":"2026-09-22 20:00:00"}` |
| 2 | `dormmate/v1/nodes/dorm-c/telemetry` | `{"nodeId":"dorm-c","temperature":25,"humidity":60,"status":"正常","time":"2026-09-22 20:00:00"}` |
| 3 | `dormmate/v1/nodes/dorm-b/telemetry` | `{"nodeId":"dorm-b","temperature":31,"humidity":60,"status":"偏热","time":"2026-09-22 20:00:00"}` |
| 4 | `dormmate/v1/nodes/dorm-b/telemetry` | `{"nodeId":"dorm-b","temperature":33,"humidity":60,"status":"偏热","time":"2026-09-22 20:20:00"}` |

```
当前总览  当前 3 个宿舍中，2 个正常，1 个需要关注；dorm-b 已持续偏热 20 分钟，是当前重点。
判断依据  优先关注 dorm-b：已连续偏热 20 分钟（2 次），是目前唯一的异常节点；dorm-a 当前正常；dorm-c 当前正常。
```

**发到第 3 条时先看一眼**：这时候 dorm-b 刚开段，两句里写的是「不到 1 分钟」。
第 4 条一发下去，时长**当场**变成 20 分钟 —— 这一步就是为了让人看见这两句
是每条报文都重算的，不是启动时算一次就挂在那儿。

**组 3｜两个异常，靠时长决出** —— 也就是需求里给的那两句

| 顺序 | topic | payload |
|---|---|---|
| 1 | `dormmate/v1/nodes/dorm-a/telemetry` | `{"nodeId":"dorm-a","temperature":25,"humidity":60,"status":"正常","time":"2026-09-22 20:00:00"}` |
| 2 | `dormmate/v1/nodes/dorm-b/telemetry` | `{"nodeId":"dorm-b","temperature":31,"humidity":60,"status":"偏热","time":"2026-09-22 20:00:00"}` |
| 3 | `dormmate/v1/nodes/dorm-c/telemetry` | `{"nodeId":"dorm-c","temperature":25,"humidity":80,"status":"偏湿","time":"2026-09-22 20:15:00"}` |
| 4 | `dormmate/v1/nodes/dorm-b/telemetry` | `{"nodeId":"dorm-b","temperature":33,"humidity":60,"status":"偏热","time":"2026-09-22 20:20:00"}` |
| 5 | `dormmate/v1/nodes/dorm-c/telemetry` | `{"nodeId":"dorm-c","temperature":26,"humidity":82,"status":"偏湿","time":"2026-09-22 20:20:00"}` |

```
当前总览  当前 3 个宿舍中，1 个正常，2 个需要关注；dorm-b 已持续偏热 20 分钟，是当前重点；dorm-c 出现偏湿。
判断依据  优先关注 dorm-b：已连续偏热 20 分钟（2 次），持续时间最长；dorm-c 虽然偏湿，但只持续 5 分钟；dorm-a 当前正常。
```

发完再点一下 dorm-b 那张卡片，按「开启风扇 / 通风」，两句当场变成：

```
当前总览  …dorm-b 已持续偏热 20 分钟，是当前重点（风扇已开启，处理中）；dorm-c 出现偏湿。
判断依据  优先关注 dorm-b：已连续偏热 20 分钟（2 次），持续时间最长（风扇已开启，处理中）；…
```

**想再看「时长打平靠次数赢」和「完全并列」**，把组 3 改一处就行：

- **靠次数赢**：把 dorm-c 第 3 条的 `time` 改成 `20:00:00`（和 dorm-b 同时开段），
  再给 dorm-b 中间补一条 `"time":"2026-09-22 20:10:00"` 的。这样两个都异常了
  20 分钟，但 dorm-b 有 3 条、dorm-c 只有 2 条：

  ```
  判断依据  优先关注 dorm-b：已连续偏热 20 分钟（3 次），持续时间和 dorm-c 一样长，异常次数最多；dorm-c 也偏湿，持续时间和它一样长，但只有 2 条异常数据；dorm-a 当前正常。
  ```

  **不写「持续时间最长」** —— 它没有赢在时长那一步，写了就是假话。

- **完全并列**：只把 dorm-c 第 3 条的 `time` 改成 `20:00:00`（不再补那条 20:10），
  两个节点的时刻和条数就都一样了：

  ```
  判断依据  优先关注 dorm-b：已连续偏热 20 分钟（2 次），和 dorm-c 完全并列，按节点名顺序排在前面；dorm-c 也偏湿，时长和次数都跟它一样，按节点名顺序排在后面；dorm-a 当前正常。
  ```

  排在前面的永远是 `dorm-b` —— 定序用的是固定的码元序，不跟着运行环境的
  区域设置走（用 `localeCompare` 的话，同一份数据在不同机器上可能排出不同结果）。

### 变异测试

34 个变异逐个塞回源码，确认测试变红，再还原（还原后全套必须仍然是绿的）。
**32 个被抓住**，2 个是**等价变异体**（改了也测不出来，理由见下）：

| 变异 | 结果 |
|---|---|
| `ranked` 不再只看异常节点（正常节点也进池子） | ✓ logic 红 |
| `ranked` 的时长排序反向 | ✓ logic 红 |
| `ranked` 去掉 nodeId 定序那一步（四步里的最后一步） | ✓ logic 红 |
| `ranked` 改用 `localeCompare` | ✓ logic 红 |
| `basisFor` 去掉「只有一个异常节点」那条守卫 | ✓ logic 红 |
| `basisFor` 的尾巴一律写「持续时间最长」 | ✓ logic 红 |
| `reasonFor` 不再拼开头的节点名 | ✓ logic 红 |
| `survey` 的「正常」判据写反 | ✓ logic 红 |
| `survey` 把没收到数据的也算进「有数据」 | ✓ logic 红 |
| `handlingNote` 认错处理状态 | ✓ logic 红 |
| `lostTo` 的时长比较用 `<=` | ✓ logic 红 |
| `lostTo` 一律写「只持续 X 分钟」 | ✓ logic 红 |
| `buildOverview` 不区分「没收到数据」和「正常」 | ✓ logic 红 |
| `buildOverview` 没数据的当正常（分母少算） | ✓ logic 红 |
| `buildOverview` 有节点没数据时也说「都正常」 | ✓ logic 红 |
| `buildOverview` 把「0 个正常」也写出来 | ✓ logic 红 |
| `buildOverview` 不写「另有 N 个没收到数据」 | ✓ logic 红 |
| `buildOverview` 的重点取最后一个（最不要紧的） | ✓ logic 红 |
| **`buildOverview` 的「还有谁异常」按键顺序，不按严重程度** | ✓ logic 红（**补了测试才抓住**） |
| `buildOverview` 结尾用逗号 | ✓ logic 红 |
| `buildReasons` 不区分「没收到数据」和「正常」 | ✓ logic 红 |
| `buildReasons` 自己拼一句，没复用 `basisFor` | ✓ logic 红 |
| `buildReasons` 忘了标记重点（重点说两遍） | ✓ logic 红 |
| `buildReasons` 把没数据的说成「当前正常」 | ✓ logic 红 |
| `buildReasons` 拿正常的节点去跟重点比 | ✓ logic 红 |
| `buildReasons` 结尾用逗号 | ✓ logic 红 |
| `handleMessage` 里不重画总览 | ✓ dashboard 红 |
| 清空时不重画总览 | ✓ dashboard 红 |
| **按风扇之后不重画总览** | ✓ dashboard 红 |
| 启动时不画总览 | ✓ dashboard 红 |
| `renderInsight` 走 `innerHTML` | ✓ dashboard 红 |
| `renderInsight` 把两句对调 | ✓ dashboard 红 |
| `basisFor` 比次数时跟**所有人**比，而不是只跟时长相同的那些 | **等价变异体** |
| `handlingNote` 去掉「状态已经正常就不写」那条守卫 | **等价变异体** |

**两个等价变异体，都验过为什么等价**

1. **`basisFor` 里 `tied[0]` 换成 `others[0]`。** 走到那一行时两者恒等：
   `others` 按「时长降序、次数降序」排过，所以 `others[0]` 的时长是所有
   落后者里最长的。如果它比重点短，那 `tied` 就是空的，上面那行已经
   `return` 掉了；能走到这一行，说明 `others[0]` 的时长正好等于重点的，
   于是它就在 `tied` 里，而且是 `tied` 的第一个。**结论：改不掉**。
   代码里仍然写 `tied` —— 它把「只跟时长相同的那些比次数」这条规则写在了
   明面上，而 `others[0]` 那个写法得靠排序不变式才成立。

2. **`handlingNote` 去掉「状态已经正常就不写」那条守卫。** 这个函数目前只在
   `buildOverview` / `buildReasons` 里被调，而传进去的都是 `ranked()` 挑出来的
   节点（`abnormalCount > 0`）。页面上这两个字段是 `nextAbnormal` 一起维护的，
   `abnormalCount > 0` 和 `latest.status !== '正常'` 恒等价（7-1 那条不变量），
   所以**跑起来的页面上这个守卫到不了**。手动构造一份两个字段打架的数据确实
   能区分，但那样断言的就是一句自相矛盾的话（「dorm-a 已持续正常 20 分钟」），
   钉住它只会让这套测试更难读。守卫留着是因为它是一句领域陈述
   （「处理中」只在异常时有意义），纯函数不该假设调用方一定守住了跨模块的不变量。

**一次「变异写错了」。** 第 31 条第一次跑出来是 SURVIVED，查下来是变异本身
没生效：那条 `from` 只覆盖到了注释的开头，`renderInsight();` 那行原封不动
留在原地 —— 改的是一句注释。换成用 `renderInsight();\n});` 当锚点（整个文件
里只有风扇回调这一处是这个形状）之后一测就红了。**这类"假存活"比真存活更
值得警惕**：它看起来是一条漏网之鱼，实际上什么都没验证。

## Step 8-2：B3 今日摘要（Python 生成）

看板的 B1 / B2 说的都是**现在** —— 那一段还没结束，说「已持续 20 分钟」。
这一步回答的是另一个问题：**这一天到底发生过哪几段、后来好没好。**

```bash
py -3.14 analysis/make_sim_data.py            # 先造一份一天的数据
py -3.14 analysis/analysis.py data/day_sim.csv   # 再生成带「今日摘要」的报告
```

`report/report.html` 里多出来的那一块长这样：

```
今日摘要
数据来源：模拟日数据（source 列全是「模拟」，不是现场采集的真数据）

dorm-a 全天整体正常；dorm-b 14:10 起持续偏热 40 分钟后恢复；
dorm-c 21:30 出现偏湿，目前仍未恢复。今日共 2 次需要关注的环境事件。

宿舍     开始                  结束                  持续（分钟）  异常类型  结果
dorm-b  2026-09-22 14:10:00  2026-09-22 14:50:00   40           偏热      已恢复
dorm-c  2026-09-22 21:30:00  2026-09-22 23:55:00  145           偏湿      仍未恢复
```

那句话里的宿舍名、时刻、状态、时长、事件总数**一个都不写死**，全是算出来的。

三个文件各管一段：

| 文件 | 干什么 |
|---|---|
| `analysis/make_sim_data.py` | 造数据：按一天的时间轴把采样点摆出来，不连网、不等时间 |
| `analysis/daily_summary.py` | 找「连续异常段」，把它们说成人话 |
| `analysis/analysis.py` | 通过 `sections` 把这一块塞进 `report.html`，并注明数据来源 |

`daily_summary.py` 也能单独跑，不进报告：

```bash
py -3.14 analysis/daily_summary.py                  # 默认 data/day_sim.csv
py -3.14 analysis/daily_summary.py data/dormmate.csv
```

### 为什么要先造一份数据

`data/dormmate.csv` 是网页上「点一下、发一条」攒出来的，时间戳全挤在几秒里。
拿它算「持续了多少分钟」，答案是「0 分钟」—— 不是算错了，是这份数据里
**根本没有「持续」这回事**。要看「14:10 起持续偏热 40 分钟后恢复」这句话写得对不对，
得先有一份像样的一天数据。

`simulator/simulator.py` 是往 MQTT 上实时发的，真要跑满一天也不现实。所以
`make_sim_data.py` 不连网，直接照着时间轴把采样点摆出来：三个节点各 288 点
（每 5 分钟一个），**按（时间, 节点名）交错排序**成一份 864 行的 CSV。

> **⚠ Step 9-1 起，同一个脚本还多写两份文件**（`dorm-a_history_sim.csv`、
> `new_samples.csv`，都跟 `--out` 走）。这一节说的 `day_sim.csv` 一个字节都没变，
> 多出来的两份见「Step 9-1」那一节。

按时间交错而不是「一个节点写完再写下一个」，是因为真实的多节点导出就是三个宿舍的
消息混在一起按时序落下来的。交错排之后，`daily_summary` 那边**必须真的按节点分组**
才算得对 —— 分组写漏了，摘要立刻会变成三个节点互相打断的一团。

| 决定 | 为什么 |
|---|---|
| 采样间隔 **5 分钟** | 事件时长要能被间隔整除才数得准。「40 分钟」= 14:10 到 14:50 共 9 个采样点，首尾正好差 40 分钟。间隔取 60 的话，40 这种时长根本落不到点上 |
| 默认种子 **2350** | 挑出来的，不是随手写的：它让默认这份数据正好落在需求里那两句例子的时刻上（`dorm-b` 14:10、`dorm-c` 21:30），把摘要和例子并排一放就知道实现没跑偏 |
| 随机种子用 `random.Random(f"dormmate-day-{seed}-{node_id}")` | 字符串种子内部走 sha512，**跨进程、跨机器都稳定**。换成 `hash(node_id)` 就完了 —— 字符串哈希每个进程都不一样（`PYTHONHASHSEED`），同一份参数跑两次能出两份数据。这一条是单独验证过的，见下面「变异测试」最后一段 |
| 正常段取 22~25 ℃ / 52~64 %，偏热段 31~33 ℃，偏湿段 78~86 % | **离三条阈值（18 / 30 / 75）都留着距离**，抖动不会把一条正常数据甩到异常那边去。围着阈值抖的话会抖出几个 29.8 / 74.6 的正常点，一段连续的异常被切成好几段，「持续 40 分钟」直接散架。左边那句话也就时真时假，「换种子摘要变不变」变成看运气 |
| 偏湿段温度压到 26 ℃ 以下 | 温度一过 30 就先判偏热了（统一规则是按顺序判、前面命中就不再往下看），这个事件就不再是「偏湿」 |
| 偏湿段一直铺到这一天结束 | 没有结束时刻 —— 摘要里那句「目前仍未恢复」就是打这儿来的 |
| 事件开始时刻**往后**对齐到采样点 | 开始时刻不落在点上，第一条异常数据就会晚于它，「14:10 起」和 CSV 里最早那条异常数据对不上 |
| 「40 分钟」的窗口**两端都算在内** | `hot = (第一个异常采样点, 最后一个异常采样点)`。写成左闭右开的话最后一个异常点是 14:25，实际只有 35 分钟 |
| 不管有没有事件，每个采样点都照抽 2 个随机数 | 不然事件窗口一变，后面的随机数全错位，改一个参数等于把整份数据搅乱，没法解释「到底换了什么导致摘要变了」。`--hot-start` 也是**先照常抽一个再决定用哪个**，消耗的随机数个数一样 |
| 输出 BOM + CRLF，只写 CRLF 不写裸 LF | 和网页「导出 CSV」那份一致，`analysis.load()` 用 `utf-8-sig` 读它，读文件的代码就只有一条路要走 |

### 「连续异常段」和看板是同一套定义

这是这一块最要紧的一条。看板的 `nextAbnormal`（7-1）已经定义了什么叫「连续异常」，
这里**不能另立一套**：

| 规则 | 两边一致的做法 |
|---|---|
| 怎么开一段 | 一条**不是「正常」**的数据开一段 |
| 段里再来异常数据 | 只是延长它，**起点不动** |
| 什么时候算结束 | 来一条**正常**数据 |
| 「持续」怎么算 | 这一段里**最后一条**异常数据的时间 − **第一条**异常数据的时间。和看板「已持续 X 分钟」是同一个口径 |
| 段里换了状态类型（偏热 → 偏湿） | **不改口**，仍然算同一段，说的还是**开段时**那个类型。看板 7-4 记事件时也是这么定的（`problem` 保持开案时那个） |
| 到文件读完还开着的段 | 那就是没恢复。看板那边是 `abnormalCount` 还没归零 |

不统一的话，同一份数据在报告里是「14:10 起持续偏热 40 分钟」，在卡片上是
「已持续 35 分钟」，两个数都「看着挺对」，没有任何地方会报错。

「段里换类型不改口」和「不排序保护」这两条都是**故意**的，各有一条测试专门钉住
（`test_段里换状态类型不改口`、`test_没有正常数据隔开就仍是一段`）—— 排序那条是
跟「报文没有乱序保护」（见「已知限制」）同一个口径：数据源只有一个，乱序多半是人为的，
看得见反而好排查。真要做就得先定下「以 `time` 为准还是以到达顺序为准」，这一步不定。

### 「目前仍未恢复」是什么意思

「目前」指的是**这份数据记到的最后一刻**。一整天的文件里就是「到这一天结束」——
`dorm-c` 21:30 开始偏湿，数据到 23:55 结束，所以到结束都没恢复。

措辞和工作台上那句保持一致。**不是**「现在（此刻）还没恢复」—— 这份 CSV 是
昨天的一天数据，跟此刻没有关系。

### 「没有数据」≠「正常」

和 B1 那条是同一条原则，换个尺度再讲一遍。

一个节点这一天**一条数据都没有**，它根本不在 `nodes` 里，于是**一个字都不提它**。
不会被说成「全天整体正常」—— 那是「不知道」，不是「正常」。

`render_daily_summary` 的 `node_ids` 参数要单独传进来就是为了这件事：一个节点可能
**一个事件都没有**（它在 `events` 里根本不出现），不传就漏了它的「全天整体正常」；
或者更糟，为了不漏它而放宽条件，把「没有数据」的也说成了正常。

一个节点都没有数据时，整句话退成 `这一天没有收到任何节点的数据。`

### 计数和说法必须对得上

`dorm-a 全天整体正常；…今日共 2 次需要关注的环境事件。` —— 这里有两个数：
句子提到了几个节点、总数报了几次事件。

万一 `events` 里冒出一个 `node_ids` 没提到的节点（比如上游传进来的两组数据对不上），
就会出现「总数算了它一笔，句子里却一个字都没提」。所以 `render_daily_summary`
先把 `node_ids` 和 `events` 里的节点名**并起来**再生成句子：

```python
order = sorted(set(... for node in node_ids) | {event["nodeId"] for event in events})
```

并集而不是直接用 `node_ids`。「计数和说法对不上」是这类文字报告最难查的一类错 ——
报告照样生成、照样能打开，只有对着数才发现少了一句。

顺序用 `sorted()`（固定的码元序），**不跟着运行环境的区域设置走**。和 8-1 的
第 4 步定序、7-1 的 nodeId 定序是同一条：同一份数据在不同机器上要排出同一个结果。

### 为什么不认 CSV 里那列 status

`find_daily_events` 要的是 `rule_status` 列（`analysis.add_rule_status()` 生成的），
**不是** CSV 里那列原始 `status`。这一列不在就直接报人话退出：

```
find_daily_events() 需要 rule_status 列（规则重算过的状态）。
先用 analysis.add_rule_status(df) 补上 —— 直接读 CSV 里那列 status 的话，
网页端规则改了这边不会跟着改，摘要会照着旧规则说得头头是道。
```

理由和 2-3 一样：`status` 是发布端算好写进 CSV 的，规则改了、历史 CSV 不会跟着改。
用原始列的话，一份按旧规则的阈值算出来的数据会被当成今天的规则来解读，
而报告上**看不出来**这件事。重算一遍的成本可以忽略。

`make_sim_data.py` 里 `_record()` 算出来的 `status` 本来就是 `rules.judge_status` 的结果，
但它写进 DataFrame 之后仍然要**显式赋给 `rule_status`** 才喂给 `find_daily_events` ——
不给自己开一条「我知道这份数据是对的」的后门。

### `MISSING` 这个常量的家在 `daily_summary.py`

温湿度缺一个就判不出状态，`add_rule_status()` 往这一列写 `(缺失)`。
「哪种值算没有可用数据」是**分段算法**的事（分段时要知道哪些行该跳过），
所以常量跟着算法走，家在 `daily_summary.py`；`analysis.MISSING` 指回这里：

```python
MISSING = daily_summary.MISSING
```

全项目仍然只有一份定义。写成两个字面量 `"(缺失)"` 的话，哪天改了口径（比如换成
`(无数据)`），两边只改一处，摘要会安静地漏掉中间的脏行、把它们当成正常数据接在段尾。

`(缺失)` 的行**既不开段、也不结段**，整行跳过 —— 和看板一致：那边脏报文整条丢掉，
正在进行的异常段起点不动，也不会因为中间空了一块就断成两截。

### 循环 import 是怎么断的

`analysis.py` 要 import `daily_summary` 来拼报告区块；`daily_summary` 的
`build_daily_summary()` 又想用 `analysis.py` 的 `load()` / `add_rule_status()` /
`resolve_csv()`（CSV 的读法和「status 一律重算」这两条规则各只有一处实现，不重抄）。

顶层互相 import 的话谁也先进不来。断法是**单向 + 一处延迟**：

```
analysis.py ──顶层 import──> daily_summary.py ──延迟 import──> analysis.py
                                  │
                                  └──顶层 import──> rules.py
```

`daily_summary.py` 的模块体只 import `rules` 和 `config`（都是叶子，不会回头），
`from analysis import analysis as report` 写在 `build_daily_summary()` **函数体里面**，
只在真要读文件时才执行 —— 那时候 `analysis.py` 早跑完模块体了。

上面那些纯函数（`find_daily_events` / `render_daily_summary` / `source_note`）
本来也不需要 `analysis`，所以不受影响。理由在文件头的 docstring 里也写了一遍 ——
这种「知道的人不多、删掉就崩」的写法必须留个记号。

### `main()` 为什么不许另读一次文件

`main()` 手上已经有一份算过规则的 `df` 了。调 `summarize_frame(df)` 是**就地用**它；
调 `build_daily_summary(csv_path)` 会**再读一次文件、再算一遍规则**。

**今天这两条路跑出来的结果一模一样** —— 所以这是一条没有行为差异的约束，
只能靠结构守卫钉住：

```python
mock.patch.object(daily_summary, "build_daily_summary",
                  side_effect=AssertionError("main 不该另读一次文件"))
```

写成行为断言是写不出来的（两条路今天等价）。守它的理由是**读取和复核各只该发生一次**：
读两遍是白费，而且两份中间结果哪天因为文件被改、编码不同、或规则复核有副作用而分叉，
报告上的数字和摘要就会各说各的 —— 这种错没人会想到去查「读了两遍」。

### 提交在仓库里的 `report/report.html` 是哪一份

**是 `data/dormmate.csv` 跑出来的那份**，和 Step 2-5 的文档一致（那份报告一直是从
样例数据生成的）。它没有 `nodeId` 列，所以今日摘要那块**如实降级**：

```
数据来源：CSV 里没有 source 列，看不出这份数据是现场采集的还是模拟出来的
这份 CSV 里没有 nodeId 列，没法按宿舍分开算今日摘要。先在网页上导出一份带 nodeId 的数据。
```

这不是坏了，是那一块的守卫在工作 —— 一份没有节点列的 CSV 确实没法按宿舍分段，
与其猜一个，不如明说。**要看真正的那块**，跑 `py -3.14 analysis/analysis.py data/day_sim.csv`。

### 变异测试

40 个变异逐个塞回源码，确认测试变红，再还原（还原后全套必须仍然是绿的）。
**40 个全被抓住，0 个存活，0 个跳过。**

先只跑 `tests.test_daily_summary`（0.2 秒一轮），**活下来的再拿全套 `discover` 复核一遍**
—— 只跑一个套件就宣布「存活」是不严谨的，别的套件可能抓得住。（这一轮 40 条全部
是 `daily_summary` 那一个套件自己抓住的，没有出现「只有别的套件抓得住」的情况；
复核这一步留着是因为下一轮未必如此。）

| 变异 | 结果 |
|---|---|
| 段里换状态时类型跟着改口（说「14:10 起偏湿」） | ✓ daily_summary 红 |
| 段的起点跟着往后走（不再是第一条异常数据） | ✓ daily_summary 红 |
| 开段就标成已恢复 | ✓ daily_summary 红 |
| 收尾时不把开着的段算进来（没恢复的事件凭空消失） | ✓ daily_summary 红 |
| 缺失值行当成异常数据 | ✓ daily_summary 红 |
| 缺失值行当成正常数据（一段被脏数据切断） | ✓ daily_summary 红 |
| `minutes` 按条数算而不是按时间算 | ✓ daily_summary 红 |
| 事件不排序（行序跟着文件走） | ✓ daily_summary 红 |
| **排序只按开始时间，不按节点名** | ✓ daily_summary 红（**补了测试才抓住**） |
| `nodeId` 缺失的行被丢掉 | ✓ daily_summary 红 |
| `nodeId` 缺失的行归到空串（句子里冒出个没名字的节点） | ✓ daily_summary 红 |
| `_cell` 不过滤 `NaN` | ✓ daily_summary 红 |
| `_clock` 切错位置 | ✓ daily_summary 红 |
| 时长算不出来时说成 `0 分钟` | ✓ daily_summary 红 |
| 没有事件的节点被说成「这一天没有数据」 | ✓ daily_summary 红 |
| **`events` 里多出来的节点不补进句子（总数和说法对不上）** | ✓ daily_summary 红（**补了测试才抓住**） |
| 一个事件都没有时也说「今日共 0 次」 | ✓ daily_summary 红 |
| 总数报成节点数 | ✓ daily_summary 红 |
| 一个节点都没有数据时照样往下走 | ✓ daily_summary 红 |
| 后面的段也用「起持续」的说法 | ✓ daily_summary 红 |
| **恢复与否说反** | ✓ daily_summary 红（**补了测试才抓住**） |
| 数据来源写死成「模拟日数据」 | ✓ daily_summary 红 |
| 缺 `nodeId` 列时照样去分组 | ✓ daily_summary 红 |
| 区块里不写数据来源 | ✓ daily_summary 红 |
| 数据来源写死成「模拟日数据」 | ✓ daily_summary 红 |
| 一个事件都没有时也摆一张空表 | ✓ daily_summary 红 |
| **「是否恢复」那一列说反** | ✓ daily_summary 红（**补了测试才抓住**） |
| `main` 里不把今日摘要塞进报告 | ✓ daily_summary 红 |
| **`main` 里另读一次文件算摘要** | ✓ daily_summary 红（**靠结构守卫，见上**） |
| `MISSING` 的括号换成全角（和 `daily_summary` 对不上） | ✓ daily_summary 红 |
| 模拟数据的 `status` 不算，直接写「正常」 | ✓ daily_summary 红 |
| 模拟数据的行不排序 | ✓ daily_summary 红 |
| **随机种子用 `hash(node_id)`（跨进程就变了）** | ✓ daily_summary 红（**补了测试才抓住**） |
| 事件时刻不对齐到采样点 | ✓ daily_summary 红 |
| 偏热窗口的末端不算在内（40 分钟变 35 分钟） | ✓ daily_summary 红 |
| 偏湿段的温度放到 30 ℃ 以上（判成偏热） | ✓ daily_summary 红 |
| 正常段的抖动大到会越过阈值 | ✓ daily_summary 红 |
| CSV 用 LF 而不是 CRLF | ✓ daily_summary 红 |
| 写文件不带 BOM | ✓ daily_summary 红 |
| 列的顺序换了（温度湿度对调） | ✓ daily_summary 红 |

**五处是「补了测试才抓住」的，都是真的覆盖漏洞：**

1. **排序只按开始时间。** 原来的测试里三个节点的开始时间各不相同，按时间排和
   按（节点名, 时间）排结果一样。补了 `test_开始时间相同时按节点名定序`
   （构造 `dorm-c` 和 `dorm-b` 同时开段、`dorm-c` 先结案）。
2. **恢复与否说反 / 「是否恢复」那一列说反。** 前者是句子里的「后恢复」和
   「仍未恢复」对调；后者是报告表格里那一列。补了 `test_每一行的结果和它自己的事件对上`
   —— 而且**得先把 `<tbody>` 抠出来再按 `<tr>` 切**：摘要那句话里也出现了「仍未恢复」，
   直接 `index()` 找会找到句子里那个，变异照样绿。
3. **`events` 里多出来的节点不补进句子。** 补了「节点集和事件集并起来」那条断言：
   传一组不含 `dorm-z` 的 `node_ids`，但事件里有 `dorm-z`，句子必须提到它。
4. **`main` 里另读一次文件。** 见上面「`main()` 为什么不许另读一次文件」——
   两条路今天产出一样，只能结构守卫。
5. **事件开始时刻没对齐到采样点。** 原来的断言只查 `start`，而 `align()` 改的是
   窗口的起点 —— 只查 `start` 时这条能蒙对。扩成同时断言 `end` 和 `minutes`。

**另有一处是变异测试没抓到、我自己查出来的：** `hash(node_id)` 那条。它被
「默认输出逐字相等」那条测试**顺手**杀掉了，但**同进程的确定性测试仍然是绿的**
（同一个进程里 `hash()` 对同一个字符串结果稳定）。真正能钉住它的是跨进程那条：
`test_跨进程也是同一个种子同一份数据` 起两个 `PYTHONHASHSEED` 不同的子进程各跑一遍，
比字节。**「一条变异被别的断言顺手杀掉」和「这条性质真的被测到了」是两回事** ——
前者换个种子或换个测试顺序就可能漏。

**还有一次「变异写错了」**（和 8-1 那次同一类）：第 7 条锚点 `event["minutes"] = _minutes(...)`
第一次只匹配到替换后自己的文本，实测是 SKIP 而不是 killed。SKIP 不是「抓住了」，
是**这条变异压根没生效**。锚点换成单行的 `'event["minutes"] = _minutes(event["start"], event["end"])'`
之后才正常杀掉。

### 换数据，摘要必须跟着变

这是这一步的验收条件。改种子、改事件时刻、改时长，摘要跟着改：

| 命令 | 摘要 |
|---|---|
| 默认 | `dorm-a 全天整体正常；dorm-b 14:10 起持续偏热 40 分钟后恢复；dorm-c 21:30 出现偏湿，目前仍未恢复。今日共 2 次需要关注的环境事件。` |
| `--seed 7` | `…dorm-b 14:20 起持续偏热 40 分钟后恢复；dorm-c 20:25 出现偏湿，目前仍未恢复。…` |
| `--seed 888` | `…dorm-b 13:00 起持续偏热 40 分钟后恢复；dorm-c 21:15 出现偏湿，目前仍未恢复。…` |
| `--hot-start 14:30` | `…dorm-b 14:30 起持续偏热 40 分钟后恢复；dorm-c 21:30 出现偏湿…` |
| `--hot-minutes 20` | `…dorm-b 14:10 起持续偏热 20 分钟后恢复；…` |

同一组参数跑两次，摘要必须一字不差（`test_同参数两次一致`）。

「改了数据摘要却没变」是最难发现的一类错 —— 报告照样生成、照样打开、照样好看。

`--hot-start` / `--humid-start` 是**覆盖**那个窗口，不是往窗口里塞 —— 填几点就是几点
（`--humid-start 06:00` 照样能出一个早上 6 点的偏湿段），填的时刻会往后对齐到采样点。
`--hot-minutes` 取的不是 5 的整数倍时，末端的点落不到采样网格上，**实际时长会比写的短**
（`--hot-minutes 42` 量出来是 40 分钟）—— 帮助信息里写了这一条，因为它不报错。

## Step 8-3：四个出口，各说各的

到 8-1 为止，看板顶部堆着两句「交代所有事」的话：B1 总览 + B2 依据。
两句都没错，但它们是**同一类信息**（谁最要紧、为什么），而且都不是给「扫一眼」
准备的 —— 一段话要读到底才知道重点是谁。

这一步把「谁最要紧」拆给四个出口，每个出口只说它最擅长说的那一部分：

| 入口 | 承担的信息任务 | 为什么适合放在这里 |
|---|---|---|
| 看板顶部一行 | 只报**一个**事实：谁是当前重点、在不在处理、温度往哪走 | 位置最显眼、最短。它是「抬头就看见」的那一层，所以只能放**一个**结论，不放理由。要读理由的人往下看卡片、往右看 3D |
| 3D 场景 | 只表达**空间**：哪个宿舍、哪个空间要关注（地板 / 窗户 / 风扇 / 灯光 + 当前重点那圈环） | 3D 的强项是「东西在哪、长什么样」。屋里风扇转着、窗开着，一眼就懂；换成一行字写「风扇已开启」，既占地方又不如画面直观 |
| 语音提醒 | 只念**一句**：当前最重要的那句提醒 | 声音是**线性**的，说过就过去了，没人能回头翻。所以它只能承担「一句话」的任务；念三段话，听的人只记得住最后一句 |
| `report.html` | 记**全过程**：什么时候开始、怎么处理的、什么时候恢复、持续多久 | 报告是能停下来慢慢看、能对着表格逐行核的地方。时间线、时长、理由这类「要对比着看」的信息放这里不浪费 |

四个出口的**信息不重叠**才是重点。三个都在说「dorm-b 偏热」，那是三份重复；
一个说「dorm-b｜处理中｜温度正在下降」，一个让屋里风扇转起来，一个念一句
「dorm-b 偏热已持续 20 分钟（风扇已开启，处理中），温度正在下降。」，
一个把这一段的开始 / 处理 / 恢复逐条记下来 —— 这才叫分工。

### 为什么顶部那一行要替掉 8-1 的两块

顶部还是那两句人话的话，「当前重点」这一行就只能挤在它们下面，等于又多了一层。
所以这一步把 7-1 的「优先关注」栏和 8-1 的「当前总览 + 判断依据」**一起从页面上撤掉**，
顶上只剩一行。

那两个函数**没有删**：`buildOverview` / `buildReasons` 仍然留在 `logic.js` 里、
仍然有测试，因为「完整记录」那个出口（`report.html`）要用它们。页面上不渲染
不等于这段逻辑没有用 —— 只是它换了个出口。

撤掉之后，那一行还顺手升级成了一个**按钮**：点它 = 切到那个宿舍（和点卡片一样）。
7-1 那条栏本来就是这个行为，撤掉它不能把这个功能一起带走。

### 3D 的检查结果：它只表达了空间状态吗

对着「3D 只表达哪个宿舍、哪个空间需要关注，不堆文字」这条要求逐项看了一遍：

| 检查项 | 结果 |
|---|---|
| 温度高不高，有没有表达成**空间里的东西** | ✅ 偏热 → 地板变红 **+ 风扇转起来**（两个冗余线索，不靠颜色单独表意） |
| 湿不湿 | ✅ 偏湿 → 窗户玻璃变蓝 **+ 窗扇开着** |
| 冷不冷 | ✅ 偏冷 → 两盏灯一起偏蓝、背景压暗（是**光**在变，不是给屋子贴个蓝色标签） |
| 正常 | ✅ 三样都不出现，就是默认那间屋子 |
| 有没有堆文字 | ✅ 覆盖层只有一行「当前宿舍：dorm-a」，没有温度、湿度、状态 |
| 「这间是哪个宿舍」说没说清 | ⚠️ 只能靠那行文字。场景里一次只画一间屋子，**没有别的办法知道这是 dorm-a 还是 dorm-b**。这是场景的固有性质（不是这一间那一间并排摆的俯视图），文字标签就是它的答案，**保持现状** |
| 「谁是当前重点」在画面里有没有对应 | ❌ **没有**。得先点卡片切过去，才知道重点是不是就是眼前这间 |

最后一行就是这次要补的洞。补法是在地板上加一圈**平躺的环**，只有「眼前这间
正好是当前重点」时出现（选的是「画面里这个宿舍是重点时加标记」那一条）。

**环为什么不跟着报文切宿舍**：3D 跟的是「当前选中的宿舍」，这条规则从 6-3 起
就没变过（收到别的节点的报文时 3D 一次都不许被调）。如果环跟报文走，就等于
让 3D 又变回「跟着最后一个发消息的宿舍」—— 那是 6-3 特意拆掉的东西。
所以环只回答「眼前这间是不是重点」，**换重点但不换选中项时会亮也会灭**，
而画面本身一动不动。

### 那一行里为什么不写状态

「dorm-b｜偏热｜处理中｜温度正在下降」——这个写法被否掉了。多一个「偏热」看着
只多两个字，代价是那一行又变回了 8-1 那种「什么都说了」。状态在页面上一共有
三处更合适的位置：卡片徽章（形状 + 颜色 + 文字三重编码）、3D 的地板与窗户、
语音那句里念出来。**一行字只有一个任务，就是告诉你抬头该看谁。**

`buildFocus` 里留了一行注释写着要加回来怎么改（在 `parts` 里插一个 `top.status`），
改动只有一行 —— 因为这是个**取舍**，不是遗漏。

另外「处理中」只写这三个字，不写「风扇已开启」：开了什么是**空间动作**，
归 3D。这一条同样钉在测试里（`buildFocus(BUSY)` 里不许出现「风扇已开启」，
但必须有「处理中」）。

### 那圈环为什么不跟 `renderScene` 共用一次更新

两者更新的**时机不一样**：

- `renderScene()` 跟的是「当前选中的宿舍」—— 只有 `record.nodeId === currentNodeId`
  时才调；
- 那圈环跟的是**全局**的「当前重点」—— 收到任何一条报文都可能换人。

所以 `handleMessage` 收尾那里是二选一的：是当前这间就 `renderScene()`，
不是这间就 `renderFocusMark()`。写成一个函数的话，「收到 dorm-a 的报文时
把眼前 dorm-b 的环灭掉」这个动作就没地方安放。

这条性质是**双向钉住**的：测试里喂一条 dorm-a 的报文，环灭了，而
`scene.statuses` 的长度**一个都没变** —— 证明环有自己的开关，不是
`renderScene` 的副产物。

### 语音提醒：只念一句，而且每次现算

按钮按下去走的是 `speakAlert()`：现算一遍 `buildAlert(nodes)`，再念。
**不缓存**。缓存的话会出现「卡片上重点已经换人了，再点还在念旧那个」。

念之前先 `cancel()`：连点两次时，第二次要**顶掉**第一次，而不是排队念两遍。
（`speechSynthesis` 默认是排队的，这一点和「同时只有一个」的直觉不一样。）

浏览器不支持时**既念不了也不装作念了** —— 按钮下面那行如实写「当前浏览器不支持
语音合成」。这一条让「按了没反应」和「按了但浏览器不支持」在页面上长得不一样。

**为什么这一句不是那一行的复制品**：｜ 念出来是「竖线」两个字，所以语音那一句
得自成一句人话（「dorm-b 偏热已持续 20 分钟，温度正在下降。」）。两处各拼一份的
风险是「重点换人了这边还念旧的」，那个风险由「两个函数都必须从 `pickPriority`
出发」这条测试挡住 —— 12 组数据逐组比开头那个宿舍名。

### 几个决定

| 决定 | 为什么 |
|---|---|
| 顶部那一行**替掉**上面两块，不是加在下面 | 三个都放在顶部，等于「顶部」这个位置又变成了要读完才知道重点在哪的地方 |
| 那一行写成**按钮**（可以点） | 撤掉 7-1 那条栏不能把「点它切过去」一起撤掉 |
| 3D 加一圈**平躺的环**，而不是给屋子描个边 | 相机是斜着俯视的，地板占的面积最大、遮挡最少；描边的话两面墙是半透明的，描出来的线会跟墙缝混在一起 |
| 环用 `MeshBasicMaterial`（不受光） | 它是**界面记号**，不是屋里的一件东西。偏冷那段整体压暗，跟着灯光走的话它反而不显眼了 —— 而「谁是重点」跟屋里冷不冷没关系 |
| 环的颜色**不取自四个状态色** | 状态色在这个项目里是保留色（`--status-*`），只表示那四种状态。环借用其中一个的话，看着就像出现了第五种状态。用的是输入框聚焦环那个 `--focus`（纯 UI 用色） |
| 状态图标留在那一行里，状态两个字去掉 | 颜色不许单独表意。留一个**形状**（太阳 / 雪花 / 水滴 / 对勾），形状本身就把状态区分开了 |
| `tempTrend` 在只有一条数据时返回**空串**，不是「持平」 | 一条数据说不出「在往哪走」。说成「持平」就是把「不知道」说成了「没变」—— 和「还没有收到数据 ≠ 正常」是同一条原则 |
| 趋势比**精确值**，不设容差 | 设「小于 0.5℃ 算没变」要先定下来多少算没变，那是另一套规则。而且真实数据里 24.9 → 25.0 确实就是在上升 |

### 变异测试

62 个变异逐个塞回源码（`logic.js` / `dashboard.js` / `3d/scene.js` 三处），
**59 个被抓住，3 个存活 —— 3 个都是等价变异体，下面逐个证明。**

`logic.js` 的变异同时跑 `logic.test.js` 和 `dashboard.test.js` 两套
（一条变异只被其中一套抓住也算抓住，但会记下来是**哪一套**抓住的 ——
「只有 dashboard 抓得住」本身就说明 `logic.test.js` 那边缺一条测试）。
`scene.js` 的跑 `scene3d.test.js`。

| 变异 | 结果 |
|---|---|
| `tempTrend` 只看最近两条改成看最近三条 | ✓ 两套都红 |
| `tempTrend` 上升/下降写反 | ✓ 两套都红 |
| 相等时也报「上升」 | ✓ 两套都红 |
| 相等时也报「下降」 | ✓ 两套都红 |
| 相等时返回空串（把「没变」说成「不知道」） | ✓ 两套都红 |
| 拿第一条和最后一条比（不是最近两条） | ✓ 两套都红 |
| 不挡 `NaN` / `Infinity` | ✓ **只有 logic 抓住** |
| 只有一条记录时也说「持平」 | ✓ **只有 logic 抓住** |
| 持平时说成「温度正在持平」 | ✓ 两套都红 |
| 趋势丢掉「温度」两个字 | ✓ 两套都红 |
| `calmLine`：没数据时改口说「都正常」 | ✓ 两套都红 |
| `calmLine`：有节点没数据时也说「都正常」 | ✓ 两套都红 |
| `calmLine` 少报「还没有收到数据」那一档 | ✓ 两套都红 |
| `buildFocus` 丢掉趋势那一段 | ✓ 两套都红 |
| `buildFocus` 用原始值拼趋势（少了那层说法） | ✓ 两套都红 |
| `buildFocus` 空的那一段也拼进去（留个空串） | ✓ 两套都红 |
| `buildFocus` 把「无」也当成处理状态拼出来 | ✓ 两套都红（**补了测试才变成两套都红**，见下） |
| `buildFocus` 没重点时也说「都正常」 | ✓ 两套都红 |
| `buildAlert` 平静时忘了句号 | ✓ 两套都红 |
| `buildAlert` 不念状态 | ✓ 两套都红 |
| `buildAlert` 不念时长 | ✓ 两套都红 |
| `buildAlert` 趋势前面少了那个逗号 | ✓ 两套都红 |
| `buildAlert` 结尾不加句号 | ✓ 两套都红 |
| `buildAlert` 不念处理状态 | ✓ 两套都红 |
| **`buildAlert` 删掉那句「走不到」的判断** | ✗ **存活（等价变异体，见下）** |
| `renderFocus` 没重点时也画成按钮 | ✓ dashboard 红 |
| `renderFocus` 用 8-1 的总览那句替掉这一行 | ✓ dashboard 红 |
| **没重点那条路上的 `esc()` 去掉** | ✗ **存活（等价变异体，见下）** |
| **有重点那条路上的 `esc()` 去掉** | ✗ **存活（等价变异体，见下）** |
| 「正在查看 / 查看详情」不跟着 `currentNodeId` 走 | ✓ dashboard 红 |
| 「正在查看」和「查看详情」写反 | ✓ dashboard 红 |
| 那一行不画状态图标（只剩颜色独自表意） | ✓ dashboard 红 |
| 那一行的颜色不跟状态走（永远用正常那一档） | ✓ dashboard 红 |
| 那一行忘了带 `data-node`（点了没反应） | ✓ dashboard 红 |
| 那圈环不跟「正在看的是不是重点」走 | ✓ dashboard 红 |
| 那圈环的条件写反（重点是别人时反而亮） | ✓ dashboard 红 |
| 收到别的节点的报文时不重算那圈环 | ✓ dashboard 红 |
| `handleMessage` 末尾不重画那一行 | ✓ dashboard 红 |
| `renderScene` 尾巴上不重算那圈环 | ✓ dashboard 红 |
| 清空时不重画那一行 | ✓ dashboard 红 |
| 3D 覆盖层又把状态抄回去 | ✓ dashboard 红 |
| 念之前不 `cancel()`（连点两次会排队） | ✓ dashboard 红 |
| 不给 utterance 设 `lang` | ✓ dashboard 红 |
| 不挂 `onerror`（朗读失败静悄悄） | ✓ dashboard 红 |
| 失败时不写原始错误码 | ✓ dashboard 红 |
| 念了什么不写到那行说明里 | ✓ dashboard 红 |
| 不支持时什么都不说（既不念也不写） | ✓ dashboard 红 |
| 只查 `speechSynthesis`、不查构造函数 | ✓ dashboard 红 |
| 语音按钮没挂回调 | ✓ dashboard 红 |
| 清空时不擦掉上一句的说明 | ✓ dashboard 红 |
| 点那一行不切节点 | ✓ dashboard 红 |
| 点那一行时挑错了元素（`.card` 而不是 `.focus`） | ✓ dashboard 红 |
| 环不躺平（立着的一堵墙） | ✓ scene3d 红 |
| 环陷进地面里 | ✓ scene3d 红 |
| 环一开始就亮着 | ✓ scene3d 红 |
| 环忘了 `add` 进场景 | ✓ scene3d 红 |
| 环用受光材质（跟着屋里光照忽明忽暗） | ✓ scene3d 红 |
| 环不透明（把地板整个遮掉） | ✓ scene3d 红 |
| 环只画一面（相机转到背面就消失） | ✓ scene3d 红 |
| 环借用了状态色（看着像第五种状态） | ✓ scene3d 红 |
| 环的内外半径写反 | ✓ scene3d 红 |
| `setFocus` 不归一化成布尔 | ✓ scene3d 红 |

**一个真的覆盖漏洞（补了测试才抓住）：**

- **`buildFocus` 把「无」也当成处理状态拼出来。** 原来那批数据里，重点那个节点
  要么有 `handling: '处理中'`，要么**根本没有 `handling` 这个字段** ——
  两种情况都测了，唯独漏了页面里真正跑起来的那种：没按过按钮的节点，
  `handling` 是**字符串 `'无'`**（见 `nextHandling` / `beginEvent`）。
  只判 `if (node.handling)` 时它照样是真的，拼出来是「dorm-b｜无｜温度正在下降」。
  补的方法是拿真值 `'无'` 再测一遍；顺带把两头的不对称也钉住：
  `handlingNote` 用的是**白名单**（只认「处理中」），`buildFocus` 用的是**黑名单**
  （排除「无」），两种写法今天结果一样，各自钉一条。

**三个等价变异体（证明它们杀不掉）：**

1. **`buildAlert` 里那句 `if (list.length === 0) return calmLine(nodes) + '。';`。**
   `pickPriority` 的实现就是 `const list = ranked(nodes); return list.length ? … : null;`
   —— 它返回 `null` 的**充要条件**就是 `ranked()` 为空。所以上面 `if (!pick)` 已经
   兜住了，这一句永远走不到，删掉它行为一个字都不变。
   *它留着是有意的*：这是一道保险 —— 万一以后 `pickPriority` 改成别的口径
   （比如自己过滤一遍），这里是 `list[0].status` 会直接抛 `TypeError` 的地方，
   一句平静话比一个异常好收拾。测试里钉的是**前提**（没有重点时走的必须是
   `calmLine` 那条路），不是这一句本身。
   > 顺带一提：这句原本的注释写的是「不让 `undefined` 拼出『undefined 已持续
   > undefined』」——**那句话是错的**，`list[0]` 是 `undefined` 时 `top.status`
   > 当场就抛了，根本走不到拼字符串。注释已按实际作用改写。
2. **`renderFocus` 里那两处 `esc()`（平静那条路和有重点那条路各一处）。**
   去掉之后输出**一个字都不变**，因为能走到这两处的字符串全是固定字面量或
   白名单里来的：`pick.nodeId` 只可能是 `dorm-a` / `dorm-b` / `dorm-c`
   （未知节点在 `handleMessage` 的「节点必须是约定里的三个之一」那一关就被丢了，
   根本进不了 `nodes`），`handling` 只可能是 `'处理中'` / `'已恢复'` / `'无'`，
   趋势那一段是 `温度持平` / `温度正在上升` / `温度正在下降`。没有 `<` `&` `"` `'`
   能进来，`esc()` 一次也不会改变输出。
   *不删的理由*：这是纵深防御。哪天那把白名单松了（比如以后支持任意 `nodeId`
   前缀），今天这一行就是唯一的转义点 —— 为了凑一个「杀死」的数字把它删掉是
   为指标优化，不是为正确性优化。

**另有一次「变异写错了」**（和 8-1、8-2 同类）：第 8 条锚点 `if (history.length < 2) return '';`
在源码里其实长成 `if (!Array.isArray(history) || history.length < 2) return '';`，
第一次是「锚点没对上」；同一批里还有 8 条锚点因为缩进或者不唯一没生效。
**「锚点没对上」和「存活」必须分开记** —— 前者是这条变异压根没生效，报成
「存活」的话会把一个假漏洞写进表里。跑完这一轮锚点问题已经是 0。

### 这一步对测试桩的改动

三个套件的桩都动了：

- `tests/dashboard.test.js`：假 DOM 的 id 表里 `priority` / `overview` / `reasons`
  换成 `focus` / `speak` / `speak-note`；`window` 上加了 `speechSynthesis`
  （记下 `cancel` 和 `speak` 的顺序）和 `SpeechSynthesisUtterance`（记下念过的文本
  和 `lang`）；3D 桩记下每次 `setFocus` 传的值；钩子 `__renderPriority` /
  `__renderInsight` 换成 `__renderFocus` / `__speakAlert`。
- `tests/scene3d.test.js`：假 `three` 模块补了 `RingGeometry` 和
  `MeshBasicMaterial`（后者把自己记进一个表，用来验证环用的是不受光的材质）。
- `tests/logic.test.js`：导出清单从 13 个改成 16 个，`trendText` / `calmLine`
  进「不许导出」那一列。

## Step 9-1：C1 准备历史数据与新数据

C 部分要做的事是「拿一段平时的历史当基准，判断新来的一批读数正不正常」。
这一步只做**数据准备**：把基准和待判断的那批造出来，并且**分开放**。

一次运行（`py -3.14 analysis/make_sim_data.py`）现在出三份文件：

| 文件 | 是什么 | 谁用它 |
|---|---|---|
| `data/day_sim.csv` | 一天、三个宿舍、864 行，两个事件（8-2 那份，**一个字节都没变**） | 今日摘要、报告区块 |
| `data/dorm-a_history_sim.csv` | dorm-a 的 40 条「平时」历史，24~26 ℃ / 55~65 %，**条条正常** | C 部分当基准 |
| `data/new_samples.csv` | 6 条待判断的新读数：25/60、26/62、29/72、31/60、25/80、17/60 | C 部分拿去判断 |

三份的列完全一样：`nodeId,time,temperature,humidity,status,source`。

### 为什么必须分开放

「新数据不能混进历史里」不是格式要求，是**方法论要求**：后面要拿历史当基准，
去判断这 6 条新数据。新数据要是也躺在历史里，判断就变成了拿自己判断自己 ——
「这条比历史里那条高」和「这条比它自己高」在代码上看不出区别，结果照样能跑出来，
只是那个结果没有意义。所以这一步的测试是照着这条写的：

- 历史**正好 40 条**（混进那 6 条就该是 46）；
- 两边**没有一个时刻重叠**；
- 更狠的一条：异常那几条的取值**从区间上就不可能**出现在历史里 —— 历史的温度恒在
  24~26、湿度恒在 55~65，31 ℃ / 17 ℃ / 80 % 都不在这两个区间内。这条是**证出来的**，
  不是「恰好没撞上」。

时间轴是**首尾相接**的（历史的末点 11:15 + 一个采样间隔 = 新数据第一条 11:20），
所以后面想把它俩画在一条时间轴上也不会断开 —— 但它们**各自在自己的文件里**。

### 几个决定

| 决定 | 为什么 |
|---|---|
| 一次运行出三份，**不加开关** | 三份是同一次数据准备的一部分，加了开关就有「跑过但忘了加参数」这种状态。要换地方用 `--out`（三份一起搬） |
| 这两份排在 `--date` 的**后一天** | 同一天同一时刻，`day_sim.csv` 里 dorm-a 是一个读数、这份历史里是另一个读数（两条互不相干的随机流），并排一放像在吵架，而「同一个宿舍在 08:05 为什么有两个温度」是个解释不清的问题 |
| 历史**另起一条随机流**（种子串里带 `history`） | 复用 day_sim 那三条 `rng` 的话，改这里一个常数，`data/day_sim.csv` 就会跟着变 —— 那份文件有逐字节测试钉着，改完之后「是谁动了它」得查半天 |
| 新数据的六条**写死在代码里** | 它们是题目给的输入，不是造出来的。所以 `build_new_samples()` **不接 seed 参数**、一个随机数都不抽，测试里也钉了「换 `--seed` 这六条一个字节都不变」 |
| 新数据的开始时刻**由历史推出来**（末点 + 一个间隔） | 写死 11:20 的话，改了历史条数或采样间隔，新数据就会和历史末点撞在同一个时刻上。而「时间不重叠」是这条要求第一个该守住的东西 |
| 历史用**同一个采样间隔 5 分钟**，从 08:00 起 | 白天有人在宿舍的时段读起来更像「平时的记录」；也刻意避开 day_sim 那两个事件时刻（14:10 / 21:30），免得让人以为有关联 |
| `source` 仍然写「模拟」 | 这两份是同一台机器上按同一个种子生成的模拟数据。`source` 这一列是**如实交代来源**用的，不是「这算不算真数据」的判断题 |
| 温湿度记成**整数**（`25` 而不是 `25.0`） | 题目给的就是整数。CSV 里一个字不一样，逐字节比对就会红 —— 这条也留在变异表里 |

### 变异测试

41 个变异逐个塞回 `analysis/make_sim_data.py`，跑**整套 Python 测试**
（`py -3.14 -m unittest discover`，只要有一个用例挂了就算杀掉）：

**41 个全部被抓住，0 个存活，0 个锚点没对上。**

| 变异 | 结果 |
|---|---|
| `HISTORY_NODE` 换成 `dorm-b` | ✓ 四十条全是 dorm-a |
| `HISTORY_COUNT` 少一条 / 多一条 | ✓ 时间锚点 |
| `HISTORY_START` 改到 00:00 | ✓ 时间锚点 |
| 温度下界松一格 / 上界松半度 / 上界顶到阈值以上 | ✓ 取值范围 |
| 湿度上界松到 70（还是正常）/ 顶到阈值以上 | ✓ 取值范围 |
| 历史文件名改掉 | ✓ 文件名固定 |
| 两份文件共用同一个名字 | ✓ 两份是两个文件 |
| 新数据里 29/72 改成 29/74 | ✓ 逐字节 |
| 新数据写成 `25.0/60.0`（值一样，CSV 里字不一样） | ✓ 逐字节 |
| 新数据前两条对调 / 少给一条 / 17 改成 18 | ✓ 逐字节 |
| day_sim 的后一天改成同一天 / 改成前一天 | ✓ 时间锚点 |
| 采样步长退化成 1 分钟 / 少一个点 / 负步长 | ✓ 时间锚点 |
| 温度四舍五入成整数 / 留两位小数 | ✓ 逐字节 |
| 随机流种子里去掉节点名 / 去掉 seed | ✓ 逐字节 / 换种子该变 |
| 历史这条流改用 day_sim 的种子串 | ✓ 逐字节 |
| 温湿度取反了（拿湿度的区间抽温度） | ✓ 取值范围 |
| 历史不看 `--date` | ✓ 逐字节 |
| 新数据接在历史**第一条**后面 / 加 0 分钟（不错开） | ✓ 逐字节 |
| 新数据步长退化成 1 分钟 / 记到 dorm-b 头上 / 不看 `--date` | ✓ 逐字节 |
| 温湿度参数写反 | ✓ 逐字节 |
| 历史写到固定路径、不跟 `--out` 走 | ✓ 跨进程那份 |
| 两份文件写反 / 历史那份写成日数据 / 新数据那份忘了写 | ✓ 换种子 / 跨进程 |
| 新数据不吃 `--date` / 历史不吃 `--seed`、`--date` | ✓ **换一天那份 / 换种子那份**（新补的两条测试，见下） |
| 打印时把历史的首末点弄反 | ✓ 命令行输出 |

**一处真的覆盖漏洞（变异测试直接抓出来的）：**

- **`samples = build_new_samples(args.date)` 改成 `build_new_samples()`。**
  这个变异**起初是存活的**。原因很直白：整套测试里**没有一条传过非默认的 `--date`** ——
  默认情况下 `DAY` 就是 `2026-09-22`，两者结果一模一样，所以这个错误在测试里
  完全看不出来：它会一直输出 09-23 的历史和新数据，而日数据跑到别的日期去了，
  摆在一起就是「一天的数据配另一天的基准」。
  补的测试是 `test_换一天两份也跟着换`（`--date 2026-01-01` → 日数据 01-01、
  另两份 01-02）。这条变异现在是「✓ 换一天那份」抓住的。

**还有一处是文档谎言（顺手改了）：** 模块开头写着「随机种子固定（默认 **20260922**）」，
而代码里 `SEED = 2350` —— 2350 是当初特意挑出来的（它让默认数据正落在需求里
那两个时刻上，`SEED` 上面那段注释就是这么写的），docstring 这句从改种子那天起
就没跟上。同一个文件里两处说两个数，信哪个都可能是错的，已按实际值改掉。

**一条值得注意的分布：** 上表里一半以上的变异是「`data/` 里那两份文件逐字节比对」
抓住的 —— 这就是把生成结果**提交进仓库**的价值：它把「脚本现在生成的东西」和
「交上去的那份东西」钉在一起，改了逻辑却不重新生成，测试当场就红。
反过来说，那两份文件**删掉也能跑**（会 skip，和 `day_sim.csv` 一个规矩），
但上表里一多半的变异就没人管了 —— 别顺手删，理由记在「已知限制」里。

### 这一步对测试桩的改动

只动了 Python 侧，**JS 七个套件一行都没改**（这一步没碰前端）。
`tests/test_daily_summary.py` 里加了一个 `datetime` 的 import、四个测试类
（`TestHistory` / `TestNewSamples` / `TestTwoFilesApart` / `TestHistoryAndSamplesFile`），
另外把原来的「跨进程也是同一个种子同一份数据」从**比一份**改成**比三份** ——
两次子进程运行各写各的子目录（文件名的规则变了，共用目录的话第二次会把第一次
那两份按固定名字盖掉）。

**外带改了 `.gitattributes` 一行：** 加了 `data/*.csv text eol=crlf`。
原因是新那两条「逐字节等于重新生成的结果」是**对换行敏感的** —— 之前 `day_sim.csv`
那条比对走的是「读成行、再拼回文本」，CRLF 在比对里根本不出现，所以在只开了
`core.autocrlf` 的机器上也不会红。现在这两条直接比 `read_bytes()`，
要是谁 clone 出来是 LF，红的会是「谁 clone 的」而不是代码。
`text eol=crlf` 让仓库里照样存 LF（和现在一样，已跟踪的 csv 一个字节都没动）、
检出到哪台机器都是 CRLF。

## Step 9-2：C1 + C2 Isolation Forest 与固定规则对照

C 部分的后半：拿 9-1 造的那 40 条「平时」历史当基准，让 Isolation Forest 看那 6 条
新读数「像不像平时的样子」，**并排摆出固定规则的说法**，两边对不上的单独点出来。

```bash
py -3.14 analysis/ml.py                              # 用 data/ 里默认那两份
py -3.14 analysis/ml.py 别的历史.csv 别的新数据.csv   # 也可以指定（相对路径按项目根展开）
```

入口是 [analysis/ml.py](analysis/ml.py) 里的 `run_ml(history_csv, new_csv)`，返回一个
dict（`rows` / `mismatches` / `reverse` / `text` / `history_flagged` / …）。命令行只是
把它的结果打成一张表。这一步只要求返回值是「报告能直接拿去用」的 ——
**写进报告是 Step 9-3 那侧的活**（下面那一节），报告里那个区块的表跟这张表是同一批
数据、同一句话。

实际跑出来是这样（参数就是需求给的那三个，没有为了凑结果动过）：

| 时间 | 温度 ℃ | 湿度 % | 规则 | ML | 分数 | 备注 |
|---|---|---|---|---|---|---|
| 2026-09-23 11:20:00 | 25 | 60 | 正常 | 接近历史常态 | 0.0347 | |
| 2026-09-23 11:25:00 | 26 | 62 | 正常 | 与历史明显不同 | -0.0564 | 规则说正常，ML 说不同 |
| 2026-09-23 11:30:00 | 29 | 72 | 正常 | 与历史明显不同 | -0.123 | 规则说正常，ML 说不同 |
| 2026-09-23 11:35:00 | 31 | 60 | 偏热 | 与历史明显不同 | -0.0823 | |
| 2026-09-23 11:40:00 | 25 | 80 | 偏湿 | 与历史明显不同 | -0.0933 | |
| 2026-09-23 11:45:00 | 17 | 60 | 偏冷 | 与历史明显不同 | -0.045 | |

**2 条不一致**，都在 11:25 / 11:30 这两条**规则判为正常**的读数上。这不是调出来的，
是这两份数据本来的结果；`random_state=42` 定着，同一台机器上跑多少遍都是这一张表
（测试里钉了分数和这两条时刻）。

### 两种口径为什么会在这些行上分岔

固定规则只看**有没有越过那三条线**（18 / 30 / 75），越过了才说话；
ML 比的是**跟平时那 40 条像不像**，它没有「线」这个概念，只有一片云和云的边缘。
26 ℃ / 62 % 离三条线都还有距离，规则说正常没错；但平时那 40 条是 24~26 ℃ / 55~65 %
挤成一团，62 % 已经贴到边上去了，ML 就报「与历史明显不同」。

两边的说法**都成立**，它们回答的本来就不是同一个问题：

| 口径 | 回答的问题 | 输出 |
|---|---|---|
| 固定规则（`rules.judge_status`） | 这个读数**越过阈值了吗** | 偏冷 / 偏热 / 偏湿 / 正常 |
| Isolation Forest | 这个读数**像不像平时** | 接近历史常态 / 与历史明显不同 |

所以这一节的产出不是「谁对谁错」，而是把分岔点标出来：**规则说正常、ML 说不同**
的那两条，正是最值得回头看一眼的数据。反方向（规则说异常、ML 说像常态）代码里也
一起找（`find_reverse`），本次一条都没有。

### 判决门槛是 0，不是 `model.offset_`

这个坑值得单独记一笔，因为它是**自己写的文档在骗自己**：第一版脚本把
`model.offset_` 当成判决门槛打印出来（`contamination='auto'` 时它是 -0.5），
可表里明明有 -0.045 这种分数被判成了「与历史明显不同」—— 一个比 -0.5 大的分数
怎么会被判异常？

去翻装在本机上的 `sklearn/ensemble/_iforest.py`（1.9.1）才看清：

```python
is_inlier[decision_func < 0] = -1     # predict 的真正判据
```

`predict` 用的是**分数 < 0**，`offset_` 是另一套口径（`score_samples` 那一路）留下的
东西。所以 `ml.py` 里写的是 `ML_THRESHOLD = 0.0`，而且每次运行都拿
`_check_threshold()` 把 `predict` 给的标签和分数**逐条对一遍**：只要哪天 sklearn
改了判决规则，这句话会当场变成 `RuntimeError` 问你要个说法，而不是继续按旧口径
打一张看着没问题的表。

### 「与历史明显不同」没有听上去那么重

`contamination='auto'` 是**不指定异常比例**的意思，它的门槛不落在历史那片云的外沿上，
而是按自己那套估计切进去。代价是：**拿模型回看它自己学过的那 40 条历史，其中 18 条
也会被判「与历史明显不同」**（这个数命令行每跑一次就打印一次，测试里也钉着）。

所以这张表里的「与历史明显不同」要读成**「落在门槛的另一侧」**，不是
「这条读数离谱」：

- 11:30（29 ℃ / 72 %）分数 -0.123，是这批里真正离群的那一条；
- 11:25（26 ℃ / 62 %）分数 -0.0564，只是刚过线 —— 它被判为不同，一半是数据，
  一半是这个偏松的门槛。

这一点不写清楚的话，报告里那句「ML 认为与历史明显不同」会被当成硬结论。
想让它更严格，得把 `contamination` 写成一个具体比例（或者干脆用别的模型），
那是另一件事；这一步按要求**原样保留 `contamination='auto'`**。

### `load()` 现在会拦下不是数字的格子

这一步顺带补在**全项目唯一读 CSV 的地方**（`analysis/analysis.py` 的 `load()`）：
温湿度列里出现不是数字的值，就地报一句人话，说清是哪一列、第几行、哪一刻、哪一格。

不补的话，`不热` 这种值会一路走到 `rules.judge_status`，在 `temperature < 18` 那行
崩成一个裸 `TypeError` —— 看得出类型不对，看不出是**哪一行哪一列**，而这正是手改
CSV 之后最容易留下的东西（`analysis` / `daily_summary` / `ml` 三条路都会撞上它）。
空着的格子仍然照旧（缺失单独算一档），**带引号的 `'25'` 不算数字**，报。

两个 pandas 3.0.6 的行为是查着写的，别凭印象：

| 现象 | 后果 |
|---|---|
| 列里**只要有一格**是文字，**整列**都变成 `str` 类型（本该是数字的 `25` 也变成 `'25'`） | 光看「类型不对」会指着第 2 行那个没事的 `25` 报错。所以挑要报的那一格时，优先挑**连数都算不出来**的那格（`float()` 一转就炸的），挑不出来才退回第一格 |
| 空格子读出来是 `float('nan')`，而 **`nan` 本身就是 `numbers.Number`** | 「空着要放行」那句守卫是**空写** —— `isinstance(value, numbers.Number)` 自己就把空值排除掉了。变异测试里那条「空格子也当成不是数字」正是撞在这里，查完把守卫删了，理由写在代码注释里 |

第二条是**实测**出来的，不是推理出来的：拿十种写法（全是数字 / 一格文字 / 带引号的数字 /
纯空格子 / 空+文字混着 / 小数和负数 / True,False / 前导零 / 科学计数 / 带百分号）各读一遍，
这两列里的每一格只会是三种东西 —— `numbers.Number`（`int` / `float` / `bool`）、
`str`、空值，**没有第四种**。这条表就是上面两个判断的依据。

### 变异测试

104 个变异，逐个塞回 [analysis/ml.py](analysis/ml.py) 和 [analysis/analysis.py](analysis/analysis.py)，
每个都跑**整套 Python 测试**（`py -3.14 -m unittest discover`，只要有一个用例挂了就算杀掉）：

**104 个里 102 个锚点还在，逐个跑完：杀掉 101，活着 1（等价变异）、锚点没了 2（退役）。
而且跑完两个源码文件都逐字节还原干净。**

第一轮跑出来 5 个存活的，逐个查完是这样（下面那些改动做完之后又整轮重跑了一遍，
就是上面那个数）：

| 存活的变异 | 查下来的结论 |
|---|---|
| 命令行成功也返回 1 | **测试桩的洞**：`test_ml.py` 里的 `capture()` 只看 `SystemExit`，压根没接函数的返回值 —— 改成 `return 1` 也照样绿。已修（成功时退出码取返回值），这条变异当场被杀 |
| 时刻永远报第一条 | **测试的洞**：`test_坏值在第几条就说第几行` 只断言了行号和坏值，没断言时刻 —— 行号对、时刻指着头一条，等于把用户往上面几行引。已补断言，这条被杀 |
| 空格子也当成「不是数字」 | **等价变异（顺带发现守卫是空写）**：空值就是 `float('nan')`，它本身就是 `numbers.Number`，加不加那句守卫结果一样。守卫已删，锚点随之退役，理由写在注释和上面那张实测表里 |
| 判据从「不是数字」改成「是字符串」 | **等价变异**：锚点跟上一行是同一句（删守卫时一起没了）。深一层的原因也是那张实测表 —— 这两列非空的值只有数字和 `str` 两种，「不是数字」和「是字符串」在这份输入上选中的是同一批格子 |
| 不先转成字符串（`float(str(value))` → `float(value)`） | **等价变异**：`_parses_as_number()` 只被 `load()` 调用，传进去的只可能是上表那三种里的 `str`（数字进不了这个分支），`str()` 在 `str` 上是空操作 |

**唯一那个等价存活就是 `float(str(value))` → `float(value)`。** 没有为了杀掉它去造
一个「read_csv 根本产生不出来」的输入 —— 测试不是拿来凑数的，宁可在表里写清它是等价的。

变异跑完还要确认**源码被原样放回了**（比 sha256）。第一轮这里报了
`analysis/ml.py 干净：False`，diff 下来**内容一个字都没变，只有行尾从 LF 变成了 CRLF** ——
变异脚本用 `Path.write_text()`（默认按平台翻译换行）回写，而 `Path.read_text()` 默认
又把 CRLF 折成 LF，一读一写就把行尾换了。这是这个仓库的老坑（另见「排查」里那条），
已改成**还原时整块写回读到的原始字节**，之后每轮都是 `干净：True`。

### 这一步对测试桩的改动

新增 `tests/test_ml.py`（**95 条**），另给 `tests/test_analysis.py` 加了 **12 条**
（134 → 146：一个新的 `TestParsesAsNumber` 类 4 条，`TestLoad` 里 8 条）。
**JS 那七个套件一行都没改** —— 这一步没碰前端。

`tests/test_ml.py` 里 95 条分三层：**纯函数那批**（对照、成句、门槛核对）压根不读文件，
跟 sklearn 无关；**中间那批**用临时目录里现造的小 CSV（宽历史 40 条、居中的新数据 6 条），
跑得快，而且改 `data/` 里那两份默认数据不会把它们一起带红；**最后那批**才钉真数据的结果
（六个分数、六个状态、不一致的就是那两条时刻）—— 这份要是被删了会被 `skipUnless` 跳过，
和 9-1、8-2 那几份一个规矩。

`capture()` 这个助手改了：以前只接 `SystemExit`，现在**成功时也取函数的返回值**
（`_main` 跑完返回 0）。不看返回值的话，「跑成功了也返回 1」这种改法一点动静都没有，
而命令行上 `py -3.14 analysis/ml.py && 下一步` 会再也不会执行下一步。

## Step 9-3：C3 ML 结果写回 report.html

C 部分的收口：Step 9-2 算出来的对照结果，这一步接进报告 —— `report.html` 里多一个
「ML 异常分析」区块，**同一份结论再落一份 JSON**（`report/ml_result.json`）给看板 fetch。

```bash
py -3.14 analysis/analysis.py --no-plot                # 报告 + report/ml_result.json 一起出来
py -3.14 analysis/analysis.py --no-plot --no-report    # 只算不写（两个产物一起跳过）
```

区块由 `analysis/analysis.py` 的 `ml_section(result)` 拼（返回的就是 `sections` 里的
一项），内容是**四段字 + 一张表**：训练数据 / 待判断数据各自的**文件名和条数**、
一句「这一段判的不是上面那份 CSV」、两种口径的说明（固定规则看提前写好的三条阈值、
ML 看「和这个宿舍平时像不像」、**ML 只作为辅助判断**）、`run_ml()` 算出来的那句结论、
六列对照表、门槛松紧那句。

接进报告的那张表（就是 9-2 那张，**不一致的两行加底色**）：

| 宿舍 | 温度 ℃ | 湿度 % | 固定规则 | ML 判断 | 分数 |
|---|---|---|---|---|---|
| dorm-a | 25 | 60 | 正常 | 接近历史常态 | 0.0347 |
| **dorm-a** | **26** | **62** | **正常** | **与历史明显不同** | **-0.0564** |
| **dorm-a** | **29** | **72** | **正常** | **与历史明显不同** | **-0.123** |
| dorm-a | 31 | 60 | 偏热 | 与历史明显不同 | -0.0823 |
| dorm-a | 25 | 80 | 偏湿 | 与历史明显不同 | -0.0933 |
| dorm-a | 17 | 60 | 偏冷 | 与历史明显不同 | -0.045 |

高亮用的是报告里**唯一那个「要人多看一眼」的颜色**：`tr.mismatch td` 的底色
（`#fff5f5`）加左边一条竖线（`#C1440E`），和顶部那条红色横幅是一套。两个方向的不一致
都高亮：规则说正常而 ML 说不同（表里那两条），以及反过来那一种（越过了线、但这条线
在历史里常见）—— 只亮前一种的话，后一种在表里看着和「两边都同意」一模一样。

### 这一段判的不是本报告上面那份 CSV

`main()` 手里那份 CSV 是演示数据，ML 这一段判的是 **C 部分那一对文件**
（`data/dorm-a_history_sim.csv` + `data/new_samples.csv`）—— 报告开头那个「数据来源」
说的是前一份。不写清楚的话，读的人会把这张表的结论安到上面的统计上去。所以区块里
两份文件的名字和条数都印出来，还专门说一句「不是本报告上面那份 CSV」。
文件名的取法是 `Path(...).name`：报告是本机看的，但没必要把整条本机路径印上去。

### 结论那句话算一次、渲染两次

命令行上那句和报告里那句是**同一个** `result["text"]`（`ml.render_comparison()` 算的），
报告这一侧只是把它插进 `<p>` 再过一道 `_esc()`。「今日摘要」从 Step 8-2 起就是这个规矩：
各拼一份的话，屏幕上和报告里迟早变成两句话 —— 而那种不一致没人会去核对。

### 跑不起来时只让这一段降级

`ml.run_ml()` 会抛两种东西，没有一种是「报告坏了」：

- `SystemExit`：那两份文件被删了（`load()` 报一句人话就退）；或者这台机器没装
  scikit-learn（`build_model` 给出安装命令）；
- `ValueError`：两份里有一份一行数据都没有（`_require_rows` 报「只有表头」）。

`main()` 把这一段整个包在 `try` 里，接住之后报告里换成一句
**「这一段没跑：{原因}」+「报告其余部分不受影响（那些数字来自本报告读到的 CSV）」**，
并且**不写 `report/ml_result.json`** —— 没算出来的东西不落文件，省得看板上出现一张
上一次跑剩的旧结论。报告其余部分一个字都不受影响：那些数字是这次读到的 CSV 算的，
跟 ML 没关系。

### 为什么 JSON 里只留文件名、不留路径

`run_ml()` 的返回值里 `history_file` / `new_file` 是**绝对路径**（`C:\Users\...`）。
`report/` 下的东西是要提交进仓库的，原样倒出去等于把本机的目录结构一起发了出去，
而且换台机器跑出来那份文件里还写着别人的路径。所以 `ml_result_json()` 只取文件名，
测试里钉着「整份 JSON 里不许出现 `/tmp`」「文件名里不许出现冒号」。

另外三件事：键名用 camelCase（和看板那份**统一 JSON** 一个约定：`nodeId` / `time` /
`temperature` / `humidity`）；中文 `ensure_ascii=False` 原样写进去，看板 fetch 回来
就是中文，不用再解一遍 `\uXXXX`；温湿度写成 `25` 而不是 `25.0` —— CSV 读出来是
float，直接 dump 会带个 `.0`，而看板上「环境数据」和「ML 辅助判断」两处并排显示时，
一个 25 一个 25.0 看着就像两份数据（`_json_number()` 干这件事）。

### 三个不一致的计数为什么分开放

`text` 里那句「不一致的有 2 条」是**两个方向加起来**的，而「规则说正常、ML 说不同」
那一种才是题目要找的。只给一个总数的话，看板那边没法把最该看的那几条单独说出口，
所以 JSON 里是 `mismatchForward` / `mismatchReverse` / `mismatchTotal` 三个数。
测试里专门造了一组「正向 2 条、反向 1 条」的数据 —— 拿正反各一条的对称数据，
两个数**对调了也看不出来**。

### 变异测试

59 个变异，逐个塞回 [analysis/analysis.py](analysis/analysis.py)（这一步只动了这一个
源文件），每个都跑**整套 Python 测试**（`py -3.14 -m unittest discover`）：

**59 个锚点全对上，逐个跑完：杀掉 54，活着 5。** 把那 5 个查清楚、补了测试之后单跑
这 5 个，**5 个全杀**。跑完源码逐字节还原干净，`data/` 里那三份一个字节没动。

第一轮那 5 个存活逐个查下来是这样：

| 存活的变异 | 查下来的结论 |
|---|---|
| 训练数据的条数报成新数据的 | **断言写松了**：只找「40 条」，可下面门槛松紧那句里也有「40 条历史」—— 数字换了照样绿。改成连着说「模拟历史，共 40 条」 |
| 待判断数据的条数报成历史的 | 同一类：只找「4 条」，而结论那句「4 条新数据里…」里也有。改成「new_samples.csv（4 条）」 |
| 结论那句话不过转义 | **真的漏了一道**：那句结论是 `ml.render_comparison()` 拼的，里面带着**从 CSV 读来的时刻**。凑一个把 `<b>` 落在 `ml._brief` 取的那 5 个字里的时刻，就能把一个标签注进报告。补了一条用例 |
| 「规则」「ML」两列的说法对调 | **测试的洞**：两句话都还在表里，只查「有没有出现」看不出顺序。补了一条「26/62 那一行的六格逐格对」 |
| 不用 `indent`（挤成一行） | **格式没测**：挤成一行照样 `json.loads`。这和 LF、末尾换行是一类东西（都是产物的格式），补了一条「缩进两格」 |

跑变异的时候有两条「默认路径」的变异（`DEFAULT_ML_JSON` 改成仓库根、改成
`report/ml.json`）被测试杀掉了 —— 但它们**真的往那两个位置各写了一份文件**，跑完
`git status` 里多了两个没跟踪的 JSON（已删）。顺着这条线还发现一个日常问题：
`tests/test_daily_summary.py` 里那两只端到端用例会**往仓库里那份
`report/ml_result.json` 重写一遍**（内容只差一个 `generatedAt`），已修，见下。

### 这一步对测试桩的改动

`tests/test_analysis.py` 146 → **189 条**（+43：新增 `TestMlSection` 18 条、
`TestMlSkipSection` 2 条、`TestMlResultJson` 16 条，`TestHtmlTable` +4 条、
`TestMain` +3 条）。`TestMlSection` / `TestMlResultJson` 用的桩不是手抄的字典，
是拿 `ml.compare_rows()` / `ml.find_mismatches()` / `ml.render_comparison()` 这几个
**真函数**造出来的（键名、布尔值、分数位数都跟 `run_ml()` 给的一样），
手抄一份的话迟早跟丢，而那时候测试还是绿的。

`tests/test_daily_summary.py` **条数没变**，但里面两只端到端用例改了：它们本来就
把趋势图和报告那两个产出路径指到临时目录，现在多指一个 `DEFAULT_ML_JSON` ——
不指的话，跑一次测试就往仓库里那份 JSON 重写一遍，`git status` 里永远挂着一个
「改过的」文件（仓库里那份的 `generatedAt` 也跟着变成「跑过测试的时刻」）。

**JS 那七个套件一行都没改** —— 这一步（写回报告那一半）没碰前端。
下面这一节才是前端那一半。

## Step 9-3 进阶项：看板读 ML 结果

需求里 9-3 的后半句是「把结果写进 `report/ml_result.json`，**让 Dashboard 用 `fetch`
读取**并显示『ML 辅助判断』」，括号里注明「（进阶，可选）」。这一节做的是它。

看板上多了一块面板，摆在「事件记录」和「消息日志」中间：

```
ML 辅助判断                              规则说正常、ML 说不同：2 条
│ 6 条新数据里，规则与 ML 不一致的有 2 条。规则判断为正常、ML 认为与历史
│ 明显不同的有 11:25（26 ℃ / 62 %）、11:30（29 ℃ / 72 %）。两种口径本来就
│ 会在这类数据上分岔……
  这一段判的不是看板上这些实时读数，是 new_samples.csv（6 条）；模型是拿
  dorm-a_history_sim.csv（40 条）训练的。它是 2026-09-29 19:51:44 那次跑
  analysis.py 留下的，不是实时数据。
```

### 为什么不干脆让看板自己判一遍

Isolation Forest 要装 scikit-learn、要读那两份 CSV，浏览器里两样都没有 ——
这是一条硬边界，不是偷懒。能落地的做法只有：**脚本跑一次、结果落成一份文件、
看板取过来显示**。

代价是那份 JSON 记的是**上一次跑脚本时**的快照。看板上别的数字都在跟着报文变，
只有这一块不动 —— 所以 `#ml-note` 里那句「判的不是看板上这些实时读数……不是
实时数据」是这一块的**地基**，不是客套话。删掉它，看的人第一反应就是把这张表的
结论安到旁边刚收到的温湿度上。测试专门钉着这句话里两处措辞。

### 三段字由 `logic.js` 拼，页面一个字都不拼

`buildMlNote(data)` 返回 `{count, text, note}`，`mlFetchFailed(reason)` 返回同样三样。
`dashboard.js` 那边只有一个 `renderMl()` 往 `<span>` / `<p>` 上摆，没有任何拼接 ——
和 `buildFocus` / `buildAlert` 是同一条规矩（措辞归纯函数，页面只负责摆放）。

两个连带的好处：

1. **成功、读坏、读不到走的是同一条渲染路径。** 三种情况返回的都是那三样，
   所以页面里没有「出错时要怎么摆」的第二套代码 —— 那套代码平时跑不到，
   出事的时候正好在现场演示。
2. **`text` 是从 JSON 里原样搬过来的。** 结论那句由 `ml.render_comparison()` 算一次、
   在两个地方渲染（`report.html` 和这里），看板自己再拼一份就等于埋下第二个说法。
   测试直接比「页面上那句 === `ml_result.json` 里那句」。

### 读不到的时候

`fetch` 有四种失败，最后都落到同一句降级话上（`mlFetchFailed`）：

| 情况 | 页面上写的是 |
|---|---|
| 文件不在 / 服务器没起（`Failed to fetch`） | `这一段没跑：读不到 report/ml_result.json —— Failed to fetch` |
| 页面不是从项目根目录起的服务器（404） | `这一段没跑：读不到 report/ml_result.json —— HTTP 404` |
| 回来不是 JSON（文件被占着写了一半） | `这一段没跑：读不到 report/ml_result.json —— Unexpected token < in JSON at position 0` |
| 是 JSON，但不是 `analysis.py` 写的那份 | `这一段没跑：report/ml_result.json 里没有 analysis.py 该写的字段（可能不是它写的，或者版本对不上）。` |

**原因原样贴出来，不翻译**：「HTTP 404」和「Failed to fetch」指向的是两条完全不同的
排查方向（前者查服务器目录，后者查脚本跑没跑）。下面那行小字告诉人跑
`py -3.14 analysis/analysis.py`。条数那格留空 —— 写个「0 条」看着像「一条都没差」，
那是句假话。

### 为什么用 `fetch` 而不是 `import` 一份 JSON 进来

`import data from '../report/ml_result.json'` 能少写几行，但它有两个毛病：
要么得加 import attributes（Safari 还不认），要么得改文件后缀；而且**打不开就是
整页白屏** —— 一份辅助结论读不到，不该把整个看板拖垮。`fetch` 失败还能 `catch` 住，
降级成一行字。

### 这一步对测试桩的改动

- `tests/logic.test.js` 304 → **337 条**（+33：导出清单 16 → 18，新增 K 段 32 条；
  跑变异时又补了 1 条，见本节末尾的「变异测试」）。
- `tests/dashboard.test.js` 420 → **445 条**（+25：新增 R 段）。
- 其余五个 JS 套件和整个 Python 侧一行没动（`py -3.14 -m unittest discover` 459 条照绿）。

假 `fetch` 这个桩有个讲究：它**不能直接把结果给出去**，而是把 `resolve` / `reject`
存进一个数组，让 R 段自己挑时候放行。因为这一段的验收点（读到了摆什么、404 摆什么、
回来不是 JSON 又摆什么）全都发生在 promise 回来**之后**，桩要是一调用就 resolve，
这些路径一条都测不到。放行之后还要等一轮 —— `await new Promise(r => setTimeout(r, 0))`：
`then` 排在微任务里，而 `setTimeout` 是宏任务，排在所有微任务后面，一轮就够。

R 段读的是**仓库里那份真的 `report/ml_result.json`**，不是测试手写的假 JSON：

```js
const ML_REAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'report', 'ml_result.json'), 'utf8'));
```

手写一份的桩在 `analysis.py` 改了字段名之后照样全绿，而真页面上会写「这一段没跑」——
那正是最该被抓住的一类改动。断言也一律跟着真文件里的数走（现在的 `mismatchForward`
是 2，写成 0 那条测试自己会变），`data/` 一改或脚本重跑一遍都不用改测试。

还有两处是假 DOM 逼出来的写法，都写在注释里了：

- **占位那句话（「正在读取 report/ml_result.json …」）写在 `index.html` 里**，
  假 DOM 读不到 HTML，所以那一条断言是拿文件查的（`/id="ml-text"[^>]*>正在读取/`）。
  它必须落在 `#ml-text` 里头，落到别处就白写了。
- **`ctx2`（L 段那个「要什么没什么」的上下文）也得给一个 `fetch`**，
  给的是「注定失败」那一个 —— 离线时浏览器的 `fetch` 就是这个反应。
  不给的话 `loadMlResult()` 会抛 `ReferenceError`，那一段测的就成了
  「少给一个桩会怎样」，而不是「什么都缺时页面还能不能起来」。

### 变异测试

40 个变异逐个塞回源码，确认测试变红，再还原（还原后两份源码 sha256 逐字节一致、
`data/` 与 `report/` 里的产物一字未动）。**40 个全部被抓住**，其中 1 个是补完测试
才抓住的，下面单独说。

和 8-1 那次比有两处改了做法：

- **每个变异跑 `logic.test.js` 和 `dashboard.test.js` 两个套件**，任一个红就算抓住。
  8-1 那个只跑「所属文件那一个」—— `logic.js` 的变异要是只被页面套件抓住，就会被
  记成存活，那是假存活。这一段的 R 段（页面）和 K 段（纯函数）本来就是对着同一件事
  的两层，分开跑没有意义。
- **锚点对不上单独报**。40 个锚点先干跑一遍（每处原文必须只出现一次），对不上的
  只报「锚点没对上」，不算进存活 —— 脚本自己错了不能记成测试的功劳。

| 变异 | 结果 |
|---|---|
| 降级那句话去掉「这一段没跑：」前缀 | ✓ logic 红 |
| `fileName` 不截路径（`C:\Users\...` 会印到页面上） | ✓ logic 红 |
| `fileName` 对空文件名不留「那两份文件」，留个空括号 | ✓ logic 红 |
| **`fileName` 不挡非字符串（`null` 印成 `null`）** | ✗ 存活 → 补测试后 ✓（见下） |
| `rowCount` 写不出来时印 `undefined` 而不是「若干」 | ✓ logic 红 |
| 少了 `mismatchForward` 时不判成「不是那份文件」（当成 0） | ✓ logic 红 |
| 形不对的判据里不看那个数（只看有没有结论那句） | ✓ logic 红 |
| 返回的三样对调（`text` 和 `note` 换位置） | ✓ logic 红 |
| 正向是 0 时也说「规则说正常、ML 说不同：0 条」 | ✓ logic 红 |
| 反向是 0 时也摆一句「规则说异常、ML 说正常：0 条」 | ✓ logic 红 |
| 两句之间用「、」连，不用「；」 | ✓ logic 红 |
| 正向那句 / 反向那句的措辞各改一次 | ✓ logic 红（两处各一次） |
| 一个都不差时那句换说法 | ✓ logic 红 |
| 没记时刻时不写「上一次」，写个占位话 | ✓ logic 红 |
| 没记时刻时照样拼「 那次」 | ✓ logic 红 |
| 说明里不再写「不是实时数据」 | ✓ logic 红 |
| **说明里把「判的不是看板上这些实时读数」说反** | ✓ logic 红 |
| 新数据 / 训练数据的条数报成对方的 | ✓ logic 红（两处各一次） |
| 读不到时不再带「这一段没跑：」前缀 | ✓ logic 红 |
| **读不到时条数那格写成「0 条」** | ✓ logic 红 |
| 读不到时不说怎么办（去掉「先跑一次…」那句） | ✓ logic 红 |
| 原因取不到时不留一句实话（页面出现 `undefined`） | ✓ logic 红 |
| `renderMl` 三行赋值：各换错一次、不摆条数一次 | ✓ dashboard 红（三次） |
| `mlCount` / `mlText` 的 `getElementById` 各指错元素一次 | ✓ dashboard 红（两次） |
| `ML_JSON_URL` 少写「../」 | ✓ dashboard 红 |
| `fetch` 的路径多带一截 query | ✓ dashboard 红 |
| 不看 `resp.ok`（404 时去读 `statusText`） | ✓ dashboard 红 |
| `resp.ok` 那次判断整个不做了 | ✓ dashboard 红 |
| 拿到 response 不取 `json()` | ✓ dashboard 红 |
| 读到的那份不交给 `buildMlNote` | ✓ dashboard 红 |
| **`catch` 整个不接** | ✓ dashboard 红 |
| 失败时不带原始原因（一律「读不到」） | ✓ dashboard 红 |
| **启动时不读那份 JSON** | ✓ dashboard 红 |
| **启动时读两遍** | ✓ dashboard 红 |

唯一活下来的是「`fileName` 不挡非字符串」：把那句
`typeof value === 'string' ? value.trim() : ''` 整个换成 `String(value)`，测试照绿。

这是**测试漏了**，不是函数写错了 —— 函数挡得对，只是没人证明。那条断言
（`文件名给空了就说「那两份文件」`）本来传了 `newFile: ''` 和 `historyFile: null`
**两个**值，却只断言了新数据那一半的 `那两份文件（6 条）`。`null` 那一半没人看，
于是页面上可以印出「拿 null（40 条）训练的」而测试一声不响。这和 7-4 那次
「不管按没按过都去写一次风扇」是同一类：**判断写了，断言只盖了一半。**

补法是让那条把两半都看住（`null` 和空括号 `（）` 一起挡），另加一条「文件名只有
空格时也算没给」，把 `trim()` 那一半也钉住。补完当场抓住，`logic.test.js`
336 → **337 条**。上面那张表里「补测试后 ✓」就是补完之后重跑的结果。

## Step D3：事件闭环（处理 → 验证 → 恢复）

D3 要的是一条**闭环**：节点异常自动开一条事件，人在前端点一下「开始处理」，
然后**由后续收到的数据自己判定到底好没好**。

```
   异常数据来               收到 handle 指令            后面连着 N 条正常
 ─────────────────► OPEN ──────────────────────► HANDLING ──────────────► RECOVERED
                    │                             │
                    │                             └── 后面连着 N 条还是异常 ──► UNRESOLVED
                    └──（这条事件已经开着，段里的后续异常不再另开）
```

状态机在 `events.py`，core 只负责叫它。两个数字（`recoverConsecutiveNormal`
和 `verifyConsecutiveAbnormal`）都在 `core/config.json` 的 `events` 块里，
**事件层不自己定门槛**。

### 四条红线落在哪一行

红线不能靠「记得别这么写」，得靠**结构上做不到**。所以每一条都在源码里
有个具体的位置，`tests/test_events.py` 的 `TestRedLine` 拿 `ast` 把这些位置
钉住了：

| 红线 | 落在哪 | 测试怎么盯 |
|---|---|---|
| 处理指令不能把事件改成 `RECOVERED` | `EventBook.apply_action()` 里对 `event.state` 只有一处赋值，而且是 `= HANDLING` | 抠出函数体，把所有对 `event.state` 的赋值列出来，必须正好是 `['event.state = HANDLING']` |
| 恢复只能由后来的数据判定 | `event.state = RECOVERED` 这个字符串**只出现在 `_close_recovered()` 里** | 全文件搜这个字符串：除 `_close_recovered` 外一处都不许有 |
| `_close_recovered` 不是谁都能叫 | 它只被 `observe()` 调用 | 搜 `_close_recovered(` 的调用点，必须只有 `observe` 那一处 |
| core 不越权改节点状态 | `Core.handle_command()` 里**一行都不碰 `self.nodes`** | 抠出 `handle_command` 的函数体，`self.nodes` 一次都不许出现 |

第四条是最要紧的：`handle_command` 拿不到 `NodeState`，就算想在指令里顺手把
节点标成「正常」也无从下手。**「处理中」不是节点的一个状态，是事件的一个状态。**

> 写这几条检查时踩了个坑：`apply_action` 的 docstring 里正好有一句
> 「这个方法一行都不碰 `self.nodes`」，于是这条检查**先把自己的说明文字抓了**。
> 假警报一次就够让人把整个检查注释掉，所以 `_function_body` 会先把函数自己的
> docstring 剥掉再查文本。

### 两处容易想岔的地方

**判据不能数存档里的条数。** 一开始 `UNRESOLVED` 是这么判的：看 `verify`
数组最后 3 条是不是都异常。这默认了「`eventsVerifyMax` ≥ 门槛」，而这两个数
是分开配的 —— 配置成 `eventsVerifyMax=2` / `verifyConsecutiveAbnormal=3`
时，第 3 条异常早就被挤掉了，于是怎么喂都判不出未恢复，`verify_dropped`
还一直是 0（连「丢过东西」这个线索都没有）。现在事件上挂了个运行期的
`pending_abnormal` 计数，**存档留多少条不参与判定**。
`test_pending_count_survives_the_cap` 就是拿 `verify_max=2, verify_after=3`
钉的，它当场把这个洞抓了出来。

**`verify_from` 记的是下标，不是条数。** 它是「从第几条验证数据之后开始算」，
在已经 `HANDLING` 的事件上再点一次 `handle`，只多记一笔 `actions`，
**不动 `verify_from`** —— 动了的话第二次点击会把验证窗口往后推，前面已经收到的
那些正常数据就白算了。

### 持久化：`data/events.json`

core 每有变化就写一次，写完 `os.replace` 原子换上去。开案 / 转处理中 / 结案这
三个时刻是**立刻**写（状态迁移丢了就说不清发生了什么）；验证数据一条一条地
**攒着**写，同一秒内只落一次盘 —— 一条进了「处理中」却迟迟结不了案的事件
（一直治不好那种，要等第 M 条异常才结案），中途收到的验证数据也都在文件里，
core 被杀掉也不会把「处理之后收了几条、都是什么」丢掉。

启动时 `load()` 读回来：

- 文件读不动 → 改名成 `events.json.bad` 再继续（**不覆盖**，那份是查问题的线索）
- 里面某几条坏了 → 跳过并报数，不因为一条坏的就丢掉整本
- **读到还没结案的事件，一律按 `UNRESOLVED` 收尾**，`result` 里写明是重启造成的

最后这条是必须的：不然它会在文件里永远挂着「处理中」，重启一次变一次，
而实际上谁也不知道那段时间里好没好。

看这份文件时按 `summary` 看全局，按 `events` 看单条。一条事件里值钱的是四样：
`verify`（处理之后收到的那些数据，一条不落地记着）、`verify_from`、
`snapshots`（开案 / 处理 / 结案三个时刻的现场）、`result`（最后那句人话）。

`data/events.json` **不入库**（`data/` 下其他 CSV 是输入，这个是产物）。

### 看板那个按钮接上了指令

Step 7-2 那个「开启风扇 / 通风」原本只改页面自己那四个字段。D3 之后它多了一件
事：**往 `dormmate/v1/cmd` 发一条 `handle`**，于是页面上按一下和
`send_cmd.py` 发一条走的是同一条路。

```json
{"nodeId":"dorm-b","action":"handle","source":"dashboard","time":"2026-09-22 20:21:00"}
```

四个字段各有各的理由：

| 字段 | 为什么是它 |
|---|---|
| `nodeId` | core 的第一道必填校验（`COMMAND_FIELDS`） |
| `action` | 小写 `handle`。core **不做大小写折叠**，发 `Handle` 会被拒，而且拒的理由是明写的不是静默忽略 |
| `source` | `manual`（`send_cmd.py`）还是 `dashboard`（人按的）。core 那行 `[指令] ... （dashboard）-> 接受` 就是拿它区分的 |
| `time` | **该节点最新那条报文的 `time`**，不是浏览器当前时间 —— 和 `actionTime` 取同一个值。三台机器的钟不一定对得上（和 7-1 算时长同一个理由），而且这样页面上那句「记在 20:21:00 这条数据上」和 core 事件里的 `actions[0].time` 说的是同一件事 |

**这条消息里没有任何一个「结论」字段。** 没有 `status`、没有 `state`、
没有 `result` —— 能说的只有「对哪个节点、干什么、什么时候」。这和
`events.py` 那条红线是同一个形状：不是「记得别写」，是前线**没有地方**写。
`tests/dashboard.test.js` 的 O2 段逐个数了这几个名字，塞任何一个进来都会红。

`retain` 一律 `false`（和 `send_cmd.py` 同一条理由）：指令是此刻发生的动作，
留着的话下次 core 一启动就先把这条半小时前的 `handle` 又收一遍，日志里于是
冒出一个没人按过的动作。

**发不出去的时候页面照旧算「处理中」，但那行说明会如实讲清楚。** 本地那四个
字段和 core 的事件是两回事，`sendHandle()` 返不返回成功都不改它们 —— 而
`#cmd-note` 会写「这条指令没发出去（还没连上 broker）……core 那边的事件不会变」。
少了这一行，没连上的时候页面上看不出任何区别，看起来就是「按了没反应」。

### 真机验过（这一条是假 mqtt 桩测不到的）

`dashboard.test.js` 里的 `mqtt` 是**假**的 —— 桩上有 `publish`，但它只记录参数，
从来不检查这个调用形状对不对。也就是说 `client.publish(topic, text, {qos, retain})`
**这一行本身没被任何测试验过**：真 mqtt.js 的签名要是变了（v5 起就是
`publish(topic, message, opts)`），测试照样全绿，而真页面上按下去什么都不会发生。

所以这一条得拿真页面验。headless Edge 打开
`http://localhost:8000/dashboard/`，**在页面里真的点一下那个按钮**，读回来的：

```
selected       : dorm-b
conn           : 已连接
disabledBefore : false
stateBefore    : （空 —— 还没处理过）
noteBefore     : （空 —— 还没按过）

按下去之后：
noteAfter      : 已通知 core 开始处理这条事件 —— 好没好由后面收到的报文判，这一步不结案。
stateAfter     : 处理中｜风扇已开启（记在 2026-09-22 20:21:00 这条数据上） · 还没收到动作之后的数据
cardAction     : 处理中｜风扇已开启
consoleLines   : ["[DormMate] 发出 MQTT 指令 dormmate/v1/cmd
                   {\"nodeId\":\"dorm-b\",\"action\":\"handle\",\"source\":\"dashboard\",\"time\":\"2026-09-22 20:21:00\"}"]
```

另外一个**独立**的订阅者（不是 core，是另起的 `paho` 客户端）在 `dormmate/v1/cmd`
上收到的原始字节，和 core 那行日志：

```
[WIRE] topic=dormmate/v1/cmd qos=1 retain=False
       payload={"nodeId":"dorm-b","action":"handle","source":"dashboard","time":"2026-09-22 20:21:00"}
[指令] dorm-b handle（dashboard）-> 接受：dorm-b-20260922-202000 转「处理中」，等后续 3 条异常 / 3 条正常来判
```

**页面自己没结案**：`recovered_at` 还是 `null`、`verify` 还是空的；补 3 条正常读数
之后（20:22 / 20:23 / 20:24），`data/events.json` 里那条才变成
`RECOVERED`、`recovered_at` 是 `20:24:00`。

> **怎么驱动这一遍**：用 CDP，不用 `--virtual-time-budget`。
> `msedge --headless=new --remote-debugging-port=9222 <url>` 起一个，
> 再用 Node 连上去 `Runtime.evaluate` 那段探测代码（Node 22 起有全局
> `WebSocket`，一个依赖都不用装）。
> Step 7-2 那节「真机验过」记的两个坑 —— 虚拟时钟烧掉 `setTimeout`、
> `publish` 不算「还有请求在飞」所以要拿一个 fetch 当节拍器 ——
> 都是虚拟时钟的副作用。CDP 这边跑的是**真实的钟**：`await sleep(250)` 就是
> 真的等 250 毫秒，探测代码里那些「等到按钮可点」的轮询写起来是直白的，
> 不需要任何节拍器。**下次要验一个「要等网络」的行为，直接走 CDP。**

### 变异测试

5 个变异逐个塞回 `dashboard.js`，确认测试变红，再还原：

| 变异 | 结果 |
|---|---|
| 删掉 `sendHandle()` 那一行（按钮不再发指令） | ✓ dashboard 红 **16 条** |
| `retain: false` 改成 `true` | ✓ dashboard 红（那一条） |
| `time` 无条件带上（空串照样发） | ✓ dashboard 红（那一条） |
| `payload` 里塞一个 `status: '已恢复'` | ✓ dashboard 红 **3 条**（键的名单、结论字段、空 `time` 那条） |
| 清空时不清 `#cmd-note` | ✓ dashboard 红（那一条） |

第一条（删掉发指令那一行）**第一次跑只红了 4 条，然后抛异常**：`cmd` 成了
`undefined`，下面取 `cmd.topic` 就炸，后半段十几条检查连带整个文件都不跑了 ——
看到的只有一个堆栈，反而不知道坏在哪。所以取发出去的那条时写了
`|| {}`，缺了就当空对象，**每条各自 FAIL**。补完之后同一个变异红 16 条、
全程不抛 —— 「测试崩了」和「测试说这里错了」是两件事，前者会把真正的问题藏起来。

### 复现操作

```bash
# ① 清掉 retained：上一次跑剩下的最后一条读数会在 core 一订阅上就送过去，
#    看起来就像「凭空多了一段异常」，而且时间是上一次的墙上时间。
py -3.14 -m simulator.publish_one --node dorm-a --clear
py -3.14 -m simulator.publish_one --node dorm-b --clear
py -3.14 -m simulator.publish_one --node dorm-c --clear
rm -f data/events.json

# ② 起 core（另开一个终端）—— 它会订 telemetry 和 cmd 两个 topic
py -3.14 core.py

# ③ 跑剧本（再开一个终端）：两幕，dorm-b 处理→恢复、dorm-c 处理→未恢复
py -3.14 -m simulator.simulator --script simulator/scenarios/d3_event.json
```

只想手动演一幕也行 —— 剧本里那两个 `handle` 帧换成这条命令就相当于「前端按下了
按钮」，区别只在 `source` 字段（`manual` 而不是 `dashboard`）：

```bash
py -3.14 -m simulator.send_cmd --node dorm-b --action handle
py -3.14 -m simulator.send_cmd --node dorm-b --action handle --dry-run   # 只看要发什么
```

每一行都带一个**墙上时间**的前缀（就是 `core.py` 打这条日志的当下，不是报文里的
`time` —— 两个时间不是一回事，看的时候别混）：

```
[2026-09-30 13:41:02] [事件] 开事件 dorm-b-20260922-200000（连续偏热），待处理
    ← 20:01、20:02 那两条偏热一声不响：事件已经开着，段里的后续异常不另开
[2026-09-30 13:41:05] [指令] dorm-b handle（script）-> 接受：dorm-b-20260922-200000
                       转「处理中」，等后续 3 条异常 / 3 条正常来判
[2026-09-30 13:41:06] [事件] dorm-b-20260922-200000 验证中：这条 正常，再连续 2 条正常就判恢复
[2026-09-30 13:41:07] [事件] dorm-b-20260922-200000 验证中：这条 正常，再连续 1 条正常就判恢复
[2026-09-30 13:41:08] [事件] dorm-b-20260922-200000 -> RECOVERED：处理后连续 3 条正常，已恢复（验证数据 3 条）
[2026-09-30 13:41:09] [事件] 开事件 dorm-c-20260922-200600（连续偏湿），待处理
[2026-09-30 13:41:12] [指令] dorm-c handle（script）-> 接受：dorm-c-20260922-200600
                       转「处理中」，等后续 3 条异常 / 3 条正常来判
[2026-09-30 13:41:13] [事件] dorm-c-20260922-200600 验证中：处理后连续第 1/3 条异常（偏湿）
[2026-09-30 13:41:14] [事件] dorm-c-20260922-200600 验证中：处理后连续第 2/3 条异常（偏湿）
[2026-09-30 13:41:15] [事件] dorm-c-20260922-200600 -> UNRESOLVED：处理后连续 3 条依旧异常（最后一条 偏湿），事件未恢复
```

`data/events.json` 里就是一条 `RECOVERED`、一条 `UNRESOLVED`。

`RECOVERED` / `UNRESOLVED` 是 `event.state` 的原值，直接印出来的 ——
和文件里那份对得上，截图时不用在两套叫法之间换算。日志的 kind 这一轮只多了
`[事件]` 和 `[指令]` 两种，想筛出 D3 有关的就 `grep '\\(\\[事件\\]\\|\\[指令\\]\\)'`。

**真按下按钮**的那一遍（这一步要证明的是前端，所以得用真页面、真 mqtt.js）：

```bash
# ① 起静态服务器（看板走 ES 模块，file:// 打不开）
py -3.14 -m http.server 8000

# ② 打开看板，点 dorm-b 那张卡片，再按「开启风扇 / 通风」
explorer.exe http://localhost:8000/dashboard/

# ③ 想看线上的原始字节就再开一个终端订阅这条 topic（换成 MQTTX 也一样）
mosquitto_sub -h localhost -p 1883 -t 'dormmate/v1/cmd' -v
```

点下去之后三处同时看得到同一条消息：

```
浏览器 Console   [DormMate] 发出 MQTT 指令 dormmate/v1/cmd
                 {"nodeId":"dorm-b","action":"handle","source":"dashboard","time":"2026-09-22 20:21:00"}
看板那行小字     已通知 core 开始处理这条事件 —— 好没好由后面收到的报文判，这一步不结案。
core 终端        [指令] dorm-b handle（dashboard）-> 接受：dorm-b-20260922-202000
                          转「处理中」，等后续 3 条异常 / 3 条正常来判
```

core 那行括号里的 `（dashboard）` 就是 `source` 那个字段 —— 和剧本跑出来的
`（script）`、`send_cmd.py` 跑出来的 `（manual）` 摆在一起，一眼看得出这条指令
是谁发的。**这会儿 `data/events.json` 里那条事件还是 `HANDLING`、`recovered_at`
还是 `null`**，要等后面真的来 3 条正常读数才会变。

### 自测清单

1. 清完 retained、删掉 `data/events.json`，跑剧本 —— core 日志里**第一条事件
   的开案时间是 `20:00:00`**（剧本里的时间），不是今天的墙上时间。
   是墙上时间的话说明 retained 没清干净。
2. 剧本跑完，`data/events.json` 的 `summary` 是
   `{"OPEN": 0, "HANDLING": 0, "RECOVERED": 1, "UNRESOLVED": 1, "total": 2}`。
3. dorm-b 那条：`state` 是 `RECOVERED`、`recovered_at` 是 `20:05:00`、
   `verify` 正好 3 条且全是正常、`snapshots` 三条（开案 / 处理 / 结案）。
4. dorm-c 那条：`state` 是 `UNRESOLVED`、`recovered_at` 是 `null`（**不是空串**）、
   `verify` 3 条全是偏湿。
5. 单独按一次 `send_cmd --node dorm-b --action handle`（dorm-b 现在正常）：
   日志里**没有**「未恢复」也没有「已恢复」—— 没有开着的异常段时，指令不该
   凭空造出一条事件。
6. 把 `core/config.json` 里 `events` 整块删掉再起 core：**拒绝启动**并说清是
   哪一块缺了，不是带着默认值悄悄跑起来。
7. `py -3.14 -m unittest tests.test_events` → 145 条通过。
8. 浏览器里按一次按钮：Console 出现 `[DormMate] 发出 MQTT 指令`，
   core 那行是 `（dashboard）-> 接受`。**`source` 是 `dashboard`** ——
   写着 `manual` 说明发出去的是另一条路（比如 MQTTX 里手动发的），
   写着 `script` 是剧本发的。
9. 按完之后立刻看 `data/events.json`：那条事件的 `state` 是 `HANDLING`、
   `recovered_at` 是 `null`、`verify` 是空数组 —— **按一下什么都没结案**。
10. 把这个页面的网络掐掉（或先不点「连接」），再按一次按钮：卡片上照样写
    「处理中｜风扇已开启」，但下面那行小字写着「这条指令没发出去（还没连上
    broker）」—— 两件事分得清清楚楚。恢复了连接再按，那行字换成「已通知 core」。
11. `node tests/dashboard.test.js` → 481 条通过、`node tests/logic.test.js` → 408 条。

### Evidence 证据建议

| 证据 | 怎么留 |
|---|---|
| 状态迁移图 | 剧本跑完那一段 core 日志（`[事件]` 那七行）整段截图，**带上时间戳** |
| 恢复是数据判的，不是按钮判的 | **同一个 `event_id`** 的三张快照：开案（`OPEN`）→ 收到 handle（`HANDLING`）→ 后面第三条正常（`RECOVERED`）。同一个 id 是关键，说明是**一条**事件走完的，不是三条各走一步 |
| 未恢复那一幕 | dorm-c 那条的 `verify` 三条全是偏湿 + `result` 那句话一起截 |
| 落盘 | `data/events.json` 全文件截图，`summary` 和两条事件的 `state` 都要在框里 |
| 前端没资格改状态 | `py -3.14 -m simulator.send_cmd --node dorm-b --action handle` 发完之后，`data/events.json` 里那条事件**还是 `HANDLING`**（没有 `recovered_at`）—— 这条最能证明红线 |
| 重启不留悬挂 | core 跑完一幕、**在处理中**按 Ctrl-C 掉，再起一次 core：日志里那条事件按 `UNRESOLVED` 收尾，`result` 里写明是重启 |
| 前端真的发了那条指令 | 浏览器里按一次按钮，把**浏览器 Console**（`[DormMate] 发出 MQTT 指令` 那行）和 **core 终端**（`（dashboard）-> 接受` 那行）**截在同一张图里**。单截 core 的话，看不出这条是浏览器发的还是 MQTTX 发的 —— `source` 那三个字母就是干这个用的 |
| 按一下不等于结案 | 按完按钮**立刻**截 `data/events.json`：`state` 是 `HANDLING`、`recovered_at` 是 `null`、`verify` 还是空的。这一张和后面「3 条正常之后 `recovered_at` 有值」那张是**同一个 `event_id`** |

### 这一步对测试桩的改动

`tests/test_core.py` 里两条断言跟着变了，都是**故意的**：

- `test_snapshot_shape`：快照的 `counters` 多了 `commands` / `commandRejected`
  两个计数。钉死整份字典（而不是只查某个键在不在），是为了让「悄悄往快照里加
  字段」这种改动**必须显式改一次测试** —— 前端 `dashboard.js` 是照着这组键名
  取的，无声加字段等于无声改协议。
- `test_on_connect_subscribes_and_announces_online`：现在订的是
  `[(TOPIC_PATTERN, QOS), (CMD_TOPIC, QOS)]` **两个** topic。只查第一个的话，
  哪天有人把第二行删了，指令这条路会静悄悄地断掉而测试全绿。

`tests/test_core.py` 用的是假客户端，走的是真的 `on_message` 那条路，所以
`on_message` 里那个「全等分路」的判断被真跑到了。

## Step D4：故障注入

D4 要的不是「能发一条坏数据」，是**证明坏数据真的被拦住了、并且是因为对的原因**。
所以这一步交出来的是一条命令：

```bash
py -3.14 -m simulator.inject_faults            # 九条全发 + 当场核对
py -3.14 -m simulator.inject_faults --list     # 只打清单，不连 broker
py -3.14 -m simulator.inject_faults --only 3 --only 5
py -3.14 -m simulator.inject_faults --dry-run  # 打印要发什么，不连 broker
```

跑之前把该起的起好：Mosquitto → `py -3.14 core.py` → 看板。脚本自己会订
`dormmate/v1/log/reject`，每发一条就核对该不该被拒、理由对不对，最后打一张表：

```
核对结果
  PASS  #0 正常对照
  PASS  #1 非法 JSON
  ...
9/9 条符合预期
```

**core.py 没在跑的话这张表会全红**，不会假装绿 —— 那正是它的用处。

### 九条各打哪儿

| # | 故障 | 谁挡 | 留下什么 |
|---|---|---|---|
| 0 | 正常对照（25℃ / 60%） | 谁都不挡 | 看板 dorm-b 那张卡刷新 |
| 1 | 非法 JSON | core 第 2 道判据 | reject：`JSON 解析失败：…` |
| 2 | 合法 JSON 但缺字段 | core 第 4 道 | reject：`缺少 temperature；缺少 humidity；…` 逐条列 |
| 3 | topic 里的节点和报文里的对不上 | core 第 8 道 | reject：`topic 里是 dorm-a，报文里是 dorm-b，拒收` |
| 4 | 未知节点 `dorm-z` | core 第 7 道 | reject：`未知节点 'dorm-z'，配置里只有 [...]`；看板另记一条「未知节点」 |
| 5 | 数值离谱（99℃ / 200%） | **没人挡** | `[数据] dorm-c 99℃/200% 偏热` —— 见下 |
| 6 | 顶层不是对象（`[1,2,3]`） | core 第 3 道 | reject：`payload 顶层不是对象（收到 list）` |
| 7 | topic 形状不对（三段） | **core 收不到** | 什么都不留 —— 见下 |
| 8 | 清 retained 的空报文 | 哪道判据都不算 | core 打一行 `[保留]`，`counters.retainedCleared` 加一，**不发 reject** |

### 三个「和大家以为的不一样」

**第 5 条不算坏报文。** 99℃ / 200% 会被如实收下、如实判成偏热，看板上那张卡
真的会显示 99℃。九道判据管的是「这是不是我们要的那种数据」——形状、类型、
来路；**不管这个数在物理上合不合理**，`core.py` 里一行范围校验都没有。要拦的话
得先定下来「合理范围」是哪个范围、超了算拒收还是打标，那是另一套需求。手动录入
那一侧有 -20~60℃ / 0~100% 的校验，因为那是人手打的字，打字会打错。

**第 7 条 core 根本收不到。** core 订的是 `dormmate/v1/nodes/+/telemetry`，`+`
只匹配一层，而 `dormmate/v1/dorm-a` 只有三段 —— 这条落在订阅之外，core 连
「拒绝」的机会都没有。所以**第 1 道判据（topic 形状）在真链路上演示不出来**，
只有直接调 `core.validate_message` 才测得到（那在 `tests/test_core.py` 里）。
**这不是漏洞**：core 要是订成 `dormmate/#`，任何人在 broker 上发的测试话题都会
灌进来。清单里这一条标的是 `[不投递]`，跑起来会明说「没人拒收（正确：这条落在
core 的订阅之外）」，不会让人去找一条根本不存在的 reject。

**两个前端对「未知节点」的处理不一样，这是设计如此。** `dashboard/dashboard.js`
里有一份节点名单，遇到 `dorm-z` 记一条「未知节点」不画卡；`web/script.js` 没有
名单，来什么画什么。看板是三节点横向对比、版面就是三张卡，多一个没地方放；
`web/` 订阅通配符、来几个画几张卡。`tests/test_inject_faults.py` 拿源码把这条
差异钉住了 —— 哪天有人给 `web/` 也加了名单，那条会红，提醒顺手改文档。

### 为什么要核对，不是光发

「reject 上有三条」和「这三条都因为对的原因在那儿」是两件事。脚本比的是
**topic + payload 全文**加理由里的关键词：

* 只数条数的话，连着跑九条时「第 2 条没被拒、第 3 条被拒了两次」总数照样对得上；
* 第 3 条该因为「topic 里是 dorm-a」被拒，要是它其实死于 JSON 写坏了，光看条数
  也看不出来 —— 而演示时那句理由是当着人念出来的。

那份清单还是**唯一一份**：`tests/test_inject_faults.py` 把同一条清单逐条喂给
`core.validate_message`，所以「脚本以为 core 会怎么判」和「core 真的怎么判」
不会各说各话。

### 一个真踩到的坑

订阅是**异步**的：`subscribe()` 返回只代表请求发出去了，broker 那边还没认。
不等它生效就发第一条，那一条的 reject 会在订阅生效前发出来 —— 收不到，
然后被报成「core 没拒收」。core 其实拒了。这种假警报只在慢机器上出现，最难查，
所以 `Watch.open()` 在 `on_subscribe` 上压了一个 Event，等它真的订上再往下走。

### 测试

`tests/test_inject_faults.py`，**37 条，不连 broker**（连真 broker 的那种自检是
脚本自己的 `--verify`）。详表见上面 ⑱ 那一行。

## 已知限制

分三类：**设计如此**（当前步骤就有意不做）、**还没做**（后续步骤补）、
**环境依赖**（不是 bug，但很容易被当成坏了）。

### 设计如此

| 限制 | 原因 |
|---|---|
| 刷新页面后「录入历史」清空 | 只存在内存里，**有意不落 localStorage**（本步骤的约定）。要留存就刷新前先点「导出 CSV」 |
| 「最近消息」表只显示最新 20 行 | 表太长会拖慢渲染。内存里仍留 2000 条，超了从头丢；只覆盖 MQTT 收到的消息，和「录入历史」是两套数据 |
| 刷新后要等下一次发布才出卡片 | 消息没有设 retained，新连上的页面拿不到历史值，得等模拟器下一个周期（默认 5 秒） |
| 摄像头只保留最后一张快照 | 每次拍照覆盖上一张，不做连续采集，视频帧也不留在内存里 |
| 语音指令是**字面包含**匹配 | 必须说出「拍照」这三个字，说「拍张照」「照相」都不算。识别引擎会带出标点和语气词所以不能整句相等，但也没做同义词表 |
| 两个页面对报文里 `status` 的信任程度不一样 | `web/` 以**发布端发来的 `status` 为准**，不重算（只有「手动录入」那一份不经过发布端，才用 JS 规则算）；`dashboard/` 反过来，**一律用 `judgeStatus` 复核**，和报文里写的不一致就记一条警告、并以规则算出的为准。这是两个步骤各自定下的约定，不是哪边漏改了 —— 但看数据时得知道自己在哪个页面上：认规则结果的是 `dashboard/`，`web/` 是发布端说什么就显示什么 |
| 规则有两份实现，必须手工同步 | `status_rules.py`（Python）和 `shared/rules.js`（JS）各一份，没有自动同步机制。不同步的后果是报告顶部出现红色横幅（见排查表） |
| MQTT 允许匿名连接 | `allow_anonymous true` 是课程演示配置，**切勿照搬到公网**。这也是 `open_firewall.bat` 故意不放行 1883 的原因 |
| 3D 视图不跟着深色模式变 | `scene.js` 里的背景色和灯光色是写死的（那是宿舍该有的颜色，不是 UI 主题），所以看板切到深色时 3D 那块仍是浅色的。要跟就得把 `LOOK` 表再拆一套深色值 |
| 看板上的「ML 辅助判断」只有结论那一句和一个条数，没有那六行对照表 | 看板是**扫一眼**的地方，六行对照表（宿舍 / 温度 / 湿度 / 固定规则 / ML 判断 / 分数，不一致的行还高亮）归 `report.html` —— 那是要坐下来看的东西。这也是 8-3 定下的分工在 C 部分的延续：同一个结论，看板给一句，报告给完整的一笔。要摆表的话，`report/ml_result.json` 里 `rows` 那一段本来就是给这个留的（每行带着 `mismatch` 标记） |
| 看板上「ML 辅助判断」那一块是**快照**，不跟着报文变 | 它读的是 `report/ml_result.json`（上一次跑 `analysis.py` 时写下的），不像旁边那些数字每来一条报文就重算。这是这一步的取舍，不是漏做：ML 要装 scikit-learn、要读 CSV，浏览器里两样都没有。**页面上必须写着这层意思**（`#ml-note` 里那句「判的不是看板上这些实时读数……不是实时数据」）—— 删掉那句话，看的人就会把这张表的结论安到刚收到的温湿度上 |
| 报文没有乱序保护 | `latest` 一律被**最后收到**的那条顶掉，比的是到达顺序而不是 `time` 顺序。重发一条旧数据，卡片上的读数就会退回去、连续异常的时长会缩到 0（`abnormalDuration` 对负值返回 0，所以不会显示成负数）。处理动作那边不受影响：`nextHandling` 要求**严格晚于** `actionTime` 才认，一条迟到的旧数据改写不了「处理好了没有」。真要做就得给每个节点加一条「`time` 不比 `latest` 新就只进历史」的闸 —— 现在故意不做，因为演示里数据源只有一个，重复投递多半是人为的，看得见反而好排查 |
| 3D 场景的状态切换是瞬间到位的 | 开窗角度和风扇转速都不做缓动。按钮点下去要立刻看到变化，而且立刻到位让「打开了吗」「转了吗」一眼可验、也好写测试。想要柔和一点就在动画循环里让 `rotation.y` 朝目标值逼近 |
| 「语音提醒」**不自动念**，要手动点 | 自动念的话每来一条报文就念一遍（模拟器默认 5 秒一条），那是骚扰不是提醒；而且浏览器普遍要求语音合成由**用户手势**触发，自动念本来也会被拦。所以它是个按钮 |
| 3D 里「谁是当前重点」只表现为那圈环，画面本身不跟着切 | 场景跟的是「当前选中的宿舍」，这条规则从 6-3 起没变过（收到别的节点的报文时 3D 一次都不许被调）。环只回答「眼前这间是不是重点」：换重点但不换选中项时，环亮或灭，画面一动不动 |
| `data/` 里那三份演示数据**删掉也能跑**，但会少掉一批把关 | `day_sim.csv` / `dorm-a_history_sim.csv` / `new_samples.csv` 都是**跟着仓库走的固定产物**，删掉之后 `TestSampleDayFile` / `TestHistoryAndSamplesFile` 会 skip（不算失败 —— 「演示数据可以没有」）。代价是「文件和生成脚本对得上」这道没人管了：Step 9-1 那 41 个变异里，一多半正是靠逐字节比对才被杀掉的 |
| ML 那句「与历史明显不同」门槛偏松 | `contamination='auto'` 不指定异常比例，门槛不落在历史那片云的外沿上：拿模型回看它自己学过的 40 条历史，其中 **18 条**也会被判「与历史明显不同」（命令行每次都打印这个数）。所以那句要读成「落在门槛的另一侧」，不是「这条读数离谱」—— 11:25 那条分数 -0.0564 刚过线，一半是数据一半是这个门槛。要更严格就把 `contamination` 写成一个具体比例，Step 9-2 按需求原样保留 `auto` |
| `load()` 现在拒收温湿度列里的非数字格 | 判据是「**能直接比大小**」，所以带引号的 `'25'` 也拒收（虽然它转得成数字）。空着可以（缺失单独算一档）。这是有意的：不拦的话 `不热` 会一路走到 `rules.judge_status`，在 `temperature < 18` 那行崩成一个看不出哪一行哪一列的 `TypeError`；拦在这里，analysis / daily_summary / ml 三条路都受益 |
| **core 不做范围校验**，99℃ / 200% 会被如实收下 | 九道判据管的是「这是不是我们要的那种数据」（形状 / 类型 / 来路），不管这个数在物理上合不合理 —— 所以 D4 第 5 条发出去之后，看板上 `dorm-c` 那张卡真的会显示 99℃ / 200% / 偏热，reject 上一条都没有。要拦得先定下来「合理范围」是哪个范围、超了算拒收还是打标（那就不该叫拒收），是另一套需求。手动录入那一侧有 -20~60℃ / 0~100% 的校验，因为那是人手打的字，打字会打错 |
| 恢复判据两边还不一样：`core.py` 要连续 3 条正常，`dashboard/logic.js` 一条正常就结束 | **有意留着**，不是漏改。Phase2 先把「唯一业务大脑」立起来，前端这一轮还没改成读 core 那份 retained 快照（`dormmate/v1/state`）。等前端读了快照，状态机就只有一份，这个分歧自然消失。在那之前，同一个宿舍在同一时刻可能有两个说法 —— 所以演示时以 core 的终端和 `dormmate/v1/state` 为准，看板那一栏暂时只当个参考 |
| 前端还没读 `dormmate/v1/state` | 同上：Phase2 先把「谁说了算」定下来（core 发布、前端渲染），前端接线是下一步。现在 core 发了没人读，快照的用处是用 MQTTX 订阅来核对结论 |
| 事件（D3）现在只落盘 + 打日志，**快照里还没有它** | `dormmate/v1/state` 的字段是 Phase2 定下的协议（`tests/test_core.py` 的 `test_snapshot_shape` 是整份字典钉死的，加字段必须显式改一次测试），往里塞一截事件数据等于改协议；而 D3 这一轮的活儿是状态机和闭环本身。要看事件就开 `data/events.json`，或者看 core 终端那几个 `[事件]`。看板显示事件列表是下一步 |
| 「处理中」是**事件**的状态，不是节点的状态 | 节点那边只有「这一段现在是不是异常」，从来没有多过「处理中」这一档。前端按一下按钮，core 记的是「这条事件开始验证了」，而 dorm-b 那个节点的 `status` 该是偏热还是偏热、该不该参与优先排序也不受影响。两套状态混成一套的话，「处理中」会被当成一种环境状况去和「偏湿」比严重度 —— 那是两个维度的事 |
| 前端那条指令和 core 那边的事件，**是两本账** | 按一下按钮同时发生两件事：页面自己记一条事件（`renderEvents` 那张表 + 导出的 CSV），core 把 `data/events.json` 里那条推进 `HANDLING`。两边的开案时刻、结案判据、ID 形状都不一样（页面那个是本地算的，core 那个是 `节点-日期-时刻`），**对不上是正常的**。看板还没读 core 的事件（见上面那条），所以演示时以 core 的终端和 `data/events.json` 为准。好处是前端那本书在 core 没起的时候照样能用 —— 这是两本账存在的理由，不是漏做 |
| 「指令发出去没有」这件事，页面上只留最后一次的结果 | `#cmd-note` 里写的是**最近一次**按按钮的结果，不是一条流水（换个节点再按一次就覆盖了）。要一条一条看就开 Console —— 每次发都打一行。清空时那行字也一并擦掉：它是上一次按的结果，不是「现在」的状态 |
| 点多少次「开始处理」都不改结局 | 连点 N 次只是多记 N 笔动作（`accepted: false`，note 里写明），**验证窗口一次都不重置**。重置的话，连点几下就能把「连续 M 条依旧异常」那条判据一直往后推，事件永远判不出未恢复，验证环节就等于白设了 |
| 事件里的 `verify` 和 `snapshots` 都有上限，满了丢**最老**的 | `eventsVerifyMax` / `eventsMax` 管的是**存档留多少条**，不参与判定 —— 判定看的是运行期的计数（原因见 Step D3 那节「判据不能数存档里的条数」）。开案那条快照永远留着：丢了它就看不出这件事从头到尾持续了多久 |
| 「已恢复 / 未恢复」两个词在日志和 JSON 里都是英文原值 | `RECOVERED` / `UNRESOLVED` 直接照 `event.state` 印，不另起一套中文说法。对着一份文件和一个终端截图时不用在两套叫法之间换算 |
| core 一启动就会收到 retained 的最后一条读数，把它当成当前数据 | `RETAIN=True` 是为了「后开的看板立刻看到数值」，代价是 core 也照收 —— 它在协议上分不出这条是三小时前的还是刚发的（`time` 字段可以看出来，但 core 没有拿它去做新鲜度判断，因为剧本里的时间**故意**是写死的过去时刻，一查就会把整个演示机制否掉）。所以跑剧本前要先清 retained，见 Phase2 那一节的步骤 |
| 清 retained **不会**清掉 core 的内存 | `--clear` 发的那条空报文只记一笔（`counters.retainedCleared`），**不动节点**：已经在跑着的 core 里，那个节点已有的历史、开着的那一段、离线计时都照旧。它是「broker 存的那份删了」，跟这个宿舍现在的状况没有关系 —— 拿它去结算一段，等于凭一条和读数无关的消息改业务结论。所以复现步骤写的是「清完 retained **再起** core」：要的是新起的那个进程订阅时读不到旧值，而不是让跑着的那个忘掉什么 |
| core 没有乱序保护，和前端那条限制是同一个 | `latest` 一律被最后收到的那条顶掉。剧本里同一个节点的时间必须是递增的（`tests/test_scenarios.py` 有一条守着），因为倒着来的时间会让「持续了多久」算出负数被夹到 0 —— 不报错，只是数字变得没意义 |
| 一个节点一段异常里从偏热漂到偏湿，理由说的是**最近**那条异常 | 「已连续偏热 7 分钟」里的状态取的是这一段**最后一条异常**的状态，不是最早那条、也不是峰值。取最早那条的话，段里早就漂到偏湿了、理由还在说偏热；取峰值则要额外定义「差不多严重时怎么办」。三种都有道理，这里选了最好解释的那一种 |
| `web/` 和 `dashboard/` 的语音合成各写了一份 | 两页不共用代码：`web/` 是"说一句朗读"，`dashboard/` 是一个按钮，各自十来行 DOM 接线。抽成共享模块要再加一个跨页面的依赖，而这个项目里共享的只有 `shared/rules.js` —— 那是因为**规则算错了不报错**，代价完全不同。两处各有测试盯着（⑤ 和 ⑦），跟「规则有两份实现」不是一回事 |
| `handle` 这个协议串在两种语言里各写了一份 | JS 那边是 `dashboard.js` 顶上的 `CMD_TOPIC` / `CMD_ACTION`，Python 那边是 `config.CMD_TOPIC` / `events.HANDLE`，中间没有交叉校验 —— 写错一个字母就是「按了没反应」（而且不报错，core 那边只会说「未知 action」）。这和「规则有两份实现」不一样：规则是**算错了不报错**，这里是**接不上不报错**。`dashboard.test.js` 只能钉住 JS 那一份的字面量（`'dormmate/v1/cmd'` 逐个点名，字符串一改就红），钉不住两边相等。真接上了没有，只有拿真页面按一次才算数（见 Step D3 那节「真机验过」） |
| 假 `mqtt` 桩**不校验** `publish` 的调用形状 | `dashboard.test.js` 里的客户端是桩：有 `publish`，但它只把参数记下来，不检查签名对不对。所以「真 mqtt.js 收不收这个 `(topic, message, opts)`」这件事，**测试全绿也说明不了**。这不是能靠加断言补上的（补了也还是桩），只能拿真页面验一次 |
| 没连上 broker 时，页面照旧把这次处理记成「处理中」 | 本地那四个字段和 core 的事件本来就是两回事，`sendHandle()` 成没成功都不改它们。代价是页面上会出现「卡片说处理中、core 那边什么都没有」，所以 `#cmd-note` 那行字是必须的 —— 不说的话就是「按了没反应」，而且看不出是哪一半没反应 |
| 指令里的 `time` 是**最近一条报文的时刻**，不是按按钮那一刻 | 和 `actionTime` 取同一个值（三台机器的钟不一定对得上，见 7-1）。代价：如果这个节点已经 20 分钟没来新数据，core 事件里 `actions[0].time` 就是 20 分钟前那个时刻。演示里数据 5 秒一条，看不出来；真拿旧数据做演示时要知道这件事 |

### 还没做

| 限制 | 卡在哪 |
|---|---|
| 同一份 `--all-nodes` 起两次会互相顶下线 | 多节点时三个节点共用一根连接，`client_id` 是固定的 `dormmate-sim-3nodes`（单节点那支还是按节点拼的 `dormmate-sim-<nodeId>`，所以三个单节点进程可以并存）。两个都带 `--all-nodes` 的进程同时跑，Broker 会按 client_id 把先来的那个踢掉。真要多份数据就换 `--node` 分开起 |
| 没有后端、没有数据库 | 纯静态前端 + 本机 Broker，数据不落库，页面关掉就没了 |
| 前端测试不覆盖浏览器真实行为 | 测试是 Node + 一个最小 DOM shim 跑真实的 `script.js`，摄像头 / 麦克风 / Canvas 都是桩。**能证明逻辑对，不能替代真机验证** |
| 3D 视图的动画循环一直在跑 | 场景是用 `setAnimationLoop` 逐帧重绘的，风扇不转的时候也在重绘。看板本来就是常驻页面，这点开销可以接受；真要省就在风扇停下时 `setAnimationLoop(null)` |
| 看板那一块读不到时只能看一行字 | `fetch` 拿不到那份文件（没跑过脚本 404、页面不是从项目根起的服务器、文件写了一半）时，这一块降级成「这一段没跑：{原因}」，**没有重试按钮**，刷新页面才会再读一次。原因原样写在页面上（`HTTP 404` / `Failed to fetch` 指向的是不同的排查方向），`git` 里那份 JSON 一直是在的，正常情况下碰不到 |

### 环境依赖

| 限制 | 说明 |
|---|---|
| 摄像头和语音识别**要求安全上下文** | 两者都只在 `https` 或 `localhost` 下可用。手机用 `http://<IP>:8000/web/` 打开时 `navigator.mediaDevices` 直接是 `undefined`，报错会变成 `Cannot read properties of undefined` |
| Chrome 的语音识别**要求联网** | 它是把录音传到服务器上识别的，不是本地识别。断网、走代理或被墙都会报 `event.error === 'network'` |
| Firefox 没有语音识别接口 | `window.SpeechRecognition` / `webkitSpeechRecognition` 都不存在，页面会明确提示换 Chrome / Edge |
| 「语音提醒」（看板）按了没声音、说「朗读」（`web/`）没声音 | 三种可能：① 浏览器不支持合成（看板是按钮下面那行、`web/` 是「执行结果」那一格，都会写出来，不是静悄悄）；② 系统静音或没装中文语音包（`lang = 'zh-CN'` 只是个请求，装不上就只能用默认嗓音念）；③ 页面还没被点过 —— 部分浏览器要求语音合成由用户手势触发。**念失败时那行说明会带上原始错误码**（`not-allowed` / `interrupted` 这类），照着码查 |
| `analysis.py` 需要 pandas / matplotlib | 没装时出不了图和报告，但统计部分仍能跑；测试里画图那几只会被 skip 掉（不算失败）。**且必须用 64 位的 `py -3.14`**，见上文 |
| `analysis/ml.py` 需要 scikit-learn | 没装时这个脚本**不会甩一串 traceback**，而是打印一句「没装 scikit-learn」并给出安装命令就退出（`py -3.14 -m pip install scikit-learn`，同样必须 64 位）；报表、摘要、看图三件事一个都不受影响。测试里 ⑫ 那些要真跑模型的类会被整类 skip（输出里是 `s` 不是 `.`，纯函数那批照跑），不是失败 |
| `analysis.py` 的报告里那一段需要 scikit-learn（还有那两份 C 部分的数据） | Step 9-3 起 `main()` 会顺手跑一次 `run_ml()`：没装 sklearn、或那两份文件不在 / 是空的，**报告照出**，只是「ML 异常分析」那块换成一句「这一段没跑：{原因}」，并且 `report/ml_result.json` 不写 |
| `report/ml_result.json` 记的是**上一次跑 `analysis.py` 的时刻**，不是实时的 | 数据来源是 C 部分那一对 CSV（`generatedAt` 就是生成时刻），跟 MQTT 那条实时链路无关。看板上那一块显示的就是这份文件，所以 `#ml-note` 里必须把这层意思写出来（`buildMlNote` 拼的那句就是干这个的，测试也钉着它） |
| 看板上「ML 辅助判断」那一块显示「这一段没跑」 | 三种原因：`report/ml_result.json` 不在（没跑过 `analysis.py`，或者那份文件被删了）、页面不是从项目根目录起的服务器（路径是 `../report/…`，起在别处就 404）、回来不是 JSON。**原因原样写在那一行里**（`HTTP 404` 和 `Failed to fetch` 指向不同的排查方向）。看板其余部分不受影响 |
| 对照表里的分数和 README 那张表对不上 | 钉住的六个分数（0.0347 / -0.0564 / …）是 **scikit-learn 1.9.1 + `random_state=42`** 跑出来的，换版本可能就变。`tests/test_ml.py` 里那几条会红，红的正是「README 这张表过期了」这件事 —— 照着新分数把表和测试一起更新，**别改参数去迁就旧数字** |

## 排查

| 现象 | 原因 |
|---|---|
| 看板一直「连接中…」 | Broker 没启动，或配置里少了 9001 websockets listener |
| 看板显示「已连接」但没有数据 | ② 的 `simulator/simulator.py` 没在跑，且没有 retained 消息 |
| 跑 `simulator.inject_faults` **该拒的那几条全红**（#1~#4、#6） | `core.py` 没在跑 —— 没人拦，脚本就如实报「没等到 reject」。先起 core 再跑一遍 |
| 跑 `simulator.inject_faults` 说连不上 1883 | Broker 没启动（退出码 3）。提示里那句 `mosquitto -c mosquitto/dormmate.conf -v` 就是起法 |
| `inject_faults` 里某条的「被拒了，但理由不对」 | 这条不是脚本的问题：core 对这条的处理和大家以为的不一样。拿 `--only N` 单跑一条，再对着 core 终端那行 `[拒绝] …` 看它到底怎么判的；清单写错了就改清单（清单在 `simulator/inject_faults.py` 顶上那张表里） |
| `simulator.inject_faults --only 99` 返回 2 | `--only` 里的编号必须真的存在，先 `--list` 看一眼都有哪几条 |
| `simulator/simulator.py` 报连不上 1883 | Broker 没启动；或配置里 `allow_anonymous` 不是 true |
| 模拟器说发布成功、看板却没数据 | 1883 被 Mosquitto 自带的 Windows 服务抢走了，见上面「装完必须处理」 |
| `pip install pandas` 报找不到 `vswhere.exe` | 用的是 32 位 `python`，pandas 没有 32 位 Windows 包。改用 `py -3.14 -m pip install` |
| `analysis.py` 报「找不到 CSV」 | 还没在网页上点导出，或文件没放进 `data/`。相对路径按项目根展开，不是按当前目录 |
| `analysis.py` 报 `KeyError: '\uFEFFtime'` | 读的时候没带 `utf-8-sig`，BOM 被算进了第一列列名 |
| `analysis.py` 报「没装 matplotlib」 | `py -3.14 -m pip install matplotlib`；只想看统计就加 `--no-plot` |
| `trend.png` 里的中文是方块 | 看脚本打印的「中文字体：」那行，它会说明找到了哪个；一个都没找到时是 `!! 警告`。Windows 上装 `Microsoft YaHei`（系统自带）即可 |
| 跑测试时画图那几只显示 `s` 而不是 `.` | 没装 matplotlib，被 `skipUnless` 跳过了，不是失败 |
| 报告里趋势图是个破图图标 | `trend.png` 不在报告旁边（用了 `--no-plot`，或图被单独删了）。`write_report()` 找的是报告同目录下那张图 |
| 改了 `make_sim_data.py` 之后，测试红在「和重新生成的一模一样」 | 改了生成逻辑却**没重新生成** `data/` 里那几份。跑一遍 `py -3.14 analysis/make_sim_data.py` 让文件跟上；如果是有意改数据，确认新数据仍然满足「历史条条正常 / 和 day_sim 同一天不打架」再提交 |
| 跑完测试发现 `data/` 里的 csv 被改了 | 不该发生：所有会写文件的用例都写在临时目录里（另两份跟 `--out` 走这条规则就是为它）。真出现了就 `git checkout -- data/` 再查是哪条用例漏了 `--out` |
| 跑完测试发现 `report/ml_result.json` 的 `generatedAt` 变了 | 不该发生：会跑 `main()` 的用例都把 `analysis.DEFAULT_ML_JSON` 一起指到临时目录了（Step 9-3 补的）。真出现了就 `git checkout -- report/`，再查是哪条新用例只挪了趋势图和报告、忘了挪它 |
| 报告里那一段写着「这一段没跑：…」 | ML 那一段降级了，不是报告坏了。三种原因：`data/dorm-a_history_sim.csv` 或 `data/new_samples.csv` 不在、两份里有一份是空的、这台机器没装 scikit-learn（原因那句话会直说）。报告其余部分的数字照常 |
| 看板读 `report/ml_result.json` 报 CORS / `Failed to fetch` | `fetch()` 读本地文件必须走 http：用 `file://` 直接打开 `dashboard/index.html` 会拿不到。起 `py -3.14 -m http.server 8000` 再从 `http://localhost:8000/dashboard/` 打开 |
| `analysis/ml.py` 报「CSV 的 temperature 列里有不是数字的值」 | 手改 CSV 留下的：那一格是文字（`不热`）或带引号的数字（`'25'`）。报错里写着**第几行、哪一刻、哪一格**，照着改回数字，或者留空（空着算缺失，不报错） |
| 改完 `ml.py` 跑测试，`analysis/ml.py` 报「干净：False」 | 不是变异跑脏了：`Path.write_text()` 默认按平台翻译换行，`read_text()` 默认又把 CRLF 折成 LF，一读一写就把行尾换了（内容一个字没变）。变异脚本已改成还原时整块写回原始字节；自己写临时脚本改文件时，读和写都带上 `newline=""` |
| 报告顶部一条红色横幅 | 规则复核没通过：CSV 里的 status 和 Python 重算的对不上，说明 `shared/rules.js` 和 `status_rules.py` 没同步 |
| 报告里中文乱码 | 文件被某个编辑器另存成了 GBK。它是 UTF-8（不带 BOM），别另存 |
| 终端中文乱码 | 控制台代码页不是 UTF-8，先执行 `chcp 65001` |
| 点「打开摄像头」报 `Cannot read properties of undefined` | 页面不是安全上下文 —— 手机用 `http://<IP>:8000/web/` 打开就是这样。改用 `http://localhost:8000/web/`，或上 https |
| 点「打开摄像头」提示「被别的程序占用了」 | QQ / 腾讯会议 / 相机 之类正抢着摄像头，关掉它们再点 |
| 「拍照」按钮是灰的 | 摄像头还没打开。先点「打开摄像头」，按钮才会亮 |
| 摄像头指示灯一直亮着 | 点页面上的「关闭摄像头」；直接关标签页也会在 `pagehide` 时自动关 |
| 点「语音指令」提示不支持 | 用的不是 Chrome / Edge（Firefox 没有这个接口），或者页面不是安全上下文 |
| 语音识别报 `network` | Chrome 要把录音传到服务器上识别，断网、代理或墙拦截都会这样。换成能通的网络再试 |
| 说「拍照」却提示"未识别的指令" | 指令是字面包含判断，必须说出「拍照」这三个字。「拍张照」「照相」都不算 |
| 说「朗读」后没声音 | 先看「执行结果」那一格：不支持合成它会明说，念的时候出错它会带上原始错误码（`not-allowed` / `interrupted` 这类）。那一格写着「正在朗读：dorm-a 25℃…」而你没听见，就是音量或中文语音包的事 —— **页面上那句和耳朵里那句是同一句话**，「没听见」不等于「没念」 |
| 运行 `.bat` 报一串「不是内部或外部命令」 | 文件被存成了 UTF-8 或 LF 行尾。三个 `.bat` 都必须是 **GBK 编码 + CRLF 行尾，且不能写 `chcp 65001`**，原因见脚本开头的注释 |
| `core.py` 一起来就报「已连续偏热……」而模拟器还没跑 | 那是 retained 的最后一条读数，不是刚发来的。跑剧本前先 `publish_one --clear` 清一遍（见 Phase2 那一节的步骤） |
| `core.py` 启动就退出，说「配置和别处的出处对不上」 | `core/config.json` 里的阈值和 `status_rules.py` 对不上。**改规则改 `status_rules.py`**，再把那一份同步过去（反过来改会让报告和看板一起偏） |
| `core.py` 报 `ModuleNotFoundError: No module named 'core'` 或 import 到别的东西 | 项目根多了个 `core/__init__.py`（`core/` 现在只是个放配置的目录）。Python 的查找顺序是「包优先于同名的 `.py`」，那个文件一出现，`import core` 拿到的就是包而不是 `core.py`，而且**不报错**。删掉它（`tests/test_core.py` 有一条守着这件事） |
| 日志里没有 `[重点]` 这一行 | 那是**只在换人时**打印的。同一个宿舍一直领先就不重复打 —— 时长在涨不是新闻，换人才是。想看当前的结论就订阅 `dormmate/v1/state` 看 `priority` 那一段 |
| 优先关注和看板顶部那一行对不上 | 预期之内：恢复判据两边还不一样（core 要连续 3 条正常，看板一条就结束），且看板还没读 core 的快照。演示时以 core 的终端和 `dormmate/v1/state` 为准。见「已知限制」 |
| `dormmate/v1/log/reject` 上出现消息 | 有报文没通过校验，`reasons` 里写着是哪一条判据（比如 topic 是 dorm-a、报文里写 dorm-b）。发布端那边看 `--topic` 和 `--node` 是不是给岔了。**清 retained 的空报文不在这里**：它打的是 `[保留]`、进 `counters.retainedCleared` —— 空报文不是坏报文，别去追一条本来就没问题的警报 |
| 剧本跑完 `data/events.json` 还是空的（或根本没这个文件） | 两种可能：① 剧本里的节点名和 `core/config.json` 里的对不上 —— core 会拒收未知节点，终端上是 `[拒绝]` 不是 `[事件]`；② 一个异常段都没凑起来 —— 事件是**节点真的进了异常段**才开的，`--dry-run` 那几条不算数。先看 core 终端有没有 `[事件]` 那一行。文件不在这件事本身也算线索：一个事件都没有时 core 也会写一份空的出来 |
| 事件开出来了，但 `start_time` 是今天的墙上时间、不是剧本里写的 | retained 没清干净：core 一订阅上就收到上一次跑剩下的那条读数，于是**拿当下的时间**开了一条事件。跑剧本前先 `publish_one --clear` 三个节点，再删掉 `data/events.json`，然后**再起** core（顺序见 Step D3 那节） |
| 发了 `handle`，事件却还停在 `OPEN` | 先看 core 有没有 `[指令]` 那一行。没有的话是消息没到：查 topic 是不是正好 `dormmate/v1/cmd`（不是 `dormmate/v1/nodes/<节点>/cmd`），`send_cmd --node` 写错节点也会发到别人头上。有那一行而且写着「没接受」的话，理由就在那一行后半句 —— 多半是「现在没有开着的事件」（这个节点此刻是正常的，没有案子可接） |
| 看板上按了「开启风扇 / 通风」，core 那边一点动静都没有 | 按顺序看四处：① **那行小字写了什么** —— 写着「这条指令没发出去（还没连上 broker）」就是页面根本没连上（点右上角的「连接」），这种情况卡片照样会变「处理中」，**只有那行字能看出来**；② 浏览器 Console 有没有 `[DormMate] 发出 MQTT 指令` 那一行 —— 没有的话是页面这边就没发出去；③ 有那一行但 core 没有 `[指令]`，就是 core 没起，或核心订阅的 topic 和发出去的不是同一条（两边各查一次：core 启动那行日志写着它订了什么，Console 那行写着发到哪）；④ core 有 `[指令]` 但写着「没接受」，后半句就是理由（`source` 那个字段也在这里：`（dashboard）` 是人按的、`（script）` 是剧本、`（manual）` 是 `send_cmd.py`） |
| 按了按钮，卡片变「处理中」但「事件记录」那张表里没有这一条 | 两本账，见「已知限制」。页面那张表记的是**这一段连续异常**（节点从正常变异常时开一条），按按钮只是往已经开着的那条上记一笔「处理动作」；节点当时要是没在异常段里，那一列本来就是空的。要看 core 那边的事件就去 `data/events.json` 或 core 终端 |
| `#cmd-note` 那行字一直不消失 | 它是「上一次按的结果」，不会再自动变回空 —— 按下一次会覆盖它，点「清空」会擦掉。要一条条对着看就开 Console |
| 事件停在 `HANDLING` 再也不动了 | 验证数据还不够。要**连着** N 条正常（`events.recoverConsecutiveNormal`）或**连着** M 条异常（`verifyConsecutiveAbnormal`）才结案，中间断一次就从头数（一条正常会把异常计数清零，反之亦然）。发够条数再看。要是中途重启过 core，那条已经按 `UNRESOLVED` 收尾了，`result` 里写明是重启造成的 |
| 按了「开始处理」，`data/events.json` 里那条还是 `HANDLING`、`recovered_at` 是 `null` | **这是对的**，红线就是这个意思：恢复只能由后来收到的数据判。接着发够连续 N 条正常再看一次，那时候变才正常 —— 要是按完按钮当场就变成 `RECOVERED`，那才是出事 |
| 日志里有 `[事件] ... -> RECOVERED`，但发出去的数据里明明还有异常 | 看两件事：这条 `RECOVERED` 是不是**另一条**事件的（同一个宿舍可以先后开好几条，`event_id` 里的时间戳不一样）；以及恢复判据是「连续 N 条正常」，中间夹的那条异常在攒够 N 条之前就把计数清零了，所以结案时最后 N 条确实都是正常的 |
| 剧本跑起来「优先关注」每一条都在跳 | 同一个节点的时间要么在往回走（core 算出的时长被夹到 0），要么两个节点的数据交错得太碎。先看 `tests/test_scenarios.py` 里的轨迹断言是不是红的 —— 脚本层面能保证的事不该靠眼睛盯 |

## 开源组件来源

> 待填。表格先留空，逐项核实版本和许可证后再补。

| 组件 | 版本 | 用途 | 许可证 | 来源 |
|---|---|---|---|---|
|  |  |  |  |  |
|  |  |  |  |  |
|  |  |  |  |  |
|  |  |  |  |  |
|  |  |  |  |  |
|  |  |  |  |  |

需要补进来的东西大致是这些，版本号的位置一并写在这里，省得再翻：

| 要找的东西 | 版本写在哪儿 |
|---|---|
| mqtt.js（浏览器端，已本地化到 `web/vendor/mqtt.min.js`） | 打包进文件里了，是 **5.10.1**；文件末尾还带一段 bundled license 注释，写明其中 `@jspm/core` 的 buffer 垫片是 BSD-3-Clause |
| `paho-mqtt` / `pandas` / `matplotlib` / `scikit-learn` | `requirements.txt` 里写的是下限（`>=`），实际版本用 `py -3.14 -m pip show <包名>` 查。本机实测：pandas 3.0.6、scikit-learn 1.9.1（**scikit-learn 会同装 scipy 和 joblib**，填表时别忘了这两个） |
| Mosquitto | `mosquitto -h` |
| Python 解释器本身 | `py -3.14 -V` |

字体不算组件：`style.css` 用的是 `system-ui` / `Microsoft YaHei` 等**系统自带字体**，
没有随项目分发任何字体文件。`analysis.py` 画图时找的也是系统字体（脚本会打印
「中文字体：」那一行说明用了哪个）。
