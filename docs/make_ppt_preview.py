# -*- coding: utf-8 -*-
"""把 docs/ppt-copy.md 渲染成一个能翻页的 HTML 预览。

为什么要有这个脚本，而不是手写一份 HTML：

    ppt-copy.md 是**唯一**的一份内容。手抄一份 HTML 出来，两份迟早不一样 ——
    这和项目里「报告结果禁止手工修改、制品一律由脚本从输入现算」是同一条规矩。
    所以 ppt-preview.html 是**产物**：改了文案就重跑这个脚本，别去改 HTML。

它只认 ppt-copy.md 实际用到的那几种写法（## / ### / 表格 / 列表 / 引用 /
围栏代码 / 分隔线 / 粗体 / 行内代码 / 链接），不是通用 Markdown 实现。

用法：
    py -3.14 docs/make_ppt_preview.py

输出：
    docs/ppt-preview.html
"""
import html
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "ppt-copy.md"
OUT = HERE / "ppt-preview.html"

# 文案里点名的两张配图，出现在哪一页就在那一页末尾嵌进来
FIGURES = ("ppt-architecture.svg", "ppt-event-fsm.svg")

COUNT_RE = re.compile(r"^第 (\d+) 页")


# ------------------------------------------------------------------ 行内

def inline(text: str) -> str:
    """行内标记。先把行内代码挖出来占位，免得代码里的 * 或 [ 被后面的规则误伤。"""
    text = html.escape(text, quote=False)

    codes = []

    def stash(m):
        codes.append(m.group(1))
        return f"\x00{len(codes) - 1}\x00"

    text = re.sub(r"`([^`]+)`", stash, text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)
    text = re.sub(r"\x00(\d+)\x00", lambda m: f"<code>{codes[int(m.group(1))]}</code>", text)
    return text


# ------------------------------------------------------------------ 块

def split_row(line: str):
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def is_sep_row(line: str) -> bool:
    return bool(re.match(r"^\|[\s:|-]+\|$", line.strip()))


def render_table(rows):
    head = split_row(rows[0])
    body = [split_row(r) for r in rows[2:]] if len(rows) > 1 else []
    out = ['<table>', "<thead><tr>"]
    out += [f"<th>{inline(c)}</th>" for c in head]
    out += ["</tr></thead><tbody>"]
    for r in body:
        out.append("<tr>")
        for i in range(len(head)):
            cell = r[i] if i < len(r) else ""
            out.append(f"<td>{inline(cell)}</td>")
        out.append("</tr>")
    out += ["</tbody></table>"]
    return "".join(out)


def render_list(items):
    """items 是 (缩进, 文本) 的列表。两级以内够用了，多出来的层级也照这个规则拍平。"""
    if not items:
        return ""
    base = min(ind for ind, _ in items)
    out, open_ul, depth = [], False, 0
    for ind, text in items:
        level = 1 if ind <= base else 2
        if level > depth:
            out.append("<ul>")
            open_ul, depth = True, level
        elif level < depth:
            out.append("</ul>")
            depth = level
        out.append(f"<li>{inline(text)}</li>")
    while depth > 0:
        out.append("</ul>")
        depth -= 1
    return "".join(out)


def absorb_continuation(lines, i, text, indent):
    """把列表项的续行并回来。

    文案里出现过这种写法：

        - **一句立命之本**：……。**新写的三个页面拿到的是算好的结论，
          不是原材料** —— 所以它们永远不会对……有分歧。

    粗体是**跨行**的。只按单行渲染的话末尾那个 `**` 找不到配对的，
    就会原样印在页面上（星号上屏）—— 这正是这个项目最不能忍的一类东西。
    """
    while i < len(lines):
        nxt = lines[i]
        ns = nxt.strip()
        if not ns:
            break                                   # 空行收尾
        if re.match(r"^(#{1,6}\s|>|\||\d+\.\s)", ns) or ns.startswith("```") or ns == "---":
            break                                   # 换块了
        if ns.startswith("- "):
            break                                   # 同级的下一条，或者更深的子项，都交给下一轮
        text += " " + ns
        i += 1
    return text, i


def render_blocks(lines, first_line_no: int, warn):
    out, i = [], 0
    while i < len(lines):
        raw, s = lines[i], lines[i].strip()

        if not s:
            i += 1
            continue

        # 围栏代码
        if s.startswith("```"):
            i += 1
            buf = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            if i >= len(lines):
                warn(f"第 {first_line_no} 行起有个代码块没有收尾")
            i += 1
            out.append("<pre><code>" + html.escape("\n".join(buf)) + "</code></pre>")
            continue

        # 表格
        if s.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(lines[i])
                i += 1
            if len(rows) < 2 or not is_sep_row(rows[1]):
                warn(f"第 {first_line_no} 行起那张表没有分隔行，照原样当段落处理")
                out.append("<p>" + inline(s) + "</p>")
                continue
            out.append(render_table(rows))
            continue

        if s == "---":
            out.append("<hr>")
            i += 1
            continue

        # 引用（内部可以再有块）
        if s.startswith(">"):
            depth = 0
            while i < len(lines) and lines[i].strip().startswith(">"):
                depth += 1
                i += 1
            inner = [re.sub(r"^\s*>\s?", "", x) for x in lines[i - depth:i]]
            out.append("<blockquote>" + render_blocks(inner, first_line_no, warn) + "</blockquote>")
            continue

        # 标题
        m = re.match(r"^(#{1,6})\s+(.*)$", s)
        if m:
            n = len(m.group(1))
            out.append(f"<h{n}>{inline(m.group(2))}</h{n}>")
            i += 1
            continue

        # 有序列表
        if re.match(r"^\d+\.\s", s):
            items = []
            while i < len(lines) and re.match(r"^\s*\d+\.\s", lines[i]):
                text = re.sub(r"^\s*\d+\.\s", "", lines[i])
                i += 1
                text, i = absorb_continuation(lines, i, text, 0)
                items.append(text)
            out.append("<ol>" + "".join(f"<li>{inline(t)}</li>" for t in items) + "</ol>")
            continue

        # 无序列表（带缩进层级）
        if s.startswith("- "):
            items = []
            while i < len(lines):
                t = lines[i]
                if not t.strip().startswith("- "):
                    break
                ind = len(t) - len(t.lstrip())
                text = t.strip()[2:]
                i += 1
                text, i = absorb_continuation(lines, i, text, ind)
                items.append((ind, text))
            out.append(render_list(items))
            continue

        # 段落
        buf = [s]
        i += 1
        while i < len(lines):
            t = lines[i].strip()
            if not t or re.match(r"^(#{1,6}\s|>|\||-\s|\d+\.\s)", t) or t.startswith("```") or t == "---":
                break
            buf.append(t)
            i += 1
        out.append("<p>" + inline(" ".join(buf)) + "</p>")

    return "".join(out)


# ------------------------------------------------------------------ 幻灯片

def slug_len(text: str) -> int:
    return len(re.sub(r"\s", "", text))


def build_slides(md: str, warn):
    lines = md.splitlines()

    heads = [(i, l) for i, l in enumerate(lines) if l.startswith("## ")]
    if not heads:
        sys.exit("[停手] ppt-copy.md 里一个 '## ' 都没有，先看看文件是不是空的")

    slides = []

    # 封面：第一个 ## 之前的那一段（# 标题 + 说明）
    pre = lines[:heads[0][0]]
    if any(x.strip() and not x.strip().startswith("<!--") for x in pre):
        title = next((x[2:].strip() for x in pre if x.startswith("# ")), "封面")
        slides.append({"kind": "cover", "title": title, "mb": title,
                       "body": render_blocks(pre, 1, warn)})

    for n, (idx, head) in enumerate(heads):
        end = heads[n + 1][0] if n + 1 < len(heads) else len(lines)
        title = head[3:].strip()
        body_lines = lines[idx + 1:end]
        m = COUNT_RE.match(title)
        if m:
            kind, label = "page", f"第 {m.group(1)} 页"
        elif title.startswith("附："):
            kind, label = "appendix", "附录"
        else:
            kind, label = "note", "讲述纪律"
        slides.append({"kind": kind, "title": title, "label": label,
                       "body": render_blocks(body_lines, idx + 2, warn)})

    # 文案里点名的 SVG，出现在哪一页就把图嵌到那一页末尾。
    # 只认正文页（「第 N 页」）：文件头那两句「ppt-architecture.svg → 第 3 页」是在
    # 告诉人图放哪儿，不是在说「把图贴到封面来」。封面是第一个 ## 之前那一段，
    # 它把这两条指引原样收着 —— 不排掉的话两张图会同时贴到封面上（试过，很难看）。
    for s in slides:
        if s["kind"] != "page":
            continue
        for fig in FIGURES:
            if fig in s["body"]:
                s["body"] += (
                    '<figure class="fig">'
                    f'<img src="{fig}" alt="{fig}">'
                    f'<figcaption>{fig}　（点图可看原尺寸）</figcaption>'
                    "</figure>"
                )

    return slides


# ------------------------------------------------------------------ 模板

PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{doctitle}</title>
<!-- 这个文件是 docs/make_ppt_preview.py 从 docs/ppt-copy.md 生成的产物。
     别手改这里 —— 改了文案就重跑那个脚本。 -->
<style>
:root {{
  color-scheme: light;
  --page: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --ink-3: #898781;
  --hairline: #e1e0d9;
  --blue: #2a78d6;
  --blue-bg: #e8f0fc;
  --mag: #a33066;
  --good: #0a7a0a;
  --serious: #b04a12;
  --critical: #d03b3b;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
          "Microsoft YaHei", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}}

* {{ box-sizing: border-box; }}

html, body {{
  margin: 0; padding: 0; height: 100%;
  background: var(--page); color: var(--ink);
  font-family: var(--sans); font-size: 16px; line-height: 1.62;
}}

/* 顶部工具栏 */
#bar {{
  position: fixed; inset: 0 0 auto 0; height: 46px; z-index: 10;
  display: flex; align-items: center; gap: 14px; padding: 0 16px;
  background: var(--surface); border-bottom: 1px solid var(--hairline);
}}
#bar .brand {{ font-weight: 700; font-size: 14px; }}
#bar .hint {{ color: var(--ink-3); font-size: 12px; }}
#bar .spacer {{ flex: 1; }}
#bar button {{
  font: inherit; font-size: 12.5px; padding: 5px 12px; cursor: pointer;
  color: var(--ink-2); background: var(--page);
  border: 1px solid var(--hairline); border-radius: 999px;
}}
#bar button:hover {{ border-color: var(--blue); color: var(--blue); }}

/* 幻灯片容器 */
#deck {{ height: 100%; padding: 46px 0 0; }}
.slide {{
  display: none; height: 100%; overflow: auto; padding: 34px 56px 64px;
}}
.slide.on {{ display: block; }}

.slide h1 {{ font-size: 34px; line-height: 1.3; margin: 0 0 6px; }}
.slide h2 {{ font-size: 27px; line-height: 1.32; margin: 0 0 18px; }}
.slide h3 {{ font-size: 19px; margin: 22px 0 8px; }}

.slide .tag {{
  display: inline-block; margin-bottom: 10px; padding: 3px 12px;
  font-size: 12px; font-weight: 700; border-radius: 999px;
  color: #1c5bab; background: var(--blue-bg); border: 1px solid var(--blue);
}}
.slide.kind-cover .tag {{ color: var(--mag); background: #fbe9f1; border-color: #c9407f; }}
.slide.kind-note .tag,
.slide.kind-appendix .tag {{ color: var(--ink-2); background: #f0efec; border-color: var(--ink-3); }}

.slide p {{ margin: 0 0 12px; max-width: 62em; }}
.slide ul, .slide ol {{ margin: 0 0 14px; padding-left: 24px; }}
.slide li {{ margin-bottom: 5px; }}
.slide li > ul {{ margin-top: 5px; }}

.slide blockquote {{
  margin: 14px 0; padding: 10px 16px; max-width: 62em;
  border-left: 3px solid var(--hairline); border-radius: 0 8px 8px 0;
  background: var(--surface); color: var(--ink-2);
}}
.slide blockquote p:last-child {{ margin-bottom: 0; }}

.slide code {{
  font-family: var(--mono); font-size: 0.88em;
  background: #f1f0ec; padding: 1px 5px; border-radius: 4px;
}}
.slide pre {{
  margin: 14px 0; padding: 14px 16px; overflow-x: auto;
  background: var(--surface); border: 1px solid var(--hairline); border-radius: 10px;
}}
.slide pre code {{ background: none; padding: 0; font-size: 12.5px; line-height: 1.65; }}

.slide table {{
  border-collapse: collapse; margin: 14px 0; font-size: 14px; max-width: 100%;
}}
.slide th, .slide td {{
  border: 1px solid var(--hairline); padding: 7px 11px; text-align: left;
  vertical-align: top;
}}
.slide th {{ background: var(--surface); font-weight: 700; white-space: nowrap; }}
.slide tbody tr:nth-child(even) td {{ background: #fcfcfa; }}

.slide hr {{ margin: 22px 0; border: 0; border-top: 1px solid var(--hairline); }}
.slide a {{ color: var(--blue); }}

.slide .fig {{ margin: 18px 0 0; }}
.slide .fig img {{
  width: 100%; max-width: 1180px; height: auto; display: block;
  border: 1px solid var(--hairline); border-radius: 10px; background: var(--surface);
}}
.slide .fig figcaption {{ margin-top: 7px; color: var(--ink-3); font-size: 12px; }}

/* 页脚 */
#foot {{
  position: fixed; inset: auto 0 0 0; height: 30px; z-index: 10;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 16px; background: var(--surface); border-top: 1px solid var(--hairline);
  color: var(--ink-3); font-size: 11.5px;
}}

/* 左右两块点击区 */
.zone {{
  position: fixed; top: 46px; bottom: 30px; width: 14%; z-index: 5;
  cursor: pointer; opacity: 0; transition: opacity .15s;
}}
.zone:hover {{ opacity: 1; background: linear-gradient(to right, rgba(42,120,214,.10), transparent); }}
#zr {{ right: 0; }}
#zr:hover {{ background: linear-gradient(to left, rgba(42,120,214,.10), transparent); }}
#zl {{ left: 0; }}
#zl:hover {{ background: linear-gradient(to right, rgba(42,120,214,.10), transparent); }}
.zone span {{
  position: absolute; top: 50%; transform: translateY(-50%);
  font-size: 26px; color: var(--blue);
}}
#zl span {{ left: 14px; }}
#zr span {{ right: 14px; }}

/* 打印 / 导出 PDF：所有页摊开 */
@media print {{
  @page {{ size: A4 landscape; margin: 10mm; }}
  #bar, #foot, .zone {{ display: none !important; }}
  #deck {{ height: auto; padding: 0; }}
  .slide {{ display: block !important; height: auto; overflow: visible;
            padding: 0 0 18mm; page-break-after: always; font-size: 12.5px; }}
  .slide:last-child {{ page-break-after: auto; }}
  .slide h1 {{ font-size: 26px; }}
  .slide h2 {{ font-size: 21px; }}
  .slide h3 {{ font-size: 15px; }}
  .slide table {{ font-size: 10.5px; }}
  .slide pre code {{ font-size: 9.5px; }}
  .slide .fig img {{ max-width: 100%; }}
}}
</style>
</head>
<body>

<div id="bar">
  <span class="brand">{doctitle}</span>
  <span class="hint">← → 翻页　·　点左右两侧也行　·　Home / End 跳首尾</span>
  <span class="spacer"></span>
  <button type="button" onclick="window.print()">打印 / 导出 PDF</button>
</div>

<div class="zone" id="zl" onclick="step(-1)" title="上一页"><span>‹</span></div>
<div class="zone" id="zr" onclick="step(1)" title="下一页"><span>›</span></div>

<div id="deck">
{slides}
</div>

<div id="foot">
  <span>本页内容由 <code>docs/ppt-copy.md</code> 生成 —— 改文案请改那份，别改这里</span>
  <span id="pos"></span>
</div>

<script>
var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
var cur = 0;

function show(n) {{
  if (n < 0) n = 0;
  if (n > slides.length - 1) n = slides.length - 1;
  slides[cur].classList.remove('on');
  cur = n;
  slides[cur].classList.add('on');
  slides[cur].scrollTop = 0;
  document.getElementById('pos').textContent =
    (cur + 1) + ' / ' + slides.length + '　·　' + slides[cur].dataset.label;
  if (location.hash !== '#' + (cur + 1)) {{
    history.replaceState(null, '', '#' + (cur + 1));
  }}
}}

function step(d) {{ show(cur + d); }}

document.addEventListener('keydown', function (e) {{
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {{
    e.preventDefault(); step(1);
  }} else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {{
    e.preventDefault(); step(-1);
  }} else if (e.key === 'Home') {{ e.preventDefault(); show(0); }}
  else if (e.key === 'End') {{ e.preventDefault(); show(slides.length - 1); }}
}});

var start = parseInt((location.hash || '').slice(1), 10);
show(isNaN(start) ? 0 : start - 1);
</script>
</body>
</html>
"""


def main() -> int:
    if not SRC.exists():
        sys.exit(f"[停手] 找不到 {SRC}")

    raw = SRC.read_text(encoding="utf-8")
    warnings = []
    slides = build_slides(raw, warnings.append)

    if not slides:
        sys.exit("[停手] 一页都没解析出来，什么都没写")

    pages = [s for s in slides if s["kind"] == "page"]
    if len(pages) != 14:
        sys.exit(f"[停手] 解析出 {len(pages)} 个「第 N 页」（要 14 个），先看看文案改了什么")

    # 两张 SVG 各自只该嵌一次。多嵌一次多半就是又被贴到封面上了 —— 这种错不报，
    # 页面照样打得开，只有翻到第一屏才发现多了一大块。
    for fig in FIGURES:
        host = [s["title"] for s in slides if f'<img src="{fig}"' in s["body"]]
        if len(host) != 1:
            sys.exit(f"[停手] {fig} 嵌到了 {len(host)} 页上（要 1 页）：{host}")

    # 兜底：标记没配对的话，星号 / 反引号会**原样印在幻灯片上**。
    # 已经踩过一次（跨行粗体），所以宁可停手也不写出去。代码块里出现 ** 是合法的，先摘掉。
    for s in slides:
        probe = re.sub(r"<pre>.*?</pre>", "", s["body"], flags=re.S)
        for bad, what in (("**", "粗体"), ("`", "行内代码")):
            if bad in probe:
                ctx = probe[max(0, probe.index(bad) - 60):probe.index(bad) + 60]
                sys.exit(f"[停手] 「{s['title']}」里有一处{what}标记没配对，"
                         f"{bad!r} 会原样印在页面上：\n    …{ctx}…")

    doctitle = next((l[2:].strip() for l in raw.splitlines() if l.startswith("# ")), "DormMate PPT")

    body = []
    for s in slides:
        label = s.get("label") or s["title"]
        body.append(
            f'<section class="slide kind-{s["kind"]}" data-label="{html.escape(label)}">\n'
            f'<span class="tag">{html.escape(label)}</span>\n'
            f'{s["body"]}\n'
            f"</section>\n"
        )

    OUT.write_text(PAGE.format(doctitle=html.escape(doctitle), slides="".join(body)),
                   encoding="utf-8", newline="\n")

    for w in warnings:
        print("  [注意]", w)
    print(f"读入    -> {SRC}")
    print(f"写出    -> {OUT}")
    print(f"幻灯片 {len(slides)} 页（正文 {len(pages)} 页 + 封面 / 纪律 / 附录）"
          f"  {OUT.stat().st_size} 字节")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
