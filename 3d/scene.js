/**
 * Step 6-1：最小 Three.js 场景
 *
 * 这个文件只干一件事：给一个 DOM 容器，在里面搭出一个会转的立方体。
 * 还没有宿舍模型、没有数据、不连 MQTT —— 先把「three 在这个项目里跑得起来」
 * 立住，6-2 之后往这个骨架上挂东西。
 *
 * ── 三个核心对象 ────────────────────────────────────────────────
 * Three.js 的每个场景都必须有这三个，缺一个都画不出东西：
 *
 *   scene    场景。一个「世界」，所有要画的东西（地板、立方体、灯光）都挂在
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

/* 立方体每秒转多少弧度。写成「每秒」而不是「每帧」，原因见下面动画循环里的注释。 */
const CUBE_SPIN = 0.6;

/**
 * 在 container 里建一个最小 Three.js 场景。
 *
 * @param {HTMLElement|string} container 容器元素本身，或它的 id
 * @returns {{scene: THREE.Scene, camera: THREE.PerspectiveCamera,
 *            renderer: THREE.WebGLRenderer, cube: THREE.Mesh,
 *            floor: THREE.Mesh, dispose: function(): void}}
 * @throws {Error} 找不到容器、或这台设备没有可用的 WebGL
 */
export function createDorm3D(container) {
  const host = typeof container === 'string' ? document.getElementById(container) : container;
  if (!host) {
    throw new Error('createDorm3D：找不到容器 ' + container);
  }

  /* ---------- renderer：渲染器 ---------- */

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
  // 像素，笔记本核显上会明显掉帧。封顶 2 是观感和性能的常见折中：
  // 再往上肉眼几乎看不出差别，开销却继续翻倍。
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  // 抗锯齿关不掉地会有明显锯齿；它是构造参数，建完再改要重建 renderer。

  // three 造出来的 <canvas> 是行内元素（inline），行内元素底部会留出约 4px 的
  // 基线空隙。容器有自己的背景色时，就会在画布下面露出一条缝。
  renderer.domElement.style.display = 'block';
  host.appendChild(renderer.domElement);

  // 阴影默认是关的，得显式打开。这一步只是允许投影，
  // 「谁投、谁接」还要在光源和物体上分别标（见下面 castShadow / receiveShadow）。
  renderer.shadowMap.enabled = true;

  /* ---------- scene：场景（世界） ---------- */

  const scene = new THREE.Scene();
  // 不给背景色的话是纯黑，地板和它的暗部会糊在一起看不出边界。
  scene.background = new THREE.Color(0xececea);

  /* ---------- 灯光 ---------- */

  // 环境光：没有方向、没有位置，均匀照亮所有物体。它不产生任何明暗，
  // 作用只是把背光面从死黑里拉起来。只留它的话画面会像贴纸一样平。
  const ambient = new THREE.AmbientLight(0xffffff, 1.8);

  // 平行光：有方向、没有位置（position 只用来定方向，把它想成太阳）。
  // 明暗和阴影都是它给的 —— 这才是让画面看起来「立体」的那盏灯。
  //
  // 位置 (-6, 12, 9) 是相对相机 (5, 4.5, 7.5) 特意挑的：见下面「为什么灯不能
  // 和相机同侧」那段。
  const dirLight = new THREE.DirectionalLight(0xffffff, 3);
  dirLight.position.set(-6, 12, 9);

  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(1024, 1024);
  // 阴影相机是一台正交相机，必须手动告诉它「管多大范围」。默认范围很小（±5），
  // 超出去的部分不会投下阴影 —— 表现为「远处的物体影子凭空消失」。
  // 开太大则同样的 1024×1024 要摊到更大面积上，影子发糊。
  // 所以这里只圈住「会落下阴影的那一小片」，而不是整块地板。
  dirLight.shadow.camera.left = -12;
  dirLight.shadow.camera.right = 12;
  dirLight.shadow.camera.top = 12;
  dirLight.shadow.camera.bottom = -12;

  // 改完阴影相机的范围，必须自己重算一次投影矩阵。
  // three 的 LightShadow.updateMatrices() 只读现成的 projectionMatrix，
  // **不会**替你调这个方法 —— 漏掉这行的表现是「改了没反应」：范围还是默认的
  // ±5，不报错、不警告，只是阴影边缘莫名其妙地断掉。
  dirLight.shadow.camera.updateProjectionMatrix();

  /* 为什么灯不能和相机同侧 —— 这一步踩过的坑：
     最初灯放在 (6, 10, 7)，相机在 (6, 5, 9)，两者几乎同一侧。结果阴影落在
     立方体背离光源的那一面，也就是**立方体的正后方**，从相机看过去正好被
     立方体自己挡得严严实实 —— 屏幕上一片干净，看不出任何阴影，很容易误判成
     「阴影没配好」而去乱改 shadowMap，其实阴影一直在正常渲染。
     同一个原因还有个副作用：两个可见面都朝光，亮度接近，立方体看着是平的。
     把灯挪到相机的斜对角，两个问题一起解决：影子转到侧面看得见，
     立方体也变成一亮一暗两个面，「立体」感才出来。
     经验规则：主光偏离相机视线 40°~70°，别和相机同一侧。 */

  scene.add(ambient, dirLight);

  /* ---------- 地板 ---------- */

  // 400×400 不是随手写的大数：相机是贴着地面看的，地板小了这个方形就收不了边，
  // 远处的角会在地平线附近顶出一个看得见的"山脊"（因为正方形的角比边远，
  // 投影出来更高）。开到几百之后整条边都压进地平线，看不出是块有限的地板。
  // 一块 400×400 的平面只有两个三角形，开大不花性能，只是别指望它接阴影 ——
  // 阴影范围另由上面的 shadow.camera 管，两者无关。
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    // MeshStandardMaterial 是「受光」材质：它按照到它身上的光来决定明暗。
    // 想让它有明暗就必须有灯。roughness/metalness 调的是表面质感：
    // 粗糙度高 = 哑光，金属度高 = 反光。
    new THREE.MeshStandardMaterial({ color: 0xb9b8b2, roughness: 0.95, metalness: 0 })
  );
  // PlaneGeometry 默认躺在 XY 平面上（正面朝 +Z），把它想成一面立着的墙。
  // 绕 X 轴转 -90° 才放平、正面朝上（+Y）。忘了转的话，从默认视角看过去
  // 它是一条线（正好侧对着你），会被误判成「地板没画出来」。
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;   // 接住立方体的影子
  floor.name = 'floor';
  scene.add(floor);

  /* ---------- 立方体 ---------- */

  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    // 颜色取自项目的设计 token（--focus / --chart-temp 同一个蓝），
    // 让 3D 页面和两个看板看起来是一套东西。
    new THREE.MeshStandardMaterial({ color: 0x2a78d6, roughness: 0.35, metalness: 0.1 })
  );
  // 几何体的原点在它自己的中心，所以方块默认有一半埋在地板下面。
  // 抬到 y = 1（半个边长）正好坐在上面。
  cube.position.y = 1;
  cube.castShadow = true;
  cube.name = 'cube';
  scene.add(cube);

  /* ---------- camera：相机 ---------- */

  // 容器被隐藏时（display:none、或者还没布局完）clientWidth/Height 是 0，
  // 拿 0 去除会得到 Infinity/NaN，相机矩阵整个变成 NaN —— 表现是「画面全黑
  // 但控制台一条错都没有」，很难查。退回 1 至少能继续跑，尺寸会在 resize 时补上。
  function size() {
    return { w: host.clientWidth || 1, h: host.clientHeight || 1 };
  }

  // PerspectiveCamera 的四个参数：视锥的竖直张角（度）、宽高比、
  // 近裁剪面、远裁剪面。比近裁剪面更近、或比远裁剪面更远的物体不参与渲染。
  //
  // far 要能罩住那块 400×400 地板的远角（离相机约 290），否则会在远处切出
  // 一道弧形的洞 —— 表现为「地板缺了一块」，而且看不出和相机参数有关。
  // 但 near 也不能太小：深度缓冲的精度取决于 far/near 的比值，近处给 0.1
  // 而远处要 1000，比值一万，近处的面就开始打架（z-fighting）。
  // 这个场景最近的东西离相机也有 5 个单位，near 取 0.5 绰绰有余，比值降到 1200。
  const camera = new THREE.PerspectiveCamera(50, size().w / size().h, 0.5, 600);
  // 站在方块的斜前方、比它高一点，稍微俯视 —— 完全平视的话地板会退化成一条线，
  // 看不出是个平面。
  camera.position.set(5, 4.5, 7.5);
  // 看向方块的腰部而不是原点 (0,0,0)：原点在地板平面上，
  // 盯着那儿会把地板占满整个画面，方块反而被顶到边上去。
  camera.lookAt(0, 1, 0);

  /* ---------- 尺寸自适应 ---------- */

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

  /* ---------- 动画循环 ---------- */

  const clock = new THREE.Clock();

  // 用 renderer.setAnimationLoop 而不是自己写 requestAnimationFrame：
  // 它内部就是用 rAF 实现的，但把「停」也一起管了（传 null 即停），
  // 而且将来接 WebXR 时不用改这段代码。
  renderer.setAnimationLoop(function () {
    // Clock 给的是「距上一帧过了多少秒」。用它乘速度，转动快慢就与帧率无关；
    // 写成 cube.rotation.y += 0.01（每帧固定量）的话，120Hz 屏幕上会转得比
    // 60Hz 快一倍 —— 换个显示器演示，观感就变了。
    const dt = clock.getDelta();
    cube.rotation.y += dt * CUBE_SPIN;

    // 这一行才是真正「画一帧」。没有它，前面所有搭建都只是数据结构，屏幕上什么都不会有。
    renderer.render(scene, camera);
  });

  /* ---------- 清理 ---------- */

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
    scene.traverse(function (obj) {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });

    renderer.dispose();
    if (renderer.domElement.parentNode === host) {
      host.removeChild(renderer.domElement);
    }
  }

  return { scene, camera, renderer, cube, floor, dispose };
}
