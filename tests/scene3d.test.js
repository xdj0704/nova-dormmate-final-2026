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
 * 假模块有三处必须和真 three 保持一致，否则测试会在这些地方假绿：
 *
 *   - `traverse` 必须**递归**。真 three 是递归的。6-2 之前这里只走一层，
 *     而扇叶嵌在 fan 里、床垫嵌在 bed 里 —— 只走一层的话，dispose 那几条
 *     根本走不到那两层，「漏了没回收」检不出来，是假的通过。
 *   - 材质的 color 要转成 Color 对象，不是原样存数字。真 three 就是转的，
 *     而 updateScene 要调 material.color.set(...)，存数字的话假模块上会炸、
 *     真浏览器里好好的。
 *   - Object3D 的 castShadow / receiveShadow / children 必须预先存在。
 *     scene.js 里「不投阴影」的墙和地板是**没写过**这两个属性的，
 *     假模块要是只给显式赋过值的对象加，就会拿到 undefined。
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
  renderers: [], scenes: [], cameras: [], lights: [], meshes: [], groups: [], clocks: [],
};

export const FrontSide = 0;
export const DoubleSide = 2;

class Vec3 {
  constructor(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
class Vec2 {
  constructor(x, y) { this.x = x || 0; this.y = y || 0; }
  set(x, y) { this.x = x; this.y = y; return this; }
}

/* 真 three 的 Color 是可变的（color.set(0xff0000) 直接改自己），
   材质构造时会把传进来的 hex 转成 Color 存进 material.color。
   这里必须照做：updateScene 就是用 material.color.set() 改颜色的。 */
export class Color {
  constructor(hex) { this.hex = hex === undefined ? 0xffffff : hex; }
  set(hex) { this.hex = hex; return this; }
  getHex() { return this.hex; }
}

/* 所有可见对象的基类。children / add / traverse 照真 three 来 ——
   特别是 traverse 的递归（见文件头那段）。

   castShadow / receiveShadow 一开始就是 false：真 three 里它们是构造时就有的
   属性，不是「赋值了才有」。scene.js 里那两面墙正是**不写**这两个属性的。 */
class Object3D {
  constructor() {
    this.children = [];
    this.position = new Vec3();
    this.rotation = new Vec3();
    this.name = '';
    this.castShadow = false;
    this.receiveShadow = false;
  }
  add() {
    for (const o of arguments) this.children.push(o);
    return this;
  }
  traverse(fn) {
    fn(this);
    for (const c of this.children) {
      if (c && typeof c.traverse === 'function') c.traverse(fn);
      else fn(c);
    }
  }
  /* 下面两个是测试专用的便利方法，真 three 里没有。 */
  findByName(n) {
    let hit = null;
    this.traverse(function (o) { if (!hit && o.name === n) hit = o; });
    return hit;
  }
  flatten() {
    const out = [];
    this.traverse(function (o) { out.push(o); });
    return out;
  }
}

export class Group extends Object3D {
  constructor() { super(); log.groups.push(this); }
}

export class Scene extends Object3D {
  constructor() { super(); this.background = null; log.scenes.push(this); }
}

export class PerspectiveCamera extends Object3D {
  constructor(fov, aspect, near, far) {
    super();
    this.fov = fov; this.aspect = aspect; this.near = near; this.far = far;
    this.lookAtCalls = [];
    this.projectionUpdates = 0;
    log.cameras.push(this);
  }
  lookAt(x, y, z) { this.lookAtCalls.push([x, y, z]); return this; }
  updateProjectionMatrix() { this.projectionUpdates++; return this; }
}

class Light extends Object3D {
  constructor(color, intensity, kind) {
    super();
    this.color = new Color(color);
    this.intensity = intensity;
    this.kind = kind;
    log.lights.push(this);
  }
}

export class AmbientLight extends Light {
  constructor(color, intensity) { super(color, intensity, 'ambient'); }
}

export class DirectionalLight extends Light {
  constructor(color, intensity) {
    super(color, intensity, 'directional');
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
export class CylinderGeometry extends Geometry {
  constructor(rt, rb, h, seg) {
    super('Cylinder', { radiusTop: rt, radiusBottom: rb, height: h, radialSegments: seg });
  }
}

export class MeshStandardMaterial {
  constructor(opts) {
    const o = opts || {};
    Object.assign(this, o);
    this.color = new Color(o.color);
    this.disposed = 0;
  }
  dispose() { this.disposed++; }
}

export class Mesh extends Object3D {
  constructor(geometry, material) {
    super();
    this.geometry = geometry;
    this.material = material;
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

/* 假元素。scene.js 的 setLabel 只用到 className / textContent / parentNode。 */
function makeEl(tag) {
  const listeners = {};
  const classes = new Set();
  return {
    tagName: tag,
    className: '',
    textContent: '',
    children: [],
    style: {},
    parentNode: null,
    classList: {
      add(n) { classes.add(n); },
      remove(n) { classes.delete(n); },
      contains(n) { return classes.has(n); },
      toggle(n, on) { if (on) classes.add(n); else classes.delete(n); },
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, ev) { (listeners[type] || []).slice().forEach((fn) => fn(ev || {})); },
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

  const doc = {
    getElementById: (id) => (id === 'scene' ? host : null),
    createElement: (tag) => makeEl(tag),
  };

  globalThis.document = doc;
  globalThis.window = win;
  return { host, win, doc };
}

/** 从 0xRRGGBB 拆出三通道，用来判断「偏红」「偏蓝」。 */
function rgb(color) {
  const hex = typeof color === 'number' ? color : color.hex;
  return { r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 };
}

/* ---------- 跑 ---------- */

/* D 段建出来的句柄，后面几段都要用。声明必须在 IIFE 之前 ——
   写在文件末尾的话，IIFE 是先执行的那一半，会撞上 let 的暂时性死区。 */
let sceneHandle = null;
let sceneRef = null;
let cameraRef = null;
let rendererRef = null;
let envRef = null;
let clockRef = null;
let ambRef = null;
let dirRef = null;
let floorRef = null;
let groundRef = null;
let bedRef = null;
let pivotRef = null;
let paneRef = null;
let fanRef = null;
let fanMountRef = null;

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
  const stub = await import(pathToFileURL(stubPath).href);
  const log = stub.log;

  check('导出了 createDorm3D', typeof mod.createDorm3D === 'function');
  check('导出了四种状态的字符串常量', mod.STATUS
    && mod.STATUS.NORMAL === '正常' && mod.STATUS.COLD === '偏冷'
    && mod.STATUS.HOT === '偏热' && mod.STATUS.WET === '偏湿',
    JSON.stringify(mod.STATUS));

  // 状态字符串必须和统一规则一字不差：差一个字 updateScene 就认不出来，
  // 只能退回「正常」，而页面上看起来是「没反应」，很难联想到是拼写问题。
  const STATUSES = [mod.STATUS.NORMAL, mod.STATUS.COLD, mod.STATUS.HOT, mod.STATUS.WET];
  check('四个状态正好是 正常/偏冷/偏热/偏湿',
    STATUSES.join(',') === '正常,偏冷,偏热,偏湿', STATUSES.join(','));
  check('导出了风扇转速 FAN_SPIN（正数）',
    typeof mod.FAN_SPIN === 'number' && mod.FAN_SPIN > 0, mod.FAN_SPIN);
  check('导出了开窗角度 WINDOW_OPEN_ANGLE（负数，朝屋里开）',
    typeof mod.WINDOW_OPEN_ANGLE === 'number' && mod.WINDOW_OPEN_ANGLE < 0,
    mod.WINDOW_OPEN_ANGLE);

  const reset = () => {
    log.renderers.length = 0;
    log.scenes.length = 0;
    log.cameras.length = 0;
    log.lights.length = 0;
    log.meshes.length = 0;
    log.groups.length = 0;
    log.clocks.length = 0;
  };

  /* ===== B. 容器与覆盖层 ===== */

  console.log('\nB. 容器与覆盖层');

  {
    const env = installGlobals({ w: 800, h: 600 });
    const handle = mod.createDorm3D('scene');

    check('传 id 字符串能找到容器', log.renderers.length === 1);
    check('返回句柄带 scene / camera / renderer',
      !!handle.scene && !!handle.camera && !!handle.renderer);
    check('canvas 被挂进了容器',
      env.host.children.indexOf(handle.renderer.domElement) >= 0);
    check('canvas 设了 display:block（否则行内元素底部会留 4px 缝）',
      handle.renderer.domElement.style.display === 'block',
      handle.renderer.domElement.style.display);

    const label = env.host.children.find((c) => c.className === 'scene-label');
    check('覆盖层是 scene.js 建出来、挂进容器的', !!label);
    check('覆盖层和 canvas 是兄弟节点（所以能绝对定位盖在它上面）',
      env.host.children.length === 2 && !!label);

    const flat = installGlobals({ w: 10, h: 10 });
    const byEl = mod.createDorm3D(flat.host);
    check('也可以直接传元素本身', !!byEl.renderer);

    let threw = null;
    try { mod.createDorm3D('不存在的 id'); } catch (e) { threw = e; }
    check('找不到容器时抛错', threw instanceof Error);
    check('错误信息里写了是哪个容器', threw && threw.message.includes('不存在的 id'),
      threw && threw.message);

    void env;
    reset();
  }

  /* ===== C. renderer ===== */

  console.log('\nC. renderer');

  {
    installGlobals({ w: 800, h: 600, dpr: 3 });
    const h = mod.createDorm3D('scene');
    const r = h.renderer;

    check('开了抗锯齿', r.options.antialias === true, String(r.options.antialias));
    check('devicePixelRatio=3 时封顶到 2（否则要画 9 倍像素）',
      r.pixelRatio === 2, r.pixelRatio);
    check('阴影总开关打开了', r.shadowMap.enabled === true);
    check('setSize 用了容器的尺寸',
      r.sizes.length >= 1 && r.sizes[0][0] === 800 && r.sizes[0][1] === 600,
      JSON.stringify(r.sizes[0]));

    installGlobals({ w: 400, h: 300, dpr: 1 });
    const h1 = mod.createDorm3D('scene');
    check('devicePixelRatio=1 时就是 1', h1.renderer.pixelRatio === 1, h1.renderer.pixelRatio);
    check('尺寸跟着容器走', h1.renderer.sizes[0][0] === 400, JSON.stringify(h1.renderer.sizes[0]));

    reset();
  }

  /* ===== D. 宿舍的各个部分 ===== */

  console.log('\nD. 宿舍的各个部分');

  {
    envRef = installGlobals({ w: 800, h: 600 });
    const h = mod.createDorm3D('scene');
    sceneHandle = h;
    sceneRef = h.scene;
    cameraRef = h.camera;
    rendererRef = h.renderer;
    clockRef = log.clocks[0];
    floorRef = h.floor;
    groundRef = h.ground;
    bedRef = h.bed;
    pivotRef = h.windowPivot;
    paneRef = h.windowPane;
    fanRef = h.fan;
    fanMountRef = h.fanMount;

    const find = (n) => sceneRef.findByName(n);

    /* ---- 地板 ---- */

    const floor = find('floor');
    check('场景里有一块「屋里的地板」，句柄上也能拿到', !!floor && floor === floorRef);
    check('地板用的是 PlaneGeometry', floor && floor.geometry.kind === 'Plane',
      floor && floor.geometry.kind);
    check('地板的宽和高相等（正方形）',
      floor && floor.geometry.parameters.width === floor.geometry.parameters.height);
    check('地板绕 X 轴转了 -90°（不转的话它是立着的，会被看成一条线）',
      floor && Math.abs(floor.rotation.x + Math.PI / 2) < 1e-9,
      floor && floor.rotation.x);
    check('地板接阴影', floor && floor.receiveShadow === true);
    check('地板不投阴影（地面自己投自己只会出一身麻点）',
      floor && floor.castShadow === false);

    // 房间地板是 10×10，范围必须和房间一样大：再大一点，偏热时整个视野
    // （包括屋外）会一起变红，就不像「这间宿舍偏热」了。
    check('地板只铺满屋子（10×10），不是铺到天边',
      floor && floor.geometry.parameters.width === 10,
      floor && floor.geometry.parameters.width);

    /* ---- 室外大地面 ---- */

    const ground = find('ground');
    check('另有一块室外大地面', !!ground && ground === groundRef);
    // 只有屋里那块地板的话，房间会像浮在虚空里。
    check('大地面远大于房间（要一直铺到看不见的地方）',
      ground && ground.geometry.parameters.width >= 100,
      ground && ground.geometry.parameters.width);
    check('★ 大地面比房间地板低一点（两块共面的地面会互相闪烁 z-fighting）',
      ground && floor && ground.position.y < floor.position.y,
      ground && ground.position.y + ' vs ' + floor.position.y);
    check('大地面也绕 X 轴转了 -90°',
      ground && Math.abs(ground.rotation.x + Math.PI / 2) < 1e-9, ground && ground.rotation.x);

    /* ---- 墙 ---- */

    const wallBack = find('wall-back');
    const wallLeft = find('wall-left');
    check('有两面墙', !!wallBack && !!wallLeft);
    check('墙是半透明的（全挡住就看不见屋里了）',
      wallBack && wallBack.material.transparent === true
      && wallBack.material.opacity > 0 && wallBack.material.opacity < 1,
      wallBack && wallBack.material.opacity);
    check('★ 墙用 DoubleSide（相机绕到屋后时，从背面看才不会凭空消失）',
      wallBack && wallBack.material.side === stub.DoubleSide,
      wallBack && wallBack.material.side);
    check('两面墙共用一份材质（同一面墙的两半不该有细微色差）',
      wallBack && wallLeft && wallBack.material === wallLeft.material);
    check('后墙立在 -Z 那侧，不转（平面的正面本来就朝 +Z，也就是朝屋里）',
      wallBack && wallBack.position.z < 0 && Math.abs(wallBack.rotation.y) < 1e-9,
      wallBack && wallBack.position.z + ' / ' + wallBack.rotation.y);
    check('★ 左墙绕 Y 转了 +90°（不转的话它和后墙重合成一块）',
      wallLeft && Math.abs(wallLeft.rotation.y - Math.PI / 2) < 1e-9,
      wallLeft && wallLeft.rotation.y);
    check('两面墙都不投阴影（半透明的墙投出一块实心影子自相矛盾）',
      wallBack && wallBack.castShadow === false && wallLeft && wallLeft.castShadow === false);
    check('墙的高度就是墙高 4（矮了挡不住，高了像个盒子）',
      wallBack && wallBack.geometry.parameters.height === 4,
      wallBack && wallBack.geometry.parameters.height);

    /* ---- 床 ---- */

    check('床是一个 Group（零件各自摆好，整体再挪到墙角）',
      bedRef && bedRef.children.length === 2 && !!bedRef.name,
      bedRef && bedRef.children.length);
    const bedParts = bedRef ? bedRef.flatten().filter((o) => o.geometry) : [];
    check('床由 2 个长方体组成（床架 + 床垫）', bedParts.length === 2, bedParts.length);
    check('床的零件都是 BoxGeometry',
      bedParts.length === 2 && bedParts.every((p) => p.geometry.kind === 'Box'),
      bedParts.map((p) => p.geometry.kind).join(','));

    const frame = bedParts[0];
    const mattress = bedParts[1];
    check('床架抬到半个高度，正好坐在地板上（几何体原点在中心，不抬会有一半埋在地下）',
      frame && Math.abs(frame.position.y - frame.geometry.parameters.height / 2) < 1e-9,
      frame && frame.position.y);
    check('★ 床垫正好摞在床架上（差一点就会悬空或者陷进去）',
      frame && mattress
      && Math.abs(mattress.position.y
        - (frame.position.y + frame.geometry.parameters.height / 2
           + mattress.geometry.parameters.height / 2)) < 1e-9,
      mattress && mattress.position.y);
    check('床垫比床架小一圈（一样大的话会严丝合缝，看不出是两层）',
      mattress && mattress.geometry.parameters.width < frame.geometry.parameters.width
      && mattress.geometry.parameters.depth < frame.geometry.parameters.depth);
    check('床架投阴影', frame && frame.castShadow === true);
    check('床摆在屋里（不在原点、也没穿墙）',
      bedRef && bedRef.position.x < 0 && bedRef.position.z < 0
      && Math.abs(bedRef.position.x) < 5 && Math.abs(bedRef.position.z) < 5,
      bedRef && bedRef.position.x + ',' + bedRef.position.z);

    /* ---- 窗户 ---- */

    check('窗户挂在一个「铰链」Group 上（绕一条边转，才像开窗）', !!pivotRef && !!paneRef);
    check('窗扇是长方体', paneRef && paneRef.geometry.kind === 'Box',
      paneRef && paneRef.geometry.kind);
    check('窗扇很薄（薄长方体）',
      paneRef && paneRef.geometry.parameters.depth < 0.3,
      paneRef && paneRef.geometry.parameters.depth);
    check('★ 窗扇挂在铰链的一侧（position.x = 半个宽）：转 Group 时它绕边缘开合，'
      + '而不是绕自己中心原地打转',
      paneRef && Math.abs(paneRef.position.x - paneRef.geometry.parameters.width / 2) < 1e-9,
      paneRef && paneRef.position.x);
    check('铰链贴在后墙上、窗洞高度处',
      pivotRef && Math.abs(pivotRef.position.z + 5) < 0.2 && pivotRef.position.y > 1,
      pivotRef && pivotRef.position.z + ',' + pivotRef.position.y);
    check('铰链比墙面往屋里让了一点（共面会闪）',
      pivotRef && pivotRef.position.z > -5 && pivotRef.position.z < -4,
      pivotRef && pivotRef.position.z);
    check('初始是关着的（rotation.y 为 0）',
      pivotRef && pivotRef.rotation.y === 0, pivotRef && pivotRef.rotation.y);
    check('窗扇投阴影', paneRef && paneRef.castShadow === true);

    /* ---- 风扇 ---- */

    check('风扇是一个 Group', !!fanRef && !!fanRef.name);
    check('★ 风扇 Group 里正好 4 个零件：1 个中心 + 3 片扇叶',
      fanRef && fanRef.children.length === 4, fanRef && fanRef.children.length);

    const hub = fanRef && fanRef.children.find((c) => c.geometry
      && c.geometry.kind === 'Cylinder');
    const blades = fanRef ? fanRef.children.filter((c) => c.geometry
      && c.geometry.kind === 'Box') : [];
    check('中心是个圆柱', !!hub);
    check('扇叶正好 3 片', blades.length === 3, blades.length);
    check('★ 中心绕 X 转了 90°（圆柱默认轴是 Y，不扳过来的话中心是个立着的圆筒，'
      + '从正面看是一根竖条）',
      hub && Math.abs(hub.rotation.x - Math.PI / 2) < 1e-9,
      hub && hub.rotation.x);

    // 三片叶子必须绕中心均分 360°。写死一个角度复制三份的话，
    // 三片叶子会叠在一起，看起来只有一片。
    const angles = blades.map((b) => b.rotation.z).sort((a, b) => a - b);
    const step = (2 * Math.PI) / 3;
    check('★ 3 片扇叶互成 120°（角度不对会叠在一起）',
      angles.length === 3
      && Math.abs(angles[0]) < 1e-9
      && Math.abs(angles[1] - step) < 1e-9
      && Math.abs(angles[2] - 2 * step) < 1e-9,
      angles.map((a) => ((a * 180) / Math.PI).toFixed(0) + '°').join(','));
    check('★ 每片扇叶自己也转到了对应角度（不转的话三片朝向一样，'
      + '看起来像三根平行棍子而不是风车）',
      blades.length === 3 && blades.every((b, i) => Math.abs(b.rotation.z - angles[i]) < 1e-9));
    check('扇叶均匀撒在同一个半径上（半径不一会偏心，转起来晃）',
      blades.length === 3
      && Math.abs(Math.hypot(blades[0].position.x, blades[0].position.y)
        - Math.hypot(blades[1].position.x, blades[1].position.y)) < 1e-9,
      blades[0] && Math.hypot(blades[0].position.x, blades[0].position.y));
    check('扇叶都投阴影', blades.length === 3 && blades.every((b) => b.castShadow === true));

    check('风扇挂在一个「底座」Group 上（底座管摆放，风扇只管自己转）',
      !!fanMountRef && fanMountRef.children.indexOf(fanRef) >= 0);
    // 这是分两层的原因：合成一层的话扇叶转起来连支架一起转，
    // 看着像整台风扇在墙上打滚。
    const bracket = fanMountRef
      && fanMountRef.children.find((c) => c !== fanRef && c.geometry);
    check('★ 支架挂在底座上，不在会转的那个 Group 里（否则支架跟着扇叶一起转）',
      !!bracket && fanRef.children.indexOf(bracket) === -1);
    check('底座绕 Y 转了 90°，让风扇朝屋里吹',
      fanMountRef && Math.abs(fanMountRef.rotation.y - Math.PI / 2) < 1e-9,
      fanMountRef && fanMountRef.rotation.y);
    check('风扇靠左墙、在窗户那一侧（不在后会挡住床）',
      fanMountRef && fanMountRef.position.x < -4 && fanMountRef.position.z > 0,
      fanMountRef && fanMountRef.position.x + ',' + fanMountRef.position.z);
    check('风扇挂得比床高（挂地上就不是风扇了）',
      fanMountRef && fanMountRef.position.y > 2, fanMountRef && fanMountRef.position.y);

    check('场景设了背景色（不设是纯黑，墙和地板的暗部会和背景糊在一起）',
      sceneRef.background !== null && sceneRef.background !== undefined);

    check('床、窗户、风扇都在场景的名册里（只是建出来不 add 是不会被画的）',
      sceneRef.children.indexOf(bedRef) >= 0
      && sceneRef.children.indexOf(pivotRef) >= 0
      && sceneRef.children.indexOf(fanMountRef) >= 0);

    // 床 2 + 窗户 1 + 风扇 5（1 中心 + 3 扇叶 + 1 支架）+ 地板 1 + 大地面 1 + 墙 2 = 12
    check('场景里的网格数量正好是搭出来的这些（没有漏 add、也没有多建）',
      log.meshes.length === 12, log.meshes.length + ' 个');
  }

  /* ===== E. 灯光 ===== */

  console.log('\nE. 灯光');

  {
    const amb = log.lights.filter((l) => l.kind === 'ambient');
    const dir = log.lights.filter((l) => l.kind === 'directional');
    ambRef = amb[0];
    dirRef = dir[0];

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
    // 房间 10×10、墙高 4，±12 的方盒必须罩得住整个房间，
    // 否则房间边角上的东西不会投下阴影（影子凭空断掉）。
    check('阴影范围罩得住整个房间（房间是 ±5）',
      cam.left <= -5 && cam.right >= 5 && cam.top >= 5 && cam.bottom <= -5,
      [cam.left, cam.right, cam.top, cam.bottom].join(','));

    // 这条是 6-1 真正踩到的坑：three 的 LightShadow.updateMatrices() 只读现成的
    // projectionMatrix，不会替你调 updateProjectionMatrix()。漏掉这行的话，
    // 上面那些 left/right/top/bottom 全部被静默忽略，范围还是 ±5，不报任何错。
    check('★ 改完阴影相机范围后调了 updateProjectionMatrix（漏了这行会静默失效）',
      cam.projectionUpdates >= 1, cam.projectionUpdates + ' 次');

    check('平行光不在原点（位置决定方向）',
      dir[0].position.x !== 0 || dir[0].position.y !== 0 || dir[0].position.z !== 0);

    // 另一个 6-1 踩过的坑：灯和相机在同一侧时，影子落在物体正后方、
    // 被物体自己挡住，屏幕上一片干净，很容易误判成「阴影没配好」。
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

    // 灯是挂在 scene 上的。光不是「照亮屏幕」，是照亮这个世界的一部分，
    // 不在名册里就不参与计算 —— 建了却没 add 是极容易犯的错。
    check('两盏灯都挂进了场景',
      sceneRef.children.indexOf(amb[0]) >= 0 && sceneRef.children.indexOf(dir[0]) >= 0);
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

    // 罩不住就会在远处切出一道弧形的洞 —— 看起来像「地面缺了一块」，
    // 很难联想到是相机参数。算的是「相机到最远那个角」的真实距离。
    const half = groundRef.geometry.parameters.width / 2;
    const farCorner = Math.hypot(cameraRef.position.x + half, cameraRef.position.z + half);
    check('far 罩得住大地面的远角（罩不住会在远处把地面切出一道弧形的洞）',
      cameraRef.far > farCorner, 'far=' + cameraRef.far + ' 远角≈' + farCorner.toFixed(0));

    // near 也不能太小：深度缓冲的精度取决于 far/near 的比值。
    check('near 没有小到离谱（far/near 的比值决定深度精度，比值太大会 z-fighting）',
      cameraRef.far / cameraRef.near < 5000, cameraRef.far / cameraRef.near);

    check('相机不在原点（站在原点会陷在屋里，只能看见一堵墙的背面）',
      cameraRef.position.x !== 0 && cameraRef.position.z !== 0);
    check('相机站在开着的那一角（+X/+Z），不然只能看见两面墙的外墙皮',
      cameraRef.position.x > 5 && cameraRef.position.z > 5,
      cameraRef.position.x + ',' + cameraRef.position.z);
    check('相机比墙高（墙高 4，站太低就看不进屋里）',
      cameraRef.position.y > 4, cameraRef.position.y);
    check('调过 lookAt', cameraRef.lookAtCalls.length === 1, cameraRef.lookAtCalls.length);
    check('看向房间中心偏上，不是地板上的原点（盯地板会把地面占满画面）',
      cameraRef.lookAtCalls[0]
      && Math.abs(cameraRef.lookAtCalls[0][0]) < 0.5
      && cameraRef.lookAtCalls[0][1] > 1
      && Math.abs(cameraRef.lookAtCalls[0][2]) < 1,
      JSON.stringify(cameraRef.lookAtCalls[0]));
    check('构造时就调过一次 updateProjectionMatrix',
      cameraRef.projectionUpdates >= 1, cameraRef.projectionUpdates);
  }

  /* ===== G. 动画循环与风扇 ===== */

  console.log('\nG. 动画循环与风扇');

  {
    check('用 setAnimationLoop 注册了回调', typeof rendererRef.loop === 'function');
    check('建了一个 Clock', !!clockRef);

    // 一开始必须是停的：建好之后 updateScene('正常') 已经跑过一次了。
    const r0 = fanRef.rotation.z;
    clockRef.delta = 1 / 60;
    rendererRef.loop();
    check('默认（正常）状态下风扇不转', fanRef.rotation.z === r0, fanRef.rotation.z);

    sceneHandle.setFanOn(true);
    const r1 = fanRef.rotation.z;
    clockRef.delta = 1 / 60;
    rendererRef.loop();
    const d1 = fanRef.rotation.z - r1;
    check('开关打开后跑一帧就转起来', d1 > 0, d1);
    check('一帧转过的角度 = dt × FAN_SPIN',
      Math.abs(d1 - (1 / 60) * mod.FAN_SPIN) < 1e-12, d1);

    // 这条盯的是「用 dt 而不是固定增量」：固定增量的话，120Hz 的屏幕上会转得
    // 比 60Hz 快一倍，换个显示器演示观感就变了。
    const before = fanRef.rotation.z;
    clockRef.delta = 1 / 30;          // 慢速帧，dt 是上一帧的两倍
    rendererRef.loop();
    const dBig = fanRef.rotation.z - before;
    check('★ 转动量与 dt 成正比，与帧率无关（1/30 帧转过的角度是 1/60 的两倍）',
      Math.abs(dBig - 2 * d1) < 1e-12, dBig + ' vs ' + 2 * d1);

    const held = fanRef.rotation.z;
    sceneHandle.setFanOn(false);
    clockRef.delta = 1 / 60;
    rendererRef.loop();
    check('★ 关掉之后角度停在原地，不归零（归零的话风扇会「啪」地跳回起点）',
      fanRef.rotation.z === held, fanRef.rotation.z + ' vs ' + held);

    check('每帧都调了 renderer.render', rendererRef.renderCalls.length === 4,
      rendererRef.renderCalls.length);
    check('render 的实参是 (scene, camera)',
      rendererRef.renderCalls[0][0] === sceneRef && rendererRef.renderCalls[0][1] === cameraRef);
    check('每一帧都传了同一对 (scene, camera)',
      rendererRef.renderCalls.every((a) => a[0] === sceneRef && a[1] === cameraRef));
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

  /* ===== I. updateScene：状态 → 场景 ===== */

  console.log('\nI. updateScene：状态 → 场景');

  {
    const floorMat = floorRef.material;
    const paneMat = paneRef.material;
    const baseFloor = rgb(floorMat.color);
    const baseWindow = rgb(paneMat.color);

    const frame = (dt) => { clockRef.delta = dt; rendererRef.loop(); };

    /* ---- 正常 ---- */

    sceneHandle.updateScene(mod.STATUS.NORMAL);
    check('正常：地板回到底色',
      rgb(floorMat.color).r === baseFloor.r && rgb(floorMat.color).g === baseFloor.g
      && rgb(floorMat.color).b === baseFloor.b, JSON.stringify(rgb(floorMat.color)));
    check('正常：窗户关着', pivotRef.rotation.y === 0, pivotRef.rotation.y);
    check('正常：灯是白的（三通道相等）',
      rgb(dirRef.color).r === rgb(dirRef.color).b,
      JSON.stringify(rgb(dirRef.color)));

    const rz = fanRef.rotation.z;
    frame(1 / 60);
    check('正常：风扇不转', fanRef.rotation.z === rz, fanRef.rotation.z);

    /* ---- 偏热 ---- */

    check('偏热：返回「偏热」', sceneHandle.updateScene(mod.STATUS.HOT) === '偏热');
    const hot = rgb(floorMat.color);
    check('偏热：地板偏红（红通道明显高于绿蓝）',
      hot.r > hot.g + 40 && hot.r > hot.b + 40, JSON.stringify(hot));
    check('偏热：地板颜色确实变了（不是恰好和底色一样）',
      hot.r !== baseFloor.r, hot.r + ' vs ' + baseFloor.r);

    const rBefore = fanRef.rotation.z;
    frame(1 / 60);
    check('偏热：风扇转起来了', fanRef.rotation.z > rBefore, fanRef.rotation.z - rBefore);
    check('偏热：窗户仍然关着', pivotRef.rotation.y === 0, pivotRef.rotation.y);
    check('偏热：灯没被改成冷色（偏热只动地板和风扇）',
      rgb(dirRef.color).r === rgb(dirRef.color).b, JSON.stringify(rgb(dirRef.color)));

    /* ---- 偏湿 ---- */

    check('偏湿：返回「偏湿」', sceneHandle.updateScene(mod.STATUS.WET) === '偏湿');
    const wet = rgb(paneMat.color);
    check('偏湿：窗户变蓝（蓝通道明显高于红）',
      wet.b > wet.r + 40, JSON.stringify(wet));
    check('偏湿：窗户颜色确实变了', wet.r !== baseWindow.r, wet.r + ' vs ' + baseWindow.r);
    check('★ 偏湿：窗户真的打开了（rotation.y 到 WINDOW_OPEN_ANGLE，不是只换个颜色）',
      Math.abs(pivotRef.rotation.y - mod.WINDOW_OPEN_ANGLE) < 1e-9,
      pivotRef.rotation.y);
    check('★ 开窗角度够大，一眼看得出来（小角度看起来像没动）',
      Math.abs(mod.WINDOW_OPEN_ANGLE) > 1, mod.WINDOW_OPEN_ANGLE);
    check('偏湿：地板回到底色（不是偏热那块红地板残留）',
      rgb(floorMat.color).r === baseFloor.r, JSON.stringify(rgb(floorMat.color)));

    const fanHeld = fanRef.rotation.z;
    frame(1 / 60);
    check('偏湿：风扇是停的', fanRef.rotation.z === fanHeld, fanRef.rotation.z);

    /* ---- 偏冷 ---- */

    check('偏冷：返回「偏冷」', sceneHandle.updateScene(mod.STATUS.COLD) === '偏冷');
    const sun = rgb(dirRef.color);
    const amb = rgb(ambRef.color);
    check('偏冷：平行光偏蓝（蓝通道高于红）', sun.b > sun.r + 20, JSON.stringify(sun));
    check('★ 偏冷：环境光也一起偏蓝（只改一盏的话，另一盏会把冷色调中和掉）',
      amb.b > amb.r + 20, JSON.stringify(amb));
    check('偏冷：地板没被改成红色', rgb(floorMat.color).r === baseFloor.r);
    check('偏冷：窗户关着、颜色回到默认',
      pivotRef.rotation.y === 0 && rgb(paneMat.color).r === baseWindow.r,
      pivotRef.rotation.y + ' / ' + JSON.stringify(rgb(paneMat.color)));
    const fanCold = fanRef.rotation.z;
    frame(1 / 60);
    check('偏冷：风扇是停的', fanRef.rotation.z === fanCold, fanRef.rotation.z);

    /* ---- 回到正常，确认没有残留 ---- */

    // 每切一次状态都只写「该变的」，所以「切回来」必须每一项都还原 ——
    // 有残留的话，来回点几下按钮，场景会越来越花。
    sceneHandle.updateScene(mod.STATUS.NORMAL);
    check('★ 切回正常后每一项都还原（不然状态会粘住，越点越花）',
      rgb(floorMat.color).r === baseFloor.r
      && rgb(paneMat.color).r === baseWindow.r
      && pivotRef.rotation.y === 0
      && rgb(dirRef.color).r === rgb(dirRef.color).b
      && rgb(ambRef.color).r === rgb(ambRef.color).b,
      JSON.stringify(rgb(floorMat.color)) + ' / ' + JSON.stringify(rgb(dirRef.color))
        + ' / ' + JSON.stringify(rgb(ambRef.color)));

    /* ---- 不认识的 status ---- */

    const warned = [];
    const origWarn = console.warn;
    console.warn = function () { warned.push(Array.prototype.join.call(arguments, ' ')); };
    let applied = null;
    let crash = null;
    try { applied = sceneHandle.updateScene('冷不冷'); } catch (e) { crash = e; }
    console.warn = origWarn;

    check('★ 不认识的 status 不抛异常（入参迟早来自 MQTT 报文，显示层不该整页崩掉）',
      crash === null, crash && crash.message);
    check('★ 不认识时返回的是实际生效的「正常」', applied === '正常', applied);
    check('★ 不认识时在控制台警告，并把原值打出来（不能悄悄吞掉）',
      warned.length === 1 && warned[0].indexOf('冷不冷') >= 0, warned.join(' | '));
    check('不认识时按「正常」显示', rgb(floorMat.color).r === baseFloor.r);
  }

  /* ===== J. setFanOn ===== */

  console.log('\nJ. setFanOn');

  {
    check('setFanOn(true) 返回 true', sceneHandle.setFanOn(true) === true);
    check('setFanOn(false) 返回 false', sceneHandle.setFanOn(false) === false);
    check('空字符串归一化成 false（返回的是布尔，不是原值）',
      sceneHandle.setFanOn('') === false);
    check('0 归一化成 false', sceneHandle.setFanOn(0) === false);
    check('非空字符串是真值（所以别传 \'false\' 这种字符串）',
      sceneHandle.setFanOn('on') === true);

    // 它只改标志位，不动角度：直接归零的话风扇会跳回起点。
    const held = fanRef.rotation.z;
    sceneHandle.setFanOn(true);
    check('只改标志位，不立刻改角度（角度由动画循环推进）',
      fanRef.rotation.z === held, fanRef.rotation.z);

    sceneHandle.setFanOn(false);
  }

  /* ===== K. setLabel ===== */

  console.log('\nK. setLabel');

  {
    const label = envRef.host.children.find((c) => c.className === 'scene-label');
    check('覆盖层挂在容器里', !!label);

    const text = '当前宿舍：dorm-a｜状态：偏热';
    const back = sceneHandle.setLabel(text);
    check('setLabel 把文字写进覆盖层', label.textContent === text, label.textContent);
    check('setLabel 返回实际写上去的文字（方便调用方确认）', back === text, back);

    sceneHandle.setLabel(0);
    check('数字也会被转成字符串（不会被当成「没传」而清空）',
      label.textContent === '0', label.textContent);

    sceneHandle.setLabel(null);
    check('传 null 是清空', label.textContent === '', JSON.stringify(label.textContent));
    sceneHandle.setLabel(undefined);
    check('传 undefined 也是清空', label.textContent === '');

    sceneHandle.setLabel('当前宿舍：dorm-a｜状态：正常');
    check('再设一次还能写上去（清空之后没坏掉）',
      label.textContent.indexOf('正常') >= 0, label.textContent);
  }

  /* ===== L. dispose ===== */

  console.log('\nL. dispose');

  {
    // 特意挑两个**嵌在 Group 里**的零件：床垫在 bed 里、扇叶在 fan 里。
    // 假模块的 traverse 要是只走一层，这两个根本走不到，下面两条会假绿 ——
    // 这正是这次把 traverse 改成递归的原因。
    const mattress = bedRef.children.filter((c) => c.geometry)[1];   // [0] 是床架
    const blades = fanRef.children.filter((c) => c.geometry && c.geometry.kind === 'Box');
    const wall = sceneRef.findByName('wall-back');
    const hub = sceneRef.findByName('fan-hub');

    check('测试挑中的确实是床垫和扇叶', !!mattress && blades.length === 3
      && mattress.geometry.parameters.width < bedRef.children[0].geometry.parameters.width);

    sceneHandle.dispose();

    check('停掉了动画循环', rendererRef.loop === null, String(rendererRef.loop));
    check('摘掉了 resize 监听', envRef.win.count('resize') === 0, envRef.win.count('resize'));
    check('renderer 被 dispose', rendererRef.disposed === 1, rendererRef.disposed);
    check('几何体都 dispose 了（three 不会因为从 scene 移除就回收显存）',
      floorRef.geometry.disposed === 1 && groundRef.geometry.disposed === 1,
      floorRef.geometry.disposed + '/' + groundRef.geometry.disposed);
    check('★ 嵌在 Group 里的床垫也被回收了（traverse 要递归才走得到）',
      mattress.geometry.disposed === 1 && mattress.material.disposed === 1,
      mattress.geometry.disposed + '/' + mattress.material.disposed);
    check('★ 扇叶的几何体也被回收了（也嵌在 Group 里）',
      blades.every((b) => b.geometry.disposed === 1),
      blades.map((b) => b.geometry.disposed).join(','));
    check('★ 圆柱体（风扇中心）也被回收了',
      hub && hub.geometry.disposed === 1, hub && hub.geometry.disposed);
    // 3 片扇叶共用一份材质，traverse 会把它 dispose 3 次。真 three 的 dispose
    // 是幂等的，重复调没有副作用 —— 这里只要求「至少被回收过一次」。
    check('扇叶共用的那份材质也被回收了',
      blades[0].material.disposed >= 1, blades[0].material.disposed);
    check('两面墙共用的那份材质也被回收了', wall && wall.material.disposed >= 1,
      wall && wall.material.disposed);
    check('canvas 从容器摘掉了',
      envRef.host.children.indexOf(rendererRef.domElement) === -1);
    check('★ 覆盖层也摘掉了（它是 scene.js 自己加的，不摘就留在页面上）',
      envRef.host.children.every((c) => c.className !== 'scene-label'),
      envRef.host.children.length);
    check('容器最后是空的', envRef.host.children.length === 0, envRef.host.children.length);

    const sizeBefore = rendererRef.sizes.length;
    envRef.win.fire('resize');
    check('dispose 之后再 resize 不会再有动作', rendererRef.sizes.length === sizeBefore);
  }

  /* ===== M. index.html ===== */

  console.log('\nM. index.html');

  {
    const html = fs.readFileSync(HTML_FILE, 'utf8');
    // 查源码前先剥注释，否则会匹配到注释里写的示例 ——
    // 这次真踩到了：#scene 的注释里就写着「position: relative」，
    // 不剥的话下面那条「是不是真写了」永远为真。
    const bare = html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    const map = html.match(/<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/);
    check('有 importmap', !!map);

    let parsed = null;
    try { parsed = JSON.parse(map[1]); } catch (e) { /* 下面报 */ }
    check('importmap 是合法 JSON（所以里面一行注释都写不了）', parsed !== null);
    check('映射了 three', parsed && parsed.imports && !!parsed.imports.three,
      parsed && JSON.stringify(parsed.imports));

    const url = (parsed && parsed.imports.three) || '';
    check('three 固定 0.160.0（版本要和 lib/ 里那份一致）', url.includes('0.160.0'), url);
    check('指向 build/three.module.js（ESM 那份，不是 three.core.js）',
      url.includes('three.module.js'), url);

    // 比的是**标签**的位置，不是 'importmap' 这个词 —— 注释里也出现过这个词，
    // 拿 indexOf 找词的话，两条注释谁前谁后就决定了断言真假。
    const mapAt = html.indexOf('<script type="importmap">');
    const modAt = html.indexOf('<script type="module">');
    check('importmap 标签出现在 module script 标签之前（顺序反了浏览器不认）',
      mapAt >= 0 && modAt > mapAt, mapAt + ' / ' + modAt);

    check('用 type="module" 引了 scene.js',
      /import\s*\{[^}]*createDorm3D[^}]*\}\s*from\s*['"]\.\/scene\.js['"]/.test(html));
    check('HTML 里没有自己写 three 的代码（只负责建容器和调用）',
      !/new\s+THREE\./.test(bare));
    check('容器元素的 id 和调用时传的一致',
      /id="scene"/.test(html) && /createDorm3D\(\s*['"]scene['"]\s*\)/.test(html));

    /* ---- 四个测试按钮 ---- */

    const statuses = [...html.matchAll(/data-status=["']([^"']+)["']/g)].map((m) => m[1]);
    check('有 4 个测试按钮', statuses.length === 4, statuses.length + ' 个');
    check('★ 四个按钮正好是统一规则那四个状态（差一个字 updateScene 就认不出来）',
      statuses.join(',') === '正常,偏冷,偏热,偏湿', statuses.join(','));
    check('按钮上的文字就是状态本身（看的人不用猜）',
      ['正常', '偏冷', '偏热', '偏湿'].every(
        (s) => html.indexOf('>' + s + '</button>') >= 0));

    check('按钮点击调了 updateScene',
      /addEventListener\(\s*['"]click['"]/.test(bare) && /\.updateScene\(/.test(bare));
    check('★ 把 data-status 原样交给了 apply（页面这边不二次加工状态值，'
      + '认不出来的值要让 scene.js 去警告）',
      /apply\(\s*btn\.dataset\.status\s*\)/.test(bare));
    check('点了按钮会更新覆盖层文字',
      /\.setLabel\(/.test(bare) && /状态：/.test(bare));
    check('页面打开就先摆成「正常」（否则初始状态和按钮高亮对不上）',
      /apply\(\s*['"]正常['"]\s*\)/.test(bare));
    check('当前状态的那个按钮被标出来（加了 is-active）',
      /is-active/.test(bare) && /classList\.toggle\(\s*['"]is-active['"]/.test(bare));

    /* ---- 覆盖层的定位与穿透 ---- */

    check('★ .scene-label 有 pointer-events: none（否则这层会吃掉鼠标事件，'
      + '将来想给 3D 加拖拽就点不穿）',
      /\.scene-label\s*\{[^}]*pointer-events:\s*none/.test(bare));
    check('★ .scene-label 是绝对定位的（absolute）',
      /\.scene-label\s*\{[^}]*position:\s*absolute/.test(bare));
    check('★ #scene 是 position: relative（覆盖层靠它定位，'
      + '少了它覆盖层会飘到 <body> 上去，跑到页面左上角）',
      /#scene\s*\{[^}]*position:\s*relative/.test(bare));
    check('#scene 设了 overflow: hidden（setSize 和容器差一像素就会顶出滚动条）',
      /#scene\s*\{[^}]*overflow:\s*hidden/.test(bare));
    check('#scene 有确定的高度（高度是 0 的话 clientHeight 就是 0，算不出宽高比）',
      /#scene\s*\{[^}]*height:/.test(bare));
  }

  /* ===== N. 随包的文件 ===== */

  console.log('\nN. 随包的文件');

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
