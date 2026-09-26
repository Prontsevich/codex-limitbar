# lib/find-node.sh — sourced by start.sh and install.sh (not executable on its own).
#
# find_node prints the path of a Node.js >= 22 binary (global WebSocket is required).
# Launchers such as Raycast run with a minimal PATH, so the usual install locations
# are searched too; CODEX_LIMITBAR_NODE overrides everything.
find_node() {
  local c
  for c in "${CODEX_LIMITBAR_NODE:-}" "$(command -v node 2>/dev/null || true)" \
           /opt/homebrew/bin/node /usr/local/bin/node \
           "$HOME/.local/share/mise/shims/node" "$HOME/.volta/bin/node" \
           "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    if [ "$("$c" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -ge 22 ]; then
      printf '%s' "$c"; return 0
    fi
  done
  return 1
}
