@echo off
chcp 65001 >nul
REM 启动本机 Mosquitto：1883(TCP) + 9001(WebSocket)
REM 若提示找不到 mosquitto，先安装：winget install --id EclipseFoundation.Mosquitto -e
cd /d "%~dp0"
mosquitto -c mosquitto\dormmate.conf -v
pause
