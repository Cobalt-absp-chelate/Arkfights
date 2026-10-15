@echo off
setlocal
cd /d "%~dp0"
title ArkFights Launcher

echo ========================================
echo    ArkFights - Tactical Duel (LAN PvP)
echo ========================================
echo.

REM ---- 1) Check Node.js ----
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo.
    echo Please install Node.js ^(18 or newer^) from https://nodejs.org
    echo Then run this file again.
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node -v') do set "NODEVER=%%v"
echo [1/3] Node.js %NODEVER% OK

REM ---- 2) First run: extract operator model assets ----
if not exist "public\assets\spine\back-index.json" (
    echo [2/3] First run: extracting model assets, please wait...
    if not exist "spine-assets.zip" (
        echo [ERROR] spine-assets.zip not found next to this script.
        pause
        exit /b 1
    )
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%~dp0spine-assets.zip' -DestinationPath '%~dp0public\assets' -Force"
    if not exist "public\assets\spine\back-index.json" (
        echo [ERROR] Extraction failed. Please unzip spine-assets.zip into public\assets\ manually.
        pause
        exit /b 1
    )
    echo       Extraction done.
) else (
    echo [2/3] Model assets OK
)

REM ---- 3) Start server and open browser ----
if not defined PORT set "PORT=8788"

REM Already running? (a previous window may still hold the port) -> just open the browser
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [3/3] A server is ALREADY running on port %PORT%.
    echo       Opening the browser. If you want a fresh start, close that
    echo       other window first, or run with another port:
    echo           set PORT=8789
    echo.
    start "" http://127.0.0.1:%PORT%
    timeout /t 4 >nul
    exit /b 0
)

echo [3/3] Starting server...
echo.

start "" http://127.0.0.1:%PORT%
node server.js

echo.
echo Server stopped.
pause
