// tests/miniapp-rules.test.js
// 校验 miniapp/utils/rules.js 和 shared/rules.js 是同一套规则。
//
// 为什么值得单独测：判定规则在项目里有三份实现 ——
//   shared/rules.js          网页看板
//   miniapp/utils/rules.js   小程序（抄的：打包根目录是 miniapp/，引用不到 shared/）
//   status_rules.py          Python 发布端
// 抄出来的那份会漂移：改了一边忘了另一边，小程序和网页就会对同一个宿舍给出不同
// 结论。这种错不报异常、不写日志，只是安静地显示一个错的徽章 —— 所以必须专门
// 盯住。这个文件就是用来在漂移时喊一声的。
//
// 跑法：node tests/miniapp-rules.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const WEB_FILE = path.join(ROOT, 'shared', 'rules.js');
const MINI_FILE = path.join(ROOT, 'miniapp', 'utils', 'rules.js');

/* 两份实现的导出方式不同，是各自环境逼出来的，所以各起一个 vm 上下文加载：
   shared/rules.js 是经典 <script>，包在 IIFE 里把函数挂到 globalThis；
   miniapp/utils/rules.js 是 CommonJS，往 module.exports 上挂。 */
function loadWeb() {
  const context = { console };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(WEB_FILE, 'utf8'), context, { filename: WEB_FILE });
  return { judgeStatus: context.judgeStatus, getAdvice: context.getAdvice };
}

function loadMini() {
  const module = { exports: {} };
  const context = { module, exports: module.exports, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(MINI_FILE, 'utf8'), context, { filename: MINI_FILE });
  return module.exports;
}

const web = loadWeb();
const mini = loadMini();

/* ---------- 断言 ---------- */

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? `  =>  ${a}` : `\n        实际: ${a}\n        期望: ${e}`));
}

/* ---------- A. 两份都真的导出了函数 ---------- */

console.log('\n=== A. 导出形状 ===');
check('网页版导出 judgeStatus', typeof web.judgeStatus, 'function');
check('网页版导出 getAdvice', typeof web.getAdvice, 'function');
check('小程序版导出 judgeStatus', typeof mini.judgeStatus, 'function');
check('小程序版导出 getAdvice', typeof mini.getAdvice, 'function');

/* ---------- B. 约定里的回归数据 ---------- */

console.log('\n=== B. 回归数据（老师给的四条）===');
const REGRESSION = [
  [25, 60, '正常'],
  [16, 60, '偏冷'],
  [31, 60, '偏热'],
  [25, 80, '偏湿'],
];

REGRESSION.forEach(function (row) {
  const t = row[0];
  const h = row[1];
  const expected = row[2];
  check(`${t}℃/${h}% -> ${expected}（小程序）`, mini.judgeStatus(t, h), expected);
  check(`${t}℃/${h}% -> ${expected}（网页）`, web.judgeStatus(t, h), expected);
});

/* ---------- C. 边界：阈值取不取等号 ---------- */

console.log('\n=== C. 边界 ===');
const BOUNDARY = [
  [18, 60, '正常', '18 不算 < 18'],
  [17.9, 60, '偏冷', '刚好差一点点到 18'],
  [30, 60, '偏热', '30 算 >= 30'],
  [29.9, 60, '正常', '差一点点到 30，湿度也不够'],
  [29.9, 75, '偏湿', '温度没到 30，才轮到湿度规则'],
  [29.9, 74.9, '正常', '湿度也差一点点'],
  [17.9, 80, '偏冷', '冷优先于湿'],
  [31, 80, '偏热', '热优先于湿（约定里点名的坑）'],
  [31, 100, '偏热', '极端湿度也不改温度结论'],
  [16, 90, '偏冷', '又冷又湿 -> 冷'],
];

BOUNDARY.forEach(function (row) {
  check(`${row[0]}℃/${row[1]}% -> ${row[2]}（${row[3]}）`, mini.judgeStatus(row[0], row[1]), row[2]);
  check(`${row[0]}℃/${row[1]}% 两边一致`, mini.judgeStatus(row[0], row[1]) === web.judgeStatus(row[0], row[1]), true);
});

/* ---------- D. 网格对拍：两份实现在每一点上结论必须相同 ---------- */

console.log('\n=== D. 网格对拍 ===');
const TEMP_START = -20;
const TEMP_STEP = 0.5;
const TEMP_COUNT = 161;   // -20 .. 60
const HUM_STEP = 2;
const HUM_COUNT = 51;     // 0 .. 100

let pairs = 0;
let mismatches = [];
for (let i = 0; i < TEMP_COUNT; i += 1) {
  /* 用 i * step 而不是累加，避免浮点误差越滚越大 */
  const t = TEMP_START + i * TEMP_STEP;
  for (let j = 0; j < HUM_COUNT; j += 1) {
    const h = j * HUM_STEP;
    pairs += 1;
    const a = mini.judgeStatus(t, h);
    const b = web.judgeStatus(t, h);
    if (a !== b) mismatches.push({ t, h, mini: a, web: b });
  }
}

console.log(`  对拍了 ${pairs} 组温度/湿度`);
check('两份实现结论完全一致', mismatches.length, 0);
if (mismatches.length > 0) {
  console.log('  头几条不一致的：');
  mismatches.slice(0, 10).forEach(function (m) {
    console.log(`    ${m.t}℃/${m.h}%  小程序=${m.mini}  网页=${m.web}`);
  });
}

/* 顺带确认这个网格真的把四个状态都覆盖到了 —— 否则「全一致」可能只是因为
   全落在同一个分支里，没测到东西。 */
const seen = {};
for (let i = 0; i < TEMP_COUNT; i += 1) {
  const t = TEMP_START + i * TEMP_STEP;
  for (let j = 0; j < HUM_COUNT; j += 1) {
    seen[web.judgeStatus(t, j * HUM_STEP)] = true;
  }
}
check('网格覆盖到了全部四个状态', Object.keys(seen).sort(), ['偏冷', '偏热', '偏湿', '正常'].sort());

/* ---------- E. 建议文案 ---------- */

console.log('\n=== E. 建议文案 ===');
const STATUSES = ['偏冷', '偏热', '偏湿', '正常'];
STATUSES.forEach(function (s) {
  check(`「${s}」两边建议逐字相同`, mini.getAdvice(s) === web.getAdvice(s), true);
  check(`「${s}」建议非空`, mini.getAdvice(s).length > 0, true);
});
check('四个状态的建议互不相同', new Set(STATUSES.map(function (s) { return mini.getAdvice(s); })).size, 4);
check('未知状态两边都给「暂无建议」', mini.getAdvice('随便什么') === web.getAdvice('随便什么')
  && mini.getAdvice('随便什么') === '暂无建议', true);

/* ---------- F. 建议表和判定结果对得上 ---------- */

console.log('\n=== F. 判定 -> 建议 串起来 ===');
REGRESSION.forEach(function (row) {
  const status = mini.judgeStatus(row[0], row[1]);
  check(`${row[0]}℃/${row[1]}% 的 status 能查到建议`, mini.getAdvice(status) !== '暂无建议', true);
});

console.log(`\n结果：${pass} 通过，${fail} 不通过`);
process.exit(fail === 0 ? 0 : 1);
