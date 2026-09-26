#!/usr/bin/env bash
# Raycast Script Command: open ChatGPT with the codex-limitbar status bar.
#
# Usage: add this file's directory (or a directory holding a symlink to it, see
# `./install.sh --raycast`) under Raycast → Settings → Extensions → Script Commands,
# then run "Open ChatGPT with LimitBar" (assign an alias or hotkey there if you like).
# Output is compact: only the final status line is shown.

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Open ChatGPT with LimitBar
# @raycast.mode compact

# Optional parameters:
# @raycast.packageName codex-limitbar
# @raycast.icon 📊
# @raycast.description Launch ChatGPT with the Codex rate-limit status bar (restarts it once if needed).
# @raycast.author codex-limitbar

set -eu

SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  HERE="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in /*) ;; *) SOURCE="$HERE/$SOURCE" ;; esac
done
REPO="$(cd "$(dirname "$SOURCE")/.." && pwd)"

if out="$("$REPO/start.sh" 2>&1)"; then rc=0; else rc=$?; fi
last="$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -n 1)"
# strip the launcher's "== " / "!! " prefixes for the compact HUD
printf '%s\n' "${last#[=!][=!] }"
exit "$rc"
