---
name: electron-app-patching
description: "Use when patching a third-party Electron app (asar, fuses)."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [macos, linux, windows]
metadata:
  hermes:
    tags: [electron, asar, fuses, macos, codesign, patching, desktop-apps]
    related_skills: [codex-limitbar]
---

# Patching third-party Electron desktop apps

## When to Use

Use when the user asks to modify, extend, inspect, or "patch" a third-party Electron desktop app (inject a status bar or panel, swap fonts, change behavior), or asks "can we patch this?" — and when a request to add UI to such an app has no sanctioned plugin/API path.

Class of work: the user wants an existing Electron app to look or behave differently. Precedents: Claude.app (font/UI patch via asar) and ChatGPT.app (status-bar injection — see the `codex-limitbar` skill for the worked end-to-end example).

**Read-only until the user says go.** "Can this be patched?" means gather on-disk evidence and answer — no edits, no `osascript` probes that send events (they raise TCC consent dialogs; `osacompile -e …` only compiles terminology from disk and sends nothing, so it is a consent-free dictionary test), no launches with debug flags. Probing steps become the proposed next step, not an action.

## Step 1 — classify the bundle from disk

- `ls /Applications/<App>.app/Contents/Frameworks` — a `*Framework.framework` (Chromium) plus `Resources/app.asar` means Electron. The framework may be renamed: OpenAI ships `Codex Framework.framework`, not `Electron Framework.framework`.
- `ps` for helper processes: renderer/GPU/utility helpers + `*crashpad_handler` confirm the runtime.
- A main binary linking only `/usr/lib/libSystem.B.dylib`, no frameworks, no asar → native app, different class of work.
- `plutil -p Info.plist` — read `CFBundleIdentifier` (the name can lie) and updater keys (`SUFeedURL`, `Sparkle.framework`).
- **Never classify from articles or community posts**: the same app name changes architecture across releases (the macOS ChatGPT app was AppKit-native for years, then became the Electron Codex shell under the same name). Verify the installed bundle.

## Step 2 — decode the fuse wire (it decides the strategy)

- Run `scripts/read_fuses.mjs <framework binary>` — dependency-free decode of the fuse states.
- `npx @electron/fuses read --app <bundle>` alone is not enough: it hardcodes `Contents/Frameworks/Electron Framework.framework/Electron Framework` and errors on renamed frameworks. When it fails, resolve the real framework binary and call `getCurrentFuseWire(<binary>)` from `@electron/fuses` directly.
- Wire format: sentinel `dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX`, then at +SENTINEL.length `[version byte][count byte][count state chars]`; state chars `1`/`0`/`r`/0x90 = ENABLE / DISABLE / REMOVED / INHERIT. Order: RunAsNode, EnableCookieEncryption, EnableNodeOptionsEnvironmentVariable, EnableNodeCliInspectArguments, EnableEmbeddedAsarIntegrityValidation, OnlyLoadAppFromAsar, LoadBrowserProcessSpecificV8Snapshot, GrantFileProtocolExtraPrivileges, WasmTrapHandlers.
- Re-read fuses on every new build — they are per-build, nothing about them is stable between versions.
- What the key fuses gate:

| Fuse | Enabled means |
|---|---|
| RunAsNode | app runtime can run as plain Node (`ELECTRON_RUN_AS_NODE`) |
| EnableNodeOptionsEnvironmentVariable | `NODE_OPTIONS` honored → `--require` module injection at startup |
| EnableNodeCliInspectArguments | `--inspect` honored → attach a debugger to the main process |
| EnableEmbeddedAsarIntegrityValidation | asar header hash checked against `Info.plist` → `ElectronAsarIntegrity`; mismatch = forced termination → a repack MUST update the hash |
| OnlyLoadAppFromAsar | side-loading an `app/` directory blocked → the asar itself must be edited |

- Factory/default Electron leaves the security fuses DISABLED; a production app with integrity enforcement (Claude.app) is the exception, not the rule. Check, don't assume.

## Step 3 — inventory the asar

- `npx -y @electron/asar list <app.asar>` — file map, entry points (the shell UI often sits under `/webview/` or `.vite/build/`), locales.
- `npx -y @electron/asar extract-file <app.asar> <path>` — read one file without extracting everything.
- Header parse (inventory + per-file integrity stats without extraction): bytes 0–4 size word, bytes 4–8 LE uint32 `headerSize`, then `headerSize` bytes of JSON. Read exactly `headerSize` bytes — headers on large archives run multi-MB (thousands of files); a fixed small cap silently truncates. Parse tolerantly: locate the first `{` and `raw_decode`/`JSONDecoder` — plain `json.loads` on the raw slice can fail (`Extra data`, padding, or leading offset).
- Per-file `integrity` blocks in the header mark what an integrity-enforcing build would hash; their presence is irrelevant while the integrity fuse is off.
- List `app.asar.unpacked` — native modules (`*.node`, `spawn-helper`, `*.dylib`, `*.so`) live there and must stay unpacked on repack.

## Step 4 — check the app's own defenses and updater

- `codesign -d --entitlements :- <App.app>` — note app groups, `keychain-access-groups`, push entitlements: features that can break or prompt after re-signing.
- Grep the asar for tamper/attestation plumbing (`attestation`, `integrity`, `tamper`, devicecheck) — apps that ship it may react to a modified bundle. Report as risk; never promise "undetectable".
- Updater check (Sparkle `Sparkle.framework` + `SUFeedURL`, or a built-in updater) replaces the bundle on update → every patch needs a re-patch script from day one, or it dies silently at the next update.

## Step 5 — pick the cheapest strategy that fits

| Strategy | Prereq | Disk changes | Update survival |
|---|---|---|---|
| Runtime attach / injection (`--inspect` main process, `NODE_OPTIONS --require`) | respective fuse ENABLED | none; signature intact | re-attach per launch (small launcher) — proven, see Step 5b |
| AppleScript injection (`execute javascript` via sdef) | **ruled out for Electron shells** (verified dead, see below) | none | n/a |
| In-bundle asar patch | — | repack + ad-hoc re-sign | needs a re-patch script |

Check the no-disk-change paths first: the inspect fuse, then AppleScript. Zero disk change beats any repack — and when the inspect fuse is ENABLED there is no reason to touch the bundle at all.

**`NSAppleScriptEnabled` + a compiling sdef is a false positive in Electron apps.** Chromium's dictionary compiles fine and `NSPrincipalClass` is `BrowserCrApplication`, but the window registration that `execute javascript` needs belongs to the Chrome browser shell and never runs — Electron creates the windows. Verified dead on ChatGPT.app (the most "custom shell" case): app-level properties answer, `count windows` is 0 while `CGWindowListCopyWindowInfo` shows real windows for the same pid. Cheap safe check: `osacompile -e 'tell application id "<bundle-id>" to count windows'` compiles terminology from disk and sends no events; only if that compiles, one live `count windows` settles it (sends events → TCC Automation consent → user's go-ahead first). A 0 means stop — no further AppleScript work.

Probing that sends Apple Events raises a TCC Automation consent prompt — that is a state change; get the user's go-ahead before firing it.

## Step 5b — runtime injection (proven, no disk change)

The inspect fuse ENABLED makes this the cheapest live path — proven end-to-end (UI injected into the shell, survived reloads, inspector port closed afterwards). Recipe and pitfalls: `references/runtime-injection.md`; one-shot driver: `scripts/inspect-attach.mjs`; copy-and-adapt installer: `templates/bridge-install.mjs`.

1. Quit gracefully (`osascript -e 'quit app id "<bundle-id>"'`), relaunch `open -b <bundle-id> --args --inspect=<port>`, poll `http://127.0.0.1:<port>/json/list` — the main-process target appears in ~2 s with `title: "electron/js2c/browser_init"`.
2. In the main-process eval context `require` is NOT a global — reach it via `process.mainModule.require.bind(process.mainModule)`.
3. Enumerate `BrowserWindow.getAllWindows()` / `webContents.getAllWebContents()` and inject only into the app's LOCAL shell webContents (URL filter, e.g. `app://-/index.html`) — never into remote content panes.
4. Persist with a bridge: `globalThis` guard, hook `app.on('web-contents-created')` plus `did-finish-load`/`did-navigate` on every webContents, re-inject on load; keep the injected payload idempotent (`if (document.getElementById(ID)) return 'already'`). Reserve layout space for a fixed bottom bar — pad the app's full-height layout container by the bar height and self-heal on re-render; a pure overlay covers the composer/sidebar controls and reads as a defect (verified fix and hit-test checks: `references/runtime-injection.md` §3b).
5. Close the inspector right after install (`setTimeout(() => req('inspector').close(), 600)`) — an open port lets any local process run code in the app, and the bridge keeps working without it.
6. Ship a launcher (`start.sh`) next to the bridge: attach-if-port-open → restart the app if it runs without an inspector → install → close port → log to `~/Library/Logs/`. Say plainly that the UI exists only for launches through the launcher; launchd/alias is the transparent upgrade. Restarting the user's app is visible — confirm in an interactive session.
7. Verify with real evidence: DOM check (`getBoundingClientRect` of the injected node) plus a screenshot (`wc.capturePage()` → `img.toPNG()`; `win.showInactive()` first), and after `webContents.reload()` the injected UI must come back on its own.
8. Iterating on the look: bump the bridge's version constant on every edit — the previous install's self-heal re-applies the old DOM/CSS within seconds and reads as a phantom regression; the reinstall calls the old bridge's uninstall hook first. Verify small elements by region-capturing at device scale and zooming, not by squinting at a full-window shot (`references/runtime-injection.md` §3c).

## Step 6 — the in-bundle patch pipeline (macOS known-good)

Use `templates/repatch-app.sh`. Order:

1. **Prototype on a COPY** (`cp -R` the app somewhere writable, patch there) — never iterate against `/Applications` itself.
2. Quit the app; back up the original asar once.
3. Extract → apply the patch. The shell UI is usually plain Vite/React chunks; injecting a status bar/panel means a DOM+CSS addition to that shell view — not to any remote content layer.
4. Repack with the ORIGINAL unpack layout (`--unpack` globs derived from the app's existing `app.asar.unpacked`).
5. Swap `app.asar` and `app.asar.unpacked` together.
6. Only if `EnableEmbeddedAsarIntegrityValidation` is ENABLED: recompute the hash — `sha256(rawHeader.headerString)` via `@electron/asar.getRawHeader` — and write it to `Info.plist` → `ElectronAsarIntegrity.Resources/app.asar.hash`. Wrong or missing hash = the app is forcefully terminated at launch.
7. Re-sign ad-hoc: `codesign --force --deep --sign - <App.app>`. The Developer ID signature is gone; expect TCC permission resets (Accessibility, Screen Recording, Automation, Mic/Camera) that the user must re-grant, and possible Keychain/Safe Storage prompts or re-login.
8. Relaunch, verify the target UI actually renders, and keep steps 2–6 runnable as a re-patch script for the next app update.

## Reporting shape

- Verdict first, then the evidence that backs it: path + what it shows. Claims come from the installed bundle, not from articles.
- Strategies as a cost/benefit table; label anything untested as untested; no stealth promises when the app ships attestation.

## Support files

- `scripts/read_fuses.mjs` — dependency-free Electron fuse decoder; works on renamed frameworks where the fuses CLI fails.
- `scripts/inspect-attach.mjs` — evaluate an expression file inside a running Electron main process over its Node inspector port (`--expect` guards the target title, optional `--png`).
- `references/runtime-injection.md` — the no-disk-change recipe: launch with `--inspect`, reach `require` from the eval context, bridge pattern for persistence, hot-swap iteration discipline and zoom-verified visual checks (§3c), closing the port, launcher shape.
- `references/chatgpt-desktop-app.md` — ChatGPT.app recon notes: Electron/Codex merge, observed fuse states, webview shell, rate-limit internals, attestation surface, verified AppleScript verdict, observed injection results.
- `templates/repatch-app.sh` — extract → patch → repack → plist-hash → re-sign pipeline to copy and adapt.
- `templates/bridge-install.mjs` — runtime-injection installer to copy and adapt (edit the CONFIG block: shell URL pattern, element id, bar content): hooks all webContents, re-injects on load, optionally reload-tests, captures a screenshot, closes the inspector port.
