'use strict';

/* shared/rules.js 的回归测试。纯 Node，不需要 DOM，也不需要装任何依赖：
 *
 *   node tests/rules.test.js
 *
 * 这是 JS 侧规则的把关点 —— 以后 Dashboard / 3D 都从这里取规则，
 * 所以这里必须和 Python 侧（tests/test_status_rules.py）用同一批数据。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RULES = path.join(__dirname, '..', 'shared', 'rules.js');
const src = fs.readFileSync(RULES, 'utf8');

vm.runInThisContext(src, { filename: RULES });

const judgeStatus = globalThis.judgeStatus;
const getAdvice = globalThis.getAdvice;
const runRegressionTests = globalThis.runRegressionTests;

/* ---------- 断言 ---------- */

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
}

/* ---------- 1. judgeStatus：约定的 9 条数据 ---------- */

const cases = [
  // 回归数据
  [25, 60, '正常'], [16, 60, '偏冷'], [31, 60, '偏热'], [25, 80, '偏湿'],
  // 边界数据
  [18, 60, '正常'], [30, 60, '偏热'], [29, 75, '偏湿'], [17.9, 80, '偏冷'], [31, 80, '偏热'],
];

cases.forEach(([t, h, want]) => {
  const got = judgeStatus(t, h);
  check(`judgeStatus ${t}/${h} -> ${want}`, got === want, `得到 ${got}`);
});

/* 额外补的优先级与边界，防止以后有人把顺序写反 */
[
  [17.9, 60, '偏冷'], [18, 90, '偏湿'], [29.9, 90, '偏湿'],
  [10, 90, '偏冷'], [0, 60, '偏冷'], [100, 100, '偏热'], [25, 74.9, '正常'],
].forEach(([t, h, want]) => {
  const got = judgeStatus(t, h);
  check(`judgeStatus 补充 ${t}/${h} -> ${want}`, got === want, `得到 ${got}`);
});

/* ---------- 2. getAdvice ---------- */

const adviceCases = [
  ['偏冷', '注意保暖，可关窗'],
  ['偏热', '注意通风，可开风扇'],
  ['偏湿', '开窗通风或除湿'],
  ['正常', '环境良好，保持即可'],
];

adviceCases.forEach(([status, want]) => {
  const got = getAdvice(status);
  check(`getAdvice('${status}')`, got === want, JSON.stringify(got));
});

// 四个状态都要有建议，不能漏
check('四个状态都有建议（无空串）',
  adviceCases.every(([s]) => getAdvice(s).length > 0));

// 未知状态给占位，而不是静默返回空串
check("getAdvice 对未知状态返回「暂无建议」",
  getAdvice('乱七八糟') === '暂无建议', JSON.stringify(getAdvice('乱七八糟')));

/* ---------- 3. runRegressionTests：表格内容与汇总 ---------- */

const printed = [];
const realTable = console.table;
const realLog = console.log;
console.table = (rows) => printed.push(rows);
console.log = () => {};
let summary;
try {
  summary = runRegressionTests();
} finally {
  console.table = realTable;
  console.log = realLog;
}

check('runRegressionTests 覆盖 9 条', summary.total === 9, `total=${summary.total}`);
check('runRegressionTests 全部通过', summary.failed === 0 && summary.passed === 9,
  `passed=${summary.passed} failed=${summary.failed}`);
check('runRegressionTests 调用了 console.table', printed.length === 1,
  `console.table 调用次数=${printed.length}`);

const rows = summary.rows;
check('每行都有 期望/实际/是否通过 三列',
  rows.every((r) => '期望' in r && '实际' in r && '是否通过' in r),
  JSON.stringify(Object.keys(rows[0] || {})));
check('每行都带输入值，方便对不上时定位',
  rows.every((r) => '温度' in r && '湿度' in r));
check('表格里的判定与 judgeStatus 一致',
  rows.every((r) => r.实际 === judgeStatus(r.温度, r.湿度)));

/* ---------- 4. 约束：普通 script、全局函数、不碰 DOM ---------- */

// 先剥掉注释再查语法：否则注释里出现的「export」「DOM」这些词
// 会把检查自己变成假失败（这类误报踩过两次了）。
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
  .replace(/^\s*\/\/.*$/gm, '');      // 整行的行注释

check('不操作 DOM（没有 document / window 引用）',
  !/\bdocument\b/.test(code) && !/\bwindow\b/.test(code),
  '在 rules.js 里发现了 document/window');
check('不用 export / module.exports（普通 script 引入）',
  !/\bexport\b/.test(code) && !code.includes('module.exports'),
  '出现了 export 语法');
check('挂了三个全局函数',
  typeof judgeStatus === 'function'
  && typeof getAdvice === 'function'
  && typeof runRegressionTests === 'function');

/* ---------- 报告 ---------- */

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed++;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '   -> ' + c.detail}`);
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);
