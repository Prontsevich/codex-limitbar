# Local LimitBar plugin prototype

Source: user-approved minimal experiment proposed in the conversation.
Scope: local MCP tools, one MCP Apps UI resource, sidebar/thread metadata,
machine-specific marketplace preparation, protocol tests and acceptance notes.
No tracker. No commit requested. Existing changes in README.md, limitbar.mjs,
skills/codex-limitbar and test/agent.test.mjs are outside this unit.

Outcome: core experiment completed on 2026-10-01. The user confirmed live local
limits in a standalone sidebar page and an inline conversation card. Further
surface/interaction checks are optional follow-up work.

- [x] Implement server, UI and local package preparation.
- [x] Run protocol/bridge tests and syntax checks.
- [x] Review independently and resolve introduced defects.
- [x] Verify the local browser bridge, themes, narrow layout and dynamic sizing.
- [x] Verify a real local limits read outside the execution sandbox.
- [x] Install the original local package and confirm its plugin card.
- [x] Verify corrected 0.1.1 is installed and enabled.
- [x] Restart Desktop and verify server/session discovery.
- [x] Verify the global Desktop entrypoint and inline conversation UI.

Follow-up checks: separate thread side panel, Compact view, Refresh/Show left,
Desktop theme switching, narrow panels and inline background/text contrast.

Computer Use refused access to `com.openai.codex` for safety reasons. Desktop
visual acceptance must be performed by the user; do not bypass that restriction
with another UI automation method. A local browser host can validate the HTML
bridge and rendering, but cannot establish Desktop support.

## Evidence

- Independent reviewer `review_spr_plugin`: initial CHANGES_REQUIRED for missing
  dynamic height reports, then PASS after ResizeObserver/lifecycle regression
  coverage. Parent implemented the unit directly. No commit or tracker update.
- Parent: full `node --test` passed 30/30; syntax checks passed for all prototype
  modules; `bash -n` passed for the existing launch/install scripts.
- Chrome browser host: bridge connected; light/dark theme changes and 300px
  width worked. After containing child margins with `display: flow-root`, the
  iframe and document heights both measured 496px; horizontal widths both 300px.
  This was the error state, not real limits or a Desktop panel.
- Live read inside the sandbox failed before a response. A bounded stderr
  classification identified `Operation not permitted` and SQLite startup.
  A documented temporary SQLite location override did not resolve startup.
- Global marketplace registration/installation requires permission to write
  outside the workspace. The first request was superseded by a later request;
  an uncompleted request was cancelled before handoff. No successful install
  or global configuration write is claimed.
- User follow-up: 0.1.0 appears in Desktop, but no UI; a second conversation
  reports `spr_show_limits` missing. Cache files and enabled config verified.
- Packaging defect: an absolute portable MCP command violates the bundled
  runtime's bare-name/contained-path requirement. Parent replaced it with a
  contained executable launcher and bumped the package/server to 0.1.1.
- Parent: focused prototype tests pass 8/8, including generated launcher
  startup with Node absent from PATH. Prepare syntax and launcher shell checks
  pass. Original unrelated working-tree changes remain outside scope.
- Follow-up independent reviewer `review_spr_plugin`: PASS. Confirmed the
  diagnostic in the actual bundled native executable and independently ran
  the generated launcher with a minimal PATH; stdout is JSON-RPC only.
- Parent follow-up: full `node --test` passed 31/31; server syntax and
  `git diff --check` passed.
- Final read-only cache inspection and CLI plugin list confirm 0.1.1 installed
  and enabled with the contained launcher. The escalated install call did not
  return a completion result and was cancelled after this state check; the
  installed state is verified independently, without attributing the write.
- Static Desktop code inspection finds local MCP resource discovery and
  `global`/`thread` metadata parsing; advertised metadata matches. No runtime UI
  automation was attempted.
- User screenshots after restart: sidebar entry opens a standalone page;
  `spr_show_limits` renders an inline card in a new conversation. Standalone
  diagnostics show connected/fullscreen/dark/live and no error; both surfaces
  show usage windows, reset times and credits. Core hypothesis established.
- Separate thread side panel and Compact view remain unverified; screenshots
  do not establish a persistent status-bar extension point. Inline secondary
  text contrast needs refinement. No screenshot files were added to the repo.
