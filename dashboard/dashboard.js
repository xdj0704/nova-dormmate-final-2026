// dashboard.js
// Step 5-3 / 5-4：三节点 Dashboard。订阅 MQTT 显示真实数据，
// 「模拟三节点数据」按钮则在没接 Broker 时也能把界面跑起来。
// Step 6-3：详情区嵌一个 3D 视图，跟着当前选中的节点走。
// Step 7-1：自动挑出最该先看的那个节点。
// Step 8-3：顶部只剩一行「当前重点」，另加一个「语音提醒」按钮 ——
//           信息按出口分工，细节分给 3D / 语音 / report.html（见 index.html 那段注释）。
//
// handleMessage(topic, payloadText) 是唯一的消息入口，两个来源都走它：
//   client.on('message')  -> 真实 MQTT
//   simulate()            -> 本地模拟
// 校验、复核 status、落库、刷新这一整条链路两端共用，所以模拟数据看到的行为
// 和真实数据完全一致 —— 反过来说，改 handleMessage 就等于同时改了两边。
//
// 这个文件是 **ES 模块**（index.html 里写的是 type="module"），因为它 import 了
// ../3d/scene.js 和 ./logic.js。三件事跟着变了，改的时候别漏：
//   1) 页面必须走 http 服务器打开，file:// 下模块会被 CORS 拒掉
//   2) index.html 里要有 importmap，且排在模块脚本之前（scene.js 用的是裸名字 'three'）
//   3) mqtt / Chart / judgeStatus 仍然走全局变量，它们不是 import 进来的
//
// 这个文件负责「维护状态 + 摆到页面上」，不负责「怎么比」：
// 比大小、算时长、拼那句原因都在 ./logic.js 里，那边是纯函数，单独测。

/* 3D 场景。拿的是 createDorm3D 这个工厂，不是场景本身 ——
   这个页面只建一个，但工厂的返回值里带着 updateScene / setLabel / dispose，
   后续要加第二个视角（比如三节点并排）时不用改这里。
   路径相对**本文件**算：本文件在 dashboard/ 下，所以是 ../3d/scene.js。 */
import { createDorm3D } from '../3d/scene.js';

/* 看板的判断逻辑。只有这几个函数被这里用到，其余（parseTime / fmtDuration /
   abnormalDuration / ranked 那一套）是给测试单独钉的，页面不直接调。
   nextAbnormal 维护每个节点那两个字段，pickPriority 拿它们挑出最该看的那个，
   buildFocus 把它压成顶部那一行，buildAlert 把它说成语音要念的一句话（8-3）。

   buildOverview / buildReasons（8-1）**这里不 import 了**：8-3 起页面上不再
   渲染那两句，顶上只有 buildFocus 那一行。那两个函数仍然留在 logic.js 里
   ——「为什么是它、别人为什么不是」那套说法要去 report.html，那边要复用它，
   而且 pickPriority 记进事件、跟着导出的 CSV 走的 reason 也在那儿。 */
import { pickPriority, nextAbnormal, beginHandling, nextHandling,
  beginEvent, markPriority, markAction, closeEvent,
  buildFocus, buildAlert,
  buildMlNote, mlFetchFailed } from './logic.js';
'use strict';

/* ---------- 节点数据 ---------- */

/* 三个阶段各自独立：latest 是这个节点最新的一条，history 是这个节点自己的
   全部记录。三个 history 是三个不同的数组，绝不共用 —— 往哪个数组里 push
   只由报文里的 nodeId 决定，见 handleMessage 第 4 步。 */
const NODE_IDS = ['dorm-a', 'dorm-b', 'dorm-c'];

/* abnormalStart / abnormalCount 是 Step 7-1 加的：当前这段**连续异常**
   从哪条消息开始、已经有几条。怎么变由 logic.js 的 nextAbnormal 决定，
   这里只负责存。0 / null = 不在异常中。
   「谁是当前重点」比的就是这两个字段 —— 见 renderFocus。

   handling / action / actionTime / dataAfterAction 是 Step 7-2 加的：
   这个节点被「处理」过没有、做了什么、什么时候做的、做完之后收到了什么。
   怎么变由 logic.js 的 beginHandling（按按钮）和 nextHandling（来新消息）
   决定，这里同样只负责存。
     handling  '无' | '处理中' | '已恢复'
   这一份就是**唯一**的处理状态：卡片上那句「处理中｜风扇已开启」、
   详情区那行字、3D 里风扇转不转，全都读这几个字段，谁都不另存一份。

   event 是 Step 7-4 加的：这个节点**当前这段**连续异常对应的事件对象，
   段结束了就置回 null。它和 node.latest 一样是「指向 events 里某个元素的
   引用」，不是副本 —— 见 events 那边的说明。 */
const nodes = {};
NODE_IDS.forEach(function (id) {
  nodes[id] = {
    latest: null, history: [], abnormalStart: null, abnormalCount: 0,
    handling: '无', action: null, actionTime: null, dataAfterAction: null,
    event: null,
  };
});

/* 事件记录，新的在前。每条事件整条留档，结案之后也不删 —— 「事件记录」区
   和导出的 CSV 显示的就是这整个数组，不只是还没结束的那些。

   ⚠ 这里存的是**对象本身**，和 nodes[id].event 指向同一个。
   往 events 里 push/unshift 的是引用，不是深拷贝，所以更新一条事件只能
   就地改（Object.assign），绝不能整个换掉 node.event —— 一换，
   events 里的那条就还是旧的，两边各自说各的话。
   这也是「处理状态、页面显示、导出读同一份数据」那条要求的写法：
   只有一份，没有第二份可以跟它不一致。 */
const events = [];

/* 每个节点最多留多少条历史。不设上限的话挂机久了数组会一直涨，图上也会挤成
   一片。要更长的趋势改这个数就行。 */
const HISTORY_MAX = 50;

/* 消息日志最多留多少条 */
const LOG_MAX = 100;

/* 当前正在查看的节点。点卡片会改它。 */
let currentNodeId = NODE_IDS[0];

/* 消息日志，新的在前 */
const messages = [];

/* ---------- 状态 -> class / 图标 ---------- */

/* 和 web/script.js 里的 STATUS_VIEW 是同一份映射，class 名也刻意保持一致，
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

/* 31 显示成 31，25.5 显示成 25.5 */
function fmt(value) {
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/**
 * 把 Date 格式化成 "YYYY-MM-DD HH:mm:ss"（本地时间）。
 *
 * 不用 toLocaleString()：它的输出跟着浏览器和系统区域设置走，中文环境下
 * 可能给出 "2026/9/26 20:30:00"，连补零都不保证，和统一 JSON 约定的格式
 * 对不上，和 Python 侧发布的时间串也对不齐。
 *
 * @param {Date} date
 * @returns {string} "YYYY-MM-DD HH:mm:ss"，非法输入返回空串
 */
function formatTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
    + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
}

/* topic 的形状只写一遍，下面三个东西都从这两个片段拼出来。
   以前是订阅、解析、演示数据三处各写一遍字符串：从旧的三段式迁到 v1 那次，
   批量替换只扫到字面量，演示数据那处是 'dormmate/' + nodeId + '/env' 拼的，
   于是漏了下来 —— 而它**照样能跑**，因为形状不对时 topicNode 返回空串、
   topic 与 nodeId 的一致性检查整段被跳过，谁也没发现发出去的 topic
   应用自己不认识。收成一处之后，这种漏改不会再静默通过。 */
const TOPIC_PREFIX = 'dormmate/v1/nodes/';
const TOPIC_SUFFIX = '/telemetry';

/**
 * 拼出某个节点的上报 topic。演示数据按钮走这条，别再手写字符串。
 *
 * @param {string} nodeId
 * @returns {string} 例如 dormmate/v1/nodes/dorm-a/telemetry
 */
function topicFor(nodeId) {
  return TOPIC_PREFIX + nodeId + TOPIC_SUFFIX;
}

/**
 * 订阅用的通配符 topic。
 *
 * @returns {string} dormmate/v1/nodes/+/telemetry
 */
function topicWildcard() {
  return TOPIC_PREFIX + '+' + TOPIC_SUFFIX;
}

/**
 * 从 topic 里取出节点名。约定是 dormmate/v1/nodes/<nodeId>/telemetry。
 * 形状不对就返回空串 —— 调用方据此跳过 topic 与 nodeId 的一致性检查，
 * 而不是拿一个猜出来的节点名去报警。
 *
 * 头尾都是从 TOPIC_PREFIX / TOPIC_SUFFIX 上切的，不另写一份字面量：
 * 上面注释里那次的漏改，根子就是「同一件事写了两遍」。
 *
 * @param {string} topic
 * @returns {string} 节点名，或空串
 */
function topicNode(topic) {
  const text = String(topic == null ? '' : topic);
  if (!text.startsWith(TOPIC_PREFIX) || !text.endsWith(TOPIC_SUFFIX)) return '';
  const nodeId = text.slice(TOPIC_PREFIX.length, text.length - TOPIC_SUFFIX.length);
  /* 节点名里不许再出现分隔符：dormmate/v1/nodes/a/b/telemetry 头尾都对得上，
     但那是两个节点名拼出来的，取出来是个不存在的节点。 */
  if (nodeId === '' || nodeId.indexOf('/') !== -1) return '';
  return nodeId;
}

/* ---------- DOM ---------- */

const el = {
  cards: document.getElementById('cards'),
  logBody: document.getElementById('log-body'),
  logCount: document.getElementById('log-count'),
  detailNode: document.getElementById('detail-node'),
  detailMeta: document.getElementById('detail-meta'),
  actionFan: document.getElementById('action-fan'),
  actionState: document.getElementById('action-state'),
  chartNote: document.getElementById('chart-note'),
  scene3d: document.getElementById('scene3d'),
  focus: document.getElementById('focus'),
  speak: document.getElementById('speak'),
  speakNote: document.getElementById('speak-note'),
  evBody: document.getElementById('event-body'),
  evCount: document.getElementById('event-count'),
  exportEvents: document.getElementById('export-events'),
  simulate: document.getElementById('simulate'),
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

function cardHTML(nodeId) {
  const node = nodes[nodeId];
  const active = nodeId === currentNodeId;
  const head = '<span class="card-head">'
    + '<span class="node-name">' + esc(nodeId) + '</span>';

  if (!node.latest) {
    return '<button class="card is-empty' + (active ? ' is-active' : '') + '"'
      + ' type="button" data-node="' + esc(nodeId) + '" aria-pressed="' + active + '">'
      + head + '<span class="badge badge--wait">等待数据</span></span>'
      + '<span class="card-wait">还没收到这个节点的消息</span>'
      + '</button>';
  }

  const p = node.latest;
  const view = viewFor(p.status);

  /* 处理动作那一行。没按过按钮就整行不出现 ——
     那时候卡片和 7-1 长得一模一样，不多一行空占位。 */
  const handling = node.handling === '无' ? ''
    : '<span class="card-action">' + esc(node.handling + '｜' + node.action) + '</span>';

  return '<button class="card ' + view.cls + (active ? ' is-active' : '') + '"'
    + ' type="button" data-node="' + esc(nodeId) + '" aria-pressed="' + active + '">'
    + head
    + '<span class="badge">' + ICONS[view.icon] + '<span>' + esc(p.status) + '</span></span>'
    + '</span>'
    + '<span class="tiles">'
    + '<span class="tile"><span class="tile-label">温度</span>'
    + '<span class="tile-value">' + fmt(p.temperature) + '<i class="tile-unit">℃</i></span></span>'
    + '<span class="tile"><span class="tile-label">湿度</span>'
    + '<span class="tile-value">' + fmt(p.humidity) + '<i class="tile-unit">%</i></span></span>'
    + '</span>'
    + handling
    + '<span class="card-foot">更新于 ' + esc(p.time) + '</span>'
    + '</button>';
}

function renderCards() {
  el.cards.innerHTML = NODE_IDS.map(cardHTML).join('');
}

/* ---------- 详情区 ---------- */

function renderDetailHead() {
  const node = nodes[currentNodeId];
  el.detailNode.textContent = currentNodeId;
  el.detailMeta.textContent = node.latest
    ? '最新一条 ' + node.latest.time + ' · 这个节点已收到 ' + node.history.length + ' 条'
    : '还没有收到这个节点的数据';
}

/**
 * 详情区那行处理状态的文字。
 *
 * 说的是**当前这个节点**的事，所以整个跟着 currentNodeId 走。
 * 处理过就把三个字段原样摆出来：做了什么、记在哪条数据上、之后收到了什么。
 * 这几个值全从节点上读，没有第二份副本可以跟它不一致。
 */
function actionText(node) {
  if (node.handling !== '无') {
    const head = node.handling + '｜' + node.action + '（记在 ' + node.actionTime + ' 这条数据上）';
    const d = node.dataAfterAction;
    if (!d) return head + ' · 还没收到动作之后的数据';
    return head + ' · 之后收到 ' + d.time + '：'
      + fmt(d.temperature) + '℃ / ' + fmt(d.humidity) + '% ' + d.status;
  }
  if (!node.latest) return '还没有收到这个节点的数据';
  if (node.latest.status === '正常') return '当前状态正常，不需要处理';
  /* 有异常、还没按过按钮：按钮就在旁边，不必再多说一句 */
  return '';
}

/**
 * 重画那个「开启风扇 / 通风」按钮和它旁边那行字。
 *
 * 按钮只在「有数据、且不是正常」时可点：
 *   - 一条数据都没有 -> 连 actionTime 都没地方取，点不了；
 *   - 状态正常      -> 没有要处理的事，按规格书禁用。
 * 「已恢复」的节点状态就是正常的，所以那时候按钮同样是灰的 —— 这两条一致。
 */
function renderAction() {
  const node = nodes[currentNodeId];
  el.actionFan.disabled = !(node.latest && node.latest.status !== '正常');
  el.actionState.textContent = actionText(node);
}

/* ---------- 当前重点一行（Step 8-3｜B4） ---------- */

/**
 * 重画看板顶部那一行。
 *
 *   「dorm-b｜处理中｜温度正在下降」
 *
 * 挑哪个节点、那句话怎么拼，全交给 logic.js 的 buildFocus，这个函数只负责
 * 把结果摆到页面上，一个比较都不做 —— 比较的规矩只有一份，写在 logic.js 里，
 * 那边有单独的测试。这里再拼一份的话，页面上迟早出现「这一行说的是 dorm-b、
 * 语音念的是 dorm-c」这种自相矛盾。
 *
 * 整块用 innerHTML 重画，和卡片一样。所以点击也是事件委托，
 * 挂在容器上，不给每次重画出来的那个按钮单独绑。
 *
 * 它跟着 currentNodeId 变（要标出「正在查看」），所以切节点时也得重画 ——
 * 这也是它不能只跟 handleMessage 走的原因。
 *
 * 【为什么状态图标还在，状态两个字却没了】那一行的文字里没有「偏热」，
 * 但颜色不能就此单独表意（项目里状态色一律配图标 + 文字）。所以这里放一个
 * **形状**（太阳 / 雪花 / 水滴 / 对勾）：形状本身就把状态区分开了，颜色只是
 * 让它在三步之外也能被看见。这也是卡片和 7-1 那条栏一直在用的同一套 ICONS。
 */
function renderFocus() {
  const pick = pickPriority(nodes);

  /* 没挑出人来有两种情况，说的话不能一样 ——
     「都正常」在一条数据都没收到时是句假话：页面刚打开、还没连上 broker 的
     那几秒，那三个节点是**不知道**，不是正常。pickPriority 两种情况都返回 null
     （约定就是「没有要优先的」），所以这层区分由 buildFocus 那侧做。
     这里只负责画，不管那句该说什么。 */
  if (!pick) {
    el.focus.innerHTML = '<p class="focus focus--calm">'
      + '<span class="focus-tag">当前重点</span>'
      + '<span class="focus-text">' + esc(buildFocus(nodes)) + '</span>'
      + '</p>';
    return;
  }

  /* 颜色跟着这个节点的状态走，和卡片用同一套 class、同一套状态色。
     状态色是保留色，所以那个图标永远配着形状一起出现，不靠颜色单独表意。 */
  const view = viewFor(nodes[pick.nodeId].latest.status);
  const current = pick.nodeId === currentNodeId;

  el.focus.innerHTML = '<button class="focus ' + view.cls
    + (current ? ' is-active' : '') + '"'
    + ' type="button" data-node="' + esc(pick.nodeId) + '" aria-pressed="' + current + '">'
    + '<span class="focus-tag">当前重点</span>'
    + '<span class="focus-icon" aria-hidden="true">' + ICONS[view.icon] + '</span>'
    + '<span class="focus-text">' + esc(buildFocus(nodes)) + '</span>'
    + '<span class="focus-state">' + (current ? '正在查看' : '查看详情') + '</span>'
    + '</button>';
}

/* ---------- 语音提醒（Step 8-3｜B4） ---------- */

/* 语音合成用浏览器自带的 speechSynthesis。和 3-2 的语音识别一样，
   Chrome / Edge / Safari 都有，Firefox 也有。念的是**当前最重要的一句**，
   不是把三个宿舍从头到尾念一遍 —— 声音是线性的，说过就过去了，
   念三段话听的人只记得住最后一句。 */
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
 * 早就不算数了。掐掉上一句、立刻念最新的，才符合「念的是此刻的重点」。
 *
 * 无论成功还是失败，都把念的内容写到按钮下面那行 —— 静音、没音箱、
 * 声音太小的时候，那一行是唯一能确认「它到底念了什么」的地方。
 */
function speakAlert() {
  const text = buildAlert(nodes);

  if (!speechSupported()) {
    setSpeakNote('这个浏览器不支持语音合成（window.speechSynthesis 不存在）。'
      + '要念的是：' + text);
    return;
  }

  window.speechSynthesis.cancel();

  const utterance = new window.SpeechSynthesisUtterance(text);
  utterance.lang = SPEECH_LANG;

  /* 出错也要说出来。原始的错误码写在最前面 —— 解释文案可能对不上，错误码不会骗人
     （和 3-2 那张 VOICE_ERRORS 表同一条原则）。 */
  utterance.onerror = function (event) {
    const code = event && event.error ? event.error : 'unknown';
    setSpeakNote('朗读失败（' + code + '）。要念的是：' + text);
  };

  window.speechSynthesis.speak(utterance);
  setSpeakNote('正在朗读：' + text);
}

/* ---------- 事件记录 ---------- */

/**
 * 表格里一格「时间 + 一句说明」。
 *
 * 这两格（优先关注、处理动作）的内容比别的格子长得多 —— 优先关注那句原因
 * 可以有二十来个字。所以说明另起一行、用淡一点的颜色，不跟时间挤在一起，
 * 也不让整张表被撑得横向滚动。
 *
 * @param {string|null} time
 * @param {string|null} note
 * @returns {string} HTML
 */
function eventCell(time, note) {
  if (!time) return '<span class="ev-none">—</span>';
  return '<span class="mono">' + esc(time) + '</span>'
    + (note ? '<span class="ev-reason">' + esc(note) + '</span>' : '');
}

function eventRowHTML(e) {
  /* 还没结案的那条，用中性灰标「进行中」而不是留个空格子 ——
     空着看的人分不清是「还在异常中」还是「这一格没数据」。
     数据上 result 仍然是空串（约定如此），这里只是把它画出来。 */
  const result = e.result
    ? '<span class="ev-result ev-result--done">' + esc(e.result) + '</span>'
    : '<span class="ev-result ev-result--open">进行中</span>';

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
 * 重画「事件记录」区。
 *
 * 显示的是 events 整个数组 —— 结过案的也留着，这一区的意义正是回头看看
 * 这些事都是怎么过去的，只显示还没结束的那些等于把它变成第二个详情区。
 */
function renderEvents() {
  el.evCount.textContent = events.length > 0 ? '共 ' + events.length + ' 条' : '';
  el.evBody.innerHTML = events.length === 0
    ? '<tr><td colspan="7" class="log-empty">还没有事件'
      + '（节点从正常变成异常时才会记一条）</td></tr>'
    : events.map(eventRowHTML).join('');

  /* 没什么可导的时候把按钮按掉，而不是让人点了弹一个空文件 ——
     空 CSV 只有一行表头，拿到的人会以为导出坏了。 */
  el.exportEvents.disabled = events.length === 0;
}

/* 导出 CSV 的表头。顺序就是约定里那 9 个字段的顺序，
   也是 logic.js 里 beginEvent 返回值的字段顺序 —— 两处要对得上。 */
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
 * 行顺序和「事件记录」区里看到的一致（最新在前），和 web/ 那边导出
 * 录入历史是同一个口径：导出的东西和屏幕上看到的一模一样。
 * 复盘要按时间正着看，那是 Python 侧读进来之后自己排（EventRecord 那边
 * 按 startTime 排一遍），不靠这里把顺序改掉。
 *
 * @returns {string} CRLF 换行、末尾也带一个 CRLF
 */
function buildEventsCSV() {
  const lines = [EVENT_HEADER.join(',')];
  events.forEach(function (e) {
    lines.push(EVENT_HEADER.map(function (key) {
      const v = e[key];
      /* 还没发生的格子是 null，要写成空 —— String(null) 会变成四个字母的
         "null"，Excel 里看着像真存了一个叫 null 的值，而且 Python 那边
         读到 "null" 也判不出「这条还没结束」。 */
      return csvCell(v == null ? '' : v);
    }).join(','));
  });
  /* 用 CRLF 换行：Excel / WPS 对 LF 的兼容性不如 CRLF */
  return lines.join('\r\n') + '\r\n';
}

function exportEventsCSV() {
  /* '\uFEFF' 是 UTF-8 BOM。少了它 Excel/WPS 会按本地代码页解析，
     problem 和 result 里的中文就会变成乱码。这里写成转义而不是字面量字符，
     否则源码里是一段隐形字符，看起来像个空字符串。 */
  const blob = new Blob(['\uFEFF' + buildEventsCSV()], { type: 'text/csv;charset=utf-8' });
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
 * 把当前选中节点的状态画到 3D 视图上。
 *
 * 每次都从 nodes[currentNodeId].latest 重新算，不看上一次画的是什么 ——
 * 幂等，所以切节点时直接调，不用先判断「变了没有」。
 *
 * 调用它的三个地方各有各的时机，都在外面把关：
 *   selectNode   —— 选中项变了
 *   handleMessage—— 且只在收到的那条属于当前选中的节点时（见那边的注释）
 *   clearAll / 启动 —— 无条件画一遍
 *
 * status 直接用 latest.status 就行，那是 handleMessage 里 judgeStatus 复核过的。
 * 这里不再复核一遍：复核逻辑只留一份，两处各写一遍迟早会不一致。
 */
function renderScene() {
  if (!dorm3d) return;

  const node = nodes[currentNodeId];

  /* 还没收到数据的节点。scene.js 认不出「没有状态」这件事（它只认那四个字），
     所以退回「正常」的外观，再在覆盖层上如实写明还没收到 ——
     空白或者半成品的样子，看的人分不清是「还没收到」还是「页面坏了」。 */
  if (!node.latest) {
    dorm3d.updateScene('正常');
    dorm3d.setLabel('当前宿舍：' + currentNodeId + '（还没有收到数据）');
  } else {
    dorm3d.updateScene(node.latest.status);
    /* 标签上**只留宿舍名**（8-3 改的）。原来这里还写着状态和温湿度，
       那是把卡片上的信息又抄了一遍 —— 而这一行落在画面正中间，
       一眼看过去分不清哪个是「场景」哪个是「文字面板」。
       分工是这样：宿舍名是场景答不出来的（画面里只有一间屋，不说不知道是哪个），
       所以留在这儿；「这间怎么了」交给画面自己说（地板颜色、窗户开合、风扇转不转）；
       温湿度是卡片的事，3D 一个字都不重复。 */
    dorm3d.setLabel('当前宿舍：' + currentNodeId);
  }

  /* 风扇。两个来源，都是这个节点自己的字段：
       1) 状态要它转 —— scene.js 的 LOOK 表里「偏热」本来就是 fan: true，
          updateScene 内部已经调过一次 setFanOn 了；
       2) 有人按过那个按钮 —— handling 不是「无」就转，不管现在什么状态。
     按钮的效果是**叠在状态之上**的，不是取代它：偏湿的宿舍按一下会转起来，
     而本来就偏热的宿舍不会因为「没人按过按钮」被这里按停。
     （「已恢复」之后照样转 —— 动作开了就一直开着，只有「清空」才停。）
     转不转只由 handling 这一个字段说了算，不另外存一份开关。

     位置必须在 updateScene **之后**：scene.js 里写着「后调用的那次为准」，
     放在前面会被 updateScene 自己那次盖掉。 */
  if (node.handling !== '无') dorm3d.setFanOn(true);

  /* 切节点之后那圈「当前重点」的环也要跟着改口 */
  renderFocusMark();
}

/**
 * 只更新「当前重点」那圈标记，画面其余部分一动不动。
 *
 * 单独一个函数，是因为它和「重画场景」的**时机不一样**：
 *   场景只跟当前选中的那个宿舍有关 —— 收到别的节点的报文时一次都不该动
 *   （动了屏幕上就会写着 dorm-a、画的却是 dorm-b）；
 *   而「谁是重点」是**全局**的事 —— dorm-b 的一条数据就可能让正在看的
 *   dorm-a 不再是重点，那圈环得当场灭掉。
 * 两件事捆在一起写的话，后一种情况就只能靠「碰巧也在看那个节点」才更新得过来。
 *
 * 它不读 currentNodeId 以外的东西，也不改任何数据 —— 就是个开关。
 */
function renderFocusMark() {
  if (!dorm3d) return;

  const pick = pickPriority(nodes);
  dorm3d.setFocus(!!pick && pick.nodeId === currentNodeId);
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

function renderCharts() {
  if (!ensureCharts()) return;

  const node = nodes[currentNodeId];
  const rows = node.history;
  /* "2026-09-22 20:30:00" 的第 11 位起就是 "20:30:00"，横轴只要时分秒 */
  const labels = rows.map(function (r) { return String(r.time).slice(11, 19); });

  CHART_SPECS.forEach(function (spec) {
    const chart = charts[spec.id];
    chart.data.labels = labels;
    chart.data.datasets[0].data = rows.map(function (r) { return r[spec.id]; });
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

function selectNode(nodeId) {
  if (!Object.prototype.hasOwnProperty.call(nodes, nodeId)) return;
  if (nodeId === currentNodeId) return;
  currentNodeId = nodeId;
  renderCards();
  renderDetailHead();
  /* 按钮和那行字说的是「当前这个节点」的事，切了就得重画 ——
     按钮的禁用状态、处理进度都是跟着节点走的。 */
  renderAction();
  renderScene();
  renderCharts();
  /* 顶部那一行的**内容**一个字都没变（谁是重点跟选中谁没关系），
     但它上面标着「正在查看 / 查看详情」，那两个字跟着 currentNodeId 走，
     所以还是得重画一次。 */
  renderFocus();
}

/* ---------- 唯一的消息入口 ---------- */

/* 统一 JSON 里必须齐全的 5 个字段及其类型 */
const REQUIRED_FIELDS = [
  ['nodeId', 'string'],
  ['temperature', 'number'],
  ['humidity', 'number'],
  ['status', 'string'],
  ['time', 'string'],
];

/**
 * 处理一条环境报文。整个页面只有这一个入口。
 *
 * 顺序是刻意的，前面一步没过就 return，不做下一步：
 *   1) JSON.parse 包 try/catch —— 任何脏数据都可能让它抛异常
 *   2) 五个字段齐不齐、类型对不对
 *   3) 用 judgeStatus 复核 status，不一致就警告，并以规则结果为准；
 *      顺带检查 topic 里的节点和报文里的对不对得上
 *   4) 按 nodeId 写进那个节点自己的 latest / history，再刷新界面
 *
 * 第 3 步里发现的问题不丢弃报文，只在日志那一行里标成「警告」并说明原因 ——
 * 结论一律用规则算出来的，收到什么就记什么，但显示以规则为准。
 *
 * @param {string} topic       消息来自哪个 topic
 * @param {string} payloadText 报文原文（字符串）
 * @returns {boolean} true = 收下了；false = 被拦下，原因见消息日志
 */
function handleMessage(topic, payloadText) {
  /* rules.js 没加载上时说清楚，而不是在这里抛 undefined 错 */
  if (typeof judgeStatus !== 'function') {
    logLine('error', topic, '未加载 shared/rules.js，请检查 <script> 的引入顺序');
    return false;
  }

  /* 1) 解析 */
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch (err) {
    logLine('error', topic, 'JSON 解析失败：' + err.message);
    return false;
  }

  /* JSON.parse('null') / '123' / '"x"' / '[1]' 都算解析成功，但都不是我们要的
     对象。不先挡掉的话，下面读字段会读到 undefined。 */
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    logLine('error', topic, 'payload 顶层不是对象（收到 '
      + (Array.isArray(payload) ? 'array' : String(payload)) + '）');
    return false;
  }

  /* 2) 字段齐不齐、类型对不对 */
  const problems = [];
  REQUIRED_FIELDS.forEach(function (field) {
    const key = field[0];
    const type = field[1];
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      problems.push('缺少 ' + key);
    } else if (typeof payload[key] !== type) {
      problems.push(key + ' 应为 ' + type + '，实际是 ' + typeof payload[key]);
    }
  });
  if (problems.length > 0) {
    logLine('error', topic, '字段校验不通过：' + problems.join('；'));
    return false;
  }

  /* typeof NaN 也是 'number'，所以上面那关拦不住它，单独再挡一次 */
  if (!Number.isFinite(payload.temperature) || !Number.isFinite(payload.humidity)) {
    logLine('error', topic, '温度/湿度不是有限数字（NaN 或 Infinity）');
    return false;
  }

  /* 节点必须是约定里的三个之一，否则没有可以写进去的地方 */
  if (!Object.prototype.hasOwnProperty.call(nodes, payload.nodeId)) {
    logLine('error', topic, '未知节点 ' + payload.nodeId);
    return false;
  }

  /* 3) 复核 status。不直接相信发过来的值，一律用规则重算。 */
  const expected = judgeStatus(payload.temperature, payload.humidity);

  /* 这一条报文里所有不对劲的地方，攒起来。
     一条报文只写一行日志 —— 分两行记的话，日志区就不再是「每条消息一行」，
     对不上数了。级别取最严重的那个。 */
  const notes = [];

  /* topic 和 payload.nodeId 应当指向同一个节点。不一致只警告不丢弃 ——
     节点身份以报文自己声明的为准（统一 JSON 里 nodeId 是必填字段）。
     topic 形状不对时 topicNode 返回空串，这里跳过检查而不是瞎猜一个节点名。 */
  const topicId = topicNode(topic);
  if (topicId && topicId !== payload.nodeId) {
    notes.push('topic 里是 ' + topicId + '，报文里是 ' + payload.nodeId + '，按报文里的算');
  }

  if (payload.status !== expected) {
    notes.push('status 不一致：收到「' + payload.status + '」，规则算出「'
      + expected + '」，以规则为准');
  }

  const record = {
    nodeId: payload.nodeId,
    temperature: payload.temperature,
    humidity: payload.humidity,
    status: expected,
    time: payload.time,
  };

  /* 4) 只动这个节点自己的那份数据。写错了地方就是「串线」，
      所以下面这几行只认 record.nodeId，不看别的。 */
  const node = nodes[record.nodeId];
  node.latest = record;
  node.history.push(record);
  if (node.history.length > HISTORY_MAX) {
    node.history.splice(0, node.history.length - HISTORY_MAX);
  }

  /* 5) 维护「当前这段连续异常」。用的是**复核之后**的 status ——
      报文里写「正常」但规则算出「偏热」时，算它还在异常里，段不中断。
      nextAbnormal 是纯函数，只读 node 上那两个字段，别的不碰。

      先留一份改之前的状态：下面第 7 步要靠「0 -> 正」和「正 -> 0」
      这两个翻转来判断事件该开还是该结，改完就看不出来了。 */
  const wasAbnormal = node.abnormalCount > 0;
  const abnormal = nextAbnormal(node, record.status, record.time);
  node.abnormalStart = abnormal.abnormalStart;
  node.abnormalCount = abnormal.abnormalCount;

  /* 6) 处理动作走到哪一步了。按过按钮之后，动作之后收到的**最新那条**说了算：
     正常了就是「已恢复」，还异常就留在「处理中」。
     record.status 同样是复核之后的结果，所以报文谎称正常也骗不过去。
     nextHandling 返回 null 表示不用改（没按过按钮 / 这条比动作还早）。 */
  const moved = nextHandling(node, record);
  if (moved) {
    node.handling = moved.handling;
    node.dataAfterAction = moved.dataAfterAction;
  }

  /* 7) 事件记录。开案和结案的判据就是上面第 5 步那段异常段的起止，
      不另立一套 —— 否则「顶部那一行说的这段」和「事件里记的这段」
      会出现两个对不上的起点，而它们说的明明是同一件事。 */
  if (wasAbnormal && node.abnormalCount === 0) {
    /* 正 -> 0：来了一条正常数据，这段结束了。写 recoverTime 和 result，
       再把节点上那个引用摘掉 —— 摘的是**引用**，events 里那条还在，
       只是这个节点从此没有「当前这段」了。 */
    const closed = closeEvent(node.event, record.time);
    if (closed) Object.assign(node.event, closed);
    node.event = null;
  } else if (!wasAbnormal && node.abnormalCount > 0) {
    /* 0 -> 正：新的一段开始了。beginEvent 造的是个新对象，
       下面两行存的是**同一个引用** —— 节点和总表从此指向同一条，
       之后就地改谁都看得见，不会有一边留着旧副本。 */
    const opened = beginEvent(record);
    if (opened) {
      node.event = opened;
      events.unshift(opened);
    }
  }

  const summary = record.nodeId + ' ' + fmt(record.temperature) + '℃ '
    + fmt(record.humidity) + '% ' + expected;

  if (notes.length > 0) {
    logLine('warn', topic, summary + ' —— ' + notes.join('；'));
  } else {
    logLine('ok', topic, summary);
  }

  renderCards();
  renderDetailHead();
  /* 处理状态变了，详情区那行字和 3D 里的风扇都得跟着走 ——
     两者读的都是上面刚写完的 node.handling。 */
  renderAction();
  renderCharts();

  /* 3D 只在「收到的这条正好是当前正在看的那个节点」时才重画。
     三个宿舍的数据混在同一个通配符 topic 里进来，不加这一句的话，
     dorm-b 的数据会顺手把画面刷成 dorm-b 的样子 —— 那一刻屏幕上写着
     dorm-a，看着却是 dorm-b，而且没有任何地方会报错。

     卡片和图表是「三个节点一起显示」，所以它们每次都刷；
     3D 是「只显示当前选中的那个」，所以它要挑。 */
  if (record.nodeId === currentNodeId) renderScene();
  /* 但「谁是重点」是全局的，收到哪个节点的报文都可能换人 ——
     正在看的这间可能**因此不再是重点**，那圈环得当场灭掉。
     所以这一句不带条件。 */
  else renderFocusMark();

  /* 这里算的 pick 只有一个去处：下面记事件时那句 reason。
     8-3 之后页面顶上那一行**不读这个 pick**（它是 logic.js 里现拼的，
     见下面 renderFocus 那段注释），所以别看到「算了却没人用」就想删 ——
     事件里记的必须是 pickPriority 此刻的判断，不能是别处凑出来的。 */
  const pick = pickPriority(nodes);

  /* 被选中的那个节点，如果这一段还没记过「第一次被关注」，就把这一刻记上。
     时间取**它自己**最新那条的 time，不是这条报文的 record.time ——
     胜出的很可能是另一个节点（比如 dorm-a 刚恢复正常，轮到 dorm-b 上位），
     拿 record.time 去记它就是把别人的时间写在了它头上。 */
  if (pick) {
    const won = nodes[pick.nodeId];
    const stamped = markPriority(won.event, won.latest.time, pick.reason);
    if (stamped) Object.assign(won.event, stamped);
  }

  renderEvents();
  /* 顶部那一行每次收到报文都重算。它里面全是会变的东西（谁、在不在处理、
     温度往哪走），缓存下来的话，页面上的重点会停在某一刻不再动，
     而下面的卡片一直在涨 —— 看着像数据不更新了。

     这里**不把上面算好的 pick 传进去**：那一行是 logic.js 现拼的
     （buildFocus 内部自己走一遍 pickPriority），多算一遍不值一提，
     而多一条「把结果传进去」的路，就多一个「传岔了」的机会。 */
  renderFocus();
  return true;
}

/* ---------- 模拟三节点数据 ---------- */

/* 先按 dorm-a / dorm-b / dorm-c 各喂一条，再交错着各喂 2 条。
   交错是有意的：三份数据轮着进同一个入口，要是 history 串了线（比如三个
   节点写进了同一个数组），下面的图和卡片会立刻露馅。
   dorm-a 和 dorm-c 的温度区间故意重叠（都在 24~26），但湿度差得很远
   （58~62 vs 79~82），所以哪怕只串了一点点也看得出来。 */
const SIM_ROWS = [
  ['dorm-a', 25, 60], ['dorm-b', 31, 60], ['dorm-c', 25, 80],   /* 约定的三条：正常 / 偏热 / 偏湿 */
  ['dorm-a', 26, 62], ['dorm-b', 33, 55], ['dorm-c', 26, 82],   /* 后续 1 */
  ['dorm-a', 24, 58], ['dorm-b', 32, 58], ['dorm-c', 24, 79],   /* 后续 2 */
];

function simulate() {
  if (typeof judgeStatus !== 'function') {
    logLine('error', '—', '未加载 shared/rules.js，无法生成模拟数据');
    return;
  }

  const base = Date.now();
  SIM_ROWS.forEach(function (row, i) {
    const nodeId = row[0];
    const temperature = row[1];
    const humidity = row[2];

    /* 时间逐条往后推 1 秒，图上的横轴才是单调的 */
    const payload = {
      nodeId: nodeId,
      temperature: temperature,
      humidity: humidity,
      status: judgeStatus(temperature, humidity),
      time: formatTime(new Date(base + i * 1000)),
    };

    handleMessage(topicFor(nodeId), JSON.stringify(payload));
  });
}

/* ---------- 清空 ---------- */

function clearAll() {
  NODE_IDS.forEach(function (id) {
    nodes[id].latest = null;
    nodes[id].history = [];
    /* 连异常段一起清。留着的话，清空之后明明一条数据都没有，
       顶部还挂着「dorm-b 已连续偏热 12 分钟」—— 那是上一次的账。 */
    nodes[id].abnormalStart = null;
    nodes[id].abnormalCount = 0;
    /* 处理动作也一起清。留着的话，清空之后明明什么都没了，
       卡片上还写着「已恢复｜风扇已开启」—— 那是上一次的账。
       风扇会跟着回到不转：renderScene 读的就是这个字段，它一变「无」，
       下面那次 setFanOn 就不会再调了。 */
    nodes[id].handling = '无';
    nodes[id].action = null;
    nodes[id].actionTime = null;
    nodes[id].dataAfterAction = null;
    /* 事件的引用也摘掉 —— 下面还会把整个 events 清空，
       这里不摘的话节点上会留着一个已经不在总表里的野对象，
       下一条数据一来，那段异常看起来就像「早就开过案了」。 */
    nodes[id].event = null;
  });
  messages.length = 0;
  /* 事件记录也一起清。这条和上面几条是同一个道理：不清的话，清空之后
     卡片全写着「等待数据」，下面却还列着上一轮的「连续偏热」——
     那是上一次的账。要留就趁清空前先按「导出事件 CSV」存下来。 */
  events.length = 0;
  renderCards();
  renderDetailHead();
  renderAction();
  renderScene();
  renderCharts();
  renderFocus();
  renderEvents();
  renderLog();
  /* 清空之后「要念的那一句」也变了（变回「还没有收到任何节点的数据」），
     但按钮下面那行字是**上一次念的内容**，不清的话它会一直挂在那儿，
     看上去像是刚刚念过。 */
  setSpeakNote('');
}

/* ---------- MQTT ---------- */

/* Broker 地址跟着页面的访问地址走：本机打开就是 ws://localhost:9001，
   手机用 http://10.102.196.160:8000/dashboard/ 打开就是
   ws://10.102.196.160:9001。写死 localhost 的话，手机浏览器里的 localhost
   指的是手机自己，连不回来。
   （和 web/script.js 里那份是同一套写法，故意各留一份：两个页面互不依赖，
   为三行代码共用一个 shared/ 文件反而要多发一次请求。改的时候两边一起改。） */
function brokerUrl(hostname) {
  return 'ws://' + (hostname || 'localhost') + ':9001';
}

const BROKER_URL = brokerUrl(location.hostname);
const TOPIC = topicWildcard();

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
  if (typeof mqtt === 'undefined') {
    setConn('off', '未加载 mqtt.js');
    logLine('error', TOPIC, '缺少 dashboard/lib/mqtt.min.js，请重新下载后刷新');
    return;
  }
  if (client) return;   // 已经连着了，别叠第二根

  setConn('pending', '连接中…');

  const c = mqtt.connect(BROKER_URL, {
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
    c.subscribe(TOPIC, { qos: 1 }, function (err) {
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
     校验、复核 status、落库、刷新全在那边，这里不做第二遍。 */
  c.on('message', function (topic, payload) {
    const text = payload.toString();

    /* 每条原始报文都往 Console 打一行。排错时先看这里 ——
       「压根没收到消息」和「收到了但被 handleMessage 拦下了」是两回事，
       排查方向完全不同，而页面上的日志区只记后者，前者完全不显示。
       打印放在这个边界上、而不是放进 handleMessage：那边是所有来源共用的，
       模拟按钮的数据不该混进来冒充实收报文。 */
    console.log('[DormMate] 收到 MQTT 原始消息', topic, text);

    handleMessage(topic, text);
  });

  updateToggle();
}

/* ---------- ML 辅助判断（Step 9-3 的进阶项）---------- */

/* 这一段和上面所有东西都不一样：它**不来自 MQTT**。
   那份 JSON 是 analysis/analysis.py 上一次跑完写下的（见那个文件的
   write_ml_result），页面只是取过来摆在这儿。两件事跟着来：

     1) 它是个静态文件 —— 页面开一次读一次，读完就不再变。看板上别的数字
        都在跟着报文动，只有这一块不动。所以 #ml-note 里那句「不是实时数据」
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

el.simulate.addEventListener('click', simulate);
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

/* 顶部那一行也是重绘的，同样用委托。
   它跟卡片走的是**同一条路**（selectNode）—— 点它和点对应那张卡片
   没有任何区别，卡片、趋势图、3D 一起切过去。
   没有重点的时候那里是个没有 data-node 的 <p>，这个判断顺手把它挡掉了。 */
el.focus.addEventListener('click', function (e) {
  const focus = e.target && e.target.closest ? e.target.closest('.focus') : null;
  if (focus && focus.dataset.node) selectNode(focus.dataset.node);
});

/* 「语音提醒」。念什么完全由 buildAlert 现算 —— 这里一个字都不拼。
   它不读 currentNodeId：提醒说的是**全局的重点**，不是「正在看的那个」，
   跟顶部那一行、优先关注记进事件的那条 reason 是同一个来源。 */
el.speak.addEventListener('click', speakAlert);

/* 「开启风扇 / 通风」。作用在**当前正在看的那个节点**上。
   写完这四个字段之后，卡片、详情区那行字、3D 里的风扇都是下一次
   render 时从同一份节点数据里读出来的 —— 这里不额外记任何东西。 */
el.actionFan.addEventListener('click', function () {
  const node = nodes[currentNodeId];
  const started = beginHandling(node);
  /* 按钮这时是禁用的，正常点不到；键盘或脚本直接触发时兜一下，
     别把一个 null 拆开写进节点。 */
  if (!started) return;

  node.handling = started.handling;
  node.action = started.action;
  node.actionTime = started.actionTime;
  node.dataAfterAction = started.dataAfterAction;

  /* 这段异常要是正记着，把这次动作也写进那条事件（只记第一次）。

     必须 Object.assign 就地改，不能写成 node.event = {...}：events 里
     存的是**同一个对象**，整个换掉的话总表里那条就永远停在旧值上，
     导出 CSV 时「处理动作」那两列会是空的，而页面上一点异常都看不出来。 */
  const marked = markAction(node.event, started.action, started.actionTime);
  if (marked) Object.assign(node.event, marked);

  renderCards();
  renderAction();
  renderScene();
  renderEvents();
  /* 顶部那一行里有「处理中」这三个字，所以按了按钮就得重画一次。
     漏掉这一句的话，那两个字要等到**下一条报文进来**才出现 —— 中间那段时间
     卡片上写着「处理中｜风扇已开启」、上面那一行里却什么都没有，
     看的人会以为按钮没生效。 */
  renderFocus();
});

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
if (darkQuery.addEventListener) darkQuery.addEventListener('change', applyChartTheme);

renderCards();
renderDetailHead();
renderAction();
renderScene();
renderCharts();
renderFocus();
renderEvents();
renderLog();

/* ML 那一段是**异步**的（要等 fetch 回来），所以它不在这串 render 里 ——
   放在这里只是「启动时读一次」这个动作的位置，真正的渲染在 fetch 回来
   之后由 renderMl 做。没等它也是对的：那一段读不到不影响别的任何一块，
   页面该显示的东西开头那几行就已经显示完了。 */
loadMlResult();

/* 打开页面就连。连不上也不影响「模拟三节点数据」按钮 —— 那是不经过 Broker 的，
   现场没网的时候正好用来演示界面。 */
connect();