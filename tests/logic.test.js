// tests/logic.test.js
// 校验 dashboard/logic.js —— 「优先关注」的算法（Step 7-1）。
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

check('★ 导出清单正好是这五个（多一个少一个都要在这里说清楚）',
  EXPORTS.join(','), 'parseTime,fmtDuration,abnormalDuration,nextAbnormal,pickPriority');
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

const { parseTime, fmtDuration, abnormalDuration, nextAbnormal, pickPriority } = context;

check('五个函数都拿得到', [parseTime, fmtDuration, abnormalDuration, nextAbnormal, pickPriority]
  .map((f) => typeof f), ['function', 'function', 'function', 'function', 'function']);

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

console.log(`\n结果：${pass} 通过，${fail} 不通过`);
process.exit(fail === 0 ? 0 : 1);
