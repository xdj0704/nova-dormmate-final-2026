// tests/config.test.js
// 校验 shared/config.js —— 三个前端共用的那份地址 / topic 常量。
//
// 这一份文件没有一行判断逻辑，它错起来的唯一方式是**和 config.py 不一致**。
// 所以这里测的重点就一个字：**对得上**。
//   - config.py 里每一个 dormmate/ 开头的字符串，这里必须有一个一模一样的；
//   - 这里的每一个，config.py 里也必须有一个（两个方向都查，否则「这边多写了
//     一条已废弃的 topic」和「那边加了一条这边没跟上」两件事都测不出来）；
//   - 端口、QoS、retain 逐条对上；
//   - brokerUrl 跟着访问地址走（手机能不能连上的那一件事，只在这里能测）。
//
// 跑法：node tests/config.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'shared', 'config.js'), 'utf8');
const PY = fs.readFileSync(path.join(ROOT, 'config.py'), 'utf8');
/* 动作名那个常量对的是 events.py 而不是 config.py —— 「handle」这个词的出处
   在事件那一层（`HANDLE = "handle"`），config.py 里没有它。 */
const EVENTS = fs.readFileSync(path.join(ROOT, 'events.py'), 'utf8');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? `  =>  ${a}` : `\n        实际: ${a}\n        期望: ${e}`));
}

/* ---------- 把 shared/config.js 真跑一遍（不是读它的文本猜）---------- */

/* 页面上的 location 桩。config.js 里 brokerUrlFor 不传参时会读它，
   给一个「本机打开」的默认值。 */
const fakeGlobal = { location: { hostname: 'localhost' } };

vm.createContext(fakeGlobal);
vm.runInContext(SRC, fakeGlobal, { filename: 'shared/config.js' });

const C = fakeGlobal.DormMateConfig;

/* ============ A. 挂出来了、也挂对了地方 ============ */

console.log('\n=== A. 加载与暴露 ===');
check('★ 加载后全局就是多了一个 DormMateConfig', typeof C, 'object');
check('★ 而且它是个对象（不是函数 / undefined）', C !== null && !Array.isArray(C), true);
check('★ 冻上了 —— 页面里谁也别想悄悄改掉 broker 地址', Object.isFrozen(C), true);

/* 内部那几个名字不许漏到全局去：漏了就可能和某个页面自己的
   `const QOS` 撞名 —— 经典 script 共用一个全局词法作用域，
   撞了是整个页面 SyntaxError，而报错信息指向的是**另一个文件**。 */
check('★ 内部常量没有漏到全局（QOS）', fakeGlobal.QOS, undefined);
check('★ 内部常量没有漏到全局（brokerUrl）', fakeGlobal.brokerUrl, undefined);
check('★ 内部常量没有漏到全局（topicFor）', fakeGlobal.topicFor, undefined);
check('★ 也没有 export default / module.exports 那种东西', fakeGlobal.module, undefined);

/* 严格模式 + 冻结：赋值要么抛、要么无声失败，两种都不许改成功。 */
try {
  C.STATE_TOPIC = 'dormmate/v1/hacked';
} catch (err) { /* 严格模式下抛 TypeError，也是对的 */ }
check('★ 试图改 topic 之后它还是原来那句', C.STATE_TOPIC, 'dormmate/v1/state');

/* ============ B. topic 与 config.py 逐条对账 ============ */

console.log('\n=== B. topic 与 config.py 对账 ===');

/* config.py 里所有形如 "dormmate/..." 的字符串字面量。
   **带花括号的那些要跳过**：`topic_for()` 里那条是 f-string 模板
   （`f"dormmate/v1/nodes/{node_id}/telemetry"`），它是「拼出一条 topic 的方法」，
   不是一个具体的 topic 字符串，拿来比对只会得到一条永远对不上的假失败。 */
const pyTopics = [];
const pyTemplates = [];
const TOPIC_LITERAL = /"((?:dormmate)\/[^"]*)"/g;
let m;
while ((m = TOPIC_LITERAL.exec(PY)) !== null) {
  if (m[1].indexOf('{') >= 0) {
    if (pyTemplates.indexOf(m[1]) < 0) pyTemplates.push(m[1]);
  } else if (pyTopics.indexOf(m[1]) < 0) {
    pyTopics.push(m[1]);
  }
}
check('★ config.py 里那个 f-string 模板确实被认出来并跳过了（不是漏读）',
  pyTemplates, ['dormmate/v1/nodes/{node_id}/telemetry']);

/* 这份文件里所有的字符串值 */
const jsTopics = Object.keys(C)
  .filter((k) => typeof C[k] === 'string' && C[k].indexOf('dormmate/') === 0)
  .map((k) => C[k]);

check('★ config.py 里确实有 topic 可以比（防止下面的比对是空对空）', pyTopics.length >= 5, true);
check('★ config.py 每一条 topic 这里都有', pyTopics.filter((t) => jsTopics.indexOf(t) < 0), []);
check('★ 这里每一条 topic config.py 里也都有（没有多出来的废条）',
  jsTopics.filter((t) => pyTopics.indexOf(t) < 0), []);

/* 逐条点名，比「条数一样」结实：条数一样而两条互换位置照样过。 */
function pyConst(name) {
  const re = new RegExp('^' + name + '\\s*=\\s*(.+?)\\s*(?:#.*)?$', 'm');
  const hit = PY.match(re);
  if (!hit) throw new Error('config.py 里没有 ' + name);
  const raw = hit[1];
  if (/^".*"$/.test(raw)) return raw.slice(1, -1);
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === 'True') return true;
  if (raw === 'False') return false;
  throw new Error(name + ' 的写法这个测试看不懂：' + raw);
}

check('TOPIC_PATTERN', C.TOPIC_PATTERN, pyConst('TOPIC_PATTERN'));
check('STATE_TOPIC', C.STATE_TOPIC, pyConst('STATE_TOPIC'));
check('CMD_TOPIC', C.CMD_TOPIC, pyConst('CMD_TOPIC'));
check('CORE_STATUS_TOPIC', C.CORE_STATUS_TOPIC, pyConst('CORE_STATUS_TOPIC'));
check('MQTT_WS_PORT', C.MQTT_WS_PORT, pyConst('MQTT_WS_PORT'));
check('MQTT_TCP_PORT', C.MQTT_TCP_PORT, pyConst('MQTT_TCP_PORT'));
check('QOS', C.QOS, pyConst('QOS'));
check('RETAIN', C.RETAIN, pyConst('RETAIN'));

/* REJECT_TOPIC 在这里是**唯一没有同名对照**的一条：config.py 里它叫
   REJECT_TOPIC，这份文件里为了少一个名字就并进上面那张字面量清单了。
   上面那条「两个方向都查」已经覆盖了它，这里再点一次名是为了让人看得见
   它到底对的是谁。 */
check('★ 被拒绝那条 topic 和 config.py 的 REJECT_TOPIC 是同一句',
  jsTopics.indexOf(pyConst('REJECT_TOPIC')) >= 0, true);

/* 动作名不是 topic，上面那套「两个方向都查」碰不到它（那份清单只收 dormmate/
   开头的字符串）。但它的性质一模一样：写错一个字，core 回一句「动作不对」，
   而页面上看着像「点了没反应」—— 三条并发路径里错一条，只有 core 的终端知道。
   所以单独对一次，出处是 events.py 的 HANDLE。
   抠的是 `HANDLE = "handle"` 那一行本身，不是「events.py 里出现过 handle 这个词」——
   后者在 COMMANDS、在动作字典、在注释里到处都是，永远为真，等于没查。 */
check('★ 动作名和 events.py 的 HANDLE 是同一个词', C.CMD_ACTION,
  (EVENTS.match(/^HANDLE\s*=\s*"([^"]*)"/m) || [])[1]);
check('★ 而且这个动作确实在事件那一层的动作清单里（不是个没人认的词）',
  /^COMMANDS\s*=\s*\(\s*HANDLE\s*,?\s*\)/m.test(EVENTS), true);

/* 焦点那个动作名。它和 handle 不一样的地方在于**出处不是一个文件**：
   handle 的出处是 events.py 的 HANDLE（事件那一层的事），焦点是 core.py 的
   FOCUS（「现在在看哪个」是 core 记的，不属于任何一条事件）。
   两个动作名从此都有交叉校验，谁都不用靠「我记得是这么写的」。 */
const CORE = fs.readFileSync(path.join(ROOT, 'core.py'), 'utf8');
check('★ 焦点动作名和 core.py 的 FOCUS 是同一个词', C.CMD_ACTION_FOCUS,
  (CORE.match(/^FOCUS\s*=\s*"([^"]*)"/m) || [])[1]);
/* 光比字面量不够：那个词还得真的进了 core 认的动作清单，否则发过去是一句
   「不认识的 action」。清单是拼出来的（`events.COMMANDS + (FOCUS,)`），
   所以查的是那一行 —— 盯着「FOCUS 出现过」等于什么都没查，它在注释里也出现。 */
check('★ 而且它确实在 core 认的动作清单里（不是个没人认的词）',
  /^COMMANDS\s*=\s*events\.COMMANDS\s*\+\s*\(FOCUS\s*,?\s*\)/m.test(CORE), true);
check('★ 两个动作名不是同一个词（焦点和开始处理是两件事）',
  C.CMD_ACTION_FOCUS === C.CMD_ACTION, false);

/* ============ C. topicFor 的形状 ============ */

console.log('\n=== C. topicFor ===');
check('dorm-a', C.topicFor('dorm-a'), 'dormmate/v1/nodes/dorm-a/telemetry');
check('dorm-c', C.topicFor('dorm-c'), 'dormmate/v1/nodes/dorm-c/telemetry');

/* 造出来的那条必须真的落进通配符里 —— 否则前端抓包时订的是一条
   永远收不到消息的 topic，而那和「节点没发数据」看起来一模一样。 */
function matchesPattern(topic, pattern) {
  const t = topic.split('/'), p = pattern.split('/');
  return t.length === p.length && p.every((seg, i) => seg === '+' || seg === t[i]);
}
check('★ 造出来的 topic 落得进 TOPIC_PATTERN', matchesPattern(C.topicFor('dorm-b'), C.TOPIC_PATTERN), true);
check('（通配符确实在节点那一段上，不是别处）',
  C.TOPIC_PATTERN.split('/').indexOf('+'), C.topicFor('x').split('/').indexOf('x'));

/* ============ D. brokerUrl —— 手机能不能连上就看这里 ============ */

console.log('\n=== D. brokerUrl ===');
check('★ 本机打开', C.brokerUrl('localhost'), 'ws://localhost:9001');
check('★ 手机用局域网 IP 打开（这时写死 localhost 就废了）',
  C.brokerUrl('10.102.196.160'), 'ws://10.102.196.160:9001');
check('★ 没给主机名时退回 localhost', C.brokerUrl(), 'ws://localhost:9001');
check('★ 空串也退回 localhost（file:// 下 location.hostname 就是空串）',
  C.brokerUrl(''), 'ws://localhost:9001');

/* 端口不许写死在函数里：改了 MQTT_WS_PORT 而函数没跟上，
   页面会去连一个没人听的端口。拿一个「改过的」上下文单独验一次。 */
const otherContext = { location: { hostname: 'x' } };
vm.createContext(otherContext);
vm.runInContext(SRC.replace('const MQTT_WS_PORT = 9001;', 'const MQTT_WS_PORT = 19001;'),
  otherContext, { filename: 'shared/config.js(改过端口)' });
check('★ brokerUrl 用的是那个常量，不是写死的 9001',
  otherContext.DormMateConfig.brokerUrl('h'), 'ws://h:19001');

check('★ brokerUrlFor 吃一个 location 对象', C.brokerUrlFor({ hostname: '192.168.1.7' }), 'ws://192.168.1.7:9001');
check('★ brokerUrlFor 不传参时读当前 global.location',
  C.brokerUrlFor(), 'ws://localhost:9001');
check('★ 传了对象里没有 hostname 也不炸',
  C.brokerUrlFor({}), 'ws://localhost:9001');

/* ============ E. 这条规则只该有一处出处 ============ */

console.log('\n=== E. 不碰 DOM、不自带正文 ===');
check('★ 源码里没有 document', /\bdocument\b/.test(SRC), false);
check('★ 源码里没有 window', /\bwindow\b/.test(SRC), false);
check('★ 源码里没有 XMLHttpRequest / fetch',
  /XMLHttpRequest|\bfetch\s*\(/.test(SRC), false);
check('★ 源码里没有 export / import（经典 script 里那两个是语法错误）',
  /^\s*(export|import)\s/m.test(SRC), false);
check('★ 源码里没有 require（浏览器里没有 require）', /require\s*\(/.test(SRC), false);
/* 「别把规则抄第二份」这条，比的是**关键词**不是数字：数字没法查 ——
   这个文件里本来就有 1883 和 9001，`/18/` 会把 1883 也收进去。真正该挡的是
   阈值名、规则函数名、四个状态词：一个地址 / topic 常量表里出现「偏热」，
   就说明有人开始在这里写判断了。 */
check('★ 没有把它抄成第二份规则：不出现阈值键名',
  /temperatureLow|temperatureHigh|humidityHigh/.test(SRC), false);
check('★ 不出现规则函数名', /judgeStatus|getAdvice/.test(SRC), false);
check('★ 不出现四个状态词（地址表里出现「偏热」就意味着有人开始判了）',
  /偏冷|偏热|偏湿/.test(SRC), false);

console.log(`\n结果：${pass} 通过，${fail} 不通过`);
process.exit(fail === 0 ? 0 : 1);
