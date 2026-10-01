# LimitBar plugin experiment

This experiment tests a local MCP server, MCP Apps UI, and OpenAI sidebar/thread
entrypoints. It reuses `lib/limits.mjs` and never connects to CDP or modifies the
ChatGPT app bundle. It does not replace the existing status bar.

## Experiment outcome

The user agreed to stop developing this prototype for the current LimitBar
scenario. The tested plugin surfaces can display local limits, but do not
provide the continuously visible status bar or Home-style hover/pinned drawer
needed for the product. Keep the CDP implementation as the main product and
preserve this experiment as reference for future API changes. This decision
does not remove the installed development plugin. Presentation changes
discussed below remain deferred proposals.

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

To refresh an existing development installation after changing the package:

```bash
node spr-prototype/spr-prepare.mjs
codex plugin remove spr-limitbar-prototype@spr-limitbar-lab
codex plugin add spr-limitbar-prototype@spr-limitbar-lab
```

Then restart Desktop normally and use a new local Work conversation. Confirm
the actual `spr_show_limits` call appears in the tool activity. A model saying
it retrieved data is not sufficient evidence that this server was called.
The user's 0.1.2 test exposed the tools in Work but not in an ordinary Chat
conversation. If needed, type `@LimitBar` and select **LimitBar Prototype** from
the plugin menu before requesting `spr_show_limits`. This result concerns the
tested local stdio installation; it does not establish availability for other
plugin types or conversation environments.

## Host styles and Compact view (0.1.2)

This update changes the source server/HTML, not the launcher or MCP config.
An existing corrected 0.1.1 installation runs those files from this checkout:
restart Desktop to load the update; reinstalling is not required. The cached
package manifest may still say 0.1.1 while UI/server diagnostics say 0.1.2.

The UI applies `hostContext.styles.variables` during initialization and theme
updates. Missing variables fall back to system colors; partial context updates
without styles preserve the previously supplied variables.

The HTML resource and UI initialization both declare `inline`, `fullscreen`
and `pip`. Compact view requests `ui/request-display-mode` and uses the actual
returned mode, which may differ from the requested mode. In PiP, **Full view**
requests fullscreen again. Display errors are separate from limits errors.
When the host explicitly omits PiP, the button is hidden and a capability notice
is shown. Diagnostics include `availableDisplayModes` and `hostStyleCount`.

The user reported the original Compact view button did nothing. After restarting
with 0.1.2, the standalone page reported `availableDisplayModes: ["fullscreen"]`.
Desktop does not offer PiP on that tested surface, so hiding Compact view is
expected. A subsequent Work invocation opened a LimitBar tab beside the
conversation with `availableDisplayModes: ["inline", "fullscreen"]`, also
without PiP. Both native checks report applied host styles, live data and no
error. To repeat the checks in another host/context:

1. Confirm diagnostics show UI version `0.1.2` and host styles applied.
2. Click Compact view if offered. Record the actual mode or capability/error
   notice; do not infer PiP from a successful request alone.
3. If PiP opens, switch conversations and confirm visibility and refresh.
4. Return using Full view, then check light/dark appearance in both surfaces.

Automated verification passes 35/35 tests; independent review passed after
fixing mode-button visibility when the optional host mode list is absent.
Browser simulation checks theme updates and a 300px compact layout with sample
data. It does not establish native PiP support; neither tested Desktop context
offers that mode.

This experiment does not create its own native floating window or status bar.

### Presentation selection and restoration

The user subsequently observed a Work invocation opening a split content tab,
then appearing inline after leaving and returning to the conversation. The
current prototype advertises multiple modes and does not declare an initial
presentation preference. It does not automatically request fullscreen from
the widget.

Read-only inspection of Desktop 26.928.21956's
`app-initial-135a4ef2552c.js` identifies relevant host behavior:

- `Uxa` chooses an explicitly requested mode, then a preferred mode; when a
  resource declares modes but has no preference, it can default to fullscreen.
- `eSa` returns an app to inline when its content tab closes and inline is
  supported. `Uxa` also restricts tombstone/adapter-backed presentations to
  inline where applicable.

These paths explain why the same resource can render in both places. The exact
navigation-triggered transition was not traced in the running Desktop app;
restoration or tab/session disposal remains an inference, not a reproduced
root cause. A possible follow-up is to give model invocations an explicit
inline preference, provide user-controlled expand/return actions, and check
navigation restoration manually. Those changes are not implemented yet.

The desired Home-style sidebar behavior is hover preview plus a click-pinned,
narrow drawer. The documented `global` entrypoint launches a fullscreen app;
the published extensions do not expose sidebar-icon hover callbacks or drawer
pinning/width control. Styling a drawer inside the widget iframe would not
change Desktop's outer workspace/tab layout. This interaction cannot currently
be promised by the plugin prototype.

### Standalone workspace tabs

The user also observed a LimitBar tab and a primary Chat tab without close
buttons, while additional tabs created through the plus button were closable.
Read-only inspection of Desktop 26.928.21956 explains this distinction:

- `layout-1861d2700c8d.js` opens the global view as the workspace home tab and
  removes it when that workspace component is disposed.
- The panel controller in `app-initial-135a4ef2552c.js` sets
  `isClosable: false` for `isWorkspaceHome` tabs.
- `thread-app-shell-chrome-9a84c333f674.js` renders the primary Chat as a leading
  workspace tab; additional content tabs have their own close handlers.

These tabs belong to Desktop's workspace layout. The widget does not create
them directly. The user confirmed that navigating through the sidebar Home
entry removes the plugin panel and leaves its workspace. No persisted-state
cleanup is needed. Double-clicking a primary tab
switches between full and split layout in the inspected build, rather than
closing the workspace.

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
   in local Work to distinguish tool discovery from UI support. Select the
   plugin through the composer `@` menu if needed.
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

For deterministic visual checks without reading the local account:

```bash
node spr-prototype/spr-preview.mjs --demo
```

Demo values are explicitly labeled sample data. The preview simulates mode
changes inside the browser; it cannot validate native PiP placement or lifetime.

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

The original prototype passed 31 tests across the repository, and the
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
The initial screenshots did not establish a persistent status-bar slot, the
separate thread entrypoint, Refresh/Show left behavior or Compact view. Their
inline rendering had a gray background and weak secondary text contrast;
the subsequent 0.1.2 update applies host theme variables.

Those screenshots' UI diagnostics `version: 0.1.0` identify the original
HTML/bridge, not the corrected package/server version 0.1.1. The host styles
and display-mode update uses UI/package version 0.1.2 and resource v4.
The user's subsequent 0.1.2 screenshot confirms host style application
(`hostStyleCount: 76`), live data and `error: null` in dark mode. Its global
workspace offers only fullscreen and shows the expected unsupported-PiP notice.
The user then confirmed that sidebar Home exits the global workspace. A Work
conversation successfully invoked `spr_show_limits` and opened a closable
LimitBar tab beside the conversation. That UI reports inline/fullscreen modes,
76 host style variables, a connected bridge, live data and no error; PiP is
not offered. An ordinary Chat conversation did not expose the plugin tools in
the user's test. These observations support a plugin dashboard in the tested
surfaces; a persistent status-bar slot, native PiP, the separate declarative
thread entrypoint and native light-theme/Refresh/Show left interactions remain
outside the established result.
Computer Use remains explicitly
blocked from controlling ChatGPT; visual evidence came from the user. The full
screenshots were not copied into the repository.

## Sources

- [MCP Apps UI quickstart](https://developers.openai.com/plugins/build/app-quickstart)
- [OpenAI MCP Extensions](https://developers.openai.com/plugins/build/extensions)
- [Plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [UI runtime reference](https://developers.openai.com/plugins/reference)
- [Host style variables changelog](https://developers.openai.com/plugins/changelog)
- [Local MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Select a plugin in a conversation](https://learn.chatgpt.com/docs/build-plugins#using-a-plugin)
