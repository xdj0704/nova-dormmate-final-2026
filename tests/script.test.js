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
const CONFIG = path.join(__dirname, '..', 'shared', 'config.js');
/* E2 起 multimodal.js 也是这个页面的一个 script（type="module"），
   它的 id 也要和 index.html 对得上（第 8 节）。 */
const MULTIMODAL = path.join(WEB, 'multimodal.js');

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

/* 快照用的 canvas 桩：记下宽高、drawImage 的参数、以及**画上去的字**。
   - drawCalls 能验「画布是按视频原始像素开的、画的是整个画面」
   - texts 能验水印（Phase6 E2）—— 那是这一步唯一能在 Node 里自动验的东西：
     真拍一张没法在这里看图，但「往画面上写了哪几行字」是能验的。
   - toDataURL 给一段**能解码的数**：'QUJDREU=' 是 'ABCDE'，5 个字节。
     随便给个 'STUB' 的话，字节数那条断言算出来的 3 是个巧合，验不出什么。 */
let lastCanvas = null;

function canvasStub() {
  const canvas = {
    width: 0, height: 0, drawCalls: [], fills: [], texts: [],
    getContext: () => ({
      drawImage: (...args) => canvas.drawCalls.push(args),
      fillRect: (...args) => canvas.fills.push(args),
      fillText: (text, x, y) => canvas.texts.push({ text, x, y }),
      font: '', textBaseline: '', fillStyle: '',
    }),
    toDataURL: (type) => `data:${type};base64,QUJDREU=`,
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

/* 语音识别和语音合成的桩跟着那两块代码一起搬去了 tests/multimodal.test.js
   （Phase6 E2 把 ASR / TTS 从 web/script.js 挪进了 web/multimodal.js）。 */

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

/* 语音合成的桩同样搬去了 tests/multimodal.test.js（见上面那段说明）。 */

// 顺序同 index.html：先 config.js + rules.js，再 script.js
vm.runInThisContext(fs.readFileSync(CONFIG, 'utf8'), { filename: CONFIG });
vm.runInThisContext(fs.readFileSync(RULES, 'utf8'), { filename: RULES });
/* 真浏览器里 window 就是 globalThis，config.js 挂上去的那个对象页面直接就读到。
   这个桩里 window 是**另一个对象**（为了让下面能替换 location / isSecureContext），
   所以得把同一个引用搬一份过去 —— 不搬的话 script.js 会当场报「没引 config.js」，
   而那是测试桩的构造问题，不是页面的问题。 */
global.window.DormMateConfig = global.DormMateConfig;
vm.runInThisContext(fs.readFileSync(SCRIPT, 'utf8'), { filename: SCRIPT });

const CFG = global.DormMateConfig;

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
  /* 两个文件都要查：E2 起语音那几样（voice-start / voice-heard …）是
     multimodal.js 取的，只查 script.js 的话，那些 id 被改掉了也照样绿。 */
  const used = [...new Set([SCRIPT, MULTIMODAL]
    .flatMap((file) => [...fs.readFileSync(file, 'utf8')
      .matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])))];
  const missing = used.filter((id) => !ids.has(id));
  check('script.js / multimodal.js 引用的 id 在 index.html 里都存在', missing.length === 0,
    '缺失: ' + missing.join(', '));
  check('index.html 加载的是 script.js', html.includes('src="script.js"'));
  check('index.html 也挂了 multimodal.js（type="module"）',
    /<script\s+type="module"\s+src="multimodal\.js">/.test(html),
    '语音和拍照上报那一半没被加载');

  /* ---------- 9. Broker 地址和 topic 都来自 shared/config.js ---------- */

  /* 写死 localhost 的话，手机打开页面时 localhost 指的是手机自己，连不回来。
     E3 起地址的唯一出处是 shared/config.js，script.js 只转述它的值。 */
  check('本机打开时连 ws://localhost:9001',
    run('BROKER_URL') === 'ws://localhost:9001', run('BROKER_URL'));
  check('按访问用的主机名拼地址（手机/别的电脑连得回来）',
    CFG.brokerUrl('10.102.196.160') === 'ws://10.102.196.160:9001',
    CFG.brokerUrl('10.102.196.160'));
  check('hostname 是空串时退回 localhost（file:// 直开的情况）',
    CFG.brokerUrl('') === 'ws://localhost:9001', CFG.brokerUrl(''));
  check('页面用的是 CFG.brokerUrlFor(location)，不是自己拼的',
    /BROKER_URL\s*=\s*CFG\.brokerUrlFor\(location\)/.test(CODE));
  check('源码里不再有写死的 ws://localhost:9001',
    !CODE.includes("ws://localhost:9001"),
    'broker 地址又被写死了，手机打开会连回手机自己');
  check('两条 topic 都从 CFG 取，没有写死',
    run('TOPIC') === CFG.TOPIC_PATTERN && run('STATE_TOPIC') === CFG.STATE_TOPIC,
    run('TOPIC') + ' / ' + run('STATE_TOPIC'));
  /* 顺序错了 script.js 起手就 throw（它是故意的），但那样子报出来的是一句
     「需要 window.DormMateConfig」，很容易被当成 config.js 本身坏了。 */
  check('index.html 在 script.js 之前引入 ../shared/config.js',
    html.indexOf('src="../shared/config.js"') < html.indexOf('src="script.js"'),
    'config.js 必须排在 script.js 前面');

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

  check('takeSnapshot 是顶层函数（拍照按钮和多模态那边都调它）',
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

  /* ---- E2：水印和文件信息 ----
     拍下来的**那张图**在 Node 里没法看，但「往画面上写了哪几行字」「报了多大的
     文件」是能验的 —— 而这两样正是 core 收的东西。 */

  const plain = run('takeSnapshot()');
  check('不传 overlay 时一个字的字都不写（「拍照」按钮那条预览路）',
    lastCanvas.texts.length === 0 && lastCanvas.fills.length === 0,
    JSON.stringify(lastCanvas.texts));

  const marked = run("takeSnapshot(['dorm-b · 事件 ev-1 · 2026-09-22 20:31:00', '温度 31℃'])");
  check('★ 传了 overlay 就把那几行字画进画面',
    lastCanvas.texts.map((t) => t.text).join('|')
      === 'dorm-b · 事件 ev-1 · 2026-09-22 20:31:00|温度 31℃',
    JSON.stringify(lastCanvas.texts.map((t) => t.text)));
  check('水印下面垫了一条半透明黑带（浅色墙面上也看得清）',
    lastCanvas.fills.length === 1
    && lastCanvas.fills[0][0] === 0 && lastCanvas.fills[0][2] === 640,
    JSON.stringify(lastCanvas.fills));
  check('水印画在**画面底部**，不压住中间的拍摄内容',
    lastCanvas.texts.every((t) => t.y > 480 / 2),
    JSON.stringify(lastCanvas.texts.map((t) => t.y)));
  check('空行被丢掉（不会在画面上留一条空带）',
    run("takeSnapshot(['只有一行', ''])") && lastCanvas.texts.length === 1,
    JSON.stringify(lastCanvas.texts.length));

  check('★ 返回的 meta 就是拼 snapshot 指令要的那几个数',
    ['stamp', 'width', 'height', 'bytes', 'ext'].every((k) => k in marked.meta)
    && marked.meta.width === 640 && marked.meta.height === 480
    && marked.meta.ext === '.png',
    JSON.stringify(marked.meta));
  check('★ bytes 是按 base64 长度算出来的真字节数（桩里那段解出来是 5 字节）',
    marked.meta.bytes === 5, String(marked.meta.bytes));
  check('stamp 是 core 那边认的时刻写法',
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(marked.meta.stamp), marked.meta.stamp);

  /* 这四种是 base64 长度换算最容易错的地方：带一个 = 的、带两个 = 的、
     不带补位的、和空的。差的那一两个字节不影响 core（它只判断正不正），
     但算错了说明这个函数写错了，而它是要长期用的。 */
  check('pngByteLength：带 1 个 = / 带 2 个 = / 不带 / 空串',
    run("pngByteLength('data:image/png;base64,QUJDREU=')") === 5
    && run("pngByteLength('data:image/png;base64,QUJDRA==')") === 4
    && run("pngByteLength('data:image/png;base64,QUJDREVG')") === 6
    && run("pngByteLength('')") === 0,
    [run("pngByteLength('data:image/png;base64,QUJDREU=')"),
      run("pngByteLength('data:image/png;base64,QUJDRA==')"),
      run("pngByteLength('data:image/png;base64,QUJDREVG')"),
      run("pngByteLength('')")].join(','));

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

  /* ---------- 11. 语音指令（ASR）/ 语音播报（TTS）：搬去 multimodal.test.js ----------

     Phase6 E2 把 ASR（原来的 3-2）和 TTS（原来的 3-3）从 web/script.js 整块挪进了
     web/multimodal.js，理由写在那个文件头上：要算「这一句念什么」得用
     dashboard/logic.js 里的纯函数，而 logic.js 是 ES 模块 —— 进不了经典 script。
     script.js 又是必须留在经典 script 里的（本文件用 vm.runInThisContext 整个
     跑它，顶层出现 import 会让它整个废掉）。

     原来这里的五十来条断言**一条没丢**，整段搬去了 tests/multimodal.test.js，
     而且是接着往上加的：那边除了「说『朗读』真的念了」，还测了 E2 新加的四条
     指令、宿舍名的中文别名、以及「拍完不能在本地写已登记」。

     留这一段是为了让「语音的测试去哪了」有一个能被 grep 到的答案，
     不然下一个人翻到这里会以为语音那次改动把测试一起删了。 */

  /* ---------- 报告 ---------- */

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '   -> ' + c.detail}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} 通过`);
  process.exit(failed ? 1 : 0);
})();
