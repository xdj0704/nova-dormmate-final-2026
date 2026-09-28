// dashboard.js
// Step 5-3 / 5-4：三节点 Dashboard。订阅 MQTT 显示真实数据，
// 「模拟三节点数据」按钮则在没接 Broker 时也能把界面跑起来。
// Step 6-3：详情区嵌一个 3D 视图，跟着当前选中的节点走。
// Step 7-1：顶部一条「优先关注」，自动挑出最该先看的那个节点。
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

/* 优先关注的算法。只有两个函数被这里用到，其余（parseTime / fmtDuration /
   abnormalDuration）是给测试单独钉的，页面不直接调。
   nextAbnormal 维护每个节点那两个字段，pickPriority 拿它们挑出最该看的那个。 */
import { pickPriority, nextAbnormal, beginHandling, nextHandling } from './logic.js';
'use strict';

/* ---------- 节点数据 ---------- */

/* 三个阶段各自独立：latest 是这个节点最新的一条，history 是这个节点自己的
   全部记录。三个 history 是三个不同的数组，绝不共用 —— 往哪个数组里 push
   只由报文里的 nodeId 决定，见 handleMessage 第 4 步。 */
const NODE_IDS = ['dorm-a', 'dorm-b', 'dorm-c'];

/* abnormalStart / abnormalCount 是 Step 7-1 加的：当前这段**连续异常**
   从哪条消息开始、已经有几条。怎么变由 logic.js 的 nextAbnormal 决定，
   这里只负责存。0 / null = 不在异常中。
   「优先关注」比的就是这两个字段 —— 见 renderPriority。

   handling / action / actionTime / dataAfterAction 是 Step 7-2 加的：
   这个节点被「处理」过没有、做了什么、什么时候做的、做完之后收到了什么。
   怎么变由 logic.js 的 beginHandling（按按钮）和 nextHandling（来新消息）
   决定，这里同样只负责存。
     handling  '无' | '处理中' | '已恢复'
   这一份就是**唯一**的处理状态：卡片上那句「处理中｜风扇已开启」、
   详情区那行字、3D 里风扇转不转，全都读这几个字段，谁都不另存一份。 */
const nodes = {};
NODE_IDS.forEach(function (id) {
  nodes[id] = {
    latest: null, history: [], abnormalStart: null, abnormalCount: 0,
    handling: '无', action: null, actionTime: null, dataAfterAction: null,
  };
});

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

/**
 * 从 topic 里取出节点名。约定是 dormmate/<nodeId>/env。
 * 形状不对就返回空串 —— 调用方据此跳过 topic 与 nodeId 的一致性检查，
 * 而不是拿一个猜出来的节点名去报警。
 *
 * @param {string} topic
 * @returns {string} 节点名，或空串
 */
function topicNode(topic) {
  const parts = String(topic == null ? '' : topic).split('/');
  if (parts.length === 3 && parts[0] === 'dormmate' && parts[2] === 'env') return parts[1];
  return '';
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
  priority: document.getElementById('priority'),
  simulate: document.getElementById('simulate'),
  clear: document.getElementById('clear'),
  conn: document.getElementById('conn'),
  connText: document.getElementById('conn-text'),
  toggle: document.getElementById('toggle'),
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

/* ---------- 优先关注 ---------- */

/**
 * 重画顶部那条「优先关注」。
 *
 * 挑哪个节点全交给 logic.js 的 pickPriority，这个函数只负责把结果摆到页面上，
 * 一个比较都不做 —— 比较的规矩只有一份，写在 logic.js 里，那边有单独的测试。
 *
 * 整块用 innerHTML 重画，和卡片一样。所以点击也是事件委托，
 * 挂在容器上，不给每次重画出来的那个按钮单独绑。
 *
 * 它跟着 currentNodeId 变（要标出「正在查看」），所以切节点时也得重画 ——
 * 这也是它不能只跟 handleMessage 走的原因。
 */
function renderPriority() {
  const pick = pickPriority(nodes);

  /* 没挑出人来有两种情况，说的话不能一样 ——
     「三个都正常」在一条数据都没收到时是句假话：页面刚打开、还没连上
     broker 的那几秒，那三个节点是**不知道**，不是正常。
     pickPriority 两种情况都返回 null（约定就是「没有要优先的」），
     所以这层区分放在画的地方做，纯函数那边不用多一个返回值。 */
  if (!pick) {
    const hasData = NODE_IDS.some(function (id) { return nodes[id].latest !== null; });
    el.priority.innerHTML = '<p class="focus focus--calm">'
      + '<span class="focus-tag">优先关注</span>'
      + '<span class="focus-text">' + (hasData
        ? '三个节点都正常，没有需要优先处理的宿舍'
        : '还没有收到任何节点的数据') + '</span>'
      + '</p>';
    return;
  }

  /* 颜色跟着这个节点的状态走，和卡片用同一套 class、同一套状态色。
     状态色是保留色，所以这里必须配着文字用 —— 那句 reason 里本来就写着
     「偏热」两个字，颜色只是让它在三步之外也能被看见。 */
  const view = viewFor(nodes[pick.nodeId].latest.status);
  const current = pick.nodeId === currentNodeId;

  el.priority.innerHTML = '<button class="focus ' + view.cls
    + (current ? ' is-active' : '') + '"'
    + ' type="button" data-node="' + esc(pick.nodeId) + '" aria-pressed="' + current + '">'
    + '<span class="focus-tag">优先关注</span>'
    + '<span class="focus-text">' + esc(pick.reason) + '</span>'
    + '<span class="focus-state">' + (current ? '正在查看' : '查看详情') + '</span>'
    + '</button>';
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
    dorm3d.setLabel('当前宿舍：' + currentNodeId + '｜状态：还没有收到数据');
  } else {
    const applied = dorm3d.updateScene(node.latest.status);
    dorm3d.setLabel('当前宿舍：' + currentNodeId + '｜状态：' + applied
      + '｜' + fmt(node.latest.temperature) + '℃ / ' + fmt(node.latest.humidity) + '%');
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
  /* 「优先关注」栏本身不重算（异常状态一点没变），但要重画 ——
     它上面标着「正在查看 / 查看详情」，那两个字跟着 currentNodeId 走。 */
  renderPriority();
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
      nextAbnormal 是纯函数，只读 node 上那两个字段，别的不碰。 */
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

  /* 「优先关注」也是每次都要重算的：这一条报文可能让它换了人，
     也可能还是同一个人但时长和次数都变了（那句 reason 里写着）。 */
  renderPriority();
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

    handleMessage('dormmate/' + nodeId + '/env', JSON.stringify(payload));
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
  });
  messages.length = 0;
  renderCards();
  renderDetailHead();
  renderAction();
  renderScene();
  renderCharts();
  renderPriority();
  renderLog();
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
const TOPIC = 'dormmate/+/env';

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

/* ---------- 启动 ---------- */

el.simulate.addEventListener('click', simulate);
el.clear.addEventListener('click', clearAll);

el.toggle.addEventListener('click', function () {
  if (client) disconnect();
  else connect();
});

/* 卡片是每次重绘的，所以点击用事件委托挂在容器上，不给每张卡单独绑 */
el.cards.addEventListener('click', function (e) {
  const card = e.target && e.target.closest ? e.target.closest('.card') : null;
  if (card && card.dataset.node) selectNode(card.dataset.node);
});

/* 「优先关注」那条也是重绘的，同样用委托。
   它跟卡片走的是**同一条路**（selectNode）—— 点它和点对应那张卡片
   没有任何区别，卡片、趋势图、3D 一起切过去。
   全正常时那里是个没有 data-node 的 <p>，这个判断顺手把它挡掉了。 */
el.priority.addEventListener('click', function (e) {
  const focus = e.target && e.target.closest ? e.target.closest('.focus') : null;
  if (focus && focus.dataset.node) selectNode(focus.dataset.node);
});

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

  renderCards();
  renderAction();
  renderScene();
});

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
if (darkQuery.addEventListener) darkQuery.addEventListener('change', applyChartTheme);

renderCards();
renderDetailHead();
renderAction();
renderScene();
renderCharts();
renderPriority();
renderLog();

/* 打开页面就连。连不上也不影响「模拟三节点数据」按钮 —— 那是不经过 Broker 的，
   现场没网的时候正好用来演示界面。 */
connect();
