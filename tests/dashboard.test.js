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
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    _classes: classes,
    addEventListener() {},
  };
}

const els = {};
['cards', 'log-body', 'log-count', 'detail-node', 'detail-meta', 'chart-note',
  'simulate', 'clear', 'chart-temp', 'chart-humidity'].forEach((id) => { els[id] = makeEl(id); });

const chartsBox = makeEl('charts');

/* 打桩也要给回和 style.css 里一样的值，不然测不出颜色有没有接错 */
const PALETTE = {
  '--chart-temp': '#2a78d6',
  '--chart-humidity': '#c9407f',
  '--chart-grid': 'rgba(11, 11, 11, 0.08)',
  '--text-muted': '#898781',
  '--surface-1': '#fcfcfb',
};

const documentStub = {
  documentElement: makeEl('html'),
  getElementById: (id) => els[id] || makeEl(id),
  querySelector: (sel) => (sel === '.charts' ? chartsBox : makeEl(sel)),
  querySelectorAll: () => [],
  addEventListener() {},
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

const context = {
  document: documentStub,
  Chart: ChartStub,
  getComputedStyle: () => ({ getPropertyValue: (n) => PALETTE[n] || '' }),
  window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
  console,
  JSON, Math, Date, Number, Object, Array, String, Set, isNaN, parseInt,
};
context.globalThis = context;
context.window.document = documentStub;

/* ---------- 加载 shared/rules.js，再加载 dashboard.js ---------- */
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'shared', 'rules.js'), 'utf8'), context,
  { filename: path.join(ROOT, 'shared', 'rules.js') });

let src = fs.readFileSync(path.join(ROOT, 'dashboard', 'dashboard.js'), 'utf8');
/* 只加测试钩子，不改原文件 */
src += `
;globalThis.__nodes = nodes;
globalThis.__messages = messages;
globalThis.__simulate = simulate;
globalThis.__clearAll = clearAll;
globalThis.__selectNode = selectNode;
globalThis.__current = function () { return currentNodeId; };
globalThis.__topicNode = topicNode;
`;
vm.runInContext(src, context, { filename: path.join(ROOT, 'dashboard', 'dashboard.js') });

const { handleMessage, __nodes: nodes, __messages: messages, __simulate: simulate,
  __clearAll: clearAll, __selectNode: selectNode, __current: current,
  __topicNode: topicNode } = context;

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? `  =>  ${a}` : `\n        实际: ${a}\n        期望: ${e}`));
}
function mk(nodeId, t, h, status) {
  return JSON.stringify({
    nodeId, temperature: t, humidity: h,
    status: status === undefined ? context.judgeStatus(t, h) : status,
    time: '2026-09-22 20:30:00',
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
const okD = handleMessage('dormmate/dorm-a/env', mk('dorm-a', 17, 50));
check('收下了', okD, true);
check('dorm-a 变 4 条', nodes['dorm-a'].history.length, 4);
check('dorm-a 最新一条是 17℃', nodes['dorm-a'].latest.temperature, 17);
check('dorm-a 最新状态是偏冷', nodes['dorm-a'].latest.status, '偏冷');
check('dorm-b 一条没动', JSON.stringify(nodes['dorm-b'].history) === beforeB, true);
check('dorm-c 一条没动', JSON.stringify(nodes['dorm-c'].history) === beforeC, true);

/* ============ E. 脏数据必须被拦下 ============ */
console.log('\n=== E. 校验：脏数据 ===');
const badCases = [
  ['不是 JSON', 'dormmate/dorm-a/env', '{不是 json', 'error'],
  ['空字符串', 'dormmate/dorm-a/env', '', 'error'],
  ['顶层是 null', 'dormmate/dorm-a/env', 'null', 'error'],
  ['顶层是数字', 'dormmate/dorm-a/env', '123', 'error'],
  ['顶层是数组', 'dormmate/dorm-a/env', '[1,2,3]', 'error'],
  ['缺 nodeId', 'dormmate/dorm-a/env', '{"temperature":25,"humidity":60,"status":"正常","time":"t"}', 'error'],
  ['缺 temperature', 'dormmate/dorm-a/env', '{"nodeId":"dorm-a","humidity":60,"status":"正常","time":"t"}', 'error'],
  ['缺 humidity', 'dormmate/dorm-a/env', '{"nodeId":"dorm-a","temperature":25,"status":"正常","time":"t"}', 'error'],
  ['缺 status', 'dormmate/dorm-a/env', '{"nodeId":"dorm-a","temperature":25,"humidity":60,"time":"t"}', 'error'],
  ['缺 time', 'dormmate/dorm-a/env', '{"nodeId":"dorm-a","temperature":25,"humidity":60,"status":"正常"}', 'error'],
  ['temperature 是字符串', 'dormmate/dorm-a/env', '{"nodeId":"dorm-a","temperature":"25","humidity":60,"status":"正常","time":"t"}', 'error'],
  ['humidity 是 null', 'dormmate/dorm-a/env', '{"nodeId":"dorm-a","temperature":25,"humidity":null,"status":"正常","time":"t"}', 'error'],
  ['temperature 是 NaN', 'dormmate/dorm-a/env', '{"nodeId":"dorm-a","temperature":null,"humidity":60,"status":"正常","time":"t"}', 'error'],
  ['未知节点', 'dormmate/dorm-x/env', mk('dorm-x', 25, 60), 'error'],
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
const okF = handleMessage('dormmate/dorm-a/env', mk('dorm-a', 31, 80, '偏湿'));   // 约定里点名的坑
check('说偏湿、规则算偏热 -> 仍然收下', okF, true);
check('一条报文只记一行日志', messages.length - nF, 1);
check('日志级别是 warn', top().level, 'warn');
check('日志点明了两个值', /收到「偏湿」.*规则算出「偏热」/.test(top().text), true);
check('存下来的是规则结果「偏热」', nodes['dorm-a'].latest.status, '偏热');

handleMessage('dormmate/dorm-b/env', mk('dorm-b', 16, 60, '正常'));
check('说正常、规则算偏冷 -> warn', top().level, 'warn');
check('存下来的是偏冷', nodes['dorm-b'].latest.status, '偏冷');

handleMessage('dormmate/dorm-b/env', mk('dorm-b', 25, 60, '正常'));
check('status 一致时不报警', top().level, 'ok');

/* ============ G. topic 与 nodeId 不一致 ============ */
console.log('\n=== G. topic 和报文里的节点对不上 ===');
const nG = messages.length;
const okG = handleMessage('dormmate/dorm-a/env', mk('dorm-c', 25, 80));
check('仍然收下（节点以报文为准）', okG, true);
check('仍然只记一行日志', messages.length - nG, 1);
check('日志级别是 warn', top().level, 'warn');
check('提示点明了两个节点名', /topic 里是 dorm-a，报文里是 dorm-c/.test(top().text), true);
check('写进了报文说的 dorm-c', nodes['dorm-c'].latest.temperature, 25);
check('没写进 topic 说的 dorm-a', nodes['dorm-a'].latest.temperature, 31);

console.log('\n=== H. topic 形状不对时不误报 ===');
check('topicNode 正常', topicNode('dormmate/dorm-a/env'), 'dorm-a');
check('topicNode 形状不对返回空串', topicNode('随便什么'), '');
check('topicNode 对 null 不炸', topicNode(null), '');
handleMessage('随便什么', mk('dorm-a', 25, 60));
check('形状不对的 topic 不产生额外 warn', top().level, 'ok');

/* ============ I. 历史上限 ============ */
console.log('\n=== I. 历史上限 ===');
clearAll();
for (let i = 0; i < 60; i += 1) handleMessage('dormmate/dorm-a/env', mk('dorm-a', 20 + (i % 5), 50));
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

console.log(`\n结果：${pass} 通过，${fail} 不通过`);
process.exit(fail === 0 ? 0 : 1);
