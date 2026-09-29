/**
 * Step 6-2：简化宿舍 + updateScene(status)
 *
 * 6-1 里只有一块地板和一个方块，是拿来验「three 在这个项目里跑得起来」的。
 * 这一步把宿舍搭出来（地板 / 墙 / 床 / 窗户 / 风扇），再让四种状态各自
 * 改变场景的样子，好和两个看板、小程序对上同一套 status。
 *
 * ── 三个核心对象 ────────────────────────────────────────────────
 * Three.js 的每个场景都必须有这三个，缺一个都画不出东西：
 *
 *   scene    场景。一个「世界」，所有要画的东西（地板、床、灯光）都挂在
 *            它下面。它自己不可见、也不能直接显示，本质是个名册/容器。
 *            灯光也是挂在 scene 上的 —— 光不是「照亮屏幕」，是照亮这个世界的
 *            一部分，所以它必须在这个名册里，否则不参与计算。
 *
 *   camera   相机。观察这个世界的眼睛，决定「站在哪儿、朝哪看、能看多宽」。
 *            PerspectiveCamera 是透视相机，模拟人眼：近大远小。它不改变世界，
 *            只决定你怎么看它 —— 同一个 scene 换台相机就是另一张照片。
 *
 *   renderer 渲染器。真正干活的那个：把「scene 里有什么」按「camera 怎么看」
 *            算成一张图，画到它自己创建的 <canvas> 上。
 *            scene 和 camera 都只是输入，输出在 renderer 这儿。
 *
 * 一句话：renderer.render(scene, camera) —— 把世界拍成一张照片。
 * ────────────────────────────────────────────────────────────────
 *
 * 用的是 ES Module（import/export）。注意本文件是被 index.html 里
 * <script type="module"> 加载的，模块天然是严格模式，所以不需要 'use strict'。
 */

import * as THREE from 'three';

/* ================= 对外常量 ================= */

/**
 * 四种状态。字符串必须和 Python 侧 status_rules.py、JS 侧 shared/rules.js、
 * 小程序 utils/rules.js 算出的一模一样 —— 这里直接写死，不要从别处拼，
 * 拼错一个字 updateScene 就会走「不认识」的分支。
 */
export const STATUS = {
  NORMAL: '正常',
  COLD: '偏冷',
  HOT: '偏热',
  WET: '偏湿',
};

/** 风扇转速，弧度/秒。约 1.1 圈/秒。 */
export const FAN_SPIN = 7;

/**
 * 窗户开到最大时铰链转过的角度（弧度）。
 * 负号是有意的：窗户从铰链沿 +X 伸出去，绕 Y 转负角才会朝 +Z（屋里）开；
 * 转正角会朝墙外面甩出去，穿墙而过。
 */
export const WINDOW_OPEN_ANGLE = -Math.PI / 2.5;

/**
 * 「当前重点」标记环的颜色。
 *
 * 特意**不用**那四个状态色（--status-good/warning/serious/critical）。
 * 状态色是保留色：偏热是红的、偏湿是橙的，那是「这间宿舍怎么了」。
 * 这个环说的是另一件事 —— 「要看的是这一间」，是个**指路**的记号，
 * 和严重程度无关。拿状态色去画它，看的人会以为环的颜色也在报状态，
 * 而它换不换颜色其实只跟「谁是重点」有关。
 *
 * 值就是 style.css 里的 --focus（输入框聚焦环那个「纯 UI 用色，不代表任何状态」）。
 * 这里写死一份、不读 CSS 变量：scene.js 要能在没有真实 DOM 的测试里跑起来，
 * 读 getComputedStyle 会把这条依赖引进测试。改样式时两处一起改。
 */
export const FOCUS_COLOR = 0x2a78d6;

/* 环的内外半径。地板是 10×10（-5 ~ +5），环贴着房间边缘但不到墙根，
   这样它读起来是「这间屋子被圈住了」，而不是压在地板缝上。 */
const FOCUS_RING_INNER = 4.35;
const FOCUS_RING_OUTER = 4.75;

/* ================= 尺寸 ================= */

const ROOM = 10;      // 房间边长（X 和 Z 都是它）
const WALL_H = 4;     // 墙高
const GROUND = 400;   // 室外大地面。见下面「为什么还要一块大地面」

/**
 * 状态 → 场景外观。四种状态各自的每一项都写全，不做「只写差异、其余继承默认」
 * 那种省略 —— 一眼能看出四种状态分别改了什么，是这张表的全部意义。
 *
 * 地板和窗户用色说明：
 *   偏热的地板取的是项目的 --status-critical（#d03b3b）和地板底色混出来的，
 *   偏湿的窗户蓝是玻璃/水的直觉色，不是 --status-serious（那个是砖橙色）。
 *   窗户变蓝 + 打开读作「开窗通风」，是场景动作，不是在拿颜色表示状态；
 *   真正表示状态的是覆盖层里那行文字（setLabel）。
 */
const LOOK = {
  [STATUS.NORMAL]: {
    floor: 0xb9b8b2, window: 0xcdd8de, open: false, fan: false,
    sun: 0xffffff, ambient: 0xffffff, bg: 0xececea,
  },
  [STATUS.COLD]: {
    floor: 0xb9b8b2, window: 0xcdd8de, open: false, fan: false,
    sun: 0xbdd4ff, ambient: 0xc6dbff, bg: 0xe4ebf3,   // 两盏灯一起偏蓝，整体就冷下来了
  },
  [STATUS.HOT]: {
    floor: 0xc86765, window: 0xcdd8de, open: false, fan: true,
    sun: 0xffffff, ambient: 0xffffff, bg: 0xececea,
  },
  [STATUS.WET]: {
    floor: 0xb9b8b2, window: 0x4fa8e0, open: true, fan: false,
    sun: 0xffffff, ambient: 0xffffff, bg: 0xececea,
  },
};

/**
 * 在 container 里搭一个简化宿舍，并返回控制它的几个方法。
 *
 * @param {HTMLElement|string} container 容器元素本身，或它的 id
 * @returns {{scene: THREE.Scene, camera: THREE.PerspectiveCamera,
 *            renderer: THREE.WebGLRenderer, floor: THREE.Mesh,
 *            ground: THREE.Mesh, bed: THREE.Group,
 *            windowPane: THREE.Mesh, windowPivot: THREE.Group,
 *            fan: THREE.Group, fanMount: THREE.Group, focusRing: THREE.Mesh,
 *            updateScene: function(string): string,
 *            setFanOn: function(boolean): boolean,
 *            setLabel: function(string): string,
 *            setFocus: function(boolean): boolean,
 *            dispose: function(): void}}
 * @throws {Error} 找不到容器、或这台设备没有可用的 WebGL
 */
export function createDorm3D(container) {
  const host = typeof container === 'string' ? document.getElementById(container) : container;
  if (!host) {
    throw new Error('createDorm3D：找不到容器 ' + container);
  }

  /* ================= renderer：渲染器 ================= */

  // 渲染器要最先建，因为它是最可能失败的那一步：设备/浏览器没有 WebGL 时
  // 构造函数直接抛异常。放在最后建的话，前面已经挂了一堆对象却永远用不上。
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (err) {
    // 光抛异常的话页面是一片空白，看代码的人会以为是脚本没加载。
    // 把原因写在容器里，再去 Console 抛 —— 无头浏览器默认关着 WebGL，
    // 跑自动化截图时最容易撞上这一条。
    host.innerHTML = '<p class="scene-error">这台设备或浏览器没有可用的 WebGL，'
      + '3D 场景起不来。<br>在 <code>chrome://gpu</code> 里能看到具体原因。</p>';
    throw err;
  }

  // 高 DPI 屏上 devicePixelRatio 可能是 3 甚至更高，按原样渲染等于要画 9 倍的
  // 像素，笔记本核显上会明显掉帧。封顶 2 是观感和性能的常见折中。
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  // three 造出来的 <canvas> 是行内元素（inline），行内元素底部会留出约 4px 的
  // 基线空隙。容器有自己的背景色时，就会在画布下面露出一条缝。
  renderer.domElement.style.display = 'block';
  host.appendChild(renderer.domElement);

  renderer.shadowMap.enabled = true;

  /* ================= 覆盖层：setLabel ================= */

  // 用一层 HTML（绝对定位盖在 canvas 上）而不是把文字画进 3D 里。
  // 理由：中文在 canvas 上要自己处理字体和分辨率，而 HTML 这边浏览器全包了，
  // 还自带换行、缩放、无障碍朗读。代价是要给它 pointer-events: none，
  // 否则这层会吃掉鼠标事件，3D 那边将来想加拖拽就拖不动了。
  const labelEl = document.createElement('div');
  labelEl.className = 'scene-label';
  host.appendChild(labelEl);

  /**
   * 设置覆盖层上的文字。
   * @param {string} text 传 null / undefined 就是清空
   * @returns {string} 实际写上去的文字（方便调用方确认）
   */
  function setLabel(text) {
    labelEl.textContent = (text === undefined || text === null) ? '' : String(text);
    return labelEl.textContent;
  }

  /* ================= scene：场景（世界） ================= */

  const scene = new THREE.Scene();
  // 不给背景色的话是纯黑，墙和地板的暗部会糊在一起看不出边界。
  scene.background = new THREE.Color(LOOK[STATUS.NORMAL].bg);

  /* ================= 灯光 ================= */

  // 环境光：没有方向、没有位置，均匀照亮所有物体。它不产生任何明暗，
  // 作用只是把背光面从死黑里拉起来。只留它的话画面会像贴纸一样平。
  const ambient = new THREE.AmbientLight(LOOK[STATUS.NORMAL].ambient, 1.8);

  // 平行光：有方向、没有位置（position 只用来定方向，把它想成太阳）。
  // 明暗和阴影都是它给的 —— 这才是让画面看起来「立体」的那盏灯。
  //
  // 位置 (-6, 12, 9) 是相对相机 (12, 8.5, 14) 特意挑的，见下面那段注释。
  const dirLight = new THREE.DirectionalLight(LOOK[STATUS.NORMAL].sun, 3);
  dirLight.position.set(-6, 12, 9);

  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(1024, 1024);
  // 阴影相机是一台正交相机，必须手动告诉它「管多大范围」。默认范围很小（±5），
  // 超出去的部分不会投下阴影 —— 表现为「远处的物体影子凭空消失」。
  // 开太大则同样的 1024×1024 要摊到更大面积上，影子发糊。
  // 房间是 10×10、墙高 4，±12 的方盒罩得住还有富余。
  dirLight.shadow.camera.left = -12;
  dirLight.shadow.camera.right = 12;
  dirLight.shadow.camera.top = 12;
  dirLight.shadow.camera.bottom = -12;

  // 改完阴影相机的范围，必须自己重算一次投影矩阵。
  // three 的 LightShadow.updateMatrices() 只读现成的 projectionMatrix，
  // **不会**替你调这个方法 —— 漏掉这行的表现是「改了没反应」：范围还是默认的
  // ±5，不报错、不警告，只是阴影边缘莫名其妙地断掉。
  dirLight.shadow.camera.updateProjectionMatrix();

  /* 为什么灯不能和相机同侧 —— 6-1 踩过的坑：
     最初灯放在 (6, 10, 7)，相机在 (6, 5, 9)，两者几乎同一侧。结果阴影落在
     立方体背离光源的那一面，也就是**立方体的正后方**，从相机看过去正好被
     立方体自己挡得严严实实 —— 屏幕上一片干净，看不出任何阴影，很容易误判成
     「阴影没配好」而去乱改 shadowMap，其实阴影一直在正常渲染。
     同一个原因还有个副作用：两个可见面都朝光，亮度接近，物体看着是平的。
     现在房间开在 +X / +Z 两侧、相机在 (12, 8.5, 14)，灯就放在对角的
     (-6, 12, 9)：床和风扇的影子才朝镜头这边落，看得见。
     经验规则：主光偏离相机视线 40°~70°，别和相机同一侧。 */

  scene.add(ambient, dirLight);

  /* ================= 地面 ================= */

  // 为什么是两块地面，而不是一块：
  //   大地面（400×400）负责「接到天边」，让房间不像是浮在虚空里；
  //   房间地板（10×10）才是「偏热时变红」的那块，范围必须和房间一样大，
  //   否则整个视野（包括屋外）一起变红，就不像「这间宿舍偏热」了。
  // 房间地板比大地面高 0.02，避免两个共面的面互相闪烁（z-fighting）。
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND, GROUND),
    new THREE.MeshStandardMaterial({ color: 0xa9a8a2, roughness: 0.95, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  ground.name = 'ground';
  scene.add(ground);

  // 地板材质单独留一个引用：updateScene 要改它的颜色。
  const floorMat = new THREE.MeshStandardMaterial({
    color: LOOK[STATUS.NORMAL].floor, roughness: 0.9, metalness: 0,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM, ROOM), floorMat);
  // PlaneGeometry 默认躺在 XY 平面上（正面朝 +Z），把它想成一面立着的墙。
  // 绕 X 轴转 -90° 才放平、正面朝上（+Y）。忘了转的话，从默认视角看过去
  // 它是一条线（正好侧对着你），会被误判成「地板没画出来」。
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;    // 接住床和风扇的影子
  floor.castShadow = false;      // 地面自己投自己只会出一身麻点
  floor.name = 'floor';
  scene.add(floor);

  /* ================= 当前重点标记环（Step 8-3） ================= */

  // 画面里这间宿舍正是「当前重点」时，地板上多一圈环。默认不出现。
  //
  // 为什么用**平躺的环**而不是把房间整体描个边：相机是斜着俯视的，地板在画面里
  // 占的面积最大、遮挡最少，一圈环一眼就能看见；描边的话，两面墙是半透明的，
  // 描出来的线会跟墙缝混在一起。
  //
  // 用 MeshBasicMaterial（不受光照影响）而不是 Standard：这是个**界面记号**，
  // 不是场景里的一件东西。跟着灯光忽明忽暗的话，偏冷那段（两盏灯都偏蓝、
  // 整体压暗）它就不显眼了，而「谁是重点」跟屋里冷不冷没有关系。
  const focusRing = new THREE.Mesh(
    new THREE.RingGeometry(FOCUS_RING_INNER, FOCUS_RING_OUTER, 64),
    new THREE.MeshBasicMaterial({
      color: FOCUS_COLOR, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
    })
  );
  // RingGeometry 和地板一样躺在 XY 平面上，同样要绕 X 转 -90° 才放平。
  focusRing.rotation.x = -Math.PI / 2;
  // 抬 0.01 免得和地板共面闪烁（地面那一对用的是 0.02，这里小一号就够了 ——
  // 环比地面小得多，边缘的斜视角度没那么刁）。
  focusRing.position.y = 0.01;
  focusRing.name = 'focus-ring';
  focusRing.visible = false;
  scene.add(focusRing);

  /* ================= 墙 ================= */

  // 只做两面（-X 和 -Z），留下 +X / +Z 开着 —— 相机就在那个角上，
  // 四面全围上就只能看见一堵墙的外墙皮，看不到屋里。
  //
  // 用 PlaneGeometry + DoubleSide，不用有厚度的 BoxGeometry：半透明物体每多一层
  // 面就多叠一次透明度，盒子的正反面会让墙色变浑，单个平面正好一层。
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xdfe0da,
    roughness: 0.95,
    metalness: 0,
    transparent: true,
    opacity: 0.3,          // 半透明：能看见屋里，墙又还在
    side: THREE.DoubleSide, // 从背面看也要画（相机绕到屋后就靠它）
  });

  const wallBack = new THREE.Mesh(new THREE.PlaneGeometry(ROOM, WALL_H), wallMat);
  wallBack.position.set(0, WALL_H / 2, -ROOM / 2);
  wallBack.name = 'wall-back';
  scene.add(wallBack);

  const wallLeft = new THREE.Mesh(new THREE.PlaneGeometry(ROOM, WALL_H), wallMat);
  wallLeft.position.set(-ROOM / 2, WALL_H / 2, 0);
  // 平面默认正面朝 +Z。绕 Y 转 +90° 后正面朝 +X，也就是朝屋里。
  wallLeft.rotation.y = Math.PI / 2;
  wallLeft.name = 'wall-left';
  scene.add(wallLeft);

  // 两面墙都不投也不收阴影：半透明的面接住影子会变成一块块深浅不一的补丁，
  // 看起来像渲染坏了；投的话又会在地上留下一堵实心墙的影子，和半透明自相矛盾。
  // 反正屋里的影子有地板接着，够了。

  /* ================= 床 ================= */

  // 床是个 Group：床架 + 床垫各自摆好，再由 Group 整体挪到墙角。
  // 不这么做的话，每加一个零件都要把「床的位置」重算一遍加进去，
  // 想挪一下床就得改两处 —— Group 就是把「零件之间的关系」和「整体在哪」分开。
  const bed = new THREE.Group();
  bed.name = 'bed';

  const bedFrame = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 0.45, 3.4),
    new THREE.MeshStandardMaterial({ color: 0x8a6a4f, roughness: 0.75, metalness: 0 })
  );
  // 几何体的原点在它自己的中心，所以给了高度就得抬到「半个高」才坐在地上。
  bedFrame.position.y = 0.45 / 2;
  bedFrame.castShadow = true;
  bedFrame.receiveShadow = true;

  const mattress = new THREE.Mesh(
    new THREE.BoxGeometry(2.3, 0.26, 3.3),
    new THREE.MeshStandardMaterial({ color: 0xeceae2, roughness: 0.9, metalness: 0 })
  );
  mattress.position.y = 0.45 + 0.26 / 2;   // 正好摞在床架上面
  mattress.castShadow = true;
  mattress.receiveShadow = true;

  bed.add(bedFrame, mattress);
  // 靠左墙、床头朝后墙。屋里开着扇在 +Z 那侧，不会打架。
  bed.position.set(-3.6, 0, -3);
  scene.add(bed);

  /* ================= 窗户 ================= */

  // 开窗不是「把窗户转个角度」那么简单：直接转 windowPane 的话，它绕自己的
  // 中心转，看起来像块板子在原地打转，不像开窗。真实窗户是绕**一条边**转的。
  // 做法是加一个 location 在铰链上的空 Group（windowPivot），把窗户挂到它的
  // 一侧（position.x = 半个宽），再转这个 Group —— 转轴自然就落在左边缘上。
  // 这是 three/GUI 里最常见的招：想绕非中心点旋转，就给它一个父节点当轴。
  const windowPivot = new THREE.Group();
  windowPivot.name = 'window-pivot';
  // 铰链在后墙上，窗洞左边。z 比墙面（-5）往屋里挪一点，免得和墙共面闪烁。
  windowPivot.position.set(0.3, 2.3, -ROOM / 2 + 0.1);

  const windowMat = new THREE.MeshStandardMaterial({
    color: LOOK[STATUS.NORMAL].window, roughness: 0.25, metalness: 0.1,
  });
  const windowPane = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.6, 0.1), windowMat);
  windowPane.position.x = 2.6 / 2;   // 挂在铰链的 +X 侧
  windowPane.castShadow = true;
  windowPane.name = 'window-pane';
  windowPivot.add(windowPane);
  scene.add(windowPivot);

  /* ================= 风扇 ================= */

  // 风扇分两层，不能合成一层：
  //   fanMount —— 管「摆在哪儿、朝哪边」，还挂着把风扇连到墙上的支架；
  //   fan      —— 只管自己转。
  // 合成一层的话，转起来连支架一起转，看着像整台风扇在墙上打滚。
  // fan 里就是题目要的那个 Group：一个中心 + 3 片扇叶。
  const fanMount = new THREE.Group();
  fanMount.name = 'fan-mount';
  // 挂在左墙上。绕 Y 转 +90° 后，风扇的局部 +Z 指向世界 +X，也就是朝屋里吹。
  fanMount.position.set(-4.6, 2.6, 2.4);
  fanMount.rotation.y = Math.PI / 2;

  const bracket = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.16, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x6f7379, roughness: 0.6, metalness: 0.3 })
  );
  // 局部 -Z 指向墙（世界 -X），所以支架往 -Z 伸，一头扎进墙里一头接住轮毂。
  bracket.position.z = -0.28;
  bracket.castShadow = true;
  fanMount.add(bracket);

  const fan = new THREE.Group();
  fan.name = 'fan';

  // 中心（轮毂）。圆柱默认轴向是 Y，而扇叶摊在 XY 平面上（转轴是 Z），
  // 所以绕 X 转 90° 把它的轴也扳到 Z 上。不扳的话中心是个立着的圆筒，
  // 从正面看是一根竖条，不像风扇的中心。
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.17, 0.17, 0.24, 16),
    new THREE.MeshStandardMaterial({ color: 0x6f7379, roughness: 0.5, metalness: 0.4 })
  );
  hub.rotation.x = Math.PI / 2;
  hub.castShadow = true;
  hub.name = 'fan-hub';
  fan.add(hub);

  // 3 片扇叶，绕中心互成 120°。
  // 位置用 cos/sin 撒在半径 0.66 的圆上，同时把叶片自己也绕 Z 转同样的角度 ——
  // 少了后面那一步，三片叶子的朝向全是水平的，看起来像三根平行棍子而不是风车。
  const bladeMat = new THREE.MeshStandardMaterial({
    color: 0xa8aeb4, roughness: 0.55, metalness: 0.2,
  });
  for (let i = 0; i < 3; i++) {
    const angle = (i * Math.PI * 2) / 3;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(1, 0.34, 0.06), bladeMat);
    blade.position.set(Math.cos(angle) * 0.66, Math.sin(angle) * 0.66, 0);
    blade.rotation.z = angle;
    blade.castShadow = true;
    blade.name = 'fan-blade-' + i;
    fan.add(blade);
  }

  fanMount.add(fan);
  scene.add(fanMount);

  /* ================= camera：相机 ================= */

  // 容器被隐藏时（display:none、或者还没布局完）clientWidth/Height 是 0，
  // 拿 0 去除会得到 Infinity/NaN，相机矩阵整个变成 NaN —— 表现是「画面全黑
  // 但控制台一条错都没有」，很难查。退回 1 至少能继续跑，尺寸会在 resize 时补上。
  function size() {
    return { w: host.clientWidth || 1, h: host.clientHeight || 1 };
  }

  // PerspectiveCamera 的四个参数：视锥的竖直张角（度）、宽高比、
  // 近裁剪面、远裁剪面。比近裁剪面更近、或比远裁剪面更远的物体不参与渲染。
  //
  // far 要能罩住那块 400×400 大地面的远角，否则会在远处切出一道弧形的洞 ——
  // 表现为「地面缺了一块」，而且看不出和相机参数有关。
  // 但 near 也不能太小：深度缓冲的精度取决于 far/near 的比值，近处给 0.1
  // 而远处要 1000，比值一万，近处的面就开始打架（z-fighting）。
  // 这个场景最近的东西离相机也有十几米，near 取 0.5 绰绰有余，比值降到 1200。
  const camera = new THREE.PerspectiveCamera(50, size().w / size().h, 0.5, 600);
  // 站在房间开着的那一角（+X / +Z）斜上方看进去，能同时看到两面墙、床、
  // 窗户和风扇。再高一点会变成俯视图，看不出墙的高度。
  camera.position.set(12, 8.5, 14);
  // 看向房间中心偏上：盯地板会把地面占满画面，屋顶那侧反而空一大块。
  camera.lookAt(0, 1.8, 0);

  /* ================= 尺寸自适应 ================= */

  function onResize() {
    const { w, h } = size();

    // 宽高比必须始终等于容器的 宽/高，否则画面会被拉伸（圆看起来是椭圆）。
    camera.aspect = w / h;
    // 改完 aspect 一定要调这个方法。相机的投影矩阵是「算一次、存起来」的，
    // 只改 aspect 不重算，渲染时用的还是旧矩阵 —— 这是「我明明改了却没反应」
    // 最常见的原因，值得单独记一句。
    camera.updateProjectionMatrix();

    renderer.setSize(w, h);
  }

  // 先对齐一次当前尺寸，再挂监听 —— 否则页面打开到第一次窗口变化之间，
  // 画布一直是 renderer 的默认尺寸 300×150（左下角一小块）。
  onResize();
  window.addEventListener('resize', onResize);

  /* ================= 状态 ================= */

  // 风扇转不转，只由这个标志位决定；动画循环每帧读它一次。
  // 分开存而不是直接看 fan.rotation 有没有在变 —— 「要不要转」和「已经转到哪了」
  // 是两件事，停的时候角度要留在原地，不能归零。
  let fanOn = false;

  /**
   * 手动开关风扇。updateScene 内部走的也是它，所以后调用的那次为准。
   * @param {boolean} on 真值就转（别传 'false' 这种字符串，非空字符串是真值）
   * @returns {boolean} 归一化之后的开关状态
   */
  function setFanOn(on) {
    fanOn = !!on;
    return fanOn;
  }

  /**
   * 亮起 / 熄灭「当前重点」那圈标记。
   *
   * **和 updateScene 无关**，是两条独立的线：
   *   updateScene  说「这间宿舍现在怎么了」（偏热 -> 地板红、风扇转）
   *   setFocus     说「要看的就是这一间」（谁是当前重点）
   * 所以它不放进 LOOK 表 —— 那张表是「状态 -> 外观」，而这个记号跟状态无关：
   * 一个正常宿舍只要没别的异常，它也可以是当前重点吗？不会（重点只在异常里挑），
   * 但**表里加一列 focus 会让「四种状态各自改什么」变得不容易一眼看全**，
   * 而那正是那张表存在的意义。所以单独一个方法。
   *
   * 页面那边负责判断「当前画的这间是不是重点」—— scene.js 只认一个布尔值，
   * 不知道 nodeId 是什么，也不该知道（那是看板的事）。
   *
   * @param {boolean} on 真值就亮
   * @returns {boolean} 归一化之后的开关状态
   */
  function setFocus(on) {
    focusRing.visible = !!on;
    return focusRing.visible;
  }

  /**
   * 按状态改变场景外观。
   *
   * 四种状态各自改什么，全在上面那张 LOOK 表里，这里只负责照着贴上去。
   * 不在这里写 if/else 判断 —— 表能一眼看全四种状态，if 要一行行读。
   *
   * @param {string} status '正常' / '偏冷' / '偏热' / '偏湿'
   * @returns {string} 实际生效的状态；传了不认识的值会返回 '正常'
   */
  function updateScene(status) {
    let look = Object.prototype.hasOwnProperty.call(LOOK, status) ? LOOK[status] : null;
    let applied = status;

    if (!look) {
      // 不抛异常：这个方法的入参迟早会来自 MQTT 报文，链路上什么都可能传进来。
      // 显示层不该因为一个坏值整页崩掉 —— 和 dashboard 那边「脏数据拦下来、
      // 记一条警告、其余照常」是同一个思路。
      applied = STATUS.NORMAL;
      look = LOOK[applied];
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[scene] 不认识的 status：' + status + '，按「' + applied + '」显示');
      }
    }

    floorMat.color.set(look.floor);
    windowMat.color.set(look.window);
    dirLight.color.set(look.sun);
    ambient.color.set(look.ambient);
    scene.background.set(look.bg);

    // 开窗直接给角度，不做缓动。按钮点下去要立刻看到变化，
    // 而且立刻到位也让「打开了吗」这件事一眼可验、好写测试。
    // 想让开合柔和一点的话，在动画循环里让 rotation.y 朝这个目标值逼近即可。
    windowPivot.rotation.y = look.open ? WINDOW_OPEN_ANGLE : 0;

    setFanOn(look.fan);

    return applied;
  }

  /* ================= 动画循环 ================= */

  const clock = new THREE.Clock();

  // 用 renderer.setAnimationLoop 而不是自己写 requestAnimationFrame：
  // 它内部就是用 rAF 实现的，但把「停」也一起管了（传 null 即停），
  // 而且将来接 WebXR 时不用改这段代码。
  renderer.setAnimationLoop(function () {
    // Clock 给的是「距上一帧过了多少秒」。用它乘速度，转动快慢就与帧率无关；
    // 写成 fan.rotation.z += 0.1（每帧固定量）的话，120Hz 屏幕上会转得比
    // 60Hz 快一倍 —— 换个显示器演示，观感就变了。
    const dt = clock.getDelta();

    // 每帧都读一次标志位，而不是在 setFanOn 里启动/停掉一套定时器：
    // 状态只有一个来源，不会出现「关了但还在转」这种两处状态打架的情况。
    if (fanOn) {
      fan.rotation.z += dt * FAN_SPIN;
    }

    // 这一行才是真正「画一帧」。没有它，前面所有搭建都只是数据结构，屏幕上什么都不会有。
    renderer.render(scene, camera);
  });

  // 建好就先按「正常」摆一次，而不是靠各个材质构造函数里那点初值。
  // 否则以后改了 LOOK 表却忘了改构造函数，页面刚打开的样子会和点一下「正常」不一样。
  updateScene(STATUS.NORMAL);

  /* ================= 清理 ================= */

  /**
   * 拆掉这个场景。
   * 单一页面里不调也不会出事（刷新就没了），但将来要是做「切换场景」，
   * 不调就会每次切换都漏一份显存出来。
   */
  function dispose() {
    renderer.setAnimationLoop(null);                   // 停循环，否则回调还会继续跑
    window.removeEventListener('resize', onResize);

    // three 的几何体/材质/贴图**不会**因为「从 scene 里 remove 掉」而被回收 ——
    // 它们占的是 GPU 上的显存，JS 的垃圾回收管不着，必须逐个 dispose()。
    // 这是 three 里最经典的显存泄漏来源。
    // traverse 是**递归**的，所以床、窗户、风扇这些嵌在 Group 里的零件也会被走到。
    scene.traverse(function (obj) {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });

    renderer.dispose();
    if (renderer.domElement.parentNode === host) {
      host.removeChild(renderer.domElement);
    }
    // 覆盖层是我们自己加进容器的，也得自己摘掉
    if (labelEl.parentNode === host) {
      host.removeChild(labelEl);
    }
  }

  return {
    scene, camera, renderer,
    floor, ground, bed, windowPane, windowPivot, fan, fanMount, focusRing,
    updateScene, setFanOn, setLabel, setFocus, dispose,
  };
}
