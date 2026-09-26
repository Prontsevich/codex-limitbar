# ChatGPT desktop app (macOS) — recon notes

App-specific depth for the electron-app-patching workflow. Fuse state, paths and internals are per-build: re-run the recon steps before planning work. Observed on build 26.917.71314 (bundle id `com.openai.codex`).

## Identity and lineage

- `/Applications/ChatGPT.app` is the merged ChatGPT/Codex Electron client; the former native AppKit ChatGPT client continues under the name "ChatGPT Classic". The bundle name lies — check `CFBundleIdentifier`.
- Updated via Sparkle (`codexSparkleFeedUrl` inside the asar's `package.json`) → patches are overwritten on update.
- State to know: Electron user-data-dir is `~/Library/Application Support/Codex` (Cookies, Local State, crashpad db); `~/.codex` is the CLI/app side (auth.json, config.toml, sessions).

## Runtime and fuses (observed — re-verify)

- Electron 42.x, packaged with electron-forge; Chromium lives in `Contents/Frameworks/Codex Framework.framework` — the Electron Framework renamed, so the `@electron/fuses` CLI cannot find it. Use `scripts/read_fuses.mjs`.
- Observed states: RunAsNode ENABLE · CookieEncryption DISABLE · NodeOptionsEnv ENABLE · NodeCliInspectArgs ENABLE · EmbeddedAsarIntegrity DISABLE · OnlyLoadAppFromAsar DISABLE · GrantFileProtocolExtraPrivileges ENABLE · WasmTrapHandlers ENABLE.
- Consequences: no asar-integrity enforcement (recomputing the plist hash after a repack is unnecessary while this holds); runtime attach paths (`--inspect`, `NODE_OPTIONS`) are open. Contrast: Claude.app ships EmbeddedAsarIntegrity + OnlyLoadAppFromAsar ENABLE.
- Entitlements to watch: `com.apple.security.app-sandbox` is false; `keychain-access-groups <TEAMID>.*` (the vendor team id — public in any signed bundle, shown here as a placeholder); APNs production; apple-events; camera/mic.

## Bundle layout

- `Resources/app.asar` ~370 MB, ~15.7k files, every file carrying per-file integrity blocks (blockSize 4 MiB) — irrelevant while the integrity fuse is off.
- Main entry `.vite/build/early-bootstrap.js`; other `.vite/build` chunks and preloads (`sandbox-preload.js`, `browser-page-preload.js`).
- Shell UI (menus, Codex mode, settings) is a local React bundle under `/webview/` (`index.html`, `assets/*`) — the right layer for a status bar / panel injection.
- Chat content is remote chatgpt.com in sandboxed webContents (`sandbox: true, contextIsolation: true, nodeIntegration: false`) — don't target it.
- `app.asar.unpacked`: node-pty (`pty.node`, `spawn-helper`), better-sqlite3, objc-js, @worklouder HID stack — repack `--unpack` globs must keep these.
- `Resources/native/*.node` helpers live outside the asar (devicecheck, sky, modifier monitor).

## Rate limits inside the app (the status-bar subject)

- App-server JSON-RPC: method `account/rateLimits/read` → HTTP `/v2/account/rate-limits`; notification `account/rateLimits/updated`; internal tool name `get_usage_limits`.
- Localized UI strings confirm the windows: "5 hour usage limit", "Daily usage limit", "Weekly usage limit", "Monthly usage limit".
- The app spawns its bundled CLI: `Contents/Resources/codex … app-server --analytics-default-enabled` (bundled CLI version differs from any standalone install).
- External readers of the same protocol are common (MCP servers exposing limits to an agent, standalone menu-bar apps). Data supply is a solved problem — the open question is in-app presentation. See the `codex-limitbar` skill (`references/rate-limits-protocol.md`) for the wire protocol.
- **The app's own bundled CLI answers the same protocol.** Verified: `Contents/Resources/codex` (0.155.0-alpha.16.4) returned the same `account/rateLimits/read` shape as a standalone 0.154.0 install — both live (5h 2%, Weekly 73%, plan plus, 3 reset credits). Prefer the bundled binary: resolve it from `app.getAppPath()` (strip `/app.asar` from the tail, sibling `codex`), then fall back to a standalone `codex` on `PATH`, mise shims, Homebrew. Same version the UI itself talks to, and no separate install required.
- Spawn discipline (copied from codex-limits-mcp): `cp.spawn(bin, ['app-server','--listen','stdio://'])` with `cwd: os.tmpdir()`, env copy with `PWD` overridden and `OLDPWD`/`INIT_CWD` deleted, `stdio: ['pipe','pipe','ignore']`, 15 s timeout, SIGTERM on finish; consume stdout as a line buffer, skip notifications, act on `id:1` then `id:2`.
- Poll cadence: every 5 min plus a refetch on `powerMonitor.on('resume')` (Mac asleep = stale numbers otherwise). Each successful read is pushed into every eligible webContents by `executeJavaScript`-ing the `__sprBarSetLimits(limits, meta)` call — also right after every inject, so a reloaded window gets live numbers instead of sample ones.
- Bridge identifiers use the `spr` prefix (`__sprBridge`, `__sprBar*`, `#spr-statusbar`, `data-spr-padded`) — renamed from `hermes` at the user's request. The sweep for pre-rename artifacts must run on every apply cycle, not just at install: the stale bridge keeps its own hooks (an anonymously-added `resize` listener cannot be unregistered) and re-created its bar and padding after the swap despite the first-install sweep having removed them.
- Meta seam: `{live, planType, resetCredits, updatedAtMs}` drives the right-hand note — `live · updated HH:MM`, tooltip `plan plus · 3 reset credits · source: local codex app-server`; before the first successful fetch it reads `sample data`.

## Tamper / attestation surface (assume it can react)

- DeviceCheck attestation (`attestation/generate`, `devicecheck.node`), keychain envelope key `electron-integrity-state-envelope`, event `oai.integrity-state-missing-recovery.v1`, backend `/backend-api/codex/desktop-session/{challenges,codes}`.
- Do not present local patching as undetectable; state the ToS gray zone plainly.

## AppleScript corner — VERIFIED DEAD (do not re-investigate)

- `Info.plist`: `NSAppleScriptEnabled = true`, `OSAScriptingDefinition = scripting.sdef`; the sdef is the Chromium dictionary (standard + Chromium suites, incl. `execute javascript`), and `NSPrincipalClass` is `BrowserCrApplication`.
- Static evidence looks promising — and is misleading. The dictionary compiles (`osacompile -e 'tell application id "com.openai.codex" to execute front window javascript "1+1"'` exits 0; the Chrome control behaves the same; Claude fails to compile — it ships no sdef), and the Chromium AppleScript classes/selectors are present inside `Codex Framework` (`BrowserCrApplication`, `TabAppleScript`, `WindowAppleScript`, `handlesExecuteJavascriptScriptCommand`).
- Live probe result: the app answers events, but only app-level properties. `version` → build string; `count windows` → **0** while `CGWindowListCopyWindowInfo` shows real windows for the same pid; `tabs of window 1` and `execute front window javascript …` → error **-1719** (invalid index — nothing to execute); `count bookmarkFolders` → **-2753** (event unhandled).
- Mechanism: Chromium's AppleScript support is compiled into the shared framework, but the window-registration path (`insertInAppleScriptWindows:`) belongs to the Chrome browser shell and never runs in an Electron shell — Electron creates the windows. No registered windows → no tabs → `execute javascript` unreachable. Chrome/Edge/Yandex work because they are full browsers.

## Runtime injection (verified against this build)

- Launch: `open -b com.openai.codex --args --inspect=9333` → main-process target `electron/js2c/browser_init` in ~2 s. `require` is not a global there; use `process.mainModule.require.bind(process.mainModule)`.
- WebContents observed: `app://-/index.html` (main shell), `app://-/index.html?initialRoute=%2Favatar-overlay` (full-screen mascot overlay — shares the main window's URL prefix, exclude it from shell filters), `app://-/detached-window.html` (detached chat), plus remote `https://chatgpt.com/...` panes (e.g. embedded checkout). Inject only into the main shell and detached windows — never the remote panes.
- `executeJavaScript(..., true)` on the shells renders the bar (verified visually and via DOM rect: `x=0, w=1720, h=28`). The bar must RESERVE space, not overlay: the overlay version covered the bottom 28 px of the sidebar and composer (user-reported defect); the fix pads the full-height layout container (`div.relative.flex.flex-col._Layout_*`, direct child of `#root`) by 28 px, with observer/interval self-heal and a `__barRemove` teardown. Verified after the fix: viewport 1233 · bar 1205–1233 · sidebar bottom 1159 · composer bottom 1149 · covered-visible count 0 · hit tests clean at 5 x-positions, and the padding re-applies itself after `webContents.reload()`. A bridge on `did-finish-load`/`did-navigate` + `web-contents-created` re-injects after reload; `req('inspector').close()` closes :9333 with the bridge still live and the app running.
- `capturePage()` throws `UnknownVizError` on the remote chatgpt.com pane; the `app://-/` shells capture fine (main window up to 3440×2578 @2x). Call `win.showInactive()` before capturing hidden windows.
- A launcher (`start.sh`) attaches or restarts the app, installs the bridge, closes the port; `--capture` also saves a screenshot of the main window.

## Status-bar look (design spec)

The strip is deliberately plain and matched to the app's own panels — the user rejected gradient/shadow depth (reads as "pseudo-3D") and wants the app's fonts and colors kept.

- Per limit: `[label] [mini bar] [NN% used] [time-to-reset]` — the limit name sits LEFT of the bar, percent and time to the right. No glyph beside the reset time: a `↻` reads as a refresh control.
- Divider between limits: bullet `•` at ~0.85 alpha with horizontal padding. The app's dark surface swallows a middot or a secondary-text tone — 0.25 alpha was invisible and 0.55 still weak, so go to full strength in one step.
- Mini bar 64×5 px over a `rgba(191,189,182,.14)` track; fill colored by REMAINING (traffic light): ≥50% green `#7ee787`, ≥25% amber `#e3b341`, ≥10% orange `#f0883e`, <10% red `#f85149`.
- Segmented used/left toggle, choice persisted in `localStorage`; relative reset time (`2h 9m`, `3d 4h`) with the exact timestamp in a hover tooltip.
- Background from the app's own CSS vars (`--color-surface`, `--color-border`) so the strip follows theme changes; flat, no gradient or shadow.
- Data seam (wired): `window.__sprBarSetLimits([{name, usedPercent, resetsAtMs}], {live, planType, resetCredits, updatedAtMs})`; mode hook `__sprBarSetMode('used'|'left')`. Live values come from the bundled codex app-server (see the rate-limits section above); the strip shows sample data (labelled as such) only until the first successful read.
- Window names derive from `windowDurationMins`: 10080 → `Weekly`, exact day/hour multiples → `3d` / `5h`, else `Nm`. Do not hardcode two windows — the 5h window is suspended for some accounts, so `primary`/`secondary` may collapse to one limit.
