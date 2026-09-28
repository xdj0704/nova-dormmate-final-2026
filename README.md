# DormMate Final · 多节点宿舍环境助手

## 项目简介

DormMate Final 是一个**宿舍环境监测助手**。它把宿舍的温湿度采集上来，经 MQTT 推到
浏览器，实时显示成一块看板；看板上还能手动录入一组数据做即时分析、把记录导出成 CSV；
再往后是给看板装上"眼睛"和"嘴"—— 现场拍照与语音指令。导出的 CSV 交给 Python 侧读回来，
做规则复核、状态统计、趋势图和 HTML 报告，形成**采集 → 展示 → 导出 → 分析**的闭环。

前端是**纯静态**的（不需要构建、不需要打包工具；三个第三方库 —— mqtt.js、Chart.js、
three.js —— 都各留了一份本地副本，默认走 CDN，现场没网时按下面指出的那几行换成本地文件
即可，不用改别的），后端只有本机一个 Mosquitto Broker，没有服务器程序、没有数据库。

课程 Challenge 项目。看板已经是**三节点**（`dorm-a` / `dorm-b` / `dorm-c`）的 ——
订阅的是通配符 topic，每个节点各存一份互不相干的状态。只是 `simulator.py` 一次
只发一个节点，要同时看到三个宿舍就起三个进程（`--node` 各指一个），或者用 MQTTX 手发。

## 主要功能

| 模块 | 状态 | 说明 |
|---|---|---|
| 实时看板（`web/`） | ✅ 已完成（M1） | 通过 WebSocket 订阅 `dormmate/+/env`，显示温湿度与状态徽章。状态用**颜色 + 图标**双重编码，不靠颜色单独表意；支持深 / 浅色主题 |
| 多节点看板（`dashboard/`） | ✅ 已完成（Step 5-3 / 5-4） | 订阅同一个通配符 topic 把三个节点一次收齐，`dorm-a` / `dorm-b` / `dorm-c` 各一张状态卡 + 一张趋势图（温湿度分两张，不用双 Y 轴）。三个节点各存一份互不相干的状态，改一个不动另外两个 |
| 3D 宿舍实景 | ✅ 已完成（Step 6-1 ~ 6-3） | Three.js 场景嵌在看板里，跟着**当前选中的节点**走：点卡片切节点时，画面、标签、风扇一起切 |
| 优先关注 | ✅ 已完成（Step 7-1） | 从三个节点里挑出最该先看的那个：先比连续异常时长，一样长比这段的消息条数，还一样按 nodeId 定序。点它 = 点对应那张卡片 |
| 处理动作 | ✅ 已完成（Step 7-2） | 详情区「开启风扇 / 通风」按钮。按下后节点记「处理中｜风扇已开启」，动作之后收到的数据决定转「已恢复」还是留在「处理中」。卡片、详情区、3D 风扇读的是同一份节点数据 |
| 手动录入分析 | ✅ 已完成 | 在页面上直接输入一组温湿度，前端按统一规则算出 status 并给出建议文案，带范围校验（温度 -20~60℃，湿度 0~100%） |
| 录入历史 + 导出 CSV | ✅ 已完成 | 表内滚动、表头吸顶；导出为 CRLF 换行 + UTF-8 BOM，Excel / WPS 打开不乱码 |
| Python 分析 | ✅ 已完成（Step 2-2~2-5） | 读 CSV → 规则复核 → 状态统计 → 出 `report/trend.png` 趋势图 → 出 `report/report.html`；支线还能渲染一份 Markdown 报告 |
| 现场快照 | ✅ 已完成（Step 3-1） | 摄像头预览 + 一键拍照，快照显示在页面右侧，标明拍摄时间与分辨率 |
| 语音指令（ASR） | ✅ 已完成（Step 3-2） | 说「朗读」播报当前状态、说「拍照」拍下现场画面，识别到的文字和执行结果显示在页面上 |
| 语音播报（TTS） | ⏳ **待完成**（Step 3-3） | `speakStatus()` 目前只把要念的内容打到 Console，还没有真正念出来 |

每个模块的具体做法、测试条数和踩过的坑，记在下面各自的 Step 小节里。
不清楚某处为什么这么写时，先看那一节的「几个决定」表格。

## 目录结构

```
nova-dormmate-final-2026/    # 仓库根
├── README.md                # 本文档
├── .gitattributes           # 钉住第三方文件的换行，README 里的 sha256 才对得上
├── requirements.txt         # Python 依赖：paho-mqtt + pandas + matplotlib
├── status_rules.py          # 规则（Python 侧唯一实现，发布端算 status 用）
├── config.py                # Broker / 端口 / Topic / 节点 等统一配置
├── simulator.py             # M1 数据源：生成并发布环境数据
├── shared/
│   └── rules.js             # 规则（JS 侧唯一实现，前端页面共用一份）
├── analysis/                # Step 2-2/2-3/2-4/2-5：分析层（是个包，所以有 __init__.py）
│   ├── __init__.py
│   ├── rules.py             # judge_status() —— 转发 status_rules，不重抄规则
│   ├── analysis.py          # 读 CSV + 复核规则 + 状态统计 + summary + 趋势图 + HTML 报告
│   └── report.py            # 把同一个 summary 渲染成 Markdown 报告
├── data/
│   └── dormmate.csv         # 演示用样例数据（网页「导出 CSV」的文件格式）
├── report/                  # Step 2-4/2-5 的产物（注意是单数，见下面说明）
│   ├── trend.png            # 温湿度趋势折线图（analysis/analysis.py 的产物）
│   └── report.html          # HTML 报告，里面的 <img src="trend.png"> 是相对路径
├── reports/
│   └── dormmate-report.md   # Markdown 报告（analysis/report.py 的产物）
├── tests/
│   ├── test_status_rules.py # Python 侧回归测试（22 条）
│   ├── test_analysis.py     # analysis 读取、统计、趋势图与报告的测试（134 条，需要 pandas / matplotlib）
│   ├── test_report.py       # 报告渲染的测试（30 条，需要 pandas）
│   ├── rules.test.js        # shared/rules.js 的测试（31 条，纯 Node 无依赖）
│   ├── miniapp-rules.test.js # 小程序 rules.js ↔ shared/rules.js 交叉比对（48 条）
│   ├── logic.test.js        # dashboard/logic.js 的纯函数：解析 / 时长 / 连续异常段 / 挑优先 / 处理状态机（112 条）
│   ├── dashboard.test.js    # dashboard.js 的订阅 / 校验 / 绘图 / 3D 接线 / 优先关注栏 / 处理动作（271 条，假 DOM + 假 mqtt）
│   ├── scene3d.test.js      # 3d/scene.js 与 3d/index.html 的结构（198 条，假 three 模块 + 假 DOM）
│   ├── scene3d-page.test.js # 3d/index.html 里那段模块脚本：MQTT 驱动 3D（65 条）
│   └── script.test.js       # 前端回归测试（130 条，纯 Node 无依赖）
├── mosquitto/dormmate.conf  # Mosquitto 配置：1883(TCP) + 9001(WebSocket)
├── web/                     # M1~M3 单节点看板（纯静态，无需构建）
│   ├── index.html
│   ├── style.css
│   ├── script.js            # 订阅渲染 + 手动录入 + 录入历史 + 导出 CSV + 现场快照 + 语音指令
│   └── vendor/mqtt.min.js   # 本地化的 mqtt.js，不依赖 CDN
├── dashboard/               # M5 多节点看板：dorm-a/b/c 横向对比（纯静态）
│   ├── index.html           # 建容器 + 一张 three 的 importmap（scene.js 里的裸名 three 靠它解析）
│   ├── style.css
│   ├── dashboard.js         # ES 模块：订阅 dormmate/+/env、校验报文、复核 status、卡片 + 趋势图 + 日志 + 3D 视图 + 处理动作
│   ├── logic.js             # 优先关注的算法 + 处理动作的状态机：只放纯函数，不碰 DOM、不读当前时间（ES 模块，单独测）
│   └── lib/
│       ├── mqtt.min.js      # 本地引用：它挂了就一条数据都收不到，所以不走 CDN
│       └── chart.umd.min.js # 备用：Chart.js 默认走 CDN，断网时改成引用这个
├── 3d/                      # M6 三维场景（ES Module + importmap，必须走 http 服务器）
│   ├── index.html           # 容器 + importmap + 节点选择（dorm-a/b/c）+ 订阅 MQTT 筛给当前节点，另留 4 个手动预览按钮
│   ├── scene.js             # createDorm3D(container)：宿舍 + updateScene(status) / setFanOn / setLabel
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

**MQTT**：本机 Mosquitto；MQTTX 走 TCP 1883；浏览器走 `ws://<页面所在的地址>:9001`；Topic `dormmate/<nodeId>/env`。

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

> `py -3.14 simulator.py` 显示发布成功，MQTTX 也能收到数据，
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
py -3.14 simulator.py
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
开到局域网等于同一个 WiFi 下谁都能往 `dormmate/+/env` 发布和订阅。
M5 真的需要别的机器发布数据时再手动放行：

```powershell
netsh advfirewall firewall add rule name="DormMate 1883" dir=in action=allow protocol=TCP localport=1883
```

## 用 MQTTX 验证发布端

新建连接：`mqtt://localhost:1883`（TCP），订阅 `dormmate/+/env`。
应能收到与 `simulator.py` 终端输出完全一致的 JSON。
发布端用了 retain，所以新订阅者会立刻收到最后一条。

## 跑测试

```bash
py -3.14 -m unittest discover -s tests -t . -v   # ①②③ Python 侧，共 186 条
node tests/rules.test.js                          # ④ 规则 JS 侧，31 条
node tests/scene3d.test.js                        # ⑧ 3D 场景，198 条
node tests/scene3d-page.test.js                   # ⑨ 3D 页面的 MQTT 接线，65 条
node tests/miniapp-rules.test.js                  # ⑥ 两份规则实现交叉比对，48 条
node tests/dashboard.test.js                      # ⑦ 多节点看板，271 条
node tests/logic.test.js                          # ⑩ 优先关注 + 处理动作，112 条
node tests/script.test.js                         # ⑤ 页面 JS 侧，130 条
```

`unittest discover` 会把 `tests/` 下三个 `test_*.py` 一起收进来
（22 + 134 + 30 = 186 条），所以 `py -3.14` 那条要装 pandas 和 matplotlib。
`node` 那七条不需要任何依赖，也不用起服务器。

画图那几只测试在开头 `skipUnless(HAS_MPL)`：没装 matplotlib 时会**跳过**
（输出里是 `s` 不是 `.`）而不是报一堆错 —— 读 CSV、统计、复核这几步没它也
能跑，不该被一个画图依赖拖着。真要看图出没出，就看跳过了几条。

| 命令 | 管什么 |
|---|---|
| ① 22 条 | 老师给的 4 条回归数据、优先级（31/80 必须是偏热）、边界值（18/30/75 取等号）、JSON 字段与 time 格式、Topic 约定 |
| ② 134 条 | `analysis/rules.py` 是转发而非第二份实现（`assertIs` 直接比函数对象）、路径按项目根推导、CSV 读取（BOM / 缺列 / 缺文件 / 只有表头）、统计值、样例数据的 status 与规则一致；Step 2-3 的 `rule_status` 重算、不一致行识别（含温湿度缺失不能算成「正常」）、状态计数、关注列表、`summary` 的键与 JSON 可序列化、时间范围、`verbose=False`、表格的中文列宽；Step 2-4 的趋势数据整理（排序 / 跳过的行 / 缺失留 nan）、横轴时间格式、字体列表、写出的确实是 PNG、目录自动创建、空表也出图、画完不留下没关的 figure、横轴跨度为 0 时不刷警告；Step 2-5 的 HTML 转义（`<script>` 撑不破页面）、表格拼装、数字全部来自 summary（换一份数据数字跟着换）、占比与合计、关注表格只列非正常、趋势图的相对路径与占位、规则不一致时的横幅、`sections` 额外区块的顺序与转义约定、写文件的编码 / LF / 目录自动创建 |
| ③ 30 条 | 报告的段落齐全、占比、表格里的竖线/换行转义、空表不出现 `nan%`、写文件的编码与 LF 换行、结论的并列与阈值判断、报告里**不出现**建议文案（那是网页 `getAdvice()` 的活） |
| ④ 31 条 | `judgeStatus` / `getAdvice` / `runRegressionTests` 的行为，外加"不许用 export、不许碰 DOM"这类约束 |
| ⑤ 130 条 | `validateInput` 的判序、`analyze` 的四种状态与配色 class、`formatTime` 的格式与补零、录入历史的追加与倒序、CSV 的表头/BOM/CRLF/行顺序/空状态、HTML 与 JS 的 id 是否对得上、broker 地址按访问地址拼（本机 / 局域网 IP / 空 hostname）、源码里不再有写死的 `ws://localhost:9001`；Step 3-1 的摄像头：起手标记、`takeSnapshot()` 的三种失败路径与成功路径、画布取视频原始像素而不是 CSS 尺寸、`drawImage` 的实参、第二次拍照是覆盖不是追加、关摄像头时每条 track 都被 `stop()`、`pagehide` 自动关；Step 3-2 的语音：浏览器不支持、`lang`/`continuous`/`interimResults` 三个参数、重复点击被忽略、三个固定指令各自的走向、「拍照」在摄像头没开时走 `takeSnapshot` 的失败分支、字面匹配的边界（「拍张照」不算）、三种错误码都出现在页面上、表里没有的码不被吞、离开页面时 `abort` 且不报错 |
| ⑥ 48 条 | `miniapp/utils/rules.js` 与 `shared/rules.js` 的交叉比对：两份实现分别放进各自的 vm 跑，在 8211 组温湿度（温度 -20~60 步长 0.5 × 湿度 0~100 步长 2）上逐对比 `judgeStatus` 与 `getAdvice`，结果必须完全一致；另有一条守卫确认这个网格真的覆盖到了四种状态，否则「全都一样」可能只是压根没测到 |
| ⑦ 271 条 | `dashboard.js` 配假 DOM + 假 `mqtt` 实跑：三节点数据互不串线（三份 `history` 各归各的）、切节点重绘两张图、脏数据（解析失败 / 缺字段 / 类型不对 / NaN / 未知节点）分别被拦下、`status` 与规则不一致时以规则为准、topic 与 nodeId 不一致时警告但不丢弃、历史上限、清空、MQTT 连接与订阅、Console 打印原始报文（被拦下的那条也要打）、mqtt.js 没加载时的降级提示；Step 6-3 的 3D 接线：**收到别的节点的消息时 3D 一次都不许被调**、切节点立刻改画、收到的 status 是复核之后才交给 3D 的、`renderScene` 的幂等与「3D 建不起来时直接跳过」；Step 7-1 的「优先关注」栏：`abnormalStart` / `abnormalCount` 的维护（首条开段、起点不动、节点之间互不串、来正常数据两个字段一起清零、清零后再异常是新的一段、段里从偏热变偏湿仍是同一段、**报文谎称「正常」但规则算出偏热时段不被打断**）、`abnormalCount > 0` 与 `latest.status !== '正常'` 的等价不变量、页面刚加载时那栏就画好了且说的是「还没有收到数据」而不是「三个都正常」、点那栏走的**是注册在 `#priority` 上的真实委托回调**（`clickFocus()` 模拟的是事件，不是直接调 `selectNode`，所以选择器写错这里会红）且卡片 / 趋势图 / 3D 一起切过去并改口说「正在查看」、以及交给 MQTTX 的那三组数据在 `handleMessage` 上端到端跑一遍；Step 7-2 的处理动作：没数据 / 状态正常时按钮都禁用、偏湿时可按、点在 `#action-fan` 上真实注册的回调、按下之后四个字段各是什么（`actionTime` 取的是**该节点最新那条消息的 `time`**，不是浏览器时间）、卡片上出现独立的 `<span class="card-action">处理中｜风扇已开启</span>` 且**只有被处理的那个节点有**、详情区那行字把「记在哪条数据上 / 之后收到了什么」说清楚、**按下之后先 `updateScene` 再 `setFanOn(true)`**（顺序反了会被 `updateScene` 自己那次盖掉，所以拿偏湿当被测场景 —— 偏热的 `LOOK` 本来就是 `fan: true`，顺序写反也照样绿）、比动作还早的消息不许改写处理状态、动作之后正常了转「已恢复」而再变坏自动退回「处理中」、`actionTime` 不被后来的消息顶掉、两个节点各记各的互不覆盖、**没按过按钮的节点 dashboard 一次都不碰风扇**（不许把偏热本来就转着的按停）、清空后四个字段归零且不再喊「转」、以及「启动那一刻按钮就是灰的、那行字就是『还没有收到数据』」的加载快照 |
| ⑧ 198 条 | `3d/scene.js` 配假 `three` 模块 + 假 DOM 实跑（模块里的裸名字 `three` 是不认 importmap 的，测试把那一行 import 改写成指向本地假模块的绝对 file:// URL）：容器查找与报错、renderer 的像素比封顶与尺寸、宿舍每部分的几何 / 朝向 / 摞放关系（床垫正好压在床架上、3 片扇叶互成 120°、窗扇挂在铰链的一侧、支架不在会转的那个 Group 里）、两盏灯与阴影相机、相机参数与 `lookAt`、`updateScene` 四种状态各自改了什么以及切回来有没有残留、不认识的 status 退回「正常」并在控制台警告、`setFanOn` 的归一化与「关掉不归零」、`setLabel` 的覆盖层、动画循环随 dt 累加（**验证转动快慢与帧率无关**）、resize 自适应与 0×0 容器不产生 NaN、dispose 是否真的回收了几何体 / 材质 / 监听（**包括嵌在 Group 里的零件**）、index.html 的 importmap（合法 JSON、出现顺序比的是**标签**位置、版本号）与 4 个按钮的接线、覆盖层那两条关键 CSS、以及 `lib/` 里那份的大小与自包含性。22 个变异（含「灯不能和相机同侧」「改完阴影相机范围要重算投影矩阵」「假模块的 traverse 退回只走一层」）逐个塞回源码验证过，全部被抓住 |
| ⑨ 65 条 | `3d/index.html` 里那段 `<script type="module">`：**从 HTML 里抠出来**，摘掉 import 换成打桩的 `createDorm3D`，配上假 `mqtt` 和假的按钮桩实跑。盯的就是 Step 6-3 那条规则 —— **画面跟的是「当前选中的宿舍」，不是「最后一个发消息的宿舍」**：给 dorm-b 发消息时 3D 一次都不许被调、切过去才画、而且画的是它最新那条；没收到数据的节点退回「正常」的外观并在覆盖层上如实说明；报文里写错的 `status` 一律以规则算出的为准；脏数据四条（非 JSON / 缺字段 / 类型不对 / 未知节点）一条都不许改到画面；`shared/rules.js` 必须是普通 script 且排在模块之前；6-2 留下的 4 个手动预览按钮仍然可用，且会被下一次真数据顶掉 |
| ⑩ 112 条 | `dashboard/logic.js` 的纯函数逐个钉住：`parseTime` 只认 `YYYY-MM-DD HH:mm:ss`（`/`、`T`、少秒、不补零、前后空格、空串、`null`、数字、中文一律 `NaN`）且按 UTC 折算（同一串在不同时区差几小时这条就红了）、跨零点 / 跨月 / 闰日、`fmtDuration` 的向下取整（4 分 59 秒说「4 分钟」）与非正数兜底、`abnormalDuration` 在起点晚于终点时返回 0 而不是负数、`nextAbnormal` 不改传入的对象 / 认得不完整的 `prev`、以及 `pickPriority` 的整套判定：三组场景、**时长优先于条数（7 分钟的 1 次排在 1 分钟的 99 次前面）**、追平那句话只点**时长相同**的那个（跟所有人比是错的）、第 3 步是固定码元序而不是跟着区域设置走的 `localeCompare`。Step 7-2 的处理动作状态机：`beginHandling` 在没有 `latest` / `latest` 是 `null` / 传 `null` 时返回 `null`、按下之后返回的正好是那四个字段、`actionTime` 只认 `latest.time`（`history` 里更早的那条不算）、每次返回新对象且不改传入的节点、`nextHandling` 对「没按过按钮」「不认识的状态」「`actionTime` 或这条的 `time` 解析不出来」一律返回 `null`、**「严格晚于 `actionTime`」**（同一时刻的那条不算，动作就记在它身上）、动作之后正常转「已恢复」而偏冷 / 偏热 / 偏湿一律留在「处理中」、只认 `record.status` 不自己复核、以及来回走一遍：处理中 → 还异常(处理中) → 正常(已恢复) → 又异常(处理中) → 正常(已恢复)。另有守门的静态检查：导出就这 7 个、`ACTION_FAN` **不**导出（那串字只该有一份）、没有 `export default`、源码里不许出现 `document` / `window` / `innerHTML` / 定时器 / `Date.now(` |

⑤ 的做法是把**真实的** `script.js` 加载进一个最小 DOM 桩里直接调函数，
不是另写一份等价逻辑——否则测的是抄来的那份，不是线上那份。它同时充当
「规则只有一份」的守门人：`script.js` 里一旦又冒出 `computeStatus` 或
`temperature < 18`，⑤ 会直接报错。

② 和 ⑤ 各踩过一次**「检查匹配到自己的注释」**的坑（注释里写了 `export`、
`toLocaleString`，检查就报失败），所以两处都是先把注释剥掉再查语法。

**改 `status_rules.py` 要跑 ①（②③ 顺带一起跑）；改 `shared/rules.js` 要跑 ④，改 `miniapp/utils/rules.js` 要跑 ⑥（两次改完都再确认 ⑤ 还绿）。**

## simulator.py 常用参数

| 参数 | 说明 |
|---|---|
| `--dry-run` | 只打印 JSON，不连 MQTT（没装 Mosquitto 时也能验证格式） |
| `--count 4` | 只发 4 条，方便一次跑完 |
| `--mode random` | 换成随机温度/湿度 |
| `--interval 2` | 改成 2 秒一条 |
| `--node dorm-b` | 换节点（M5 用） |

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
| `status_rules.py` | `simulator.py`（发布端）、`analysis/rules.py`（转发） | 发布前算好，写进 JSON 的 `status` 字段 |
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
from analysis import analysis

summary = analysis.summarize(analysis.add_rule_status(analysis.load(csv)), csv, verbose=False)

sections = [
    analysis.table_section("事件复盘", ["时间", "事件"], [["20:30:15", "温度越过 30 ℃"]]),
    analysis.table_section("今日摘要", ["项目", "值"], [["最高温", "31 ℃"]], right=(1,)),
    {"title": "ML 异常分析", "html": "<p class='note'>后面接模型输出。</p>"},
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

### 为什么 `speakStatus()` 现在只 `console.log`

Step 3-3 才做语音合成。现在它把"要念的内容"（各节点的温度/湿度和状态）打到控制台，
**返回值仍然是 `{ok, message}`** —— 和 `takeSnapshot()` 同一个形状。这样路由层
（`handleVoiceText`）不用分辨命令是谁，拿到结果直接显示就行；Step 3-3 把里面换成
真正的朗读时，路由那一层一行都不用改。

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

## Step 5-3 / 5-4：多节点 Dashboard

`dashboard/` 是和 `web/` 并列的第二个前端，专门看 dorm-a / dorm-b / dorm-c 三个节点：

| | `web/` | `dashboard/` |
|---|---|---|
| 面向 | M1~M3，单个宿舍的完整功能 | M5，三个节点的横向对比 |
| 内容 | 卡片 + 手动录入 + 录入历史 + 导出 CSV + 现场快照 + 语音指令 | 三张节点卡 + 两张趋势图 + 消息日志 |
| 数据 | 订阅同一个通配符 `dormmate/+/env`；按 `nodeId` 存进一个 Map，**来几个节点就画几张卡** | 订阅同一个通配符，但节点白名单写死在 `dashboard.js` 的 `NODE_IDS`：固定三张卡，还没收到数据的显示「等待数据」，白名单外的节点只记一条错误日志、不建卡 |

打开方式和 `web/` 一样走 8000 端口的静态服务器（`start_web.bat` 或手动起）：

```
http://localhost:8000/dashboard/
```

### 订阅与连接

Topic 用通配符 `dormmate/+/env`，一条订阅覆盖三个节点 —— 加第四个节点不用改订阅，
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
[DormMate] 收到 MQTT 原始消息 dormmate/dorm-a/env {"nodeId":"dorm-a",...}
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

两边的规矩是同一条：**订阅 `dormmate/+/env`，但只有「当前选中的那个宿舍」的消息
才交给 `updateScene`**。收到的 `status` 也一律用 `judgeStatus` 复核，报文里写什么都不算数。

### 为什么要按节点筛：三个宿舍挤在一个 topic 里

`dormmate/+/env` 这个通配符把三个宿舍的数据混在一条流里送过来。
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

只有异常节点参加比较，按固定的三步走，前面分出胜负就不再往下看：

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
`simulator.py` 是带 retain 发的（README 上面那节写了），所以新订阅者一上来就会
**立刻收到三条旧报文**。如果那三条的 `time` 比你要发的场景新（比如是今天刚发的、
而场景用的是 2026-09-22），那么每个节点的这段异常就从今天那条开始 ——
拿 9 月 22 日的时间去减，结果是**负数**，`abnormalDuration` 一律返回 0，
栏上于是三个节点「完全并列」。

验的时候我就是这么栽的：日志里数字都对，栏上却写「三个节点都正常」
或者「三个并列」。清掉 retain 就正常了：

```bash
mosquitto_pub -h localhost -p 1883 -t 'dormmate/dorm-a/env' -r -n
```

（`-r -n` = 发一条空的 retain，等于把这条 retained 消息删掉。三个节点各来一次。）

顺带一提，这也是「先点清空」有用的另一个原因：清空是页面自己的账，
和 broker 上的 retain 无关，两边都干净了才对得上。

### 三组测试数据（MQTTX 直接发）

都发到 `dormmate/<nodeId>/env`，**`time` 是决定时长的唯一因素**（不是真实时间），
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
包括：正常数据不清零、每条异常都开新段、先比次数再比时长、第 3 步改用
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
| 报文没有乱序保护 | `latest` 一律被**最后收到**的那条顶掉，比的是到达顺序而不是 `time` 顺序。重发一条旧数据，卡片上的读数就会退回去、连续异常的时长会缩到 0（`abnormalDuration` 对负值返回 0，所以不会显示成负数）。处理动作那边不受影响：`nextHandling` 要求**严格晚于** `actionTime` 才认，一条迟到的旧数据改写不了「处理好了没有」。真要做就得给每个节点加一条「`time` 不比 `latest` 新就只进历史」的闸 —— 现在故意不做，因为演示里数据源只有一个，重复投递多半是人为的，看得见反而好排查 |
| 3D 场景的状态切换是瞬间到位的 | 开窗角度和风扇转速都不做缓动。按钮点下去要立刻看到变化，而且立刻到位让「打开了吗」「转了吗」一眼可验、也好写测试。想要柔和一点就在动画循环里让 `rotation.y` 朝目标值逼近 |

### 还没做

| 限制 | 卡在哪 |
|---|---|
| 语音只识别、不播报 | 语音合成是 Step 3-3。现在 `speakStatus()` 把要念的内容打到 Console 占位 |
| `simulator.py` 一次只发一个节点 | 没有「三个一起发」的开关，`--node` 指哪个就发哪个。要同时看到三个宿舍的实时数据，就开三个终端各起一个进程 —— `client_id` 是按节点拼的（`dormmate-sim-<nodeId>`），三个进程不会互相顶下线；看板那边一个字都不用改。当然也可以用 MQTTX 手发 |
| 没有后端、没有数据库 | 纯静态前端 + 本机 Broker，数据不落库，页面关掉就没了 |
| 前端测试不覆盖浏览器真实行为 | 测试是 Node + 一个最小 DOM shim 跑真实的 `script.js`，摄像头 / 麦克风 / Canvas 都是桩。**能证明逻辑对，不能替代真机验证** |
| 3D 视图的动画循环一直在跑 | 场景是用 `setAnimationLoop` 逐帧重绘的，风扇不转的时候也在重绘。看板本来就是常驻页面，这点开销可以接受；真要省就在风扇停下时 `setAnimationLoop(null)` |

### 环境依赖

| 限制 | 说明 |
|---|---|
| 摄像头和语音识别**要求安全上下文** | 两者都只在 `https` 或 `localhost` 下可用。手机用 `http://<IP>:8000/web/` 打开时 `navigator.mediaDevices` 直接是 `undefined`，报错会变成 `Cannot read properties of undefined` |
| Chrome 的语音识别**要求联网** | 它是把录音传到服务器上识别的，不是本地识别。断网、走代理或被墙都会报 `event.error === 'network'` |
| Firefox 没有语音识别接口 | `window.SpeechRecognition` / `webkitSpeechRecognition` 都不存在，页面会明确提示换 Chrome / Edge |
| `analysis.py` 需要 pandas / matplotlib | 没装时出不了图和报告，但统计部分仍能跑；测试里画图那几只会被 skip 掉（不算失败）。**且必须用 64 位的 `py -3.14`**，见上文 |

## 排查

| 现象 | 原因 |
|---|---|
| 看板一直「连接中…」 | Broker 没启动，或配置里少了 9001 websockets listener |
| 看板显示「已连接」但没有数据 | ② 的 `simulator.py` 没在跑，且没有 retained 消息 |
| `simulator.py` 报连不上 1883 | Broker 没启动；或配置里 `allow_anonymous` 不是 true |
| 模拟器说发布成功、看板却没数据 | 1883 被 Mosquitto 自带的 Windows 服务抢走了，见上面「装完必须处理」 |
| `pip install pandas` 报找不到 `vswhere.exe` | 用的是 32 位 `python`，pandas 没有 32 位 Windows 包。改用 `py -3.14 -m pip install` |
| `analysis.py` 报「找不到 CSV」 | 还没在网页上点导出，或文件没放进 `data/`。相对路径按项目根展开，不是按当前目录 |
| `analysis.py` 报 `KeyError: '\uFEFFtime'` | 读的时候没带 `utf-8-sig`，BOM 被算进了第一列列名 |
| `analysis.py` 报「没装 matplotlib」 | `py -3.14 -m pip install matplotlib`；只想看统计就加 `--no-plot` |
| `trend.png` 里的中文是方块 | 看脚本打印的「中文字体：」那行，它会说明找到了哪个；一个都没找到时是 `!! 警告`。Windows 上装 `Microsoft YaHei`（系统自带）即可 |
| 跑测试时画图那几只显示 `s` 而不是 `.` | 没装 matplotlib，被 `skipUnless` 跳过了，不是失败 |
| 报告里趋势图是个破图图标 | `trend.png` 不在报告旁边（用了 `--no-plot`，或图被单独删了）。`write_report()` 找的是报告同目录下那张图 |
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
| 说「朗读」后只看到控制台输出 | 这是本步骤的预期行为，语音合成在 Step 3-3 |
| 运行 `.bat` 报一串「不是内部或外部命令」 | 文件被存成了 UTF-8 或 LF 行尾。三个 `.bat` 都必须是 **GBK 编码 + CRLF 行尾，且不能写 `chcp 65001`**，原因见脚本开头的注释 |

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
| `paho-mqtt` / `pandas` / `matplotlib` | `requirements.txt` 里写的是下限（`>=`），实际版本用 `py -3.14 -m pip show <包名>` 查 |
| Mosquitto | `mosquitto -h` |
| Python 解释器本身 | `py -3.14 -V` |

字体不算组件：`style.css` 用的是 `system-ui` / `Microsoft YaHei` 等**系统自带字体**，
没有随项目分发任何字体文件。`analysis.py` 画图时找的也是系统字体（脚本会打印
「中文字体：」那一行说明用了哪个）。
