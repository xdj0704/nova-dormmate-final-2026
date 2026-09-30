// tests/mobile.test.js
// 校验 mobile/mobile.js —— 移动端 H5 的唯一消息入口 handleMessage，
// 以及 Step E3-3 那两条「手机才会发」的指令。
//
// 重点盯六件事：
//   1) **只订一条 topic**。除了 dormmate/v1/state 什么都不订，别的一律忽略，
//      而且忽略之后页面一个字节都不能变。遥测 topic 尤其要拦。
//   2) **不做业务计算**。状态是「台风」也照显示，温度是 99 也照显示。
//      这个文件里一个阈值、一个状态词都不许有（下面那条断言是「剥掉注释之后
//      仍然一个都没有」—— 注释里说说可以，代码里出现就说明有人开始判了）。
//   3) **点一下什么都不变**。点宿舍行发的是 focus，点开始处理发的是 handle，
//      两条都不会就地改屏幕上任何一个字 —— 焦点归 core 说了算，
//      处理状态也归 core 说了算。这是 E3 那两条红线在移动端的表达。
//   4) focus 报文**只发事实**：{nodeId, action:'focus', source:'mobile'}，
//      没有 time、没有 status、没有任何「已恢复」。同一个宿舍点两下就发两条 ——
//      「再点一下是取消」是 core 的规矩，这边不自己判。
//   5) handle 报文带的是**最新快照里这个节点的时刻**，不是手机时钟。
//   6) 和看板**共用同一份 logic.js**，不是第二份实现。
//
// 做法是把 DOM / mqtt 打上桩，用 vm 把 shared/config.js、dashboard/logic.js
// （真文件）、mobile/mobile.js 依次跑起来。不是静态检查，是让它真的执行一遍。
//
// 跑法：node tests/mobile.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CONFIG_SRC = path.join(ROOT, 'shared', 'config.js');
const LOGIC_SRC = path.join(ROOT, 'dashboard', 'logic.js');
const MOB_SRC = path.join(ROOT, 'mobile', 'mobile.js');
const MOB_HTML = path.join(ROOT, 'mobile', 'index.html');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? `  =>  ${a}` : `\n        实际: ${a}\n        期望: ${e}`));
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

/* ---------- DOM 打桩 ---------- */

function makeEl(id) {
  const classes = new Set();
  return {
    id, textContent: '', innerHTML: '', dataset: {}, disabled: false, className: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    _classes: classes,
    _handlers: {},
    addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
  };
}

const els = {};
/* 这份清单就是 mobile/index.html 里那些 id。**一个都不能漏**：
   getElementById 对没登记的 id 会现场造一个新的，那样测试读到的
   els['nodes'] 和 mobile.js 里 el.nodes 拿到的就不是同一个对象，
   断言全是假绿 —— 页面上明明没变，测试却看见变了。 */
['app', 'conn', 'conn-text', 'focus', 'nodes', 'node-count',
  'action-handle', 'action-state', 'cmd-note', 'log-body', 'log-count',
  'never-used'].forEach((id) => { els[id] = makeEl(id); });

const documentStub = {
  getElementById: (id) => els[id],
  addEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
};

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
         不然 sendFocus / sendHandle 会一直走「没连上」那条分支。 */
      connected: false,
      published: [],
      on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return c; },
      subscribe(topic, o, cb) { c.subscribed.push({ topic, opts: o }); if (cb) cb(null); return c; },
      publish(topic, payload, opts) { c.published.push({ topic, payload, opts }); return c; },
      end(force) { c.ended = true; c.endForce = force; return c; },
    };
    mqttStub.clients.push(c);
    return c;
  },
};

/* ---------- console 打桩 ---------- */
/* mobile.js 每条原始报文都往 Console 打一行，发出去的指令也打一行。
   测试里那会是几百行噪音；「发出去的那条 payload 到底是什么」也在里面。 */
const consoleLogs = [];
const consoleStub = {
  log: (...args) => { consoleLogs.push(args.map(String).join(' ')); },
  warn: (...args) => { consoleLogs.push('WARN ' + args.map(String).join(' ')); },
  error: (...args) => { consoleLogs.push('ERROR ' + args.map(String).join(' ')); },
};

/* ---------- 上下文 ---------- */
/* ★ window 就指向上下文自己。真浏览器里 window === globalThis，
   shared/config.js 挂的是 globalThis（见那个文件最后一行），
   mobile.js 读的是 window.DormMateConfig —— 只有把这两个当成同一个东西，
   才和浏览器里的行为一致。分成两个对象的话，config.js 挂到 A、
   mobile.js 读 B，页面上永远是「未加载 shared/config.js」。 */
const context = {
  document: documentStub,
  mqtt: mqttStub,
  location: { hostname: 'localhost' },
  console: consoleStub,
  JSON, Math, Date, Number, Object, Array, String, Boolean,
  isNaN, parseInt, RegExp, TypeError, undefined,
};
context.globalThis = context;
context.window = context;

vm.createContext(context);

/* ---------- 依次加载三个真文件 ---------- */

/* 1) shared/config.js —— 普通 script，原样跑 */
vm.runInContext(fs.readFileSync(CONFIG_SRC, 'utf8'), context, { filename: CONFIG_SRC });

/* 2) dashboard/logic.js —— 真文件（不打桩）。
      「一个结论都不下」正是这一步的全部内容，打个桩等于把要测的东西测没了。
      它是 ES 模块，把 `export ` 前缀摘掉就行：顶层 function 声明在 vm 里
      就是上下文的全局属性，后面 mobile.js 调到的就是这里定义的那一个。
      顺带一个副作用是好事：logic.js 和 mobile.js 的顶层名字撞了的话，
      这里会当场抛「Identifier 'x' has already been declared」。 */
const logicText = fs.readFileSync(LOGIC_SRC, 'utf8');
vm.runInContext(logicText.replace(/^export\s+/gm, ''), context, { filename: LOGIC_SRC });

/* 3) mobile/mobile.js —— 摘掉那一条 import。
      它是 ES 模块，而 vm.runInContext 只能跑普通脚本，原样喂进去会抛
      「Cannot use import statement outside a module」。摘之前先数一遍，
      必须正好一条；将来谁再加一条 import，这里立刻炸出来，
      而不是把那条也悄悄摘了、测了个假的。 */
const mobText = fs.readFileSync(MOB_SRC, 'utf8');
const importCount = (mobText.match(/^import\s/gm) || []).length;
if (importCount !== 1) {
  throw new Error('mobile.js 里应该只有一条 import，实际 ' + importCount + ' 条 —— '
    + '下面那个正则摘不干净，vm 会抛语法错。');
}

/* 这条 import 折成了两行，所以分隔符一律写 \s —— 它能匹配换行。
   写成字面空格的话摘不掉，下一句 vm 会抛「Cannot use import statement
   outside a module」。
   名字那一段必须用 [^{}]* 而不是 [\s\S]*?：那是为了让正则老老实实停在这一对
   花括号里，不会从**上面或下面**某个花括号起头一路吞到别处。 */
const LOGIC_IMPORT = /^import\s*\{[^{}]*\}\s*from\s*'\.\.\/dashboard\/logic\.js';\s*$/m;
if (!LOGIC_IMPORT.test(mobText)) {
  throw new Error('没找到指向 ../dashboard/logic.js 的那条 import —— '
    + '这条路径是「两个页面共用同一份判断」的全部证据，找不到它这个测试就没意义了。');
}

const src = mobText.replace(LOGIC_IMPORT,
  '/* import 已摘除：上面已经把真 logic.js 的函数放进上下文了 */\n');
if (/^import\s/m.test(src)) throw new Error('还有 import 没摘掉，vm 会抛语法错');

vm.runInContext(src, context, { filename: MOB_SRC });

/* 脚本一跑完，启动那一屏就已经画好了（文件末尾那串 renderAll() 是同步的）。
   **趁一帧快照都还没喂的时候把它抄下来** —— 这是「打开页面但 core 没起」
   那一屏，也是唯一能验它的时候：后面所有断言都在喂过数据之后了。
   抄的是那一刻的**字面**，不是「函数应该会输出什么」。 */
const BOOT = {
  focus: els.focus.innerHTML,
  nodes: els.nodes.innerHTML,
  nodeCount: els['node-count'].textContent,
  actionDisabled: els['action-handle'].disabled,
  actionState: els['action-state'].textContent,
  log: els['log-body'].innerHTML,
  connText: els['conn-text'].textContent,
  /* 状态是挂在 dataset 上的（不是 innerHTML 里的属性）—— 打桩的 dataset 是个
     普通对象，写进去不会出现在 innerHTML 里，所以单独抄一份。 */
  focusStatus: els.focus.dataset.status,
};

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
    problem: '偏热',
    priorityTime: '2026-09-22 20:28:00',
    priorityReason: '连续 3 条异常，时长最长',
    action: null,
    actionTime: null,
    actionSource: null,
    recoverTime: null,
    endTime: null,
    result: '',
    abnormalAfter: 0,
    verifyCount: 0,
  };
  Object.keys(over || {}).forEach(function (k) { e[k] = over[k]; });
  return e;
}

function eventBlock(list) {
  const events = list || [];
  const summary = { OPEN: 0, HANDLING: 0, RECOVERED: 0, UNRESOLVED: 0, total: events.length, dropped: 0 };
  events.forEach(function (e) { summary[e.state] = (summary[e.state] || 0) + 1; });
  return { summary: summary, dropped: 0, events: events };
}

/* 一份**形状和 core 发的一模一样**的快照（字段名照着 core.py 的 snapshot()
   和 events.py 的 view() 抄）。fixture 和真报文对不上的话，测的是
   「我以为 core 发什么」，不是「core 发什么」。 */
function snapshotOf(over) {
  const s = {
    v: 2,
    time: '2026-09-22 20:30:00',
    focus: null,
    priority: null,
    nodes: [
      nodeRow('dorm-a', { temperature: 25, humidity: 60, status: '正常' }),
      nodeRow('dorm-b', { temperature: 31, humidity: 60, status: '偏热' }),
      nodeRow('dorm-c', { temperature: 25, humidity: 80, status: '偏湿' }),
    ],
    events: eventBlock([]),
    rejects: { total: 0, kept: 0, items: [] },
    counters: {
      received: 9, rejected: 0, statusMismatch: 0,
      retainedCleared: 0, commands: 0, commandRejected: 0,
    },
  };
  Object.keys(over || {}).forEach(function (k) { s[k] = over[k]; });
  return s;
}

function feed(snapshot) {
  return context.handleMessage(context.DormMateConfig.STATE_TOPIC, JSON.stringify(snapshot));
}

function liveClient() { return mqttStub.clients[mqttStub.clients.length - 1]; }

/* 触发委托在 #app 上的那次点击。真浏览器里 e.target 是被点到的那个元素，
   而处理函数要往上找 data-focus-node —— 这里给的就是那个「已经找到的」
   结果，形状和 closest() 的返回值一样。 */
function tapNode(nodeId) {
  const evt = {
    target: {
      closest: (sel) => (sel === '[data-focus-node]' ? { dataset: { node: nodeId } } : null),
    },
  };
  els['app']._handlers.click[0](evt);
}

function tapHandle() {
  els['action-handle']._handlers.click[0]({});
}

const CFG = context.DormMateConfig;
const STATE = CFG.STATE_TOPIC;

/* ============ A. 挂上了、连上了、只订一条 ============ */

section('A. 加载与订阅');

check('★ 消息入口挂出来了（顶层函数在 vm 里就是上下文属性）', typeof context.handleMessage, 'function');
check('★ 打开页面就建了一根连接', mqttStub.clients.length, 1);
check('★ clientId 带 dormmate-mobile- 前缀（和看板、3D 分得清）',
  liveClient().opts.clientId.indexOf('dormmate-mobile-'), 0);
check('★ 连的是 config.js 拼出来的地址', liveClient().url, CFG.brokerUrlFor());
check('★ 没连上时状态是「连接中…」', els['conn-text'].textContent, '连接中…');
check('（class 也跟着走，不是写死的）', els['conn'].className, 'conn conn--pending');

/* 握手：真 mqtt.js 连上时会回调 connect，订阅发生在那一拍 */
liveClient().connected = true;
liveClient().handlers.connect[0]();
check('★ 连上之后只订阅了一条 topic', liveClient().subscribed.length, 1);
check('★ 而且订的就是快照那条', liveClient().subscribed[0].topic, STATE);
check('★ 遥测通配符一条都不订（订了就又要自己算一遍）',
  liveClient().subscribed.some((s) => s.topic === CFG.TOPIC_PATTERN), false);
check('★ qos 用的是配置里那个', liveClient().subscribed[0].opts.qos, CFG.QOS);
check('连上之后状态文字跟着变', els['conn-text'].textContent, '已连接');

/* ============ B. 只认快照那一条 topic ============ */

section('B. 只认 dormmate/v1/state');

const beforeB = { focus: els.focus.innerHTML, nodes: els.nodes.innerHTML };
check('★ 遥测 topic 上的一条合法报文被拦下',
  context.handleMessage(CFG.topicFor('dorm-a'), JSON.stringify(snapshotOf())), false);
check('core/status 那条也一样', context.handleMessage('dormmate/v1/core/status', '{"online":true}'), false);
check('空 topic 也被拦', context.handleMessage('', '{}'), false);
check('★ 拦下之后页面一个字节都没变',
  [els.focus.innerHTML === beforeB.focus, els.nodes.innerHTML === beforeB.nodes], [true, true]);

check('坏 JSON 被拦', context.handleMessage(STATE, '{ 这不是 json'), false);
check('★ 日志里写的是 JSON 解析失败，不是「没收到」',
  els['log-body'].innerHTML.indexOf('JSON 解析失败') > 0, true);

check('版本不对被拦', context.handleMessage(STATE, JSON.stringify(snapshotOf({ v: 1 }))), false);
check('★ 原因里指出了版本号（不然「页面没反应」查不下去）',
  els['log-body'].innerHTML.indexOf('快照版本是 1') > 0, true);

check('少了一块也被拦（rejects）',
  context.handleMessage(STATE, JSON.stringify((function () {
    const s = snapshotOf(); delete s.rejects; return s;
  })())), false);

check('★ 一份形状正确的快照被收下', feed(snapshotOf()), true);

/* ============ C. 只渲染，不算 ============ */

section('C. 快照说什么就显示什么');

check('★ 三个宿舍都画出来了（一个节点名都没写死）',
  ['dorm-a', 'dorm-b', 'dorm-c'].every((n) => els.nodes.innerHTML.indexOf('data-focus-node="' + n + '"') >= 0), true);
check('★ 状态是快照里那个字，原样显示', els.nodes.innerHTML.indexOf('>偏热<') >= 0, true);
check('★ 温度和湿度也都来自快照', els.nodes.innerHTML.indexOf('31℃') >= 0, true);
check('★ 列表条数写在标题旁边', els['node-count'].textContent, '3 个');

/* 认不出来的状态照显示 —— 页面不修不补也不复核。 */
feed(snapshotOf({
  nodes: [nodeRow('dorm-a', { status: '台风', temperature: 99, humidity: 99 })],
}));
check('★ 不认识的状态原样显示（页面不替 core 改）',
  els.nodes.innerHTML.indexOf('>台风<') >= 0, true);
check('★ 离谱的读数也照显示（99℃ 不在页面这一层拦）',
  els.nodes.innerHTML.indexOf('99℃') >= 0, true);
check('★ 也不认识那个状态 —— 落到中性色那一档（属性里没有匹配的值）',
  els.nodes.innerHTML.indexOf('data-status="台风"') >= 0, true);

/* 没有 status 的节点（core 还没收到过这个宿舍的数据）:显示 —，不是「正常」 */
feed(snapshotOf({
  nodes: [nodeRow('dorm-a', { status: null, temperature: null, humidity: null, time: null })],
}));
check('★ 没有数据时显示 —，不是「正常」',
  els.nodes.innerHTML.indexOf('>—<') >= 0, true);
check('★ 一个宿舍都没有时也不装作有', (function () {
  feed(snapshotOf({ nodes: [] }));
  return els['node-count'].textContent;
})(), '');
check('（那种情况下写的是「还没有收到快照」，不是「都正常」）',
  els.nodes.innerHTML.indexOf('还没有收到 core 的快照') > 0, true);

/* ============ D. 这个文件里没有第二份规则 ============ */

section('D. 没有第二份规则');

/* 注释里说说没关系（这个文件的注释里到处都在解释那四条规则是什么），
   代码里出现就是有人开始判了。所以先把块注释和整行 // 注释剥掉。 */
const mobCode = mobText
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');

check('★ 剥注释这一步真的剥掉了东西（否则下面的断言是空对空）',
  mobCode.length < mobText.length, true);
check('★ 没有四个状态词（一个都没有，「正常」也不行）',
  /正常|偏冷|偏热|偏湿/.test(mobCode), false);
/* 阈值那一条查的是**形状**（比较运算符挨着 18/30/75），不是「文件里出现这三个数」：
   `const LOG_MAX = 30` 是日志留多少行，跟温度没关系，光看数字会把它误伤成
   「这里在判温度」（`pad2` 里的 `n < 10` 也会被误伤）。真正要挡的是
   `t < 18` 那种写法 —— 这里一个都不许有。 */
check('★ 没有比较运算符配阈值那种判断（要判温度就长这个形状）',
  /(?:<|>|<=|>=|===|==|!==|!=)\s*(?:18|30|75)\b|\b(?:18|30|75)\s*[<>]/.test(mobCode), false);
/* 上面那条只查形状，所以再补一条更死的：这三个数在这个文件里**只出现在两行**，
   而且两行都不是温度 —— 一行是日志留多少条，一行是 MQTT 心跳多少秒。
   （把期望写成一份**清单**而不是「0 处」是有意的：清单红了的时候，
   实际值里会带着那几行原文，一眼看得出新加的那处是干嘛的。
   写成「不许出现」的话，改日志上限这种无关的事也会红，而那种红只会教人
   把断言删掉。）将来谁悄悄加一句 `if (t > 30)`，这里立刻多出一行。 */
check('★ 18/30/75 只出现在日志上限和 MQTT 心跳那两行（都不是温度）',
  mobCode.split('\n').map((l) => l.trim()).filter((l) => /\b(?:18|30|75)\b/.test(l)),
  ['const LOG_MAX = 30;', 'keepalive: 30,']);
check('★ 没有写死的节点名',
  /dorm-[abc]/.test(mobCode), false);
check('★ 没有 NODE_IDS 那种白名单', /NODE_IDS/.test(mobCode), false);
check('★ 没有自己再实现一遍读快照 / 拼横幅',
  /function\s+(readSnapshot|focusBanner|actionState|handlingOf|snapshotSummary)\b/.test(mobCode), false);
check('★ 没有本地存储（存一份状态就等着和 core 不一样）',
  /localStorage|sessionStorage/.test(mobCode), false);

/* 复用的是看板那一份，不是第二份实现 —— 这是上面那些断言成立的前提。
   「真的共用」不能光看那条 import 写得对不对（写对路径、import 一个不存在的
   名字，页面照样跑不起来但测试看不出来），所以逐个名字回到 logic.js 里查
   它**确实导出了**那几个函数。名字抄错一个（比如把 handlingOf 写成 handleOf）
   在这里就红，而不是等到手机上大卡片一片空白。 */
check('★ 真的 import 了看板的 logic.js', /from\s*'\.\.\/dashboard\/logic\.js'/.test(mobText), true);
{
  const imported = (mobText.match(/^import\s*\{([^{}]*)\}\s*from\s*'\.\.\/dashboard\/logic\.js'/m) || [])[1] || '';
  const names = imported.split(',').map((s) => s.trim()).filter(Boolean);
  check('★ import 的名字都是 logic.js 真的导出了的',
    names.filter((n) => !new RegExp('^export\\s+function\\s+' + n + '\\b', 'm').test(logicText)), []);
  check('★ 而且用到的每一个都是这么来的（上下文里那七个都在）',
    names.filter((n) => typeof context[n] !== 'function'), []);
  check('（顺带确认名字不是空对空 —— 至少 import 了五个）', names.length >= 5, true);
}

/* ============ E. focus：手机才发的那条指令 ============ */

section('E. 点一下宿舍 = 发一条 focus');

/* 先回到一份「有重点」的快照：dorm-b 偏热，core 排出来的重点就是它 */
feed(snapshotOf({
  nodes: [
    nodeRow('dorm-a'),
    nodeRow('dorm-b', { temperature: 31, status: '偏热', abnormalCount: 3, durationSec: 600, durationText: '10 分钟', reason: '连续 3 条异常，时长最长' }),
    nodeRow('dorm-c'),
  ],
  priority: { nodeId: 'dorm-b', status: '偏热', severity: 3, abnormalCount: 3, durationSec: 600, durationText: '10 分钟', reason: '连续 3 条异常，时长最长' },
}));

check('★ 大卡片说的是 core 排出来的重点（标签是「当前重点」）',
  [els.focus.innerHTML.indexOf('当前重点') > 0, els.focus.innerHTML.indexOf('dorm-b') > 0], [true, true]);
check('★ 那张卡片自己带 data-focus-node（点它也能切焦点）',
  els.focus.innerHTML.indexOf('data-focus-node="dorm-b"') > 0, true);
check('★ 状态原样挂在卡片这一层（配色由 CSS 按字面挑）', els.focus.dataset.status, '偏热');
check('★ 正在看的那个宿舍在列表里被标出来',
  els.nodes.innerHTML.indexOf('class="node is-watching" type="button" data-focus-node="dorm-b"') > 0, true);

/* 点 dorm-c */
const focusBefore = { focus: els.focus.innerHTML, nodes: els.nodes.innerHTML, state: els['action-state'].textContent };
els['cmd-note'].textContent = '';
tapNode('dorm-c');

check('★ 点一下发出去恰好一条指令', liveClient().published.length, 1);
check('★ 发到 cmd topic 上', liveClient().published[0].topic, CFG.CMD_TOPIC);
check('★ 报文里只有三个字段：nodeId / action / source',
  JSON.parse(liveClient().published[0].payload), { nodeId: 'dorm-c', action: CFG.CMD_ACTION_FOCUS, source: 'mobile' });
check('★ action 就是 config 里那个焦点动作（写错一个字 core 会说「动作不对」）',
  JSON.parse(liveClient().published[0].payload).action, 'focus');
check('★ 报文里没有 time（焦点不挂在读数的时间线上）',
  Object.prototype.hasOwnProperty.call(JSON.parse(liveClient().published[0].payload), 'time'), false);
check('★ 报文里没有 status / state 这类结论',
  /status|state|recover/i.test(liveClient().published[0].payload), false);
check('★ 指令**不 retained**（留在 broker 上的话，下次起 core 会自己切一次焦点）',
  [liveClient().published[0].opts.qos, liveClient().published[0].opts.retain], [CFG.QOS, false]);

check('★ 点完屏幕上别的地方一个字都没动',
  [els.focus.innerHTML === focusBefore.focus,
    els.nodes.innerHTML === focusBefore.nodes,
    els['action-state'].textContent === focusBefore.state], [true, true, true]);
check('★ 那一行字必须说「等 core 发回新快照」（不然就是「点了没反应」）',
  els['cmd-note'].textContent.indexOf('等 core 发回新快照') > 0, true);
check('（而且点的是哪个宿舍要说清）',
  els['cmd-note'].textContent.indexOf('dorm-c') > 0, true);

/* 同一个宿舍再点一下：**页面不自己取消**，照样把事实发出去，
   是不是取消由 core 决定。 */
tapNode('dorm-c');
check('★ 再点一下还是发（取消是 core 的规矩，这边不判）', liveClient().published.length, 2);
check('★ 两条报文一模一样', liveClient().published[1].payload, liveClient().published[0].payload);
check('（页面上依旧什么都没变）', els.nodes.innerHTML, focusBefore.nodes);

/* 焦点真的跨过来了：core 把 focus 记进快照，页面跟着走 */
const client2 = liveClient();
feed(snapshotOf({
  nodes: [
    nodeRow('dorm-a'),
    nodeRow('dorm-b', { temperature: 31, status: '偏热', abnormalCount: 3, durationText: '10 分钟' }),
    nodeRow('dorm-c'),
  ],
  priority: { nodeId: 'dorm-b', status: '偏热', reason: '连续 3 条异常，时长最长' },
  focus: { nodeId: 'dorm-c', by: 'mobile', at: '2026-09-22 20:31:00' },
}));

check('★ 焦点一到，大卡片换成了它（标签变成「跨端焦点」）',
  [els.focus.innerHTML.indexOf('跨端焦点') > 0, els.focus.innerHTML.indexOf('dorm-c') > 0], [true, true]);
check('★ 列表里高亮的那个也跟着换',
  els.nodes.innerHTML.indexOf('class="node is-watching" type="button" data-focus-node="dorm-c"') > 0, true);
check('★ 数据选出来的重点没有因此被瞒掉（cross 那句还在说 dorm-b）',
  els.focus.innerHTML.indexOf('dorm-b') > 0, true);
check('★ 日志里记了一行跨端焦点（这是联动的证据）',
  els['log-body'].innerHTML.indexOf('跨端焦点 → dorm-c') > 0, true);
check('（是谁发的也写出来了）', els['log-body'].innerHTML.indexOf('mobile') > 0, true);

/* 「按钮作用在谁身上」不靠那句说明去猜 —— 直接按一下，看它把哪个人发出去。 */
{
  const n = client2.published.length;
  tapHandle();
  check('★ 焦点一切，开始处理作用的对象跟着换（发出去的是 dorm-c）',
    JSON.parse(client2.published[n].payload).nodeId, 'dorm-c');
}

/* 同一条焦点再来一帧：不该再记一行 */
const focusLogBefore = (els['log-body'].innerHTML.match(/跨端焦点 → dorm-c/g) || []).length;
feed(snapshotOf({
  nodes: [nodeRow('dorm-a'), nodeRow('dorm-b'), nodeRow('dorm-c')],
  focus: { nodeId: 'dorm-c', by: 'mobile', at: '2026-09-22 20:31:00' },
}));
check('★ 焦点没变就不再记一行（否则日志被同一句话刷屏）',
  (els['log-body'].innerHTML.match(/跨端焦点 → dorm-c/g) || []).length, focusLogBefore);

/* 取消。数的是「这一次多记了几行」，不是「日志里有没有这几个字」——
   后者在喂过一帧之后就永远为真了，测不出「反复记同一句」。 */
const cancelBefore = (els['log-body'].innerHTML.match(/跨端焦点已取消/g) || []).length;
feed(snapshotOf({ nodes: [nodeRow('dorm-a'), nodeRow('dorm-b'), nodeRow('dorm-c')] }));
const cancelAfter = (els['log-body'].innerHTML.match(/跨端焦点已取消/g) || []).length;
check('★ 焦点没了记一行「已取消」', cancelAfter - cancelBefore, 1);
check('★ 而没变的时候不再记（再喂两帧，行数不许涨）', (function () {
  feed(snapshotOf({ nodes: [nodeRow('dorm-a')] }));
  feed(snapshotOf({ nodes: [nodeRow('dorm-a')] }));
  return (els['log-body'].innerHTML.match(/跨端焦点已取消/g) || []).length;
})(), cancelAfter);

/* 连不上 broker 时：一个字都不许发，也不许假装发了 */
section('E2. 连不上时不发假指令');
{
  const offline = (function () {
    /* 造一根没连上的客户端：把当前这根标记成未连接 */
    const c = liveClient();
    const wasConnected = c.connected;
    c.connected = false;
    const n = c.published.length;
    els['cmd-note'].textContent = '';
    const nodesBefore = els.nodes.innerHTML;
    tapNode('dorm-a');
    const out = {
      sent: c.published.length - n,
      note: els['cmd-note'].textContent,
      unchanged: els.nodes.innerHTML === nodesBefore,
    };
    c.connected = wasConnected;
    return out;
  })();
  check('★ 没连上就一条都不发', offline.sent, 0);
  check('★ 那一行字要说明原因（MQTT 那几个字在）', /broker|连接/.test(offline.note), true);
  check('（页面上别的还是不动）', offline.unchanged, true);
}

/* ============ F. handle：开始处理 ============ */

section('F. 开始处理');

feed(snapshotOf({
  nodes: [
    nodeRow('dorm-a'),
    nodeRow('dorm-b', { temperature: 31, status: '偏热', abnormalCount: 3, durationText: '10 分钟' }),
    nodeRow('dorm-c'),
  ],
  priority: { nodeId: 'dorm-b', status: '偏热', reason: '连续 3 条异常，时长最长' },
  events: eventBlock([eventRow({
    event_id: 'dorm-b-20260922-202800', nodeId: 'dorm-b',
    problem: '偏热', priorityReason: '连续 3 条异常，时长最长',
  })]),
}));

check('★ 有一条待处理的事件时按钮能按', els['action-handle'].disabled, false);
check('（能按的时候旁边那行字是空的 —— 没原因要解释）', els['action-state'].textContent, '');

{
  const n = liveClient().published.length;
  const nodesBefore = els.nodes.innerHTML;
  const focusBefore = els.focus.innerHTML;
  els['cmd-note'].textContent = '';
  tapHandle();

  const sent = liveClient().published[n];
  check('★ 按下开始处理发出去一条', liveClient().published.length - n, 1);
  check('★ 发到 cmd topic', sent.topic, CFG.CMD_TOPIC);
  check('★ 报文 = 大卡片上那个宿舍 + handle + mobile',
    [JSON.parse(sent.payload).nodeId, JSON.parse(sent.payload).action, JSON.parse(sent.payload).source],
    ['dorm-b', CFG.CMD_ACTION, 'mobile']);
  check('★ 带的时刻是**快照里那个节点的时刻**，不是手机时钟',
    JSON.parse(sent.payload).time, '2026-09-22 20:30:00');
  check('★ 不 retained', sent.opts.retain, false);
  check('★ 报文里没有「已恢复」这类结论', /recover|已恢复|status/.test(sent.payload), false);
  check('★ 按完屏幕上任何地方都没变（要等 core 发回新快照）',
    [els.nodes.innerHTML === nodesBefore, els.focus.innerHTML === focusBefore], [true, true]);
  check('★ 那一行字点明「好没好由 core 判」',
    els['cmd-note'].textContent.indexOf('core 后续收到的报文判') > 0, true);
}

/* 都正常、也没人被点名：没人可处理，按钮灰着，旁边那句就是**大卡片上那句**
   （同一个 focusBanner），不是另一套说法 —— 两处要是各写各的，
   迟早会出现「卡片说都正常、按钮说还没收到数据」。 */
feed(snapshotOf({
  nodes: [nodeRow('dorm-a'), nodeRow('dorm-b'), nodeRow('dorm-c')],
}));
check('★ 都正常时按钮是灰的', els['action-handle'].disabled, true);
check('★ 灰按钮旁边那句和大卡片上那句是同一句',
  [els['action-state'].textContent, els.focus.innerHTML.indexOf(els['action-state'].textContent) > 0],
  ['当前 3 个宿舍都正常', true]);
check('（那句里也写着「正常」，用的人一眼知道为什么按不动）',
  els['action-state'].textContent.indexOf('正常') > 0, true);

/* 有宿舍异常但**还没开案**：core 不给按，旁边要说清它在等什么 */
feed(snapshotOf({
  nodes: [
    nodeRow('dorm-a'),
    nodeRow('dorm-b', { temperature: 31, status: '偏热', abnormalCount: 1 }),
    nodeRow('dorm-c'),
  ],
  priority: { nodeId: 'dorm-b', status: '偏热', abnormalCount: 1, durationText: null, reason: '刚连续 1 条异常' },
}));
check('★ 只有一条异常、core 还没开案时按钮也是灰的', els['action-handle'].disabled, true);
check('★ 而且要说清它在等什么（「连续几条才开案」这句在）',
  els['action-state'].textContent.indexOf('连续') > 0, true);

/* ============ G. 启动那一刻的空状态 ============ */

section('G. 启动空状态');

/* 这一屏是**脚本刚跑完、一帧快照都还没喂**的时候抄下来的（见上面 BOOT）。
   快照是 retained 的，正常情况下 core 一上线页面立刻补上 —— 但从打开页面
   到第一帧快照到达之间那几百毫秒，屏幕上写的是「不知道」而不是「都正常」。
   这两件事在屏幕上长得一样，分不出来的时候人是不会去看时间戳的。 */
check('★ 还没收到快照时按钮是灰的', BOOT.actionDisabled, true);
check('★ 旁边那句说的是「还没有收到 core 的快照」',
  BOOT.actionState, '还没有收到 core 的快照，先等它发一帧过来');
check('★ 大卡片上写的也是「还没有收到」，不是「都正常」',
  [BOOT.focus.indexOf('还没有收到') > 0, BOOT.focus.indexOf('正常') < 0], [true, true]);
check('★ 列表里也一样，而且不装作有三个宿舍', BOOT.nodes.indexOf('还没有收到 core 的快照') > 0, true);
check('★ 那一帧里没有状态可显示（属性是空的）', BOOT.focusStatus, '');
check('★ 日志区写着「还没有收到消息」，不是空的',
  BOOT.log.indexOf('还没有收到消息') > 0, true);
check('（标题旁边不写「0 个」—— 那看着像「收到了，是 0 个」）',
  BOOT.nodeCount, '');

/* ============ H. index.html ============ */

section('H. mobile/index.html');

const html = fs.readFileSync(MOB_HTML, 'utf8');
const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');

/* 这三条查的是**去掉注释之后**的那份。这个文件的注释里到处都在讲
   「不写 maximum-scale」「config.js 要排在模块脚本前面」—— 拿原文去查，
   讲解这件事的句子本身就会命中（第一版就是这么红的）。
   注释里说不等于代码里做了，所以查的是剥掉注释的那一份。 */
check('★ 有 viewport（少了它手机上字小到看不清、按钮按不准）',
  /<meta\s+name="viewport"\s+content="width=device-width, initial-scale=1"/.test(htmlNoComments), true);
check('★ 没有禁止缩放（禁了就等于对视力不好的人关门）',
  /maximum-scale|user-scalable\s*=\s*no/.test(htmlNoComments), false);
check('★ 引了 config.js', /<script src="\.\.\/shared\/config\.js"><\/script>/.test(htmlNoComments), true);
check('★ config.js 排在模块脚本前面（模块里打开页面就要读它）',
  htmlNoComments.indexOf('../shared/config.js') < htmlNoComments.indexOf('type="module"'), true);
check('★ 只有一条模块脚本（就是 mobile.js）',
  (html.match(/<script type="module"/g) || []).length, 1);
check('★ mqtt.js 借的是 dashboard/lib 里那份（不再拷第二份）',
  html.indexOf('../dashboard/lib/mqtt.min.js') > 0, true);
check('★ 引了本页的样式表', /<link rel="stylesheet" href="style\.css">/.test(html), true);

/* E3 那条硬约束：**禁止两边手动输入数据伪造同步效果**。
   一个页面里只要有能敲数字进去的地方，就有了「屏幕上这套数据从哪来」
   说不清的可能 —— 而这个页面上的每一个字都必须是 core 发来的。 */
check('★ 没有任何输入框（手动输入数据正是 E3 禁止的那件事）',
  /<input|<textarea|<form|<select/i.test(htmlNoComments), false);
check('★ 没有任何「模拟 / 假数据」按钮',
  /模拟|假数据|demo数据/.test(htmlNoComments), false);
check('★ 没有第二份规则（页面上不写阈值）',
  /(?:<|>|&lt;|&gt;)\s*(?:18|30|75)\b/.test(htmlNoComments), false);

/* 页面上那几个 id 必须齐全 —— 少一个，mobile.js 拿到的就是 null，
   而报错要等到下一次重画才出现（“Cannot set properties of null”），
   现场看起来像「页面卡住了」。 */
check('★ 每个 id 都对得上 mobile.js 里 getElementById 的那个',
  ['app', 'conn', 'conn-text', 'focus', 'nodes', 'node-count',
    'action-handle', 'action-state', 'cmd-note', 'log-body', 'log-count']
    .filter((id) => html.indexOf('id="' + id + '"') < 0), []);

console.log(`\n结果：${pass} 通过，${fail} 不通过`);
process.exit(fail === 0 ? 0 : 1);
