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
   `Runtime.enable`, `Runtime.addBinding({name: '__sprBarRefreshBinding'})` (not for
   `--once`), `Page.addScriptToEvaluateOnNewDocument({source: bar.js})` and an
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
   `__sprBarRemove()` in every page, `Runtime.removeBinding`,
   `Page.removeScriptToEvaluateOnNewDocument`, detach, exit 0. `--once` injects + pushes (+ captures) and disconnects without touching the
   running agent's state; the bar stays until the next reload.

The port itself cannot be closed from CDP: it lives until the app process exits.

## Refresh channel (page → agent)

The panel's refresh button calls `window.__sprBarRefreshBinding('refresh')`, a CDP binding
the agent adds per session (bindings survive reloads within the session). The agent gets
`Runtime.bindingCalled` and runs `poll('manual')` — or, if the last read is under 10 s old,
logs `manual refresh throttled` and re-pushes the current numbers. Either way it then
evaluates `__sprBarRefreshDone()` so the spinner stops; the page also gives up after 20 s
(an agent that died leaves a stale binding function behind). Without the binding (`--once`,
an older agent) the refresh button is not rendered.

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
| used/left toggle in the panel (mirrors the Chat/Work toggle) | `--color-background-mode-toggle-track`, `-selected`, `--color-border-mode-toggle-selected`, `--color-text-mode-toggle-primary`, `-inactive` |
| Bar hover / expanded, panel badge | `--menu-item-background-color` |
| Panel surface, shadow, radius, font size, separators | `--menu-background-color`, `--menu-box-shadow`, `--popover-radius`, `--menu-font-size`, `--menu-separator-background-color` |
| Status dot live / stale / no data | `--app-color-accent-green` / `-orange`, tertiary text |
| Font | `--font-ui-family` |
| `LIMITS` label | `--font-small-caps-md-size`, `-weight`, `-tracking` |
| Fallback strip (`.spr-flat`) | `--app-color-background-surface-under`, `--app-color-border` |
| Pace tick (bar) / marker (panel) | secondary / primary text color; the panel marker is ringed with `--menu-background-color` so it reads over fill and track |
| Over-pace text (> 10) and run-out line | `--app-color-text-warning` |
| Settings switches | `--switch-track-width`, `-height`, `--switch-track-color`, `-color-checked`, `--switch-thumb-size`, `-offset`, `-color`, `-shadow` |

## Lifecycle and hot-swap

- `window.__sprBarState` is sticky (`{mode, live, meta, limits}`): it survives
  re-injection and `__sprBarRemove()`, so pushed limits are not lost on a swap.
- `window.__sprBarInstance = {version, apply, remove}`. Evaluating `bar.js` with the same
  `BAR_VERSION` only calls `apply()` (returns `"reapplied"`); a different version calls the
  previous instance's `remove()` first. Hence: **bump `BAR_VERSION` on every edit**.
- Before the DOM is ready (new-document script) the payload waits for `DOMContentLoaded`
  (returns `"deferred"`); React mounting is then picked up by the observer.
- `__sprBarRemove()` closes the panel (removing its document/window listeners), removes the
  bar, panel and style nodes, restores padding exactly, disconnects both observers, clears
  the intervals, refresh timer and the `resize` listener, and deletes the window hooks.
- Display mode persists in `localStorage['spr-statusbar-mode']` (`uninstall.sh` clears it
  while the agent's port is known); the pace switch in `spr-statusbar-pace` (`on|off`),
  notification settings in `spr-statusbar-notify`, sent-notification keys in
  `spr-statusbar-notified`.

## States

- No limits yet → `waiting for data…`.
- `__sprBarSetLimits([], {error})` → `limits unavailable` (the error is in the panel).
- Limits present → blocks, then a status dot + chevron at the right end. The dot is green
  when live, orange when stale: `!live`, `updatedAtMs` older than 15 min, or `meta.error`
  set alongside the last good limits. No tooltips; the bar's `aria-label` carries
  `live|stale, updated HH:MM`.
- ≤ 720 px wide: label and reset times hidden.

## Details panel

- The bar is a button (`role=button`, `tabindex=0`, `aria-haspopup=dialog`,
  `aria-controls`, `aria-expanded`); click or Enter/Space toggles
  `#spr-statusbar-panel` (`role=dialog`). `__sprBarSetPanel(open, view?)` does the same.
- The panel is the **one transient overlay**: user-opened, it may cover app UI while open.
  `position: fixed`, left-aligned with the bar (clamped into the viewport), bottom 6 px
  above the bar, width `min(320px, 100vw − 24px)`, `max-height` down to the window top with
  internal scroll. `z-index: 29` — above page content and the bar (25), below the app's
  z-30 overlay layer and its modals/menus, so an app dialog is never hidden behind it.
- Closes on an outside `pointerdown` (capture), Escape on the main view (focus returns to
  the bar), a second bar click, window `blur`, a missing layout, `__sprBarRemove()` and any
  hot-swap — from either view.
- Two views in the same element (`panelView` in `__sprBarGetState()`): **main**
  (information only) and **settings**. Opening always starts on main (the hook can pass
  `'settings'`). The gear (`data-spr-settings`) switches to settings and focuses the active
  used/left button; ← (`data-spr-back`) or Escape returns to main and focuses the gear.
  The panel is anchored by its `bottom`, so a taller view grows upward without moving the
  bottom edge; the view switch resets `scrollTop`. `aria-label` follows the view
  (`Codex usage limits` / `LimitBar settings`).
- Content: header (`Codex`, plan badge, `Updated … ago` + dot, refresh button), one block per
  window (title from `windowDurationMins`: 5-hour / Daily / N-day / Weekly), reset credits
  (count, next expiry, title — no "Reset now" action), warnings (`limitReached`,
  `spendControlReached`, `usageAllowed: false`, `meta.error`). Settings view: DISPLAY
  (`Show used|left`, `Pace marker`), NOTIFY ME (four switches + permission hint), ABOUT
  (bar version, source, refresh interval, `./start.sh --doctor`). Relative times re-render
  every 10 s while open. All dynamic text goes through
  `esc()`.
- Motion: open plays `spr-pop` (180 ms, fade + 6 px rise + 0.97 scale from the bar side);
  close adds `.spr-closing` (`spr-out`, 140 ms) and removes the node on `animationend`
  (250 ms fallback) — `ensurePanel()` discards a still-closing node if the panel reopens.
  A view switch freezes the old height, swaps the content, and transitions `height` to the
  new natural height (220 ms, `.spr-resizing` hides overflow meanwhile) while the new
  content fades in (`.spr-swap`); the inline height is cleared afterwards. Everything is
  skipped under `prefers-reduced-motion: reduce`.
- The `Show used|left` row (`.spr-opt-seg`) has a 2.5 px bottom margin: the 24 px segmented
  toggle sits in a 26 px row, so without it the gap to the next switch is 4.5 px instead of
  the 7 px between switches.
- `font-variant-numeric: tabular-nums` only on numeric rows: Inter's `tnum` also widens
  the hyphen ("5 - hour").

## Pace

For a window with `windowDurationMins` and `resetsAtMs`:
`elapsed = clamp(1 − (resetsAtMs − now) / (windowDurationMins·60000), 0, 1)` and
`delta = usedPercent − elapsed·100`.

- Skipped when the window length or reset time is missing, or `elapsed < 2%`.
- Marker at `elapsed` (used mode) or `1 − elapsed` (left mode): a 1 px tick on the bar's
  mini bar, a 2 px ringed marker on the panel's bar.
- Panel line: `|delta| < 5` → `On pace`; `delta > 0` → `N% over pace` (warning color when
  `> 10`); `delta < 0` → `N% under pace`. Over pace with a projected run-out
  `now + (100 − used) / (used / elapsedMs)` before the reset → `At this pace: out in …`.
- `Pace marker` switch / `__sprBarSetPace(bool)` hides every marker and line.

## Notifications

- Sent from the page with `new Notification('LimitBar · Codex', {body, tag: key})`, so
  macOS shows them as ChatGPT's (its permission — already granted to `app://-` — and its
  Notification settings). `Notification.requestPermission()` is never called; without
  permission the panel shows a hint and nothing is marked as sent. Clicking one focuses
  the window and opens the panel.
- Evaluated on every push (`__sprBarSetLimits`) and on the 20 s tick, so a reset is
  announced on time without waiting for a poll. Before a push replaces the limits, the
  previous ones are checked for a reset that just happened.
- Events and dedupe keys (window id = `windowDurationMins`; times rounded to 10-minute
  slots because `resetsAt` jitters by a second between reads):

  | Event (default) | Condition | Key |
  |-----------------|-----------|-----|
  | Reset (on) | weekly window only (`windowDurationMins ≥ 10080`), `now ≥ resetsAtMs`, at most 6 h late, and > 0% had been used | `reset:<mins>:<slot>` |
  | Credit (on) | next reset credit expires within 24 h | `credit:<slot>` |
  | < 25% left (off) | remaining < 25 | `low25:<mins>:<slot>` |
  | < 10% left (off) | remaining < 10 (also marks `low25`, so it never follows) | `low10:<mins>:<slot>` |

- Keys live in `localStorage['spr-statusbar-notified']` (shared by all shell windows,
  pruned after 45 days). Settings in `spr-statusbar-notify`
  (`{reset, credit, low25, low10}`).
- Test hooks: `__sprBarSetNotifyDryRun(true)` records would-be notifications in
  `__sprBarGetState().notify.log` with an in-memory dedupe (localStorage untouched);
  `__sprBarTestNotify()` shows one `LimitBar · test` banner; `__sprBarSetNotify({...})`
  changes settings.

## Live data path

- `lib/limits.mjs`: `findCodex` (bundled `<app>/Contents/Resources/codex-cli/bin/codex`
  (26.924+), then the pre-26.924 `<app>/Contents/Resources/codex`, then `PATH`,
  `~/.local/bin`, mise shims, Homebrew; the agent logs `limits source: …` on change), `rpcFetch` (stdio JSON-RPC, 15 s budget),
  `parseLimits` (pure, unit-tested), `nameForWindow`. Protocol:
  `rate-limits-protocol.md`.
- Cadence: a 30 s tick; a poll when 5 minutes have passed, or immediately when a tick
  arrives more than 90 s late (the Mac slept). One poll in flight at a time.
- Each successful read is pushed into every attached page with
  `__sprBarSetLimits(limits, meta)` — and right after every injection, so a reloaded
  window shows live numbers at once. A failed read is logged and pushed as `meta.error`:
  the bar keeps the last good numbers marked `stale` (error in the panel), or shows
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
- `location.reload()` → log `reload: bar present`, live numbers return, panel closed.
- Pace: `__sprBarSetPace(false)` → no `.spr-tick` / `.spr-mark` / `.spr-pace` nodes;
  `true` brings them back.
- Notifications: with `__sprBarSetNotifyDryRun(true)` push synthetic limits and check the
  log — reset, both thresholds, credit expiry, no repeat on a second push, nothing with the
  settings off; turn dry-run off after restoring the real limits.
- Panel: `__sprBarSetPanel(true)` → one `#spr-statusbar-panel`, `aria-expanded="true"`;
  a synthetic `pointerdown` on `#root` and an Escape `keydown` both close it; in settings
  (`__sprBarSetPanel(true, 'settings')` or a gear click) Escape / ← go back to main with the
  bottom edge unchanged (measure after the 180 ms open / 220 ms resize animations); the refresh
  button logs `limits live (manual)` and a second click within 10 s logs `throttled`.
- Screenshot (`--png` / `start.sh --capture`) in both themes — switch only via
  `document.documentElement.dataset.theme` and restore the previous value. The window frame
  is translucent over native glass, which CDP captures as gray: set
  `Emulation.setDefaultBackgroundColorOverride` (and, for the bar strip, a temporary
  `html` background) during the capture and clear both after. Never publish captures that
  show the sidebar or chat content — blur `#root` (a temporary style) for panel shots.
