/**
 * Step E1-3：三间房并排的「世界」。
 *
 * scene.js 管的是一个宿舍 + 一台相机 + 一层覆盖层（看板那块面板要的东西）。
 * 这个文件管的是**三间房摆在同一个世界里**，各自绑一个节点，另加四样只有
 * 多房间才谈得上的东西：
 *
 *   1. NODE_MAP —— 房间摆在哪儿（一张布局表）
 *   2. Raycaster —— 点哪间房就是哪间房
 *   3. CSS2DRenderer —— 每间房头顶一行「温湿度 + 状态」，跟着房间一起动
 *   4. 相机飞行 + 脉冲光圈 —— 前一个跟着焦点走，后一个跟着当前重点呼吸
 *
 * 画面里会动的东西一共三样，各跟着一条不同的线走 —— 这三条别混：
 *
 *   地板颜色 / 窗户   ←  环境状态（正常 / 偏冷 / 偏热 / 偏湿），来自快照 nodes[]
 *   风扇转不转        ←  环境状态（偏热）**或** 事件状态（HANDLING 处理中）
 *   脉冲光圈          ←  谁是当前重点，来自快照 priority
 *   相机飞过去        ←  焦点是谁，来自快照 focus
 *
 * 风扇是唯一有两个原因的：偏热那间该吹风（屋里的事），处理中那间也在转
 * （有人在管这件事）。两个原因合成一个开关，见 syncFan。
 *
 * ── 这个文件里**没有**判断 ────────────────────────────────────
 * 状态字符串是外面（页面，页面又是从 core 的快照里读的）喂进来的，这里一个字
 * 都不算。跟 scene.js、dashboard/logic.js、mobile.js 是同一条口径：
 * 业务判断只有 core 一处。喂进来一个不认识的状态（比如「台风」）时，
 * 地板颜色落回「正常」，但**文字照原样显示** —— 显示层没有资格改别人的话。
 *
 * ── NODE_MAP 管的是「摆在哪儿」，不是「有哪些节点」 ──────────────
 * 这句话值得单独说清楚，因为它看着像是「又写死了一份节点名单」。
 * 不是：状态、温度、湿度、谁是重点、焦点是谁，**全都来自 core 的快照**。
 * 这张表回答的是另一个问题 —— 「dorm-a 这间屋子摆在世界的哪个坐标」。
 * 房间的位置是**布景**，不可能从数据里推出来（快照里没有坐标字段），
 * 所以它必须是一张表。
 * 代价写在明处：快照里出现一个表上没有的节点，它的数据画不出来（会告警）。
 * 这是布局表的固有边界，不是「漏读了快照」。
 *
 * 用的是 ES Module。CSS2DRenderer 是 three 的 addon（不在核心构建里），
 * 已经 vendor 到 lib/ 下，见 README 里那张第三方文件表。
 */

import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from './lib/CSS2DRenderer.js';
import { buildRoom, LOOK, STATUS, WALL_H } from './room.js';

/* ================= 布局 ================= */

/**
 * 节点 → 房间摆在哪。
 *
 * 三间房沿 X 轴一字排开，间距 12.5（房间是 10×10，所以每两间之间留 2.5 的过道）。
 * 左右对称、dorm-b 在正中间，是为了「一眼看出中间那间是基准」——
 * 相机从正前方看过去时，三间房的透视是一样的，谁也不比谁显得远。
 */
export const NODE_MAP = {
  'dorm-a': { x: -12.5, z: 0 },
  'dorm-b': { x: 0, z: 0 },
  'dorm-c': { x: 12.5, z: 0 },
};

/** 有房间的那几个节点，顺序就是并排的顺序（从左到右）。 */
export const NODE_IDS = Object.keys(NODE_MAP);

/* 一台相机能同时看到三间房时站在哪儿。 */
const OVERVIEW = {
  pos: { x: 0, y: 19, z: 27 },
  look: { x: 0, y: 2, z: 0 },
};
/* 飞到某一间房时，相机相对那间房中心偏多少。和 scene.js 单间房的取景一致：
   站在房间开着的那一角（+X / +Z）斜上方，能同时看到两面墙、床、窗户和风扇。 */
const ROOM_VIEW = { x: 11, y: 8.5, z: 13, lookY: 1.8 };

/* 相机飞过去要多久（秒），以及脉冲呼吸一个来回要多久。 */
const FLY_SEC = 0.9;
const PULSE_SEC = 1.7;

/* 「这个节点的事件正在处理中」在标签上写什么字。
   它是 core `events.HANDLING` 的显示名 —— 事件状态，不是那四个环境状态。
   （事件状态一共四个：OPEN / HANDLING / RECOVERED / UNRESOLVED。
    这里只挑 HANDLING 一个说，因为只有它对 3D 画面有影响：风扇转起来。） */
const HANDLING_TEXT = '处理中';

/* 室外大地面。比三间房加起来还大一圈，让它们不像浮在虚空里。 */
const GROUND = 400;

/**
 * 三间房的世界 —— 搭起来，并且**只**接受「谁是什么状态、谁是重点、谁在看」。
 *
 * @param {HTMLElement|string} container 容器元素本身，或它的 id
 * @returns {{scene: THREE.Scene, camera: THREE.PerspectiveCamera,
 *            renderer: THREE.WebGLRenderer, labelRenderer: CSS2DRenderer,
 *            rooms: Object, NODE_MAP: Object, NODE_IDS: string[],
 *            setReading: function(string, ?object): boolean,
 *            setHandling: function(string, boolean): boolean,
 *            setPriority: function(?string): ?string,
 *            setFocus: function(?string): ?string,
 *            viewOf: function(?string): object,
 *            onPick: function(function(string): void): void,
 *            dispose: function(): void}}
 * @throws {Error} 找不到容器、或这台设备没有可用的 WebGL
 */
export function createDormWorld(container) {
  const host = typeof container === 'string' ? document.getElementById(container) : container;
  if (!host) {
    throw new Error('createDormWorld：找不到容器 ' + container);
  }

  /* ================= renderer：渲染器 ================= */

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (err) {
    // 和 scene.js 同一个理由：光抛异常页面是一片空白，看着像脚本没加载。
    host.innerHTML = '<p class="scene-error">这台设备或浏览器没有可用的 WebGL，'
      + '3D 场景起不来。<br>在 <code>chrome://gpu</code> 里能看到具体原因。</p>';
    throw err;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.style.display = 'block';
  host.appendChild(renderer.domElement);
  renderer.shadowMap.enabled = true;

  /* ================= CSS2D 标签层 ================= */

  const labelRenderer = new CSS2DRenderer();

  // 这一层是绝对定位盖在 canvas 上的 HTML。三行样式必须自己写死：
  //
  //   position/top/left —— CSS2DRenderer 自己**不设**这几条（它只设 overflow），
  //     不补的话这层会跑到画布下面去，标签全在下面堆着。
  //   pointer-events: none —— **最要命的一条**：这层盖在画布上，只要它收点击，
  //     底下 canvas 的 click 就永远收不到，Raycaster 一个事件都拿不到，
  //     表现为「点房间没反应」，而且控制台一条错都没有。
  //
  // 不写进页面 CSS 而是写在 JS 里，是因为这三条是「这层能不能用」的前提，
  // 不是排版偏好 —— 换个页面复用这个模块时不该再想一遍。
  labelRenderer.domElement.style.position = 'absolute';
  labelRenderer.domElement.style.top = '0';
  labelRenderer.domElement.style.left = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  host.appendChild(labelRenderer.domElement);

  /* ================= scene：场景（世界） ================= */

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(LOOK[STATUS.NORMAL].bg);

  /* ================= 灯光 ================= */

  // 三间房共用这两盏灯。**这是多房间和单房间最大的一处不同**：
  // 单间房那边状态变了连灯色一起换（让整盏灯偏蓝就等于「这间房冷」），
  // 三间房各有各的状态时没法这么干 —— 一盏灯没法同时是三种颜色。
  // 所以那边灯色跟着状态走，这边灯色是固定的，状态只落在房间自己的零件上
  // （地板颜色、窗户开合、风扇转不转），这三样都长在那间房里，一眼能分清。
  const ambient = new THREE.AmbientLight(LOOK[STATUS.NORMAL].ambient, 1.8);
  const dirLight = new THREE.DirectionalLight(LOOK[STATUS.NORMAL].sun, 2.2);
  // 灯要罩住三间房，所以往 -X 挪一点、抬高 —— 单间房那边是 (-6, 12, 9)。
  dirLight.position.set(-10, 20, 16);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(2048, 2048);
  // 阴影相机是一台正交相机，必须手动告诉它「管多大范围」。默认只有 ±5，
  // 三间房并排一共三十多米宽，不放大就只剩中间那间有影子，
  // 而表现是「边上的房间影子凭空消失」，不会报错。
  dirLight.shadow.camera.left = -28;
  dirLight.shadow.camera.right = 28;
  dirLight.shadow.camera.top = 28;
  dirLight.shadow.camera.bottom = -28;
  dirLight.shadow.camera.updateProjectionMatrix();

  scene.add(ambient, dirLight);

  /* ================= 大地面 ================= */

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND, GROUND),
    new THREE.MeshStandardMaterial({ color: 0xa9a8a2, roughness: 0.95, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  ground.name = 'ground';
  scene.add(ground);

  /* ================= 三间房 ================= */

  /* 每个节点这一格记的是「这间房现在被摆成什么样」。
     和房间本身（几何）分开：几何建一次就不动了，这里记的是会变的那部分。 */
  const rooms = {};

  NODE_IDS.forEach(function (nodeId) {
    const spot = NODE_MAP[nodeId];
    // prefix 必须给：三间房并排时不加前缀的话，三间房的地板全叫 'floor'，
    // 按名字找零件会随机撞上一个（测试里最先现形）。
    const room = buildRoom(nodeId);
    room.group.position.set(spot.x, 0, spot.z);
    // 拾取时靠它反查「这一下点的是哪间房」：命中的是地板/床/墙里的哪一个零件
    // 无所谓，往上找到带 nodeId 的那个 Group 就算。
    room.group.userData.nodeId = nodeId;
    scene.add(room.group);

    /* ---- 头顶那行标签（CSS2DRenderer）---- */

    // 用 CSS2D 而不是 scene.js 那种固定覆盖层：标签要**跟着房间走**。
    // 三间房并排、相机还会飞，固定的一层文字没法同时说清三间房各是什么状态。
    const el = document.createElement('div');
    el.className = 'scene-tag';
    const tagNode = document.createElement('span');
    tagNode.className = 'tag-node';
    tagNode.textContent = nodeId;
    const tagRead = document.createElement('span');
    tagRead.className = 'tag-read';
    const tagStatus = document.createElement('span');
    tagStatus.className = 'tag-status';
    // 「处理中」这一格。风扇转起来的原因是**看不见的**（屋里没有别的东西
    // 因为「有人在管这件事」而变化），不写一个字出来，看的人只会觉得
    // 「这台风扇怎么自己转起来了」。平时是空的、也不占位，只在处理中时出现。
    //
    // 这个字是**事件状态**（core 的 events.HANDLING）的显示名，不是那四个
    // 环境状态之一 —— 环境状态一个字都不在这里写死，一律照抄快照里的值。
    const tagHandling = document.createElement('span');
    tagHandling.className = 'tag-handling';
    tagHandling.textContent = HANDLING_TEXT;
    // 离线提示（Phase9 D4）。**单独一格**，不并进上面的 tag-status 里：
    // 那个格子说的是「这个宿舍现在什么状况」，而离线是**状态之外**的事实
    // （core 的优先排序不排离线的节点）。并在一起会出现「偏热 · 已离线」
    // 这种一格两义的字，看的人分不清「已离线」是在描述环境还是在描述链路。
    //
    // 和 tag-handling 一样，平时是空的、也不占位（CSS 里 :empty 隐藏）。
    const tagOffline = document.createElement('span');
    tagOffline.className = 'tag-offline';
    el.appendChild(tagNode);
    el.appendChild(tagRead);
    el.appendChild(tagStatus);
    el.appendChild(tagHandling);
    el.appendChild(tagOffline);

    const label = new CSS2DObject(el);
    // 挂在房间**上方**：墙高 4，标签放 4.6，正好在屋顶上方一点，不挡屋里。
    label.position.set(0, WALL_H + 0.6, 0);
    room.group.add(label);

    rooms[nodeId] = {
      nodeId,
      spot,
      room,
      el,
      tagRead,
      tagStatus,
      tagHandling,
      tagOffline,
      reading: null,     // 快照里这一格；null = 还没收到过
      lookFan: false,    // 状态说「这间热，风扇该转」（LOOK 表里那一列）
      handling: false,   // 这个节点的事件正在处理中（HANDLING）
      pulsing: false,    // 是不是「当前重点」（脉冲光圈跟着它呼吸）
    };

    // 建出来先写成「还没有数据」，而不是先摆一个「正常」。
    // 空白/半成品的样子让人分不清「还没收到」和「页面坏了」，
    // 先写个「—」再写明还没收到，两件事就都说得清了。
    renderTag(rooms[nodeId]);
  });

  /* ================= camera：相机 ================= */

  function size() {
    // 容器被隐藏时 clientWidth/Height 是 0，拿 0 去除会得到 Infinity/NaN，
    // 相机矩阵整个变成 NaN —— 表现是「画面全黑但控制台一条错都没有」。
    return { w: host.clientWidth || 1, h: host.clientHeight || 1 };
  }

  const camera = new THREE.PerspectiveCamera(50, size().w / size().h, 0.5, 900);
  camera.position.set(OVERVIEW.pos.x, OVERVIEW.pos.y, OVERVIEW.pos.z);

  /* 相机看向哪儿，单独存一份。
     不直接读 camera.rotation 再插值：那是欧拉角，插值中间会经过没有意义的朝向
     （相机在半路上翻滚）。存一个「盯着哪儿」的点，插值它，每帧重新 lookAt ——
     这才是镜头飞行该有的样子。 */
  const lookAt = { x: OVERVIEW.look.x, y: OVERVIEW.look.y, z: OVERVIEW.look.z };
  camera.lookAt(lookAt.x, lookAt.y, lookAt.z);

  /* 飞行状态。null = 没在飞。 */
  let flight = null;

  /** 某间房（或总览）该用哪台相机位。 */
  function viewOf(nodeId) {
    const spot = nodeId ? NODE_MAP[nodeId] : null;
    if (!spot) {
      return { pos: { x: OVERVIEW.pos.x, y: OVERVIEW.pos.y, z: OVERVIEW.pos.z },
        look: { x: OVERVIEW.look.x, y: OVERVIEW.look.y, z: OVERVIEW.look.z } };
    }
    return {
      pos: { x: spot.x + ROOM_VIEW.x, y: ROOM_VIEW.y, z: spot.z + ROOM_VIEW.z },
      look: { x: spot.x, y: ROOM_VIEW.lookY, z: spot.z },
    };
  }

  /**
   * 让镜头飞过去。**不直接跳**，是为了让看的人跟得上「焦点换人了」这件事 ——
   * 一帧之内切过去的话，人只会觉得画面闪了一下，反而看不出换到哪间了。
   */
  function flyTo(nodeId) {
    flight = {
      from: { x: camera.position.x, y: camera.position.y, z: camera.position.z,
        lx: lookAt.x, ly: lookAt.y, lz: lookAt.z },
      to: viewOf(nodeId),
      t: 0,
    };
  }

  /** 推进飞行。每帧调一次，dt 是距上一帧的秒数。 */
  function advanceFlight(dt) {
    if (!flight) return;
    flight.t = Math.min(1, flight.t + dt / FLY_SEC);
    // smoothstep：两头慢、中间快。线性插值看着像机器在平移，不像镜头在飞。
    const k = flight.t * flight.t * (3 - 2 * flight.t);
    const f = flight.from;
    const to = flight.to;
    camera.position.set(
      f.x + (to.pos.x - f.x) * k,
      f.y + (to.pos.y - f.y) * k,
      f.z + (to.pos.z - f.z) * k
    );
    lookAt.x = f.lx + (to.look.x - f.lx) * k;
    lookAt.y = f.ly + (to.look.y - f.ly) * k;
    lookAt.z = f.lz + (to.look.z - f.lz) * k;
    if (flight.t >= 1) flight = null;
  }

  /* ================= 尺寸自适应 ================= */

  function onResize() {
    const { w, h } = size();
    camera.aspect = w / h;
    // 改完 aspect 必须重算投影矩阵，只改 aspect 渲染时用的还是旧矩阵。
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    // 两个渲染器必须**同一个尺寸**：标签层按像素坐标摆在画布上，
    // 尺寸差一点，标签就会从它那间房上滑开，而且房间越靠边偏得越多。
    labelRenderer.setSize(w, h);
  }

  onResize();
  window.addEventListener('resize', onResize);

  /* ================= 标签：把数据摆成人话 ================= */

  /** 温度/湿度摆成「25℃ · 80%」。缺一个就摆一个「—」，不猜。 */
  function readText(reading) {
    if (!reading) return '—';
    const t = typeof reading.temperature === 'number' ? reading.temperature + '℃' : '—';
    const h = typeof reading.humidity === 'number' ? reading.humidity + '%' : '—';
    return t + ' · ' + h;
  }

  /**
   * 把一格数据写成标签上的字。
   *
   * 这里**只摆字，不算状态**：status 是快照里带来的那个字符串，原样显示。
   * 认不出来的状态（「台风」）照显示 —— 显示层没有资格改别人的话，
   * 和看板、移动端的口径一致。
   */
  function renderTag(entry) {
    entry.tagRead.textContent = entry.reading ? readText(entry.reading) : '—';
    const status = entry.reading && typeof entry.reading.status === 'string'
      ? entry.reading.status : '';
    entry.tagStatus.textContent = status || '还没有数据';
    // 颜色交给 CSS 按属性挑（mobile/style.css 也是这个做法）：这样
    // 「不认识的状态」照样有个字面，不会因为配色表里没有它就变成一片空白。
    entry.el.setAttribute('data-status', status);
    entry.el.classList.toggle('tag-online', !!(entry.reading && entry.reading.online));
    // 「处理中」那格直接开/关 hidden，不靠页面 CSS 决定看不看得见 ——
    // 少了这一句，页面少写一条 CSS 就会变成三间房都挂着「处理中」，
    // 而这种错在控制台里一点动静都没有。
    entry.tagHandling.hidden = !entry.handling;

    /* 离线提示（D4）。两件事都是**照抄快照里的值**，这边一个字都不判：
         * 在不在线    -> reading.online（core 算的）
         * 多久没来了  -> reading.offlineText（core 算好的那句话）
       「多久」那句不在这边拿 lastSeen 去减 —— 那是第二个算法，
       而它和 core 的迟早会差一截，差的时候谁都不报错。
       快照里没 offlineText 这一格（老 core 配新页面）时退回「已离线」四个字。 */
    const offline = !!(entry.reading && entry.reading.online === false);
    entry.tagOffline.textContent = offline
      ? '已离线' + (entry.reading.offlineText ? ' ' + entry.reading.offlineText : '')
      : '';
    // 和 tagHandling 同样的做法：直接写 DOM 属性，不指望页面 CSS。
    entry.tagOffline.hidden = !offline;
  }

  /* ================= 脉冲光圈 ================= */

  /* 呼吸到哪儿了。用 clock 的累计时间算，不自己累加 —— 累加的话掉帧之后
     相位会漂，两个标签呼吸不同步（这里只有一个，但道理一样）。 */
  const clock = new THREE.Clock();

  function pulse(t) {
    NODE_IDS.forEach(function (nodeId) {
      const entry = rooms[nodeId];
      if (!entry.pulsing) return;
      // 0 → 1 → 0 的一个来回
      const k = 0.5 + 0.5 * Math.sin((t / PULSE_SEC) * Math.PI * 2);
      const mat = entry.room.ringMat;
      mat.opacity = 0.45 + 0.5 * k;
      // 缩放和透明度一起动：只改透明度在浅色地板上不够显眼，只改大小
      // 又像是「圈在长大」而不是「在呼吸」。两个一起，读起来才是忽明忽暗。
      const s = 1 + 0.05 * k;
      entry.room.ring.scale.set(s, s, s);
    });
  }

  /* ================= 动画循环 ================= */

  renderer.setAnimationLoop(function () {
    // Clock 给的是「距上一帧过了多少秒」；累计时间用 elapsedTime，
    // 转动/呼吸的快慢就与帧率无关。
    const dt = clock.getDelta();
    const t = clock.elapsedTime;

    NODE_IDS.forEach(function (nodeId) {
      rooms[nodeId].room.spin(dt);
    });

    pulse(t);
    advanceFlight(dt);

    // ★ 每帧重新对准一次。**少了这一行，镜头会平移但朝向一动不动** ——
    // 相机飞过去了，眼睛还盯着原来那个方向，画面看着「挪了一下但没转过去」，
    // 而且控制台一条错都没有（位置确实变了，只是没看对地方）。
    // 只认位置、不认朝向是相机最容易漏的一半：position 是它站在哪，
    // lookAt 是它朝哪看，两个都得每帧更新。
    camera.lookAt(lookAt.x, lookAt.y, lookAt.z);

    // 先把 3D 画出来，再让标签层按同一台相机摆字 —— 反过来的话，
    // 一帧里标签用的是**上一帧**的相机位置，房间动的时候标签会慢半拍。
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  });

  /* ================= 拾取：点哪间房 ================= */

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  /* 拾取只在**房间那三个 Group** 里找。地面、灯、别的都不参与 ——
     不然点在屋外的空地上也会命中大地面，而那不是「点了某一间」。 */
  const pickables = NODE_IDS.map(function (nodeId) { return rooms[nodeId].room.group; });

  let onPickCb = null;

  /**
   * 注册「点中某间房」的回调。
   *
   * 这个模块**只报告点了哪一间**，不决定点了之后干什么 ——
   * 发指令、切焦点都是页面的主张（而且真要去 core 绕一圈）。分开之后，
   * 这里可以在没有 MQTT 的测试里单独验。
   *
   * @param {function(string): void} cb 收到 nodeId
   */
  function onPick(cb) {
    onPickCb = typeof cb === 'function' ? cb : null;
  }

  function handleClick(ev) {
    if (!onPickCb) return;
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    // 屏幕坐标 → 归一化设备坐标（NDC）。减一半再除一半：屏幕原点是左上角、
    // y 轴向下，而 NDC 原点是正中间、y 轴向上（所以 y 那一步是负的）。
    pointer.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(pointer, camera);

    // 第二个参数 true = 递归进 Group 里面找。命中的可能是地板、床、墙、
    // 甚至那圈环 —— 是哪一件都不要紧，往上找到带 nodeId 的那个 Group 就是答案。
    const hits = raycaster.intersectObjects(pickables, true);
    if (!hits.length) return;

    let obj = hits[0].object;
    while (obj && !(obj.userData && obj.userData.nodeId)) obj = obj.parent;
    if (obj) onPickCb(obj.userData.nodeId);
  }

  renderer.domElement.addEventListener('click', handleClick);

  /* ================= 对外：三件事 ================= */

  /**
   * 这间房现在的数据（页面从 core 的快照里取一格喂进来）。
   *
   * @param {string} nodeId
   * @param {?object} reading {temperature, humidity, status, online}；null = 没数据
   * @returns {boolean} 认不认得这个节点
   */
  function setReading(nodeId, reading) {
    const entry = rooms[nodeId];
    if (!entry) {
      console.warn('[world] NODE_MAP 里没有 ' + nodeId + ' 的位置，画不出来（布局表是有边界的）');
      return false;
    }
    entry.reading = reading || null;

    // 状态 → 房间外观。不认识的走「正常」那一格，和 scene.js 同一个兜法。
    const status = entry.reading && entry.reading.status;
    const look = Object.prototype.hasOwnProperty.call(LOOK, status) ? LOOK[status] : null;
    if (!look && status) {
      console.warn('[world] 不认识的 status：' + status + '，地板按「' + STATUS.NORMAL + '」显示（字照原样写）');
    }
    const applied = look || LOOK[STATUS.NORMAL];
    entry.lookFan = !!applied.fan;
    entry.room.applyLook(applied);
    syncFan(entry);

    renderTag(entry);
    return true;
  }

  /**
   * 这间房的风扇转不转，由**两件事**决定，合成一个开关：
   *
   *   状态    LOOK 表里那一列。偏热 -> 转。说的是「这屋热，该吹风」。
   *   事件   这个节点的事件是不是处理中（HANDLING）。说的是「有人在管这件事了」。
   *
   * 两件事都成立时风扇当然转，只成立一件时也转 —— 所以是 or，不是覆盖。
   * 不写成「后调用的那个说了算」，是因为页面每收到一帧快照都会把两件事都
   * 重报一遍，覆盖式的话谁后到就听谁的，风扇会随报文顺序抖。
   */
  function syncFan(entry) {
    entry.room.setFanOn(entry.lookFan || entry.handling);
  }

  /**
   * 这个节点的事件是不是正在处理中（快照 events 里 state === 'HANDLING'）。
   *
   * 页面从快照里数出来喂进来。这里不自己看 events —— world.js 收的是
   * 「哪几间在处理」，不是一个完整快照（它连快照这个词都不该知道）。
   *
   * @param {string} nodeId
   * @param {boolean} on
   * @returns {boolean} 认不认得这个节点
   */
  function setHandling(nodeId, on) {
    const entry = rooms[nodeId];
    if (!entry) {
      console.warn('[world] NODE_MAP 里没有 ' + nodeId + ' 的位置，画不出来（布局表是有边界的）');
      return false;
    }
    entry.handling = !!on;
    syncFan(entry);
    renderTag(entry);
    return true;
  }

  /**
   * 谁是「当前重点」（core 挑出来的那一个）—— 那间房的光圈开始呼吸。
   *
   * 和焦点是两件事：重点说的是「这间最该管」，焦点说的是「现在在看哪间」。
   * 所以重点用**脉冲**（在动的东西最抓眼睛，适合说「看这儿」），
   * 焦点用相机飞过去（换的是视角，不动画面里的东西）。
   *
   * @param {?string} nodeId null = 没有重点
   * @returns {?string} 实际生效的节点
   */
  function setPriority(nodeId) {
    const target = rooms[nodeId] ? nodeId : null;
    NODE_IDS.forEach(function (id) {
      const entry = rooms[id];
      entry.pulsing = id === target;
      // 不再是重点的那间要**立刻收干净**：脉冲只在「还是重点」时才每帧写，
      // 停下的那间没人再管它的透明度，不收就会永远停在半亮上。
      entry.room.ring.visible = entry.pulsing;
      entry.room.ringMat.opacity = 0.9;
      entry.room.ring.scale.set(1, 1, 1);
    });
    return target;
  }

  /**
   * 焦点（看的是哪一间）—— 变了就把镜头飞过去。
   *
   * **只在真的变了的时候飞**：快照是反复发的（一个节点一条遥测就可能有新快照），
   * 每收到一帧就飞一次的话，镜头会一直在半路上被重置，永远到不了。
   *
   * @param {?string} nodeId null = 回到总览
   * @returns {?string} 实际生效的节点
   */
  function setFocus(nodeId) {
    const target = rooms[nodeId] ? nodeId : null;
    if (target === currentFocus) return target;
    currentFocus = target;

    NODE_IDS.forEach(function (id) {
      rooms[id].el.classList.toggle('tag-focus', id === target);
    });

    // 换焦点的时候把正在飞的那一次丢掉（flyTo 会从当前实际位置重新起算）。
    flyTo(target);
    return target;
  }

  let currentFocus = null;

  /* ================= 清理 ================= */

  function dispose() {
    renderer.setAnimationLoop(null);
    window.removeEventListener('resize', onResize);
    renderer.domElement.removeEventListener('click', handleClick);

    // three 的几何体/材质**不会**因为「从 scene 里 remove 掉」而被回收 ——
    // 它们占的是 GPU 上的显存，JS 的垃圾回收管不着，必须逐个 dispose()。
    scene.traverse(function (obj) {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });

    renderer.dispose();
    if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    if (labelRenderer.domElement.parentNode === host) host.removeChild(labelRenderer.domElement);
  }

  return {
    scene, camera, renderer, labelRenderer,
    rooms, NODE_MAP, NODE_IDS,
    setReading, setHandling, setPriority, setFocus, viewOf, onPick, dispose,
  };
}
