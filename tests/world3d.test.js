'use strict';

/**
 * three/world.js 的测试（Step E1-3）。纯 Node，零依赖。
 *
 * 手法和 tests/scene3d.test.js 一样：把**真实的**源文件跑起来，只把它的
 * import 改写到本地假模块。这里多一个层次：
 *
 *   world.js  import 'three'                  -> 假 three
 *   world.js  import './room.js'              -> 真的 room.js（它的 three 也改写）
 *   world.js  import './lib/CSS2DRenderer.js' -> **假的** CSS2D 层（见下）
 *
 * 为什么 CSS2D 那一层要假掉，而不是让 vendor 进来的真文件跑：
 * 真的 CSS2DRenderer 要用 Matrix4 / Vector3 做投影矩阵乘法，才能把 3D 坐标
 * 算成屏幕像素。假模块给不出正确的矩阵 —— 编一个出来，测的就是我自己编的
 * 那套矩阵，不是它。所以分成两件事做：
 *
 *   本文件  测 world.js 自己写的那些：三间房、标签的**内容与归属**、
 *          拾取、脉冲、相机飞行、清理。这些都用不着真矩阵。
 *   另一段  把那份 vendor 进来的真文件按**结构**验一遍（存在、字节数、
 *          sha256、只 import three、两个导出名都在）—— 见文件末尾 T 段。
 *          它的出处和大小记在 README 那张第三方文件表里。
 *
 * 假 three 模块有三处必须和真的保持一致，否则测试会假绿：
 *   - traverse 必须**递归**（真 three 是递归的）。扇叶嵌在 fan 里、床垫嵌在
 *     bed 里、整间房又嵌在 scene 里 —— 只走一层的话 dispose 那几条走不到。
 *   - `userData` 必须是**一开始就有**的空对象。真 three 的 Object3D 构造时
 *     就给了 {}。world.js 直接往它上面写 nodeId，假模块要是「赋值了才有」，
 *     真实浏览器里好好的，这里会炸。
 *   - `scale` 同理，构造时就是个 (1,1,1) 的向量。脉冲光圈改的就是它。
 *
 * Raycaster 是**可编程**的：`intersectObjects` 返回测试事先摆好的命中列表。
 * 这样测的是「拿命中结果去反查是哪间房」这一段（往上找带 nodeId 的那个 Group），
 * 而不是 three 的射线求交数学 —— 后者是 three 自己的事，不是这个项目的。
 *
 * 另外：Node 里没有 package.json 时 .js 默认 CommonJS，所以临时目录里放一个
 * {"type":"module"}，源码里那些 import 一个字都不用改。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const WORLD_FILE = path.join(ROOT, 'three', 'world.js');
const ROOM_FILE = path.join(ROOT, 'three', 'room.js');
const CSS2D_FILE = path.join(ROOT, 'three', 'lib', 'CSS2DRenderer.js');

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

/* ---------- 假 three / 假 CSS2D / 假 DOM ---------- */

/* 都搬去了 tests/helpers/fake-three.js。three/ 下的模块和 three/index.html 那个
   页面要假的东西是**同一批**（world.js + room.js + lib/CSS2DRenderer.js），
   各写一份的话「world.js 这边补了一条、页面那边忘了补」是迟早的事 —— 而两边
   跑的是同一份源码，假模块一旦和真模块错开，测试会绿、浏览器里会炸。
   那个文件头上写着这套假模块的三条铁律（traverse 递归、userData 和 scale
   构造时就有）。 */
const {
  writeFakeThree, installGlobals, rgb, captureWarn,
} = require('./helpers/fake-three.js');

/* ---------- 跨段共用的句柄（必须在 IIFE 之前声明，否则撞暂时性死区） ---------- */

let handle = null;
let sceneRef = null;
let cameraRef = null;
let rendererRef = null;
let clockRef = null;
let raycasterRef = null;
let groundRef = null;
let envRef = null;
let mod = null;
let roomMod = null;
let stub = null;

(async function main() {
  console.log('== three/world.js ==\n');

  /* ===== A. 源文件约束 ===== */

  console.log('A. 源文件约束');

  const src = fs.readFileSync(WORLD_FILE, 'utf8');

  // 先把注释剥掉再查，否则会匹配到注释里写的示例
  //（dashboard 那边踩过：注释里写了状态名，断言就永远是绿的）。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const imports = [...code.matchAll(/^\s*import\s[\s\S]*?from\s+['"]([^'"]+)['"]/gm)]
    .map((m) => m[1]);
  check('import 三条：裸名字 three + 相对 ./room.js + 相对 ./lib/CSS2DRenderer.js',
    imports.length === 3
    && imports.filter((s) => s === 'three').length === 1
    && imports.indexOf('./room.js') >= 0
    && imports.indexOf('./lib/CSS2DRenderer.js') >= 0,
    imports.length + ' 条：' + imports.join(', '));

  const bareNames = imports.filter((s) => !s.startsWith('.') && !s.startsWith('/'));
  check('★ 裸名字只有 three 一个（importmap 只映射了它，多一个浏览器就报找不到）',
    bareNames.length === 1 && bareNames[0] === 'three', bareNames.join(', '));

  check('两条相对 import 都指的是真文件',
    fs.existsSync(ROOM_FILE) && fs.existsSync(CSS2D_FILE),
    [ROOM_FILE, CSS2D_FILE].map((p) => fs.existsSync(p)).join(','));

  check('用的是 export function（不是 IIFE、不是 globalThis 挂载）',
    /export\s+function\s+createDormWorld\s*\(/.test(code));
  check('导出 NODE_MAP（映射关系集中在这一处）', /export\s+const\s+NODE_MAP\s*=/.test(code));
  check('导出 NODE_IDS', /export\s+const\s+NODE_IDS\s*=/.test(code));
  check('没有 require(', !/\brequire\s*\(/.test(code));

  /* 红线：状态必须由温湿度算出来，显示层不许自己判。这里盯的是
     「world.js 有没有偷偷把四个状态名写进代码里」—— 注释里提到不算，
     所以上面先剥了注释。 */
  check('★ 源码里一个状态名都没有（偏冷 / 偏热 / 偏湿 / 正常）—— 状态一律从外面喂进来',
    !/偏冷|偏热|偏湿|正常/.test(code));
  check('★ 没有自己判状态（调 judgeStatus 或者拿温湿度做比较）',
    !/judgeStatus/.test(code) && !/humidity\s*[<>]=?/.test(code)
    && !/temperature\s*[<>]=?/.test(code));
  check('没有去 import 规则那套（shared/rules.js 是前端页面用的，world.js 不碰）',
    imports.every((s) => s.indexOf('rules') < 0), imports.join(', '));

  /* ===== 准备假模块 ===== */

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-world-'));

  // package.json / three-stub.mjs / lib/CSS2DRenderer.js 三个文件由它一次摆好，
  // 形状和仓库里**一模一样** —— 源码里那些相对 import 一个字都不用改。
  const { stubPath, stubUrl } = writeFakeThree(tmp);

  check('源码里的 three 被改写成了本地假模块',
    src.replace(/from\s+['"]three['"]/, 'X') !== src);

  fs.writeFileSync(path.join(tmp, 'world-under-test.mjs'),
    src.replace(/from\s+['"]three['"]/, "from '" + stubUrl + "'"), 'utf8');

  const roomSrc = fs.readFileSync(ROOM_FILE, 'utf8');
  const roomRewritten = roomSrc.replace(/from\s+['"]three['"]/, "from '" + stubUrl + "'");
  check('room.js 里的 three 也被改写成了同一个假模块（两边共用一份 log）',
    roomRewritten !== roomSrc);
  fs.writeFileSync(path.join(tmp, 'room.js'), roomRewritten, 'utf8');

  mod = await import(pathToFileURL(path.join(tmp, 'world-under-test.mjs')).href);
  roomMod = await import(pathToFileURL(path.join(tmp, 'room.js')).href);
  stub = await import(pathToFileURL(stubPath).href);
  const log = stub.log;
  const css2dLog = (await import(pathToFileURL(
    path.join(tmp, 'lib', 'CSS2DRenderer.js')).href)).log;

  const STATUS = roomMod.STATUS;
  const ROOM = roomMod.ROOM;

  check('导出了 createDormWorld', typeof mod.createDormWorld === 'function');
  check('四个状态照旧是 正常/偏冷/偏热/偏湿',
    [STATUS.NORMAL, STATUS.COLD, STATUS.HOT, STATUS.WET].join(',') === '正常,偏冷,偏热,偏湿',
    [STATUS.NORMAL, STATUS.COLD, STATUS.HOT, STATUS.WET].join(','));

  /* ===== B. NODE_MAP / NODE_IDS ===== */

  console.log('\nB. NODE_MAP：房间摆在哪儿');

  const MAP = mod.NODE_MAP;

  check('★ 三个节点都在表里（dorm-a / dorm-b / dorm-c）',
    MAP['dorm-a'] && MAP['dorm-b'] && MAP['dorm-c'],
    Object.keys(MAP).join(','));
  check('NODE_IDS 是表里的键，顺序就是并排的顺序',
    mod.NODE_IDS.join(',') === 'dorm-a,dorm-b,dorm-c', mod.NODE_IDS.join(','));

  const xs = mod.NODE_IDS.map((id) => MAP[id].x);
  check('★ 三间房沿 X 一字排开，x 各不相同',
    xs[0] !== xs[1] && xs[1] !== xs[2] && xs[0] !== xs[2], xs.join(','));
  check('顺序是从左到右（x 递增）', xs[0] < xs[1] && xs[1] < xs[2], xs.join(','));
  check('★ 间距比房间本身还宽（不然两间房会叠在一起，屋里穿墙）',
    Math.abs(xs[1] - xs[0]) > ROOM && Math.abs(xs[2] - xs[1]) > ROOM,
    Math.abs(xs[1] - xs[0]) + ' > ' + ROOM);
  check('★ 左右对称、dorm-b 在正中间（正着看过去三间透视一样，谁也不显得远）',
    Math.abs(xs[0] + xs[2]) < 1e-9 && Math.abs(xs[1]) < 1e-9, xs.join(','));
  check('三间房 z 相同（并排，不是前后错开）',
    MAP['dorm-a'].z === MAP['dorm-b'].z && MAP['dorm-b'].z === MAP['dorm-c'].z);

  /* ===== C. 搭起来的世界 ===== */

  console.log('\nC. 三间房与场景');

  {
    envRef = installGlobals({ w: 900, h: 500 });
    handle = mod.createDormWorld('world');
    sceneRef = handle.scene;
    cameraRef = handle.camera;
    rendererRef = handle.renderer;
    clockRef = log.clocks[0];
    raycasterRef = log.raycasters[0];
    groundRef = sceneRef.findByName('ground');

    check('传 id 字符串能找到容器', log.renderers.length === 1);
    check('canvas 被挂进了容器',
      envRef.host.children.indexOf(rendererRef.domElement) >= 0);
    check('标签层也被挂进了容器',
      envRef.host.children.indexOf(handle.labelRenderer.domElement) >= 0);

    mod.NODE_IDS.forEach(function (id) {
      const g = sceneRef.findByName(id + '-room');
      check('场景里有 ' + id + ' 那间房（挂在场景这棵树上）',
        !!g && sceneRef.children.indexOf(g) >= 0);
      check('★ ' + id + ' 那间房身上带着 nodeId（拾取时靠它反查是哪间）',
        g && g.userData.nodeId === id, g && g.userData.nodeId);
      check(id + ' 那间房摆在 NODE_MAP 说的位置',
        g && g.position.x === MAP[id].x && g.position.z === MAP[id].z,
        g && g.position.x + ',' + g.position.z);
    });

    // 三间房各 12 个网格（地板 1 + 环 1 + 墙 2 + 床 2 + 窗 1 + 风扇 5），
    // 加大地面 1 = 37。多了就是重复建，少了就是漏 add。
    check('★ 网格数正好 3×12 + 1 = 37（没漏 add，也没多建）',
      log.meshes.length === 37, log.meshes.length + ' 个');
    check('场景里挂着 15 个 Group（3 间房 × 5：房间 / 床 / 窗 / 底座 / 风扇）',
      log.groups.length === 15, log.groups.length + ' 个');

    // 前缀是这个模块能不能成立的前提：三间房都不带前缀的话，三块地板全叫
    // 'floor'，按名字找零件会随机撞上一个。
    check('★ 零件名带上了各自的前缀（dorm-a 的地板叫 dorm-a-floor）',
      !!sceneRef.findByName('dorm-a-floor') && !!sceneRef.findByName('dorm-c-floor'));
    check("★ 没有不带前缀的零件名混进来（'floor' 是单间房那边的叫法）",
      sceneRef.flatten().every((o) => o.name !== 'floor' && o.name !== 'focus-ring'),
      sceneRef.flatten().map((o) => o.name).filter(Boolean).slice(0, 8).join(','));

    check('三间房的地面各自独立（不是三间共用一块会一起变色的地板）',
      new Set(mod.NODE_IDS.map((id) => handle.rooms[id].room.floorMat)).size === 3);
    check('三间房的房间组也各自独立', new Set(
      mod.NODE_IDS.map((id) => handle.rooms[id].room.group)).size === 3);

    check('有一块室外大地面（只有屋里那块的话房间像浮在虚空里）', !!groundRef);
    check('大地面比三间房加起来还宽（要一直铺到看不见的地方）',
      groundRef.geometry.parameters.width > Math.abs(xs[2] - xs[0]) + ROOM,
      groundRef.geometry.parameters.width);
  }

  /* ===== D. 灯光：全场景共用，所以不跟状态走 ===== */

  console.log('\nD. 灯光');

  {
    const amb = log.lights.filter((l) => l.kind === 'ambient');
    const dir = log.lights.filter((l) => l.kind === 'directional');

    check('有一盏环境光、一盏平行光（三间房共用这两盏）',
      amb.length === 1 && dir.length === 1, amb.length + '/' + dir.length);
    check('两盏灯都挂进了场景（不在名册里就不参与计算）',
      sceneRef.children.indexOf(amb[0]) >= 0 && sceneRef.children.indexOf(dir[0]) >= 0);

    const cam = dir[0].shadow.camera;
    // 三间房并排一共 30 多米宽，±12（单间房那边的值）只罩得住中间那间 ——
    // 表现是边上的房间影子凭空消失，不报错。
    check('★ 阴影范围放大了（要罩住三间房，±12 只够中间那间）',
      cam.right >= Math.abs(xs[2]) + ROOM / 2 && cam.left <= xs[0] - ROOM / 2,
      [cam.left, cam.right].join(','));
    check('★ 改完范围调了 updateProjectionMatrix（漏了这行会静默失效）',
      cam.projectionUpdates >= 1, cam.projectionUpdates + ' 次');

    // 和单间房那边最大的不同：灯是全场景的，不能跟着某一间的状态变
    //（一盏灯没法同时是三种颜色）。所以状态只落在房间自己的零件上。
    const before = { sun: dir[0].color.hex, amb: amb[0].color.hex, bg: sceneRef.background.hex };
    handle.setReading('dorm-a', { temperature: 16, humidity: 60, status: STATUS.COLD });
    handle.setReading('dorm-b', { temperature: 31, humidity: 60, status: STATUS.HOT });
    check('★ 某间房偏冷时，灯和背景一步都不动（那是全局的，跟着变就没法三间各是各的）',
      dir[0].color.hex === before.sun && amb[0].color.hex === before.amb
      && sceneRef.background.hex === before.bg,
      dir[0].color.hex + '/' + before.sun);
    check('偏冷那间的地板确实变冷了（状态落在房间自己的零件上）',
      rgb(handle.rooms['dorm-a'].room.floorMat.color).b
      > rgb(handle.rooms['dorm-a'].room.floorMat.color).r + 20,
      JSON.stringify(rgb(handle.rooms['dorm-a'].room.floorMat.color)));
  }

  /* ===== E. setReading：一格数据 → 这间房 ===== */

  console.log('\nE. setReading');

  {
    const floors = {};
    const specs = [
      ['dorm-a', 31, 60, STATUS.HOT],
      ['dorm-b', 25, 80, STATUS.WET],
      ['dorm-c', 16, 60, STATUS.COLD],
    ];
    specs.forEach(function (s) {
      check('setReading 认得 ' + s[0], handle.setReading(s[0],
        { temperature: s[1], humidity: s[2], status: s[3], online: true }) === true);
      floors[s[0]] = handle.rooms[s[0]].room.floorMat.color.hex;
    });

    check('★ 三间房的地板颜色互不相同（三间各有各的状态，就得一眼分得出来）',
      new Set(Object.values(floors)).size === 3,
      mod.NODE_IDS.map((id) => '0x' + floors[id].toString(16)).join(' '));

    const hot = rgb(floors['dorm-a']);
    const cold = rgb(floors['dorm-c']);
    check('偏热那间偏红（红通道明显高）', hot.r > hot.g + 40 && hot.r > hot.b + 40,
      JSON.stringify(hot));
    check('偏冷那间偏蓝（蓝通道明显高）', cold.b > cold.r + 20, JSON.stringify(cold));

    check('★ 偏湿那间的窗户是开着的',
      Math.abs(handle.rooms['dorm-b'].room.windowPivot.rotation.y
        - roomMod.WINDOW_OPEN_ANGLE) < 1e-9,
      handle.rooms['dorm-b'].room.windowPivot.rotation.y);
    check('另外两间的窗户都关着',
      handle.rooms['dorm-a'].room.windowPivot.rotation.y === 0
      && handle.rooms['dorm-c'].room.windowPivot.rotation.y === 0);

    /* ---- 标签内容 ---- */

    check('标签上写的是这间房的温湿度',
      handle.rooms['dorm-b'].tagRead.textContent === '25℃ · 80%',
      handle.rooms['dorm-b'].tagRead.textContent);
    check('★ 标签上的状态就是快照给的那个字符串（原样，不重算）',
      handle.rooms['dorm-b'].tagStatus.textContent === STATUS.WET,
      handle.rooms['dorm-b'].tagStatus.textContent);
    check('★ 颜色靠 data-status 属性挑，文字另外有（颜色不是唯一信号）',
      handle.rooms['dorm-b'].el.getAttribute('data-status') === STATUS.WET,
      handle.rooms['dorm-b'].el.getAttribute('data-status'));

    /* ---- 不认识的 status ---- */

    const warned = captureWarn(function () {
      check('不认识的状态不抛异常，返回 true（数据照收）',
        handle.setReading('dorm-a', { temperature: 25, humidity: 60, status: '台风' }) === true);
    });
    check('★ 不认识的状态：文字照原样写「台风」（显示层没资格改别人的话）',
      handle.rooms['dorm-a'].tagStatus.textContent === '台风',
      handle.rooms['dorm-a'].tagStatus.textContent);
    check('★ 不认识的状态：在控制台警告并把原值打出来（不能悄悄吞掉）',
      warned.length === 1 && warned[0].indexOf('台风') >= 0, warned.join(' | '));
    check('不认识的状态：地板按「正常」显示',
      handle.rooms['dorm-a'].room.floorMat.color.hex
      === handle.rooms['dorm-c'].room.floorMat.color.hex
        ? false
        : handle.rooms['dorm-a'].room.floorMat.color.hex
          === roomMod.LOOK[STATUS.NORMAL].floor,
      '0x' + handle.rooms['dorm-a'].room.floorMat.color.hex.toString(16));

    /* ---- 还没有数据 ---- */

    handle.setReading('dorm-a', null);
    check('★ 没有数据就写「—」，不编数字', handle.rooms['dorm-a'].tagRead.textContent === '—',
      handle.rooms['dorm-a'].tagRead.textContent);
    check('★ 没有数据时状态写「还没有数据」（不是「正常」—— 没收到 ≠ 正常）',
      handle.rooms['dorm-a'].tagStatus.textContent === '还没有数据',
      handle.rooms['dorm-a'].tagStatus.textContent);
    check('缺一个字段就把那个写成「—」，另一个照写',
      (function () {
        handle.setReading('dorm-a', { temperature: 25, humidity: null, status: STATUS.NORMAL });
        return handle.rooms['dorm-a'].tagRead.textContent === '25℃ · —';
      })(), handle.rooms['dorm-a'].tagRead.textContent);

    /* ---- 表上没有的节点 ---- */

    let warned2 = captureWarn(function () {
      check('★ NODE_MAP 里没有的节点返回 false（布局表是有边界的，得说出来）',
        handle.setReading('dorm-z', { temperature: 25, humidity: 60, status: STATUS.NORMAL })
        === false);
    });
    check('★ 并且把节点名打出来（不能默默不画）',
      warned2.length === 1 && warned2[0].indexOf('dorm-z') >= 0, warned2.join(' | '));

    // 收拾回一个已知状态，后面的段好接着用
    handle.setReading('dorm-a', { temperature: 31, humidity: 60, status: STATUS.HOT, online: true });
    handle.setReading('dorm-b', { temperature: 25, humidity: 80, status: STATUS.WET, online: true });
    handle.setReading('dorm-c', { temperature: 16, humidity: 60, status: STATUS.COLD, online: true });
  }

  /* ===== F. 风扇：两个原因合成一个开关 ===== */

  console.log('\nF. 风扇（状态 或 处理中）');

  {
    const frame = (dt) => { clockRef.delta = dt === undefined ? 1 / 60 : dt; rendererRef.loop(); };
    const spun = (id, dt) => {
      const fan = handle.rooms[id].room.fan;
      const before = fan.rotation.z;
      frame(dt);
      return fan.rotation.z - before;
    };

    // dorm-a 现在是偏热（LOOK 里那一列 fan = true）
    check('★ 偏热那间：风扇转（状态说的「这屋热，该吹风」）', spun('dorm-a') > 0);
    check('偏湿那间：风扇不转', spun('dorm-b') === 0);

    /* HANDLING：事件正在处理中。要求和「偏热」分开举证 ——
       这就是「至少两类对象随状态动态变化」里的第二类。 */
    check('setHandling 认得这个节点', handle.setHandling('dorm-b', true) === true);
    check('★ 处理中那间：风扇转起来了（偏湿本身并不让风扇转）', spun('dorm-b') > 0);

    check('setHandling(id, false) 之后风扇停下', (function () {
      handle.setHandling('dorm-b', false);
      return spun('dorm-b') === 0;
    })());

    // 两个原因合成的是 **or**：偏热那间把处理中关掉，风扇还得转 ——
    // 写成覆盖式（后调用的说了算）的话，页面每帧重报两件事，风扇会随报文顺序抖。
    handle.setHandling('dorm-a', false);
    check('★ 偏热那间即使「处理中 = 否」也照样转（两个原因是 or，不是互相覆盖）',
      spun('dorm-a') > 0);

    handle.setHandling('dorm-c', true);
    check('★ 偏冷那间可以只因为「处理中」就转起来', spun('dorm-c') > 0);
    handle.setHandling('dorm-c', false);

    /* ---- 标签上那句「处理中」 ---- */

    check('平时「处理中」那格是藏着的',
      handle.rooms['dorm-c'].tagHandling.hidden === true);
    handle.setHandling('dorm-c', true);
    check('★ 处理中时露出来（风扇转的原因看不见，得有字说出来）',
      handle.rooms['dorm-c'].tagHandling.hidden === false);
    check('那格的字是「处理中」',
      handle.rooms['dorm-c'].tagHandling.textContent === '处理中',
      handle.rooms['dorm-c'].tagHandling.textContent);
    handle.setHandling('dorm-c', false);
    check('撤了处理中又藏回去（不是只加不减）',
      handle.rooms['dorm-c'].tagHandling.hidden === true);

    let warned = captureWarn(function () {
      check('NODE_MAP 里没有的节点，setHandling 返回 false',
        handle.setHandling('dorm-z', true) === false);
    });
    check('并且把节点名打出来', warned.length === 1 && warned[0].indexOf('dorm-z') >= 0,
      warned.join(' | '));

    /* ---- 转速与帧率无关 ---- */

    handle.setHandling('dorm-b', true);
    const d1 = spun('dorm-b', 1 / 60);
    const d2 = spun('dorm-b', 1 / 30);
    check('★ 两帧转过的角度成正比（用 dt 算，120Hz 屏上不会转快一倍）',
      Math.abs(d2 - 2 * d1) < 1e-12, d2 + ' vs ' + 2 * d1);
    handle.setHandling('dorm-b', false);
  }

  /* ===== G. 标签层（CSS2D） ===== */

  console.log('\nG. 标签层');

  {
    const layer = handle.labelRenderer.domElement;

    /* 这两条是**点击能不能工作**的前提，不是排版偏好：
       这层是绝对定位、盖在 canvas 上的 HTML。它要是收鼠标事件，
       底下 canvas 的 click 就永远收不到，Raycaster 一个事件都拿不到，
       表现为「点房间没反应」，而且控制台一条错都没有。 */
    check('★ 标签层不接鼠标事件（pointer-events: none）——'
      + '否则它盖在画布上，点击全被它吃掉，Raycaster 永远收不到',
      layer.style.pointerEvents === 'none', layer.style.pointerEvents);
    check('★ 标签层是绝对定位的（CSS2DRenderer 自己只设 overflow，这三条得补）',
      layer.style.position === 'absolute', layer.style.position);

    const labels = [];
    sceneRef.traverse(function (o) { if (o.isCSS2DObject) labels.push(o); });
    check('★ 三间房各有一个 CSS2D 标签（不是一层固定文字）', labels.length === 3, labels.length);

    mod.NODE_IDS.forEach(function (id) {
      const el = handle.rooms[id].el;
      check(id + ' 的标签挂在它自己那间房底下（跟着房间一起动）',
        handle.rooms[id].room.group.children.some((c) => c.isCSS2DObject && c.element === el));
      check(id + ' 的标签浮在屋顶上方（不挡屋里）',
        handle.rooms[id].room.group.children.filter((c) => c.isCSS2DObject)
          .every((c) => c.position.y > roomMod.WALL_H),
        handle.rooms[id].room.group.children.filter((c) => c.isCSS2DObject)
          .map((c) => c.position.y).join(','));
      check(id + ' 的标签元素类名是 scene-tag', el.className === 'scene-tag', el.className);
      check(id + ' 的标签有「名字 / 读数 / 状态 / 处理中」四格',
        el.children.map((c) => c.className).join(',')
        === 'tag-node,tag-read,tag-status,tag-handling',
        el.children.map((c) => c.className).join(','));
      check(id + ' 那张标签上写着节点名', el.children[0].textContent === id,
        el.children[0].textContent);
    });

    // 渲染一次之后标签元素该出现在那一层 DOM 里（真那份每帧都摆一次）
    rendererRef.loop();
    check('★ 渲染之后三个标签都在标签层里（不在的话页面上一个字都看不到）',
      mod.NODE_IDS.every((id) => layer.children.indexOf(handle.rooms[id].el) >= 0),
      layer.children.length);
    check('标签层里只有这三张标签', layer.children.length === 3, layer.children.length);
  }

  /* ===== H. Raycaster：点哪间房 ===== */

  console.log('\nH. 点房间');

  {
    /* 命中记录的写法：真 three 的 intersectObjects 返回的是**记录**数组
       （{ object, distance, point, ... }），不是裸的 Object3D。假 raycaster
       要照这个形状摆，否则测的就是一个真 three 不会给的东西 ——
       world.js 读的是 hits[0].object，摆成裸对象的话它拿到的是 undefined，
       这里会红，而线上其实是对的。 */
    const hit = (obj) => ({ object: obj, distance: 1 });

    // 还没注册回调时点一下不该炸（页面在拿到第一条快照之前就是这个状态）
    let crash = null;
    try {
      raycasterRef.hits = [hit(handle.rooms['dorm-b'].room.floor)];
      rendererRef.domElement.fire('click', { clientX: 1, clientY: 1 });
    } catch (e) { crash = e; }
    check('还没注册回调时点一下不会炸', crash === null, crash && crash.message);

    const picks = [];
    handle.onPick((id) => picks.push(id));

    // 假 raycaster 的命中列表由测试摆：下面挑的是**最里面**的那片扇叶，
    // 中间隔着 fan -> fanMount 两层 Group。反查得一路往上走才找得到 nodeId。
    const blade = handle.rooms['dorm-b'].room.fan.children
      .find((c) => c.geometry && c.geometry.kind === 'Box');
    check('测试挑中的是一片嵌在两层 Group 里的扇叶（它自己身上没有 nodeId）',
      !!blade && !blade.userData.nodeId, blade && blade.name);

    raycasterRef.hits = [hit(blade)];
    rendererRef.domElement.fire('click', { clientX: 450, clientY: 250 });
    check('★ 点中 dorm-b 里的一片扇叶 -> 回调收到的是 dorm-b（一路往上找带 nodeId 的那个）',
      picks.join(',') === 'dorm-b', picks.join(','));

    // 下面这几下只为看坐标换算，别再打中任何东西（不然 picks 会多出几条，
    // 后面「三间房都点得中」那一条对不上）
    raycasterRef.hits = [];

    // 屏幕坐标 -> 归一化设备坐标。画布是 900×500（见 C 段），点正中间该是 (0,0)。
    check('屏幕坐标换算成了归一化设备坐标（点在正中间 -> 0,0）',
      Math.abs(raycasterRef.pointer.x) < 1e-9 && Math.abs(raycasterRef.pointer.y) < 1e-9,
      raycasterRef.pointer.x + ',' + raycasterRef.pointer.y);
    check('左下角是 (-1,-1)（y 轴要翻过来：屏幕原点在左上，NDC 原点在正中）',
      (function () {
        rendererRef.domElement.fire('click', { clientX: 0, clientY: 500 });
        return Math.abs(raycasterRef.pointer.x + 1) < 1e-9
          && Math.abs(raycasterRef.pointer.y + 1) < 1e-9;
      })(), raycasterRef.pointer.x + ',' + raycasterRef.pointer.y);

    check('用相机摆的射线', raycasterRef.camera === cameraRef);
    check('★ 只在三间房那三个 Group 里找（大地面、灯、别的都不参与 —— '
      + '点在屋外空地上不该算「点了某一间」）',
      raycasterRef.calls[0][0].length === 3
      && raycasterRef.calls[0][0].indexOf(groundRef) < 0
      && mod.NODE_IDS.every((id) => raycasterRef.calls[0][0].indexOf(
        handle.rooms[id].room.group) >= 0),
      raycasterRef.calls[0][0].length);
    check('★ 递归进 Group 里面找（不递归的话命中的永远是房间外壳，'
      + '而射线打在墙/地上才是真正常见的情况）',
      raycasterRef.calls[0][1] === true, raycasterRef.calls[0][1]);

    // 点在空地/天上：什么也没打中
    raycasterRef.hits = [];
    const n = picks.length;
    rendererRef.domElement.fire('click', { clientX: 10, clientY: 10 });
    check('★ 什么也没打中时一声不响（不该瞎报一间）', picks.length === n, picks.length);

    // 点房间的地板是最常见的命中（射线多数时候落在墙/地上，不是嵌在里面的零件）
    raycasterRef.hits = [hit(handle.rooms['dorm-a'].room.floor)];
    rendererRef.domElement.fire('click', { clientX: 100, clientY: 300 });
    raycasterRef.hits = [hit(handle.rooms['dorm-c'].room.floor)];
    rendererRef.domElement.fire('click', { clientX: 800, clientY: 300 });
    check('三间房都点得中（B 点扇叶、A 和 C 点地板）',
      picks.join(',') === 'dorm-b,dorm-a,dorm-c', picks.join(','));

    // 多个命中时取最近的那个（真 three 是按距离排序的，第一个就是最近的）
    raycasterRef.hits = [hit(handle.rooms['dorm-c'].room.floor),
      hit(handle.rooms['dorm-a'].room.floor)];
    rendererRef.domElement.fire('click', { clientX: 500, clientY: 300 });
    check('★ 多个命中时取第一个（最近的那个），不是最后撞上的那个',
      picks[picks.length - 1] === 'dorm-c', picks[picks.length - 1]);
  }

  /* ===== I. setPriority：脉冲光圈 ===== */

  console.log('\nI. 脉冲光圈（当前重点）');

  {
    const frame = (dt) => { clockRef.delta = dt === undefined ? 1 / 60 : dt; rendererRef.loop(); };
    const ringOf = (id) => handle.rooms[id].room.ring;
    const matOf = (id) => handle.rooms[id].room.ringMat;

    check('一开始三间房的环都是藏着的（谁都不是重点）',
      mod.NODE_IDS.every((id) => ringOf(id).visible === false));

    check('setPriority 认这个节点', handle.setPriority('dorm-b') === 'dorm-b');
    check('★ 只有 dorm-b 那圈环露出来', ringOf('dorm-b').visible === true
      && ringOf('dorm-a').visible === false && ringOf('dorm-c').visible === false);

    // 脉冲：每帧由累计时间算出一个 0..1 的相位，改不透明度和缩放。
    const o0 = matOf('dorm-b').opacity;
    frame();
    const o1 = matOf('dorm-b').opacity;
    check('★ 跑一帧之后透明度变了（在呼吸，不是亮着一块死板的环）', o1 !== o0,
      o0 + ' -> ' + o1);

    const all = [];
    for (let i = 0; i < 600; i++) { frame(1 / 60); all.push(matOf('dorm-b').opacity); }
    check('★ 600 帧里透明度始终在 0.45 ~ 0.95 之间（不会越呼吸越亮直到全白）',
      all.every((v) => v >= 0.45 - 1e-9 && v <= 0.95 + 1e-9),
      Math.min.apply(null, all).toFixed(3) + ' ~ ' + Math.max.apply(null, all).toFixed(3));
    check('★ 透明度真的来回变（不是恒定在一个值上）',
      Math.max.apply(null, all) - Math.min.apply(null, all) > 0.3,
      (Math.max.apply(null, all) - Math.min.apply(null, all)).toFixed(3));
    check('★ 缩放也在跟着动（只改透明度在浅色地板上不够显眼）',
      (function () {
        const s = [];
        for (let i = 0; i < 120; i++) { frame(1 / 60); s.push(ringOf('dorm-b').scale.x); }
        return Math.min.apply(null, s) >= 0.999 && Math.max.apply(null, s) > 1.001;
      })(), ringOf('dorm-b').scale.x);

    /* 换人：旧的那间必须收**干净**。脉冲只在「还是重点」时才每帧写，
       停下的那间没人再管它的透明度 —— 不复位就会永远停在半亮上。 */
    handle.setPriority('dorm-a');
    check('★ 换人之后旧那间藏起来', ringOf('dorm-b').visible === false);
    check('★ 旧那间的透明度和缩放都复了位（不复位就会永远停在半亮 / 半大上）',
      matOf('dorm-b').opacity === 0.9 && ringOf('dorm-b').scale.x === 1,
      matOf('dorm-b').opacity + ' / ' + ringOf('dorm-b').scale.x);
    check('新那间亮起来', ringOf('dorm-a').visible === true);

    check('传不认识的节点 -> null，三间全收起来',
      handle.setPriority('dorm-z') === null
      && mod.NODE_IDS.every((id) => ringOf(id).visible === false));
    check('传 null 也是全收起来', handle.setPriority(null) === null
      && mod.NODE_IDS.every((id) => ringOf(id).visible === false));
  }

  /* ===== J. setFocus：相机飞行 ===== */

  console.log('\nJ. 相机飞行（焦点）');

  {
    const frame = (dt) => { clockRef.delta = dt === undefined ? 1 / 60 : dt; rendererRef.loop(); };
    const at = () => cameraRef.position.x;

    check('★ 一开始相机站在总览位（能看到三间房）',
      cameraRef.position.x === 0 && cameraRef.position.y > 10 && cameraRef.position.z > 20,
      cameraRef.position.x + ',' + cameraRef.position.y + ',' + cameraRef.position.z);

    const target = MAP['dorm-a'].x + 11;   // ROOM_VIEW.x

    check('setFocus 认这个节点', handle.setFocus('dorm-a') === 'dorm-a');
    check('★ 焦点那间的标签被标了出来（另外两间没有）',
      handle.rooms['dorm-a'].el.classList.contains('tag-focus') === true
      && handle.rooms['dorm-b'].el.classList.contains('tag-focus') === false);

    frame();
    check('★ 一帧之后相机还没到（是**飞**过去的，不是一帧跳过去）',
      at() < 0 && at() > target + 0.5, at() + ' -> ' + target);

    // 起步要慢：整段用的是 smoothstep（两头慢、中间快）。
    // 匀速插值看着像机器在平移，不像镜头在飞 —— 而这一条正是那种
    // 「不写断言就没人拦得住」的观感约定（改成匀速，别的断言全会照过）。
    const frac = at() / target;
    const linear = (1 / 60) / 0.9;
    check('★ 起步明显比匀速慢（smoothstep 的两头慢；匀速看着像机器在平移）',
      frac > 0 && frac < linear * 0.5, frac.toFixed(5) + ' vs 匀速的 ' + linear.toFixed(5));

    for (let i = 0; i < 120; i++) frame();
    check('★ 飞够时间后停在 dorm-a 的取景位', Math.abs(at() - target) < 1e-9,
      at() + ' vs ' + target);
    const look = cameraRef.lookAtCalls[cameraRef.lookAtCalls.length - 1];
    check('★ 停下来时看的是 dorm-a 的中心（不是还在盯着原点）',
      Math.abs(look[0] - MAP['dorm-a'].x) < 1e-9 && Math.abs(look[2] - MAP['dorm-a'].z) < 1e-9,
      JSON.stringify(look));

    /* 这条盯的是真实会出事的那个写法：快照是反复发的，一个节点一条遥测就
       可能来一帧新快照。要是「每收到一帧就重飞一次」，镜头会一直在半路上
       被重置，永远到不了 —— 表现是「镜头卡在半路慢慢挪，看着像卡了」。 */
    handle.setFocus('dorm-c');
    const targetC = MAP['dorm-c'].x + 11;
    for (let i = 0; i < 150; i++) { handle.setFocus('dorm-c'); frame(); }
    check('★ 每帧都重报同一个焦点也照样飞得到（重报才飞的写法镜头会卡在半路）',
      Math.abs(at() - targetC) < 1e-9, at() + ' vs ' + targetC);

    check('★ 回总览：setFocus(null) 把镜头飞回去',
      handle.setFocus(null) === null
      && mod.NODE_IDS.every((id) => handle.rooms[id].el.classList.contains('tag-focus') === false));
    for (let i = 0; i < 150; i++) frame();
    check('回总览之后又看得见三间房了（x 回到中间）', Math.abs(at()) < 1e-9, at());

    check('传不认识的节点 -> 回总览（不认的就当没焦点）',
      handle.setFocus('dorm-z') === null);
    for (let i = 0; i < 150; i++) frame();

    // 相机换位子不该顺手改任何一间房的样子
    handle.setReading('dorm-b', { temperature: 31, humidity: 60, status: STATUS.HOT, online: true });
    const before = {
      floor: handle.rooms['dorm-b'].room.floorMat.color.hex,
      window: handle.rooms['dorm-b'].room.windowPivot.rotation.y,
      ring: handle.rooms['dorm-b'].room.ring.visible,
      text: handle.rooms['dorm-b'].tagStatus.textContent,
    };
    handle.setFocus('dorm-b');
    for (let i = 0; i < 150; i++) frame();
    check('★ 换焦点只动相机和标签上的记号，不碰房间本身（那是状态的表达）',
      handle.rooms['dorm-b'].room.floorMat.color.hex === before.floor
      && handle.rooms['dorm-b'].room.windowPivot.rotation.y === before.window
      && handle.rooms['dorm-b'].room.ring.visible === before.ring
      && handle.rooms['dorm-b'].tagStatus.textContent === before.text,
      handle.rooms['dorm-b'].tagStatus.textContent);
    check('每帧都调了 lookAt（飞行途中每帧重看一下，不然朝向不会跟着走）',
      cameraRef.lookAtCalls.length > 300, cameraRef.lookAtCalls.length);
  }

  /* ===== K. 动画循环 ===== */

  console.log('\nK. 动画循环');

  {
    check('用 setAnimationLoop 注册了回调', typeof rendererRef.loop === 'function');

    const rBefore = rendererRef.renderCalls.length;
    const lBefore = handle.labelRenderer.renders.length;
    rendererRef.loop();
    check('每帧 3D 画一次', rendererRef.renderCalls.length === rBefore + 1);
    check('★ 每帧标签层也渲染一次（少这一次，标签就停在上一帧的位置上）',
      handle.labelRenderer.renders.length === lBefore + 1);
    // 取值前先判在不在：少了上面那两条的话这里会是 undefined，
    // 直接下标会抛 TypeError 把整份测试打断 —— 那样「红」是红在崩了，
    // 而不是红在这条断言上，后面那些段也全跑不到。
    const a3d = rendererRef.renderCalls[rBefore];
    const a2d = handle.labelRenderer.renders[lBefore];
    check('两边传的是同一对 (scene, camera) —— 尺寸和视角必须一致，'
      + '不然标签会从它那间房上滑开',
      !!a3d && !!a2d && a3d[0] === sceneRef && a3d[1] === cameraRef
      && a2d[1] === cameraRef,
      JSON.stringify([!!a3d, !!a2d]));
  }

  /* ===== L. 尺寸自适应 ===== */

  console.log('\nL. 尺寸自适应');

  {
    check('挂了 resize 监听', envRef.win.count('resize') === 1, envRef.win.count('resize'));

    const projBefore = cameraRef.projectionUpdates;
    envRef.host.clientWidth = 1000;
    envRef.host.clientHeight = 400;
    envRef.win.fire('resize');

    check('resize 后 aspect 跟着变',
      Math.abs(cameraRef.aspect - 1000 / 400) < 1e-12, cameraRef.aspect);
    check('resize 后重算了投影矩阵', cameraRef.projectionUpdates > projBefore);
    const last3d = rendererRef.sizes[rendererRef.sizes.length - 1];
    const last2d = handle.labelRenderer.sizes[handle.labelRenderer.sizes.length - 1];
    check('★ 两个渲染器拿到**同一个**尺寸（差一点标签就会从房间上滑开）',
      !!last3d && !!last2d && last3d[0] === 1000 && last3d[1] === 400
      && last2d[0] === 1000 && last2d[1] === 400,
      JSON.stringify([last3d, last2d]));

    envRef.host.clientWidth = 0;
    envRef.host.clientHeight = 0;
    envRef.win.fire('resize');
    check('★ 容器 0×0 时 aspect 不会变成 NaN（NaN 的表现是整屏全黑、控制台一条错都没有）',
      Number.isFinite(cameraRef.aspect), cameraRef.aspect);
    check('0×0 时两个渲染器拿到的也是有限数',
      rendererRef.sizes.every((s) => Number.isFinite(s[0]))
      && handle.labelRenderer.sizes.every((s) => Number.isFinite(s[0])));

    envRef.host.clientWidth = 900;
    envRef.host.clientHeight = 500;
    envRef.win.fire('resize');
  }

  /* ===== M. dispose ===== */

  console.log('\nM. dispose');

  {
    // 挑两个**嵌在最里面**的零件：扇叶在 fan 里、fan 又在 fanMount 里。
    // 假模块的 traverse 只走一层的话这两条会假绿。
    const blade = handle.rooms['dorm-b'].room.fan.children.find((c) => c.geometry);
    const mattress = handle.rooms['dorm-b'].room.bed.children[1];
    const floorA = handle.rooms['dorm-a'].room.floor;

    check('测试挑中的确实是嵌在里面的零件',
      !!blade && !!mattress && !!floorA && !!blade.geometry);

    handle.dispose();

    check('停掉了动画循环', rendererRef.loop === null, String(rendererRef.loop));
    check('摘掉了 resize 监听', envRef.win.count('resize') === 0, envRef.win.count('resize'));
    check('★ 摘掉了画布上的 click 监听（不摘的话页面切走了还在接点击）',
      rendererRef.domElement.count('click') === 0, rendererRef.domElement.count('click'));
    check('renderer 被 dispose', rendererRef.disposed === 1, rendererRef.disposed);

    check('三间房的地板几何体都回收了（三份是三个对象，不是一个复用三次）',
      mod.NODE_IDS.every((id) => handle.rooms[id].room.floor.geometry.disposed === 1),
      mod.NODE_IDS.map((id) => handle.rooms[id].room.floor.geometry.disposed).join(','));
    check('★ 嵌在两层 Group 里的扇叶也被回收了（traverse 要递归才走得到）',
      blade.geometry.disposed === 1 && blade.material.disposed >= 1,
      blade.geometry.disposed + '/' + blade.material.disposed);
    check('床垫（也嵌在 Group 里）被回收了', mattress.geometry.disposed === 1,
      mattress.geometry.disposed);
    check('三间房的环都被回收了',
      mod.NODE_IDS.every((id) => handle.rooms[id].room.ring.geometry.disposed === 1));
    check('大地面也回收了', groundRef.geometry.disposed === 1);

    check('canvas 从容器摘掉了',
      envRef.host.children.indexOf(rendererRef.domElement) === -1);
    check('★ 标签层也从容器摘掉了（它是 world.js 自己加的，不摘就留在页面上）',
      envRef.host.children.indexOf(handle.labelRenderer.domElement) === -1,
      envRef.host.children.length);
    check('容器最后是空的', envRef.host.children.length === 0, envRef.host.children.length);

    const sizeBefore = rendererRef.sizes.length;
    envRef.win.fire('resize');
    check('dispose 之后再 resize 不会再有动作', rendererRef.sizes.length === sizeBefore);
  }

  /* ===== N. 容器找不到 ===== */

  console.log('\nN. 容器');

  {
    installGlobals({ w: 100, h: 100 });
    // world.js 是先查容器、再建渲染器的，所以找不到容器时不该多出一个渲染器。
    // 反过来写（先建再查）的话，每次传错 id 都会漏一份显存和一个画布。
    const before = log.renderers.length;
    let threw = null;
    try { mod.createDormWorld('不存在的 id'); } catch (e) { threw = e; }
    check('找不到容器时抛错', threw instanceof Error);
    check('错误信息里写了是哪个容器',
      threw && threw.message.includes('不存在的 id'), threw && threw.message);
    check('★ 抛错时一个渲染器都没建（先查容器再建，不然每次传错都漏一份显存）',
      log.renderers.length === before, log.renderers.length - before + ' 个');
  }

  /* ===== O. 页面拿到的句柄 ===== */

  console.log('\nO. 句柄');

  {
    installGlobals({ w: 300, h: 200 });
    const h = mod.createDormWorld('world');
    check('句柄上有三间房（页面靠它取标签元素）', h.rooms
      && Object.keys(h.rooms).length === 3);
    check('句柄上那三间房和 NODE_IDS 对得上',
      Object.keys(h.rooms).sort().join(',') === mod.NODE_IDS.slice().sort().join(','));
    check('句柄暴露了 NODE_MAP / NODE_IDS（页面要用它摆 UI）',
      h.NODE_MAP === mod.NODE_MAP && h.NODE_IDS === mod.NODE_IDS);
    ['setReading', 'setHandling', 'setPriority', 'setFocus', 'viewOf', 'onPick', 'dispose']
      .forEach(function (fn) {
        check('句柄上有 ' + fn, typeof h[fn] === 'function');
      });
    check('viewOf 给得出某一间的取景位（不用飞也能算出来）',
      (function () {
        const v = h.viewOf('dorm-a');
        return v && v.pos && Math.abs(v.pos.x - (MAP['dorm-a'].x + 11)) < 1e-9;
      })());
    check('viewOf(不认识的节点) 退回总览',
      (function () {
        const v = h.viewOf('dorm-z');
        return v && Math.abs(v.pos.x) < 1e-9;
      })());
    h.dispose();
  }

  /* ===== P. 随包的 CSS2DRenderer ===== */

  console.log('\nP. three/lib/CSS2DRenderer.js（vendor 进来的那份）');

  {
    check('文件在 three/lib/ 里（world.js 那条 import 指的是它）', fs.existsSync(CSS2D_FILE));

    const bytes = fs.readFileSync(CSS2D_FILE);
    // 和 three.module.js 那条一样，大小按**归一化成 LF 之后**算：仓库里存的是
    // LF，core.autocrlf=true 的机器 clone 出来会变成 CRLF（4407 -> 4587 字节）。
    // 不归一化的话这条断言只在自己机器上绿。
    const lf = bytes.toString('latin1').replace(/\r\n/g, '\n').length;
    check('归一化后 4407 字节', lf === 4407, lf);

    // 出处和哈希：README 那张第三方文件表里记的是同一个数。这份文件不是我们写的，
    // 认它的唯一办法就是记下它的指纹 —— 哪天有人顺手改了它，这里会红。
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    check('★ sha256 和 README 里记的那个一致（e1-3 时是 a4f0f791…）',
      sha === 'a4f0f79184c043f6b9d2654d8ba051e49a7d631d34e8f437c1804798a68c379f',
      sha);

    const src = fs.readFileSync(CSS2D_FILE, 'utf8');
    const imports = [...src.matchAll(/^\s*import\s[\s\S]*?from\s+['"]([^'"]+)['"]/gm)]
      .map((m) => m[1]);
    check('★ 只 import 裸名字 three 这一条（多一个裸名字 importmap 就得跟着改）',
      imports.length === 1 && imports[0] === 'three', imports.join(','));
    check('导出了 CSS2DObject 和 CSS2DRenderer（world.js 两个都用）',
      /export\s*\{[^}]*CSS2DObject[^}]*\}/.test(src)
      && /export\s*\{[^}]*CSS2DRenderer[^}]*\}/.test(src));
    check('★ 它自己**不**设 pointer-events（所以 world.js 必须补那一行，见 G 段）',
      !/pointerEvents|pointer-events/.test(src));
    // 认它是不是 three r160 那一份：看它从 three 里要了哪几个名字、
    // 以及内部那两个标志（isCSS2DObject / setFromMatrixPosition）。
    // 这比「文件里出现了 three.js 这个词」结实得多 —— 后者随便一个注释都能满足。
    check('★ 是 three r160 的 examples/jsm 那一份（要 Matrix4/Object3D/Vector2/Vector3，'
      + '内部用 isCSS2DObject 和 setFromMatrixPosition）',
      /Matrix4/.test(src) && /Vector3/.test(src)
      && /isCSS2DObject/.test(src) && /setFromMatrixPosition/.test(src));

    const rows = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    check('★ README 里记了这份文件的 sha256（不然这个数只活在测试里）',
      rows.indexOf('a4f0f79184c043f6b9d2654d8ba051e49a7d631d34e8f437c1804798a68c379f') >= 0);
  }

  /* ---------- 收尾 ---------- */

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 不通过');
  process.exit(fail === 0 ? 0 : 1);
})();
