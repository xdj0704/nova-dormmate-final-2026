// tests/dashboard.test.js
// 校验 dashboard/dashboard.js —— 多节点看板的唯一消息入口 handleMessage，
// 以及 Step E3-2 之后它那套「只订快照、只渲染」的行为。
//
// 重点盯五件事：
//   1) **只认一条 topic**。除了 dormmate/v1/state，别的一律忽略，
//      而且忽略之后页面一个字节都不能变（订到别人的 topic、端口连错，
//      都是这么表现的）。遥测 topic 尤其要拦 —— 那是 E3 之前它订的那条。
//   2) **不做业务计算**。快照说什么就是什么：状态是「台风」也照显示，
//      温度是 99 也照显示，页面不修不补也不复核。
//   3) **按下「开始处理」之后页面一个字都不改** —— 这是红线最强的表达：
//      好没好等 core 发回下一帧快照。以前按一下就地改四个字段、
//      屏幕上立刻写「处理中」，那正是这一轮要拆掉的东西。
//   4) 跨端联动：快照里的 focus 一变，看板的选中项跟着走；但用户点过别处之后
//      不再被同一条 focus 拽回去。
//   5) 清空清的是**屏幕**，不是 core —— 下一条快照一到画面就回来。
//
// 做法是把 DOM / Chart.js / mqtt / 3D / speechSynthesis / fetch 全打上桩，
// 用 vm 把 shared/config.js、dashboard/logic.js（真文件）、dashboard.js 依次跑起来。
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
    /* dashboard.js 里那句 `el.conn.className = 'conn conn--' + kind` 直接赋值，
       所以要有个初值能读回来。 */
    className: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    _classes: classes,
    /* 把注册的回调留下来。卡片和顶部那条横幅的点击都是事件委托
       （内容整块重画，不给每次新生成的按钮单独绑），不记下来就没法触发它们 ——
       而「点卡片换查看对象」「点横幅等于点卡片」正是要测的东西。 */
    _handlers: {},
    addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
  };
}

const els = {};
/* 这份清单就是 dashboard/index.html 里那些 id。**一个都不能漏**：
   getElementById 对没登记的 id 会现场造一个新的，那样测试读到的
   els['event-body'] 和 dashboard.js 里 el.evBody 拿到的就不是同一个对象，
   断言全是假绿 —— 页面上明明没变，测试却看见变了。 */
['cards', 'log-body', 'log-count', 'detail-node', 'detail-meta',
  'action-handle', 'action-state', 'cmd-note', 'chart-note',
  'scene3d', 'focus', 'speak', 'speak-note',
  'event-body', 'event-count', 'export-events',
  'reject-body', 'reject-count',
  'clear', 'conn', 'conn-text', 'toggle',
  'ml-count', 'ml-text', 'ml-note',
  'chart-temp', 'chart-humidity']
  .forEach((id) => { els[id] = makeEl(id); });

/* index.html 里那一句是**写在标签里**的，不是页面脚本填的 ——
   造出来的空元素得照着补上，否则读回来是空串，看着像「页面把占位抹了」。
   这段字的唯一作用是：fetch 还没回来那一小段时间里别留白。 */
els['ml-text'].textContent = '正在读取 report/ml_result.json …';

const chartsBox = makeEl('charts');

/* 打桩也要给回和 style.css 里一样的值，不然测不出颜色有没有接错 */
const PALETTE = {
  '--chart-temp': '#2a78d6',
  '--chart-humidity': '#c9407f',
  '--chart-grid': 'rgba(11, 11, 11, 0.08)',
  '--text-muted': '#898781',
  '--surface-1': '#fcfcfb',
};

/* 导出 CSV 那条路要用到 vm 里没有的三样东西：Blob、URL、
   以及 document.createElement —— 真实现是临时造一个 <a download> 插进 body
   再点它一下。不补这三样，点导出按钮就是 ReferenceError，
   而「导出的字节到底对不对」正是这一步最该测的东西。 */
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
   这里把 connect/subscribe/publish/on 都记下来，测试就能主动触发握手、
   主动投递消息、检查发出去的东西。 */
const mqttStub = {
  clients: [],
  connect(url, opts) {
    const handlers = {};
    const c = {
      url, opts, handlers, subscribed: [], ended: false, endForce: null,
      /* 真 mqtt.js 的客户端连上之后 connected 就是 true，这里照做 ——
         不然 sendHandle 会一直走「没连上」那条分支。 */
      connected: false,
      published: [],
      on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return c; },
      subscribe(topic, o, cb) { c.subscribed.push({ topic, opts: o }); if (cb) cb(null); return c; },
      publish(topic, payload, opts) {
        c.published.push({ topic, payload, opts });
        return c;
      },
      end(force) { c.ended = true; c.endForce = force; return c; },
    };
    mqttStub.clients.push(c);
    return c;
  },
};

/* ---------- 3d/scene.js 打桩 ---------- */
/* 不记录的话就测不出「切节点 / 收到新快照时到底有没有把状态交给 3D」。
   打桩挂的是 createDorm3D（模块里 import 的那个名字），不是 3D 场景本身。 */
const sceneCalls = [];
function createDorm3DStub(hostId) {
  const rec = { hostId, statuses: [], labels: [], fans: [], focus: [], ops: [], disposed: 0 };
  sceneCalls.push(rec);
  return {
    updateScene(status) { rec.statuses.push(status); rec.ops.push('updateScene'); return status; },
    setLabel(text) { rec.labels.push(text); rec.ops.push('setLabel'); return text; },
    /* setFanOn 要记下来：验收点之一是「有人按过开始处理，扇叶得一直转」。
       ops 是按调用顺序记的**混在一起**的流水 ——
       scene.js 里那句「后调用的那次为准」意味着 updateScene 和 setFanOn
       的先后顺序本身就是一个必须钉住的约定，分开两个数组就看不出顺序了。 */
    setFanOn(on) { rec.fans.push(on); rec.ops.push('setFanOn'); },
    setFocus(on) { rec.focus.push(!!on); rec.ops.push('setFocus'); },
    dispose() { rec.disposed += 1; },
  };
}

/* ---------- speechSynthesis 打桩 ---------- */
/* 真浏览器里 speak() 是异步出声的，测试环境没有声卡、也不需要。
   要验的是「按下按钮之后按顺序做了什么」：先 cancel 再 speak、
   utterance 的 lang 设成了 zh-CN、onerror 把**原始错误码**写进了那行说明。
   顺序单独记在 speechLog 里 —— 只看计数是看不出先后的。 */
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
  speak(u) { this.uttered.push(u); speechLog.push('speak'); },
};

/* ---------- fetch 打桩 ---------- */
/* 看板打开时会 fetch('../report/ml_result.json')。vm 里没有 fetch，
   不打桩就是 ReferenceError —— 而这一段的验收点（读到了摆什么、
   404 摆什么、回来不是 JSON 又摆什么）全都发生在 promise 回来**之后**，
   所以桩不直接把结果给出去：它把 resolve / reject 存起来，
   让测试自己挑时候放行，放行之后再等一轮微任务才读得到页面。 */
const fetchCalls = [];
const fetchPending = [];
function fetchStub(url) {
  fetchCalls.push(url);
  return new Promise((resolve, reject) => { fetchPending.push({ resolve, reject }); });
}

/* ---------- console 打桩 ---------- */
/* dashboard.js 每条原始报文都往 Console 打一行。测试里那会是几百行噪音，
   而且「发出去的那条指令 payload 是什么」正好也在 Console 那行里 —— 记下来备用。 */
const consoleLogs = [];
const consoleStub = {
  log: (...args) => { consoleLogs.push(args.map(String).join(' ')); },
  warn: (...args) => { consoleLogs.push('WARN ' + args.map(String).join(' ')); },
  error: (...args) => { consoleLogs.push('ERROR ' + args.map(String).join(' ')); },
};

/* ---------- 上下文 ---------- */
/* ★ window 就指向上下文自己。
   真浏览器里 window === globalThis，shared/config.js 挂的是 globalThis
   （见那个文件最后一行），dashboard.js 读的是 window.DormMateConfig ——
   只有把这两个当成同一个东西，才和浏览器里的行为一致。
   分成两个对象的话，config.js 挂到 A、dashboard.js 读 B，页面上永远是
   「未加载 shared/config.js」。 */
const context = {
  document: documentStub,
  Chart: ChartStub,
  mqtt: mqttStub,
  fetch: fetchStub,
  createDorm3D: createDorm3DStub,
  location: { hostname: 'localhost' },
  getComputedStyle: () => ({ getPropertyValue: (n) => PALETTE[n] || '' }),
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  speechSynthesis: speechStub,
  SpeechSynthesisUtterance: SpeechSynthesisUtteranceStub,
  Blob: BlobStub,
  URL: URLStub,
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  console: consoleStub,
  JSON, Math, Date, Number, Object, Array, String, Set, Boolean,
  isNaN, parseInt, Promise, Error, RegExp, TypeError, undefined,
};
context.globalThis = context;
context.window = context;

vm.createContext(context);

/* ---------- 依次加载三个真文件 ---------- */

const CONFIG_SRC = path.join(ROOT, 'shared', 'config.js');
const LOGIC_SRC = path.join(ROOT, 'dashboard', 'logic.js');
const DASH_SRC = path.join(ROOT, 'dashboard', 'dashboard.js');

/* 1) shared/config.js —— 普通 script，原样跑。
      跑完之后 window.DormMateConfig 就有了（挂的就是 globalThis）。 */
vm.runInContext(fs.readFileSync(CONFIG_SRC, 'utf8'), context, { filename: CONFIG_SRC });

/* 2) dashboard/logic.js —— 真文件（不打桩）。
      「一个结论都不下」这条正是这一轮的全部内容，打个桩等于把要测的东西测没了。
      它是 ES 模块，把 `export ` 前缀摘掉就行：顶层 function 声明在 vm 里
      就是上下文的全局属性，后面 dashboard.js 调到的就是这里定义的那一个。
      顺带一个副作用是好事：logic.js 和 dashboard.js 的顶层名字撞了的话，
      这里会当场抛「Identifier 'x' has already been declared」。 */
vm.runInContext(fs.readFileSync(LOGIC_SRC, 'utf8').replace(/^export\s+/gm, ''),
  context, { filename: LOGIC_SRC });

/* 3) dashboard/dashboard.js —— 摘掉那两条 import。
     它是 ES 模块，而 vm.runInContext 只能跑普通脚本，原样喂进去会抛
     「Cannot use import statement outside a module」。摘之前先数一遍，
     必须正好两条；将来谁再加一条 import，这里立刻炸出来，
     而不是把那条也悄悄摘了、测了个假的。 */
const dashText = fs.readFileSync(DASH_SRC, 'utf8');
const importCount = (dashText.match(/^import\s/gm) || []).length;
if (importCount !== 2) {
  throw new Error('dashboard.js 里应该是两条 import，实际 ' + importCount + ' 条 —— '
    + '下面那两个正则摘不干净，vm 会抛语法错。');
}
const SCENE_IMPORT = /^import\s*\{\s*createDorm3D\s*\}\s*from\s*'\.\.\/3d\/scene\.js';\s*$/m;
/* 这条 import 折成了两行，所以分隔符一律写 \s —— 它能匹配换行。
   写成字面空格的话摘不掉，下一句 vm 会抛「Cannot use import statement outside a module」。

   名字那一段必须用 [^{}]* 而不是 [\s\S]*?：两条 import 挨在一起，用后者的话
   正则可以从**上一行那条** `import { createDorm3D }` 的 `{` 起头，
   一路吞到 './logic.js' 的 `}` —— 匹配是成功的，但摘出来的是错的那一段
   （下面按名字数量做的断言就是这么发现它的）。 */
const LOGIC_IMPORT = /^import\s*\{[^{}]*\}\s*from\s*'\.\/logic\.js';\s*$/m;

let src = dashText
  .replace(SCENE_IMPORT, '/* import 已摘除：顶上用的是上下文里的 createDorm3D 打桩 */\n')
  .replace(LOGIC_IMPORT, '/* import 已摘除：上面已经把真 logic.js 的函数放进上下文了 */\n');
if (/^import\s/m.test(src)) throw new Error('还有 import 没摘掉，vm 会抛语法错');

vm.runInContext(src, context, { filename: DASH_SRC });

/* ---------- 造数据 ---------- */

function nodeRow(nodeId, over) {
  const row = {
    nodeId: nodeId,
    online: true,
    status: '正常',
    temperature: 25,
    humidity: 60,
    time: '2026-09-22 20:30:00',
    abnormalCount: 0,
    durationSec: null,
    durationText: null,
    reason: '',
    lastSeen: '2026-09-22 20:30:00',
    historyCount: 3,
    history: [
      { time: '2026-09-22 20:28:00', temperature: 25, humidity: 60, status: '正常' },
      { time: '2026-09-22 20:29:00', temperature: 25, humidity: 60, status: '正常' },
      { time: '2026-09-22 20:30:00', temperature: 25, humidity: 60, status: '正常' },
    ],
  };
  Object.keys(over || {}).forEach(function (k) { row[k] = over[k]; });
  return row;
}

function eventRow(over) {
  const e = {
    event_id: 'dorm-a-20260922-202800',
    nodeId: 'dorm-a',
    state: 'OPEN',
    startTime: '2026-09-22 20:28:00',
    problem: '温度偏高（31℃）',
    priorityTime: '2026-09-22 20:30:00',
    priorityReason: '连续异常 3 次、已持续 2 分钟，最久',
    action: null, actionTime: null, actionSource: null,
    recoverTime: null, endTime: null, result: null,
    abnormalAfter: 0, verifyCount: 0,
  };
  Object.keys(over || {}).forEach(function (k) { e[k] = over[k]; });
  return e;
}

function snapshotOf(over) {
  const s = {
    v: 2,
    time: '2026-09-22 20:30:00',
    focus: null,
    priority: null,
    nodes: [nodeRow('dorm-a'), nodeRow('dorm-b'), nodeRow('dorm-c')],
    events: {
      summary: { total: 0, OPEN: 0, HANDLING: 0, RECOVERED: 0, UNRESOLVED: 0 },
      dropped: 0, events: [],
    },
    rejects: { total: 0, kept: 0, items: [] },
    counters: { received: 0, rejected: 0, statusMismatch: 0, retainedCleared: 0,
      commands: 0, commandRejected: 0 },
  };
  Object.keys(over || {}).forEach(function (k) { s[k] = over[k]; });
  return s;
}

/** 一份「上面出事了」的快照：dorm-b 偏热、开着案、已经按过开始处理。 */
function busySnapshot(over) {
  const hot = nodeRow('dorm-b', {
    status: '偏热', temperature: 31, abnormalCount: 3,
    durationSec: 1200, durationText: '20 分钟',
    reason: '已连续偏热 20 分钟（3 次）',
    history: [
      { time: '2026-09-22 20:28:00', temperature: 33, humidity: 60, status: '偏热' },
      { time: '2026-09-22 20:29:00', temperature: 32, humidity: 60, status: '偏热' },
      { time: '2026-09-22 20:30:00', temperature: 31, humidity: 60, status: '偏热' },
    ],
  });
  const s = snapshotOf({
    priority: { nodeId: 'dorm-b', status: '偏热', severity: 'critical',
      abnormalCount: 3, durationSec: 1200, durationText: '20 分钟',
      reason: '已连续偏热 20 分钟（3 次）' },
    nodes: [nodeRow('dorm-a'), hot, nodeRow('dorm-c')],
    events: {
      summary: { total: 8, OPEN: 0, HANDLING: 1, RECOVERED: 7, UNRESOLVED: 0 },
      dropped: 0,
      events: [
        eventRow({ nodeId: 'dorm-a', state: 'RECOVERED', recoverTime: '2026-09-22 20:10:00',
          endTime: '2026-09-22 20:10:00', result: '已恢复', action: '开启风扇 / 通风' }),
        eventRow({ nodeId: 'dorm-b', state: 'HANDLING', action: '开启风扇 / 通风',
          actionTime: '2026-09-22 20:31:00', actionSource: 'dashboard', abnormalAfter: 2 }),
      ],
    },
    rejects: { total: 1, kept: 1, items: [{ time: '2026-09-22 20:29:00',
      topic: 'dormmate/v1/nodes/dorm-a/telemetry', reasons: ['JSON 解析失败'],
      payload: '{not json' }] },
    counters: { received: 42, rejected: 1, statusMismatch: 0, retainedCleared: 0,
      commands: 2, commandRejected: 0 },
  });
  Object.keys(over || {}).forEach(function (k) { s[k] = over[k]; });
  return s;
}

/* ---------- 驱动页面的小工具 ---------- */

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? `  =>  ${a}` : `\n        实际: ${a}\n        期望: ${e}`));
}

function liveClient() { return mqttStub.clients[mqttStub.clients.length - 1]; }

/** 让 socket 真的连上（触发 connect 回调 -> 订阅）。 */
function goOnline() {
  const c = liveClient();
  c.connected = true;
  (c.handlers.connect || []).forEach((fn) => fn());
  return c;
}

/* 投递一条消息，走的是**页面自己注册的那个回调**（不是直接调 handleMessage）——
   这样连「mqtt.js 给的是二进制、页面要先 toString」这一段也在测的范围里。 */
let deliveries = 0;
function deliver(topic, text) {
  deliveries += 1;
  const c = liveClient();
  (c.handlers.message || []).forEach((fn) => fn(topic, { toString: () => text }));
}

function feed(snapshot) { deliver('dormmate/v1/state', JSON.stringify(snapshot)); }

/** 点某张卡片（事件委托：造一个 target.closest 能认出 .card 的假事件）。 */
function clickCard(nodeId) {
  const target = { closest: (sel) => (sel === '.card' ? { dataset: { node: nodeId } } : null) };
  els.cards._handlers.click.forEach((fn) => fn({ target }));
}

/** 点顶部那条横幅。 */
function clickBanner(nodeId) {
  const target = { closest: (sel) => (sel === '.focus' ? { dataset: { node: nodeId } } : null) };
  els.focus._handlers.click.forEach((fn) => fn({ target }));
}

/* 真浏览器里灰掉的按钮**不会触发 click**。桩要照抄这个行为 ——
   不然「灰按钮点不动」那条测的就是桩自己，页面上明明按不动，测试却看见发了消息。 */
function clickHandle() {
  if (els['action-handle'].disabled) return;
  els['action-handle']._handlers.click.forEach((fn) => fn());
}
function clickClear() { els.clear._handlers.click.forEach((fn) => fn()); }
function clickExport() { els['export-events']._handlers.click.forEach((fn) => fn()); }
function clickSpeak() { els.speak._handlers.click.forEach((fn) => fn()); }
function clickToggle() { els.toggle._handlers.click.forEach((fn) => fn()); }

/** 数一数页面上画了几张卡片。
    `(?!-)` 是必须的：卡片里面还有 card-head / card-action / card-foot 三个
    class，写成 /class="card/ 的话一张卡会被数成四张。 */
function cardCount() { return (els.cards.innerHTML.match(/class="card(?!-)/g) || []).length; }

/** 等一轮微任务 —— fetch 的 promise 链要转好几圈才轮到 renderMl。 */
function settle() { return new Promise((resolve) => setImmediate(resolve)); }

const stateTopic = 'dormmate/v1/state';

/* ==================================================================== */

(async function main() {

/* ---------- A. 启动那一刻 ---------- */

console.log('=== A. 启动 ===');

check('★ 打开页面就连（连的是 shared/config.js 里那个地址）',
  mqttStub.clients.length, 1);
check('★ 地址里带 9001（WebSocket 端口来自配置，不是写死的）',
  liveClient().url, 'ws://localhost:9001');
check('还没连上时顶部写的是「连接中…」', els['conn-text'].textContent, '连接中…');
check('连接状态那个 class 是 pending', els.conn.className, 'conn conn--pending');
check('★ 打开时不会自己订阅（要等 socket 真的连上）',
  liveClient().subscribed.length, 0);

check('★ 一张卡片都没有时，卡片区写的是一句说明（不是空白）',
  els.cards.innerHTML.indexOf('还没有收到 core 的快照') > 0, true);
check('★ 那句话告诉人先起 core.py（把出路写出来，不是干等）',
  els.cards.innerHTML.indexOf('core.py') > 0, true);
check('★ 详情区的节点名是破折号（不知道，不是「dorm-a」）',
  els['detail-node'].textContent, '—');
check('★ 「开始处理」是灰的（还没有任何数据）',
  els['action-handle'].disabled, true);
check('★ 灰着的同时说了为什么', els['action-state'].textContent,
  '还没有收到 core 的快照');
check('★ 事件区写着「还没有事件」而不是空着',
  els['event-body'].innerHTML.indexOf('还没有事件') > 0, true);
check('事件条数是空的（不写「共 0 条」—— 那是另一回事）',
  els['event-count'].textContent, '');
check('导出按钮是灰的', els['export-events'].disabled, true);
check('★ 被拒绝消息那块写着「core 一条都没拒过」',
  els['reject-body'].innerHTML.indexOf('core 一条都没拒过') > 0, true);
check('消息日志一开始是空的', els['log-body'].innerHTML.indexOf('还没有收到消息') > 0, true);
check('★ 顶部横幅是平静那句，且此刻说的是「还没有收到 core 的快照」',
  els.focus.innerHTML.indexOf('还没有收到 core 的快照') > 0, true);
check('★ 3D 已经建起来了（容器 id 传对了）', sceneCalls.length, 1);
check('3D 拿到的容器是 scene3d', sceneCalls[0].hostId, 'scene3d');
check('★ 还没数据时 3D 标着「core 还没收到数据」（不是「正常」）',
  sceneCalls[0].labels[0], '当前宿舍：—（core 还没收到数据）');
check('★ 打开页面就向 report/ml_result.json 取了那一段',
  fetchCalls, ['../report/ml_result.json']);
/* 图表在启动时就建好了（两张空坐标轴），有数据才填点 ——
   这样「哪一张是哪张」在页面上是稳定的，不会因为还没数据就整块跳出来。 */
check('★ 启动时两张图就建好了（坐标轴先立着）', builtCharts.length, 2);
check('★ 但那时候一条点都没有（不画空线）',
  [builtCharts[0].data.labels, builtCharts[0].data.datasets[0].data], [[], []]);

/* 连上之后订阅哪一条 —— 这是 E3 最硬的一条要求，单独一段盯着。 */
console.log('\n=== A2. 订阅 ===');
goOnline();
check('★ 连上之后只订一条 topic', liveClient().subscribed.length, 1);
check('★★ 订的是快照那条', liveClient().subscribed[0].topic, stateTopic);
check('★★ 而且**不是**遥测的通配符 topic（E3 之前它订的就是那条）',
  liveClient().subscribed[0].topic.indexOf('telemetry'), -1);
check('订阅用的是配置里的 QoS', liveClient().subscribed[0].opts.qos, 1);
check('连上之后顶部写「已连接」', els['conn-text'].textContent, '已连接');
check('连接状态那个 class 变成 on', els.conn.className, 'conn conn--on');
check('按钮变成「断开」', els.toggle.textContent, '断开');
check('clientId 带 dormmate-dash- 前缀（现场同时开几个页面时分得清）',
  liveClient().opts.clientId.indexOf('dormmate-dash-'), 0);
check('★ 断线要自动重连（现场 wifi 抖一下不该让人手点）',
  liveClient().opts.reconnectPeriod > 0, true);

/* ---------- B. 收到一帧快照 ---------- */

console.log('\n=== B. 收到快照 ===');

feed(snapshotOf());
check('★ 三张卡片都画出来了', cardCount(), 3);
check('★ 卡片上的节点名来自快照（不是写死的三个）',
  els.cards.innerHTML.indexOf('data-node="dorm-a"') > 0
  && els.cards.innerHTML.indexOf('data-node="dorm-b"') > 0
  && els.cards.innerHTML.indexOf('data-node="dorm-c"') > 0, true);
check('卡片上有温度和湿度', /25<i class="tile-unit">℃<\/i>/.test(els.cards.innerHTML), true);
check('卡片上有状态徽章', els.cards.innerHTML.indexOf('<span>正常</span>') > 0, true);
check('★ 一个宿舍都没有时不会凭空画出三张卡（快照里几个就画几个）',
  (function () { feed(snapshotOf({ nodes: [nodeRow('dorm-x')] })); return cardCount(); })(), 1);
feed(snapshotOf());

check('详情区跟着切到第一个宿舍', els['detail-node'].textContent, 'dorm-a');
check('详情区那句话里有最新时刻和 core 手里的条数',
  els['detail-meta'].textContent,
  '最新一条 2026-09-22 20:30:00 · core 手里有这个节点的 3 条读数');
check('★ 日志里记了一行摘要', els['log-body'].innerHTML.indexOf('快照 v2 · 宿舍 3') > 0, true);
check('★ 「一条快照一行」——日志的行数就是收到的快照条数（排查时拿它对数）',
  els['log-count'].textContent, '共 ' + deliveries + ' 条');
check('★ 摘要里点名了核心的两件事（重点和事件）',
  els['log-body'].innerHTML.indexOf('重点 无') > 0
  && els['log-body'].innerHTML.indexOf('事件 0') > 0, true);

check('★★ 消息日志里记的是**快照摘要**，不是原始报文（原始报文只进 Console）',
  els['log-body'].innerHTML.indexOf('"nodes"'), -1);
check('★ Console 里有那条原始报文（排错的第一现场）',
  consoleLogs.some((l) => l.indexOf('收到 MQTT 原始消息') >= 0 && l.indexOf(stateTopic) > 0), true);

check('两张图：温度 + 湿度', builtCharts.map((c) => c.data.datasets[0].label),
  ['温度', '湿度']);
check('★ 横轴是时分秒（不是整串日期）',
  builtCharts[0].data.labels, ['20:28:00', '20:29:00', '20:30:00']);
check('★ 曲线数据来自快照里的 history（页面不再自己攒）',
  builtCharts[0].data.datasets[0].data, [25, 25, 25]);
check('湿度那张也是同一段历史',
  builtCharts[1].data.datasets[0].data, [60, 60, 60]);
check('★ 坐标轴单位是 ℃ / %',
  [builtCharts[0].options.scales.y.ticks.callback(25),
    builtCharts[1].options.scales.y.ticks.callback(60)], ['25℃', '60%']);

check('★ 3D 收到的是快照里的状态（页面不判、不复核）',
  sceneCalls[0].statuses[sceneCalls[0].statuses.length - 1], '正常');
check('★ 3D 的标签只有宿舍名（「这间怎么了」交给画面说）',
  sceneCalls[0].labels[sceneCalls[0].labels.length - 1], '当前宿舍：dorm-a');

/* ---------- C. 只认那一条 topic ---------- */

console.log('\n=== C. 只认快照那一条 topic ===');

/* 「页面没变」比的是**数据那一部分**：卡片、详情、3D。
   日志会多一行 —— 那是应该的，被忽略的消息必须留痕，不然「怎么没反应」
   这个问题的答案就只剩 Console 里才有了。 */
const before = JSON.stringify([els.cards.innerHTML, els['detail-node'].textContent,
  els['event-body'].innerHTML, sceneCalls[0].statuses.length]);
const logWarnBefore = (els['log-body'].innerHTML.match(/不是快照 topic/g) || []).length;

check('★ 遥测 topic 上的消息被拦下（返回 false）',
  context.handleMessage('dormmate/v1/nodes/dorm-a/telemetry',
    '{"nodeId":"dorm-a","temperature":40,"humidity":10,"status":"正常"}'), false);
check('★★ 而且页面数据一个字节都没变（卡片、详情、事件、3D 都没动）',
  JSON.stringify([els.cards.innerHTML, els['detail-node'].textContent,
    els['event-body'].innerHTML, sceneCalls[0].statuses.length]), before);
check('★★ 拦下的那条在日志里写了「不是快照 topic」',
  els['log-body'].innerHTML.indexOf('不是快照 topic') > 0, true);
check('★ 只多了一行（拦一条记一行，不会连锁反应）',
  (els['log-body'].innerHTML.match(/不是快照 topic/g) || []).length, logWarnBefore + 1);
check('★ 而且日志里把该订哪条写出来了（不用去翻源码）',
  els['log-body'].innerHTML.indexOf(stateTopic) > 0, true);

check('别的 topic 也一样被拦（core 的在线状态那条）',
  context.handleMessage('dormmate/v1/core/status', '{"online":true}'), false);
check('拒绝日志那条 topic 也一样', context.handleMessage('dormmate/v1/log/reject', '{}'), false);
check('★ 空 topic 也被拦', context.handleMessage('', '{}'), false);

/* ---------- D. 坏数据 ---------- */

console.log('\n=== D. 坏数据拦得住 ===');

function feedRaw(text, topic) {
  return context.handleMessage(topic || stateTopic, text);
}
check('★ 不是 JSON', feedRaw('{not json'), false);
check('日志里写了 JSON 解析失败', els['log-body'].innerHTML.indexOf('JSON 解析失败') > 0, true);
check('★ 顶层是数组', feedRaw('[]'), false);
check('日志里写了校验不通过', els['log-body'].innerHTML.indexOf('快照校验不通过') > 0, true);
check('★ 版本是 1（旧版 core 混跑）', feedRaw('{"v":1,"nodes":[]}'), false);
check('★ 日志里把版本不对写出来了',
  els['log-body'].innerHTML.indexOf('快照版本是 1') > 0, true);
check('★ 少了 reject 那一块', feedRaw(JSON.stringify(
  Object.assign(snapshotOf(), { rejects: undefined }))), false);
check('★ 没有 v 字段', feedRaw('{"nodes":[]}'), false);
check('拦下之后页面还是那一帧（没有被清空、也没有半更新）',
  [cardCount(), els['detail-node'].textContent], [3, 'dorm-a']);
check('★ 坏数据之后紧接着一帧好的，页面照常更新（前一条没留下坏状态）',
  (function () { feed(snapshotOf()); return els['log-body'].innerHTML.indexOf('快照 v2') > 0; })(), true);

/* ---------- E. 页面不修内容 ---------- */

console.log('\n=== E. 快照说什么就是什么（不修、不补、不复核）===');

feed(snapshotOf({ nodes: [nodeRow('dorm-a', { status: '台风', temperature: 99,
  humidity: -5, online: false }), nodeRow('dorm-b'), nodeRow('dorm-c')] }));
check('★★ 状态是「台风」这种没见过的词，页面照样显示（前端不认识规则）',
  els.cards.innerHTML.indexOf('<span>台风</span>') > 0, true);
check('★★ 温度 99℃、湿度 -5% 原样显示（D4 第 5 条演示的就是它）',
  [/99<i class="tile-unit">℃<\/i>/.test(els.cards.innerHTML),
    /-5<i class="tile-unit">%<\/i>/.test(els.cards.innerHTML)], [true, true]);
check('★ 认不出来的状态用中性那一档配色（不硬套成某一档状态色）',
  els.cards.innerHTML.indexOf('is-unknown') > 0, true);
check('★ 离线单独一个小标，不挤进状态徽章里',
  els.cards.innerHTML.indexOf('已离线') > 0, true);
check('★ 状态是「台风」的宿舍照样能选中（页面不为它另判一次）',
  (function () { clickCard('dorm-a'); return els['detail-node'].textContent; })(), 'dorm-a');
check('★ 3D 也照传「台风」（scene.js 认不出时会退回中性外观）',
  sceneCalls[0].statuses[sceneCalls[0].statuses.length - 1], '台风');

/* 一个宿舍还没数据时画什么 —— 「不知道」和「正常」必须看得出区别 */
feed(snapshotOf({ nodes: [nodeRow('dorm-a', { status: null, temperature: null,
  humidity: null }), nodeRow('dorm-b'), nodeRow('dorm-c')] }));
check('★ 还没数据的宿舍画的是「等待数据」', els.cards.innerHTML.indexOf('等待数据') > 0, true);
check('★ 而且写着「core 还没收到这个节点的数据」',
  els.cards.innerHTML.indexOf('core 还没收到这个节点的数据') > 0, true);
/* ★ 那一张卡上**一个数字都不许有**。写 0 是「测出来就是 0」，写 NaN 是
   「页面算崩了」，两个都在说一件没发生过的事 —— 所以连温度那一格都不画，
   换成那句话。抽出 dorm-a 那张卡单独看，免得 dorm-b / dorm-c 上的数字混进来。 */
const emptyCard = els.cards.innerHTML.split('data-node="dorm-a"')[1].split('</button>')[0];
check('★ 没有数据的卡片上不出现任何数字 / NaN / undefined',
  [/tile-value/.test(emptyCard), /NaN/.test(emptyCard), /undefined/.test(emptyCard)],
  [false, false, false]);

/* ---------- F. 跨端联动（focus） ---------- */

console.log('\n=== F. 跨端联动：focus ===');

feed(snapshotOf({ priority: { nodeId: 'dorm-b', status: '偏热', reason: '理由B' } }));
check('★ core 排出来的重点会自动被选中（不用人点）',
  els['detail-node'].textContent, 'dorm-b');
check('★ 顶栏标签是「当前重点」', els.focus.innerHTML.indexOf('当前重点') > 0, true);
check('★ 顶栏把 core 给的理由摆出来了', els.focus.innerHTML.indexOf('理由B') > 0, true);

feed(snapshotOf({ priority: { nodeId: 'dorm-b', status: '偏热', reason: '理由B' },
  focus: { nodeId: 'dorm-c', by: 'mobile', at: '2026-09-22 20:32:00' } }));
check('★★ 移动端点名 dorm-c 之后，看板跟着切过去了',
  els['detail-node'].textContent, 'dorm-c');
check('★★ 顶栏标签变成「跨端焦点」', els.focus.innerHTML.indexOf('跨端焦点') > 0, true);
check('★★ 顶栏写明了是谁发的', els.focus.innerHTML.indexOf('mobile') > 0, true);
check('★ 同时没忘了说 core 排出来的重点是谁、凭什么',
  els.focus.innerHTML.indexOf('数据选出的重点是 dorm-b') > 0, true);
check('★ 跨端这一行记进了日志（证据）',
  els['log-body'].innerHTML.indexOf('跨端焦点 → dorm-c') > 0, true);
check('★ 日志那条里写了是谁发的 focus',
  els['log-body'].innerHTML.indexOf('mobile 发的 focus') > 0, true);

/* 「焦点那一行只在变化时记」——摘要行是**每条快照都记**的（那是日志的约定），
   所以比的是「跨端焦点」这个词出现的次数。 */
const focusLogBefore = (els['log-body'].innerHTML.match(/跨端焦点 →/g) || []).length;
const allLogBefore = (els['log-body'].innerHTML.match(/log-row log-row--/g) || []).length;
feed(snapshotOf({ priority: { nodeId: 'dorm-b', status: '偏热', reason: '理由B' },
  focus: { nodeId: 'dorm-c', by: 'mobile', at: '2026-09-22 20:32:30' } }));
check('★★ 焦点没变时不再记那一行（否则会被同一句话刷屏，看不出哪次真变了）',
  (els['log-body'].innerHTML.match(/跨端焦点 →/g) || []).length, focusLogBefore);
check('★ 但摘要那一行照记（「一帧快照一行」是日志的约定）',
  (els['log-body'].innerHTML.match(/log-row log-row--/g) || []).length, allLogBefore + 1);

clickCard('dorm-a');
check('★ 可以点卡片切到别处看', els['detail-node'].textContent, 'dorm-a');
feed(snapshotOf({ priority: { nodeId: 'dorm-b', status: '偏热', reason: '理由B' },
  focus: { nodeId: 'dorm-c', by: 'mobile', at: '2026-09-22 20:32:30' } }));
check('★★ 下一条一模一样的快照不再把人拽回 dorm-c（跟过一次就算跟过了）',
  els['detail-node'].textContent, 'dorm-a');
feed(snapshotOf({ priority: { nodeId: 'dorm-b', status: '偏热', reason: '理由B' },
  focus: { nodeId: 'dorm-b', by: 'mobile' } }));
check('★ 换成另一个焦点时照样跟着切', els['detail-node'].textContent, 'dorm-b');

feed(snapshotOf({ priority: { nodeId: 'dorm-b', status: '偏热', reason: '理由B' },
  focus: null }));
check('★★ 焦点取消之后回落到 core 选出的重点',
  [els['detail-node'].textContent, els.focus.innerHTML.indexOf('当前重点') > 0],
  ['dorm-b', true]);
check('★ 取消这件事也记了一行',
  els['log-body'].innerHTML.indexOf('跨端焦点已取消') > 0, true);

/* 点东西不该往 broker 发消息 —— 看板是**看**的那一端，
   改焦点是移动端的事（两边都能改的话，两个人一起看就会互相抢）。 */
const publishedBeforeClick = liveClient().published.length;
clickCard('dorm-c');
clickBanner('dorm-a');
check('★★ 在看板上点卡片 / 点横幅，一条消息都不发',
  liveClient().published.length, publishedBeforeClick);
check('★ 点横幅等于点对应那张卡片', els['detail-node'].textContent, 'dorm-a');

/* ---------- G. 「开始处理」 ---------- */

console.log('\n=== G. 开始处理 ===');

/* 「待处理」那一档：core 开了案、还没人动过。这是唯一能按的状态。 */
const openSnapshot = busySnapshot({ events: { summary: { total: 8, OPEN: 1 },
  dropped: 0, events: [eventRow({ nodeId: 'dorm-b', state: 'OPEN' })] } });
feed(openSnapshot);
clickCard('dorm-b');
check('★ 有一条待处理的事件时按钮可以按', els['action-handle'].disabled, false);
check('★ 可以按时旁边那行是空的', els['action-state'].textContent, '');
check('★ 卡片上标出了处理到哪一步',
  els.cards.innerHTML.indexOf('card-action') > 0, true);
check('★ 而且标的是 core 事件里的状态词（待处理）',
  els.cards.innerHTML.indexOf('待处理') > 0, true);

const pubBefore = liveClient().published.length;
const cardsBefore = els.cards.innerHTML;
const eventsBefore = els['event-body'].innerHTML;
const rejectBefore = els['reject-body'].innerHTML;
const opsBefore = sceneCalls[0].ops.length;
const summaryBefore = els['log-body'].innerHTML;
clickHandle();

check('★ 按一下正好发出去一条', liveClient().published.length, pubBefore + 1);
const sent = liveClient().published[pubBefore];
check('★ 发到指令那条 topic', sent.topic, 'dormmate/v1/cmd');
check('★ payload 里是节点 + 动作 + 来源',
  JSON.parse(sent.payload), { nodeId: 'dorm-b', action: 'handle',
    source: 'dashboard', time: '2026-09-22 20:30:00' });
check('★★ payload 里**没有**任何结论性的字段（status / state / 已恢复）',
  ['status', 'state', 'result', 'recovered'].filter((k) =>
    Object.prototype.hasOwnProperty.call(JSON.parse(sent.payload), k)), []);
check('★ 带的是**快照里这个节点的最新时刻**，不是浏览器时钟',
  JSON.parse(sent.payload).time, '2026-09-22 20:30:00');
check('★ QoS 用配置里的', sent.opts.qos, 1);
check('★★ 指令**不 retained**（留下的指令会在下次起 core 时凭空推进一条事件）',
  sent.opts.retain, false);
check('★ 指令进了 Console（现场演示时能在 F12 里看见）',
  consoleLogs.some((l) => l.indexOf('发出 MQTT 指令') >= 0
    && l.indexOf('dormmate/v1/cmd') > 0), true);

/* 【这一条是整份文件里最要紧的一条】
   按下去之后，屏幕上除了那行说明，**什么都不许动**。 */
check('★★ 卡片一个字节都没变（「处理中」要等 core 发回新快照）',
  els.cards.innerHTML, cardsBefore);
check('★★ 事件表一个字节都没变', els['event-body'].innerHTML, eventsBefore);
check('★★ 被拒绝消息那块也没变', els['reject-body'].innerHTML, rejectBefore);
check('★★ 3D 一次都没重画（没有本地记账，就没有本地动画）',
  sceneCalls[0].ops.length, opsBefore);
check('★★ 消息日志也没多出一行（日志的约定是「一帧快照一行」）',
  els['log-body'].innerHTML, summaryBefore);
check('★★ 唯一变的是那行说明 —— 它说清了「好没好由 core 判」',
  els['cmd-note'].textContent,
  '已把 handle 指令发给 core —— 好没好由 core 后续收到的报文判，'
  + '这一步不结案。页面上那行「处理中」要等 core 发回新快照才会出现。');
check('★ 那行说明里没有「已恢复」（红线写在人看得见的地方）',
  els['cmd-note'].textContent.indexOf('已恢复'), -1);

/* core 把新快照发回来之后，「处理中」才出现 —— 这就是那一拍往返。 */
feed(busySnapshot({ events: { summary: { total: 8, HANDLING: 1 }, dropped: 0,
  events: [eventRow({ nodeId: 'dorm-b', state: 'HANDLING', abnormalAfter: 2,
    action: '开启风扇 / 通风', actionTime: '2026-09-22 20:31:00' })] } }));
check('★★ core 发回新快照之后，卡片上才出现「处理中」（不是点出来的）',
  els.cards.innerHTML.indexOf('处理中') > 0, true);

/* 已经在处理中的按钮是灰的 —— 再按只会多记一笔动作，core 那边用不上。 */
check('★ 已经在处理中 -> 按钮灰着', els['action-handle'].disabled, true);
check('★ 灰着的原因写清楚了（而且把「之后又收到几条异常」报出来）',
  els['action-state'].textContent.indexOf('再按一次只会多记一笔动作') > 0, true);
check('★ 那个条数来自快照里的 abnormalAfter（不是这边数的 verify 数组）',
  els['action-state'].textContent.indexOf('之后又收到 2 条异常') > 0, true);

clickCard('dorm-a');
clickCard('dorm-b');
feed(snapshotOf({ nodes: [nodeRow('dorm-a')] }));
clickCard('dorm-a');
check('★ 状态正常、也没事件 -> 灰着', els['action-handle'].disabled, true);
check('★ 那句话说的是「没有未结案的事件」',
  els['action-state'].textContent.indexOf('没有未结案的事件') > 0, true);
const pubBeforeNormal = liveClient().published.length;
clickHandle();
check('★★ 灰按钮点不动（一条消息都不发）',
  liveClient().published.length, pubBeforeNormal);

/* 离线时发不出去 —— 那行说明是唯一说得出话的地方 */
feed(openSnapshot);
clickCard('dorm-b');
liveClient().connected = false;
const pubOffline = liveClient().published.length;
clickHandle();
check('★ 没连上时不发', liveClient().published.length, pubOffline);
check('★ 而且明说没发出去 + 原因',
  els['cmd-note'].textContent.indexOf('还没连上 broker') > 0, true);
check('★★ 而且明说「这一次点击没有任何效果」（页面不替 core 记账）',
  els['cmd-note'].textContent.indexOf('没有任何效果') > 0, true);
liveClient().connected = true;

/* ---------- H. 事件表 ---------- */

console.log('\n=== H. 事件记录 ===');

feed(busySnapshot());
check('★ 事件条数读的是 core 的真总数，显示条数少了会写出来',
  els['event-count'].textContent, '共 8 条（显示最近 2 条）');
const evHtml = els['event-body'].innerHTML;
check('★★ 显示顺序是**最新在最上面**（core 给的数组是从旧到新）',
  evHtml.indexOf('dorm-b') < evHtml.indexOf('dorm-a'), true);
check('★ 每个宿舍名都出现了', [evHtml.indexOf('dorm-b') > 0,
  evHtml.indexOf('dorm-a') > 0], [true, true]);
check('★ 未结案的那条写的是 core 的状态词「处理中」',
  evHtml.indexOf('ev-result--open') > 0 && evHtml.indexOf('处理中') > 0, true);
check('★ 结过案的写的是「已恢复」', evHtml.indexOf('已恢复') > 0, true);
check('★ 处理动作那一栏是 core 记的那笔',
  evHtml.indexOf('开启风扇 / 通风') > 0, true);
check('★ 优先关注那一栏把时间 + 理由两行都摆出来',
  evHtml.indexOf('ev-reason') > 0 && evHtml.indexOf('连续异常 3 次') > 0, true);
check('★ 还没发生的格子是破折号（ev-none），不是空格',
  evHtml.indexOf('ev-none') > 0, true);
check('★ 显示条数少于总数时写明了「显示最近 N 条」',
  (function () { feed(busySnapshot({ events: { summary: { total: 500 },
    events: [eventRow({ nodeId: 'dorm-b' })] } })); return els['event-count'].textContent; })(),
  '共 500 条（显示最近 1 条）');

feed(busySnapshot());
const blobsBefore = blobs.length;
clickExport();
check('★ 点导出造了一个 Blob', blobs.length, blobsBefore + 1);
const csv = blobs[blobs.length - 1];
check('★ CSV 带 UTF-8 BOM（不带的话 Excel 里中文是乱码）',
  csv.text.charCodeAt(0), 0xFEFF);
check('★ MIME 是 text/csv + utf-8', csv.type, 'text/csv;charset=utf-8');
const csvLines = csv.text.slice(1).split('\r\n');
check('★ 表头就是那九列', csvLines[0],
  'nodeId,startTime,problem,priorityTime,priorityReason,action,actionTime,recoverTime,result');
check('★ 用 CRLF 换行 + 末尾也有一个（Excel/WPS 对 LF 不友好）',
  csv.text.slice(1).endsWith('\r\n'), true);
check('★★ 导出的行序和屏幕上一样（最新在前）',
  csvLines[1].indexOf('dorm-b') === 0, true);
check('★ 还没发生的格子导成空，不是字面的 "null"',
  csv.text.indexOf('null'), -1);
check('★ 下载用的是 download 属性（不是新开一个标签页）',
  clickedAnchors[clickedAnchors.length - 1].download, 'events.csv');
check('★ 造完的 <a> 又摘下来了（不留垃圾在 DOM 里）',
  appendedNodes.length, removedNodes.length);
check('★ objectURL 没有当场回收（当场回收会让下载点不动）',
  objectUrls.length > revokedUrls.length, true);
timers[timers.length - 1].fn();
check('★ 隔一会儿之后才回收', revokedUrls.length, 1);

/* RFC 4180 那两条：字段里出现了分隔符（半角逗号）或者双引号时，
   整格要包双引号，里面的双引号写成两个。不做的话 Excel 会把一格切成两格，
   而看的人只看到内容错位，不会想到是转义的问题。
   （全角的「，」不算分隔符，不用包 —— 那正是 core 写理由时用的那个。） */
feed(snapshotOf({ nodes: [nodeRow('dorm-a')],
  events: { summary: { total: 1, OPEN: 1 }, dropped: 0, events: [
    eventRow({ nodeId: 'dorm-a', problem: '温度偏高, 且湿度正常',
      priorityReason: '他说"热"了' })] } }));
const blobsBeforeQuote = blobs.length;
clickExport();
const quoted = blobs[blobs.length - 1].text;
check('★ 字段里有半角逗号时整格包双引号（不包的话 Excel 会把一格切成两格）',
  quoted.indexOf('"温度偏高, 且湿度正常"') > 0, true);
check('★ 字段里有双引号时写成两个（这是 CSV 的转义写法，不是打错）',
  quoted.indexOf('"他说""热""了"') > 0, true);
check('★ 那两格只包了一层，没有把整行都包起来',
  (quoted.match(/"温度偏高, 且湿度正常"/g) || []).length, 1);
feed(snapshotOf());
check('（导出按钮那两次点击各造了一个 Blob）', blobs.length, blobsBeforeQuote + 1);

feed(snapshotOf());
check('★ 一条事件都没有时导出按钮是灰的', els['export-events'].disabled, true);
check('★ 事件区写着「还没有事件」', els['event-body'].innerHTML.indexOf('还没有事件') > 0, true);

/* ---------- I. 被拒绝消息 ---------- */

console.log('\n=== I. 被拒绝消息 ===');

feed(snapshotOf({ rejects: { total: 2, kept: 2, items: [
  { time: '2026-09-22 20:28:00', topic: 'dormmate/v1/nodes/dorm-a/telemetry',
    reasons: ['JSON 解析失败'], payload: '{not json' },
  { time: '2026-09-22 20:29:00', topic: 'dormmate/v1/nodes/dorm-b/telemetry',
    reasons: ['topic 形状不对', 'nodeId 和 topic 对不上'],
    payload: '{"nodeId":"dorm-b"}' },
] } }));
const rjHtml = els['reject-body'].innerHTML;
check('★ 条数读的是 core 的真总数', els['reject-count'].textContent, '共 2 条');
check('★★ 最新那条在最上面', rjHtml.indexOf('20:29:00') < rjHtml.indexOf('20:28:00'), true);
check('★ 原文一字不差地摆出来（`{not json` 那串）',
  rjHtml.indexOf('{not json') > 0, true);
check('★ 一次给了两条原因时两条都摆出来',
  rjHtml.indexOf('topic 形状不对') > 0 && rjHtml.indexOf('nodeId 和 topic 对不上') > 0, true);
check('★ 原因是分开的小胶囊（数得清错在哪几处）', rjHtml.indexOf('rj-reason') > 0, true);
check('★ 原文用等宽字体那一档（空格和引号看得清）',
  rjHtml.indexOf('rj-payload') > 0, true);

const logBeforeNewReject = els['log-body'].innerHTML;
feed(snapshotOf({ rejects: { total: 3, kept: 3, items: [
  { time: '2026-09-22 20:31:00', topic: 'dormmate/v1/nodes/dorm-c/telemetry',
    reasons: ['湿度超出范围'], payload: '{"humidity":999}' },
] } }));
check('★ rejects 涨了就在日志里提醒一句',
  els['log-body'].innerHTML.indexOf('core 拒收了 1 条消息') > 0, true);
check('★ 提醒里带着原因，并指路到下面那块面板',
  [els['log-body'].innerHTML.indexOf('湿度超出范围') > 0,
    els['log-body'].innerHTML.indexOf('被拒绝消息') > 0], [true, true]);
check('★ 面板换成了新那一帧的内容（旧的不残留）',
  [els['reject-body'].innerHTML.indexOf('{not json'), els['reject-count'].textContent],
  [-1, '共 3 条（显示最近 1 条）']);
/* 「共 3 条（显示最近 1 条）」这个写法是故意的：core 只留最近 N 条在快照里，
   面板上摆不满的时候得说清楚**没摆的那些去哪了**，不然 3 和 1 两个数对不上，
   看的人会以为面板漏了。 */
const logAfterReject = els['log-body'].innerHTML;
feed(snapshotOf({ rejects: { total: 3, kept: 3, items: [] } }));
check('★ 条数没再涨就不重复提醒（否则每帧一句，日志没法看）',
  (els['log-body'].innerHTML.match(/core 拒收了/g) || []).length,
  (logAfterReject.match(/core 拒收了/g) || []).length);

feed(snapshotOf());
check('★ core 一条都没拒过时那句提示还在', els['reject-body'].innerHTML.indexOf('core 一条都没拒过') > 0, true);
check('★ 这时条数是空的（不是「共 0 条」）', els['reject-count'].textContent, '');

/* ---------- J. 清空 ---------- */

console.log('\n=== J. 清空 ===');

feed(busySnapshot());
const pubBeforeClear = liveClient().published.length;
clickClear();
check('★ 卡片区换成一句说明', els.cards.innerHTML.indexOf('屏幕已清空') > 0, true);
check('★ 而且那句话点明了 core 手里那份没动',
  els.cards.innerHTML.indexOf('core 手里那份数据没动') > 0, true);
check('★ 详情区回到破折号', els['detail-node'].textContent, '—');
check('★ 按钮灰了', els['action-handle'].disabled, true);
check('★ 事件表清了', els['event-body'].innerHTML.indexOf('屏幕已清空') > 0, true);
check('★ 被拒绝那块也清了', els['reject-body'].innerHTML.indexOf('屏幕已清空') > 0, true);
check('★ 消息日志清了', els['log-body'].innerHTML.indexOf('还没有收到消息') > 0, true);
check('★ 图表也清了（屏幕上不许留着已经不在快照里的数据）',
  builtCharts[0].data.datasets[0].data, []);
check('★ 3D 退回中性 + 标签清掉',
  [sceneCalls[0].statuses[sceneCalls[0].statuses.length - 1],
    sceneCalls[0].labels[sceneCalls[0].labels.length - 1]],
  ['正常', '当前宿舍：—']);
check('★ 上次念的那句话也擦了（不然看着像刚刚念的）',
  els['speak-note'].textContent, '');
check('★★ 清空**不发**任何消息（清的是屏幕，不是 core 的数据）',
  liveClient().published.length, pubBeforeClear);
feed(busySnapshot());
check('★★ 下一条快照一到画面就回来了（证明刚才清的是屏幕）',
  [cardCount(), els['detail-node'].textContent], [3, 'dorm-b']);

/* ---------- K. 3D ---------- */

console.log('\n=== K. 3D ===');

feed(snapshotOf());
const ops = sceneCalls[0].ops;
check('★ 每帧都是「先 updateScene 再 setFanOn」这个顺序（scene.js 里后调用者为准）',
  ops.indexOf('updateScene') < ops.indexOf('setFanOn') || ops.indexOf('setFanOn') === -1,
  true);
clickCard('dorm-b');
check('★ 切节点会重画场景', sceneCalls[0].statuses[sceneCalls[0].statuses.length - 1], '正常');
check('★ 标签跟着换成新宿舍', sceneCalls[0].labels[sceneCalls[0].labels.length - 1],
  '当前宿舍：dorm-b');

/* 风扇：判据是**core 记的那笔动作**，不是页面自己记的「按过没有」。
   页面这一行是在 updateScene **之后**补的一刀 —— scene.js 的 LOOK 表已经照
   status 把扇叶摆好过一次（偏热就转），页面只在「core 的事件里真有那笔 action」
   时再补一刀把它强制转起来。

   所以断言分两半：有 action 时页面确实补了这一刀；没有 action 时页面**一次都不碰**
   风扇，扇叶转不转完全交给 updateScene 按 status 管。第二半才是红线那一半 ——
   页面不能自己决定扇叶转不转。 */
const fansBeforeBusy = sceneCalls[0].fans.length;
feed(busySnapshot());
check('★★ core 的事件里有 action 时，页面把风扇补成转的（不是本地记的「按过没有」）',
  [sceneCalls[0].fans.length, sceneCalls[0].fans[sceneCalls[0].fans.length - 1]],
  [fansBeforeBusy + 1, true]);
feed(snapshotOf());
check('★ 没有 action 时页面一次都不碰风扇（交给 updateScene 按 status 摆）',
  sceneCalls[0].fans.length, fansBeforeBusy + 1);

/* 「当前重点」那圈环亮在谁身上 —— 和顶栏那条横幅必须是同一个宿舍。 */
feed(snapshotOf({ priority: { nodeId: 'dorm-b', status: '偏热', reason: 'x' } }));
check('★ 重点是 dorm-b 时，环亮着（横幅也说的它）',
  [els.focus.innerHTML.indexOf('dorm-b') > 0,
    sceneCalls[0].focus[sceneCalls[0].focus.length - 1]], [true, true]);
clickCard('dorm-a');
check('★ 看别的宿舍时环灭（省得以为那间才是重点）',
  sceneCalls[0].focus[sceneCalls[0].focus.length - 1], false);
feed(snapshotOf());
check('★ 谁也不重点时环也是灭的',
  sceneCalls[0].focus[sceneCalls[0].focus.length - 1], false);

/* ---------- L. 语音 ---------- */

console.log('\n=== L. 语音提醒 ===');

feed(busySnapshot());
const logLen = speechLog.length;
clickSpeak();
check('★ 先 cancel 再 speak（不 cancel 的话连点两次第二句要排队等第一句念完）',
  speechLog.slice(logLen), ['cancel', 'speak']);
check('★ 念的是最新那一帧算出来的话（不是缓存的上一次）',
  spoken[spoken.length - 1].text,
  'dorm-b 偏热已持续 20 分钟（已按下开始处理，处理中），温度正在下降。');
check('★ 语言设成 zh-CN', spoken[spoken.length - 1].lang, 'zh-CN');
check('★ 念的是人话（没有 ｜ 那种只给眼睛看的符号）',
  spoken[spoken.length - 1].text.indexOf('｜'), -1);
check('★ 按钮下面那行写了正在念什么（声音放不出来时这是唯一的凭据）',
  els['speak-note'].textContent.indexOf('正在朗读：') === 0, true);

spoken[spoken.length - 1].onerror({ error: 'not-allowed' });
check('★ 念失败时把**原始错误码**贴出来（解释文案可能对不上，错误码不会骗人）',
  els['speak-note'].textContent.indexOf('not-allowed') > 0, true);
check('★ 失败时也把本该念的那句留着（能自己读一眼）',
  els['speak-note'].textContent.indexOf('dorm-b 偏热') > 0, true);

feed(snapshotOf());
clickSpeak();
check('★ 平静时念的是那句平静话', spoken[spoken.length - 1].text, '当前 3 个宿舍都正常。');

/* 浏览器不支持语音合成时的降级 —— 按钮不能点了没反应。 */
const savedSpeech = context.speechSynthesis;
const savedUtterance = context.SpeechSynthesisUtterance;
delete context.speechSynthesis;
delete context.SpeechSynthesisUtterance;
clickSpeak();
check('★ 不支持时明说「不支持」并把它本该念的写出来',
  [els['speak-note'].textContent.indexOf('这个浏览器不支持语音合成') === 0,
    els['speak-note'].textContent.indexOf('当前 3 个宿舍都正常。') > 0], [true, true]);
context.speechSynthesis = savedSpeech;
context.SpeechSynthesisUtterance = savedUtterance;

/* ---------- M. 连接开关 ---------- */

console.log('\n=== M. 连接 / 断开 ===');

clickToggle();
check('★ 点「断开」会强制断开（不再自动重连）', liveClient().ended, true);
check('★ 而且是 force 断开（不强断的话会自己爬回来，看着像点不动）',
  liveClient().endForce, true);
check('★ 顶部写「未连接」', els['conn-text'].textContent, '未连接');
check('★ 按钮变回「连接」', els.toggle.textContent, '连接');
const clientsBefore = mqttStub.clients.length;
clickToggle();
check('★ 点「连接」会新开一根（不是复用断开的那根）',
  mqttStub.clients.length, clientsBefore + 1);
goOnline();
check('★ 新那根也订的是快照那条',
  [liveClient().subscribed.length, liveClient().subscribed[0].topic], [1, stateTopic]);
feed(busySnapshot());
check('★ 重连之后数据照常进来', cardCount(), 3);

/* ---------- N. ML 那一段 ---------- */

console.log('\n=== N. Rule-ML 预留展示区 ===');

check('★ fetch 的路径是相对本页面算的（页面在 dashboard/ 下）',
  fetchCalls[0], '../report/ml_result.json');
/* 这一刻 fetch 还没回来（下面的 await settle 才放行），所以页面上必须是
   index.html 里那句占位 —— 空着的话看起来跟「这一段本来就没有内容」一样。 */
check('★ 读回来之前页面上是占位那句话（不是空白）',
  els['ml-text'].textContent, '正在读取 report/ml_result.json …');

/* 放行第一个 fetch：正常情况下摆什么 */
fetchPending[0].resolve({
  ok: true,
  status: 200,
  json: () => Promise.resolve({
    text: '规则和 ML 在这份数据上大体一致，只有少数几条对不上。',
    mismatchForward: 2, mismatchReverse: 1,
    generatedAt: '2026-09-22 21:00:00',
    newFile: 'data/sim_log.csv', newRows: 300,
    historyFile: 'data/history.csv', historyRows: 1200,
  }),
});
await settle();
check('★ 条数摆出来了（两个方向分开报）', els['ml-count'].textContent,
  '规则说正常、ML 说不同：2 条；规则说异常、ML 说正常：1 条');
check('★ 结论那句是从那份 JSON 里原样搬的', els['ml-text'].textContent,
  '规则和 ML 在这份数据上大体一致，只有少数几条对不上。');
check('★★ 说明里点明了「判的不是看板上这些实时读数」',
  els['ml-note'].textContent.indexOf('判的不是看板上这些实时读数') > 0, true);
check('★★ 而且点明了「不是实时数据」',
  els['ml-note'].textContent.indexOf('不是实时数据') > 0, true);
check('★ 说明里写了是哪份文件、多少条、什么时候跑的',
  [els['ml-note'].textContent.indexOf('sim_log.csv') > 0,
    els['ml-note'].textContent.indexOf('300 条') > 0,
    els['ml-note'].textContent.indexOf('2026-09-22 21:00:00') > 0], [true, true, true]);

/* 第二个 fetch：404 时降级。重开一个页面太麻烦，直接点一次连接再走一遍不够 ——
   所以这里验的是「读不到会降级」那套话术本身在页面上的落点：
   用 loadMlResult 的第二条路径（放行成一个 404）来测。 */
check('★ 读不到时页面上那段会降级成一句「这一段没跑」',
  context.mlFetchFailed('HTTP 404').text.indexOf('这一段没跑：读不到') === 0, true);
check('★ 降级时条数那栏是空的（不是 0）', context.mlFetchFailed('HTTP 404').count, '');
check('★ 降级时告诉人怎么补（跑一次 analysis.py）',
  context.mlFetchFailed('HTTP 404').note.indexOf('analysis/analysis.py') > 0, true);
check('★ 原因原样贴出来（HTTP 404 和「回来不是 JSON」指向不同的排查方向）',
  context.mlFetchFailed('Unexpected token < in JSON at position 0').text
    .indexOf('Unexpected token <') > 0, true);

/* ---------- O. 静态断言（源码里那几件必须成立的事） ---------- */

console.log('\n=== O. 源码里的硬约定 ===');

check('★ dashboard.js 正好两条 import', importCount, 2);
check('★★ 它 import 的是 ../3d/scene.js 和 ./logic.js（没有第三条）',
  [SCENE_IMPORT.test(dashText), LOGIC_IMPORT.test(dashText)], [true, true]);

/* import 进来的名字必须真的在 logic.js 里导出 —— 少一个的话页面整块
   「is not a function」，而那是运行到那一行才炸。 */
const logicExports = (fs.readFileSync(LOGIC_SRC, 'utf8')
  .match(/^export\s+(?:function|const|let)\s+(\w+)/gm) || [])
  .map((l) => l.replace(/^export\s+(?:function|const|let)\s+/, ''));
const importedNames = (dashText.match(/^import\s*\{([^{}]*)\}\s*from\s*'\.\/logic\.js';/m) || [])[1]
  .split(',').map((s) => s.trim()).filter(Boolean);
check('★ 从 logic.js 引了十二个名字', importedNames.length, 12);
check('★★ 这十二个每一个都在 logic.js 的导出清单里',
  importedNames.filter((n) => logicExports.indexOf(n) < 0), []);

/* 【不许自己实现业务判断】这一条查的是**源码文本**：阈值、状态名一旦出现，
   就说明判断又溜回前端了。 */

/* 注释里当然可以出现「偏热」「18℃」这类字眼（那是在解释规则），所以先摘注释。 */
const dashCode = dashText
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/* 阈值的查法不是「文件里不许出现 18 / 30 / 75」—— 那个写法会撞上两处
   跟判断毫无关系的数字：太阳图标的 SVG 路径里有一串小数（含 10.18），
   还有连 broker 用的 keepalive: 30。把它们一条条剔掉要写一堆正则，
   而真正想拦的东西很集中：**读数和数字之间的比较**。下面这两条盯的就是这个位置。 */
const THRESHOLD_CMP =
  /(?:<|>|<=|>=|===|==|!==|!=)\s*(?:18|30|75)\b|\b(?:18|30|75)\s*[<>]/;
check('★★ dashboard.js 里没有读数阈值（18 / 30 / 75 不参与任何比较）',
  THRESHOLD_CMP.test(dashCode), false);
check('★★ 湿度那个 75 干脆整份源码里都没出现', /\b75\b/.test(dashCode), false);

/* 这几个状态名在这个文件里**只允许出现在那张渲染表里** —— STATUS_VIEW 干的
   是「偏冷 -> 一个颜色、一个图标」，那是画，不是判。把那张表摘掉之后这些词
   还出现，就说明判断溜回来了。 */
const noStyleMap = dashCode.replace(/const STATUS_VIEW = \{[\s\S]*?\n\};/, '');
check('★★ 状态名只出现在渲染表里，别处一个都没有（状态只从快照里读）',
  /偏冷|偏热|偏湿/.test(noStyleMap), false);
check('★★ 不再引 shared/rules.js（页面不再复核状态）',
  dashText.indexOf('rules.js'), -1);
check('★★ 源码里不出现 judgeStatus', dashCode.indexOf('judgeStatus'), -1);
check('★★ 不出现 telemetry（它不订遥测了）',
  dashCode.indexOf('telemetry'), -1);
check('★★ topic 和地址都从 CFG 里取（没有第二份写死的）',
  dashCode.indexOf('9001'), -1);
check('★ 来源标记是 dashboard（core 的日志里分得清是谁按的）',
  dashCode.indexOf("SOURCE_DASHBOARD = 'dashboard'") > 0, true);

/* ---------- P. index.html ---------- */

console.log('\n=== P. index.html ===');

const html = fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf8');
/* 这个页面的注释写得很密，而且**注释里会引原文**（比如「以前这里写的是
   <script src="../shared/rules.js">」）。凡是查「这一页引了什么」的断言，
   都得先把注释摘掉再查，不然拦下来的是自己写的那句说明。 */
const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
check('★★ 引了 shared/config.js（三个前端共用那一份）',
  htmlNoComments.indexOf('src="../shared/config.js"') > 0, true);
/* 查的是**标签**而不是那几个字：文件里有好几处注释在解释「以前这里引的是
   shared/rules.js，现在不引了」，直接搜字符串会撞上那些说明。 */
check('★★ 不再引 shared/rules.js', /<script[^>]*shared\/rules\.js/.test(htmlNoComments), false);
check('★★ 「模拟三节点数据」那个按钮已经删掉了（E3 禁止自己造数据伪造同步）',
  html.indexOf('simulate'), -1);
check('★ 按钮叫「开始处理」，id 是 action-handle',
  /id="action-handle"[^>]*>开始处理</.test(html), true);
check('★ 有被拒绝消息那块面板的容器',
  [html.indexOf('id="reject-body"') > 0, html.indexOf('id="reject-count"') > 0],
  [true, true]);
check('★ 那一块的四列是 时间 / Topic / 原因 / 原文',
  /<th>时间<\/th>\s*<th>Topic<\/th>\s*<th>原因<\/th>\s*<th>原文<\/th>/.test(html), true);
check('★ 页头写明了它只订 dormmate/v1/state',
  html.indexOf('只订阅 <code>dormmate/v1/state</code>') > 0, true);
/* 只看页脚那一段。上面有一条注释专门在解释「以前那句『一律用规则复核』
   现在是错的」，搜整份文件的话会被那条注释挡下来。 */
const footer = (html.match(/<footer[\s\S]*?<\/footer>/) || [''])[0];
check('★ 页脚不再宣称「一律用规则复核」（那句话现在是错的）',
  footer.indexOf('一律用规则复核'), -1);
check('★ 页脚改成了「由 core 执行、页面只负责画」',
  [footer.indexOf('core/rules.py') > 0, footer.indexOf('页面只负责画') > 0], [true, true]);
check('★ config.js 排在模块脚本之前（模块要用到那个全局）',
  htmlNoComments.indexOf('../shared/config.js') < htmlNoComments.indexOf('type="module"'), true);
check('★ importmap 排在模块脚本之前（排在后面浏览器不认）',
  htmlNoComments.indexOf('importmap') < htmlNoComments.indexOf('type="module"'), true);
check('★ 那两张图的 canvas 还在（Chart.js 要靠它）',
  [html.indexOf('id="chart-temp"') > 0, html.indexOf('id="chart-humidity"') > 0],
  [true, true]);
check('★ ML 那一块的位置留着（Rule-ML 预留展示区）',
  [html.indexOf('id="ml-count"') > 0, html.indexOf('id="ml-text"') > 0,
    html.indexOf('id="ml-note"') > 0], [true, true, true]);
check('★ 3D 那个容器还在', html.indexOf('id="scene3d"') > 0, true);

/* 页面的每个 id 都得在测试的登记表里 —— 漏一个就会假绿，
   这条断言是给**测试自己**的护栏。 */
const idList = (html.match(/id="([\w-]+)"/g) || [])
  .map((s) => s.slice(4, -1));
check('★ index.html 里那些 id 测试全都登记了（漏了就是假绿）',
  idList.filter((id) => !Object.prototype.hasOwnProperty.call(els, id)), []);
check('★ 而且登记的那些一个不多（多出来的是已经不存在的元素）',
  Object.keys(els).filter((id) => idList.indexOf(id) < 0), []);

/* 送进来的消息条数 —— 用来确认整份测试真的走了几百次投递，
   而不是某一段静悄悄跳过了。 */
check('★ 这一整轮确实投递了消息（不是空跑）', deliveries > 10, true);

console.log(`\n结果：${pass} 通过，${fail} 不通过`);
process.exit(fail === 0 ? 0 : 1);

}()).catch((err) => {
  console.error(err);
  process.exit(1);
});
