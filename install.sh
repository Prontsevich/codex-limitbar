# Install codex-limitbar: put the `codex-limitbar` command into PATH.
#
# Usage:
#   ./install.sh              # link ./start.sh as `codex-limitbar` into ~/.local/bin
#   ./install.sh --uninstall  # remove the command
#   ./install.sh --check      # report state, change nothing
#
# The repo stays the entry point: the installed command is a thin wrapper that
# runs start.sh from THIS directory, so `git pull` updates everything at once.

set -eu

REPO_DIR="$(cd "$(dirname "$0")" && pwd -P)"
BIN_DIR="${CODEX_LIMITBAR_BIN_DIR:-$HOME/.local/bin}"
LINK="$BIN_DIR/codex-limitbar"

usage() {
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

MODE="install"
case "${1:-}" in
    --uninstall) MODE="uninstall" ;;
    --check)     MODE="check" ;;
    -h|--help)   usage 0 ;;
    '') ;;
    *) echo "unknown flag: $1" >&2; usage 2 ;;
esac

if [ "$MODE" = "check" ]; then
    if [ -L "$LINK" ]; then
        printf 'installed: %s -> %s\n' "$LINK" "$(readlink "$LINK")"
    elif [ -e "$LINK" ]; then
        printf 'present but not a symlink: %s\n' "$LINK"
    else
        printf 'not installed (would create %s)\n' "$LINK"
    fi
    exit 0
fi

if [ "$MODE" = "uninstall" ]; then
    if [ -L "$LINK" ]; then rm "$LINK"; echo "removed $LINK"; else echo "nothing to remove at $LINK"; fi
    exit 0
fi

# --- preflight -------------------------------------------------------------

fail=0
if [ ! -d "/Applications/ChatGPT.app" ]; then
    echo "!! ChatGPT.app not found in /Applications" >&2; fail=1
fi
if ! command -v node >/dev/null 2>&1; then
    echo "!! node not found in PATH" >&2; fail=1
fi
if [ ! -f "$REPO_DIR/start.sh" ]; then
    echo "!! start.sh is missing next to this script" >&2; fail=1
fi
[ "$fail" -eq 0 ] || { echo "preflight failed; fix the above and re-run" >&2; exit 1; }

# --- install ---------------------------------------------------------------

mkdir -p "$BIN_DIR"
if [ -L "$LINK" ]; then rm "$LINK"; fi
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
    echo "!! $LINK exists and is not a symlink; move it away first" >&2
    exit 1
fi

ln -s "$REPO_DIR/start.sh" "$LINK"
echo "installed: $LINK -> $REPO_DIR/start.sh"

case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "note: $BIN_DIR is not in your PATH — add it to use the bare command" ;;
esac

echo "run: codex-limitbar"
