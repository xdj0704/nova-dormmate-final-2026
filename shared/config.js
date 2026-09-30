'use strict';

/* DormMate 前端统一配置（E3）
 *
 * 普通 <script> 引入，挂一个全局对象 DormMateConfig，不用 export —— 和
 * shared/rules.js 同一个做法，因为看板 / 移动端 / 3D 里有两个是经典 script
 * （只有 3d/ 走 ES Module + importmap），`export` 在那两个里直接是语法错误。
 *
 * 【为什么会有这个文件】E3 之前，broker 地址那三行在每个页面里各抄了一份
 * （`web/script.js`、`dashboard/dashboard.js`、`3d/index.html`），当时还专门
 * 写了注释说「故意各留一份，为三行代码共用 shared/ 反而多发一次请求」。
 * E3 要加移动端，同一段就要出现第四次，而且它在手机上**必须**跟着访问地址走
 * （写死 localhost 的话，手机浏览器里的 localhost 指的是手机自己，连不回来）——
 * 抄错一次的后果是「手机上永远连不上」，而页面上只会写「未连接」。
 * 所以那笔账到这里翻过来了：一份，所有人引它。
 *
 * 【规则的真源**不在**这里，在 /shared/rules.js 和 status_rules.py】
 * 这个文件只放「地址和 topic 字符串」，一个判断都没有 —— 前端不许自己算。
 * topic 的真源在项目根的 config.py：下面每一条字符串都必须和它逐字相同，
 * `tests/config.test.js` 会把两边读出来逐条比，改一边漏另一边那里就红。
 */
(function (global) {
  'use strict';

  /* ---- MQTT ---- */

  /* 浏览器走 WebSocket。这个端口号必须和 config.py 的 MQTT_WS_PORT 一致 ——
     握手不上不会有任何报错，只有页面上那行「未连接」。 */
  const MQTT_WS_PORT = 9001;

  /* 给 MQTTX / 命令行用的那个口。前端用不到，放在这里是为了让「两个口」这件事
     只有一个出处 —— 看板上要写一句「MQTTX 请连 1883，浏览器连 9001」时不必再手打。 */
  const MQTT_TCP_PORT = 1883;

  /* ---- topic（逐字对应 config.py）---- */

  /* 遥测通配符。**前端不再订阅它**（E3 起前端只订 STATE_TOPIC），
     留着是给排查用的：抓 MQTTX 时要订哪一条，答案在这里，不必去读 core。 */
  const TOPIC_PATTERN = 'dormmate/v1/nodes/+/telemetry';

  /* core 发的全局状态快照（retained）。E3 起所有前端只订这一条。 */
  const STATE_TOPIC = 'dormmate/v1/state';

  /* 前端 -> core 的指令（retain=False）。 */
  const CMD_TOPIC = 'dormmate/v1/cmd';

  /* core 拒掉一条报文时发的（retain=False）。
     **E3 起前端不订这一条**：被拒绝日志改由 core 攒进快照里一起发（前端只订
     STATE_TOPIC 就够）。留着它是因为这份文件的职责是「topic 表只有一处出处」，
     排查时要订哪一条、MQTTX 里该填什么，答案应该在这里找到。 */
  const REJECT_TOPIC = 'dormmate/v1/log/reject';

  /* core 的在线状态（retained + 遗嘱）。同样**前端不订**：快照本身是 retained 的，
     能收到 STATE_TOPIC 就说明 core 活着。 */
  const CORE_STATUS_TOPIC = 'dormmate/v1/core/status';

  /* ---- QoS / retain ---- */

  const QOS = 1;

  /* 遥测和快照都是 retained：后打开页面的人立刻能看到当前值，
     不用等下一个周期。 */
  const RETAIN = true;

  /* 指令**必须**是 False。retain 的指令会留在 broker 上，之后每开一次
     浏览器都先收到一次 —— 页面刚加载就自己按了一遍「开始处理」。 */
  const CMD_RETAIN = false;

  /* 「开始处理」那个动作的名字，报文里写成 `{"nodeId":"dorm-b","action":"handle",...}`。
     它和 topic 一样是**跨端约定**：看板、移动端各发一次，core 的 events.HANDLE 收
     一次，三处必须一模一样（写错一个字，core 回一句「动作不对」，
     而看板那边看着像「点了没反应」）。所以它和 topic 放一起，
     对应 core 侧的 `events.py` 里的 `HANDLE = "handle"`。
     `tests/config.test.js` 会去 events.py 里把那行抠出来对一次。 */
  const CMD_ACTION = 'handle';

  /* 「把焦点切到这个宿舍」那个动作的名字。**只有移动端发**它（看板故意不发：
     两个端都能改焦点的话，两个人一起看就会互相抢），发完 core 把它记进快照的
     `focus` 那三个字段，看板和 3D 跟着切过去。

     同一个节点再发一次是**取消**（core 里写的）—— 手机上「再点一下收起」不用
     另发一条指令，所以这里也只有一个动作名。

     对应 core 侧的 `FOCUS = "focus"`（在 core.py 里，不在 config.py：它是
     **动作**不是配置）。它进了 `COMMANDS`（`events.COMMANDS + (FOCUS,)`），
     所以 `validate_command` 那六道判据对它一样适用。
     `tests/config.test.js` 会去 core.py 里把那行抠出来对一次。 */
  const CMD_ACTION_FOCUS = 'focus';

  /* ---- 函数 ---- */

  /**
   * dorm-a -> dormmate/v1/nodes/dorm-a/telemetry
   *
   * 顺序**不是**可选的：core 的 validate_message 会拿 topic 里的节点和报文里的
   * nodeId 对账，两者不一样直接拒收，理由里写着「topic 形状不对」。
   *
   * @param {string} nodeId
   * @returns {string}
   */
  function topicFor(nodeId) {
    return 'dormmate/v1/nodes/' + String(nodeId) + '/telemetry';
  }

  /**
   * 按页面的访问地址拼 broker 的 WebSocket 地址。
   *
   * @param {string} [hostname] 不给就退回 'localhost'
   * @returns {string} 例如 ws://10.102.196.160:9001
   */
  function brokerUrl(hostname) {
    /* `hostname || 'localhost'`：file:// 打开时 location.hostname 是空串，
       不兜这一下会拼出 `ws://:9001` 这种烂地址，连报错都看不懂。 */
    return 'ws://' + (hostname || 'localhost') + ':' + MQTT_WS_PORT;
  }

  /**
   * brokerUrl 的便利版：直接从 location 对象取。
   *
   * 单独给出一个吃 location 的版本，是为了**测试能不碰真 location** ——
   * 否则「手机上打开该连哪个地址」这一条只能在真手机上试。
   *
   * @param {{hostname?: string}} [loc] 不给就用当前的 global.location
   */
  function brokerUrlFor(loc) {
    const where = loc || global.location || {};
    return brokerUrl(where.hostname);
  }

  /* 冻上：这几个值一旦有人（或者未来某次「我先改一行试试」）在页面里赋值，
     会静默改掉所有后续的连接行为，而页面看着照常。冻结之后写不进去，
     严格模式下那句赋值当场抛错。 */
  global.DormMateConfig = Object.freeze({
    MQTT_WS_PORT: MQTT_WS_PORT,
    MQTT_TCP_PORT: MQTT_TCP_PORT,
    TOPIC_PATTERN: TOPIC_PATTERN,
    STATE_TOPIC: STATE_TOPIC,
    CMD_TOPIC: CMD_TOPIC,
    REJECT_TOPIC: REJECT_TOPIC,
    CORE_STATUS_TOPIC: CORE_STATUS_TOPIC,
    QOS: QOS,
    RETAIN: RETAIN,
    CMD_RETAIN: CMD_RETAIN,
    CMD_ACTION: CMD_ACTION,
    CMD_ACTION_FOCUS: CMD_ACTION_FOCUS,
    topicFor: topicFor,
    brokerUrl: brokerUrl,
    brokerUrlFor: brokerUrlFor,
  });
}(typeof globalThis !== 'undefined' ? globalThis : this));
