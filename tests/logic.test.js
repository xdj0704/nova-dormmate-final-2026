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

check('★ 导出清单正好是这十一个（多一个少一个都要在这里说清楚）',
  EXPORTS.join(','),
  'parseTime,fmtDuration,abnormalDuration,nextAbnormal,beginHandling,nextHandling,'
  + 'beginEvent,markPriority,markAction,closeEvent,pickPriority');
/* ACTION_FAN 刻意**不**导出：它是「按钮按下之后 action 记什么名字」的唯一一份，
   只该由 logic.js 自己写进返回值。导出的话，dashboard 那边就可能有人
   自己拼一个字符串塞进卡片，页面上就会出现两个说法不一样的名字。 */
check('★ ACTION_FAN 不导出（那串字只该从 logic.js 里出来一份）',
  EXPORTS.includes('ACTION_FAN'), false);
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
  nextHandling, beginEvent, markPriority, markAction, closeEvent, pickPriority } = context;

check('十一个函数都拿得到', [parseTime, fmtDuration, abnormalDuration, nextAbnormal,
  beginHandling, nextHandling, beginEvent, markPriority, markAction, closeEvent,
  pickPriority].map((f) => typeof f),
['function', 'function', 'function', 'function', 'function', 'function',
  'function', 'function', 'function', 'function', 'function']);

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
  byCount.reason, 'dorm-b 已连续偏热 6 分钟（3 次），持续时间和 dorm-a 一样长，异常次数最多');

/* 场景三：全都一样，按名字 */
const byName = pickPriority(three(
  node('2026-09-22 20:06:00', '2026-09-22 20:00:00', 3, '偏冷'),
  node('2026-09-22 20:06:00', '2026-09-22 20:00:00', 3, '偏热'),
  node('2026-09-22 20:06:00', '2026-09-22 20:00:00', 3, '偏湿')));
check('★ 完全并列时按字母顺序，dorm-a 在前', byName.nodeId, 'dorm-a');
check('★ 尾巴如实说要按名字排了',
  byName.reason, 'dorm-a 已连续偏冷 6 分钟（3 次），和 dorm-b 完全并列，按节点名顺序排在前面');

/* 第 3 步要的是**固定的码元序**，不是跟着运行环境走的本地化排序。
   dorm-a / dorm-b / dorm-c 上这两种排法碰巧答案一样，所以上面那条测不出区别，
   得挑一对能把它们分开的名字：码元序里 'B'(0x42) < 'a'(0x61)，
   本地化排序先比字母再比大小写，'a' 反而排在 'B' 前面。 */
const byCodeUnit = pickPriority({
  'dorm-a': node('2026-09-22 20:06:00', '2026-09-22 20:00:00', 3, '偏冷'),
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
check('★ 键的顺序反过来，结果一模一样（完全并列时靠名字定序）',
  [reverse.nodeId, reverse.reason], [forward.nodeId, forward.reason]);
check('倒序之后仍然是 dorm-a（不是「谁先被遍历到就是谁」）', reverse.nodeId, 'dorm-a');

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

console.log(`\n结果：${pass} 通过，${fail} 不通过`);
process.exit(fail === 0 ? 0 : 1);
