---
name: codex-limitbar
description: "Use when installing/repairing codex-limitbar or reading Codex rate limits. Status bar in the ChatGPT desktop app + the app-server rate-limits protocol."
version: 1.0.0
author: codex-limitbar
license: MIT
platforms: [macos]
metadata:
  hermes:
    tags: [codex, chatgpt, rate-limits, status-bar, electron, macos]
    related_skills: [electron-app-patching]
---

# codex-limitbar

Injects a rate-limit status bar into the local UI of the **ChatGPT desktop app**
(`/Applications/ChatGPT.app`, an Electron shell, bundle id `com.openai.codex`) via the
Electron main-process inspector — no disk changes to the app bundle.

Repo: https://github.com/Prontsevich/codex-limitbar

## When to Use

- "Install / set up the limits bar in ChatGPT" → run `./start.sh` from the repo (or the
  `codex-limitbar` command after `./install.sh`).
- "The bar is missing / shows sample data / shows wrong numbers" → diagnose below.
- "Read my Codex rate limits" (with or without the bar) → the probe script
  (`scripts/probe_rate_limits.py`) answers in seconds; protocol reference:
  `references/rate-limits-protocol.md`.
- "The bar disappeared after a ChatGPT update" → the fuse state or the shell URL may have
  changed; re-verify against the new build, then re-install.

## How it works (60-second version)

1. `start.sh` quits ChatGPT if needed and relaunches it with `--inspect=<port>`. This works
   because the app ships with the Electron fuse `EnableNodeCliInspectArguments` ENABLED.
2. `bridge.mjs` connects to the Node inspector of the **main process** and installs a hook:
   every app-shell window gets the bar injected on load. The inspector port is closed
   immediately after install (`inspector.close()`).
3. The injected bar keeps itself alive: countdown refresh, `MutationObserver` re-apply,
   `padding-bottom` self-heal on the app's layout container.
4. Live data: the bridge spawns the app's own bundled `codex app-server` (stdio JSON-RPC,
   `account/rateLimits/read`), polls every 5 minutes, and refetches on Mac wake
   (`powerMonitor` resume).

The bar exists only for launches that went through `start.sh` / the `codex-limitbar`
command — a normal Dock launch shows nothing (expected, not a bug).

## Install & run

```bash
git clone https://github.com/Prontsevich/codex-limitbar.git
cd codex-limitbar
./install.sh          # optional: puts a `codex-limitbar` command in PATH
codex-limitbar        # or: ./start.sh
```

- `./start.sh` — launch (or restart) ChatGPT with the bar. Also safe to re-run: attaches if
  the inspector port is already open.
- `./start.sh --capture` — same + saves `last-run.png` of the main window.
- `./install-skills.sh` — symlink the `skills/` folders into every detected agent harness
  home (Claude Code, Codex, Cursor, Gemini, Hermes, OpenCode, Copilot).

Requirements: macOS, Node.js on PATH, the ChatGPT desktop app installed.

## Diagnosing the bar

Run the probe first — it separates "no data" from "no bar":

```bash
python3 scripts/probe_rate_limits.py
```

- Probe prints `rateLimits.primary.usedPercent` → the CLI answers; the problem is in the
  injection (step 2 below).
- Probe fails → CLI/auth problem: check `~/.codex/auth.json` exists, run `codex login`,
  re-run the probe.

Bar missing / stale checklist:

1. **Was the app launched via `start.sh`?** Normal Dock launches never show the bar.
   `pgrep -fl 'ChatGPT.app/Contents/MacOS/ChatGPT' | head -1` then
   `ps -o command= -p <pid>` — `--inspect=` must be among the flags.
2. **Log**: `~/Library/Logs/spr-limitbar-bridge.log` — every install and every limits read
   is logged (`bridge vN installed`, `inject wc=1`, `limits live: ...`).
3. **`sample data` in the note** = the bar injected but no live read succeeded yet: probe
   again, then wait one poll cycle (or reload the window: the bridge pushes limits on
   every inject).
4. **Bar returned but duplicates / old styles**: a superseded bridge is still live (its
   self-heal keeps re-applying its own DOM). Reinstall with a bumped `BRIDGE_VERSION` and
   fully restart the app (a window reload does not drop main-process listeners).
5. **After a ChatGPT app update**: re-verify the fuse state
   (`node skills/electron-app-patching/scripts/read_fuses.mjs "<app>/Contents/Frameworks/Codex Framework.framework/Codex Framework"`)
   and that the shell URL is still `app://-/index.html`; then re-run `start.sh`.

## In-page hooks (dev console of the main window)

| Hook | Purpose |
|------|---------|
| `__sprBarSetLimits([{name, usedPercent, resetsAtMs}], meta)` | push limits + meta `{live, planType, resetCredits, updatedAtMs}` |
| `__sprBarSetMode('used' \| 'left')` | switch the display mode |
| `__sprBarGetState()` | read current state/version |
| `__sprBarRemove()` | full teardown: removes the bar and restores layout padding |

## Caveats

- ToS gray zone: runtime UI injection into a third-party app. Not affiliated with OpenAI.
  The bundle is never modified (no repack, no re-sign), but the app ships device-attestation
  plumbing that may react to unusual runtimes — use at your own risk.
- The inspector port is open only for the few seconds between launch and install, bound to
  `127.0.0.1`.

## Support files

- `references/rate-limits-protocol.md` — the codex app-server JSON-RPC protocol: handshake,
  response shape, field meanings, "limits unavailable" decision path.
- `references/internals.md` — how the injection works: layout padding, self-heal, hot-swap
  discipline, bridge identifiers, cleanup rules.
- `scripts/probe_rate_limits.py` — live JSON-RPC probe (no app required).
- `scripts/inspect-attach.mjs` — evaluate an expression file inside a running Electron main
  process over its inspector port (with a target-title safety rail).
