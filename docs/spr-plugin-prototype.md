# LimitBar plugin experiment

This experiment tests a local MCP server, MCP Apps UI, and OpenAI sidebar/thread
entrypoints. It reuses `lib/limits.mjs` and never connects to CDP or modifies the
ChatGPT app bundle. It does not replace the existing status bar.

## Prepare and install

Requires Node 22+ and a locally signed-in Codex account.

```bash
node spr-prototype/spr-prepare.mjs
codex plugin marketplace add ./spr-prototype/.spr-marketplace
codex plugin add spr-limitbar-prototype@spr-limitbar-lab
```

The generated marketplace uses a contained `./spr-launch.sh` executable.
That development launcher holds absolute Node/server paths for this machine.
The installed plugin runs the server from this checkout; keep the checkout in
place. This is a development package, not a portable/public distribution.
Refresh/reinstall the local plugin after changing metadata. UI-breaking changes
must also version `UI_URI` in `spr-server.mjs` to avoid cached resources.

To replace the original 0.1.0 package with the corrected 0.1.1 launcher:

```bash
node spr-prototype/spr-prepare.mjs
codex plugin remove spr-limitbar-prototype@spr-limitbar-lab
codex plugin add spr-limitbar-prototype@spr-limitbar-lab
```

Then restart Desktop normally and use a new local Work conversation. Confirm
the actual `spr_show_limits` call appears in the tool activity. A model saying
it retrieved data is not sufficient evidence that this server was called.

## Why the original package could appear without tools

Version 0.1.0 put an absolute executable path in portable `mcp.json`. The
bundled 0.159.2 runtime requires Agent Plugins stdio commands to be bare
executable names or contained `./` paths. Listing/installing the manifest does
not establish that MCP configuration passed loading. Version 0.1.1 keeps the
manifest command inside the package and runs the known Node binary from a
quoted shell launcher. It does not depend on Desktop's PATH containing Node.

Read-only inspection of Desktop 26.928.21956 found code that discovers local
MCP tool resources and parses the advertised `global` and `thread` entrypoints.
The observed metadata matches that parser. The subsequent user test confirmed
the global sidebar entrypoint and inline tool UI for this account.

If a new conversation still has no `spr_show_limits`, resolve server/session
discovery before judging UI support. If the tool is present but no UI opens,
check Desktop logs for `mcp_extension_entrypoint_rejected` and
`mcp_extension_tool_rejected` events concerning this server. The documented
alternative is to register the server in ChatGPT developer mode, using HTTPS
or Secure MCP Tunnel for the private stdio server, and map the resulting
`plugin_asdk_app...` ID through `.app.json`. That is a separate experiment and
is not configured by this local package.

## Desktop acceptance

After installation, restart Desktop at a convenient time. Keep active work safe;
the test does not require relaunching with a debugging port.

1. Confirm **LimitBar Prototype** appears in the **LimitBar Lab** marketplace.
2. Confirm its `spr-limitbar` MCP server connects and exposes `spr_show_limits`
   and `spr_read_limits`.
3. Look for a LimitBar entry in the global sidebar. Open it without a model turn.
4. In a conversation, look for a LimitBar entry in the side panel. Open it.
5. If entrypoints are absent, invoke `spr_show_limits` from a test conversation
   to distinguish tool discovery from inline UI support.
6. Confirm actual usage windows, reset times and credits. One window is normal.
7. Click **Refresh**, then **Show left**. Expand **Prototype diagnostics** and
   confirm `bridge: connected`, `live: true` and an actual update timestamp.
8. Test light/dark appearance, narrow panels, switching conversations and closing
   the panel. If **Compact view** is available, test it separately.

Capture only the plugin region, never sidebar/chat content. Do not treat a
browser preview as proof of Desktop entrypoint support.

## Boundaries

- The UI is one HTML resource, with no external assets or network access.
- UI calls `spr_read_limits` through the MCP Apps host bridge. The server caches
  reads for 10 seconds and coalesces concurrent requests.
- Visible UI refreshes every five minutes and after becoming visible again.
- Errors show previous values as stale. No raw account IDs or auth payloads are
  forwarded to the UI/model. No notifications or reset-credit consumption.
- Settings are session-only; the two tools remain useful without UI rendering.
- Desktop honors the global sidebar metadata and inline tool UI for this local
  stdio plugin in the user's tested installation. The separate thread side
  panel entrypoint remains unverified.
- There is no persistent status-bar extension point implemented here.

## Checks and removal

For a real-data browser smoke test, start the loopback-only test host and open
the printed URL. It implements a small host bridge, not Desktop entrypoints.
The title explicitly identifies it as a test host. Stop it with Ctrl-C.

```bash
node spr-prototype/spr-preview.mjs
```

```bash
node --check spr-prototype/spr-server.mjs
node --check spr-prototype/spr-prepare.mjs
node --check spr-prototype/spr-preview.mjs
node --test test/spr-plugin.test.mjs
node --test test/spr-widget.test.mjs
codex plugin remove spr-limitbar-prototype@spr-limitbar-lab
codex plugin marketplace remove spr-limitbar-lab
```

## Verification status

Protocol and UI bridge tests pass (31 tests across the repository), and the
independent implementation review passed. The local browser host was checked in
both themes at a 300px panel width, including dynamic height changes.

The user installed 0.1.0 and saw the plugin card, but no UI appeared. In a
subsequent test conversation the model reported `spr_show_limits` unavailable.
The installed cache and enabled config entry were verified. The generated
0.1.1 launcher passes a regression test that starts it without Node on PATH and
reads both tool definitions over stdio.
The corrected 0.1.1 cache and enabled installation were subsequently verified
with `codex plugin list --marketplace spr-limitbar-lab --json`.

On 2026-10-01, the user restarted Desktop and supplied screenshots confirming:

- A new sidebar entry opens LimitBar as a standalone page.
- Invoking `spr_show_limits` in a new conversation renders the same UI inline.
- The standalone page reports `bridge: connected`, `displayMode: fullscreen`,
  `theme: dark`, `live: true`, a current update timestamp and `error: null`.
- Both surfaces render account usage windows, reset times and reset credits.

This establishes the core hypothesis: the local stdio plugin can read local
limits and render its own UI in supported Desktop surfaces without CDP.
The screenshots do not establish a persistent status-bar slot, the separate
thread side panel, Refresh/Show left behavior or Compact view. Those remain
follow-up checks. Inline rendering has a gray background and weak secondary
text contrast; theme integration needs refinement before product use.

The UI diagnostics' `version: 0.1.0` identifies the unchanged HTML/bridge,
not the corrected package/server version 0.1.1. Computer Use remains explicitly
blocked from controlling ChatGPT; visual evidence came from the user. The full
screenshots were not copied into the repository.

## Sources

- [MCP Apps UI quickstart](https://developers.openai.com/plugins/build/app-quickstart)
- [OpenAI MCP Extensions](https://developers.openai.com/plugins/build/extensions)
- [Plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Local MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
