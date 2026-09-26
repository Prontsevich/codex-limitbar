# How the injection works (bridge internals)

The engineering notes behind `bridge.mjs`: what it hooks, why each piece exists, and the
rules that keep it stable across reinstalls. The generic methodology lives in the
`electron-app-patching` skill; this file is the product-specific detail.

## Install path

1. `start.sh` quits ChatGPT if needed, relaunches it with `--inspect=<port>`, waits for
   `http://127.0.0.1:<port>/json/list`.
2. `bridge.mjs` finds the main-process target by title `electron/js2c/browser_init`,
   connects over its `webSocketDebuggerUrl`, and evaluates the install payload.
3. Inside the app, `require` is not a global: the payload reaches it via
   `process.mainModule.require.bind(process.mainModule)`.
4. The payload enumerates `webContents.getAllWebContents()`, keeps only the app shell
   (URL `app://-/index.html` and `app://-/detached-window.html`; exact URL match, because
   the mascot overlay shares the prefix as `...?initialRoute=%2Favatar-overlay`), and hooks
   `app.on('web-contents-created')` + `did-finish-load` / `did-navigate` for re-injection.
5. When done, the installer closes the port: `setTimeout(() => req('inspector').close(), 600)`.

## Layout: reserve space, never overlay

A `position:fixed;bottom:0` bar alone slices the sidebar and composer (user-reported
defect). The known-good shape:

1. Find the app's full-height layout container: non-fixed direct children of `#root`
   measuring ≥85% of viewport height and ≥50% width — on ChatGPT.app that is
   `div.relative.flex.flex-col._Layout_*`.
2. Set `padding-bottom: 28px` (bar height) on it and mark the node `data-spr-padded`,
   saving the original inline padding under `data-spr-orig-pad`.
3. Self-heal from three places: a debounced `MutationObserver` (childList + subtree,
   ~250 ms), an interval (~1.5 s), and `resize`. All helpers are check-then-write so the
   observer cannot loop.

Verified geometry (v12): viewport 1233 · bar 1205–1233 · sidebar bottom 1159 · composer
bottom 1149 · covered-visible count 0 · hit tests clean at 5 x-positions; the padding
re-applies itself after `webContents.reload()`.

## Identifiers

All bridge identifiers use the `spr` prefix: `__sprBridge` (main-process guard),
`__sprBarSetLimits` / `__sprBarSetMode` / `__sprBarGetState` / `__sprBarRemove` (window
hooks), `#spr-statusbar` + `#spr-statusbar-style` (DOM), `data-spr-padded` (attribute),
`spr-statusbar-mode` (localStorage key), `~/Library/Logs/spr-limitbar-bridge.log` (log).

## Reinstall / hot-swap discipline

The injected bar is live-edited by re-running the installer against the running app. Four
rules, each learned the hard way:

1. **Bump `BRIDGE_VERSION` on every edit.** The previous install's self-heal keeps
   re-applying ITS DOM/CSS; without a bump the new style is overwritten within seconds and
   reads as a phantom regression.
2. **The installer must dispose the previous bridge first.** Resolve the hook from BOTH
   shapes — `prev.dispose` and `prev.state.dispose` — and export it under both names going
   forward. A check that only looks at one shape silently never matches, and the old bridge
   keeps its main-process listeners, re-injecting its old payload on every window reload.
3. **A rename or re-ID needs a legacy sweep inside `apply()`, running every cycle — not
   only at install.** The old bridge's hooks stay live in the page; an anonymous `resize`
   listener cannot be unregistered and re-creates the old bar and its padding after the
   swap. The sweep also deletes legacy globals and restores any padding it finds under the
   old marker.
4. **Renaming a persisted preference key: migrate inside the state factory, and clear the
   old key unconditionally on every payload evaluation.** The state object is sticky
   (`window.__sprBarState = window.__sprBarState || {...}`), so a later install that adds
   migration logic never runs it while the state lives. Copy legacy → new inside the
   factory; delete the legacy key on each payload evaluation (pure cleanup after the
   factory).

When a swap must be clean immediately and nothing else works: reload the window (kills the
old realm's hooks at once), and for main-process listeners a full app restart is the only
cure.

## Live data path

- `cp.spawn(bin, ['app-server', '--listen', 'stdio://'])` from the main process —
  `cwd: os.tmpdir()`, env copy with `PWD` overridden and `OLDPWD` / `INIT_CWD` deleted,
  `stdio: ['pipe', 'pipe', 'ignore']`, 15 s timeout, `SIGTERM` after the answer.
- Handshake: `initialize` (`protocolVersion`, `clientInfo`) → `initialized` →
  `account/rateLimits/read` (id 42). Parse `rateLimits.primary` / `.secondary` when present.
- Push into every eligible webContents via
  `wc.executeJavaScript('__sprBarSetLimits([...], meta)')` — also right after every
  injection, so a reloaded window gets live numbers instead of sample ones.
- Cadence: `setInterval` every 5 minutes + refetch on `powerMonitor.on('resume')`.
- Meta seam: `{live, planType, resetCredits, updatedAtMs}` drives the right-hand note —
  `live · updated HH:MM`, tooltip `plan <type> · N reset credits · source: local codex
  app-server`; before the first successful fetch it reads `sample data`.

## Verification hooks (what a reinstall audit checks)

Project the bar's own state into a small JSON after every install: bridge version, DOM
count (`document.querySelectorAll('#spr-statusbar').length` — must be 1), legacy artifact
count (`#hermes-statusbar` nodes, `__hermes*` globals, old localStorage key — must be 0),
`textContent` (content and order of labels / percentages / times), and the padded
container's computed `padding-bottom` (must equal bar height). Cheap, and it catches both a
silent revert and a half-applied swap.
