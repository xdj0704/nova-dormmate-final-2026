/* web/multimodal.js —— Phase6 E2：语音（ASR / TTS）与摄像头快照的绑定。

   【为什么是单独一个文件，而不是接着写在 web/script.js 里】
   这个文件要算「现在该念哪一句」，那个算法在 dashboard/logic.js 里
   （speakLine / selectedNode），而 logic.js 是 **ES 模块** —— 在经典 script 的
   顶层写 import 是语法错误，而 web/script.js 必须是经典 script（tests/script.test.js
   用 vm.runInThisContext 整个跑它）。所以这里用 <script type="module">，
   通过 window.DormMateBridge 跟 script.js 接头：
     取数据：bridge.onState(fn) / bridge.latestState()
     发指令：bridge.sendCmd(body)
     拍照片：bridge.capture(overlay) -> {ok, message, meta}

   【数据只有一条来源：core 的全局快照】
   念什么、照片挂给谁、焦点在哪一间，全部从 dormmate/v1/state 那一帧里读。
   这个文件**不碰遥测** —— 遥测里只有「读数是多少」，没有「谁开着什么事件」。
   拿遥测凑一个「当前宿舍」出来是前端在替 core 判断（禁的那件事），而且不报错。
   同理，快照能不能读懂由 logic.js 的 readSnapshot 说了算，这里不自己判形状。

   【浏览器限制（务必写进 README，演示前先看这一条）】
   SpeechRecognition 和 getUserMedia 都只在**安全上下文**里可用：
     - http://localhost:8000   ✓ 算安全上下文
     - http://127.0.0.1:8000   ✓
     - file:///.../index.html   ✗ 不是安全上下文（不是 http(s)）
     - http://192.168.x.x:8000 ✗ 局域网 IP 走 http，不算安全上下文
   所以手机扫码（局域网 IP）打开这个页面时，麦克风和摄像头都会被浏览器拦掉，
   页面会显示「不是安全上下文」那一句。要演示就老实用本机 localhost。
   Chrome 把识别打到云端做，所以 ASR **还要联网**；TTS 在本机合成，断网也能念。 */

import {
  readSnapshot,
  selectedNode,
  nodeOf,
  openEvent,
  focusBanner,
  speakLine,
} from '../dashboard/logic.js';

const CFG = window.DormMateConfig;
if (!CFG) {
  throw new Error('web/multimodal.js 需要 window.DormMateConfig：'
    + 'index.html 里要先引 ../shared/config.js（而且要在本模块之前）。');
}

const BRIDGE = window.DormMateBridge;
if (!BRIDGE) {
  throw new Error('web/multimodal.js 需要 window.DormMateBridge：'
    + '它是 web/script.js 建起来的，顺序错了或者那个文件报错了。');
}

/* 指令里带的来源。core 会把它打进日志：`[指令] dorm-b focus（web）`——
   演示时一眼分出这一条是人按的、还是手机发的、还是 send_cmd.py 发的。
   自由字符串，各端写自己的名字（见 shared/config.js 的 CMD_ACTION_FOCUS）。 */
const SOURCE = 'web';

const SPEECH_LANG = 'zh-CN';

const el = {
  start: document.getElementById('voice-start'),
  note: document.getElementById('voice-note'),
  error: document.getElementById('voice-error'),
  heard: document.getElementById('voice-heard'),
  action: document.getElementById('voice-action'),
  focus: document.getElementById('voice-focus'),
};

/* ---------- 显示那几行字 ---------- */

function setError(text) { if (el.error) el.error.textContent = text; }
function setNote(text) { if (el.note) el.note.textContent = text; }

/* 两个结果区。isPlaceholder 由调用方明确传进来决定用弱色还是正常墨色 ——
   不去比较文本内容猜「这是不是占位文案」，那样迟早被真结果撞上。 */
function setHeard(text, isPlaceholder) {
  if (!el.heard) return;
  el.heard.textContent = text;
  el.heard.classList.toggle('is-placeholder', isPlaceholder === true);
}

function setAction(text, isPlaceholder) {
  if (!el.action) return;
  el.action.textContent = text;
  el.action.classList.toggle('is-placeholder', isPlaceholder === true);
}

function setFocus(text, isPlaceholder) {
  if (!el.focus) return;
  el.focus.textContent = text;
  el.focus.classList.toggle('is-placeholder', isPlaceholder === true);
}

/* ---------- 快照：读它，不解析它 ---------- */

/* 那两条 topic 的名字只在 shared/config.js 里有一份，这里要写进提示文案的时候
   得问它 —— 这个文件里一个 topic 字面量都不写：写一个就多一处出处，
   改端口 / 改命名的那天，页面会指着一个连不上的 topic 教人怎么排查。 */
function stateTopic() {
  return (BRIDGE.topics && BRIDGE.topics.state) || 'core 的快照 topic';
}


/**
 * 手上这一帧快照，**已经过 readSnapshot 那一关**。
 *
 * 读不懂的时候返回 null，并且把原因写进「执行结果」那行字 —— 页面上最常见
 * 的两种「读不懂」是 core 还没起来（一帧都没收到）和新旧版本混跑（v 对不上），
 * 两种的说法完全不一样，所以原因要照抄 logic.js 给的那句，不自己编。
 *
 * @returns {Object|null}
 */
function readySnapshot() {
  const raw = BRIDGE.latestState();
  if (raw === null || raw === undefined) {
    setAction('还没有收到 core 的快照（' + stateTopic() + ' 一帧都没到）。'
      + '确认 core.py 在跑、而且连的是同一个 broker。', false);
    return null;
  }
  const checked = readSnapshot(raw);
  if (!checked.ok) {
    setAction('core 那一帧快照读不懂：' + checked.reason, false);
    return null;
  }
  return checked.snapshot;
}

/* ---------- 中文别名 ---------- */

/**
 * 把一段话压成「只留字母数字汉字」的形式，用来做包含判断。
 *
 * 说话的识别结果里大小写、空格、连字符、下划线全看引擎心情：
 * 「dorm-b」「Dorm B」「dormb」「dorm_b」都会被吐出来。比较之前先抹平，
 * 比给每一种写法各列一条别名靠谱 —— 别名表列不全，抹平不会漏。
 */
function normalize(text) {
  return String(text === null || text === undefined ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]/g, '');
}

const ORDINAL_CHARS = '一二三四五六七八九';

/** 「一」/「3」→ 0 基下标；认不出来是 -1。 */
function ordinalOf(ch) {
  const digit = '123456789'.indexOf(ch);
  if (digit >= 0) return digit;
  return ORDINAL_CHARS.indexOf(ch);
}

/**
 * 语音里点名的第几间：`第一个` / `第2间` / `三号` / `二号宿舍`。
 *
 * 认不出来返回 -1（不是 0）—— 「没点名」和「点的是第一间」必须分得开，
 * 混成一个值的话，一句「查看」会静悄悄切到第一间去。
 */
function ordinalIndex(text) {
  const t = String(text === null || text === undefined ? '' : text);
  let m = t.match(/第\s*([一二三四五六七八九1-9])\s*(?:个|间|号|室)?/);
  if (!m) m = t.match(/([一二三四五六七八九1-9])\s*号/);
  return m ? ordinalOf(m[1]) : -1;
}

/**
 * 从一句话里认出是哪一间宿舍。认不出返回空串。
 *
 * 两条路，顺序有讲究：
 *   1) 名字：快照里哪个 nodeId（抹平之后）出现在这句话里。取**最长**的那个 ——
 *      节点名以后要是变成 dorm-a1 / dorm-a10，短的先命中就会认错一间。
 *   2) 第几间：按快照里 nodes 的**顺序**取（core 给的顺序是它配置里的顺序，
 *      那是唯一稳定的顺序；这个文件里没有任何写死的宿舍名）。
 *      名字没认出来才走这条：「查看 dorm-b」里没有序数词。
 *
 * 「名字」这条路必须排在前面：说「看第三间」时如果恰好有个宿舍叫「三间」，
 * 名字是更明确的意图。这条推理只在两句都成立时才有区别，所以顺序写死在这里。
 *
 * @param {Object|null} snapshot
 * @param {string} text
 * @returns {string} nodeId，认不出是空串
 */
function resolveNode(snapshot, text) {
  const list = snapshot && Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const flat = normalize(text);

  let best = '';
  list.forEach((node) => {
    if (!node || typeof node.nodeId !== 'string' || !node.nodeId) return;
    const name = normalize(node.nodeId);
    if (name && flat.indexOf(name) >= 0 && name.length > best.length) best = node.nodeId;
  });
  if (best) return best;

  const index = ordinalIndex(text);
  if (index >= 0 && index < list.length && list[index] && list[index].nodeId) {
    return list[index].nodeId;
  }
  return '';
}

/** 「快照里都有哪几间」——认不出宿舍名时把候选说出来，别只说「没听懂」。 */
function nodeNames(snapshot) {
  const list = snapshot && Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  return list
    .map((node) => (node && typeof node.nodeId === 'string' ? node.nodeId : ''))
    .filter((name) => name !== '')
    .join('、');
}

/**
 * 例句里那个宿舍名，从**快照**里取（第一个节点），不写死。
 *
 * 有三处提示要给人一个例句（「不知道拍哪一间 / 不知道念哪一间」）。写死
 * `查看 dorm-b` 的话，core 的 config.json 里那几间一改，页面就会指着一个
 * 不存在的宿舍教人怎么说话 —— 而且不会有任何报错，试的人只会以为语音坏了。
 * 一帧快照都没收到时退成一句不带名字的说法。
 */
function exampleNode(snapshot) {
  const list = snapshot && Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const first = list.length && list[0] && typeof list[0].nodeId === 'string'
    ? list[0].nodeId : '';
  return first ? '查看 ' + first : '查看 <宿舍名>';
}

/* ---------- 指令表 ---------- */

/**
 * 固定指令。**数组顺序就是判断顺序**，第一条命中的赢 —— 和 web/script.js 里
 * 3-2 那一版是同一条规矩（那边现在空了，规矩还在）。
 *
 * 关键词用「包含」判断而不是整句相等：识别引擎会把语气词和标点一起吐出来
 * （「朗读一下。」「帮我拍张照」），整句比对永远匹配不上。
 *
 * 每条命令自己返回 {ok, message}，路由层只负责显示 —— 成没成是命令自己的事。
 * 顺序上要注意：'记录现场' 必须在 '记录' 前面是没意义的（同一条里按前后无所谓，
 * 因为都指向同一条命令）；真正要当心的是**跨条目**的包含，比如 '开始' 和
 * '开始处理' —— 它们在同一条里，无害。所以这张表里各条的关键词互不包含。
 */
const VOICE_COMMANDS = [
  {
    id: 'focus',
    label: '查看',
    /* 「查看 dorm-b」→ focus 指令。别名里没有单独一个「看」：太短，
       一句「这个看着还行」会误命中，而要切焦点的人不会只说一个「看」。 */
    keywords: ['查看', '看看', '看一下', '看下', '聚焦', '切到', '切换到',
      '转到', '调到', '换到', '切换'],
    run: doFocus,
  },
  {
    id: 'snapshot',
    label: '记录现场',
    keywords: ['记录现场', '记录', '拍照', '拍一张', '拍张', '拍下来',
      '拍摄', '快照', '抓拍'],
    run: doSnapshot,
  },
  {
    id: 'speak',
    label: '朗读状态',
    keywords: ['朗读', '播报', '读一下', '念一下', '念一遍', '念', '读'],
    run: doSpeak,
  },
  {
    id: 'handle',
    label: '开始处理',
    keywords: ['开始处理', '处理一下', '去处理', '处理', '开始'],
    run: doHandle,
  },
];

/* 错误码 -> 人话。这张表只能「加一句解释」，不能拿它替掉错误码：
   表里没有的码（浏览器各版本一直在加新的）也得照样显示出来。 */
const VOICE_ERRORS = {
  'not-allowed': '麦克风权限被拒绝了。点地址栏左边的图标，把「麦克风」改成「允许」，然后重试。',
  'service-not-allowed': '浏览器拒绝了语音识别服务（策略限制，或当前不是安全上下文 —— 用 localhost 打开）。',
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

/* ---------- 四条指令 ---------- */

/**
 * 指令发出去之后拼一句人话。
 *
 * 【措辞是这一步的交付物之一】成功那句只说「已发出」，**不说「焦点已切到」**。
 * 这边只知道报文交给了 broker，core 收没收、认不认都得等下一帧快照 —— 说成
 * 「已切到」就是本地替 core 宣布结果，而报文丢了的那个场合屏幕上照样写着切好了。
 */
function sentLine(what, ok, nodeId) {
  if (!ok) {
    return '「' + what + '」没发出去：MQTT 还没连上（' + nodeId + '）。'
      + '等一下重试 —— 这会儿屏幕上什么都不会变，因为确实什么都没发出去。';
  }
  return '已发出「' + what + '」指令（' + nodeId + '），'
    + '等 core 回帧确认 —— 屏幕上不会立刻变，那一拍就是它的往返。';
}

/**
 * 「查看 dorm-b」—— 切全局焦点。
 *
 * **只发指令，不改本地任何东西。** 焦点最后是哪一间由 core 说了算（它把
 * focus 记进快照，看板 / 3D / 这个页面跟着切）。本地先改的话，指令恰好丢了的
 * 时候屏幕上会一直显示一个 core 根本不认的焦点，而且这是那种「看着对、其实错」
 * 的状态，只有对着三个端比对才发现。
 */
function doFocus(text, snapshot) {
  const nodeId = resolveNode(snapshot, text);
  if (!nodeId) {
    const names = nodeNames(snapshot);
    return {
      ok: false,
      message: '没听出是哪一间。'
        + (names ? '快照里现在有：' + names + '。说「查看 ' + names.split('、')[0] + '」这样最稳。'
          : '快照里一个节点都还没有。'),
    };
  }

  const ok = BRIDGE.sendCmd({
    nodeId: nodeId,
    action: CFG.CMD_ACTION_FOCUS,
    source: SOURCE,
  });
  return { ok: ok, message: sentLine('查看 ' + nodeId, ok, nodeId) };
}

/**
 * 「记录现场」—— 拍一张，把文件信息发给 core，挂到那一间此刻未结案的事件上。
 *
 * 【照片本体不过去】只报 stamp / 宽高 / 字节数 / 文件名 / 水印。base64 进了
 * 案卷的话 data/events.json 会被几张图撑到几十兆，而那份文件每次 save 都要
 * 整份重写。core 要的证据是「有人到场并按了快门」，不是那几百 KB 像素。
 *
 * 【红线：拍完什么都不改】这条路一个状态都不动，也不在本地记「已登记 1 张」。
 * 照片是**证据**，「都拍下来了那就当处理过了吧」这一句真写出来红线就没了，
 * 而且不会有任何报错：一间没人按过「开始处理」的宿舍会顶着一张照片显示成
 * 「处理中」。所以下面那个相机数只在**新快照回来之后**才重画（见 watchShot）。
 *
 * 点名哪一间：说了就用说的（「记录 dorm-b 的现场」），没说就用快照里选中的
 * 那一间（selectedNode：被点名 > 是重点 —— 和横幅、和朗读同一套挑法）。
 *
 * @param {string} text
 * @param {Object|null} snapshot
 */
function doSnapshot(text, snapshot) {
  const nodeId = resolveNode(snapshot, text) || selectedNode(snapshot);
  if (!nodeId) {
    return {
      ok: false,
      message: '不知道拍哪一间：快照里既没有人点名（focus），也没有需要关注的'
        + '重点（priority）。先说「' + exampleNode(snapshot) + '」再拍。',
    };
  }

  const event = openEvent(snapshot, nodeId);
  const node = nodeOf(snapshot, nodeId);
  const stamp = formatStamp(new Date());

  const overlay = [];
  /* 第一行是这条证据的**身份**：哪一间、哪条案卷、什么时候拍的。要求里那三样
     （nodeId / event_id / 时间戳）都在这一行上，少一样这张图就没法对账。
     没有未结案的事件时写「未开案」——**不写一个编出来的编号**：事后有人拿
     「事件 dorm-b-xxx」去案卷里查，查不到才最坏。 */
  overlay.push(nodeId + ' · 事件 ' + (event ? event.event_id : '未开案') + ' · ' + stamp);

  /* 第二行是当时的读数，从**快照**里取（core 的权威值），不从遥测里拿 ——
     照片上那行字和案卷里那条事件必须是同一个来源，不然就是两份数据。 */
  const readings = [];
  if (node && Number.isFinite(node.temperature)) readings.push('温度 ' + node.temperature + '℃');
  if (node && Number.isFinite(node.humidity)) readings.push('湿度 ' + node.humidity + '%');
  if (node && node.status) readings.push(node.status);
  if (readings.length) overlay.push(readings.join(' · '));

  /* stamp 传下去：水印上印的那个时刻和下面报给 core 的 stamp 必须是**同一个
     字符串**。各自读一次钟的话会差一两秒，事后拿照片跟案卷对账的人会以为
     拍了两张。 */
  const shot = BRIDGE.capture(overlay, stamp);
  if (!shot.ok) return { ok: false, message: shot.message };

  const meta = shot.meta || {};
  const body = {
    nodeId: nodeId,
    action: CFG.CMD_ACTION_SNAPSHOT,
    source: SOURCE,
    stamp: stamp,
    width: meta.width,
    height: meta.height,
    bytes: meta.bytes,
    file: fileNameFor(nodeId, event, stamp, meta.ext),
    watermark: overlay.join(' / '),
  };
  /* eventId 只在真的有一条案子时才带。空串和缺席在 core 那边是一回事
     （是「前端没意见」，不是「对不上」），那就干脆不带 —— 少一个字段少一处歧义。 */
  if (event) body.eventId = event.event_id;

  const ok = BRIDGE.sendCmd(body);
  const before = event ? cameraCount(event) : 0;
  if (ok) watchShot(nodeId, event ? event.event_id : '', before);

  let message = `已拍下 ${meta.width}×${meta.height}（${meta.bytes} 字节），水印：`
    + overlay[0] + '。';
  message += ok
    ? '文件信息已发给 core，等它回帧确认登记。'
    : '但指令没发出去（MQTT 还没连上），core 那边不会有这张照片。';
  if (!event) {
    message += '注意：快照里 ' + nodeId + ' 此刻没有未结案的事件，'
      + 'core 可能会拒收（它只往开着的事件上挂）。';
  }
  return { ok: ok, message: message };
}

/** core 报的那条事件上登了几张（logic.js 里同名函数没导出，这里自己读字段）。 */
function cameraCount(event) {
  return event && Number.isFinite(event.cameraCount) ? event.cameraCount : 0;
}

/**
 * 文件名：有案子时是 `dorm-b-20260922-203000-20260922203100.png`，
 * 没案子时是 `dorm-b-unfiled-20260922203100.png`。
 *
 * 拼在浏览器这边，因为 core 只把它当一个字符串留档（它没法知道用户想怎么命名）。
 * 时刻压成纯数字是为了当文件名用（冒号在 Windows 上根本存不下来）。
 *
 * 【前面不再挂一遍宿舍名】案号自己就是 `<宿舍>-<日期>-<时刻>`
 * （core 那边见 events.py 的 `_new_id`）。开头再写一次宿舍名，会拼出
 * `dorm-b-dorm-b-20260922-203000-...` 这种「两串长得都像时间戳」的东西，
 * 事后翻案卷的人分不清哪一串是案号、哪一串是拍摄时刻。宿舍名没丢：它就在案号里。
 */
function fileNameFor(nodeId, event, stamp, ext) {
  const compact = String(stamp).replace(/[^0-9]/g, '');
  const stem = event ? event.event_id : nodeId + '-unfiled';
  return stem + '-' + compact + (ext || '.png');
}

/**
 * 等 core 把这张照片登记进去。
 *
 * 【为什么不能当场写「已登记」】照片登记在 core 的案卷里，这边看不见那个数组
 * （快照只报个数 cameraCount）。所以唯一的确认是**下一帧快照里那个数变大了**。
 * 当场写「已登记 1 张」的话，指令丢了、或者 core 拒收（没有未结案的事件），
 * 屏幕上照样写着登记成功 —— 那是这个项目里最不该出现的一类假话。
 *
 * 等不到也不改口：那边可能被拒了，理由只有 core 的日志里有。这里只把「还在等」
 * 说出来，再附一句去哪儿看理由。
 */
let pendingShot = null;

function watchShot(nodeId, eventId, before) {
  pendingShot = { nodeId: nodeId, eventId: eventId, before: before };
}

function confirmShot(snapshot) {
  if (!pendingShot) return;
  const event = pendingShot.eventId
    ? findEventById(snapshot, pendingShot.eventId)
    : openEvent(snapshot, pendingShot.nodeId);
  if (!event) return;

  const now = cameraCount(event);
  if (now > pendingShot.before) {
    setAction('core 已确认：' + pendingShot.nodeId + ' 那条事件上现在登记着 '
      + now + ' 张现场快照（刚才发出指令时是 ' + pendingShot.before + ' 张）。', false);
    pendingShot = null;
  }
}

/** 案卷编号找那条事件 —— 结过案的也算（快照里只留最近若干条）。 */
function findEventById(snapshot, eventId) {
  const list = snapshot && snapshot.events && Array.isArray(snapshot.events.events)
    ? snapshot.events.events : [];
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].event_id === eventId) return list[i];
  }
  return null;
}

/**
 * 「朗读状态」—— 念的是**选中那一间**的温湿度、状态、事件。
 *
 * 【一个字都不在页面里拼】那句人话由 logic.js 的 speakLine 现算，用的是
 * **当下这一帧快照**：念之前重新取一次，不是页面打开时算好存下来的 ——
 * 念出来的是此刻的状态，不是几分钟前的。
 *
 * 【先 cancel 再 speak】连着说两次「朗读」，第二句会老老实实排在队列里等着，
 * 等第一句念完才开口，那时候念的是**上一次算出来的**内容。掐掉上一句立刻念
 * 最新的才对。
 */
function doSpeak(text, snapshot) {
  const nodeId = resolveNode(snapshot, text) || selectedNode(snapshot);
  if (!nodeId) {
    return {
      ok: false,
      message: '快照里既没有人点名（focus），也没有需要关注的重点（priority），'
        + '不知道念哪一间。先说「' + exampleNode(snapshot) + '」。',
    };
  }

  const sentence = speakLine(snapshot, nodeId);

  if (!speechSupported()) {
    return {
      ok: false,
      message: '这个浏览器不支持语音合成（window.speechSynthesis 不存在）。'
        + '要念的是：' + sentence,
    };
  }

  window.speechSynthesis.cancel();
  speaking = new window.SpeechSynthesisUtterance(sentence);
  speaking.lang = SPEECH_LANG;
  /* 出错也要说出来。这时候「执行结果」那行已经写着「正在朗读…」，不覆盖的话
     页面会一直声称它在念，而实际上什么都没响。原始错误码写在最前面。 */
  speaking.onerror = function (event) {
    const code = (event && event.error) ? event.error : 'unknown';
    setAction('朗读失败（' + code + '）。要念的是：' + sentence, false);
  };
  window.speechSynthesis.speak(speaking);

  /* message 就是「要念的那句话」本身，不是另写一句提示：静音、没音箱、音量太小
     的场合，页面上那行字是唯一能确认「它到底念了什么」的地方。 */
  return { ok: true, message: '正在朗读：' + sentence };
}

/**
 * 「开始处理」—— 把 handle 发给 core，作用在选中那一间上。
 *
 * 【只发事实，不发结论】这条消息里没有 status、没有 state、没有任何「已恢复」。
 * core 收到只会把事件从待处理推到处理中，之后好没好由它后面收到的报文说了算。
 * 这个红线在 core 那边是结构上成立的（handle_command 拿不到节点状态）。
 *
 * 【本地一个字不改】按完屏幕上不会立刻变，卡片上那行「处理中」要等 core 把
 * 新快照发回来才出现。这条路更慢，但它是唯一能保证「屏幕上写的和 core 想的
 * 是同一件事」的做法 —— 点击直接把事件置成处理中本来就是红线。
 *
 * 【带 time】带的是**快照里这一间的时刻**，不是浏览器时钟。不给的话 core 会用
 * 自己的当下时刻盖章，同一个动作两个说法。
 */
function doHandle(text, snapshot) {
  const nodeId = resolveNode(snapshot, text) || selectedNode(snapshot);
  if (!nodeId) {
    return {
      ok: false,
      message: '不知道给哪一间按「开始处理」：快照里既没人点名也没有重点。'
        + '先说「' + exampleNode(snapshot) + '」。',
    };
  }

  const node = nodeOf(snapshot, nodeId);
  const body = { nodeId: nodeId, action: CFG.CMD_ACTION, source: SOURCE };
  /* time 只在真的是个非空字符串时才带上。JSON.stringify 会把 undefined 的键
     直接丢掉，但这里显式判一下，别靠它的副作用。 */
  if (node && typeof node.time === 'string' && node.time) body.time = node.time;

  const ok = BRIDGE.sendCmd(body);
  return {
    ok: ok,
    message: ok
      ? '已发出「开始处理」（' + nodeId + '），等 core 的新快照把状态推成「处理中」。'
        + '本地不会改：按完屏幕不会立刻变，那一拍就是 core 的往返。'
      : '「开始处理」没发出去：MQTT 还没连上（' + nodeId + '）。',
  };
}

/* ---------- 语音合成 ---------- */

/* 正在念的那一句。留个引用不是「记住上一条」（每次都是现算的），是防一个
   真实的坑：Chrome 里 utterance 被 GC 掉，念到一半会直接停。 */
let speaking = null;

/**
 * 浏览器支不支持语音合成。
 *
 * 两个都要查：Chrome 上 speechSynthesis 一直在，但 SpeechSynthesisUtterance
 * 是个构造函数，缺了它 `new` 出来就是个 TypeError。少查一个的话，不支持的
 * 环境里说一句「朗读」就是一条未捕获的异常，界面上只表现为「什么都没发生」。
 */
function speechSupported() {
  return typeof window.speechSynthesis !== 'undefined'
    && typeof window.SpeechSynthesisUtterance === 'function';
}

/* ---------- 语音识别 ---------- */

/* 非空就表示「正在听」。用来挡住重复点击 —— 连点两次会走到 start() 抛
   InvalidStateError，比直接忽略第二次点击难解释得多。 */
let recognition = null;

function resetVoiceButton() {
  if (!el.start) return;
  el.start.textContent = '语音指令';
  el.start.classList.remove('is-listening');
}

/**
 * 把识别到的文字派发给固定指令。
 *
 * 三条路都留着痕迹：识别到的原文写进「识别到的文字」（**原样**写，不做任何
 * 美化 —— 认错了要看得见认成了什么），命中了哪条写进开头，命令自己的结果
 * 跟在后面。认不出是谁的责任要分得开：是没听清、还是这条命令没做成。
 */
function handleVoiceText(text) {
  const heard = String(text === null || text === undefined ? '' : text).trim();
  setHeard(heard, false);   // 原文照写，原样

  if (!heard) {
    setAction('没识别到内容，再说一次', true);
    return;
  }

  const snapshot = readySnapshot();
  if (!snapshot) return;

  const cmd = VOICE_COMMANDS.find((c) => c.keywords.some((k) => heard.includes(k)));
  if (!cmd) {
    setAction('未识别的指令：「' + heard + '」。'
      + '能说的是：查看 + 宿舍名 / 记录现场 / 朗读状态 / 开始处理。', false);
    return;
  }

  const outcome = cmd.run(heard, snapshot);
  setAction('识别为「' + cmd.label + '」——' + ((outcome && outcome.message) || '已执行'), false);
}

function startVoiceCommand() {
  const Ctor = speechRecognitionCtor();
  if (!Ctor) {
    setError('这个浏览器不支持语音识别（window.SpeechRecognition 不存在）。换新版 Chrome / Edge。');
    return;
  }
  if (!window.isSecureContext) {
    /* 这条单列出来：不是「浏览器不支持」，是这个地址不安全。混在一起说
       的话，人换浏览器换一圈也不管用 —— 要换的是打开方式（用 localhost）。 */
    setError('当前页面不是安全上下文（' + location.protocol + '//'
      + location.hostname + '）。麦克风只在 https 或 localhost 下可用。');
    return;
  }
  if (recognition) return;   // 正在听，忽略这次点击

  setError('');
  setNote('请说指令…');

  const rec = new Ctor();
  rec.lang = SPEECH_LANG;        // 中文
  rec.continuous = false;        // 只识别一句，说完就结束
  rec.interimResults = false;    // 只要最终结果，不要边听边变的中间稿

  recognition = rec;

  rec.onstart = () => {
    if (el.start) {
      el.start.textContent = '正在听…';
      el.start.classList.add('is-listening');
    }
    setNote('正在收音…');
  };

  rec.onresult = (event) => {
    /* results 是个列表，每项带 isFinal。interimResults=false 时通常只有一条
       final，但别假设只有一条 —— 全拼起来更稳。 */
    let text = '';
    for (let i = event.resultIndex || 0; i < event.results.length; i += 1) {
      text += event.results[i][0].transcript;
    }
    handleVoiceText(text);
  };

  rec.onerror = (event) => {
    setError(voiceErrorMessage(event && event.error));
  };

  rec.onend = () => {
    recognition = null;
    resetVoiceButton();
    setNote('');
  };

  try {
    rec.start();
  } catch (err) {
    /* 正常走不到这里（上面已经挡住重复点击），兜个底：别让异常冒出去，
       把按钮永远卡在「正在听」。 */
    recognition = null;
    resetVoiceButton();
    setError('启动语音识别失败：' + ((err && err.message) || err));
  }
}

/* 离开页面时把还在听的会话掐掉，别让麦克风一直开着 */
function stopVoiceCommand() {
  if (!recognition) return;
  /* 主动 abort 也会触发 onerror（error === 'aborted'），但那是我们自己干的，
     不该当成错误显示给用户，所以先把回调摘掉再中止。 */
  recognition.onerror = null;
  try {
    recognition.abort();
  } catch (err) {
    console.warn('[DormMate] 中止语音识别时出错：', err);
  }
  recognition = null;
}

/* ---------- 时间 ---------- */

function pad2(n) { return n < 10 ? '0' + n : String(n); }

/** `2026-09-22 20:31:00`。和 core 那边（以及遥测里的 time）同一套写法。 */
function formatStamp(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
    + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
}

/* ---------- 快照到了就重画 ---------- */

/**
 * 「当前焦点」那一行，以及「等 core 确认」那条回执。
 *
 * 挑法用 focusBanner 的 tag —— 和看板横幅、和朗读句是同一个出口，所以三处
 * 永远说的是同一间。这一行会把「快照里没有重点也没人点名」这种状态也照实写
 * 出来，因为那正是「说『记录现场』会失败」的原因，演示时看得见比看不见好。
 */
function renderState(snapshot) {
  const banner = focusBanner(snapshot);
  if (!banner.nodeId) {
    setFocus('当前焦点：没有（快照里 focus 和 priority 都是空的）', true);
  } else {
    const node = nodeOf(snapshot, banner.nodeId);
    const event = openEvent(snapshot, banner.nodeId);
    const bits = [banner.tag, banner.line];
    if (node && node.status) bits.push(node.status);
    bits.push(event
      ? '未结案事件 ' + event.event_id + ' · 已登记 ' + cameraCount(event) + ' 张快照'
      : '没有未结案的事件');
    setFocus('当前焦点：' + bits.join(' ｜ '), false);
  }

  confirmShot(snapshot);
}

/* ---------- 入口 ---------- */

if (el.start) {
  el.start.addEventListener('click', startVoiceCommand);

  /* 离开页面时中止会话 —— 和摄像头一样，不收拾的话麦克风会一直开着；
     正在念的那句也掐掉（切走之后还在响是件很吓人的事）。
     两条 pagehide 各注册各的，互不影响。 */
  window.addEventListener('pagehide', () => {
    stopVoiceCommand();
    if (speechSupported()) window.speechSynthesis.cancel();
  });
}

BRIDGE.onState(renderState);

/**
 * 对外的门面。web/script.js 的「拍照」按钮就调这个 —— 那个按钮拿不到快照
 * （它那个文件压根不认快照），所以按下时走这边：先算水印，再拍，再上报。
 *
 * 挂在 window 上而不是模块内导出：调用方是经典 script，拿不到 ES 模块的导出。
 */
window.DormMateMultimodal = {
  /* 拍照按钮那条路。和语音说「记录现场」走的是**同一个** doSnapshot ——
     两条入口共用一份实现，不然「按按钮拍的」和「说出来拍的」迟早会不一样。 */
  recordScene() {
    const snapshot = readySnapshot();
    if (!snapshot) return null;
    const outcome = doSnapshot('', snapshot);
    setHeard('（「拍照」按钮）', true);
    setAction(outcome.message, false);
    return outcome;
  },

  /* 下面两个给测试和排查用：不用真说话就能走一遍指令。 */
  say(text) { handleVoiceText(text); },
  commands() { return VOICE_COMMANDS.map((c) => c.id); },
};
