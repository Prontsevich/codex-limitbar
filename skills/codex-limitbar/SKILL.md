---
name: codex-limitbar
description: "Use when installing/repairing/removing codex-limitbar or reading Codex rate limits. Status bar in the ChatGPT desktop app (CDP injection) + the app-server rate-limits protocol."
version: 2.0.0
author: codex-limitbar
license: MIT
platforms: [macos]
metadata:
  hermes:
    tags: [codex, chatgpt, rate-limits, status-bar, electron, cdp, macos]
    related_skills: [electron-app-patching]   # external: https://github.com/Prontsevich/electron-app-patching
---

# codex-limitbar

Injects a rate-limit status bar into the local UI of the **ChatGPT desktop app**
(`/Applications/ChatGPT.app`, bundle id `com.openai.codex`) over the Chrome DevTools
Protocol — no disk changes to the app bundle.

Repo: https://github.com/Prontsevich/codex-limitbar

## When to Use

- "Install / set up the limits bar in ChatGPT" → `./start.sh` from the repo (or the
  `codex-limitbar` command after `./install.sh`; Raycast: `./install.sh --raycast`).
- "The bar is missing / says waiting / stale / wrong numbers" → diagnose below.
- "Remove it" → `./uninstall.sh` (`--check` first; `--restart-app` closes the port).
- "Read my Codex rate limits" (with or without the bar) → `scripts/probe_rate_limits.py`
  answers in seconds; protocol: `references/rate-limits-protocol.md`.
- "The bar stopped working after a ChatGPT update" → re-verify the method (below) before
  touching code.

## How it works (60-second version)

1. `start.sh` launches ChatGPT with `--remote-debugging-port=<random 127.0.0.1 port>`
   (quitting it once if it runs without one). This Chromium switch is not controlled by
   Electron fuses — since 26.924.22138 the old `--inspect` main-process path is closed
   (`EnableNodeCliInspectArguments`, `RunAsNode`, `NODE_OPTIONS` fuses disabled).
2. `limitbar.mjs` (the agent) runs the identity check — port owner is the app's main
   executable (or its children), `/json/version` is Chrome, an exact `app://-/index.html`
   page exists and defines `codexWindowType` + `electronBridge` — and refuses otherwise.
3. It attaches to the shell page(s), registers `bar.js` with
   `Page.addScriptToEvaluateOnNewDocument` (survives reloads) and evaluates it now.
4. It spawns the app's bundled `codex app-server` (`Contents/Resources/codex-cli/bin/codex`
   since 26.924; stdio JSON-RPC, `account/rateLimits/read`) every 5 minutes, after wake
   and on the panel's refresh button (a CDP binding, `__sprBarRefreshBinding`), and pushes
   the numbers via `__sprBarSetLimits`. It exits when the app quits.
5. Clicking the bar opens a details panel (plan, per-window bars, reset times, reset
   credits, warnings, `used|left` toggle, refresh) — the one transient overlay.

The bar exists only for launches that went through `start.sh` / the command / the Raycast
script — a normal launch shows nothing (expected). **The CDP port stays open for the app's
lifetime**; any process running as the user can drive the window meanwhile.

## Install, run, stop, remove

```bash
git clone https://github.com/Prontsevich/codex-limitbar.git && cd codex-limitbar
./install.sh             # optional: `codex-limitbar` command in ~/.local/bin
./install.sh --raycast   # optional: Raycast Script Command "Open ChatGPT with LimitBar"
codex-limitbar           # or ./start.sh — fast path if already active
./start.sh --status      # app pid, CDP port, agent state
./start.sh --stop        # bar removed live; port stays open until a normal app restart
./start.sh --capture     # + last-run.png of the main window
./uninstall.sh --check   # then ./uninstall.sh [--restart-app] [--purge]
```

Requirements: macOS, Node.js >= 22 (`CODEX_LIMITBAR_NODE` overrides discovery), ChatGPT in
`/Applications` (`CODEX_LIMITBAR_APP` overrides), a signed-in Codex account.
`./install-skills.sh` links this skill into every detected agent harness.

## Diagnosing the bar

Start with the read-only report — it covers every layer below in one run (exit 1 when
something failed; `--json` for machine-readable output):

```bash
./start.sh --doctor
```

Then, if needed, separate "no data" from "no bar" by hand:

```bash
python3 scripts/probe_rate_limits.py /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
```

- Probe prints `rateLimits.primary.usedPercent` → the CLI answers; look at injection.
- Probe fails → CLI/auth problem: sign in (app or `codex login`), re-probe.

Checklist:

1. `./start.sh --status` — is the agent running, and does the app have a CDP port?
   `ps -o command= -p <app pid>` must show `--remote-debugging-port=`.
2. Log `~/Library/Logs/spr-limitbar.log`: `identity ok`, `injected target=…`,
   `reload: bar present`, `limits live (…)`; failures read `REFUSING: …`,
   `attach ERR`, `limits ERR`. State: `~/Library/Application Support/spr-limitbar/agent.json`.
3. Live bar state (port from step 1):
   `node scripts/cdp-eval.mjs --port <p> -e 'JSON.stringify(__sprBarGetState())'`.
   `waiting for data…` = no successful read yet; `stale` = last good data older than 15 min.
4. Duplicates / old styles after an edit: `BAR_VERSION` in `bar.js` was not bumped;
   bump it, `./start.sh --stop && ./start.sh`.
5. After a ChatGPT update: Sparkle relaunches without the port — re-run `start.sh`. If it
   still fails, re-verify the method: fuses
   (`node <electron-app-patching>/skills/electron-app-patching/scripts/read_fuses.mjs /Applications/ChatGPT.app`,
   from https://github.com/Prontsevich/electron-app-patching), whether
   `--remote-debugging-port` still exposes `app://-/index.html` (`/json/list`), and the
   shell globals used by the identity check.

## In-page hooks (evaluate with `scripts/cdp-eval.mjs`)

| Hook | Purpose |
|------|---------|
| `__sprBarSetLimits([{name, usedPercent, resetsAtMs, windowDurationMins?}], meta)` | push limits + meta `{live, planType, resetCredits, resetCreditsNextExpiresAtMs, resetCreditTitle, limitReached, spendControlReached, usageAllowed, updatedAtMs, error?}` |
| `__sprBarSetMode('used' \| 'left')` | switch the display mode |
| `__sprBarSetPanel(true \| false)` | open / close the details panel |
| `__sprBarSetPace(true \| false)` | show / hide the pace markers and lines |
| `__sprBarSetNotify({reset, credit, low25, low10})` | change notification settings |
| `__sprBarTestNotify()` | send one `LimitBar · test` notification |
| `__sprBarSetNotifyDryRun(true \| false)` | record would-be notifications in state instead of showing them (tests) |
| `__sprBarGetState()` | `{version, mode, live, limits, meta, theme, panelOpen, pace, notify}` |
| `__sprBarRemove()` | full teardown: removes bar + panel and restores layout padding |

## Caveats

- Open CDP port while the app runs (see above); web pages cannot connect (Chromium origin
  check), local processes can.
- ToS gray zone: runtime UI injection into a third-party app. Not affiliated with OpenAI.
  The app ships device-attestation/integrity plumbing; OpenAI closed the previous method in
  26.924 and may close this one in any update.

## Support files

- `references/internals.md` — how the injection works: identity check, CDP sessions,
  layout strategy, theme tokens, lifecycle, data path, verification.
- `references/rate-limits-protocol.md` — the codex app-server JSON-RPC protocol: handshake,
  response shape, field meanings, "limits unavailable" decision path.
- `scripts/cdp-eval.mjs` — evaluate an expression (or file) in the shell page over CDP,
  with the same identity check; `--png` saves a screenshot. Exit codes: 0 ok, 2
  usage/transport, 3 identity refused, 4 page exception.
- `scripts/probe_rate_limits.py` — live JSON-RPC probe (no app UI required).
