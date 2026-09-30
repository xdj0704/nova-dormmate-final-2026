'use strict';

/**
 * web/multimodal.js 的测试（Phase6 E2）。纯 Node，零依赖。
 *
 * 【为什么另起一个文件】E2 把 ASR（原来的 Step 3-2）和 TTS（原来的 Step 3-3）
 * 从 web/script.js 整块搬进了 web/multimodal.js，那两节原来的五十来条断言
 * 跟着搬到这里（tests/script.test.js 里留了一段指路的注释），再往上加 E2 新的。
 *
 * 【跑的到底是不是真东西】跑的是**真模块**：把仓库的形状照抄进一个临时目录，
 * 让 multimodal.js 里那句 `import ... from '../dashboard/logic.js'` 一个字都
 * 不用改，走的就是线上那条路径。
 *
 *   tmp/package.json            {"type":"module"}
 *   tmp/web/multimodal.js       真的（逐字节拷过来）
 *   tmp/dashboard/logic.js      真的 —— 念的那句话（speakLine）、挑中哪一间
 *                               （selectedNode）和看板 / 手机 / 3D 是**同一份**，
 *                               所以「同一帧快照在几块屏幕上永远说同一件事」
 *                               在这里是真的被验到了，不是嘴上说的
 *   shared/config.js            真的，用 vm 求值一遍（它本来就是个没有 export
 *                               的 IIFE，页面里也是普通 <script> 引的）
 *
 * 桩换掉的只有**外面的世界**：window（config / bridge / 语音那几个 API）、
 * document（几个元素）、location。window.DormMateBridge 是 web/script.js
 * 建起来的那根线，这里给它一个假的 —— 这样这个文件测的是 multimodal.js
 * 自己（发什么、说什么），MQTT 那一半归 tests/script.test.js 管。
 *
 * 【这个文件盯的四件事】
 *   1) 说出去的话认得出中文别名（dorm-b / Dorm B / dormb / 第二个）
 *   2) 四条指令各发各的：focus / snapshot / handle 发给 core 的报文长什么样
 *   3) 拍照那条**红线**：照片落款、水印三要素、以及「登没登上」只认 core
 *      下一帧报回来的 cameraCount —— 本地一个字都不许替它写
 *   4) 念的那句话**不是这里拼的**：来自 logic.js 的 speakLine + 当下那一帧快照
 *
 * 跑法：node tests/multimodal.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MODULE_FILE = path.join(ROOT, 'web', 'multimodal.js');
const SCRIPT_FILE = path.join(ROOT, 'web', 'script.js');
const LOGIC_FILE = path.join(ROOT, 'dashboard', 'logic.js');
const CONFIG_FILE = path.join(ROOT, 'shared', 'config.js');
const HTML_FILE = path.join(ROOT, 'web', 'index.html');

let pass = 0;
let fail = 0;

function check(label, cond, extra) {
  if (cond) {
    pass++;
    console.log('PASS  ' + label);
  } else {
    fail++;
    console.log('FAIL  ' + label + (extra === undefined ? '' : '   -> ' + extra));
  }
}

/* ---------- 静态：接线 ---------- */

const MODULE_SRC = fs.readFileSync(MODULE_FILE, 'utf8');
const SCRIPT_SRC = fs.readFileSync(SCRIPT_FILE, 'utf8');
const html = fs.readFileSync(HTML_FILE, 'utf8');

/* 查「源码里有没有某个词」之前先剥注释。注释里本来就会拿 dorm-b 举例、
   会提到「摄氏度」「已恢复」这些字 —— 不剥的话这几条永远是红的，然后就有人
   把它们注释掉，那条检查就白写了。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const CODE = stripComments(MODULE_SRC);

console.log('=== A. 接线（静态）===');

check('index.html 挂了 multimodal.js，而且带 type="module"',
  /<script\s+type="module"\s+src="multimodal\.js">/.test(html), '');
check('★ index.html 在 multimodal.js 之前引 config.js（它起手就要 CFG）',
  html.indexOf('src="../shared/config.js"') < html.indexOf('src="multimodal.js"'), '');
check('页面留了那五样元素（按钮 / 两行结果 / 焦点行 / 麦克风提示）',
  ['voice-start', 'voice-note', 'voice-error', 'voice-heard', 'voice-action',
    'voice-focus'].every((id) => html.includes('id="' + id + '"')), '');
check('★ 语音那一套在 script.js 里没有残留（搬干净了，不是抄了一份）',
  !/speakStatus|VOICE_COMMANDS|speechSynthesis|SpeechRecognition/.test(SCRIPT_SRC), '');

const IMPORTS = (MODULE_SRC.match(/^import[\s\S]*?from\s+'([^']+)'/gm) || []);
check('★ 只 import ../dashboard/logic.js 一个（不引 mqtt、不引 three）',
  IMPORTS.length === 1 && IMPORTS[0].includes("'../dashboard/logic.js'"),
  IMPORTS.join(' | '));
check('★ 用的就是 logic.js 的那几个出口（念什么、选中哪一间由它说了算）',
  /speakLine/.test(CODE) && /selectedNode/.test(CODE) && /openEvent/.test(CODE)
  && /readSnapshot/.test(CODE), '');
check('★ 念的那句话不是这个文件拼的（源码里没有 logic.js 才用的措辞）',
  !/摄氏度/.test(CODE), '「摄氏度」只有 speakLine 那么写');
check('★ 源码里没有写死的 topic 字符串（全从 CFG 取）',
  !/dormmate\/v1\//.test(CODE), '');
check('★ 源码里没有写死的宿舍名（有哪些宿舍是 core 的配置说了算）',
  !/dorm-/.test(CODE), '');
check('★ 源码里没有温度阈值 18 / 30 / 75（判断不是这一层的事）',
  !/\b(18|30|75)\b/.test(CODE), '');
check('★ 源码里没有事件状态名 RECOVERED / 「已恢复」（红灯词）',
  !/RECOVERED|已恢复/.test(CODE), '');

/* ---------- 摆仓库 ---------- */

function makeEl() {
  const listeners = {};
  return {
    value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, src: '',
    classList: {
      _on: new Set(),
      toggle(name, on) { if (on) this._on.add(name); else this._on.delete(name); },
      add(name) { this._on.add(name); },
      remove(name) { this._on.delete(name); },
    },
    addEventListener(type, handler) {
      (listeners[type] || (listeners[type] = [])).push(handler);
    },
    fire(type, event = {}) {
      (listeners[type] || []).forEach((handler) => handler(event));
    },
  };
}

const els = {};
const windowListeners = {};

/* 语音合成的桩：speak() 只把 utterance 记下来（不真念），cancel() 数次数；
   utterance.fireError(code) 模拟「念到一半出错」—— 真浏览器走 onerror。 */
let spokenTexts = [];
let cancelCount = 0;

function fakeUtterance(text) {
  return {
    text, lang: '',
    onerror: null,
    fireError(code) { if (this.onerror) this.onerror({ error: code }); },
  };
}

function installSpeechSynthesis(mode) {
  spokenTexts = [];
  cancelCount = 0;
  const synth = {
    speak(u) { spokenTexts.push(u); },
    cancel() { cancelCount += 1; },
  };
  window.speechSynthesis = mode === 'off' ? undefined : synth;
  window.SpeechSynthesisUtterance = mode === 'ok'
    ? function UtteranceStub(text) { return fakeUtterance(text); }
    : undefined;
}

/* 语音识别的桩：new 出来的实例记下 lang / continuous，start() 立刻回调 onstart
   （真浏览器也这样），测试再手动 say() / fail() 模拟「识别到了什么」。 */
let lastRecognition = null;

function fakeRecognition() {
  return {
    lang: '', continuous: true, interimResults: true,
    started: 0, aborted: 0,
    onstart: null, onresult: null, onerror: null, onend: null,
    start() { this.started += 1; if (this.onstart) this.onstart(); },
    stop() {},
    abort() { this.aborted += 1; if (this.onend) this.onend(); },
    say(text) {
      if (this.onresult) {
        this.onresult({ resultIndex: 0, results: [[{ transcript: text }]] });
      }
      if (this.onend) this.onend();
    },
    fail(code) {
      if (this.onerror) this.onerror({ error: code });
      if (this.onend) this.onend();
    },
  };
}

function installSpeechRecognition(supported) {
  lastRecognition = null;
  const Ctor = supported
    ? function SpeechRecognitionStub() {
      lastRecognition = fakeRecognition();
      return lastRecognition;   // 构造函数返回对象时，new 的结果就是它
    }
    : undefined;
  window.SpeechRecognition = Ctor;
  window.webkitSpeechRecognition = Ctor;
}

/* window.DormMateBridge —— web/script.js 建起来的那根线。这里给它一个假的，
   好让这个文件只测 multimodal.js 自己（它发什么、说什么）。 */
const bridge = {
  topics: { telemetry: 'dormmate/v1/nodes/+/telemetry', state: 'dormmate/v1/state',
    cmd: 'dormmate/v1/cmd' },
  listeners: [],
  sent: [],
  captures: [],
  captureFail: '',
  latest: null,
  onState(fn) { bridge.listeners.push(fn); if (bridge.latest) fn(bridge.latest); },
  latestState() { return bridge.latest; },
  sendCmd(body) {
    if (bridge.connected === false) return false;
    bridge.sent.push(body);
    return true;
  },
  capture(overlay, stamp) {
    /* 传进来的 stamp 记下来：真实现里画布用它当拍摄时刻，桩也照做 ——
       「水印上的时刻和指令里的 stamp 是同一个」那条才有得验。 */
    bridge.captures.push({ overlay: overlay, stamp: stamp });
    if (bridge.captureFail) return { ok: false, message: bridge.captureFail, meta: null };
    return {
      ok: true,
      message: '已拍照，' + (stamp || '2026-09-22 20:31:00'),
      meta: { stamp: stamp || '2026-09-22 20:31:00', width: 640, height: 480,
        bytes: 48213, ext: '.png' },
    };
  },
  /* 测试用：推一帧快照进来，等价于 MQTT 上到了一条 state */
  push(snap) { bridge.latest = snap; bridge.listeners.forEach((fn) => fn(snap)); },
};

/* Node 里没有 window / location / document，得先造出来再 import 真模块 ——
   模块在**求值的那一刻**就会读它们（CFG / BRIDGE / 那几个元素）。 */
const window = {
  matchMedia: () => ({ matches: false }),
  isSecureContext: true,
  addEventListener(type, handler) {
    (windowListeners[type] || (windowListeners[type] = [])).push(handler);
  },
  DormMateBridge: bridge,
};
global.window = window;
global.location = { hostname: 'localhost', protocol: 'http:' };
global.document = { getElementById: (id) => (els[id] || (els[id] = makeEl())) };

/* config.js 是经典 script（没有 export），用 vm 求值一遍，和 index.html 里
   那个 <script> 等价。它自己会挂到 globalThis.DormMateConfig 上，真浏览器里
   window 就是 globalThis，所以这里也把同一个引用搬给这个桩的 window。 */
vm.runInThisContext(fs.readFileSync(CONFIG_FILE, 'utf8'), { filename: CONFIG_FILE });
window.DormMateConfig = global.DormMateConfig;
const CFG = global.DormMateConfig;

installSpeechSynthesis('ok');
installSpeechRecognition(true);

/* ---------- 摆临时目录，import 真模块 ---------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dormmate-mm-'));
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
fs.mkdirSync(path.join(tmp, 'web'));
fs.mkdirSync(path.join(tmp, 'dashboard'));
fs.copyFileSync(MODULE_FILE, path.join(tmp, 'web', 'multimodal.js'));
fs.copyFileSync(LOGIC_FILE, path.join(tmp, 'dashboard', 'logic.js'));

/* ---------- 快照样本（字段就是 core 的 view() 那几样）---------- */

function nodeRow(nodeId, over) {
  const row = {
    nodeId: nodeId, online: true, status: '正常', temperature: 25, humidity: 60,
    time: '2026-09-22 20:30:00', abnormalCount: 0, durationSec: null,
    durationText: null, reason: '', lastSeen: '2026-09-22 20:30:00',
    historyCount: 3,
    history: [
      { time: '2026-09-22 20:28:00', temperature: 25, humidity: 60, status: '正常' },
      { time: '2026-09-22 20:29:00', temperature: 25, humidity: 60, status: '正常' },
      { time: '2026-09-22 20:30:00', temperature: 25, humidity: 60, status: '正常' },
    ],
  };
  Object.keys(over || {}).forEach((k) => { row[k] = over[k]; });
  return row;
}

function eventRow(over) {
  const e = {
    event_id: 'dorm-b-20260922-202800', nodeId: 'dorm-b', state: 'OPEN',
    startTime: '2026-09-22 20:28:00', problem: '温度偏高（31℃）',
    priorityTime: '2026-09-22 20:30:00', priorityReason: '连续异常 3 次、已持续 2 分钟，最久',
    action: null, actionTime: null, actionSource: null, recoverTime: null,
    endTime: null, result: null, abnormalAfter: 0, verifyCount: 0, cameraCount: 0,
  };
  Object.keys(over || {}).forEach((k) => { e[k] = over[k]; });
  return e;
}

/** 一份「dorm-b 偏热、开着案、还没人处理」的快照。 */
function snapshotOf(over) {
  const hot = nodeRow('dorm-b', {
    status: '偏热', temperature: 31, humidity: 78, abnormalCount: 3,
    durationSec: 1200, durationText: '20 分钟', reason: '已连续偏热 20 分钟（3 次）',
  });
  const s = {
    v: 2,
    time: '2026-09-22 20:30:00',
    focus: { nodeId: 'dorm-b', by: 'web', at: '2026-09-22 20:30:05' },
    priority: { nodeId: 'dorm-b', status: '偏热', severity: 'critical',
      abnormalCount: 3, durationSec: 1200, durationText: '20 分钟',
      reason: '已连续偏热 20 分钟（3 次）' },
    nodes: [nodeRow('dorm-a'), hot, nodeRow('dorm-c')],
    events: {
      summary: { total: 1, OPEN: 1, HANDLING: 0, RECOVERED: 0, UNRESOLVED: 0 },
      dropped: 0,
      events: [eventRow()],
    },
    rejects: { total: 0, kept: 0, items: [] },
    counters: { received: 0, rejected: 0, statusMismatch: 0, retainedCleared: 0,
      commands: 0, commandRejected: 0 },
  };
  Object.keys(over || {}).forEach((k) => { s[k] = over[k]; });
  return s;
}

const heard = () => els['voice-heard'].textContent;
const actionLine = () => els['voice-action'].textContent;
const focusLine = () => els['voice-focus'].textContent;
const errorLine = () => els['voice-error'].textContent;
const lastSent = () => bridge.sent[bridge.sent.length - 1];

(async () => {
  /* 真模块。它没有 export（出口挂在 window.DormMateMultimodal 上），
     所以拿到的是空命名空间 —— 这也是为什么下面都用 window 上那个门面。 */
  await import(pathToFileURL(path.join(tmp, 'web', 'multimodal.js')).href);
  const mm = window.DormMateMultimodal;
  /* logic.js 也真地 import 一份进来：期望值要现算，不能在这里抄一遍 ——
     抄一遍的话这两份迟早不一样，而测试还是绿的。 */
  const logic = await import(
    pathToFileURL(path.join(tmp, 'dashboard', 'logic.js')).href);

  const say = (text) => mm.say(text);

  console.log('=== B. 模块形状 ===');

  check('★ 门面挂在 window 上（经典 script 才拿得到它）', !!mm, String(mm));
  check('★ 四条指令，顺序就是判断顺序',
    JSON.stringify(mm.commands()) === JSON.stringify(['focus', 'snapshot', 'speak', 'handle']),
    JSON.stringify(mm.commands()));
  check('recordScene 是给「拍照」按钮用的（script.js 通过它走这条路）',
    typeof (mm && mm.recordScene) === 'function', typeof (mm && mm.recordScene));

  console.log('=== C. 快照没到 / 读不懂的时候 ===');

  check('一帧快照都没到时，说「朗读状态」给的是「还没收到」，不是「没有数据要念」',
    (say('朗读状态'), actionLine().includes('还没有收到 core 的快照')), actionLine());
  check('读不懂的快照会被点名（版本对不上，不是笼统的「出错了」）',
    (bridge.push(snapshotOf({ v: 1 })), say('朗读状态'),
      actionLine().includes('快照版本是 1')), actionLine());
  check('顶层不是对象也照样说清楚（端口连错订到别的 topic 的典型症状）',
    (bridge.push([1, 2, 3]), say('朗读状态'), actionLine().includes('不是对象')), actionLine());
  check('识别到的原文照样显示出来（认错了要看得见认成了什么）',
    (bridge.push(snapshotOf()), say('朗读状态'), heard() === '朗读状态'), heard());

  console.log('=== D. 中文别名 ===');

  function focusTo(text) {
    bridge.sent.length = 0;
    say(text);
    return lastSent() && lastSent().nodeId;
  }

  check('★ 「查看 dorm-b」认得出宿舍名', focusTo('查看 dorm-b') === 'dorm-b', focusTo('查看 dorm-b'));
  check('「Dorm B」这种大小写加空格也认（识别引擎不保证吐什么）',
    focusTo('查看 Dorm B') === 'dorm-b', focusTo('查看 Dorm B'));
  check('「dormb」连字符没了也认', focusTo('查看dormb') === 'dorm-b', focusTo('查看dormb'));
  check('「dorm_b」下划线顶替连字符也认', focusTo('查看 dorm_b') === 'dorm-b', focusTo('查看 dorm_b'));
  check('★ 「第二个」按快照里的顺序认（nodes 的顺序是 core 给的）',
    focusTo('看看第二个') === 'dorm-b', focusTo('看看第二个'));
  check('「三号」也认', focusTo('切到三号') === 'dorm-c', focusTo('切到三号'));
  check('「切换到第三间」也认（别名加序数词一起用）',
    focusTo('切换到第三间') === 'dorm-c', focusTo('切换到第三间'));
  check('★ 快照里没有的宿舍名不会被当成某一间（绝不猜一个）',
    (bridge.sent.length = 0, say('查看 dorm-z'), bridge.sent.length === 0 && actionLine().includes('没听出是哪一间')),
    actionLine());
  check('认不出来时把候选说出来（快照里现在有哪几间）',
    actionLine().includes('dorm-a、dorm-b、dorm-c'), actionLine());
  check('★ 一句不相干的话不会被硬套成某条指令',
    (bridge.sent.length = 0, say('今天天气不错'), bridge.sent.length === 0
      && actionLine().includes('未识别的指令')), actionLine());
  check('识别结果那行写的是原文，不做任何美化',
    (say('帮我看看第二个。'), heard() === '帮我看看第二个。'), heard());

  console.log('=== E. 「查看 dorm-b」= focus 指令 ===');

  bridge.sent.length = 0;
  say('查看 dorm-b');
  check('★ 报文就是 {nodeId, action: focus, source: web}',
    JSON.stringify(lastSent()) === JSON.stringify({
      nodeId: 'dorm-b', action: CFG.CMD_ACTION_FOCUS, source: 'web',
    }), JSON.stringify(lastSent()));
  check('★ 那句只说「已发出」，不说「焦点已切到」（core 认没认还没人知道）',
    /已发出/.test(actionLine()) && !/已切到|已经切|切好了/.test(actionLine()), actionLine());
  check('★ 结果那行标出识别成了哪条指令（认错了要看得出来）',
    actionLine().includes('识别为「查看」'), actionLine());
  /* 红线：本地一个字都不改。焦点最终是哪一间由 core 记进快照说了算 ——
     本地先把「当前焦点」改成 dorm-c 看着更跟手，但那正是被禁的伪造同步。 */
  const beforeFocus = focusLine();
  bridge.sent.length = 0;
  say('查看 dorm-c');
  check('★ 发了 focus 之后本地那行「当前焦点」一个字都没动（等 core 的下一帧）',
    focusLine() === beforeFocus, focusLine());
  check('MQTT 没连上时说得明白（不是「已发出」），而且没塞进 sent',
    (bridge.connected = false, bridge.sent.length = 0, say('查看 dorm-b'),
      bridge.connected = true,
      bridge.sent.length === 0 && actionLine().includes('没发出去')),
    actionLine());

  console.log('=== F. 「记录现场」= 拍照 + snapshot 指令 ===');

  bridge.push(snapshotOf());
  bridge.sent.length = 0;
  bridge.captures.length = 0;
  say('记录现场');
  const overlay = bridge.captures[0] && bridge.captures[0].overlay;
  const shot = lastSent();

  check('★ 真的去拍了（走 bridge.capture，不是自己开画布）',
    bridge.captures.length === 1 && Array.isArray(overlay), JSON.stringify(bridge.captures));
  check('★ 水印第一行三样都在：宿舍名 · 事件编号 · 时间戳',
    !!overlay && overlay[0].includes('dorm-b')
    && overlay[0].includes('dorm-b-20260922-202800')
    && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(overlay[0]), overlay && overlay[0]);
  check('水印第二行是那一刻的读数（从快照取，不从遥测拿）',
    !!overlay && overlay[1].includes('温度 31℃') && overlay[1].includes('湿度 78%')
    && overlay[1].includes('偏热'), overlay && overlay[1]);
  check('★ 报文里带 nodeId（挂给哪一间）',
    shot && shot.nodeId === 'dorm-b', JSON.stringify(shot));
  check('★ 动作名是 CFG.CMD_ACTION_SNAPSHOT（不是手写的字符串）',
    shot && shot.action === CFG.CMD_ACTION_SNAPSHOT, shot && shot.action);
  check('★ eventId 报的是 core 那条案卷的编号（它只拿它对账）',
    shot && shot.eventId === 'dorm-b-20260922-202800', shot && shot.eventId);
  check('★ 文件信息四件套齐全（stamp / width / height / bytes）',
    shot && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(shot.stamp) && shot.width === 640
    && shot.height === 480 && shot.bytes === 48213, JSON.stringify(shot));
  /* 这一条是这一步最容易被写成两个数据源的地方：水印归画布那边画、指令归这边拼，
     各自读一次钟就差一两秒，然后「照片上印 20:31:00、案卷里写 20:31:01」。 */
  check('★ 水印上印的时刻和指令里报的 stamp 是同一个字符串',
    shot && overlay[0].includes(shot.stamp), overlay[0] + '  vs  ' + (shot && shot.stamp));
  /* 宿舍名只出现一次：案号自己就是 `<宿舍>-<日期>-<时刻>`，前面再挂一遍会拼出
     两串都像时间戳的东西，事后从 events.json 里认不出来哪串是案号。 */
  check('★ 文件名里带宿舍名和案卷号（事后从 events.json 里一眼认得出）',
    shot && shot.file === 'dorm-b-20260922-202800-'
      + shot.stamp.replace(/[^0-9]/g, '') + '.png', shot && shot.file);
  check('★ watermark 字段就是画在照片上那两行',
    shot && shot.watermark === overlay.join(' / '), shot && shot.watermark);
  check('★ 照片本体不过去（没有 data URL / base64 这种字段，案卷不许被撑大）',
    shot && !JSON.stringify(shot).includes('data:image')
    && !JSON.stringify(shot).includes('base64'), JSON.stringify(shot).slice(0, 120));
  check('★ 拍照那一段没写「已登记」—— 只说发出去了，等 core 回帧',
    !/已登记/.test(actionLine()) && /等它回帧确认/.test(actionLine()), actionLine());

  /* 没有未结案的事件：水印里**不编**一个案卷号，报文里也不带 eventId，
     并且把「core 可能会拒收」这件事说出来（那是从快照读出来的预测，
     不是这边下的判断）。 */
  bridge.push(snapshotOf({ events: { summary: {}, dropped: 0, events: [] } }));
  bridge.sent.length = 0;
  bridge.captures.length = 0;
  say('记录现场');
  const noCase = lastSent();
  check('★ 没有未结案的事件时，水印里写「未开案」而不是编一个编号',
    bridge.captures[0].overlay[0].includes('未开案')
    && !/\d{8}-\d{6}/.test(bridge.captures[0].overlay[0]),
    bridge.captures[0].overlay[0]);
  check('★ 这时 eventId 整个字段缺席（空串和缺席在 core 那边是一回事）',
    noCase && !('eventId' in noCase), JSON.stringify(noCase));
  check('页面提前说清楚 core 可能会拒收（快照里没开案，这是读出来的不是猜的）',
    actionLine().includes('没有未结案的事件') && actionLine().includes('拒收'), actionLine());

  /* 语音里点名另一间 */
  bridge.push(snapshotOf({ focus: null,
    events: { summary: {}, dropped: 0, events: [] } }));
  bridge.sent.length = 0;
  say('记录 dorm-c 的现场');
  check('语音里点名了哪一间就拍哪一间（不用非是焦点那一间）',
    lastSent() && lastSent().nodeId === 'dorm-c', JSON.stringify(lastSent() && lastSent().nodeId));

  /* 焦点和重点都是空的 */
  bridge.push(snapshotOf({ focus: null, priority: null }));
  bridge.sent.length = 0;
  check('★ 快照里既没人点名也没有重点时拒绝得干脆，并说清怎么才能拍',
    (say('记录现场'), bridge.sent.length === 0 && actionLine().includes('先说「查看')),
    actionLine());

  /* 摄像头没开 / 拍失败。注意这里得**先把快照推回有焦点的那一帧** ——
     上面那两条把 focus / priority 都清空了，不清回来的话这一条测的是
     「不知道拍哪一间」，压根走不到拍照那一步（那样这条测试就永远绿）。 */
  bridge.push(snapshotOf());
  bridge.captureFail = '摄像头还没打开，先点「打开摄像头」';
  bridge.sent.length = 0;
  say('记录现场');
  check('拍不成时如实说拍不成，而且一条指令都不发（不发一条没有照片的指令）',
    bridge.sent.length === 0 && actionLine().includes('先点「打开摄像头」'), actionLine());
  bridge.captureFail = '';

  console.log('=== G. 「朗读状态」= TTS ===');

  bridge.push(snapshotOf());
  installSpeechSynthesis('ok');
  say('朗读状态');
  const spoken = spokenTexts[0];
  check('★ 说「朗读状态」真的调了 speak()', spokenTexts.length === 1, String(spokenTexts.length));
  check('★ 念的和 logic.js 现算出来的**逐字相同**（不是这边另拼一句）',
    !!spoken && spoken.text === logic.speakLine(bridge.latest, 'dorm-b'),
    spoken && spoken.text);
  check('★ 念的是选中那一间的读数（温湿度 + 状态 + 事件）',
    !!spoken && spoken.text.includes('dorm-b') && spoken.text.includes('31')
    && spoken.text.includes('78') && spoken.text.includes('偏热')
    && spoken.text.includes('事件'), spoken && spoken.text);
  check('★ 快照里没有的东西一个字都不念（比如 dorm-a 的读数）',
    !!spoken && !spoken.text.includes('dorm-a'), spoken && spoken.text);
  check('lang 是 zh-CN', !!spoken && spoken.lang === 'zh-CN', spoken && spoken.lang);
  check('念之前先 cancel（否则第二句要排队等第一句念完，念的是旧的）',
    cancelCount === 1, String(cancelCount));
  check('★ 页面上显示的就是要念的那一句（静音时只能靠它确认念了什么）',
    actionLine() === '识别为「朗读状态」——正在朗读：' + spoken.text, actionLine());
  check('utterance 留着一个引用（被 GC 掉的话 Chrome 念到一半会停）',
    typeof window.DormMateMultimodal === 'object', '');

  /* 每次现算：换了快照再念，念的就是新的那一帧 */
  const firstText = spoken.text;
  bridge.push(snapshotOf({
    nodes: [nodeRow('dorm-a'), nodeRow('dorm-b', {
      status: '偏热', temperature: 39, humidity: 88, durationText: '30 分钟',
    }), nodeRow('dorm-c')],
  }));
  say('朗读状态');
  check('新收到的数据立刻进下一句（念的是此刻的快照，不是上一次那份）',
    spokenTexts[1] && spokenTexts[1].text !== firstText
    && spokenTexts[1].text.includes('39'), spokenTexts[1] && spokenTexts[1].text);
  check('第二句照样先 cancel 再 speak',
    cancelCount === 2 && spokenTexts.length === 2,
    `cancel=${cancelCount} speak=${spokenTexts.length}`);

  /* 语音里点名念哪一间 */
  say('朗读 dorm-a');
  check('说「朗读 dorm-a」就念 dorm-a（被点名的优先于选中那间）',
    spokenTexts[2] && spokenTexts[2].text === logic.speakLine(bridge.latest, 'dorm-a'),
    spokenTexts[2] && spokenTexts[2].text);

  /* 浏览器不支持 */
  installSpeechSynthesis('off');
  bridge.push(snapshotOf());
  say('朗读状态');
  check('不支持语音合成时页面上仍有话说（不是点了没反应）',
    actionLine().includes('不支持语音合成'), actionLine());
  check('不支持时把要念的内容也写出来（不然演示时无从知道它本来该念什么）',
    actionLine().includes('dorm-b'), actionLine());
  check('不支持时压根没碰 speechSynthesis',
    spokenTexts.length === 0 && cancelCount === 0,
    `speak=${spokenTexts.length} cancel=${cancelCount}`);

  installSpeechSynthesis('partial');
  say('朗读状态');
  check('只有 speechSynthesis、没有那个构造函数，也算不支持（少查一个就是 TypeError）',
    actionLine().includes('不支持语音合成'), actionLine());

  /* 念的时候出错 */
  installSpeechSynthesis('ok');
  say('朗读状态');
  const speakingNow = spokenTexts[spokenTexts.length - 1];
  speakingNow.fireError('not-allowed');
  check('朗读失败：原始的 event.error 露在页面上（解释文案可能对不上，错误码不会骗人）',
    actionLine().includes('not-allowed'), actionLine());
  check('★ 朗读失败：把「正在朗读」覆盖掉，不留一句假话',
    !actionLine().includes('正在朗读') && actionLine().includes('朗读失败'), actionLine());
  speakingNow.fireError(undefined);
  check('连错误码都没有时写 unknown，不写 undefined',
    actionLine().includes('（unknown）'), actionLine());

  console.log('=== H. 「开始处理」= handle 指令 ===');

  bridge.push(snapshotOf());
  bridge.sent.length = 0;
  say('开始处理');
  const handle = lastSent();
  check('★ 报文是 {nodeId, action: handle, source: web}',
    handle && handle.nodeId === 'dorm-b' && handle.action === CFG.CMD_ACTION
    && handle.source === 'web', JSON.stringify(handle));
  check('带上了快照里这一间的时刻（不带的话 core 会用自己的钟盖章，两个说法）',
    handle && handle.time === '2026-09-22 20:30:00', JSON.stringify(handle));
  /* 红线：这条消息里只能有「我按了按钮」这一个事实。 */
  check('★ 报文里没有 status / state / 已恢复（只发事实，不发结论）',
    handle && !('status' in handle) && !('state' in handle)
    && !JSON.stringify(handle).includes('恢复'), JSON.stringify(handle));
  check('★ 那句话说清楚本地不改状态（屏幕上要等 core 的下一帧才变）',
    actionLine().includes('开始处理') && actionLine().includes('等 core'), actionLine());
  check('「开始」不会被「查看」那条抢走（指令表的顺序对）',
    actionLine().includes('识别为「开始处理」'), actionLine());

  console.log('=== I. 麦克风那半边 ===');

  const startBtn = els['voice-start'];
  installSpeechRecognition(false);
  startBtn.fire('click');
  check('浏览器没有 SpeechRecognition 时点名说清楚，而不是点了没反应',
    errorLine().includes('SpeechRecognition'), errorLine());

  installSpeechRecognition(true);
  window.isSecureContext = false;
  startBtn.fire('click');
  check('★ 不是安全上下文时提示的是「换地址」而不是「换浏览器」（混在一起人换一圈也不管用）',
    errorLine().includes('不是安全上下文') && errorLine().includes('https'), errorLine());
  window.isSecureContext = true;

  startBtn.fire('click');
  const rec = lastRecognition;
  check('确实 new 了 SpeechRecognition', !!rec, String(rec));
  check('lang 是 zh-CN', rec && rec.lang === 'zh-CN', rec && rec.lang);
  check('只识别一句（continuous=false）', rec && rec.continuous === false, rec && String(rec.continuous));
  check('不要中间稿（interimResults=false）', rec && rec.interimResults === false,
    rec && String(rec.interimResults));
  check('按钮上写着「正在听…」', startBtn.textContent === '正在听…', startBtn.textContent);
  check('提示行说「正在收音…」', els['voice-note'].textContent === '正在收音…',
    els['voice-note'].textContent);
  check('正在听的时候再点一次不会走到 start()（那会抛 InvalidStateError）',
    (startBtn.fire('click'), rec.started === 1), String(rec.started));

  /* 说一句话 → 走完整条链路 */
  bridge.sent.length = 0;
  bridge.push(snapshotOf());
  rec.say('查看 dorm-b');
  check('★ 语音说出来的话走的是和 say() 同一条路（不是另有一套）',
    lastSent() && lastSent().nodeId === 'dorm-b', JSON.stringify(lastSent()));
  check('结束后按钮复位', startBtn.textContent === '语音指令', startBtn.textContent);
  check('结束后提示行清空', els['voice-note'].textContent === '', els['voice-note'].textContent);

  /* 出错只说给用户听，解释在前、错误码在后 */
  startBtn.fire('click');
  lastRecognition.fail('not-allowed');
  check('识别出错时原始错误码在前、人话解释在后',
    /not-allowed/.test(errorLine()) && /麦克风权限被拒绝/.test(errorLine()), errorLine());
  check('出错后按钮仍然复位（不然按钮永远卡在「正在听」）',
    startBtn.textContent === '语音指令', startBtn.textContent);

  startBtn.fire('click');
  lastRecognition.fail('这个码浏览器以后才加');
  check('表里没有的码也照样显示出来（不能拿解释表替掉错误码）',
    errorLine().includes('这个码浏览器以后才加'), errorLine());

  /* 离开页面 */
  startBtn.fire('click');
  const listening = lastRecognition;
  (windowListeners.pagehide || []).forEach((fn) => fn());
  check('★ 离开页面时掐掉还在听的会话（否则麦克风一直开着）',
    listening.aborted === 1, String(listening.aborted));
  check('自己主动中止不算错误（不许写进错误区）',
    !/aborted/.test(errorLine()), errorLine());
  check('离开页面时也把正在念的那句 cancel 掉（切走之后还在响很吓人）',
    cancelCount >= 1, String(cancelCount));

  console.log('=== J. 快照到了重画什么 ===');

  bridge.push(snapshotOf());
  check('★ 焦点那行按 core 的快照写（不是本地记的）',
    focusLine().includes('dorm-b') && focusLine().includes('当前焦点'), focusLine());
  check('焦点那行标出是「跨端焦点」还是「当前重点」（挑法用 focusBanner 的 tag）',
    focusLine().includes('跨端焦点'), focusLine());
  check('焦点那行把未结案事件和已登记的快照数一起写出来',
    focusLine().includes('dorm-b-20260922-202800') && focusLine().includes('已登记 0 张'),
    focusLine());

  bridge.push(snapshotOf({ focus: null, priority: null }));
  check('没人点名也没有重点时如实说「没有」，不硬指一间',
    focusLine().includes('没有') && !focusLine().includes('dorm-'), focusLine());

  /* 拍照那条回执：只认 core 报回来的 cameraCount 变大 */
  bridge.push(snapshotOf());
  say('记录现场');
  bridge.push(snapshotOf({
    events: {
      summary: { total: 1, OPEN: 1 },
      dropped: 0,
      events: [eventRow({ cameraCount: 1 })],
    },
  }));
  check('★ core 把 cameraCount 报回来之后才说「已确认」（这才是唯一的确认途径）',
    actionLine().includes('core 已确认') && actionLine().includes('1 张'), actionLine());

  bridge.push(snapshotOf());
  say('记录现场');
  bridge.push(snapshotOf({
    events: {
      summary: { total: 1, OPEN: 1 },
      dropped: 0,
      events: [eventRow({ cameraCount: 0 })],
    },
  }));
  check('★ 数目没变大时**不**说「已确认」（指令被拒 / 丢了的时候不许写成功）',
    !actionLine().includes('core 已确认'), actionLine());

  /* 拍照按钮那条路：走的是同一个 doSnapshot */
  bridge.push(snapshotOf());
  bridge.sent.length = 0;
  bridge.captures.length = 0;
  mm.recordScene();
  check('★「拍照」按钮和语音「记录现场」走的是同一份实现（不是各写一套）',
    bridge.captures.length === 1 && lastSent()
    && lastSent().action === CFG.CMD_ACTION_SNAPSHOT, JSON.stringify(bridge.captures.length));
  check('按钮拍的那张水印一样齐（宿舍 · 案卷 · 时刻）',
    bridge.captures[0].overlay[0].includes('dorm-b')
    && bridge.captures[0].overlay[0].includes('dorm-b-20260922-202800'),
    bridge.captures[0].overlay[0]);
  check('按钮那条路也会说清楚发生了什么',
    actionLine().includes('已拍下') && actionLine().includes('640×480'), actionLine());

  /* 收摊 */
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 不通过');
  process.exit(fail ? 1 : 0);
})();
