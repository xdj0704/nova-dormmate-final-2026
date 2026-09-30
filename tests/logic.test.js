// tests/logic.test.js
// 校验 dashboard/logic.js —— 「优先关注」的算法（Step 7-1）
// 和「处理动作」的状态机（Step 7-2）。
//
// 这个文件是整个测试套件里唯一**不用起 vm 上下文打桩**的一个：
// logic.js 是纯函数，不碰 DOM、不读全局变量、不调 Date.now()，
// 给它一组输入就该得到一组固定输出。所以这里连假 document 都不用造，
// 直接把函数拿出来调。
//
// 它不需要打桩这件事本身就是一条要求，A 段把它钉住了 ——
// 哪天有人往 logic.js 里塞一句 document.getElementById，这里立刻红。
//
// 跑法：node tests/logic.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const LOGIC_FILE = path.join(ROOT, 'dashboard', 'logic.js');

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? `  =>  ${a}` : `\n        实际: ${a}\n        期望: ${e}`));
}

const raw = fs.readFileSync(LOGIC_FILE, 'utf8');

/* ---------- A. 模块形状 ---------- */

console.log('=== A. 模块形状（纯函数的硬约束）===');

/* 导出清单。顺序也一起对 —— 导出集合变了这里就红，
   免得将来谁把某个函数从 export 拿掉，测试还在，测的却是别的东西。 */
const EXPORTS = (raw.match(/^export\s+(?:function|const|let)\s+(\w+)/gm) || [])
  .map((line) => line.replace(/^export\s+(?:function|const|let)\s+/, ''));

check('★ 导出清单正好是这十九个（多一个少一个都要在这里说清楚）',
  EXPORTS.join(','),
  'parseTime,fmtDuration,abnormalDuration,nextAbnormal,beginHandling,nextHandling,'
  + 'beginEvent,markPriority,markAction,closeEvent,pickPriority,'
  + 'buildOverview,buildReasons,tempTrend,buildFocus,buildAlert,'
  + 'buildMlNote,mlFetchFailed,cmdNote');
/* ACTION_FAN 刻意**不**导出：它是「按钮按下之后 action 记什么名字」的唯一一份，
   只该由 logic.js 自己写进返回值。导出的话，dashboard 那边就可能有人
   自己拼一个字符串塞进卡片，页面上就会出现两个说法不一样的名字。 */
check('★ ACTION_FAN 不导出（那串字只该从 logic.js 里出来一份）',
  EXPORTS.includes('ACTION_FAN'), false);

/* 8-1 的内部件同理不导出。ranked() 是「谁是重点」的唯一一份排序，
   basisFor() 是「赢在哪一步」的唯一一份说法 —— 导出的话，页面那边就能
   绕开 pickPriority 自己排一遍，页面上两句话指着不同的宿舍而没人报错。
   （basisFor 在 8-1 之前叫 reasonFor，那时它是私有的；拆成两半之后
   仍然都留在模块里，只有 buildReasons / pickPriority 是对外的口。） */
['ranked', 'basisFor', 'reasonFor', 'survey', 'handlingNote', 'lostTo']
  .forEach(function (name) {
    check('★ ' + name + ' 不导出（内部件：排序和说法各只留一份）',
      EXPORTS.includes(name), false);
  });

/* 8-3 的内部件同理。trendText 是「上升/下降/持平」→ 那句话的唯一一份说法：
   那一行和语音都用它，导出的话页面那边就能自己造第二种说法
   （「温度在涨」/「温度上升」），同一件事两种说法而没人报错。
   calmLine 是「没有重点时说什么」的唯一一份 —— 8-1 那两句里也各有一份类似的话，
   但那两句归 report.html，页面上现在只剩 calmLine 这一份。 */
['trendText', 'calmLine'].forEach(function (name) {
  check('★ ' + name + ' 不导出（内部件：同一件事只留一种说法）',
    EXPORTS.includes(name), false);
});
check('没有 default export（用默认导出的话，dashboard.js 那条具名 import 就失效了）',
  /export\s+default/.test(raw), false);

/* 「不操作 DOM」是这一步的明确要求，所以直接查源码。
   先剥注释：注释里本来就会提到 document、Date 这些东西（比如 parseTime 上面
   写了「不用 new Date(字符串)」），不剥的话这几条永远是红的。 */
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

check('★ 源码里没有 document（不操作 DOM）', /\bdocument\b/.test(code), false);
check('★ 源码里没有 window', /\bwindow\b/.test(code), false);
check('★ 源码里没有 innerHTML', /innerHTML/.test(code), false);
check('★ 源码里没有 setTimeout / requestAnimationFrame（不碰时间调度）',
  /setTimeout|requestAnimationFrame|setInterval/.test(code), false);
check('★ 源码里没有 Date.now（时长一律用报文里的 time 算，不用浏览器当前时间）',
  /Date\.now\s*\(/.test(code), false);
check('时间只经 Date.UTC 折算（两端同按 UTC，时区自然抵消）',
  /Date\.UTC\s*\(/.test(code), true);

/* ---------- 把函数拿出来 ---------- */

/* logic.js 是 ES 模块。vm 跑不了 import/export，所以把 `export ` 前缀摘掉 ——
   函数名照旧留在作用域里，顶层 function 声明在 vm 里就是上下文的全局属性。
   和 tests/scene3d.test.js 改写 'three' 是同一个思路。 */
const stripped = raw.replace(/^export\s+/gm, '');
const context = { Date, Number, String, Object, Array, JSON, Math, isNaN };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(stripped, context, { filename: LOGIC_FILE });

const { parseTime, fmtDuration, abnormalDuration, nextAbnormal, beginHandling,
  nextHandling, beginEvent, markPriority, markAction, closeEvent, pickPriority,
  buildOverview, buildReasons, tempTrend, buildFocus, buildAlert,
  buildMlNote, mlFetchFailed, cmdNote } = context;

check('十九个函数都拿得到', [parseTime, fmtDuration, abnormalDuration, nextAbnormal,
  beginHandling, nextHandling, beginEvent, markPriority, markAction, closeEvent,
  pickPriority, buildOverview, buildReasons, tempTrend, buildFocus, buildAlert,
  buildMlNote, mlFetchFailed, cmdNote]
  .map((f) => typeof f),
['function', 'function', 'function', 'function', 'function', 'function',
  'function', 'function', 'function', 'function', 'function',
  'function', 'function', 'function', 'function', 'function',
  'function', 'function', 'function']);

/* ---------- 小工具 ---------- */

const MIN = 60 * 1000;
/* 拼一个节点。四个参数刚好是页面那边维护的那四个字段 */
function node(latestTime, abnormalStart, abnormalCount, status) {
  return {
    latest: { time: latestTime, status: status === undefined ? '偏热' : status },
    abnormalStart,
    abnormalCount,
  };
}
/* 三节点一套，key 就是 nodeId */
function three(a, b, c) {
  return { 'dorm-a': a, 'dorm-b': b, 'dorm-c': c };
}

/* ---------- B. parseTime ---------- */

console.log('\n=== B. parseTime ===');

check('★ 按 UTC 折算（不是按本地时区，否则同一串在不同机器上差好几个小时）',
  parseTime('2026-09-22 20:30:00'), Date.UTC(2026, 8, 22, 20, 30, 0));
check('相差一分钟 = 60000 毫秒',
  parseTime('2026-09-22 20:31:00') - parseTime('2026-09-22 20:30:00'), MIN);
check('跨零点照样算得对',
  parseTime('2026-09-23 00:00:00') - parseTime('2026-09-22 23:59:00'), MIN);
check('跨月照样算得对',
  parseTime('2026-10-01 00:00:00') - parseTime('2026-09-30 23:59:00'), MIN);
check('闰年的 2 月 29 日认得出（不是 Invalid Date）',
  Number.isNaN(parseTime('2024-02-29 12:00:00')), false);

/* 格式不对一律 NaN，不做「差不多」的宽容匹配 ——
   宽容匹配的代价是得出一个看着挺像样的错时长，而那个错没人会发现。 */
check('斜杠分隔 -> NaN', Number.isNaN(parseTime('2026/09/22 20:30:00')), true);
check('ISO 的 T 分隔 -> NaN（我们只认约定里那一种写法）',
  Number.isNaN(parseTime('2026-09-22T20:30:00')), true);
check('缺秒 -> NaN', Number.isNaN(parseTime('2026-09-22 20:30')), true);
check('不补零 -> NaN', Number.isNaN(parseTime('2026-9-22 20:30:00')), true);
check('前面有空格 -> NaN', Number.isNaN(parseTime(' 2026-09-22 20:30:00')), true);
check('空串 -> NaN', Number.isNaN(parseTime('')), true);
check('null -> NaN，不抛异常', Number.isNaN(parseTime(null)), true);
check('undefined -> NaN，不抛异常', Number.isNaN(parseTime(undefined)), true);
check('数字 -> NaN', Number.isNaN(parseTime(1758000000000)), true);
check('一句中文 -> NaN', Number.isNaN(parseTime('刚刚')), true);

/* ---------- C. fmtDuration ---------- */

console.log('\n=== C. fmtDuration（一律向下取整）===');

check('0 毫秒', fmtDuration(0), '不到 1 分钟');
check('59 秒', fmtDuration(59 * 1000), '不到 1 分钟');
check('整 1 分钟', fmtDuration(MIN), '1 分钟');
check('7 分钟', fmtDuration(7 * MIN), '7 分钟');
check('59 分 59 秒', fmtDuration(59 * MIN + 59 * 1000), '59 分钟');
check('★ 4 分 59 秒 -> 「4 分钟」，不是 5（这一栏宁可少说不要多说）',
  fmtDuration(4 * MIN + 59 * 1000), '4 分钟');
check('整 1 小时', fmtDuration(60 * MIN), '1 小时');
check('1 小时 5 分', fmtDuration(65 * MIN), '1 小时 5 分钟');
check('2 小时整（不写「2 小时 0 分钟」）', fmtDuration(120 * MIN), '2 小时');
/* 负数只可能来自脏数据。既然算不出「负的几分钟」，就当 0 ——
   页面上出现「已连续偏热 -3 分钟」比说「不到 1 分钟」糟得多。 */
check('负数 -> 当 0', fmtDuration(-5000), '不到 1 分钟');
check('NaN -> 当 0，不抛异常', fmtDuration(NaN), '不到 1 分钟');
check('Infinity -> 当 0', fmtDuration(Infinity), '不到 1 分钟');

/* ---------- D. abnormalDuration ---------- */

console.log('\n=== D. abnormalDuration ===');

check('起点到最新一条相差 7 分钟', abnormalDuration(
  node('2026-09-22 20:07:00', '2026-09-22 20:00:00', 2)), 7 * MIN);
check('只有一条消息（起点就是它自己）-> 0',
  abnormalDuration(node('2026-09-22 20:00:00', '2026-09-22 20:00:00', 1)), 0);
check('没有 latest -> 0', abnormalDuration(null), 0);
check('latest 是 null -> 0',
  abnormalDuration({ latest: null, abnormalStart: '2026-09-22 20:00:00', abnormalCount: 1 }), 0);
check('abnormalStart 是 null -> 0',
  abnormalDuration({ latest: { time: '2026-09-22 20:07:00' }, abnormalStart: null, abnormalCount: 1 }), 0);
check('abnormalStart 是脏字符串 -> 0',
  abnormalDuration({ latest: { time: '2026-09-22 20:07:00' }, abnormalStart: '刚才', abnormalCount: 1 }), 0);
check('latest.time 是脏字符串 -> 0',
  abnormalDuration({ latest: { time: '现在' }, abnormalStart: '2026-09-22 20:00:00', abnormalCount: 1 }), 0);
/* time 前后颠倒（手输的假数据）时不能返回负数 */
check('★ 起点比终点还晚 -> 0，不返回负数',
  abnormalDuration(node('2026-09-22 20:00:00', '2026-09-22 20:07:00', 2)), 0);
check('跨天也算得对（23:59 -> 次日 00:06 = 7 分钟）',
  abnormalDuration(node('2026-09-23 00:06:00', '2026-09-22 23:59:00', 2)), 7 * MIN);

/* ---------- E. nextAbnormal ---------- */

console.log('\n=== E. nextAbnormal（连续异常的状态机）===');

const EMPTY = { abnormalStart: null, abnormalCount: 0 };
const T1 = '2026-09-22 20:00:00';
const T2 = '2026-09-22 20:03:00';

check('从没异常过 + 来一条异常 -> 起点是它自己，1 次',
  nextAbnormal(EMPTY, '偏冷', T1), { abnormalStart: T1, abnormalCount: 1 });
check('★ 段接着走：起点不动，次数加一',
  nextAbnormal({ abnormalStart: T1, abnormalCount: 1 }, '偏冷', T2),
  { abnormalStart: T1, abnormalCount: 2 });
check('正常数据 -> 两个字段一起清零',
  nextAbnormal({ abnormalStart: T1, abnormalCount: 5 }, '正常', T2),
  { abnormalStart: null, abnormalCount: 0 });
check('★ 清零之后再来异常 -> 新的一段从这条开始（不是沿用上一段的起点）',
  nextAbnormal(EMPTY, '偏热', T2), { abnormalStart: T2, abnormalCount: 1 });
check('★ 段里状态从偏冷变偏热，仍然是同一段（统计的是「连续异常」不是「连续偏冷」）',
  nextAbnormal({ abnormalStart: T1, abnormalCount: 2 }, '偏热', T2),
  { abnormalStart: T1, abnormalCount: 3 });

/* 不能改传进来的东西 —— 页面那边是 node 本身，改了就等于把手里的状态改脏了 */
const prev = { abnormalStart: T1, abnormalCount: 1 };
const out = nextAbnormal(prev, '偏热', T2);
check('★ 不修改传进来的对象', prev, { abnormalStart: T1, abnormalCount: 1 });
check('返回的是新对象，不是传进来的那个', out === prev, false);

check('prev 是 undefined 也不炸', nextAbnormal(undefined, '偏冷', T1),
  { abnormalStart: T1, abnormalCount: 1 });
check('prev 的 abnormalCount 是 NaN -> 当成新的一段',
  nextAbnormal({ abnormalStart: T1, abnormalCount: NaN }, '偏冷', T2),
  { abnormalStart: T2, abnormalCount: 1 });
check('prev 的 abnormalCount 是负数 -> 当成新的一段',
  nextAbnormal({ abnormalStart: T1, abnormalCount: -3 }, '偏冷', T2),
  { abnormalStart: T2, abnormalCount: 1 });
check('没异常过 + 来一条正常 -> 还是空的',
  nextAbnormal(EMPTY, '正常', T1), { abnormalStart: null, abnormalCount: 0 });
/* 判据就是「等不等于正常这两个字」，不做任何模糊匹配 */
check('「正常 」多一个空格不算正常（页面那边 status 来自复核，不会带空格）',
  nextAbnormal(EMPTY, '正常 ', T1), { abnormalStart: T1, abnormalCount: 1 });

/* ---------- F. pickPriority ---------- */

console.log('\n=== F. pickPriority ===');

check('空对象 -> null', pickPriority({}), null);
check('nodes 是 undefined -> null，不抛异常', pickPriority(undefined), null);
check('三个都正常 -> null', pickPriority(three(
  node('2026-09-22 20:00:00', null, 0, '正常'),
  node('2026-09-22 20:00:00', null, 0, '正常'),
  node('2026-09-22 20:00:00', null, 0, '正常'))), null);
check('还一条数据都没收到 -> null', pickPriority({
  'dorm-a': { latest: null, abnormalStart: null, abnormalCount: 0 },
  'dorm-b': { latest: null, abnormalStart: null, abnormalCount: 0 },
}), null);

/* 只有一个异常节点。这时上面三步一步都没比过，原因那句话要如实说。 */
const solo = pickPriority(three(
  node('2026-09-22 20:00:00', null, 0, '正常'),
  node('2026-09-22 20:07:00', '2026-09-22 20:00:00', 2, '偏热'),
  node('2026-09-22 20:05:00', null, 0, '正常')));
check('★ 只有一个异常节点 -> 就是它', solo.nodeId, 'dorm-b');
check('★ 原因里如实写「目前唯一」，不假称「持续时间最长」',
  solo.reason, 'dorm-b 已连续偏热 7 分钟（2 次），是目前唯一的异常节点');

/* 场景一：时长决出优先 */
const byDuration = pickPriority(three(
  node('2026-09-22 20:03:00', '2026-09-22 20:00:00', 2, '偏冷'),
  node('2026-09-22 20:07:00', '2026-09-22 20:00:00', 2, '偏热'),
  node('2026-09-22 20:05:00', '2026-09-22 20:00:00', 2, '偏湿')));
check('★ 时长最长的是 dorm-b', byDuration.nodeId, 'dorm-b');
check('★ 原因里带着时长和条数，尾巴说明赢在时长',
  byDuration.reason, 'dorm-b 已连续偏热 7 分钟（2 次），持续时间最长');

/* 场景二：时长一样长，比次数 */
const byCount = pickPriority(three(
  node('2026-09-22 20:06:00', '2026-09-22 20:00:00', 2, '偏冷'),
  node('2026-09-22 20:06:00', '2026-09-22 20:00:00', 3, '偏热'),
  node('2026-09-22 20:06:00', '2026-09-22 20:00:00', 2, '偏湿')));
check('★ 三个一样长，条数最多的是 dorm-b', byCount.nodeId, 'dorm-b');
check('★ 尾巴如实说赢在次数，不写「持续时间最长」',
  byCount.reason, 'dorm-b 已连续偏热 6 分钟（3 次），持续时间和 dorm-c 一样长，异常次数最多');

/* 场景三：时长和条数都打平，比严重度（偏热 > 偏湿 > 偏冷） */
const bySeverity = pickPriority(three(
  node('2026-09-22 20:06:00', '2026-09-22 20:00:00', 3, '偏冷'),
  node('2026-09-22 20:06:00', '2026-09-22 20:00:00', 3, '偏热'),
  node('2026-09-22 20:06:00', '2026-09-22 20:00:00', 3, '偏湿')));
check('★ 时长、条数都一样时，偏热的 dorm-b 排在前面', bySeverity.nodeId, 'dorm-b');
check('★ 尾巴如实说赢在严重度',
  bySeverity.reason,
  'dorm-b 已连续偏热 6 分钟（3 次），持续时间和 dorm-c 一样长、异常次数也一样，'
  + '但偏热比偏湿更要紧');

/* 场景四：连严重度都一样，才轮到按名字。
   注意三个的状态必须**相同** —— 不然会停在上面那一步，测不到字典序。 */
const byName = pickPriority(three(
  node('2026-09-22 20:06:00', '2026-09-22 20:00:00', 3, '偏热'),
  node('2026-09-22 20:06:00', '2026-09-22 20:00:00', 3, '偏热'),
  node('2026-09-22 20:06:00', '2026-09-22 20:00:00', 3, '偏热')));
check('★ 四步全平才按字母顺序，dorm-a 在前', byName.nodeId, 'dorm-a');
check('★ 尾巴如实说要按名字排了',
  byName.reason, 'dorm-a 已连续偏热 6 分钟（3 次），和 dorm-b 完全并列，按节点名顺序排在前面');

/* 第 4 步要的是**固定的码元序**，不是跟着运行环境走的本地化排序。
   dorm-a / dorm-b / dorm-c 上这两种排法碰巧答案一样，所以上面那条测不出区别，
   得挑一对能把它们分开的名字：码元序里 'B'(0x42) < 'a'(0x61)，
   本地化排序先比字母再比大小写，'a' 反而排在 'B' 前面。
   两个的状态也得一样（原因同上），否则赢的是严重度那一步。 */
const byCodeUnit = pickPriority({
  'dorm-a': node('2026-09-22 20:06:00', '2026-09-22 20:00:00', 3, '偏热'),
  'dorm-B': node('2026-09-22 20:06:00', '2026-09-22 20:00:00', 3, '偏热'),
});
check("★ 第 3 步用码元序：'dorm-B' 排在 'dorm-a' 前面", byCodeUnit.nodeId, 'dorm-B');
/* 这条是上面那条的对照组：本地化排序给的答案正好相反，
   所以换成 localeCompare 写法，上面那条立刻变红。 */
check('（对照）本地化排序给的是相反的答案，这条才挑得出区别',
  'dorm-B'.localeCompare('dorm-a') > 0, true);

/* 时长优先于条数：条数再多，时长短也排在后面 */
const longFew = pickPriority(three(
  node('2026-09-22 20:07:00', '2026-09-22 20:00:00', 1, '偏冷'),
  node('2026-09-22 20:01:00', '2026-09-22 20:00:00', 99, '偏热'),
  node('2026-09-22 20:00:00', null, 0, '正常')));
check('★ 时长优先：7 分钟的 1 次 排在 1 分钟的 99 次 前面', longFew.nodeId, 'dorm-a');

/* 次数只在时长**相同**的那些之间比。跟所有人比是错的 ——
   一个只异常了一分钟但有 99 条的节点，根本不该进到比次数这一步。 */
check('★ 追平的那句话点的是时长相同的那个（不是次数最多的那个）',
  longFew.reason, 'dorm-a 已连续偏冷 7 分钟（1 次），持续时间最长');

/* 刚发第一条异常（时长 0）也算异常，照样选得出来 */
const justStarted = pickPriority(three(
  node('2026-09-22 20:00:00', null, 0, '正常'),
  node('2026-09-22 20:00:00', '2026-09-22 20:00:00', 1, '偏热'),
  node('2026-09-22 20:00:00', null, 0, '正常')));
check('只有一条异常消息（时长 0）也照样选出来', justStarted.nodeId, 'dorm-b');
check('时长 0 说成「不到 1 分钟」', justStarted.reason.includes('不到 1 分钟'), true);

/* 脏 time 不抛异常，当 0 处理 */
const dirty = pickPriority(three(
  node('不是时间', '2026-09-22 20:00:00', 2, '偏冷'),
  node('2026-09-22 20:05:00', '2026-09-22 20:00:00', 2, '偏热'),
  node('2026-09-22 20:00:00', null, 0, '正常')));
check('★ time 脏了不抛异常，坏的那个当 0 时长，好的照常赢', dirty.nodeId, 'dorm-b');

/* 结果必须确定：同一份数据，键的顺序换了也得是同一个人、同一句话。
   顺便钉死「不用 localeCompare」—— 那个跟着运行环境的区域设置走。 */
const ks = ['dorm-a', 'dorm-b', 'dorm-c'];
const vals = [
  node('2026-09-22 20:06:00', '2026-09-22 20:00:00', 2, '偏冷'),
  node('2026-09-22 20:06:00', '2026-09-22 20:00:00', 2, '偏热'),
  node('2026-09-22 20:06:00', '2026-09-22 20:00:00', 2, '偏湿'),
];
const forward = pickPriority({ [ks[0]]: vals[0], [ks[1]]: vals[1], [ks[2]]: vals[2] });
const reverse = pickPriority({ [ks[2]]: vals[2], [ks[1]]: vals[1], [ks[0]]: vals[0] });
check('★ 键的顺序反过来，结果一模一样（时长条数都平，靠严重度定序）',
  [reverse.nodeId, reverse.reason], [forward.nodeId, forward.reason]);
check('倒序之后仍然是 dorm-b（不是「谁先被遍历到就是谁」）', reverse.nodeId, 'dorm-b');

/* logic.js 不判断规则：status 是原样抄进那句原因的，它不自己复核 */
const echo = pickPriority(three(
  node('2026-09-22 20:03:00', '2026-09-22 20:00:00', 2, '偏湿'),
  node('2026-09-22 20:00:00', null, 0, '正常'),
  node('2026-09-22 20:00:00', null, 0, '正常')));
check('★ latest.status 原样写进原因（复核规则的只有 shared/rules.js 一份）',
  echo.reason.includes('已连续偏湿'), true);

/* ---------- G. 处理动作（Step 7-2）---------- */

console.log('\n=== G. beginHandling / nextHandling（处理动作的状态机）===');

/* 拼一个「可处理」的节点：只要 latest 有 time 就能按下那个按钮。
   故意多带几个字段，好验「不改传进来的东西」。 */
function hNode(latestTime, handling, actionTime) {
  return {
    latest: { time: latestTime, status: '偏热', temperature: 31, humidity: 60 },
    handling: handling === undefined ? '无' : handling,
    action: null,
    actionTime: actionTime === undefined ? null : actionTime,
    dataAfterAction: null,
    history: [],
  };
}
/* 一条复核之后的记录 */
function rec(status, time) {
  return { nodeId: 'dorm-a', temperature: 25, humidity: 60, status, time };
}

/* --- beginHandling：按下按钮那一刻 --- */

check('beginHandling(null) -> null，不抛异常', beginHandling(null), null);
check('beginHandling({}) -> null（没有 latest）', beginHandling({}), null);
check('latest 是 null -> null（一条数据都没收到过，actionTime 没地方取）',
  beginHandling({ latest: null }), null);

const started = beginHandling(hNode('2026-09-22 20:05:00'));
check('★ 按下之后 handling 是「处理中」', started.handling, '处理中');
check('★ action 就是「风扇已开启」这一串（卡片上原样显示的就是它）',
  started.action, '风扇已开启');
check('★ actionTime 取的是**最新那条消息的 time**',
  started.actionTime, '2026-09-22 20:05:00');
check('刚按下时还没有「动作之后的数据」', started.dataAfterAction, null);
check('返回的正好是这四个字段', Object.keys(started).sort(),
  ['action', 'actionTime', 'dataAfterAction', 'handling']);

/* actionTime 只认 latest.time：latest 里别的字段、以及 history 里的旧消息，
   都不该被拿去当动作时间 */
const multi = hNode('2026-09-22 20:05:00');
multi.history = [{ time: '2026-09-22 19:00:00', status: '偏热' }];
check('★ actionTime 不是 history 里更早的那条（只认 latest）',
  beginHandling(multi).actionTime, '2026-09-22 20:05:00');

/* 纯函数：不改传进来的节点，也不复用同一个对象 */
const untouched = hNode('2026-09-22 20:05:00');
const before = JSON.stringify(untouched);
const r1 = beginHandling(untouched);
const r2 = beginHandling(untouched);
check('★ 不改传进来的节点（纯函数）', JSON.stringify(untouched), before);
check('★ 每次返回新对象（不是同一个引用被反复改写）', r1 === r2, false);

/* --- nextHandling：动作之后又来了一条 --- */

const inProgress = () => hNode('2026-09-22 20:05:00', '处理中', '2026-09-22 20:05:00');

check('nextHandling(null, record) -> null', nextHandling(null, rec('正常', '2026-09-22 20:09:00')), null);
check('nextHandling(node, null) -> null',
  nextHandling(inProgress(), null), null);
check('★ 没按过按钮（handling 是「无」）-> null，处理状态不受影响',
  nextHandling(hNode('2026-09-22 20:05:00'), rec('正常', '2026-09-22 20:09:00')), null);
check('handling 是个没见过的值 -> null（不认识的状态不去动它）',
  nextHandling(hNode('2026-09-22 20:05:00', '修好了', '2026-09-22 20:05:00'),
    rec('正常', '2026-09-22 20:09:00')), null);

/* 严格晚于 actionTime 才算「动作之后」*/
check('★ 和 actionTime 同一时刻的那条**不算**（动作就记在这条数据上，'
  + '让它立刻把自己判成「已恢复」是错的）',
  nextHandling(inProgress(), rec('正常', '2026-09-22 20:05:00')), null);
check('★ 比 actionTime 还早的（重发旧数据 / 乱序到达）-> null',
  nextHandling(inProgress(), rec('正常', '2026-09-22 20:00:00')), null);
check('actionTime 脏了（解析不出来）-> null，不当成 0 硬算',
  nextHandling(hNode('2026-09-22 20:05:00', '处理中', '不是时间'),
    rec('正常', '2026-09-22 20:09:00')), null);
check('actionTime 是 null -> null',
  nextHandling(hNode('2026-09-22 20:05:00', '处理中', null),
    rec('正常', '2026-09-22 20:09:00')), null);
check('这条记录的 time 脏了 -> null',
  nextHandling(inProgress(), rec('正常', '不是时间')), null);

/* 动作之后的最新那条说了算 */
const recovered = nextHandling(inProgress(), rec('正常', '2026-09-22 20:09:00'));
check('★ 动作之后是「正常」-> 转「已恢复」', recovered.handling, '已恢复');
check('★ dataAfterAction 记的就是这一条', recovered.dataAfterAction,
  rec('正常', '2026-09-22 20:09:00'));
check('只返回这两个字段（action / actionTime 不动，还是那一次动作的）',
  Object.keys(recovered).sort(), ['dataAfterAction', 'handling']);

check('★ 动作之后还是异常（偏热）-> 留在「处理中」',
  nextHandling(inProgress(), rec('偏热', '2026-09-22 20:09:00')).handling, '处理中');
check('★ 偏冷也算异常 -> 留在「处理中」',
  nextHandling(inProgress(), rec('偏冷', '2026-09-22 20:09:00')).handling, '处理中');
check('★ 偏湿也算异常 -> 留在「处理中」',
  nextHandling(inProgress(), rec('偏湿', '2026-09-22 20:09:00')).handling, '处理中');
check('留在「处理中」时 dataAfterAction 照样更新（最新的那条就是判断依据）',
  nextHandling(inProgress(), rec('偏热', '2026-09-22 20:09:00')).dataAfterAction.time,
  '2026-09-22 20:09:00');

/* 纯函数 */
const src2 = hNode('2026-09-22 20:05:00', '处理中', '2026-09-22 20:05:00');
const before2 = JSON.stringify(src2);
nextHandling(src2, rec('正常', '2026-09-22 20:09:00'));
check('★ nextHandling 也不改传进来的节点', JSON.stringify(src2), before2);

/* 只读 record.status，不自己复核 —— 判定规则只有 shared/rules.js 一份。
   传进来一条「写着正常、但读数明显偏热」的记录，这里就该按「正常」处理：
   复核是 dashboard 在调它之前做完的事。 */
check('★ 只认 record.status，不自己重新判断（复核规则的只有 shared/rules.js 一份）',
  nextHandling(inProgress(), { status: '正常', time: '2026-09-22 20:09:00' }).handling,
  '已恢复');

/* --- 来回走一遍：环境变好变坏都走同一条规则 --- */

let state = beginHandling(hNode('2026-09-22 20:05:00')).handling;
const trail = [state];
[['偏热', '20:09:00'], ['正常', '20:12:00'], ['偏湿', '20:15:00'], ['正常', '20:18:00']]
  .forEach(([status, hm]) => {
    const node = { handling: state, actionTime: '2026-09-22 20:05:00' };
    const moved = nextHandling(node, rec(status, '2026-09-22 ' + hm));
    state = moved.handling;
    trail.push(state);
  });
check('★ 处理中 -> 还异常(处理中) -> 正常(已恢复) -> 又异常(处理中) -> 正常(已恢复)',
  trail, ['处理中', '处理中', '已恢复', '处理中', '已恢复']);

/* 「已恢复」之后再变坏，也要退得回去 —— 不是只有「处理中」才接受新数据 */
check('★ 已恢复的节点收到一条更晚的异常数据 -> 退回「处理中」',
  nextHandling(hNode('2026-09-22 20:09:00', '已恢复', '2026-09-22 20:05:00'),
    rec('偏热', '2026-09-22 20:12:00')).handling, '处理中');
check('★ 已恢复的节点再收到一条更晚的正常数据 -> 仍是「已恢复」，'
  + 'dataAfterAction 往后挪到最新那条',
  nextHandling(hNode('2026-09-22 20:09:00', '已恢复', '2026-09-22 20:05:00'),
    rec('正常', '2026-09-22 20:12:00')).dataAfterAction.time, '2026-09-22 20:12:00');

/* ---------- H. 事件记录（Step 7-4）---------- */

console.log('\n=== H. beginEvent / markPriority / markAction / closeEvent（事件记录）===');

/* 一条事件的字段顺序就是导出 CSV 的列顺序（dashboard.js 的 EVENT_HEADER）。
   这里钉死顺序，那两处就再也拧不到一起去。 */
const EVENT_KEYS = ['nodeId', 'startTime', 'problem', 'priorityTime', 'priorityReason',
  'action', 'actionTime', 'recoverTime', 'result'];

/* --- beginEvent：这段异常开始了 --- */

check('beginEvent(null) -> null，不抛异常', beginEvent(null), null);
check('beginEvent(undefined) -> null', beginEvent(undefined), null);
check('★ status 是「正常」-> null（不许造出一个叫「连续正常」的东西）',
  beginEvent(rec('正常', '2026-09-22 20:30:00')), null);

const ev = beginEvent({ nodeId: 'dorm-b', status: '偏热', time: '2026-09-22 20:30:00' });
check('★ problem 是「连续」+ 当时的 status', ev.problem, '连续偏热');
check('★ startTime 就是这条消息的 time', ev.startTime, '2026-09-22 20:30:00');
check('★ nodeId 照抄', ev.nodeId, 'dorm-b');
check('★ 字段正好是那九列，而且**顺序**跟 CSV 表头一致',
  Object.keys(ev), EVENT_KEYS);

/* 还没发生的那几格一律 null / 空串。空串是 result 专用的：
   它有个明确的「还没结案」含义，而 null 是「这件事压根没发生过」。 */
check('刚开案时优先关注那两格是 null', [ev.priorityTime, ev.priorityReason], [null, null]);
check('刚开案时处理动作那两格是 null', [ev.action, ev.actionTime], [null, null]);
check('刚开案时 recoverTime 是 null', ev.recoverTime, null);
check('★ 刚开案时 result 是**空字符串**（不是「进行中」也不是 null）', ev.result, '');

/* 三种异常都要能开案，problem 跟着 status 走 */
['偏冷', '偏热', '偏湿'].forEach((s) => {
  check('★ ' + s + ' 开出来的 problem 是「连续' + s + '」',
    beginEvent(rec(s, '2026-09-22 20:30:00')).problem, '连续' + s);
});

/* beginEvent 只读 record.status，不自己复核 —— 复核是 dashboard 在调它之前做完的。
   传一条「写着偏热、读数却是 25/60」的记录，这里就该按偏热开案。 */
check('★ 只认 record.status，不自己重新判断（复核规则的只有 shared/rules.js 一份）',
  beginEvent({ nodeId: 'dorm-a', status: '偏热', time: '2026-09-22 20:30:00',
    temperature: 25, humidity: 60 }).problem, '连续偏热');

/* 纯函数 */
const srcRec = { nodeId: 'dorm-a', status: '偏湿', time: '2026-09-22 20:30:00' };
const recBefore = JSON.stringify(srcRec);
const e1 = beginEvent(srcRec);
const e2 = beginEvent(srcRec);
check('★ 不改传进来的那条记录', JSON.stringify(srcRec), recBefore);
check('★ 每次返回新对象（两条事件不能共用一个对象）', e1 === e2, false);

/* --- markPriority：第一次被选成「优先关注」 --- */

check('markPriority(null, ...) -> null', markPriority(null, '2026-09-22 20:35:00', 'x'), null);
check('★ 没有时间 -> null（不能记一个空时刻）',
  markPriority(beginEvent(rec('偏热', '2026-09-22 20:30:00')), null, 'x'), null);
check('time 是空串 -> null', markPriority(beginEvent(rec('偏热', '2026-09-22 20:30:00')), '', 'x'), null);

const fresh = beginEvent(rec('偏热', '2026-09-22 20:30:00'));
const pri = markPriority(fresh, '2026-09-22 20:35:00', 'dorm-b 已连续偏热 5 分钟（3 次），持续时间最长');
check('★ 第一次记下时刻', pri.priorityTime, '2026-09-22 20:35:00');
check('★ 原因原话照抄（页面上那条栏里显示的就是这一句）',
  pri.priorityReason, 'dorm-b 已连续偏热 5 分钟（3 次），持续时间最长');
check('只返回这两个字段', Object.keys(pri).sort(), ['priorityReason', 'priorityTime']);

/* ★ 只记第一次：之后再被选中不覆盖。复盘要回答的是「什么时候被注意到、
   当时因为什么」，不是「最后一次看它时长什么样」。 */
const stamped = Object.assign(beginEvent(rec('偏热', '2026-09-22 20:30:00')),
  { priorityTime: '2026-09-22 20:35:00', priorityReason: '第一次的原因' });
check('★ 已经记过 -> null，不覆盖（只记第一次）',
  markPriority(stamped, '2026-09-22 20:50:00', '后来的原因'), null);
check('★ 那条事件上的时刻和原因都还是第一次的',
  [stamped.priorityTime, stamped.priorityReason],
  ['2026-09-22 20:35:00', '第一次的原因']);

/* reason 缺失时写空串，不写字符串 'null' —— 那四个字母会原样进 CSV */
check('reason 是 null -> 空串（不是字符串 "null"）',
  markPriority(beginEvent(rec('偏热', '2026-09-22 20:30:00')), '2026-09-22 20:35:00', null)
    .priorityReason, '');
check('reason 是 undefined -> 空串',
  markPriority(beginEvent(rec('偏热', '2026-09-22 20:30:00')), '2026-09-22 20:35:00')
    .priorityReason, '');
check('reason 是数字 -> 转成字符串，不原样塞进去',
  markPriority(beginEvent(rec('偏热', '2026-09-22 20:30:00')), '2026-09-22 20:35:00', 42)
    .priorityReason, '42');

/* 纯函数：返回局部对象，绝不就地改传进来的那条 */
const pSrc = beginEvent(rec('偏热', '2026-09-22 20:30:00'));
const pBefore = JSON.stringify(pSrc);
markPriority(pSrc, '2026-09-22 20:35:00', 'x');
check('★ markPriority 不改传进来的事件（要不要写回去是调用方的事）',
  JSON.stringify(pSrc), pBefore);

/* --- markAction：处理动作 --- */

check('markAction(null, ...) -> null', markAction(null, '风扇已开启', '2026-09-22 20:35:00'), null);
check('没有动作名 -> null',
  markAction(beginEvent(rec('偏热', '2026-09-22 20:30:00')), null, '2026-09-22 20:35:00'), null);
check('动作名是空串 -> null',
  markAction(beginEvent(rec('偏热', '2026-09-22 20:30:00')), '', '2026-09-22 20:35:00'), null);
check('★ 没有时间 -> null（不能记一个空时刻）',
  markAction(beginEvent(rec('偏热', '2026-09-22 20:30:00')), '风扇已开启', null), null);

const act = markAction(beginEvent(rec('偏热', '2026-09-22 20:30:00')),
  '风扇已开启', '2026-09-22 20:35:00');
check('★ 第一次记下动作名', act.action, '风扇已开启');
check('★ 和动作记在哪条数据上', act.actionTime, '2026-09-22 20:35:00');
check('只返回这两个字段', Object.keys(act).sort(), ['action', 'actionTime']);

/* ★ 也只记第一次：第二次按的时候 actionTime 会往前挪，但复盘要看的是
   「这件事第一次被动手是什么时候、做了什么」。 */
const acted = Object.assign(beginEvent(rec('偏热', '2026-09-22 20:30:00')),
  { action: '风扇已开启', actionTime: '2026-09-22 20:35:00' });
check('★ 已经记过 -> null，不覆盖（只记第一次）',
  markAction(acted, '风扇已开启', '2026-09-22 20:40:00'), null);
check('★ 那条事件上的动作时刻还是第一次的', acted.actionTime, '2026-09-22 20:35:00');

const aSrc = beginEvent(rec('偏热', '2026-09-22 20:30:00'));
const aBefore = JSON.stringify(aSrc);
markAction(aSrc, '风扇已开启', '2026-09-22 20:35:00');
check('★ markAction 不改传进来的事件', JSON.stringify(aSrc), aBefore);

/* --- closeEvent：结案 --- */

check('closeEvent(null, ...) -> null', closeEvent(null, '2026-09-22 20:55:00'), null);
check('★ 没有时间 -> null',
  closeEvent(beginEvent(rec('偏热', '2026-09-22 20:30:00')), null), null);

const closed = closeEvent(beginEvent(rec('偏热', '2026-09-22 20:30:00')), '2026-09-22 20:55:00');
check('★ recoverTime 是让它恢复正常的那条消息的 time',
  closed.recoverTime, '2026-09-22 20:55:00');
check('★ result 是「已恢复」', closed.result, '已恢复');
check('只返回这两个字段', Object.keys(closed).sort(), ['recoverTime', 'result']);

check('★ 已经结过案 -> null（不重复结案，recoverTime 不会被后来的数据顶掉）',
  closeEvent({ recoverTime: '2026-09-22 20:55:00', result: '已恢复' },
    '2026-09-22 21:30:00'), null);

/* 结案不做时间比较：该不该结案是 nextAbnormal 把 abnormalCount 清零说了算的，
   这边只负责写下来。所以哪怕传一个比 startTime 还早的 time，它也照写 ——
   这是**故意**的，不是漏了校验（代价见 README「报文没有乱序保护」）。 */
check('★ 结案不看时间先后（该不该结案由 nextAbnormal 决定，这里只负责写）',
  closeEvent(beginEvent(rec('偏热', '2026-09-22 20:30:00')), '2026-09-22 20:00:00')
    .recoverTime, '2026-09-22 20:00:00');

const cSrc = beginEvent(rec('偏热', '2026-09-22 20:30:00'));
const cBefore = JSON.stringify(cSrc);
closeEvent(cSrc, '2026-09-22 20:55:00');
check('★ closeEvent 不改传进来的事件', JSON.stringify(cSrc), cBefore);

/* --- 一个节点走完一整段：开案 -> 被关注 -> 动手 -> 结案 ---

   四个函数拼起来用的样子，就是 dashboard.js 里 handleMessage 那一串。
   全程只有**一个**对象，就地往上加字段。 */
const walked = beginEvent({ nodeId: 'dorm-b', status: '偏热', time: '2026-09-22 20:30:00' });
Object.assign(walked, markPriority(walked, '2026-09-22 20:35:00', 'dorm-b 已连续偏热 5 分钟（3 次），持续时间最长'));
Object.assign(walked, markAction(walked, '风扇已开启', '2026-09-22 20:35:00'));
Object.assign(walked, closeEvent(walked, '2026-09-22 20:55:00'));

check('★ 走完一整段之后，九列全填齐（CSV 那一行就是这么来的）',
  Object.keys(walked).map((k) => walked[k]), [
    'dorm-b',
    '2026-09-22 20:30:00',
    '连续偏热',
    '2026-09-22 20:35:00',
    'dorm-b 已连续偏热 5 分钟（3 次），持续时间最长',
    '风扇已开启',
    '2026-09-22 20:35:00',
    '2026-09-22 20:55:00',
    '已恢复',
  ]);

/* 段里状态变了也不另开一条 —— problem 是开案时定死的。
   一段从偏热恶化成偏湿的经历，事后不该看起来像是从头就偏湿的。 */
const worsen = beginEvent({ nodeId: 'dorm-b', status: '偏热', time: '2026-09-22 20:30:00' });
worsen.latestStatus = '偏湿';
check('★ problem 在开案时就定死，中途状态变了也不改名（它是这条事件的名字）',
  worsen.problem, '连续偏热');
check('★ 没有任何函数会去改 problem（markPriority / markAction / closeEvent 都只返回自己那几格）',
  [markPriority(worsen, '2026-09-22 20:35:00', 'x'),
    markAction(worsen, '风扇已开启', '2026-09-22 20:35:00'),
    closeEvent(worsen, '2026-09-22 20:55:00')]
    .map((p) => Object.prototype.hasOwnProperty.call(p, 'problem')),
  [false, false, false]);

/* ---------- I. Step 8-1：B1 当前总览 + B2 判断依据 ---------- */

console.log('\n=== I. Step 8-1：当前总览 + 判断依据 ===');

/* 三个节点的三份数据。时间全部写死成固定时刻 —— 和 7-1 算时长同一个道理：
   两端都取报文里的 time，所以 20:00 到 20:20 永远是 20 分钟，
   跟什么时候跑、在哪台机器上跑都没关系，断言才能写定值。 */
function trio(a, b, c) {
  return { 'dorm-a': a, 'dorm-b': b, 'dorm-c': c };
}
/* 正常节点：abnormalCount 是 0，abnormalStart 按约定也是 null */
function calm(time) { return node(time, null, 0, '正常'); }
/* 一条数据都还没收到的节点。页面刚打开、还没连上 broker 的那几秒就是这个样子 */
function silent() { return { latest: null, abnormalStart: null, abnormalCount: 0 }; }

const ALL_CALM = trio(calm('2026-09-22 20:00:00'), calm('2026-09-22 20:00:00'),
  calm('2026-09-22 20:00:00'));
const NOBODY = trio(silent(), silent(), silent());

check('★ 一条数据都没有时不说「都正常」——那是**不知道**，不是正常',
  buildOverview(NOBODY), '还没有收到任何节点的数据。');
check('★ 一条数据都没有时，依据也说不出——不硬编一句糊弄过去',
  buildReasons(NOBODY), '还没有收到任何节点的数据，说不出依据。');
check('★ nodes 是空对象也不炸',
  buildOverview({}), '还没有收到任何节点的数据。');
check('★ nodes 是 undefined 也不炸',
  typeof buildReasons(undefined), 'string');
check('★ 都正常：总览不硬凑「0 个需要关注」',
  buildOverview(ALL_CALM), '当前 3 个宿舍都正常。');
check('★ 都正常：依据说清「没有要优先处理的」',
  buildReasons(ALL_CALM), '当前 3 个宿舍都正常，没有要优先处理的宿舍。');
check('★ 都正常时总览里不出现「是当前重点」（没有重点就别造一个）',
  /当前重点/.test(buildOverview(ALL_CALM)), false);
check('★ 只收到 2 个节点的数据时，「都正常」要改口——第 3 个是不知道',
  buildOverview(trio(calm('2026-09-22 20:00:00'), calm('2026-09-22 20:00:00'), silent())),
  '当前 3 个宿舍中，2 个正常，另有 1 个还没有收到数据。');

/* ---- 一个异常 ---- */

const ONE = trio(calm('2026-09-22 20:00:00'),
  node('2026-09-22 20:20:00', '2026-09-22 20:00:00', 2, '偏热'),
  calm('2026-09-22 20:00:00'));

check('★ 一个异常：总览先说计数，再点出重点',
  buildOverview(ONE),
  '当前 3 个宿舍中，2 个正常，1 个需要关注；dorm-b 已持续偏热 20 分钟，是当前重点。');
check('★ 一个异常：依据里正常的两个直说「当前正常」，不硬拉来比较',
  buildReasons(ONE),
  '优先关注 dorm-b：已连续偏热 20 分钟（2 次），是目前唯一的异常节点；'
  + 'dorm-a 当前正常；dorm-c 当前正常。');

/* ---- 两个异常：靠时长决出（就是需求里给的那两句）---- */

const TWO = trio(calm('2026-09-22 20:00:00'),
  node('2026-09-22 20:20:00', '2026-09-22 20:00:00', 2, '偏热'),
  node('2026-09-22 20:20:00', '2026-09-22 20:15:00', 2, '偏湿'));

check('★ 两个异常：总览多出一笔「dorm-c 出现偏湿」',
  buildOverview(TWO),
  '当前 3 个宿舍中，1 个正常，2 个需要关注；dorm-b 已持续偏热 20 分钟，是当前重点；'
  + 'dorm-c 出现偏湿。');
check('★ 两个异常：依据逐个对比，输的那个说清输在哪一步',
  buildReasons(TWO),
  '优先关注 dorm-b：已连续偏热 20 分钟（2 次），持续时间最长；'
  + 'dorm-c 虽然偏湿，但只持续 5 分钟；dorm-a 当前正常。');

/* ---- 时长打平、靠次数决出 ---- */

const TIE = trio(node('2026-09-22 20:20:00', '2026-09-22 20:00:00', 2, '偏冷'),
  node('2026-09-22 20:20:00', '2026-09-22 20:00:00', 4, '偏热'),
  calm('2026-09-22 20:00:00'));

check('★ 时长打平时，输的那个不能写成「只持续 20 分钟」——它并没有更短',
  buildReasons(TIE),
  '优先关注 dorm-b：已连续偏热 20 分钟（4 次），持续时间和 dorm-a 一样长，异常次数最多；'
  + 'dorm-a 也偏冷，持续时间和它一样长，但只有 2 条异常数据；dorm-c 当前正常。');

/* ---- 时长和条数都打平，靠严重度分胜负 ---- */

const SEV = trio(node('2026-09-22 20:20:00', '2026-09-22 20:00:00', 2, '偏冷'),
  node('2026-09-22 20:20:00', '2026-09-22 20:00:00', 2, '偏热'),
  calm('2026-09-22 20:00:00'));

check('★ 时长条数都一样时靠严重度定序：偏热 > 偏冷',
  buildReasons(SEV),
  '优先关注 dorm-b：已连续偏热 20 分钟（2 次），持续时间和 dorm-a 一样长、异常次数也一样，'
  + '但偏热比偏冷更要紧；'
  + 'dorm-a 也偏冷，时长和次数都跟它一样，但偏冷没有偏热要紧；dorm-c 当前正常。');

/* ---- 连严重度都一样，只能按节点名定序 ---- */

const DEAD = trio(node('2026-09-22 20:20:00', '2026-09-22 20:00:00', 2, '偏热'),
  node('2026-09-22 20:20:00', '2026-09-22 20:00:00', 2, '偏热'),
  calm('2026-09-22 20:00:00'));

check('★ 完全并列时明说是靠节点名排的，不装作赢了',
  buildReasons(DEAD),
  '优先关注 dorm-a：已连续偏热 20 分钟（2 次），和 dorm-b 完全并列，按节点名顺序排在前面；'
  + 'dorm-b 也偏热，时长和次数都跟它一样，按节点名顺序排在后面；dorm-c 当前正常。');

/* ---- 处理状态 ---- */

const HANDLING = trio(calm('2026-09-22 20:00:00'),
  Object.assign(node('2026-09-22 20:20:00', '2026-09-22 20:00:00', 2, '偏热'),
    { handling: '处理中', action: '风扇已开启' }),
  node('2026-09-22 20:20:00', '2026-09-22 20:15:00', 2, '偏湿'));

check('★ 正在处理的节点，总览里如实补一句；计数口径不变，仍算「需要关注」',
  buildOverview(HANDLING),
  '当前 3 个宿舍中，1 个正常，2 个需要关注；dorm-b 已持续偏热 20 分钟，是当前重点'
  + '（风扇已开启，处理中）；dorm-c 出现偏湿。');
check('★ 依据里也带上处理状态',
  buildReasons(HANDLING).indexOf('（风扇已开启，处理中）') >= 0, true);
/* 处理状态只是如实报出来，不参与排序 —— 真按「有没有人管」排是另一套规则。
   这里用同一份数据（只差 handling 那几个字段）验证：重点和原因一字不变。 */
check('★ 处理状态不参与排序：同一份数据按不按风扇，「谁是重点、因为什么」都一样',
  pickPriority(HANDLING).reason, pickPriority(TWO).reason);
/* 一个**已经正常**、handling 却还停在「处理中」的节点：风扇是按在旧数据上的，
   之后来的那条正常数据比动作还早（见 nextHandling 的时间判断），所以状态回来了
   但处理状态没跟上。这时候写「（风扇已开启，处理中）」是自相矛盾的
   —— 都正常了还处理什么。 */
check('★ 状态已经正常、处理状态却还停在「处理中」的节点，不带那个括号',
  buildReasons(trio(
    Object.assign(calm('2026-09-22 20:00:00'),
      { handling: '处理中', action: '风扇已开启' }),
    node('2026-09-22 20:20:00', '2026-09-22 20:00:00', 2, '偏热'),
    calm('2026-09-22 20:00:00'))).indexOf('处理中'), -1);

/* ---- 有节点还没收到数据 ---- */

const MIXED = trio(silent(),
  node('2026-09-22 20:20:00', '2026-09-22 20:00:00', 2, '偏热'),
  calm('2026-09-22 20:00:00'));

check('★ 没收到数据的节点单独说，不算进「正常」里（三个数加起来正好是宿舍数）',
  buildOverview(MIXED),
  '当前 3 个宿舍中，1 个正常，1 个需要关注，另有 1 个还没有收到数据；'
  + 'dorm-b 已持续偏热 20 分钟，是当前重点。');
check('★ 依据里没数据的那个也说成「还没有收到数据」，不冒充正常',
  buildReasons(MIXED),
  '优先关注 dorm-b：已连续偏热 20 分钟（2 次），是目前唯一的异常节点；'
  + 'dorm-a 还没有收到数据；dorm-c 当前正常。');

/* ---- 一个数字、一个名字都不许写死 ---- */

const FOUR = {
  'dorm-a': calm('2026-09-22 20:00:00'),
  'dorm-b': node('2026-09-22 20:30:00', '2026-09-22 20:00:00', 3, '偏热'),
  'dorm-c': node('2026-09-22 20:30:00', '2026-09-22 20:10:00', 2, '偏湿'),
  'dorm-d': node('2026-09-22 20:30:00', '2026-09-22 20:20:00', 1, '偏冷'),
};

check('★ 换成四个宿舍照样说得对：宿舍数是数出来的，不是写死的 3',
  buildOverview(FOUR),
  '当前 4 个宿舍中，1 个正常，3 个需要关注；dorm-b 已持续偏热 30 分钟，是当前重点；'
  + 'dorm-c 出现偏湿、dorm-d 出现偏冷。');
check('★ 四个节点时依据也跟着走：三个异常各自一句，正常的那个照实说',
  buildReasons(FOUR),
  '优先关注 dorm-b：已连续偏热 30 分钟（3 次），持续时间最长；'
  + 'dorm-c 虽然偏湿，但只持续 20 分钟；dorm-d 虽然偏冷，但只持续 10 分钟；'
  + 'dorm-a 当前正常。');

/* 三个都不正常：为 0 的那一档不写出来（「0 个正常」又长又没信息）。
   和上面「都正常时不写 0 个需要关注」是同一个口径。 */
const ALL_BAD = trio(
  node('2026-09-22 20:30:00', '2026-09-22 20:00:00', 2, '偏冷'),
  node('2026-09-22 20:30:00', '2026-09-22 20:00:00', 3, '偏热'),
  node('2026-09-22 20:30:00', '2026-09-22 20:10:00', 1, '偏湿'));

check('★ 三个都不正常时，不写「0 个正常」那一档',
  buildOverview(ALL_BAD),
  '当前 3 个宿舍中，3 个需要关注；dorm-b 已持续偏热 30 分钟，是当前重点；'
  + 'dorm-a 出现偏冷、dorm-c 出现偏湿。');
check('★ 三个都不正常时也单独说了没数据的那个（只收了 1 条消息）',
  buildOverview(trio(silent(),
    node('2026-09-22 20:30:00', '2026-09-22 20:00:00', 3, '偏热'),
    node('2026-09-22 20:30:00', '2026-09-22 20:10:00', 1, '偏湿'))),
  '当前 3 个宿舍中，2 个需要关注，另有 1 个还没有收到数据；'
  + 'dorm-b 已持续偏热 30 分钟，是当前重点；dorm-c 出现偏湿。');

/* 节点名的字典序和严重程度**不一致**的一组。
   上面每一组的 dorm-a/b/c 恰好都按 a < b < c 排，正好和「越靠前越严重」
   重合 —— 那样即使把「还有谁异常」写成按 nodes 键顺序遍历，结果也一模一样，
   测不出区别。这一组故意把最严重的放在中间：
   dorm-a 只异常 5 分钟，dorm-b 异常 30 分钟（重点），dorm-c 异常 20 分钟。
   键顺序是 a/b/c，严重程度是 b/c/a，两者必须分得开。 */
const OUT_OF_ORDER = {
  'dorm-a': node('2026-09-22 20:05:00', '2026-09-22 20:00:00', 1, '偏冷'),
  'dorm-b': node('2026-09-22 20:30:00', '2026-09-22 20:00:00', 3, '偏热'),
  'dorm-c': node('2026-09-22 20:30:00', '2026-09-22 20:10:00', 2, '偏湿'),
  'dorm-d': calm('2026-09-22 20:00:00'),
};

check('★ 「还有谁异常」按严重程度排，不是按 nodes 的键顺序',
  buildOverview(OUT_OF_ORDER),
  '当前 4 个宿舍中，1 个正常，3 个需要关注；dorm-b 已持续偏热 30 分钟，是当前重点；'
  + 'dorm-c 出现偏湿、dorm-a 出现偏冷。');
check('★ 依据里也是先重点、再按严重程度一路排下来',
  buildReasons(OUT_OF_ORDER),
  '优先关注 dorm-b：已连续偏热 30 分钟（3 次），持续时间最长；'
  + 'dorm-c 虽然偏湿，但只持续 20 分钟；dorm-a 虽然偏冷，但只持续 5 分钟；'
  + 'dorm-d 当前正常。');

const RENAMED = {
  'north-1': calm('2026-09-22 20:00:00'),
  'south-2': node('2026-09-22 20:10:00', '2026-09-22 20:00:00', 1, '偏冷'),
};

check('★ 节点名换掉、状态换掉、宿舍数换掉，同一份代码说的还是实话',
  buildOverview(RENAMED),
  '当前 2 个宿舍中，1 个正常，1 个需要关注；south-2 已持续偏冷 10 分钟，是当前重点。');
check('★ 依据里的节点名和状态也全都来自数据',
  buildReasons(RENAMED),
  '优先关注 south-2：已连续偏冷 10 分钟（1 次），是目前唯一的异常节点；'
  + 'north-1 当前正常。');

/* ---- 和顶部那条栏的一致性：这是这两句存在的意义 ---- */

[[TWO, '两个异常'], [FOUR, '四个节点'], [TIE, '时长打平'], [DEAD, '完全并列'],
  [MIXED, '有节点没数据'], [ONE, '一个异常'], [RENAMED, '换过名字']]
  .forEach(function (item) {
    const nodes = item[0];
    const label = item[1];
    const pick = pickPriority(nodes);
    const overview = buildOverview(nodes);
    const reasons = buildReasons(nodes);

    check('★ [' + label + '] 总览点的重点和优先关注栏是同一个人',
      overview.indexOf(pick.nodeId + ' 已持续') >= 0, true);
    /* 栏里是「dorm-b 已连续…」，依据是「优先关注 dorm-b：已连续…」——
       去掉开头那个节点名之后必须逐字相同。各拼一份的话，两处对
       「赢在哪一步」的说法迟早会不一样。 */
    check('★ [' + label + '] 依据开头那半句和栏里的原因逐字相同',
      reasons.indexOf('优先关注 ' + pick.nodeId + '：'
        + pick.reason.slice(pick.nodeId.length + 1)), 0);
    check('★ [' + label + '] 重点在依据里只说一遍（不在后面那拨对比里再出现一次）',
      reasons.split(pick.nodeId).length - 1, 1);
    check('★ [' + label + '] 两句话都以句号收尾',
      [/。$/.test(overview), /。$/.test(reasons)], [true, true]);
  });

/* ---- 纯函数 ---- */

const SNAPSHOT = JSON.stringify(FOUR);
buildOverview(FOUR);
buildReasons(FOUR);
pickPriority(FOUR);
check('★ 总览和依据都不改传进来的 nodes（页面那边读的是同一份对象）',
  JSON.stringify(FOUR), SNAPSHOT);

/* 同一个输入永远同一个输出 —— 这两句会被反复重画，带上任何「当前时间」
   或随机成分，页面上就会出现两句对不上的话。 */
check('★ 同样的输入连着算两遍，两句话一字不差',
  [buildOverview(TWO) === buildOverview(TWO), buildReasons(TWO) === buildReasons(TWO)],
  [true, true]);

/* ---------- J. Step 8-3：当前重点一行 + 语音提醒 ---------- */

console.log('\n=== J. Step 8-3：当前重点一行 + 语音提醒 ===');

/* 这一步是**信息分工**：页面上原来有三处在说「谁是重点」（7-1 那条栏、
   B1 总览、B2 依据），8-3 并成看板顶部一行，剩下的细节分给 3D / 语音 /
   report.html。所以这里测的是两个新出口各自「该说什么、不该说什么」。

   两个函数都必须从 pickPriority 出发 —— 「谁是重点」只有一份实现。
   两处各挑一次的话，页面上会出现「那一行说的是 dorm-b、语音念的是 dorm-c」，
   而且不会有任何地方报错。J3 最后一组专门钉这一条。 */

/**
 * 一个带历史记录的节点。tempTrend 只看 history 的最后两条，
 * 所以 history 的**方向**很关键：最后一个是「刚收到的那条」，
 * 和页面里 history.push() 的方向一致（新的在后）。
 *
 * @param {number[]} temps 温度序列，最后一个是最新那条
 * @param {Object} [opts] time / start / count / status / handling
 */
function traced(temps, opts) {
  const o = opts || {};
  const time = o.time || '2026-09-22 20:20:00';
  const n = node(time, o.start || '2026-09-22 20:00:00',
    o.count === undefined ? 2 : o.count, o.status || '偏热');
  n.history = temps.map((t) => ({ time: time, temperature: t }));
  if (o.handling) {
    n.handling = o.handling;
    n.action = '风扇已开启';
  }
  return n;
}

/* ---- J1. tempTrend：最近两条温度往哪走 ---- */

check('★ 后一条比前一条高 -> 上升', tempTrend(traced([24, 26])), '上升');
check('★ 后一条比前一条低 -> 下降', tempTrend(traced([26, 24])), '下降');
check('★ 一样 -> 持平', tempTrend(traced([25, 25])), '持平');
/* 只看最近两条。看更长的一段就成了「这一段的走势」，那是趋势图的事。 */
check('★ 只看最近两条：前面跌得再狠，最近一次是涨的就是「上升」',
  tempTrend(traced([30, 24, 26])), '上升');
check('★ 反过来也一样：前面涨得再高，最近一次是跌的就是「下降」',
  tempTrend(traced([18, 33, 31])), '下降');
/* 比的是精确值，不设「小于 0.5℃ 算没变」那种容差 ——
   设阈值要先定下来多少算没变，那是另一套规则，这一步不定；
   而且真实数据里 24.9 → 25.0 确实就是在上升。 */
check('★ 差 0.1℃ 也算上升（没有容差）', tempTrend(traced([24.9, 25])), '上升');
check('★ 差 0.1℃ 也算下降', tempTrend(traced([25, 24.9])), '下降');

/* 【只有一条记录时是空串，不是「持平」】这两件事不一样：
   一条数据说不出「在往哪走」，说成「持平」就是把「不知道」说成了「没变」——
   和 B1 那边「还没有收到数据 ≠ 正常」是同一条原则。 */
check('★ 只有一条记录 -> 空串（说不出往哪走，不写成「持平」）',
  tempTrend(traced([25])), '');
check('一条记录都没有 -> 空串', tempTrend(traced([])), '');
check('没有 history 字段 -> 空串，不炸', tempTrend(node('2026-09-22 20:20:00',
  '2026-09-22 20:00:00', 2, '偏热')), '');
check('history 不是数组 -> 空串，不炸', tempTrend({ history: '昨天' }), '');
check('history 里有一项是 null -> 空串，不炸',
  tempTrend({ history: [{ temperature: 25 }, null] }), '');
check('温度不是有限数字 -> 空串（NaN 走进比较会得出「持平」这种假结论）',
  [tempTrend({ history: [{ temperature: 25 }, { temperature: NaN }] }),
    tempTrend({ history: [{ temperature: 25 }, { temperature: '26' }] }),
    tempTrend({ history: [{ temperature: 25 }, {}] })], ['', '', '']);
check('节点是 null / undefined / 空对象 -> 空串，不炸',
  [tempTrend(null), tempTrend(undefined), tempTrend({})], ['', '', '']);

/* ---- J2. buildFocus：看板顶部那一行 ---- */

/* 平静时候那一行不带句号 —— 它不是一句话，是一个状态标签。
   和 buildAlert（那一句是要念出来的）不一样，两边刻意各写各的标点。 */
check('★ 一条数据都没有 -> 「还没有收到任何节点的数据」（不是「都正常」）',
  buildFocus(NOBODY), '还没有收到任何节点的数据');
check('★ 都正常 -> 「当前 3 个宿舍都正常」', buildFocus(ALL_CALM), '当前 3 个宿舍都正常');
check('★ 只收到 2 个节点的数据 -> 两个数都报出来（第 3 个是不知道，不是正常）',
  buildFocus(trio(calm('2026-09-22 20:00:00'), calm('2026-09-22 20:00:00'), silent())),
  '当前 2 个宿舍正常，另有 1 个还没有收到数据');
check('nodes 是空对象 / undefined 也不炸',
  [buildFocus({}), buildFocus(undefined)],
  ['还没有收到任何节点的数据', '还没有收到任何节点的数据']);

/* 有一条异常、只有一条数据：说不出往哪走，就只剩宿舍名。
   拼不出来的那一段**整个不出现**，不留一个空串或两个连着的 ｜。 */
check('★ 只有一条数据时只剩宿舍名（说不出「往哪走」就不说）',
  buildFocus(ONE), 'dorm-b');
check('★ 没有连着两个 ｜（空的那一段是整个不出现，不是拼个空串）',
  buildFocus(ONE).includes('｜｜'), false);
check('没有 ｜ 收尾 / 开头（段是拼上去的，不是占位符）',
  [/｜$/.test(buildFocus(ONE)), /^｜/.test(buildFocus(ONE))], [false, false]);

/* 规格里给的那个例子：谁、在不在处理、往哪走 */
const BUSY = trio(calm('2026-09-22 20:00:00'),
  traced([31, 30], { handling: '处理中' }),
  calm('2026-09-22 20:00:00'));

check('★ 三段拼起来就是规格里那个样子', buildFocus(BUSY), 'dorm-b｜处理中｜温度正在下降');
check('★ 没按过按钮就没有「处理中」那一段',
  buildFocus(trio(calm('2026-09-22 20:00:00'), traced([31, 30]),
    calm('2026-09-22 20:00:00'))),
  'dorm-b｜温度正在下降');
/* 【「无」是字符串，所以它真的】上面那条用的是「没有 handling 这个字段」，
   但页面里跑起来时不是那样：没按过按钮的节点，handling 就是字符串 '无'
   （见 nextHandling / beginEvent）。所以这里不能只判 `if (node.handling)` ——
   那样拼出来是「dorm-b｜无｜温度正在下降」，把「没人在处理」说成了一段内容。 */
check('★ handling 是「无」（页面里没按过按钮就是这个值）-> 也不拼这一段',
  buildFocus(trio(calm('2026-09-22 20:00:00'), traced([31, 30], { handling: '无' }),
    calm('2026-09-22 20:00:00'))),
  'dorm-b｜温度正在下降');
/* 同一个坑，另一侧：handlingNote 用的是白名单（只认「处理中」），
   所以语音那句本来就不会念出「无」。钉住这个不对称，免得日后统一成黑名单。 */
check('★ 语音那句也不念「无」',
  buildAlert(trio(calm('2026-09-22 20:00:00'), traced([31, 30], { handling: '无' }),
    calm('2026-09-22 20:00:00'))).includes('无'),
  false);
check('★ 持平时的说法是「温度持平」，不是「温度正在持平」',
  buildFocus(trio(calm('2026-09-22 20:00:00'), traced([31, 31], { handling: '处理中' }),
    calm('2026-09-22 20:00:00'))),
  'dorm-b｜处理中｜温度持平');

/* 【这一行里没有状态】这是分工的结果，不是漏了：
   状态由卡片徽章（颜色 + 形状 + 文字）、3D 场景、语音一起承担。
   一行字里塞四样东西，就又变回 8-1 那种「两句话交代所有事」了。 */
check('★ 这一行里不写状态（偏热/偏冷/偏湿一个都不出现）',
  ['偏热', '偏冷', '偏湿'].map((s) => buildFocus(BUSY).includes(s)), [false, false, false]);
/* 【也不写「风扇已开启」】开了什么是**空间动作**，3D 里风扇转着比一行字直观 ——
   那正是 3D 该承担的部分。这一行只报「有没有人在处理」。 */
check('★ 也不写「风扇已开启」（那是 3D 的事）',
  [buildFocus(BUSY).includes('风扇已开启'), buildFocus(BUSY).includes('处理中')],
  [false, true]);
/* 一句原因也不写。它归 report.html ——那里才是交代来龙去脉的地方。 */
check('★ 不写那句原因（「持续时间最长」之类一个都没有）',
  buildFocus(BUSY).includes('已持续'), false);

/* ---- J3. buildAlert：语音念的那一句 ---- */

/* 只有一句 —— 这是这个出口的约束，不是偷懒：声音是线性的，说过就过去了，
   没人能回头翻。念三段话，听的人只记得住最后一句。 */
check('★ 一条数据都没有 -> 念的是「还没有收到数据」，不是「都正常」',
  buildAlert(NOBODY), '还没有收到任何节点的数据。');
check('★ 都正常 -> 念的是「都正常」', buildAlert(ALL_CALM), '当前 3 个宿舍都正常。');
check('★ 平静时的两句以句号收尾（要念出来，得自成一句）',
  [/。$/.test(buildAlert(NOBODY)), /。$/.test(buildAlert(ALL_CALM))], [true, true]);

check('★ 一个异常：念的是「谁、什么状态、持续了多久」',
  buildAlert(ONE), 'dorm-b 偏热已持续 20 分钟。');
check('★ 有趋势就跟着念出来，自成一句',
  buildAlert(trio(calm('2026-09-22 20:00:00'), traced([31, 30]),
    calm('2026-09-22 20:00:00'))),
  'dorm-b 偏热已持续 20 分钟，温度正在下降。');
check('★ 正在处理就念出来（复用 handlingNote，和那一行、事件记录是同一份说法）',
  buildAlert(BUSY), 'dorm-b 偏热已持续 20 分钟（风扇已开启，处理中），温度正在下降。');
/* 念出来是「竖线」两个字，所以语音那一句里绝不能有 ｜ ——
   这正是「两个出口不一样、不能共用一个字符串」的地方。 */
check('★ 语音那句里没有 ｜（念出来是「竖线」）',
  buildAlert(BUSY).includes('｜'), false);

/* 【语音只说结果，不说排序依据】「是目前唯一的异常节点」「持续时间最长」
   那套是 B2 依据的话，写在 report.html 里给人对着表格慢慢看。
   念出来是一串听一遍就过去的字，交代不了「为什么不是别人」。 */
check('★ 不念输赢的理由（不提别的宿舍、不说「唯一」）',
  [buildAlert(ONE).includes('唯一'), buildAlert(TWO).includes('dorm-a'),
    buildAlert(TWO).includes('持续最长')], [false, false, false]);
check('两个都异常时也只念重点那一个，不把两个都念一遍',
  [buildAlert(TWO), buildAlert(TWO).includes('dorm-c')],
  ['dorm-b 偏热已持续 20 分钟。', false]);
check('★ 每次都以句号收尾', /。$/.test(buildAlert(BUSY)), true);

/* ---- 两个出口必须指向同一个人 ---- */

[[TWO, '两个异常'], [FOUR, '四个节点'], [TIE, '时长打平'], [DEAD, '完全并列'],
  [MIXED, '有节点没数据'], [ONE, '一个异常'], [RENAMED, '换过名字'], [ALL_BAD, '三个都不正常'],
  [OUT_OF_ORDER, '键顺序和严重程度不一致'], [BUSY, '正在处理'], [ALL_CALM, '都正常'],
  [NOBODY, '一条数据都没有']]
  .forEach(function (item) {
    const nodes = item[0];
    const label = item[1];
    const pick = pickPriority(nodes);
    const line = buildFocus(nodes);
    const spoken = buildAlert(nodes);

    if (!pick) {
      /* 没有重点时两边都不能凭空造一个出来：说的是同一句平静话，
         只差头尾那点差别（一行不带句号、一句带）。 */
      check('★ [' + label + '] 没有重点时，那一行和语音说的是同一件事',
        [line + '。', spoken], [spoken, spoken]);
      return;
    }

    /* 重点那个宿舍的名字必须出现在两个出口的最前面 ——
       不是「包含」就行：包含的话，「dorm-b 不在重点里但被顺口提了一句」
       也能过。这一行和这一句的开头就是答案本身。 */
    check('★ [' + label + '] 那一行开头就是重点那个宿舍',
      line.indexOf(pick.nodeId), 0);
    check('★ [' + label + '] 语音那句开头也是同一个宿舍',
      spoken.indexOf(pick.nodeId), 0);
    check('★ [' + label + '] 两个出口指向的是 pickPriority 挑出来的那个人',
      [line.indexOf(pick.nodeId), spoken.indexOf(pick.nodeId)], [0, 0]);
  });

/* 【buildAlert 里有一句走不到的话】它拿到 pick 之后又算了一遍 ranked()，
   还判了一次 `list.length === 0`。那一句永远走不到：pickPriority 的实现就是
   「ranked() 空了才返回 null」，所以 pick 非空 ⇒ ranked 非空。
   变异测试杀不掉它（删掉它行为一个字都不变，见 README 的等价变异体），
   所以在这里把**前提**钉住：没有重点的时候，走的必须是 calmLine 那条路，
   绝不能是把 undefined 拼进句子里的那条。 */
[[NOBODY, '一条数据都没有'], [ALL_CALM, '都正常'],
  [trio(calm('2026-09-22 20:00:00'), calm('2026-09-22 20:00:00'), silent()),
    '只收到两个节点的数据']]
  .forEach(function (item) {
    const pick = pickPriority(item[0]);
    const spoken = buildAlert(item[0]);
    check('★ [' + item[1] + '] 没重点时走的是 calmLine 那条路（不是拼出 undefined）',
      [pick, spoken.indexOf('undefined'), /。$/.test(spoken)], [null, -1, true]);
  });

/* ---- 纯函数：不改输入、同样输入同样输出 ---- */

const J_SNAPSHOT = JSON.stringify(FOUR);
buildFocus(FOUR);
buildAlert(FOUR);
tempTrend(FOUR['dorm-b']);
check('★ 三个函数都不改传进来的 nodes（页面那边读的是同一份对象）',
  JSON.stringify(FOUR), J_SNAPSHOT);

/* 这一行和这一句都是**每条报文都重算**的（时长、趋势、处理状态都在变），
   带上任何「当前时间」或随机成分，页面上就会出现某个数字停在某一刻不再动，
   而下面的卡片一直在涨 —— 看着像数据不更新了。 */
check('★ 同样的输入连着算两遍，那一行一字不差',
  [buildFocus(BUSY) === buildFocus(BUSY), buildAlert(BUSY) === buildAlert(BUSY)],
  [true, true]);

/* ---------- K. Step 9-3 进阶项：看板读 ML 结果 ---------- */
console.log('\n=== K. ML 辅助判断（看板这一侧）===');

/* 一份「像 analysis.py 写出来的」JSON。字段名照 report/ml_result.json 抄。
   这里够用就行 —— 那份真文件由 tests/dashboard.test.js 整份读进来跑一遍，
   两处合起来才说明「这函数认得真文件」。 */
function mlJson(over) {
  return Object.assign({
    generatedAt: '2026-09-29 19:45:12',
    historyFile: 'dorm-a_history_sim.csv',
    historyRows: 40,
    historyFlagged: 18,
    newFile: 'new_samples.csv',
    newRows: 6,
    mismatchForward: 2,
    mismatchReverse: 0,
    mismatchTotal: 2,
    text: '历史 40 条里有 18 条被判成「与平时明显不同」；新数据 6 条里，'
      + '固定规则说正常、ML 说不同的有 2 条。',
  }, over);
}
/* 三样东西的键就这三个。页面那边是照着这三个名字取的 ——
   哪天改成 note.sentence 之类，dashboard.js 会静悄悄写上去一个 undefined，
   只有这条能挡住。 */
const KEYS = ['count', 'note', 'text'];

/* ---- 正常那份 ---- */

const note = buildMlNote(mlJson());
check('★ 返回的就是那三样（count / text / note）', Object.keys(note).sort(), KEYS);
check('★ 条数报的是「规则说正常、ML 说不同」那个数',
  note.count, '规则说正常、ML 说不同：2 条');
check('★ 结论那句是从 JSON 里原样搬的（看板不另写一份结论）',
  note.text, mlJson().text);
check('★ 说明里点明了判的是哪一份新数据', note.note.includes('new_samples.csv（6 条）'), true);
check('★ 说明里点明了模型是拿哪一份训练的',
  note.note.includes('dorm-a_history_sim.csv（40 条）'), true);
check('★ 说明里写清了不是实时数据', note.note.includes('不是实时数据'), true);
check('★ 说明里带着那份 JSON 记的时刻',
  note.note.includes('2026-09-29 19:45:12'), true);
/* 这一条是这一段存在的理由：看板上别的数字都在动，这一段不动。
   少了那句「判的不是看板上这些读数」，看的人会把它安到刚收到的温湿度上。 */
check('★ 而且说清了判的不是看板上的实时读数',
  note.note.includes('判的不是看板上这些实时读数'), true);

/* ---- 两个方向分开报 ---- */

check('两个方向都是 0 时说的是「一条都没差」',
  buildMlNote(mlJson({ mismatchForward: 0, mismatchReverse: 0 })).count,
  '规则和 ML 一条都没差');
/* 反向那条不能顺着前一句说成「一条都没差」—— 那是句假话，
   两个方向说的根本不是一回事。 */
check('★ 只有反向时不说「一条都没差」，说的是反向那句',
  buildMlNote(mlJson({ mismatchForward: 0, mismatchReverse: 1 })).count,
  '规则说异常、ML 说正常：1 条');
check('两个方向都有时两句都在，中间分开',
  buildMlNote(mlJson({ mismatchForward: 2, mismatchReverse: 1 })).count,
  '规则说正常、ML 说不同：2 条；规则说异常、ML 说正常：1 条');

/* ---- 只留文件名 ---- */

const longPath = buildMlNote(mlJson({
  historyFile: 'C:\\Users\\xdj\\Desktop\\ml\\dorm-a_history_sim.csv',
  newFile: '/tmp/ml/new_samples.csv',
}));
check('★ 路径只留文件名（那份 JSON 里本来就只有名字，这里再挡一道）',
  [longPath.note.includes('C:\\Users'), longPath.note.includes('/tmp/'),
    longPath.note.includes('dorm-a_history_sim.csv'),
    longPath.note.includes('new_samples.csv')],
  [false, false, true, true]);
/* 两个文件名都要挡：一个给空串，一个给 null（不是字符串）。
   早先这条只断言了新数据那一半，historyFile: null 那一半没人管 ——
   函数里那句 typeof 判断于是可以整个换成 String(value) 还照样绿，
   页面上会印出「拿 null（40 条）训练的」。变异测试把它抓出来了。 */
const blankName = buildMlNote(mlJson({ newFile: '', historyFile: null })).note;
check('文件名给空了就说「那两份文件」，不留一个空括号',
  [blankName.includes('那两份文件（6 条）'),
    blankName.includes('那两份文件（40 条）训练的'),
    blankName.includes('（），'), blankName.includes('null')],
  [true, true, false, false]);
check('文件名只有空格时也算没给（trim 过，不留一格空白）',
  buildMlNote(mlJson({ newFile: '   ' })).note.includes('那两份文件（6 条）'), true);
/* 条数写不出来时说「若干」—— 不能写 0，0 是「一条都没有」的意思。 */
check('条数缺了说「若干」，不说 0',
  buildMlNote(mlJson({ newRows: undefined })).note.includes('（若干 条）'), true);

/* ---- 时刻缺了 ---- */

const noStamp = buildMlNote(mlJson({ generatedAt: '' }));
check('★ 没记时刻时不写「undefined 那次」，说「上一次」',
  [noStamp.note.includes('undefined'), noStamp.note.includes('上一次跑 analysis.py 留下的')],
  [false, true]);

/* ---- 坏数据：一句都不许往外抛 ---- */

const BROKEN = [
  ['null', null], ['undefined', undefined], ['空对象', {}],
  ['少了结论那句', mlJson({ text: '' })], ['结论不是字符串', mlJson({ text: 123 })],
  ['少了那个数', mlJson({ mismatchForward: undefined })],
  ['数是个字符串', mlJson({ mismatchForward: '2' })],
  ['整个是字符串', '{"text":"x"}'], ['整个是数组', [1, 2, 3]],
];
BROKEN.forEach(function (item) {
  let got;
  try { got = buildMlNote(item[1]); } catch (err) { got = 'THREW: ' + err.message; }
  const ok = got && typeof got === 'object' && got.count === '' && typeof got.text === 'string'
    && got.text.indexOf('这一段没跑：') === 0 && got.note === '';
  check('★ [' + item[0] + '] 降级成一句「这一段没跑」，不抛', ok, true);
});
/* 降级那句话里必须是**这三样**都齐的形状，页面才只有一条渲染路径 */
check('降级时三样东西照样齐（页面那边不用分情况）',
  Object.keys(buildMlNote(null)).sort(), KEYS);

/* ---- 读不到那份文件 ---- */

const missing = mlFetchFailed('HTTP 404');
check('★ 读不到时说的话里带着原始原因', missing.text.includes('HTTP 404'), true);
check('★ 也带着「这一段没跑」这个前缀（和报告里那句同一个口径）',
  missing.text.indexOf('这一段没跑：') === 0, true);
check('说明里告诉人怎么办（跑哪个脚本）',
  missing.note.includes('py -3.14 analysis/analysis.py'), true);
check('读不到时条数是空的（不写「0 条」，那看着像「一条都没差」）', missing.count, '');
check('原因取不到时也有句实话，不留个 undefined 在页面上',
  [mlFetchFailed(undefined).text.includes('undefined'),
    mlFetchFailed('   ').text.includes('不知道什么原因')],
  [false, true]);

/* ---- 纯函数：不改输入、同样输入同样输出 ---- */

const K_SNAPSHOT = JSON.stringify(mlJson());
buildMlNote(mlJson());
buildMlNote(mlJson({ text: '' }));
check('★ 两个函数都不改传进来的东西', JSON.stringify(mlJson()), K_SNAPSHOT);
/* 页面只在启动时算一次，但这一条和上面那些一样：纯函数是它的硬约束。
   带上任何时间/随机成分，「这一块是上一次跑脚本的快照」这个说法就不成立了。 */
check('★ 同样输入连着算两遍，三样东西一字不差',
  [JSON.stringify(buildMlNote(mlJson())) === JSON.stringify(buildMlNote(mlJson())),
    mlFetchFailed('x').text === mlFetchFailed('x').text],
  [true, true]);

/* ---------- K2. 按下处理按钮之后那行说明（Step D3 收尾） ---------- */

console.log('\n=== K2. cmdNote：那条指令发给 core 没有 ===');

const okNote = cmdNote(true, '');
/* 发出去的那句必须点明「好没好由后面的报文判」。这是 D3 红线在界面上的那一半：
   按钮只把事件推到处理中，按一下不能等于已恢复。 */
check('★ 发出去时说的是「好没好由后面收到的报文判」',
  [okNote.includes('好没好'), okNote.includes('后面收到的报文'),
    okNote.includes('不结案')],
  [true, true, true]);
check('发出去时这句话里没有「已恢复」这三个字（按一下不是结案）',
  okNote.includes('已恢复'), false);

const badNote = cmdNote(false, '还没连上 broker');
check('★ 发不出去时带着原始原因', badNote.includes('还没连上 broker'), true);
check('★ 发不出去时如实说「core 那边的事件不会变」（这才是要命的那半句）',
  [badNote.includes('只记在页面上'), badNote.includes('core 那边的事件不会变')],
  [true, true]);
check('发不出去时也不说「已恢复」', badNote.includes('已恢复'), false);
check('原因取不到时也有句实话，不留个空括号在页面上',
  [cmdNote(false, undefined).includes('（）'),
    cmdNote(false, undefined).includes('不知道什么原因'),
    cmdNote(false, '   ').includes('不知道什么原因')],
  [false, true, true]);
/* 原样贴出来，不翻译也不加工：「还没连上 broker」和「mqtt.js 没加载」
   是两个排查方向，糊成一句「发送失败」就把线索丢了。 */
check('原因原样贴出来，不加工', cmdNote(false, 'HTTP 500').includes('HTTP 500'), true);
check('纯函数：同样输入连着算两遍一字不差',
  cmdNote(true, '') === cmdNote(true, ''), true);

/* ---------- L. 和 Python 读同一份期望表 ---------- */

console.log('\n=== L. 共用期望表：和 Python 的 rules.py 逐条对齐 ===');

/* 这一段的期望值**不是**在这里写的，是从 tests/fixtures/priority_cases.json
   读的 —— Python 那边的 tests/test_rules_priority.py 读的是同一份。
   两边各写一套测试治不了「改了一边忘了另一边」：两套都绿，
   而它们期望的不是同一件事。

   要跑的东西不一样：那边直接调 rank_priority 拿到整张表，
   这边只有两个对外的口 —— pickPriority（赢家 + 那句理由）和
   buildReasons（一整段话）。所以这边用「整段话里含不含某句、
   几条的相对先后」来钉同一批事实，钉的是**页面上真会出现的字**。 */
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'priority_cases.json');
const fix = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

/* fixture 里给的是秒，这边要的是 time 字符串。换算只在这一处显式做，
   不藏进 fixture —— 一次换算看不懂的时候，第一个该被怀疑的就是单位。 */
const FIX_BASE = '2026-09-22 20:00:00';
const FIX_BASE_MS = parseTime(FIX_BASE);

function pad2(n) { return n < 10 ? '0' + n : String(n); }

/* parseTime 用的是 Date.UTC，这里也照 UTC 拼回来。
   拼成本地时间的话，时区一偏，同一个 360 秒就变成「6 小时」了。 */
function timeAfter(seconds) {
  const d = new Date(FIX_BASE_MS + seconds * 1000);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
    + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
}

function nodesOf(c) {
  const nodes = {};
  c.nodes.forEach(function (n) {
    /* count 为 0 的走正常那条：起点给 null，和页面里维护的正常节点一样 */
    nodes[n.nodeId] = n.count > 0
      ? node(timeAfter(n.durationSec), FIX_BASE, n.count, n.status)
      : node(FIX_BASE, null, 0, n.status);
  });
  return nodes;
}

check('期望表读得到（坏掉的样子是一条都跑不到）', fix.cases.length >= 8, true);

/* ---- 时长说法：同一张表 ---- */
fix.duration.forEach(function (row) {
  check('时长 ' + row.seconds + ' 秒 -> ' + row.expect,
    fmtDuration(row.seconds * 1000), row.expect);
});

/* ---- 每个用例：赢家、赢家的理由、输家各自输在哪、以及先后 ---- */
fix.cases.forEach(function (c) {
  const nodes = nodesOf(c);
  const top = pickPriority(nodes);
  const reason = buildReasons(nodes);

  if (c.order.length === 0) {
    check('★ ' + c.name + '：没有要优先处理的', top, null);
    return;
  }

  const winner = c.order[0];
  check('★ ' + c.name + '：挑出来的是 ' + winner, top.nodeId, winner);

  /* 两边唯一那个故意的差别：pickPriority 的 reason 前面有节点名，
     Python 的 RankedNode.reason 没有。差别在这里被**显式**对上，
     而不是靠 fixture 含糊过去。 */
  check('★ ' + c.name + '：赢家的理由',
    top.reason, winner + ' ' + c.reasons[winner]);

  /* 同一句话在 B2 依据里是「优先关注 X：…」—— 那里名字在冒号前，
     所以理由那半句不带名字。两处都得对。 */
  check('★ ' + c.name + '：依据里那句「优先关注 ' + winner + '：…」',
    reason.includes('优先关注 ' + winner + '：' + c.reasons[winner]), true);

  /* 输家：每一个都要在整段话里，且说的是 fixture 里那句。
     只查「含不含」不够 —— 先后顺序也得对，否则「谁排在谁前面」这件事
     在页面上就是错的，而每条单独看都挑不出毛病。 */
  const losers = c.order.slice(1);
  losers.forEach(function (id) {
    check('★ ' + c.name + '：' + id + ' 输在哪',
      reason.includes(id + ' ' + c.reasons[id]), true);
  });
  for (let i = 0; i + 1 < losers.length; i += 1) {
    check('★ ' + c.name + '：' + losers[i] + ' 排在 ' + losers[i + 1] + ' 前面',
      reason.indexOf(losers[i] + ' ') < reason.indexOf(losers[i + 1] + ' '), true);
  }
});

/* ---- 输入顺序不影响结果（第 4 步存在的唯一理由）---- */
const shuffled = fix.cases.filter(function (c) {
  return c.name.indexOf('与数据到达顺序无关') >= 0;
})[0];
check('期望表里有那条「顺序无关」的用例', Boolean(shuffled), true);
if (shuffled) {
  const forward = nodesOf(shuffled);
  const backward = nodesOf({ nodes: shuffled.nodes.slice().reverse() });
  check('★ 同一份数据倒着喂，挑出来的人和理由一字不差',
    [pickPriority(forward).nodeId === pickPriority(backward).nodeId,
      pickPriority(forward).reason === pickPriority(backward).reason],
    [true, true]);
}

/* ---- logic.js 里也不许写死节点名 ---- */
/* 和 Python 那边同一个checker思路，只是 JS 没有文档字符串，
   要摘的只有注释：块注释和行注释。 */
const logicCode = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
check('★ logic.js 的代码里不出现任何具体节点名（注释里的例子不算）',
  /dorm-/.test(logicCode), false);

console.log(`\n结果：${pass} 通过，${fail} 不通过`);
process.exit(fail === 0 ? 0 : 1);
