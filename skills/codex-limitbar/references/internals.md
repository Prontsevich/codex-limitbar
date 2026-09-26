# How the injection works (internals)

The engineering notes behind `limitbar.mjs` and `bar.js`: what they hook, why each piece
exists, and the rules that keep them stable. The generic methodology (fuses, CDP renderer
injection, recon of the ChatGPT app) lives in the external
[electron-app-patching](https://github.com/Prontsevich/electron-app-patching) skill. Up to
ChatGPT 26.917 the bar was installed through the Electron main-process inspector
(`--inspect`); 26.924.22138 disabled that path — it is documented there, not here.

## Install path

1. **Launch** (`start.sh`): ChatGPT is started via LaunchServices with
   `open -b com.openai.codex --args --remote-debugging-port=<p>`, `p` a free random port in
   20000–40000 (Chromium binds `127.0.0.1`). `open --args` is ignored by a running
   instance, so a running app without a port is quit gracefully first (`osascript`, then
   `pkill -TERM` fallback). The launcher waits for `/json/version` and then for the
   `app://-/index.html` target in `/json/list`.
2. **Identity check** (`lib/cdp.mjs` `verifyIdentity`, run on every connect and reconnect;
   `IdentityError` → exit 3):
   1. Port owner: `lsof -iTCP:<p> -sTCP:LISTEN` pids; exactly one must be the main
      executable in `<app>/Contents/MacOS` (realpath compare). Every other listener must
      descend from it — app children such as `SkyComputerUseService` inherit the socket.
   2. `/json/version` → `Browser` matches `Chrome/…` and has a `webSocketDebuggerUrl`.
   3. `/json/list` has a `page` with URL exactly `app://-/index.html`.
   4. In that page, `typeof window.codexWindowType !== 'undefined' && !!window.electronBridge`
      evaluates to `true`.
3. **Attach**: one browser-level websocket; `Target.setDiscoverTargets` + `Target.getTargets`;
   every eligible page (`isShellUrl`: exact shell URL or `app://-/index.html?…` without
   `avatar-overlay`) gets `Target.attachToTarget({flatten: true})` → `Page.enable`,
   `Runtime.enable`, `Page.addScriptToEvaluateOnNewDocument({source: bar.js})` and an
   immediate `Runtime.evaluate(bar.js)`. Concurrent attach requests for one target (the
   `targetCreated` burst vs the `getTargets` pass) share one in-flight promise.
4. **Reloads**: on `Page.loadEventFired` the agent checks
   `typeof window.__sprBarSetLimits === 'function'`; if missing it re-evaluates `bar.js`,
   then pushes the latest limits either way. A target that navigates away from the shell
   gets its new-document script removed and is detached.
5. **State**: after the first successful injection the agent writes
   `~/Library/Application Support/spr-limitbar/agent.json`
   `{pid, port, app, appPid, barVersion, startedAt}` (`CODEX_LIMITBAR_STATE_DIR` overrides).
   `start.sh` uses it for the fast path (agent alive + same app pid + same port).
6. **Lifetime**: when the browser websocket closes (app quit / relaunch) the agent retries
   the same port for 30 s — the app may relaunch itself with the same argv (its Node
   permission-model restart) — then removes the state file and exits. SIGTERM/SIGINT:
   `__sprBarRemove()` in every page, `Page.removeScriptToEvaluateOnNewDocument`, detach,
   exit 0. `--once` injects + pushes (+ captures) and disconnects without touching the
   running agent's state; the bar stays until the next reload.

The port itself cannot be closed from CDP: it lives until the app process exits.

## Layout: reserve space, never overlay

In the 26.924 shell the window frame holds a left icon rail (52 px), a top toolbar band
(44 px) and an inset rounded content card. The bar:

1. Finds the layout container among `#root`'s direct children by class prefix
   (`/(^|\s)_Layout_/` — the hash suffix changes per build), falling back to geometry
   (non-fixed, ≥ 85 % viewport height, ≥ 50 % width; boot loaders/toasts skipped).
2. Sets `padding-bottom: 28px` on it (replacing its native 4 px), marking the node
   `data-spr-padded` and saving the original inline value in `data-spr-orig-pad`.
3. Finds the content card inside it (`[class*="_PageSurface_"]`, ≥ 30 % width and ≥ 50 %
   height) and positions the fixed bar (`bottom: 0`, height 28 px) to the card's left/right
   edges, transparent — it reads as a frame band like the top toolbar; the icon rail stays
   clean.
4. No card → fallback class `.spr-flat`: full-width strip on `surface-under` with a top
   border. **No layout → no bar** (and any padding is restored): it never floats over
   unknown UI.
5. `z-index: 25`, below the app's overlay layer (`z-30`), so app modals cover the bar.
6. Self-heal: a debounced `MutationObserver` (childList + subtree, 250 ms, only re-applies
   when `needsApply()`), a `ResizeObserver` on the layout/card, `resize`, and a 20 s
   interval that also refreshes the countdowns. All writes are check-then-write, so the
   observer cannot loop.

## Theme tokens

Only the app's CSS custom properties (switched by `html[data-theme]`), each with a
fallback; theme changes need no JS.

| Bar role | Token |
|----------|-------|
| Primary / secondary / tertiary text | `--app-color-text-foreground`, `-foreground-secondary`, `-foreground-tertiary` |
| Percent text by remaining ≥ 50 / ≥ 25 / ≥ 10 / < 10 | `--app-color-text-success`, `--color-text-caution-surface`, `--app-color-text-warning`, `--app-color-text-error` |
| Mini-bar fills (same thresholds) | `--app-color-accent-green` / `-yellow` / `-orange` / `-red` |
| Mini-bar track | `--switch-track-color` |
| used/left toggle (mirrors the Chat/Work toggle) | `--color-background-mode-toggle-track`, `-selected`, `--color-border-mode-toggle-selected`, `--color-text-mode-toggle-primary`, `-inactive` |
| Font | `--font-ui-family` |
| `LIMITS` label | `--font-small-caps-md-size`, `-weight`, `-tracking` |
| Fallback strip (`.spr-flat`) | `--app-color-background-surface-under`, `--app-color-border` |

## Lifecycle and hot-swap

- `window.__sprBarState` is sticky (`{mode, live, meta, limits}`): it survives
  re-injection and `__sprBarRemove()`, so pushed limits are not lost on a swap.
- `window.__sprBarInstance = {version, apply, remove}`. Evaluating `bar.js` with the same
  `BAR_VERSION` only calls `apply()` (returns `"reapplied"`); a different version calls the
  previous instance's `remove()` first. Hence: **bump `BAR_VERSION` on every edit**.
- Before the DOM is ready (new-document script) the payload waits for `DOMContentLoaded`
  (returns `"deferred"`); React mounting is then picked up by the observer.
- `__sprBarRemove()` removes the bar and style node, restores padding exactly, disconnects
  both observers, clears the interval and the `resize` listener, and deletes the window
  hooks.
- Display mode persists in `localStorage['spr-statusbar-mode']` (`uninstall.sh` clears it
  while the agent's port is known).

## States

- No limits yet → `waiting for data…`.
- `__sprBarSetLimits([], {error})` → `limits unavailable` (error in the tooltip).
- Limits present → blocks + `used/left` toggle + note `live · updated HH:MM`; the note turns
  `stale` when `!live`, when `updatedAtMs` is older than 15 min, or when `meta.error` is set
  alongside the last good limits.
- ≤ 900 px wide: note hidden; ≤ 720 px: label and reset times hidden.

## Live data path

- `lib/limits.mjs`: `findCodex` (bundled `<app>/Contents/Resources/codex` first, then
  `PATH`, `~/.local/bin`, mise shims, Homebrew), `rpcFetch` (stdio JSON-RPC, 15 s budget),
  `parseLimits` (pure, unit-tested), `nameForWindow`. Protocol:
  `rate-limits-protocol.md`.
- Cadence: a 30 s tick; a poll when 5 minutes have passed, or immediately when a tick
  arrives more than 90 s late (the Mac slept). One poll in flight at a time.
- Each successful read is pushed into every attached page with
  `__sprBarSetLimits(limits, meta)` — and right after every injection, so a reloaded
  window shows live numbers at once. A failed read is logged and pushed as `meta.error`:
  the bar keeps the last good numbers marked `stale` (error in the tooltip), or shows
  `limits unavailable` when no read has succeeded yet. The next good read clears it.
- `rpcFetch` SIGTERMs the app-server after the answer and SIGKILLs it after a 2 s grace;
  a process `exit` handler kills any child still alive, so none outlives the agent.

## Files

- Log: `~/Library/Logs/spr-limitbar.log` (identity, injections, reloads, limits reads —
  parsed numbers only, never response bodies or tokens).
- State: `~/Library/Application Support/spr-limitbar/agent.json`; `raycast-link` in the
  same dir records where `install.sh --raycast` put its symlink.

## Verification checklist (after any change)

Project the bar's state into a small JSON with `scripts/cdp-eval.mjs`:

- `__sprBarGetState().version` equals the new `BAR_VERSION`; `live: true`.
- `document.querySelectorAll('#spr-statusbar').length === 1`.
- `textContent` has the expected labels / percentages / times in order.
- The padded container's computed `padding-bottom` is `28px`; after `__sprBarRemove()` it
  is back to the original (`4px` computed, empty inline) and no `data-spr-*` remain.
- Geometry: `elementFromPoint(x, barTop - 6)` hits app UI and `elementFromPoint(x,
  barTop + 12)` hits the bar at several x positions; covered-visible element count in the
  bar strip is 0.
- `location.reload()` → log `reload: bar present`, live numbers return.
- Screenshot (`--png` / `start.sh --capture`) in both themes — switch only via
  `document.documentElement.dataset.theme` and restore the previous value.
