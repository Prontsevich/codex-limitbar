# Runtime injection into an Electron main process (no disk change)

Strategy for apps with the `EnableNodeCliInspectArguments` fuse ENABLED (check first with `scripts/read_fuses.mjs`). Nothing on disk changes: signature, TCC permissions and the updater stay untouched. Proven end-to-end on ChatGPT.app: a status bar injected into the local shell, re-injected after reloads, inspector port closed afterwards.

## 1. Launch with the inspector

```zsh
osascript -e 'quit app id "<bundle-id>"'        # graceful quit; allow up to ~20 s
open -b <bundle-id> --args --inspect=9333
```

- `--inspect` binds 127.0.0.1 only. Poll `http://127.0.0.1:9333/json/list` — the main-process target appears in ~2 s with `title: "electron/js2c/browser_init"`, `type: "node"`.
- **Verify the target title before evaluating anything** — never run payloads on whatever debug port happens to be open. `scripts/inspect-attach.mjs` refuses non-matching targets by default.
- `ps -o command= -p <pid>` shows the effective flags — quick proof the app received them.
- `--remote-debugging-port=9444` additionally exposes renderer `page` targets (DOM checks, screenshots). Injection itself does not need it.
- Quitting first is mandatory: `open --args` onto an already-running instance is ignored.

## 2. Reach `require` from the inspector eval context

- `typeof require === 'function'` → **false**; `process.mainModule` → exists.
- `const req = process.mainModule.require.bind(process.mainModule);` — then `req('electron')`, `req('fs')`, `req('inspector')` all work.
- Wrap payloads as `(() => { … })()` and return JSON strings; the driver prints `result.value`.
- `Runtime.enable` → `Runtime.evaluate` with `returnByValue: true, awaitPromise: true` runs async payloads fine.

## 3. Inject into the shell and hook for persistence

- Enumerate first, do not assume: print `id`, `getURL()`, `getType()`, `isDestroyed()` for every `webContents.getAllWebContents()` entry.
- Target the app's LOCAL shell UI only — filter by URL prefix (`app://-/index.html`, `file:`, the app's custom scheme). Remote content panes (a real site embedded in the shell) are off-limits: the shell is where chrome/status UI belongs, and injecting into remote pages is a different, fragile thing.
- Inject: `await wc.executeJavaScript(payload, true)`; make the payload idempotent via a `document.getElementById(ID)` early return.
- Bridge pattern for persistence: a `globalThis.__bridge` guard; hook every existing webContents and `app.on('web-contents-created', (_e, wc) => …)` with `did-finish-load` + `did-navigate` → re-inject. The hook lives in main-process memory: it survives page reloads, NOT an app restart.
- Screenshots: from the main process `await wc.capturePage()` → `img.toPNG()`; call `win.showInactive()` first to raise hidden/detached windows. `capturePage()` can throw `UnknownVizError` on some webContents — catch per window and continue.

## 3b. Fixed bottom bars: reserve layout space, never pure-overlay

A `position:fixed;bottom:0` bar covers whatever the app renders in that strip — on ChatGPT.app it sliced the last sidebar rows and the composer controls, and the overlay shape is the first thing the user reports as a defect. The known-good shape reserves the space:

1. Find the app's full-height layout container: non-fixed direct children of `#root` (fallback `body`) measuring ≥85% of viewport height and ≥50% width. On ChatGPT.app that is one `div.relative.flex.flex-col._Layout_*`.
2. Set `padding-bottom: <barH>px` on it — the app's flex column shrinks by the strip, and the fixed bar sits in the freed band. Save the original inline padding on the node (`data-*-orig-pad`) for an exact restore.
3. Self-heal: React re-renders and route switches wipe inline padding and can drop the node — re-apply from a debounced `MutationObserver` (childList + subtree, ~250 ms), an interval (~1.5 s), and on `resize`. Keep both helpers idempotent (check-then-write) so the observer cannot loop.
4. Ship a teardown hook on `window` (`__barRemove()`) that removes the bar plus its style tag and restores the saved padding — it makes the injection reversible and testable.
5. Verify geometry, not vibes:
   - `document.elementFromPoint(x, barTop - 6)` at several x-positions must hit app UI (composer/sidebar); `elementFromPoint(x, barTop + 12)` must hit the bar itself.
   - Count visible elements intersecting the bar strip, filtering false positives: skip `pointer-events:none`, opacity <0.05, `display:none` / `visibility:hidden`, `position:fixed`, the padded container itself, and anything clipped by an ancestor with overflow hidden/auto/scroll (rect compare). Target: **0**.
   - Numbers from the verified fix: viewport 1233 tall · bar 1205–1233 · sidebar bottom 1159 · composer bottom 1149.
6. Screenshot and look at it afterwards — clean geometry can still sit ugly next to the app's real chrome.

## 3c. Iterating on the injected UI (hot-swap discipline)

The injected bar is live-edited by reinstalling the bridge into the running app. Two traps:

- **Bump the bridge's version constant on EVERY edit.** The previous install's self-heal (interval + MutationObserver) keeps re-applying ITS DOM and CSS — by design. Without a version bump your new style is overwritten within seconds and reads as a phantom regression you then chase in the wrong place. The installer must call the previous bridge's uninstall hook (`__barRemove()` / `uninstall()`) first: two live bridges fight over the padded container and can attach padding to the wrong node (e.g. the startup loader).
- **A swap that renames or re-IDs the injected nodes needs a legacy sweep in the NEW bridge, running inside `apply()` — not only at install.** The old bridge's hooks stay live in the page: an anonymous `resize` listener cannot be unregistered and re-creates the old bar and its `padding` after the swap, so the new bridge must delete old nodes/attributes on every cycle (restoring any padding it finds under the old marker). A window reload kills all of the old realm's hooks at once — the surest reset when a swap must be clean immediately.
- **The dispose hook of a superseded bridge can silently fail to run.** If the installer checks `typeof prev.dispose === 'function'` but the previous version stored cleanup as `state.dispose`, the check never matches: the old bridge keeps its `did-finish-load`/`did-navigate` listeners in the main process and re-injects its OLD payload (old ids, old globals) on every window reload — the symptom is legacy artifacts that keep coming back after a rename. Resolve the hook from both shapes (`prev.dispose || prev.state.dispose`), export it under both names going forward, and prove it: fake the live bridge's version lower, install again, and grep the log for `disposed`.
- **Renaming a persisted preference key: migrate inside the state factory, then clear the old key unconditionally on every payload evaluation.** The bar's state object is sticky (`window.__xState = window.__xState || {...}`), so the factory — where `readMode()` runs — executes once per page realm; a later install that ADDS migration logic never runs it while the state lives (the visible mode silently keeps the old value). Copy legacy → new inside the factory, and delete the legacy key as its own line after the factory: safe because the factory runs first in a fresh realm, and in a live realm it is pure cleanup. Do NOT delete it in the pre-factory sweep — that runs before the factory and destroys the migration source.
- **Assert against the live node, not your editor.** After each install, project the bar's own state into a small JSON: bridge version, `textContent` (content AND order of labels / percentages / times), computed style of the node you just changed, child order. Cheap, and it catches both a silent revert and a half-applied swap.

Verifying a small element (a divider, an icon) — measure and LOOK at zoom:

- Capture the region you need from the main process: `wc.capturePage({ x, y, width, height })` runs at the window's device scale (2x on Retina shells ≈ full resolution). Doing the crop in the app avoids external image tooling entirely — post-cropping a full screenshot with `sips` flags or PIL is fiddly and depends on packages that may not be installed.
- Then zoom: a vision pass on that crop (or on the original image with a region box) answers "visible? too loud?" far better than a full-window screenshot, where a 5 px element collapses into a few pixels.

**When the user says an element is "barely visible", jump to full strength in ONE step** — ≥0.85 alpha plus a size bump and horizontal spacing — instead of nudging 0.25 → 0.55 → 0.85 across three round-trips. A dark app surface swallows low-alpha marks. Then keep the element in its tier: a divider should out-shine secondary text ("used", timestamps) yet stay dimmer than the accent-colored values (the percentages), so it groups without competing.

## 4. Close the inspector after install

An open inspector port = any local process can execute code in the app. Close it once the bridge is in:

```js
setTimeout(() => req('inspector').close(), 600);   // the delay lets the current eval return first
```

Verified: port closed, bridge still injecting, app alive. While iterating, keep the inspector OPEN and close it only on the final install — once closed, the only way back is quitting and relaunching the app with the flag (the launcher does exactly that when it finds the app running without an inspector).

## 5. Ship a launcher

The bridge exists only for launches that went through `--inspect`; a normal Dock launch shows nothing. Launcher shape (`start.sh`): attach if the port is up → else quit + relaunch with the flag → install bridge → close port → tail a logfile under `~/Library/Logs/`. Offer launchd/alias as the transparent upgrade. Restarting the user's app is user-visible — confirm in an interactive session, do not fire it unattended.

## Pitfalls

- The injected UI disappearing on a normal launch is expected, not a bug — the launcher is the entry point.
- Don't reuse a fixed debug port blindly; pick an uncommon one and check it is free first.
- Log every install and injection to a file — the injector runs detached from any terminal, so the log is the post-hoc evidence.
- After an app update, re-verify the fuse state and re-run the flow from scratch: nothing about the runtime is stable between builds.
- **Serialized payloads see only their own scope.** The payload ships as source text (`fn.toString()`); driver module-scope constants do not exist inside the app. Thread values through the payload's own `cfg` object (runtime replaces referencing `cfg` are fine) or substitute placeholders textually in the driver BEFORE sending; a leftover runtime `.replace()` callback that references a driver-module name throws `ReferenceError: <NAME> is not defined` inside the app.
- **URL-substring target filters hit overlay windows.** An overlay window can share the main window's URL prefix (ChatGPT.app: `app://-/index.html?initialRoute=%2Favatar-overlay` vs `app://-/index.html`) — an `includes()` filter or a prefix regex can drive or inject into the overlay instead. Select by exact URL equality, and exclude overlay routes from the shell filter in the bridge too.
- **A reinstall can silently revert itself.** The previous bridge's self-heal keeps re-applying the old DOM/CSS; bump the bridge version constant on every edit and call its uninstall hook first (§3c).
