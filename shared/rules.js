'use strict';

/* DormMate 统一规则（JS 侧唯一实现）
 *
 * 普通 <script> 引入，挂三个全局函数，不用 export。
 * 不依赖也不操作 DOM —— 网页看板、后续的 Dashboard 和 3D 场景共用这一份，
 * 任何地方都不要再把规则抄一遍。
 *
 * 另一份实现是 Python 侧的 status_rules.py（发布端用）。两边规则必须一致：
 * 改任何一边都要同步另一边，并各自跑回归：
 *     python -m unittest discover -s tests -t .    # Python 侧
 *     node tests/rules.test.js                     # JS 侧
 *
 * 为什么整个文件包在 IIFE 里：这里是经典 script，顶层 const 会和其它
 * script 共用同一个全局词法作用域。比如本文件和 web/script.js 都有
 * 自己的常量，直接写顶层 const 一旦重名，整个页面会直接 SyntaxError。
 * 包起来后内部名字都是函数作用域，只把三个函数显式挂到全局。
 */
(function (global) {
  /* 状态取值 */
  const COLD = '偏冷';
  const HOT = '偏热';
  const HUMID = '偏湿';
  const NORMAL = '正常';

  /* 状态 -> 建议 */
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

  /* 回归 + 边界用例。[温度, 湿度, 期望状态] */
  const CASES = [
    // 老师给的回归数据
    [25, 60, NORMAL, '回归'],
    [16, 60, COLD, '回归'],
    [31, 60, HOT, '回归'],
    [25, 80, HUMID, '回归'],
    // 边界：阈值取等号的行为
    [18, 60, NORMAL, '边界'],   // 18 不算 < 18
    [30, 60, HOT, '边界'],      // 30 算 >= 30
    [29, 75, HUMID, '边界'],    // 温度没到 30，湿度规则才轮到
    [17.9, 80, COLD, '边界'],   // 冷优先于湿
    [31, 80, HOT, '边界'],      // 热优先于湿（约定里点名的坑）
  ];

  /**
   * 跑一遍回归 + 边界用例，在 Console 打印表格。
   *
   * @returns {{total: number, passed: number, failed: number, rows: object[]}}
   */
  function runRegressionTests() {
    const rows = CASES.map(function (item) {
      const temperature = item[0];
      const humidity = item[1];
      const expected = item[2];
      const actual = judgeStatus(temperature, humidity);
      return {
        组别: item[3],
        温度: temperature,
        湿度: humidity,
        期望: expected,
        实际: actual,
        是否通过: actual === expected ? '通过' : '不通过',
      };
    });

    const failed = rows.filter(function (r) { return r.是否通过 !== '通过'; }).length;
    const summary = { total: rows.length, passed: rows.length - failed, failed, rows };

    if (typeof console !== 'undefined' && console.table) {
      console.table(rows);
    }
    console.log(
      '[DormMate] 规则回归：' + summary.passed + '/' + summary.total + ' 通过'
      + (failed > 0 ? '，' + failed + ' 条不通过（判错的那几行见上表）' : ''),
    );

    return summary;
  }

  global.judgeStatus = judgeStatus;
  global.getAdvice = getAdvice;
  global.runRegressionTests = runRegressionTests;
}(typeof globalThis !== 'undefined' ? globalThis : this));
