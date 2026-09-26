#!/usr/bin/env bash
# install.sh — put the `codex-limitbar` command into PATH (and optionally Raycast).
#
# Usage:
#   ./install.sh                  # link ./start.sh as `codex-limitbar` into ~/.local/bin
#   ./install.sh --raycast [dir]  # also link the Raycast script command into [dir]
#                                 # (default ~/.config/raycast/scripts)
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

usage() {
    sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

MODE="install"
RAYCAST_DIR=""
while [ $# -gt 0 ]; do
    case "$1" in
        --uninstall) shift; exec "$REPO_DIR/uninstall.sh" "$@" ;;
        --check)     MODE="check" ;;
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
    exit 0
fi

# --- preflight -------------------------------------------------------------

fail=0
if [ ! -d "/Applications/ChatGPT.app" ]; then
    echo "!! ChatGPT.app not found in /Applications" >&2; fail=1
fi
# shellcheck source=lib/find-node.sh
. "$REPO_DIR/lib/find-node.sh"
if ! find_node >/dev/null; then
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

if [ -n "$RAYCAST_DIR" ]; then
    mkdir -p "$RAYCAST_DIR"
    dest="$RAYCAST_DIR/codex-limitbar.sh"
    if [ -e "$dest" ] && [ ! -L "$dest" ]; then
        echo "!! $dest exists and is not a symlink; move it away first" >&2
        exit 1
    fi
    ln -sfn "$REPO_DIR/raycast/codex-limitbar.sh" "$dest"
    mkdir -p "$STATE_DIR"
    printf '%s\n' "$dest" > "$RAYCAST_RECORD"
    echo "raycast:   $dest -> $REPO_DIR/raycast/codex-limitbar.sh"
    echo "           Raycast → Settings → Extensions → Script Commands → Add Directories → $RAYCAST_DIR"
    echo "           then search \"Open ChatGPT with LimitBar\" (set an alias/hotkey there)"
fi

echo "run: codex-limitbar"
