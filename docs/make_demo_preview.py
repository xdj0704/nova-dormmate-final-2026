# -*- coding: utf-8 -*-
"""把 demo-script.md 渲染成一个能播的单文件 HTML —— 演示视频的提词器 / 分镜预演。

**它不是视频。** 它录不了屏，也造不出画面。它做的是三件事：

  1. 按脚本里写好的时间**自己往下走**（7 分 00 秒走完），当前该念哪一段一目了然；
  2. 把旁白放大到一眼能扫完的字号 —— 录屏时摆在副屏上，不用低头找行；
  3. 把「屏幕画面 / 要跑的命令」和旁白分两栏摆着，念的时候不会串行。

真正的画面得靠录屏软件。这份东西解决的是「念的时候手里有没有谱」。

纯标准库，没有第三方依赖。用法：

    py -3.14 docs/make_demo_preview.py

产物写到 docs/demo-preview.html。**那个 HTML 是产物，别手改** ——
要改内容改 demo-script.md，再跑一遍这个脚本。
"""
import html
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "demo-script.md"
OUT = HERE / "demo-preview.html"

# `## 第 3 段 · D2：系统自己指出先看哪一间`
SEG_HEAD = re.compile(r"^##\s+第\s*(\d+)\s*段\s*·\s*(.+?)\s*$")
PREP_HEAD = re.compile(r"^##\s+拍摄前")

# `**时间** 0:40 – 1:30（50 秒）`
TIME_LINE = re.compile(
    r"\*\*时间\*\*\s*(\d+):(\d+)\s*[–—-]\s*(\d+):(\d+)\s*[（(]\s*(\d+)\s*秒\s*[)）]"
)
SCREEN_LINE = re.compile(r"^\*\*屏幕\*\*\s*(.+)$")
# `**【动作】** …` / `**【跑】** …`
ACTION_LINE = re.compile(r"^\*\*【(.+?)】\*\*\s*(.*)$")
BOLD_NOTE = re.compile(r"^\*\*(.+?)\*\*(.*)$")


def inline(s: str) -> str:
    """先转义，再认 **粗体** 和 `代码`。

    顺序不能反：先认标记再转义的话，正文里本来就有的 `<` 会被当成标签。
    """
    s = html.escape(s, quote=False)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    return s


def mmss(sec: int) -> str:
    return f"{sec // 60}:{sec % 60:02d}"


def blank_seg():
    return {"n": 0, "title": "", "start": 0, "end": 0, "dur": 0,
            "screen": "", "notes": [], "lines": []}


def parse(text: str):
    """切出「拍摄前」和八个正片段落。

    只认 `## 第 N 段 · 标题` 这种小标题。后面「录制注意事项」那张表不进来 ——
    那是拍完才看的东西，摆在提词器上只会挡路。
    """
    segments = []
    cur = None
    prep = None
    mode = None          # 'prep' | 'seg' | None
    i = 0
    lines = text.splitlines()

    while i < len(lines):
        ln = lines[i]

        m = SEG_HEAD.match(ln)
        if m:
            cur = blank_seg()
            cur["n"] = int(m.group(1))
            cur["title"] = m.group(2)
            segments.append(cur)
            mode = "seg"
            i += 1
            continue

        if PREP_HEAD.match(ln):
            prep = {"lines": []}
            mode = "prep"
            i += 1
            continue

        if ln.startswith("## "):
            mode = None
            i += 1
            continue

        if mode == "prep":
            if ln.startswith("|") or ln.startswith("```"):
                i += 1
                continue          # 表格式的行不进提词器，读不出节奏
            if ln.strip():
                prep["lines"].append(inline(ln.strip()))
            i += 1
            continue

        if mode != "seg":
            i += 1
            continue

        t = TIME_LINE.search(ln)
        if t:
            s = int(t.group(1)) * 60 + int(t.group(2))
            e = int(t.group(3)) * 60 + int(t.group(4))
            cur["start"], cur["end"], cur["dur"] = s, e, int(t.group(5))
            i += 1
            continue

        s = SCREEN_LINE.match(ln)
        if s:
            cur["screen"] = s.group(1).strip()
            i += 1
            continue

        a = ACTION_LINE.match(ln)
        if a:
            cur["notes"].append((a.group(1), inline(a.group(2).strip())))
            i += 1
            continue

        # 围栏代码块：`**【跑】** 一句说明` 下面那三行就是真正要敲的命令。
        # 不收的话提词器上只剩一句「停掉上一个模拟器，跑：」—— 跑什么没了。
        if ln.startswith("```"):
            i += 1
            code = []
            while i < len(lines) and not lines[i].startswith("```"):
                code.append(lines[i])
                i += 1
            i += 1                                   # 吃掉收尾那三个反引号
            body = "\n".join(code).strip("\n")
            if body:
                cur["notes"].append(("跑", html.escape(body, quote=False)))
            continue

        # 旁白：`> **旁白**` 之后**连着**的 `>` 行。碰到第一个不以 '>' 开头的
        # 行就停 —— 这是第二段引文（比如第 7 段末尾那条「拍摄提示」）的分界。
        if ln.startswith(">"):
            raw = []
            while i < len(lines) and lines[i].startswith(">"):
                body = lines[i][1:].strip()
                if body:
                    raw.append(body)
                i += 1
            # 第一行若是 **旁白** 这个小标题，丢掉它本身。
            # **必须对原串判**：先 inline 的话它会变成 <strong>旁白</strong>，
            # 就匹配不上了 —— 每个片段会平白多出一行念「旁白」的旁白。
            if raw and re.fullmatch(r"\*\*旁白\*\*", raw[0]):
                raw = raw[1:]
            if raw:
                cur["lines"].extend(inline(b) for b in raw)
            continue

        i += 1

    return prep, segments


PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DormMate 演示视频 · 分镜预演与提词器</title>
<style>
  :root {
    --bg: #14161a; --panel: #1c1f25; --panel2: #23272f;
    --ink: #e8eaed; --dim: #9aa3af; --line: #31363f;
    --hot: #e8834a; --calm: #4a9ee8; --ok: #4ec98a;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--ink);
    font: 16px/1.7 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
    display: flex; flex-direction: column; overflow: hidden;
  }
  header {
    display: flex; align-items: baseline; gap: 16px;
    padding: 12px 22px; background: var(--panel);
    border-bottom: 1px solid var(--line); flex: none;
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: .02em; }
  header .warn {
    font-size: 12px; color: var(--dim);
  }
  header .warn b { color: var(--hot); }
  .clock { margin-left: auto; display: flex; align-items: baseline; gap: 10px; }
  .clock .now { font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .clock .rest { font-size: 13px; color: var(--dim); font-variant-numeric: tabular-nums; }

  .bar { height: 4px; background: var(--panel2); display: flex; flex: none; }
  .bar i { display: block; height: 100%; background: var(--line); border-right: 1px solid var(--bg); }
  .bar i.done { background: var(--ok); }
  .bar i.live { background: var(--hot); }

  main { display: flex; flex: 1; min-height: 0; }

  nav {
    width: 268px; flex: none; background: var(--panel);
    border-right: 1px solid var(--line); overflow-y: auto; padding: 10px 0;
  }
  nav button {
    display: block; width: 100%; text-align: left; cursor: pointer;
    background: none; border: 0; border-left: 3px solid transparent;
    color: var(--dim); font: inherit; font-size: 13px; line-height: 1.45;
    padding: 8px 14px; display: flex; gap: 9px; align-items: flex-start;
  }
  nav button:hover { background: var(--panel2); color: var(--ink); }
  nav button.on { border-left-color: var(--hot); background: var(--panel2); color: var(--ink); }
  nav button .idx {
    flex: none; width: 20px; text-align: right; font-variant-numeric: tabular-nums;
    color: var(--dim); font-size: 12px; padding-top: 1px;
  }
  nav button.on .idx { color: var(--hot); }
  nav button .t { flex: 1; }
  nav button .d { flex: none; font-size: 11px; color: var(--dim); font-variant-numeric: tabular-nums; }

  section { flex: 1; display: flex; flex-direction: column; min-width: 0; }

  .stage { flex: 1; overflow-y: auto; padding: 22px 30px 8px; }
  .seg-title { font-size: 15px; color: var(--dim); margin: 0 0 4px; }
  .seg-title b { color: var(--hot); }
  .speak { margin: 0 0 20px; }
  .speak p {
    font-size: 25px; line-height: 1.62; margin: 0 0 14px; letter-spacing: .01em;
  }
  .cue {
    display: inline-block; margin: 0 0 6px;
    background: rgba(232,131,74,.14); color: var(--hot);
    border: 1px solid rgba(232,131,74,.35); border-radius: 999px;
    padding: 1px 11px; font-size: 13px; font-weight: 600;
  }
  .cue + p, .cue + div { margin-top: 2px; }
  .cue-note { font-size: 17px; color: var(--dim); margin: 0 0 16px; }
  .cue-note code { color: #cfd6e0; }

  aside {
    flex: none; border-top: 1px solid var(--line); background: var(--panel);
    padding: 12px 30px 16px; max-height: 34vh; overflow-y: auto;
  }
  aside h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: .12em;
    color: var(--dim); margin: 0 0 7px; font-weight: 600;
  }
  aside .screen { font-size: 16px; margin: 0 0 12px; }
  aside .screen code { color: #cfd6e0; background: var(--panel2); padding: 1px 5px; border-radius: 3px; }
  aside .cmd {
    font-family: Consolas, "Cascadia Mono", monospace; font-size: 14px;
    background: var(--panel2); border-left: 3px solid var(--calm);
    padding: 8px 12px; border-radius: 0 4px 4px 0; margin: 0 0 8px;
    white-space: pre-wrap; word-break: break-all;
  }
  aside .act { font-size: 15px; color: var(--dim); margin: 0 0 6px; }
  aside .act b { color: var(--ok); }

  footer {
    flex: none; display: flex; align-items: center; gap: 10px;
    padding: 10px 30px; border-top: 1px solid var(--line); background: var(--panel);
  }
  footer button {
    font: inherit; font-size: 14px; cursor: pointer;
    background: var(--panel2); color: var(--ink);
    border: 1px solid var(--line); border-radius: 6px; padding: 6px 16px;
  }
  footer button:hover { border-color: var(--dim); }
  footer button.go { background: var(--hot); border-color: var(--hot); color: #14161a; font-weight: 700; }
  footer kbd {
    font: inherit; font-size: 12px; background: var(--panel2);
    border: 1px solid var(--line); border-bottom-width: 2px;
    border-radius: 4px; padding: 1px 6px; color: var(--dim);
  }
  footer .hint { margin-left: auto; color: var(--dim); font-size: 12px; }
  footer label { color: var(--dim); font-size: 13px; display: flex; align-items: center; gap: 6px; }

  .empty { color: var(--dim); padding: 40px 0; }
</style>
</head>
<body>
<header>
  <h1>DormMate 演示视频 · 分镜预演与提词器</h1>
  <span class="warn">这是<b>提词器</b>，不是视频 —— 画面得你自己录</span>
  <span class="clock"><span class="now" id="now">0:00</span><span class="rest" id="rest">/ 7:00</span></span>
</header>
<div class="bar" id="bar"></div>

<main>
  <nav id="nav"></nav>
  <section>
    <div class="stage" id="stage"></div>
    <aside>
      <h2>屏幕画面</h2>
      <div class="screen" id="screen"></div>
      <h2 style="margin-top:10px">这一段要做的</h2>
      <div id="acts"></div>
    </aside>
    <footer>
      <button id="play" class="go">开始</button>
      <button id="prev">上一段</button>
      <button id="next">下一段</button>
      <label><input type="checkbox" id="loop"> 到点自动停</label>
      <span class="hint"><kbd>空格</kbd> 开始/暂停　<kbd>←</kbd><kbd>→</kbd> 换段　<kbd>R</kbd> 归零</span>
    </footer>
  </section>
</main>

<script>
const SEGMENTS = __SEGMENTS__;
const PREP = __PREP__;
const TOTAL = __TOTAL__;

const el = {
  nav: document.getElementById('nav'),
  stage: document.getElementById('stage'),
  screen: document.getElementById('screen'),
  acts: document.getElementById('acts'),
  now: document.getElementById('now'),
  rest: document.getElementById('rest'),
  bar: document.getElementById('bar'),
  play: document.getElementById('play'),
  prev: document.getElementById('prev'),
  next: document.getElementById('next'),
  loop: document.getElementById('loop'),
};

function mmss(s) {
  s = Math.max(0, Math.round(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

let idx = 0, elapsed = 0, playing = false, raf = 0, last = 0;

function segAt(t) {
  for (let i = 0; i < SEGMENTS.length; i++) {
    if (t < SEGMENTS[i].end) return i;
  }
  return SEGMENTS.length - 1;
}

function renderNav() {
  el.nav.innerHTML = '';
  const mk = (label, sub, i, dur) => {
    const b = document.createElement('button');
    b.innerHTML = '<span class="idx">' + label + '</span>'
      + '<span class="t">' + sub + '</span>'
      + '<span class="d">' + dur + '</span>';
    b.addEventListener('click', () => { idx = i; elapsed = segStart(i); draw(); });
    el.nav.appendChild(b);
    return b;
  };
  el.nav.appendChild(mk('·', '开拍前：起进程与三个坑', -1, ''));
  SEGMENTS.forEach((s, i) => mk(String(s.n), s.title, i, mmss(s.dur)));
}

function segStart(i) { return i < 0 ? 0 : SEGMENTS[i].start; }

function renderBar() {
  el.bar.innerHTML = '';
  SEGMENTS.forEach(s => {
    const i = document.createElement('i');
    i.style.flex = String(s.dur);
    el.bar.appendChild(i);
  });
}

function paintBar() {
  const live = segAt(elapsed);
  [...el.bar.children].forEach((n, i) => {
    n.className = i < live ? 'done' : (i === live ? 'live' : '');
  });
}

function renderStage() {
  if (idx < 0) {
    el.stage.innerHTML = '<p class="seg-title"><b>开拍前</b>（不录）</p>'
      + '<div class="speak">' + PREP.map(p => '<p>' + p + '</p>').join('') + '</div>';
    el.screen.innerHTML = '四个标签页：dashboard / three / mobile / web，都留在那儿随时切。';
    el.acts.innerHTML = '';
    return;
  }
  const s = SEGMENTS[idx];
  const when = mmss(s.start) + ' – ' + mmss(s.end) + '（' + s.dur + ' 秒）';
  let h = '<p class="seg-title"><b>第 ' + s.n + ' 段</b> · ' + s.title
    + '　<span style="opacity:.6">' + when + '</span></p>';
  h += '<div class="speak">';
  s.lines.forEach(line => {
    const m = line.match(/^【(.+?)】(.*)$/);
    if (m) {
      h += '<div class="cue">' + m[1] + '</div>';
      if (m[2].trim()) h += '<p>' + m[2].trim() + '</p>';
    } else {
      h += '<p>' + line + '</p>';
    }
  });
  h += '</div>';
  el.stage.innerHTML = h;

  el.screen.innerHTML = s.screen || '——';

  let a = '';
  // 按原文顺序摆：有的段先是【动作】"停掉上一个模拟器，跑："、后面才跟命令块。
  // 把命令全提到前面去的话，那句说明就跑到命令下面了，读着像倒装。
  s.notes.forEach(n => {
    a += n[0] === '跑'
      ? '<div class="cmd">' + n[1] + '</div>'
      : '<p class="act"><b>【' + n[0] + '】</b>' + n[1] + '</p>';
  });
  el.acts.innerHTML = a || '<p class="act" style="opacity:.6">这一段不用跑命令。</p>';
  el.stage.scrollTop = 0;
}

function draw() {
  const live = playing ? segAt(elapsed) : idx;
  idx = live < 0 ? -1 : live;
  renderStage();
  el.now.textContent = mmss(elapsed);
  el.rest.textContent = '/ ' + mmss(TOTAL);
  paintBar();
  [...el.nav.children].forEach((n, i) => {
    n.classList.toggle('on', i - 1 === idx);
  });
  el.play.textContent = playing ? '暂停' : (elapsed === 0 ? '开始' : '继续');
  el.play.classList.toggle('go', !playing);
}

function tick(ts) {
  if (!playing) return;
  if (!last) last = ts;
  elapsed += (ts - last) / 1000;
  last = ts;
  if (elapsed >= TOTAL) {
    elapsed = TOTAL;
    playing = false;
    last = 0;
    draw();
    return;
  }
  draw();
  raf = requestAnimationFrame(tick);
}

function play() {
  if (elapsed >= TOTAL) elapsed = 0;
  playing = true; last = 0;
  raf = requestAnimationFrame(tick);
  draw();
}
function pause() {
  playing = false; last = 0;
  cancelAnimationFrame(raf);
  draw();
}
function goto(i) {
  idx = Math.max(-1, Math.min(SEGMENTS.length - 1, i));
  const s = idx < 0 ? 0 : SEGMENTS[idx].start;
  elapsed = playing ? elapsed : s;
  if (playing) { elapsed = Math.max(elapsed, s); }
  draw();
}

el.play.addEventListener('click', () => playing ? pause() : play());
el.next.addEventListener('click', () => goto(idx + 1));
el.prev.addEventListener('click', () => goto(idx - 1));
el.loop.addEventListener('change', () => {});

document.addEventListener('keydown', e => {
  if (e.key === ' ') { e.preventDefault(); playing ? pause() : play(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); goto(idx + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); goto(idx - 1); }
  else if (e.key === 'r' || e.key === 'R') {
    playing = false; cancelAnimationFrame(raf);
    last = 0; elapsed = 0; idx = 0; draw();
  }
});

renderNav();
renderBar();
draw();
</script>
</body>
</html>
"""


def main() -> int:
    text = SRC.read_text(encoding="utf-8")
    prep, segments = parse(text)

    if len(segments) != 8:
        sys.exit(f"[停手] 数出来 {len(segments)} 段（要 8 段）—— 标题格式变了？")

    total = sum(s["dur"] for s in segments)
    if total != 420:
        sys.exit(f"[停手] 八段加起来 {total} 秒（要 420 秒 = 7 分 00 秒）")

    # 起止时间必须首尾相接、且和总长对得上 —— 对不上说明脚本里改过时间没改全
    t = 0
    for s in segments:
        if s["start"] != t:
            sys.exit(f"[停手] 第 {s['n']} 段起始写的是 {s['start']} 秒，"
                     f"但上一段到 {t} 秒就结束了")
        if s["end"] - s["start"] != s["dur"]:
            sys.exit(f"[停手] 第 {s['n']} 段的时长和起止对不上")
        if not s["lines"]:
            sys.exit(f"[停手] 第 {s['n']} 段没有旁白")
        if not s["screen"]:
            sys.exit(f"[停手] 第 {s['n']} 段没有写屏幕画面")
        t = s["end"]

    # 标记没被认掉的话，页面上会原样冒出 `**` 和反引号 —— 页面照样打得开，
    # 只有念到那一行才发现。上一版就是这么漏的（旁白没走 inline）。
    for s in segments:
        for line in s["lines"]:
            if "**" in line or "`" in line:
                sys.exit(f"[停手] 第 {s['n']} 段旁白里还剩标记：{line[:40]!r}")
        for kind, body in s["notes"]:
            if "**" in body:
                sys.exit(f"[停手] 第 {s['n']} 段的【{kind}】里还剩 **：{body[:40]!r}")

    import json
    page = (PAGE
            .replace("__SEGMENTS__", json.dumps(segments, ensure_ascii=False))
            .replace("__PREP__", json.dumps(prep["lines"] if prep else [],
                                            ensure_ascii=False))
            .replace("__TOTAL__", str(total)))
    OUT.write_text(page, encoding="utf-8")

    print(f"读    -> {SRC}（{len(text.splitlines())} 行）")
    print(f"写    -> {OUT}（{len(page)} 字符）")
    print(f"八段    {total} 秒 = {mmss(total)}")
    for s in segments:
        print(f"  第 {s['n']} 段 {mmss(s['start'])}–{mmss(s['end'])} "
              f"{s['dur']:>3}秒  旁白 {len(s['lines']):>2} 行  {s['title']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
