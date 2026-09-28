@echo off
REM 本文件必须是 GBK 编码 + CRLF 行尾，且刻意不写 chcp 65001。
REM 原因：cmd.exe 按字节追踪自己在批处理里的位置。文件编码和控制台
REM 代码页不一致，或中途 chcp 切代码页，都会让它把后面的行劈开 ——
REM 症状是 REM 变成 EM、netsh 那行被截成两截，报一串"不是内部或外部命令"。
REM 实测用 UTF-8 + chcp 65001 + LF 时，三个 .bat 各有 6/6/2 处解析错误。
REM 启动静态服务器，然后浏览器打开 http://localhost:8000/web/
REM
REM 注意根目录是【项目根】不是 web\：页面用 <script src="../shared/rules.js">
REM 引规则文件，服务器根必须是项目根，否则 ../ 会越过 web\ 这层、
REM 被 http.server 拒绝访问，rules.js 直接 404，手动录入就没结果。
REM
REM --bind 0.0.0.0：监听所有网卡，手机 / 别的电脑才能用局域网地址打开看板。
REM 代价是这个目录（含配置和测试）对同局域网公开 —— 只想本机用就改回
REM --bind 127.0.0.1。
REM 另外防火墙默认拦入站，首次要在管理员下双击一次 open_firewall.bat，
REM 否则绑了 0.0.0.0 手机照样打不开。
REM
REM 页面里的 broker 地址按访问地址自己拼（web/script.js 的 brokerUrl()），
REM 手机打开就是 ws://<本机IP>:9001，不用改代码。
cd /d "%~dp0"
REM 用 py -3.14 而不是 python：项目统一到 64 位解释器，
REM PATH 上的 python 是 32 位的那个（装不了 pandas）。
start "" http://localhost:8000/web/
echo 本机局域网地址（手机 / 别的电脑访问时用下面这个 IPv4）：
ipconfig | findstr /i "IPv4"
echo.
echo 手机浏览器打开： http://^<上面的 IPv4^>:8000/web/
echo.
py -3.14 -m http.server 8000 --bind 0.0.0.0 --directory .
pause
