#!/usr/bin/env bash
# ArkFights one-click launcher (macOS / Linux)
set -u
cd "$(dirname "$0")"

echo "========================================"
echo "   ArkFights - Tactical Duel (LAN PvP)"
echo "========================================"
echo

# ---- 1) Check Node.js ----
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found."
  echo "Please install Node.js (18 or newer) from https://nodejs.org"
  exit 1
fi
echo "[1/3] Node.js $(node -v) OK"

# ---- 2) First run: extract operator model assets ----
if [ ! -f "public/assets/spine/back-index.json" ]; then
  echo "[2/3] First run: extracting model assets, please wait..."
  if [ ! -f "spine-assets.zip" ]; then
    echo "[ERROR] spine-assets.zip not found next to this script."
    exit 1
  fi
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o spine-assets.zip -d public/assets || { echo "[ERROR] Extraction failed."; exit 1; }
  else
    python3 -c "import zipfile;zipfile.ZipFile('spine-assets.zip').extractall('public/assets')" \
      || { echo "[ERROR] Extraction failed (please install unzip)."; exit 1; }
  fi
  echo "      Extraction done."
else
  echo "[2/3] Model assets OK"
fi

# ---- 3) Start server and open browser ----
PORT="${PORT:-8788}"
echo "[3/3] Starting server..."
echo
echo "  Local : http://127.0.0.1:${PORT}"
echo "  LAN   : use the address printed below, share it with your opponent"
echo "  Stop  : press Ctrl+C"
echo

(
  sleep 2
  if command -v open >/dev/null 2>&1; then open "http://127.0.0.1:${PORT}"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://127.0.0.1:${PORT}" >/dev/null 2>&1
  fi
) &

PORT="$PORT" node server.js
echo
echo "Server stopped."
