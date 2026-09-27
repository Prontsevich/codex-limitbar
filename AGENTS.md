# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

A macOS utility that injects a rate-limit status bar into the local UI of the
ChatGPT desktop app (`/Applications/ChatGPT.app`, bundle id `com.openai.codex`,
an Electron fork on OpenAI's Owl engine since 26.924) at runtime over the Chrome
DevTools Protocol — no bundle modification. Two parts:

- **The product**
  - `bar.js` — the page payload (DOM, styles, hooks), injected into
    `app://-/index.html`.
  - `limitbar.mjs` — the agent: identity check, CDP attach, injection, limits
    polling; runs until the app quits.
  - `lib/cdp.mjs` (CDP client + identity check), `lib/limits.mjs` (app-server
    JSON-RPC + parser), `test/` (`node --test`).
  - `start.sh` (launcher), `install.sh` (PATH command, `--raycast`),
    `uninstall.sh`, `raycast/codex-limitbar.sh` (Raycast Script Command),
    `install-skills.sh` (agent-skill installer).
- **The skill**: `skills/codex-limitbar/` (product + protocol reference,
  `scripts/cdp-eval.mjs`, `scripts/probe_rate_limits.py`). The general
  methodology skill lives in its own repo:
  https://github.com/Prontsevich/electron-app-patching.

## Ground rules

- **Never modify `/Applications/ChatGPT.app`** — no repack, no re-sign. The
  method depends on zero disk changes; the signature and TCC permissions stay
  intact.
- **All runtime identifiers use the `spr` prefix**: `__sprBar*` window hooks,
  `__sprBarState` / `__sprBarInstance`, the CDP binding `__sprBarRefreshBinding`,
  `#spr-statusbar`, `#spr-statusbar-panel`, `#spr-statusbar-style`,
  `data-spr-padded` / `data-spr-orig-pad` / `data-spr-version`,
  `spr-statusbar-mode` / `spr-statusbar-pace` / `spr-statusbar-notify` /
  `spr-statusbar-notified` (localStorage keys), state dir
  `~/Library/Application Support/spr-limitbar/`, log
  `~/Library/Logs/spr-limitbar.log`. New DOM/global/storage/file names must
  follow.
- **Bump `BAR_VERSION` in `bar.js` on every edit.** A live bar re-applies its
  own DOM/CSS via self-heal; same version = re-apply, different version = the
  old instance is removed first. Without a bump your change never replaces the
  running one and looks like a phantom regression. The agent reads the version
  with `/BAR_VERSION\s*=\s*(\d+)/`.
- **`bar.js` must stay idempotent and self-contained**: it runs both before the
  DOM exists (`Page.addScriptToEvaluateOnNewDocument`) and into a loaded page
  (`Runtime.evaluate`), possibly several times (reload, `--once`/`--capture`
  second clients). It waits for the DOM itself, and `__sprBarRemove()` must
  restore the layout exactly.
- **The bar reserves layout space** (padding on the app's layout container) —
  it never overlays app UI. No layout found → no bar. Verify with hit tests and
  a zero covered-visible count (see `skills/codex-limitbar/references/internals.md`).
  The details panel is the one exception: a transient overlay the user opens,
  closed by outside click / Escape / blur, kept below the app's modals
  (z-index 29 vs the app's z-30 layer).
- **Colors come from the app's theme tokens** (`--app-color-*` and related,
  with fallbacks) — no hardcoded theme colors; theme switching must work with
  no JS.
- **Notifications** (Web Notification API in the page, shown as ChatGPT's own):
  always titled `LimitBar …`, each event at most once per window cycle (dedupe
  keys in `spr-statusbar-notified`, reset times rounded to 10 min), and **never
  call `Notification.requestPermission()`** — without permission the panel shows
  a hint instead. Test event logic with `__sprBarSetNotifyDryRun(true)`; a live
  test shows at most one `__sprBarTestNotify()` banner.
- **Never weaken the identity check** (`lib/cdp.mjs` `verifyIdentity`, mirrored
  in `cdp-eval.mjs`): port owner → CDP endpoint → exact shell page → shell
  globals. Every entry point that evaluates code runs it first.
- **Verify against the live app, not the editor**: install, then project the
  bar's state into a small JSON (version, `textContent`, DOM counts, padding)
  and capture the actual region. Captures must never show the user's sidebar
  or chats: clip to the bar, or blur `#root` temporarily for panel shots. A look at the real pixels beats reading the
  diff.

## Conventions

- English everywhere: code, comments, docs, commit messages.
- Commits: imperative mood; `feat:` / `fix:` / `docs:` / `chore:` prefixes.
- Product code stays dependency-free: Node built-ins only (Node >= 22 for the
  global `WebSocket`/`fetch`). No npm install.
- Shell scripts: bash with `set -eu`, correct quoting, self-documenting usage
  blocks at the top.
- Protocol shapes live in
  `skills/codex-limitbar/references/rate-limits-protocol.md` — update that file
  alongside any parser change in `lib/limits.mjs` (and extend
  `test/limits.test.mjs`).

## Testing a change (manual, on a real machine)

```bash
for f in limitbar.mjs lib/*.mjs bar.js skills/codex-limitbar/scripts/cdp-eval.mjs; do node --check "$f"; done   # one file per call
node --test                                  # parser / window names / binary lookup
bash -n start.sh install.sh uninstall.sh install-skills.sh raycast/codex-limitbar.sh
./start.sh                                   # attach, or relaunch ChatGPT once with a CDP port
./start.sh --status                          # note the CDP port
./start.sh --doctor                          # read-only report: app, CLI, port, page, bar, agent, log
```

1. Read the live state (port from `--status`):
   `node skills/codex-limitbar/scripts/cdp-eval.mjs --port <p> -e 'JSON.stringify({s: __sprBarGetState(), n: document.querySelectorAll("#spr-statusbar").length})'`
   → the new `version`, `live: true`, and `n === 1`.
2. Reload the window (`-e 'location.reload()'`) — the log must show
   `reload: bar present`, and the bar must come back with live numbers.
3. `./start.sh --capture` (or `cdp-eval.mjs … --png out.png`) and LOOK at the
   image, in both themes if you touched styles. These capture the whole window —
   keep them local; see the capture notes in `internals.md` before sharing any.
4. Panel: `-e '__sprBarSetPanel(true)'`, check it renders and closes on an
   outside `pointerdown` / Escape; press its refresh button — the log shows
   `limits live (manual)`.
5. `./start.sh --stop` — bar and panel disappear and the padding is restored.

`cdp-eval.mjs -e` runs in the page's global scope: wrap multi-statement
expressions in an IIFE, or a second `const x` in a later call throws.

To test a `bar.js` edit without restarting the agent: `./start.sh --stop`,
then `./start.sh` (it re-attaches to the open port with the new file).

## Known traps

- The CDP port stays open for the app's lifetime; `--stop` removes the bar, not
  the port. A clean slate needs a normal app restart
  (`./uninstall.sh --restart-app` does it).
- Child processes of the app (e.g. `SkyComputerUseService`) inherit the
  listening socket, so `lsof` shows several listeners — the identity check
  accepts descendants of the app's main process only.
- The mascot overlay window shares the shell URL prefix
  (`app://-/index.html?initialRoute=%2Favatar-overlay`) — select shell targets
  by exact URL / `isShellUrl()`.
- Class names carry build hashes (`_Layout_gs442_2`) — match by prefix
  (`[class*="_Layout_"]`, `[class*="_PageSurface_"]`), with a geometry fallback.
- The 5-hour window is suspended for many accounts: one limit row is normal;
  do not hardcode two.
- After a ChatGPT app update, re-check the fuses and that
  `--remote-debugging-port` still exposes `app://-/index.html`, before
  assuming the bar broke (fuse reader in the electron-app-patching repo).
  Sparkle relaunches the app without the port — the agent exits; re-run
  `start.sh`.
