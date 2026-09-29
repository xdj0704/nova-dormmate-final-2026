// dashboard/logic.js
// Step 7-1：优先关注的算法。**纯函数**——不碰 DOM，不读全局变量，不调 Date.now()。
//
// 单独拆一个文件出来，是因为这一整套判断（先比时长、再比次数、最后比名字）
// 是「看一眼就知道该先管哪个宿舍」的全部依据，而它跟页面长什么样毫无关系。
// 拆开之后 tests/logic.test.js 不用打任何桩就能把它整个测一遍 ——
// 留在 dashboard.js 里的话，测它就得起一整套假 DOM。
//
// 它只依赖每个节点上那两个字段，由 dashboard.js 在 handleMessage 里维护：
//   abnormalStart —— 当前这段连续异常里**第一条**消息的 time
//   abnormalCount —— 这段里已经有几条异常消息（0 = 不在异常中）
// 这两个字段怎么变，见本文件里的 nextAbnormal()。
//
// 这里**不判断**什么是异常、什么是正常 —— 那是统一规则的事，只有 shared/rules.js
// 说了算。传进来的 status 已经是 judgeStatus 复核过的结果，这里只负责比较。

/**
 * 统一 JSON 里的时间格式，固定 "YYYY-MM-DD HH:mm:ss"。
 * 故意写死成一个精确的形状、不用宽松匹配：格式一旦不对就该算不出来，
 * 而不是被某条正则「差不多」地认下来，最后得出一个看着挺像样的错时长。
 */
const TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * 把 "YYYY-MM-DD HH:mm:ss" 解析成毫秒数；解析不出来返回 NaN。
 *
 * 不用 new Date(字符串)：
 *   1) "2026-09-22 20:30:00" 是**非标准**格式（ISO 8601 要求中间是 T），
 *      各引擎实现不一致 —— Safari 一类历史上直接给 Invalid Date。
 *      统一 JSON 的格式是定死的，自己按正则解析最稳，也不依赖运行环境。
 *   2) 这里算出来的绝对时刻没有意义，只用来做减法。两端都按 UTC 折算，
 *      时区就自动抵消了 —— 不会因为浏览器在东八区，把 7 分钟算成 7 小时。
 *
 * @param {string} text
 * @returns {number} 毫秒数，或 NaN
 */
export function parseTime(text) {
  const m = TIME_RE.exec(String(text == null ? '' : text));
  if (!m) return NaN;
  /* Date.UTC 的月份是 0 起数的，所以减 1 */
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]));
}

/**
 * 把一段毫秒数说成人话。
 *
 * 取整一律向下：说「5 分钟」的时候，至少要真的过了 5 分钟。
 * 四舍五入会把 4 分 31 秒说成 5 分钟，往长了报 —— 这一栏是让人判断
 * 严重程度的，宁可少说不要多说。
 *
 * @param {number} ms
 * @returns {string} 例如 "不到 1 分钟" / "7 分钟" / "1 小时 5 分钟"
 */
export function fmtDuration(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (total < 60) return '不到 1 分钟';

  const minutes = Math.floor(total / 60);
  if (minutes < 60) return minutes + ' 分钟';

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? hours + ' 小时' : hours + ' 小时 ' + rest + ' 分钟';
}

/**
 * 这个节点当前这段连续异常持续了多久（毫秒）。
 *
 * 两端都取报文里的 time，不用浏览器当前时间 —— 现场演示时三台机器的钟
 * 不一定对得上，而且历史数据的 time 也可能是编的。「20:00 到 20:07」
 * 就永远是 7 分钟，跟什么时候跑的没关系，测试也才能写出定值。
 *
 * @param {{abnormalStart: string|null, latest: {time: string}|null}} node
 * @returns {number} 毫秒数；算不出来（缺字段、格式不对、起点晚于终点）返回 0
 */
export function abnormalDuration(node) {
  if (!node || !node.latest) return 0;

  const start = parseTime(node.abnormalStart);
  const end = parseTime(node.latest.time);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;

  /* 起点比终点还晚（脏数据、或手输的 time 前后颠倒）当 0 处理，不返回负数 ——
     负数一路传到页面上就是「已连续偏热 -3 分钟」。 */
  return end > start ? end - start : 0;
}

/**
 * 维护「当前这段连续异常」的状态机。纯函数：给旧的两个字段和一条新消息，
 * 返回新的两个字段，不修改传进来的东西。
 *
 * 规则只有两条：
 *   - 这条是正常 -> 这段结束，两个字段一起清零
 *   - 这条还是异常 -> 段继续，条数加一；**起点不动**
 *
 * 特别注意「起点不动」：段内状态从偏冷变成偏热，不算新的一段。
 * 这里统计的是「连续异常了多久」，不是「连续偏热了多久」。
 *
 * @param {{abnormalStart: string|null, abnormalCount: number}} prev
 * @param {string} status 这条消息**复核之后**的状态（正常 / 偏冷 / 偏热 / 偏湿）
 * @param {string} time   这条消息的 time
 * @returns {{abnormalStart: string|null, abnormalCount: number}}
 */
export function nextAbnormal(prev, status, time) {
  const count = prev && Number.isFinite(prev.abnormalCount) && prev.abnormalCount > 0
    ? prev.abnormalCount : 0;

  if (status === '正常') return { abnormalStart: null, abnormalCount: 0 };

  /* 上一段已经结束了（或压根还没开始）—— 这条就是新一段的第一条，起点是它自己。
     判断「上一段还在不在」只看 abnormalCount 这一个字段。
     换成看 abnormalStart 空不空，就多出第二个真相来源：两个字段一旦对不上
     （比如 time 传了空串），起点会被后来每条消息顶掉，界面上的时长永远停在
     「不到 1 分钟」，而且不会有任何地方报错。 */
  if (count === 0) return { abnormalStart: time, abnormalCount: 1 };

  return { abnormalStart: prev.abnormalStart, abnormalCount: count + 1 };
}

/* ---------- Step 7-2：处理动作 ---------- */

/**
 * 按下那个按钮之后，节点上 action 字段记的名字。
 *
 * 单独拎成一个常量，是因为这串字会**原样出现在卡片上**（「处理中｜风扇已开启」），
 * 测试断言的也是这一串。写死两处的话，改了这边忘了那边，
 * 页面上就会显示一个谁也发现不了的错名字。
 */
const ACTION_FAN = '风扇已开启';

/**
 * 按下「开启风扇 / 通风」之后，这个节点的处理字段该变成什么。
 *
 * 纯函数：只读传进来的节点，返回新的那几个字段，不改任何东西。
 * 返回 null = 这个节点现在处理不了 —— 它连一条数据都没收到过，
 * actionTime 根本没地方取。界面上那个按钮这时本来就是禁用的，这里是兜底。
 *
 * actionTime 取**该节点最新那条消息的 time**，不用浏览器当前时间。
 * 和 7-1 算时长同一个理由：现场三台机器的钟不一定对得上；而且这样
 * 「动作发生在哪条数据之后」在日志和卡片上能一条条对上，不用猜。
 *
 * @param {{latest: {time: string}|null}} node
 * @returns {{handling: string, action: string, actionTime: string,
 *            dataAfterAction: null}|null}
 */
export function beginHandling(node) {
  if (!node || !node.latest) return null;
  return {
    handling: '处理中',
    action: ACTION_FAN,
    actionTime: node.latest.time,
    /* 还没有「动作之后的数据」，等它来 —— 见 nextHandling */
    dataAfterAction: null,
  };
}

/**
 * 动作之后又来了一条消息，处理状态该怎么走。
 *
 * 规则只有一条：**看动作之后的最新那条**。
 *   这条（复核之后的）正常 -> 「已恢复」
 *   这条还是异常           -> 留在「处理中」
 * 环境再变坏就自动退回「处理中」—— 同一条规则，不用另写一条判断。
 *
 * actionTime 那条**自己不算数**（要严格晚于它）：动作就是记在那条数据上的，
 * 让它立刻把自己判成「已恢复」是错的。
 *
 * 返回 null = 什么都不用改：还没按过按钮、时间解析不出来、或者这条消息
 * 比动作还早（乱序到达，或者重发了一条旧的）。这时候保持原样，
 * 让一条迟到的旧数据改写「处理好了没有」是不对的。
 *
 * @param {{handling: string, actionTime: string|null}} node
 * @param {{status: string, time: string}} record 复核**之后**的那条记录
 * @returns {{handling: string, dataAfterAction: object}|null}
 */
export function nextHandling(node, record) {
  if (!node || !record) return null;
  if (node.handling !== '处理中' && node.handling !== '已恢复') return null;

  const at = parseTime(node.actionTime);
  const t = parseTime(record.time);
  if (Number.isNaN(at) || Number.isNaN(t)) return null;
  if (!(t > at)) return null;

  return {
    handling: record.status === '正常' ? '已恢复' : '处理中',
    dataAfterAction: record,
  };
}

/* ---------- Step 7-4：事件记录 ---------- */

/**
 * 一条事件。字段就是导出 CSV 的那 9 列，顺序也一致
 * （见 dashboard.js 的 EVENT_HEADER）：
 *
 *   nodeId         哪个宿舍
 *   startTime      这段连续异常是从哪条消息开始的
 *   problem        「连续偏热」这一串，**创建时定死**（见下）
 *   priorityTime   第一次被选为「优先关注」的那一刻，没有就是 null
 *   priorityReason 那次选它的原因原话，和页面上那条栏里说的是同一句
 *   action         按过按钮之后做了什么（「风扇已开启」）
 *   actionTime     那个动作记在哪条数据上
 *   recoverTime    这段结束的那条消息的 time，没有就是 null
 *   result         '已恢复'，或者空串表示还没结束
 *
 * 这一整条记录的是**一段连续异常**，和 nextAbnormal 维护的那一段同生共死：
 * 段开始就开一条，段结束（来了一条正常数据）就结案。中途不会另开一条，
 * 哪怕段里状态从偏热变成了偏湿 —— 和 7-1 那边「统计的是连续异常、
 * 不是连续偏热」是同一个口径。
 */

/**
 * 段开始了：开一条新事件。
 *
 * problem 取**开始那一刻**的状态，之后不再改。理由：它是这条事件的名字，
 * 在复盘的时间线里就摆在 startTime 旁边，说的是「这件事是从什么开始的」。
 * 跟着最新状态改的话，一段从偏热恶化成偏湿的经历，事后看起来像是从头
 * 就是偏湿的 —— 那是另一件事了。
 *
 * 返回 null = 不该开：没有这条记录，或者它本身是「正常」。
 * 后面这条在页面里不会发生（段开始的前提就是这条不正常），
 * 写在这里是为了不让一个「连续正常」这种自相矛盾的名字有机会被造出来。
 *
 * @param {{nodeId: string, status: string, time: string}} record 复核之后的记录
 * @returns {Object|null}
 */
export function beginEvent(record) {
  if (!record || record.status === '正常') return null;
  return {
    nodeId: record.nodeId,
    startTime: record.time,
    problem: '连续' + record.status,
    priorityTime: null,
    priorityReason: null,
    action: null,
    actionTime: null,
    recoverTime: null,
    result: '',
  };
}

/**
 * 这个节点被选成「优先关注」了，把那一刻记到事件上。
 *
 * **只记第一次**：之后再被选中也不覆盖。复盘想回答的是「这个宿舍是什么
 * 时候被注意到的、当时是因为什么」，而不是「最后一次看它时长什么样」。
 * 后者在页面顶上那条栏里一直是最新的，不必再存一份。
 *
 * 返回 null = 不用改：没有事件、没有时间，或者早就记过了。
 *
 * @param {Object|null} event
 * @param {string} time 判定它胜出时，**它自己**最新那条消息的 time
 * @param {string} reason 和页面上那条栏里显示的原因原话
 * @returns {{priorityTime: string, priorityReason: string}|null}
 */
export function markPriority(event, time, reason) {
  if (!event || !time) return null;
  if (event.priorityTime) return null;
  return {
    priorityTime: time,
    priorityReason: reason == null ? '' : String(reason),
  };
}

/**
 * 有人在处理这段异常期间按了「开启风扇 / 通风」，把动作记到事件上。
 *
 * 同样**只记第一次**。按第二次时 actionTime 会往前挪（按钮那会儿是可点的），
 * 但复盘要看的是「这件事第一次被动手是什么时候、做了什么」——
 * 第二次按的是同一件事的重复，不该把第一次的功劳盖掉。
 *
 * 返回 null = 不用改：没有事件、没有动作名/时间，或者已经记过了。
 *
 * @param {Object|null} event
 * @param {string} action 动作名（就是按钮按下之后卡片上显示的那串）
 * @param {string} time 动作记在哪条数据上
 * @returns {{action: string, actionTime: string}|null}
 */
export function markAction(event, action, time) {
  if (!event || !action || !time) return null;
  if (event.action) return null;
  return { action: action, actionTime: time };
}

/**
 * 段结束了：结案。
 *
 * 触发条件是 nextAbnormal 把 abnormalCount 清零（也就是来了一条正常数据），
 * 所以这里不做时间比较 —— 该不该结案是那一步说了算的，这边只负责写下来。
 * （代价和页面上其它地方一样：一条迟到的正常数据同样会把它结掉，
 * 见 README「报文没有乱序保护」那一条。）
 *
 * result 只有一个终态：'已恢复'。没结案的才是空串，两者不会混。
 *
 * 返回 null = 不用改：没有事件、没有时间，或者已经结过案了。
 *
 * @param {Object|null} event
 * @param {string} time 让它恢复正常的那条消息的 time
 * @returns {{recoverTime: string, result: string}|null}
 */
export function closeEvent(event, time) {
  if (!event || !time) return null;
  if (event.recoverTime) return null;
  return { recoverTime: time, result: '已恢复' };
}

/**
 * 拼一句人话，说清楚为什么是它。
 *
 * 尾巴必须如实说明**赢在哪一步**。一律写「持续时间最长」是不行的：
 * 时长打平、靠次数赢的那次，说它「持续时间最长」就是假话，而这一栏
 * 存在的意义正是让人相信这个排序。
 */
function reasonFor(winner, list) {
  const head = winner.nodeId + ' 已连续' + winner.status + ' '
    + fmtDuration(winner.duration) + '（' + winner.count + ' 次）';

  /* 只有一个异常节点时，下面那三步一步都没比过。写「持续时间最长」
     是在说一件没发生过的事。 */
  if (list.length === 1) return head + '，是目前唯一的异常节点';

  /* 排序保证 others[0] 就是除它以外最靠前的那个 */
  const others = list.slice(1);
  /* 跟它一样长的那些。为空 = 它就是最长的，赢在时长这一步。 */
  const tied = others.filter(function (o) { return o.duration === winner.duration; });

  if (tied.length === 0) return head + '，持续时间最长';

  /* 只跟**时长相同**的那些比次数。跟所有人比是错的：一个只异常了一分钟
     但有 99 条消息的节点，次数比谁都多，却根本没进到比次数这一步。 */
  if (winner.count > tied[0].count) {
    return head + '，持续时间和 ' + tied[0].nodeId + ' 一样长，异常次数最多';
  }

  return head + '，和 ' + tied[0].nodeId + ' 完全并列，按节点名顺序排在前面';
}

/**
 * 从三个节点里挑出最该先看的那一个。
 *
 * 只在异常节点里挑。「异常」的判据就是 abnormalCount > 0 这一个字段 ——
 * 它是 nextAbnormal 维护的，在这里再按 latest.status 复核一遍只会多出一个
 * 可能跟它打架的判据。这两个字段的对应关系由 dashboard 那边的测试钉住。
 *
 * 比较顺序是固定的三步：
 *   1) 连续异常时长，长的优先
 *   2) 时长一样，比这段里的消息条数，多的优先
 *   3) 还一样，按 nodeId 字母顺序
 * 第 3 步不是为了「更准」，是为了**确定**：同样一份数据永远得到同一个结果，
 * 不会因为对象键的遍历顺序变了就换了个人。
 *
 * @param {Object} nodes 形如 { 'dorm-a': { latest, abnormalStart, abnormalCount }, ... }
 * @returns {{nodeId: string, reason: string}|null} 全部正常时返回 null
 */
export function pickPriority(nodes) {
  const list = [];

  Object.keys(nodes || {}).forEach(function (nodeId) {
    const node = nodes[nodeId];
    if (!node || !node.latest) return;
    /* 用 > 0 而不是 !== 0：abnormalCount 是 NaN 或负数时，同样按「不在异常中」处理 */
    if (!(node.abnormalCount > 0)) return;

    list.push({
      nodeId: nodeId,
      status: node.latest.status,
      count: node.abnormalCount,
      duration: abnormalDuration(node),
    });
  });

  if (list.length === 0) return null;

  list.sort(function (a, b) {
    if (a.duration !== b.duration) return b.duration - a.duration;
    if (a.count !== b.count) return b.count - a.count;
    if (a.nodeId === b.nodeId) return 0;
    /* 不用 localeCompare：它跟着运行环境的区域设置走，同一个数组在不同机器上
       可能排出不同结果。这里要的是固定的字典序。 */
    return a.nodeId < b.nodeId ? -1 : 1;
  });

  return { nodeId: list[0].nodeId, reason: reasonFor(list[0], list) };
}
