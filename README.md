# DormMate Final · 多节点宿舍环境助手

M1：单个宿舍（dorm-a）的环境数据从模拟器 → MQTT → 浏览器看板的完整实时链路。
Step 2-2：网页导出的 CSV 交给 Python 读回来做基础统计。

## 目录结构

```
DormMate Final/
├── status_rules.py          # 规则（Python 侧唯一实现，发布端算 status 用）
├── config.py                # Broker / 端口 / Topic / 节点 等统一配置
├── simulator.py             # M1 数据源：生成并发布环境数据
├── shared/
│   └── rules.js             # 规则（JS 侧唯一实现，看板/Dashboard/3D 共用）
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
│   └── script.test.js       # 前端回归测试（70 条，纯 Node 无依赖）
├── mosquitto/dormmate.conf  # Mosquitto 配置：1883(TCP) + 9001(WebSocket)
├── web/                     # 前端看板（纯静态，无需构建）
│   ├── index.html
│   ├── style.css
│   ├── script.js            # 订阅渲染 + 手动录入校验/分析 + 录入历史 + 导出 CSV
│   └── vendor/mqtt.min.js   # 本地化的 mqtt.js，不依赖 CDN
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
node tests/script.test.js                         # ⑤ 页面 JS 侧，70 条
```

`unittest discover` 会把 `tests/` 下三个 `test_*.py` 一起收进来
（22 + 134 + 30 = 186 条），所以 `py -3.14` 那条要装 pandas 和 matplotlib。
`node` 那两条不需要任何依赖，也不用起服务器。

画图那几只测试在开头 `skipUnless(HAS_MPL)`：没装 matplotlib 时会**跳过**
（输出里是 `s` 不是 `.`）而不是报一堆错 —— 读 CSV、统计、复核这几步没它也
能跑，不该被一个画图依赖拖着。真要看图出没出，就看跳过了几条。

| 命令 | 管什么 |
|---|---|
| ① 22 条 | 老师给的 4 条回归数据、优先级（31/80 必须是偏热）、边界值（18/30/75 取等号）、JSON 字段与 time 格式、Topic 约定 |
| ② 134 条 | `analysis/rules.py` 是转发而非第二份实现（`assertIs` 直接比函数对象）、路径按项目根推导、CSV 读取（BOM / 缺列 / 缺文件 / 只有表头）、统计值、样例数据的 status 与规则一致；Step 2-3 的 `rule_status` 重算、不一致行识别（含温湿度缺失不能算成「正常」）、状态计数、关注列表、`summary` 的键与 JSON 可序列化、时间范围、`verbose=False`、表格的中文列宽；Step 2-4 的趋势数据整理（排序 / 跳过的行 / 缺失留 nan）、横轴时间格式、字体列表、写出的确实是 PNG、目录自动创建、空表也出图、画完不留下没关的 figure、横轴跨度为 0 时不刷警告；Step 2-5 的 HTML 转义（`<script>` 撑不破页面）、表格拼装、数字全部来自 summary（换一份数据数字跟着换）、占比与合计、关注表格只列非正常、趋势图的相对路径与占位、规则不一致时的横幅、`sections` 额外区块的顺序与转义约定、写文件的编码 / LF / 目录自动创建 |
| ③ 30 条 | 报告的段落齐全、占比、表格里的竖线/换行转义、空表不出现 `nan%`、写文件的编码与 LF 换行、结论的并列与阈值判断、报告里**不出现**建议文案（那是网页 `getAdvice()` 的活） |
| ④ 31 条 | `judgeStatus` / `getAdvice` / `runRegressionTests` 的行为，外加"不许用 export、不许碰 DOM"这类约束 |
| ⑤ 70 条 | `validateInput` 的判序、`analyze` 的四种状态与配色 class、`formatTime` 的格式与补零、录入历史的追加与倒序、CSV 的表头/BOM/CRLF/行顺序/空状态、HTML 与 JS 的 id 是否对得上、broker 地址按访问地址拼（本机 / 局域网 IP / 空 hostname）、源码里不再有写死的 `ws://localhost:9001` |

⑤ 的做法是把**真实的** `script.js` 加载进一个最小 DOM 桩里直接调函数，
不是另写一份等价逻辑——否则测的是抄来的那份，不是线上那份。它同时充当
「规则只有一份」的守门人：`script.js` 里一旦又冒出 `computeStatus` 或
`temperature < 18`，⑤ 会直接报错。

② 和 ⑤ 各踩过一次**「检查匹配到自己的注释」**的坑（注释里写了 `export`、
`toLocaleString`，检查就报失败），所以两处都是先把注释剥掉再查语法。

**改 `status_rules.py` 要跑 ①（②③ 顺带一起跑）；改 `shared/rules.js` 要跑 ④（并确认 ⑤ 还绿）。**

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
py -3.14 -m unittest discover -s tests -t . -v   # Python 侧 144 条
node tests/rules.test.js                         # JS 侧 31 条
```

`analysis/rules.py` **不算第三份实现**：它 `import ... as judge_status`，直接转发
`status_rules.compute_status`，连阈值常量都是从根模块借的。重抄一份的代价不是多打
几行字，而是以后改规则时必然漏改其中一处——发布端按新规则发「偏热」、分析端按旧规则
判成「偏湿」，两边都不报错，只是数据对不上。测试里用 `assertIs` 直接比函数对象，
一旦谁把它改成第二份实现就会红。

JS 侧只有 `shared/rules.js` 这一份。看板页面、后续的 Dashboard 和 3D 场景都从
它取函数（`<script src="../shared/rules.js">`，或者从 `web/` 出发的相对路径），
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
趋势图：C:\Users\xdj\Desktop\DormMate Final\report\trend.png（12 个点，119 KB）
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
py -3.14 "C:\Users\xdj\Desktop\DormMate Final\analysis\analysis.py" data/dormmate.csv
```

上面这条照样能找到 `C:\Users\xdj\Desktop\DormMate Final\data\dormmate.csv`。
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
"""M1 数据源：生成宿舍环境数据，按统一 JSON 格式通过 MQTT 发布。

用法示例：
    python simulator.py                      # dorm-a，演示序列，每 5 秒一条
    python simulator.py --dry-run --count 4  # 只在终端打印，不连 MQTT
    python simulator.py --mode random        # 随机温度/湿度
    python simulator.py --node dorm-b        # 换个节点（M5 用）
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from datetime import datetime

import paho.mqtt.client as mqtt

from config import (
    DEFAULT_NODE_ID,
    MQTT_HOST,
    MQTT_PASSWORD,
    MQTT_TCP_PORT,
    MQTT_USERNAME,
    PUBLISH_INTERVAL,
    QOS,
    RETAIN,
    TIME_FORMAT,
    topic_for,
)
from status_rules import compute_status

# Windows 控制台兜底：某些代码页下中文/箭头会抛 UnicodeEncodeError 直接崩掉。
# 只把无法编码的字符替换掉，不影响正常输出。
# line_buffering：输出重定向到文件/管道时也能实时看到，方便截图进报告。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="replace", line_buffering=True)

# 演示序列：依次覆盖全部 4 种 status，取值与回归测试数据一致
DEMO_SEQUENCE = [
    (16.0, 60.0),  # 偏冷
    (25.0, 60.0),  # 正常
    (25.0, 80.0),  # 偏湿
    (31.0, 78.0),  # 偏热
]


def build_payload(node_id: str, temperature: float, humidity: float,
                  now: datetime | None = None) -> dict:
    """按统一 JSON 结构组装一条数据；status 永远由规则算出，不接受外部传入。"""
    temperature = round(float(temperature), 1)
    humidity = round(float(humidity), 1)
    payload = {
        "nodeId": node_id,
        "temperature": temperature,
        "humidity": humidity,
        "status": compute_status(temperature, humidity),
        "time": (now or datetime.now()).strftime(TIME_FORMAT),
    }
    # 自检：防止以后有人绕过 compute_status 直接写 status
    assert payload["status"] == compute_status(temperature, humidity)
    return payload


def random_sample() -> tuple[float, float]:
    return round(random.uniform(8.0, 38.0), 1), round(random.uniform(30.0, 95.0), 1)


def dumps(payload: dict) -> str:
    """ensure_ascii=False 才能让 status 里的中文正常显示。"""
    return json.dumps(payload, ensure_ascii=False)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="DormMate 环境数据模拟发布器")
    p.add_argument("--node", default=DEFAULT_NODE_ID, help="节点 ID（默认 dorm-a）")
    p.add_argument("--host", default=MQTT_HOST, help="MQTT Broker 地址")
    p.add_argument("--port", type=int, default=MQTT_TCP_PORT, help="MQTT TCP 端口")
    p.add_argument("--interval", type=float, default=PUBLISH_INTERVAL, help="发布间隔秒数")
    p.add_argument("--mode", choices=("demo", "random"), default="demo",
                   help="demo=固定序列（覆盖 4 种状态）；random=随机值")
    p.add_argument("--count", type=int, default=0, help="发布条数，0 表示一直发")
    p.add_argument("--dry-run", action="store_true", help="只打印，不连 MQTT")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    topic = topic_for(args.node)
    print(f"[DormMate] 节点={args.node}  Topic={topic}  模式={args.mode}")

    client = None
    if not args.dry_run:
        client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=f"dormmate-sim-{args.node}",
        )
        if MQTT_USERNAME:
            client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
        try:
            client.connect(args.host, args.port, keepalive=60)
        except OSError as exc:
            print(f"[错误] 连不上 {args.host}:{args.port} —— {exc}", file=sys.stderr)
            print("       请先启动 Mosquitto：mosquitto -c mosquitto/dormmate.conf -v",
                  file=sys.stderr)
            return 1
        client.loop_start()
        print(f"[MQTT] 已连接 {args.host}:{args.port}")
    else:
        print("[Dry-run] 不连接 MQTT，只打印 JSON")

    sent = 0
    try:
        while args.count == 0 or sent < args.count:
            if args.mode == "random":
                temperature, humidity = random_sample()
            else:
                temperature, humidity = DEMO_SEQUENCE[sent % len(DEMO_SEQUENCE)]

            payload = build_payload(args.node, temperature, humidity)
            message = dumps(payload)

            if client is not None:
                info = client.publish(topic, message, qos=QOS, retain=RETAIN)
                if info.rc != mqtt.MQTT_ERR_SUCCESS:
                    print(f"[警告] 发布失败 rc={info.rc}", file=sys.stderr)

            sent += 1
            flag = "→" if client is not None else " "
            print(f"[{sent:>4}] {flag} {message}")

            if args.count == 0 or sent < args.count:
                time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n[DormMate] 已停止")
    finally:
        if client is not None:
            client.loop_stop()
            client.disconnect()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
# 装的时候要用 64 位解释器：
#     py -3.14 -m pip install -r requirements.txt
#
# 为什么强调 64 位：pandas 和 matplotlib 早就不发布 32 位 Windows 包了。
# PATH 上的 python 是 32 位的，在它上面 pip install pandas 会去找源码包，
# 然后因为缺少 MSVC 编译环境失败。64 位的那个解释器（C:\Program Files\Python314）
# 有现成的 wheel，直接装就行。

paho-mqtt>=2.0
pandas>=2.2
matplotlib>=3.8
