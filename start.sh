#!/usr/bin/env bash
# start.sh — open ChatGPT with the LIMITS status bar (codex-limitbar).
#
# Usage:
#   ./start.sh             # open ChatGPT with the bar (restarts it once if it runs without CDP)
#   ./start.sh --capture   # same + save last-run.png of the main window
#   ./start.sh --status    # report app / port / agent state, change nothing
#   ./start.sh --stop      # stop the agent: the bar disappears live
#   ./start.sh --doctor    # read-only diagnostics report (--doctor --json for JSON)
#
# How: ChatGPT is launched with --remote-debugging-port=<random 127.0.0.1 port>, then
# limitbar.mjs (the agent) attaches over CDP, verifies the port belongs to the app,
# injects bar.js and keeps it fed with live limits until the app quits.
# Re-running while everything is up just brings ChatGPT to the front.
set -euo pipefail

# Resolve our own directory even when invoked through a symlink
# (~/.local/bin/codex-limitbar -> start.sh): BASH_SOURCE[0] is then the LINK path.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  HERE="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in /*) ;; *) SOURCE="$HERE/$SOURCE" ;; esac
done
DIR="$(cd "$(dirname "$SOURCE")" && pwd)"

usage() { sed -n '2,14p' "$DIR/start.sh" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

APP="${CODEX_LIMITBAR_APP:-/Applications/ChatGPT.app}"
BUNDLE_ID="com.openai.codex"
STATE_DIR="${CODEX_LIMITBAR_STATE_DIR:-$HOME/Library/Application Support/spr-limitbar}"   # same override as limitbar.mjs
STATE="$STATE_DIR/agent.json"
LOG="$HOME/Library/Logs/spr-limitbar.log"

MODE="run"
CAPTURE=0
JSON=0
for arg in "$@"; do
  case "$arg" in
    --capture) CAPTURE=1 ;;
    --status)  MODE="status" ;;
    --stop)    MODE="stop" ;;
    --doctor)  MODE="doctor" ;;
    --json)    JSON=1 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown flag: $arg" >&2; usage 2 ;;
  esac
done

# --- helpers ---------------------------------------------------------------

# shellcheck source=lib/find-node.sh
. "$DIR/lib/find-node.sh"

APP_EXE="$APP/Contents/MacOS/$(defaults read "$APP/Contents/Info.plist" CFBundleExecutable 2>/dev/null || echo ChatGPT)"

# pid of the app's main process (helpers live under Frameworks/, not Contents/MacOS/)
app_pid() { pgrep -f "^$APP_EXE( |\$)" 2>/dev/null | head -n 1 || true; }

# the --remote-debugging-port the running app was started with, if any
app_port() {
  local pid="$1"
  ps -o command= -p "$pid" 2>/dev/null | grep -oE -- '--remote-debugging-port=[0-9]+' | head -n 1 | cut -d= -f2 || true
}

port_up() { curl -s --max-time 1 "http://127.0.0.1:$1/json/version" -o /dev/null 2>/dev/null; }

port_free() { ! /usr/sbin/lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

pick_port() {
  local p
  for _ in $(seq 1 40); do
    p=$(( 20000 + RANDOM % 20000 ))
    if port_free "$p"; then printf '%s' "$p"; return 0; fi
  done
  return 1
}

# "pid port appPid" from agent.json (empty when absent/unreadable)
state_fields() {
  [ -f "$STATE" ] || return 0
  "$NODE" -e 'try { const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log([s.pid, s.port, s.appPid].join(" ")); } catch {}' "$STATE" 2>/dev/null || true
}

agent_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -o command= -p "$pid" 2>/dev/null | grep -q 'limitbar\.mjs'
}

quit_app() {
  osascript -e "quit app id \"$BUNDLE_ID\"" >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do [ -n "$(app_pid)" ] || break; sleep 0.5; done
  if [ -n "$(app_pid)" ]; then
    pkill -TERM -f "^$APP_EXE( |\$)" 2>/dev/null || true
    for _ in $(seq 1 20); do [ -n "$(app_pid)" ] || break; sleep 0.5; done
  fi
  if [ -n "$(app_pid)" ]; then echo "!! ChatGPT did not quit; aborting"; exit 1; fi
  sleep 1
}

start_agent() {
  local port="$1" extra=() apid
  if [ "$CAPTURE" -eq 1 ]; then extra=(--capture "$DIR/last-run.png"); fi
  mkdir -p "$(dirname "$LOG")"
  nohup "$NODE" "$DIR/limitbar.mjs" --port "$port" --app "$APP" --log "$LOG" ${extra[@]+"${extra[@]}"} >>"$LOG" 2>&1 &
  local agent=$!
  disown "$agent" 2>/dev/null || true
  for _ in $(seq 1 40); do
    read -r spid _ apid <<<"$(state_fields)" || true
    if [ "${spid:-}" = "$agent" ]; then
      echo "== OK: bar active (agent pid $agent, app pid $apid, port $port)"
      return 0
    fi
    if ! kill -0 "$agent" 2>/dev/null; then
      echo "!! agent exited; last log lines:"; tail -n 5 "$LOG" 2>/dev/null || true
      return 1
    fi
    sleep 0.5
  done
  echo "!! agent did not report an injection within 20 s; see $LOG"
  return 1
}

# --- main ------------------------------------------------------------------

# Diagnostics run before any other precondition: reporting a missing app or Node
# is part of their job. Read-only: never touches the app or the agent.
if [ "$MODE" = "doctor" ]; then
  NODE="$(find_node)" || {
    echo "✗ Node  Node.js >= 22 not found"
    echo "    → install Node 22+, or set CODEX_LIMITBAR_NODE to its path"
    exit 1
  }
  if [ "$JSON" -eq 1 ]; then exec "$NODE" "$DIR/lib/doctor.mjs" --app "$APP" --log "$LOG" --json; fi
  exec "$NODE" "$DIR/lib/doctor.mjs" --app "$APP" --log "$LOG"
fi
[ "$JSON" -eq 0 ] || { echo "--json only goes with --doctor" >&2; usage 2; }

[ -d "$APP" ] || { echo "!! $APP not found"; exit 1; }
NODE="$(find_node)" || { echo "!! Node.js >= 22 not found (set CODEX_LIMITBAR_NODE to its path)"; exit 1; }

read -r S_PID S_PORT S_APP <<<"$(state_fields)" || true
APID="$(app_pid)"
APORT=""
[ -n "$APID" ] && APORT="$(app_port "$APID")"

if [ "$MODE" = "status" ]; then
  echo "app:   ${APID:-not running}${APORT:+ (CDP port $APORT)}"
  if agent_alive "${S_PID:-}"; then echo "agent: running (pid $S_PID, port $S_PORT, app pid $S_APP)"; else echo "agent: not running"; fi
  echo "log:   $LOG"
  exit 0
fi

if [ "$MODE" = "stop" ]; then
  if agent_alive "${S_PID:-}"; then
    kill -TERM "$S_PID"
    for _ in $(seq 1 20); do kill -0 "$S_PID" 2>/dev/null || break; sleep 0.25; done
    echo "== agent stopped; the bar is removed."
    [ -n "$APORT" ] && echo "   note: ChatGPT keeps its debugging port $APORT open until you quit and reopen it normally."
  else
    echo "== agent is not running"
  fi
  exit 0
fi

# Fast path: agent alive and attached to the app that is running now.
if [ -n "$APID" ] && [ -n "$APORT" ] && agent_alive "${S_PID:-}" && [ "${S_APP:-}" = "$APID" ] && [ "${S_PORT:-}" = "$APORT" ]; then
  open -b "$BUNDLE_ID"
  if [ "$CAPTURE" -eq 1 ]; then
    "$NODE" "$DIR/limitbar.mjs" --port "$APORT" --app "$APP" --log "$LOG" --once --capture "$DIR/last-run.png" || true
  fi
  echo "== OK: bar already active (agent pid $S_PID, port $APORT)"
  exit 0
fi

# A stale agent (other app instance / port): stop it before starting a new one.
if agent_alive "${S_PID:-}"; then kill -TERM "$S_PID" 2>/dev/null || true; sleep 1; fi

if [ -n "$APID" ] && [ -n "$APORT" ] && port_up "$APORT"; then
  echo "== ChatGPT already has a debugging port ($APORT); starting the agent"
  open -b "$BUNDLE_ID"
  start_agent "$APORT"
  exit $?
fi

if [ -n "$APID" ]; then
  echo "== ChatGPT is running without a debugging port; restarting it"
  quit_app
fi

PORT="$(pick_port)" || { echo "!! no free port found in 20000-40000"; exit 1; }
echo "== launching ChatGPT with --remote-debugging-port=$PORT"
open -b "$BUNDLE_ID" --args --remote-debugging-port="$PORT"
for _ in $(seq 1 60); do port_up "$PORT" && break; sleep 1; done
port_up "$PORT" || { echo "!! debugging port $PORT did not come up; aborting"; exit 1; }
# the shell page appears a moment after the port
for _ in $(seq 1 30); do
  curl -s --max-time 1 "http://127.0.0.1:$PORT/json/list" 2>/dev/null | grep -q '"url": *"app://-/index.html"' && break
  sleep 0.5
done

start_agent "$PORT"
