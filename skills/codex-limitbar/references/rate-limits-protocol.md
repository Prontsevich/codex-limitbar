# Codex app-server rate-limits protocol

The OpenAI Codex CLI ships a hidden local JSON-RPC server (`codex app-server --listen
stdio://`) that its own TUI uses. codex-limitbar reads usage through it — the ChatGPT
desktop app itself talks to the same protocol (its bundled CLI is spawned as
`codex app-server --analytics-default-enabled`). Implementation: `lib/limits.mjs`
(`rpcFetch`, `parseLimits`, `nameForWindow`, `findCodex`), covered by
`test/limits.test.mjs` — update both with any shape change.

Verified against codex-cli 0.147.0; re-verified 0.154.0, the bundled 0.155.0-alpha.16.4
(ChatGPT 26.917) and the bundled 0.158.0-alpha.2.1 (ChatGPT 26.924) — same core shape;
26.924 adds `ordinaryUsageAllowed`, `accountId`, `rateLimitUpsell`, `normalModelSlug` and
populates the reset-credit list.

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
{"id":2,"result":{"ordinaryUsageAllowed":true,
  "rateLimits":{"limitId":"codex","limitName":null,"normalModelSlug":null,
  "primary":{"usedPercent":0,"windowDurationMins":300,"resetsAt":1790461457},
  "secondary":{"usedPercent":0,"windowDurationMins":10080,"resetsAt":1791048257},
  "credits":{"hasCredits":false,"unlimited":false,"balance":"0"},
  "individualLimit":null,"spendControlReached":false,"planType":"plus",
  "rateLimitReachedType":null},
  "rateLimitsByLimitId":{"codex":{...same...}},
  "rateLimitResetCredits":{"availableCount":3,"credits":[
    {"id":"RateLimitResetCredit_…","resetType":"codexRateLimits","status":"available",
     "grantedAt":1788485573,"expiresAt":1791077573,
     "title":"Full reset (Weekly + 5 hr)","description":"…"}]},
  "accountId":"…","rateLimitUpsell":{...}}}
```

- `usedPercent` 0–100; `windowDurationMins` 300 = 5h, 10080 = weekly.
- `resetsAt`, `grantedAt`, `expiresAt` are unix seconds.
- `rateLimitResetCredits.availableCount` = reset credits left; `credits[]` lists them
  (`status` `available` counts; others are ignored).
- `planType` = `plus` / `pro` / etc. `rateLimitReachedType` names the window that is
  exhausted (null otherwise); `spendControlReached` = the spend limit is hit;
  `ordinaryUsageAllowed: false` = usage is blocked for the account.

What `parseLimits` passes to the bar: per window `{name, usedPercent, resetsAtMs,
windowDurationMins}`; meta `{live, planType, resetCredits, resetCreditsNextExpiresAtMs
(earliest available credit), resetCreditTitle (its title, trimmed, ≤ 80 chars),
limitReached, spendControlReached, usageAllowed, updatedAtMs}`. Deliberately **not**
passed: credit ids and descriptions, `accountId`, `rateLimitUpsell`.

## Quick probe

```bash
python3 scripts/probe_rate_limits.py [codex-executable]   # default: `codex` on PATH
python3 scripts/probe_rate_limits.py /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
```

Success = JSON printed with `rateLimits.primary` and `usedPercent`. Failure modes are
explicit: no initialize response (binary missing / server hung), no id-2 response within
15 s (protocol changed or auth unavailable), or an error object on id 2.

Run it under a clean-ish env when the app's isolation is in question:
`env -i HOME=$HOME PATH="$HOME/.local/bin:/usr/bin:/bin" python3 scripts/probe_rate_limits.py`.

## Spawn discipline

Spawn discipline (as implemented in `rpcFetch`; keeps the child well-behaved and blind to
where the agent was started):

- `spawn(bin, ['app-server', '--listen', 'stdio://'])` with `cwd: os.tmpdir()`,
  `env` = copy with `PWD` overridden and `OLDPWD` / `INIT_CWD` deleted (privacy isolation),
  `stdio: ['pipe', 'pipe', 'ignore']`.
- 15 s timeout; `SIGTERM` after the answer. Consume stdout as a line buffer; skip
  notifications; act on the id-1 ack, then the id-2 response.
- Request ids are fixed: `1` for `initialize`, `2` for `account/rateLimits/read`. The
  `initialize` params carry only `clientInfo` (`name`, `title`, `version`) — no
  `protocolVersion`.
- Responses are small; the reader gives up above 4 MiB of buffered output. A hung server =
  timeout, not a protocol break.

## Choosing the binary

`findCodex` in `lib/limits.mjs` takes the first executable candidate:

1. The app's own bundled CLI — same version the UI talks to, no separate install
   required (`--app` / `CODEX_LIMITBAR_APP` select the app):
   `<App.app>/Contents/Resources/codex-cli/bin/codex` (26.924+), then the pre-26.924
   location `<App.app>/Contents/Resources/codex`. The agent logs the chosen binary once
   (`limits source: …`) — a PATH fallback there means the bundle layout changed again.
2. `codex` in every `PATH` directory.
3. `~/.local/bin/codex`, `~/.local/share/mise/shims/codex`, `/opt/homebrew/bin/codex`,
   `/usr/local/bin/codex`.

Paths are built with `node:path` (platform-neutral; `codex.exe` on Windows).

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
