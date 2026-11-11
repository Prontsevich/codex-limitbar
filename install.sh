#!/usr/bin/env bash
# install.sh — install the command, an optional app launcher and Raycast command.
#
# Usage:
#   ./install.sh                  # link ./start.sh as `codex-limitbar` into ~/.local/bin
#   ./install.sh --raycast [dir]  # also link the Raycast script command into [dir]
#                                 # (default ~/.config/raycast/scripts)
#   ./install.sh --app            # also install ~/Applications/Codex with LimitBar.app
#   ./install.sh --check          # report state, change nothing
#   ./install.sh --uninstall      # remove everything (runs ./uninstall.sh)
#
# The repo stays the entry point: the installed command is a symlink to start.sh
# in THIS directory, so `git pull` updates everything at once.
# CODEX_LIMITBAR_BIN_DIR overrides ~/.local/bin.

set -eu

REPO_DIR="$(cd "$(dirname "$0")" && pwd -P)"
BIN_DIR="${CODEX_LIMITBAR_BIN_DIR:-$HOME/.local/bin}"
LINK="$BIN_DIR/codex-limitbar"
STATE_DIR="$HOME/Library/Application Support/spr-limitbar"
RAYCAST_RECORD="$STATE_DIR/raycast-link"
RAYCAST_DEFAULT="$HOME/.config/raycast/scripts"
APP="${CODEX_LIMITBAR_APP:-/Applications/ChatGPT.app}"
LAUNCHER="${CODEX_LIMITBAR_LAUNCHER_DIR:-$HOME/Applications}/Codex with LimitBar.app"

usage() {
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

MODE="install"
RAYCAST_DIR=""
INSTALL_APP=0
while [ $# -gt 0 ]; do
    case "$1" in
        --uninstall) shift; exec "$REPO_DIR/uninstall.sh" "$@" ;;
        --check)     MODE="check" ;;
        --app)       INSTALL_APP=1 ;;
        --raycast)
            RAYCAST_DIR="$RAYCAST_DEFAULT"
            case "${2:-}" in ''|-*) ;; *) RAYCAST_DIR="$2"; shift ;; esac
            ;;
        -h|--help)   usage 0 ;;
        *) echo "unknown argument: $1" >&2; usage 2 ;;
    esac
    shift
done

if [ "$MODE" = "check" ]; then
    if [ -L "$LINK" ]; then
        printf 'command:  %s -> %s\n' "$LINK" "$(readlink "$LINK")"
    elif [ -e "$LINK" ]; then
        printf 'command:  %s exists but is not a symlink\n' "$LINK"
    else
        printf 'command:  not installed (would create %s)\n' "$LINK"
    fi
    if [ -f "$RAYCAST_RECORD" ] && [ -L "$(cat "$RAYCAST_RECORD")" ]; then
        printf 'raycast:  %s\n' "$(cat "$RAYCAST_RECORD")"
    else
        printf 'raycast:  not installed\n'
    fi
    . "$REPO_DIR/lib/find-node.sh"
    NODE="$(find_node)" || { echo "!! Node.js >= 22 not found" >&2; exit 1; }
    "$NODE" "$REPO_DIR/lib/launcher.mjs" check "$REPO_DIR" "$LAUNCHER"
    exit 0
fi

# --- preflight -------------------------------------------------------------

fail=0
if [ ! -d "$APP" ]; then
    echo "!! $APP not found" >&2; fail=1
fi
# shellcheck source=lib/find-node.sh
. "$REPO_DIR/lib/find-node.sh"
if ! NODE="$(find_node)"; then
    echo "!! Node.js >= 22 not found (set CODEX_LIMITBAR_NODE to its path)" >&2; fail=1
fi
for f in start.sh limitbar.mjs bar.js; do
    [ -f "$REPO_DIR/$f" ] || { echo "!! $f is missing next to this script" >&2; fail=1; }
done
[ "$fail" -eq 0 ] || { echo "preflight failed; fix the above and re-run" >&2; exit 1; }

# --- install ---------------------------------------------------------------

mkdir -p "$BIN_DIR"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
    echo "!! $LINK exists and is not a symlink; move it away first" >&2
    exit 1
fi
ln -sfn "$REPO_DIR/start.sh" "$LINK"
echo "installed: $LINK -> $REPO_DIR/start.sh"

case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "note: $BIN_DIR is not in your PATH — add it to use the bare command" ;;
esac

if [ "$INSTALL_APP" -eq 1 ]; then
    "$NODE" "$REPO_DIR/lib/launcher.mjs" install "$REPO_DIR" "$LAUNCHER" "$APP" "$NODE"
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$LAUNCHER"
    echo "           Open Codex with LimitBar from Spotlight/Raycast, or drag it from ~/Applications to the Dock."
fi

if [ -n "$RAYCAST_DIR" ]; then
    mkdir -p "$RAYCAST_DIR"
    dest="$RAYCAST_DIR/codex-limitbar.sh"
    icon="$RAYCAST_DIR/spr-codex-icon.png"
    for entry in "$dest" "$icon"; do
        if [ -L "$entry" ]; then
            [ "$(readlink "$entry")" != "$REPO_DIR/raycast/${entry##*/}" ] || continue
        elif [ ! -e "$entry" ]; then
            continue
        fi
        echo "!! $entry already exists and is not owned by this checkout" >&2
        exit 1
    done
    ln -sfn "$REPO_DIR/raycast/spr-codex-icon.png" "$icon"
    ln -sfn "$REPO_DIR/raycast/codex-limitbar.sh" "$dest"
    mkdir -p "$STATE_DIR"
    printf '%s\n' "$dest" > "$RAYCAST_RECORD"
    echo "raycast:   $dest -> $REPO_DIR/raycast/codex-limitbar.sh"
    echo "           Raycast → Settings → Extensions → Script Commands → Add Directories → $RAYCAST_DIR"
    echo "           then search \"Open ChatGPT with LimitBar\" (set an alias/hotkey there)"
fi

echo "run: codex-limitbar"
