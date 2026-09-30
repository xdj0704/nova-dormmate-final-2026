'use strict';

/* DormMate 前端：通过 WebSocket 订 MQTT，实时渲染各宿舍环境状态。
   注意：MQTT 数据的 status 一律以发布端发来的字段为准，前端不重算规则。
   唯一的例外是「手动录入分析」——那份数据不经过发布端，只能在前端算，
   用的是 shared/rules.js 的 judgeStatus() / getAdvice()。
   规则不要在本文件或任何页面里再抄一份。

   【Phase6 E2 从这个文件里搬走了什么】
   语音那整块（ASR、中文别名、TTS、拍照上报）搬去了 web/multimodal.js。
   搬的理由一句话：那份代码要用 dashboard/logic.js 里的纯函数来算「朗读什么」，
   而 logic.js 是 ES Module —— 在**经典 script** 顶层写 import 是语法错误，
   而这个文件必须留在经典 script 里（tests/script.test.js 用 vm 加载它，
   顶层出现 import 同样整个文件废掉）。所以拆成两份，中间用 window.DormMateBridge
   接一根线：这个文件管「收数据、画页面、握摄像头」，那边管「听人话、念出来」。

   搬走之后这里只剩三件事：
     1) 把 MQTT 收下来（遥测 + 状态快照两条 topic）
     2) 把遥测画成卡片和表格
     3) 把摄像头这块硬件握在手里（开 / 关 / 抓一张，包括画水印）  */

/* 地址和 topic 的真源是 ../shared/config.js（E3 起四端共用那一份）。
   这里**不再写死端口和 topic 字符串** —— 写死一次就是又开了一处出处，
   而 tests/config.test.js 盯的正是「同一个字面量只该有一处」。
   （3-1 那一版这里有个本地 brokerUrl()，E3 之后 config.js 里有一份更好的，
   它带 brokerUrlFor(location)，所以那个本地版本删掉了。） */
const CFG = typeof window !== 'undefined' ? window.DormMateConfig : null;
if (!CFG) {
  /* 没引 config.js 就连不上，而且报出来的会是「Cannot read properties of
     undefined」这种看不出所以然的东西。与其那样，不如当场点名缺了什么。
     顺序在 index.html 里：先 ../shared/config.js，再这份 script.js。 */
  throw new Error('web/script.js 需要 window.DormMateConfig：'
    + 'index.html 里要先引 ../shared/config.js。');
}

const BROKER_URL = CFG.brokerUrlFor(location);
const TOPIC = CFG.TOPIC_PATTERN;      // 遥测通配符
const STATE_TOPIC = CFG.STATE_TOPIC;  // core 的全局快照

const MAX_ROWS = 20;        // 「最近消息」表最多显示多少行
const MAX_MESSAGES = 2000;  // 内存里最多留多少条 MQTT 消息（防止挂机把内存吃光）

const CSV_HEADER = ['time', 'temperature', 'humidity', 'status'];
const CSV_FILENAME = 'dormmate.csv';

/* 手动录入的合理范围，闭区间（端点值算合法） */
const RANGE = {
  tempMin: -20,
  tempMax: 60,
  humMin: 0,
  humMax: 100,
};

/* 状态 -> 颜色档 + 图标。图标形状本身就区分状态，不靠颜色单独表意。
   偏冷用雪花、正常用对勾、偏湿用水滴、偏热用太阳，四个轮廓互不相似。 */
const ICONS = {
  check: '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7"/></svg>',
  snow:  '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M7 1.5v11M2.24 4.25l9.52 5.5M11.76 4.25l-9.52 5.5"/></svg>',
  drop:  '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M7 1.6S3.2 6.1 3.2 8.7a3.8 3.8 0 0 0 7.6 0C10.8 6.1 7 1.6 7 1.6z"/></svg>',
  sun:   '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="2.5"/><path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.76 2.76l1.06 1.06M10.18 10.18l1.06 1.06M11.24 2.76l-1.06 1.06M3.82 10.18l-1.06 1.06"/></svg>',
};

const STATUS_VIEW = {
  '正常': { cls: 'is-good',     icon: 'check' },
  '偏冷': { cls: 'is-warning',  icon: 'snow'  },
  '偏湿': { cls: 'is-serious',  icon: 'drop'  },
  '偏热': { cls: 'is-critical', icon: 'sun'   },
};

const nodes = new Map();  // nodeId -> 最新 payload

/* MQTT 消息日志，新的在前。只给「最近消息」表用（导出 CSV 导的是 history）。
   上限 MAX_MESSAGES 是防挂机的：模拟器每 5 秒一条，不管它就会一直涨。 */
const messages = [];

/* 手动录入的分析历史。每条 {time, temperature, humidity, status}。
   用 push 追加（数组里是旧 -> 新），渲染时倒着走，最新的显示在最上面 ——
   顺序只在渲染那一步决定，数组本身保持"提交顺序"这个更自然的含义。

   只活在内存里，刷新页面就清空。这是有意的：本步骤约定不落 localStorage。

   名字和浏览器的 window.history 撞了，但这里是经典 script 的顶层 const，
   会在顶层词法作用域里把 window.history 遮蔽掉；本文件不做 History API
   操作，所以只是重名，不影响任何东西。 */
const history = [];

const el = {
  cards: document.getElementById('cards'),
  empty: document.getElementById('empty'),
  logBody: document.getElementById('log-body'),
  logCount: document.getElementById('log-count'),
  conn: document.getElementById('conn'),
  connText: document.getElementById('conn-text'),
  theme: document.getElementById('theme'),
  exportBtn: document.getElementById('export'),
  note: document.getElementById('export-note'),
  manualForm: document.getElementById('manual-form'),
  tempInput: document.getElementById('temp-input'),
  humInput: document.getElementById('hum-input'),
  manualError: document.getElementById('manual-error'),
  manualResult: document.getElementById('manual-result'),
  historyBody: document.getElementById('history-body'),
  historyCount: document.getElementById('history-count'),
  camOpen: document.getElementById('cam-open'),
  camShot: document.getElementById('cam-shot'),
  camNote: document.getElementById('cam-note'),
  camError: document.getElementById('cam-error'),
  camVideo: document.getElementById('cam-video'),
  camPreviewHint: document.getElementById('cam-preview-hint'),
  camImage: document.getElementById('cam-image'),
  camShotHint: document.getElementById('cam-shot-hint'),
  camCaption: document.getElementById('cam-caption'),
  /* 语音那五样（voice-start / voice-note / voice-error / voice-heard /
     voice-action）E2 起由 web/multimodal.js 自己取，不在这里缓存 ——
     两个文件各缓存一份的话，谁先跑、谁把它换了，都不好查。 */
};

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* 31 显示成 31，25.5 显示成 25.5 */
function fmt(value) {
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function viewFor(status) {
  return STATUS_VIEW[status] || { cls: 'is-unknown', icon: 'check' };
}

/* ---------- 时间格式化 ---------- */

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 把 Date 格式化成 "YYYY-MM-DD HH:mm:ss"。
 *
 * 不用 toLocaleString()：它的输出跟着浏览器和系统区域设置走，中文环境下
 * 可能给出 "2026/9/26 20:30:00"，连补零都不保证，导出的 CSV 里列对不齐，
 * 和 Python 侧发布的时间串也对不上。这里手动拼，格式永远是固定的。
 *
 * 取的是本地时间（getFullYear 这一组），和 Python 侧
 * datetime.now().strftime('%Y-%m-%d %H:%M:%S') 对齐 —— 两边的时间
 * 会出现在同一张表、同一个 CSV 里，所以必须同一套口径。
 *
 * @param {Date} date
 * @returns {string} "YYYY-MM-DD HH:mm:ss"
 */
function formatTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  // 无效日期直接给空串，不要把 "NaN-NaN-NaN NaN:NaN:NaN" 写到页面上
  if (Number.isNaN(d.getTime())) return '';

  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    + ` ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/* ---------- 手动录入：校验 ---------- */

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
 * @param {string} tempText 温度输入框的原始文本
 * @param {string} humText  湿度输入框的原始文本
 * @returns {{ok: boolean, message: string,
 *            temperature: number|null, humidity: number|null}}
 */
function validateInput(tempText, humText) {
  // 全角空格也要算空，所以先 trim 再比
  const tempStr = String(tempText ?? '').trim();
  const humStr = String(humText ?? '').trim();

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

/* ---------- 手动录入：分析 ---------- */

/* 卡片本身不挂状态 class：颜色由外层结果区 #manual-result 带，
   卡片的 --c 从那里继承下来（见 style.css 的 .manual-result .card）。 */
function manualResultHTML(temperature, humidity, status, advice) {
  const view = viewFor(status);
  return `
    <article class="card">
      <div class="card-head">
        <span class="node-name">录入值</span>
        <span class="badge">${ICONS[view.icon]}<span>${esc(status)}</span></span>
      </div>
      <div class="tiles">
        <div>
          <div class="tile-label">温度</div>
          <div class="tile-value">${fmt(temperature)}<span class="tile-unit">℃</span></div>
        </div>
        <div>
          <div class="tile-label">湿度</div>
          <div class="tile-value">${fmt(humidity)}<span class="tile-unit">%</span></div>
        </div>
      </div>
      <p class="advice">${esc(advice)}</p>
    </article>`;
}

/* 校验不通过就把提示写进 #manual-error 并返回，不进入后续分析 */
function analyze() {
  const result = validateInput(el.tempInput.value, el.humInput.value);

  if (!result.ok) {
    el.manualError.textContent = result.message;
    el.manualResult.hidden = true;
    el.manualResult.className = 'manual-result';
    el.manualResult.innerHTML = '';
    return;   // 校验没过：既不分析，也不记历史
  }

  // rules.js 没加载成功时给一句明确提示，而不是抛 undefined 错
  if (typeof judgeStatus !== 'function' || typeof getAdvice !== 'function') {
    el.manualError.textContent = '未加载 shared/rules.js，请检查 <script> 的引入顺序';
    el.manualResult.hidden = true;
    return;
  }

  const status = judgeStatus(result.temperature, result.humidity);
  const advice = getAdvice(status);

  el.manualError.textContent = '';
  // 结果区按状态换 class，颜色由 CSS 里那四档 --c 决定
  el.manualResult.className = `manual-result ${viewFor(status).cls}`;
  el.manualResult.innerHTML = manualResultHTML(
    result.temperature, result.humidity, status, advice,
  );
  el.manualResult.hidden = false;

  /* 到这一步才算分析成功，记一笔。
     push 是往末尾追加，不会覆盖已有的记录；时间是提交这一刻的本地时间。
     上面两个 return 都在这之前，所以校验失败不会污染历史。 */
  history.push({
    time: formatTime(new Date()),
    temperature: result.temperature,
    humidity: result.humidity,
    status,
  });
  renderHistory();
}

/* ---------- 手动录入：历史记录 ---------- */

function historyRowHTML(record) {
  const view = viewFor(record.status);
  return `
    <tr class="${view.cls}">
      <td class="time">${esc(record.time)}</td>
      <td class="num">${fmt(record.temperature)}</td>
      <td class="num">${fmt(record.humidity)}</td>
      <td><span class="mini">${ICONS[view.icon]}<span>${esc(record.status)}</span></span></td>
    </tr>`;
}

/**
 * 按显示顺序（最新的在前）取记录。
 *
 * history 里是 push 追加的（旧 -> 新），这里倒着走，而不是去 unshift 数组 ——
 * 一条记录只存一份，顺序只在取的时候决定。
 *
 * 表格和导出 CSV 都走这个函数，两处顺序才不会各说各话：
 * 页面上看着是什么顺序，导出来就是什么顺序。
 *
 * @returns {object[]} 新 -> 旧
 */
function historyRows() {
  const rows = [];
  for (let i = history.length - 1; i >= 0; i--) {
    rows.push(history[i]);
  }
  return rows;
}

/**
 * 把 history 渲染成「时间 | 温度℃ | 湿度% | 状态」，最新的在最上面。
 * 顺便把「共 N 条记录」写进 #history-count。
 */
function renderHistory() {
  /* 页面上没有这块时静默跳过，不影响订阅和渲染。
     和下面手动录入面板的存在性判断是同一个思路。 */
  if (!el.historyBody) return;

  if (history.length === 0) {
    el.historyBody.innerHTML =
      '<tr><td colspan="4" class="history-empty">还没有记录 —— 上面提交一次就会出现。</td></tr>';
  } else {
    el.historyBody.innerHTML = historyRows().map(historyRowHTML).join('');
  }

  if (el.historyCount) {
    el.historyCount.textContent = `共 ${history.length} 条记录`;
  }
}

/* ---------- 渲染 ---------- */

function renderCards(freshNodeId) {
  const ids = [...nodes.keys()].sort();
  el.cards.innerHTML = ids.map((id) => cardHTML(id, nodes.get(id), id === freshNodeId)).join('');
  el.empty.classList.toggle('is-shown', ids.length === 0);
}

function cardHTML(nodeId, p, fresh) {
  const view = viewFor(p.status);
  return `
    <article class="card ${view.cls}${fresh ? ' card--fresh' : ''}">
      <div class="card-head">
        <span class="node-name">${esc(nodeId)}</span>
        <span class="badge">${ICONS[view.icon]}<span>${esc(p.status)}</span></span>
      </div>
      <div class="tiles">
        <div>
          <div class="tile-label">温度</div>
          <div class="tile-value">${fmt(p.temperature)}<span class="tile-unit">℃</span></div>
        </div>
        <div>
          <div class="tile-label">湿度</div>
          <div class="tile-value">${fmt(p.humidity)}<span class="tile-unit">%</span></div>
        </div>
      </div>
      <div class="card-foot">更新于 ${esc(p.time)}</div>
    </article>`;
}

function renderLog() {
  el.logBody.innerHTML = messages.slice(0, MAX_ROWS).map((r) => {
    const view = viewFor(r.status);
    return `
      <tr class="${view.cls}">
        <td class="time">${esc(r.time)}</td>
        <td>${esc(r.nodeId)}</td>
        <td class="num">${fmt(r.temperature)}</td>
        <td class="num">${fmt(r.humidity)}</td>
        <td><span class="mini">${ICONS[view.icon]}<span>${esc(r.status)}</span></span></td>
      </tr>`;
  }).join('');

  const total = messages.length;
  el.logCount.textContent = total > MAX_ROWS
    ? `已记录 ${total} 条 · 表格显示最新 ${MAX_ROWS} 条`
    : (total > 0 ? `已记录 ${total} 条` : '');
}

function setConn(kind, text) {
  el.conn.className = `conn conn--${kind}`;
  el.connText.textContent = text;
}

let noteTimer = null;

/* 按钮旁边的一行反馈，3 秒后自动消失 */
function showNote(text) {
  el.note.textContent = text;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { el.note.textContent = ''; }, 3000);
}

/* ---------- 导出 CSV ---------- */

/* RFC 4180：字段含逗号/引号/换行时要包双引号，内部的双引号写成两个 */
function csvCell(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* 导出的是 history（手动录入的分析历史），不是 MQTT 的 messages。
   走 historyRows()，所以 CSV 的行顺序和页面上看到的完全一致（最新在前）。 */
function buildCSV() {
  const lines = [CSV_HEADER.join(',')];
  for (const r of historyRows()) {
    lines.push([r.time, r.temperature, r.humidity, r.status].map(csvCell).join(','));
  }
  // 用 CRLF 换行：Excel / WPS 对 LF 的兼容性不如 CRLF
  return `${lines.join('\r\n')}\r\n`;
}

function exportCSV() {
  if (history.length === 0) {
    showNote('没有可导出的记录');
    return;
  }

  // \uFEFF 是 UTF-8 BOM。少了它 Excel/WPS 会按本地代码页解析，
  // status 里的中文就会变成乱码。这里写成转义而不是字面量字符，
  // 否则源码里是一段隐形字符，看起来像个空字符串。
  const blob = new Blob(['\uFEFF' + buildCSV()], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = CSV_FILENAME;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // 不能立刻 revoke：部分浏览器会在下载真正开始前就把 blob 释放掉，
  // 表现为"点了没反应"。留一点时间再回收。
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  showNote(`已导出 ${history.length} 条`);
}

/* ---------- 现场快照（摄像头） ----------

   三个函数是给外面用的，都在顶层声明，也就是 window 上的全局函数 ——
   本文件是经典 script，不是 module，顶层 function 自动挂到 window：

     openCamera()    打开摄像头，成功返回 true
     closeCamera()   关掉，把摄像头指示灯熄灭
     takeSnapshot()  拍一张，返回 {ok, message, meta}

   语音那边（web/multimodal.js）通过 DormMateBridge.capture(overlay) 调第三个，
   用返回的 meta 拼一条 snapshot 指令发给 core。这里**不判断**那张照片该挂到
   哪条案卷上 —— 那是快照里的事件说了算，这边连快照长什么样都不知道。

   只保存一张：snapshot 每次被覆盖，不做连续采集，也不把视频帧留在内存里。 */

let cameraStream = null;
let snapshot = null;   // {dataUrl, time}，没拍过是 null

/* getUserMedia 的错误名 -> 人话。要分开说，别笼统地"打开失败"：
   权限被拒要改浏览器设置，没有设备要去插摄像头，被占用要关掉别的程序 ——
   三件事用户要做的事完全不同。一个名字可能新旧浏览器给的不一样，
   所以别名都列上（比如 NotAllowedError 的老名字是 PermissionDeniedError）。 */
const CAMERA_ERRORS = {
  NotAllowedError:
    '摄像头权限被拒绝了。点地址栏左边的图标，把「摄像头」改成「允许」，然后重试。',
  PermissionDeniedError:
    '摄像头权限被拒绝了。点地址栏左边的图标，把「摄像头」改成「允许」，然后重试。',
  NotFoundError: '没找到摄像头设备。确认摄像头接好了、没被禁用，然后重试。',
  DevicesNotFoundError: '没找到摄像头设备。确认摄像头接好了、没被禁用，然后重试。',
  NotReadableError:
    '摄像头被别的程序占用了（QQ / 腾讯会议 / 相机 之类）。关掉它们再重试。',
  TrackStartError:
    '摄像头被别的程序占用了（QQ / 腾讯会议 / 相机 之类）。关掉它们再重试。',
  OverconstrainedError: '摄像头不支持请求的画面参数，换一个摄像头试试。',
  SecurityError: '浏览器出于安全考虑拒绝了摄像头访问。',
};

/* 接口不可用时返回原因，可用时返回空串。
   最常踩的是【安全上下文】：http 页面里 navigator.mediaDevices 直接是
   undefined，报错会变成 "Cannot read properties of undefined"，
   完全看不出是地址的问题。localhost 算安全，但手机用局域网 IP
   （http://192.168.x.x:8000/web/）打开就不算 —— 那条路必须 https。 */
function cameraBlockedReason() {
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) return '';

  if (!window.isSecureContext) {
    return `当前地址（${location.host}）不是安全上下文，浏览器不提供摄像头接口。`
      + '本机请用 http://localhost:8000/web/ 打开；'
      + '手机用局域网 IP 打开时 http:// 也不行，需要 https 或者本机的 localhost。';
  }
  return '这个浏览器不支持摄像头（navigator.mediaDevices 不存在），换新版 Chrome / Edge。';
}

function setCameraError(text) {
  if (el.camError) el.camError.textContent = text;
}

function setCameraNote(text) {
  if (el.camNote) el.camNote.textContent = text;
}

/* 等 video 真正拿到画面尺寸。刚设完 srcObject 时 videoWidth 还是 0，
   这时候截图会得到一张 0×0 的空白图。 */
function waitForVideo(video) {
  if (video.videoWidth > 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok) => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onLoaded);
      resolve(ok);
    };
    const onLoaded = () => done(video.videoWidth > 0);
    // 等不到也别把界面卡死，4 秒后放弃（拍的时候会再检查一次）
    const timer = setTimeout(() => done(false), 4000);
    video.addEventListener('loadedmetadata', onLoaded);
  });
}

async function openCamera() {
  if (!el.camVideo) return false;

  setCameraError('');
  setCameraNote('');

  const blocked = cameraBlockedReason();
  if (blocked) {
    setCameraError(blocked);
    return false;
  }

  // 已经开着就当作"再点一次没坏处"，不重复申请 —— 重复调用会再弹一次权限框
  if (cameraStream) return true;

  let stream;
  try {
    /* 必须由用户手势触发（按钮点击，或下一步语音识别的事件回调里）。
       页面一加载就自动调用会被浏览器直接拒掉。
       浏览器会弹权限框，所以这里一定会等一会儿。 */
    stream = await navigator.mediaDevices.getUserMedia({ video: true });
  } catch (err) {
    const name = err && err.name;
    setCameraError(CAMERA_ERRORS[name]
      || `打开摄像头失败：${(err && err.message) || '未知错误'}`);
    return false;
  }

  cameraStream = stream;
  el.camVideo.srcObject = stream;
  el.camVideo.hidden = false;
  if (el.camPreviewHint) el.camPreviewHint.hidden = true;

  try {
    await el.camVideo.play();
  } catch (err) {
    /* 自动播放被拦不算致命：接着等 loadedmetadata，画面照样会出来。
       真出不来也只是预览不动，拍照那步会自己报"画面还没准备好"。 */
    console.warn('[DormMate] 预览自动播放被拦截：', err);
  }
  await waitForVideo(el.camVideo);

  el.camOpen.textContent = '关闭摄像头';
  el.camShot.disabled = false;
  setCameraNote('摄像头已就绪');
  return true;
}

function closeCamera() {
  if (!el.camVideo) return;

  /* 每一条 track 都要 stop()。只把 srcObject 置空的话画面是没了，
     但摄像头还开着、指示灯还亮着，别的地方也依然抢不到这个设备。 */
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
  }
  cameraStream = null;

  el.camVideo.srcObject = null;
  el.camVideo.hidden = true;
  if (el.camPreviewHint) el.camPreviewHint.hidden = false;

  el.camOpen.textContent = '打开摄像头';
  el.camShot.disabled = true;
  setCameraNote('');
}

/**
 * 水印那一行行字画到画布上（Phase6 E2）。
 *
 * **只负责画，不负责决定画什么。** 那两三行字是 multimodal.js 从快照里算出来的
 * （宿舍名、事件编号、快门时刻、当时的温湿度），从这里传进来。这个文件不认识
 * 快照，也不该认识 —— 它要是开始自己拼水印，就会出现「照片上写 dorm-b、
 * 发出去的指令说 dorm-c」这种只有对图才能发现的分家。
 *
 * 字号按画布宽度算，不写死像素：640 宽的摄像头和 1920 宽的，同一号字一个看不清、
 * 一个占掉半幅。下面铺一条半透明黑带，浅色墙面上也能看清。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {string[]} overlay 每一行
 */
function drawOverlay(ctx, width, height, overlay) {
  const lines = (Array.isArray(overlay) ? overlay : [])
    .map((line) => String(line == null ? '' : line))
    .filter((line) => line !== '');
  if (lines.length === 0) return;

  const size = Math.max(12, Math.round(width / 38));
  const pad = Math.round(size * 0.6);
  const lineHeight = Math.round(size * 1.35);
  const bandHeight = lineHeight * lines.length + pad * 2;

  ctx.font = `${size}px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`;
  ctx.textBaseline = 'top';

  ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
  ctx.fillRect(0, height - bandHeight, width, bandHeight);

  ctx.fillStyle = '#ffffff';
  /* 第一行（宿舍 + 事件编号 + 时刻）加粗：它是这条证据的**身份**，
     后面那行读数变了没关系，这一行是事后拿它对账的。 */
  lines.forEach((line, i) => {
    ctx.font = `${i === 0 ? 'bold ' : ''}${size}px -apple-system, "Segoe UI",`
      + ' "Microsoft YaHei", sans-serif';
    ctx.fillText(line, pad, height - bandHeight + pad + i * lineHeight);
  });
}

/* PNG data URL 解码之后有多少字节。
   画布不留 blob，所以没有更准的途径 —— 差几十字节无所谓，core 那边只拿它
   判断「这是不是一个正常的文件」（0 字节和 3 字节的东西它拒收）。
   base64 的长度关系是 4 个字符换 3 个字节，末尾的 = 是补位，不算。 */
function pngByteLength(dataUrl) {
  const base64 = String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);
  if (!base64) return 0;
  const padding = base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0);
  return Math.floor(base64.length * 3 / 4) - padding;
}

/**
 * 拍一张快照，显示在右边的快照区，覆盖上一张。
 *
 * 画布尺寸取 videoWidth / videoHeight（视频的原始像素），不是 CSS 显示尺寸 ——
 * 显示尺寸跟着窗口宽度变，用它会拍出一会儿大一会儿小、甚至被拉伸的图。
 *
 * @param {string[]} [overlay] 画在画面下方那几行字（E2 的水印）。不给就不画 ——
 *        「拍照」按钮那条预览路就是这么调的。
 * @param {string} [stamp] 这一张的时刻。**给了就照用**，不给才现读时钟。
 *        调用方（web/multimodal.js）一定要给：水印上印的那个时刻和指令里报的
 *        那个 stamp 必须是**同一个字符串**，而水印是在这里画上去的、指令是它
 *        拼的 —— 各自读一次钟就会差上一两秒，事后拿照片跟案卷对账的人会以为
 *        有两张照片。
 * @returns {{ok: boolean, message: string, meta: Object|null}}
 *          ok 为 false 时 message 是原因，直接播报就行。
 *          meta 是**发指令要用的那几个数**：{stamp, width, height, bytes, ext}
 *          —— 「哪张照片」由它说清楚，照片本身留在浏览器里。
 */
function takeSnapshot(overlay, stamp) {
  if (!el.camVideo) {
    return { ok: false, message: '这个页面没有快照区', meta: null };
  }

  if (!cameraStream) {
    const message = '摄像头还没打开，先点「打开摄像头」';
    setCameraError(message);
    return { ok: false, message, meta: null };
  }

  const width = el.camVideo.videoWidth;
  const height = el.camVideo.videoHeight;
  if (!width || !height) {
    const message = '画面还没准备好，等一秒再拍';
    setCameraError(message);
    return { ok: false, message, meta: null };
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  // 画布不进 DOM，纯粹当一次性的转换工具用
  const ctx = canvas.getContext('2d');
  ctx.drawImage(el.camVideo, 0, 0, width, height);
  drawOverlay(ctx, width, height, overlay);

  /* 时刻：调用方给了就用它给的（见上面那段说明），没给才现读。 */
  const time = typeof stamp === 'string' && stamp ? stamp : formatTime(new Date());
  const dataUrl = canvas.toDataURL('image/png');
  snapshot = { dataUrl, time };   // 覆盖，所以永远只有一张

  el.camImage.src = dataUrl;
  el.camImage.hidden = false;
  if (el.camShotHint) el.camShotHint.hidden = true;
  if (el.camCaption) {
    el.camCaption.textContent = `拍摄于 ${time} · ${width}×${height}`;
    el.camCaption.hidden = false;
  }

  setCameraError('');
  setCameraNote(`已拍下 1 张（${time}）`);
  return {
    ok: true,
    message: `已拍照，${time}`,
    meta: {
      stamp: time,
      width,
      height,
      /* 后缀要小写：文件名的另一半（宿舍名 + 时刻）在 multimodal.js 那边拼，
         它拿到的已经是这一份 meta。 */
      bytes: pngByteLength(dataUrl),
      ext: '.png',
    },
  };
}

/* ---------- 语音指令 / 语音播报（Phase6 E2 搬走了） ----------

   Step 3-2 的识别和 Step 3-3 的播报原本在这个位置，现在整体搬进了
   web/multimodal.js。

   搬走的理由不是「这个文件太长了」，是**数据来源不同**：那两块要回答
   「现在念哪一间」「这张照片算谁的事件」，答案只在 core 的全局快照里
   （焦点、开着的事件、快照登记了几张）—— 遥测里没有。而这份 script.js
   手上的就是遥测。两块混在一个文件里，迟早有人图省事拿「最后一条遥测
   的宿舍」凑一个「当前宿舍」出来：那是前端在替 core 判断，正是被禁的
   那件事，而且**不会报错**，只会念错一间宿舍。

   这个文件留下的两件事：能拍一张照（takeSnapshot），能把指令发出去
   （DormMateBridge.sendCmd）。说什么、念什么、什么时候拍，都在那边。

   为什么那边必须另开一个文件而不是接着写在这儿：那边要用
   dashboard/logic.js 里的纯函数，而 logic.js 是 ES 模块 —— 在经典 script
   的顶层写 import 是语法错误，而**这个文件必须是经典 script**
   （tests/script.test.js 用 vm.runInThisContext 整个跑它，顶层一句 import
   会让整个文件废掉）。所以 index.html 里多挂一个
   <script type="module" src="multimodal.js">，两边靠 window.DormMateBridge 接头。*/

/* ---------- 全局快照，和给外面用的那几个口子（Phase6 E2） ----------

   core 每处理完一条消息就 retained 一帧 dormmate/v1/state，里面是**它那边
   的全貌**：焦点在哪一间、每间开着什么事件、那条事件下面挂了几张快照。
   E2 要的东西全在这里 —— 遥测里只有「读数是多少」。

   这个文件**不解析**它。收到就原样存下来，谁来问给谁。判断形状是
   dashboard/logic.js 的 readSnapshot 的活（它认得的比这里多，而且那边有
   一整段测试对着）。这里再写一遍「v 是不是 2、nodes 是不是数组」，就等于
   多出一份会跟那边分家的解析器：core 加一个字段，两边对「什么叫合法」的
   理解就不一样了，而且只有一边会报错。 */

let state = null;          /* core 最近一帧快照，原样的对象；一帧都没收到过是 null */
const stateListeners = []; /* 快照到了要通知谁（多模态那边注册进来） */

function onStateMessage(payload) {
  let snap;
  try {
    snap = JSON.parse(payload.toString());
  } catch (err) {
    console.warn('[DormMate] 丢弃一帧读不懂的快照：', err.message);
    return;
  }

  state = snap;
  /* 这里**不检查** snap 里有没有该有的字段 —— 原样存、原样给，
     判断留给读的人（见上面的注释）。

     一个回调抛异常不能把排在后面的回调、更不能把 MQTT 那条收包路径带走。
     谁注册的谁负责，这里只保证「每一个都被叫到」。 */
  stateListeners.forEach((fn) => {
    try {
      fn(snap);
    } catch (err) {
      console.error('[DormMate] 快照回调出错：', err);
    }
  });
}

/* 给 web/multimodal.js 用的几个口子。

   一个显式的桥，而不是把内部变量挂到 window 上：那边依赖什么，在这里一眼
   能看全；以后想少给一个，也知道该删哪一行、谁会受影响。 */
window.DormMateBridge = {
  /* 三个 topic 名让那边自己拿去写进说明文字，别在那边再抄一遍字面量 */
  topics: { telemetry: TOPIC, state: STATE_TOPIC, cmd: CFG.CMD_TOPIC },

  /* 「快照到了叫我」。注册的时候**先补手上这一帧**：state 是 retained 的，
     页面一连上就会收到一帧，但那边注册的时刻和这一帧到达的时刻谁先谁后
     不保证 —— 少补这一下，「朗读状态」第一次会念成「还没有收到数据」，
     而屏幕上明明显示着数据。 */
  onState(fn) {
    if (typeof fn !== 'function') return;
    stateListeners.push(fn);
    if (state) fn(state);
  },

  /* 手上这一帧。还没收到过就是 null，**不是空对象** —— 空对象会被下游
     当成「一帧内容都是空的快照」，然后一本正经地念出「还没有数据」。 */
  latestState() { return state; },

  /* 发一条指令给 core。返回的是**发出去没有**，不是 core 收没收 ——
     那是两件事，第二件这里根本无从知道。core 那边的答复走 state 那条路：
     发完等下一帧回来对账（红线：拍照不许在本地把事件写成「已恢复」）。 */
  sendCmd(body) {
    if (!client || !client.connected) return false;
    client.publish(CFG.CMD_TOPIC, JSON.stringify(body), { qos: CFG.QOS, retain: false });
    return true;
  },

  /* 拍一张，把 overlay 那几行字画进画面。返回 {ok, message, meta}，
     meta 是拼那条 snapshot 指令要用的文件信息。
     stamp 由调用方给 —— 水印上印的时刻和指令里报的必须是同一个字符串。 */
  capture(overlay, stamp) { return takeSnapshot(overlay, stamp); },
};

/* ---------- 数据校验（MQTT 侧） ---------- */

function normalize(raw, topicNodeId) {
  const p = JSON.parse(raw);
  if (!p || typeof p !== 'object') throw new Error('payload 不是对象');

  const temperature = Number(p.temperature);
  const humidity = Number(p.humidity);
  if (!Number.isFinite(temperature) || !Number.isFinite(humidity)) {
    throw new Error('temperature / humidity 不是数字');
  }
  if (typeof p.status !== 'string' || !p.status) throw new Error('缺少 status');
  if (typeof p.time !== 'string' || !p.time) throw new Error('缺少 time');

  return {
    nodeId: typeof p.nodeId === 'string' && p.nodeId ? p.nodeId : topicNodeId,
    temperature,
    humidity,
    status: p.status,
    time: p.time,
  };
}

function onMessage(topic, payload) {
  /* 两条 topic 走两个岔口，别合流：快照是 core 的全局视图，不是某间宿舍的
     一条读数，塞进下面那套 normalize 只会被当成非法数据丢掉（它没有
     temperature，还没 nodeId）。 */
  if (topic === STATE_TOPIC) {
    onStateMessage(payload);
    return;
  }

  // dormmate/v1/nodes/<nodeId>/telemetry —— 节点名是第 4 段（下标 3）。
  // 形状不对就交 'unknown'，让下游的一致性检查去报警，不拿猜出来的名字当数。
  const parts = topic.split('/');
  const topicNodeId = parts.length === 5 && parts[0] === 'dormmate'
    && parts[1] === 'v1' && parts[2] === 'nodes' ? parts[3] : 'unknown';

  let data;
  try {
    data = normalize(payload.toString(), topicNodeId);
  } catch (err) {
    console.warn('[DormMate] 丢弃一条非法数据：', err.message, payload.toString());
    return;
  }

  nodes.set(data.nodeId, data);
  messages.unshift(data);
  if (messages.length > MAX_MESSAGES) messages.length = MAX_MESSAGES;

  renderCards(data.nodeId);
  renderLog();
}

/* ---------- 连接 ---------- */

/* 当前那条 MQTT 连接。没连上（或压根没加载 mqtt.js）时是 null ——
   sendCmd 拿它做闸门，不拿"有没有加载过"猜。 */
let client = null;

function connect() {
  if (typeof mqtt === 'undefined') {
    setConn('off', '未加载 mqtt.js');
    el.empty.classList.add('is-shown');
    el.empty.innerHTML = '缺少 <code>web/vendor/mqtt.min.js</code>，请重新下载后刷新。';
    return;
  }

  /* 模块级，不 const 在函数里：sendCmd 要用它（E2 起这个文件会发指令，
     不再只是收）。 */
  client = mqtt.connect(BROKER_URL, {
    clientId: `dormmate-web-${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 5000,
    keepalive: 30,
  });

  client.on('connect', () => {
    setConn('on', '已连接');
    /* 两条都订，各喂各的：遥测喂看板（卡片 / 最近消息 / CSV / 历史记录），
       state 喂 E2 那套多模态（念哪一间、快照挂给谁、按钮该不该亮）。
       把 state 换掉遥测是不行的 —— 快照里没有逐条消息，CSV 和历史就空了。 */
    client.subscribe([TOPIC, STATE_TOPIC], { qos: CFG.QOS }, (err) => {
      if (err) {
        console.error('[DormMate] 订阅失败：', err);
        setConn('off', '订阅失败');
      }
    });
  });

  client.on('reconnect', () => setConn('pending', '重连中…'));
  client.on('close', () => setConn('off', '已断开'));
  client.on('error', (err) => {
    console.error('[DormMate] 连接错误：', err);
    setConn('off', '连接失败');
  });

  client.on('message', onMessage);
}

/* ---------- 主题 ---------- */

function isDark() {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  el.theme.textContent = isDark() ? '浅色' : '深色';
}

el.theme.addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  localStorage.setItem('dormmate-theme', next);
  applyTheme(next);
});

el.exportBtn.addEventListener('click', exportCSV);

/* 手动录入面板。加了存在性判断：万一这份 script.js 被贴到没有该面板的
   index.html 上，也只是这个功能不可用，不会整个页面报错。 */
if (el.manualForm) {
  el.manualForm.addEventListener('submit', (event) => {
    event.preventDefault();   // 表单默认提交会刷新页面
    analyze();
  });

  // 用户开始改输入就清掉上一次的错误提示
  [el.tempInput, el.humInput].forEach((input) => {
    input.addEventListener('input', () => { el.manualError.textContent = ''; });
  });
}

/* 现场快照。和手动录入面板一样先判存在性。 */
if (el.camOpen) {
  el.camOpen.addEventListener('click', () => {
    /* 同一个按钮兼作开关：开着的时候再点是关掉。
       留个关的地方，不然摄像头指示灯会一直亮着，用户只能去关标签页。 */
    if (cameraStream) {
      closeCamera();
      return;
    }
    openCamera().catch((err) => {
      console.error('[DormMate] 打开摄像头时出错：', err);
      setCameraError(`打开摄像头失败：${(err && err.message) || err}`);
    });
  });

  /* E2 起这个按钮要走多模态那边：照片要带水印（宿舍 / 事件编号 / 时刻），
     还要把文件信息发回 core 归档 —— 两件事都得先知道**当前焦点是哪一间**，
     那在 state 里，这个文件没有。

     那边没加载时就还是拍一张裸的：页面不该因为少一个可选模块，连
     「打开摄像头看一眼」都用不了（那也是 3-1 那一步的交付物）。 */
  el.camShot.addEventListener('click', () => {
    const mm = window.DormMateMultimodal;
    if (mm && typeof mm.recordScene === 'function') {
      mm.recordScene();
      return;
    }
    takeSnapshot();
  });

  /* 离开页面（关标签、手机切走被回收）时把摄像头关掉。
     用 pagehide 不用 beforeunload：移动端 Safari 常常不触发后者。 */
  window.addEventListener('pagehide', closeCamera);
}

/* 语音按钮的注册跟着那整块一起搬去了 web/multimodal.js（那边自己判
   #voice-start 在不在，并自己挂 pagehide 收麦克风）。 */

/* ---------- 启动 ---------- */

document.getElementById('broker-label').textContent = BROKER_URL;
document.getElementById('topic-label').textContent = TOPIC;
/* E2 多出来的两条 topic 也显示出来。文案从 CFG 取 —— 页面里再写一遍
   'dormmate/v1/state' 的话，改一处忘一处的时候页面上会挂着旧地址，
   而那正是用来核对「到底连的是哪儿」的那行字（和 8-1 同一条口径）。 */
const stateLabel = document.getElementById('state-label');
if (stateLabel) stateLabel.textContent = STATE_TOPIC;
const cmdLabel = document.getElementById('cmd-label');
if (cmdLabel) cmdLabel.textContent = CFG.CMD_TOPIC;

applyTheme(localStorage.getItem('dormmate-theme') || '');
renderCards();
renderLog();
renderHistory();   // 先渲染一次，好让「共 0 条记录」一开始就显示出来
connect();
