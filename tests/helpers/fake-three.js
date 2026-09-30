'use strict';

/**
 * tests/helpers/fake-three.js —— 给 three/ 下那几个模块用的假 three，一份，共用。
 *
 * 谁在用：
 *   tests/world3d.test.js        three/world.js（连同它 import 的 room.js）
 *   tests/scene3d-page.test.js   three/index.html 里那段 <script type="module">
 *
 * 【为什么不各写一份】world.js 和页面加载的是**同一批模块**（world.js +
 * room.js + lib/CSS2DRenderer.js），要假的东西一模一样。各写一份的代价是
 * 「world.js 那边补了一条，页面这边忘了补」，而两边跑的是同一份源码 ——
 * 假模块和真模块对不上时，测试会绿，浏览器里会炸。
 *
 * 【这套假模块的三条铁律】和真 three 不一致就会假绿：
 *   - traverse 必须**递归**（真 three 是递归的）。扇叶嵌在 fan 里、床垫嵌在
 *     bed 里、整间房又嵌在 scene 里 —— 只走一层的话 dispose 那几条走不到。
 *   - `userData` 必须是**一开始就有**的空对象。真 three 的 Object3D 构造时
 *     就给了 {}。world.js 直接往它上面写 nodeId，假模块要是「赋值了才有」，
 *     真实浏览器里好好的，这里会炸。
 *   - `scale` 同理，构造时就是个 (1,1,1) 的向量。脉冲光圈改的就是它。
 *
 * Raycaster 是**可编程**的：`intersectObjects` 返回测试事先摆好的命中列表。
 * 这样测的是「拿命中结果去反查是哪间房」这一段，而不是 three 的射线求交数学
 * —— 后者是 three 自己的事，不是这个项目的。
 *
 * 【CSS2D 那一层为什么也是假的】真的 CSS2DRenderer 要用 Matrix4 / Vector3 做
 * 投影矩阵乘法，才能把 3D 坐标算成屏幕像素。假模块给不出正确的矩阵 ——
 * 编一个出来，测的就是我自己编的那套矩阵。所以世界那边只测「标签的内容与归属」
 * （都用不着真矩阵），vendor 进来的真文件在 world3d.test.js 末尾按**结构**验
 * （存在、字节数、sha256、只 import three、两个导出名都在）。
 *
 * 这个文件是 **CommonJS**：tests/ 下没有 package.json，.js 默认就是 CJS，
 * 和那些 *.test.js 一致。它只导出字符串和几个假的 DOM 小工具，
 * 真正被 import 的是 writeFakeThree() 写出去的那几个 .mjs。
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/* ---------- 假 three 模块 ---------- */

const STUB_SOURCE = `
export const log = {
  renderers: [], scenes: [], cameras: [], lights: [], meshes: [], groups: [],
  clocks: [], basicMaterials: [], raycasters: [],
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

export class Color {
  constructor(hex) { this.hex = hex === undefined ? 0xffffff : hex; }
  set(hex) { this.hex = hex; return this; }
  getHex() { return this.hex; }
}

/* children / position / rotation / scale / userData / castShadow / receiveShadow
   全都是**构造时就有**的，照真 three 来（见文件头那段：userData 和 scale
   要是「赋值了才有」，world.js 在真浏览器里好好的，这里会炸）。 */
export class Object3D {
  constructor() {
    this.children = [];
    this.position = new Vec3();
    this.rotation = new Vec3();
    this.scale = new Vec3(1, 1, 1);
    this.name = '';
    this.visible = true;
    this.userData = {};
    this.castShadow = false;
    this.receiveShadow = false;
    this.parent = null;
  }
  add() {
    for (const o of arguments) { this.children.push(o); o.parent = this; }
    return this;
  }
  remove(o) {
    const i = this.children.indexOf(o);
    if (i >= 0) { this.children.splice(i, 1); o.parent = null; }
    return this;
  }
  traverse(fn) {
    fn(this);
    for (const c of this.children) {
      if (c && typeof c.traverse === 'function') c.traverse(fn);
      else fn(c);
    }
  }
  /* 测试专用的便利方法，真 three 里没有。 */
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
export class RingGeometry extends Geometry {
  constructor(inner, outer, seg) {
    super('Ring', { innerRadius: inner, outerRadius: outer, thetaSegments: seg });
  }
}

export class MeshStandardMaterial {
  constructor(opts) {
    Object.assign(this, opts || {});
    this.color = new Color((opts || {}).color);
    this.disposed = 0;
  }
  dispose() { this.disposed++; }
}

export class MeshBasicMaterial {
  constructor(opts) {
    Object.assign(this, opts || {});
    this.color = new Color((opts || {}).color);
    this.disposed = 0;
    log.basicMaterials.push(this);
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

/* Clock：真 three 的 getDelta() 会顺手把 elapsedTime 往前推，所以要照做 ——
   world.js 的脉冲光圈读的正是 elapsedTime（不是自己累加，见那边的注释）。 */
export class Clock {
  constructor() { this.delta = 1 / 60; this.elapsedTime = 0; log.clocks.push(this); }
  getDelta() { this.elapsedTime += this.delta; return this.delta; }
}

/* 画布。world.js 要往它上面挂 click 监听、还要 getBoundingClientRect
   把鼠标位置换算成归一化设备坐标 —— 真 three 的 domElement 就是一块
   <canvas>，这两样都有。 */
function fakeCanvas() {
  const listeners = {};
  return {
    style: {}, parentNode: null, width: 0, height: 0,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = listeners[type] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    fire(type, ev) { (listeners[type] || []).slice().forEach(function (fn) { fn(ev || {}); }); },
    count(type) { return (listeners[type] || []).length; },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: this.width, height: this.height };
    },
  };
}

export class WebGLRenderer {
  constructor(opts) {
    this.options = opts || {};
    this.domElement = fakeCanvas();
    this.shadowMap = { enabled: false, type: null };
    this.pixelRatio = null;
    this.sizes = [];
    this.loop = null;
    this.renderCalls = [];
    this.disposed = 0;
    log.renderers.push(this);
  }
  setPixelRatio(r) { this.pixelRatio = r; return this; }
  setSize(w, h) {
    this.sizes.push([w, h]);
    this.domElement.width = w; this.domElement.height = h;
    return this;
  }
  setAnimationLoop(fn) { this.loop = fn; return this; }
  render(scene, camera) { this.renderCalls.push([scene, camera]); return this; }
  dispose() { this.disposed++; }
}

/* Raycaster：hit 列表由测试摆（见文件头）。setFromCamera 只记下来，
   不去算射线 —— 那是 three 的事。 */
export class Raycaster {
  constructor() { this.hits = []; this.calls = []; log.raycasters.push(this); }
  setFromCamera(pointer, camera) {
    this.pointer = { x: pointer.x, y: pointer.y };
    this.camera = camera;
    return this;
  }
  intersectObjects(objects, recursive) {
    this.calls.push([objects, recursive]);
    return this.hits;
  }
}

export class Vector2 {
  constructor(x, y) { this.x = x || 0; this.y = y || 0; }
  set(x, y) { this.x = x; this.y = y; return this; }
}
`;

/* ---------- 假 CSS2D 层（摆在真路径 lib/CSS2DRenderer.js 上） ---------- */

/* 只有两件事必须在：CSS2DObject 得是一种 Object3D（否则 add 进房间 Group 之后
   scene.traverse 走不到它），CSS2DRenderer 得把标签元素收进自己那层 DOM。
   其余（投影、transform、zIndex）都是真文件里的事，见文件末尾 T 段。 */
const CSS2D_STUB_SOURCE = (stubUrl) => `
import { Object3D } from '${stubUrl}';

export const log = { labelRenderers: [], labelTraversals: [] };

function fakeLayer() {
  return {
    style: {}, parentNode: null, children: [],
    appendChild(el) { this.children.push(el); el.parentNode = this; return el; },
    removeChild(el) {
      const i = this.children.indexOf(el);
      if (i >= 0) this.children.splice(i, 1);
      el.parentNode = null;
      return el;
    },
  };
}

export class CSS2DObject extends Object3D {
  constructor(element) {
    super();
    this.element = element;
    this.isCSS2DObject = true;
  }
}

export class CSS2DRenderer {
  constructor(params) {
    const o = params || {};
    this.domElement = o.element || fakeLayer();
    this.sizes = [];
    this.renders = [];
    log.labelRenderers.push(this);
  }
  getSize() {
    return { width: this.domElement.style.width, height: this.domElement.style.height };
  }
  setSize(w, h) {
    this.sizes.push([w, h]);
    this.domElement.style.width = w + 'px';
    this.domElement.style.height = h + 'px';
    return this;
  }
  render(scene, camera) {
    this.renders.push([scene, camera]);
    const found = [];
    scene.traverse(function (o) { if (o.isCSS2DObject) found.push(o); });
    log.labelTraversals.push(found.length);
    // 真那份是每帧把元素摆到算出来的像素位置上；「元素属于这一层」是它的前提，
    // 这里只做这一步 —— 归属是 world.js 之外唯一还有意义的部分。
    for (const o of found) {
      if (this.domElement.children.indexOf(o.element) < 0) this.domElement.appendChild(o.element);
    }
    return this;
  }
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

/* 假元素。world.js 用到的：className / textContent / setAttribute /
   classList.toggle / hidden / appendChild / parentNode。
   页面（three/index.html）多用到 dataset 和 addEventListener —— 图例那一排
   是页面自己 createElement 出来的，两个都要有，不然页面一跑就炸。 */
function makeEl(tag) {
  const classes = new Set();
  const attrs = {};
  const listeners = {};
  return {
    tagName: tag,
    className: '',
    textContent: '',
    hidden: false,
    dataset: {},
    children: [],
    style: {},
    parentNode: null,
    classList: {
      add(n) { classes.add(n); },
      remove(n) { classes.delete(n); },
      contains(n) { return classes.has(n); },
      toggle(n, on) { if (on) classes.add(n); else classes.delete(n); },
    },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = listeners[type] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    fire(type, ev) { (listeners[type] || []).slice().forEach(function (fn) { fn(ev || {}); }); },
    appendChild(el) { this.children.push(el); el.parentNode = this; return el; },
    removeChild(el) {
      const i = this.children.indexOf(el);
      if (i >= 0) this.children.splice(i, 1);
      el.parentNode = null;
      return el;
    },
  };
}

/**
 * 装一套假的 window / document / location。
 *
 * @param {{w?: number, h?: number, dpr?: number, id?: string,
 *          extra?: Object<string, Object>, hostname?: string}} [opts]
 *   id     哪一个是「3D 容器」（makeHost 造的那个，有 clientWidth/Height）
 *   extra  其余 id -> 假元素（页面上的 #conn / #readout / #legend 这些）
 *   hostname  location.hostname（页面拿它拼 broker 地址）
 */
function installGlobals(opts) {
  const o = opts || {};
  const host = makeHost(o.w === undefined ? 800 : o.w, o.h === undefined ? 600 : o.h);
  const listeners = {};
  const extra = o.extra || {};

  const win = {
    devicePixelRatio: o.dpr === undefined ? 1 : o.dpr,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = listeners[type] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    fire(type, ev) { (listeners[type] || []).slice().forEach(function (fn) { fn(ev || {}); }); },
    count(type) { return (listeners[type] || []).length; },
  };

  const doc = {
    getElementById: (id) => {
      if (id === (o.id || 'world')) return host;
      return Object.prototype.hasOwnProperty.call(extra, id) ? extra[id] : null;
    },
    createElement: (tag) => makeEl(tag),
  };

  globalThis.document = doc;
  globalThis.window = win;
  globalThis.location = { hostname: o.hostname || 'localhost' };
  return { host, win, doc, extra };
}

/** 从 0xRRGGBB 拆出三通道，用来判断「偏红」「偏蓝」。 */
function rgb(color) {
  const hex = typeof color === 'number' ? color : color.hex;
  return { r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 };
}

/** 把 console.warn 接管一会儿，返回收集到的那些话。 */
function captureWarn(fn) {
  const said = [];
  const orig = console.warn;
  console.warn = function () { said.push(Array.prototype.join.call(arguments, ' ')); };
  try { fn(); } finally { console.warn = orig; }
  return said;
}

/* ---------- 写进临时目录 ---------- */

/**
 * 把两个假模块摆进临时目录，摆成**和仓库一样的形状**：
 *
 *   tmp/package.json                {"type":"module"}（不然 .js 被当成 CJS）
 *   tmp/three-stub.mjs              假 three
 *   tmp/lib/CSS2DRenderer.js        假 CSS2D 层（**真路径**：
 *                                   world.js 里那条 './lib/CSS2DRenderer.js'
 *                                   一个字都不用改，走的就是线上那条）
 *
 * 调用方拿到 stubUrl 之后，把被测源码里 `from 'three'` 改写成它就够了。
 *
 * @param {string} tmp 已经建好的临时目录
 * @returns {{stubPath: string, stubUrl: string, css2dPath: string}}
 */
function writeFakeThree(tmp) {
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}', 'utf8');

  const stubPath = path.join(tmp, 'three-stub.mjs');
  fs.writeFileSync(stubPath, STUB_SOURCE, 'utf8');
  const stubUrl = pathToFileURL(stubPath).href;

  const css2dPath = path.join(tmp, 'lib', 'CSS2DRenderer.js');
  fs.mkdirSync(path.dirname(css2dPath), { recursive: true });
  fs.writeFileSync(css2dPath, CSS2D_STUB_SOURCE(stubUrl), 'utf8');

  return { stubPath, stubUrl, css2dPath };
}

module.exports = {
  STUB_SOURCE,
  CSS2D_STUB_SOURCE,
  writeFakeThree,
  makeHost,
  makeEl,
  installGlobals,
  rgb,
  captureWarn,
};
