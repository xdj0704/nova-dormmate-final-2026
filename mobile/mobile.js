// mobile/mobile.js
// Step E3-3：移动端 H5 —— 宿舍环境助手在手机上的那一半。
//
// 【它和看板是什么关系】
// 同一个 core、同一条快照（dormmate/v1/state）、同一套「只渲染」的规矩。
// 差别只有两处：
//
//   1) 屏幕小。只留三件事：谁该管（大卡片）、点一下看它（迷你列表）、
//      按开始处理。趋势图、事件表、被拒绝报文、3D 那些留在看板上 ——
//      不是它们不重要，是手机上塞不下，而且演示时手机的角色是
//      「人在宿舍里随手看一眼」，不是「坐下来分析」。
//
//   2) **它会发 focus**。手机上点一个宿舍 = 「我看这个」，发出去之后 core
//      把它记进快照的 focus 字段，看板和 3D 跟着切过去（README 的 E3
//      那一节画了这条链路）。看板**故意不发** focus：两个端都能改焦点的话，
//      两个人同时看就会互相抢。这条约定写在 shared/config.js 的
//      CMD_ACTION_FOCUS 那段注释里。
//
// 【为什么共用看板的 logic.js，而不是自己写一份】
// 「把快照里的字段摆成人话」这件事，两份实现迟早会分叉 —— 大卡片上写
// 「跨端焦点」而看板上写「当前重点」，同一帧数据在两个人眼里是两个说法，
// 而两个人都以为自己在看事实。logic.js 里是纯函数（不碰 DOM、不读全局、
// 不调 Date.now），所以两个页面共一份是安全的，也不会有谁把谁带坏。
// 于是这个文件里**没有任何判断**：谁是重点、处理到哪一步、能不能按，
// 全部由 logic.js 读快照字段回答 —— 和看板拿到的永远是同一个答案。
// 这里只干两件事：把那些字贴到 DOM 上，和把两条指令发出去。
//
// 【它一条遥测都不订】和看板一样，只订 dormmate/v1/state。
// 手机是最容易被「自己造一份数据看着像同步」骗过去的地方（网络慢、
// 看不出真假），E3 明确禁止这件事：屏幕上每一个字都得是 core 发过来的。
//
// 这个文件是 **ES 模块**（index.html 里写的是 type="module"），
// 所以页面必须走 http 服务器打开。

/* 和看板共用的那一份。import 用的是相对路径，所以这一页不需要 importmap。 */
import { readSnapshot, nodeOf, focusBanner, handlingOf, actionState, cmdNote,
  snapshotSummary } from '../dashboard/logic.js';

/* ---------- 配置 ---------- */

/* Broker 地址和 topic 常量来自 shared/config.js（Step E3-1）——
   那是普通 <script>，挂的是 globalThis；这个模块里读 window.DormMateConfig，
   浏览器里两者是同一个东西（测试里也照这样搭上下文）。
   读不到就说明 <script> 的顺序错了或者那个文件没加载上，页面只能明说。 */
const CFG = typeof window !== 'undefined' ? window.DormMateConfig : null;

/* 指令里带的来源。core 会把它打进日志：`[指令] dorm-b focus（mobile）`——
   演示时一眼分出这一条是手机发的、还是 send_cmd.py / 看板发的。 */
const SOURCE_MOBILE = 'mobile';

/* ---------- 页面状态 ---------- */

/* 最近一帧通过校验的快照。null = 还没收到过（那三个宿舍此刻是**不知道**，
   不是正常）。整页的字都从这里取，别处不留第二份。 */
let snapshot = null;

/* 上一次记进日志的焦点，用来只在**变化时**记一行（跨端联动的证据）。
   初值是空串而不是 undefined：空串就是「没有焦点」，和快照里没有焦点时
   算出来的那个值一模一样；写成 undefined 的话，第一帧（本来就没焦点）
   会被当成一次「从有到无」，每次刷新页面都先记一行「跨端焦点已取消」——
   一件根本没发生过的事。（看板那边踩过同一个坑。） */
let loggedFocus = '';

/* 消息日志，新的在前。 */
const messages = [];

/* 手机上日志最长留这么多行。看板留 100 行是因为那块地方够；
   这里留 30 行，滚三屏就到底了，再多也没人会翻。 */
const LOG_MAX = 30;

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
 * （那是浏览器收到这一条的时刻），页面上别处显示的时刻全来自快照。
 *
 * 不用 toLocaleString()：它的输出跟着浏览器和系统区域设置走，
 * 同一个页面在不同手机上给出的格式可能不一样。
 */
function formatTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
    + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
}

/* ---------- DOM ---------- */

const el = {
  app: document.getElementById('app'),
  conn: document.getElementById('conn'),
  connText: document.getElementById('conn-text'),
  focus: document.getElementById('focus'),
  nodes: document.getElementById('nodes'),
  nodeCount: document.getElementById('node-count'),
  actionHandle: document.getElementById('action-handle'),
  actionState: document.getElementById('action-state'),
  cmdNote: document.getElementById('cmd-note'),
  logBody: document.getElementById('log-body'),
  logCount: document.getElementById('log-count'),
};

/* ---------- 消息日志 ---------- */

/* 日志级别那三个词。**「正常」那一档故意写成「收到」**：
   「正常」在这个项目里是 core 算出来的四种状态之一（rules.py），
   让它在这个文件里出现，下面那条「这个文件里一个状态词都没有」就再也测不了了
   —— 而那一条正是「这里没有第二份规则」最便宜的证明。
   何况在一份消息流水里，「收到」本来就比「正常」更准确：它标的是级别，
   不是宿舍的状态。 */
const LEVEL_TEXT = { ok: '收到', warn: '警告', error: '错误' };

/**
 * 记一条日志。消息和错误都走这里，所以这块是排查问题的第一现场。
 *
 * **写完当场就画**（和看板那边一样）。不能等下一帧快照 —— 被拦下的报文
 * （topic 不对、JSON 坏了、版本不对）走的是 handleMessage 里提前 return
 * 那几条岔路，而**整页重画只发生在收下快照之后**。日志区要是攒着不画，
 * 「core 一直不发快照」这种情况下手机上会是一片空白，而 Console 在手机上是
 * 看不见的 —— 那时候唯一的线索就是这块地方，它偏偏什么都没写。
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
  if (messages.length === 0) {
    el.logBody.innerHTML = '<li class="log-empty">还没有收到消息</li>';
    return;
  }
  el.logBody.innerHTML = messages.map(function (m) {
    return '<li class="log-row log-row--' + esc(m.level) + '">'
      + '<span class="log-time">' + esc(m.time.slice(11)) + '</span>'
      + '<span class="log-level">' + esc(LEVEL_TEXT[m.level] || m.level) + '</span>'
      + '<span class="log-text">' + esc(m.text) + '</span></li>';
  }).join('');
}

/* ---------- 大卡片（优先关注 / 跨端焦点） ---------- */

/**
 * 画顶部那张大卡片。**这里一个字都不拼** —— 说什么全由 focusBanner() 决定，
 * 它和看板顶部那一行是同一个函数，两个屏幕因此永远说同一件事。
 *
 * 状态词（正常 / 偏热 / …）不放进 JS 的映射表，而是原样写进 `data-status`
 * 属性，由 style.css 里的 `[data-status="…"]` 挑颜色。这样这个文件里
 * **一个状态词都没有**（有测试盯着），也就没有任何地方能长出「第二份规则」；
 * 认不出来的状态（比如 core 某天加了个新的）属性照样写上去，样式落到
 * 兜底那一档，字面照常显示 —— 和看板「不认识的状态原样显示」是同一个行为。
 */
function renderFocus() {
  const b = focusBanner(snapshot);

  if (b.mode === 'calm') {
    /* 没有重点也没有焦点：一张安安静静的卡片。不做成按钮 ——
       没东西可点的时候长成按钮的样子，人只会反复点它。 */
    el.focus.className = 'big big--calm';
    el.focus.dataset.status = '';
    el.focus.innerHTML = '<p class="big-line">' + esc(b.line) + '</p>';
    return;
  }

  const status = b.status == null ? '' : String(b.status);
  el.focus.className = 'big';
  /* 状态原样挂到属性上，配色由 style.css 按字面挑（见那个文件开头）。
     ★ 挂在**卡片这一层**而不是里面那个按钮上：CSS 要挑的是整张卡片的
     竖线颜色，用 :has() 也能写，但 :has() 在旧一点的浏览器里整条规则会被
     丢掉，而丢掉的正好是「偏热的卡片是红的」这件事 —— 出错的方式太安静了。 */
  el.focus.dataset.status = status;

  let html = '<button class="big-hit" type="button"'
    + ' data-focus-node="' + esc(b.nodeId) + '">'
    + '<span class="big-tag">' + esc(b.tag) + '</span>'
    + '<span class="big-head">'
    + '<span class="big-node">' + esc(b.nodeId) + '</span>'
    + '<span class="badge">' + esc(status || '还没有收到数据') + '</span>'
    + '</span>'
    + '<span class="big-line">' + esc(b.line) + '</span>'
    + '</button>';

  /* 理由永远来自快照里 core 写的字（被点名时就是「谁点的名」）。
     没有就不占那一行。 */
  if (b.reason) html += '<p class="big-why">' + esc(b.reason) + '</p>';
  if (b.cross) html += '<p class="big-cross">' + esc(b.cross) + '</p>';

  /* 这一行是**教怎么用**，不是状态：手机上没人会去猜「点一下会怎样」。
     写出来之后，「再点一下取消」这条 core 的规矩才有地方知道。 */
  html += '<p class="big-hint">点这张卡片 = 把焦点切到它；同一个宿舍再点一下是取消。</p>';

  el.focus.innerHTML = html;
}

/* ---------- 宿舍迷你列表 ---------- */

/**
 * 一行一个宿舍，整行可点（`<button>`，于是键盘和读屏软件也认）。
 *
 * 高亮的那一行（is-watching）是「大卡片正在说谁」—— 由 focusBanner 算出来，
 * 也就是 core 的焦点 / 重点。**点一下不会立刻点亮**：焦点归属是 core 说了算，
 * 要等下一帧快照。本地先把那一行点亮就是在伪造同步，那正是 E3 禁止的事。
 */
function renderNodes() {
  const nodes = snapshot && Array.isArray(snapshot.nodes) ? snapshot.nodes : [];

  el.nodeCount.textContent = nodes.length > 0 ? nodes.length + ' 个' : '';

  if (nodes.length === 0) {
    el.nodes.innerHTML = '<p class="nodes-empty">还没有收到 core 的快照。</p>';
    return;
  }

  const watching = focusBanner(snapshot).nodeId || '';

  el.nodes.innerHTML = nodes.map(function (n) {
    if (!n || !n.nodeId) return '';
    const status = n.status == null ? '' : String(n.status);
    const handling = handlingOf(snapshot, n.nodeId);
    return '<button class="node' + (n.nodeId === watching ? ' is-watching' : '')
      + '" type="button"'
      + ' data-focus-node="' + esc(n.nodeId) + '"'
      + ' data-status="' + esc(status) + '">'
      + '<span class="node-name">' + esc(n.nodeId) + '</span>'
      + '<span class="node-read">' + esc(fmt(n.temperature)) + '℃ · '
      + esc(fmt(n.humidity)) + '%</span>'
      + '<span class="badge">' + esc(status || '—') + '</span>'
      /* 「待处理 / 处理中」来自 core 的事件（handlingOf 读的），不是这边判的。
         正常节点没有未结案的事件，这一格就不出现。 */
      + (handling.label !== '无' ? '<span class="node-flag">' + esc(handling.label) + '</span>' : '')
      + '</button>';
  }).join('');
}

/* ---------- 处理按钮 ---------- */

/**
 * 「开始处理」按钮的样子和作用对象。
 *
 * 作用在**大卡片上那个宿舍**（focusBanner 挑出来的：有焦点用焦点，
 * 没有就用 core 选的重点）—— 和看板「作用在当前选中的那个」是同一个口径，
 * 只是手机上「正在看哪个」只有这一处出口。
 *
 * 能不能按、按不动时旁边写什么，全部来自 logic.js 的 actionState（纯函数，
 * 和看板共用）：这个宿舍有一条**待处理**的事件才能按。页面不复核状态 ——
 * 状态正常但 core 那边还挂着未结案的事件时，按钮该是什么样由 core 说。
 */
function renderAction() {
  const subject = focusBanner(snapshot).nodeId;

  if (!subject) {
    /* 快照里既没有焦点也没有重点，按钮就没对象可作用。这时候旁边写什么
       分两种，**都不是业务判断**：
         - 一帧都还没收到：说的是页面的处境（连「哪个宿舍」都还不知道，
           拿 actionState 的话来顶会说成「core 还没收到这个节点的数据」，
           而「这个节点」根本不存在）
         - 收到了但没人被点名：直接用 focusBanner 那句平静话（大卡片上
           写的就是它）—— 两处同一句，不会出现「卡片说都正常、按钮说
           还没收到数据」这种自相矛盾 */
    el.actionHandle.disabled = true;
    el.actionState.textContent = snapshot
      ? focusBanner(snapshot).line
      : '还没有收到 core 的快照，先等它发一帧过来';
    return;
  }

  const state = actionState(snapshot, subject);
  el.actionHandle.disabled = !state.enabled;
  el.actionState.textContent = state.note;
}

/** 整页重画。收到一帧快照之后走一遍。 */
function renderAll() {
  renderFocus();
  renderNodes();
  renderAction();
  renderLog();
}

/* ---------- 唯一的消息入口 ---------- */

/**
 * 处理一条快照。整个页面只有这一个入口。
 *
 * 顺序是刻意的，前面一步没过就 return，不做下一步：
 *   1) topic 必须就是那一条 —— 只订了它，别的都当没看见（写进日志）
 *   2) JSON.parse 包 try/catch —— 坏数据什么都能抛
 *   3) readSnapshot 校验形状与版本（在 logic.js 里，和看板共用同一份）
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

  if (topic !== CFG.STATE_TOPIC) {
    logLine('warn', topic, '不是快照 topic（' + CFG.STATE_TOPIC + '），已忽略');
    return false;
  }

  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch (err) {
    logLine('error', topic, 'JSON 解析失败：' + err.message);
    return false;
  }

  const result = readSnapshot(payload);
  if (!result.ok) {
    logLine('error', topic, '快照校验不通过：' + result.reason);
    return false;
  }

  /* 整份替换，不是逐字段合并 —— 快照的意义就是「这一帧是此刻的全部」，
     留着上一帧的字段会做出一个不存在的状态。 */
  snapshot = result.snapshot;

  /* 焦点变了才记一行。快照是反复发的，每次都记的话日志会被同一句话刷屏，
     反而看不出哪一次真的变了 —— 而这一行正是跨端联动的证据。 */
  const focusId = snapshot.focus && typeof snapshot.focus.nodeId === 'string'
    ? snapshot.focus.nodeId : '';
  if (focusId !== loggedFocus) {
    loggedFocus = focusId;
    if (focusId) {
      const by = snapshot.focus.by ? String(snapshot.focus.by) : '别的端';
      logLine('ok', topic, '跨端焦点 → ' + focusId + '（' + by + ' 发的 focus）');
    } else {
      logLine('ok', topic, '跨端焦点已取消');
    }
  }

  logLine('ok', topic, snapshotSummary(snapshot));

  renderAll();
  return true;
}

/* ---------- MQTT ---------- */

/* 当前那根连接。null 表示没连上，或已被主动断开。 */
let client = null;

function setConn(kind, text) {
  el.conn.className = 'conn conn--' + kind;
  el.connText.textContent = text;
}

function connect() {
  if (!CFG) {
    setConn('off', '未加载 config.js');
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
    clientId: 'dormmate-mobile-' + Math.random().toString(16).slice(2, 8),
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 5000,
    keepalive: 30,
  });
  client = c;

  /* 每个回调开头都先确认自己还是当前那根连接 —— 断开或换过连接之后，
     旧连接的回调还可能补触发一次，不挡掉就会把新连接的状态覆盖成旧的。 */
  function current() { return client === c; }

  c.on('connect', function () {
    if (!current()) return;
    setConn('on', '已连接');
    /* 只订这一条。多订一条都会走 handleMessage，而那里只认它。 */
    c.subscribe(CFG.STATE_TOPIC, { qos: CFG.QOS }, function (err) {
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
    console.log('[DormMate] 收到 MQTT 原始消息', topic, text);
    handleMessage(topic, text);
  });
}

/* ---------- 两条指令 ---------- */

/** 连不上时那句「没发出去」的原因。两条指令各写一遍是因为 prompt 的话不一样。 */
function notSentReason() {
  return client ? '还没连上 broker' : '连接还没建立（mqtt.js 没加载或已断开）';
}

/**
 * 把一条「开始处理」发给 core。返回 `{ok, reason}`，**不抛异常**。
 *
 * 【只发事实，不发结论】这条消息里没有 status、没有 state、没有任何
 * 「已恢复」。core 收到它只会把事件从待处理推到处理中，之后好没好由它
 * 后面收到的报文说了算 —— 那条红线在 core 那边是结构上成立的
 * （`handle_command` 拿不到节点状态），这边只需要不往消息里塞那些东西。
 *
 * 【带 time】带的是**最新那条快照里这个节点的时刻**，不是手机时钟 ——
 * 手机的时间和 core 不一定对得上（时区、手动改过），盖上两个不同的章，
 * 事件的时间线就乱了。
 *
 * 【不 retained】指令是一次性的。留在 broker 上的话，下一次起 core 时会
 * 凭空把某条事件推进「处理中」—— 那条指令是上一次演示发的，人早忘了。
 *
 * @param {string} nodeId
 * @param {string} actionTime
 * @returns {{ok: boolean, reason: string}}
 */
function sendHandle(nodeId, actionTime) {
  if (!CFG) return { ok: false, reason: '未加载 shared/config.js' };
  if (!client || !client.connected) return { ok: false, reason: notSentReason() };

  const payload = { nodeId: nodeId, action: CFG.CMD_ACTION, source: SOURCE_MOBILE };
  /* time 只在真的是个非空字符串时才带上。JSON.stringify 会把 undefined 的键
     直接丢掉，所以这里显式判一下，别靠它的副作用。 */
  if (typeof actionTime === 'string' && actionTime) payload.time = actionTime;

  return publish(payload);
}

/**
 * 把一条「焦点切到这个宿舍」发给 core。返回 `{ok, reason}`，不抛异常。
 *
 * 【同一个宿舍再发一次 = 取消】这条规矩在 core 里（`handle_command` 里
 * focus 那一支），**不在这边判**：页面只管把「我要看 dorm-b」说出去，
 * 是不是取消由 core 决定 —— 这边自己判的话，就又多了一份「当前焦点是谁」
 * 的本地状态，而那份状态迟早会和 core 的不一样。
 *
 * 【不带 time】focus 不是一条事件，它不挂在读数的时间线上；带上一个手机
 * 时刻反而会被当成「这条指令产生的时刻」。core 收到它盖的是自己那一刻的章
 * （快照里 focus.at 就是它），两边不会有两个说法。
 *
 * 【谁在发】移动端和 3D 页面各有一份这个函数 —— 两边都是「点一下，把镜头
 * 切到那一间」，只是点的是卡片还是房间。看板不发：它那块 3D 面板本来就只看
 * 一间，没有「切到哪一间」这回事。规则和 source 的名字见 shared/config.js
 * 的 CMD_ACTION_FOCUS。
 *
 * @param {string} nodeId
 * @returns {{ok: boolean, reason: string}}
 */
function sendFocus(nodeId) {
  if (!CFG) return { ok: false, reason: '未加载 shared/config.js' };
  if (!client || !client.connected) return { ok: false, reason: notSentReason() };

  return publish({ nodeId: nodeId, action: CFG.CMD_ACTION_FOCUS, source: SOURCE_MOBILE });
}

/** 两条指令共用的出口：拼 JSON、发到 cmd topic、往 Console 打一行。 */
function publish(payload) {
  const text = JSON.stringify(payload);
  client.publish(CFG.CMD_TOPIC, text, { qos: CFG.QOS, retain: CFG.CMD_RETAIN });
  console.log('[DormMate] 发出 MQTT 指令', CFG.CMD_TOPIC, text);
  return { ok: true, reason: '' };
}

/**
 * 发完 focus 之后，按钮下面那行说明。
 *
 * 和看板上的 cmdNote 分开写，是因为那句是**照着 handle 那件事**写的
 * （「好没好由 core 后续收到的报文判」是事件结案的说法，焦点没有这回事）。
 * 措辞放在这里而不是 logic.js：logic.js 是三个出口共用的一套词，而 focus
 * 这句话只有移动端这一处这么说 —— 3D 页面点房间也发 focus，但它那句写在自己
 * 页面里（说的是「镜头什么时候飞过去由 core 说了算」）。凑成一句反而四不像。
 *
 * 那半句「要等 core 发回新快照」必须留着：手机上点一下**屏幕上什么都不变**，
 * 不说的话就是「点了没反应」；说了才知道该等什么。
 */
function focusNote(ok, nodeId, detail) {
  if (ok) {
    return '已把 focus 指令发给 core：' + nodeId + '。看板、3D 和这一页都要等 '
      + 'core 发回新快照才会跟过去；同一个宿舍再点一下是取消，'
      + '取消成不成同样由 core 说了算。';
  }
  const why = typeof detail === 'string' && detail.trim() ? detail.trim() : '不知道什么原因';
  return '这条指令没发出去（' + why + '）—— 页面上不会有任何变化。';
}

/* ---------- 点击 ---------- */

/* 整页只有这一处挂点击（事件委托在 #app 上）。
   带 data-focus-node 的东西有两个：大卡片和列表里每一行 —— 点它们做的事
   **完全一样**，所以不写两份。 */
el.app.addEventListener('click', function (e) {
  const hit = e.target && e.target.closest ? e.target.closest('[data-focus-node]') : null;
  if (!hit) return;
  const nodeId = hit.dataset ? hit.dataset.node : '';
  if (!nodeId) return;

  const sent = sendFocus(nodeId);
  /* ★ 这里**只写这一行字**。屏幕上别的一个字节都不动 ——
     焦点是 core 说了算的，本地先点亮那一行就是伪造同步。 */
  el.cmdNote.textContent = focusNote(sent.ok, nodeId, sent.reason);
});

/**
 * 「开始处理」。作用在大卡片上那个宿舍上，只做两件事：
 *   1) 把 handle 发给 core
 *   2) 把那句说明写到按钮下面
 * 屏幕上其余的东西**一个字都不动** —— 等 core 的新快照回来，renderAll()
 * 会照着那一帧重画。所以按一下之后画面会「过一拍才变」，那一拍就是
 * core 的往返。
 */
el.actionHandle.addEventListener('click', function () {
  const subject = focusBanner(snapshot).nodeId;
  if (!subject) return;
  const node = nodeOf(snapshot, subject);
  const sent = sendHandle(subject, node ? node.time : '');
  el.cmdNote.textContent = cmdNote(sent.ok, sent.reason);
});

/* ---------- 启动 ---------- */

/* 启动那一刻就把空状态画出来：大卡片和列表上都会写着「还没有收到 core 的
   快照」，而不是「都正常」—— 页面刚打开那几秒，那三个宿舍是**不知道**，
   不是正常。卡片上的状态也一律是「—」「还没有收到数据」。 */
renderAll();

/* 打开页面就连。连不上时页面只说「还没收到快照」，不会再造一份假数据顶上 ——
   E3 明确禁止「手动输入数据伪造同步效果」。要数据就跑 simulator/，
   或者在 MQTTX 里发。 */
connect();
