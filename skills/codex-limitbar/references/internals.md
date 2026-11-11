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
   `--once`), `Page.addScriptToEvaluateOnNewDocument` and an immediate
   `Runtime.evaluate` of the bar and native observer. Concurrent attach requests for one target (the
   `targetCreated` burst vs the `getTargets` pass) share one in-flight promise.
4. **Reloads**: on `Page.loadEventFired` the agent checks
   `typeof window.__sprBarSetLimits === 'function'`; if missing it re-evaluates the payload,
   then pushes the latest limits either way. A target that navigates away from the shell
   gets its new-document script removed and is detached.
5. **State**: after the first successful injection the agent writes
   `~/Library/Application Support/spr-limitbar/agent.json`
   `{pid, port, app, appPid, barVersion, startedAt}` (`CODEX_LIMITBAR_STATE_DIR` overrides).
   `start.sh` uses it for the fast path (agent alive + same app pid + same port).
   Direct reads and native window changes update `limits.json`
   `{atMs, limits, accountScope}` in that directory. Unchanged native windows refresh
   it at most once per 5 minutes. The prior snapshot is carried into the push as
   `meta.prevLimits` / `meta.prevAtMs` for offline rollover detection. Snapshots older
   than 30 days or with a different account fingerprint are ignored. Legacy unscoped
   snapshots can only be compared with another unscoped read.
6. **Lifetime**: when the browser websocket closes (app quit / relaunch) the agent retries
   the same port for 30 s — the app may relaunch itself with the same argv (its Node
   permission-model restart) — then removes the state file and exits. SIGTERM/SIGINT:
   `__sprBarRemove()` in every page, `Runtime.removeBinding`,
   `Page.removeScriptToEvaluateOnNewDocument`, detach, exit 0. `--once` injects,
   reads once, and disconnects without writing the running agent's state; the bar
   stays until the next reload. Capturing an already running bar uses a read-only
   connection to the verified shell.

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

1. Finds `[data-app-shell-frame]` inside `#root` on the 26.1103 shell, where the frame
   is nested under a `display: contents` wrapper. On older shells it checks `#root`'s
   direct children for the `_Layout_` class prefix, then falls back to geometry
   (non-fixed, ≥ 85 % viewport height, ≥ 50 % width; boot loaders/toasts skipped).
2. Sets `padding-bottom: 28px` on it (replacing its native 4 px), marking the node
   `data-spr-padded` and saving the original inline value in `data-spr-orig-pad`.
3. Finds the content card inside it (`PageSurface-` class prefix under
   `[data-app-shell-workspace]` on 26.1103, `_PageSurface_` on older shells, ≥ 30 % width
   and ≥ 50 % height) and positions the fixed bar (`bottom: 0`, height 28 px) to the card's left/right
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

The optional sidebar position mounts the same trigger as the first item in the native
rail footer. It restores the original bottom padding and opens the details panel to the
right of the trigger when there is room. When the native footer cannot be identified,
the trigger falls back to the bottom strip. The saved preference is
`localStorage['spr-statusbar-position']`; `__sprBarGetState()` reports it as `position`
and reports the actual trigger location as `placement`.

The panel's bottom edge uses a fixed window inset above the bottom strip. The first
display change in Settings pins its horizontal position until it closes. Window
resizing clamps it to the visible area. The style picker uses the host menu colors
with native select keyboard behavior. Position changes expand or collapse the style
row while preserving the other Settings controls.

Position changes release the outgoing indicator's space as it disappears. The bottom
strip slides in sync with the layout padding, and the sidebar trigger animates its
height and footer spacing. Start and graceful stop use the same motions. Hot
replacement tears down immediately, as do reduced-motion and hidden-page transitions.

The `Sidebar style` setting appears when Sidebar is selected. Its storage key is
`spr-statusbar-sidebar-style` and its state field is `sidebarStyle`. The bottom
fallback always renders the strip. Vertical and horizontal meters and rings use
the same fills, thresholds, and even-pace calculation as the strip. The weekly
meter is taller in a vertical pair and thicker in a horizontal pair.

Vibe Slots renders a fixed dark cabinet with quota colors from the host. The
reels use exact 100% to select the star or skull symbols. A live push starts a
spin when the shown faces change, or when the panel is waiting for a manual
refresh. The details panel's `Pull lever` action replays the current faces without
requesting new limits. Reduced motion and hidden pages get the settled value immediately.
Changing style, replacing the indicator, or removing it cancels any active
reel motion and restores the settled DOM.

## Theme tokens

Only the app's CSS custom properties (switched by `html[data-theme]`), each with a
fallback; theme changes need no JS.

| Bar role | Token |
|----------|-------|
| Primary / secondary / tertiary text | `--app-color-text-foreground`, `-foreground-secondary`, `-foreground-tertiary` |
| Percent text by remaining ≥ mid / ≥ low / ≥ crit / < crit (defaults 50 / 25 / 10) | `--app-color-text-success`, `--color-text-caution-surface`, `--app-color-text-warning`, `--app-color-text-error` |
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
  the intervals, refresh timer and the `resize` listener, drops the current bar event and
  deletes the window hooks.
- Display mode persists in `localStorage['spr-statusbar-mode']` (`uninstall.sh` clears it
  while the agent's port is known); the pace switch in `spr-statusbar-pace` (`on|off`),
  notification settings in `spr-statusbar-notify`, sent-notification keys in
  `spr-statusbar-notified`, the last announced reset in `spr-statusbar-event`
  (`{text, body, atMs}`, restored on load so the panel's line survives a reload), color
  thresholds in `spr-statusbar-thresholds`
  (`{d: {crit, low, mid}, w: {'<windowDurationMins>': {…}}}` — a window entry overrides the
  defaults for that window; an override equal to the defaults is not stored).

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
  internal scroll. `z-index: 49` — above page content, the bar (25), and the peeking
  sidebar (40), below the app's z-50 modals/menus in ChatGPT 26.928, so an app dialog
  is never hidden behind it.
- Closes on an outside `pointerdown` (capture), Escape on the main view (focus returns to
  the bar), a second bar click, window `blur`, a missing layout, `__sprBarRemove()` and any
  hot-swap — from any view.
- Three views in the same element (`panelView` in `__sprBarGetState()`): **main**
  (information only), **settings** and **credits**. Opening always starts on main (the hook
  can pass `'settings'` or `'credits'`). The gear (`data-spr-settings`) switches to settings
  and focuses the active used/left button; the main view's `View all` row
  (`data-spr-credits`, shown only when the pushed list is non-empty) switches to credits.
  ← (`data-spr-back`) or Escape returns to main and restores focus to the row it came from
  (`data-spr-credits` or the gear). The panel is anchored by its `bottom`, so a taller view
  grows upward without moving the bottom edge; the view switch resets `scrollTop`.
  `aria-label` follows the view (`Codex usage limits` / `LimitBar settings` /
  `LimitBar reset credits`).
- Content: header (`Codex`, plan badge, `Updated … ago` + dot, refresh button), one block per
  window (title from `windowDurationMins`: 5-hour / Daily / N-day / Weekly), reset credits
  (count, next expiry, title, `View all · N` — no "Reset now" action), warnings
  (`limitReached`, `spendControlReached`, `usageAllowed: false`, `meta.error`). The credits
  view lists one row per available credit, soonest expiry first: `title` on the left,
  `in 13d 23h · 22 Oct` on the right (relative countdown plus a deterministic short date —
  `fmtDate` builds it from `MONTHS`, the system locale is deliberately not used). A footer
  states that spending a credit happens in ChatGPT itself. Settings view: DISPLAY
  (`Position`, `Sidebar style` when applicable, `Show used|left`, `Pace marker`),
  COLOR THRESHOLDS (`Apply to` scope + three `−/+`
  fields), NOTIFY ME (four switches + permission hint), ABOUT (bar version, source,
  refresh interval, `./start.sh --doctor`). Relative times re-render every 10 s while open.
  All dynamic text goes through `esc()`.
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

## Color thresholds

`levelFor(remaining, t)` maps the amount **remaining** to `ok`/`mid`/`low`/`crit`:
`remaining < t.crit` → red, `< t.low` → orange, `< t.mid` → yellow, else green. `t` is
`threshFor(limit)`: the window's override from `spr-statusbar-thresholds`, else the global
defaults (50 / 25 / 10). `threshFor` clamps the ordering (`crit < low < mid`) so an
inconsistent store can never produce a nonsensical color. The bar block, the panel bar and
the percent number all take the per-window level (so one window can differ from another).

Settings (`COLOR THRESHOLDS`) edits one scope at a time: `Apply to` selects `All` (the
global defaults) or a window (`windowDurationMins`), the three `−`/`+` fields carry the
value (the middle one is a text field for exact entry, `input` mode). `setThresh` settles
the edited values in range and ordered, writes `spr-statusbar-thresholds`, and drops an
override that now equals the defaults. Scope resets to `All` each time the panel opens
(`threshScope`), and `__sprBarSetThresholds({scope, reset: true})` restores a scope's
defaults. `__sprBarSetThresholds({crit, low, mid})` with no scope edits the global defaults.

## Notifications

- **Two channels, one event — and only when the reset is off schedule.** Whether a roll is
  the schedule is decided by *where the new cycle started*: `resetsAt − windowDurationMins`
  of the fresh snapshot against the `resetsAt` the previous one announced. Within
  `SCHEDULE_TOLERANCE_MS` (3 h) it is the weekly plan doing its thing and
  `announce(..., quiet)` writes the panel line only. Further away it is the provider's own
  decision: the same record plus the bar chip (45 s, `EVENT_MS`, success colour), the text
  `Weekly limit reset (off schedule)` in the panel for a day (`EVENT_VISIBLE_MS`) and, when
  the page may notify, the system notification. Using the cycle start rather than the clock
  makes the test independent of *when* we look — which is what the closed-app case needs.
  Everything is exposed as
  `__sprBarGetState().event = {chip, text, body, atMs, resetAtMs, chipUntilMs}`; the panel
  shows `resetAtMs` (with a date when it is not today).
- **A roll that happened while the app was closed** is noticed on the next start: the page
  has no `st.limits` yet, so `__sprBarSetLimits` compares against `meta.prevLimits` from
  `limits.json` and the same `checkRollover` runs, with the event text gaining
  `, while closed`. Nothing is reported if the gap is longer than the snapshot's 30-day
  ceiling, if the app was closed on a fresh install, or if more than one cycle passed (one
  event, not two).

- **The permission is not free.** `Notification.permission` sits at `default` in this
  shell until something asks (the app's own renderer has a `[desktop-notifications]`
  module that calls `requestPermission()` for exactly that reason), and a `default`/`denied`
  permission makes `new Notification()` useless — silently, with nothing marked. That was
  the real cause of "the reset notification never fires": no `spr-statusbar-notified` key
  ever appeared in the shell's localStorage. `Notification.requestPermission()` is
  therefore called in exactly one place — the Settings **Enable…** row — never on load or
  on a timer. Settings shows the button for `default`, points at System Settings →
  Notifications for `denied`, and says "allowed" for `granted`.
- `announce()` marks its dedupe key whatever the permission: one window cycle is one
  event, and granting permission later never releases a backlog of stale alerts.
  `notify()` (low25 / low10 / credit) keeps the old rule — marked only on a successful
  `show()`, so nothing is swallowed while permission is missing.
- **The reported `resetsAt` is not the moment the counters zero out.** Measured on the
  weekly window on 2026-10-28: usage fell 52% → 0% at ~06:35Z while `resetsAt` was
  `07:20:07Z` (43 min later, 7 days after the previous cycle). A clock test alone
  therefore never fires — at 06:37 the stamp was still in the future, and once it passed
  the snapshot already held the new window, so `usedPercent > 0` was false. Hence
  `checkRollover()`: two consecutive pushes of the same window with `resetsAtMs` moved
  forward (by more than a minute) and the previous one having used > 0%. Both paths use
  the same dedupe key, so a roll that satisfies both announces once.
- Evaluated on every push (`__sprBarSetLimits`) and on the 20 s tick, so a reset is
  announced on time without waiting for a poll. Before a push replaces the limits, the
  previous ones are checked for a reset that just happened.
- Events and dedupe keys (window id = `windowDurationMins`; times rounded to 10-minute
  slots because `resetsAt` jitters by a second between reads):

  | Event (default) | Condition | Key |
  |-----------------|-----------|-----|
  | Reset (on) | weekly window only (`windowDurationMins ≥ 10080`) and > 0% had been used, detected either way: `now ≥ resetsAtMs` (at most 6 h late — always the scheduled roll, recorded silently) **or** the same window's `resetsAtMs` moved forward between two pushes (loud only when `resetsAt − windowDurationMins` is more than 3 h away from the old stamp) | `reset:<mins>:<slot>` |
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
- `lib/native-limits.mjs` subscribes to the shell's usage cache in the main frame.
  It accepts a single observed, account-scoped `rate-limit-status` query whose
  payload matches that account. It projects the usage windows and status fields
  into the existing parser's input and forwards the cache's own update time.
  The account ID is used only in memory to match direct reads. The saved snapshot
  keeps an account fingerprint so a restart on another account cannot report a
  rollover from the previous account's windows.
- Fresh native updates suppress periodic reads. The 30 s tick checks for a
  5-minute-old or missing native snapshot and for an announced reset that has
  passed by at least 5 s. Foreground and panel-open signals check data older
  than 1 minute. Manual refresh still reads directly with the 10 s throttle.
  Only one direct read is in flight. If a newer native snapshot arrives during
  the read, it stays on the bar. A cache replay with a newer timestamp cannot
  move the bar back to an older window or a lower percentage in the same window
  after a direct read.
- The window cache can include only the reset-credit count. The direct read
  fills in missing details for the same account and count, without replacing
  newer usage windows. The fallback also works on desktop builds that lack
  the expected private cache shape.
- A tick arriving more than 90 s late indicates sleep. On wake, the agent first
  replaces its CDP connection, then checks whether the reattached window has a
  fresh native snapshot before reading directly.
- Each successful read is pushed into every attached page with
  `__sprBarSetLimits(limits, meta)` — and right after every injection, so a reloaded
  window shows live numbers at once. A failed read is logged and pushed as `meta.error`:
  the bar keeps the last good numbers marked `stale` (error in the panel), or shows
  `limits unavailable` when no read has succeeded yet. The next good read clears it.
- A delivery timeout (even with an open WebSocket), another transport error, or loss
  of all shell sessions starts one connection recovery. The agent discards old
  sessions, closes the old socket, repeats the full identity check, reinjects the bar,
  pushes cached limits, and falls back to a read if needed. Delayed events and attach completions from
  the old connection cannot replace sessions on the new connection. Page exceptions
  are logged without reconnecting. Retries back off from 1 s to 30 s and continue
  while the app owns the debugging port; the agent exits once that ownership has
  been absent for 30 s. A normal app restart without the port still needs `start.sh`.
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
- Reset chip, two cases. **Scheduled:** push a weekly window with `usedPercent > 0` and
  `resetsAtMs` ~45 min ago, then the same window with `resetsAtMs` seven days later and
  `usedPercent: 0` — no chip, no banner, no `notify.log` entry, but
  `__sprBarGetState().event.text` is `Weekly limit reset` and the panel shows the line.
  **Off schedule:** the same two pushes with the first `resetsAtMs` three days in the *future*
  — the chip `Weekly limit reset` appears in the label slot, the panel says
  `Weekly limit reset (off schedule)`, the dry-run log gains the key, the chip is gone after
  45 s and a repeated push announces nothing. **While closed:** write
  `~/Library/Application Support/spr-limitbar/limits.json` by hand (`{atMs: now-2h, limits:
  [{name:'Weekly', usedPercent:52, resetsAtMs: <now + 3 d>, windowDurationMins:10080}]}`), then
  `./start.sh --stop && ./start.sh` — the first push compares against it, the log says
  `prev snapshot: … old` and the panel reads `(off schedule, while closed)`. Delete the file
  afterwards; the agent rewrites it on the next poll anyway.
- Panel: `__sprBarSetPanel(true)` → one `#spr-statusbar-panel`, `aria-expanded="true"`;
  a synthetic `pointerdown` on `#root` and an Escape `keydown` both close it; in settings
  (`__sprBarSetPanel(true, 'settings')` or a gear click) and in credits
  (`__sprBarSetPanel(true, 'credits')` or the main view's `View all` row) Escape / ← go back
  to main with the bottom edge unchanged (measure after the 180 ms open / 220 ms resize
  animations); the refresh button logs `limits live (manual)` and a second click within 10 s
  logs `throttled`. The credits screen needs `meta.resetCreditsList` — with real limits, or a
  synthetic push, the rows match the list and the `View all` row is hidden while it is empty.
- Screenshot (`--png` / `start.sh --capture`) in both themes — switch only via
  `document.documentElement.dataset.theme` and restore the previous value. The window frame
  is translucent over native glass, which CDP captures as gray: set
  `Emulation.setDefaultBackgroundColorOverride` (and, for the bar strip, a temporary
  `html` background) during the capture and clear both after. Never publish captures that
  show the sidebar or chat content — blur `#root` (a temporary style) for panel shots.
