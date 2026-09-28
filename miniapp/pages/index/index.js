// index.js
// 规则从 utils/rules.js 来。小程序用 CommonJS，路径是相对于本文件算的：
// pages/index/index.js -> ../../utils/rules.js
const { judgeStatus, getAdvice } = require('../../utils/rules.js');

/* 手动录入的合理范围，闭区间（端点值算合法）。
   和 web/script.js 里的 RANGE 保持一致，改一边记得改另一边。 */
const RANGE = {
  tempMin: -20,
  tempMax: 60,
  humMin: 0,
  humMax: 100,
};

/**
 * 校验失败时的统一返回形状，调用方只看 ok 和 message。
 * 和 web/script.js 的 invalid() 一样，多带两个 null 是为了让成功和失败
 * 两条路径的返回结构长得一样，取字段时不用先判断有没有。
 */
function invalid(message) {
  return { ok: false, message, temperature: null, humidity: null };
}

/**
 * 校验两个输入框的文本。
 *
 * 判断顺序不能调换：
 *   1) 空值 —— 必须第一个判。Number('') 的结果是 0 而不是 NaN，
 *      少这一步的话，空输入会被当成 0℃ 一路走下去。
 *   2) 非数字 —— Number.isNaN 只对真正的 NaN 返回 true，
 *      所以要先把文本转成数字再判断。
 *   3) 合理范围 —— 闭区间，端点算合法。
 *
 * 为什么 type="digit" 了还要校验：type 只影响弹出哪个键盘，管不住粘贴，
 * 开发者工具里更是能直接敲字母。输入端过滤不掉的，只能在提交时拦。
 *
 * @param {string} tempText 温度输入框的原始文本
 * @param {string} humText  湿度输入框的原始文本
 * @returns {{ok: boolean, message: string,
 *            temperature: number|null, humidity: number|null}}
 */
function validateInput(tempText, humText) {
  // 全角空格（U+3000）也在 trim 的范围内，所以先 trim 再比空。
  // 用 `== null` 而不是 `??`：小程序的 babel 对空值合并运算符支持不稳，
  // 而 `== null` 同时盖住 undefined 和 null，是等价的写法。
  const tempStr = String(tempText == null ? '' : tempText).trim();
  const humStr = String(humText == null ? '' : humText).trim();

  if (tempStr === '' || humStr === '') {
    return invalid('请输入温度/湿度');
  }

  const temperature = Number(tempStr);
  const humidity = Number(humStr);

  if (Number.isNaN(temperature) || Number.isNaN(humidity)) {
    return invalid('请输入数字');
  }

  const problems = [];
  if (temperature < RANGE.tempMin || temperature > RANGE.tempMax) {
    problems.push(`温度超出合理范围（${RANGE.tempMin}~${RANGE.tempMax}℃）`);
  }
  if (humidity < RANGE.humMin || humidity > RANGE.humMax) {
    problems.push(`湿度超出合理范围（${RANGE.humMin}~${RANGE.humMax}%）`);
  }
  if (problems.length > 0) {
    return invalid(problems.join('；'));
  }

  return { ok: true, message: '', temperature, humidity };
}

// 注意：本模板生成的原始文件用的是 Component({ ... })，不是 Page({ ... })。
// 两种写法在微信里都能当页面用，data 和 setData 完全一样，差别只在最外层
// 那个词。这一步按约定用 Page；若模拟器报错，把 Page 换成 Component 即可，
// 下面一个字都不用动。
Page({
  data: {
    // 输入框的原始文本，跟着 e.detail.value 走（永远是字符串）
    tempInput: '',
    humInput: '',

    // 分析结果。初始为空，onAnalyze 成功后才写入；
    // WXML 里用 wx:if="{{status}}" 控制结果卡片显不显示。
    temperature: null,
    humidity: null,
    status: '',
    advice: '',

    // 校验不通过时的提示，成功时清空
    error: '',
  },

  /**
   * 温度输入。只存原始文本，不在这里转数字 —— 边输边转的话，
   * 用户刚敲下 "-" 或 "1." 这种中间状态会被立刻判成非法，输入体验很差。
   * 转换和校验都推迟到 onAnalyze。
   */
  onTempInput(e) {
    this.setData({ tempInput: e.detail.value });
  },

  onHumInput(e) {
    this.setData({ humInput: e.detail.value });
  },

  /**
   * 点「分析环境」：先校验，再判定，最后一次 setData。
   */
  onAnalyze() {
    const result = validateInput(this.data.tempInput, this.data.humInput);

    if (!result.ok) {
      // 校验没过：清掉上一次的结果，只留错误提示。
      // 把 status 置空是有意的 —— 否则改坏输入再点分析，屏幕上还挂着
      // 上一次的结论，看着像是新算出来的。
      this.setData({
        error: result.message,
        temperature: null,
        humidity: null,
        status: '',
        advice: '',
      });
      return;
    }

    const status = judgeStatus(result.temperature, result.humidity);
    const advice = getAdvice(status);

    this.setData({
      error: '',
      temperature: result.temperature,
      humidity: result.humidity,
      status,
      advice,
    });
  },
});
