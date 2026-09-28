'use strict';

/**
 * 3d/scene.js 的测试。纯 Node，零依赖。
 *
 * 做法和 tests/dashboard.test.js 一样：把**真实的**源文件跑起来，而不是另写一份
 * 等价逻辑 —— 否则测的是抄来的那份，不是线上那份。
 *
 * 两个麻烦，各有各的解法：
 *
 *   1) scene.js 是 ES Module，`import * as THREE from 'three'` 是个裸名字。
 *      Node 不认 importmap，直接 import 会报 ERR_MODULE_NOT_FOUND。
 *      解法：把源码里那一行改写成指向本地假模块的绝对 file:// URL，写成 .mjs
 *      扔进临时目录再 import。不做语法改写、不装任何依赖，跑的还是原文件。
 *
 *   2) 它要 document / window。Node 里没有。
 *      解法：往 globalThis 上挂假货，再调 createDorm3D。
 *
 * 另外：Node 里没有 package.json，所以 .js 默认是 CommonJS，没法用顶层 await。
 * 下面的 import() 只能包在 async 里，断言全在它之后。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const SCENE_FILE = path.join(ROOT, '3d', 'scene.js');
const HTML_FILE = path.join(ROOT, '3d', 'index.html');
const LIB_FILE = path.join(ROOT, '3d', 'lib', 'three.module.js');

let pass = 0;
let fail = 0;

function check(label, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ok   ' + label);
  } else {
    fail++;
    console.log('  FAIL ' + label + (extra === undefined ? '' : '   实际：' + extra));
  }
}

/* ---------- 假 three 模块 ---------- */

const STUB_SOURCE = `
export const log = {
  renderers: [], scenes: [], cameras: [], lights: [], meshes: [], clocks: [],
};

class Vec3 {
  constructor(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
class Vec2 {
  constructor(x, y) { this.x = x || 0; this.y = y || 0; }
  set(x, y) { this.x = x; this.y = y; return this; }
}

export class Color { constructor(hex) { this.hex = hex; } }

export class Scene {
  constructor() { this.children = []; this.background = null; log.scenes.push(this); }
  add() {
    for (const o of arguments) this.children.push(o);
    return this;
  }
  traverse(fn) { fn(this); this.children.forEach((c) => fn(c)); }
}

export class PerspectiveCamera {
  constructor(fov, aspect, near, far) {
    this.fov = fov; this.aspect = aspect; this.near = near; this.far = far;
    this.position = new Vec3();
    this.lookAtCalls = [];
    this.projectionUpdates = 0;
    log.cameras.push(this);
  }
  lookAt(x, y, z) { this.lookAtCalls.push([x, y, z]); return this; }
  updateProjectionMatrix() { this.projectionUpdates++; return this; }
}

class Light {
  constructor(color, intensity, kind) {
    this.color = color; this.intensity = intensity; this.kind = kind;
    this.position = new Vec3();
    log.lights.push(this);
  }
}

export class AmbientLight extends Light {
  constructor(color, intensity) { super(color, intensity, 'ambient'); }
}

export class DirectionalLight extends Light {
  constructor(color, intensity) {
    super(color, intensity, 'directional');
    this.castShadow = false;
    this.target = { position: new Vec3() };
    this.shadow = {
      mapSize: new Vec2(),
      camera: {
        left: -5, right: 5, top: 5, bottom: -5,
        projectionUpdates: 0,
        updateProjectionMatrix() { this.projectionUpdates++; },
      },
    };
  }
}

class Geometry {
  constructor(kind, params) { this.kind = kind; this.parameters = params; this.disposed = 0; }
  dispose() { this.disposed++; }
}
export class BoxGeometry extends Geometry {
  constructor(w, h, d) { super('Box', { width: w, height: h, depth: d }); }
}
export class PlaneGeometry extends Geometry {
  constructor(w, h) { super('Plane', { width: w, height: h }); }
}

export class MeshStandardMaterial {
  constructor(opts) { Object.assign(this, opts || {}); this.disposed = 0; }
  dispose() { this.disposed++; }
}

export class Mesh {
  constructor(geometry, material) {
    this.geometry = geometry; this.material = material;
    this.position = new Vec3(); this.rotation = new Vec3();
    this.castShadow = false; this.receiveShadow = false; this.name = '';
    this.children = [];
    log.meshes.push(this);
  }
}

export class Clock {
  constructor() { this.delta = 1 / 60; log.clocks.push(this); }
  getDelta() { return this.delta; }
}

export class WebGLRenderer {
  constructor(opts) {
    this.options = opts || {};
    this.domElement = { style: {}, parentNode: null, width: 0, height: 0 };
    this.shadowMap = { enabled: false, type: null };
    this.pixelRatio = null;
    this.sizes = [];
    this.loop = null;
    this.renderCalls = [];
    this.disposed = 0;
    log.renderers.push(this);
  }
  setPixelRatio(r) { this.pixelRatio = r; return this; }
  setSize(w, h) { this.sizes.push([w, h]); this.domElement.width = w; this.domElement.height = h; return this; }
  setAnimationLoop(fn) { this.loop = fn; return this; }
  render(scene, camera) { this.renderCalls.push([scene, camera]); return this; }
  dispose() { this.disposed++; }
}
`;

/* ---------- 假 DOM ---------- */

function makeHost(w, h) {
  return {
    clientWidth: w,
    clientHeight: h,
    children: [],
    innerHTML: '',
    appendChild(el) { this.children.push(el); el.parentNode = this; return el; },
    removeChild(el) {
      const i = this.children.indexOf(el);
      if (i >= 0) this.children.splice(i, 1);
      el.parentNode = null;
      return el;
    },
  };
}

function installGlobals(opts) {
  const o = opts || {};
  const host = makeHost(o.w === undefined ? 800 : o.w, o.h === undefined ? 600 : o.h);
  const listeners = {};

  const win = {
    devicePixelRatio: o.dpr === undefined ? 1 : o.dpr,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = listeners[type] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    fire(type, ev) { (listeners[type] || []).slice().forEach((fn) => fn(ev || {})); },
    count(type) { return (listeners[type] || []).length; },
  };

  const doc = { getElementById: (id) => (id === 'scene' ? host : null) };

  globalThis.document = doc;
  globalThis.window = win;
  return { host, win, doc };
}

/* ---------- 跑 ---------- */

/* D 段建出来的句柄，I 段（dispose）要用。声明必须在 IIFE 之前 ——
   写在文件末尾的话，IIFE 是先执行的那一半，会撞上 let 的暂时性死区。 */
let sceneHandle = null;

(async function main() {
  console.log('== 3d/scene.js ==\n');

  /* ===== A. 源文件约束 ===== */

  console.log('A. 源文件约束');

  const src = fs.readFileSync(SCENE_FILE, 'utf8');

  // 把注释剥掉再查语法，否则会匹配到注释里写的示例
  // （dashboard 那边的测试踩过这个坑，见 README「检查匹配到自己的注释」）
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const imports = [...code.matchAll(/^\s*import\s[\s\S]*?from\s+['"]([^'"]+)['"]/gm)]
    .map((m) => m[1]);
  check('只有一条 import', imports.length === 1, imports.length + ' 条：' + imports.join(', '));
  check('且来源是裸名字 three', imports[0] === 'three', imports[0]);

  // importmap 只映射了 "three" 这一条。要是源码里冒出第二个裸名字，
  // 浏览器会直接报找不到模块 —— 这条盯着它。
  const bareNames = imports.filter((s) => !s.startsWith('.') && !s.startsWith('/'));
  check('裸名字只有 three 一个（importmap 只映射了它）',
    bareNames.length === 1 && bareNames[0] === 'three', bareNames.join(', '));

  check('用的是 export function（不是 IIFE、不是 globalThis 挂载）',
    /export\s+function\s+createDorm3D\s*\(/.test(code));
  check('没有 require(', !/\brequire\s*\(/.test(code));

  /* ===== 准备假模块 ===== */

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-3d-'));
  const stubPath = path.join(tmp, 'three-stub.mjs');
  fs.writeFileSync(stubPath, STUB_SOURCE, 'utf8');

  const rewritten = src.replace(/from\s+['"]three['"]/,
    "from '" + pathToFileURL(stubPath).href + "'");
  check('源码里的 three 被改写成了本地假模块', rewritten !== src);

  const sceneCopy = path.join(tmp, 'scene-under-test.mjs');
  fs.writeFileSync(sceneCopy, rewritten, 'utf8');

  const mod = await import(pathToFileURL(sceneCopy).href);
  const log = (await import(pathToFileURL(stubPath).href)).log;

  check('导出了 createDorm3D', typeof mod.createDorm3D === 'function');

  const reset = () => {
    log.renderers.length = 0;
    log.scenes.length = 0;
    log.cameras.length = 0;
    log.lights.length = 0;
    log.meshes.length = 0;
    log.clocks.length = 0;
  };

  /* ===== B. 容器 ===== */

  console.log('\nB. 容器');

  {
    const env = installGlobals({ w: 800, h: 600 });
    const handle = mod.createDorm3D('scene');

    check('传 id 字符串能找到容器', log.renderers.length === 1);
    check('返回句柄带 scene / camera / renderer',
      !!handle.scene && !!handle.camera && !!handle.renderer);
    check('canvas 被挂进了容器', env.host.children.length === 1);
    check('canvas 是 renderer 造的那个',
      env.host.children[0] === handle.renderer.domElement);
    check('canvas 设了 display:block（否则行内元素底部会留 4px 缝）',
      handle.renderer.domElement.style.display === 'block',
      handle.renderer.domElement.style.display);

    const flat = installGlobals({ w: 10, h: 10 });
    const byEl = mod.createDorm3D(flat.host);
    check('也可以直接传元素本身', !!byEl.renderer);

    let threw = null;
    try { mod.createDorm3D('不存在的 id'); } catch (e) { threw = e; }
    check('找不到容器时抛错', threw instanceof Error);
    check('错误信息里写了是哪个容器', threw && threw.message.includes('不存在的 id'),
      threw && threw.message);

    reset();
  }

  /* ===== C. renderer ===== */

  console.log('\nC. renderer');

  {
    const env = installGlobals({ w: 800, h: 600, dpr: 3 });
    const h = mod.createDorm3D('scene');
    const r = h.renderer;

    check('开了抗锯齿', r.options.antialias === true, String(r.options.antialias));
    check('devicePixelRatio=3 时封顶到 2（否则要画 9 倍像素）',
      r.pixelRatio === 2, r.pixelRatio);
    check('阴影总开关打开了', r.shadowMap.enabled === true);
    check('setSize 用了容器的尺寸',
      r.sizes.length >= 1 && r.sizes[0][0] === 800 && r.sizes[0][1] === 600,
      JSON.stringify(r.sizes[0]));

    const env1 = installGlobals({ w: 400, h: 300, dpr: 1 });
    const h1 = mod.createDorm3D('scene');
    check('devicePixelRatio=1 时就是 1', h1.renderer.pixelRatio === 1, h1.renderer.pixelRatio);
    check('尺寸跟着容器走', h1.renderer.sizes[0][0] === 400, JSON.stringify(h1.renderer.sizes[0]));

    void env;
    reset();
  }

  /* ===== D. 场景内容 ===== */

  console.log('\nD. 场景内容');

  let sceneRef = null;
  let cameraRef = null;
  let rendererRef = null;
  let envRef = null;

  {
    envRef = installGlobals({ w: 800, h: 600 });
    const h = mod.createDorm3D('scene');
    sceneHandle = h;
    sceneRef = h.scene;
    cameraRef = h.camera;
    rendererRef = h.renderer;

    const named = (n) => sceneRef.children.find((c) => c && c.name === n);
    const floor = named('floor');
    const cube = named('cube');

    check('场景里有一块地板', !!floor);
    check('场景里有一个立方体', !!cube);
    check('地板用的是 PlaneGeometry', floor && floor.geometry.kind === 'Plane',
      floor && floor.geometry.kind);
    check('地板的宽和高相等（正方形）',
      floor && floor.geometry.parameters.width === floor.geometry.parameters.height);
    check('地板远大于立方体（小地板会在地平线附近顶出一个看得见的角）',
      floor && floor.geometry.parameters.width >= 100,
      floor && floor.geometry.parameters.width);

    check('立方体用的是 BoxGeometry', cube && cube.geometry.kind === 'Box',
      cube && cube.geometry.kind);
    check('立方体三个方向等长', cube
      && cube.geometry.parameters.width === cube.geometry.parameters.height
      && cube.geometry.parameters.height === cube.geometry.parameters.depth);

    check('地板绕 X 轴转了 -90°（不转的话它是立着的，会被看成一条线）',
      floor && Math.abs(floor.rotation.x + Math.PI / 2) < 1e-9,
      floor && floor.rotation.x);
    check('地板接阴影', floor && floor.receiveShadow === true);
    check('地板不投阴影（地面自己投自己只会出一身麻点）',
      floor && floor.castShadow === false);

    check('立方体投阴影', cube && cube.castShadow === true);
    check('立方体的 y = 半个边长，正好坐在地板上',
      cube && cube.position.y === cube.geometry.parameters.height / 2,
      cube && cube.position.y);
    check('立方体的 x/z 都在原点（不然会飘在地板外面）',
      cube && cube.position.x === 0 && cube.position.z === 0);

    check('场景设了背景色（不设是纯黑，地板暗部会和背景糊在一起）',
      sceneRef.background !== null && sceneRef.background !== undefined);

    check('没有多余的网格', log.meshes.length === 2, log.meshes.length + ' 个');
  }

  /* ===== E. 灯光 ===== */

  console.log('\nE. 灯光');

  {
    const amb = log.lights.filter((l) => l.kind === 'ambient');
    const dir = log.lights.filter((l) => l.kind === 'directional');

    check('有一盏环境光', amb.length === 1, amb.length + ' 盏');
    check('环境光有强度', amb[0] && amb[0].intensity > 0, amb[0] && amb[0].intensity);

    check('有一盏平行光', dir.length === 1, dir.length + ' 盏');
    check('平行光投阴影', dir[0] && dir[0].castShadow === true);
    check('平行光的阴影贴图尺寸设过',
      dir[0] && dir[0].shadow.mapSize.x > 0 && dir[0].shadow.mapSize.y > 0,
      dir[0] && dir[0].shadow.mapSize.x);

    const cam = dir[0].shadow.camera;
    check('阴影相机的范围被改过（不再是默认的 ±5）',
      cam.left === -12 && cam.right === 12 && cam.top === 12 && cam.bottom === -12,
      [cam.left, cam.right, cam.top, cam.bottom].join(','));

    // 这条是这一步真正踩到的坑：three 的 LightShadow.updateMatrices() 只读现成的
    // projectionMatrix，不会替你调 updateProjectionMatrix()。漏掉这行的话，
    // 上面那些 left/right/top/bottom 全部被静默忽略，范围还是 ±5，不报任何错。
    check('★ 改完阴影相机范围后调了 updateProjectionMatrix（漏了这行会静默失效）',
      cam.projectionUpdates >= 1, cam.projectionUpdates + ' 次');

    check('平行光不在原点（位置决定方向）',
      dir[0].position.x !== 0 || dir[0].position.y !== 0 || dir[0].position.z !== 0);

    // 另一个踩过的坑：灯和相机在同一侧时，影子落在物体正后方、被物体自己挡住，
    // 屏幕上一片干净，很容易误判成「阴影没配好」。
    const nx = (v) => {
      const m = Math.hypot(v.x, v.z);
      return m === 0 ? [0, 0] : [v.x / m, v.z / m];
    };
    const c = nx(cameraRef.position);
    const l = nx(dir[0].position);
    const dot = Math.max(-1, Math.min(1, c[0] * l[0] + c[1] * l[1]));
    const angle = (Math.acos(dot) * 180) / Math.PI;
    check('★ 主光与相机的水平夹角 > 30°（同侧时影子会藏在物体背后看不见）',
      angle > 30, angle.toFixed(1) + '°');
  }

  /* ===== F. 相机 ===== */

  console.log('\nF. 相机');

  {
    check('是 PerspectiveCamera', cameraRef.fov !== undefined);
    check('fov = 50', cameraRef.fov === 50, cameraRef.fov);
    check('aspect = 容器宽/高', cameraRef.aspect === 800 / 600, cameraRef.aspect);
    check('near/far 是正数且 far > near',
      cameraRef.near > 0 && cameraRef.far > cameraRef.near,
      cameraRef.near + ' / ' + cameraRef.far);
    check('far 罩得住地板（罩不住会在远处把地板切出一道弧形的洞）',
      cameraRef.far > Math.hypot(cameraRef.position.x, cameraRef.position.z) + 100,
      'far=' + cameraRef.far);
    check('相机不在原点（站在原点会陷在方块里）',
      cameraRef.position.x !== 0 && cameraRef.position.z !== 0);
    check('相机比方块高（完全平视时地板会退化成一条线）',
      cameraRef.position.y > 2, cameraRef.position.y);
    check('调过 lookAt', cameraRef.lookAtCalls.length === 1, cameraRef.lookAtCalls.length);
    check('看向方块腰部 y=1，而不是地板上的原点',
      cameraRef.lookAtCalls[0] && cameraRef.lookAtCalls[0][1] === 1,
      JSON.stringify(cameraRef.lookAtCalls[0]));
    check('构造时就调过一次 updateProjectionMatrix',
      cameraRef.projectionUpdates >= 1, cameraRef.projectionUpdates);
  }

  /* ===== G. 动画循环 ===== */

  console.log('\nG. 动画循环');

  {
    check('用 setAnimationLoop 注册了回调', typeof rendererRef.loop === 'function');

    const cube = sceneRef.children.find((c) => c.name === 'cube');
    const clock = log.clocks[0];
    check('建了一个 Clock', !!clock);

    const r0 = cube.rotation.y;
    clock.delta = 1 / 60;
    rendererRef.loop();
    const d1 = cube.rotation.y - r0;

    check('跑一帧就转了一点', d1 > 0, d1);

    clock.delta = 1 / 60;
    rendererRef.loop();
    check('再跑一帧继续累加', Math.abs(cube.rotation.y - r0 - 2 * d1) < 1e-12);

    // 这条盯的是「用 dt 而不是固定增量」：固定增量的话，120Hz 的屏幕上会转得
    // 比 60Hz 快一倍，换个显示器演示观感就变了。
    const before = cube.rotation.y;
    clock.delta = 1 / 30;          // 慢速帧，dt 是上一帧的两倍
    rendererRef.loop();
    const dBig = cube.rotation.y - before;
    check('★ 转动量与 dt 成正比，与帧率无关（1/30 帧转过的角度是 1/60 的两倍）',
      Math.abs(dBig - 2 * d1) < 1e-12, dBig + ' vs ' + 2 * d1);

    check('每帧都调了 renderer.render', rendererRef.renderCalls.length === 3,
      rendererRef.renderCalls.length);
    check('render 的实参是 (scene, camera)',
      rendererRef.renderCalls[0][0] === sceneRef && rendererRef.renderCalls[0][1] === cameraRef);
  }

  /* ===== H. 尺寸自适应 ===== */

  console.log('\nH. 尺寸自适应');

  {
    check('挂了 resize 监听', envRef.win.count('resize') === 1, envRef.win.count('resize'));

    const projBefore = cameraRef.projectionUpdates;
    const sizeBefore = rendererRef.sizes.length;

    envRef.host.clientWidth = 1000;
    envRef.host.clientHeight = 400;
    envRef.win.fire('resize');

    check('resize 后 aspect 跟着变',
      Math.abs(cameraRef.aspect - 1000 / 400) < 1e-12, cameraRef.aspect);
    check('resize 后重算了投影矩阵（只改 aspect 不重算，画面照样是拉伸的）',
      cameraRef.projectionUpdates > projBefore);
    check('resize 后 setSize 用了新尺寸',
      rendererRef.sizes.length > sizeBefore
      && rendererRef.sizes[rendererRef.sizes.length - 1][0] === 1000,
      JSON.stringify(rendererRef.sizes[rendererRef.sizes.length - 1]));

    // 容器被隐藏（display:none）时是 0×0，0/0 会得到 NaN，相机矩阵整个变成 NaN ——
    // 表现是「画面全黑但控制台一条错都没有」，极难查。
    envRef.host.clientWidth = 0;
    envRef.host.clientHeight = 0;
    envRef.win.fire('resize');
    check('★ 容器 0×0 时 aspect 不会变成 NaN',
      Number.isFinite(cameraRef.aspect), cameraRef.aspect);
    check('容器 0×0 时 setSize 拿到的也是有限数',
      rendererRef.sizes.every((s) => Number.isFinite(s[0]) && Number.isFinite(s[1])));
  }

  /* ===== I. dispose ===== */

  console.log('\nI. dispose');

  {
    const cube = sceneRef.children.find((c) => c.name === 'cube');
    const floor = sceneRef.children.find((c) => c.name === 'floor');

    sceneHandle.dispose();

    check('停掉了动画循环', rendererRef.loop === null, String(rendererRef.loop));
    check('摘掉了 resize 监听', envRef.win.count('resize') === 0, envRef.win.count('resize'));
    check('renderer 被 dispose', rendererRef.disposed === 1, rendererRef.disposed);
    check('几何体都 dispose 了（three 不会因为从 scene 移除就回收显存）',
      cube.geometry.disposed === 1 && floor.geometry.disposed === 1,
      cube.geometry.disposed + '/' + floor.geometry.disposed);
    check('材质都 dispose 了',
      cube.material.disposed === 1 && floor.material.disposed === 1,
      cube.material.disposed + '/' + floor.material.disposed);
    check('canvas 从容器摘掉了', envRef.host.children.length === 0,
      envRef.host.children.length);

    const sizeBefore = rendererRef.sizes.length;
    envRef.win.fire('resize');
    check('dispose 之后再 resize 不会再有动作', rendererRef.sizes.length === sizeBefore);
    check('dispose 之后调 loop() 不会炸（它已经是 null 了）',
      rendererRef.loop === null);
  }

  /* ===== J. index.html ===== */

  console.log('\nJ. index.html');

  {
    const html = fs.readFileSync(HTML_FILE, 'utf8');

    const map = html.match(/<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/);
    check('有 importmap', !!map);

    let parsed = null;
    try { parsed = JSON.parse(map[1]); } catch (e) { /* 下面报 */ }
    check('importmap 是合法 JSON（所以里面写不了注释）', parsed !== null);
    check('映射了 three', parsed && parsed.imports && !!parsed.imports.three,
      parsed && JSON.stringify(parsed.imports));

    const url = (parsed && parsed.imports.three) || '';
    check('three 固定 0.160.0（版本要和 lib/ 里那份一致）', url.includes('0.160.0'), url);
    check('指向 build/three.module.js（ESM 那份，不是 three.core.js）',
      url.includes('three.module.js'), url);

    check('importmap 出现在 module script 之前（顺序反了浏览器不认）',
      html.indexOf('importmap') < html.indexOf('type="module"'));
    check('用 type="module" 引了 scene.js',
      /import\s*\{[^}]*createDorm3D[^}]*\}\s*from\s*['"]\.\/scene\.js['"]/.test(html));
    check('HTML 里没有自己写 three 的代码（只负责建容器和调用）',
      !/new\s+THREE\./.test(html));
    check('容器元素的 id 和调用时传的一致',
      /id="scene"/.test(html) && /createDorm3D\(\s*['"]scene['"]\s*\)/.test(html));
  }

  /* ===== K. 随包的文件 ===== */

  console.log('\nK. 随包的文件');

  {
    check('本地 three.module.js 在 3d/lib/ 里（断网时的退路）', fs.existsSync(LIB_FILE));
    // 大小按「归一化成 LF 之后」算。这份文件在库里存的是 LF，但 core.autocrlf=true
    // 的机器上 clone 出来会被换成 CRLF（1272972 -> 1326016 字节）。不归一化的话
    // 这条断言只在自己机器上绿 —— 仓库带着一个「clone 下来就红」的测试，比不测还糟。
    // （latin1 解码是一个字节对一个字符，所以 length 就是字节数。）
    const bytes = fs.readFileSync(LIB_FILE).toString('latin1')
      .replace(/\r\n/g, '\n').length;
    check('归一化后 1272972 字节（0.160.0 的未压缩 build/three.module.js，'
      + '不是 670681 的 .min）', bytes === 1272972, bytes);

    const libSrc = fs.readFileSync(LIB_FILE, 'utf8');
    check('本地那份是自包含的（没有裸 import，否则 importmap 得多映射几条）',
      !/^\s*import\s[\s\S]*?from\s+['"][^.'"]/m.test(libSrc));
    check("版本号是 160（REVISION = '160'）", /REVISION\s*=\s*'160'/.test(libSrc));
  }

  /* ---------- 收尾 ---------- */

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 不通过');
  process.exit(fail === 0 ? 0 : 1);
})();
