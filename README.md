# codex-limitbar

A rate-limit status bar injected into the local UI of the **ChatGPT desktop app**
(macOS). It shows your Codex usage windows — percent used, time to reset, plan and reset
credits — right inside the app window, on every launch.

![codex-limitbar status bar](docs/screenshot.png)

```
LIMITS  5h  ▁▁▁▁▁▁  0% used  3h 45m  •  Weekly  ███▄▄▄  73% used  19h 48m     used|left   live · updated 02:11
```

No bundle modification: the bar is injected at runtime into the app's main process over
the Electron inspector. The app's signature, TCC permissions and updater are untouched.

## How it works

1. `start.sh` relaunches ChatGPT with `--inspect=<port>`.
2. `bridge.mjs` installs a hook into the main process: every shell window gets the bar
   injected on load, and the inspector port is closed immediately after install.
3. Limits are read live from the app's own bundled `codex app-server` (stdio JSON-RPC,
   `account/rateLimits/read`) — polled every 5 minutes and refetched when the Mac wakes.

## Requirements

- macOS (tested on the current ChatGPT desktop build)
- Node.js on `PATH` (any recent version)
- ChatGPT desktop app installed in `/Applications`

## Install

```bash
git clone https://github.com/Prontsevich/codex-limitbar.git
cd codex-limitbar
./install.sh        # optional: installs a `codex-limitbar` command into PATH
```

Run it:

```bash
codex-limitbar      # or: ./start.sh
```

`start.sh` quits ChatGPT if it is running, relaunches it with the inspector flag, installs
the bridge and closes the debug port. The bar re-appears automatically on every window
load and on every subsequent launch through the command.

```bash
./start.sh --capture          # same + saves last-run.png of the main window
./install.sh --uninstall      # remove the `codex-limitbar` command
```

### What it looks like

- Per limit: `[name] [mini bar] [NN% used] [time to reset]` — the name sits left of the bar.
- Color by the amount **remaining**: green >= 50, amber >= 25, orange >= 10, red < 10.
- Relative reset time (`2h 13m`); hover shows the exact reset moment.
- `used` / `left` toggle on the right (choice persisted).
- Data note on the far right: `live · updated HH:MM`; hover shows plan + reset credits.
  Until the first successful read it says `sample data`.
- The bar reserves real layout space (padding on the app's layout container) — it never
  covers the sidebar, composer or any control.

## For coding agents

This repo ships two agent skills under `skills/`:

- **`codex-limitbar`** — install, run and repair the bar; the app-server rate-limits
  protocol; diagnostics.
- **`electron-app-patching`** — the general methodology for injecting UI into any
  third-party Electron app (fuses, asar inventory, runtime injection, re-pack pipeline).

Install them into every agent harness found on the machine:

```bash
./install-skills.sh          # symlinks into ~/.claude, ~/.codex, ~/.cursor, ~/.hermes, ...
./install-skills.sh hermes   # or target specific harnesses
./install-skills.sh --check  # report drift, change nothing
```

## Hooks (dev console of the main window)

| Hook | Purpose |
|------|---------|
| `__sprBarSetLimits([{name, usedPercent, resetsAtMs}], meta)` | push limits + `{live, planType, resetCredits, updatedAtMs}` |
| `__sprBarSetMode('used' \| 'left')` | switch display mode |
| `__sprBarGetState()` | read current state/version |
| `__sprBarRemove()` | full teardown, restores layout |

## Troubleshooting

- **No bar after a normal Dock launch** — expected: the bar only exists for launches that
  went through `codex-limitbar` / `start.sh` (the hook lives in process memory).
- **Bar missing after `start.sh`** — check the log:
  `~/Library/Logs/spr-limitbar-bridge.log`; make sure ChatGPT was actually relaunched with
  `--inspect=9333` (`ps -o command= -p <pid>`).
- **`sample data` in the note** — the read failed: check that `codex` CLI is usable
  (`python3 skills/codex-limitbar/scripts/probe_rate_limits.py` prints live JSON).
- **Numbers stale / "limits unavailable"** — restart the ChatGPT app; if the probe still
  fails, re-run `codex login`.

## Caveats

- Runtime UI injection into a third-party app is a ToS gray zone. This project is **not
  affiliated with OpenAI**; use at your own risk. The app ships device-attestation plumbing
  that may react to unusual runtimes.
- The inspector port is open only for the few seconds between launch and install, and it is
  bound to `127.0.0.1`.
- Verified against a specific ChatGPT build; a future update may change the fuse state or
  the shell layout — re-check with the `electron-app-patching` skill if the bar stops
  appearing.

## License

MIT
