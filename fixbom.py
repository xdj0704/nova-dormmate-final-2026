"""把源码里字面的 U+FEFF 换成可见的转义 \\uFEFF。

源码里放一个隐形的 BOM 字符，肉眼看着就是一对空引号，review 时根本看不出
那里有东西；文件一旦被按 GBK 另存就会损坏。所以统一写成转义形式。

    python fixbom.py web/script.js web/index.html

没有任何字面 BOM 时原样跳过，重复执行也安全。
"""
import sys

ESCAPE = chr(0x5C) + 'uFEFF'      # 反斜杠 + uFEFF，即源码里的 '\uFEFF'
LITERAL = chr(0xFEFF)

changed = 0
for path in sys.argv[1:]:
    # newline='' 读写都用：不做换行翻译，CR/LF 原样保留
    with open(path, encoding='utf-8', newline='') as f:
        src = f.read()

    count = src.count(LITERAL)
    if count == 0:
        print(f'{path}: 没有字面 BOM，跳过')
        continue

    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(src.replace(LITERAL, ESCAPE))
    changed += count
    print(f'{path}: 替换 {count} 处')

print(f'共替换 {changed} 处')
