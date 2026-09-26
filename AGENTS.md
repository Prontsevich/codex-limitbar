# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

A macOS utility that injects a rate-limit status bar into the local UI of the
ChatGPT desktop app (`/Applications/ChatGPT.app`, an Electron shell, bundle id
`com.openai.codex`) at runtime — no bundle modification. Two parts:

- **The product**: `bridge.mjs` (installer + injected bridge), `start.sh`
  (launcher), `install.sh` (PATH command), `install-skills.sh` (agent-skill
  installer).
- **The skills**: `skills/codex-limitbar/` (product + protocol reference) and
  `skills/electron-app-patching/` (general Electron injection methodology).

## Ground rules

- **Never modify `/Applications/ChatGPT.app`** — no repack, no re-sign. The
  method depends on zero disk changes; the signature and TCC permissions stay
  intact.
- **All runtime identifiers use the `spr` prefix**: `__sprBridge`, `__sprBar*`
  window hooks, `#spr-statusbar`, `data-spr-padded`, `spr-statusbar-mode`
  (localStorage key), log `~/Library/Logs/spr-limitbar-bridge.log`. New
  DOM/global/storage names must follow.
- **Bump `BRIDGE_VERSION` in `bridge.mjs` on every edit.** A previously
  installed bridge keeps re-applying its own DOM/CSS via self-heal; without a
  version bump your change is overwritten within seconds and looks like a
  phantom regression.
- **The installer must dispose the previous bridge** (resolve the hook from
  both `prev.dispose` and `prev.state.dispose`), and the bridge must sweep
  legacy artifacts inside `apply()` on every cycle, not only at install.
- **The bar reserves layout space** (padding on the app's layout container) —
  it never overlays app UI. Verify with hit tests and a zero covered-visible
  count (see `skills/codex-limitbar/references/internals.md`).
- **Verify against the live app, not the editor**: install, then project the
  bar's state into a small JSON (version, `textContent`, DOM counts, padding)
  and capture the actual region. A look at the real pixels beats reading the
  diff.

## Conventions

- English everywhere: code, comments, docs, commit messages.
- Commits: imperative mood; `feat:` / `fix:` / `docs:` / `chore:` prefixes for
  follow-ups ("Initial commit" for the first one).
- `bridge.mjs` stays dependency-free: Node built-ins plus the app's own
  Electron/`codex` binary only. No npm install for the product itself.
- Shell scripts: bash with `set -eu`, correct quoting, self-documenting usage
  blocks at the top.
- Protocol shapes live in
  `skills/codex-limitbar/references/rate-limits-protocol.md` — update that file
  alongside any parser change in `bridge.mjs`.

## Testing a change (manual, on a real machine)

```bash
./start.sh          # attach or relaunch ChatGPT with the inspector, install
node --check bridge.mjs
python3 -m py_compile skills/codex-limitbar/scripts/probe_rate_limits.py
```

1. Install into the running app; from the shell window's dev console:
   `window.__sprBarGetState()` → `{version, mode, live, limits, meta}` and
   `document.querySelectorAll('#spr-statusbar').length === 1`.
2. Reload the window — the bar must return on its own with live numbers, not
   `sample data`.
3. Capture the bar region (`capturePage({x, y, width, height})` using the rect
   from `getBoundingClientRect()`) and look at it.

## Known traps

- A window reload does not drop main-process listeners of a superseded bridge;
  a full app restart is the clean reset when a swap must be immediate.
- The mascot overlay window shares the main shell's URL prefix
  (`app://-/index.html?initialRoute=%2Favatar-overlay`) — select shell targets
  by exact URL.
- The 5-hour window is suspended for many accounts: one limit row is normal;
  do not hardcode two.
- After a ChatGPT app update, re-verify the fuse state and the shell URL before
  assuming the bridge broke (see `skills/electron-app-patching/`).
