@echo off
REM 本文件必须是 GBK 编码 + CRLF 行尾，且刻意不写 chcp 65001。
REM 原因：cmd.exe 按字节追踪自己在批处理里的位置。文件编码和控制台
REM 代码页不一致，或中途 chcp 切代码页，都会让它把后面的行劈开 ——
REM 症状是 REM 变成 EM、netsh 那行被截成两截，报一串"不是内部或外部命令"。
REM 实测用 UTF-8 + chcp 65001 + LF 时，三个 .bat 各有 6/6/2 处解析错误。
REM 放行看板的入站端口，好让手机 / 别的电脑打开 http://<本机IP>:8000/web/
REM
REM 为什么需要这个：把服务绑到 0.0.0.0 只是"网卡上听得见"，
REM Windows 防火墙默认仍然拦入站连接，手机照样打不开。
REM 加防火墙规则要管理员权限，所以这个脚本会自己申请提升。
REM
REM 只开看板要用的两个端口：
REM   8000  静态服务器（页面本身）
REM   9001  MQTT over WebSocket（页面的实时数据）
REM
REM 1883（MQTT / TCP）故意没开：它现在允许匿名连接（课程演示配置），
REM 开到局域网等于同一个 WiFi 下谁都能发布和订阅。M5 多节点真的需要
REM 别的机器往这里发数据时，再手动执行下面这行：
REM   netsh advfirewall firewall add rule name="DormMate 1883" dir=in action=allow protocol=TCP localport=1883

REM 已经是管理员就直接往下走，否则用 PowerShell 提权重开自己
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo 需要管理员权限，正在申请提升，请在弹出的窗口里点「是」...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo 正在放行入站端口...
REM 先删同名规则再建，重复执行不会堆出一串重复项
for %%P in (8000 9001) do (
    netsh advfirewall firewall delete rule name="DormMate %%P" >nul 2>&1
    netsh advfirewall firewall add rule name="DormMate %%P" dir=in action=allow protocol=TCP localport=%%P >nul
    if errorlevel 1 (
        echo   端口 %%P 放行失败
    ) else (
        echo   端口 %%P 已放行
    )
)

echo.
echo 当前规则：
netsh advfirewall firewall show rule name=all | findstr /i "DormMate"
echo.
echo 本机局域网地址（手机访问时用下面这个 IPv4）：
ipconfig | findstr /i "IPv4"
echo.
echo 手机浏览器打开： http://^<上面的 IPv4^>:8000/web/
echo.
echo 撤销（演示完把端口关回去）：
echo   netsh advfirewall firewall delete rule name="DormMate 8000"
echo   netsh advfirewall firewall delete rule name="DormMate 9001"
echo.
pause
