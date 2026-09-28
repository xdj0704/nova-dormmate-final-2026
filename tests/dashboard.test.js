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
  'simulate', 'clear', 'chart-temp', 'chart-humidity',
  'conn', 'conn-text', 'toggle'].forEach((id) => { els[id] = makeEl(id); });

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
  const rec = { hostId, statuses: [], labels: [], disposed: 0 };
  sceneCalls.push(rec);
  return {
    /* 真的那个也会返回「实际生效的状态」，所以桩照做 ——
       renderScene 拿它的返回值拼标签文字。 */
    updateScene(status) { rec.statuses.push(status); return status; },
    setLabel(text) { rec.labels.push(text); return text; },
    setFanOn() {},
    dispose() { rec.disposed += 1; },
  };
}

const context = {
  document: documentStub,
  Chart: ChartStub,
  mqtt: mqttStub,
  createDorm3D: createDorm3DStub,
  location: { hostname: 'localhost' },
  getComputedStyle: () => ({ getPropertyValue: (n) => PALETTE[n] || '' }),
  window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
  console,
  JSON, Math, Date, Number, Object, Array, String, Set, isNaN, parseInt,
};
context.globalThis = context;
context.window.document = documentStub;

/* ---------- 加载 shared/rules.js，再加载 dashboard.js ---------- */

/* Step 6-3 起 dashboard.js 是 ES 模块（它 import 了 ../3d/scene.js），
   而 vm.runInContext 只能跑普通脚本 —— 原样喂进去会抛
   「Cannot use import statement outside a module」。

   处理方式和 tests/scene3d.test.js 里改写 'three' 那个标识符是一个思路：
   把 import 那一行摘掉，改用上下文里同名的打桩函数顶上。
   摘之前先数一遍，必须正好一条；将来谁再加一条 import，这里立刻炸出来，
   而不是把那条也悄悄摘了、测了个假的。

   注意这只是**跑起来**的方式。原文件里到底怎么写的那一行，
   由下面 J 段的两条静态断言盯着（正则 + 文件真的在）。 */
const SCENE_IMPORT = /^import\s*\{\s*createDorm3D\s*\}\s*from\s*'\.\.\/3d\/scene\.js';\s*$/m;
const DASH_SRC = path.join(ROOT, 'dashboard', 'dashboard.js');
const importCount = (fs.readFileSync(DASH_SRC, 'utf8').match(/^import\s/gm) || []).length;

vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'shared', 'rules.js'), 'utf8'), context,
  { filename: path.join(ROOT, 'shared', 'rules.js') });

let src = fs.readFileSync(DASH_SRC, 'utf8');
src = src.replace(SCENE_IMPORT, '/* import 已摘除：顶上用的是上下文里的 createDorm3D 打桩 */\n');
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
`;
vm.runInContext(src, context, { filename: DASH_SRC });

const { handleMessage, __nodes: nodes, __messages: messages, __simulate: simulate,
  __clearAll: clearAll, __selectNode: selectNode, __current: current,
  __topicNode: topicNode, __connect: connect, __disconnect: disconnect,
  __renderScene: renderScene } = context;

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

/* ============ K. MQTT 接线 ============ */
console.log('\n=== K. MQTT 接线 ===');
check('打开页面就连了 Broker', mqttStub.clients.length, 1);
const mc = mqttStub.clients[0];
check('连的地址由页面 hostname 拼出来', mc.url, 'ws://localhost:9001');
check('还没握手成功时不订阅', mc.subscribed, []);
check('刚打开时状态是「连接中…」', els['conn-text'].textContent, '连接中…');

/* 模拟 Broker 握手成功 */
mc.handlers.connect.forEach((fn) => fn());
check('连上后订阅 dormmate/+/env', mc.subscribed, ['dormmate/+/env']);
check('状态变成「已连接」', els['conn-text'].textContent, '已连接');
check('指示灯切到绿色那档', els.conn.className, 'conn conn--on');

/* 真投一条 MQTT 消息进来 —— 这一步的核心：消息要一路走到 handleMessage */
clearAll();
mc.handlers.message.forEach((fn) => fn('dormmate/dorm-b/env', JSON.stringify({
  nodeId: 'dorm-b', temperature: 31, humidity: 60, status: '偏热', time: '2026-09-22 20:30:00',
})));
check('MQTT 消息落到了 dorm-b', nodes['dorm-b'].history.length, 1);
check('就是那条 31℃', nodes['dorm-b'].latest.temperature, 31);
check('dorm-a 没被牵连', nodes['dorm-a'].history.length, 0);
check('dorm-c 没被牵连', nodes['dorm-c'].history.length, 0);
check('日志级别 ok', top().level, 'ok');

/* 走 MQTT 进来的脏数据，被同一条链路拦下 */
mc.handlers.message.forEach((fn) => fn('dormmate/dorm-b/env', '{坏掉的 json'));
check('MQTT 来的脏 JSON 被拦下', top().level, 'error');
check('拦下后没写进历史', nodes['dorm-b'].history.length, 1);

/* 原始报文要往 Console 打一行（排错用）。
   把 console.log 临时换成收集器 —— 不换的话每跑一次测试都要刷一大片屏。
   注意 ctx 里传的就是 Node 的 console 本身，所以要还原回去。 */
const realLog = console.log;
const logged = [];
console.log = (...args) => { logged.push(args); };
mc.handlers.message.forEach((fn) => fn('dormmate/dorm-c/env', JSON.stringify({
  nodeId: 'dorm-c', temperature: 25, humidity: 80, status: '偏湿', time: '2026-09-22 20:30:00',
})));
console.log = realLog;

check('每条原始报文打一行 Console', logged.length, 1);
check('打印的是 topic', logged[0][1], 'dormmate/dorm-c/env');
check('打印的是原始报文原文，不是解析后的对象',
  logged[0][2], '{"nodeId":"dorm-c","temperature":25,"humidity":80,"status":"偏湿","time":"2026-09-22 20:30:00"}');

/* 被拦下的报文更要打印 —— 排错时最需要的就是这一条 */
console.log = (...args) => { logged.push(args); };
mc.handlers.message.forEach((fn) => fn('dormmate/dorm-c/env', '{又一条坏 json'));
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
check('第二根也订阅同样的 topic', mc2.subscribed, ['dormmate/+/env']);
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

check('★ dashboard.js 只有一条 import（下面摘 import 靠的是正则，多一条会被一起摘掉）',
  importCount, 1);
check('★ 那条 import 拿的是 ../3d/scene.js 里的 createDorm3D（不是 3d/index.html 里那份拷贝）',
  SCENE_IMPORT.test(fs.readFileSync(DASH_SRC, 'utf8')), true);
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

/* --- 只画当前选中的那个节点 --- */

clearAll();
check('★ 清空后 3D 立刻退回「还没有收到数据」', lastLabel().includes('还没有收到数据'), true);
check('清空后场景退回「正常」', lastStatus(), '正常');

/* C 段留下的当前节点是 dorm-b。这时喂一条 dorm-a 的：
   数据要收下，画面一个字都不能动。 */
const nStatus = scene.statuses.length;
const nLabel = scene.labels.length;
handleMessage('dormmate/dorm-a/env', mk('dorm-a', 31, 60));
check('dorm-a 的数据收下了', nodes['dorm-a'].latest.status, '偏热');
check('★ 不是当前节点的消息：3D 一次都没被调', scene.statuses.length, nStatus);
check('★ 覆盖层也一个字没动（还写着 dorm-b）', scene.labels.length, nLabel);

/* 切过去：不用等新数据，立刻画出它那条的样子 */
selectNode('dorm-a');
check('★ 切到已有数据的节点，立刻画出它的状态', lastStatus(), '偏热');
check('★ 覆盖层写明是哪个宿舍的哪个状态',
  lastLabel().includes('dorm-a') && lastLabel().includes('偏热'), true);
check('覆盖层把读数也带上（标签上不必再回头找卡片）',
  lastLabel().includes('31℃') && lastLabel().includes('60%'), true);

/* 反方向再来一遍，确认不是「第一次刚好对了」 */
const n2 = scene.statuses.length;
handleMessage('dormmate/dorm-b/env', mk('dorm-b', 25, 80));
check('★ 当前是 dorm-a，dorm-b 的消息同样不改画面',
  scene.statuses.length, n2);
selectNode('dorm-b');
check('★ 切到 dorm-b，画的是它自己的偏湿', lastStatus(), '偏湿');

const n3 = scene.statuses.length;
handleMessage('dormmate/dorm-b/env', mk('dorm-b', 16, 60));
check('★ 当前节点收到新消息，画面跟着变', lastStatus(), '偏冷');
check('确实重画了（不是恰好在上一行就画好了）', scene.statuses.length > n3, true);

/* --- status 复核的结果才交给 3D --- */

handleMessage('dormmate/dorm-b/env', mk('dorm-b', 31, 60, '正常'));   // 报文里故意写错
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
handleMessage('dormmate/dorm-a/env', mk('dorm-a', 16, 60));
selectNode('dorm-c');
check('★ 切到没收到数据的节点：退回「正常」的外观', lastStatus(), '正常');
check('★ 覆盖层如实写「还没有收到数据」，不沿用上一个节点的偏冷',
  lastLabel().includes('dorm-c') && lastLabel().includes('还没有收到数据'), true);

selectNode('dorm-a');
check('★ 切回有数据的节点，状态又回来了（不是只有第一次切才画）', lastStatus(), '偏冷');

/* --- 脏数据不污染画面 --- */

clearAll();
handleMessage('dormmate/dorm-a/env', mk('dorm-a', 25, 60));
const n5 = scene.statuses.length;
console.error = () => {};
handleMessage('dormmate/dorm-a/env', '这不是 JSON');
handleMessage('dormmate/dorm-a/env', JSON.stringify({ nodeId: 'dorm-a', humidity: 60 }));
handleMessage('dormmate/dorm-a/env', mk('dorm-z', 31, 60));
console.error = realError;
check('★ 三条脏数据一条都没改到画面', scene.statuses.length, n5);
check('画面还是那条干净数据的「正常」', lastStatus(), '正常');

/* ============ L. 没加载 mqtt.js（现场没网的情况）============ */
console.log('\n=== L. 没加载 mqtt.js ===');
const els2 = {};
['cards', 'log-body', 'log-count', 'detail-node', 'detail-meta', 'chart-note',
  'simulate', 'clear', 'chart-temp', 'chart-humidity',
  'conn', 'conn-text', 'toggle'].forEach((id) => { els2[id] = makeEl(id); });

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
  /* 这里故意让 3D 建不起来（模拟这台设备没有 WebGL）：
     和 mqtt 那条一起，凑成「两个依赖同时缺」的最坏情况 ——
     页面照样得起来。initScene3D 的 try/catch 就是为这个写的。 */
  createDorm3D: () => { throw new Error('这台设备没有可用的 WebGL'); },
  location: { hostname: 'localhost' },
  /* 故意不给 mqtt —— 模拟 vendor/mqtt.min.js 没下载到 */
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
  /* 只把 error 静音：initScene3D 捕到异常后会 console.error 一行，
     那是**预期行为**，不是测试失败。log 留着，方便排查。 */
  console: { log: console.log, warn: console.warn, error: () => {} },
  JSON, Math, Date, Number, Object, Array, String, Set, isNaN, parseInt,
};
ctx2.globalThis = ctx2;
ctx2.window.document = doc2;

let src2 = fs.readFileSync(DASH_SRC, 'utf8');
src2 = src2.replace(SCENE_IMPORT, '/* import 已摘除，理由同上 */\n');
src2 += ';globalThis.__simulate = simulate;\nglobalThis.__renderScene = renderScene;\n';

vm.createContext(ctx2);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'shared', 'rules.js'), 'utf8'), ctx2);
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

console.log(`\n结果：${pass} 通过，${fail} 不通过`);
process.exit(fail === 0 ? 0 : 1);
