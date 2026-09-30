// tests/logic.test.js
// 校验 dashboard/logic.js —— Step E3-2 之后，这里只剩两件事：
// 「**读**快照里的字段」和「把那些字段**说**成人话」。
//
// 这个文件是整个测试套件里唯一**不用起 vm 上下文打桩**的一个：
// logic.js 是纯函数，不碰 DOM、不读全局变量、不调 Date.now()，
// 给它一份快照就该得到一句固定的话。所以这里连假 document 都不用造。
//
// 它不需要打桩这件事本身就是一条要求，A 段把它钉住了 ——
// 哪天有人往 logic.js 里塞一句 document.getElementById，这里立刻红。
//
// 【这一轮为什么要重写】E3 之前这个文件测的是「优先关注怎么排」
// 「处理动作状态机怎么走」—— 那些判断**整体搬去了 core**，函数也不在了。
// 现在测的是另一边：core 发的这份快照，页面读对了没有、说对了没有。
// 尤其是「一个结论都不许下」这条：A 段里有几条专门查源码里**没有**
// 阈值、没有状态名、没有节点名 —— 那些词一旦出现，就说明判断又溜回来了。
//
// 跑法：node tests/logic.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const LOGIC_FILE = path.join(ROOT, 'dashboard', 'logic.js');

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? `  =>  ${a}` : `\n        实际: ${a}\n        期望: ${e}`));
}

const raw = fs.readFileSync(LOGIC_FILE, 'utf8');

/* ---------- A. 模块形状 ---------- */

console.log('=== A. 模块形状（纯函数的硬约束）===');

/* 导出清单。顺序也一起对 —— 导出集合变了这里就红，
   免得将来谁把某个函数从 export 拿掉，测试还在，测的却是别的东西。 */
const EXPORTS = (raw.match(/^export\s+(?:function|const|let)\s+(\w+)/gm) || [])
  .map((line) => line.replace(/^export\s+(?:function|const|let)\s+/, ''));

check('★ 导出清单正好是这十九个（一个 const + 十八个函数，多一个少一个都要在这里说清楚）',
  EXPORTS.join(','),
  'SNAPSHOT_VERSION,readSnapshot,nodeOf,openEvent,latestEvent,eventStateText,'
  + 'handlingOf,actionState,fanOn,trendOf,trendText,calmLine,focusBanner,'
  + 'alertLine,speakLine,snapshotSummary,buildMlNote,mlFetchFailed,cmdNote');
check('没有 default export（用默认导出的话，dashboard.js 那条具名 import 就失效了）',
  /export\s+default/.test(raw), false);

/* 内部件不许导出：导出的话，页面那边就能绕开这些唯一的说法自己拼一份，
   于是同一件事在屏幕上出现两种讲法而没人报错。
     nodeList / eventBlock / survey / isObject / bad —— 取值用的内部件
     trendText 的反面：它是「上升/下降/持平 -> 一句话」的唯一一份说法，两边都用它
     fileName / rowCount —— ML 那一段的收拾字段 */
['nodeList', 'eventBlock', 'survey', 'isObject', 'bad', 'fileName', 'rowCount',
  'cameraCountOf', 'ML_BAD_SHAPE', 'STATUS_TEXT']
  .forEach(function (name) {
    check('★ ' + name + ' 不导出（内部件：同一件事只留一份说法）',
      EXPORTS.includes(name), false);
  });

/* 「不操作 DOM / 不读全局 / 不看时钟」是这一步的明确要求，所以直接查源码。
   先剥注释：注释里本来就会提到 document、Date 这些东西（比如上面写着
   「不调 Date.now()」），不剥的话这几条永远是红的。 */
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

[
  'document', 'window', 'globalThis', 'localStorage', 'sessionStorage',
  'navigator', 'fetch(', 'Date.now', 'new Date', 'setTimeout', 'mqtt',
].forEach(function (name) {
  check('★ 源码里不出现 ' + name + '（纯函数：这一层不许碰这些）',
    code.indexOf(name) >= 0, false);
});

/* 【这一轮最重要的一条：判断不许溜回来】
   温度阈值（18 / 30 / 75）和那三个状态名，是 core 的事。
   这个文件现在连它们认都不认识 —— 「偏热」这三个字是从快照的 status 字段里
   原样搬出来的，不是这边判出来的。源码里出现任何一个，就说明有人又写了一遍规则。
   用 \b 圈住数字：不圈的话 '2026' 里的 '20'、'26' 会误伤。 */
check('★ 源码里没有温度阈值 18（判断不是这一层的事）', /\b18\b/.test(code), false);
check('★ 源码里没有温度阈值 30', /\b30\b/.test(code), false);
check('★ 源码里没有湿度阈值 75', /\b75\b/.test(code), false);
check('★ 源码里一个状态名都没有（偏冷 / 偏热 / 偏湿）',
  /偏冷|偏热|偏湿/.test(code), false);
/* 「正常」是**比较的基准**（谁需要关注 = 谁不是正常），留着它不算判断；
   但它是唯一的例外，所以单独钉一条，免得将来又多出第二个词。 */
check('（「正常」是唯一的例外：它是比较基准，不是判出来的）',
  code.indexOf('正常') > 0, true);
check('★ 源码里不出现 judgeStatus（规则那份在 shared/rules.js，这里不引）',
  code.indexOf('judgeStatus'), -1);
/* 节点名同样一个都不能写死：快照里有哪些宿舍是 core 的配置说了算。
   写死的话，core 的 config.json 加了第四个节点，页面会当它不存在。 */
check('★ 源码里不出现任何具体节点名（注释里的例子不算）',
  /dorm-/.test(code), false);

const stripped = raw.replace(/^export\s+/gm, '');
const context = { Number, String, Object, Array, JSON, Math, isNaN, Boolean };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(stripped, context, { filename: LOGIC_FILE });

const { readSnapshot, nodeOf, openEvent, latestEvent, eventStateText,
  handlingOf, actionState, fanOn, trendOf, trendText, calmLine, focusBanner,
  alertLine, speakLine, snapshotSummary, buildMlNote, mlFetchFailed, cmdNote } = context;

check('★ 十八个口都拿得到', [readSnapshot, nodeOf, openEvent, latestEvent,
  eventStateText, handlingOf, actionState, fanOn, trendOf, trendText, calmLine,
  focusBanner, alertLine, speakLine, snapshotSummary, buildMlNote, mlFetchFailed,
  cmdNote]
  .map((f) => typeof f),
['function', 'function', 'function', 'function', 'function', 'function',
  'function', 'function', 'function', 'function', 'function', 'function',
  'function', 'function', 'function', 'function', 'function', 'function']);

/* 版本号是 const（不是函数），要从上下文的词法作用域里读 ——
   它和 core.py 的 SNAPSHOT_VERSION 必须同时改，读出来对一次是值得的。 */
const SNAPSHOT_VERSION = vm.runInContext('SNAPSHOT_VERSION', context);
check('★ 认的快照版本是 2', SNAPSHOT_VERSION, 2);

/* ---------- 造数据 ---------- */

/** 一个节点在快照里的那一条。字段和 core.py 的 NodeState.snapshot() 一一对应。 */
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

/** 一条事件。字段就是 core 的 Event.view() 那十四样（顺序也照着）。 */
function eventRow(over) {
  const e = {
    event_id: 'dorm-a-20260922-202800',
    nodeId: 'dorm-a',
    state: 'OPEN',
    startTime: '2026-09-22 20:28:00',
    problem: '温度偏高（31℃）',
    priorityTime: '2026-09-22 20:30:00',
    priorityReason: '连续异常 3 次、已持续 2 分钟，最久',
    action: null,
    actionTime: null,
    actionSource: null,
    recoverTime: null,
    endTime: null,
    result: null,
    abnormalAfter: 0,
    verifyCount: 0,
    /* Phase6 E2：这条事件上登了几张现场快照。core 只报个数，那条记录本身
       （水印、文件名、宽高）留在 data/events.json 里，不进每个周期的快照。 */
    cameraCount: 0,
  };
  Object.keys(over || {}).forEach(function (k) { e[k] = over[k]; });
  return e;
}

/** 一份完整的 v2 快照。三个宿舍，什么都没发生。 */
function snapshotOf(over) {
  const s = {
    v: 2,
    time: '2026-09-22 20:30:00',
    focus: null,
    priority: null,
    nodes: [nodeRow('dorm-a'), nodeRow('dorm-b'), nodeRow('dorm-c')],
    events: {
      summary: { total: 0, OPEN: 0, HANDLING: 0, RECOVERED: 0, UNRESOLVED: 0 },
      dropped: 0,
      events: [],
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
    status: '偏热',
    temperature: 31,
    abnormalCount: 3,
    durationSec: 1200,
    durationText: '20 分钟',
    reason: '已连续偏热 20 分钟（3 次）',
    history: [
      { time: '2026-09-22 20:28:00', temperature: 33, humidity: 60, status: '偏热' },
      { time: '2026-09-22 20:29:00', temperature: 32, humidity: 60, status: '偏热' },
      { time: '2026-09-22 20:30:00', temperature: 31, humidity: 60, status: '偏热' },
    ],
  });
  const ev = eventRow({
    nodeId: 'dorm-b', state: 'HANDLING', action: '开启风扇 / 通风',
    actionTime: '2026-09-22 20:31:00', actionSource: 'dashboard',
    abnormalAfter: 2,
  });
  const s = snapshotOf({
    priority: { nodeId: 'dorm-b', status: '偏热', severity: 'critical',
      abnormalCount: 3, durationSec: 1200, durationText: '20 分钟',
      reason: '已连续偏热 20 分钟（3 次）' },
    nodes: [nodeRow('dorm-a'), hot, nodeRow('dorm-c')],
    events: {
      summary: { total: 8, OPEN: 0, HANDLING: 1, RECOVERED: 7, UNRESOLVED: 0 },
      dropped: 0,
      events: [eventRow({ nodeId: 'dorm-a', state: 'RECOVERED',
        recoverTime: '2026-09-22 20:10:00', endTime: '2026-09-22 20:10:00',
        result: '已恢复', action: '开启风扇 / 通风' }), ev],
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

/* ---------- B. readSnapshot ---------- */

console.log('\n=== B. readSnapshot（前端唯一的入口校验）===');

function reasonOf(value) {
  const r = readSnapshot(value);
  return [r.ok, r.reason];
}

check('正常的一份快照', readSnapshot(snapshotOf()).ok, true);
check('★ 通过之后原样交出去（不做深拷贝、不悄悄补字段）',
  readSnapshot(snapshotOf()).snapshot.nodes.length, 3);
check('通过时 reason 是空串（不是 undefined）', readSnapshot(snapshotOf()).reason, '');

check('null', reasonOf(null),
  [false, '快照顶层不是对象（收到 null）']);
check('undefined', reasonOf(undefined),
  [false, '快照顶层不是对象（收到 undefined）']);
check('★ 数组（有人把 [] 当空快照发过来）', reasonOf([]),
  [false, '快照顶层不是对象（收到 array）']);
check('字符串', reasonOf('hello'),
  [false, '快照顶层不是对象（收到 hello）']);
check('数字', reasonOf(7), [false, '快照顶层不是对象（收到 7）']);

check('没有 v', reasonOf({ nodes: [] })[1].indexOf('没有 v') >= 0, true);
check('★ v 是字符串 "2"（JSON 里手写过一次 "2" 就会这样）',
  reasonOf({ v: '2' })[1].indexOf('没有 v') >= 0, true);
check('★ v 是 1（旧版 core）', reasonOf({ v: 1 }),
  [false, '快照版本是 1，这个页面认的是 2（core.py 改了字段就要一起改）']);
check('★ v 是 3（比这个页面新）',
  reasonOf({ v: 3 })[1].indexOf('快照版本是 3') >= 0, true);
check('★ v 是 NaN（JSON.parse 造不出来，但别的地方能）',
  reasonOf({ v: NaN })[1].indexOf('没有 v') >= 0, true);

check('nodes 不是数组', reasonOf({ v: 2, nodes: {} })[1], '快照里没有 nodes 数组');
check('events 整块没了', reasonOf({ v: 2, nodes: [] })[1],
  '快照里没有 events（事件那一块）');
check('events 在、events.events 不是数组',
  reasonOf({ v: 2, nodes: [], events: { summary: {}, events: null } })[1],
  '快照里没有 events（事件那一块）');
check('rejects 整块没了',
  reasonOf({ v: 2, nodes: [], events: { events: [] } })[1],
  '快照里没有 rejects（被拒绝消息那一块）');
check('counters 没了',
  reasonOf({ v: 2, nodes: [], events: { events: [] }, rejects: { items: [] } })[1],
  '快照里没有 counters');

check('priority 是字符串（不是对象也不是 null）',
  reasonOf(Object.assign(snapshotOf(), { priority: 'dorm-a' }))[1],
  'priority 既不是对象也不是 null');
check('priority 是 null 是**允许**的（此刻没有重点）',
  readSnapshot(snapshotOf({ priority: null })).ok, true);
check('★ focus 是数组（旧版 core 没有这个字段，会拿到 undefined）',
  reasonOf(Object.assign(snapshotOf(), { focus: [] }))[1],
  'focus 既不是对象也不是 null（旧版 core 没有这个字段）');
check('focus 是 null 是允许的（没人点名）',
  readSnapshot(snapshotOf({ focus: null })).ok, true);
check('★ focus 字段整个缺失也算不通过（旧版 core 的快照会被拦下，而不是整页显示 undefined）',
  reasonOf(snapshotOf({ focus: undefined }))[1],
  'focus 既不是对象也不是 null（旧版 core 没有这个字段）');

/* 【只查形状，不查内容】core 那边就不拦 99℃（D4 第 5 条正是拿它演示的），
   页面这一层更不该拦 —— 拦了的话，D4 那条演示在看板上什么都看不到，
   而演示要看的恰恰就是「它照样被收下了」。 */
const weird = snapshotOf({ nodes: [nodeRow('dorm-a', {
  status: '偏热', temperature: 99, humidity: -5, abnormalCount: 999 })] });
check('★★ 内容再离谱也放行（99℃ / -5% 都收）', readSnapshot(weird).ok, true);
check('★ 而且原样交给页面（不修正、不夹紧）',
  readSnapshot(weird).snapshot.nodes[0].temperature, 99);
check('status 是页面上从没见过的词也放行',
  readSnapshot(snapshotOf({ nodes: [nodeRow('dorm-a', { status: '台风' })] })).ok, true);

/* ---------- C. nodeOf ---------- */

console.log('\n=== C. nodeOf ===');

const base = snapshotOf();
check('找得到 dorm-b', nodeOf(base, 'dorm-b').nodeId, 'dorm-b');
check('找不到就是 null（不抛）', nodeOf(base, 'dorm-z'), null);
check('snapshot 是 null', nodeOf(null, 'dorm-b'), null);
check('snapshot 是 undefined', nodeOf(undefined, 'dorm-b'), null);
check('nodes 不是数组', nodeOf({ nodes: 'x' }, 'dorm-b'), null);
check('nodes 里夹了个 null 也不炸', nodeOf({ nodes: [null, nodeRow('dorm-a')] }, 'dorm-a').nodeId, 'dorm-a');
check('★ 一个宿舍都没有时是 null，不是造一个空的出来',
  nodeOf(snapshotOf({ nodes: [] }), 'dorm-a'), null);
/* 节点名不是写死的 —— 把 core 的 config.json 改成 dorm-x，这里照样找得到 */
check('★ 换一个没见过的节点名照样找得到（名字来自快照，不是写死的）',
  nodeOf(snapshotOf({ nodes: [nodeRow('dorm-x')] }), 'dorm-x').nodeId, 'dorm-x');

/* ---------- D. 事件：openEvent / latestEvent / eventStateText / handlingOf ---------- */

console.log('\n=== D. 事件 ===');

const withEvents = snapshotOf({
  events: {
    summary: { total: 3 },
    events: [
      eventRow({ nodeId: 'dorm-a', state: 'RECOVERED', recoverTime: '2026-09-22 20:10:00' }),
      eventRow({ nodeId: 'dorm-b', state: 'OPEN' }),
      eventRow({ nodeId: 'dorm-c', state: 'UNRESOLVED', endTime: '2026-09-22 20:20:00' }),
    ],
  },
});

check('OPEN 算未结案', openEvent(withEvents, 'dorm-b').state, 'OPEN');
check('★ RECOVERED 不算未结案（结过案的属于事件表，不属于「此刻在处理吗」）',
  openEvent(withEvents, 'dorm-a'), null);
check('★ UNRESOLVED 也不算未结案', openEvent(withEvents, 'dorm-c'), null);
check('这个宿舍没有事件', openEvent(withEvents, 'dorm-z'), null);
check('没有 events 这一块时是 null（不抛）', openEvent(null, 'dorm-b'), null);

const twoOpen = snapshotOf({
  events: { summary: {}, events: [
    eventRow({ nodeId: 'dorm-b', state: 'OPEN', startTime: '2026-09-22 20:00:00' }),
    eventRow({ nodeId: 'dorm-b', state: 'HANDLING', startTime: '2026-09-22 20:20:00' }),
  ] },
});
check('★ 同一个宿舍两条没结案时取**后**一条（core 保证不会，但重启读到两条时取最近的更对）',
  openEvent(twoOpen, 'dorm-b').startTime, '2026-09-22 20:20:00');

check('latestEvent 拿到结过案的那条', latestEvent(withEvents, 'dorm-a').state, 'RECOVERED');
check('latestEvent 在没有事件时是 null', latestEvent(withEvents, 'dorm-z'), null);
const twoForB = snapshotOf({
  events: { summary: {}, events: [
    eventRow({ nodeId: 'dorm-b', state: 'RECOVERED', startTime: '2026-09-22 19:00:00' }),
    eventRow({ nodeId: 'dorm-b', state: 'OPEN', startTime: '2026-09-22 20:00:00' }),
  ] },
});
check('★ latestEvent 取最后一条（不是第一条，也不是「最后一条未结案」）',
  latestEvent(twoForB, 'dorm-b').startTime, '2026-09-22 20:00:00');
check('★ openEvent 和 latestEvent 可以指向不同两条（这不是 bug，是两个问题）',
  [openEvent(twoForB, 'dorm-b').state, latestEvent(twoForB, 'dorm-b').state],
  ['OPEN', 'OPEN']);

check('OPEN -> 待处理', eventStateText('OPEN'), '待处理');
check('HANDLING -> 处理中', eventStateText('HANDLING'), '处理中');
check('RECOVERED -> 已恢复', eventStateText('RECOVERED'), '已恢复');
check('UNRESOLVED -> 未恢复', eventStateText('UNRESOLVED'), '未恢复');
check('★ 认不出来的原样返回（不假装懂、也不吞掉）', eventStateText('PAUSED'), 'PAUSED');
check('空串 -> 空串', eventStateText(''), '');
check('null -> 空串', eventStateText(null), '');
check('undefined -> 空串', eventStateText(undefined), '');
check('★ 不是字符串的（数字）-> 空串，不抛', eventStateText(3), '');
/* 原型链上的名字：用 hasOwnProperty 判的话 'toString' 会走漏，
   拿到一个函数当状态名。core 那边不会发这种，但挡一下不要钱。 */
check('★ "toString" 这种原型链上的名字不许被当成已知状态',
  eventStateText('toString'), 'toString');

check('没有事件 -> 无', handlingOf(withEvents, 'dorm-z').label, '无');
check('没有事件时 event 是 null', handlingOf(withEvents, 'dorm-z').event, null);
check('没有事件时 after 是 0', handlingOf(withEvents, 'dorm-z').after, 0);
check('OPEN -> 待处理', handlingOf(withEvents, 'dorm-b').label, '待处理');
check('HANDLING -> 处理中', handlingOf(busySnapshot(), 'dorm-b').label, '处理中');
check('★ 结过案的宿舍 -> 无（卡片上不该还挂着「处理中」）',
  handlingOf(withEvents, 'dorm-a').label, '无');
check('after 读的是 core 数好的 abnormalAfter',
  handlingOf(busySnapshot(), 'dorm-b').after, 2);
check('★ abnormalAfter 缺失时是 0，不是 NaN',
  handlingOf(withEvents, 'dorm-b').after, 0);
check('★ abnormalAfter 是字符串时也是 0（不把 "2" 当 2 用）',
  handlingOf(snapshotOf({ events: { summary: {}, events: [eventRow({ abnormalAfter: '2' })] } }), 'dorm-a').after,
  0);
check('event 那一栏给的就是快照里那条本身',
  handlingOf(withEvents, 'dorm-b').event === withEvents.events.events[1], true);

/* ---------- E. actionState（「开始处理」按钮） ---------- */

console.log('\n=== E. actionState ===');

check('★ 还没收到快照 -> 灰着', actionState(null, 'dorm-b').enabled, false);
check('没收到快照时那句话说了原因',
  actionState(null, 'dorm-b').note.indexOf('core 还没收到这个节点的数据') >= 0, true);
check('★ 这个宿舍还没数据 -> 灰着（按了也没有对应的事件）',
  actionState(snapshotOf({ nodes: [nodeRow('dorm-a', { status: null, temperature: null })] }), 'dorm-a').enabled,
  false);
check('还没数据那句话说的是「还没有收到」而不是「正常」',
  actionState(snapshotOf({ nodes: [nodeRow('dorm-a', { status: null })] }), 'dorm-a').note
    .indexOf('正常'), -1);

check('★ 有一条待处理的事件 -> 可以按', actionState(withEvents, 'dorm-b').enabled, true);
check('可以按时旁边那行是空的（不用多说一句）', actionState(withEvents, 'dorm-b').note, '');

const handlingState = actionState(busySnapshot(), 'dorm-b');
check('★ 已经在处理中 -> 灰着', handlingState.enabled, false);
check('处理中那句话点明了「再按只会多记一笔」',
  handlingState.note.indexOf('再按一次只会多记一笔动作') > 0, true);
check('处理中那句话带上了「之后又收到 2 条异常」',
  handlingState.note.indexOf('之后又收到 2 条异常') > 0, true);

const normalNoEvent = actionState(snapshotOf(), 'dorm-a');
check('★ 状态正常、也没事件 -> 灰着', normalNoEvent.enabled, false);
check('那句话说的是「没有未结案的事件」',
  normalNoEvent.note.indexOf('没有未结案的事件') > 0, true);

const hotNoEvent = actionState(snapshotOf({ nodes: [nodeRow('dorm-b', {
  status: '偏热', abnormalCount: 2 })] }), 'dorm-b');
check('★ 异常但 core 还没开案 -> 灰着（开案是 core 的规矩）',
  hotNoEvent.enabled, false);
check('★ 那句话把「连着几条了」报出来（数字来自快照，不是这边写死的 3）',
  hotNoEvent.note.indexOf('现在连着 2 条') > 0, true);
const hotOther = actionState(snapshotOf({ nodes: [nodeRow('dorm-b', {
  status: '偏热', abnormalCount: 5 })] }), 'dorm-b');
check('★ 换成连着 5 条，那句话跟着变成 5（说明这个数不是写死的）',
  hotOther.note.indexOf('现在连着 5 条') > 0, true);
check('★ abnormalCount 缺失时报 0，不报 NaN',
  actionState(snapshotOf({ nodes: [nodeRow('dorm-b', { status: '偏热', abnormalCount: null })] }), 'dorm-b')
    .note.indexOf('现在连着 0 条') > 0, true);

/* 【以 core 的事件为准】处理之后连着几条正常、还没到恢复的条数时，
   node.status 已经是「正常」了，而 core 那边那条事件还挂着 HANDLING。
   这时候按钮该是什么样由**事件**说，不由 status 说 —— 两句要是有出入，
   按 core 的来（不然「屏幕说正常、core 还在处理」，两边各说各的）。 */
const recoveredButOpen = snapshotOf({
  nodes: [nodeRow('dorm-b', { status: '正常' })],
  events: { summary: {}, events: [eventRow({ nodeId: 'dorm-b', state: 'HANDLING' })] },
});
check('★★ status 已经是正常、但事件还在处理中 -> 仍然灰着（以 core 的事件为准）',
  actionState(recoveredButOpen, 'dorm-b').enabled, false);
check('★★ 而且那句话说的是「处理中」，不是「状态正常」',
  actionState(recoveredButOpen, 'dorm-b').note.indexOf('正在处理中') > 0, true);

const normalButOpen = snapshotOf({
  nodes: [nodeRow('dorm-b', { status: '正常' })],
  events: { summary: {}, events: [eventRow({ nodeId: 'dorm-b', state: 'OPEN' })] },
});
check('★★ 反过来也一样：status 正常但事件还开着 -> 可以按',
  actionState(normalButOpen, 'dorm-b').enabled, true);

/* ---------- F. fanOn（3D 里的风扇） ---------- */

console.log('\n=== F. fanOn ===');

check('★ 最近那条事件有 action -> 转', fanOn(busySnapshot(), 'dorm-b'), true);
check('没有事件 -> 不转', fanOn(snapshotOf(), 'dorm-a'), false);
check('有事件但没人按过 -> 不转', fanOn(withEvents, 'dorm-b'), false);
check('★ 结过案但按过 -> 照样转（7-2 定下的：只有清空才停）',
  fanOn(snapshotOf({ events: { summary: {}, events: [
    eventRow({ nodeId: 'dorm-a', state: 'RECOVERED', action: '开启风扇 / 通风' })] } }), 'dorm-a'),
  true);
check('★ action 是空串不算按过（空串是假值，别把「记了个空」当「按过」）',
  fanOn(snapshotOf({ events: { summary: {}, events: [
    eventRow({ nodeId: 'dorm-a', action: '' })] } }), 'dorm-a'), false);
check('★ 读的是最近那条，不是随便一条',
  fanOn(snapshotOf({ events: { summary: {}, events: [
    eventRow({ nodeId: 'dorm-a', state: 'RECOVERED', action: '开启风扇 / 通风',
      startTime: '2026-09-22 19:00:00' }),
    eventRow({ nodeId: 'dorm-a', state: 'OPEN', action: null,
      startTime: '2026-09-22 20:00:00' })] } }), 'dorm-a'), false);
/* 「按过」是**按节点**算的，不是全局一个开关：另一个宿舍按过，
   不该让这个宿舍的扇叶也转起来。 */
const othersPressed = snapshotOf({ events: { summary: {}, events: [
  eventRow({ nodeId: 'dorm-a', state: 'OPEN', action: null }),
  eventRow({ nodeId: 'dorm-b', state: 'HANDLING', action: '开启风扇 / 通风' }),
] } });
check('★ 别的宿舍按过不算这个宿舍的（dorm-a 自己那条没按过）',
  fanOn(othersPressed, 'dorm-a'), false);
check('（同一个快照里，按过那个宿舍照样转 —— 说明确实是按节点分的）',
  fanOn(othersPressed, 'dorm-b'), true);

/* ---------- G. trendOf / trendText ---------- */

console.log('\n=== G. trendOf / trendText ===');

function hist(a, b) {
  return [
    { time: '2026-09-22 20:29:00', temperature: a, humidity: 60 },
    { time: '2026-09-22 20:30:00', temperature: b, humidity: 60 },
  ];
}

check('31 <- 33 是下降', trendOf(hist(33, 31)), '下降');
check('29 <- 25 是上升', trendOf(hist(25, 29)), '上升');
check('25 <- 25 是持平', trendOf(hist(25, 25)), '持平');
check('25.0 <- 25.0（浮点相等）是持平', trendOf(hist(25.0, 25.0)), '持平');
check('25.4 <- 25.5 是上升（差 0.1 也算变了，不设容差）', trendOf(hist(25.4, 25.5)), '上升');
check('★ 只有一条 -> 空串（说成「持平」就是把「不知道」说成了「没变」）',
  trendOf([{ time: 'x', temperature: 25 }]), '');
check('★ 一条都没有 -> 空串', trendOf([]), '');
check('不是数组 -> 空串', trendOf(null), '');
check('undefined -> 空串', trendOf(undefined), '');
check('★ 缺温度字段 -> 空串（不是 NaN 一路传到页面上）',
  trendOf([{ time: 'a' }, { time: 'b' }]), '');
check('★ 温度是字符串 -> 空串（"29" 不许被当成 29 比）',
  trendOf(hist('25', '29')), '');
check('★ 温度是 Infinity -> 空串', trendOf(hist(25, Infinity)), '');
check('数组里夹了 null -> 空串', trendOf([null, { temperature: 25 }]), '');
check('★ 只看最近两条：前面跌得再狠，最近一次是涨的就是上升',
  trendOf([{ temperature: 30 }, { temperature: 20 }, { temperature: 25 }]), '上升');
check('★ 不看湿度、不看 status（只有温度能定方向）',
  trendOf([{ temperature: 25, humidity: 80, status: '偏湿' },
    { temperature: 25, humidity: 60, status: '正常' }]), '持平');

check('下降 -> 温度正在下降', trendText('下降'), '温度正在下降');
check('上升 -> 温度正在上升', trendText('上升'), '温度正在上升');
check('★ 持平 -> 「温度持平」（「温度正在持平」不成话）', trendText('持平'), '温度持平');
check('空串 -> 空串（拼句子时直接跳过）', trendText(''), '');
check('undefined -> 空串', trendText(undefined), '');

/* ---------- H. calmLine ---------- */

console.log('\n=== H. calmLine ===');

check('★ snapshot 是 null -> 「还没有收到 core 的快照」（不是「都正常」）',
  calmLine(null), '还没有收到 core 的快照');
check('nodes 是空数组 -> 同一句', calmLine(snapshotOf({ nodes: [] })), '还没有收到 core 的快照');
check('★ 三个都有数据、都正常 -> 「当前 3 个宿舍都正常」',
  calmLine(snapshotOf()), '当前 3 个宿舍都正常');
check('★ 三个一个都没收到数据 -> 「还没有收到任何节点的数据」（不知道 ≠ 正常）',
  calmLine(snapshotOf({ nodes: [nodeRow('dorm-a', { status: null }),
    nodeRow('dorm-b', { status: null })] })),
  '还没有收到任何节点的数据');
check('★ 一个正常、一个还没数据 -> 两件事分开说',
  calmLine(snapshotOf({ nodes: [nodeRow('dorm-a'), nodeRow('dorm-b', { status: null })] })),
  '当前 1 个宿舍正常，另有 1 个还没有收到数据');
/* 全正常才算「都正常」：有一个还没数据就不能说满 */
check('★★ 两个正常 + 一个还没数据 ≠ 都正常',
  calmLine(snapshotOf({ nodes: [nodeRow('dorm-a'), nodeRow('dorm-b'),
    nodeRow('dorm-c', { status: null })] })),
  '当前 2 个宿舍正常，另有 1 个还没有收到数据');
check('★ 有异常却没人被点名（那个节点离线了）时如实报个数，不说「都正常」',
  calmLine(snapshotOf({ nodes: [nodeRow('dorm-a'), nodeRow('dorm-b'),
    nodeRow('dorm-c', { status: '偏热', online: false })] })),
  '当前 2 个宿舍正常，另有 1 个异常（离线的节点不参与优先排序）');
check('★ 又有异常又有没数据的，两样都报',
  calmLine(snapshotOf({ nodes: [nodeRow('dorm-a'),
    nodeRow('dorm-b', { status: '偏冷' }), nodeRow('dorm-c', { status: null })] })),
  '当前 1 个宿舍正常，另有 1 个异常（离线的节点不参与优先排序），另有 1 个还没有收到数据');
check('一个宿舍都没有收到数据、也一个都没正常',
  calmLine(snapshotOf({ nodes: [nodeRow('dorm-a', { status: null })] })),
  '还没有收到任何节点的数据');
/* 数字是数出来的（几个宿舍是快照说了算），所以换个数就得跟着变 */
check('★ 换成一个宿舍 -> 「当前 1 个宿舍都正常」',
  calmLine(snapshotOf({ nodes: [nodeRow('dorm-a')] })), '当前 1 个宿舍都正常');

/* ---------- I. focusBanner ---------- */

console.log('\n=== I. focusBanner（顶部那条横幅）===');

check('★ 什么都没有 -> calm', focusBanner(snapshotOf()).mode, 'calm');
check('calm 时 nodeId 是 null', focusBanner(snapshotOf()).nodeId, null);
check('calm 时 line 就是 calmLine 那句',
  focusBanner(snapshotOf()).line, '当前 3 个宿舍都正常');
check('calm 时没有理由也没有跨端说明',
  [focusBanner(snapshotOf()).reason, focusBanner(snapshotOf()).cross], ['', '']);
check('★ 没收到快照时也是 calm（不是抛异常）', focusBanner(null).mode, 'calm');

const pb = focusBanner(busySnapshot());
check('有重点、没人点名 -> mode 是 priority', pb.mode, 'priority');
check('priority 的标签是「当前重点」', pb.tag, '当前重点');
check('nodeId 是重点那个宿舍', pb.nodeId, 'dorm-b');
check('status 原样来自快照', pb.status, '偏热');
check('★ 那一行是「宿舍｜处理到哪一步｜温度往哪走」', pb.line, 'dorm-b｜处理中｜温度正在下降');
check('★ 理由就是 core 写的那句（一个字的加工都没有）', pb.reason, '已连续偏热 20 分钟（3 次）');
check('没点名时没有跨端补充（「重点是 X」已经写在理由里了）', pb.cross, '');

/* 8-3 那条分工：状态名**不进**那一行（图标和颜色单独表意）。
   进了的话，这一行会变成「dorm-b｜偏热｜处理中｜温度正在下降」——
   四个词挤在一起，扫一眼反而看不出哪个是重点。 */
check('★★ 那一行里没有状态名（「偏热」由图标 + 颜色说，不挤进正文）',
  pb.line.indexOf('偏热'), -1);

/* 没有处理动作、历史也不够两条时，那一行只剩宿舍名 ——
   不补一个「—」也不补一句「正常」，宁可短。 */
const plain = focusBanner(snapshotOf({
  priority: { nodeId: 'dorm-a', status: '偏湿', reason: '已连续偏湿 3 分钟（3 次）' },
  nodes: [nodeRow('dorm-a', { status: '偏湿', history: [] }), nodeRow('dorm-b'),
    nodeRow('dorm-c')],
}));
check('★ 没有处理动作、历史也不够两条时，那一行就是宿舍名',
  plain.line, 'dorm-a');
check('这条也是 priority', plain.mode, 'priority');

/* 只要有两条历史，那一行就会多出趋势那半句 —— 上面那条之所以「只剩宿舍名」，
   是因为历史不够，不是因为趋势那一节被删了。 */
const withTrend = focusBanner(snapshotOf({
  priority: { nodeId: 'dorm-a', status: '偏湿', reason: 'x' },
  nodes: [nodeRow('dorm-a', { status: '偏湿', history: [
    { time: '2026-09-22 20:29:00', temperature: 26, humidity: 80 },
    { time: '2026-09-22 20:30:00', temperature: 25, humidity: 81 }] }),
  nodeRow('dorm-b'), nodeRow('dorm-c')],
}));
check('★ 有两条历史才多出趋势那半句', withTrend.line, 'dorm-a｜温度正在下降');

const fb = focusBanner(busySnapshot({
  focus: { nodeId: 'dorm-c', by: 'mobile', at: '2026-09-22 20:32:00' },
}));
check('有人点名 -> mode 是 focus', fb.mode, 'focus');
check('标签是「跨端焦点」', fb.tag, '跨端焦点');
check('nodeId 是被点名那个（不是重点那个）', fb.nodeId, 'dorm-c');
check('★ 理由是「谁点的名」', fb.reason, '跨端焦点：mobile 发来的 focus 指令');
check('★ 跨端补充里说清了 core 排出来的重点是谁、凭什么',
  fb.cross, '数据选出的重点是 dorm-b：已连续偏热 20 分钟（3 次）');
check('被点名的宿舍状态也照实给（dorm-c 正常）', fb.status, '正常');

const sameOne = focusBanner(busySnapshot({
  focus: { nodeId: 'dorm-b', by: 'mobile' },
}));
check('★ 点名的正好是重点那个 -> 理由用 core 写的那句（不说两遍）',
  sameOne.reason, '已连续偏热 20 分钟（3 次）');
check('★ 这种情况下跨端补充说的是「也是它」', sameOne.cross, '数据选出的重点也是它');
check('跟数据选出来的一致时，模式仍然是 focus（是人点的就该说是人点的）',
  sameOne.mode, 'focus');

const noPriority = focusBanner(snapshotOf({
  focus: { nodeId: 'dorm-c', by: 'mobile' }, priority: null,
}));
check('★ 有人点名、但此刻没有任何重点 -> 跨端补充明说这件事',
  noPriority.cross, '此刻没有需要关注的异常节点');
check('没有重点时理由仍然是「谁点的名」', noPriority.reason,
  '跨端焦点：mobile 发来的 focus 指令');
check('没有重点时 mode 还是 focus', noPriority.mode, 'focus');

check('★ focus.by 缺失时兜一句「别的端」（不写 undefined）',
  focusBanner(snapshotOf({ focus: { nodeId: 'dorm-c' } })).reason,
  '跨端焦点：别的端 发来的 focus 指令');
check('★ focus.by 是空串时也兜住',
  focusBanner(snapshotOf({ focus: { nodeId: 'dorm-c', by: '' } })).reason,
  '跨端焦点：别的端 发来的 focus 指令');
check('★ 点名的宿舍还没收到数据 -> status 是 null（页面据此画中性色），不是硬编一个「正常」',
  focusBanner(snapshotOf({ focus: { nodeId: 'dorm-c', by: 'mobile' },
    nodes: [nodeRow('dorm-a'), nodeRow('dorm-b'),
      nodeRow('dorm-c', { status: null })] })).status, null);
check('★ 点名的宿舍根本不在名单里（core 改了配置）也照样能显示这个名字',
  focusBanner(snapshotOf({ focus: { nodeId: 'dorm-x', by: 'mobile' } })).line, 'dorm-x');

/* 【和 alertLine 必须指向同一个宿舍】两处各自挑一遍「被点名 > 是重点」，
   挑法要是走岔了，屏幕上就会出现「横幅写着 dorm-c、语音念着 dorm-b」——
   两条出口说的话不一样，而两边看着都对。 */
[
  ['只有重点', busySnapshot()],
  ['只有焦点', snapshotOf({ focus: { nodeId: 'dorm-c', by: 'mobile' } })],
  ['焦点和重点不同', busySnapshot({ focus: { nodeId: 'dorm-c', by: 'mobile' } })],
  ['焦点和重点相同', busySnapshot({ focus: { nodeId: 'dorm-b', by: 'mobile' } })],
  ['都没有', snapshotOf()],
].forEach(function (pair) {
  const banner = focusBanner(pair[1]);
  const line = alertLine(pair[1]);
  check('★ ' + pair[0] + '：横幅和语音说的是同一个宿舍',
    banner.nodeId === null ? line.indexOf('宿舍') > 0 : line.indexOf(banner.nodeId) === 0, true);
});

/* ---------- J. alertLine ---------- */

console.log('\n=== J. alertLine ===');

check('★ 平静时就是 calmLine 加个句号',
  alertLine(snapshotOf()), '当前 3 个宿舍都正常。');
check('没收到快照时也成一句话', alertLine(null), '还没有收到 core 的快照。');
check('★ 异常 + 处理中 + 在降温，整句读得通',
  alertLine(busySnapshot()),
  'dorm-b 偏热已持续 20 分钟（已按下开始处理，处理中），温度正在下降。');
check('★ 正常节点的 durationText 是 null，所以不会有「已持续」那半句',
  alertLine(snapshotOf({ priority: { nodeId: 'dorm-a', status: '正常', reason: 'x' },
    nodes: [nodeRow('dorm-a', { history: [] }), nodeRow('dorm-b'), nodeRow('dorm-c')] })),
  'dorm-a 正常。');
check('没开案的时候不说处理的事',
  alertLine(snapshotOf({ priority: { nodeId: 'dorm-b', status: '偏热',
    reason: 'x' }, nodes: [nodeRow('dorm-a'), nodeRow('dorm-b', { status: '偏热',
    durationText: '5 分钟', history: [] }), nodeRow('dorm-c')] })),
  'dorm-b 偏热已持续 5 分钟。');
check('★ 开了案还没人动 -> 「（已开案，还没人处理）」',
  alertLine(snapshotOf({
    priority: { nodeId: 'dorm-b', status: '偏热', reason: 'x' },
    nodes: [nodeRow('dorm-a'), nodeRow('dorm-b', { status: '偏热', history: [] }),
      nodeRow('dorm-c')],
    events: { summary: {}, events: [eventRow({ nodeId: 'dorm-b', state: 'OPEN' })] } })),
  'dorm-b 偏热（已开案，还没人处理）。');
/* ★ 这一条顺带钉住一件事：**状态是从节点那一行读的**，不是从 priority 里读的。
   priority 是 core 排重点时写下的那份副本，节点那一行才是权威 ——
   两份要是不一致（节点已经恢复了、priority 还停在旧的），页面按节点那一行说。 */
check('★ 还没收到数据的宿舍 -> 念「还没有收到数据」，不念「正常」',
  alertLine(snapshotOf({ priority: { nodeId: 'dorm-c', status: null, reason: 'x' },
    nodes: [nodeRow('dorm-a'), nodeRow('dorm-b'),
      nodeRow('dorm-c', { status: null, history: [] })] })),
  'dorm-c 还没有收到数据。');
check('★ 状态读的是节点那一行，不是 priority 里那份副本',
  alertLine(snapshotOf({ priority: { nodeId: 'dorm-b', status: '偏热', reason: 'x' } })),
  'dorm-b 正常，温度持平。');
check('★ 每一句都以句号收尾（语音那边靠这个断句）',
  alertLine(busySnapshot()).slice(-1), '。');
check('★ 念的是人话，没有 ｜ 那种只给眼睛看的符号',
  alertLine(busySnapshot()).indexOf('｜'), -1);
/* 「持续多久」直接用 core 算好的 durationText，这边不碰秒数 ——
   格式化只留一份，不然会同时存在「20 分钟」和「1200 秒」两个说法。 */
check('★ 念出来的是 core 给的 durationText（不是这边用 durationSec 重算的）',
  alertLine(snapshotOf({ priority: { nodeId: 'dorm-b', status: '偏热', reason: 'x' },
    nodes: [nodeRow('dorm-a'), nodeRow('dorm-b', { status: '偏热',
      durationSec: 1200, durationText: '不到 1 分钟' }), nodeRow('dorm-c')] }))
    .indexOf('不到 1 分钟') > 0, true);

/* ---------- K. speakLine（Phase6 E2：「朗读状态」念的那两句） ---------- */

console.log('\n=== K. speakLine ===');

check('★ 平静时和 alertLine 一样：calmLine 加个句号',
  speakLine(snapshotOf()), '当前 3 个宿舍都正常。');
check('没收到快照时也成一句话', speakLine(null), '还没有收到 core 的快照。');

/* 【主体那一条】温湿度必须**念出来**，而且是快照里那两个数。
   E2 的要求是「朗读内容从 state 全局快照实时获取选中节点的温湿度、状态、事件」
   —— 只念「偏热」的话，31℃ 和 39℃ 听起来一模一样。 */
check('★ 异常 + 处理中：温湿度 / 状态 / 时长 / 事件四样都在',
  speakLine(busySnapshot()),
  'dorm-b 温度 31 摄氏度，湿度 60%，偏热，已持续 20 分钟。'
  + '事件处理中，之后又收到 2 条异常。');

/* 「实时」两个字靠这条守着：换一份快照，念出来的数字就得跟着变。
   写死一份文本的话（不管是写死在页面里还是写死在这个函数里），这里立刻红。 */
check('★ 换一份快照，念的就是新的读数（不是写死的那句）',
  speakLine(busySnapshot({
    nodes: [nodeRow('dorm-a'), nodeRow('dorm-b', { status: '偏热',
      temperature: 36.5, humidity: 41, durationText: '3 分钟' }), nodeRow('dorm-c')],
  })),
  'dorm-b 温度 36.5 摄氏度，湿度 41%，偏热，已持续 3 分钟。事件处理中，'
  + '之后又收到 2 条异常。');

/* 点了名就念那一个 —— 「查看 dorm-b」之后紧跟着一句「朗读状态」，
   听的人要的是 dorm-b，不是 core 排出来的那个重点。 */
check('★ 传了 nodeId 就念它，不管焦点和重点是谁',
  speakLine(busySnapshot({ priority: { nodeId: 'dorm-c', status: '正常', reason: 'x' } }),
    'dorm-c'),
  'dorm-c 温度 25 摄氏度，湿度 60%，正常。没有未结案的事件。');
check('★ 传的 nodeId 前后有空格也认（页面上那个值是从 DOM 里读出来的）',
  speakLine(busySnapshot(), ' dorm-b ').indexOf('dorm-b 温度') === 0, true);
check('★ 传了个空串 / 空白 -> 当没传，回到「被点名 > 是重点」',
  speakLine(busySnapshot(), '   ').indexOf('dorm-b 温度') === 0, true);
check('★ 传的 nodeId 和焦点都在时，传进来的那个优先',
  speakLine(busySnapshot({ focus: { nodeId: 'dorm-c', by: 'mobile' } }), 'dorm-b')
    .indexOf('dorm-b 温度') === 0, true);

/* 【不能拿别人的读数冒充】点了一个 core 还没收到数据的宿舍，要如实说，
   不能退回去念重点那个 —— 那等于把「dorm-b 什么情况」答成了「dorm-a 什么情况」，
   而听的人分不出这个区别。 */
check('★ 点名那个还没收到数据 -> 如实说，不去念别人的读数',
  speakLine(snapshotOf({ nodes: [nodeRow('dorm-a'), nodeRow('dorm-b'),
    nodeRow('dorm-c', { status: null })] }), 'dorm-c'),
  'dorm-c 还没有收到数据，core 那边还没有它的读数。');
check('★ 点名那个压根不在名单里（core 改了配置）也这么说，不是崩掉',
  speakLine(snapshotOf(), 'dorm-x'),
  'dorm-x 还没有收到数据，core 那边还没有它的读数。');
check('★ 「还没有收到数据」不等于「正常」',
  speakLine(snapshotOf({ priority: { nodeId: 'dorm-c', status: null, reason: 'x' },
    nodes: [nodeRow('dorm-a'), nodeRow('dorm-b'),
      nodeRow('dorm-c', { status: null, history: [] })] })).indexOf('正常'), -1);

/* 事件那一段的三种情形。 */
check('★ 开了案没人动 -> 「事件待处理，还没有人按开始处理」',
  speakLine(snapshotOf({
    priority: { nodeId: 'dorm-b', status: '偏热', reason: 'x' },
    nodes: [nodeRow('dorm-a'), nodeRow('dorm-b', { status: '偏热', temperature: 33,
      humidity: 55, history: [] }), nodeRow('dorm-c')],
    events: { summary: {}, events: [eventRow({ nodeId: 'dorm-b', state: 'OPEN' })] } })),
  'dorm-b 温度 33 摄氏度，湿度 55%，偏热。事件待处理，还没有人按开始处理。');
check('★ 没有未结案的事件 -> 如实说，不编一句「正常」',
  speakLine(snapshotOf({ priority: { nodeId: 'dorm-b', status: '正常', reason: 'x' } })),
  'dorm-b 温度 25 摄氏度，湿度 60%，正常。没有未结案的事件。');
/* 事件那一段读的是**事件表**，不是节点的 status：处理之后连着几条正常、
   还没到恢复条数时，status 已经是「正常」而案卷还开着 —— 那时候念「正常」
   是对，念「没有未结案的事件」就错了。 */
check('★ status 是「正常」但案卷还开着的时候，事件那一段说的是案卷',
  speakLine(snapshotOf({
    priority: { nodeId: 'dorm-b', status: '正常', reason: 'x' },
    events: { summary: {}, events: [eventRow({ nodeId: 'dorm-b', state: 'HANDLING',
      action: '开启风扇 / 通风', abnormalAfter: 1 })] } })),
  'dorm-b 温度 25 摄氏度，湿度 60%，正常。事件处理中，之后又收到 1 条异常。');

/* 【E2 新加的那半句】现场快照张数，用的是 core 报的 cameraCount。 */
check('★ 拍了照之后念得出张数',
  speakLine(snapshotOf({
    priority: { nodeId: 'dorm-b', status: '偏热', reason: 'x' },
    nodes: [nodeRow('dorm-a'), nodeRow('dorm-b', { status: '偏热', temperature: 34,
      humidity: 70, history: [] }), nodeRow('dorm-c')],
    events: { summary: {}, events: [eventRow({ nodeId: 'dorm-b', state: 'OPEN',
      cameraCount: 2 })] } })),
  'dorm-b 温度 34 摄氏度，湿度 70%，偏热。事件待处理，还没有人按开始处理，'
  + '已登记 2 张现场快照。');
check('★ 一张都没拍就不提这半句（不然每次都先念一句「0 张」）',
  speakLine(busySnapshot()).indexOf('现场快照'), -1);
/* 旧版 core 的快照里没有 cameraCount。缺了它得当成「这一帧没带这个数」，
   而不是让 JS 把 undefined 念成「已登记 undefined 张现场快照」。 */
check('★ 事件里没有 cameraCount 字段（旧版 core）也不会念出 undefined',
  speakLine(snapshotOf({
    priority: { nodeId: 'dorm-b', status: '偏热', reason: 'x' },
    events: { summary: {}, events: [{ nodeId: 'dorm-b', state: 'OPEN' }] } }))
    .indexOf('undefined'), -1);

/* 长什么样：两个句子，句号收尾，没有 ｜。
   【两句不是一个长句】念的时候中间不留缝，听的人抓不住哪儿是数字、哪儿是状态。 */
check('★ 每一句都以句号收尾（语音那边靠这个断句）',
  speakLine(busySnapshot()).slice(-1), '。');
check('★ 两个句子（温湿度一句、事件一句）',
  speakLine(busySnapshot()).split('。').length - 1, 2);
check('★ 念的是人话，没有 ｜ 那种只给眼睛看的符号',
  speakLine(busySnapshot()).indexOf('｜'), -1);

/* 【和 focusBanner 说的是同一个宿舍】三处（横幅 / alertLine / speakLine）各挑一遍
   「被点名 > 是重点」，挑法走岔了就会出现「横幅写着 dorm-c、念出来的却是 dorm-b」——
   两条出口说的话不一样，而两边看着都对。不传 nodeId 时才谈得上挑。 */
[
  ['只有重点', busySnapshot()],
  ['只有焦点', snapshotOf({ focus: { nodeId: 'dorm-c', by: 'mobile' } })],
  ['焦点和重点不同', busySnapshot({ focus: { nodeId: 'dorm-c', by: 'mobile' } })],
  ['焦点和重点相同', busySnapshot({ focus: { nodeId: 'dorm-b', by: 'mobile' } })],
  ['都没有', snapshotOf()],
].forEach(function (pair) {
  const banner = focusBanner(pair[1]);
  const line = speakLine(pair[1]);
  check('★ ' + pair[0] + '：横幅和朗读念的是同一个宿舍',
    banner.nodeId === null ? line.indexOf('宿舍') > 0 : line.indexOf(banner.nodeId) === 0, true);
});

/* ---------- L. snapshotSummary（日志里那一行） ---------- */

console.log('\n=== L. snapshotSummary ===');

check('没收到快照', snapshotSummary(null), '还没有收到快照');
check('★ 整行', snapshotSummary(busySnapshot()),
  '快照 v2 · 宿舍 3（异常 1） · 重点 dorm-b · 事件 8（未结案 1）'
  + ' · 拒绝 1 · 指令 2');
check('★ 有焦点时末尾补一句', snapshotSummary(busySnapshot({
  focus: { nodeId: 'dorm-c', by: 'mobile' } })),
  '快照 v2 · 宿舍 3（异常 1） · 重点 dorm-b · 事件 8（未结案 1）'
  + ' · 拒绝 1 · 指令 2 · 焦点 dorm-c');
check('★ 没焦点时不补那一句（不是「焦点 无」）',
  snapshotSummary(snapshotOf()).indexOf('焦点'), -1);
check('没有重点时写「重点 无」', snapshotSummary(snapshotOf()),
  '快照 v2 · 宿舍 3（异常 0） · 重点 无 · 事件 0（未结案 0） · 拒绝 0 · 指令 0');
check('★ 一个宿舍都没数据时「异常」是 0（不知道 ≠ 异常）',
  snapshotSummary(snapshotOf({ nodes: [nodeRow('dorm-a', { status: null })] }))
    .indexOf('宿舍 1（异常 0）') > 0, true);
check('★ summary 里缺字段时报 0 不报 NaN', snapshotSummary(snapshotOf({
  events: { summary: {}, events: [] }, rejects: {}, counters: {} })),
  '快照 v2 · 宿舍 3（异常 0） · 重点 无 · 事件 0（未结案 0） · 拒绝 0 · 指令 0');
check('★ 「未结案」是 OPEN + HANDLING 两个加起来（不是只看 OPEN）',
  snapshotSummary(snapshotOf({ events: { summary: { total: 9, OPEN: 2, HANDLING: 3 },
    events: [] } })).indexOf('（未结案 5）') > 0, true);
check('★ 版本号读的是快照里的 v（不是这边写死的 2）',
  snapshotSummary(snapshotOf({ v: 2 })).indexOf('快照 v2') === 0, true);

/* ---------- M. buildMlNote / mlFetchFailed（Rule-ML 那一段） ---------- */

console.log('\n=== M. buildMlNote / mlFetchFailed ===');

const ML_OK = {
  text: '规则和 ML 在这份数据上大体一致，只有少数几条对不上。',
  mismatchForward: 2,
  mismatchReverse: 1,
  generatedAt: '2026-09-22 21:00:00',
  newFile: 'data/sim_log.csv',
  newRows: 300,
  historyFile: 'data/history.csv',
  historyRows: 1200,
};

check('★ 结论那句是从 JSON 里原样搬的（看板不另写一句）',
  buildMlNote(ML_OK).text, ML_OK.text);
check('★ 条数两个方向分开报',
  buildMlNote(ML_OK).count, '规则说正常、ML 说不同：2 条；规则说异常、ML 说正常：1 条');
check('反向是 0 时只报正向',
  buildMlNote(Object.assign({}, ML_OK, { mismatchReverse: 0 })).count,
  '规则说正常、ML 说不同：2 条');
check('正向是 0 时只报反向',
  buildMlNote(Object.assign({}, ML_OK, { mismatchForward: 0, mismatchReverse: 3 })).count,
  '规则说异常、ML 说正常：3 条');
check('★ 一条都没差时也有一句话（不是空白）',
  buildMlNote(Object.assign({}, ML_OK, { mismatchForward: 0, mismatchReverse: 0 })).count,
  '规则和 ML 一条都没差');
check('★ 说明里点明判的是哪份文件、几条', buildMlNote(ML_OK).note,
  '这一段判的不是看板上这些实时读数，是 sim_log.csv（300 条）；'
  + '模型是拿 history.csv（1200 条）训练的。它是 2026-09-22 21:00:00 那次'
  + '跑 analysis.py 留下的，不是实时数据。');
check('★ 说明里写明了「不是实时数据」（少了这句，看板上那些实时数字会背锅）',
  buildMlNote(ML_OK).note.indexOf('不是实时数据') > 0, true);
check('★ 路径被剥成文件名（本机全路径不许露到页面上）',
  buildMlNote(Object.assign({}, ML_OK, { newFile: 'C:\\Users\\xdj\\data\\sim_log.csv' }))
    .note.indexOf('C:\\Users') , -1);
check('文件名缺失时说「那两份文件」，不写 undefined',
  buildMlNote(Object.assign({}, ML_OK, { newFile: null })).note.indexOf('那两份文件') > 0, true);
check('★ 条数缺失时说「若干」而不是 0（0 是「一条都没有」，是另一回事）',
  buildMlNote(Object.assign({}, ML_OK, { newRows: null })).note.indexOf('（若干 条）') > 0, true);
check('生成时刻缺失时说「上一次」',
  buildMlNote(Object.assign({}, ML_OK, { generatedAt: null })).note
    .indexOf('它是 上一次跑 analysis.py') > 0, true);
check('结论那句前后的空白被收拾掉',
  buildMlNote(Object.assign({}, ML_OK, { text: '  一句话  ' })).text, '一句话');

function badShape(data) {
  const note = buildMlNote(data);
  return [note.count, note.note];
}
check('★ null（文件里是个 null）', badShape(null), ['', '']);
check('★ 空对象', badShape({}), ['', '']);
check('★ text 不是字符串', badShape({ text: 3, mismatchForward: 1 }), ['', '']);
check('★ text 是空串', badShape({ text: '   ', mismatchForward: 1 }), ['', '']);
check('★ mismatchForward 不是数字', badShape({ text: 'x', mismatchForward: null }), ['', '']);
check('★ 字段缺了时那句降级话点明了原因',
  buildMlNote({}).text.indexOf('report/ml_result.json 里没有 analysis.py 该写的字段') > 0, true);
check('降级话里也带着「这一段没跑」这个口径（和报告里那句一致）',
  buildMlNote({}).text.indexOf('这一段没跑') === 0, true);

check('★ 读不到时说的是「读不到 + 原因」',
  mlFetchFailed('HTTP 404').text, '这一段没跑：读不到 report/ml_result.json —— HTTP 404');
check('★ 原因原样贴出来（「HTTP 404」和「读不到」指向完全不同的排查方向）',
  mlFetchFailed('Unexpected token < in JSON at position 0').text
    .indexOf('Unexpected token <') > 0, true);
check('原因缺失时兜一句「不知道什么原因」',
  mlFetchFailed('').text.indexOf('不知道什么原因') > 0, true);
check('原因不是字符串时也兜住',
  mlFetchFailed(null).text.indexOf('不知道什么原因') > 0, true);
check('★ 降级时条数那一栏是空的（不是 0）', mlFetchFailed('x').count, '');
check('★ 降级时说明里告诉人怎么补（跑一次 analysis.py），并点明看板其余部分不受影响',
  mlFetchFailed('x').note.indexOf('analysis/analysis.py') > 0
    && mlFetchFailed('x').note.indexOf('看板其余部分不受影响') > 0, true);

/* ---------- N. cmdNote ---------- */

console.log('\n=== N. cmdNote（按下「开始处理」之后那行字）===');

const sent = cmdNote(true);
check('★ 发出去时点明「好没好由 core 判，这一步不结案」',
  sent.indexOf('由 core 后续收到的报文判') > 0, true);
check('★ 而且说了「这一步不结案」（红线写在人看得见的地方）',
  sent.indexOf('这一步不结案') > 0, true);
check('★ 并且预先说明「处理中」要等 core 发回新快照才出现（免得以为点了没反应）',
  sent.indexOf('要等 core 发回新快照') > 0, true);
check('★ 不提「已恢复」两个字（那不是点出来的）',
  sent.indexOf('已恢复'), -1);

const failed = cmdNote(false, '还没连上 broker');
check('★ 发不出去时把原因原样贴出来',
  failed.indexOf('还没连上 broker') > 0, true);
check('★ 并且明说「这一次点击没有任何效果」（页面不替 core 记账）',
  failed.indexOf('没有任何效果') > 0, true);
check('失败时不说「已记下这一笔」之类的话（页面不记账）',
  failed.indexOf('记下这一笔'), -1);
check('原因缺失时兜一句', cmdNote(false, '').indexOf('不知道什么原因') > 0, true);
check('原因不是字符串时也兜住', cmdNote(false, null).indexOf('不知道什么原因') > 0, true);

/* ---------- O. 纯函数：不改输入 ---------- */

console.log('\n=== O. 纯函数 ===');

/* 【为什么用「跑完再比一遍 JSON」而不是 Object.freeze】
   freeze 只在严格模式下才抛，而 logic.js 不是严格模式（它是个普通模块，
   顶层没有 'use strict'）—— 冻结之后赋值会**静默失败**，测试照样绿。
   所以改成前后各序列化一次对比：不管什么模式，改过的字段一定看得出来。 */
const before = JSON.stringify(busySnapshot({ focus: { nodeId: 'dorm-c', by: 'mobile' } }));
const frozen = busySnapshot({ focus: { nodeId: 'dorm-c', by: 'mobile' } });
focusBanner(frozen);
alertLine(frozen);
speakLine(frozen);
speakLine(frozen, 'dorm-b');
snapshotSummary(frozen);
calmLine(frozen);
actionState(frozen, 'dorm-b');
handlingOf(frozen, 'dorm-b');
fanOn(frozen, 'dorm-b');
openEvent(frozen, 'dorm-b');
latestEvent(frozen, 'dorm-b');
nodeOf(frozen, 'dorm-b');
readSnapshot(frozen);
check('★ 把这些函数全跑一遍，那一份快照一个字节都没变',
  JSON.stringify(frozen), before);

/* 同一个输入两次调用结果一样 —— 纯函数的定义。挑几个会拼字符串的验：
   要是在里面偷偷读了时间或者存了缓存，两次就会不一样。 */
const twice = busySnapshot();
check('★ focusBanner 两次调用一模一样',
  JSON.stringify(focusBanner(twice)) === JSON.stringify(focusBanner(twice)), true);
check('★ alertLine 两次调用一模一样', alertLine(twice), alertLine(twice));
check('★ speakLine 两次调用一模一样', speakLine(twice), speakLine(twice));
check('★ snapshotSummary 两次调用一模一样',
  snapshotSummary(twice), snapshotSummary(twice));

/* ---------- P. 变异：改坏一处，看抓不抓得住 ---------- */

console.log('\n=== P. 变异（真跑一遍，不是看代码猜）===');

/* 「横幅的理由必须是 core 给的那串字」——理由要是这边拼的，改一下快照里的
   reason，横幅就该跟着变。不变就说明那句话是写死在代码里的。 */
const r1 = focusBanner(busySnapshot({ priority: { nodeId: 'dorm-b', status: '偏热',
  reason: '理由甲' } })).reason;
const r2 = focusBanner(busySnapshot({ priority: { nodeId: 'dorm-b', status: '偏热',
  reason: '理由乙' } })).reason;
check('★ 改快照里的 reason，横幅的理由跟着变（不是写死的）', [r1, r2], ['理由甲', '理由乙']);

/* 「异常个数是数出来的」——多一个异常宿舍，那句平静话就该变。 */
check('★ 多一个异常宿舍，calmLine 跟着变（不是写死「都正常」）',
  calmLine(snapshotOf({ nodes: [nodeRow('dorm-a'), nodeRow('dorm-b', { status: '偏暖' }),
    nodeRow('dorm-c')] })).indexOf('另有 1 个异常') > 0, true);

/* 「那一行是照着字段拼的」——给 dorm-b 加一笔待处理动作，line 里就多一段。 */
check('★ 给事件改成 OPEN，横幅那一行里就没有「处理中」了',
  focusBanner(busySnapshot({ events: { summary: { total: 1 },
    events: [eventRow({ nodeId: 'dorm-b', state: 'OPEN' })] } })).line
    .indexOf('处理中'), -1);

/* 「状态来自快照，不是算的」——把快照里的 status 换成没人见过的词，
   页面照搬。反过来，要是这边有判断，就会把它改回「正常」或者丢掉。 */
const typhoon = snapshotOf({
  priority: { nodeId: 'dorm-a', status: '台风', reason: 'x' },
  nodes: [nodeRow('dorm-a', { status: '台风', history: [] }), nodeRow('dorm-b'),
    nodeRow('dorm-c')],
});
check('★ 快照说「台风」，页面就显示「台风」（一个字的判断都没有）',
  focusBanner(typhoon).status, '台风');
check('★ 快照说「台风」，语音也念「台风」',
  alertLine(typhoon), 'dorm-a 台风。');

/* 「温湿度是快照里那两个数，不是这边写的」——把读数换掉，念出来的跟着换。
   这条和上面那条是一对：上面守状态词，这条守数字。数字比状态词更容易被写死
   （演示时好看的那个数），所以它单独钉一条。 */
const readA = speakLine(busySnapshot({
  nodes: [nodeRow('dorm-a'), nodeRow('dorm-b', { status: '偏热', temperature: 31,
    humidity: 60, history: [] }), nodeRow('dorm-c')] }));
const readB = speakLine(busySnapshot({
  nodes: [nodeRow('dorm-a'), nodeRow('dorm-b', { status: '偏热', temperature: 39,
    humidity: 88, history: [] }), nodeRow('dorm-c')] }));
check('★ 把快照里的温湿度换掉，念出来的数字跟着变（不是写死的）',
  [readA.indexOf('温度 31 摄氏度，湿度 60%') > 0,
    readB.indexOf('温度 39 摄氏度，湿度 88%') > 0], [true, true]);
check('★ 而且换掉之后原来那两个数就不在了',
  [readA.indexOf('39'), readA.indexOf('88')], [-1, -1]);
/* 颜色那一档认不出来就退回中性色（dashboard.js 的 viewFor），
   所以「台风」这个状态下页面依然画得出来，只是没有状态色 ——
   这正是「前端不认识规则」该有的样子：多一个状态名不会让页面崩，
   也不会被页面悄悄改回「正常」。 */

console.log(`\n结果：${pass} 通过，${fail} 不通过`);
process.exit(fail === 0 ? 0 : 1);
