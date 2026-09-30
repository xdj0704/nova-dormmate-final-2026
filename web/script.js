'use strict';

/* DormMate 前端：通过 WebSocket 订阅 MQTT，实时渲染各宿舍环境状态。
   注意：MQTT 数据的 status 一律以发布端发来的字段为准，前端不重算规则。
   唯一的例外是「手动录入分析」——那份数据不经过发布端，只能在前端算，
   用的是 shared/rules.js 的 judgeStatus() / getAdvice()。
   规则不要在本文件或任何页面里再抄一份。 */

/* Broker 地址跟着页面的访问地址走：本机打开就是 ws://localhost:9001，
   手机用 http://10.102.196.160:8000/web/ 打开就是 ws://10.102.196.160:9001。
   写死 localhost 的话，手机浏览器里的 localhost 指的是手机自己，连不回来。
   （file:// 直开时 hostname 是空串，退回 localhost —— 那种打开方式本来就
   连不上 WebSocket，这里只是别让它拼出 ws://:9001 这种烂地址。） */
function brokerUrl(hostname) {
  return `ws://${hostname || 'localhost'}:9001`;
}

const BROKER_URL = brokerUrl(location.hostname);
const TOPIC = 'dormmate/v1/nodes/+/telemetry';

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
  voiceStart: document.getElementById('voice-start'),
  voiceNote: document.getElementById('voice-note'),
  voiceError: document.getElementById('voice-error'),
  voiceHeard: document.getElementById('voice-heard'),
  voiceAction: document.getElementById('voice-action'),
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
     takeSnapshot()  拍一张，返回 {ok, message}

   下一步的语音指令「拍照」直接调 takeSnapshot() 就行，用返回的 message
   做播报 / 提示，不用自己去分辨是没开摄像头还是画面没就绪。

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
 * 拍一张快照，显示在右边的快照区，覆盖上一张。
 *
 * 画布尺寸取 videoWidth / videoHeight（视频的原始像素），不是 CSS 显示尺寸 ——
 * 显示尺寸跟着窗口宽度变，用它会拍出一会儿大一会儿小、甚至被拉伸的图。
 *
 * @returns {{ok: boolean, message: string}} ok 为 false 时 message 是原因，
 *          语音指令直接播报它就行。
 */
function takeSnapshot() {
  if (!el.camVideo) {
    return { ok: false, message: '这个页面没有快照区' };
  }

  if (!cameraStream) {
    const message = '摄像头还没打开，先点「打开摄像头」';
    setCameraError(message);
    return { ok: false, message };
  }

  const width = el.camVideo.videoWidth;
  const height = el.camVideo.videoHeight;
  if (!width || !height) {
    const message = '画面还没准备好，等一秒再拍';
    setCameraError(message);
    return { ok: false, message };
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  // 画布不进 DOM，纯粹当一次性的转换工具用
  canvas.getContext('2d').drawImage(el.camVideo, 0, 0, width, height);

  const time = formatTime(new Date());
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
  return { ok: true, message: `已拍照，${time}` };
}

/* ---------- 语音指令（Step 3-2） ----------

   用浏览器自带的 SpeechRecognition（Chrome / Edge 上带 webkit 前缀）。
   每次点击只识别一句：continuous = false，拿到结果或出错都让它结束。
   不做连续听 —— 连续模式下"一句话说完了"由引擎自己判断，教室里一吵
   就会把旁边的闲聊也识别进来。 */

const VOICE_LANG = 'zh-CN';

/* 非空就表示"正在听"。用来挡住重复点击 —— 连点两次会走到 start() 抛
   InvalidStateError，比直接忽略第二次点击难解释得多。 */
let recognition = null;

/* 固定指令。用「包含」判断而不是整句相等：识别引擎会把标点和语气词
   一起吐出来（"朗读一下。"、"帮我拍张照"），整句比对永远匹配不上。
   数组顺序就是判断顺序，第一条命中的赢 —— 说"朗读并且拍照"会走朗读。 */
const VOICE_COMMANDS = [
  { keyword: '朗读', run: speakStatus },
  { keyword: '拍照', run: takeSnapshot },
];

/* 错误码 -> 人话。注意这张表只能"加一句解释"，不能拿它替掉错误码：
   表里没有的码（浏览器各版本一直在加新的）也得照样显示出来。 */
const VOICE_ERRORS = {
  'not-allowed': '麦克风权限被拒绝了。点地址栏左边的图标，把「麦克风」改成「允许」，然后重试。',
  'service-not-allowed': '浏览器拒绝了语音识别服务（策略限制，或当前不是安全上下文）。',
  'audio-capture': '没找到麦克风。确认设备接好了、没被别的程序占用，然后重试。',
  'no-speech': '没听到声音。靠近麦克风、说大声一点再试。',
  network: '连不上语音识别服务（network）。Chrome 是把录音传到服务器上识别的，断网或代理拦截都会这样。',
  aborted: '识别被中断了。再点一次「语音指令」重试。',
  'language-not-supported': '识别服务不支持 zh-CN。',
};

function speechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/* 原始的 event.error 一定写在最前面：解释文案可能对不上，错误码不会骗人。 */
function voiceErrorMessage(code) {
  const name = code || 'unknown';
  const hint = VOICE_ERRORS[name];
  return hint ? `语音识别出错（${name}）：${hint}` : `语音识别出错（${name}）`;
}

function setVoiceError(text) { if (el.voiceError) el.voiceError.textContent = text; }
function setVoiceNote(text) { if (el.voiceNote) el.voiceNote.textContent = text; }

/* 两个结果区。isPlaceholder 由调用方明确传进来，决定用弱色还是正常墨色 ——
   不去比较文本内容猜"这是不是占位文案"，那样迟早会被真结果撞上。 */
function setVoiceHeard(text, isPlaceholder = false) {
  if (!el.voiceHeard) return;
  el.voiceHeard.textContent = text;
  el.voiceHeard.classList.toggle('is-placeholder', isPlaceholder);
}

function setVoiceAction(text, isPlaceholder = false) {
  if (!el.voiceAction) return;
  el.voiceAction.textContent = text;
  el.voiceAction.classList.toggle('is-placeholder', isPlaceholder);
}

/* ---------- 语音播报（Step 3-3） ----------

   用浏览器自带的 speechSynthesis。和 Step 3-2 的识别不一样：识别要联网
   （Chrome 是把录音传上去识别的），合成不用 —— 声音就在本机，断网也念得出来。

   念的是**当前收到的所有节点**，一句话念完。念什么由下面这两个函数现算，
   页面一个字都不拼 —— 和看板那边 8-3 的分工是同一条原则。 */

const SPEECH_LANG = 'zh-CN';

/* 正在念的那一句。留个引用不是"记住上一条"（每次都是现算的），是防一个真实的坑：
   Chrome 里 utterance 被 GC 掉，念到一半会直接停。变量一直指着它，它就活着。 */
let speaking = null;

/**
 * 浏览器支不支持语音合成。
 *
 * 两个都要查：Chrome 上 speechSynthesis 一直在，但 SpeechSynthesisUtterance
 * 是个构造函数，缺了它 `new` 出来就是个 TypeError。少查一个的话，不支持的
 * 环境里说一句「朗读」就是一条未捕获的异常 —— 界面上只表现为"什么都没发生"。
 * （看板那边 8-3 查的是同样两样东西。）
 */
function speechSupported() {
  return typeof window.speechSynthesis !== 'undefined'
    && typeof window.SpeechSynthesisUtterance === 'function';
}

/**
 * 要念的那句话，形如 `dorm-a 25℃ 60% 正常；dorm-b 31℃ 78% 偏热`。
 *
 * 状态直接取报文里的 `status`，**不重算**。规则在这个项目里只有一份实现
 * （Python 侧的 `status_rules`，页面和看板都只负责渲染）；前端自己再算一遍的话，
 * 屏幕上显示的和耳朵听到的迟早会在某条边界数据上分家，而且不报错。
 *
 * 按 nodeId 排序，不是按收到的先后。同一份数据念出来的句子必须每次都一样 ——
 * 顺序跟着到达时间跑的话，连"刚才念的和现在念的是不是同一句"都没法比。
 *
 * 一个节点都没有时说的是「还没有收到」，**不是「都正常」**：页面刚打开那几秒
 * 是**不知道**，说成"正常"就是句假话（和看板 B1 / B4 同一个口径）。
 */
function statusReadout() {
  const lines = [...nodes.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id, p]) => `${id} ${fmt(p.temperature)}℃ ${fmt(p.humidity)}% ${p.status}`);
  return lines.length ? lines.join('；') : '还没有收到任何节点的数据';
}

/**
 * 把当前状态念出来。
 *
 * 返回值仍然是 `{ok, message}`，和 `takeSnapshot()` 同一个形状 ——
 * 路由层（`handleVoiceText`）不用分辨命令是谁，拿到结果直接显示就行。
 *
 * **message 就是"要念的那句话"本身**，不是另写一句提示。静音、没音箱、音量
 * 太小的场合，页面上那行字是唯一能确认"它到底念了什么"的地方；提示语和朗读
 * 内容各写各的，那行字就失去意义了（看板 8-3 也是这么处理的）。
 *
 * 先 `cancel()` 再 `speak()`：连着说两次「朗读」，第二句会老老实实排在队列里
 * 等着，等第一句念完（三个节点要好几秒）才开口，而那时候念的是**上一次算出来
 * 的**内容，早就不算数了。掐掉上一句、立刻念最新的才对。
 */
function speakStatus() {
  const text = statusReadout();

  if (!speechSupported()) {
    return {
      ok: false,
      message: '这个浏览器不支持语音合成（window.speechSynthesis 不存在）。'
        + '要念的是：' + text,
    };
  }

  window.speechSynthesis.cancel();

  speaking = new window.SpeechSynthesisUtterance(text);
  speaking.lang = SPEECH_LANG;

  /* 出错也要说出来。这时候路由层已经把「正在朗读…」显示上去了，不覆盖的话
     页面会一直声称它在念 —— 而实际上什么都没响。原始的错误码写在最前面：
     解释文案可能对不上，错误码不会骗人（和 3-2 那张 VOICE_ERRORS 表、
     看板 8-3 是同一条原则）。 */
  speaking.onerror = function (event) {
    const code = (event && event.error) ? event.error : 'unknown';
    setVoiceAction(`朗读失败（${code}）。要念的是：${text}`, false);
  };

  window.speechSynthesis.speak(speaking);
  return { ok: true, message: '正在朗读：' + text };
}

/* 把识别到的文字派发给固定指令。
   命令自己返回 {ok, message}，这里只负责显示 —— 成功还是失败是命令
   自己的事，路由层不替它判断。 */
function handleVoiceText(text) {
  const heard = String(text || '').trim();
  setVoiceHeard(heard, false);

  if (!heard) {
    setVoiceAction('没识别到内容，再说一次', true);
    return;
  }

  const cmd = VOICE_COMMANDS.find((c) => heard.includes(c.keyword));
  if (!cmd) {
    setVoiceAction(`未识别的指令：${heard}`, false);
    return;
  }

  const outcome = cmd.run();
  if (outcome && outcome.message) setVoiceAction(outcome.message, false);
  else setVoiceAction(`已执行「${cmd.keyword}」`, true);
}

function resetVoiceButton() {
  if (!el.voiceStart) return;
  el.voiceStart.textContent = '语音指令';
  el.voiceStart.classList.remove('is-listening');
}

function startVoiceCommand() {
  const Ctor = speechRecognitionCtor();
  if (!Ctor) {
    setVoiceError(
      '这个浏览器不支持语音识别（window.SpeechRecognition 不存在）。换新版 Chrome / Edge。',
    );
    return;
  }
  if (recognition) return;   // 正在听，忽略这次点击

  setVoiceError('');
  setVoiceNote('请说指令…');

  const rec = new Ctor();
  rec.lang = VOICE_LANG;        // 中文
  rec.continuous = false;       // 只识别一句，说完就结束
  rec.interimResults = false;   // 只要最终结果，不要边听边变的中间稿

  recognition = rec;

  rec.onstart = () => {
    if (el.voiceStart) {
      el.voiceStart.textContent = '正在听…';
      el.voiceStart.classList.add('is-listening');
    }
    setVoiceNote('正在收音…');
  };

  rec.onresult = (event) => {
    /* results 是个列表，每项带 isFinal。interimResults=false 时通常只有
       一条 final，但别假设只有一条 —— 全拼起来更稳。 */
    let text = '';
    for (let i = event.resultIndex || 0; i < event.results.length; i++) {
      text += event.results[i][0].transcript;
    }
    handleVoiceText(text);
  };

  rec.onerror = (event) => {
    setVoiceError(voiceErrorMessage(event && event.error));
  };

  rec.onend = () => {
    recognition = null;
    resetVoiceButton();
    setVoiceNote('');
  };

  try {
    rec.start();
  } catch (err) {
    /* 正常走不到这里（上面已经挡住重复点击），兜个底：别让异常冒出去，
       把按钮永远卡在"正在听"。 */
    recognition = null;
    resetVoiceButton();
    setVoiceError(`启动语音识别失败：${(err && err.message) || err}`);
  }
}

/* 离开页面时把还在听的会话掐掉，别让麦克风一直开着 */
function stopVoiceCommand() {
  if (!recognition) return;
  /* 主动 abort 也会触发 onerror（error === 'aborted'），但那是我们自己
     干的，不该当成错误显示给用户，所以先把回调摘掉再中止。 */
  recognition.onerror = null;
  try {
    recognition.abort();
  } catch (err) {
    console.warn('[DormMate] 中止语音识别时出错：', err);
  }
  recognition = null;
}

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

function connect() {
  if (typeof mqtt === 'undefined') {
    setConn('off', '未加载 mqtt.js');
    el.empty.classList.add('is-shown');
    el.empty.innerHTML = '缺少 <code>web/vendor/mqtt.min.js</code>，请重新下载后刷新。';
    return;
  }

  const client = mqtt.connect(BROKER_URL, {
    clientId: `dormmate-web-${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 5000,
    keepalive: 30,
  });

  client.on('connect', () => {
    setConn('on', '已连接');
    client.subscribe(TOPIC, { qos: 1 }, (err) => {
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

  el.camShot.addEventListener('click', () => takeSnapshot());

  /* 离开页面（关标签、手机切走被回收）时把摄像头关掉。
     用 pagehide 不用 beforeunload：移动端 Safari 常常不触发后者。 */
  window.addEventListener('pagehide', closeCamera);
}

/* 语音指令。和上面两块一样先判存在性。 */
if (el.voiceStart) {
  el.voiceStart.addEventListener('click', startVoiceCommand);

  /* 离开页面时中止会话 —— 和摄像头一样，不收拾的话麦克风会一直开着。
     两条 pagehide 是分开注册的，互不影响。 */
  window.addEventListener('pagehide', stopVoiceCommand);
}

/* ---------- 启动 ---------- */

document.getElementById('broker-label').textContent = BROKER_URL;
document.getElementById('topic-label').textContent = TOPIC;

applyTheme(localStorage.getItem('dormmate-theme') || '');
renderCards();
renderLog();
renderHistory();   // 先渲染一次，好让「共 0 条记录」一开始就显示出来
connect();
