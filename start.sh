#!/usr/bin/env bash
# start.sh — launch (or attach to) ChatGPT with the LIMITS status-bar bridge.
# usage: ./start.sh [--capture]
#   --capture   also save a PNG of the main window after install (last-run.png)
set -euo pipefail

PORT=9333
# Resolve our own directory even when invoked through the installed symlink
# (~/.local/bin/codex-limitbar -> start.sh): BASH_SOURCE[0] is then the LINK path.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  HERE="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in /*) ;; *) SOURCE="$HERE/$SOURCE" ;; esac
done
DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
LOG="$HOME/Library/Logs/spr-limitbar-bridge.log"
BUNDLE_ID="com.openai.codex"
APP_PROC='ChatGPT.app/Contents/MacOS/ChatGPT'

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "!! node not found in PATH"; exit 1; fi

EXTRA_OPTS=()
if [[ " $* " == *" --capture "* ]]; then EXTRA_OPTS=(--capture-after 2500 --capture-out "$DIR/last-run.png"); fi

app_running() { pgrep -f "$APP_PROC" >/dev/null 2>&1; }
port_up() { curl -s --max-time 1 "http://127.0.0.1:$PORT/json/list" -o /dev/null 2>/dev/null; }

if port_up; then
  echo "== attaching to running ChatGPT (inspector :$PORT)"
  "$NODE" "$DIR/bridge.mjs" "$PORT" --log "$LOG" --close-inspector 600 ${EXTRA_OPTS[@]+"${EXTRA_OPTS[@]}"}
  echo "== OK: bridge (re)installed"
  exit 0
fi

if app_running; then
  echo "== ChatGPT is running without an inspector; restarting it"
  osascript -e 'quit app id "com.openai.codex"' >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do app_running || break; sleep 0.5; done
  if app_running; then
    pkill -TERM -f "$APP_PROC" 2>/dev/null || true
    for _ in $(seq 1 20); do app_running || break; sleep 0.5; done
  fi
  if app_running; then echo "!! ChatGPT did not quit; aborting"; exit 1; fi
  sleep 1
fi

echo "== launching ChatGPT with --inspect=$PORT"
open -b "$BUNDLE_ID" --args --inspect="$PORT"
for _ in $(seq 1 60); do port_up && break; sleep 1; done
if ! port_up; then echo "!! inspector did not come up on :$PORT; aborting"; exit 1; fi

echo "== installing bridge and closing the inspector port"
"$NODE" "$DIR/bridge.mjs" "$PORT" --log "$LOG" --close-inspector 600 ${EXTRA_OPTS[@]+"${EXTRA_OPTS[@]}"}
sleep 1
if port_up; then echo "!! WARNING: inspector port still open"; else echo "== inspector port closed"; fi

echo "== DONE. The bar re-appears automatically on every window load."
tail -n 3 "$LOG" 2>/dev/null || true
