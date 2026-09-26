# install-skills.sh — install the repo's agent skills into every detected harness.
#
# Usage:
#   ./install-skills.sh                 # link into every harness whose home dir exists
#   ./install-skills.sh claude cursor   # link into the named harnesses only
#   ./install-skills.sh --copy codex    # copy instead of symlink (hosts that reject links)
#   ./install-skills.sh --check         # report drift, change nothing
#   ./install-skills.sh --force claude  # replace an existing dir (backed up first)
#
# Backups go to ~/.codex-limitbar-backups/<target>-<stamp> (override with
# CODEX_LIMITBAR_BACKUP_DIR) — never inside a skills directory, where a harness
# would load them as duplicate skills.
#
# Targets: claude cursor codex agents gemini hermes opencode copilot all
#
# The repo stays the single source of truth. A symlink means every harness sees
# edits immediately; a copy must be refreshed by re-running this script.

set -eu

REPO_DIR="$(cd "$(dirname "$0")" && pwd -P)"
MODE="link"
FORCE=0
CHECK=0
TARGETS=""

usage() {
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

harness_root() {
    case "$1" in
        claude)   printf '%s' "$HOME/.claude/skills" ;;
        cursor)   printf '%s' "$HOME/.cursor/skills" ;;
        codex)    printf '%s' "$HOME/.codex/skills" ;;
        agents)   printf '%s' "$HOME/.agents/skills" ;;
        gemini)   printf '%s' "$HOME/.gemini/skills" ;;
        hermes)   printf '%s' "$HOME/.hermes/skills" ;;
        opencode) printf '%s' "$HOME/.config/opencode/skills" ;;
        copilot)  printf '%s' "$HOME/.copilot/skills" ;;
        *) echo "unknown target: $1" >&2; exit 2 ;;
    esac
}

ALL_TARGETS="claude cursor codex agents gemini hermes opencode copilot"
SKILLS="codex-limitbar electron-app-patching"

for arg in "$@"; do
    case "$arg" in
        --link) MODE="link" ;;
        --copy) MODE="copy" ;;
        --force) FORCE=1 ;;
        --check) CHECK=1 ;;
        -h|--help) usage 0 ;;
        all) TARGETS="$ALL_TARGETS" ;;
        --*) echo "unknown flag: $arg" >&2; usage 2 ;;
        *) TARGETS="$TARGETS $arg" ;;
    esac
done

if [ -z "$TARGETS" ]; then
    for t in $ALL_TARGETS; do
        parent="$(dirname "$(harness_root "$t")")"
        [ -d "$parent" ] && TARGETS="$TARGETS $t"
    done
fi

describe() {
    dest="$1"
    if [ -L "$dest" ]; then
        real="$(cd "$dest" 2>/dev/null && pwd -P || echo '?')"
        if [ "$real" = "$REPO_DIR/skills/$(basename "$dest")" ]; then
            echo "symlink -> repo (ok)"
        else
            echo "symlink -> $real (foreign)"
        fi
    elif [ -d "$dest" ]; then
        if diff -rq --exclude=.DS_Store --exclude=__pycache__ "$REPO_DIR/skills/$(basename "$dest")" "$dest" >/dev/null 2>&1; then
            echo "plain copy, in sync"
        else
            echo "plain copy, DRIFTED"
        fi
    elif [ -e "$dest" ]; then
        echo "exists but is not a directory"
    else
        echo "missing"
    fi
}

BACKUP_ROOT="${CODEX_LIMITBAR_BACKUP_DIR:-$HOME/.codex-limitbar-backups}"

backup() {
    dest="$1"; name="$2"; stamp="$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$BACKUP_ROOT"
    mv "$dest" "$BACKUP_ROOT/$name-$stamp"
    echo "  backed up previous install to $BACKUP_ROOT/$name-$stamp"
}

install_one() {
    dest="$1"; name="$2"; src="$3"
    if [ -L "$dest" ]; then
        rm "$dest"
    elif [ -e "$dest" ]; then
        if [ "$FORCE" -ne 1 ]; then
            echo "  refusing to replace existing directory without --force"
            return 1
        fi
        backup "$dest" "$name"
    fi
    mkdir -p "$(dirname "$dest")"
    if [ "$MODE" = "link" ]; then
        ln -s "$src" "$dest"
        echo "  linked -> $src"
    else
        mkdir -p "$dest"
        cp -R "$src/." "$dest/"
        find "$dest" -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
        find "$dest" -name .DS_Store -delete 2>/dev/null || true
        echo "  copied from $src"
    fi
}

status=0
for t in $TARGETS; do
    root="$(harness_root "$t")"
    echo "$t  ($root)"
    for skill in $SKILLS; do
        src="$REPO_DIR/skills/$skill"
        dest="$root/$skill"
        printf '  %-24s before: %s\n' "$skill" "$(describe "$dest")"
        if [ "$CHECK" -eq 1 ]; then continue; fi
        install_one "$dest" "$t-$skill" "$src" || status=1
        printf '  %-24s after:  %s\n' "$skill" "$(describe "$dest")"
    done
done
exit "$status"
