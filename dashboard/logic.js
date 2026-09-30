// dashboard/logic.js
// 看板的判断逻辑：7-1 优先关注、7-2 处理动作、7-4 事件记录、8-1 总览与依据、
// 8-3 当前重点一行 + 语音提醒那句话。
// **纯函数**——不碰 DOM，不读全局变量，不调 Date.now()。
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

/* ---------- 优先关注 ---------- */

/**
 * 严重度权重：数字越大越该先看。
 *
 * 这一档只在「连续异常时长和异常条数都打平」时才轮得到 —— 出现得很少，
 * 但前两步分不出胜负时，总得有个确定的说法，不能看谁先被遍历到。
 *
 * 取值不是随手定的，跟 `web/style.css` 里那四档状态色的角色是同一个意思：
 *   偏热 = critical / 偏湿 = serious / 偏冷 = warning / 正常 = good
 * 「正常」给 0 只是一个占位：它压根不会进这个排序（见 ranked）。
 *
 * ⚠ 这份表和 Python 侧 `rules.py` 的 SEVERITY_WEIGHTS 是同一套东西，
 * 而且 `core/config.json` 里还能改。两边的**行为**由
 * `tests/fixtures/priority_cases.json` 钉住 —— 那份文件 Python 和 Node
 * 各读一遍、逐条对上才算过。改了这里，那份 json 和 rules.py 要一起改。
 */
const SEVERITY = { '偏热': 3, '偏湿': 2, '偏冷': 1, '正常': 0 };

/**
 * 查一个状态的严重度。不认识的状态当 0：不猜、也不炸 ——
 * 状态是从报文里读来的，宁可排在后面，也不要让整个页面停摆。
 */
function severityOf(status) {
  return SEVERITY[status] || 0;
}

/**
 * 把「当前在异常中的节点」按那四步排好序，交给调用方。
 *
 * 抽出来是因为有四个地方要用这份排序：pickPriority（对外那一份）、
 * B1 总览里那句「是当前重点」（8-3 之后归 report.html）、B2 依据（同上）、
 * 以及 8-3 的 buildAlert。各写一份的话，「谁是重点」就有了四个出处 ——
 * 而且四份都「看着挺对」，对不上的时候没有任何地方会报错，
 * 只是页面上那一行说的是 dorm-b、语音念的是 dorm-c。
 *
 * 排序的四步和判据见 pickPriority 的注释。
 *
 * @param {Object} nodes
 * @returns {Array<{nodeId: string, status: string, count: number, duration: number, severity: number}>}
 *          全是异常节点，最该先看的排在第一个；都在正常时是空数组
 */
function ranked(nodes) {
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
      severity: severityOf(node.latest.status),
    });
  });

  list.sort(function (a, b) {
    if (a.duration !== b.duration) return b.duration - a.duration;
    if (a.count !== b.count) return b.count - a.count;
    if (a.severity !== b.severity) return b.severity - a.severity;
    if (a.nodeId === b.nodeId) return 0;
    /* 不用 localeCompare：它跟着运行环境的区域设置走，同一个数组在不同机器上
       可能排出不同结果。这里要的是固定的字典序。 */
    return a.nodeId < b.nodeId ? -1 : 1;
  });

  return list;
}

/**
 * 拼出「凭什么」那半句 —— 不含节点名。
 *
 * 不含节点名是因为有两个地方要它，而那两处节点名的位置不一样：
 * pickPriority 的 reason 是「dorm-b 已连续偏热 20 分钟（4 次），持续时间最长」
 * （reasonFor 在前面补上节点名），B2 的依据写
 * 「优先关注 dorm-b：已连续偏热 20 分钟（4 次），持续时间最长」
 * —— 节点名在「优先关注 …：」那里已经说过了，再说一遍就成了
 * 「优先关注 dorm-b：dorm-b 已连续…」。各拼一份的话，两处对「赢在哪一步」
 * 的说法迟早会不一样，而这一栏存在的意义正是让人相信这个排序。
 *
 * 尾巴必须如实说明**赢在哪一步**。一律写「持续时间最长」是不行的：
 * 时长打平、靠次数赢的那次，说它「持续时间最长」就是假话。
 */
function basisFor(winner, list) {
  const head = '已连续' + winner.status + ' '
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

  /* 再只跟**时长和次数都一样**的那些比严重度。同样不能跟所有人比 ——
     条数比它多的那些压根没走到这一步。 */
  const same = tied.filter(function (o) { return o.count === winner.count; });
  if (same.length > 0 && winner.severity > same[0].severity) {
    return head + '，持续时间和 ' + same[0].nodeId + ' 一样长、异常次数也一样，'
      + '但' + winner.status + '比' + same[0].status + '更要紧';
  }

  /* 四步全平。这里已经是最后的兜底，写的就是实话。 */
  const peer = same.length > 0 ? same[0].nodeId : tied[0].nodeId;
  return head + '，和 ' + peer + ' 完全并列，按节点名顺序排在前面';
}

/**
 * 顶上那条「优先关注」栏用的一整句 —— 比 basisFor 多一个开头的节点名。
 */
function reasonFor(winner, list) {
  return winner.nodeId + ' ' + basisFor(winner, list);
}

/**
 * 从三个节点里挑出最该先看的那一个。
 *
 * 只在异常节点里挑。「异常」的判据就是 abnormalCount > 0 这一个字段 ——
 * 它是 nextAbnormal 维护的，在这里再按 latest.status 复核一遍只会多出一个
 * 可能跟它打架的判据。这两个字段的对应关系由 dashboard 那边的测试钉住。
 *
 * 比较顺序是固定的四步：
 *   1) 连续异常时长，长的优先
 *   2) 时长一样，比这段里的消息条数，多的优先
 *   3) 还一样，比严重度：偏热 > 偏湿 > 偏冷（见上面的 SEVERITY）
 *   4) 全部并列，按 nodeId 字母顺序
 * 第 4 步不是为了「更准」，是为了**确定**：同样一份数据永远得到同一个结果，
 * 不会因为对象键的遍历顺序变了就换了个人。
 *
 * @param {Object} nodes 形如 { 'dorm-a': { latest, abnormalStart, abnormalCount }, ... }
 * @returns {{nodeId: string, reason: string}|null} 全部正常时返回 null
 */
export function pickPriority(nodes) {
  const list = ranked(nodes);
  if (list.length === 0) return null;

  return { nodeId: list[0].nodeId, reason: reasonFor(list[0], list) };
}

/* ---------- Step 8-1：B1 当前总览 + B2 判断依据 ---------- */

/* 这两句都是**现算**的，一个字都不缓存：每收到一条报文，时长、次数、
   状态都可能变，缓存下来的话，页面上就会出现一句「dorm-b 已持续偏热
   5 分钟」挂在那里不再动 —— 而下面的卡片和栏里的数字一直在涨。
   它们也**不读浏览器当前时间**，理由和 7-1 算时长完全一样。 */

/**
 * 数一遍三个节点现在各是什么情况。
 *
 * 这里按 `latest.status` 数，不按 `abnormalCount > 0` 数 —— 两处口径
 * 本来应当一致（由 dashboard 那边的测试钉住），但「需要关注」这四个字
 * 是对着**卡片上那个状态徽章**说的，所以分母就用徽章读的那个字段：
 * 看的人一抬头就能对上，不用先知道还有另一套计数。
 *
 * @param {Object} nodes
 * @returns {{ids: string[], withData: string[], noData: string[],
 *            normal: string[], abnormal: string[]}}
 */
function survey(nodes) {
  const ids = Object.keys(nodes || {});
  const withData = [];
  const noData = [];

  ids.forEach(function (nodeId) {
    const node = nodes[nodeId];
    if (node && node.latest) withData.push(nodeId);
    else noData.push(nodeId);
  });

  return {
    ids: ids,
    withData: withData,
    noData: noData,
    normal: withData.filter(function (id) { return nodes[id].latest.status === '正常'; }),
    abnormal: withData.filter(function (id) { return nodes[id].latest.status !== '正常'; }),
  };
}

/**
 * 一个节点正在被处理时，跟在句子后面的那个括号。
 *
 * **处理状态不参与排序**，一个节点的「处理中」既不会让它更容易被选中，
 * 也不会让它落选（pickPriority 连这个字段都不读）。这里只是把当前状态
 * 如实报出来 —— 所以它写成一个括号，不写成「因为…所以…」。
 * 写成「虽然已经开了风扇，但还是先管 dorm-b」那种因果句就是在编：
 * 真要按「有没有人管」排，那是另一套规则，得先定下来。
 *
 * 状态已经正常的不写这个括号：那说明风扇是按在旧数据上、之后来的
 * 那条正常数据比动作还早（见 nextHandling），此时「处理中」没有任何意义。
 *
 * @param {Object} node
 * @returns {string} 例如 '（风扇已开启，处理中）'，不需要时是空串
 */
function handlingNote(node) {
  if (!node || !node.latest || node.latest.status === '正常') return '';
  if (node.handling !== '处理中') return '';
  return '（' + (node.action ? node.action + '，' : '') + '处理中）';
}

/**
 * B1：一句说清三个宿舍现在什么样。
 *
 *   「当前 3 个宿舍中，1 个正常，2 个需要关注；dorm-b 已持续偏热 20 分钟，
 *     是当前重点；dorm-c 出现偏湿。」
 *
 * 四段：有多少 / 谁最要紧 / 还有谁不正常。除了重点之外的异常节点只报
 * 「谁还异常、异常成什么样」，为什么先不它们是 B2 的事 —— 两句都做对比的话，
 * 摆在一起读就是车轱辘话。
 *
 * 数字、节点名、状态一个都没写死：宿舍数取自 nodes 的键，正常/需要关注
 * 是按当前状态数出来的，重点来自 ranked()，时长来自 fmtDuration()。
 * 换个宿舍数、换成四个节点，同一份代码说的还是实话。
 *
 * 「还没有收到数据」的节点单独说，不算进「正常」里 —— 页面刚打开那几秒
 * 那三个节点是**不知道**，不是正常。这一点和 8-3 的 calmLine 是同一个口径。
 *
 * @param {Object} nodes
 * @returns {string}
 */
export function buildOverview(nodes) {
  const s = survey(nodes);
  const total = s.ids.length;

  if (s.withData.length === 0) return '还没有收到任何节点的数据。';

  /* 都在正常。没收到数据的那些要单独说 —— 「3 个宿舍都正常」在只收到
     2 条消息时是句假话，第 3 个是不知道。 */
  if (s.abnormal.length === 0) {
    return s.noData.length === 0
      ? '当前 ' + total + ' 个宿舍都正常。'
      : '当前 ' + total + ' 个宿舍中，' + s.normal.length + ' 个正常，另有 '
        + s.noData.length + ' 个还没有收到数据。';
  }

  /* 三个数字（正常 / 需要关注 / 没数据）加起来正好是宿舍数 —— 挪走一个
     都会让这句话自相矛盾。**为 0 的那一档不写**：「0 个正常」是一句
     又长又没信息的话，而且和上面「都正常时不写 0 个需要关注」是同一个口径。

     三个都不正常时，前两档一起塌成「3 个需要关注」，读起来反而更顺。 */
  const bits = [];
  if (s.normal.length > 0) bits.push(s.normal.length + ' 个正常');
  bits.push(s.abnormal.length + ' 个需要关注');
  if (s.noData.length > 0) bits.push('另有 ' + s.noData.length + ' 个还没有收到数据');

  const head = '当前 ' + total + ' 个宿舍中，' + bits.join('，');

  const list = ranked(nodes);
  /* 到不了：abnormal 非空时 ranked 也非空。留着是为了不让一个 undefined
     的 top 把整句拼成「undefined 已持续…」——那还不如少说一句。 */
  if (list.length === 0) return head + '。';

  const top = list[0];
  const others = list.slice(1).map(function (o) { return o.nodeId + ' 出现' + o.status; });

  return head + '；' + top.nodeId + ' 已持续' + top.status + ' '
    + fmtDuration(top.duration) + '，是当前重点' + handlingNote(nodes[top.nodeId])
    + (others.length > 0 ? '；' + others.join('、') : '')
    + '。';
}

/**
 * 一个落后于重点的异常节点，为什么排在后面。
 *
 * 尾巴同样要如实说**输在哪一步**：挨个字比过去、该第几步倒下就写第几步。
 * 一律写「但只持续 X 分钟」是错的 —— 时长打平、靠次数赢的那一轮，
 * 那个节点根本没有「只持续」这回事，这么写会让看的人以为排序是乱的。
 *
 * @param {{nodeId: string, status: string, count: number, duration: number}} other
 * @param {{duration: number, count: number}} top
 * @returns {string} 例如 '虽然偏湿，但只持续 5 分钟'
 */
function lostTo(other, top) {
  if (other.duration < top.duration) {
    return '虽然' + other.status + '，但只持续 ' + fmtDuration(other.duration);
  }
  if (other.count < top.count) {
    return '也' + other.status + '，持续时间和它一样长，但只有 ' + other.count + ' 条异常数据';
  }
  /* 严重度比的是**已经算好的 severity**，不是拿 status 现查一遍 ——
     权重表只有一份，现查等于给「判谁优先」和「说为什么」各留了一个出处。 */
  if (other.severity < top.severity) {
    return '也' + other.status + '，时长和次数都跟它一样，'
      + '但' + other.status + '没有' + top.status + '要紧';
  }
  return '也' + other.status + '，时长和次数都跟它一样，按节点名顺序排在后面';
}

/**
 * B2：说清为什么是它，别人为什么不是。
 *
 *   「优先关注 dorm-b：已连续偏热 20 分钟（4 次），持续时间最长；
 *     dorm-c 虽然偏湿，但只持续 5 分钟；dorm-a 当前正常。」
 *
 * 开头那半句直接复用 basisFor —— 和顶上那条栏里显示的是同一份文字，
 * 连「赢在哪一步」的说法都逐字相同。两处对不上的话，看的人第一反应
 * 是「到底哪个算数」。
 *
 * 其余节点分两拨：**还在异常的**用对比的说法（它们是输给了重点的那些，
 * 排在重点后面），**正常和没收到数据的**直说各自现在什么样、不比较 ——
 * 拿一个正常的节点去跟重点比「谁更久」是没有意义的。
 *
 * @param {Object} nodes
 * @returns {string}
 */
export function buildReasons(nodes) {
  const s = survey(nodes);

  if (s.withData.length === 0) return '还没有收到任何节点的数据，说不出依据。';

  const list = ranked(nodes);

  if (list.length === 0) {
    /* abnormal 非空却挑不出人，只可能是 abnormalCount 和 status 打架了
       （那个不变量由 dashboard 那边的测试钉住）。这时候照实说，不装作没事。 */
    if (s.abnormal.length > 0) return '当前有异常节点，但还算不出优先关注的是谁。';

    return s.noData.length === 0
      ? '当前 ' + s.ids.length + ' 个宿舍都正常，没有要优先处理的宿舍。'
      : '当前 ' + s.normal.length + ' 个宿舍正常，另有 ' + s.noData.length
        + ' 个还没有收到数据，没有要优先处理的宿舍。';
  }

  const top = list[0];
  const parts = ['优先关注 ' + top.nodeId + '：' + basisFor(top, list)
    + handlingNote(nodes[top.nodeId])];

  /* 重点自己不再重复一遍 */
  const shown = {};
  shown[top.nodeId] = true;

  list.slice(1).forEach(function (o) {
    shown[o.nodeId] = true;
    parts.push(o.nodeId + ' ' + lostTo(o, top) + handlingNote(nodes[o.nodeId]));
  });

  /* 剩下的（正常 / 没收到数据）按 nodes 的键顺序说。到这一步还没被说过的，
     只可能是这两类 —— 异常的那些在上面那一拨里已经全说完了。 */
  s.ids.forEach(function (nodeId) {
    if (shown[nodeId]) return;
    const node = nodes[nodeId] || {};
    parts.push(nodeId + (node.latest ? ' 当前' + node.latest.status : ' 还没有收到数据'));
  });

  return parts.join('；') + '。';
}

/* ---------- Step 8-3：B4 当前重点一行 ---------- */

/* 这一步是**信息分工**，不是又加一块内容：页面上原来有三处在说「谁是重点」
   （7-1 那条栏、B1 总览、B2 依据），它们说的是同一件事，只是详略不同。
   8-3 把它们并成看板顶部的一行，剩下的细节分给另外三个出口：

     看板顶部 这一行        —— 谁、在不在处理、往哪走（扫一眼就够）
     3D 场景               —— 哪个空间、风扇转没转、窗开没开（不堆文字）
     语音提醒              —— 把同一件事念成一句人话
     report.html           —— 开始 / 处理 / 恢复 / 持续了多久，完整的账

   分工的判据是「这个出口**擅长**什么」：一行字只适合扫，不适合交代来龙去脉；
   3D 天生适合表达空间和动作，不适合放文字；声音只能一句一句听，不能回头翻；
   报告可以慢，所以该它承担完整记录。

   下面两个函数都从 pickPriority 出发 —— 「谁是重点」仍然只有一份实现。
   这一点必须守住：这一行和语音念的是同一件事，两处对不上的话，
   看的人第一反应是「到底哪个算数」。 */

/**
 * 「温度在往哪走」—— 拿这个节点最近两条记录比一比。
 *
 * 只比温度、只看最近两条，是这一步定下的口径。不做滑动平均、不看更早的趋势：
 * 这里要回答的是「刚发生的变化」，而不是「这一段的走势」—— 后者是趋势图的事。
 *
 * 三种结果：'上升' / '下降' / '持平'。
 *
 * 只有一条记录时返回**空串**，不是 '持平'。这两件事不一样：一条数据说不出
 * 「在往哪走」，说成「持平」就是把「不知道」说成了「没变」—— 和 B1 那边
 * 「还没有收到数据 ≠ 正常」是同一条原则。
 *
 * 比的是**精确值**，不设容差。设一个「小于 0.5 ℃ 算没变」的阈值需要先定下来
 * 多少算没变，那是另一套规则，这一步不定；而且真实数据里 24.9 → 25.0
 * 确实就是在上升。
 *
 * @param {{history: Array<{temperature: number}>}} node
 * @returns {'上升'|'下降'|'持平'|''}
 */
export function tempTrend(node) {
  const history = node && node.history;
  if (!Array.isArray(history) || history.length < 2) return '';

  const now = history[history.length - 1];
  const before = history[history.length - 2];
  if (!now || !before) return '';

  /* Number.isFinite 顺手把 NaN / Infinity / 字符串 / undefined 一起挡掉。
     报文在 handleMessage 里已经校验过一次，这里是纯函数的自保。 */
  const a = before.temperature;
  const b = now.temperature;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';

  if (b > a) return '上升';
  if (b < a) return '下降';
  return '持平';
}

/**
 * 趋势那一段的说法。
 *
 * 「温度正在持平」不成话，所以持平单独一句。**不写成「温度不变」** ——
 * 同一个意思在两个出口（这一行和语音）里各写各的，迟早会不一样。
 */
function trendText(trend) {
  if (!trend) return '';
  if (trend === '持平') return '温度持平';
  return '温度正在' + trend;
}

/**
 * 平静时候那一行（没有重点可言）。
 *
 * 「还没有收到数据」和「都正常」必须分开说 —— 页面刚打开那几秒，
 * 那三个宿舍是**不知道**，不是正常。这一条和 B1 总览是同一个口径。
 *
 * 有节点还没收到数据时不说「都正常」，而是把两个数都报出来 ——
 * 「当前 3 个宿舍都正常」在只收到 2 条消息时是句假话。
 */
function calmLine(nodes) {
  const s = survey(nodes);
  if (s.withData.length === 0) return '还没有收到任何节点的数据';
  if (s.noData.length === 0) return '当前 ' + s.ids.length + ' 个宿舍都正常';
  return '当前 ' + s.normal.length + ' 个宿舍正常，另有 ' + s.noData.length
    + ' 个还没有收到数据';
}

/**
 * B4 那一行：谁、在不在处理、温度往哪走。
 *
 *   「dorm-b｜处理中｜温度正在下降」
 *
 * 三段用 ｜ 分开，**没有内容的那段整个不出现**（不写空串、不留两个连着的 ｜）：
 *   - 没按过按钮 -> 没有「处理中」这段
 *   - 只收到一条数据 -> 没有趋势这段（说不出「往哪走」，见 tempTrend）
 * 全都拼不出来时只剩宿舍名，那也是实话 —— 数据里没有的东西不编。
 *
 * 【这一行里没有状态（偏热/偏湿）】这是有意的，也是分工的结果：
 * 状态由**卡片上那个徽章**（颜色 + 图标 + 文字三重编码）、3D 场景（地板颜色、
 * 窗户开合）、语音那句一起承担。一行字里塞四样东西，就又变回 8-1 那种
 * 「两句话交代所有事」，那正是这一步要拆掉的。
 * 想加回来的话，就在 parts 里插一个 top.status —— 改动只有一行。
 *
 * 【「处理中」只写这三个字，不写「风扇已开启」】开了什么是**空间动作**，
 * 3D 里风扇转着比一行字直观得多 —— 那正是 3D 该承担的部分。
 *
 * @param {Object} nodes
 * @returns {string} 一个宿舍名；平静时是一句没有重点的话
 */
export function buildFocus(nodes) {
  const pick = pickPriority(nodes);
  if (!pick) return calmLine(nodes);

  const node = nodes[pick.nodeId] || {};
  const parts = [pick.nodeId];

  if (node.handling && node.handling !== '无') parts.push(String(node.handling));

  const trend = trendText(tempTrend(node));
  if (trend) parts.push(trend);

  return parts.join('｜');
}

/**
 * 语音念的那一句。**只有一句** —— 这是这个出口的约束，不是偷懒：
 * 声音是线性的，说过就过去了，没人能回头翻。念三段话，听的人只记得住最后一句。
 *
 *   「dorm-b 偏热已持续 20 分钟（风扇已开启，处理中），温度正在下降。」
 *
 * 和 buildFocus 说的是同一个人（都走 pickPriority），但**不是同一串字**：
 * ｜ 是给人扫的，念出来是「竖线」，所以这一句得自成一句人话。
 * 两处各拼一份的风险是「重点换人了这边还念旧的」—— 那个风险由
 * 「两个函数都必须从 pickPriority 出发」这条测试挡住。
 *
 * 处理状态复用 handlingNote()，和 7-1 那条栏、B2 依据是同一份说法 ——
 * 「风扇已开启，处理中」这几个字全项目只有那一处拼得出来。
 *
 * @param {Object} nodes
 * @returns {string} 以句号收尾的一句话
 */
export function buildAlert(nodes) {
  const pick = pickPriority(nodes);
  if (!pick) return calmLine(nodes) + '。';

  const list = ranked(nodes);
  /* **到不了**：pickPriority 的实现就是「ranked() 空了才返回 null」，
     所以上面 pick 非空时这里必非空。留着是道保险 —— 万一以后 pickPriority
     改成别的口径（比如自己过滤一遍），这里是 `list[0].status` 会直接炸掉
     的地方，一句平静话比一个 TypeError 好收拾。
     换句话说：这是一句**走不到的代码**，变异测试杀不掉它，因为删掉它
     行为一个字都不变。这一点写在 README 的变异测试表里。 */
  if (list.length === 0) return calmLine(nodes) + '。';

  const top = list[0];
  const node = nodes[pick.nodeId] || {};

  let text = pick.nodeId + ' ' + top.status + '已持续 ' + fmtDuration(top.duration)
    + handlingNote(node);

  const trend = trendText(tempTrend(node));
  if (trend) text += '，' + trend;

  return text + '。';
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
 * 「ML 辅助判断」这一段要显示的三样东西：标题旁的条数、结论那句、来源说明。
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
