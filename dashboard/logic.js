// dashboard/logic.js
// Step E3-2：看板只剩「把 core 发来的快照摆成几句话」这一件事。
//
// 【这一轮砍掉了什么，为什么】
// E3 之前，这个文件里有整整一套业务判断：连续异常段（nextAbnormal）、优先关注
// 排序（pickPriority）、处理动作状态机（beginHandling / nextHandling）、事件
// 记录（beginEvent / markAction / closeEvent）、总览与依据（buildOverview /
// buildReasons）。那是「前端自己算一遍」时代的产物，代价是同一件事有两份实现：
// core.py 一份、这里一份，而两边的恢复判据、事件开案时刻、时长口径**都不完全
// 一样**（见 README 「恢复判据两边还不一样」那条）。
//
// E3 定的规矩是「前端只订阅 dormmate/v1/state，只渲染，不做业务计算」。照着
// 这条规矩，上面那一整套**整体搬去了 core**，这里一个判断都不再留：
//   - 谁是重点、凭什么         -> core 的 rules.rank_priority，走 snapshot.priority
//   - 一段异常从哪到哪          -> core 的事件状态机，走 snapshot.events
//   - 处理到哪一步了            -> 同上（OPEN / HANDLING / RECOVERED / UNRESOLVED）
//   - 异常持续了多久            -> core 的 durationText（连格式化都不在这边做）
//   - 一条报文为什么被拒        -> core 的 snapshot.rejects
//   - 现在在看哪个宿舍          -> core 的 snapshot.focus（跨端联动）
//
// 留下来的只有两种东西：
//   1) **读**：把快照里的字段取出来（readSnapshot / nodeOf / openEvent / latestEvent）
//   2) **说**：把那些字段摆成一句人话（focusBanner / alertLine / trendText / …）
// 说的时候一个数字都不算、一个结论都不下 —— 「处理中」这三个字来自事件的
// state 字段，不是这边判出来的；「偏热」来自 core 算好的 status，这边连
// 温度阈值都不认识（这个文件里没有 18 / 30 / 75 这三个数，有测试盯着）。
//
// 【唯一一处「算」：温度往哪走】trendOf 拿最近两个读数比大小，得出
// 上升 / 下降 / 持平。它不是业务判断：没有阈值、不产生状态、不影响任何结论，
// 只是给那句提醒添半句话。真要让 core 算，快照就得再加一个字段，
// 而它连「异常」的定义都碰不到。这个取舍写在 README 的 E3-2 那一节。
//
// 文件仍然是**纯函数**：不碰 DOM、不读全局、不调 Date.now()，
// 所以 tests/logic.test.js 不用打任何桩就能把它整个测一遍。

/**
 * 这份页面认的快照版本，必须和 core.py 的 SNAPSHOT_VERSION 对上。
 *
 * 单独写成一个常量而不是直接比 2：改的时候两边一起 grep 得到。
 * 版本对不上时页面**不装作能读**（见 readSnapshot）—— 少一个字段就整块显示
 * undefined，比直接说「版本不对」难查得多。
 */
export const SNAPSHOT_VERSION = 2;

/* ---------- 读：把快照拆开 ---------- */

/**
 * 校验一条 `dormmate/v1/state` 报文。
 *
 * 前端从此**只订这一条 topic**，所以这是页面上唯一的入口校验：过了这一关，
 * 后面每一处渲染都可以直接取字段，不用到处判 `undefined`。
 *
 * 判据只针对**形状**，不针对内容：某个宿舍温度是 99℃ 照样放行（core 那边
 * 就不拦，D4 第 5 条正是拿它演示的）。这里挡的是「这条消息压根不是快照」——
 * 端口连错了订到别的 topic、新旧版本混跑、broker 上留着别人的数据。
 *
 * 返回 `{ok, snapshot, reason}`，**不抛异常**：调用方只有一条路要走
 * （不 ok 就把 reason 写进日志），不用为「抛了」再写一套。
 *
 * @param {*} value JSON.parse 之后的快照
 * @returns {{ok: boolean, snapshot: Object|null, reason: string}}
 */
export function readSnapshot(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return bad('快照顶层不是对象（收到 '
      + (Array.isArray(value) ? 'array' : String(value)) + '）');
  }
  if (!Number.isFinite(value.v)) {
    return bad('快照里没有 v（版本号）字段，这不像是 core 发的那份');
  }
  if (value.v !== SNAPSHOT_VERSION) {
    return bad('快照版本是 ' + value.v + '，这个页面认的是 ' + SNAPSHOT_VERSION
      + '（core.py 改了字段就要一起改）');
  }
  if (!Array.isArray(value.nodes)) {
    return bad('快照里没有 nodes 数组');
  }
  if (!isObject(value.events) || !Array.isArray(value.events.events)) {
    return bad('快照里没有 events（事件那一块）');
  }
  if (!isObject(value.rejects) || !Array.isArray(value.rejects.items)) {
    return bad('快照里没有 rejects（被拒绝消息那一块）');
  }
  if (!isObject(value.counters)) {
    return bad('快照里没有 counters');
  }
  /* priority / focus 两个都可能是 null（没有重点 / 没人点名），那不是错，
     是「此刻没有」—— 但也不能是别的类型，那说明字段搬了家。 */
  if (value.priority !== null && !isObject(value.priority)) {
    return bad('priority 既不是对象也不是 null');
  }
  if (value.focus !== null && !isObject(value.focus)) {
    return bad('focus 既不是对象也不是 null（旧版 core 没有这个字段）');
  }
  return { ok: true, snapshot: value, reason: '' };
}

function bad(reason) {
  return { ok: false, snapshot: null, reason: reason };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 快照里某个宿舍那一条。找不到就 null（不抛）—— 快照里有哪些宿舍是 core 的
 * 配置说了算，这个文件里**没有**任何写死的节点名（@see tests/logic.test.js）。
 *
 * @param {Object|null} snapshot
 * @param {string} nodeId
 * @returns {Object|null}
 */
export function nodeOf(snapshot, nodeId) {
  const list = snapshot && Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].nodeId === nodeId) return list[i];
  }
  return null;
}

/** 快照里那几个宿舍，按 core 给的顺序。没有就直接给空数组。 */
function nodeList(snapshot) {
  return snapshot && Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
}

/** 事件那一块（`snapshot.events`），形状不对时给一个空壳，省得每处都判。 */
function eventBlock(snapshot) {
  const block = snapshot && isObject(snapshot.events) ? snapshot.events : null;
  return {
    summary: block && isObject(block.summary) ? block.summary : {},
    events: block && Array.isArray(block.events) ? block.events : [],
  };
}

/**
 * 某个宿舍**当前还没结案**的那条事件（状态是 OPEN 或 HANDLING）。
 *
 * 「处理到哪一步了」在 E3 之前是前端自己记的四个字段（handling / action /
 * actionTime / dataAfterAction）。现在它是 core 事件机里那条事件的**状态**：
 * 没有未结案的事件 = 这个宿舍此刻没什么在处理。
 *
 * 取**最后**一条匹配的：core 保证一个宿舍同时只有一条没结案的事件，但如果
 * 哪天不是了（比如重启后读到两条没结案的），拿最近那条总比拿最早那条对。
 *
 * @param {Object|null} snapshot
 * @param {string} nodeId
 * @returns {Object|null}
 */
export function openEvent(snapshot, nodeId) {
  const list = eventBlock(snapshot).events;
  let found = null;
  list.forEach(function (e) {
    if (e && e.nodeId === nodeId && (e.state === 'OPEN' || e.state === 'HANDLING')) {
      found = e;
    }
  });
  return found;
}

/**
 * 某个宿舍**最近**的那条事件，结过案的也算。
 *
 * 3D 里的风扇读的是它：动作一旦有人按过（`event.action` 有值），扇叶就一直
 * 转着 —— 这和 7-2 定下的行为一样（「已恢复」之后照样转，只有清空才停），
 * 只是判断依据从「前端记的 handling 字段」换成了 core 记的那笔动作。
 *
 * 拿的是 `snapshot.events.events` 里最近 20 条，所以挂机很久之后最早那几条
 * 会被挤掉 —— 挤掉的是**结过案**的，判「风扇开着没」只需要最近那条。
 *
 * @param {Object|null} snapshot
 * @param {string} nodeId
 * @returns {Object|null}
 */
export function latestEvent(snapshot, nodeId) {
  const list = eventBlock(snapshot).events;
  let found = null;
  list.forEach(function (e) {
    if (e && e.nodeId === nodeId) found = e;
  });
  return found;
}

/** 事件状态那几个英文值对应的中文。认不出来的原样返回，不假装懂。 */
export function eventStateText(state) {
  const table = {
    OPEN: '待处理',
    HANDLING: '处理中',
    RECOVERED: '已恢复',
    UNRESOLVED: '未恢复',
  };
  if (typeof state !== 'string' || !state) return '';
  return Object.prototype.hasOwnProperty.call(table, state) ? table[state] : state;
}

/**
 * 某个宿舍此刻的处理状态，给卡片和详情区用。
 *
 *   {label, event, after}
 *   label  '无' | '待处理' | '处理中'
 *   event  那条未结案的事件（没有就是 null）
 *   after  处理之后又收到几条异常（core 数好的，前端不自己数 verify 数组 ——
 *          那个数组有上限，数出来的和判定用的不是一回事）
 *
 * **「已恢复」不在这里**：那是结过案的状态，属于事件表，不属于「卡片上这个
 * 宿舍正在被处理吗」。一个宿舍恢复之后就是正常了，卡片上不该还挂着处理字样。
 *
 * @param {Object|null} snapshot
 * @param {string} nodeId
 * @returns {{label: string, event: Object|null, after: number}}
 */
export function handlingOf(snapshot, nodeId) {
  const event = openEvent(snapshot, nodeId);
  if (!event) return { label: '无', event: null, after: 0 };
  const after = Number.isFinite(event.abnormalAfter) ? event.abnormalAfter : 0;
  return {
    label: event.state === 'HANDLING' ? '处理中' : '待处理',
    event: event,
    after: after,
  };
}

/**
 * 「开始处理」这个按钮：能不能按、按不了的时候旁边那行字说什么。
 *
 *   {enabled, note}
 *
 * 返回的是**一对**而不是「一个布尔 + 另一处再拼一句解释」：能按与否和那句
 * 解释说的是同一件事，分成两个函数写的话，改了一处忘了另一处，就会出现
 * 「按钮灰着，旁边写着『可以开始处理』」。
 *
 * 能按的唯一条件：这个宿舍有一条**待处理**的事件（core 开过案、还没人动过）。
 * 其余几种情况都不是「出错」，只是这个按钮此刻没有意义，所以每一种都把自己
 * 的原因写出来 —— 灰按钮不说明原因，用的人只会以为页面坏了。
 *
 * 注意这里**不判断状态好不好**：状态正常但 core 那边还挂着一条未结案的事件
 * （处理之后连着几条正常、还没到恢复的条数），按钮该是什么样由 core 的事件说，
 * 不由 `node.status` 说。前后两句话要是有出入，以 core 的为准。
 *
 * @param {Object|null} snapshot
 * @param {string} nodeId
 * @returns {{enabled: boolean, note: string}}
 */
export function actionState(snapshot, nodeId) {
  const node = nodeOf(snapshot, nodeId);
  if (!node || node.status == null) {
    return { enabled: false, note: 'core 还没收到这个节点的数据，现在按了也没有对应的事件' };
  }

  const handling = handlingOf(snapshot, nodeId);
  if (handling.label === '处理中') {
    return {
      enabled: false,
      note: 'core 那边这条事件正在处理中'
        + (handling.after > 0 ? '（之后又收到 ' + handling.after + ' 条异常）' : '')
        + '—— 再按一次只会多记一笔动作，不会让它更快结案',
    };
  }
  if (handling.label === '待处理') return { enabled: true, note: '' };

  if (node.status === '正常') {
    return { enabled: false, note: '这个宿舍当前状态正常，core 那边也没有未结案的事件' };
  }
  return {
    enabled: false,
    note: 'core 还没为这个宿舍开案 —— 它要连续收到几条异常才开一条'
      + '（现在连着 ' + (Number.isFinite(node.abnormalCount) ? node.abnormalCount : 0) + ' 条）',
  };
}

/**
 * 3D 里的风扇该不该转。判据只有一条：这个宿舍最近那条事件里有没有一笔
 * **被接受的动作**（`event.action`）。有就转，而且一直转着。
 *
 * 转不转**不由状态决定**：偏热的宿舍按 LOOK 表本来就会转（那是 scene.js 的
 * 事），这里回答的是「有没有人按过开始处理」——两者叠在一起，谁也不覆盖谁。
 *
 * @param {Object|null} snapshot
 * @param {string} nodeId
 * @returns {boolean}
 */
export function fanOn(snapshot, nodeId) {
  const event = latestEvent(snapshot, nodeId);
  return Boolean(event && event.action);
}

/* ---------- 说：把字段摆成人话 ---------- */

/**
 * 温度往哪走。**只看最近两条** —— 前面跌得再狠，最近一次是涨的就是「上升」。
 *
 * 比的是**精确值**，不设容差：设一个「小于 0.5℃ 算没变」的阈值要先定下来
 * 多少算没变，那是另一套规则，这一步不定。
 *
 * 只有一条记录时返回空串而**不是「持平」**：一条数据说不出「在往哪走」，
 * 说成持平就是把「不知道」说成了「没变」。这和「一条数据都没有 ≠ 正常」
 * 是同一条原则。
 *
 * 这是这个文件里**唯一**一处「算」，理由见文件开头那段。
 *
 * @param {Array<{temperature: number}>} history 快照里带的那段历史
 * @returns {'上升'|'下降'|'持平'|''}
 */
export function trendOf(history) {
  if (!Array.isArray(history) || history.length < 2) return '';

  const now = history[history.length - 1];
  const before = history[history.length - 2];
  if (!now || !before) return '';

  /* Number.isFinite 顺手把 NaN / Infinity / 字符串 / undefined 一起挡掉 */
  const a = before.temperature;
  const b = now.temperature;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';

  if (b > a) return '上升';
  if (b < a) return '下降';
  return '持平';
}

/**
 * 趋势那半句话。「温度正在持平」不成话，所以持平单独一句。
 *
 * **不写成「温度不变」**：同一个意思在两个出口（顶部那一行和语音）里各写
 * 各的，迟早会不一样。
 */
export function trendText(trend) {
  if (!trend) return '';
  if (trend === '持平') return '温度持平';
  return '温度正在' + trend;
}

/** 数一数现在有几个宿舍正常、几个还没收到数据。 */
function survey(snapshot) {
  const nodes = nodeList(snapshot);
  const withData = [];
  const noData = [];
  const normal = [];

  nodes.forEach(function (n) {
    if (!n || n.status == null) {
      noData.push(n);
      return;
    }
    withData.push(n);
    if (n.status === '正常') normal.push(n);
  });

  return { nodes: nodes, withData: withData, noData: noData, normal: normal };
}

/**
 * 平静时候那一句（core 没点名、也没有重点可言）。
 *
 * 「还没有收到数据」和「都正常」必须分开说 —— 快照刚到、core 还没收到任何
 * 报文的那几秒，那三个宿舍是**不知道**，不是正常。
 *
 * 只有「每个收到的宿舍都是正常、而且一个都没落下」时才说「都正常」。
 * 有宿舍是异常却没人被点名（那些节点离线了，core 的优先排序不排离线的），
 * 这里如实把个数报出来 —— 说成「都正常」是句假话，而看的人看不出来。
 */
export function calmLine(snapshot) {
  const s = survey(snapshot);
  if (s.nodes.length === 0) return '还没有收到 core 的快照';
  if (s.withData.length === 0) return '还没有收到任何节点的数据';
  if (s.noData.length === 0 && s.normal.length === s.withData.length) {
    return '当前 ' + s.nodes.length + ' 个宿舍都正常';
  }

  const parts = ['当前 ' + s.normal.length + ' 个宿舍正常'];
  const abnormal = s.withData.length - s.normal.length;
  if (abnormal > 0) parts.push('另有 ' + abnormal + ' 个异常（离线的节点不参与优先排序）');
  if (s.noData.length > 0) parts.push('另有 ' + s.noData.length + ' 个还没有收到数据');
  return parts.join('，');
}

/**
 * 顶部那条横幅要显示的东西。整块由快照决定，页面一个字都不拼。
 *
 *   {mode, nodeId, status, tag, line, reason, cross}
 *
 *   mode    'focus' | 'priority' | 'calm'
 *   nodeId  横幅说的那个宿舍（calm 时是 null）
 *   status  它此刻的状态（可能为 null：还没收到数据）
 *   tag     左上角那四个字
 *   line    那一行字（三段用 ｜ 分开；calm 时是一句平静话）
 *   reason  **理由**，永远来自快照里 core 写的字
 *   cross   跨端补充说明（只有被点名时才有内容）
 *
 * 【为什么有两个来源】core 的快照里有两个「谁该被看」的字段：
 *   priority —— core 按数据排出来的重点（时长 > 条数 > 严重度 > 名字）
 *   focus    —— 有人从移动端点名看这个宿舍（E3 的跨端联动）
 * 被点名时横幅说的是**点名那个**（那是人的意图，就近），同时**把 core 的理由
 * 一并写出来**（不然「数据说该看 dorm-b」这件事就没人说了）。
 * 两个都没有就是一句平静话 —— 这里的每一串字都指向快照里的某一个字段，
 * 没有任何一个宿舍名是写死的。
 *
 * @param {Object|null} snapshot
 * @returns {{mode: string, nodeId: string|null, status: string|null,
 *            tag: string, line: string, reason: string, cross: string}}
 */
export function focusBanner(snapshot) {
  const focus = snapshot && isObject(snapshot.focus) ? snapshot.focus : null;
  const top = snapshot && isObject(snapshot.priority) ? snapshot.priority : null;

  const focusedId = focus && typeof focus.nodeId === 'string' ? focus.nodeId : '';
  const topId = top && typeof top.nodeId === 'string' ? top.nodeId : '';
  const subject = focusedId || topId;

  if (!subject) {
    return {
      mode: 'calm', nodeId: null, status: null, tag: '',
      line: calmLine(snapshot), reason: '', cross: '',
    };
  }

  const node = nodeOf(snapshot, subject);
  const parts = [subject];

  const handling = handlingOf(snapshot, subject);
  if (handling.label && handling.label !== '无') parts.push(handling.label);

  const trend = trendText(trendOf(node && node.history));
  if (trend) parts.push(trend);

  const topReason = top && typeof top.reason === 'string' ? top.reason.trim() : '';

  /* 理由：说的是重点那个宿舍时，理由就是 core 自己写的那句；
     被点名而它又不是重点时，理由是「谁点的名」。两处都不会是空的
     （core 那边排出来的第一名一定带 reason）。 */
  let reason = topReason;
  if (focusedId && focusedId !== topId) {
    const by = typeof focus.by === 'string' && focus.by ? focus.by : '别的端';
    reason = '跨端焦点：' + by + ' 发来的 focus 指令';
  }

  /* 跨端补充。被点名时才有 —— 没点名的话，「数据选出的重点是 X」这件事
     已经写在 reason 里了，再写一遍就是同一句话说两遍。 */
  let cross = '';
  if (focusedId) {
    if (!topId) {
      cross = '此刻没有需要关注的异常节点';
    } else if (topId === focusedId) {
      cross = '数据选出的重点也是它';
    } else {
      cross = '数据选出的重点是 ' + topId + '：' + topReason;
    }
  }

  return {
    mode: focusedId ? 'focus' : 'priority',
    nodeId: subject,
    status: node && node.status != null ? node.status : null,
    tag: focusedId ? '跨端焦点' : '当前重点',
    line: parts.join('｜'),
    reason: reason,
    cross: cross,
  };
}

/**
 * 语音念的那一句。**只有一句** —— 这是这个出口的约束，不是偷懒：
 * 声音是线性的，说过就过去了，念三段话听的人只记得住最后一句。
 *
 *   「dorm-b 偏热已持续 20 分钟（已按下开始处理，处理中），温度正在下降。」
 *
 * 和 focusBanner 说的是**同一个宿舍**（都按「被点名 > 是重点」这一条挑），
 * 但**不是同一串字**：｜ 是给人扫的，念出来是「竖线」，所以这一句得自成
 * 一句人话。两处各拼一份的风险是「横幅换人了这边还念旧的」—— 那个风险由
 * 「两个出口必须指向同一个人」那条测试挡住。
 *
 * 时长直接用 core 算好的 `durationText`，这边不碰秒数（格式化只留一份）。
 *
 * @param {Object|null} snapshot
 * @returns {string} 以句号收尾的一句话
 */
export function alertLine(snapshot) {
  const focus = snapshot && isObject(snapshot.focus) ? snapshot.focus : null;
  const top = snapshot && isObject(snapshot.priority) ? snapshot.priority : null;
  const focusedId = focus && typeof focus.nodeId === 'string' ? focus.nodeId : '';
  const topId = top && typeof top.nodeId === 'string' ? top.nodeId : '';
  const subject = focusedId || topId;

  if (!subject) return calmLine(snapshot) + '。';

  const node = nodeOf(snapshot, subject);
  const status = node && node.status != null ? node.status : '还没有收到数据';

  let text = subject + ' ' + status;

  /* 只有真的在异常里才有「持续了多久」这回事。正常节点的 durationText 是
     null（core 那侧解释过：说成「不到 1 分钟」是在说一件没发生过的事）。 */
  if (node && typeof node.durationText === 'string' && node.durationText) {
    text += '已持续 ' + node.durationText;
  }

  const handling = handlingOf(snapshot, subject);
  if (handling.label === '处理中') text += '（已按下开始处理，处理中）';
  else if (handling.label === '待处理') text += '（已开案，还没人处理）';

  const trend = trendText(trendOf(node && node.history));
  if (trend) text += '，' + trend;

  return text + '。';
}

/**
 * core 报的「这条事件上登了几张现场快照」（Phase6 E2）。
 *
 * 没有这个字段不是「一张都没拍」，是**这一帧没带这个数**（旧版 core 的快照里
 * 没有它）。两种都按「不提」处理 —— 念一句「0 张」会把这件事的重要性抬到和
 * 温湿度一样，而它显然不是。
 *
 * 数出来的**不是**这边数 `snapshots` 数组的长度：那个数组每个周期都要重发，
 * 所以 core 只报个数（`cameraCount`）。前端要看得细去读 data/events.json。
 *
 * @param {Object|null} event
 * @returns {number}
 */
function cameraCountOf(event) {
  return event && Number.isFinite(event.cameraCount) ? event.cameraCount : 0;
}

/**
 * 语音「朗读状态」念的那两句。
 *
 *   dorm-b 温度 31 摄氏度，湿度 78%，偏热，已持续 20 分钟。事件待处理，已登记 1 张现场快照。
 *
 * 【和 alertLine 的分工】alertLine 是**页面自己**到点念的那一句，说给「没在看
 * 屏幕的人」听，所以它只挑最要紧的那件事说、一个数字都不念。这一句是**有人点名
 * 要听**的时候念的（web 页面那句「朗读状态」），点名的人想听的就是读数本身 ——
 * 所以温湿度这两个数必须念出来，而且是从快照里**原样搬**的，不是这边量的。
 *
 * 【为什么温湿度也要念】「偏热」是 core 那套阈值算出来的结论，只听结论的话，
 * 31℃ 和 39℃ 听起来一模一样。这是唯一一个会念出这两个数字的出口，因为它是
 * 唯一一个**问的人明确想听**的出口。
 *
 * 【和 focusBanner 说的是同一个宿舍】挑谁这一条和 alertLine 完全相同
 * （被点名 > 是重点），三处只能有一份挑法：横幅说 A 而念出来的是 B 的话，
 * 站在旁边听的人看不出哪里不对。
 *
 * 【两句，不是一个长句】温湿度一句、事件一句，中间断开 —— 一口气念完的话，
 * 听的人抓不住哪儿是数字、哪儿是状态。结尾照旧是句号。
 *
 * 【念谁】给了 `nodeId` 就念那一个（web 页面「查看 dorm-b」之后就该念 dorm-b），
 * 不给就按上面那条规矩自己挑。点了名的那个宿舍如果 core 还没收到过数据，
 * 就如实说「还没收到数据」，**不去念别人的读数** —— 那等于把「dorm-b 现在什么
 * 情况」答成了「dorm-a 现在什么情况」，而听的人分不出这个区别。
 *
 * @param {Object|null} snapshot
 * @param {string} [nodeId] 指定念哪一个；不给就自己挑
 * @returns {string} 以句号收尾
 */
export function speakLine(snapshot, nodeId) {
  const focus = snapshot && isObject(snapshot.focus) ? snapshot.focus : null;
  const top = snapshot && isObject(snapshot.priority) ? snapshot.priority : null;
  const focusedId = focus && typeof focus.nodeId === 'string' ? focus.nodeId : '';
  const topId = top && typeof top.nodeId === 'string' ? top.nodeId : '';
  /* 空串 / 全是空白当没传 —— 页面上那个值是从快照里读出来的，读到 undefined
     拼出来就是空串，那不该被当成一个宿舍名。 */
  const asked = typeof nodeId === 'string' ? nodeId.trim() : '';
  const subject = asked || focusedId || topId;

  if (!subject) return calmLine(snapshot) + '。';

  const node = nodeOf(snapshot, subject);
  const status = node && node.status != null ? node.status : '';
  if (!status) {
    return subject + ' 还没有收到数据，core 那边还没有它的读数。';
  }

  const readings = [];
  if (Number.isFinite(node.temperature)) {
    readings.push('温度 ' + node.temperature + ' 摄氏度');
  }
  if (Number.isFinite(node.humidity)) {
    readings.push('湿度 ' + node.humidity + '%');
  }

  let first = subject + ' ' + readings.concat([status]).join('，');
  /* 只有真的在异常里才有「持续了多久」这回事 —— 正常节点的 durationText 是
     null（core 那侧解释过：说成「不到 1 分钟」是在说一件没发生过的事）。 */
  if (typeof node.durationText === 'string' && node.durationText) {
    first += '，已持续 ' + node.durationText;
  }

  const handling = handlingOf(snapshot, subject);
  const second = [];
  if (handling.label === '处理中') {
    second.push('事件处理中');
    if (handling.after > 0) second.push('之后又收到 ' + handling.after + ' 条异常');
  } else if (handling.label === '待处理') {
    second.push('事件待处理，还没有人按开始处理');
  } else {
    /* 没有未结案的事件 —— 这句话是**从快照读出来的**（core 的事件表里这一间
       没有 OPEN / HANDLING 的了），不是这边看 status 猜的。两者可以不一样：
       处理之后连着几条正常、还没到恢复的条数时，状态是「正常」而事件还开着。 */
    second.push('没有未结案的事件');
  }

  const shots = cameraCountOf(handling.event);
  if (shots > 0) second.push('已登记 ' + shots + ' 张现场快照');

  return first + '。' + second.join('，') + '。';
}

/**
 * 消息日志里那一行摘要。看板每隔一会儿就会收到一条快照，把整份报文打到
 * 日志里刷屏没有意义 —— 这一行说的是「这一帧里有什么」。
 *
 * 数出来的数字全部来自快照自己带的 `summary` / `total` / `counters`，
 * 没有一个是这边数出来的：「一共发生过多少条事件」和「面板上摆了几条」
 * 是两个数，前者只能问 core。
 *
 * @param {Object|null} snapshot
 * @returns {string}
 */
export function snapshotSummary(snapshot) {
  if (!snapshot) return '还没有收到快照';

  const nodes = nodeList(snapshot);
  const abnormal = nodes.filter(function (n) {
    return n && n.status != null && n.status !== '正常';
  }).length;

  const block = eventBlock(snapshot);
  const total = Number.isFinite(block.summary.total) ? block.summary.total : 0;
  const open = (Number.isFinite(block.summary.OPEN) ? block.summary.OPEN : 0)
    + (Number.isFinite(block.summary.HANDLING) ? block.summary.HANDLING : 0);
  const top = isObject(snapshot.priority) && typeof snapshot.priority.nodeId === 'string'
    ? snapshot.priority.nodeId : '';
  const focus = isObject(snapshot.focus) && typeof snapshot.focus.nodeId === 'string'
    ? snapshot.focus.nodeId : '';
  const rejects = isObject(snapshot.rejects) && Number.isFinite(snapshot.rejects.total)
    ? snapshot.rejects.total : 0;
  const commands = isObject(snapshot.counters) && Number.isFinite(snapshot.counters.commands)
    ? snapshot.counters.commands : 0;

  const parts = [
    '快照 v' + snapshot.v,
    '宿舍 ' + nodes.length + '（异常 ' + abnormal + '）',
    '重点 ' + (top || '无'),
    '事件 ' + total + '（未结案 ' + open + '）',
    '拒绝 ' + rejects,
    '指令 ' + commands,
  ];
  if (focus) parts.push('焦点 ' + focus);
  return parts.join(' · ');
}

/* ---------- Step 9-3 的进阶项：看板读 report/ml_result.json ---------- */

/* 看板这一侧**不复算** ML、也不重念一遍规则：它只是把 analysis.py 上一次跑完
   写下的那份 JSON 摆到页面上。所以这一段里没有阈值、没有模型、不读 CSV，
   只干一件事 —— 把那份 JSON 说成几句人话。

   为什么不让看板自己判一遍：Isolation Forest 要装 scikit-learn、要读训练数据，
   浏览器里两样都没有。分开跑、结果落成一份文件、看板取过来显示，是这件事
   唯一能落地的做法；代价是那份 JSON 里记的是**上一次跑脚本时**的快照，
   不是实时数据。这个代价必须写在页面上（见下面 note）——
   不然看板上一堆刚收到的数字旁边摆着一段 ML 结论，谁都会以为它判的是
   刚刚那几个读数。

   这里返回的永远是**同样三样东西**，成功也好、读坏了也好、压根读不到也好。
   页面那边因此只有一条渲染路径，不用为「出错了」再写第二套摆放方式；
   返回 null 让调用方去分情况，反而多出一条没人测得住的分支。 */

/** 那份 JSON 里该有的字段缺了时（不是 analysis.py 写的、或者版本对不上）说的话。 */
const ML_BAD_SHAPE =
  '这一段没跑：report/ml_result.json 里没有 analysis.py 该写的字段'
  + '（可能不是它写的，或者版本对不上）。';

/** 只留文件名。那份 JSON 里存的就是文件名（见 analysis.py 的 write_ml_result），
    这里再挡一道，免得哪天有人把本机全路径写进去，页面上就露出一条 C:\... */
function fileName(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '那两份文件';
  return /[\\/]/.test(text) ? text.split(/[\\/]/).pop() : text;
}

/** 条数。写不出来就说「若干」—— 不写 0，0 是「一条都没有」的意思，是另一回事。 */
function rowCount(value) {
  return Number.isFinite(value) ? String(value) : '若干';
}

/**
 * 「Rule-ML」那一段要显示的三样东西：标题旁的条数、结论那句、来源说明。
 *
 *   { count: '规则说正常、ML 说不同：2 条',
 *     text:  '……',                       // 结论那一句
 *     note:  '……' }                      // 判的是哪两份文件、什么时候跑的
 *
 * 【text 一定是从 JSON 里原样搬过来的】不在看板上另写一句结论 ——
 * 报告里那句和这里这句必须是同一串字（analysis.py 那边算一次、渲染两次），
 * 看板自己拼一份就等于埋下第二个说法，两处迟早不一样。
 *
 * @param {*} data report/ml_result.json 解析出来的东西（坏的也认，不抛）
 * @returns {{count: string, text: string, note: string}}
 */
export function buildMlNote(data) {
  const text = data && typeof data.text === 'string' ? data.text.trim() : '';
  const forward = data && Number.isFinite(data.mismatchForward)
    ? data.mismatchForward : null;
  if (!text || forward === null) return { count: '', text: ML_BAD_SHAPE, note: '' };

  /* 两个方向分开报，和报告里那三个数（正向 / 反向 / 合计）是同一个口径：
     合成一个数的话，「规则说正常、ML 说不同」和「规则说异常、ML 说正常」
     会被加在一起，而那两句说的根本不是一回事。 */
  const reverse = Number.isFinite(data.mismatchReverse) ? data.mismatchReverse : 0;
  const parts = [];
  if (forward > 0) parts.push('规则说正常、ML 说不同：' + forward + ' 条');
  if (reverse > 0) parts.push('规则说异常、ML 说正常：' + reverse + ' 条');
  const count = parts.length ? parts.join('；') : '规则和 ML 一条都没差';

  const stamp = data.generatedAt && typeof data.generatedAt === 'string'
    ? data.generatedAt.trim() : '';

  /* 这一句是这一段的地基：它判的是**别的数据**，而且是**上一次**的。
     两件事都得说，少哪一件都会让人把这张表的结论安到看板上刚收到的读数上。 */
  const note = '这一段判的不是看板上这些实时读数，是 ' + fileName(data.newFile)
    + '（' + rowCount(data.newRows) + ' 条）；模型是拿 ' + fileName(data.historyFile)
    + '（' + rowCount(data.historyRows) + ' 条）训练的。它是 '
    + (stamp ? stamp + ' 那次' : '上一次')
    + '跑 analysis.py 留下的，不是实时数据。';

  return { count, text, note };
}

/**
 * 那份 JSON 压根读不到时说的话（404 / 打不开 / 回来不是 JSON）。
 *
 * 和报告里那句「这一段没跑：{原因}」是同一个口径：降级要说清楚**是哪一段**
 * 没跑、为什么，而不是让这块空着或者把整页拖垮。reason 由调用方从异常里取，
 * 这里不翻译也不加工 —— 原样贴出来最有用（「HTTP 404」和「读不到」是两回事，
 * 一个要检查服务器目录，一个要看脚本有没有跑）。
 *
 * @param {string} reason
 * @returns {{count: string, text: string, note: string}}
 */
export function mlFetchFailed(reason) {
  const why = typeof reason === 'string' && reason.trim()
    ? reason.trim() : '不知道什么原因';
  return {
    count: '',
    text: '这一段没跑：读不到 report/ml_result.json —— ' + why,
    note: '先跑一次 py -3.14 analysis/analysis.py，它会把这份文件写在 report/ 下；'
      + '看板其余部分不受影响。',
  };
}

/**
 * 按下「开始处理」之后，按钮旁边那行说明该说什么。
 *
 * 【E3-2 起这一行只回答一件事：指令发出去了没有】以前它还要说「这次处理
 * 只记在页面上」—— 因为那时候页面自己也在记账。现在页面**什么都不记**：
 * 按下去只是往 `dormmate/v1/cmd` 发一条 handle，卡片上那行「处理中」要等
 * core 把新快照发回来才出现。所以发不出去时页面上**一个字都不会变**，
 * 这一行是唯一说得出话的地方。
 *
 * 发出去的那一句特意点明「好没好由 core 后续收到的报文判」：按一下就把事件
 * 判成已恢复是红线，这句话写在最显眼的地方，看的人不必去翻代码。
 *
 * @param {boolean} ok
 * @param {string} [detail] 没发出去时的原因，原样贴出来，不翻译也不加工
 * @returns {string}
 */
export function cmdNote(ok, detail) {
  if (ok) {
    return '已把 handle 指令发给 core —— 好没好由 core 后续收到的报文判，'
      + '这一步不结案。页面上那行「处理中」要等 core 发回新快照才会出现。';
  }
  const why = typeof detail === 'string' && detail.trim()
    ? detail.trim() : '不知道什么原因';
  return '这条指令没发出去（' + why + '）—— 页面不会替 core 记这笔处理，'
    + '所以这一次点击没有任何效果。';
}
