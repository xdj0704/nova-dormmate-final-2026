/**
 * Step 6-2：一间简化宿舍 + updateScene(status)
 *
 * 6-1 里只有一块地板和一个方块，是拿来验「three 在这个项目里跑得起来」的。
 * 6-2 把宿舍搭出来（地板 / 墙 / 床 / 窗户 / 风扇），再让四种状态各自
 * 改变场景的样子，好和两个看板、小程序对上同一套 status。
 *
 * ── E1-2 之后这个文件剩什么 ────────────────────────────────────
 * 「一间房怎么搭」搬去了 room.js（E1 的三间房和这里的单间房共用它）。
 * 留在这里的是**围着这一间房**的东西：
 *
 *   renderer 渲染器 —— 把「scene 里有什么」按「camera 怎么看」算成一张图，
 *            画到它自己创建的 <canvas> 上。scene 和 camera 都只是输入，
 *            输出在 renderer 这儿。一句话：renderer.render(scene, camera)。
 *   camera   相机 —— 观察这个世界的眼睛，决定「站在哪儿、朝哪看、能看多宽」。
 *            PerspectiveCamera 模拟人眼：近大远小。它不改变世界，只决定你怎么看它。
 *   scene    场景 —— 一个「世界」，要画的东西都挂在它下面。它自己不可见、
 *            也不能直接显示，本质是个名册/容器。灯光也挂在这里 —— 光不是
 *            「照亮屏幕」，是照亮这个世界的一部分，不在名册里就不参与计算。
 *   灯 / 背景 / 覆盖层 / 动画循环 / 清理
 *
 * 外加一样 room.js 里没有的：**灯和背景跟着状态一起变**。这是单间房独有的 ——
 * 只有一间房的时候，让整盏灯偏蓝就等于是「这间房冷」。三间房各有各的状态时
 * 没法这么干（一盏灯没法同时是三种颜色），那边（world.js）就只改房间自己的零件。
 *
 * 用的是 ES Module（import/export）。注意本文件是被 index.html 里
 * <script type="module"> 加载的，模块天然是严格模式，所以不需要 'use strict'。
 */

import * as THREE from 'three';
import { buildRoom, LOOK, STATUS, ROOM, FAN_SPIN, WINDOW_OPEN_ANGLE, FOCUS_COLOR } from './room.js';

/* 对外常量原样再导出一次：它们是这个模块 API 的一部分，
   搬到 room.js 只是换了个住址，调用方（和测试）不该跟着改 import 路径。 */
export { STATUS, FAN_SPIN, WINDOW_OPEN_ANGLE, FOCUS_COLOR, ROOM };

const GROUND = 400;   // 室外大地面。见下面「为什么还要一块大地面」

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
  //
  // （E1 的三间房那边用的是 CSS2DRenderer，标签跟着房间一起动，见 world.js。
  //   这里留着手写覆盖层，是因为看板那块面板只有一个「当前宿舍」要说，
  //   一行固定文字就够了，不值得为它多引一个渲染器。）
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
  //   房间地板（10×10，在 room.js 里）才是「偏热时变红」的那块，范围必须和
  //   房间一样大，否则整个视野（包括屋外）一起变红，就不像「这间宿舍偏热」了。
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

  /* ================= 这一间房 ================= */

  // 不传 prefix：零件名和 Step 6-2 时一模一样（'floor' / 'bed' / 'focus-ring' …）。
  // 按名字找零件的地方（包括测试）都不用改。
  const room = buildRoom();
  scene.add(room.group);

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

  /**
   * 手动开关风扇。updateScene 内部走的也是它，所以后调用的那次为准。
   * @param {boolean} on 真值就转（别传 'false' 这种字符串，非空字符串是真值）
   * @returns {boolean} 归一化之后的开关状态
   */
  function setFanOn(on) {
    return room.setFanOn(on);
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
   * 页面那边负责判断「当前画的这间是不是重点」—— 这里只认一个布尔值，
   * 不知道 nodeId 是什么，也不该知道（那是看板的事）。
   *
   * @param {boolean} on 真值就亮
   * @returns {boolean} 归一化之后的开关状态
   */
  function setFocus(on) {
    room.ring.visible = !!on;
    return room.ring.visible;
  }

  /**
   * 按状态改变场景外观。
   *
   * 四种状态各自改什么，全在那张 LOOK 表里，这里只负责照着贴上去。
   * 不在这里写 if/else 判断 —— 表能一眼看全四种状态，if 要一行行读。
   *
   * 分两半：房间自己的零件交给 room.applyLook，**灯和背景在这里改**
   * （单间房才有的做法，理由见文件头）。
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

    room.applyLook(look);

    dirLight.color.set(look.sun);
    ambient.color.set(look.ambient);
    scene.background.set(look.bg);

    return applied;
  }

  /* ================= 动画循环 ================= */

  const clock = new THREE.Clock();

  // 用 renderer.setAnimationLoop 而不是自己写 requestAnimationFrame：
  // 它内部就是用 rAF 实现的，但把「停」也一起管了（传 null 即停），
  // 而且将来接 WebXR 时不用改这段代码。
  renderer.setAnimationLoop(function () {
    // Clock 给的是「距上一帧过了多少秒」，交给 room.spin —— 转动快慢与帧率无关。
    const dt = clock.getDelta();

    // 每帧都读一次标志位，而不是在 setFanOn 里启动/停掉一套定时器：
    // 状态只有一个来源，不会出现「关了但还在转」这种两处状态打架的情况。
    room.spin(dt);

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
    floor: room.floor, ground, bed: room.bed,
    windowPane: room.windowPane, windowPivot: room.windowPivot,
    fan: room.fan, fanMount: room.fanMount, focusRing: room.ring,
    updateScene, setFanOn, setLabel, setFocus, dispose,
  };
}
