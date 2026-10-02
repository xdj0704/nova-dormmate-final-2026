'use strict';

/**
 * three/index.html 那个页面的测试（Step E1-4）。纯 Node，零依赖。
 *
 * 【跑的到底是不是真东西】跑的是**从 HTML 里抠出来那段 <script type="module">**，
 * 加上它真正 import 的那几个**真文件**：
 *
 *   page.mjs               HTML 里那段脚本，逐字节搬过来（只改了文件位置）
 *   ./world.js             真的（它 import 的 'three' 改写成假模块）
 *   ./room.js              真的（同上）
 *   ./lib/CSS2DRenderer.js 假的（见 tests/helpers/fake-three.js 头上那段）
 *   ../dashboard/logic.js  真的 —— readSnapshot / openEvent / focusBanner 和看板、
 *                          手机是**同一份**，所以「同一帧快照在几块屏幕上永远是
 *                          同一句话」这件事是真的被验到了
 *   ../shared/config.js    真的（用 vm 求值一遍，topic 全从它那儿来）
 *
 * 摆法是把仓库的形状照抄进临时目录：
 *
 *   tmp/package.json
 *   tmp/three/page.mjs  world.js  room.js  three-stub.mjs  lib/CSS2DRenderer.js
 *   tmp/dashboard/logic.js
 *
 * 于是页面里那些相对 import（'./world.js' / '../dashboard/logic.js'）**一个字
 * 都不用改**，走的就是线上那几条路径。用 vm 求值 config.js 而不是 import 它，
 * 是因为它本来就是个没有 export 的 IIFE（页面里也是普通 <script> 引的）。
 *
 * 【这个文件盯的三件事】
 *   1) 只订阅 dormmate/v1/state —— 别的 topic 上来的东西一律当没看见
 *   2) 节点名单、状态、谁是重点、焦点是谁，全部来自快照；页面一个判断都不做
 *   3) **点房间只发指令，画面一个字都不改**（红线）：镜头什么时候飞，
 *      由 core 发回来的下一帧快照说了算
 *
 * 第 3 条是这一步最容易写错的地方 —— 本地先把镜头挪过去看着「更跟手」，
 * 但那正是 E3 硬约束里点名的「伪造同步」。
 *
 * 跑法：node tests/scene3d-page.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const { writeFakeThree, makeEl, installGlobals } = require('./helpers/fake-three.js');

const ROOT = path.join(__dirname, '..');
const HTML_FILE = path.join(ROOT, 'three', 'index.html');
const WORLD_FILE = path.join(ROOT, 'three', 'world.js');
const ROOM_FILE = path.join(ROOT, 'three', 'room.js');
const LOGIC_FILE = path.join(ROOT, 'dashboard', 'logic.js');
const CONFIG_FILE = path.join(ROOT, 'shared', 'config.js');

const STATE_TOPIC = 'dormmate/v1/state';
const CMD_TOPIC = 'dormmate/v1/cmd';

/* console.log 要留给页面用（它自己会打几行日志），所以先抓一份出来报结果。 */
const out = console.log.bind(console);
console.log = function () {};

let pass = 0;
let fail = 0;

function check(label, cond, extra) {
  if (cond) {
    pass++;
    out('  ok   ' + label);
  } else {
    fail++;
    out('  FAIL ' + label + (extra === undefined ? '' : '   实际：' + extra));
  }
}

/* ================= A. 静态：这个页面的接线 ================= */

const html = fs.readFileSync(HTML_FILE, 'utf8');
const pageSrc = (html.match(/<script type="module">([\s\S]*?)<\/script>/) || ['', ''])[1];

/* 整份 HTML 剥掉注释。找 <script> 标签、查 CSS 用这一份 ——
   注释里出现过「dormmate/v1/nodes/+/telemetry」这种字面量，不剥的话
   下面那条「页面里没有 topic 字面量」永远是红的（而且红得没道理）。 */
const bare = html
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/* 再窄一层：只留那段模块脚本、且剥掉块注释。查「页面逻辑里有没有写死什么」
   用这一份 —— 这一层必须剥，不然注释里那些「这里没有 18/30/75」的说明
   会把检查搞红。 */
const code = pageSrc.replace(/\/\*[\s\S]*?\*\//g, '');

const MODULE_TAG = '<script type="module">';

out('A. index.html 的接线');

check('★ 内联的 module 脚本只有一处（多一处就是复制粘贴留了一份没删）',
  bare.split(MODULE_TAG).length - 1 === 1,
  bare.split(MODULE_TAG).length - 1 + ' 处');
check('抠到了那段模块脚本', pageSrc.length > 0);

const imports = [...pageSrc.matchAll(/^\s*import\s[\s\S]*?from\s+['"]([^'"]+)['"]/gm)]
  .map((m) => m[1]);
check('import 正好三条', imports.length === 3, imports.join(', '));
check('★ 三条全是相对路径，一个裸名字都没有（页面不直接 import three）',
  imports.length === 3 && imports.every((s) => s.charAt(0) === '.'), imports.join(', '));
check('引的是 ./world.js（三间房的世界）', imports.indexOf('./world.js') >= 0, imports.join(', '));
check('引的是 ./room.js（图例那四个状态名从它的 STATUS / LOOK 来）',
  imports.indexOf('./room.js') >= 0, imports.join(', '));
check('★ 引的是 ../dashboard/logic.js —— 和看板、手机是**同一份**读快照的代码',
  imports.indexOf('../dashboard/logic.js') >= 0, imports.join(', '));
check('三条相对 import 都指得到真文件',
  [WORLD_FILE, ROOM_FILE, LOGIC_FILE].every((p) => fs.existsSync(p)));

/* 页面不再自己复核 status —— 那是 Step 6-3 的做法（前端也算一遍）。
   E1 起快照里的 status 就是 core 算好的，再算一遍等于把同一件事写两份。 */
check('★ 没有引 shared/rules.js、也没有 judgeStatus（页面不自己复核 status）',
  code.indexOf('shared/rules.js') < 0 && code.indexOf('judgeStatus') < 0);
check('★ 页面逻辑里一个温度阈值都没有（判定不在这边）',
  !/\b(18|30|75)\b\s*[)<>]/.test(code)
  && !/humidity\s*[<>]=?/.test(code) && !/temperature\s*[<>]=?/.test(code));
check('★ 没有自己画房间的代码（几何、材质、相机一个字都不在页面里）',
  !/new\s+THREE\./.test(code) && !/BoxGeometry|MeshStandardMaterial|PerspectiveCamera/.test(code));

/* topic 只在 shared/config.js 一处。页面里出现字面量的话，改 topic 要记得改
   两个地方，而漏改的那个不会有任何报错。 */
check('★ 页面逻辑里没有 dormmate/ 开头的 topic 字面量（topic 只在 config.js 一处）',
  code.indexOf('dormmate/') < 0 && pageSrc.indexOf('STATE_TOPIC') >= 0);
check('HTML 正文里点名的那条 topic 是 state（没有把遥测 topic 写进页面）',
  bare.indexOf('dormmate/v1/nodes/') < 0);
check('★ 订阅用的是 CFG.STATE_TOPIC', /subscribe\(\s*CFG\.STATE_TOPIC/.test(pageSrc));
check('★ 发指令用的是 CFG.CMD_TOPIC', /publish\(\s*CFG\.CMD_TOPIC/.test(pageSrc));
check('动作名用的是 CFG.CMD_ACTION_FOCUS（不是手写的字符串）',
  /action:\s*CFG\.CMD_ACTION_FOCUS/.test(pageSrc));
check('★ 指令带 retain: CFG.CMD_RETAIN（config 里是 false，指令不能留）',
  /retain:\s*CFG\.CMD_RETAIN/.test(pageSrc));

check('★ 页面里一个按钮都没有了（6-2/6-3 那四个手动预览按钮删干净了）',
  !/<button/i.test(bare));
check('★ 也没有 data-node / data-status 这类按钮属性了',
  !/data-node=/.test(code) && !/data-status=/.test(code));

/* ---- 引资源的顺序 ---- */

const mqttTag = '<script src="../dashboard/lib/mqtt.min.js"></script>';
const cfgTag = '<script src="../shared/config.js"></script>';
const rulesTag = '<script src="../shared/rules.js"></script>';
const modAt = bare.indexOf(MODULE_TAG);
check('mqtt.js 是普通 script 引的，且排在模块脚本之前',
  bare.indexOf(mqttTag) >= 0 && bare.indexOf(mqttTag) < modAt);
check('★ shared/config.js 是普通 script 引的（它没有 export，import 进来是 undefined）',
  bare.indexOf(cfgTag) >= 0);
check('★ 而且排在模块脚本之前（模块里才读得到 window.DormMateConfig）',
  bare.indexOf(cfgTag) >= 0 && bare.indexOf(cfgTag) < modAt);
check('★ 没有再引 shared/rules.js（少下一个文件，也少一条「前端也算一遍」的旧路）',
  bare.indexOf(rulesTag) < 0);

const map = html.match(/<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/);
check('有 importmap', !!map);
let parsedMap = null;
try { parsedMap = JSON.parse(map[1]); } catch (err) { /* 下面那条报 */ }
check('importmap 里是合法 JSON（所以里面一行注释都写不了）', parsedMap !== null);
const threeUrl = (parsedMap && parsedMap.imports && parsedMap.imports.three) || '';
check('映射了 three', threeUrl.length > 0, threeUrl);
check('three 固定 0.160.0（版本要和 lib/ 里那两份 vendor 文件一致）',
  threeUrl.indexOf('0.160.0') >= 0, threeUrl);
check('指向 build/three.module.js（ESM 那份，不是 three.core.js）',
  threeUrl.indexOf('three.module.js') >= 0, threeUrl);
check('★ 映射表里就只有 three 一条（CSS2DRenderer 走相对路径，不占这张表）',
  parsedMap !== null && Object.keys(parsedMap.imports).join(',') === 'three',
  parsedMap && Object.keys(parsedMap.imports).join(','));
check('importmap 标签出现在 module script 标签之前（顺序反了浏览器不认）',
  html.indexOf('<script type="importmap">') >= 0
  && html.indexOf('<script type="importmap">') < html.indexOf(MODULE_TAG));

/* ---- 容器 ---- */

check('容器元素的 id 和调用时传的一致',
  /id="scene"/.test(html) && /createDormWorld\(\s*['"]scene['"]\s*\)/.test(html));
check('★ #scene 是 position: relative（标签层和画布都绝对定位，靠它定位）',
  /#scene\s*\{[^}]*position:\s*relative/.test(bare));
check('#scene 设了 overflow: hidden（和 setSize 差一像素就会顶出滚动条）',
  /#scene\s*\{[^}]*overflow:\s*hidden/.test(bare));
check('#scene 有确定的高度（高度是 0 的话算不出宽高比）',
  /#scene\s*\{[^}]*height:/.test(bare));
check('#scene 是 cursor: pointer（三间房能点，不提示没人知道）',
  /#scene\s*\{[^}]*cursor:\s*pointer/.test(bare));

/* ---- 标签那层是 world.js 建的，页面只负责上色 ---- */

check('★ CSS 里给 [data-status] 四档都配了色（和移动端 style.css 一个做法）',
  ['正常', '偏冷', '偏热', '偏湿'].every(
    (s) => bare.indexOf('.scene-tag[data-status="' + s + '"]') >= 0));
check('★ 「处理中」那格有 [hidden] { display: none }（world.js 只管开 hidden）',
  /\.tag-handling\[hidden\]\s*\{\s*display:\s*none/.test(bare));
check('焦点那间有单独的记号（.tag-focus），和脉冲光圈长得不一样',
  /\.tag-focus\s*\{/.test(bare)
  && bare.slice(bare.indexOf('.tag-focus')).indexOf('border-color') >= 0);

/* ================= 临时目录：照抄仓库的形状 ================= */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-page-'));
const threeDir = path.join(tmp, 'three');
fs.mkdirSync(threeDir, { recursive: true });
const { stubPath, stubUrl, css2dPath } = writeFakeThree(threeDir);
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}', 'utf8');
fs.mkdirSync(path.join(tmp, 'dashboard'), { recursive: true });
fs.copyFileSync(LOGIC_FILE, path.join(tmp, 'dashboard', 'logic.js'));

for (const pair of [['world.js', WORLD_FILE], ['room.js', ROOM_FILE]]) {
  const src = fs.readFileSync(pair[1], 'utf8');
  const rewritten = src.replace(/from\s+['"]three['"]/, "from '" + stubUrl + "'");
  check(pair[0] + ' 里的 three 被改写成了本地假模块', rewritten !== src);
  fs.writeFileSync(path.join(threeDir, pair[0]), rewritten, 'utf8');
}
fs.writeFileSync(path.join(threeDir, 'page.mjs'), pageSrc, 'utf8');

/* ================= 装假的浏览器环境 ================= */

const extra = {
  conn: makeEl('p'),
  'conn-text': makeEl('span'),
  /* Phase9 D4：3D 页也有一条 core 心跳提示。少了它 getElementById 返回 null，
     renderCoreHint() 会在「Cannot set properties of null」上把整个页面脚本打断 ——
     而那是模块顶层调用，断在哪一步后面全不跑，看着像「3D 页整块坏了」。 */
  'core-hint': makeEl('p'),
  readout: makeEl('p'),
  'readout-reason': makeEl('p'),
  'cmd-note': makeEl('p'),
  legend: makeEl('div'),
};
const env = installGlobals({ id: 'scene', extra: extra, hostname: 'localhost' });

/* 真的 shared/config.js 用 vm 求值一遍 —— topic 一个都不是这边编的。 */
vm.runInThisContext(fs.readFileSync(CONFIG_FILE, 'utf8'), { filename: CONFIG_FILE });
check('★ 跑完了真的 shared/config.js（topic 全从它那儿来）',
  !!(globalThis.DormMateConfig && globalThis.DormMateConfig.STATE_TOPIC === STATE_TOPIC),
  globalThis.DormMateConfig && globalThis.DormMateConfig.STATE_TOPIC);
env.win.DormMateConfig = globalThis.DormMateConfig;

/* mqtt 的桩。页面只用到 connect / on / subscribe / publish 四样。 */
const mqttStub = {
  clients: [],
  connect(url, opts) {
    const handlers = {};
    const c = {
      url: url, opts: opts, handlers: handlers, subscribed: [], published: [], connected: false,
      on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return c; },
      subscribe(topic, o, cb) { c.subscribed.push(topic); if (cb) cb(null); return c; },
      publish(topic, text, o) { c.published.push({ topic: topic, payload: text, opts: o }); return c; },
      end() { return c; },
    };
    mqttStub.clients.push(c);
    return c;
  },
};
globalThis.mqtt = mqttStub;

/* 收集页面自己说的话（它用 console.warn / console.error 报原因）。 */
const said = [];
console.warn = function () { said.push(Array.prototype.join.call(arguments, ' ')); };
console.error = console.warn;
const clearWarns = function () { said.length = 0; };

/* ================= 跑起来 ================= */

let stub = null;
let css2dLog = null;
let worldMod = null;
let roomMod = null;
let client = null;

(async function main() {
  await import(pathToFileURL(path.join(threeDir, 'page.mjs')).href);
  worldMod = await import(pathToFileURL(path.join(threeDir, 'world.js')).href);
  roomMod = await import(pathToFileURL(path.join(threeDir, 'room.js')).href);
  stub = await import(pathToFileURL(stubPath).href);
  css2dLog = (await import(pathToFileURL(css2dPath).href)).log;

  const STATUS = roomMod.STATUS;
  const LOOK = roomMod.LOOK;
  const MAP = worldMod.NODE_MAP;

  const rendererRef = () => stub.log.renderers[0];
  const cam = () => stub.log.cameras[0];
  const raycasterRef = stub.log.raycasters[0];
  const canvas = rendererRef().domElement;

  const roomGroup = (id) => stub.log.groups.find((g) => g.name === id + '-room');
  const partOf = (id, part) => roomGroup(id).findByName(id + '-' + part);
  const floorHex = (id) => partOf(id, 'floor').material.color.hex;
  const fanAngle = (id) => partOf(id, 'fan').rotation.z;
  const ringEl = (id) => partOf(id, 'focus-ring');

  /* 标签是挂在房间 Group 上的 CSS2DObject —— 从外面能拿到的入口只有它。 */
  function tagEl(id) {
    let found = null;
    roomGroup(id).traverse((o) => { if (!found && o.isCSS2DObject) found = o; });
    return found.element;
  }
  const TAG_NODE = 0, TAG_READ = 1, TAG_STATUS = 2, TAG_HANDLING = 3;
  const tagText = (id, i) => tagEl(id).children[i].textContent;
  const tagHidden = (id) => tagEl(id).children[TAG_HANDLING].hidden;
  const isFocused = (id) => tagEl(id).classList.contains('tag-focus');

  function frame() { rendererRef().loop(); }

  /** 走页面真正注册的那个 message 回调（mqtt.js 给的是二进制，所以过一遍 Buffer）。 */
  function deliver(topic, obj) {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    client.handlers.message.forEach((fn) => fn(topic, Buffer.from(text)));
  }

  /** 拼一帧形状合法的快照（readSnapshot 那一关要过）。 */
  function mkSnapshot(o) {
    const s = o || {};
    return {
      v: s.v === undefined ? 2 : s.v,
      time: '2026-09-30 20:30:00',
      focus: s.focus === undefined ? null : s.focus,
      priority: s.priority === undefined ? null : s.priority,
      nodes: s.nodes === undefined ? [] : s.nodes,
      events: s.events === undefined ? { summary: {}, dropped: 0, events: [] } : s.events,
      rejects: s.rejects === undefined ? { total: 0, items: [], reasons: {} } : s.rejects,
      counters: s.counters === undefined ? {} : s.counters,
      /* Phase9 D4：core 心跳那一块。不给（null）就落进「这份快照是旧 core 发的」
         那一档 —— 正是这一页在过渡期的真实处境。 */
      core: s.core === undefined ? null : s.core,
    };
  }

  /** 一帧「core 刚发出来的」快照。 */
  function liveCore() {
    return { online: true, epochMs: Date.now(), staleAfterSec: 15 };
  }

  /** 快照里的一格节点。history 给空数组 —— trendOf 只认两条以上。 */
  function mkNode(nodeId, status, t, h) {
    return {
      nodeId: nodeId, online: true, status: status, temperature: t, humidity: h,
      time: '2026-09-30 20:30:00', abnormalCount: 0, durationSec: 0,
      durationText: '0 秒', reason: '', lastSeen: '2026-09-30 20:30:00',
      historyCount: 1, history: [],
    };
  }

  /** 一条事件。state 就是 core 事件机里的原值。 */
  function mkEvent(nodeId, state) {
    const acted = state === 'HANDLING';
    return {
      eventId: nodeId + '-1', nodeId: nodeId, state: state,
      startTime: '2026-09-30 20:00:00', problem: '偏热',
      priorityTime: '2026-09-30 20:00:00', priorityReason: '',
      action: acted ? 'handle' : null,
      actionTime: acted ? '2026-09-30 20:05:00' : null,
      actionSource: acted ? 'mobile' : null,
      recoverTime: null, endTime: null, result: '',
      abnormalAfter: 0, verifyCount: 0,
    };
  }

  /* ================= B. 启动 ================= */

  out('\nB. 启动');
  check('页面起来时建了三间房的世界',
    stub.log.groups.filter((g) => /^dorm-[abc]-room$/.test(g.name)).length === 3,
    stub.log.groups.filter((g) => /^dorm-[abc]-room$/.test(g.name)).length + ' 间');
  check('标签层只建了一层，世界的节点表就是那三个',
    css2dLog.labelRenderers.length === 1 && worldMod.NODE_IDS.length === 3);
  check('打开页面就连了 Broker', mqttStub.clients.length === 1, mqttStub.clients.length + ' 根');
  client = mqttStub.clients[0];
  check('★ 连的地址按页面 hostname 拼（本机就是 ws://localhost:9001）',
    client.url === 'ws://localhost:9001', client.url);
  check('还没握手成功时不订阅', client.subscribed.length === 0, client.subscribed.join(','));
  check('连接状态那块写的是带地址的「连接中…」',
    env.extra['conn-text'].textContent.indexOf('9001') >= 0,
    env.extra['conn-text'].textContent);

  client.connected = true;
  client.handlers.connect.forEach((fn) => fn());
  check('★ 连上后订阅 dormmate/v1/state（**只订这一条**）',
    client.subscribed.join(',') === STATE_TOPIC, client.subscribed.join(','));
  check('连接状态切到「已连接」那档', env.extra.conn.className === 'conn is-on',
    env.extra.conn.className);
  check('状态文字里带着实际连的地址（连错机器时一眼看得出来）',
    env.extra['conn-text'].textContent.indexOf('已连接') >= 0
    && env.extra['conn-text'].textContent.indexOf('9001') >= 0,
    env.extra['conn-text'].textContent);

  /* 这两条一起看：占位那句话写在 HTML 里（所以假元素是空的 —— 页面在拿到
     快照之前一个字都没往读数条里写），而三间房的标签是 JS 建的，写的是
     「还没有数据」。两处都不假装「正常」。 */
  check('★ 还没收到快照时读数条写着「还没有收到快照…」（这句在 HTML 里，不靠 JS 兜）',
    /id="readout"[^>]*>还没有收到快照/.test(bare));
  check('页面在收到快照之前不往读数条里写任何东西',
    env.extra.readout.textContent === '', JSON.stringify(env.extra.readout.textContent));
  check('★ 三间房都还没有数据（写「—」+「还没有数据」，不假装正常）',
    worldMod.NODE_IDS.every((id) => tagText(id, TAG_READ) === '—'
      && tagText(id, TAG_STATUS) === '还没有数据'),
    worldMod.NODE_IDS.map((id) => tagText(id, TAG_READ) + '/' + tagText(id, TAG_STATUS)).join(' | '));
  check('每间房的标签上都写着自己的 nodeId',
    worldMod.NODE_IDS.every((id) => tagText(id, TAG_NODE) === id));
  check('★ 一开始没有焦点，相机停在总览位',
    cam().position.x === 0 && cam().position.y === 19 && cam().position.z === 27,
    [cam().position.x, cam().position.y, cam().position.z].join(','));
  const startPos = { x: cam().position.x, y: cam().position.y, z: cam().position.z };

  /* ================= C. 快照驱动 ================= */

  out('\nC. 一帧快照摆三间房');

  deliver(STATE_TOPIC, mkSnapshot({
    priority: { nodeId: 'dorm-a', reason: '偏热已持续 20 分钟', score: 3 },
    nodes: [
      mkNode('dorm-a', STATUS.HOT, 31, 60),
      mkNode('dorm-b', STATUS.NORMAL, 25, 60),
      mkNode('dorm-c', STATUS.COLD, 16, 60),
    ],
  }));

  check('★ 三间房的读数来自快照（31℃ / 25℃ / 16℃）',
    tagText('dorm-a', TAG_READ) === '31℃ · 60%'
    && tagText('dorm-b', TAG_READ) === '25℃ · 60%'
    && tagText('dorm-c', TAG_READ) === '16℃ · 60%',
    worldMod.NODE_IDS.map((id) => tagText(id, TAG_READ)).join(' | '));
  check('★ 标签上的状态就是快照里那个字符串',
    tagText('dorm-a', TAG_STATUS) === STATUS.HOT
    && tagText('dorm-b', TAG_STATUS) === STATUS.NORMAL
    && tagText('dorm-c', TAG_STATUS) === STATUS.COLD,
    worldMod.NODE_IDS.map((id) => tagText(id, TAG_STATUS)).join(' | '));
  check('★ 地板颜色跟着状态走（偏热那间红、偏冷那间蓝）',
    floorHex('dorm-a') === LOOK[STATUS.HOT].floor
    && floorHex('dorm-c') === LOOK[STATUS.COLD].floor,
    floorHex('dorm-a') + ' / ' + floorHex('dorm-c'));
  check('三种状态的地板色两两不同（三间房并排时一眼分得清）',
    new Set([floorHex('dorm-a'), floorHex('dorm-b'), floorHex('dorm-c')]).size === 3);
  check('标签上的 data-status 属性也跟着快照走（配色是 CSS 按它挑的）',
    tagEl('dorm-a').getAttribute('data-status') === STATUS.HOT
    && tagEl('dorm-b').getAttribute('data-status') === STATUS.NORMAL,
    tagEl('dorm-a').getAttribute('data-status'));

  check('★ 读数条用的是 focusBanner 的话（和看板顶部、手机大卡片同一个函数）',
    env.extra.readout.textContent.indexOf('dorm-a') >= 0
    && env.extra.readout.textContent.indexOf('当前重点') >= 0,
    env.extra.readout.textContent);
  check('读数条下面那行写的是 core 给的理由',
    env.extra['readout-reason'].textContent === '偏热已持续 20 分钟',
    env.extra['readout-reason'].textContent);

  /* ---- core 心跳（Phase9 D4）----
     3D 这一屏最容易被 retained 快照骗：core 死了，broker 把最后一帧留着，
     页面打开照样收到、房间照样亮着颜色 —— 看着完全「正常」。
     所以这条提示必须写出来，而且颜色变了不算，字得说清楚。 */
  deliver(STATE_TOPIC, mkSnapshot({ core: liveCore(), nodes: [mkNode('dorm-a', STATUS.HOT, 31, 60)] }));
  check('★ core 在发帧时说「在线」',
    env.extra['core-hint'].textContent.indexOf('core 在线') === 0,
    env.extra['core-hint'].textContent);
  check('★ 那行不带 is-stale（只有过期才染色）',
    env.extra['core-hint'].className.indexOf('is-stale') < 0,
    env.extra['core-hint'].className);

  deliver(STATE_TOPIC, mkSnapshot({
    core: { online: true, epochMs: Date.now() - 60000, staleAfterSec: 15 },
    nodes: [mkNode('dorm-a', STATUS.HOT, 31, 60)],
  }));
  check('★★ core 停了一分钟，那行就说「core 没声了」',
    env.extra['core-hint'].textContent.indexOf('core 没声了') === 0,
    env.extra['core-hint'].textContent);
  check('★ 并且带上 is-stale 那一档配色',
    env.extra['core-hint'].className.indexOf('is-stale') >= 0,
    env.extra['core-hint'].className);
  check('★ 说清楚屏幕上的定格是怎么回事（不是「数据有误」）',
    env.extra['core-hint'].textContent.indexOf('停在那一刻') >= 0,
    env.extra['core-hint'].textContent);
  check('★ 这时房间照样在那儿、颜色也没变（3D 这屏不会自己把房间熄掉）',
    floorHex('dorm-a') === LOOK[STATUS.HOT].floor, floorHex('dorm-a'));

  /* 老 core 发的快照里没有 core 这一块 —— 如实说「判不了」，不猜。 */
  deliver(STATE_TOPIC, mkSnapshot({ nodes: [mkNode('dorm-a', STATUS.HOT, 31, 60)] }));
  check('★ 快照里没有心跳那一块时点明「core 是旧版本？」，不猜死活',
    env.extra['core-hint'].textContent.indexOf('旧版本') >= 0,
    env.extra['core-hint'].textContent);

  /* 节点名单来自快照 —— 不是页面里写死三个名字。 */
  deliver(STATE_TOPIC, mkSnapshot({
    nodes: [mkNode('dorm-a', STATUS.NORMAL, 25, 60), mkNode('dorm-b', STATUS.HOT, 31, 60)],
  }));
  check('★ 快照里说了哪几间就改哪几间',
    tagText('dorm-a', TAG_STATUS) === STATUS.NORMAL
    && tagText('dorm-b', TAG_STATUS) === STATUS.HOT,
    worldMod.NODE_IDS.map((id) => tagText(id, TAG_STATUS)).join(' | '));
  check('★ 快照里没提的那间**保持上一帧的样子**，不会被凭空改成「正常」',
    tagText('dorm-c', TAG_STATUS) === STATUS.COLD
    && floorHex('dorm-c') === LOOK[STATUS.COLD].floor,
    tagText('dorm-c', TAG_STATUS));

  clearWarns();
  deliver(STATE_TOPIC, mkSnapshot({ nodes: [mkNode('dorm-z', STATUS.HOT, 31, 60)] }));
  check('★ 快照里有布局表上没有的节点：world.js 告警，页面不炸',
    said.some((w) => w.indexOf('NODE_MAP') >= 0), said.join(' || '));

  /* 状态是**原样转发**的：页面不加工、不校验认不认识。 */
  clearWarns();
  deliver(STATE_TOPIC, mkSnapshot({ nodes: [mkNode('dorm-a', '台风', 31, 60)] }));
  check('★ 不认识的状态原样写到标签上（显示层没有资格改别人的话）',
    tagText('dorm-a', TAG_STATUS) === '台风', tagText('dorm-a', TAG_STATUS));
  check('世界那边为这个状态告警了一句，外观退回「正常」那一格',
    floorHex('dorm-a') === LOOK[STATUS.NORMAL].floor
    && said.some((w) => w.indexOf('台风') >= 0), said.join(' || '));

  /* ================= D. 只认那一条 topic ================= */

  out('\nD. 只认 dormmate/v1/state 一条');

  deliver(STATE_TOPIC, mkSnapshot({ nodes: [mkNode('dorm-a', STATUS.NORMAL, 25, 60)] }));
  const beforeTag = tagText('dorm-a', TAG_STATUS) + '/' + tagText('dorm-a', TAG_READ);

  clearWarns();
  deliver('dormmate/v1/nodes/dorm-a/telemetry',
    { nodeId: 'dorm-a', temperature: 31, humidity: 60, status: '偏热' });
  check('★ 单条遥测（E1 之前订阅的那条）现在不听：画面一个字没动',
    tagText('dorm-a', TAG_STATUS) + '/' + tagText('dorm-a', TAG_READ) === beforeTag,
    tagText('dorm-a', TAG_STATUS) + '/' + tagText('dorm-a', TAG_READ));
  check('而且说了原因（丢了什么都不说最难查）',
    said.some((w) => w.indexOf('不是快照 topic') >= 0), said.join(' || '));

  clearWarns();
  deliver(STATE_TOPIC, '这不是 JSON');
  check('坏 JSON：画面不动，报告了原因',
    tagText('dorm-a', TAG_STATUS) === STATUS.NORMAL
    && said.some((w) => w.indexOf('不是合法 JSON') >= 0), said.join(' || '));

  clearWarns();
  deliver(STATE_TOPIC, { v: 2, nodes: [] });
  check('形状不对（缺 events / rejects / counters）：readSnapshot 挡下',
    said.some((w) => w.indexOf('快照校验不通过') >= 0), said.join(' || '));

  clearWarns();
  deliver(STATE_TOPIC, mkSnapshot({ v: 1, nodes: [mkNode('dorm-a', STATUS.HOT, 31, 60)] }));
  check('★ 版本号对不上也不读（宁可什么都不显示，也别整块 undefined）',
    tagText('dorm-a', TAG_STATUS) === STATUS.NORMAL
    && said.some((w) => w.indexOf('快照校验不通过') >= 0), said.join(' || '));

  clearWarns();
  deliver(STATE_TOPIC, mkSnapshot({ nodes: [mkNode('dorm-a', STATUS.HOT, 31, 60)] }));
  check('★ 脏数据之后好快照照样进（没被卡死）',
    tagText('dorm-a', TAG_STATUS) === STATUS.HOT, tagText('dorm-a', TAG_STATUS));

  /* ================= E. 红线：点房间只发指令 ================= */

  out('\nE. 点房间 = 发一条 focus 指令（画面一个字都不改）');

  function clickRoom(nodeId) {
    // 命中的是一片**扇叶**（嵌在 fan → fan-mount 两层 Group 里），证明 world.js
    // 是往上找带 nodeId 的那个 Group，而不是只看第一层。
    raycasterRef.hits = [{ object: partOf(nodeId, 'fan-blade-0'), distance: 1 }];
    canvas.fire('click', { clientX: 400, clientY: 300 });
  }

  const pubBefore = client.published.length;
  clickRoom('dorm-b');
  check('★ 点房间发出了一条指令', client.published.length === pubBefore + 1,
    client.published.length - pubBefore + ' 条');
  const pub = client.published[client.published.length - 1];
  check('★ 发到 dormmate/v1/cmd（不是遥测那条，也不是 state）', pub.topic === CMD_TOPIC, pub.topic);
  check('★ 载荷就是 {nodeId, action, source} 三样 —— 没有 status、没有 state',
    pub.payload === JSON.stringify({ nodeId: 'dorm-b', action: 'focus', source: '3d' }),
    pub.payload);
  check('★ 不 retained（留着的话下次起 core 会凭空切一次焦点）',
    pub.opts && pub.opts.retain === false, JSON.stringify(pub.opts));
  check('QoS 走配置里的那个', pub.opts && pub.opts.qos === globalThis.DormMateConfig.QOS,
    pub.opts && String(pub.opts.qos));

  /* 这一段最关键的一条：发完指令，**画面一个字都不能动**。 */
  frame();
  check('★ 发完指令之后相机一动不动（本地不抢跑）',
    cam().position.x === startPos.x && cam().position.z === startPos.z,
    cam().position.x + ',' + cam().position.z);
  check('★ 焦点那个记号也没加上（等 core 说了算）', !isFocused('dorm-b'), tagEl('dorm-b').className);
  check('★ 三间房没有一间开始脉冲（点房间不是「选重点」）',
    worldMod.NODE_IDS.every((id) => ringEl(id).visible === false));
  check('点了之后只写了一句「等 core 发回新快照」',
    env.extra['cmd-note'].textContent.indexOf('等 core 发回新快照') >= 0,
    env.extra['cmd-note'].textContent);

  const pubAfterRoom = client.published.length;
  raycasterRef.hits = [];
  canvas.fire('click', { clientX: 10, clientY: 10 });
  check('点空白处（raycaster 一条都没命中）不发指令',
    client.published.length === pubAfterRoom, client.published.length);

  client.connected = false;
  raycasterRef.hits = [{ object: roomGroup('dorm-c'), distance: 1 }];
  canvas.fire('click', { clientX: 400, clientY: 300 });
  check('★ 没连上 broker 时不发指令', client.published.length === pubAfterRoom,
    client.published.length);
  check('★ 而且如实说明原因（点了没反应最难查）',
    env.extra['cmd-note'].textContent.indexOf('没能把焦点切到 dorm-c') >= 0
    && env.extra['cmd-note'].textContent.indexOf('broker') >= 0,
    env.extra['cmd-note'].textContent);
  client.connected = true;

  /* ================= F. 焦点：快照说了算 ================= */

  out('\nF. 焦点由快照驱动');

  deliver(STATE_TOPIC, mkSnapshot({
    focus: { nodeId: 'dorm-b', by: '3d', at: '2026-09-30 20:31:00' },
    priority: { nodeId: 'dorm-a', reason: '偏热已持续 20 分钟', score: 3 },
    nodes: [
      mkNode('dorm-a', STATUS.HOT, 31, 60),
      mkNode('dorm-b', STATUS.NORMAL, 25, 60),
      mkNode('dorm-c', STATUS.COLD, 16, 60),
    ],
  }));

  check('★ 快照里 focus 有值之后，标签上才加上焦点记号',
    isFocused('dorm-b') && !isFocused('dorm-a') && !isFocused('dorm-c'),
    worldMod.NODE_IDS.map((id) => id + ':' + isFocused(id)).join(' '));
  check('★ 指令落地了，「等新快照」那句就撤掉',
    env.extra['cmd-note'].textContent === '', env.extra['cmd-note'].textContent);
  check('读数条改口写成跨端焦点（by 是 3d，排错时一眼看得出是谁点的）',
    env.extra.readout.textContent.indexOf('dorm-b') >= 0
    && env.extra.readout.textContent.indexOf('跨端焦点') >= 0,
    env.extra.readout.textContent);
  check('理由那行写的是「谁点的名」',
    env.extra['readout-reason'].textContent.indexOf('3d') >= 0,
    env.extra['readout-reason'].textContent);

  frame();
  check('★ 一帧之后还没到（是飞过去的，不是瞬移）',
    cam().position.x !== MAP['dorm-b'].x + 11, cam().position.x);

  for (let i = 0; i < 90; i++) frame();
  check('★ 飞够时间之后停在 dorm-b 的取景位',
    Math.abs(cam().position.x - (MAP['dorm-b'].x + 11)) < 0.5, cam().position.x);
  const lastLook = cam().lookAtCalls[cam().lookAtCalls.length - 1];
  check('★ 而且每帧都在重新对准那间房（只改位置不改朝向 = 飞过去了却盯着老地方）',
    !!lastLook && Math.abs(lastLook[0] - MAP['dorm-b'].x) < 0.5
    && Math.abs(lastLook[2] - MAP['dorm-b'].z) < 0.5,
    JSON.stringify(lastLook));

  /* 快照是反复发的，同一帧再来一遍不能把镜头拉回去重飞。 */
  const landedX = cam().position.x;
  deliver(STATE_TOPIC, mkSnapshot({
    focus: { nodeId: 'dorm-b', by: '3d', at: '2026-09-30 20:31:00' },
    nodes: [mkNode('dorm-a', STATUS.HOT, 31, 60), mkNode('dorm-b', STATUS.NORMAL, 25, 60)],
  }));
  frame();
  check('★ 每帧都重报同一个焦点，镜头也照样停在原地（重报才飞的写法会永远飞不到）',
    cam().position.x === landedX, cam().position.x);

  deliver(STATE_TOPIC, mkSnapshot({
    nodes: [mkNode('dorm-a', STATUS.HOT, 31, 60), mkNode('dorm-b', STATUS.NORMAL, 25, 60)],
  }));
  check('★ focus 变回 null：焦点记号撤掉', !isFocused('dorm-b'), tagEl('dorm-b').className);
  for (let i = 0; i < 120; i++) frame();
  check('★ 镜头飞回总览位',
    Math.abs(cam().position.x - startPos.x) < 0.5
    && Math.abs(cam().position.z - startPos.z) < 0.5,
    cam().position.x + ',' + cam().position.z);

  /* ================= G. 事件状态 → 风扇 / 处理中 ================= */

  out('\nG. HANDLING 处理中：风扇转 + 标签多一格');

  deliver(STATE_TOPIC, mkSnapshot({
    nodes: [mkNode('dorm-a', STATUS.NORMAL, 25, 60), mkNode('dorm-b', STATUS.NORMAL, 25, 60)],
  }));
  const idle = fanAngle('dorm-a');
  frame(); frame();
  check('正常那间风扇不转（两帧之后角度一点没变）', fanAngle('dorm-a') === idle, fanAngle('dorm-a'));
  check('LOOK 表里「正常」那一列本来就不该转（所以下面那个转是真出了别的原因）',
    LOOK[STATUS.NORMAL].fan === false);
  check('没有处理中事件时，「处理中」那格是藏着的', tagHidden('dorm-a') === true);

  deliver(STATE_TOPIC, mkSnapshot({
    nodes: [mkNode('dorm-a', STATUS.NORMAL, 25, 60), mkNode('dorm-b', STATUS.NORMAL, 25, 60)],
    events: { summary: {}, dropped: 0, events: [mkEvent('dorm-a', 'HANDLING')] },
  }));
  check('★ HANDLING 那间，标签上多出「处理中」',
    tagHidden('dorm-a') === false && tagText('dorm-a', TAG_HANDLING) === '处理中',
    tagHidden('dorm-a') + '/' + tagText('dorm-a', TAG_HANDLING));
  check('别的那间这一格还是藏着的', tagHidden('dorm-b') === true);

  const aBefore = fanAngle('dorm-a');
  const bBefore = fanAngle('dorm-b');
  frame();
  check('★ 状态是「正常」也照样转 —— 这是另一个原因（有人在管这件事）',
    fanAngle('dorm-a') !== aBefore, fanAngle('dorm-a'));
  check('同一帧里没有事件的那间纹丝不动', fanAngle('dorm-b') === bBefore, fanAngle('dorm-b'));

  /* 结案之后就该停 —— 这和看板那台风扇（按过就一直转）**故意不一样**。 */
  deliver(STATE_TOPIC, mkSnapshot({
    nodes: [mkNode('dorm-a', STATUS.NORMAL, 25, 60)],
    events: { summary: {}, dropped: 0, events: [mkEvent('dorm-a', 'RECOVERED')] },
  }));
  const aRecovered = fanAngle('dorm-a');
  frame(); frame();
  check('★ 已恢复（RECOVERED）之后扇叶停下 —— 三间并排时「还悬着」的那个信号',
    fanAngle('dorm-a') === aRecovered, fanAngle('dorm-a'));
  check('「处理中」那格也跟着收起来', tagHidden('dorm-a') === true);

  /* 偏热那一路：不看事件也该转（LOOK 表说了算，两路合成是 or） */
  deliver(STATE_TOPIC, mkSnapshot({ nodes: [mkNode('dorm-a', STATUS.HOT, 31, 60)] }));
  const hotIdle = fanAngle('dorm-a');
  frame();
  check('★ 偏热那间没有任何事件也转（这是状态那一路）',
    fanAngle('dorm-a') !== hotIdle, fanAngle('dorm-a'));

  deliver(STATE_TOPIC, mkSnapshot({
    nodes: [mkNode('dorm-a', STATUS.HOT, 31, 60)],
    events: { summary: {}, dropped: 0, events: [mkEvent('dorm-a', 'RECOVERED')] },
  }));
  const hotRecovered = fanAngle('dorm-a');
  frame();
  check('★ 偏热那间把事件结掉照样转（两个原因是 or，谁也不覆盖谁）',
    fanAngle('dorm-a') !== hotRecovered, fanAngle('dorm-a'));

  deliver(STATE_TOPIC, mkSnapshot({
    nodes: [mkNode('dorm-a', STATUS.COLD, 16, 60), mkNode('dorm-c', STATUS.COLD, 16, 60)],
    events: { summary: {}, dropped: 0, events: [mkEvent('dorm-c', 'HANDLING')] },
  }));
  const aCold = fanAngle('dorm-a');
  const cCold = fanAngle('dorm-c');
  frame();
  check('★ 别的节点在处理中，这间不跟着转（事件是按 nodeId 分的）',
    fanAngle('dorm-a') === aCold, fanAngle('dorm-a'));
  check('处理中的那间自己在转', fanAngle('dorm-c') !== cCold, fanAngle('dorm-c'));

  /* ================= H. 重点 → 脉冲光圈 ================= */

  out('\nH. 重点：地上那圈脉冲');

  deliver(STATE_TOPIC, mkSnapshot({
    priority: { nodeId: 'dorm-c', reason: '偏冷已持续 30 分钟', score: 5 },
    nodes: [
      mkNode('dorm-a', STATUS.NORMAL, 25, 60),
      mkNode('dorm-b', STATUS.NORMAL, 25, 60),
      mkNode('dorm-c', STATUS.COLD, 16, 60),
    ],
  }));

  check('★ 只有重点那间的光圈亮着',
    ringEl('dorm-c').visible === true
    && ringEl('dorm-a').visible === false && ringEl('dorm-b').visible === false,
    worldMod.NODE_IDS.map((id) => id + ':' + ringEl(id).visible).join(' '));

  frame();
  const o1 = ringEl('dorm-c').material.opacity;
  const s1 = ringEl('dorm-c').scale.x;
  frame();
  const o2 = ringEl('dorm-c').material.opacity;
  const s2 = ringEl('dorm-c').scale.x;
  check('★ 光圈在呼吸（两帧之间透明度和大小都变了）',
    o1 !== o2 && s1 !== s2, o1 + '->' + o2 + '  ' + s1 + '->' + s2);
  check('透明度在 0.45~0.95 之间（半亮到接近实心，不会整个消失）',
    o2 >= 0.45 && o2 <= 0.95, o2);
  check('缩放只在 1 ~ 1.05 之间微动（是「在呼吸」，不是「圈在长大」）',
    s2 >= 1 && s2 <= 1.05, s2);

  deliver(STATE_TOPIC, mkSnapshot({
    priority: { nodeId: 'dorm-a', reason: '偏热', score: 1 },
    nodes: [mkNode('dorm-a', STATUS.HOT, 31, 60), mkNode('dorm-c', STATUS.COLD, 16, 60)],
  }));
  check('★ 换重点：旧那间立刻收干净（不然它会永远停在半亮上）',
    ringEl('dorm-c').visible === false
    && ringEl('dorm-c').material.opacity === 0.9
    && ringEl('dorm-c').scale.x === 1
    && ringEl('dorm-a').visible === true,
    ringEl('dorm-c').material.opacity + ' / ' + ringEl('dorm-a').visible);

  deliver(STATE_TOPIC, mkSnapshot({ nodes: [mkNode('dorm-a', STATUS.NORMAL, 25, 60)] }));
  check('没有重点时三间都不亮',
    worldMod.NODE_IDS.every((id) => ringEl(id).visible === false));

  /* ================= I. 图例 ================= */

  out('\nI. 图例（颜色从 LOOK 表来，不是另抄一份）');

  const items = env.extra.legend.children;
  const hex = (n) => '#' + n.toString(16).padStart(6, '0');
  const idx = (status) => Object.keys(LOOK).indexOf(status);
  const swatch = (status) => items[idx(status)].children[0].style.background;
  const hint = (status) => items[idx(status)].children[2].textContent;

  check('图例四项', items.length === 4, items.length + ' 项');
  check('★ 四项就是 LOOK 表的四个键，顺序也一样（不是这边另写一份状态名）',
    items.map((el) => el.dataset.status).join(',') === Object.keys(LOOK).join(','),
    items.map((el) => el.dataset.status).join(','));
  check('★ 偏热那项的色块就是 LOOK 里偏热的地板色',
    swatch(STATUS.HOT) === hex(LOOK[STATUS.HOT].floor), swatch(STATUS.HOT));
  check('★ 偏冷那项同理（地板说了算）',
    swatch(STATUS.COLD) === hex(LOOK[STATUS.COLD].floor), swatch(STATUS.COLD));
  check('★ 偏湿那项说的是「窗扇打开」（它的地板色和正常一样，靠窗户说话）',
    hint(STATUS.WET).indexOf('窗扇打开') >= 0, hint(STATUS.WET));
  check('★ 偏湿那项的色块是窗户色，不是和正常那项看不出区别的同一块灰',
    swatch(STATUS.WET) === hex(LOOK[STATUS.WET].window)
    && swatch(STATUS.WET) !== swatch(STATUS.NORMAL),
    swatch(STATUS.WET) + ' vs ' + swatch(STATUS.NORMAL));
  check('四项的色块两两不同（有一对撞色的话图例反而更让人糊涂）',
    new Set(items.map((el) => el.children[0].style.background)).size === 4,
    items.map((el) => el.children[0].style.background).join(' '));
  check('偏热那项写了「风扇转」', hint(STATUS.HOT).indexOf('风扇转') >= 0, hint(STATUS.HOT));
  check('偏冷那项写的是「地板换色」', hint(STATUS.COLD) === '地板换色', hint(STATUS.COLD));
  check('正常那项写的是「和平时一样」', hint(STATUS.NORMAL) === '和平时一样', hint(STATUS.NORMAL));
  check('每项都有状态名那一格（色块旁边必须有字，不能只靠颜色）',
    items.every((el) => el.children[1].textContent === el.dataset.status),
    items.map((el) => el.children[1].textContent).join(','));

  /* ================= 收尾 ================= */

  fs.rmSync(tmp, { recursive: true, force: true });
  out('\n结果：' + pass + ' 通过，' + fail + ' 不通过');
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  out(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
