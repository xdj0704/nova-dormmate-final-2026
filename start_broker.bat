@echo off
REM 本文件必须是 GBK 编码 + CRLF 行尾，且刻意不写 chcp 65001。
REM 原因：cmd.exe 按字节追踪自己在批处理里的位置。文件编码和控制台
REM 代码页不一致，或中途 chcp 切代码页，都会让它把后面的行劈开 ——
REM 症状是 REM 变成 EM、netsh 那行被截成两截，报一串"不是内部或外部命令"。
REM 实测用 UTF-8 + chcp 65001 + LF 时，三个 .bat 各有 6/6/2 处解析错误。
REM 启动本机 Mosquitto：1883(TCP) + 9001(WebSocket)
REM 若提示找不到 mosquitto，先安装：winget install --id EclipseFoundation.Mosquitto -e
cd /d "%~dp0"
mosquitto -c mosquitto\dormmate.conf -v
pause
