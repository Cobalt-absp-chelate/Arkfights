#!/usr/bin/env bash
# ArkFights 一键启动（macOS / Linux）
set -u
cd "$(dirname "$0")"

echo "========================================"
echo "   ArkFights - 明日方舟风格双人对战"
echo "========================================"
echo

# ---- 1) 检查 Node.js ----
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js"
  echo "请先安装 Node.js (18+)：https://nodejs.org"
  exit 1
fi
echo "[1/3] Node.js 已就绪 $(node -v)"

# ---- 2) 首次运行：解压模型资源 ----
if [ ! -f "public/assets/spine/back-index.json" ]; then
  echo "[2/3] 首次运行：正在解压干员模型资源，请稍候..."
  if [ ! -f "spine-assets.zip" ]; then
    echo "[错误] 找不到 spine-assets.zip"
    exit 1
  fi
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o spine-assets.zip -d public/assets || { echo "[错误] 解压失败"; exit 1; }
  else
    python3 -c "import zipfile;zipfile.ZipFile('spine-assets.zip').extractall('public/assets')" \
      || { echo "[错误] 解压失败（请安装 unzip）"; exit 1; }
  fi
  echo "      解压完成"
else
  echo "[2/3] 模型资源已就绪"
fi

# ---- 3) 启动服务器并打开浏览器 ----
echo "[3/3] 正在启动服务器..."
echo
echo "  本机访问：http://127.0.0.1:8788"
echo "  停止服务：Ctrl+C"
echo

(
  sleep 2
  if command -v open >/dev/null 2>&1; then open http://127.0.0.1:8788
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open http://127.0.0.1:8788 >/dev/null 2>&1
  fi
) &

node server.js
echo
echo "服务器已停止。"
