// tests/scene3d-page.test.js
// 校验 three/index.html 里那段 <script type="module">：MQTT 驱动 3D 的那一半（Step 6-3）。
//
// 跑的不是另写一份的等价代码，是**直接从 HTML 里抠出来那段脚本**，
// 所以「页面上真正跑的东西」和「测的东西」不可能对不上。
// 抠出来之后唯一动过的地方是把 import 那一行摘掉（vm 跑不了 import），
// 换成同名的打桩函数 —— 和 tests/scene3d.test.js 改写 'three' 是一个思路。
//
// 重点盯一件事：**画面跟的是「当前选中的宿舍」，不是「最后一个发消息的宿舍」**。
// 三个宿舍的数据混在同一个通配符 topic 里进来，不筛的话 dorm-b 一来
// 画面就变成 dorm-b，而覆盖层上还写着 dorm-a —— 屏幕上看着挺正常。
//
// 跑法：node tests/scene3d-page.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML_FILE = path.join(ROOT, 'three', 'index.html');
const RULES_FILE = path.join(ROOT, 'shared', 'rules.js');

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? `  =>  ${a}` : `\n        实际: ${a}\n        期望: ${e}`));
}

const html = fs.readFileSync(HTML_FILE, 'utf8');

/* ---------- 把那段脚本抠出来 ---------- */

/* 剥注释之后再找标签，免得匹配到注释里写的示例 ——
   scene3d.test.js 那节就踩过这个坑（注释里写着「position: relative」，
   不剥的话「是不是真写了」永远为真）。 */
const bare = html
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const MODULE_TAG = '<script type="module">';
const tagCount = bare.split(MODULE_TAG).length - 1;
const moduleMatch = bare.match(/<script type="module">([\s\S]*?)<\/script>/);

/* ---------- 静态：接线本身 ---------- */

console.log('=== A. index.html 的接线 ===');

check('★ 内联的 module 脚本只有一处（多一处就是复制粘贴留了一份没删）', tagCount, 1);
check('抠到了那段脚本', !!moduleMatch, true);

let pageSrc = moduleMatch ? moduleMatch[1] : '';

/* 这一段在 HTML 里是缩进过的（前后各有四个空格），所以开头的 \s* 不能省 ——
   dashboard.test.js 里那条同样的正则能用，是因为那边的 import 顶着行首。 */
const SCENE_IMPORT = /^[ \t]*import\s*\{\s*createDorm3D\s*\}\s*from\s*'\.\/scene\.js';?[ \t]*$/m;
check('★ 脚本 import 了 ./scene.js 的 createDorm3D',
  SCENE_IMPORT.test(pageSrc), true);
check('整个 HTML 里就这一条 import（多一条上面那个正则就摘不干净）',
  (pageSrc.match(/^\s*import\s/gm) || []).length, 1);

/* shared/rules.js 必须是普通 script：它是个 IIFE，挂全局函数，没有 export。
   在模块里 import 它拿到的是 undefined，judgeStatus 一调就炸。 */
const rulesTag = '<script src="../shared/rules.js"></script>';
check('★ shared/rules.js 是普通 script 引入的（它没有 export，import 进来是 undefined）',
  bare.indexOf(rulesTag) >= 0, true);
check('★ 而且排在模块脚本之前（模块里才调得到 judgeStatus）',
  bare.indexOf(rulesTag) >= 0 && bare.indexOf(rulesTag) < bare.indexOf(MODULE_TAG), true);
check('★ mqtt.js 也是普通 script，同样排在模块脚本之前',
  /<script src="\.\.\/dashboard\/lib\/mqtt\.min\.js"><\/script>/.test(bare)
  && bare.indexOf('../dashboard/lib/mqtt.min.js') < bare.indexOf(MODULE_TAG), true);
check('订阅的是 dormmate/v1/nodes/+/telemetry',
      /['"]dormmate\/v1\/nodes\/\+\/telemetry['"]/.test(pageSrc), true);
check('Broker 地址带 9001 端口', /:9001/.test(pageSrc), true);

/* 按钮从 HTML 里读出来，测的就是页面上真正有的那几个 ——
   手写一份 ['dorm-a','dorm-b','dorm-c'] 的话，HTML 里少写一个也测不出来。 */
const statusValues = [...bare.matchAll(/data-status=["']([^"']+)["']/g)].map((m) => m[1]);
const nodeValues = [...bare.matchAll(/data-node=["']([^"']+)["']/g)].map((m) => m[1]);
check('★ 有 3 个宿舍按钮，正好是约定的 dorm-a/b/c',
  nodeValues.join(','), 'dorm-a,dorm-b,dorm-c');
check('6-2 留下的 4 个手动预览按钮还在',
  statusValues.join(','), '正常,偏冷,偏热,偏湿');

/* ---------- 打桩 ---------- */

/* three/scene.js 的桩：把交给 3D 的状态和写进覆盖层的文字按顺序记下来。
   不记的话，「到底有没有把消息交给 updateScene」根本测不出来。 */
const scene = { hostId: null, statuses: [], labels: [] };
function createDorm3DStub(hostId) {
  scene.hostId = hostId;
  return {
    updateScene(status) { scene.statuses.push(status); return status; },
    setLabel(text) { scene.labels.push(text); return text; },
    setFanOn() {},
    dispose() {},
  };
}

/* mqtt.js 的桩：记下连的地址、订阅的 topic，并留着回调由测试主动触发 */
const mqttStub = {
  clients: [],
  connect(url, opts) {
    const handlers = {};
    const c = {
      url, opts, handlers, subscribed: [],
      on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return c; },
      subscribe(topic, o, cb) { c.subscribed.push(topic); if (cb) cb(null); return c; },
      end() { return c; },
    };
    mqttStub.clients.push(c);
    return c;
  },
};

/* 按钮桩。classList.toggle 收两个参数（和真的 DOM 一样），
   不实现 force 的话 is-active 的高亮根本测不了。 */
function makeBtn(dataset) {
  const on = new Set();
  return {
    dataset,
    handlers: {},
    classList: {
      toggle(c, force) { if (force) on.add(c); else on.delete(c); },
      contains: (c) => on.has(c),
    },
    addEventListener(ev, fn) { this.handlers[ev] = fn; },
    click() { if (this.handlers.click) this.handlers.click(); },
  };
}

const statusButtons = statusValues.map((v) => makeBtn({ status: v }));
const nodeButtons = nodeValues.map((v) => makeBtn({ node: v }));
const els = { conn: { className: '' }, 'conn-text': { textContent: '' } };

const documentStub = {
  querySelectorAll(sel) {
    if (sel.indexOf('data-status') >= 0) return statusButtons;
    if (sel.indexOf('data-node') >= 0) return nodeButtons;
    return [];
  },
  getElementById: (id) => els[id] || { className: '', textContent: '' },
};

/* console 的 warn 要收起来：下面有几条是「故意喂脏数据」，
   那些警告是**预期行为**，不该刷屏，但断言要能看到它们。 */
const warns = [];
const consoleStub = {
  warn: (...a) => warns.push(a.map(String).join(' ')),
  error: (...a) => warns.push(a.map(String).join(' ')),
  log: () => {},
};

const context = {
  createDorm3D: createDorm3DStub,
  mqtt: mqttStub,
  document: documentStub,
  location: { hostname: 'localhost' },
  console: consoleStub,
  JSON, Math, Date, Number, Object, Array, String, Set, isNaN, parseInt,
};
context.globalThis = context;

/* ---------- 跑起来 ---------- */

pageSrc = pageSrc.replace(SCENE_IMPORT,
  '/* import 已摘除：顶上用的是上下文里的 createDorm3D 打桩 */\n');

vm.createContext(context);
vm.runInContext(fs.readFileSync(RULES_FILE, 'utf8'), context,
  { filename: RULES_FILE });
vm.runInContext(pageSrc, context, { filename: HTML_FILE });

const client = mqttStub.clients[0];
const lastStatus = () => scene.statuses[scene.statuses.length - 1];
const lastLabel = () => scene.labels[scene.labels.length - 1];

/* 投递一条报文。走的是页面真正注册的那个 message 回调。 */
function deliver(topic, obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  client.handlers.message.forEach((fn) => fn(topic, Buffer.from(text)));
}
/* 按统一规则拼一条合法报文；status 默认由规则算，也可以故意写错 */
function mk(nodeId, t, h, status) {
  return {
    nodeId, temperature: t, humidity: h,
    status: status === undefined ? context.judgeStatus(t, h) : status,
    time: '2026-09-29 20:30:00',
  };
}
/* 点按钮 */
const clickNode = (id) => nodeButtons.find((b) => b.dataset.node === id).click();
const clickStatus = (s) => statusButtons.find((b) => b.dataset.status === s).click();

/* ---------- B. 启动 ---------- */

console.log('\n=== B. 启动 ===');

check('页面起来时建了一个 3D 场景', scene.hostId, 'scene');
check('打开页面就连了 Broker', mqttStub.clients.length, 1);
check('★ 连的地址由页面 hostname 拼出来（本机就是 ws://localhost:9001）',
  client.url, 'ws://localhost:9001');
check('还没握手成功时不订阅', client.subscribed, []);

client.handlers.connect.forEach((fn) => fn());
check('★ 连上后订阅 dormmate/v1/nodes/+/telemetry', client.subscribed,
      ['dormmate/v1/nodes/+/telemetry']);
check('连接状态文字里有地址（连错机器时一眼看得出来）',
  els['conn-text'].textContent.includes('9001'), true);
check('连接状态切到「已连接」那档', els.conn.className, 'conn is-on');

check('★ 打开时摆的是 dorm-a（多节点页面，得先选一个）', lastLabel().includes('dorm-a'), true);
check('★ 这时还没有数据，覆盖层如实写「还没有收到数据」', lastLabel().includes('还没有收到数据'), true);
check('初始场景退回「正常」的外观', lastStatus(), '正常');
check('dorm-a 的按钮是高亮的', nodeButtons[0].classList.contains('is-active'), true);

/* 这时候三个宿舍都还没收到任何数据。挨个切一遍，都得如实说「还没有收到数据」，
   不能凭空画一个状态出来 —— 页面刚打开那几秒就是这个状态，
   画的要是上一个宿舍的样子，看的人会以为数据已经来了。 */
clickNode('dorm-b');
check('★ 切到没收到数据的节点：退回「正常」的外观', lastStatus(), '正常');
check('★ 覆盖层如实写「还没有收到数据」',
  lastLabel().includes('dorm-b') && lastLabel().includes('还没有收到数据'), true);
check('切过去之后高亮也跟着走', nodeButtons[1].classList.contains('is-active'), true);
clickNode('dorm-a');
check('切回 dorm-a 也一样（没数据就说没数据）',
  lastLabel().includes('dorm-a') && lastLabel().includes('还没有收到数据'), true);

/* ---------- C. 只画当前选中的那个节点 ---------- */

console.log('\n=== C. 只画当前选中的那个节点 ===');

/* 当前是 dorm-a。喂一条 dorm-b 的：数据要收下，画面一个字都不能动。 */
const nS = scene.statuses.length;
const nL = scene.labels.length;
deliver('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 31, 60));
check('★ 不是当前节点的消息：3D 一次都没被调', scene.statuses.length, nS);
check('★ 覆盖层也一个字没动', scene.labels.length, nL);
check('覆盖层上还是 dorm-a', lastLabel().includes('dorm-a'), true);

/* 现在喂当前节点的 */
deliver('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 25, 80));
check('★ 当前节点的消息：画面跟着变', lastStatus(), '偏湿');
check('★ 覆盖层写的是当前宿舍名 + 状态',
  lastLabel().includes('dorm-a') && lastLabel().includes('偏湿'), true);

/* 反方向再确认一遍，排除「第一次刚好对了」 */
const nS2 = scene.statuses.length;
deliver('dormmate/v1/nodes/dorm-c/telemetry', mk('dorm-c', 16, 60));
check('★ dorm-c 的消息同样不改画面', scene.statuses.length, nS2);
check('画面还是 dorm-a 的偏湿', lastStatus(), '偏湿');

/* ---------- D. 切节点 ---------- */

console.log('\n=== D. 切节点 ===');

/* dorm-c 上面刚喂过一条（偏冷），切过去应该立刻画出来，不用等新数据 */
clickNode('dorm-c');
check('★ 切到已有数据的节点，立刻画出它那条的状态', lastStatus(), '偏冷');
check('★ 覆盖层跟着换成 dorm-c', lastLabel().includes('dorm-c'), true);
check('dorm-c 的按钮高亮了', nodeButtons[2].classList.contains('is-active'), true);
check('dorm-a 的按钮不再高亮', nodeButtons[0].classList.contains('is-active'), false);

/* 切过去之后，dorm-c 的消息才开始改画面 */
const nS3 = scene.statuses.length;
deliver('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 31, 60));
check('★ 切到 dorm-c 之后，dorm-a 的消息就不该再改画面了',
  scene.statuses.length, nS3);
deliver('dormmate/v1/nodes/dorm-c/telemetry', mk('dorm-c', 31, 60));
check('★ 而 dorm-c 的消息现在能改', lastStatus(), '偏热');

/* dorm-b 在 C 段收到过一条 31/60（偏热），D 段这里再喂一条 16/60（偏冷），
   当前是 dorm-c，所以这两条都不该动画面。 */
const nS3b = scene.statuses.length;
deliver('dormmate/v1/nodes/dorm-b/telemetry', mk('dorm-b', 16, 60));
check('★ 还没切过去的时候，dorm-b 的新消息仍然不动画面',
  scene.statuses.length, nS3b);
clickNode('dorm-b');
check('★ 切过去才发现它已经有两条了，画的是**最新那条**（偏冷，不是偏热）',
  lastStatus(), '偏冷');
check('覆盖层换成 dorm-b', lastLabel().includes('dorm-b'), true);

clickNode('dorm-a');
check('★ 切回 dorm-a，状态又回来了（不是只有第一次切才画）', lastStatus(), '偏热');

/* ---------- E. status 一律用 judgeStatus 复核 ---------- */

console.log('\n=== E. status 复核 ===');

warns.length = 0;
deliver('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 31, 80, '偏湿'));   // 约定里点名的坑
check('★ 报文里写「偏湿」，规则算出「偏热」—— 交给 3D 的是「偏热」',
  lastStatus(), '偏热');
check('★ 覆盖层上写的也是「偏热」', lastLabel().includes('偏热'), true);
check('不一致时控制台警告了', warns.some((w) => w.includes('status 不一致')), true);

warns.length = 0;
deliver('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 16, 60, '正常'));
check('说正常、规则算偏冷 -> 交给 3D 的是偏冷', lastStatus(), '偏冷');
check('警告里两个值都写了',
  warns.some((w) => w.includes('正常') && w.includes('偏冷')), true);

warns.length = 0;
deliver('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 25, 60));
check('status 一致时不警告', warns.length, 0);
check('正常就是正常', lastStatus(), '正常');

/* 回归数据四条全过一遍：页面显示的必须和统一规则一致 */
console.log('  -- 回归测试数据 --');
[['dorm-a', 25, 60, '正常'], ['dorm-a', 16, 60, '偏冷'],
  ['dorm-a', 31, 60, '偏热'], ['dorm-a', 25, 80, '偏湿']].forEach((row) => {
  deliver('dormmate/v1/nodes/' + row[0] + '/telemetry', mk(row[0], row[1], row[2]));
  check(`★ ${row[1]}℃ / ${row[2]}% -> ${row[3]}`, lastStatus(), row[3]);
});

/* ---------- F. 脏数据不污染画面 ---------- */

console.log('\n=== F. 脏数据 ===');

const nS4 = scene.statuses.length;
warns.length = 0;
deliver('dormmate/v1/nodes/dorm-a/telemetry', '这不是 JSON');
deliver('dormmate/v1/nodes/dorm-a/telemetry', JSON.stringify({ nodeId: 'dorm-a', humidity: 60 }));
deliver('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', '31', 60));
deliver('dormmate/v1/nodes/dorm-z/telemetry', mk('dorm-z', 31, 60));
check('★ 四条脏数据一条都没改到画面', scene.statuses.length, nS4);
check('画面还是那条干净数据的样子', lastStatus(), '偏湿');
check('每条脏数据都报了原因', warns.length, 4);

deliver('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 31, 60));
check('★ 脏数据之后，正常报文照样能进（没被卡死）', lastStatus(), '偏热');

/* ---------- G. 手动预览按钮没被 MQTT 挤掉 ---------- */

console.log('\n=== G. 手动预览（6-2 的功能还在）===');

warns.length = 0;
clickStatus('偏冷');
check('★ 点手动按钮照样能改画面（没 Broker 时靠它演示）', lastStatus(), '偏冷');
check('★ 覆盖层写明这是手动预览，不冒充真实数据',
  lastLabel().includes('手动预览'), true);
check('状态按钮的高亮跟着手动点的那个走',
  statusButtons[1].classList.contains('is-active'), true);

deliver('dormmate/v1/nodes/dorm-a/telemetry', mk('dorm-a', 25, 80));
check('★ 来一条真数据就把手动预览顶掉', lastStatus(), '偏湿');
check('★ 「手动预览」这几个字也跟着没了', lastLabel().includes('手动预览'), false);
check('高亮回到偏湿那个按钮上',
  statusButtons[3].classList.contains('is-active'), true);

/* 不认识的 status 交给 scene.js 去警告 —— 页面这边不二次加工状态值 */
warns.length = 0;
clickStatus('正常');
check('页面把 data-status 原样交出去（认不出来的值由 scene.js 警告）',
  lastStatus(), '正常');

console.log(`\n结果：${pass} 通过，${fail} 不通过`);
process.exit(fail === 0 ? 0 : 1);
