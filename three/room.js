/**
 * 造一间简化宿舍。
 *
 * 这个文件是 Step E1-2 从 scene.js 里**原样搬出来**的，一行几何都没改 ——
 * 搬的理由是 E1 要的是「三间房并排，各自绑一个节点」，而看板里那块 3D 面板
 * 要的是「一间房，跟着选中的宿舍换皮」。两者共用的是**同一间房的搭法**，
 * 不同的只是「摆几间、镜头怎么放、灯怎么打」。
 *
 * 所以切分线划在这儿：
 *
 *   room.js    一间房长什么样 —— 地板 / 墙 / 床 / 窗户 / 风扇 / 标记环，
 *              以及「状态变了，这间房自己的零件怎么变」
 *   scene.js   一间房 + 相机 + 渲染器 + 灯 + 覆盖层 = 看板那块面板要的东西
 *   world.js   三间房 + 全局灯 + 相机飞行 + 悬浮标签 + 拾取 = 3D 页面要的东西
 *
 * 「一间房」里唯一**没**跟过来的是灯和背景色。原因是灯是全局的：三间房各有各的
 * 状态时，没法让一盏灯同时是三种颜色。所以状态落在房间自己的零件上（地板颜色、
 * 窗户颜色与开合、风扇转不转），这三样都长在这间房里，一眼能看出是哪一间。
 * 单间房那边（scene.js）仍然按 LOOK 表连灯和背景一起换，那是它原有的行为。
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
 * 这里写死一份、不读 CSS 变量：room.js 要能在没有真实 DOM 的测试里跑起来，
 * 读 getComputedStyle 会把这条依赖引进测试。改样式时两处一起改。
 */
export const FOCUS_COLOR = 0x2a78d6;

/* 环的内外半径。地板是 10×10（-5 ~ +5），环贴着房间边缘但不到墙根，
   这样它读起来是「这间屋子被圈住了」，而不是压在地板缝上。 */
const FOCUS_RING_INNER = 4.35;
const FOCUS_RING_OUTER = 4.75;

/* ================= 尺寸 ================= */

export const ROOM = 10;      // 房间边长（X 和 Z 都是它）
export const WALL_H = 4;     // 墙高

/**
 * 状态 → 房间外观。四种状态各自的每一项都写全，不做「只写差异、其余继承默认」
 * 那种省略 —— 一眼能看出四种状态分别改了什么，是这张表的全部意义。
 *
 * 地板和窗户用色说明：
 *   偏热的地板取的是项目的 --status-critical（#d03b3b）和地板底色混出来的，
 *   偏冷的地板是一个冷灰蓝 —— 这两种状态都靠**地板**说话，
 *   所以三间房并排时（灯是共用的）也一眼分得出来谁冷谁热。
 *   偏湿的窗户蓝是玻璃/水的直觉色，不是 --status-serious（那个是砖橙色）。
 *   窗户变蓝 + 打开读作「开窗通风」，是场景动作，不是在拿颜色表示状态；
 *   真正表示状态的是旁边的文字（单间房那边是覆盖层，三间房那边是悬浮标签）。
 *
 * **每一行都有一项和「正常」不同** —— 这条是被三间房逼出来的：
 * 单间房那边灯是这一间独有的，偏冷只改灯也看得见；三间房的灯是全场景共用的，
 * 一行要是只改 sun/ambient/bg，那间房在三间房里就和正常那间一模一样。
 *
 * sun / ambient / bg 是三盏「全局」的东西，只有单间房那边用得上（见文件头）。
 */
export const LOOK = {
  [STATUS.NORMAL]: {
    floor: 0xb9b8b2, window: 0xcdd8de, open: false, fan: false,
    sun: 0xffffff, ambient: 0xffffff, bg: 0xececea,
  },
  [STATUS.COLD]: {
    // 地板也偏冷色，**不只是靠灯**。单间房那边（scene.js）灯是这一间房独有的，
    // 让两盏灯一起偏蓝就等于「这间房冷」；三间房那边灯是全场景共用的，
    // 一盏灯没法同时是三间的颜色 —— 所以那边要是只改灯，偏冷那间房会和
    // 正常那间长得一模一样，「房间颜色跟随 status」就少了一格。
    // 地板带上冷色，两边都成立。
    floor: 0x9fb0c8, window: 0xcdd8de, open: false, fan: false,
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
 * 搭一间房，原点在房间正中、地面在 y = 0。
 *
 * 返回的是「这间房自己的零件 + 几个手法」，不含相机和灯 —— 摆到哪儿、怎么打光
 * 由调用方决定（单间房的 scene.js 和 三间房的 world.js 各有一套）。
 *
 * @param {string} [prefix] 给这间房里所有零件名字加的前缀。三间房并排时必须给，
 *   否则三间房里的地板全叫 'floor'，按名字找零件会随机撞上一个。单间房那边
 *   不传，零件名和 Step 6-2 时一模一样。
 * @returns {{group: THREE.Group, floor: THREE.Mesh, floorMat: THREE.Material,
 *            bed: THREE.Group, windowPane: THREE.Mesh, windowPivot: THREE.Group,
 *            fan: THREE.Group, fanMount: THREE.Group, ring: THREE.Mesh,
 *            setFanOn: function(boolean): boolean, spin: function(number): void,
 *            applyLook: function(object): object}}
 */
export function buildRoom(prefix) {
  const pre = prefix ? prefix + '-' : '';
  const name = function (n) { return pre + n; };

  /* ================= 一间房的组 ================= */

  // 整间房挂在一个 Group 下，是为了「把房间挪到 (x, 0, z)」只改一个数：
  // 里面的零件坐标全是相对房间中心的，挪房间不用逐个重算。
  const group = new THREE.Group();
  group.name = pre ? pre + 'room' : 'room';

  /* ================= 地板 ================= */

  // 地板材质单独留一个引用：状态变了要改它的颜色。
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
  floor.name = name('floor');
  group.add(floor);

  /* ================= 当前重点标记环 ================= */

  // 画面里这间宿舍正是「当前重点」时，地板上多一圈环。默认不出现。
  //
  // 为什么用**平躺的环**而不是把房间整体描个边：相机是斜着俯视的，地板在画面里
  // 占的面积最大、遮挡最少，一圈环一眼就能看见；描边的话，两面墙是半透明的，
  // 描出来的线会跟墙缝混在一起。
  //
  // 用 MeshBasicMaterial（不受光照影响）而不是 Standard：这是个**界面记号**，
  // 不是场景里的一件东西。跟着灯光忽明忽暗的话，偏冷那段（两盏灯都偏蓝、
  // 整体压暗）它就不显眼了，而「谁是重点」跟屋里冷不冷没有关系。
  const ringMat = new THREE.MeshBasicMaterial({
    color: FOCUS_COLOR, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(FOCUS_RING_INNER, FOCUS_RING_OUTER, 64),
    ringMat
  );
  // RingGeometry 和地板一样躺在 XY 平面上，同样要绕 X 转 -90° 才放平。
  ring.rotation.x = -Math.PI / 2;
  // 抬 0.01 免得和地板共面闪烁（外面那块大地面用的是 0.02，这里小一号就够了 ——
  // 环比地面小得多，边缘的斜视角度没那么刁）。
  ring.position.y = 0.01;
  ring.name = name('focus-ring');
  ring.visible = false;
  group.add(ring);

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
  wallBack.name = name('wall-back');
  group.add(wallBack);

  const wallLeft = new THREE.Mesh(new THREE.PlaneGeometry(ROOM, WALL_H), wallMat);
  wallLeft.position.set(-ROOM / 2, WALL_H / 2, 0);
  // 平面默认正面朝 +Z。绕 Y 转 +90° 后正面朝 +X，也就是朝屋里。
  wallLeft.rotation.y = Math.PI / 2;
  wallLeft.name = name('wall-left');
  group.add(wallLeft);

  // 两面墙都不投也不收阴影：半透明的面接住影子会变成一块块深浅不一的补丁，
  // 看起来像渲染坏了；投的话又会在地上留下一堵实心墙的影子，和半透明自相矛盾。
  // 反正屋里的影子有地板接着，够了。

  /* ================= 床 ================= */

  // 床是个 Group：床架 + 床垫各自摆好，再由 Group 整体挪到墙角。
  // 不这么做的话，每加一个零件都要把「床的位置」重算一遍加进去，
  // 想挪一下床就得改两处 —— Group 就是把「零件之间的关系」和「整体在哪」分开。
  const bed = new THREE.Group();
  bed.name = name('bed');

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
  group.add(bed);

  /* ================= 窗户 ================= */

  // 开窗不是「把窗户转个角度」那么简单：直接转 windowPane 的话，它绕自己的
  // 中心转，看起来像块板子在原地打转，不像开窗。真实窗户是绕**一条边**转的。
  // 做法是加一个 location 在铰链上的空 Group（windowPivot），把窗户挂到它的
  // 一侧（position.x = 半个宽），再转这个 Group —— 转轴自然就落在左边缘上。
  // 这是 three/GUI 里最常见的招：想绕非中心点旋转，就给它一个父节点当轴。
  const windowPivot = new THREE.Group();
  windowPivot.name = name('window-pivot');
  // 铰链在后墙上，窗洞左边。z 比墙面（-5）往屋里挪一点，免得和墙共面闪烁。
  windowPivot.position.set(0.3, 2.3, -ROOM / 2 + 0.1);

  const windowMat = new THREE.MeshStandardMaterial({
    color: LOOK[STATUS.NORMAL].window, roughness: 0.25, metalness: 0.1,
  });
  const windowPane = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.6, 0.1), windowMat);
  windowPane.position.x = 2.6 / 2;   // 挂在铰链的 +X 侧
  windowPane.castShadow = true;
  windowPane.name = name('window-pane');
  windowPivot.add(windowPane);
  group.add(windowPivot);

  /* ================= 风扇 ================= */

  // 风扇分两层，不能合成一层：
  //   fanMount —— 管「摆在哪儿、朝哪边」，还挂着把风扇连到墙上的支架；
  //   fan      —— 只管自己转。
  // 合成一层的话，转起来连支架一起转，看着像整台风扇在墙上打滚。
  // fan 里就是题目要的那个 Group：一个中心 + 3 片扇叶。
  const fanMount = new THREE.Group();
  fanMount.name = name('fan-mount');
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
  fan.name = name('fan');

  // 中心（轮毂）。圆柱默认轴向是 Y，而扇叶摊在 XY 平面上（转轴是 Z），
  // 所以绕 X 转 90° 把它的轴也扳到 Z 上。不扳的话中心是个立着的圆筒，
  // 从正面看是一根竖条，不像风扇的中心。
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.17, 0.17, 0.24, 16),
    new THREE.MeshStandardMaterial({ color: 0x6f7379, roughness: 0.5, metalness: 0.4 })
  );
  hub.rotation.x = Math.PI / 2;
  hub.castShadow = true;
  hub.name = name('fan-hub');
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
    blade.name = name('fan-blade-' + i);
    fan.add(blade);
  }

  fanMount.add(fan);
  group.add(fanMount);

  /* ================= 这间房自己的状态 ================= */

  const room = {
    group, floor, floorMat, bed,
    wallBack, wallLeft, wallMat, windowPane, windowMat, windowPivot,
    fan, fanMount, ring, ringMat,

    // 风扇转不转，只由这个标志位决定；动画循环每帧读它一次。
    // 分开存而不是直接看 fan.rotation 有没有在变 —— 「要不要转」和「已经转到哪了」
    // 是两件事，停的时候角度要留在原地，不能归零。
    fanOn: false,

    /**
     * 手动开关风扇。applyLook 内部走的也是它，所以后调用的那次为准。
     * @param {boolean} on 真值就转（别传 'false' 这种字符串，非空字符串是真值）
     * @returns {boolean} 归一化之后的开关状态
     */
    setFanOn: function (on) {
      room.fanOn = !!on;
      return room.fanOn;
    },

    /**
     * 让扇叶按时间往前转一点。调用方每帧调一次，传的是「距上一帧过了多少秒」。
     *
     * 用它乘速度，转动快慢就与帧率无关；写成 fan.rotation.z += 0.1（每帧固定量）
     * 的话，120Hz 屏幕上会转得比 60Hz 快一倍 —— 换个显示器演示，观感就变了。
     */
    spin: function (dt) {
      if (room.fanOn) room.fan.rotation.z += dt * FAN_SPIN;
    },

    /**
     * 把这间房改成某个状态该有的样子。
     *
     * 只动**长在这间房里**的三样：地板颜色、窗户颜色与开合、风扇转不转。
     * 不认识的 status 按「正常」处理并且不抛异常 —— 这个入参迟早来自 MQTT 报文，
     * 链路上什么都可能传进来，显示层不该因为一个坏值整页崩掉。
     *
     * @param {object} look LOOK 表里的一格
     * @returns {object} 实际贴上去的那一格
     */
    applyLook: function (look) {
      room.floorMat.color.set(look.floor);
      room.windowMat.color.set(look.window);
      // 开窗直接给角度，不做缓动。按钮点下去要立刻看到变化，
      // 而且立刻到位也让「打开了吗」这件事一眼可验、好写测试。
      // 想让开合柔和一点的话，在动画循环里让 rotation.y 朝这个目标值逼近即可。
      room.windowPivot.rotation.y = look.open ? WINDOW_OPEN_ANGLE : 0;
      room.setFanOn(look.fan);
      return look;
    },
  };

  return room;
}
