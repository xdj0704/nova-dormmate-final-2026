// utils/rules.js
// 小程序侧的规则实现，判定逻辑与 shared/rules.js 完全一致。
//
// 为什么必须抄一份：小程序的代码根目录就是 miniapp/（project.config.json 里
// 没配 miniprogramRoot），打包时只收这个目录里的文件，所以 ../shared/rules.js
// 根本进不了包。小程序也没有 <script> 标签，只能用 CommonJS 的 require。
//
// 和 shared/rules.js 的两处写法差异，都是环境逼的，不是逻辑变了：
//   1) 那边整个文件包在 IIFE 里、把函数挂到 global 上 —— 因为它是经典
//      <script>，顶层 const 会和别的 script 共用同一个全局词法作用域。
//      小程序里每个文件天然就是一个模块，作用域是隔离的，不需要 IIFE，
//      用 module.exports 导出就行。
//   2) 那边用 Number.isNaN 之类的判断都在调用方（script.js），这边同理，
//      校验不放在这里。
//
// 改这个文件之前先看一眼 shared/rules.js 顶部的约定：规则现在有
// 三处实现 —— shared/rules.js（网页）、status_rules.py（Python 发布端）、
// 本文件（小程序）。三边必须一致，改一处就要同步另外两处。
'use strict';

/* 状态取值 */
const COLD = '偏冷';
const HOT = '偏热';
const HUMID = '偏湿';
const NORMAL = '正常';

/* 状态 -> 建议。文案和 shared/rules.js 里的 ADVICE 逐字相同 */
const ADVICE = {
  [COLD]: '注意保暖，可关窗',
  [HOT]: '注意通风，可开风扇',
  [HUMID]: '开窗通风或除湿',
  [NORMAL]: '环境良好，保持即可',
};

/**
 * 统一状态判定。顺序严格照约定，命中即停：
 *   1) temperature <  18  -> 偏冷
 *   2) temperature >= 30  -> 偏热
 *   3) humidity    >= 75  -> 偏湿
 *   4) 其余               -> 正常
 *
 * 顺序不能调换：31℃/80% 是「偏热」而不是「偏湿」，因为温度规则先命中。
 *
 * @param {number} temperature 温度（℃）
 * @param {number} humidity    湿度（%）
 * @returns {string} "偏冷" | "偏热" | "偏湿" | "正常"
 */
function judgeStatus(temperature, humidity) {
  if (temperature < 18) return COLD;
  if (temperature >= 30) return HOT;
  if (humidity >= 75) return HUMID;
  return NORMAL;
}

/**
 * 按状态给一句建议。传入 judgeStatus 的四个取值之外的字符串时返回
 * 「暂无建议」——宁可显示一句占位，也不要静默给空字符串。
 *
 * @param {string} status judgeStatus 的返回值
 * @returns {string}
 */
function getAdvice(status) {
  return ADVICE[status] || '暂无建议';
}

module.exports = {
  judgeStatus,
  getAdvice,
};
