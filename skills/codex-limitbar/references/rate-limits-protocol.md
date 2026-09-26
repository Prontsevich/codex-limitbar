# Codex app-server rate-limits protocol

The OpenAI Codex CLI ships a hidden local JSON-RPC server (`codex app-server --listen
stdio://`) that its own TUI uses. codex-limitbar reads usage through it — the ChatGPT
desktop app itself talks to the same protocol (its bundled CLI is spawned as
`codex app-server --analytics-default-enabled`).

Verified against codex-cli 0.147.0; re-verified 0.154.0 and the bundled
0.155.0-alpha.16.4 inside ChatGPT.app — same shape.

## The protocol

JSONL over stdio. Sequence:

1. `{"method":"initialize","id":1,"params":{"clientInfo":{"name":"...","version":"..."}}}\n`
2. Wait for `{"id":1,"result":{...}}` (handshake ack). The server may emit notifications
   (e.g. `remoteControl/status/changed`) around it — skip anything with `method` and no
   matching `id`.
3. `{"method":"initialized","params":{}}\n` (notification, no id)
4. `{"method":"account/rateLimits/read","id":2}\n`
5. Read until the line with `"id":2` — that is the response. It may arrive AFTER one or
   more notification lines.

Live response shape (camelCase):

```json
{"id":2,"result":{"rateLimits":{"limitId":"codex","limitName":null,
  "primary":{"usedPercent":95,"windowDurationMins":10080,"resetsAt":1787203791},
  "secondary":null,"credits":{"hasCredits":false,"unlimited":false,"balance":"0"},
  "individualLimit":null,"spendControlReached":false,"planType":"plus",
  "rateLimitReachedType":null},
  "rateLimitsByLimitId":{"codex":{...same...}},
  "rateLimitResetCredits":{"availableCount":0,"credits":[]}}}
```

- `usedPercent` 0–100; `windowDurationMins` 300 = 5h, 10080 = weekly.
- `resetsAt` is unix seconds.
- `credits.resetCredits` (or `rateLimitResetCredits.availableCount`) = reset credits left.
- `planType` = `plus` / `pro` / etc.

## Quick probe

```bash
python3 scripts/probe_rate_limits.py [codex-executable]
```

Success = JSON printed with `rateLimits.primary` and `usedPercent`. Failure modes are
explicit: no initialize response (binary missing / server hung), no id-2 response within
15 s (protocol changed or auth unavailable), or an error object on id 2.

Run it under a clean-ish env when the app's isolation is in question:
`env -i HOME=$HOME PATH="$HOME/.local/bin:/usr/bin:/bin" python3 scripts/probe_rate_limits.py`.

## Spawn discipline

Spawn discipline (keeps the child well-behaved inside an app process):

- `spawn(bin, ['app-server', '--listen', 'stdio://'])` with `cwd: os.tmpdir()`,
  `env` = copy with `PWD` overridden and `OLDPWD` / `INIT_CWD` deleted (privacy isolation),
  `stdio: ['pipe', 'pipe', 'ignore']`.
- 15 s timeout; `SIGTERM` after the answer. Consume stdout as a line buffer; skip
  notifications; act on the id-1 ack, then the id-2 response.
- Response is bounded (~1 MiB); a hung server = timeout, not a protocol break.

## Choosing the binary

Preference order (the first that answers wins):

1. The app's own bundled CLI: `<App.app>/Contents/Resources/codex` — same version the UI
   talks to, and no separate install required. In an injected bridge resolve it from
   `app.getAppPath()` and strip `/app.asar` from the tail (sibling `codex`).
2. A standalone `codex` on `PATH` (`~/.local/bin/codex`, mise shims, Homebrew).

## Diagnosing "limits unavailable"

The message can come from EITHER codex-limitbar or the ChatGPT/Codex client itself:

1. Run the probe. If it returns live data, the protocol and auth are FINE — the message
   comes from OpenAI's own client (ChatGPT desktop/web), not from this tool.
2. OpenAI-side causes (known, recurring): the ChatGPT client caches a "limits unavailable"
   state — **restarting the ChatGPT app clears it**; "not available for this account"
   (workspace/plan-side); OpenAI status incidents.
3. If the probe fails: check `~/.codex/auth.json` exists and is fresh; run `codex login`
   and re-probe.

## Pitfalls

- **Don't drive the TUI to get limits.** `codex /status` needs a real terminal;
  `codex exec "/status"` treats it as a prompt; PTY-driving the interactive TUI hangs or
  needs fragile timing. The app-server protocol is the intended non-interactive path.
- **Field naming**: the binary's debug strings also contain snake_case variants
  (`rate_limits`) — the wire is camelCase. If a future CLI flips, decoders must change.
- **Window reality check**: the 5-hour window is suspended for many accounts since
  ~July 2026 — `secondary` may be `null` and only a weekly (10080 min) window remains.
  That is expected, not a bug. Do not hardcode two windows; derive names from
  `windowDurationMins`.
- **Timing**: writing initialize + initialized + read in sequence and then draining
  everything works (the server buffers), but tolerate interleaved notifications.
- **Slow / reconnecting Codex sessions** are a different diagnosis (payload/history bloat),
  not rate limits.
