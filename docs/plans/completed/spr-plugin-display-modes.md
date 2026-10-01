# LimitBar display modes and host styles

Source: user continuation after the successful local plugin experiment.
Scope: apply MCP Apps host style variables, declare supported display modes,
request PiP through the host bridge, report host decisions and adapt compact
layout. Parent implementation; independent review before handoff. No tracker.
Commit policy: propose only; the earlier commit approval covered the prototype.
Existing changes in README.md, limitbar.mjs, skills/codex-limitbar,
test/agent.test.mjs and graphify-out are outside this unit.

- [x] Apply host styles on initialization and context updates.
- [x] Declare inline/fullscreen/pip; handle actual host decisions separately
  from limits errors and support returning to fullscreen.
- [x] Add regression coverage and verify themes/compact layout in a test host.
- [x] Review independently and resolve findings.
- [x] Verify updated global Desktop rendering and its fullscreen-only mode list.
- [x] Confirm leaving the global plugin workspace through sidebar Home.
- [x] Verify the updated conversation tool UI's host modes; native PiP is not
  offered in the tested Work context.

Completed with a host limitation: the global workspace offers only fullscreen;
the Work conversation tool UI offers inline/fullscreen. Neither tested context
offers PiP, so native floating-window behavior cannot be accepted here. The
user confirmed that sidebar Home leaves the global workspace. The prototype
supports the advertised surfaces but does not replace the persistent status bar.
Desktop Computer Use is blocked; never bypass it through another automation
method. A browser host checks rendering and protocol behavior, not native
window placement/persistence. Other builds, contexts and accounts are outside
this acceptance result.

## Evidence

- User: original Compact view click produced no visible change.
- User: after restarting, version 0.1.2 reports `bridge: connected`,
  `availableDisplayModes: ["fullscreen"]`, `hostStyleCount: 76`, live data and
  no error in the global workspace. The missing Compact view button is the
  intended response to the host capability list.
- User: an ordinary Chat conversation did not expose the plugin tools, while
  Work invoked `spr_show_limits` and opened a closable LimitBar content tab
  beside the conversation. Version 0.1.2 reports `displayMode: fullscreen`,
  `availableDisplayModes: ["inline", "fullscreen"]`, `hostStyleCount: 76`,
  `bridge: connected`, `live: true` and `error: null`. PiP is absent from the
  host's offered modes. This is an observed local installation result, not a
  claim that all plugins are unavailable in Chat.
- User: the global LimitBar workspace and its primary Chat have no close
  buttons; extra tabs created with the plus button are closable. Static Desktop
  inspection identifies the LimitBar tab as a non-closable workspace home,
  removed on workspace disposal, and the Chat as a leading workspace tab.
  The user confirmed that sidebar Home removes the plugin panel. No persisted
  state was modified and no Desktop control restriction was bypassed.
- Parent: focused tests 11/11, including host style initialization/theme updates,
  partial context updates, display-mode declaration, accepted/rejected/failed
  and timed-out requests, duplicate-click suppression and separate view errors.
- Parent: final full tests pass 35/35 after both capability regressions were
  added; focused tests pass 12/12. Prototype module syntax, launcher shell
  syntax and `git diff --check` pass.
- Chrome local test host: simulated PiP and fullscreen switching works. With
  clearly labeled demo data, Show left produces 88%/56% from 12%/44% used.
  Dark PiP measures 300px client/scroll width and 390px client/scroll height;
  no overflow. Host styles switch between light and dark; error layout was
  checked separately. This is not native Desktop PiP acceptance.
- Version 0.1.2, UI resource v4, explicit sample-data preview option. Source
  and tests preserve the original local-account backend and security boundary.
- Independent reviewer `review_spr_plugin`: CHANGES_REQUIRED for hiding the
  standard mode request when the optional host mode list is absent. Parent
  removed the legacy API gate and added the standard-only PiP/full roundtrip
  regression. Re-review PASS; focused 12/12 independently confirmed.
- Package cache update was prevented by workspace permissions. A requested
  escalation was cancelled because reinstalling is unnecessary for this unit:
  the installed launcher/MCP config are identical to generated 0.1.2 and run
  the server directly from this checkout. Restart Desktop to reload the source
  and discover resource v4. The installed manifest may still report 0.1.1;
  current HTML/server diagnostics report 0.1.2.

Sources:
- https://developers.openai.com/plugins/reference
- https://developers.openai.com/plugins/changelog
