'use strict';

/* web/script.js 的回归测试（纯 Node，不需要装任何依赖）。
 *
 *   node tests/script.test.js
 *
 * 做法：用一个最小 DOM 桩把**真实的** script.js 加载进来，
 * 直接调用它的 validateInput / exportCSV / analyze，
 * 而不是另写一份等价逻辑 —— 否则测的是我抄的版本，不是线上那份。
 *
 * 规则函数（judgeStatus / getAdvice）来自 shared/rules.js，
 * 所以要按 index.html 的顺序先加载它，单独测规则见 tests/rules.test.js。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'web');
const SCRIPT = path.join(WEB, 'script.js');
const HTML = path.join(WEB, 'index.html');
const RULES = path.join(__dirname, '..', 'shared', 'rules.js');

/* ---------- DOM 桩 ---------- */

function stubEl() {
  const listeners = {};
  return {
    value: '', textContent: '', innerHTML: '', className: '', hidden: false,
    disabled: false, src: '',
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, handler) {
      (listeners[type] || (listeners[type] = [])).push(handler);
    },
    /* 测试里手动触发，模拟用户点击 */
    fire(type, event = {}) {
      (listeners[type] || []).forEach((handler) => handler(event));
    },
    dataset: {},
  };
}

const els = {};
const clicks = [];
let capturedBlob = null;

/* script.js 顶部会读 location.hostname 拼 broker 地址。
   桩里给 localhost，等价于"在本机浏览器里打开"。 */
global.location = { hostname: 'localhost' };

/* 快照用的 canvas 桩：记下宽高和 drawImage 的参数，
   这样能验"画布是按视频原始像素开的、画的是整个画面"。 */
let lastCanvas = null;

function canvasStub() {
  const canvas = {
    width: 0, height: 0, drawCalls: [],
    getContext: () => ({ drawImage: (...args) => canvas.drawCalls.push(args) }),
    toDataURL: (type) => `data:${type};base64,STUB`,
  };
  lastCanvas = canvas;
  return canvas;
}

global.document = {
  getElementById: (id) => (els[id] || (els[id] = stubEl())),
  createElement: (tag) => {
    if (tag === 'canvas') return canvasStub();
    return {
      href: '', download: '',
      click() { clicks.push({ href: this.href, download: this.download }); },
    };
  },
  body: { appendChild() {}, removeChild() {} },
  documentElement: { dataset: {} },
};

/* ---------- 摄像头桩 ----------

   getUserMedia 的行为按测试需要切换：
     'ok'   正常给一条视频流
     'deny' 权限被拒（NotAllowedError）
     'none' 没有摄像头设备（NotFoundError）
     'off'  navigator.mediaDevices 根本不存在 —— 非安全上下文或老浏览器

   每条流的 track 都记着 stop() 的调用，用来验"关摄像头时真的把轨道停了"：
   只把 srcObject 置空的话，摄像头指示灯会一直亮着。 */
let lastConstraints = null;
let lastStream = null;

function fakeStream() {
  const stopped = [];
  const tracks = [{ kind: 'video', stop() { stopped.push('video'); } }];
  return { tracks, stopped, getTracks: () => tracks };
}

function installMediaDevices(mode) {
  const value = mode === 'off' ? {} : {
    mediaDevices: {
      getUserMedia(constraints) {
        lastConstraints = constraints;
        if (mode === 'ok') {
          lastStream = fakeStream();
          return Promise.resolve(lastStream);
        }
        const err = new Error(mode === 'deny' ? 'Permission denied' : 'device not found');
        err.name = mode === 'deny' ? 'NotAllowedError' : 'NotFoundError';
        return Promise.reject(err);
      },
    },
  };
  /* Node 21+ 自带的 navigator 是只读的，直接赋值在严格模式下会抛，
     所以用 defineProperty 整个换掉。 */
  Object.defineProperty(globalThis, 'navigator', {
    value, configurable: true, writable: true,
  });
}

/* ---------- 语音识别桩 ----------

   window.SpeechRecognition 换成假的构造函数。new 出来的实例记下
   lang / continuous，start() 会立刻回调 onstart（真浏览器也是这样），
   测试再手动 say() / fail() 模拟"识别到了什么"和"出了什么错"。

   supported=false 时两个前缀都不挂，等价于不支持的浏览器。 */
let lastRecognition = null;

function fakeRecognition() {
  return {
    lang: '', continuous: true, interimResults: true,
    started: 0, aborted: 0,
    onstart: null, onresult: null, onerror: null, onend: null,
    start() { this.started += 1; if (this.onstart) this.onstart(); },
    stop() {},
    abort() { this.aborted += 1; if (this.onend) this.onend(); },
    /* 模拟"识别出一句话"，然后会话结束 */
    say(text) {
      if (this.onresult) {
        this.onresult({ resultIndex: 0, results: [[{ transcript: text }]] });
      }
      if (this.onend) this.onend();
    },
    /* 模拟"识别失败" */
    fail(code) {
      if (this.onerror) this.onerror({ error: code });
      if (this.onend) this.onend();
    },
  };
}

function installSpeechRecognition(supported) {
  lastRecognition = null;
  const Ctor = supported
    ? function SpeechRecognitionStub() {
      lastRecognition = fakeRecognition();
      return lastRecognition;   // 构造函数返回对象时，new 的结果就是它
    }
    : undefined;
  for (const key of ['SpeechRecognition', 'webkitSpeechRecognition']) {
    Object.defineProperty(global.window, key, {
      value: Ctor, configurable: true, writable: true,
    });
  }
}

installMediaDevices('ok');
/* window 上的事件也要能挂：script.js 在 pagehide 时关摄像头。
   记下来是为了测试能手动触发（见「离开页面会关摄像头」那条）。 */
const windowListeners = {};
function fireWindow(type) {
  (windowListeners[type] || []).forEach((handler) => handler());
}

global.window = {
  matchMedia: () => ({ matches: false }),
  // 默认当作本机 localhost 打开（安全上下文）。测局域网 http 时临时改成 false
  isSecureContext: true,
  addEventListener(type, handler) {
    (windowListeners[type] || (windowListeners[type] = [])).push(handler);
  },
};
global.localStorage = { getItem: () => null, setItem() {} };
global.URL.createObjectURL = (blob) => { capturedBlob = blob; return 'blob:fake-url'; };
global.URL.revokeObjectURL = () => {};

/* ---------- 语音合成桩（Step 3-3） ----------

   window.speechSynthesis 换成假的：speak() 只把 utterance 记下来（不真念），
   cancel() 数次数。utterance 上的 fireError(code) 模拟"念到一半出错"——
   真浏览器走的是它的 onerror 回调。

   三种模式，对应"浏览器支持到什么程度"：
     'ok'      speechSynthesis 和 SpeechSynthesisUtterance 都在
     'partial' 只有前者，没有那个构造函数（Chrome 上这两个是分开的两样东西）
     'off'     两个都没有

   默认装 'ok'（和上面 installMediaDevices('ok') 一个道理）：3-2 那批测的是
   **识别**，不该被"这台浏览器支不支持合成"干扰。 */
let spokenTexts = [];
let cancelCount = 0;

function fakeUtterance(text) {
  return {
    text, lang: '',
    onerror: null,
    fireError(code) { if (this.onerror) this.onerror({ error: code }); },
  };
}

function installSpeechSynthesis(mode) {
  spokenTexts = [];
  cancelCount = 0;
  const synth = {
    speak(u) { spokenTexts.push(u); },
    cancel() { cancelCount += 1; },
  };
  const Ctor = mode === 'ok'
    ? function UtteranceStub(text) { return fakeUtterance(text); }
    : undefined;
  Object.defineProperty(global.window, 'speechSynthesis', {
    value: mode === 'off' ? undefined : synth, configurable: true, writable: true,
  });
  Object.defineProperty(global.window, 'SpeechSynthesisUtterance', {
    value: Ctor, configurable: true, writable: true,
  });
}

installSpeechSynthesis('ok');

// 顺序同 index.html：先 rules.js，再 script.js
vm.runInThisContext(fs.readFileSync(RULES, 'utf8'), { filename: RULES });
vm.runInThisContext(fs.readFileSync(SCRIPT, 'utf8'), { filename: SCRIPT });

/* 只在这一个 VM 上下文里求值，方便拿到 script.js 内部的绑定 */
const run = (code) => vm.runInThisContext(code);

/* ---------- 断言 ---------- */

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
}

/* ---------- 1. validateInput ---------- */

const cases = [
  // [温度文本, 湿度文本, 期望 ok, 期望 message 里包含]
  ['', '60', false, '请输入温度/湿度'],
  ['25', '', false, '请输入温度/湿度'],
  ['', '', false, '请输入温度/湿度'],
  ['   ', '60', false, '请输入温度/湿度'],          // 纯空格算空
  ['abc', '60', false, '请输入数字'],
  ['25', 'x', false, '请输入数字'],
  ['1e3', '60', false, '温度超出合理范围'],          // 1000 是数字，但超范围
  ['-20.1', '60', false, '温度超出合理范围'],
  ['60.1', '60', false, '温度超出合理范围'],
  ['25', '-1', false, '湿度超出合理范围'],
  ['25', '100.1', false, '湿度超出合理范围'],
  ['NaN', '60', false, '请输入数字'],
  // 闭区间端点算合法
  ['-20', '0', true, ''],
  ['60', '100', true, ''],
  ['25', '60', true, ''],
  ['16', '60', true, ''],
];

cases.forEach(([t, h, ok, frag], i) => {
  const r = run(`validateInput(${JSON.stringify(t)}, ${JSON.stringify(h)})`);
  const shapeOk = typeof r.ok === 'boolean'
    && typeof r.message === 'string'
    && 'temperature' in r && 'humidity' in r;
  const msgOk = frag === '' ? r.message === '' : r.message.includes(frag);
  check(`validateInput #${i + 1} (${JSON.stringify(t)}, ${JSON.stringify(h)})`,
    r.ok === ok && msgOk && shapeOk,
    `ok=${r.ok} message=${JSON.stringify(r.message)}`);
});

// 通过时必须给出转换后的数字，而不是原文本
const good = run(`validateInput('31', '78')`);
check('校验通过时返回数字类型的 temperature/humidity',
  good.ok && good.temperature === 31 && good.humidity === 78 && good.message === '',
  JSON.stringify(good));

// 空值必须死在 Number('') === 0 这个坑前面
const empty = run(`validateInput('', '')`);
check("空输入不会被当成 0（Number('') 是 0 不是 NaN）",
  empty.ok === false && empty.temperature === null,
  JSON.stringify(empty));

/* ---------- 2. 规则只能有一份：本文件不许再抄 ---------- */

const SRC = fs.readFileSync(SCRIPT, 'utf8');
const HTML_SRC = fs.readFileSync(HTML, 'utf8');

/* 查 API 用法之前先剥掉注释。注释里写到 computeStatus、toLocaleString、
   localStorage 这些词，往往是在解释「为什么不用它」，按源码硬匹配会误报。
   rules.test.js 里踩过两次，这里统一用 CODE 查。 */
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
  .replace(/^\s*\/\/.*$/gm, '');      // 整行的行注释

check('script.js 里没有本地规则实现（规则只在 shared/rules.js）',
  !CODE.includes('computeStatus') && !CODE.includes('temperature < 18'),
  'script.js 里又出现了规则实现');

check('script.js 调的是 judgeStatus / getAdvice',
  CODE.includes('judgeStatus(') && CODE.includes('getAdvice('),
  '没找到对共享规则的调用');

check('index.html 在 script.js 之前引入 ../shared/rules.js',
  (() => {
    const i = HTML_SRC.indexOf('../shared/rules.js');
    const j = HTML_SRC.indexOf('src="script.js"');
    return i !== -1 && j !== -1 && i < j;
  })(),
  '引入顺序不对或路径不对');

/* ---------- 3. analyze()：校验失败不进入分析 ---------- */

function analyzeWith(t, h) {
  els['temp-input'].value = t;
  els['hum-input'].value = h;
  els['manual-result'].hidden = false;      // 先弄脏，确认失败时会被复原
  els['manual-result'].innerHTML = 'DIRTY';
  run('analyze()');
}

analyzeWith('', '60');
check('空输入：提示写入页面且不进入分析',
  els['manual-error'].textContent === '请输入温度/湿度'
  && els['manual-result'].hidden === true
  && els['manual-result'].innerHTML === '',
  `error=${JSON.stringify(els['manual-error'].textContent)} hidden=${els['manual-result'].hidden}`);

analyzeWith('abc', '60');
check('非数字：提示"请输入数字"且不进入分析',
  els['manual-error'].textContent === '请输入数字' && els['manual-result'].hidden === true,
  JSON.stringify(els['manual-error'].textContent));

analyzeWith('25', '200');
check('超范围：提示超出合理范围且不进入分析',
  els['manual-error'].textContent.includes('湿度超出合理范围')
  && els['manual-result'].hidden === true,
  JSON.stringify(els['manual-error'].textContent));

/* 四种状态各跑一遍：状态、建议、结果区 class 都要对 */
const okCases = [
  ['31', '78', '偏热', '注意通风，可开风扇', 'is-critical'],
  ['16', '90', '偏冷', '注意保暖，可关窗', 'is-warning'],
  ['25', '80', '偏湿', '开窗通风或除湿', 'is-serious'],
  ['25', '60', '正常', '环境良好，保持即可', 'is-good'],
];

okCases.forEach(([t, h, status, advice, cls]) => {
  analyzeWith(t, h);
  const html = els['manual-result'].innerHTML;
  const ok = els['manual-error'].textContent === ''
    && els['manual-result'].hidden === false
    && html.includes(status)
    && html.includes(advice)
    && html.includes(t)
    && els['manual-result'].className.includes(cls);
  check(`${t}/${h} -> ${status} + 建议 + ${cls}`, ok,
    `error=${JSON.stringify(els['manual-error'].textContent)} `
    + `class=${JSON.stringify(els['manual-result'].className)} `
    + `有建议=${html.includes(advice)}`);
});

/* 校验失败时要连结果区的状态 class 一起清掉，别留着上一次的颜色 */
analyzeWith('abc', '60');
check('校验失败后结果区的状态 class 被清空',
  els['manual-result'].className === 'manual-result'
  && els['manual-result'].hidden === true,
  JSON.stringify(els['manual-result'].className));

check('script.js 里没有 window.alert（要求把提示显示在页面上）',
  !CODE.includes('alert('),
  '出现了 alert(');

/* ---------- 4. 导出 CSV（导的是 history） ---------- */

// 第 3 节分析成功过几次，history 里已经有记录了，先清空再测空状态
run('history.length = 0; exportCSV();');
check('历史为空时提示且不产生下载',
  els['export-note'].textContent === '没有可导出的记录'
  && capturedBlob === null && clicks.length === 0,
  `note=${JSON.stringify(els['export-note'].textContent)} clicks=${clicks.length}`);

/* 往 messages 里塞一条特征值（99），用来证明 CSV 导的是 history 而不是它。
   history 按提交顺序 push，页面上和 CSV 里都应该是倒过来的。 */
run(`
  messages.unshift(
    { nodeId:'dorm-a', temperature:99, humidity:99, status:'偏热', time:'1999-01-01 00:00:00' }
  );
  history.push(
    { time:'2026-09-22 20:29:55', temperature:25, humidity:60, status:'正常' },
    { time:'2026-09-22 20:30:00', temperature:31, humidity:78, status:'偏热' }
  );
  exportCSV();
`);

// 同步抓一下提示文字：showNote 3 秒后会自动清空，别等到 await 之后再读
const exportedNote = els['export-note'].textContent;

(async () => {
  const bytes = new Uint8Array(await capturedBlob.arrayBuffer());
  // blob.text() 按规范会吞掉开头的 BOM，所以用 ignoreBOM 保留它再断言
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

  check('文件名 dormmate.csv', clicks[0] && clicks[0].download === 'dormmate.csv',
    clicks[0] && clicks[0].download);
  check('开头是 UTF-8 BOM (EF BB BF)',
    bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF,
    [...bytes.slice(0, 3)].map((b) => b.toString(16)).join(' '));
  check('首字符是 U+FEFF', text.charCodeAt(0) === 0xFEFF, '0x' + text.charCodeAt(0).toString(16));

  const body = text.slice(1);
  const lines = body.split('\r\n').filter(Boolean);
  check('表头固定', lines[0] === 'time,temperature,humidity,status', JSON.stringify(lines[0]));
  check('两条历史两行', lines.length === 3, `行数=${lines.length}`);
  check('中文未被转义', body.includes('偏热') && body.includes('正常'));
  check('用 CRLF 换行', body.includes('\r\n') && !/[^\r]\n/.test(body));

  check('导的是 history，不是 MQTT 的 messages',
    !body.includes('99') && !body.includes('dorm-a'),
    'messages 里的数据混进了 CSV');

  check('CSV 的行顺序和页面一致（最新在前）',
    lines[1] === '2026-09-22 20:30:00,31,78,偏热'
    && lines[2] === '2026-09-22 20:29:55,25,60,正常',
    JSON.stringify(lines.slice(1)));

  check('导出后提示条数', exportedNote === '已导出 2 条', JSON.stringify(exportedNote));

  const esc = run(`[csvCell('a,b'), csvCell('say "hi"'), csvCell('正常')]`);
  check('CSV 引号转义', esc[0] === '"a,b"' && esc[1] === '"say ""hi"""' && esc[2] === '正常',
    JSON.stringify(esc));

  /* ---------- 6. formatTime ---------- */

  /* 自己拼固定的 Date，不受"现在几点"影响。用本地时间构造、本地时间读，
     所以时区怎么变都不会让这几条挂掉。 */
  const timeCases = [
    [new Date(2026, 8, 22, 20, 30, 0),   '2026-09-22 20:30:00'],
    [new Date(2026, 0, 1, 0, 0, 0),      '2026-01-01 00:00:00'],
    [new Date(2026, 11, 31, 23, 59, 59), '2026-12-31 23:59:59'],
    [new Date(2026, 8, 2, 9, 5, 7),      '2026-09-02 09:05:07'],  // 个位数必须补零
  ];
  timeCases.forEach(([d, want], i) => {
    const got = run(`formatTime(new Date(${d.getFullYear()}, ${d.getMonth()}, `
      + `${d.getDate()}, ${d.getHours()}, ${d.getMinutes()}, ${d.getSeconds()}))`);
    check(`formatTime #${i + 1} -> ${want}`, got === want, JSON.stringify(got));
  });

  check('formatTime 长度固定 19，不随区域设置变',
    timeCases.every(([, want]) => want.length === 19));

  check('formatTime 没用 toLocaleString（输出格式必须与浏览器无关）',
    !/toLocale\w*\(/.test(CODE), '源码里出现了 toLocale* 调用');

  check('formatTime 对无效日期返回空串，而不是 NaN-NaN-NaN',
    run('formatTime(new Date("这不是日期"))') === '',
    JSON.stringify(run('formatTime(new Date("这不是日期"))')));

  /* ---------- 7. 录入历史 ---------- */

  // 前面已经分析过几次，先清空，让这一节从确定的状态开始
  run('history.length = 0; renderHistory();');

  check('清空后计数是「共 0 条记录」',
    els['history-count'].textContent === '共 0 条记录',
    JSON.stringify(els['history-count'].textContent));

  check('空历史渲染的是占位行，不是一张空表',
    els['history-body'].innerHTML.includes('colspan="4"')
    && els['history-body'].innerHTML.includes('history-empty'),
    els['history-body'].innerHTML);

  check('history 是数组', run('Array.isArray(history)'));

  // 三次成功分析 -> 三条记录
  analyzeWith('25', '60');    // 正常
  analyzeWith('31', '78');    // 偏热
  analyzeWith('16', '90');    // 偏冷

  check('三次成功分析 -> 三条记录（追加，不是覆盖）',
    run('history.length') === 3, `length=${run('history.length')}`);

  check('计数跟着变成「共 3 条记录」',
    els['history-count'].textContent === '共 3 条记录',
    JSON.stringify(els['history-count'].textContent));

  /* 数组里是 push 的提交顺序，页面上必须是倒过来的 —— 最新的在最上面 */
  check('数组保持提交顺序（旧 -> 新）',
    run('history.map((r) => r.temperature).join(",")') === '25,31,16',
    run('history.map((r) => r.temperature).join(",")'));

  const cells = [...els['history-body'].innerHTML
    .matchAll(/<td class="num">([^<]+)<\/td>/g)].map((m) => m[1]);
  check('页面上最新的在最上面（16/90 -> 31/78 -> 25/60）',
    cells.join(',') === '16,90,31,78,25,60', cells.join(','));

  check('每行都是「时间 | 温度 | 湿度 | 状态」四列',
    (els['history-body'].innerHTML.match(/<tr/g) || []).length === 3
    && (els['history-body'].innerHTML.match(/<td/g) || []).length === 12,
    `行=${(els['history-body'].innerHTML.match(/<tr/g) || []).length} `
    + `列=${(els['history-body'].innerHTML.match(/<td/g) || []).length}`);

  /* 记录本身：字段、类型、时间格式 */
  check('每条记录正好是 {time, temperature, humidity, status}',
    run('Object.keys(history[0]).sort().join(",")')
      === 'humidity,status,temperature,time',
    run('JSON.stringify(history[0])'));

  check('记录里的数值是数字，不是输入框里的字符串',
    run('typeof history[0].temperature === "number" '
      + '&& typeof history[0].humidity === "number"'),
    run('typeof history[0].temperature'));

  const recordTime = run('history[0].time');
  check('记录里的时间是 YYYY-MM-DD HH:mm:ss',
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(recordTime),
    JSON.stringify(recordTime));

  check('记录里的状态就是 judgeStatus 的结果',
    run('history.every((r) => r.status === judgeStatus(r.temperature, r.humidity))'),
    run('JSON.stringify(history.map((r) => r.status))'));

  /* 校验失败不能污染历史 —— 这是"分析成功后才记"的反面 */
  analyzeWith('', '');
  analyzeWith('abc', '60');
  analyzeWith('25', '200');
  check('校验失败三次后仍然是 3 条',
    run('history.length') === 3, `length=${run('history.length')}`);

  check('历史只活在内存里，不写 localStorage（刷新即清空是有意的）',
    !/localStorage[^;]{0,80}history/.test(CODE),
    '历史被写进了 localStorage');

  /* ---------- 8. HTML 与 JS 的 id 对得上 ---------- */

  const html = fs.readFileSync(HTML, 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = [...new Set([...fs.readFileSync(SCRIPT, 'utf8')
    .matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]))];
  const missing = used.filter((id) => !ids.has(id));
  check('script.js 引用的 id 在 index.html 里都存在', missing.length === 0,
    '缺失: ' + missing.join(', '));
  check('index.html 加载的是 script.js', html.includes('src="script.js"'));

  /* ---------- 9. Broker 地址跟着访问地址走 ---------- */

  // 写死 localhost 的话，手机打开页面时 localhost 指的是手机自己，连不回来
  check('本机打开时还是 ws://localhost:9001',
    run('brokerUrl("localhost")') === 'ws://localhost:9001');
  check('按访问用的主机名拼地址（手机/别的电脑）',
    run('brokerUrl("10.102.196.160")') === 'ws://10.102.196.160:9001');
  check('hostname 是空串时退回 localhost（file:// 直开的情况）',
    run('brokerUrl("")') === 'ws://localhost:9001');
  check('页面真的用了 brokerUrl(location.hostname)，不是写死的',
    run('BROKER_URL === brokerUrl(location.hostname)'));
  check('源码里不再有写死的 ws://localhost:9001',
    !CODE.includes("ws://localhost:9001"),
    'broker 地址又被写死了，手机打开会连回手机自己');

  /* ---------- 10. 现场快照（摄像头） ---------- */

  const video = els['cam-video'];
  const openBtn = els['cam-open'];
  const shotBtn = els['cam-shot'];
  const img = els['cam-image'];

  /* 桩不会真的解码视频，尺寸得手动给：takeSnapshot 拿 videoWidth/videoHeight
     开画布，两边都是 0 的话它会当成"画面还没准备好"给拒了。 */
  video.videoWidth = 1280;
  video.videoHeight = 720;
  video.play = () => Promise.resolve();

  check('页面有「打开摄像头」和「拍照」两个按钮',
    /id="cam-open"[^>]*>打开摄像头</.test(html)
    && /id="cam-shot"[^>]*>拍照</.test(html));
  check('有 video 预览区', /<video id="cam-video"/.test(html));
  check('有快照显示区', /<img id="cam-image"/.test(html));

  check('takeSnapshot 是顶层函数，语音指令能直接调',
    run('typeof takeSnapshot') === 'function', run('typeof takeSnapshot'));

  /* 没开摄像头就拍（语音指令很可能在这个状态下被喊到）：要拒绝得干脆，
     并把原因写在页面上，而不是抛异常或者拍出一张黑图。 */
  const tooEarly = run('takeSnapshot()');
  check('没开摄像头时拍照返回 ok=false', tooEarly.ok === false, JSON.stringify(tooEarly));
  check('没开摄像头时页面上写了怎么办',
    els['cam-error'].textContent.includes('先点「打开摄像头」'),
    els['cam-error'].textContent);
  /* 桩不解析 HTML，hidden 属性在桩里体现不出来，所以起手状态查标记本身；
     "没拍成"这件事查的是没往 img.src 里塞过东西。 */
  check('快照区起手是藏着的（HTML 上带 hidden）',
    /<img id="cam-image"[^>]*\shidden/.test(html));
  check('没拍成时不会往快照区塞图', !img.src, String(img.src));

  /* ---- 打开 ---- */

  installMediaDevices('ok');
  const opened = await run('openCamera()');
  check('打开成功返回 true', opened === true, String(opened));
  check('约束就是 { video: true }',
    JSON.stringify(lastConstraints) === '{"video":true}', JSON.stringify(lastConstraints));
  check('视频流接到了 video 上', video.srcObject === lastStream);
  check('预览显示、占位文字收起',
    video.hidden === false && els['cam-preview-hint'].hidden === true);
  check('「拍照」按钮解禁', shotBtn.disabled === false);
  check('按钮变成「关闭摄像头」', openBtn.textContent === '关闭摄像头', openBtn.textContent);

  /* ---- 拍照 ---- */

  const shot = run('takeSnapshot()');
  check('拍照成功', shot.ok === true, JSON.stringify(shot));
  check('画布按视频原始像素开，不是 CSS 显示尺寸',
    lastCanvas.width === 1280 && lastCanvas.height === 720,
    `${lastCanvas.width}x${lastCanvas.height}`);
  check('整张画面都画进去了',
    lastCanvas.drawCalls.length === 1
    && JSON.stringify(lastCanvas.drawCalls[0].slice(1)) === '[0,0,1280,720]',
    JSON.stringify(lastCanvas.drawCalls));
  check('快照显示成一张 PNG data URL',
    img.hidden === false && img.src.startsWith('data:image/png'), img.src);
  check('快照下面写明拍摄时间和分辨率',
    /^拍摄于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · 1280×720$/
      .test(els['cam-caption'].textContent),
    els['cam-caption'].textContent);
  check('页面上报出已拍下的条数',
    els['cam-note'].textContent.includes('已拍下 1 张'), els['cam-note'].textContent);

  // 换个尺寸再拍一张：画布跟着新尺寸重开，说明是覆盖而不是堆着
  video.videoWidth = 640;
  video.videoHeight = 480;
  run('takeSnapshot()');
  check('再拍一张是覆盖上一张（只保存一张，不连续采集）',
    lastCanvas.width === 640 && lastCanvas.height === 480,
    `${lastCanvas.width}x${lastCanvas.height}`);

  /* ---- 关闭 ---- */

  run('closeCamera()');
  check('关的时候真的 stop 了 track（否则摄像头指示灯不灭）',
    lastStream.stopped.length === 1, JSON.stringify(lastStream.stopped));
  check('video 上的流被摘掉', video.srcObject === null);
  check('预览重新藏起来', video.hidden === true);
  check('「拍照」重新禁用', shotBtn.disabled === true);
  check('按钮文字恢复', openBtn.textContent === '打开摄像头', openBtn.textContent);

  /* ---- 三种失败 ---- */

  installMediaDevices('deny');
  const denied = await run('openCamera()');
  check('权限被拒时返回 false', denied === false);
  check('权限被拒时提示的是"改浏览器设置"',
    els['cam-error'].textContent.includes('权限被拒绝'), els['cam-error'].textContent);
  check('权限被拒后「拍照」仍然禁用', shotBtn.disabled === true);

  installMediaDevices('none');
  await run('openCamera()');
  check('没有摄像头时提示的是"设备"而不是"权限"',
    els['cam-error'].textContent.includes('没找到摄像头设备'), els['cam-error'].textContent);

  /* 手机用局域网 IP 打开时 navigator.mediaDevices 整个不存在。
     不特判的话报出来是 "Cannot read properties of undefined"，
     完全看不出是地址的问题 —— 所以这条必须区分开。 */
  installMediaDevices('off');
  global.window.isSecureContext = false;
  await run('openCamera()');
  check('局域网 http 打开时提示换地址，而不是笼统的"失败"',
    els['cam-error'].textContent.includes('不是安全上下文')
    && els['cam-error'].textContent.includes('https'), els['cam-error'].textContent);
  global.window.isSecureContext = true;

  /* ---- 离开页面 ---- */

  installMediaDevices('ok');
  await run('openCamera()');
  const streamBeforeHide = lastStream;
  fireWindow('pagehide');
  check('离开页面时自动关摄像头',
    streamBeforeHide.stopped.length === 1 && video.srcObject === null,
    JSON.stringify(streamBeforeHide.stopped));

  /* ---------- 11. 语音指令（ASR） ---------- */

  const voiceBtn = els['voice-start'];
  const voiceError = () => els['voice-error'].textContent;
  const voiceAction = () => els['voice-action'].textContent;

  check('页面有「语音指令」按钮', /id="voice-start"[^>]*>语音指令</.test(html));
  check('页面有识别文字显示区', /id="voice-heard"/.test(html));
  check('页面有执行结果显示区', /id="voice-action"/.test(html));
  check('speakStatus 是顶层函数，指令表能直接引用它',
    run('typeof speakStatus') === 'function', run('typeof speakStatus'));

  /* ---- 浏览器不支持 ---- */

  installSpeechRecognition(false);
  voiceBtn.fire('click');
  check('不支持时给出明确原因，而不是点了没反应',
    voiceError().includes('SpeechRecognition'), voiceError());

  /* ---- 正常走一遍 ---- */

  installSpeechRecognition(true);
  voiceBtn.fire('click');
  const rec = lastRecognition;
  check('确实 new 了 SpeechRecognition', !!rec);
  check('lang 是 zh-CN', (rec && rec.lang) === 'zh-CN', rec && rec.lang);
  check('只识别一句（continuous=false）',
    rec && rec.continuous === false, rec && String(rec.continuous));
  check('不要中间稿（interimResults=false）',
    rec && rec.interimResults === false, rec && String(rec.interimResults));
  check('按钮变成「正在听…」', voiceBtn.textContent === '正在听…', voiceBtn.textContent);

  voiceBtn.fire('click');
  check('正在听时重复点击被忽略（不会开出第二个会话）',
    lastRecognition === rec, '又 new 了一个');

  /* ---- 固定指令 ---- */

  rec.say('朗读一下。');
  check('识别到的文字显示在页面上',
    els['voice-heard'].textContent === '朗读一下。', els['voice-heard'].textContent);
  check('「朗读」走 speakStatus（显示的是它自己的返回值）',
    voiceAction().includes('朗读'), voiceAction());
  check('说完一句会话就结束，按钮恢复',
    voiceBtn.textContent === '语音指令', voiceBtn.textContent);

  /* 「拍照」得真的调到 takeSnapshot：先开摄像头，再喊拍照 */
  installMediaDevices('ok');
  await run('openCamera()');
  voiceBtn.fire('click');
  lastRecognition.say('帮我拍照吧');
  check('「拍照」调到 takeSnapshot（页面上出现拍摄时间）',
    voiceAction().includes('已拍照'), voiceAction());
  check('识别文字也换成这一句',
    els['voice-heard'].textContent === '帮我拍照吧', els['voice-heard'].textContent);

  /* 摄像头没开时说「拍照」：走的是 takeSnapshot 自己的失败分支，
     原因照样显示出来 —— 这正是它返回 {ok, message} 的用处。 */
  run('closeCamera()');
  voiceBtn.fire('click');
  lastRecognition.say('拍照');
  check('没开摄像头时说「拍照」会提示先开摄像头',
    voiceAction().includes('先点「打开摄像头」'), voiceAction());

  /* ---- 未识别 ---- */

  voiceBtn.fire('click');
  lastRecognition.say('今天天气不错');
  check('不认识的指令把原话回显出来',
    voiceAction() === '未识别的指令：今天天气不错', voiceAction());

  /* 固定指令是字面子串匹配，不是同义词理解：「拍张照」里没有「拍照」
     这三个字，就走不到 takeSnapshot。这是这一步的约定行为（要求就是
     "包含拍照"），不是 bug —— 但演示时得照约定说「拍照」。 */
  voiceBtn.fire('click');
  lastRecognition.say('拍张照');
  check('关键词按字面包含判断，同义词不算（"拍张照" ≠ "拍照"）',
    voiceAction() === '未识别的指令：拍张照', voiceAction());

  voiceBtn.fire('click');
  lastRecognition.say('朗读并且拍照');
  check('一句话里两个关键词都在时，按固定顺序取第一条（朗读）',
    voiceAction().includes('朗读'), voiceAction());

  /* ---- 错误：event.error 必须露在页面上 ---- */

  voiceBtn.fire('click');
  lastRecognition.fail('not-allowed');
  check('麦克风被拒：页面上有具体的 event.error',
    voiceError().includes('not-allowed'), voiceError());
  check('麦克风被拒：同时给人话解释',
    voiceError().includes('权限'), voiceError());

  voiceBtn.fire('click');
  lastRecognition.fail('network');
  check('network 错误：页面上有具体的 event.error',
    voiceError().includes('network'), voiceError());

  voiceBtn.fire('click');
  lastRecognition.fail('no-speech');
  check('没听到声音：也有对应的提示',
    voiceError().includes('no-speech'), voiceError());

  check('表里没有的错误码也照样显示出来，不吞掉',
    run('voiceErrorMessage("weird-new-code")') === '语音识别出错（weird-new-code）',
    run('voiceErrorMessage("weird-new-code")'));

  /* ---- 离开页面 ---- */

  voiceBtn.fire('click');            // 顺便把上一条错误清掉
  const listening = lastRecognition;
  check('重新开始会把上一次的错误清掉', voiceError() === '', voiceError());
  fireWindow('pagehide');
  check('离开页面时掐掉还在听的会话（否则麦克风一直开着）',
    listening.aborted === 1, String(listening.aborted));
  check('自己主动中止不会被当成错误显示出来',
    voiceError() === '', voiceError());

  /* ---------- Step 3-3：语音播报 ---------- */

  /* 念的那句话单独拿出来测：它是"哪些字会进到耳朵里"的唯一出处，
     不该只有"走没走到 speak()"这一条。 */

  run('nodes.clear()');
  check('一个节点都没收到时念「还没有收到」，不念「都正常」',
    run('statusReadout()') === '还没有收到任何节点的数据', run('statusReadout()'));

  run(`
    nodes.set('dorm-b', { temperature:31, humidity:78, status:'偏热' });
    nodes.set('dorm-a', { temperature:25, humidity:60, status:'正常' });
  `);
  check('按 nodeId 排序，不是按收到的先后（后到的 dorm-b 排在后面）',
    run('statusReadout()') === 'dorm-a 25℃ 60% 正常；dorm-b 31℃ 78% 偏热',
    run('statusReadout()'));

  run("nodes.set('dorm-c', { temperature:25.5, humidity:60, status:'正常' })");
  check('小数照 fmt 的格式念（25.5 不写成 25.50）',
    run('statusReadout()').includes('dorm-c 25.5℃ 60% 正常'), run('statusReadout()'));

  /* 前端**不许**重算状态：规则只有 Python 侧那一份实现。31℃/78% 规则上算
     偏热，这里故意把报文的 status 写成偏湿 —— 念出来的必须是报文里那个。 */
  run("nodes.clear(); nodes.set('dorm-a', { temperature:31, humidity:78, status:'偏湿' })");
  check('念的是报文里的 status，不是页面自己重算的',
    run('statusReadout()') === 'dorm-a 31℃ 78% 偏湿', run('statusReadout()'));

  /* ---- 说「朗读」真的念出来（走完整条链路） ---- */

  run(`
    nodes.clear();
    nodes.set('dorm-a', { temperature:25, humidity:60, status:'正常' });
    nodes.set('dorm-b', { temperature:31, humidity:78, status:'偏热' });
  `);
  installSpeechSynthesis('ok');

  voiceBtn.fire('click');
  lastRecognition.say('朗读');
  check('说「朗读」真的调了 speak()', spokenTexts.length === 1, String(spokenTexts.length));
  check('念的就是当前状态那句话',
    spokenTexts[0] && spokenTexts[0].text === 'dorm-a 25℃ 60% 正常；dorm-b 31℃ 78% 偏热',
    spokenTexts[0] && spokenTexts[0].text);
  check('lang 是 zh-CN', spokenTexts[0] && spokenTexts[0].lang === 'zh-CN',
    spokenTexts[0] && spokenTexts[0].lang);
  check('念之前先 cancel（否则第二句要排队等第一句念完）',
    cancelCount === 1, String(cancelCount));
  check('页面上显示的就是要念的那一句（静音时只能靠它确认念了什么）',
    voiceAction() === '正在朗读：dorm-a 25℃ 60% 正常；dorm-b 31℃ 78% 偏热', voiceAction());
  check('utterance 留着一个引用（被 GC 掉的话 Chrome 念到一半会停）',
    run('speaking') === spokenTexts[0], String(run('speaking') === spokenTexts[0]));

  /* ---- 每次现算，不缓存上一句 ---- */

  run("nodes.set('dorm-c', { temperature:16, humidity:60, status:'偏冷' })");
  voiceBtn.fire('click');
  lastRecognition.say('朗读');
  check('第二句照样先 cancel 再 speak',
    cancelCount === 2 && spokenTexts.length === 2,
    `cancel=${cancelCount} speak=${spokenTexts.length}`);
  check('新收到的节点立刻进下一句（念的是此刻的数据，不是上一次那份）',
    spokenTexts[1].text.includes('dorm-c 16℃ 60% 偏冷'), spokenTexts[1].text);

  /* ---- 浏览器不支持 ---- */

  installSpeechSynthesis('off');
  const unsupported = run('speakStatus()');
  check('不支持时返回 {ok:false} 而不是抛异常',
    unsupported && unsupported.ok === false, JSON.stringify(unsupported));
  check('不支持时把要念的内容照样写在页面上',
    unsupported.message.includes('不支持') && unsupported.message.includes('dorm-c'),
    unsupported.message);
  check('不支持时压根没碰 speechSynthesis',
    spokenTexts.length === 0 && cancelCount === 0,
    `speak=${spokenTexts.length} cancel=${cancelCount}`);

  installSpeechSynthesis('partial');
  check('只有 speechSynthesis、没有那个构造函数，也算不支持（少查一个就是 TypeError）',
    run('speechSupported()') === false, String(run('speechSupported()')));
  check('这种浏览器里说「朗读」不抛异常，照样返回 {ok:false}',
    (() => {
      try { const r = run('speakStatus()'); return r && r.ok === false; } catch (e) { return false; }
    })(), '抛了异常');

  /* ---- 念的时候出错 ---- */

  installSpeechSynthesis('ok');
  voiceBtn.fire('click');
  lastRecognition.say('朗读');
  const speakingNow = spokenTexts[spokenTexts.length - 1];
  speakingNow.fireError('not-allowed');
  check('朗读失败：原始的 event.error 露在页面上',
    voiceAction().includes('not-allowed'), voiceAction());
  check('朗读失败：把「正在朗读」覆盖掉，不留一句假话',
    !voiceAction().includes('正在朗读') && voiceAction().includes('朗读失败'), voiceAction());

  speakingNow.fireError(undefined);
  check('连错误码都没有时写 unknown，不写 undefined',
    voiceAction().includes('（unknown）'), voiceAction());

  /* ---------- 报告 ---------- */

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '   -> ' + c.detail}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} 通过`);
  process.exit(failed ? 1 : 0);
})();
