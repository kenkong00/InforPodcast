@echo off
title 信息聚合网站 - 启动器
cd /d "%~dp0"

echo ==============================================
echo   信息聚合网站   http://localhost:5199
echo ==============================================
echo.

rem ---- 0) 端口已被占用：服务多半已经在跑了，直接开浏览器 ----
netstat -ano | findstr ":5199" | findstr "LISTENING" >nul
if %errorlevel%==0 goto occupied

rem ---- 1) 找 Node ----
where node >nul 2>nul
if %errorlevel% neq 0 goto nonode

rem ---- 2) 前端构建 ----
if not exist "web\dist\index.html" goto build
echo [1/3] 前端已构建好，跳过构建。
goto serve

:build
echo [1/3] 第一次启动，正在构建前端（大约 10 到 30 秒）...
call npm run build
if %errorlevel% neq 0 goto buildfail

:serve
echo [2/3] 正在启动本地服务...
rem 另起一个隐形的等待进程：端口一通就自动打开浏览器。
rem 必须等端口就绪再开，否则浏览器只会显示「拒绝连接」。
start "wavecast-wait" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0.tools\wait-open.ps1"
echo [3/3] 服务就绪后会自己打开浏览器，请保持本窗口开着。
echo       关掉本窗口就等于停止服务。
echo.
node server\index.js
set RC=%errorlevel%

echo.
if "%RC%"=="0" goto rcok
echo [错误] 服务异常退出，退出码 %RC%
echo        常见原因：
echo          1. 端口 5199 被别的程序占了（刚才的预检没发现，可能是刚被抢走的）
echo          2. Node 版本太低，需要 18 以上
echo          3. 依赖没装全，在项目目录执行一次 npm install
goto afterrc

:rcok
echo 服务已正常退出。

:afterrc
echo.
echo 按任意键关闭本窗口...
pause >nul
exit /b %RC%

:occupied
echo [提示] 端口 5199 已被占用，服务很可能已经在运行了。
echo        正在打开浏览器...
start "" http://localhost:5199
echo.
echo 按任意键关闭本窗口...
pause >nul
exit /b 0

:nonode
echo [错误] 没找到 node，请先安装 Node.js（18 以上版本）再试。
echo.
echo 按任意键关闭本窗口...
pause >nul
exit /b 1

:buildfail
echo [错误] 前端构建失败，请把上面的报错发我看看。
echo.
echo 按任意键关闭本窗口...
pause >nul
exit /b 1
