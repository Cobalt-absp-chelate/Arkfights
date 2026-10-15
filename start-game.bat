@echo off
chcp 65001 >nul
title ArkFights 启动器
cd /d "%~dp0"

echo ========================================
echo    ArkFights - 明日方舟风格双人对战
echo ========================================
echo.

REM ---- 1) 检查 Node.js ----
where node >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Node.js
    echo.
    echo 请先安装 Node.js ^(18 或更高版本^)：https://nodejs.org
    echo 安装后重新双击本脚本即可。
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODEVER=%%v
echo [1/3] Node.js 已就绪 %NODEVER%

REM ---- 2) 首次运行：解压模型资源 ----
if not exist "public\assets\spine\back-index.json" (
    echo [2/3] 首次运行：正在解压干员模型资源，请稍候...
    if not exist "spine-assets.zip" (
        echo [错误] 找不到 spine-assets.zip
        echo 请确认它和本脚本在同一目录下。
        pause
        exit /b 1
    )
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%~dp0spine-assets.zip' -DestinationPath '%~dp0public\assets' -Force"
    if not exist "public\assets\spine\back-index.json" (
        echo [错误] 解压失败，请手动解压 spine-assets.zip 到 public\assets\
        pause
        exit /b 1
    )
    echo       解压完成
) else (
    echo [2/3] 模型资源已就绪
)

REM ---- 3) 启动服务器并打开浏览器 ----
echo [3/3] 正在启动服务器...
echo.
echo   本机访问：http://127.0.0.1:8788
echo   联机方式：把下面显示的局域网地址发给对手
echo   停止服务：在本窗口按 Ctrl+C
echo.

start "" http://127.0.0.1:8788
node server.js

echo.
echo 服务器已停止。
pause
