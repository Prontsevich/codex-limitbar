#!/usr/bin/env bash
# uninstall.sh — remove everything codex-limitbar put on this Mac.
#
# Usage:
#   ./uninstall.sh                # stop the agent (bar disappears live) and remove all artifacts
#   ./uninstall.sh --check        # dry run: list what would be removed
#   ./uninstall.sh --purge        # also delete ~/.codex-limitbar-backups (skill-install backups)
#   ./uninstall.sh --restart-app  # also quit and reopen ChatGPT normally (closes its debugging port)
#
# Removes: the running agent, the `codex-limitbar` command (only our symlink), the
# Raycast script link, skill symlinks that point into this repo, the state dir and
# logs. The ChatGPT app itself is never modified. The repo directory stays — delete
# it yourself afterwards.

set -eu

REPO_DIR="$(cd "$(dirname "$0")" && pwd -P)"
BIN_DIR="${CODEX_LIMITBAR_BIN_DIR:-$HOME/.local/bin}"
STATE_DIR="$HOME/Library/Application Support/spr-limitbar"
BACKUPS="${CODEX_LIMITBAR_BACKUP_DIR:-$HOME/.codex-limitbar-backups}"
APP="${CODEX_LIMITBAR_APP:-/Applications/ChatGPT.app}"
BUNDLE_ID="com.openai.codex"

usage() {
    sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

DRY=0
PURGE=0
RESTART=0
for arg in "$@"; do
    case "$arg" in
        --check)       DRY=1 ;;
        --purge)       PURGE=1 ;;
        --restart-app) RESTART=1 ;;
        -h|--help)     usage 0 ;;
        *) echo "unknown flag: $arg" >&2; usage 2 ;;
    esac
done

act() {   # act <description> <command...>
    local what="$1"; shift
    if [ "$DRY" -eq 1 ]; then echo "would: $what"; else "$@" && echo "done:  $what"; fi
}

# true when $1 is a symlink whose target resolves inside this repo
points_into_repo() {
    [ -L "$1" ] || return 1
    local target
    target="$(readlink "$1")"
    case "$target" in /*) ;; *) target="$(dirname "$1")/$target" ;; esac
    target="$(cd "$(dirname "$target")" 2>/dev/null && pwd -P)/$(basename "$target")" || return 1
    case "$target" in "$REPO_DIR"/*) return 0 ;; *) return 1 ;; esac
}

# 1. the agent: SIGTERM makes it remove the bar from the live window first
agents="$(pgrep -f "$REPO_DIR/limitbar.mjs" 2>/dev/null || true)"
if [ -f "$STATE_DIR/agent.json" ]; then
    spid="$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$STATE_DIR/agent.json" | head -n 1)"
    if [ -n "$spid" ] && ps -o command= -p "$spid" 2>/dev/null | grep -q 'limitbar\.mjs'; then
        agents="$(printf '%s\n%s\n' "$agents" "$spid" | sort -u)"
    fi
fi
for pid in $agents; do
    [ -n "$pid" ] || continue
    if [ "$DRY" -eq 1 ]; then
        echo "would: stop agent pid $pid (removes the bar from the window)"
    else
        # the bar keeps its preferences (mode, pace, notifications) in the page's localStorage; clear them
        # while the agent's port is still known (harmless if this fails)
        port="$(ps -o command= -p "$pid" 2>/dev/null | sed -n 's/.*--port \([0-9][0-9]*\).*/\1/p')"
        node_bin="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
        if [ -n "$port" ] && [ -x "$node_bin" ]; then
            "$node_bin" "$REPO_DIR/skills/codex-limitbar/scripts/cdp-eval.mjs" --port "$port" --app "$APP" \
                -e "['spr-statusbar-mode','spr-statusbar-pace','spr-statusbar-notify','spr-statusbar-notified'].forEach(k => localStorage.removeItem(k)); 'ok'" >/dev/null 2>&1 || true
        fi
        kill -TERM "$pid" 2>/dev/null || true
        for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
        echo "done:  stopped agent pid $pid (bar removed)"
    fi
done

# 2. the PATH command
LINK="$BIN_DIR/codex-limitbar"
if points_into_repo "$LINK"; then
    act "remove $LINK" rm "$LINK"
elif [ -e "$LINK" ] || [ -L "$LINK" ]; then
    echo "skip:  $LINK is not our symlink"
fi

# 3. Raycast script link (recorded by install.sh --raycast, plus the default dir)
recorded="$(cat "$STATE_DIR/raycast-link" 2>/dev/null || true)"
default_link="$HOME/.config/raycast/scripts/codex-limitbar.sh"
for link in "$recorded" "$default_link"; do
    [ -n "$link" ] || continue
    if points_into_repo "$link"; then act "remove $link" rm "$link"; fi
    [ "$recorded" = "$default_link" ] && break   # same path twice: handled
done

# 4. skill symlinks installed by install-skills.sh (copies are left alone)
for root in "$HOME/.claude/skills" "$HOME/.codex/skills" "$HOME/.cursor/skills" "$HOME/.agents/skills" \
            "$HOME/.gemini/skills" "$HOME/.hermes/skills" "$HOME/.config/opencode/skills" "$HOME/.copilot/skills"; do
    [ -d "$root" ] || continue
    for entry in "$root"/*; do
        if points_into_repo "$entry"; then act "remove skill link $entry" rm "$entry"; fi
    done
    if [ -d "$root/codex-limitbar" ] && [ ! -L "$root/codex-limitbar" ]; then
        echo "note:  $root/codex-limitbar is a plain copy; remove it yourself if you want it gone"
    fi
done

# 5. state and logs
[ -d "$STATE_DIR" ] && act "remove $STATE_DIR" rm -rf "$STATE_DIR"
for f in "$HOME/Library/Logs/spr-limitbar.log" "$HOME/Library/Logs/spr-limitbar-bridge.log"; do
    [ -e "$f" ] && act "remove $f" rm -f "$f"
done

# 6. skill-install backups: only on --purge
if [ -d "$BACKUPS" ]; then
    if [ "$PURGE" -eq 1 ]; then act "remove $BACKUPS" rm -rf "$BACKUPS"
    else echo "kept:  $BACKUPS (skill-install backups; --purge deletes them)"; fi
fi

# 7. optional clean restart: closes the app's debugging port
APP_EXE="$APP/Contents/MacOS/$(defaults read "$APP/Contents/Info.plist" CFBundleExecutable 2>/dev/null || echo ChatGPT)"
apid="$(pgrep -f "^$APP_EXE( |\$)" 2>/dev/null | head -n 1 || true)"
has_port=0
[ -n "$apid" ] && ps -o command= -p "$apid" | grep -q -- '--remote-debugging-port' && has_port=1
if [ "$RESTART" -eq 1 ] && [ -n "$apid" ]; then
    if [ "$DRY" -eq 1 ]; then echo "would: quit and reopen ChatGPT normally"
    else
        osascript -e "quit app id \"$BUNDLE_ID\"" >/dev/null 2>&1 || true
        for _ in $(seq 1 40); do pgrep -f "^$APP_EXE( |\$)" >/dev/null 2>&1 || break; sleep 0.5; done
        if pgrep -f "^$APP_EXE( |\$)" >/dev/null 2>&1; then echo "!! ChatGPT did not quit; reopen it yourself"
        else sleep 1; open -b "$BUNDLE_ID"; echo "done:  reopened ChatGPT without a debugging port"; fi
    fi
elif [ "$has_port" -eq 1 ]; then
    echo "note:  ChatGPT still has its debugging port open; quit and reopen it (or re-run with --restart-app)"
fi

[ "$DRY" -eq 1 ] && echo "(dry run: nothing changed)"
echo "The repo at $REPO_DIR is untouched; delete it to finish."
