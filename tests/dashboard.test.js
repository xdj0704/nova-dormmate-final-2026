// tests/dashboard.test.js
// 校验 dashboard/dashboard.js 的 handleMessage —— 多节点看板的唯一消息入口。
//
// 重点盯三件事：
//   1) 不串线。往 dorm-a 发消息，dorm-b / dorm-c 的历史必须一个字都不变。
//      这是三节点看板最容易出的错，而且出了以后图上看着还挺像样。
//   2) 脏数据拦得住，且拦下之后不污染任何节点的历史。
//   3) status 一律用 judgeStatus 复核，报文里写什么都不算数。
//
// 做法是把 DOM 和 Chart.js 都打上桩，用 vm 把 dashboard.js 真跑起来。
// 不是静态检查，是让它真的执行一遍。
//
// 跑法：node tests/dashboard.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* ---------- DOM 打桩 ---------- */
function makeEl(id) {
  const classes = new Set();
  return {
    id, textContent: '', innerHTML: '', dataset: {},
    /* 真按钮上没写 disabled 属性时，读出来就是 false（不是 undefined）。
       照抄这个默认值 —— 不然「刚打开时按钮是灰的」那条断言拿到的是 undefined，
       真假都测不出来。 */
    disabled: false,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    _classes: classes,
    /* 把注册的回调留下来。「优先关注」那条栏的点击是事件委托（内容整块重画，
       不给每次新生成的按钮单独绑），不记下来就没法触发它 —— 而
       「点一下要切到那个节点」正是这一步的验收点之一。 */
    _handlers: {},
    addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
  };
}

const els = {};
['cards', 'log-body', 'log-count', 'detail-node', 'detail-meta', 'chart-note',
  'scene3d', 'simulate', 'clear', 'chart-temp', 'chart-humidity',
  'conn', 'conn-text', 'toggle', 'action-fan', 'action-state',
  /* Step 7-4 的三件：事件表、条数、导出按钮。
     必须列在这里 —— getElementById 对没登记的 id 会现场造一个新的，
     那样断言里读到的 els['event-body'] 和页面里那个就不是同一个对象了。 */
  'event-body', 'event-count', 'export-events',
  /* Step 8-3 的三件：顶上那一行、语音按钮、按钮下面那行说明。同理必须登记。 */
  'focus', 'speak', 'speak-note',
  /* Step 9-3 进阶项的三件：条数、结论那句、来源说明。同理必须登记。 */
  'ml-count', 'ml-text', 'ml-note']
  .forEach((id) => { els[id] = makeEl(id); });

const chartsBox = makeEl('charts');

/* 打桩也要给回和 style.css 里一样的值，不然测不出颜色有没有接错 */
const PALETTE = {
  '--chart-temp': '#2a78d6',
  '--chart-humidity': '#c9407f',
  '--chart-grid': 'rgba(11, 11, 11, 0.08)',
  '--text-muted': '#898781',
  '--surface-1': '#fcfcfb',
};

/* 导出 CSV 那条路（Step 7-4）要用到 vm 里没有的三样东西：Blob、URL、
   以及 document.createElement —— 真实现是临时造一个 <a download> 插进 body
   再点它一下。不补这三样，点导出按钮就是 ReferenceError，
   而「导出的字节到底对不对」正是这一步最该测的东西。
   每一件都把调用记下来，测试才能在没有真浏览器的情况下把那份 CSV 拿到手。 */
const blobs = [];
class BlobStub {
  constructor(parts, options) {
    this.parts = parts;
    this.type = options && options.type;
    /* 真 Blob 是二进制，这里只关心文本，拼起来就够了 */
    this.text = parts.join('');
    blobs.push(this);
  }
}
const objectUrls = [];
const revokedUrls = [];
const clickedAnchors = [];
const appendedNodes = [];
const removedNodes = [];
/* 只记不执行：setTimeout 在 dashboard.js 里只用于「延迟回收 objectURL」那一处，
   立刻执行就把「隔了一会儿才 revoke」这个行为测没了。测试自己挑时候触发。 */
const timers = [];

const documentStub = {
  documentElement: makeEl('html'),
  getElementById: (id) => els[id] || makeEl(id),
  querySelector: (sel) => (sel === '.charts' ? chartsBox : makeEl(sel)),
  querySelectorAll: () => [],
  addEventListener() {},
  createElement(tag) {
    const node = makeEl(tag);
    node.tag = tag;
    node.click = () => clickedAnchors.push(node);
    return node;
  },
  body: {
    appendChild: (n) => appendedNodes.push(n),
    removeChild: (n) => removedNodes.push(n),
  },
};

const URLStub = {
  createObjectURL(blob) {
    const url = 'blob:stub/' + (objectUrls.length + 1);
    objectUrls.push({ url, blob });
    return url;
  },
  revokeObjectURL(url) { revokedUrls.push(url); },
};

/* ---------- Chart.js 打桩 ---------- */
const builtCharts = [];
class ChartStub {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.data = config.data;
    this.options = config.options;
    this.updates = 0;
    this.constructorArgs = { type: config.type };
    builtCharts.push(this);
  }
  update() { this.updates += 1; }
}

/* ---------- mqtt.js 打桩 ---------- */
/* 不打桩的话 connect() 会走进「未加载 mqtt.js」那条分支，MQTT 这段等于没测。
   这里把 connect/subscribe/on 都记下来，测试就能主动触发握手、主动投递消息。 */
const mqttStub = {
  clients: [],
  connect(url, opts) {
    const handlers = {};
    const c = {
      url, opts, handlers, subscribed: [], ended: false,
      on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return c; },
      subscribe(topic, o, cb) { c.subscribed.push(topic); if (cb) cb(null); return c; },
      end() { c.ended = true; return c; },
    };
    mqttStub.clients.push(c);
    return c;
  },
};

/* ---------- 3d/scene.js 打桩 ---------- */
/* 不记录的话就测不出「切节点 / 收到新消息时到底有没有把状态交给 3D」——
   而这正是 Step 6-3 的全部内容。
   打桩挂的是 createDorm3D（模块里 import 的那个名字），不是 3D 场景本身。 */
const sceneCalls = [];
function createDorm3DStub(hostId) {
  const rec = { hostId, statuses: [], labels: [], fans: [], focus: [], ops: [], disposed: 0 };
  sceneCalls.push(rec);
  return {
    /* 真的那个也会返回「实际生效的状态」，所以桩照做 ——
       renderScene 拿它的返回值拼标签文字。 */
    updateScene(status) { rec.statuses.push(status); rec.ops.push('updateScene'); return status; },
    setLabel(text) { rec.labels.push(text); return text; },
    /* setFanOn 要记下来（Step 7-2）：这一步的验收点之一是「点了按钮风扇得转」，
       不记的话调没调、传的是 true 还是 false，全都测不出来。
       ops 是按调用顺序记的**混在一起**的流水 ——
       scene.js 里那句「后调用的那次为准」意味着 updateScene 和 setFanOn
       的先后顺序本身就是一个必须钉住的约定，分开两个数组就看不出顺序了。 */
    setFanOn(on) { rec.fans.push(on); rec.ops.push('setFanOn'); },
    /* setFocus 是 Step 8-3 加的：画面里那圈「当前重点」的环亮不亮。
       和 setFanOn 一样要按顺序记 —— 「什么时候亮的」本身就是这一步的验收点，
       而它和 updateScene 的先后顺序（场景先重画、再开关环）也在这里钉住。 */
    setFocus(on) { rec.focus.push(!!on); rec.ops.push('setFocus'); },
    dispose() { rec.disposed += 1; },
  };
}

/* ---------- speechSynthesis 打桩（Step 8-3）----------
   真浏览器里 speak() 是异步出声的，测试环境没有声卡、也不需要。
   这一步要验的是「按下按钮之后按顺序做了什么」：
     先 cancel 再 speak（不 cancel 的话连点两次，第二句要排队等第一句念完）、
     utterance 的 lang 设成了 zh-CN、
     onerror 把**原始错误码**写进了那行说明。
   所以三件事各记一份；顺序单独记在 speechLog 里 ——
   只看 cancelled 和 uttered 两个计数是看不出先后顺序的。 */
const speechLog = [];
const spoken = [];
function SpeechSynthesisUtteranceStub(text) {
  this.text = text;
  this.lang = '';
  this.onerror = null;
  spoken.push(this);
}
const speechStub = {
  cancelled: 0,
  uttered: [],
  cancel() { this.cancelled += 1; speechLog.push('cancel'); },
  /* 记下交给 speak 的那一个，好在断言里确认「念的」和「造出来的」是同一句 ——
     造了一个 A、念了另一个 B 的话，两边的计数都对得上，只有这一份能看出来。 */
  speak(u) { this.uttered.push(u); speechLog.push('speak'); },
};

/* ---------- fetch 打桩（Step 9-3 的进阶项）----------
   看板打开时会 fetch('../report/ml_result.json')，把 C 部分那份 ML 结果读来显示。
   vm 里没有 fetch，不打桩就是 ReferenceError —— 而这一段的验收点
   （读到了摆什么、404 摆什么、回来不是 JSON 又摆什么）全都发生在
   promise 回来**之后**，所以桩不能直接把结果给出去：
   它把 resolve / reject 存起来，让测试自己挑时候放行（R 段），
   放行之后还要等一轮微任务才读得到页面 —— 见 R 段那个 settle()。 */
const fetchCalls = [];
const fetchPending = [];
function fetchStub(url) {
  fetchCalls.push(url);
  return new Promise((resolve, reject) => { fetchPending.push({ resolve, reject }); });
}

const context = {
  document: documentStub,
  Chart: ChartStub,
  mqtt: mqttStub,
  fetch: fetchStub,
  createDorm3D: createDorm3DStub,
  location: { hostname: 'localhost' },
  getComputedStyle: () => ({ getPropertyValue: (n) => PALETTE[n] || '' }),
  window: {
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    speechSynthesis: speechStub,
    SpeechSynthesisUtterance: SpeechSynthesisUtteranceStub,
  },
  Blob: BlobStub,
  URL: URLStub,
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  console,
  JSON, Math, Date, Number, Object, Array, String, Set, isNaN, parseInt,
};
context.globalThis = context;
context.window.document = documentStub;

/* ---------- 加载 shared/rules.js，再加载 dashboard.js ---------- */

/* Step 6-3 起 dashboard.js 是 ES 模块（它 import 了 ../3d/scene.js），
   Step 7-1 又多了一条（./logic.js）。而 vm.runInContext 只能跑普通脚本 ——
   原样喂进去会抛「Cannot use import statement outside a module」。

   处理方式和 tests/scene3d.test.js 里改写 'three' 那个标识符是一个思路：
   把 import 那两行摘掉。摘之前先数一遍，必须正好两条；
   将来谁再加一条 import，这里立刻炸出来，而不是把那条也悄悄摘了、测了个假的。

   两条摘掉之后顶上放的东西不一样：
     ../3d/scene.js —— 换成打桩的 createDorm3D（3D 不是这一步要测的）
     ./logic.js     —— 换成**真文件**（见下面 runInContext 那段）
   这么分是因为「优先关注」的比较规则正是 Step 7-1 的全部内容，
   处理动作的状态机（beginHandling / nextHandling）是 Step 7-2 的全部内容，
   打个桩等于把要测的东西测没了。

   注意这只是**跑起来**的方式。原文件里到底怎么写的那两行，
   由下面 M 段的两条静态断言盯着（正则 + 文件真的在）。 */
const SCENE_IMPORT = /^import\s*\{\s*createDorm3D\s*\}\s*from\s*'\.\.\/3d\/scene\.js';\s*$/m;
/* 这条 import 在源码里折成了两行（Step 7-4 起函数变多，一行放不下），
   所以分隔符一律写 \s —— 它能匹配换行，折行处那几个空格加换行才过得去。
   写成 [ ] 或字面空格的话，摘不掉 import，下一句 vm 会抛
   「Cannot use import statement outside a module」。 */
const LOGIC_IMPORT = /^import\s*\{\s*pickPriority\s*,\s*nextAbnormal\s*,\s*beginHandling\s*,\s*nextHandling\s*,\s*beginEvent\s*,\s*markPriority\s*,\s*markAction\s*,\s*closeEvent\s*,\s*buildFocus\s*,\s*buildAlert\s*,\s*buildMlNote\s*,\s*mlFetchFailed\s*\}\s*from\s*'\.\/logic\.js';\s*$/m;
const DASH_SRC = path.join(ROOT, 'dashboard', 'dashboard.js');
const LOGIC_SRC = path.join(ROOT, 'dashboard', 'logic.js');
const RULES_SRC = path.join(ROOT, 'shared', 'rules.js');
const dashText = fs.readFileSync(DASH_SRC, 'utf8');
const importCount = (dashText.match(/^import\s/gm) || []).length;

vm.createContext(context);
vm.runInContext(fs.readFileSync(RULES_SRC, 'utf8'), context, { filename: RULES_SRC });

/* logic.js 跑真的那份。它同样是 ES 模块，把 `export ` 前缀摘掉就行 ——
   函数名照旧留在作用域里，顶层 function 声明在 vm 里就是上下文的全局属性。
   两个脚本共用一个上下文，所以后面 dashboard.js 里那句 pickPriority 调到的
   就是这里定义的那一个。

   顺带一个副作用是好事：logic.js 和 dashboard.js 的顶层名字撞了的话，
   这里会当场抛「Identifier 'x' has already been declared」，不会悄悄跑过去。 */
vm.runInContext(fs.readFileSync(LOGIC_SRC, 'utf8').replace(/^export\s+/gm, ''),
  context, { filename: LOGIC_SRC });

let src = dashText;
src = src.replace(SCENE_IMPORT, '/* import 已摘除：顶上用的是上下文里的 createDorm3D 打桩 */\n');
src = src.replace(LOGIC_IMPORT, '/* import 已摘除：上面跑的是真的 logic.js */\n');
/* 只加测试钩子，不改原文件 */
src += `
;globalThis.__nodes = nodes;
globalThis.__messages = messages;
globalThis.__simulate = simulate;
globalThis.__clearAll = clearAll;
globalThis.__selectNode = selectNode;
globalThis.__current = function () { return currentNodeId; };
globalThis.__topicNode = topicNode;
globalThis.__connect = connect;
globalThis.__disconnect = disconnect;
globalThis.__renderScene = renderScene;
globalThis.__renderFocus = renderFocus;
globalThis.__speakAlert = speakAlert;
globalThis.__events = events;
globalThis.__renderEvents = renderEvents;
globalThis.__buildEventsCSV = buildEventsCSV;
globalThis.__exportEventsCSV = exportEventsCSV;
globalThis.__loadMlResult = loadMlResult;
`;
vm.runInContext(src, context, { filename: DASH_SRC });

/* 页面刚加载完、一条数据都还没收到的那一刻，顶上那一行画了什么。
   先存下来 —— 后面各段都会往里灌数据，之后就再也看不到这个状态了。
   N 段拿它验「启动时就画好了」和「没数据时不谎称都正常」。 */
const FOCUS_AT_LOAD = els.focus.innerHTML;

/* 那圈「当前重点」的环在启动那一刻是什么样，同样先存下来 ——
   M 段读到的已经是 A~L 跑完之后的流水了（几十次调用），
   要验「刚起来时就接过一次、传的是 false」只能靠这一份快照。 */
const RING_AT_LOAD = sceneCalls[0].focus.slice();

/* 处理动作那一行刚加载完的样子，同样先存下来 ——
   O 段一上来就 clearAll()，那之后再读到的就是「清空之后」画出来的，
   而不是「启动时」画出来的了。少了这一份，把文件末尾那次 renderAction()
   删掉也不会有人发现：按钮的 disabled 是 makeEl 给的默认值，看着照样是灰的。 */
const ACTION_AT_LOAD = {
  disabled: els['action-fan'].disabled,
  text: els['action-state'].textContent,
};

/* 事件记录那一块刚加载完的样子。同样的道理：P 段一上来就 clearAll()，
   那之后再读到的就是「清空之后」画出来的。少了这一份，
   把文件末尾那次 renderEvents() 删掉也不会有人发现 ——
   tbody 本来就是空的，看着跟「渲染过了、只是没有事件」一模一样。 */
const EVENTS_AT_LOAD = {
  disabled: els['export-events'].disabled,
  count: els['event-count'].textContent,
  body: els['event-body'].innerHTML,
};

/* ML 那一块刚加载完的样子。这一份和上面几份不一样：它不是「别的段会把它改掉」，
   而是**测试自己**在 R 段会把 fetch 放行、让页面重画它。到那时候再读，
   拿到的就是「读回来之后」的样子了 —— 要验「读回来之前不是一片空白」
   只能靠这一份快照。 */
const ML_AT_LOAD = {
  count: els['ml-count'].textContent,
  text: els['ml-text'].textContent,
};

const { handleMessage, __nodes: nodes, __messages: messages, __simulate: simulate,
  __clearAll: clearAll, __selectNode: selectNode, __current: current,
  __topicNode: topicNode, __connect: connect, __disconnect: disconnect,
  __renderScene: renderScene, __renderFocus: renderFocus, __speakAlert: speakAlert,
  __events: events, __buildEventsCSV: buildEventsCSV,
  __loadMlResult: loadMlResult, buildMlNote, mlFetchFailed,
  pickPriority, beginHandling, nextHandling,
  buildFocus, buildAlert } = context;

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? `  =>  ${a}` : `\n        实际: ${a}\n        期望: ${e}`));
}
/* time 可以指定。不指定时用这个固定的默认值。
   「优先关注」的时长完全由 time 决定（故意不读浏览器当前时间），
   所以 N 段必须能逐条控制它，否则时长那几条没法写出定值。 */
const DEFAULT_TIME = '2026-09-22 20:30:00';
function mk(nodeId, t, h, status, time) {
  return JSON.stringify({
    nodeId, temperature: t, humidity: h,
    status: status === undefined ? context.judgeStatus(t, h) : status,
    time: time === undefined ? DEFAULT_TIME : time,
  });
}
const top = () => messages[0];

/* ============ A. 模拟三节点数据 ============ */
console.log('\n=== A. simulate() 后三个节点各自的数据 ===');
simulate();

check('三个节点都收到了 3 条', ['dorm-a', 'dorm-b', 'dorm-c'].map((id) => nodes[id].history.length), [3, 3, 3]);
check('dorm-a 温度序列', nodes['dorm-a'].history.map((r) => r.temperature), [25, 26, 24]);
check('dorm-a 湿度序列', nodes['dorm-a'].history.map((r) => r.humidity), [60, 62, 58]);
check('dorm-b 温度序列', nodes['dorm-b'].history.map((r) => r.temperature), [31, 33, 32]);
check('dorm-b 湿度序列', nodes['dorm-b'].history.map((r) => r.humidity), [60, 55, 58]);
check('dorm-c 温度序列', nodes['dorm-c'].history.map((r) => r.temperature), [25, 26, 24]);
check('dorm-c 湿度序列', nodes['dorm-c'].history.map((r) => r.humidity), [80, 82, 79]);
check('dorm-a 状态序列', nodes['dorm-a'].history.map((r) => r.status), ['正常', '正常', '正常']);
check('dorm-b 状态序列', nodes['dorm-b'].history.map((r) => r.status), ['偏热', '偏热', '偏热']);
check('dorm-c 状态序列', nodes['dorm-c'].history.map((r) => r.status), ['偏湿', '偏湿', '偏湿']);
check('每条的 nodeId 和所在节点一致', ['dorm-a', 'dorm-b', 'dorm-c'].map(
  (id) => nodes[id].history.every((r) => r.nodeId === id)), [true, true, true]);
check('latest 就是各自最后一条', ['dorm-a', 'dorm-b', 'dorm-c'].map((id) => nodes[id].latest.temperature), [24, 32, 24]);
check('一次都没出现 warn/error（模拟数据是干净的）',
  messages.filter((m) => m.level !== 'ok').length, 0);
check('日志条数 = 9 条 ok', messages.length, 9);

/* ============ B. 图表跟着当前节点走 ============ */
console.log('\n=== B. 图表数据 ===');
check('建了 2 张图（温度、湿度各一张，不是双 Y 轴）', builtCharts.length, 2);
const tempChart = builtCharts[0], humChart = builtCharts[1];
check('温度图序列色', tempChart.data.datasets[0].borderColor, '#2a78d6');
check('湿度图序列色', humChart.data.datasets[0].borderColor, '#c9407f');
check('温度图数据 = dorm-a 的温度', tempChart.data.datasets[0].data, [25, 26, 24]);
check('湿度图数据 = dorm-a 的湿度', humChart.data.datasets[0].data, [60, 62, 58]);
check('湿度图没有混进 dorm-c 的 80/82/79', humChart.data.datasets[0].data.includes(80), false);
/* simulate() 里的 time 是 formatTime(new Date())，用的是真实当前时间，
   所以不能断言具体时刻，只能断言它确实来自这个节点自己的 time 字段 */
check('横轴标签 = dorm-a 自己三条 time 的时分秒',
  tempChart.data.labels, nodes['dorm-a'].history.map((r) => r.time.slice(11, 19)));
check('横轴标签都是 HH:mm:ss 形状',
  tempChart.data.labels.every((l) => /^\d{2}:\d{2}:\d{2}$/.test(l)), true);
check('横轴标签逐条递增',
  tempChart.data.labels.join() === tempChart.data.labels.slice().sort().join(), true);

/* ============ C. 切换当前节点 ============ */
console.log('\n=== C. 点卡片切节点 ===');
check('默认看 dorm-a', current(), 'dorm-a');
selectNode('dorm-c');
check('切到 dorm-c', current(), 'dorm-c');
check('切完后温度图 = dorm-c 的温度', tempChart.data.datasets[0].data, [25, 26, 24]);
check('切完后湿度图 = dorm-c 的湿度（不再是 60/62/58）', humChart.data.datasets[0].data, [80, 82, 79]);
selectNode('dorm-b');
check('切到 dorm-b 的温度图', tempChart.data.datasets[0].data, [31, 33, 32]);
check('切到 dorm-b 的湿度图', humChart.data.datasets[0].data, [60, 55, 58]);
selectNode('不存在');
check('切到不存在的节点被忽略', current(), 'dorm-b');
selectNode('dorm-b');
check('重复点同一个节点不出错', current(), 'dorm-b');

/* ============ D. 不串线：单独喂一个节点，别的节点纹丝不动 ============ */
console.log('\n=== D. 往 dorm-a 再喂一条，b/c 不受影响 ===');
const beforeB = JSON.stringify(nodes['dorm-b'].history);
const beforeC = JSON.stringify(nodes['dorm-c'].history);
const okD = handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 17, 50));
check('收下了', okD, true);
check('dorm-a 变 4 条', nodes['dorm-a'].history.length, 4);
check('dorm-a 最新一条是 17℃', nodes['dorm-a'].latest.temperature, 17);
check('dorm-a 最新状态是偏冷', nodes['dorm-a'].latest.status, '偏冷');
check('dorm-b 一条没动', JSON.stringify(nodes['dorm-b'].history) === beforeB, true);
check('dorm-c 一条没动', JSON.stringify(nodes['dorm-c'].history) === beforeC, true);

/* ============ E. 脏数据必须被拦下 ============ */
console.log('\n=== E. 校验：脏数据 ===');
const badCases = [
  ['不是 JSON', 'dormmate/v1/nodes/dorm-a/telemetry', '{不是 json', 'error'],
  ['空字符串', 'dormmate/v1/nodes/dorm-a/telemetry', '', 'error'],
  ['顶层是 null', 'dormmate/v1/nodes/dorm-a/telemetry', 'null', 'error'],
  ['顶层是数字', 'dormmate/v1/nodes/dorm-a/telemetry', '123', 'error'],
  ['顶层是数组', 'dormmate/v1/nodes/dorm-a/telemetry', '[1,2,3]', 'error'],
  ['缺 nodeId', 'dormmate/v1/nodes/dorm-a/telemetry', '{"temperature":25,"humidity":60,"status":"正常","time":"t"}', 'error'],
  ['缺 temperature', 'dormmate/v1/nodes/dorm-a/telemetry', '{"nodeId":"dorm-a","humidity":60,"status":"正常","time":"t"}', 'error'],
  ['缺 humidity', 'dormmate/v1/nodes/dorm-a/telemetry', '{"nodeId":"dorm-a","temperature":25,"status":"正常","time":"t"}', 'error'],
  ['缺 status', 'dormmate/v1/nodes/dorm-a/telemetry', '{"nodeId":"dorm-a","temperature":25,"humidity":60,"time":"t"}', 'error'],
  ['缺 time', 'dormmate/v1/nodes/dorm-a/telemetry', '{"nodeId":"dorm-a","temperature":25,"humidity":60,"status":"正常"}', 'error'],
  ['temperature 是字符串', 'dormmate/v1/nodes/dorm-a/telemetry', '{"nodeId":"dorm-a","temperature":"25","humidity":60,"status":"正常","time":"t"}', 'error'],
  ['humidity 是 null', 'dormmate/v1/nodes/dorm-a/telemetry', '{"nodeId":"dorm-a","temperature":25,"humidity":null,"status":"正常","time":"t"}', 'error'],
  ['temperature 是 NaN', 'dormmate/v1/nodes/dorm-a/telemetry', '{"nodeId":"dorm-a","temperature":null,"humidity":60,"status":"正常","time":"t"}', 'error'],
  ['未知节点', 'dormmate/v1/nodes/dorm-x/telemetry', mk('dorm-x', 25, 60), 'error'],
];
const beforeAll = JSON.stringify([nodes['dorm-a'].history, nodes['dorm-b'].history, nodes['dorm-c'].history]);
badCases.forEach(([label, topic, body, wantLevel]) => {
  const r = handleMessage(topic, body);
  const m = top();
  check(`${label} -> 被拦下`, r, false);
  check(`${label} -> 日志级别 ${wantLevel}`, m.level, wantLevel);
});
check('一堆脏数据进来，三个节点的历史一条没变',
  JSON.stringify([nodes['dorm-a'].history, nodes['dorm-b'].history, nodes['dorm-c'].history]) === beforeAll, true);

/* ============ F. status 复核 ============ */
console.log('\n=== F. status 复核（以规则为准）===');
const nF = messages.length;
const okF = handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 31, 80, '偏湿'));   // 约定里点名的坑
check('说偏湿、规则算偏热 -> 仍然收下', okF, true);
check('一条报文只记一行日志', messages.length - nF, 1);
check('日志级别是 warn', top().level, 'warn');
check('日志点明了两个值', /收到「偏湿」.*规则算出「偏热」/.test(top().text), true);
check('存下来的是规则结果「偏热」', nodes['dorm-a'].latest.status, '偏热');

handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 16, 60, '正常'));
check('说正常、规则算偏冷 -> warn', top().level, 'warn');
check('存下来的是偏冷', nodes['dorm-b'].latest.status, '偏冷');

handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 25, 60, '正常'));
check('status 一致时不报警', top().level, 'ok');

/* ============ G. topic 与 nodeId 不一致 ============ */
console.log('\n=== G. topic 和报文里的节点对不上 ===');
const nG = messages.length;
const okG = handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-c', 25, 80));
check('仍然收下（节点以报文为准）', okG, true);
check('仍然只记一行日志', messages.length - nG, 1);
check('日志级别是 warn', top().level, 'warn');
check('提示点明了两个节点名', /topic 里是 dorm-a，报文里是 dorm-c/.test(top().text), true);
check('写进了报文说的 dorm-c', nodes['dorm-c'].latest.temperature, 25);
check('没写进 topic 说的 dorm-a', nodes['dorm-a'].latest.temperature, 31);

console.log('\n=== H. topic 形状不对时不误报 ===');
check('topicNode 正常', topicNode('dormmate/v1/nodes/dorm-a/telemetry'), 'dorm-a');
check('topicNode 形状不对返回空串', topicNode('随便什么'), '');
check('topicNode 对 null 不炸', topicNode(null), '');
// 迁移到 v1 之前的旧形状必须不再认（认了就等于两个 topic 都能进门）
check('旧的三段式 topic 不再认', topicNode('dormmate/dorm-a/env'), '');
check('少了 v1 段不认', topicNode('dormmate/nodes/dorm-a/telemetry'), '');
check('尾段不是 telemetry 不认', topicNode('dormmate/v1/nodes/dorm-a/env'), '');
handleMessage('随便什么', mk('dorm-a', 25, 60));
check('形状不对的 topic 不产生额外 warn', top().level, 'ok');

/* ============ I. 历史上限 ============ */
console.log('\n=== I. 历史上限 ===');
clearAll();
for (let i = 0; i < 60; i += 1) handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 20 + (i % 5), 50));
check('dorm-a 历史上限 50 条', nodes['dorm-a'].history.length, 50);
check('留下的是最新的那批（最后一条 20+59%5=24）', nodes['dorm-a'].latest.temperature, 20 + (59 % 5));
check('dorm-b 依旧为空', nodes['dorm-b'].history.length, 0);

/* ============ J. 清空 ============ */
console.log('\n=== J. 清空 ===');
clearAll();
check('三个节点都空了', ['dorm-a', 'dorm-b', 'dorm-c'].map((id) => nodes[id].history.length), [0, 0, 0]);
check('latest 也清了', ['dorm-a', 'dorm-b', 'dorm-c'].map((id) => nodes[id].latest), [null, null, null]);
check('日志清空', messages.length, 0);
check('清空后没炸', true, true);

/* ============ K. MQTT 接线 ============ */
console.log('\n=== K. MQTT 接线 ===');
check('打开页面就连了 Broker', mqttStub.clients.length, 1);
const mc = mqttStub.clients[0];
check('连的地址由页面 hostname 拼出来', mc.url, 'ws://localhost:9001');
check('还没握手成功时不订阅', mc.subscribed, []);
check('刚打开时状态是「连接中…」', els['conn-text'].textContent, '连接中…');

/* 模拟 Broker 握手成功 */
mc.handlers.connect.forEach((fn) => fn());
check('连上后订阅 dormmate/v1/nodes/+/telemetry', mc.subscribed,
  ['dormmate/v1/nodes/+/telemetry']);
check('状态变成「已连接」', els['conn-text'].textContent, '已连接');
check('指示灯切到绿色那档', els.conn.className, 'conn conn--on');

/* 真投一条 MQTT 消息进来 —— 这一步的核心：消息要一路走到 handleMessage */
clearAll();
mc.handlers.message.forEach((fn) => fn('dormmate/v1/nodes/dorm-b/telemetry', JSON.stringify({
  nodeId: 'dorm-b', temperature: 31, humidity: 60, status: '偏热', time: '2026-09-22 20:30:00',
})));
check('MQTT 消息落到了 dorm-b', nodes['dorm-b'].history.length, 1);
check('就是那条 31℃', nodes['dorm-b'].latest.temperature, 31);
check('dorm-a 没被牵连', nodes['dorm-a'].history.length, 0);
check('dorm-c 没被牵连', nodes['dorm-c'].history.length, 0);
check('日志级别 ok', top().level, 'ok');

/* 走 MQTT 进来的脏数据，被同一条链路拦下 */
mc.handlers.message.forEach((fn) => fn('dormmate/v1/nodes/dorm-b/telemetry', '{坏掉的 json'));
check('MQTT 来的脏 JSON 被拦下', top().level, 'error');
check('拦下后没写进历史', nodes['dorm-b'].history.length, 1);

/* 原始报文要往 Console 打一行（排错用）。
   把 console.log 临时换成收集器 —— 不换的话每跑一次测试都要刷一大片屏。
   注意 ctx 里传的就是 Node 的 console 本身，所以要还原回去。 */
const realLog = console.log;
const logged = [];
console.log = (...args) => { logged.push(args); };
mc.handlers.message.forEach((fn) => fn('dormmate/v1/nodes/dorm-c/telemetry', JSON.stringify({
  nodeId: 'dorm-c', temperature: 25, humidity: 80, status: '偏湿', time: '2026-09-22 20:30:00',
})));
console.log = realLog;

check('每条原始报文打一行 Console', logged.length, 1);
check('打印的是 topic', logged[0][1], 'dormmate/v1/nodes/dorm-c/telemetry');
check('打印的是原始报文原文，不是解析后的对象',
  logged[0][2], '{"nodeId":"dorm-c","temperature":25,"humidity":80,"status":"偏湿","time":"2026-09-22 20:30:00"}');

/* 被拦下的报文更要打印 —— 排错时最需要的就是这一条 */
console.log = (...args) => { logged.push(args); };
mc.handlers.message.forEach((fn) => fn('dormmate/v1/nodes/dorm-c/telemetry', '{又一条坏 json'));
console.log = realLog;
check('被拦下的报文同样打印了', logged.length, 2);
check('打印内容就是那段坏文本', logged[1][2], '{又一条坏 json');

/* 反过来的要求：模拟按钮的数据不该混进「实收报文」里冒充真消息 */
console.log = (...args) => { logged.push(args); };
simulate();
console.log = realLog;
check('模拟数据不冒充「实收报文」（Console 里不出现）', logged.length, 2);

/* 断开 */
disconnect();
check('断开时强制 end，不再自动重连', mc.ended, true);
check('状态回到「未连接」', els['conn-text'].textContent, '未连接');
/* 旧连接的 close 回调补触发一次，不该把状态覆盖回去 */
mc.handlers.close.forEach((fn) => fn());
check('旧连接的 close 回调不覆盖当前状态', els['conn-text'].textContent, '未连接');

connect();
check('能重新连一根', mqttStub.clients.length, 2);
const mc2 = mqttStub.clients[1];
check('重连后状态是「连接中…」', els['conn-text'].textContent, '连接中…');
connect();
check('已经连着时再点「连接」不会叠第二根', mqttStub.clients.length, 2);
mc2.handlers.connect.forEach((fn) => fn());
check('第二根也订阅同样的 topic', mc2.subscribed, ['dormmate/v1/nodes/+/telemetry']);
check('第二根连上后状态是「已连接」', els['conn-text'].textContent, '已连接');

mc2.handlers.reconnect.forEach((fn) => fn());
check('掉线重连时显示「重连中…」', els['conn-text'].textContent, '重连中…');
mc2.handlers.connect.forEach((fn) => fn());
check('重连成功后回到「已连接」', els['conn-text'].textContent, '已连接');

/* 出错分支：console.error 是故意调的，这里临时静音，免得刷屏 */
const realError = console.error;
console.error = () => {};
mc2.handlers.error.forEach((fn) => fn(new Error('boom')));
console.error = realError;
check('连接出错显示「连接失败」', els['conn-text'].textContent, '连接失败');

/* ============ M. 3D 视图接线（Step 6-3）============ */
console.log('\n=== M. 3D 视图接线 ===');

/* 这个桩是按调用顺序把所有状态和文字都记下来的。
   这一段要盯的就一件事：**画面跟的是「当前选中的节点」，不是「最后一个发消息的节点」**。
   三个宿舍的数据混在同一个通配符 topic 里进来，这一步最容易出的错就是
   dorm-b 一来就把画面改成 dorm-b 的样子，而左上角还写着 dorm-a ——
   屏幕上看着挺正常，只有盯着标签才发现对不上。 */
const scene = sceneCalls[0];
const lastStatus = () => scene.statuses[scene.statuses.length - 1];
const lastLabel = () => scene.labels[scene.labels.length - 1];

/* --- 接线本身 --- */

check('★ dashboard.js 只有两条 import（上面摘 import 靠的是两条正则，多一条会被漏掉）',
  importCount, 2);
check('★ 其中一条拿的是 ../3d/scene.js 里的 createDorm3D（不是 3d/index.html 里那份拷贝）',
  SCENE_IMPORT.test(dashText), true);
check('那个文件真的在（../ 是相对 dashboard.js 自己算的，不是相对页面）',
  fs.existsSync(path.join(ROOT, '3d', 'scene.js')), true);

const dashHtml = fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf8');
const modAt = dashHtml.indexOf('<script type="module"');
const mapAt = dashHtml.indexOf('<script type="importmap">');

check('★ dashboard.js 用 type="module" 载入（不然 import 直接是语法错）',
  dashHtml.indexOf('<script type="module" src="dashboard.js">') >= 0, true);
check('★ dashboard 也有一张 importmap（scene.js 里写的是裸名字 three，'
  + 'importmap 是文档级的，缺了它就在 scene.js 里报「Failed to resolve」）',
  mapAt >= 0, true);
check('★ importmap 排在模块脚本之前（顺序反了浏览器不认）',
  mapAt >= 0 && modAt > mapAt, true);
check('★ type="module" 全页只有一处（只该有 dashboard.js 那一条）',
  (dashHtml.match(/<script[^>]*type="module"/g) || []).length, 1);
check('★ mqtt.js / Chart.js / rules.js 都还在模块脚本之前 —— 它们挂的是全局变量，'
  + '必须在模块跑起来之前挂好',
  ['lib/mqtt.min.js', 'chart.umd.min.js', '../shared/rules.js']
    .every((f) => dashHtml.slice(0, modAt).includes(f)), true);
check('容器 #scene3d 在页面上', dashHtml.indexOf('<div id="scene3d">') >= 0, true);

/* --- 初始化 --- */

check('页面起来时建了一个 3D 场景', sceneCalls.length, 1);
check('★ 建的时候容器 id 和 index.html 里那个一致（对不上就挂到别的元素里去了）',
  scene.hostId, 'scene3d');
check('★ 打开页面时覆盖层写的是「还没有收到数据」，不假装有数据',
  scene.labels[0].includes('还没有收到数据'), true);
check('初始场景退回「正常」的外观（空白或半成品分不清是没数据还是坏了）',
  scene.statuses[0], '正常');
/* ★ 页面起来的时候就已经调过一次 setFocus 了 —— renderScene 的尾巴上那一句。
   少了它（或者 scene.js 的返回值里根本没有 setFocus），那圈「当前重点」的环
   永远不会出现，而那是在 renderScene 里头，页面上一点异常都看不出来。
   （scene.js 那一侧的契约由 tests/scene3d.test.js 单独钉。） */
check('★ 页面起来时就调过一次 setFocus，传的是 false'
  + '（一条数据都没有，没有重点可言 —— 不是留着上一次的亮着的环）',
  RING_AT_LOAD, [false]);

/* --- 只画当前选中的那个节点 --- */

clearAll();
check('★ 清空后 3D 立刻退回「还没有收到数据」', lastLabel().includes('还没有收到数据'), true);
check('清空后场景退回「正常」', lastStatus(), '正常');

/* C 段留下的当前节点是 dorm-b。这时喂一条 dorm-a 的：
   数据要收下，画面一个字都不能动。 */
const nStatus = scene.statuses.length;
const nLabel = scene.labels.length;
handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 31, 60));
check('dorm-a 的数据收下了', nodes['dorm-a'].latest.status, '偏热');
check('★ 不是当前节点的消息：3D 一次都没被调', scene.statuses.length, nStatus);
check('★ 覆盖层也一个字没动（还写着 dorm-b）', scene.labels.length, nLabel);

/* 切过去：不用等新数据，立刻画出它那条的样子 */
selectNode('dorm-a');
check('★ 切到已有数据的节点，立刻画出它的状态', lastStatus(), '偏热');
/* ★ 8-3 起标签上**只有宿舍名**。
   原来这里还写着状态和温湿度，那是把卡片上的信息又抄了一遍 ——
   而这一行落在画面正中间，看的人分不清哪个是「场景」哪个是「文字面板」。
   分工：宿舍名是画面答不出来的（画里只有一间屋，不说不知道是哪个），
   所以留在这儿；「这间怎么了」交给画面自己说（地板颜色、窗户开合、风扇转不转）；
   温湿度是卡片的事。 */
check('★ 覆盖层只写宿舍名', lastLabel(), '当前宿舍：dorm-a');
check('★ 状态不再抄进标签（交给画面自己表达）', lastLabel().includes('偏热'), false);
check('★ 温湿度也不再抄进标签（那是卡片的信息）',
  [lastLabel().includes('31℃'), lastLabel().includes('60%')], [false, false]);

/* 反方向再来一遍，确认不是「第一次刚好对了」 */
const n2 = scene.statuses.length;
handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 25, 80));
check('★ 当前是 dorm-a，dorm-b 的消息同样不改画面',
  scene.statuses.length, n2);
selectNode('dorm-b');
check('★ 切到 dorm-b，画的是它自己的偏湿', lastStatus(), '偏湿');

const n3 = scene.statuses.length;
handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 16, 60));
check('★ 当前节点收到新消息，画面跟着变', lastStatus(), '偏冷');
check('确实重画了（不是恰好在上一行就画好了）', scene.statuses.length > n3, true);

/* --- status 复核的结果才交给 3D --- */

handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 31, 60, '正常'));   // 报文里故意写错
check('报文里写「正常」，3D 上画的仍然是规则算出来的「偏热」', lastStatus(), '偏热');
check('日志里警告了不一致', top().level, 'warn');

/* --- 幂等：消息来了直接调，不用先判断变没变 --- */

const n4 = scene.statuses.length;
renderScene();
renderScene();
check('★ renderScene 是幂等的（重复调用画出同样的状态，不会翻转或累加）',
  scene.statuses.slice(n4), ['偏热', '偏热']);

/* --- 切到还没收到数据的节点 --- */

clearAll();
handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 16, 60));
selectNode('dorm-c');
check('★ 切到没收到数据的节点：退回「正常」的外观', lastStatus(), '正常');
check('★ 覆盖层如实写「还没有收到数据」，不沿用上一个节点的偏冷',
  lastLabel().includes('dorm-c') && lastLabel().includes('还没有收到数据'), true);

selectNode('dorm-a');
check('★ 切回有数据的节点，状态又回来了（不是只有第一次切才画）', lastStatus(), '偏冷');

/* --- 脏数据不污染画面 --- */

clearAll();
handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 25, 60));
const n5 = scene.statuses.length;
console.error = () => {};
handleMessage('dormmate/v1/nodes/dorm-a/telemetry', '这不是 JSON');
handleMessage('dormmate/v1/nodes/dorm-a/telemetry', JSON.stringify({ nodeId: 'dorm-a', humidity: 60 }));
handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-z', 31, 60));
console.error = realError;
check('★ 三条脏数据一条都没改到画面', scene.statuses.length, n5);
check('画面还是那条干净数据的「正常」', lastStatus(), '正常');

/* ============ N. 当前重点一行（Step 7-1 挑人 + Step 8-3 那一行）============ */
console.log('\n=== N. 当前重点一行 ===');

const ids = ['dorm-a', 'dorm-b', 'dorm-c'];
const T = (hm) => '2026-09-22 ' + hm;   // 三组场景的时间都在这天
const focusHTML = () => els.focus.innerHTML;
/* 点一下那一行。走的是页面真正注册在 #focus 上的那个委托回调，
   不是直接调 selectNode —— 委托的 selector 写错了这里就该红。 */
function clickFocus(nodeId) {
  els.focus._handlers.click.forEach((fn) => fn({
    target: { closest: (sel) => (sel === '.focus' ? { dataset: { node: nodeId } } : null) },
  }));
}

/* --- 接线本身 --- */

check('★ dashboard.js 有两条 import（scene.js 的 3D 工厂 + logic.js 的算法）',
  importCount, 2);
check('★ logic.js 那条拿的是 7-1 的四个 + 7-4 的四个 + 8-3 的两个',
  LOGIC_IMPORT.test(dashText), true);
check('★ logic.js 那个文件真的在（./ 是相对 dashboard.js 自己算的，不是相对页面）',
  fs.existsSync(LOGIC_SRC), true);
check('index.html 里有 #focus 容器', dashHtml.includes('id="focus"'), true);
/* ★ 8-1 那两块（B1 总览 + B2 依据）已经撤了 —— 顶部只剩这一行。
   这一步是**信息分工**：原来有三处在说「谁是重点」，详略不同而已；
   现在一行留给看板顶部，细节分给 3D / 语音 / report.html。
   两块里任何一个还在页面上，就是「又加了一块」而不是分工。 */
check('★ 8-1 的 #overview / #reasons 已经从页面上撤掉了',
  [dashHtml.includes('id="overview"'), dashHtml.includes('id="reasons"')],
  [false, false]);
check('★ 那一行旁边就是「语音提醒」按钮', dashHtml.includes('id="speak"'), true);
check('按钮的文案就是「语音提醒」', dashHtml.includes('>语音提醒</button>'), true);
check('★ 念了哪一句写在按钮下面那行说明里', dashHtml.includes('id="speak-note"'), true);

/* --- 启动那一刻（一条数据都没有）--- */

check('★ 启动时就画好了那一行（不是等第一条消息才出现）',
  FOCUS_AT_LOAD.includes('class="focus'), true);
/* 「三个都正常」在一条数据都没收到时是假话：那三个节点是**不知道**，不是正常。
   这两种情况都由 pickPriority 返回 null，区分在 buildFocus 那侧做。 */
check('★ 启动时说的是「还没有收到数据」，不是「三个都正常」',
  [FOCUS_AT_LOAD.includes('还没有收到任何节点的数据'),
    FOCUS_AT_LOAD.includes('三个宿舍都正常')], [true, false]);
check('启动时它不是按钮（没东西可点）', FOCUS_AT_LOAD.includes('<button'), false);
/* 页面里跑的就是真的那份 logic.js（上面 runInContext 喂进去的），
   不是另写一个桩 —— 所以下面每一条都在验同一个函数 */
check('拿到的 pickPriority 就是 logic.js 里那个', typeof pickPriority, 'function');

/* --- 维护 abnormalStart / abnormalCount --- */

clearAll();
check('清空后三个节点的连续异常段都是空的',
  ids.map((id) => nodes[id].abnormalStart + ' / ' + nodes[id].abnormalCount),
  ['null / 0', 'null / 0', 'null / 0']);

handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 16, 60, undefined, T('20:00:00')));
check('★ 第一条异常：起点是它自己，记 1 次',
  [nodes['dorm-a'].abnormalStart, nodes['dorm-a'].abnormalCount],
  [T('20:00:00'), 1]);

handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 16, 60, undefined, T('20:03:00')));
check('★ 段接着走：起点不动，次数加一',
  [nodes['dorm-a'].abnormalStart, nodes['dorm-a'].abnormalCount], [T('20:00:00'), 2]);

handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 31, 60, undefined, T('20:04:00')));
check('别的节点各算各的段，互不影响',
  ids.map((id) => nodes[id].abnormalCount), [2, 1, 0]);

handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 25, 60, undefined, T('20:05:00')));
check('★ 来一条正常数据：起点和次数一起清零',
  [nodes['dorm-a'].abnormalStart, nodes['dorm-a'].abnormalCount], [null, 0]);

handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 31, 60, undefined, T('20:09:00')));
check('★ 清零之后再异常：新的一段从这条开始（不沿用 20:00:00）',
  [nodes['dorm-a'].abnormalStart, nodes['dorm-a'].abnormalCount], [T('20:09:00'), 1]);

/* 段里状态从偏热变成偏湿：算同一段。这里统计的是「连续异常了多久」，
   不是「连续偏热了多久」—— 所以起点不动、次数继续加。 */
handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 25, 80, undefined, T('20:06:00')));
check('★ 段里从偏热变偏湿，仍是同一段：起点不动、次数继续加',
  [nodes['dorm-b'].abnormalStart, nodes['dorm-b'].abnormalCount], [T('20:04:00'), 2]);

/* 报文谎称「正常」、规则算出「偏热」时，段不能被打断 ——
   用的是复核之后的状态，不是报文里那个字符串。 */
handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 31, 60, '正常', T('20:07:00')));
check('★ 报文谎称「正常」但规则算出偏热：段没被打断（用的是复核后的状态）',
  [nodes['dorm-b'].abnormalStart, nodes['dorm-b'].abnormalCount], [T('20:04:00'), 3]);

/* 两个字段必须始终一致：有异常计数 <=> 最新状态不是正常。
   它们由同一个函数一起写，这里把这条不变量钉住 ——
   一旦哪天有人只改了其中一个，这里立刻红。
   （还没收到数据的节点两边都是「没有」，也算一致。） */
check('★ 不变量：abnormalCount > 0 恰好等价于 latest 不是「正常」',
  ids.map((id) => (nodes[id].abnormalCount > 0) === (nodes[id].latest
    ? nodes[id].latest.status !== '正常' : false)),
  [true, true, true]);

/* --- 看板顶上那一行 --- */

/* 此刻：dorm-a 偏热 20:09 起 1 次（时长 0），dorm-b 偏热 20:04 起 3 次（3 分钟），
   dorm-c 还没收到过。当前看的是 dorm-a（M 段留下的）。 */
check('★ 顶部那一行挑出了 dorm-b', focusHTML().includes('dorm-b'), true);
/* ★ 这一行说的是**宿舍名 + 处理状态 + 趋势**，没有状态两个字，也没有那句原因。
   这是 8-3 的分工：状态由卡片徽章（颜色 + 形状 + 文字）、3D 场景、语音一起承担；
   「凭什么先管它」那种来龙去脉归 report.html。一行字里塞四样东西，
   就又变回 8-1 那种「两句话交代所有事」了，那正是这一步要拆掉的。 */
check('★ 那一行的内容：宿舍名 + 趋势（没按过按钮，就没有「处理中」那段）',
  focusHTML().includes('dorm-b｜温度正在上升'), true);
check('★ 那一行里不写状态（分工：状态由徽章和 3D 承担）',
  [focusHTML().includes('偏热'), focusHTML().includes('已持续')], [false, false]);
check('★ 那句原因也不在这一行里（它归 report.html）',
  focusHTML().includes('持续时间最长'), false);
/* 颜色不能单独表意：这一行里没有「偏热」两个字，所以状态必须由**形状**再表一次。
   放进来的就是卡片上那套 ICONS（偏热是太阳、偏冷是雪花）。 */
check('★ 但状态图标在（颜色永远配着形状出现，不靠颜色单独表意）',
  [focusHTML().includes('focus-icon'), focusHTML().includes('<svg')], [true, true]);
check('那一行是个 button，带着 nodeId（点击委托靠它认人）',
  /<button[^>]*data-node="dorm-b"/.test(focusHTML()), true);
check('颜色跟着状态走（偏热 -> is-critical，和卡片同一套 class）',
  focusHTML().includes('focus is-critical'), true);
check('当前看的不是它 -> 右边写「查看详情」', focusHTML().includes('查看详情'), true);
check('当前看的不是它 -> 不带选中描边', /\bis-active\b/.test(focusHTML()), false);

/* --- 点它 = 点对应那张卡片 --- */

/* 切之前先记下那一行的内容。它在切完之后必须**一个字都没变** ——
   「谁是重点」跟正在看谁无关，变的是右边那两个字。 */
const lineBefore = buildFocus(nodes);
clickFocus('dorm-b');
check('★ 点「当前重点」切到了 dorm-b', current(), 'dorm-b');
check('★ 卡片跟着切（dorm-b 那张变成「查看中」）',
  /data-node="dorm-b"[^>]*aria-pressed="true"/.test(els.cards.innerHTML), true);
check('★ 趋势图跟着切（画的是 dorm-b 自己的历史）',
  tempChart.data.datasets[0].data, nodes['dorm-b'].history.map((r) => r.temperature));
check('★ 3D 跟着切（画的是 dorm-b 的状态）', lastStatus(), '偏热');
check('★ 切过去之后那一行改口说「正在查看」', focusHTML().includes('正在查看'), true);
check('★ 而且它本身带上了选中描边',
  /class="focus is-critical is-active"/.test(focusHTML()), true);
check('★ 内容一个字没变（换的只是「正在查看」那两个字）',
  [buildFocus(nodes) === lineBefore, focusHTML().includes(lineBefore)], [true, true]);
check('标记变了，挑中的节点没变（只是「正在看」这件事变了）',
  pickPriority(nodes).nodeId, 'dorm-b');

/* --- 3D 上那圈「当前重点」标记（Step 8-3）--- */

/* 这一圈环和「重画场景」的时机**不一样**，所以 dashboard.js 那边是两个函数：
     场景只跟当前选中的宿舍有关 —— 收到别的节点的报文时一次都不该动；
     谁是重点却是**全局**的 —— dorm-b 的一条数据就可能让正在看的 dorm-a
                                不再是重点，那圈环得当场灭掉。
   下面这几条把这两个时机分别钉住。 */
const ringAt = () => scene.focus[scene.focus.length - 1];
const ringCount = () => scene.focus.length;

check('★ 启动那一刻那圈环是灭的（一条数据都没有，没有重点可言）',
  scene.focus[0], false);
check('★ 切到重点那个宿舍（dorm-b）之后环亮起来 —— 它正好是当前看的这间',
  ringAt(), true);

/* ★ 这一条是 renderFocusMark 单独存在的全部理由。
   当前看的是 dorm-b，也正是重点。现在来两条 **dorm-a** 的报文：
   画面本身一步都不该动（收到的不是它 —— 上面 M 段已经钉过），
   但 dorm-a 的异常段比 dorm-b 长，重点当场换人 ——
   dorm-b 那圈环必须跟着灭掉。
   两件事捆在一个函数里写的话，这一种情况就只能靠「碰巧也在看那个节点」才更新得过来。 */
const ringBefore = ringCount();
const stBefore = scene.statuses.length;
handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 31, 60, undefined, T('20:20:00')));
check('（这时 dorm-a 的段是 11 分钟、dorm-b 是 3 分钟，重点换成了 dorm-a）',
  pickPriority(nodes).nodeId, 'dorm-a');
check('★ 重点被别的节点抢走：正在看的这间当场摘掉标记', ringAt(), false);
check('★ 而且确实重新调了一次 setFocus（不是沿用上一次那个值）',
  ringCount() > ringBefore, true);
check('★ 与此同时画面一步都没动（收到的不是当前这个节点）',
  scene.statuses.length, stBefore);

/* 再看一个方向：重点抢回来，环还得亮回去 */
handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 31, 60, undefined, T('20:30:00')));
check('★ 正在看的这间重新成为重点：环当场亮回来',
  [pickPriority(nodes).nodeId, ringAt()], ['dorm-b', true]);

/* --- 清空之后：又回到「一条数据都没有」 --- */

clearAll();
/* 清空不是「三个都正常」，是「什么都不知道了」—— 和刚打开页面是同一种状态，
   所以话也该是同一句。这条同时钉住了 clearAll 必须重画那一行。 */
check('★ 清空后说的是「还没有收到数据」，不是「三个都正常」',
  [focusHTML().includes('还没有收到任何节点的数据'),
    focusHTML().includes('三个宿舍都正常')], [true, false]);
check('★ 没数据时不是按钮（点不动，也不该看着像能点）',
  focusHTML().includes('<button'), false);
check('没数据时没有 data-node，点上去什么也不会发生',
  focusHTML().includes('data-node'), false);
check('★ 清空后那圈环也灭了（连重点都没有了）', ringAt(), false);
check('pickPriority 在一条数据都没有时返回 null', pickPriority(nodes), null);
/* 点一个没有 data-node 的东西不能把 currentNodeId 弄坏 */
check('当前还看在 dorm-b 上（切节点只由真实的点击改）', current(), 'dorm-b');

/* --- 按风扇那一刻，那一行当场补出「处理中」--- */

handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 31, 60, undefined, T('20:00:00')));
check('按之前那一行里没有「处理中」', focusHTML().includes('处理中'), false);
check('这时按钮是能点的（不然下面按的是一个灰按钮，模拟的不是真行为）',
  els['action-fan'].disabled, false);
check('当前看的正是它（否则按下去作用在别的节点上）', current(), 'dorm-b');

els['action-fan']._handlers.click.forEach((fn) => fn());
/* ★ 这一条盯的是风扇回调里那句 renderFocus()。漏掉的话，「处理中」三个字
   要等到**下一条报文进来**才出现 —— 中间那段时间卡片上写着「处理中｜风扇已开启」、
   上面那一行里却什么都没有，看的人会以为按钮没生效。 */
check('★ 按了风扇之后那一行**当场**补出处理状态（不用等下一条报文）',
  focusHTML().includes('dorm-b｜处理中'), true);
check('★ 只写「处理中」，不写「风扇已开启」—— 开了什么是空间动作，归 3D',
  focusHTML().includes('风扇已开启'), false);
/* 只有一条数据，所以没有趋势那段，｜ 后面直接就是「处理中」，不会留个空的 ｜ */
check('只有一条数据时后面不跟趋势（说不出「往哪走」就不说）',
  focusHTML().includes('dorm-b｜处理中｜'), false);

/* --- 三组场景：和交给 MQTTX 的那三组是同一份数据 --- */

/* 下面这三组就是回给用户的 MQTTX 测试数据。先在这里跑一遍 ——
   现场照着发的时候页面上会出现什么，这里已经验过了。 */
console.log('  -- 场景一：按时长决出优先 --');
clearAll();
[['dorm-a', 16, 60, '20:00:00'], ['dorm-a', 16, 60, '20:03:00'],
  ['dorm-b', 31, 60, '20:00:00'], ['dorm-b', 31, 60, '20:07:00'],
  ['dorm-c', 25, 80, '20:00:00'], ['dorm-c', 25, 80, '20:05:00'],
].forEach(([id, t, h, hm]) => {
  handleMessage('dormmate/' + id + '/env', mk(id, t, h, undefined, T(hm)));
});
check('★ 场景一：三段各 2 条，时长 3 / 7 / 5 分钟',
  ids.map((id) => nodes[id].abnormalCount + ' 条'), ['2 条', '2 条', '2 条']);
check('★ 场景一：时长最长的 dorm-b 胜出', pickPriority(nodes).nodeId, 'dorm-b');
check('★ 场景一：原因',
  pickPriority(nodes).reason, 'dorm-b 已连续偏热 7 分钟（2 次），持续时间最长');
/* 那一行只说「是它」，不说「凭什么」。原因仍然算得出来（上面那条），
   但它去的地方是事件记录和 report.html —— 那才是要交代来龙去脉的出口。 */
check('★ 场景一：那一行说的是 dorm-b，但不含那句原因',
  [focusHTML().includes('dorm-b｜'), focusHTML().includes('持续时间最长')], [true, false]);

console.log('  -- 场景二：时长相同，按次数决出 --');
clearAll();
[['dorm-a', 16, 60, '20:00:00'], ['dorm-a', 16, 60, '20:06:00'],
  ['dorm-b', 31, 60, '20:00:00'], ['dorm-b', 31, 60, '20:03:00'], ['dorm-b', 31, 60, '20:06:00'],
  ['dorm-c', 25, 80, '20:00:00'], ['dorm-c', 25, 80, '20:06:00'],
].forEach(([id, t, h, hm]) => {
  handleMessage('dormmate/' + id + '/env', mk(id, t, h, undefined, T(hm)));
});
check('★ 场景二：三段的条数分别是 2 / 3 / 2',
  ids.map((id) => nodes[id].abnormalCount), [2, 3, 2]);
check('★ 场景二：三段时长都是 6 分钟（起点 20:00、最新 20:06）',
  ids.map((id) => nodes[id].abnormalStart), [T('20:00:00'), T('20:00:00'), T('20:00:00')]);
check('★ 场景二：条数最多的 dorm-b 胜出', pickPriority(nodes).nodeId, 'dorm-b');
check('★ 场景二：原因如实说赢在次数，不写「持续时间最长」',
  pickPriority(nodes).reason,
  'dorm-b 已连续偏热 6 分钟（3 次），持续时间和 dorm-a 一样长，异常次数最多');

console.log('  -- 场景三：全部正常 --');
clearAll();
[['dorm-a', 25, 60, '20:00:00'], ['dorm-b', 25, 60, '20:00:00'], ['dorm-c', 25, 60, '20:00:00']]
  .forEach(([id, t, h, hm]) => {
    handleMessage('dormmate/' + id + '/env', mk(id, t, h, undefined, T(hm)));
  });
check('★ 场景三：数据都收下了（不是被拦掉才显得「全正常」）',
  ids.map((id) => nodes[id].history.length + ' / ' + nodes[id].latest.status),
  ['1 / 正常', '1 / 正常', '1 / 正常']);
check('★ 场景三：三个节点的异常计数都是 0', ids.map((id) => nodes[id].abnormalCount), [0, 0, 0]);
check('★ 场景三：pickPriority 返回 null', pickPriority(nodes), null);
check('★ 场景三：那一行说三个都正常', focusHTML().includes('3 个宿舍都正常'), true);
/* 平静时那一行不是按钮：没有重点，就没有可点过去的地方 */
check('★ 场景三：没有重点时它不是按钮', focusHTML().includes('<button'), false);

/* 三组跑完，让后面的 O 段从一个干净的、当前节点确定的状态开始 */
clearAll();
selectNode('dorm-a');

/* ============ O. 处理动作（Step 7-2）============ */
console.log('\n=== O. 处理动作 ===');

/* 这一步的要求是「处理状态、Dashboard 显示、3D 表现读同一份节点数据」。
   所以下面每一段都是同一个写法：先写进节点字段，再把三处显示分别看一眼 ——
   卡片上那行、详情区那行字、3D 里风扇转不转。三处都从 nodes[id] 读，
   这里就没有第二份可以跟它不一致的副本。 */
const fanBtn = els['action-fan'];
const fanState = els['action-state'];
/* 走页面真正注册在 #action-fan 上的那个回调，不直接调内部函数 ——
   回调要是挂错了元素（比如挂到 #clear 上），这里就该红。 */
const clickFan = () => fanBtn._handlers.click.forEach((fn) => fn());
const actionsOnCards = () => (els.cards.innerHTML.match(/card-action/g) || []).length;

/* --- 接线本身 --- */

check('index.html 里有 #action-fan 那个按钮', dashHtml.includes('id="action-fan"'), true);
check('index.html 里有 #action-state 那行字', dashHtml.includes('id="action-state"'), true);
check('按钮的文案就是「开启风扇 / 通风」', dashHtml.includes('开启风扇 / 通风'), true);
check('★ 页面上跑的 beginHandling / nextHandling 就是 logic.js 里那两个（不是另写的桩）',
  [typeof beginHandling, typeof nextHandling], ['function', 'function']);
check('★ 启动那一刻就把这一行画好了（按钮是灰的、字是「还没有收到数据」）',
  ACTION_AT_LOAD, { disabled: true, text: '还没有收到这个节点的数据' });

/* --- 一条数据都没有：按不动 --- */

clearAll();
selectNode('dorm-a');
check('★ 没收到过数据时按钮是灰的（连 actionTime 都没地方取）', fanBtn.disabled, true);
check('★ 那行字如实说还没收到数据，不混成「正常不需要处理」',
  fanState.textContent, '还没有收到这个节点的数据');
check('没处理过的卡片上不出现处理状态那一行', actionsOnCards(), 0);

/* --- 状态正常：照样按不动（规格书：节点状态正常时禁用）--- */

handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 25, 60, undefined, T('20:00:00')));
check('状态正常时按钮还是灰的', fanBtn.disabled, true);
check('那行字说明为什么按不动', fanState.textContent, '当前状态正常，不需要处理');

/* --- 异常了：可以按 --- */

/* 这里特意拿**偏湿**当被测场景，不用偏热。
   偏热在 scene.js 的 LOOK 表里本来就是 fan: true，updateScene 自己就会把风扇
   打开 —— 那种情况下「先 updateScene 再 setFanOn」的顺序写反了也照样绿。
   偏湿的 fan 是 false，只有「动作叠在状态之上」这一种写法才转得起来。 */
handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 25, 80, undefined, T('20:05:00')));
check('节点偏湿了，按钮可点（不是正常状态）', fanBtn.disabled, false);
check('确认这一段的场景确实是偏湿，否则上面那条测的不是这件事',
  nodes['dorm-a'].latest.status, '偏湿');
check('还没按的时候那行字是空的（没什么要说的）', fanState.textContent, '');

/* --- 按一下 --- */

const fansBefore = scene.fans.length;
const opsBefore = scene.ops.length;
clickFan();

check('★ handling 变成「处理中」', nodes['dorm-a'].handling, '处理中');
check('★ action 记的是「风扇已开启」', nodes['dorm-a'].action, '风扇已开启');
check('★ actionTime 用**该节点最新那条消息的 time**，不是浏览器当前时间',
  nodes['dorm-a'].actionTime, T('20:05:00'));
check('刚按下时还没有「动作之后的数据」', nodes['dorm-a'].dataAfterAction, null);

check('★ 卡片上出现「处理中｜风扇已开启」',
  els.cards.innerHTML.includes('处理中｜风扇已开启'), true);
check('★ 它在卡片上是个单独的元素，不是混进脚注里的一句话',
  /<span class="card-action">处理中｜风扇已开启<\/span>/.test(els.cards.innerHTML), true);
check('只有被处理的那个节点有这一行（另外两张卡没有）', actionsOnCards(), 1);

check('★ 详情区那行字把「记在哪条数据上」说清楚',
  fanState.textContent,
  '处理中｜风扇已开启（记在 2026-09-22 20:05:00 这条数据上） · 还没收到动作之后的数据');

check('★ 按下去调了 setFanOn(true)，风扇转起来', scene.fans.slice(fansBefore), [true]);
/* ★ 顺序是刻意的：scene.js 里写着「后调用的那次为准」，setFanOn 必须在
   updateScene **之后** —— 反过来的话这次 setFanOn 会被 updateScene 自己那次
   盖掉（偏湿的 fan 是 false，风扇就转不起来了）。
   末尾那个 setFocus 是 8-3 加的：renderScene 收尾时要顺手按新的重点重算
   那圈环。它排在最后，上面那两步的先后不受影响。 */
check('★ 顺序是「先 updateScene、再 setFanOn」，最后才收尾重算那圈环',
  scene.ops.slice(opsBefore), ['updateScene', 'setFanOn', 'setFocus']);

/* --- 来了一条比动作还早的：不许改写「处理好了没有」--- */

/* 重发旧数据 / 乱序到达。它比 actionTime 还早，就不该参与判断 ——
   这一条偏偏是「正常」，少了 t > at 那道闸就会立刻把状态改成「已恢复」，
   而实际上动作之后一条数据都还没来。 */
handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 25, 60, undefined, T('20:00:00')));
check('★ 比动作还早的消息不改处理状态（还留在「处理中」）',
  nodes['dorm-a'].handling, '处理中');
check('★ 也不记成「动作之后的数据」', nodes['dorm-a'].dataAfterAction, null);
check('卡片上还是「处理中」，没被那条旧数据改写',
  els.cards.innerHTML.includes('处理中｜风扇已开启'), true);

/* --- 动作之后来了正常的：已恢复 --- */

handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 25, 60, undefined, T('20:09:00')));
check('★ 动作之后的这条是正常 -> 转「已恢复」', nodes['dorm-a'].handling, '已恢复');
check('★ dataAfterAction 记的是这一条（不是随便哪一条）',
  [nodes['dorm-a'].dataAfterAction.time, nodes['dorm-a'].dataAfterAction.status],
  [T('20:09:00'), '正常']);
check('★ 卡片跟着改口', els.cards.innerHTML.includes('已恢复｜风扇已开启'), true);
check('★ 详情区把「之后收到了什么」写出来',
  fanState.textContent,
  '已恢复｜风扇已开启（记在 2026-09-22 20:05:00 这条数据上）'
  + ' · 之后收到 2026-09-22 20:09:00：25℃ / 60% 正常');
check('恢复之后状态就是正常，按钮回到灰的', fanBtn.disabled, true);
check('★ 恢复之后风扇照样转（动作开了就一直开着，只有「清空」才停）',
  scene.fans[scene.fans.length - 1], true);

/* --- 环境又变坏：自动退回「处理中」--- */

handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 31, 60, undefined, T('20:12:00')));
check('★ 又异常了 -> 退回「处理中」（同一条规则，没有另写一条判断）',
  nodes['dorm-a'].handling, '处理中');
check('★ dataAfterAction 跟着换成新的这条',
  nodes['dorm-a'].dataAfterAction.time, T('20:12:00'));
check('卡片上又写成「处理中」（不是停在「已恢复」）',
  els.cards.innerHTML.includes('处理中｜风扇已开启'), true);
check('actionTime 没被顶掉（动作还是那一次，记在 20:05 上）',
  nodes['dorm-a'].actionTime, T('20:05:00'));

/* --- 每个节点各管各的 --- */

clearAll();
selectNode('dorm-a');
handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 31, 60, undefined, T('20:00:00')));
handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 25, 80, undefined, T('20:00:00')));
clickFan();
check('★ 按的是当前正在看的 dorm-a', nodes['dorm-a'].handling, '处理中');
check('★ dorm-b 一点没被牵连', [nodes['dorm-b'].handling, nodes['dorm-b'].actionTime], ['无', null]);
check('★ dorm-c 同样没被牵连', [nodes['dorm-c'].handling, nodes['dorm-c'].actionTime], ['无', null]);
check('三张卡里只有一张带处理状态', actionsOnCards(), 1);

/* 切到 dorm-b：它自己没被处理过，详情区那行字和按钮都得按它自己的来 */
selectNode('dorm-b');
check('★ 切到 dorm-b，那行字说的是它自己的情况（没处理过）',
  fanState.textContent, '');
check('★ 按钮跟着当前节点走：dorm-b 偏湿，可点', fanBtn.disabled, false);
const fansBeforeB = scene.fans.length;
selectNode('dorm-b');
check('★ 去看一个没处理过的节点，风扇不会被 dorm-a 的处理状态带着转',
  scene.fans.length, fansBeforeB);
check('★ 卡片上那一行只属于 dorm-a（切节点不会把它搬过来）', actionsOnCards(), 1);

/* dorm-b 自己也按一下：两个节点各记各的，互不覆盖 */
handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 25, 80, undefined, T('20:04:00')));
clickFan();
check('★ dorm-b 记在自己的 actionTime 上（20:04，不是 dorm-a 的 20:00）',
  [nodes['dorm-b'].handling, nodes['dorm-b'].actionTime], ['处理中', T('20:04:00')]);
check('dorm-a 的没被动过', [nodes['dorm-a'].handling, nodes['dorm-a'].actionTime],
  ['处理中', T('20:00:00')]);
check('两张卡各带一行处理状态', actionsOnCards(), 2);

/* 切回 dorm-a：它那份还在（不是只有最后按的那个才记得住） */
selectNode('dorm-a');
check('★ 切回 dorm-a，处理状态还在，说的是它自己的 20:00',
  fanState.textContent.includes('记在 2026-09-22 20:00:00 这条数据上'), true);
check('★ 切回 dorm-a，风扇转起来（它自己是处理中的那个）',
  scene.fans[scene.fans.length - 1], true);

/* --- 没按过按钮的节点：dashboard 一次都不许碰风扇 --- */

/* scene.js 的 LOOK 表里偏热是 fan: true，updateScene 自己会把风扇打开。
   dashboard 这边只该在「按过按钮」时补一句 setFanOn(true)，
   绝不能反过来对没处理过的节点喊 setFanOn(false) —— 那等于把 Step 6-2 弄坏了：
   一个偏热的宿舍，只要没人点过按钮，风扇反而不转了。
   所以这条钉住的是「handling 是「无」时，dashboard 连碰都不碰风扇」，
   转与不转完全交给 updateScene 按状态那一档去定。 */
clearAll();
selectNode('dorm-a');
const fansIdle = scene.fans.length;
handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 31, 60, undefined, T('20:00:00')));
check('当前节点转成偏热（scene.js 里这一档本来就要转）',
  nodes['dorm-a'].latest.status, '偏热');
check('★ 没按过按钮的节点，dashboard 一次都没碰风扇（交给 updateScene 那一档）',
  scene.fans.length, fansIdle);
check('交出去的确实是「偏热」，风扇转不转由 scene.js 自己按这一档决定',
  scene.statuses[scene.statuses.length - 1], '偏热');

/* --- 偏热节点上按一下：锦上添花，不能把本来就转着的风扇按停 --- */

clearAll();
selectNode('dorm-c');
handleMessage('dormmate/v1/nodes/dorm-c/telemetry', mk('dorm-c', 31, 60, undefined, T('20:00:00')));
check('dorm-c 偏热（scene.js 的 LOOK 表里这一档本来就转）', nodes['dorm-c'].latest.status, '偏热');
clickFan();
check('★ 偏热的节点按一下照样记上处理动作', nodes['dorm-c'].handling, '处理中');
check('★ setFanOn 传的是 true，不是 false —— 动作是叠在状态之上的，不取代它',
  scene.fans[scene.fans.length - 1], true);

/* --- 清空：四个字段一起回到「没处理过」--- */

const fansBeforeClear = scene.fans.length;
clearAll();
check('★ 清空后三个节点的处理字段全归零',
  ids.map((id) => [nodes[id].handling, nodes[id].action, nodes[id].actionTime,
    nodes[id].dataAfterAction]),
  [['无', null, null, null], ['无', null, null, null], ['无', null, null, null]]);
check('★ 卡片上那行处理状态跟着消失', actionsOnCards(), 0);
check('清空后 3D 收到的状态是「正常」（这一档的 LOOK 里 fan 是 false，'
  + '风扇就此停下 —— dashboard 自己从不调 setFanOn(false)，停是 updateScene 干的）',
  scene.statuses[scene.statuses.length - 1], '正常');
check('★ 清空之后 dashboard 一次都没再喊「转」（上面那个「正常」才是停下来的原因）',
  scene.fans.length, fansBeforeClear);
check('清空后按钮回到灰的（又变成一条数据都没有）', fanBtn.disabled, true);
check('清空后那行字也回到「还没有收到数据」',
  fanState.textContent, '还没有收到这个节点的数据');

/* 这一段跑完，把状态交回给 L 段期望的样子 */
clearAll();
selectNode('dorm-a');

/* ============ L. 没加载 mqtt.js（现场没网的情况）============ */
console.log('\n=== L. 没加载 mqtt.js ===');
const els2 = {};
['cards', 'log-body', 'log-count', 'detail-node', 'detail-meta', 'chart-note',
  'scene3d', 'simulate', 'clear', 'chart-temp', 'chart-humidity',
  'conn', 'conn-text', 'toggle', 'action-fan', 'action-state',
  /* 这几个不列也能跑（getElementById 会现场造一个），但列上更贴近真页面 */
  'event-body', 'event-count', 'export-events', 'focus', 'speak', 'speak-note',
  /* ML 那三件同理。R 段要在这一段里读它降级之后写了什么 */
  'ml-count', 'ml-text', 'ml-note']
  .forEach((id) => { els2[id] = makeEl(id); });
/* 这一段故意**不**补 Blob / URL / setTimeout：导出按钮在这里不会被点，
   而「缺依赖时页面照样起得来」正是这一段要验的 —— 补得越全，
   越测不出真缺东西时会不会崩。 */

const doc2 = {
  documentElement: makeEl('html'),
  getElementById: (id) => els2[id] || makeEl(id),
  querySelector: () => makeEl('x'),
  querySelectorAll: () => [],
  addEventListener() {},
};

const ctx2 = {
  document: doc2,
  Chart: ChartStub,
  /* 这里的 fetch 是**故意**让它失败的：这个上下文模拟的是「现场什么依赖都缺」，
     离线时浏览器的 fetch 就是这个反应（fetch 本身在，请求发不出去）。
     不能不给：不给的话 dashboard.js 一开头的 loadMlResult() 会抛
     ReferenceError，那这一段测的就成了「少给一个桩会怎样」，
     而不是「什么都缺时页面还能不能起来」。 */
  fetch: () => Promise.reject(new Error('Failed to fetch')),
  /* 这里故意让 3D 建不起来（模拟这台设备没有 WebGL）：
     和 mqtt 那条一起，凑成「两个依赖同时缺」的最坏情况 ——
     页面照样得起来。initScene3D 的 try/catch 就是为这个写的。 */
  createDorm3D: () => { throw new Error('这台设备没有可用的 WebGL'); },
  location: { hostname: 'localhost' },
  /* 故意不给 mqtt —— 模拟 vendor/mqtt.min.js 没下载到 */
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  /* 这一段故意**不**给 speechSynthesis：和 mqtt、WebGL 一起，
     凑成「三个依赖同时缺」。speakAlert 只在点按钮时才走那条分支，
     页面起来这一步碰不到它 —— 但「缺东西时页面照样起得来」正是这一段要验的。 */
  window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
  /* 只把 error 静音：initScene3D 捕到异常后会 console.error 一行，
     那是**预期行为**，不是测试失败。log 留着，方便排查。 */
  console: { log: console.log, warn: console.warn, error: () => {} },
  JSON, Math, Date, Number, Object, Array, String, Set, isNaN, parseInt,
};
ctx2.globalThis = ctx2;
ctx2.window.document = doc2;

let src2 = dashText;
src2 = src2.replace(SCENE_IMPORT, '/* import 已摘除，理由同上 */\n');
src2 = src2.replace(LOGIC_IMPORT, '/* import 已摘除：下面跑的是真的 logic.js */\n');
src2 += ';globalThis.__simulate = simulate;\nglobalThis.__renderScene = renderScene;\n'
  + 'globalThis.__renderFocus = renderFocus;\nglobalThis.__speakAlert = speakAlert;\n';

vm.createContext(ctx2);
vm.runInContext(fs.readFileSync(RULES_SRC, 'utf8'), ctx2);
/* 这里也得喂真的 logic.js：simulate() 会走到 renderFocus，
   没有它的话这一段测的就不是「没网时页面能不能起来」，
   而是「pickPriority is not defined」—— 一个跟本节无关的错。 */
vm.runInContext(fs.readFileSync(LOGIC_SRC, 'utf8').replace(/^export\s+/gm, ''),
  ctx2, { filename: LOGIC_SRC });
vm.runInContext(src2, ctx2, { filename: DASH_SRC });

check('没有 mqtt 也不抛异常，页面照常起来', typeof ctx2.judgeStatus, 'function');
check('状态显示「未加载 mqtt.js」', els2['conn-text'].textContent, '未加载 mqtt.js');
check('日志写明了缺哪个文件（是 lib/ 那份，不是 web/vendor）',
  els2['log-body'].innerHTML.includes('dashboard/lib/mqtt.min.js'), true);
/* 关键的降级行为：连不上 Broker 也得能演示界面 */
ctx2.__simulate();
check('没有 Broker 时「模拟三节点数据」照样能用', els2['cards'].innerHTML.includes('dorm-a'), true);
check('三张卡都出来了', ['dorm-a', 'dorm-b', 'dorm-c'].every(
  (id) => els2['cards'].innerHTML.includes(id)), true);

/* 3D 建不起来（没有 WebGL）时，dorm3d 是 null。renderScene 头一行就得跳过，
   而不是去调 null.updateScene。 */
ctx2.__renderScene();
check('★ 没有 WebGL 时 renderScene 直接跳过，不抛异常', true, true);
check('3D 建不起来不影响数据照常进（卡片还是三张）', els2['cards'].innerHTML.includes('dorm-c'), true);

/* 「当前重点」不依赖任何外部东西（3D 和 mqtt 都缺着，它照样得算出来）——
   它是三个模块里唯一一个纯计算，没网没显卡的时候正好靠它撑住现场演示。 */
check('★ 没网没显卡时「当前重点」照样算得出来（挑出异常的那个节点）',
  els2.focus.innerHTML.includes('当前重点')
  && els2.focus.innerHTML.includes('dorm-b'), true);
/* 语音也缺着，但按钮点下去不能抛未捕获异常 —— 它得把那句话写出来。
   （这一段没给 window.speechSynthesis，走的正是「不支持」那条分支。） */
ctx2.__speakAlert();
check('★ 没网没显卡、浏览器也不支持语音时，点下去仍然只是写一行字，不抛异常',
  els2['speak-note'].textContent.includes('不支持语音合成'), true);

/* ============ P. 事件记录与导出（Step 7-4）============ */
console.log('\n=== P. 事件记录与导出 ===');

const evBody = () => els['event-body'].innerHTML;
const exportBtn = els['export-events'];
/* 走页面真正注册在 #export-events 上的那个回调，不直接调 exportEventsCSV ——
   回调要是挂错了元素，这里就该红。 */
const clickExport = () => exportBtn._handlers.click.forEach((fn) => fn());
/* 表里画了几行数据。不能数 <tr>：一条事件都没有时渲染的是一行
   「还没有事件」的提示，它也是 <tr>。数结果胶囊最稳 ——
   空状态一个都没有，每条数据正好一个。
   要连 class=" 一起写：只写 ev-result 的话，同一个 span 上的
   ev-result--open / ev-result--done 也会被数进去，一行变两行。 */
const evRowCount = () => (evBody().match(/<span class="ev-result/g) || []).length;
/* 按节点找事件。events 是「新的在前」（unshift），所以同节点有多条时
   拿到的是**最新**那条 —— P 段里需要旧那条时会直接写 events[i]。 */
const evOf = (id) => events.find((e) => e.nodeId === id);

/* --- 接线本身 --- */

check('index.html 里有 #event-body 那张表', dashHtml.includes('id="event-body"'), true);
check('index.html 里有 #event-count', dashHtml.includes('id="event-count"'), true);
check('index.html 里有 #export-events 按钮', dashHtml.includes('id="export-events"'), true);
check('按钮的文案就是「导出事件 CSV」', dashHtml.includes('导出事件 CSV'), true);

const EV_TH = ['开始', '节点', '问题', '优先关注', '处理动作', '恢复', '结果'];
const thPos = EV_TH.map((t) => dashHtml.indexOf('<th>' + t + '</th>'));
check('★ 表头七列全在', thPos.every((p) => p > 0), true);
check('★ 而且顺序固定（列序换了这里就红 —— 导出 CSV 的列序跟它一一对应）',
  thPos.every((p, i) => i === 0 || p > thPos[i - 1]), true);

/* --- 启动那一刻（一条数据都没有）--- */

check('★ 启动时就把这块画好了（不是等第一条消息才出现）',
  EVENTS_AT_LOAD.body.includes('还没有事件'), true);
check('★ 启动时条数是空的，不写「共 0 条」',
  EVENTS_AT_LOAD.count, '');
/* 没东西可导的时候把按钮按掉，而不是让人点了弹一个只有表头的空 CSV ——
   拿到的人会以为导出坏了。 */
check('★ 启动时导出按钮是灰的', EVENTS_AT_LOAD.disabled, true);
check('★ 跑在页面上的 buildEventsCSV 就是 dashboard.js 里那个',
  typeof buildEventsCSV, 'function');

/* --- 开案：正常 -> 异常 --- */

clearAll();
check('清空之后一条事件都没有', events.length, 0);
check('清空之后按钮又变灰', exportBtn.disabled, true);
check('清空之后表里写的是「还没有事件」', evBody().includes('还没有事件'), true);

handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 31, 60, undefined, T('20:30:00')));
check('★ 节点从正常变成异常：开出一条事件', events.length, 1);
const ev0 = events[0];
check('★ 起点就是这条消息的 time', ev0.startTime, T('20:30:00'));
check('★ problem 记的是开始那一刻的状态', ev0.problem, '连续偏热');
check('nodeId 是它自己的', ev0.nodeId, 'dorm-b');
/* ★ 这一条是整段实现的地基：events 里存的是**对象本身**，不是深拷贝。
   整个换掉 node.event 的话，总表里那条会永远停在旧值上 ——
   页面上一点异常都看不出来，只有导出的 CSV 是空的。 */
check('★ 节点上那个引用和 events 里那条是**同一个对象**（不是各存一份副本）',
  nodes['dorm-b'].event === ev0, true);
check('刚开案时还没结案', [ev0.recoverTime, ev0.result], [null, '']);
check('★ 表里多了一行', evRowCount(), 1);
check('★ 那一行写着节点、问题和「进行中」',
  [evBody().includes('dorm-b'), evBody().includes('连续偏热'),
    evBody().includes('进行中')], [true, true, true]);
check('条数写出来了', els['event-count'].textContent, '共 1 条');
check('★ 有事件之后按钮能点了', exportBtn.disabled, false);

/* 第一次被选为「优先关注」就记上那一刻 —— 这时候它是唯一的异常节点 */
check('★ 第一次被选中，就把那一刻记上了', ev0.priorityTime, T('20:30:00'));
/* 记下的原因和「谁是重点」那套算法现算的是**同一句**。
   要在刚记下的这一刻比 —— 后面它还会变，而事件上那句已经冻住了。

   8-3 之后这句原因不再贴到页面上（顶上只剩那一行，细节给了 report.html），
   所以断言的对象从 DOM 换成了 pickPriority。盯的东西没变：
   「为什么是它」全项目只有一处拼得出来，事件里记的就是那一处。 */
check('★ 记下的原因和 pickPriority 现算的那句一字不差',
  ev0.priorityReason, pickPriority(nodes).reason);
check('而且这句原因不会出现在顶部那一行里（分工：那一行只管「是它」）',
  [els.focus.innerHTML.includes(ev0.priorityReason),
    ev0.priorityReason.length > 0], [false, true]);

/* --- 段内继续异常：不另开一条 --- */

handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 33, 55, undefined, T('20:33:00')));
check('★ 段内又来一条异常：不另开一条', events.length, 1);
check('★ 起点不动（每次刷新起点的话，时长永远停在「不到 1 分钟」）',
  events[0].startTime, T('20:30:00'));
check('★ 表里还是那一行（每收一条加一行的话这里会变成 2）', evRowCount(), 1);
check('★ 之后又被选中也不覆盖（复盘要的是第一次被注意到的时刻）',
  events[0].priorityTime, T('20:30:00'));

/* 段里状态变了仍然是同一段、同一条 —— 和 7-1「统计的是连续异常、
   不是连续偏热」是同一个口径 */
handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 25, 80, undefined, T('20:36:00')));
check('★ 段里从偏热变成偏湿：还是同一条事件', events.length, 1);
check('★ problem 保持开案时的「连续偏热」（它是这条事件的名字，不跟着改）',
  events[0].problem, '连续偏热');

/* --- ★ 被记上的是胜出者**自己**的时刻，不是触发那一轮的报文时刻 ---

   构造一个「触发者是 A、胜出者是 B」的局面：
     dorm-a 20:00 起连续偏热，20 分钟，一直占着优先关注
     dorm-b 20:05 起也偏热，但只有 0 分钟，一直被 dorm-a 压着 —— 没被选中过
     dorm-a 20:30 恢复正常，这一轮触发的是 **dorm-a 的报文**，
       但胜出的是 dorm-b
   dorm-b 是这一刻才第一次被选中的，记的必须是它**自己**最新那条的 20:05。
   写成 record.time 的话，这里会看到 20:30 —— 那是别人的时间。 */
clearAll();
handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 31, 60, undefined, T('20:00:00')));
handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 31, 60, undefined, T('20:20:00')));
handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 31, 60, undefined, T('20:05:00')));
check('这时胜出的还是 dorm-a（20 分钟 > 0 分钟）', pickPriority(nodes).nodeId, 'dorm-a');
check('★ dorm-b 还没被选中过，所以还没记时刻', evOf('dorm-b').priorityTime, null);

handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 25, 60, undefined, T('20:30:00')));
check('★ dorm-a 恢复之后轮到 dorm-b 上位', pickPriority(nodes).nodeId, 'dorm-b');
check('★ 记的是 dorm-b **自己**最新那条的 20:05，不是这条触发报文的 20:30',
  evOf('dorm-b').priorityTime, T('20:05:00'));
check('★ 而且 dorm-b 自己的那条事件还在（恢复的是 dorm-a，不该动它）',
  [evOf('dorm-b').recoverTime, evOf('dorm-b').result], [null, '']);

/* --- 处理动作：也只记第一次 --- */

selectNode('dorm-b');
clickFan();
check('★ 按一下风扇：动作写进了那条事件', evOf('dorm-b').action, '风扇已开启');
check('★ 动作时间取的是该节点最新那条的 time', evOf('dorm-b').actionTime, T('20:05:00'));

handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 32, 60, undefined, T('20:10:00')));
clickFan();
check('★ 再按一次不覆盖（复盘看的是第一次动手是什么时候、做了什么）',
  evOf('dorm-b').actionTime, T('20:05:00'));

/* --- 结案：来了正常数据 --- */

handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 25, 60, undefined, T('20:55:00')));
check('★ 恢复正常之后没有要优先的了', pickPriority(nodes), null);
check('★ 写上了恢复时刻', evOf('dorm-b').recoverTime, T('20:55:00'));
check('★ result 变成「已恢复」', evOf('dorm-b').result, '已恢复');
check('★ 节点上那个引用摘掉了（这个节点没有「当前这段」了）',
  nodes['dorm-b'].event, null);
check('★ 但事件还在表里 —— 结案是留档，不是删除', evOf('dorm-b') !== undefined, true);
check('★ 表里那行写着「已恢复」', evBody().includes('已恢复'), true);
check('★ 行数没变（结案不加行也不减行）', evRowCount(), 2);

/* 恢复之后再异常，开的是**新的一条** —— 旧的那条已经结案了，不能被翻出来改。
   先把旧那条抓在手里：下面 unshift 进来一条新的之后，evOf('dorm-b')
   拿到的就是新的那条了，旧的就再也点不到。 */
const oldB = evOf('dorm-b');
handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 31, 60, undefined, T('21:00:00')));
check('★ 恢复之后又异常：开的是新的一条', events.length, 3);
check('★ 新那条的起点是 21:00，不是被改回去的 20:05',
  [events[0].nodeId, events[0].startTime, events[0].result],
  ['dorm-b', T('21:00:00'), '']);
check('★ evOf 现在拿到的是新那条（同一个节点两条事件，认最新）',
  evOf('dorm-b') === events[0], true);
check('★ 旧那条一个字段都没被动过',
  [oldB.startTime, oldB.recoverTime, oldB.result],
  [T('20:05:00'), T('20:55:00'), '已恢复']);
/* 新那条还没结案，也没被旧那条的状态污染 */
check('★ 新那条是干净的：没恢复、没动作、没被优先关注过',
  [evOf('dorm-b').recoverTime, evOf('dorm-b').action, evOf('dorm-b').priorityTime],
  [null, null, T('21:00:00')]);

/* --- 每个节点各记各的 --- */

handleMessage('dormmate/v1/nodes/dorm-c/telemetry', mk('dorm-c', 25, 80, undefined, T('21:05:00')));
check('★ 三个节点各有一条，互不串线',
  ids.map((id) => {
    const e = evOf(id);
    return e ? e.nodeId : null;
  }), ['dorm-a', 'dorm-b', 'dorm-c']);
/* dorm-a 早在 20:30 就恢复正常、那条已经结案了。后面这一串 dorm-b / dorm-c
   的消息一条都不该动到它 —— 起点和恢复时刻都还是它自己那两个。 */
check('★ dorm-a 那条的起点和恢复时刻都还是它自己的（后面的消息没改到它）',
  [evOf('dorm-a').startTime, evOf('dorm-a').recoverTime],
  [T('20:00:00'), T('20:30:00')]);
check('★ dorm-a 那条是「已恢复」，dorm-c 那条还在进行中',
  [evOf('dorm-a').result, evOf('dorm-c').result], ['已恢复', '']);

/* --- 清空 --- */

clearAll();
check('★ 清空把事件也一起清了（不清的话卡片写着「等待数据」，下面还列着上一轮的账）',
  events.length, 0);
check('清空后表里回到「还没有事件」', evBody().includes('还没有事件'), true);
check('清空后条数也清空', els['event-count'].textContent, '');
check('清空后按钮又灰了', exportBtn.disabled, true);
check('★ 清空后节点上没留下指向总表的野引用',
  ids.map((id) => nodes[id].event), [null, null, null]);
/* clearAll 是 events.length = 0（就地清空），不是 events = [] ——
   整个换掉的话，下面这个引用就指向一个已经被丢弃的数组了 */
check('★ 清空是就地清空：拿到的还是同一个数组对象',
  Array.isArray(events) && events.length === 0, true);

/* --- CSV 字节 --- */

clearAll();
handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 31, 60, undefined, T('20:30:00')));
selectNode('dorm-b');
clickFan();
handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 25, 60, undefined, T('20:55:00')));
handleMessage('dormmate/v1/nodes/dorm-c/telemetry', mk('dorm-c', 25, 80, undefined, T('21:00:00')));

const csv = buildEventsCSV();
const csvLines = csv.split('\r\n');

check('★ 表头就是那九列，顺序固定',
  csvLines[0],
  'nodeId,startTime,problem,priorityTime,priorityReason,action,actionTime,recoverTime,result');
check('★ 每条事件一行（两条 = 两行数据 + 一行表头）', csvLines.length, 4);
check('★ 行序和表里看到的一致（最新在前）',
  [csvLines[1].startsWith('dorm-c,'), csvLines[2].startsWith('dorm-b,')], [true, true]);

/* 换行：CRLF，而且每个 \n 前面都得有 \r */
check('★ 换行是 CRLF（Excel / WPS 对 LF 的兼容性不如 CRLF）',
  /\n/.test(csv) && !/[^\r]\n/.test(csv), true);
check('★ 末尾也有一个 CRLF（不是 \r\n\r\n，就一个）',
  [csv.endsWith('\r\n'), csv.endsWith('\r\n\r\n')], [true, false]);

/* 还没发生的格子要写成**空**。String(null) 会写成四个字母的 "null"：
   Excel 里看着像真存了一个叫 null 的值，Python 那边也判不出「这条还没结束」。 */
check('★ 整份 CSV 里一个 "null" 都没有', csv.includes('null'), false);
check('★ 没结案那条：动作 / 恢复 / 结果三处都是空',
  csvLines[1].endsWith(',,,,'), true);

/* 结了案那条：动作、恢复、结果都写上了 */
check('★ 已结案那条：动作、动作时间、恢复时刻、结果四处齐全',
  csvLines[2].endsWith(',风扇已开启,2026-09-22 20:30:00,2026-09-22 20:55:00,已恢复'), true);
check('★ problem 那一列写的是「连续偏湿」', csvLines[1].includes(',连续偏湿,'), true);

/* 转义（RFC 4180）：字段里有半角逗号或双引号时要包起来、内部的引号写成两个。
   真跑起来这两样都不会出现（原因里用的是全角「，」，不触发转义），
   但这份文件是要喂给 analysis.py 的，格式错一点那边就解析歪了。 */
events.unshift({
  nodeId: 'dorm-z', startTime: T('22:00:00'), problem: '连续偏热,带逗号',
  priorityTime: null, priorityReason: '他说"先看这个"',
  action: null, actionTime: null, recoverTime: null, result: '',
});
const csvQuoted = buildEventsCSV();
check('★ 含半角逗号的字段被双引号包起来',
  csvQuoted.includes('"连续偏热,带逗号"'), true);
check('★ 字段里的双引号写成两个',
  csvQuoted.includes('"他说""先看这个"""'), true);
events.shift();

/* --- 点一下导出按钮 --- */

const nBlobs = blobs.length;
const nAnchors = clickedAnchors.length;
const nAppended = appendedNodes.length;
const nRemoved = removedNodes.length;
const nTimers = timers.length;

clickExport();

check('★ 点一下造了一个 Blob', blobs.length, nBlobs + 1);
const made = blobs[blobs.length - 1];
check('★ MIME 是 text/csv;charset=utf-8', made.type, 'text/csv;charset=utf-8');
/* ★ BOM 必须在最前面。少了它 Excel/WPS 会按本地代码页解析，
   problem 和 result 里的中文就是乱码 —— 这正是当初定「带 UTF-8 BOM」的原因。 */
check('★ 内容第一个字符就是 UTF-8 BOM (U+FEFF)', made.text.charCodeAt(0), 0xFEFF);
check('★ BOM 之后就是 buildEventsCSV 拼出来的那份',
  made.text.slice(1), buildEventsCSV());

const anchor = clickedAnchors[clickedAnchors.length - 1];
check('★ 造了一个 <a>', clickedAnchors.length, nAnchors + 1);
check('★ 它是链接、下载名是 events.csv',
  [anchor.tag, anchor.download], ['a', 'events.csv']);
check('★ href 指向那个 object URL', anchor.href, objectUrls[objectUrls.length - 1].url);
/* 先插进文档再点：Firefox 里不插进文档的 <a> 点了没反应 */
check('★ 先插进 body 再点', appendedNodes.length, nAppended + 1);
check('★ 点完把 <a> 摘掉，不留垃圾节点',
  [removedNodes.length === nRemoved + 1, removedNodes[removedNodes.length - 1] === anchor],
  [true, true]);
/* 不能点完立刻 revoke：部分浏览器会在下载真正开始前就把 blob 释放掉，
   表现为「点了没反应」。所以是隔一会儿再回收。 */
check('★ objectURL 是延迟 1000ms 回收的，不是点完立刻 revoke',
  [timers.length, timers[timers.length - 1].ms, revokedUrls.length],
  [nTimers + 1, 1000, 0]);
timers[timers.length - 1].fn();
check('★ 到点了才 revoke，revoke 的就是那个 URL', revokedUrls, [anchor.href]);

/* 一条事件都没有时按钮是 disabled 的。真浏览器里点灰按钮不会触发回调，
   所以这里不模拟「点了会怎样」—— 上面 EVENTS_AT_LOAD 那条断言盯的就是它。 */

/* ============ Q. 语音提醒（Step 8-3）============ */
console.log('\n=== Q. 语音提醒 ===');

/* 这是四个出口里唯一一个「说给人听」的，约束也来自那里：声音是线性的，
   说过就过去了，没人能回头翻 —— 所以**只念一句**，而且每次都现算。
   念的那句话由 logic.js 的 buildAlert 拼（那边有单独的词句测试），
   这一段盯的是页面这一侧：点一下到底做了什么、按什么顺序做、失败了怎么办。 */
const speakBtn = els.speak;
/* 走页面真正注册在 #speak 上的那个回调，不直接调 speakAlert ——
   回调要是挂错了元素，这里就该红。 */
const clickSpeak = () => speakBtn._handlers.click.forEach((fn) => fn());
const noteText = () => els['speak-note'].textContent;
const lastSpoken = () => spoken[spoken.length - 1];

/* --- 接线本身 --- */

check('index.html 里有 #speak 按钮', dashHtml.includes('id="speak"'), true);
check('index.html 里有 #speak-note（念了哪一句写在这儿）',
  dashHtml.includes('id="speak-note"'), true);
check('★ 按钮上就挂着 speakAlert 这一个回调', speakBtn._handlers.click.length, 1);
/* 按钮下面那行说明是**唯一**能确认「它到底念了什么」的地方 ——
   静音、没音箱、声音太小的时候，声音这条出口整个是空白的。
   它是一行说明，不是第二个按钮：写成按钮的话，看的人会以为按它能重念。 */
check('★ 那行说明在页面上是个 <p>', /<p[^>]*id="speak-note"/.test(dashHtml), true);
check('★ 它是 textContent 贴上去的（那句话里夹着节点名，不走 innerHTML）',
  els['speak-note'].innerHTML, '');

/* --- 念的是「当前最重要的那一句」 --- */

clearAll();
handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 25, 60, undefined, T('20:00:00')));
handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 31, 60, undefined, T('20:00:00')));
handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 31, 60, undefined, T('20:10:00')));
check('（此刻重点是 dorm-b：段从 20:00 起，10 分钟）',
  pickPriority(nodes).nodeId, 'dorm-b');

const cancelledBefore = speechStub.cancelled;
const spokenBefore = spoken.length;
clickSpeak();

check('★ 点一下只念**一句**（不是把三个宿舍从头到尾念一遍）',
  spoken.length - spokenBefore, 1);
check('★ 念的就是 buildAlert 现算的那一句，逐字对得上',
  lastSpoken().text, 'dorm-b 偏热已持续 10 分钟，温度持平。');
check('★ 念的这句开头就是 pickPriority 挑出来的那个宿舍',
  lastSpoken().text.indexOf(pickPriority(nodes).nodeId), 0);
check('★ 交给 speak 的就是造出来的那个 utterance（不是造一个念另一个）',
  speechStub.uttered[speechStub.uttered.length - 1] === lastSpoken(), true);
/* 顺序是刻意的：不先 cancel 的话，连点两次第二句会老老实实排在队列里
   等第一句念完（好几秒）才开口 —— 而那时候念的是按下按钮那一刻算出来的话。 */
check('★ 先 cancel 再 speak（不然连点两次，第二句要排队等第一句念完）',
  [speechStub.cancelled - cancelledBefore, speechLog.slice(-2)],
  [1, ['cancel', 'speak']]);
check('★ lang 设成了 zh-CN（不设的话按系统语言挑嗓音，中文会被念成字母）',
  lastSpoken().lang, 'zh-CN');
check('★ 念了哪一句写在那行说明里（静音时唯一能确认它念了什么的地方）',
  noteText(), '正在朗读：' + lastSpoken().text);

/* --- 处理状态也念出来 --- */

selectNode('dorm-b');
els['action-fan']._handlers.click.forEach((fn) => fn());
clickSpeak();
/* handlingNote() 是全项目唯一拼得出「风扇已开启，处理中」的地方，
   7-1 那条栏、B2 依据、这一句读的都是它。 */
check('★ 按过风扇之后念的那句带上「（风扇已开启，处理中）」',
  lastSpoken().text.includes('（风扇已开启，处理中）'), true);
check('而且念的是 dorm-b（重点没换人）',
  lastSpoken().text.indexOf('dorm-b'), 0);

/* --- ★ 每次都现算，一个字都不缓存 --- */

/* 念一句旧的比不念更糟：听的人以为现在还是那样。 */
handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 16, 60, undefined, T('20:00:00')));
handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 15, 60, undefined, T('20:30:00')));
check('这时重点已经换人了（dorm-a 的段 30 分钟，比 dorm-b 的 10 分钟长）',
  pickPriority(nodes).nodeId, 'dorm-a');
check('上一句确实说的是别人（不然下面那条可能只是恰好相等）',
  lastSpoken().text.includes('dorm-b'), true);

clickSpeak();
check('★ 数据变了：再点一次念的是新算的那句，不是上一次那句',
  lastSpoken().text, 'dorm-a 偏冷已持续 30 分钟，温度正在下降。');
check('趋势也跟着念出来了（不是每次都念同一套词）',
  lastSpoken().text.includes('温度正在下降'), true);

/* --- 没有重点可念的时候，念的也得是实话 --- */

clearAll();
clickSpeak();
check('★ 一条数据都没有：念的是「还没有收到数据」，不是「都正常」',
  lastSpoken().text, '还没有收到任何节点的数据。');
/* 再点一次也得重算，不能因为「上一次算过了」就跳过 cancel/speak */
const cancelledIdle = speechStub.cancelled;
clickSpeak();
check('平静时照样每次都真的念（不是「没重点就什么都不做」）',
  [spoken.length > 0, speechStub.cancelled - cancelledIdle], [true, 1]);

handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 25, 60, undefined, T('20:00:00')));
handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 25, 60, undefined, T('20:00:00')));
handleMessage('dormmate/v1/nodes/dorm-c/telemetry', mk('dorm-c', 25, 60, undefined, T('20:00:00')));
clickSpeak();
check('★ 三个都正常：念的是「都正常」，句号收尾',
  lastSpoken().text, '当前 3 个宿舍都正常。');

/* --- 浏览器不支持语音合成 --- */

/* 两个都要查：Chrome 上 speechSynthesis 一直在，缺的是 SpeechSynthesisUtterance
   那个构造函数。少查一个的话，点一下就是一条未捕获的 TypeError ——
   按钮看着能用，按下去什么也没有。 */
const savedSynth = speechStub;
const savedCtor = context.window.SpeechSynthesisUtterance;
const spokenBeforeUnsupported = spoken.length;

context.window.speechSynthesis = undefined;
clickSpeak();
check('★ 不支持时一个 utterance 都不造（不是造出来再失败）',
  spoken.length, spokenBeforeUnsupported);
check('★ 不支持时把那句话写出来，而不是静悄悄地什么都不做',
  [noteText().includes('不支持语音合成'), noteText().includes('要念的是：')], [true, true]);
check('说明里带着本来要念的那句（不然还是不知道它想说什么）',
  noteText().includes(buildAlert(nodes)), true);

/* 只缺构造函数这一半 —— 单独再走一遍，因为两个条件是分开写的 */
context.window.speechSynthesis = savedSynth;
context.window.SpeechSynthesisUtterance = undefined;
clickSpeak();
check('★ 只缺 SpeechSynthesisUtterance 也算不支持（它是构造函数，typeof 不是 function）',
  spoken.length, spokenBeforeUnsupported);
context.window.SpeechSynthesisUtterance = savedCtor;

/* --- 朗读失败：原始错误码要写出来 --- */

clickSpeak();
const failedUtterance = lastSpoken();
check('★ 挂上了 onerror（不挂的话朗读失败是静悄悄的，那行说明会一直写着「正在朗读」）',
  typeof failedUtterance.onerror, 'function');
failedUtterance.onerror({ error: 'not-allowed' });
/* 原始错误码写在最前面 —— 解释文案可能对不上，错误码不会骗人
   （和 3-2 那张 VOICE_ERRORS 表同一条原则）。 */
check('★ 失败时把原始错误码写在那行说明里',
  [noteText().includes('朗读失败'), noteText().includes('not-allowed')], [true, true]);
check('也把本来要念的那句带上', noteText().includes(failedUtterance.text), true);
failedUtterance.onerror(null);
check('连事件对象都没有时退回 unknown，不崩', noteText().includes('unknown'), true);

/* --- 清空之后那行说明也要清掉 --- */

clickSpeak();
check('念过之后那行说明里有字', noteText().length > 0, true);
clearAll();
/* 那行字是「上一次念的内容」。清空之后它一直挂在那儿，看着像是刚刚念过 ——
   而那时要念的那句已经变回「还没有收到任何节点的数据」了。 */
check('★ 清空之后那行说明也清了', noteText(), '');
check('清空之后顶部那一行也回到了起点',
  els.focus.innerHTML.includes('还没有收到任何节点的数据'), true);

/* --- 语音和顶部那一行必须指向同一个人 --- */

/* 这是这一步最容易出的错：两个出口各拼一份，页面上那一行说的是 dorm-b、
   语音念的是 dorm-c。逻辑上防它的办法是「两边都从 pickPriority 出发」，
   这里从页面上再验一次。 */
clearAll();
handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 31, 60, undefined, T('20:00:00')));
handleMessage('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 31, 60, undefined, T('20:10:00')));
handleMessage('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 31, 60, undefined, T('20:05:00')));

const pickNow = pickPriority(nodes);
clickSpeak();
check('★ 顶部那一行里就是 buildFocus 那句话（页面不自己另拼一份）',
  els.focus.innerHTML.includes(buildFocus(nodes)), true);
check('★ 语音念的就是 buildAlert 那句话',
  lastSpoken().text, buildAlert(nodes));
check('★ 两个出口说的是同一个宿舍',
  [buildFocus(nodes).indexOf(pickNow.nodeId), lastSpoken().text.indexOf(pickNow.nodeId)],
  [0, 0]);
check('（这时重点确实是 dorm-b：它 10 分钟，dorm-a 只有 0 分钟）',
  pickNow.nodeId, 'dorm-b');

/* --- 直接调 speakAlert 也走同一条路（上一段里点按钮走的就是它）--- */

const spokenBeforeDirect = spoken.length;
speakAlert();
check('★ 直接调 speakAlert 和点按钮效果一样（就一个实现，没有第二条路）',
  [spoken.length - spokenBeforeDirect, lastSpoken().text], [1, buildAlert(nodes)]);

const lineIdem = els.focus.innerHTML;
renderFocus();
check('★ 数据没变时重画那一行，内容一字不差（幂等）',
  els.focus.innerHTML, lineIdem);

clearAll();
check('★ 清空之后顶部那一行回到起点，不留上一次的账',
  els.focus.innerHTML.includes('还没有收到任何节点的数据'), true);

/* ============ R. ML 辅助判断（Step 9-3 的进阶项）============
   这一段和上面每一段都不同：它的数据不来自 MQTT，而是页面自己去 fetch
   一份**静态文件**（analysis/analysis.py 上一次跑完写的 report/ml_result.json）。
   要验的有三件：

     1) 打开页面就去读，而且只读一次
     2) 读回来了 —— 摆的就是文件里那句结论，不是页面另写的一份
     3) 读不到（404 / 服务器没起 / 回来不是 JSON / 文件不是那个文件）
        都得降级成一行**说清原因**的字，不能空着、不能把页面拖垮

   第 3 条是这个文件里最容易漏的：那些路径平时跑不到，出事的时候正好在现场演示。 */
console.log('\n=== R. ML 辅助判断（看板读 report/ml_result.json）===');

const mlCount = () => els['ml-count'].textContent;
const mlText = () => els['ml-text'].textContent;
const mlNote = () => els['ml-note'].textContent;

/* --- 接线本身 --- */

check('index.html 里有 #ml-text', dashHtml.includes('id="ml-text"'), true);
check('index.html 里有 #ml-count', dashHtml.includes('id="ml-count"'), true);
check('index.html 里有 #ml-note', dashHtml.includes('id="ml-note"'), true);
check('面板标题就是「ML 辅助判断」', dashHtml.includes('ML 辅助判断'), true);

/* 启动时读，就一次 —— 这一段是静态文件，没有「再读一遍」的理由，
   多读几次不但没用，还会把「它跟实时数据没关系」这件事说糊。 */
check('★ 打开页面就去读那份 JSON（就一次）', fetchCalls, ['../report/ml_result.json']);

/* --- 读回来之前 --- */

/* 占位那句话写在 index.html 里（假 DOM 读不到它，所以对着**文件**查），
   它必须落在 #ml-text 这个 <p> 里头 —— 落到别处就白写了。
   fetch 是异步的，那几百毫秒里那一块空着的话，看着跟「这一段没有内容」一样。 */
check('★ 读回来之前那一块写着「正在读取」而不是空白（fetch 是异步的）',
  /id="ml-text"[^>]*>正在读取[^<]*</.test(dashHtml), true);
check('（占位那句里点明了读的是哪份文件）',
  /id="ml-text"[^>]*>[^<]*report\/ml_result\.json/.test(dashHtml), true);
/* 条数那一格是 JS 填的，所以这一条看的是真跑起来之后的那个元素：
   它只能是空的 —— 先摆一个「0 条」的话，读回来之前看着就像「一条都没差」。 */
check('★ 读回来之前条数那格是空的（不先摆一个「0 条」）', ML_AT_LOAD.count, '');

/* --- 真的把仓库里那份读了 --- */

/* 下面每一跳都拿**它自己**跟真文件里的数对，不写死 2 条 / 40 条 ——
   data/ 一改或脚本重跑一遍，那些数就会变，写死的断言会红得莫名其妙。
   读的是仓库里那份真文件，也不自己手写一份假 JSON：手写的桩在
   analysis.py 改了字段名之后照样全绿，而真页面上会写「这一段没跑」。 */
const ML_REAL = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'report', 'ml_result.json'), 'utf8'));

/* fetch 回来之后还要过两个 then 才轮到页面 —— 那些排在微任务里。
   setTimeout(0) 是宏任务，排在所有微任务后面，等它一轮就够了。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/* 这一段读不到那份文件时，一个节点、一条事件都不该被动过 ——
   它是**另一条数据线**，跟 MQTT 那条没有任何关系。 */
const ML_BEFORE = JSON.stringify(nodes) + '|' + events.length;

(async function () {
  fetchPending[0].resolve({ ok: true, status: 200, json: () => Promise.resolve(ML_REAL) });
  await settle();

  const want = buildMlNote(ML_REAL);
  check('★ 页面上摆的三样就是那个纯函数算出来的三样（页面一个字都不自己拼）',
    [mlCount(), mlText(), mlNote()], [want.count, want.text, want.note]);
  check('★ 结论那句就是真文件里那一句（看板和报告说的是同一句话）',
    mlText(), ML_REAL.text);
  check('★ 条数就是真文件里「规则说正常、ML 说不同」那个数',
    mlCount().includes('：' + ML_REAL.mismatchForward + ' 条'), ML_REAL.mismatchForward > 0);
  check('★ 说明里写着不是实时数据（看板上别的数字都在动，这一段不动）',
    mlNote().includes('不是实时数据'), true);
  check('★ 说明里那两份文件名和真文件对得上',
    [mlNote().includes(ML_REAL.newFile), mlNote().includes(ML_REAL.historyFile)],
    [true, true]);
  check('★ 说明里带着那份 JSON 记的时刻', mlNote().includes(ML_REAL.generatedAt), true);

  /* --- 读不到：先是一个「文件根本打不开」 --- */

  loadMlResult();
  fetchPending[1].reject(new Error('Failed to fetch'));
  await settle();

  check('★ 打不开时降级成一句「这一段没跑：……」，不抛也不空着',
    [mlText().indexOf('这一段没跑：') === 0, mlText().includes('Failed to fetch')],
    [true, true]);
  check('★ 打不开时条数那格是空的（不写「0 条」，那看着像「一条都没差」）',
    mlCount(), '');
  check('★ 打不开时告诉人先跑哪个脚本',
    mlNote().includes('py -3.14 analysis/analysis.py'), true);

  /* --- 404：页面不是从项目根目录起的服务器时就是这样 --- */

  loadMlResult();
  fetchPending[2].resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  await settle();
  check('★ 404 说的是「HTTP 404」，不是拿一句「读不到」糊过去',
    mlText().includes('HTTP 404'), true);

  /* --- 回来不是 JSON：文件被人占着写了一半，或者服务器给了个 404 页面 --- */

  loadMlResult();
  fetchPending[3].resolve({
    ok: true, status: 200,
    json: () => Promise.reject(new Error('Unexpected token < in JSON at position 0')),
  });
  await settle();
  check('★ 回来不是 JSON 时也说得出为什么',
    mlText().includes('Unexpected token'), true);

  /* --- 是 JSON，但不是 analysis.py 写的那份 --- */

  loadMlResult();
  fetchPending[4].resolve({ ok: true, status: 200, json: () => Promise.resolve({ hi: 1 }) });
  await settle();
  check('★ 文件在那儿但不是那一份：照样说「这一段没跑」',
    [mlText().indexOf('这一段没跑：') === 0, mlText().includes('该写的字段')],
    [true, true]);

  /* --- 这四条路走下来，别的任何一块都不该动过 --- */

  check('★ ML 那一段读不到，一个节点、一条事件都不动（它不走 MQTT 那条线）',
    JSON.stringify(nodes) + '|' + events.length, ML_BEFORE);

  /* --- 再读到一次能恢复：降级是一时的，不是把这一块写死 --- */

  loadMlResult();
  fetchPending[5].resolve({ ok: true, status: 200, json: () => Promise.resolve(ML_REAL) });
  await settle();
  check('★ 再读到时又能摆回来（降级不留痕）', mlText(), ML_REAL.text);

  /* --- 直接调 loadMlResult 也走同一条路（上面每一次都是它）--- */

  check('★ 跑在页面上的就是 dashboard.js 里那个函数（不是测试另造的一条路）',
    typeof loadMlResult, 'function');

  /* --- L 段那个「什么都没有」的上下文 --- */

  /* 那边没有 mqtt、没有 WebGL、也没有能用的 fetch（模拟离线 / 服务器没起）。
     页面照样得起来，ML 那一段降级成一行字 —— 它的 promise 是在那边加载时
     发出的，刚刚这几轮微任务里已经跑完了。 */
  check('★ L 段那个「要什么没什么」的上下文里，ML 那一段也降级成一行字',
    els2['ml-text'].textContent.indexOf('这一段没跑：') === 0, true);
  check('（那边连 fetch 都用不了，原因写的就是打不开）',
    els2['ml-text'].textContent.includes('Failed to fetch'), true);

  console.log(`\n结果：${pass} 通过，${fail} 不通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
