// dashboard.js
// Step 5-3 / 5-4：三节点 Dashboard。
// Step 6-3：详情区嵌一个 3D 视图，跟着当前选中的节点走。
// Step 8-3：顶部只剩一行「当前重点」，另加一个「语音提醒」按钮。
// Step E3-2：**改成只订阅 core 发布的 `dormmate/v1/state`**，页面只渲染。
//
// 【这一轮最大的改动：数据从哪来】
// E3 之前，这个页面订的是 `dormmate/v1/nodes/+/telemetry`，于是它得自己把
// 原始读数加工一遍：复核 status、维护连续异常段、挑优先关注、记事件、判处理
// 到哪一步了。core 那边其实**也在做同一件事**，两边各有一份实现。
//
// 现在整个反过来：
//     simulator ——> core.py（唯一业务大脑）——> dormmate/v1/state ——> 这个页面
// 页面订的是那一条 retained 快照，画的是快照里的字段。所以：
//   - 这个文件里**没有**温度阈值、没有「连续几条算异常」、没有排序规则、
//     没有事件状态机 —— 它们全在 core 里，只有一份（有测试盯着这件事）
//   - 页面上那些字（谁是重点、因为什么、处理到没有）都是 core 写好的，
//     这边一个结论都不下；`./logic.js` 那一份也只剩「读字段 + 拼人话」
//   - 顺带去掉的：「模拟三节点数据」按钮。E3 明确禁止「两边手动输入数据
//     伪造同步效果」—— 那个按钮干的正是这件事（凭空造一份本地数据让界面
//     动起来）。要数据就跑 simulator/，或者用 MQTTX 发。
//
// 【代价：没有 core 就没有画面】页面打开时如果 core 没起，这里只会显示
// 「还没有收到 core 的快照」。这是**有意的** —— 快照是 retained 的，core
// 一上线，页面立刻补上；而本地造一份假数据顶上去，就再也分不清屏幕上的
// 数字是真的还是编的。README 的「已知限制」里写了这一条。
//
// handleMessage(topic, payloadText) 是唯一的消息入口。
//
// 这个文件是 **ES 模块**（index.html 里写的是 type="module"），因为它 import 了
// ../3d/scene.js 和 ./logic.js。三件事跟着变了，改的时候别漏：
//   1) 页面必须走 http 服务器打开，file:// 下模块会被 CORS 拒掉
//   2) index.html 里要有 importmap，且排在模块脚本之前（scene.js 用的是裸名字 'three'）
//   3) mqtt / Chart 仍走全局变量，DormMateConfig 也是（shared/config.js 是普通
//      script，挂全局而不是 export —— 见那个文件开头那段）

/* 3D 场景。拿的是 createDorm3D 这个工厂，不是场景本身 ——
   这个页面只建一个，但工厂的返回值里带着 updateScene / setLabel / dispose。 */
import { createDorm3D } from '../3d/scene.js';

/* 看板剩下来的那一半：读快照字段 + 把它们摆成人话。
   全是纯函数，不碰 DOM，所以 tests/logic.test.js 不用打任何桩就能整个测一遍。 */
import { readSnapshot, nodeOf, eventStateText, handlingOf, fanOn,
  focusBanner, alertLine, snapshotSummary, actionState,
  buildMlNote, mlFetchFailed, cmdNote } from './logic.js';
'use strict';

/* ---------- 配置 ---------- */

/* Broker 地址和 topic 常量来自 shared/config.js（Step E3-1）—— 三个前端
   （dashboard / 3d / mobile）共用一份。以前这里写着「有意重复」，E3 起
   反过来：三个页面订的是**同一条**快照 topic，再各写一份就不是重复两三行，
   而是「改了 topic 有一处没跟上」变成了常态。

   它是普通 script 挂的全局，所以这里读 window 上的属性而不是 import。
   读不到就**什么都不做**并说清楚 —— 硬着头皮往下走的话，连的是 undefined
   地址、订的是 undefined topic，错误信息会飘到很远的地方去。 */
const CFG = typeof window !== 'undefined' ? window.DormMateConfig : null;

/* ---------- 页面状态 ---------- */

/* 最近一帧通过校验的快照。null = 还没收到过。
   页面上**所有**数字都从这一份里读，没有第二份数据可以跟它不一致 ——
   这正是「只有一份」的写法：换一帧就是整页重画。 */
let snapshot = null;

/* 当前正在查看的宿舍。点卡片会改它；移动端发来 focus 时也会跟着切过去。
   null = 还没从快照里知道有哪些宿舍（快照里带的就是全部，这个文件里
   没有写死的节点名）。 */
let selected = null;

/* 上一次**跟过**的焦点 / 重点。用来区分「焦点变了」和「同一条焦点又发了一遍」：
   跟过之后用户点别人看，不该被下一条一模一样的快照拽回去。 */
let followed = undefined;

/* 上一次记进日志的焦点，用来只在**变化时**记一行（跨端联动的证据）。

   初值是空串而不是 undefined：空串就是「没有焦点」，和快照里没有焦点时
   算出来的那个值**一模一样**。初值写成 undefined 的话，第一帧（本来就没焦点）
   会被当成一次「从有到无」的变化，于是每次刷新页面都会先记一行
   「跨端焦点已取消」—— 一件根本没发生过的事。 */
let loggedFocus = '';

/* 上一次快照里「一共拒过多少条」。涨了就记一行警告，人不用一直盯着下面那块面板。 */
let loggedRejects = null;

/* 消息日志，新的在前。这是**本页面收到的东西**的流水，和「被拒绝消息」那块
   面板不是一回事 —— 那块是 core 拒掉的东西（跟着快照来）。 */
const messages = [];

/* 消息日志最多留多少条 */
const LOG_MAX = 100;

/* ---------- 状态 -> class / 图标 ---------- */

/* status 是从快照里读来的（core 用 rules.py 算的），这里只负责决定它长什么样。
   和 web/script.js 里的 STATUS_VIEW 是同一份映射，class 名也刻意保持一致，
   这样两个页面的卡片配色用的是同一套定义（见 dashboard/style.css 里的 --c）。 */
const STATUS_VIEW = {
  '正常': { cls: 'is-good',     icon: 'check' },
  '偏冷': { cls: 'is-warning',  icon: 'snow'  },
  '偏湿': { cls: 'is-serious',  icon: 'drop'  },
  '偏热': { cls: 'is-critical', icon: 'sun'   },
};

/* 图标形状本身就区分状态，不靠颜色单独表意。和 web/script.js 同一套。 */
const ICONS = {
  check: '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7"/></svg>',
  snow:  '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M7 1.5v11M2.24 4.25l9.52 5.5M11.76 4.25l-9.52 5.5"/></svg>',
  drop:  '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M7 1.6S3.2 6.1 3.2 8.7a3.8 3.8 0 0 0 7.6 0C10.8 6.1 7 1.6 7 1.6z"/></svg>',
  sun:   '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="2.5"/><path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.76 2.76l1.06 1.06M10.18 10.18l1.06 1.06M11.24 2.76l-1.06 1.06M3.82 10.18l-1.06 1.06"/></svg>',
};

function viewFor(status) {
  return STATUS_VIEW[status] || { cls: 'is-unknown', icon: 'check' };
}

/* ---------- 小工具 ---------- */

function esc(value) {
  return String(value).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* 31 显示成 31，25.5 显示成 25.5。null / undefined 显示成 —（还没收到数据） */
function fmt(value) {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/**
 * 把 Date 格式化成 "YYYY-MM-DD HH:mm:ss"（本地时间）。只用在**消息日志**上
 * （那是浏览器收到这一条的时刻），页面别处显示的时刻全来自快照。
 *
 * 不用 toLocaleString()：它的输出跟着浏览器和系统区域设置走，中文环境下
 * 可能给出 "2026/9/26 20:30:00"，连补零都不保证。
 */
function formatTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
    + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
}

/* ---------- DOM ---------- */

const el = {
  cards: document.getElementById('cards'),
  logBody: document.getElementById('log-body'),
  logCount: document.getElementById('log-count'),
  detailNode: document.getElementById('detail-node'),
  detailMeta: document.getElementById('detail-meta'),
  actionHandle: document.getElementById('action-handle'),
  actionState: document.getElementById('action-state'),
  cmdNote: document.getElementById('cmd-note'),
  chartNote: document.getElementById('chart-note'),
  scene3d: document.getElementById('scene3d'),
  focus: document.getElementById('focus'),
  speak: document.getElementById('speak'),
  speakNote: document.getElementById('speak-note'),
  evBody: document.getElementById('event-body'),
  evCount: document.getElementById('event-count'),
  exportEvents: document.getElementById('export-events'),
  rjBody: document.getElementById('reject-body'),
  rjCount: document.getElementById('reject-count'),
  clear: document.getElementById('clear'),
  conn: document.getElementById('conn'),
  connText: document.getElementById('conn-text'),
  toggle: document.getElementById('toggle'),
  /* Step 9-3 进阶项的三件：条数、结论那句、来源说明 */
  mlCount: document.getElementById('ml-count'),
  mlText: document.getElementById('ml-text'),
  mlNote: document.getElementById('ml-note'),
};

/* ---------- 消息日志 ---------- */

const LEVEL_TEXT = { ok: '正常', warn: '警告', error: '错误' };

/**
 * 记一条日志。消息和错误都走这里，所以日志区是排查问题的第一现场。
 *
 * @param {'ok'|'warn'|'error'} level
 * @param {string} topic
 * @param {string} text
 */
function logLine(level, topic, text) {
  messages.unshift({
    level: level,
    time: formatTime(new Date()),
    topic: topic ? String(topic) : '—',
    text: text,
  });
  if (messages.length > LOG_MAX) messages.length = LOG_MAX;
  renderLog();
}

function renderLog() {
  el.logCount.textContent = messages.length > 0 ? '共 ' + messages.length + ' 条' : '';
  el.logBody.innerHTML = messages.length === 0
    ? '<tr><td colspan="4" class="log-empty">还没有收到消息</td></tr>'
    : messages.map(function (m) {
      return '<tr class="log-row log-row--' + m.level + '">'
        + '<td class="mono">' + esc(m.time) + '</td>'
        + '<td><span class="level level--' + m.level + '">' + esc(LEVEL_TEXT[m.level]) + '</span></td>'
        + '<td class="mono">' + esc(m.topic) + '</td>'
        + '<td>' + esc(m.text) + '</td>'
        + '</tr>';
    }).join('');
}

/* ---------- 卡片 ---------- */

/**
 * 一张卡片。三个宿舍画的是同一套东西，内容全部来自快照里那一条。
 *
 * 「处理中｜handle」那一行来自 core 的事件（handlingOf）—— 这个宿舍有一条
 * 未结案的事件时才出现。没按过按钮就整行不出现，不多一行空占位。
 */
function cardHTML(node) {
  const nodeId = node.nodeId;
  const active = nodeId === selected;
  const head = '<span class="card-head">'
    + '<span class="node-name">' + esc(nodeId) + '</span>';

  const handling = handlingOf(snapshot, nodeId);
  const handlingHTML = handling.label === '无' ? ''
    : '<span class="card-action">' + esc(handling.label
      + (handling.event && handling.event.action ? '｜' + handling.event.action : '')) + '</span>';

  if (node.status == null) {
    return '<button class="card is-empty' + (active ? ' is-active' : '') + '"'
      + ' type="button" data-node="' + esc(nodeId) + '" aria-pressed="' + active + '">'
      + head + '<span class="badge badge--wait">等待数据</span></span>'
      + '<span class="card-wait">core 还没收到这个节点的数据</span>'
      + handlingHTML
      + '</button>';
  }

  const view = viewFor(node.status);

  /* 离线是个**状态之外**的事实（core 的优先排序不排离线的节点），
     所以它单独一个小标，不挤进那个状态徽章里。 */
  const offline = node.online ? ''
    : '<span class="badge badge--wait">已离线</span>';

  return '<button class="card ' + view.cls + (active ? ' is-active' : '') + '"'
    + ' type="button" data-node="' + esc(nodeId) + '" aria-pressed="' + active + '">'
    + head
    + '<span class="badge">' + ICONS[view.icon] + '<span>' + esc(node.status) + '</span></span>'
    + '</span>'
    + '<span class="tiles">'
    + '<span class="tile"><span class="tile-label">温度</span>'
    + '<span class="tile-value">' + fmt(node.temperature) + '<i class="tile-unit">℃</i></span></span>'
    + '<span class="tile"><span class="tile-label">湿度</span>'
    + '<span class="tile-value">' + fmt(node.humidity) + '<i class="tile-unit">%</i></span></span>'
    + '</span>'
    + handlingHTML
    + '<span class="card-foot">' + esc(node.durationText
      ? '已持续 ' + node.durationText : '更新于 ' + (node.time || '—')) + '</span>'
    + offline
    + '</button>';
}

function renderCards() {
  const nodes = snapshot && Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  el.cards.innerHTML = nodes.length === 0
    ? '<p class="cards-empty">还没有收到 core 的快照 —— 先起 core.py，'
      + '它会把三节点状态发布到 dormmate/v1/state（保留消息，页面一订就能拿到）。</p>'
    : nodes.map(cardHTML).join('');
}

/* ---------- 详情区 ---------- */

function renderDetailHead() {
  const node = selected ? nodeOf(snapshot, selected) : null;
  el.detailNode.textContent = selected || '—';
  if (!node) {
    el.detailMeta.textContent = '还没有收到 core 的快照';
    return;
  }
  el.detailMeta.textContent = node.status == null
    ? 'core 还没收到这个节点的数据'
    : '最新一条 ' + (node.time || '—') + ' · core 手里有这个节点的 '
      + fmt(node.historyCount) + ' 条读数';
}

/**
 * 重画「开始处理」按钮和它旁边那行字。
 *
 * **能不能按由 core 说了算**：这个宿舍有一条「待处理」的事件才能按
 * （`actionState` 判的，在 logic.js 里，单独可测）。
 *   - 一条数据都没有        -> 按了也没有对应的事件，按钮灰着并说明原因
 *   - 状态正常、也没有事件  -> 没有要处理的事
 *   - 异常但 core 还没开案  -> 「连续几条异常才开案」是 core 的规矩，按钮等着
 *   - 已经在处理中          -> 按下去只是多记一笔动作，core 那边用不上
 */
function renderAction() {
  const state = selected ? actionState(snapshot, selected)
    : { enabled: false, note: '还没有收到 core 的快照' };
  el.actionHandle.disabled = !state.enabled;
  el.actionState.textContent = state.note;
}

/* ---------- 顶部横幅（优先关注 / 跨端焦点） ---------- */

/**
 * 重画看板顶部那条横幅。
 *
 *   [跨端焦点] dorm-b｜处理中｜温度正在下降
 *              跨端焦点：mobile 发来的 focus 指令
 *              数据选出的重点是 dorm-a：已连续偏热 12 分钟（3 次）……
 *
 * 挑哪个宿舍、那几行字怎么写，全交给 logic.js 的 focusBanner —— 这个函数只
 * 负责把结果摆到页面上，一个比较都不做。两个来源（core 排出来的 priority、
 * 人在移动端点名的 focus）各自怎么说话，写在那边。
 *
 * 整块用 innerHTML 重画，和卡片一样，所以点击也是事件委托挂在容器上。
 * 它跟着 selected 变（要标出「正在查看」），切节点时也得重画。
 */
function renderFocus() {
  const banner = focusBanner(snapshot);

  if (banner.mode === 'calm') {
    el.focus.innerHTML = '<p class="focus focus--calm">'
      + '<span class="focus-tag">当前重点</span>'
      + '<span class="focus-text">' + esc(banner.line) + '</span>'
      + '</p>';
    return;
  }

  /* 颜色跟着这个宿舍的状态走，和卡片用同一套 class、同一套状态色。
     状态可能为 null（被点名的宿舍还没收到数据）—— 那就用中性那套。 */
  const view = viewFor(banner.status);
  const current = banner.nodeId === selected;
  const reason = banner.reason
    ? '<span class="focus-reason">' + esc(banner.reason) + '</span>' : '';
  const cross = banner.cross
    ? '<span class="focus-cross">' + esc(banner.cross) + '</span>' : '';

  el.focus.innerHTML = '<button class="focus ' + view.cls
    + (current ? ' is-active' : '') + '"'
    + ' type="button" data-node="' + esc(banner.nodeId) + '" aria-pressed="' + current + '">'
    + '<span class="focus-tag">' + esc(banner.tag) + '</span>'
    + '<span class="focus-icon" aria-hidden="true">' + ICONS[view.icon] + '</span>'
    + '<span class="focus-text">' + esc(banner.line) + '</span>'
    + '<span class="focus-state">' + (current ? '正在查看' : '查看详情') + '</span>'
    + reason + cross
    + '</button>';
}

/* ---------- 语音提醒 ---------- */

/* 语音合成用浏览器自带的 speechSynthesis。念的是**当前最重要的一句**，
   不是把三个宿舍从头到尾念一遍 —— 声音是线性的，说过就过去了，
   念三段话听的人只记得住最后一句。那句话由 logic.js 的 alertLine 从快照里
   拼出来（和上面那条横幅说的是同一个宿舍）。 */
const SPEECH_LANG = 'zh-CN';

function setSpeakNote(text) {
  el.speakNote.textContent = text;
}

/**
 * 浏览器支不支持语音合成。
 *
 * 两个都要查：Chrome 上 speechSynthesis 一直存在，但 SpeechSynthesisUtterance
 * 是个构造函数，缺了它 new 出来就是个 TypeError。少查一个的话，
 * 不支持的环境里点一下按钮就是一条未捕获的异常 —— 按钮看着能用，按下去什么也没有。
 */
function speechSupported() {
  return typeof window.speechSynthesis !== 'undefined'
    && typeof window.SpeechSynthesisUtterance === 'function';
}

/**
 * 念一遍当前最重要的一句提醒。
 *
 * **每次都现算**，不缓存上一句 —— 念之前数据可能已经变了，念一句旧的比不念更糟。
 *
 * 先 cancel() 再 speak()：连点两次的话，第二句会老老实实排在队列里等着，
 * 等第一句念完（好几秒）它才开口，而那时候念的是**按下按钮那一刻**算出来的话，
 * 早就不算数了。
 *
 * 无论成功还是失败，都把念的内容写到按钮下面那行 —— 静音、没音箱、
 * 声音太小的时候，那一行是唯一能确认「它到底念了什么」的地方。
 */
function speakAlert() {
  const text = alertLine(snapshot);

  if (!speechSupported()) {
    setSpeakNote('这个浏览器不支持语音合成（window.speechSynthesis 不存在）。'
      + '要念的是：' + text);
    return;
  }

  window.speechSynthesis.cancel();

  const utterance = new window.SpeechSynthesisUtterance(text);
  utterance.lang = SPEECH_LANG;

  /* 出错也要说出来。原始的错误码写在最前面 —— 解释文案可能对不上，
     错误码不会骗人（和 3-2 那张 VOICE_ERRORS 表同一条原则）。 */
  utterance.onerror = function (event) {
    const code = event && event.error ? event.error : 'unknown';
    setSpeakNote('朗读失败（' + code + '）。要念的是：' + text);
  };

  window.speechSynthesis.speak(utterance);
  setSpeakNote('正在朗读：' + text);
}

/* ---------- 事件记录 ---------- */

/* 表格里一格「时间 + 一句说明」。
   这两格（优先关注、处理动作）的内容比别的格子长得多，所以说明另起一行、
   用淡一点的颜色，不跟时间挤在一起，也不让整张表被横向撑开。 */
function eventCell(time, note) {
  if (!time) return '<span class="ev-none">—</span>';
  return '<span class="mono">' + esc(time) + '</span>'
    + (note ? '<span class="ev-reason">' + esc(note) + '</span>' : '');
}

/* 一行事件。字段名和 core 的 `Event.view()` 一个一个对齐（那边有注释说明
   为什么对齐）：改这里就得改那边，改那边这条表就空一格。 */
function eventRowHTML(e) {
  /* 还没结案的那条，用中性灰标出 core 那边的状态名，而不是留个空格子 ——
     空着看的人分不清是「还在异常中」还是「这一格没数据」。 */
  const state = eventStateText(e.state);
  const closed = e.state === 'RECOVERED' || e.state === 'UNRESOLVED';
  const result = closed
    ? '<span class="ev-result ev-result--done">' + esc(e.result || state) + '</span>'
    : '<span class="ev-result ev-result--open">' + esc(state) + '</span>';

  return '<tr>'
    + '<td class="mono">' + esc(e.startTime) + '</td>'
    + '<td class="mono">' + esc(e.nodeId) + '</td>'
    + '<td>' + esc(e.problem) + '</td>'
    + '<td class="ev-cell">' + eventCell(e.priorityTime, e.priorityReason) + '</td>'
    + '<td class="ev-cell">' + eventCell(e.actionTime, e.action) + '</td>'
    + '<td class="mono">' + (e.recoverTime
      ? esc(e.recoverTime) : '<span class="ev-none">—</span>') + '</td>'
    + '<td>' + result + '</td>'
    + '</tr>';
}

/**
 * 最近这一帧快照里的那几条事件，**最新的在最上面**。
 *
 * core 的快照是**从旧到新**给的（那是这份名单该有的读法：一件事从头到尾
 * 怎么走过来的）。看板要的是「最近发生了什么」，所以这里翻一下 ——
 * 翻的是**显示顺序**，不是数据：导出的 CSV 跟着表格走（「导出的东西和屏幕上
 * 看到的一模一样」是 7-4 定下的口径）。
 *
 * @returns {Array<Object>}
 */
function eventRows() {
  const block = snapshot && snapshot.events && Array.isArray(snapshot.events.events)
    ? snapshot.events.events : [];
  return block.slice().reverse();
}

/**
 * 重画「事件记录」区。
 *
 * 「共 N 条」读的是 core 的 `summary.total`，**不是**这一屏摆了几行 ——
 * 快照里只带最近 20 条，挂机久了真实的条数比能显示的多。两个数混成一个的话，
 * 「一共发生过多少条」会跟着屏幕一起封顶。
 */
function renderEvents() {
  const rows = eventRows();
  const block = snapshot && snapshot.events ? snapshot.events : {};
  const total = Number.isFinite(block.summary && block.summary.total)
    ? block.summary.total : rows.length;

  el.evCount.textContent = total > 0
    ? '共 ' + total + ' 条' + (total > rows.length ? '（显示最近 ' + rows.length + ' 条）' : '')
    : '';
  el.evBody.innerHTML = rows.length === 0
    ? '<tr><td colspan="7" class="log-empty">还没有事件'
      + '（core 那边连续几条异常才会开一条）</td></tr>'
    : rows.map(eventRowHTML).join('');

  /* 没什么可导的时候把按钮按掉，而不是让人点了弹一个空文件 ——
     空 CSV 只有一行表头，拿到的人会以为导出坏了。 */
  el.exportEvents.disabled = rows.length === 0;
}

/* 导出 CSV 的表头。顺序就是 core 那边 `Event.view()` 与这张表的九个字段，
   两边要对得上（字段名对齐是 core 侧有意做的，见 events.py 里 view() 的注释）。 */
const EVENT_HEADER = ['nodeId', 'startTime', 'problem', 'priorityTime', 'priorityReason',
  'action', 'actionTime', 'recoverTime', 'result'];

const EVENT_FILENAME = 'events.csv';

/* RFC 4180：字段含逗号/引号/换行时要包双引号，内部的双引号写成两个。
   和 web/script.js 里那份是同一个写法，故意各留一份：两个页面互不依赖，
   为六行代码共用一个 shared/ 文件反而要多发一次请求。改的时候两边一起改。 */
function csvCell(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * 拼出事件 CSV 的全文（不含 BOM，加 BOM 是下载那一步的事）。
 *
 * 行顺序和「事件记录」区里看到的一致（最新在前），和 web/ 那边导出录入历史
 * 是同一个口径：导出的东西和屏幕上看到的一模一样。复盘要按时间正着看，
 * 那是 Python 侧读进来之后自己排，不靠这里把顺序改掉。
 *
 * @returns {string} CRLF 换行、末尾也带一个 CRLF
 */
function buildEventsCSV() {
  const lines = [EVENT_HEADER.join(',')];
  eventRows().forEach(function (e) {
    lines.push(EVENT_HEADER.map(function (key) {
      const v = e[key];
      /* 还没发生的格子是 null，要写成空 —— String(null) 会变成四个字母的
         "null"，Excel 里看着像真存了一个叫 null 的值。 */
      return csvCell(v == null ? '' : v);
    }).join(','));
  });
  /* 用 CRLF 换行：Excel / WPS 对 LF 的兼容性不如 CRLF */
  return lines.join('\r\n') + '\r\n';
}

function exportEventsCSV() {
  /* '﻿' 是 UTF-8 BOM。少了它 Excel/WPS 会按本地代码页解析，
     problem 和 result 里的中文就会变成乱码。这里写成转义而不是字面量字符，
     否则源码里是一段隐形字符，看起来像个空字符串。 */
  const blob = new Blob(['﻿' + buildEventsCSV()], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = EVENT_FILENAME;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  /* 不能立刻 revoke：部分浏览器会在下载真正开始前就把 blob 释放掉，
     表现为「点了没反应」。留一点时间再回收。 */
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

/* ---------- 被拒绝消息（Step E3-2 新增） ---------- */

/**
 * 一行被拒绝的消息：什么时候、哪条 topic、为什么、原文是什么。
 *
 * **原文一定要摆出来**（core 那边特意存的是没转过义的原文，见
 * `publish_reject`）：只写一句「JSON 解析失败」的话，发消息的人根本不知道
 * 自己哪里写错了。这是 D4 那套故障注入的对照面 —— 发出去之后不用去 core 的
 * 终端里翻，看板上这一块直接对着抄。
 */
function rejectRowHTML(item) {
  const reasons = Array.isArray(item.reasons) ? item.reasons : [];
  return '<tr>'
    + '<td class="mono">' + esc(item.time) + '</td>'
    + '<td class="mono">' + esc(item.topic) + '</td>'
    + '<td class="rj-reasons">' + reasons.map(function (r) {
      return '<span class="rj-reason">' + esc(r) + '</span>';
    }).join('') + '</td>'
    + '<td><code class="rj-payload">' + esc(item.payload) + '</code></td>'
    + '</tr>';
}

/**
 * 重画「被拒绝消息」区。
 *
 * 【这一块为什么不订 `dormmate/v1/log/reject`】core 那条 topic 照发不误
 * （MQTTX 和 D4 的 inject_faults.py 都靠它），但看板不订它 —— 前端只订一条
 * topic 是 E3 的硬约束，而且两条流合成一张表还要自己处理「刷新页面时之前那几条
 * 哪去了」和「reject 和快照谁先到」。快照里那一块是**那一帧的全貌**，
 * 一帧就是一次重画，没有对不齐的中间状态。
 *
 * 顺序反过来摆（最新的在最上面）：core 的环形缓冲是从旧到新追加的。
 */
function renderRejects() {
  const block = snapshot && snapshot.rejects ? snapshot.rejects : {};
  const items = Array.isArray(block.items) ? block.items : [];
  const rows = items.slice().reverse();
  const total = Number.isFinite(block.total) ? block.total : rows.length;

  el.rjCount.textContent = total > 0
    ? '共 ' + total + ' 条' + (total > rows.length ? '（显示最近 ' + rows.length + ' 条）' : '')
    : '';
  el.rjBody.innerHTML = rows.length === 0
    ? '<tr><td colspan="4" class="log-empty">core 一条都没拒过</td></tr>'
    : rows.map(rejectRowHTML).join('');
}

/* ---------- 3D 视图 ---------- */

/* 建不出来就是 null（这台设备没有 WebGL、或者 three 没加载上）。
   scene.js 会把原因写进容器里给看的人看，这里只负责别让后面崩掉：
   renderScene 头一行就是「没有就什么都不做」，页面其余部分照常用。 */
const dorm3d = initScene3D();

function initScene3D() {
  try {
    return createDorm3D('scene3d');
  } catch (err) {
    console.error('[DormMate] 3D 视图初始化失败，页面其余部分不受影响：', err);
    return null;
  }
}

/**
 * 把当前选中宿舍的状态画到 3D 视图上。
 *
 * 每次都从快照里重新读，不看上一次画的是什么 —— 幂等，所以切节点时直接调，
 * 不用先判断「变了没有」。
 *
 * status 直接用快照里的（那是 core 算好的），这里**不复核也不重算** ——
 * 页面这一轮起连阈值都不认识。
 */
function renderScene() {
  if (!dorm3d) return;

  const node = selected ? nodeOf(snapshot, selected) : null;

  /* 还没收到数据的宿舍。scene.js 认不出「没有状态」这件事（它只认那四个字），
     所以退回「正常」的外观，再在覆盖层上如实写明还没收到 ——
     空白或者半成品的样子，看的人分不清是「还没收到」还是「页面坏了」。 */
  if (!node || node.status == null) {
    dorm3d.updateScene('正常');
    dorm3d.setLabel('当前宿舍：' + (selected || '—') + '（core 还没收到数据）');
  } else {
    dorm3d.updateScene(node.status);
    /* 标签上**只留宿舍名**（8-3 改的）：宿舍名是场景答不出来的（画面里只有
       一间屋，不说不知道是哪个），「这间怎么了」交给画面自己说。 */
    dorm3d.setLabel('当前宿舍：' + selected);
  }

  /* 风扇。两个来源，都和上面那次 updateScene **叠在一起**，谁也不覆盖谁：
       1) 状态要它转 —— scene.js 的 LOOK 表里「偏热」本来就是 fan: true，
          updateScene 内部已经调过一次 setFanOn 了；
       2) 有人按过「开始处理」 —— core 的事件里记着那笔动作，扇叶就一直转着。
     位置必须在 updateScene **之后**：scene.js 里写着「后调用的那次为准」，
     放在前面会被 updateScene 自己那次盖掉。 */
  if (selected && fanOn(snapshot, selected)) dorm3d.setFanOn(true);

  /* 切节点之后那圈「当前重点」的环也要跟着改口 */
  renderFocusMark();
}

/**
 * 只更新「当前重点」那圈标记，画面其余部分一动不动。
 *
 * 单独一个函数，是因为它和「重画场景」的**时机**可以不一样：收到新快照时
 * 「谁是重点」可能换人，而画面本身不用重画（换重点不等于换选中项）。
 *
 * 判据是**横幅上说的那个宿舍**（被点名 > 是重点），和顶部那条横幅同源 ——
 * 环亮着的地方，就是横幅上写的那个宿舍。两处各判一遍的话，迟早出现
 * 「环亮在 dorm-a、横幅写着 dorm-b」。
 */
function renderFocusMark() {
  if (!dorm3d) return;
  const banner = focusBanner(snapshot);
  dorm3d.setFocus(banner.mode !== 'calm' && banner.nodeId === selected);
}

/* ---------- 图表 ---------- */

/* 两张图各自的颜色。变量值定义在 style.css 的 :root 和深色那段里。
   这两组值不是眼睛挑的：用 dataviz 的 validate_palette.js 跑过 OKLCH 亮度带、
   色度下限、色觉模拟分离度（protan/deutan）、与底色的 WCAG 对比度，浅色
   #2a78d6+#c9407f、深色 #4a8fe0+#c05c8e 两两组合全部通过。改颜色记得重跑。 */
const CHART_SPECS = [
  /* suggestedMin/Max 是给纵轴一个固定的物理范围，好让三个节点的图能纵向对比 ——
     如果让 Chart.js 自动缩放，dorm-a 的 58% 和 dorm-c 的 80% 都会被拉满整张图，
     看上去一模一样，反而看不出差别。这两个值只是建议，数据超出去会自动扩展，
     不会把点裁掉。 */
  { id: 'temperature', label: '温度', canvas: 'chart-temp',
    colorVar: '--chart-temp', unit: '℃', suggestedMin: 10, suggestedMax: 40 },
  { id: 'humidity', label: '湿度', canvas: 'chart-humidity',
    colorVar: '--chart-humidity', unit: '%', suggestedMin: 0, suggestedMax: 100 },
];

const charts = {};
let chartBroken = false;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function buildChart(spec) {
  const color = cssVar(spec.colorVar);
  const surface = cssVar('--surface-1');
  const grid = cssVar('--chart-grid');
  const tick = cssVar('--text-muted');

  return new Chart(document.getElementById(spec.canvas), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: spec.label,
        data: [],
        borderColor: color,
        borderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: color,
        /* 点外面套一圈底色：点密了互相压住时也能分清边界 */
        pointBorderColor: surface,
        pointBorderWidth: 2,
        tension: 0.25,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
      /* 不要求鼠标正好压在点上，横向扫过去就出读数 */
      interaction: { mode: 'index', intersect: false },
      plugins: {
        /* 单序列：图上方的小标题已经说明画的是什么，不需要图例 */
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            label: function (item) { return item.formattedValue + ' ' + spec.unit; },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: grid },
          ticks: { color: tick, maxRotation: 0, autoSkipPadding: 12, font: { size: 11 } },
        },
        y: {
          suggestedMin: spec.suggestedMin,
          suggestedMax: spec.suggestedMax,
          grid: { color: grid },
          border: { display: false },
          ticks: {
            color: tick,
            font: { size: 11 },
            callback: function (v) { return v + spec.unit; },
          },
        },
      },
    },
  });
}

/**
 * 图表只在第一次用的时候建。返回 false 表示 Chart.js 没加载上。
 * 这里不抛异常、也不留一张空白图：没网的时候把原因写在页面上，
 * 比一个什么都不显示的方块好排查。
 */
function ensureCharts() {
  if (charts.temperature) return true;

  if (typeof Chart !== 'function') {
    if (!chartBroken) {
      chartBroken = true;
      el.chartNote.textContent = '没加载到 Chart.js，趋势图画不出来。'
        + '现场没网时把 chart.umd.min.js 放到 dashboard/lib/ 下，'
        + '再把 index.html 里那行 <script src> 改成 lib/chart.umd.min.js。';
      el.chartNote.classList.add('is-error');
      document.querySelector('.charts').classList.add('is-broken');
    }
    return false;
  }

  CHART_SPECS.forEach(function (spec) {
    charts[spec.id] = buildChart(spec);
  });
  return true;
}

/**
 * 画当前选中宿舍的曲线。
 *
 * 数据来自**快照里那个 `history` 数组**（core 每个周期跟着快照一起发的
 * 最近 50 条）。这是 E3 里一个不显眼但很要紧的地方：页面不再订遥测，
 * 所以如果快照不带历史，刷新一下图上就什么也没有，得干等几分钟才看得出走势 ——
 * 而「刚刚是不是在降」正是最该看的时候。
 */
function renderCharts() {
  if (!ensureCharts()) return;

  const node = selected ? nodeOf(snapshot, selected) : null;
  const rows = node && Array.isArray(node.history) ? node.history : [];
  /* "2026-09-22 20:30:00" 的第 11 位起就是 "20:30:00"，横轴只要时分秒 */
  const labels = rows.map(function (r) { return String(r && r.time).slice(11, 19); });

  CHART_SPECS.forEach(function (spec) {
    const chart = charts[spec.id];
    chart.data.labels = labels;
    chart.data.datasets[0].data = rows.map(function (r) {
      return r ? r[spec.id] : null;
    });
    chart.update();
  });
}

/**
 * 系统深浅色切换时，把图表的颜色也换掉。
 * Chart.js 是画在 canvas 上的，拿不到 CSS 变量，只能我们自己读出来再塞回去。
 */
function applyChartTheme() {
  if (!charts.temperature) return;
  const grid = cssVar('--chart-grid');
  const tick = cssVar('--text-muted');
  const surface = cssVar('--surface-1');

  CHART_SPECS.forEach(function (spec) {
    const chart = charts[spec.id];
    const color = cssVar(spec.colorVar);
    chart.data.datasets[0].borderColor = color;
    chart.data.datasets[0].pointBackgroundColor = color;
    chart.data.datasets[0].pointBorderColor = surface;
    chart.options.scales.x.border.color = grid;
    chart.options.scales.x.ticks.color = tick;
    chart.options.scales.y.grid.color = grid;
    chart.options.scales.y.ticks.color = tick;
    chart.update('none');
  });
}

/* ---------- 选择当前节点 ---------- */

/**
 * 换成看另一个宿舍。趋势图、3D、详情区、按钮都跟着走。
 *
 * 这个函数**不发任何消息**：移动端那一侧的「点一下切换焦点」才发 focus 指令，
 * 看板这边点卡片只是换个视角（想看哪个宿舍是自己屏幕上的事，没必要广播出去）。
 * 跨端联动是**单向**的：移动端 -> core -> 看板。反过来的话，两个人同时看
 * 看板就会互相抢焦点。
 */
function selectNode(nodeId) {
  if (!nodeId || nodeId === selected) return;
  if (!nodeOf(snapshot, nodeId)) return;
  selected = nodeId;
  renderCards();
  renderDetailHead();
  renderAction();
  renderScene();
  renderCharts();
  /* 横幅上标着「正在查看 / 查看详情」，那两个字跟着 selected 走，
     所以内容一个字没变也得重画一次。 */
  renderFocus();
}

/* ---------- 唯一的消息入口 ---------- */

/**
 * 处理一条快照。整个页面只有这一个入口。
 *
 * 顺序是刻意的，前面一步没过就 return，不做下一步：
 *   1) topic 必须就是那一条 —— 只订了它，别的都当没看见（写进日志）
 *   2) JSON.parse 包 try/catch —— 坏数据什么都能抛
 *   3) readSnapshot 校验形状与版本（在 logic.js 里，单独可测）
 *   4) 换掉内存里那一帧，然后整页重画
 *
 * **没有第 5 步**：页面不加工、不合并、不记账。一帧快照就是全部事实。
 *
 * @param {string} topic
 * @param {string} payloadText 报文原文
 * @returns {boolean} true = 收下了；false = 被拦下，原因见消息日志
 */
function handleMessage(topic, payloadText) {
  if (!CFG) {
    logLine('error', topic, '未加载 shared/config.js，请检查 <script> 的引入顺序');
    return false;
  }

  /* 1) 只认那一条 topic。多订一条都会走这个入口，不挡的话「别的 topic 上的
        一条消息把整页刷成空的」这种事迟早发生。 */
  if (topic !== CFG.STATE_TOPIC) {
    logLine('warn', topic, '不是快照 topic（' + CFG.STATE_TOPIC + '），已忽略');
    return false;
  }

  /* 2) 解析 */
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch (err) {
    logLine('error', topic, 'JSON 解析失败：' + err.message);
    return false;
  }

  /* 3) 形状与版本 */
  const result = readSnapshot(payload);
  if (!result.ok) {
    logLine('error', topic, '快照校验不通过：' + result.reason);
    return false;
  }

  /* 4) 换帧。注意是**整份替换**（不是逐字段合并）—— 快照的意义就在于
        「这一帧就是此刻的全部」，残留上一帧的字段会做出一个不存在的状态。 */
  snapshot = result.snapshot;

  syncSelection();

  const banner = focusBanner(snapshot);
  const focusId = snapshot.focus && typeof snapshot.focus.nodeId === 'string'
    ? snapshot.focus.nodeId : '';

  /* 跨端联动那件事只在**变化时**记一行 —— 快照是会反复发的，
     每次都记的话日志会被同一句话刷屏，反而看不出哪一次真的变了。 */
  if (focusId !== loggedFocus) {
    loggedFocus = focusId;
    if (focusId) {
      const by = snapshot.focus.by ? String(snapshot.focus.by) : '别的端';
      logLine('ok', topic, '跨端焦点 → ' + focusId + '（' + by + ' 发的 focus），'
        + '趋势图和 3D 跟着切过去');
    } else {
      logLine('ok', topic, '跨端焦点已取消，回落到 core 选出的重点'
        + (banner.nodeId ? '（' + banner.nodeId + '）' : ''));
    }
  }

  /* core 又拒了一条。数量涨了就提醒一句，原因摆在被拒绝消息那块面板上。 */
  const rejects = snapshot.rejects && Number.isFinite(snapshot.rejects.total)
    ? snapshot.rejects.total : 0;
  if (loggedRejects !== null && rejects > loggedRejects) {
    const items = Array.isArray(snapshot.rejects.items) ? snapshot.rejects.items : [];
    const last = items.length > 0 ? items[items.length - 1] : null;
    logLine('warn', topic, 'core 拒收了 ' + (rejects - loggedRejects) + ' 条消息'
      + (last ? '：「' + (last.reasons || []).join('；') + '」' : '')
      + '，原文见下面「被拒绝消息」那块');
  }
  loggedRejects = rejects;

  logLine('ok', topic, snapshotSummary(snapshot));

  renderAll();
  return true;
}

/**
 * 从快照里定下来「现在看哪个宿舍」。
 *
 * 两条规矩：
 *   1) 快照里有哪几个宿舍是 core 说了算 —— 选中的那个要是已经不在名单里了，
 *      退回第一个（core 改了配置就会发生）。
 *   2) **焦点变了就跟着切**（E3 的跨端联动：移动端点一下，看板和 3D 一起跟过去）。
 *      但跟着切过之后就不再抢：用户点别处看，下一条一模一样的快照不该把他拽回来。
 *      所以比的是「这个目标跟过了没有」，不是「这一帧里有没有焦点」。
 */
function syncSelection() {
  const nodes = snapshot && Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const ids = nodes.map(function (n) { return n && n.nodeId; }).filter(Boolean);
  if (ids.length === 0) return;

  if (!selected || ids.indexOf(selected) === -1) {
    selected = ids[0];
    followed = undefined;
  }

  const focusId = snapshot.focus && typeof snapshot.focus.nodeId === 'string'
    ? snapshot.focus.nodeId : '';
  const topId = snapshot.priority && typeof snapshot.priority.nodeId === 'string'
    ? snapshot.priority.nodeId : '';
  const target = focusId || topId;

  if (!target || ids.indexOf(target) === -1) return;
  if (target === followed) return;

  followed = target;
  selected = target;
}

/** 整页重画。收到一帧快照之后走一遍。 */
function renderAll() {
  renderCards();
  renderDetailHead();
  renderAction();
  renderFocus();
  renderEvents();
  renderRejects();
  renderScene();
  renderCharts();
}

/* ---------- 清空 ---------- */

/**
 * 把页面上的东西擦干净。
 *
 * 【它清的是**屏幕**，不是 core】快照是 retained 的，core 手里那份数据一点
 * 没动 —— 所以清空之后下一条快照一到，画面立刻原样回来。这一点必须说清楚：
 * 以前「清空」清的是页面自己攒的那份数据，看起来像「把数据删了」；
 * 现在页面根本没有那份数据可删。
 */
function clearAll() {
  snapshot = null;
  selected = null;
  followed = undefined;
  loggedFocus = '';
  loggedRejects = null;
  messages.length = 0;

  el.cards.innerHTML = '<p class="cards-empty">屏幕已清空 —— '
    + 'core 手里那份数据没动，下一条快照一到画面就回来了。</p>';
  el.detailNode.textContent = '—';
  el.detailMeta.textContent = '屏幕已清空';
  el.actionHandle.disabled = true;
  el.actionState.textContent = '';
  el.focus.innerHTML = '';
  el.evBody.innerHTML = '<tr><td colspan="7" class="log-empty">屏幕已清空</td></tr>';
  el.evCount.textContent = '';
  el.exportEvents.disabled = true;
  el.rjBody.innerHTML = '<tr><td colspan="4" class="log-empty">屏幕已清空</td></tr>';
  el.rjCount.textContent = '';
  renderLog();

  /* 图表也清掉：留着上一条曲线的话，屏幕上就有一份「已经不在快照里的数据」。 */
  if (ensureCharts()) {
    CHART_SPECS.forEach(function (spec) {
      charts[spec.id].data.labels = [];
      charts[spec.id].data.datasets[0].data = [];
      charts[spec.id].update();
    });
  }

  if (dorm3d) {
    dorm3d.updateScene('正常');
    dorm3d.setLabel('当前宿舍：—');
    dorm3d.setFocus(false);
  }

  /* 那两行说明也擦掉：它们说的是**上一次**发生了什么，
     清空之后还挂着，看上去像是刚刚发生的。 */
  setSpeakNote('');
  el.cmdNote.textContent = '';
}

/* ---------- MQTT ---------- */

/* 当前那根连接。null 表示没连上，或已被主动断开。 */
let client = null;

function setConn(kind, text) {
  el.conn.className = 'conn conn--' + kind;
  el.connText.textContent = text;
}

function updateToggle() {
  el.toggle.textContent = client ? '断开' : '连接';
}

/**
 * 订阅用的那一条 topic —— 就是快照那条，别的都不订。
 *
 * 以前这里是 `dormmate/v1/nodes/+/telemetry`（三个宿舍的原始读数混在一条
 * 通配符 topic 里）。E3 之后页面**一条遥测都不订**：收原始读数就意味着
 * 又要自己算一遍，那正是这一轮要拆掉的东西。
 */
function snapshotTopic() {
  return CFG ? CFG.STATE_TOPIC : '';
}

/**
 * 断开并停止自动重连。
 *
 * 先把 client 置空再 end()：end() 会触发 close 回调，那时 client 已经是 null，
 * 回调里的 current() 认出「这是被主动断开的那根」而直接返回，不会过一会儿又把
 * 状态覆盖回「已断开」。不这么做的话，点「断开」会闪一下「未连接」再跳回「已断开」。
 */
function disconnect() {
  const c = client;
  client = null;
  if (c) c.end(true);   // true = 强制断开，不再自动重连
  setConn('off', '未连接');
  updateToggle();
}

function connect() {
  if (!CFG) {
    setConn('off', '未加载 shared/config.js');
    return;
  }
  if (typeof mqtt === 'undefined') {
    setConn('off', '未加载 mqtt.js');
    logLine('error', CFG.STATE_TOPIC, '缺少 dashboard/lib/mqtt.min.js，请重新下载后刷新');
    return;
  }
  if (client) return;   // 已经连着了，别叠第二根

  setConn('pending', '连接中…');

  const c = mqtt.connect(CFG.brokerUrlFor(), {
    clientId: 'dormmate-dash-' + Math.random().toString(16).slice(2, 8),
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 5000,
    keepalive: 30,
  });
  client = c;

  /* 每个回调开头都先确认自己还是当前那根连接。断开或换过连接之后，旧连接的回调
     还可能补触发一次，不挡掉就会把新连接的状态覆盖成旧的。 */
  function current() { return client === c; }

  c.on('connect', function () {
    if (!current()) return;
    setConn('on', '已连接');
    updateToggle();
    c.subscribe(snapshotTopic(), { qos: CFG.QOS }, function (err) {
      if (err) {
        console.error('[DormMate] 订阅失败：', err);
        setConn('off', '订阅失败');
      }
    });
  });

  c.on('reconnect', function () {
    if (!current()) return;
    setConn('pending', '重连中…');
  });

  c.on('close', function () {
    if (!current()) return;
    setConn('off', '已断开');
  });

  c.on('offline', function () {
    if (!current()) return;
    setConn('off', '已离线');
  });

  c.on('error', function (err) {
    if (!current()) return;
    console.error('[DormMate] 连接错误：', err);
    setConn('off', '连接失败');
  });

  /* 唯一的接入口。mqtt.js 给的是二进制，转成字符串交给 handleMessage ——
     校验、换帧、重画全在那边，这里不做第二遍。 */
  c.on('message', function (topic, payload) {
    const text = payload.toString();

    /* 每条原始报文都往 Console 打一行。排错时先看这里 ——
       「压根没收到消息」和「收到了但被 handleMessage 拦下了」是两回事，
       排查方向完全不同，而页面上的日志区只记后者，前者完全不显示。 */
    console.log('[DormMate] 收到 MQTT 原始消息', topic, text);

    handleMessage(topic, text);
  });

  updateToggle();
}

/* ---------- Rule-ML 辅助判断（Step 9-3 的进阶项）---------- */

/* 这一段和上面所有东西都不一样：它**不来自 MQTT**。
   那份 JSON 是 analysis/analysis.py 上一次跑完写下的（见那个文件的
   write_ml_result），页面只是取过来摆在这儿。两件事跟着来：

     1) 它是个静态文件 —— 页面开一次读一次，读完就不再变。看板上别的数字
        都在跟着快照动，只有这一块不动。所以 #ml-note 里那句「不是实时数据」
        得留在页面上（由 buildMlNote 给），不能嫌啰嗦删掉。
     2) 跟 Broker 没关系 —— 现场没网、mqtt.js 没加载、broker 没起，
        这一段照样显示（当然，前提是页面本身是从 http 服务器打开的）。

   路径相对**本页面**算：页面在 dashboard/ 下，所以是 ../report/ml_result.json。
   这个路径只在下面这一处写，fetch 的 stub 也是照它对的。 */
const ML_JSON_URL = '../report/ml_result.json';

/* 把三段字摆到页面上。**这里一个字都不拼** —— 说什么全由 logic.js 的
   buildMlNote / mlFetchFailed 决定，那两个是纯函数，单独测得住。

   成功、读坏了、读不到三条路都走这一个函数：它们拿回来的都是同样那三样
   （条数 / 结论 / 说明），所以页面上只有一条摆放方式，不用为出错再写一套。 */
function renderMl(note) {
  el.mlCount.textContent = note.count;
  el.mlText.textContent = note.text;
  el.mlNote.textContent = note.note;
}

/* 读一次那份 JSON。

   ⚠ 这里必须用 fetch 而不是把 JSON 直接 import 进来。
   import 一个 .json 在浏览器里要么得加 import attributes（Safari 还不认），
   要么得改后缀，而且**打不开就是整页白屏** —— 一份辅助结论读不到，
   不该把看板拖垮。fetch 失败还能 catch 住，降级成一行字。

   三种失败都要落到同一句降级话上，所以 catch 放在链子最后：
     404（没跑过脚本）/ 打不开（页面不是从项目根目录起的服务器）/
     回来不是 JSON（文件被别的程序占着写了一半）。
   reason 取异常自己的话，不翻译 —— 「HTTP 404」和「Unexpected token <」
   指向的是两个完全不同的排查方向。 */
function loadMlResult() {
  return fetch(ML_JSON_URL)
    .then(function (resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    })
    .then(function (data) { renderMl(buildMlNote(data)); })
    .catch(function (err) {
      renderMl(mlFetchFailed(err && err.message ? err.message : String(err)));
    });
}

/* ---------- 启动 ---------- */

el.clear.addEventListener('click', clearAll);
el.exportEvents.addEventListener('click', exportEventsCSV);

el.toggle.addEventListener('click', function () {
  if (client) disconnect();
  else connect();
});

/* 卡片是每次重绘的，所以点击用事件委托挂在容器上，不给每张卡单独绑 */
el.cards.addEventListener('click', function (e) {
  const card = e.target && e.target.closest ? e.target.closest('.card') : null;
  if (card && card.dataset.node) selectNode(card.dataset.node);
});

/* 顶部那条横幅也是重绘的，同样用委托。
   它跟卡片走的是**同一条路**（selectNode）—— 点它和点对应那张卡片
   没有任何区别，详情区、趋势图、3D 一起切过去。
   平静时候那里是个没有 data-node 的 <p>，这个判断顺手把它挡掉了。 */
el.focus.addEventListener('click', function (e) {
  const banner = e.target && e.target.closest ? e.target.closest('.focus') : null;
  if (banner && banner.dataset.node) selectNode(banner.dataset.node);
});

/* 「语音提醒」。念什么完全由 alertLine 现算 —— 这里一个字都不拼。 */
el.speak.addEventListener('click', speakAlert);

/**
 * 把一条「开始处理」发给 core。返回 `{ok, reason}`，**不抛异常**。
 *
 * 【只发事实，不发结论】这条消息里没有 status、没有 state、没有任何「已恢复」。
 * core 收到它只会把事件从待处理推到处理中，之后好没好由它后面收到的报文
 * 说了算 —— 这条红线在 core 那边是结构上成立的（`handle_command` 拿不到
 * 节点状态），这边只需要不往消息里塞那些东西。
 *
 * 【E3-2 起页面**不再本地记账**】以前按一下会就地改四个字段（handling /
 * action / actionTime / dataAfterAction），于是屏幕上立刻写「处理中」。
 * 现在什么都不改：卡片上那行「处理中」要等 core 把新快照发回来才出现。
 * 这条路更慢，但它是**唯一**能保证「屏幕上写的和 core 想的是同一件事」的做法 ——
 * 点击直接把事件置成处理中（更别说置成已恢复）本来就是红线。
 *
 * 【带 time】带的是**最新那条快照里这个节点的时刻**，不是浏览器时钟。
 * 不给的话 core 会用自己的当下时刻盖章，于是同一个动作两个说法。
 *
 * 【不 retained】指令是一次性的。留在 broker 上的话，下一次起 core 时会
 * 凭空把某条事件推进「处理中」—— 那条指令是上一次演示发的，人早忘了。
 *
 * 【不进消息日志】日志区的约定是「一条快照一行」，行数是排查时用来对数的。
 * 这里只往 Console 打一行。
 *
 * @param {string} nodeId
 * @param {string} actionTime
 * @returns {{ok: boolean, reason: string}}
 */
function sendHandle(nodeId, actionTime) {
  if (!CFG) return { ok: false, reason: '未加载 shared/config.js' };
  if (!client || !client.connected) {
    return {
      ok: false,
      reason: client ? '还没连上 broker' : '连接还没建立（mqtt.js 没加载或已断开）',
    };
  }

  const payload = { nodeId: nodeId, action: CFG.CMD_ACTION, source: SOURCE_DASHBOARD };
  /* time 只在真的是个非空字符串时才带上。JSON.stringify 会把 undefined 的键
     直接丢掉，所以这里显式判一下，别靠它的副作用。 */
  if (typeof actionTime === 'string' && actionTime) payload.time = actionTime;

  const text = JSON.stringify(payload);
  client.publish(CFG.CMD_TOPIC, text, { qos: CFG.QOS, retain: CFG.CMD_RETAIN });
  console.log('[DormMate] 发出 MQTT 指令', CFG.CMD_TOPIC, text);
  return { ok: true, reason: '' };
}

/* 指令里带的来源。core 会把它打进日志：`[指令] dorm-b handle（dashboard）`——
   演示的时候一眼分出这一条是人按的还是 send_cmd.py 发的、还是手机发的。 */
const SOURCE_DASHBOARD = 'dashboard';

/**
 * 「开始处理」。作用在**当前正在看的那个宿舍**上，只做两件事：
 *   1) 把 handle 发给 core
 *   2) 把那句说明写到按钮下面
 * 屏幕上其余的东西**一个字都不动** —— 等 core 的新快照回来，renderAll 会照着
 * 那一帧重画。所以按一下之后画面会「过一拍才变」，那一拍就是 core 的往返。
 */
el.actionHandle.addEventListener('click', function () {
  if (!selected) return;
  const node = nodeOf(snapshot, selected);
  const sent = sendHandle(selected, node ? node.time : '');
  el.cmdNote.textContent = cmdNote(sent.ok, sent.reason);
});

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
if (darkQuery.addEventListener) darkQuery.addEventListener('change', applyChartTheme);

/* 启动那一刻就把空状态画出来：卡片上和顶部那条横幅上都会写着「还没有收到
   core 的快照」，而不是「三个宿舍都正常」—— 页面刚打开那几秒，那三个宿舍是
   **不知道**，不是正常。 */
renderCards();
renderDetailHead();
renderAction();
renderFocus();
renderEvents();
renderRejects();
renderScene();
renderCharts();
renderLog();

/* ML 那一段是**异步**的（要等 fetch 回来），所以它不在这串 render 里 ——
   放在这里只是「启动时读一次」这个动作的位置，真正的渲染在 fetch 回来
   之后由 renderMl 做。没等它也是对的：那一段读不到不影响别的任何一块。 */
loadMlResult();

/* 打开页面就连。连不上时页面只说「还没收到快照」，不会再造一份假数据顶上 ——
   E3 明确禁止「手动输入数据伪造同步效果」。要数据就跑 simulator/。 */
connect();
