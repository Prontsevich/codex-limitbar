// bar.js — the LIMITS status bar and its details panel, injected into the ChatGPT
// desktop shell page (app://-/index.html) over CDP. Evaluated both before the DOM
// exists (Page.addScriptToEvaluateOnNewDocument) and into an already-loaded page
// (Runtime.evaluate); both paths converge on the same idempotent apply().
//
// Contract with the helper:
//   - `BAR_VERSION` below is read by the helper with /BAR_VERSION = (\d+)/.
//   - window.__sprBarSetLimits([{name, usedPercent, resetsAtMs, windowDurationMins?}], meta)
//       meta: {live, planType, resetCredits, resetCreditsNextExpiresAtMs?, resetCreditTitle?,
//              limitReached?, spendControlReached?, usageAllowed?, updatedAtMs, error?}
//   - window.__sprBarSetMode('used' | 'left')
//   - window.__sprBarSetPanel(open) — open/close the details panel
//   - window.__sprBarSetPace(bool) — show/hide the pace markers and pace lines
//   - window.__sprBarSetNotify({reset, credit, low25, low10}) — notification settings
//   - window.__sprBarTestNotify() — one clearly labelled test notification
//   - window.__sprBarSetNotifyDryRun(bool) — record would-be notifications instead of
//       showing them (in-memory dedupe while on; for tests)
//   - window.__sprBarGetState() -> {version, mode, live, limits, meta, theme, panelOpen,
//       pace, notify: {settings, permission, dryRun, log}}
//   - window.__sprBarRemove() -> full teardown, restores the layout exactly
//   - window.__sprBarRefreshBinding(payload) — CDP binding added by the helper (the
//       panel's refresh button); absent for --once clients, then the button is hidden.
//   - window.__sprBarRefreshDone() — the helper calls it when a manual refresh settles.
//
// Colors come only from the app's own CSS tokens, so bar and panel follow the
// light/dark theme with no JS. The bar only appears once the app layout is found:
// it reserves space (padding on the layout container) and never overlays app UI.
// The details panel is the one exception: a transient, user-opened overlay.
// Notifications go through the page's Web Notification API, so macOS shows them as
// ChatGPT's own (its icon, its Notification settings). They are always prefixed
// "LimitBar", fire at most once per window cycle, and permission is never requested.
(() => {
  const BAR_VERSION = 26;
  const ID = 'spr-statusbar';
  const PANEL_ID = ID + '-panel';
  const STYLE_ID = ID + '-style';
  const LS_KEY = 'spr-statusbar-mode';
  const PACE_KEY = 'spr-statusbar-pace';
  const NOTIFY_KEY = 'spr-statusbar-notify';
  const NOTIFIED_KEY = 'spr-statusbar-notified';
  const NOTIFY_DEFAULTS = { reset: true, credit: true, low25: false, low10: false };
  const NOTIFY_TITLE = 'LimitBar · Codex';
  const DEDUPE_TTL_MS = 45 * 86400000;
  const RESET_NOTIFY_MAX_LATE_MS = 6 * 3600000;   // a reset seen much later is old news
  const WEEKLY_MINS = 10080;                       // only the weekly window's reset is announced
  const CREDIT_WARN_MS = 24 * 3600000;
  const PACE_MIN_ELAPSED = 0.02;                   // too early in a window to judge pace
  const PACE_ON_BAND = 5;                          // |delta| below this reads "On pace"
  const PACE_WARN = 10;                            // over pace by more than this = warning
  const H = 28;
  const STALE_MS = 15 * 60 * 1000;
  const REFRESH_TIMEOUT_MS = 20000;

  // Hot-swap: same version re-applies; any other version is torn down first.
  const prev = window.__sprBarInstance;
  if (prev && prev.version === BAR_VERSION) {
    try { prev.apply(); } catch (err) {}
    return JSON.stringify({ version: BAR_VERSION, status: 'reapplied' });
  }
  if (prev && typeof prev.remove === 'function') {
    try { prev.remove(); } catch (err) {}
  } else if (typeof window.__sprBarRemove === 'function') {
    try { window.__sprBarRemove(); } catch (err) {}
  }

  const readMode = () => {
    try { return localStorage.getItem(LS_KEY) === 'left' ? 'left' : 'used'; } catch (err) { return 'used'; }
  };
  const writeMode = m => { try { localStorage.setItem(LS_KEY, m); } catch (err) {} };
  const readJSON = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v && typeof v === 'object' ? v : def; } catch (err) { return def; } };
  const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (err) {} };
  const readPace = () => { try { return localStorage.getItem(PACE_KEY) !== 'off'; } catch (err) { return true; } };
  const readNotify = () => {
    const v = readJSON(NOTIFY_KEY, {}), out = {};
    for (const k of Object.keys(NOTIFY_DEFAULTS)) out[k] = typeof v[k] === 'boolean' ? v[k] : NOTIFY_DEFAULTS[k];
    return out;
  };

  // Sticky state: survives re-injection, so pushed limits are not lost on a hot-swap.
  const st = window.__sprBarState = window.__sprBarState || { mode: readMode(), live: false, meta: null, limits: null };
  let pace = readPace();
  let notifySettings = readNotify();

  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  // Traffic light by REMAINING amount, mapped to the app's semantic text tokens
  // (they carry per-theme contrast, e.g. caution is dark amber in the light theme).
  const levelFor = remaining => remaining < 10 ? 'crit' : remaining < 25 ? 'low' : remaining < 50 ? 'mid' : 'ok';
  const fmtLeft = ms => {
    const s = Math.max(0, Math.round(ms / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm';
    return '<1m';
  };
  const fmtAgo = ms => ms < 60000 ? 'just now' : fmtLeft(ms) + ' ago';
  const hhmm = ms => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // "5-hour", "Weekly", "Daily", "3-day" from the window length; else the short name.
  const titleFor = l => {
    const m = Number(l.windowDurationMins) || 0;
    if (m === 10080) return 'Weekly';
    if (m === 1440) return 'Daily';
    if (m > 1440 && m % 1440 === 0) return (m / 1440) + '-day';
    if (m >= 60 && m % 60 === 0) return (m / 60) + '-hour';
    return String(l.name || '?');
  };
  const hasData = () => Array.isArray(st.limits) && st.limits.length > 0;
  const isStale = () => !st.live || !st.meta || !st.meta.updatedAtMs || Date.now() - st.meta.updatedAtMs > STALE_MS || !!st.meta.error;
  const canRefresh = () => typeof window.__sprBarRefreshBinding === 'function';

  // ---- pace -----------------------------------------------------------------------------
  // elapsed: share of the window already gone; delta: used% minus the even-pace used%.
  // Over pace and on track to run out before the reset → runOutMs until that happens.
  const paceFor = l => {
    const winMs = (Number(l.windowDurationMins) || 0) * 60000;
    if (!winMs || !l.resetsAtMs) return null;
    const now = Date.now();
    const elapsed = clamp(1 - (l.resetsAtMs - now) / winMs, 0, 1);
    if (elapsed < PACE_MIN_ELAPSED) return null;
    const used = clamp(Number(l.usedPercent) || 0, 0, 100);
    const delta = used - elapsed * 100;
    let runOutMs = null;
    if (delta > 0 && used > 0 && used < 100) {
      const outAt = now + (100 - used) / (used / (elapsed * winMs));
      if (outAt < l.resetsAtMs) runOutMs = outAt - now;
    }
    return { elapsed, delta, runOutMs };
  };
  // Where the even-pace point sits on a bar that shows used (fill = used) or left.
  const markPos = pc => Math.round((st.mode === 'left' ? 1 - pc.elapsed : pc.elapsed) * 1000) / 10;

  // ---- notifications ------------------------------------------------------------------
  // Keys are rounded to 10 minutes: the server's resetsAt jitters by a second or so
  // between reads, and one window cycle must map to exactly one key.
  const slot = ms => Math.round(ms / 600000);
  let notifyDryRun = false;
  let dryStore = {};
  let dryLog = [];
  const notifyPermission = () => (typeof Notification === 'function' ? Notification.permission : 'unsupported');
  const canNotify = () => notifyPermission() === 'granted';
  const loadNotified = () => notifyDryRun ? dryStore : readJSON(NOTIFIED_KEY, {});
  const markNotified = key => {
    if (notifyDryRun) { dryStore[key] = Date.now(); return; }
    const all = readJSON(NOTIFIED_KEY, {}), now = Date.now();
    for (const k of Object.keys(all)) if (!(now - all[k] < DEDUPE_TTL_MS)) delete all[k];
    all[key] = now;
    writeJSON(NOTIFIED_KEY, all);
  };
  const show = (title, body, tag) => {
    const n = new Notification(title, { body, tag });
    n.onclick = () => { try { window.focus(); } catch (err) {} setPanel(true); };
    return n;
  };
  // Fires one event at most once (per key). Without permission nothing is marked, so
  // nothing fires later in a burst once notifications get enabled.
  const notify = (key, body) => {
    if (loadNotified()[key]) return false;
    if (notifyDryRun) { markNotified(key); dryLog.push({ key, body }); return true; }
    if (!canNotify()) return false;
    try { show(NOTIFY_TITLE, body, key); markNotified(key); return true; } catch (err) { return false; }
  };
  const winName = l => titleFor(l) === 'Weekly' ? 'Weekly limit' : titleFor(l) + ' window';

  // Resets of the given limits (the current ones on every tick, the previous ones right
  // before a push replaces them), threshold crossings and expiring reset credits.
  const checkResets = limits => {
    if (!notifySettings.reset || !Array.isArray(limits)) return;
    const now = Date.now();
    for (const l of limits) {
      if (!l.resetsAtMs || now < l.resetsAtMs || now - l.resetsAtMs > RESET_NOTIFY_MAX_LATE_MS) continue;
      const weekly = (Number(l.windowDurationMins) || 0) >= WEEKLY_MINS || (!l.windowDurationMins && l.name === 'Weekly');
      if (!weekly || !((Number(l.usedPercent) || 0) > 0)) continue;   // 5-hour resets are routine; an unused week is no news
      notify('reset:' + (l.windowDurationMins || l.name) + ':' + slot(l.resetsAtMs), winName(l) + ' has reset — full quota available');
    }
  };
  const checkNotify = () => {
    if (!hasData()) return;
    checkResets(st.limits);
    const now = Date.now();
    for (const l of st.limits) {
      if (!l.resetsAtMs || now >= l.resetsAtMs) continue;
      const left = 100 - clamp(Number(l.usedPercent) || 0, 0, 100);
      const id = (l.windowDurationMins || l.name) + ':' + slot(l.resetsAtMs);
      const tail = ': ' + Math.round(left) + '% left (resets in ' + fmtLeft(l.resetsAtMs - now) + ')';
      // Below 10 also covers 25: one notification, and the 25 one never follows it.
      if (left < 10 && notifySettings.low10) {
        if (notify('low10:' + id, winName(l) + tail)) markNotified('low25:' + id);
      } else if (left < 25 && notifySettings.low25) {
        notify('low25:' + id, winName(l) + tail);
      }
    }
    const exp = st.meta && st.meta.resetCreditsNextExpiresAtMs;
    if (notifySettings.credit && exp && exp - now > 0 && exp - now <= CREDIT_WARN_MS) {
      notify('credit:' + slot(exp), 'A rate-limit reset credit expires in ' + fmtLeft(exp - now));
    }
  };

  const CHEVRON = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 6.5 5 3.5l3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const REFRESH = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const P = '#' + PANEL_ID;
  const CSS = [
    // Shared palette on both roots (the panel lives outside the bar).
    '#' + ID + ',' + P + '{',
    '  --spr-fg: var(--app-color-text-foreground, var(--color-text-primary-surface, CanvasText));',
    '  --spr-fg2: var(--app-color-text-foreground-secondary, var(--spr-fg));',
    '  --spr-fg3: var(--app-color-text-foreground-tertiary, var(--spr-fg2));',
    '  --spr-ok: var(--app-color-text-success, var(--app-color-accent-green, #2da44e));',
    '  --spr-mid: var(--color-text-caution-surface, var(--app-color-accent-yellow, #bf8700));',
    '  --spr-low: var(--app-color-text-warning, var(--app-color-accent-orange, #d1570e));',
    '  --spr-crit: var(--app-color-text-error, var(--app-color-accent-red, #cf222e));',
    // Fills use the vivid accents (a bar is not text); text uses the contrast-safe tokens above.
    '  --spr-ok-fill: var(--app-color-accent-green, var(--spr-ok));',
    '  --spr-mid-fill: var(--app-color-accent-yellow, var(--spr-mid));',
    '  --spr-low-fill: var(--app-color-accent-orange, var(--spr-low));',
    '  --spr-crit-fill: var(--app-color-accent-red, var(--spr-crit));',
    '  --spr-track: var(--switch-track-color, var(--app-color-border, rgba(128,128,128,.2)));',
    '  --spr-hover: var(--menu-item-background-color, rgba(128,128,128,.08));',
    '  font-family:var(--font-ui-family, var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif));',
    '  box-sizing:border-box;',
    '}',
    // Tabular digits only where numbers line up: Inter's tnum also widens the hyphen.
    '#' + ID + ',' + P + ' .spr-row,' + P + ' .spr-sub{font-variant-numeric:tabular-nums}',
    '#' + ID + ' .spr-ok,' + P + ' .spr-ok{color:var(--spr-ok)}',
    '#' + ID + ' .spr-mid,' + P + ' .spr-mid{color:var(--spr-mid)}',
    '#' + ID + ' .spr-low,' + P + ' .spr-low{color:var(--spr-low)}',
    '#' + ID + ' .spr-crit,' + P + ' .spr-crit{color:var(--spr-crit)}',
    '#' + ID + ' .spr-fill,' + P + ' .spr-fill{display:block;height:100%;border-radius:999px;transition:width .25s ease}',
    '#' + ID + ' .spr-ok .spr-fill,' + P + ' .spr-ok .spr-fill{background:var(--spr-ok-fill)}',
    '#' + ID + ' .spr-mid .spr-fill,' + P + ' .spr-mid .spr-fill{background:var(--spr-mid-fill)}',
    '#' + ID + ' .spr-low .spr-fill,' + P + ' .spr-low .spr-fill{background:var(--spr-low-fill)}',
    '#' + ID + ' .spr-crit .spr-fill,' + P + ' .spr-crit .spr-fill{background:var(--spr-crit-fill)}',
    '#' + ID + ' .spr-dot,' + P + ' .spr-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--spr-ok-fill);flex:none}',
    '#' + ID + ' .spr-dot.spr-stale,' + P + ' .spr-dot.spr-stale{background:var(--spr-low-fill)}',
    '#' + ID + ' .spr-dot.spr-none,' + P + ' .spr-dot.spr-none{background:var(--spr-fg3)}',

    // ---- the bar (a button that opens the panel) ----
    '#' + ID + '{',
    '  position:fixed;bottom:0;left:0;right:0;height:' + H + 'px;z-index:25;',
    '  display:flex;align-items:center;gap:12px;padding:0 12px;overflow:hidden;',
    '  font-size:12px;font-weight:500;line-height:' + H + 'px;color:var(--spr-fg2);',
    '  user-select:none;-webkit-user-select:none;white-space:nowrap;cursor:pointer;',
    '  background:transparent;border-radius:var(--radius-md, 10px);outline:none;',
    '  transition:background-color .12s ease;',
    '}',
    '#' + ID + ':hover,#' + ID + '[aria-expanded="true"]{background:var(--spr-hover)}',
    '#' + ID + ':focus-visible{box-shadow:inset 0 0 0 1px var(--spr-fg3)}',
    // Fallback shape (no inset card found): a plain strip on the app surface.
    '#' + ID + '.spr-flat{background:var(--app-color-background-surface-under, var(--color-surface-secondary, Canvas));border-top:1px solid var(--app-color-border, rgba(128,128,128,.2));border-radius:0}',
    '#' + ID + '.spr-flat:hover,#' + ID + '.spr-flat[aria-expanded="true"]{background:var(--spr-hover)}',
    '#' + ID + ' .spr-label{color:var(--spr-fg3);font-size:var(--font-small-caps-md-size, 11px);font-weight:var(--font-small-caps-md-weight, 600);letter-spacing:var(--font-small-caps-md-tracking, .65px);text-transform:uppercase}',
    '#' + ID + ' .spr-block{display:inline-flex;align-items:center;gap:8px;min-width:0}',
    '#' + ID + ' .spr-name{color:var(--spr-fg2)}',
    '#' + ID + ' .spr-track{position:relative;display:inline-block;width:64px;height:4px;border-radius:999px;background:var(--spr-track);flex:none}',
    // Even-pace tick on the mini bar: taller than the track so it reads over the fill.
    '#' + ID + ' .spr-tick{position:absolute;top:-2px;bottom:-2px;width:1px;margin-left:-.5px;background:var(--spr-fg2);border-radius:1px}',
    '#' + ID + ' .spr-val{display:inline-flex;align-items:baseline;gap:4px}',
    '#' + ID + ' .spr-val b{font-weight:600}',
    '#' + ID + ' .spr-val span,#' + ID + ' .spr-reset{color:var(--spr-fg3)}',
    '#' + ID + ' .spr-sep{width:1px;height:12px;background:var(--spr-fg3);flex:none}',
    '#' + ID + ' .spr-spacer{margin-left:auto}',
    '#' + ID + ' .spr-wait{color:var(--spr-fg3)}',
    '#' + ID + ' .spr-end{display:inline-flex;align-items:center;gap:8px;color:var(--spr-fg3);flex:none}',
    '#' + ID + ' .spr-end svg{transition:transform .15s ease}',
    '#' + ID + '[aria-expanded="true"] .spr-end svg{transform:rotate(180deg)}',
    '@media (max-width:720px){#' + ID + ' .spr-reset,#' + ID + ' .spr-label{display:none}}',

    // ---- the details panel (menu tokens: same surface, shadow and radius as app menus) ----
    P + '{',
    '  position:fixed;z-index:29;width:min(320px, calc(100vw - 24px));overflow:auto;',
    '  padding:6px 0;color:var(--spr-fg);font-size:var(--menu-font-size, 13px);line-height:1.35;',
    '  background:var(--menu-background-color, var(--app-color-background-elevated-primary-opaque, Canvas));',
    '  border-radius:var(--popover-radius, 15px);',
    '  box-shadow:var(--menu-box-shadow, 0 0 0 .5px rgba(128,128,128,.2), 0 8px 16px -4px rgba(0,0,0,.3));',
    '  user-select:none;-webkit-user-select:none;cursor:default;',
    '  animation:spr-pop .12s ease-out;',
    '}',
    '@keyframes spr-pop{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
    '@keyframes spr-spin{to{transform:rotate(360deg)}}',
    P + ' .spr-sec{padding:8px 14px}',
    P + ' .spr-hr{height:1px;margin:4px 14px;background:var(--menu-separator-background-color, var(--app-color-border, rgba(128,128,128,.2)))}',
    P + ' .spr-head{display:flex;align-items:center;gap:8px}',
    P + ' .spr-title{font-weight:600;color:var(--spr-fg)}',
    P + ' .spr-badge{font-size:11px;font-weight:500;line-height:18px;padding:0 7px;border-radius:999px;color:var(--spr-fg2);background:var(--spr-hover);text-transform:capitalize}',
    P + ' .spr-sub{display:flex;align-items:center;gap:6px;margin-top:2px;font-size:12px;color:var(--spr-fg3)}',
    P + ' .spr-icon{all:unset;box-sizing:border-box;margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:var(--radius-md, 10px);color:var(--spr-fg2);cursor:pointer}',
    P + ' .spr-icon:hover{background:var(--spr-hover);color:var(--spr-fg)}',
    P + ' .spr-icon:focus-visible{box-shadow:inset 0 0 0 1px var(--spr-fg3)}',
    P + ' .spr-icon[aria-busy="true"] svg{animation:spr-spin .8s linear infinite}',
    P + ' .spr-icon[aria-busy="true"]{cursor:progress}',
    P + ' .spr-lim + .spr-lim{margin-top:12px}',
    P + ' .spr-lname{font-weight:500;color:var(--spr-fg)}',
    P + ' .spr-bar{position:relative;height:6px;margin:7px 0 6px;border-radius:999px;background:var(--spr-track)}',
    // Even-pace marker: a notch cut out of the panel surface so it reads on fill and track.
    P + ' .spr-mark{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;border-radius:1px;background:var(--spr-fg);box-shadow:0 0 0 1.5px var(--menu-background-color, var(--app-color-background-elevated-primary-opaque, Canvas))}',
    P + ' .spr-pace{display:flex;justify-content:space-between;gap:12px;margin-top:2px;font-size:12px;color:var(--spr-fg3)}',
    P + ' .spr-pace .spr-over{color:var(--spr-fg2)}',
    P + ' .spr-pace .spr-over.spr-hot{color:var(--spr-low)}',
    P + ' .spr-row{display:flex;justify-content:space-between;gap:12px;font-size:12px;color:var(--spr-fg3)}',
    P + ' .spr-row b{font-weight:600}',
    P + ' .spr-muted{font-size:12px;color:var(--spr-fg3)}',
    P + ' .spr-strong{color:var(--spr-fg)}',
    P + ' .spr-warn{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--spr-low)}',
    P + ' .spr-warn + .spr-warn{margin-top:4px}',
    P + ' .spr-warn.spr-crit{color:var(--spr-crit)}',
    P + ' .spr-foot{display:flex;align-items:center;justify-content:space-between;gap:12px}',
    // used/left toggle mirrors the app's own mode toggle (Chat / Work) tokens.
    P + ' .spr-toggle{display:inline-flex;padding:2px;gap:2px;border-radius:999px;background:var(--color-background-mode-toggle-track, var(--spr-track));flex:none}',
    P + ' .spr-toggle button{all:unset;cursor:pointer;font-size:12px;line-height:20px;height:20px;padding:0 10px;border-radius:999px;color:var(--color-text-mode-toggle-inactive, var(--spr-fg3));box-sizing:border-box}',
    P + ' .spr-toggle button.on{background:var(--color-background-mode-toggle-selected, var(--app-color-background-control, transparent));color:var(--color-text-mode-toggle-primary, var(--spr-fg));box-shadow:0 0 0 .5px var(--color-border-mode-toggle-selected, transparent)}',
    P + ' .spr-toggle button:focus-visible{box-shadow:inset 0 0 0 1px var(--spr-fg3)}',
    P + ' .spr-source{margin-top:8px;font-size:11px;color:var(--spr-fg3)}',
    P + ' .spr-h{margin-bottom:4px;color:var(--spr-fg3);font-size:var(--font-small-caps-md-size, 11px);font-weight:var(--font-small-caps-md-weight, 600);letter-spacing:var(--font-small-caps-md-tracking, .65px);text-transform:uppercase}',
    P + ' .spr-opt{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:26px;font-size:12px;color:var(--spr-fg2)}',
    // Switches use the app's own switch tokens (track, thumb, checked accent).
    P + ' .spr-sw{all:unset;box-sizing:border-box;position:relative;flex:none;width:var(--switch-track-width, 32px);height:var(--switch-track-height, 19px);border-radius:999px;background:var(--switch-track-color, var(--spr-track));cursor:pointer;transition:background-color .15s ease}',
    P + ' .spr-sw::after{content:"";position:absolute;top:var(--switch-thumb-offset, 3px);left:var(--switch-thumb-offset, 3px);width:var(--switch-thumb-size, 13px);height:var(--switch-thumb-size, 13px);border-radius:50%;background:var(--switch-thumb-color, #fff);box-shadow:var(--switch-thumb-shadow, 0 1px 2px rgba(0,0,0,.2));transition:transform .15s ease}',
    P + ' .spr-sw[aria-checked="true"]{background:var(--switch-track-color-checked, var(--spr-ok-fill))}',
    P + ' .spr-sw[aria-checked="true"]::after{transform:translateX(calc(var(--switch-track-width, 32px) - var(--switch-thumb-size, 13px) - 2 * var(--switch-thumb-offset, 3px)))}',
    P + ' .spr-sw:focus-visible{box-shadow:0 0 0 1.5px var(--spr-fg3)}',
    P + ' .spr-hint{margin-top:4px;font-size:11px;color:var(--spr-fg3)}',
    '@media (prefers-reduced-motion:reduce){' + P + '{animation:none}' + P + ' .spr-icon[aria-busy="true"] svg{animation:none}#' + ID + ' .spr-end svg,' + P + ' .spr-sw,' + P + ' .spr-sw::after{transition:none}}'
  ].join('\n');

  // ---- layout discovery ---------------------------------------------------------------
  // The app layout container: a direct child of #root. Prefer the class-name prefix
  // (hash suffix varies per build), fall back to geometry: non-fixed, >=85% viewport
  // height, >=50% width. Boot loaders / toasts are skipped.
  const findLayouts = () => {
    const root = document.getElementById('root');
    if (!root) return [];
    const byName = [...root.children].filter(ch => /(^|\s)_Layout_/.test(String(ch.className || '')));
    if (byName.length) return byName;
    const out = [];
    for (const ch of root.children) {
      const cls = String(ch.className || '');
      if (/startup|loader|toast/i.test(cls)) continue;
      if (getComputedStyle(ch).position === 'fixed') continue;
      const r = ch.getBoundingClientRect();
      if (r.height >= innerHeight * 0.85 && r.width >= innerWidth * 0.5) out.push(ch);
    }
    return out;
  };
  // The inset rounded content card of the 26.924+ shell; the bar aligns with it and
  // sits in the window frame's bottom gutter (transparent, like the top toolbar band).
  const findCard = layout => {
    if (!layout) return null;
    const el = layout.querySelector('[class*="_PageSurface_"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width >= innerWidth * 0.3 && r.height >= innerHeight * 0.5 ? el : null;
  };

  let lastHtml = '';
  let lastPanelHtml = '';
  let layouts = [];
  let card = null;
  let panelOpen = false;
  let refreshing = false;
  let refreshTimer = 0;
  let panelTick = 0;

  const ensureStyle = () => {
    let s = document.getElementById(STYLE_ID);
    if (!s) {
      s = document.createElement('style');
      s.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(s);
    }
    if (s.textContent !== CSS) s.textContent = CSS;
  };

  // ---- panel open/close ---------------------------------------------------------------
  const onBarClick = () => setPanel(!panelOpen);
  const onBarKey = ev => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setPanel(!panelOpen); }
  };
  // Outside pointerdown closes; the bar itself toggles through its own click.
  const onDocPointer = ev => {
    const t = ev.target;
    const bar = document.getElementById(ID), panel = document.getElementById(PANEL_ID);
    if ((panel && panel.contains(t)) || (bar && bar.contains(t))) return;
    setPanel(false);
  };
  const onDocKey = ev => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    setPanel(false);
    const bar = document.getElementById(ID); if (bar) bar.focus();
  };
  const onBlur = () => setPanel(false);

  const onPanelClick = ev => {
    const el = ev.target && ev.target.closest ? ev.target : null;
    if (!el) return;
    const mode = el.closest('[data-spr-mode]');
    if (mode) {
      st.mode = mode.getAttribute('data-spr-mode') === 'left' ? 'left' : 'used';
      writeMode(st.mode);
      render();
      return;
    }
    if (el.closest('[data-spr-refresh]')) { requestRefresh(); return; }
    const sw = el.closest('[data-spr-switch]');
    if (sw) {
      const key = sw.getAttribute('data-spr-switch');
      const on = sw.getAttribute('aria-checked') !== 'true';
      if (key === 'pace') setPace(on);
      else if (key.startsWith('notify:')) setNotify({ [key.slice(7)]: on });
    }
  };

  const requestRefresh = () => {
    if (refreshing || !canRefresh()) return;
    refreshing = true;
    clearTimeout(refreshTimer);
    // The helper answers through __sprBarRefreshDone / __sprBarSetLimits; a stale
    // binding (agent gone) must not leave the spinner running forever.
    refreshTimer = setTimeout(() => { refreshing = false; renderPanel(); }, REFRESH_TIMEOUT_MS);
    renderPanel();
    try { window.__sprBarRefreshBinding('refresh'); } catch (err) { refreshing = false; renderPanel(); }
  };
  const refreshDone = () => {
    if (!refreshing) return;
    refreshing = false;
    clearTimeout(refreshTimer);
    renderPanel();
  };

  function setPanel(open) {
    open = !!open && !!document.getElementById(ID);
    if (open === panelOpen) return;
    panelOpen = open;
    const bar = document.getElementById(ID);
    if (bar) bar.setAttribute('aria-expanded', String(open));
    if (open) {
      document.addEventListener('pointerdown', onDocPointer, true);
      document.addEventListener('keydown', onDocKey, true);
      addEventListener('blur', onBlur);
      panelTick = setInterval(() => { render(); }, 10000);
      renderPanel();
    } else {
      document.removeEventListener('pointerdown', onDocPointer, true);
      document.removeEventListener('keydown', onDocKey, true);
      removeEventListener('blur', onBlur);
      clearInterval(panelTick); panelTick = 0;
      const p = document.getElementById(PANEL_ID); if (p) p.remove();
      lastPanelHtml = '';
    }
  }

  const ensurePanel = () => {
    let p = document.getElementById(PANEL_ID);
    if (!p) {
      p = document.createElement('div');
      p.id = PANEL_ID;
      p.setAttribute('role', 'dialog');
      p.setAttribute('aria-label', 'Codex usage limits');
      p.addEventListener('click', onPanelClick);
      (document.body || document.documentElement).appendChild(p);
      lastPanelHtml = '';
    }
    return p;
  };

  // Above the bar, left-aligned with it, clamped into the viewport.
  const placePanel = () => {
    const p = document.getElementById(PANEL_ID), bar = document.getElementById(ID);
    if (!p || !bar) return;
    const r = bar.getBoundingClientRect();
    const w = p.offsetWidth || 320;
    const left = clamp(Math.round(r.left), 12, Math.max(12, innerWidth - w - 12)) + 'px';
    const bottom = Math.round(innerHeight - r.top + 6) + 'px';
    const maxH = Math.max(160, Math.round(r.top - 18)) + 'px';
    if (p.style.left !== left) p.style.left = left;
    if (p.style.bottom !== bottom) p.style.bottom = bottom;
    if (p.style.maxHeight !== maxH) p.style.maxHeight = maxH;
  };

  // ---- rendering ----------------------------------------------------------------------
  const ensureBar = () => {
    let d = document.getElementById(ID);
    if (d && d.dataset.sprVersion !== String(BAR_VERSION)) { d.remove(); d = null; lastHtml = ''; }
    if (!d) {
      d = document.createElement('div');
      d.id = ID;
      d.setAttribute('role', 'button');
      d.setAttribute('tabindex', '0');
      d.setAttribute('aria-haspopup', 'dialog');
      d.setAttribute('aria-controls', PANEL_ID);
      d.setAttribute('aria-expanded', String(panelOpen));
      d.setAttribute('aria-label', 'Codex usage limits — show details');
      d.dataset.sprVersion = String(BAR_VERSION);
      d.addEventListener('click', onBarClick);
      d.addEventListener('keydown', onBarKey);
      (document.body || document.documentElement).appendChild(d);
      lastHtml = '';
    }
    return d;
  };

  const usage = l => {
    const used = clamp(Number(l.usedPercent) || 0, 0, 100);
    const remaining = 100 - used;
    return {
      lvl: levelFor(remaining),
      shown: Math.round(st.mode === 'left' ? remaining : used),
      fill: st.mode === 'left' ? remaining : used,
      word: st.mode === 'left' ? 'left' : 'used',
      left: l.resetsAtMs ? fmtLeft(l.resetsAtMs - Date.now()) : null
    };
  };

  const blockHTML = l => {
    const u = usage(l);
    const pc = pace ? paceFor(l) : null;
    // Layout: [name] [mini bar + even-pace tick] [NN% used] [time-to-reset]
    return '<span class="spr-block">'
      + '<span class="spr-name">' + esc(l.name) + '</span>'
      + '<span class="spr-track spr-' + u.lvl + '"><span class="spr-fill" style="width:' + u.fill + '%"></span>'
      + (pc ? '<span class="spr-tick" style="left:' + markPos(pc) + '%"></span>' : '') + '</span>'
      + '<span class="spr-val"><b class="spr-' + u.lvl + '">' + u.shown + '%</b><span>' + u.word + '</span></span>'
      + '<span class="spr-reset">' + (u.left || '—') + '</span>'
      + '</span>';
  };

  const statusDot = () => {
    if (!hasData()) return '<span class="spr-dot spr-none"></span>';
    return '<span class="spr-dot' + (isStale() ? ' spr-stale' : '') + '"></span>';
  };

  const renderBar = () => {
    const bar = document.getElementById(ID);
    if (!bar) return;
    let html = '<span class="spr-label">Limits</span>';
    if (hasData()) {
      st.limits.forEach((l, i) => { if (i > 0) html += '<span class="spr-sep"></span>'; html += blockHTML(l); });
    } else {
      html += '<span class="spr-wait">' + (st.meta && st.meta.error ? 'limits unavailable' : 'waiting for data…') + '</span>';
    }
    html += '<span class="spr-end spr-spacer">' + statusDot() + CHEVRON + '</span>';
    if (html !== lastHtml) { bar.innerHTML = html; lastHtml = html; }
    const label = !hasData() ? 'Codex usage limits, open details'
      : 'Codex usage limits, ' + (isStale() ? 'stale' : 'live') + ', updated ' + hhmm(st.meta.updatedAtMs) + ', open details';
    if (bar.getAttribute('aria-label') !== label) bar.setAttribute('aria-label', label);
  };

  const paceHTML = pc => {
    const d = Math.round(pc.delta);
    let left;
    if (Math.abs(pc.delta) < PACE_ON_BAND) left = '<span>On pace</span>';
    else if (pc.delta > 0) left = '<span class="spr-over' + (pc.delta > PACE_WARN ? ' spr-hot' : '') + '">' + d + '% over pace</span>';
    else left = '<span>' + (-d) + '% under pace</span>';
    const right = pc.runOutMs != null ? '<span class="spr-over spr-hot">At this pace: out in ' + fmtLeft(pc.runOutMs) + '</span>' : '';
    return '<div class="spr-pace">' + left + right + '</div>';
  };
  const switchHTML = (key, label, on) =>
    '<div class="spr-opt"><span>' + esc(label) + '</span>'
    + '<button type="button" class="spr-sw" role="switch" data-spr-switch="' + key + '" aria-checked="' + (!!on) + '" aria-label="' + esc(label) + '"></button></div>';

  const panelHTML = () => {
    const m = st.meta || {};
    const data = hasData();
    let h = '<div class="spr-sec"><div class="spr-head"><span class="spr-title">Codex</span>';
    if (m.planType) h += '<span class="spr-badge">' + esc(m.planType) + '</span>';
    if (canRefresh()) {
      h += '<button class="spr-icon" type="button" data-spr-refresh aria-label="Refresh limits"'
        + (refreshing ? ' aria-busy="true"' : '') + '>' + REFRESH + '</button>';
    }
    h += '</div><div class="spr-sub">';
    if (m.updatedAtMs) {
      h += statusDot() + '<span>'
        + (isStale() ? 'Stale · updated ' : 'Updated ') + fmtAgo(Date.now() - m.updatedAtMs) + '</span>';
    } else {
      h += statusDot() + '<span>' + (m.error ? 'Limits unavailable' : 'Waiting for the first read…') + '</span>';
    }
    h += '</div></div>';

    if (data) {
      h += '<div class="spr-hr"></div><div class="spr-sec">';
      for (const l of st.limits) {
        const u = usage(l);
        const pc = pace ? paceFor(l) : null;
        h += '<div class="spr-lim"><div class="spr-lname">' + esc(titleFor(l)) + '</div>'
          + '<div class="spr-bar spr-' + u.lvl + '"><span class="spr-fill" style="width:' + u.fill + '%"></span>'
          + (pc ? '<span class="spr-mark" style="left:' + markPos(pc) + '%"></span>' : '') + '</div>'
          + '<div class="spr-row"><span><b class="spr-' + u.lvl + '">' + u.shown + '%</b> ' + u.word + '</span>'
          + '<span>' + (u.left ? 'Resets in ' + u.left : 'Reset time not reported') + '</span></div>'
          + (pc ? paceHTML(pc) : '') + '</div>';
      }
      h += '</div>';
    }

    if (m.resetCredits > 0) {
      h += '<div class="spr-hr"></div><div class="spr-sec">'
        + '<div class="spr-strong">' + m.resetCredits + ' rate-limit reset' + (m.resetCredits === 1 ? '' : 's') + ' available</div>';
      if (m.resetCreditsNextExpiresAtMs) {
        h += '<div class="spr-muted">Next expires in '
          + fmtLeft(m.resetCreditsNextExpiresAtMs - Date.now()) + '</div>';
      }
      if (m.resetCreditTitle) h += '<div class="spr-muted">' + esc(m.resetCreditTitle) + '</div>';
      h += '</div>';
    }

    const warns = [];
    if (m.limitReached) warns.push(['crit', 'Rate limit reached (' + m.limitReached + ')']);
    if (m.spendControlReached) warns.push(['crit', 'Spend limit reached']);
    if (m.usageAllowed === false) warns.push(['crit', 'Usage is currently not allowed for this account']);
    if (m.error) warns.push(['low', (data ? 'Last refresh failed: ' : '') + m.error]);
    if (warns.length) {
      h += '<div class="spr-hr"></div><div class="spr-sec">'
        + warns.map(([lvl, text]) => '<div class="spr-warn' + (lvl === 'crit' ? ' spr-crit' : '') + '">' + esc(text) + '</div>').join('')
        + '</div>';
    }

    h += '<div class="spr-hr"></div><div class="spr-sec"><div class="spr-foot"><span class="spr-muted">Show</span>'
      + '<span class="spr-toggle" role="group" aria-label="Show used or left">'
      + '<button type="button" data-spr-mode="used" class="' + (st.mode === 'used' ? 'on' : '') + '" aria-pressed="' + (st.mode === 'used') + '">used</button>'
      + '<button type="button" data-spr-mode="left" class="' + (st.mode === 'left' ? 'on' : '') + '" aria-pressed="' + (st.mode === 'left') + '">left</button>'
      + '</span></div>'
      + switchHTML('pace', 'Pace marker', pace) + '</div>';

    h += '<div class="spr-hr"></div><div class="spr-sec"><div class="spr-h">Notify me</div>'
      + switchHTML('notify:reset', 'When the weekly limit resets', notifySettings.reset)
      + switchHTML('notify:credit', 'Reset credit expires within 24 h', notifySettings.credit)
      + switchHTML('notify:low25', 'Less than 25% left', notifySettings.low25)
      + switchHTML('notify:low10', 'Less than 10% left', notifySettings.low10);
    if (!canNotify()) h += '<div class="spr-hint">Enable notifications for ChatGPT in System Settings</div>';
    h += '<div class="spr-source">Local app-server · refreshes every 5 min</div></div>';
    return h;
  };

  function renderPanel() {
    if (!panelOpen) return;
    const p = ensurePanel();
    const html = panelHTML();
    if (html !== lastPanelHtml) {
      // Keep keyboard focus on the same control across a re-render.
      const a = document.activeElement;
      const sel = a && p.contains(a)
        ? (a.hasAttribute('data-spr-refresh') ? '[data-spr-refresh]'
          : a.hasAttribute('data-spr-mode') ? '[data-spr-mode="' + a.getAttribute('data-spr-mode') + '"]'
          : a.hasAttribute('data-spr-switch') ? '[data-spr-switch="' + a.getAttribute('data-spr-switch') + '"]' : null)
        : null;
      p.innerHTML = html;
      lastPanelHtml = html;
      if (sel) { const again = p.querySelector(sel); if (again) again.focus(); }
    }
    placePanel();
  }

  const render = () => { renderBar(); renderPanel(); };

  const restorePad = el => {
    el.style.paddingBottom = el.dataset.sprOrigPad || '';
    delete el.dataset.sprPadded;
    delete el.dataset.sprOrigPad;
  };

  const ensurePad = found => {
    for (const el of document.querySelectorAll('[data-spr-padded]')) {
      if (found.indexOf(el) === -1) restorePad(el);
    }
    for (const el of found) {
      if (!el.dataset.sprPadded) {
        el.dataset.sprOrigPad = el.style.paddingBottom || '';
        el.dataset.sprPadded = '1';
      }
      if (el.style.paddingBottom !== H + 'px') el.style.paddingBottom = H + 'px';
    }
  };

  // Horizontal extent: aligned with the content card when there is one (leaves the
  // icon rail column clean), otherwise a full-width flat strip.
  const place = bar => {
    const flat = !card;
    if (bar.classList.contains('spr-flat') !== flat) bar.classList.toggle('spr-flat', flat);
    let left = '0px', right = '0px';
    if (card) {
      const r = card.getBoundingClientRect();
      left = Math.max(0, Math.round(r.left)) + 'px';
      right = Math.max(0, Math.round(innerWidth - r.right)) + 'px';
    }
    if (bar.style.left !== left) bar.style.left = left;
    if (bar.style.right !== right) bar.style.right = right;
  };

  let ro = null;
  const observeSizes = () => {
    if (!ro) return;
    ro.disconnect();
    for (const el of layouts) ro.observe(el);
    if (card) ro.observe(card);
  };

  const apply = () => {
    if (!document.body) return { bar: 'no-body' };
    const found = findLayouts();
    if (!found.length) {
      // No app layout yet (boot, or a route without it): never float over unknown UI.
      setPanel(false);
      const b = document.getElementById(ID); if (b) { b.remove(); lastHtml = ''; }
      for (const el of document.querySelectorAll('[data-spr-padded]')) restorePad(el);
      layouts = []; card = null;
      return { bar: 'no-layout' };
    }
    ensureStyle();
    const bar = ensureBar();
    ensurePad(found);
    const nextCard = findCard(found[0]);
    const changed = nextCard !== card || found.length !== layouts.length || found.some((el, i) => el !== layouts[i]);
    layouts = found; card = nextCard;
    if (changed) observeSizes();
    place(bar);
    render();
    return { bar: 'ok', padded: layouts.length, card: !!card };
  };

  // ---- lifecycle -------------------------------------------------------------------------
  let tick = 0, debounce = 0, mo = null, started = false;
  const onResize = () => apply();
  // The tick also drives notifications, so a reset is announced on time without
  // waiting for the next poll.
  const onTick = () => { apply(); try { checkNotify(); } catch (err) {} };
  const onReady = () => start();

  const needsApply = () => {
    const bar = document.getElementById(ID);
    const found = findLayouts();
    if (!found.length) return !!bar || document.querySelectorAll('[data-spr-padded]').length > 0;
    if (!bar || bar.dataset.sprVersion !== String(BAR_VERSION)) return true;
    if (panelOpen && !document.getElementById(PANEL_ID)) return true;
    if (found.some(el => el.style.paddingBottom !== H + 'px')) return true;
    if (found.length !== layouts.length || found.some((el, i) => el !== layouts[i])) return true;
    return findCard(found[0]) !== card;
  };

  function start() {
    if (started) return;
    started = true;
    document.removeEventListener('DOMContentLoaded', onReady);
    apply();
    try { checkNotify(); } catch (err) {}
    // Countdown refresh + periodic safety re-apply + notification checks.
    tick = setInterval(onTick, 20000);
    addEventListener('resize', onResize);
    if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(() => apply()); observeSizes(); }
    // React re-renders / route switches can drop the padding or the layout node.
    mo = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { if (needsApply()) apply(); }, 250);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  const remove = () => {
    setPanel(false);
    started = false;
    clearInterval(tick);
    clearTimeout(debounce);
    clearTimeout(refreshTimer);
    refreshing = false;
    removeEventListener('resize', onResize);
    document.removeEventListener('DOMContentLoaded', onReady);
    if (mo) { mo.disconnect(); mo = null; }
    if (ro) { ro.disconnect(); ro = null; }
    const b = document.getElementById(ID); if (b) b.remove();
    const p = document.getElementById(PANEL_ID); if (p) p.remove();
    const s = document.getElementById(STYLE_ID); if (s) s.remove();
    for (const el of document.querySelectorAll('[data-spr-padded]')) restorePad(el);
    layouts = []; card = null; lastHtml = ''; lastPanelHtml = '';
    if (window.__sprBarInstance === instance) delete window.__sprBarInstance;
    notifyDryRun = false; dryStore = {}; dryLog = [];
    for (const k of ['__sprBarSetLimits', '__sprBarSetMode', '__sprBarSetPanel', '__sprBarGetState', '__sprBarRemove', '__sprBarRefreshDone',
      '__sprBarSetPace', '__sprBarSetNotify', '__sprBarTestNotify', '__sprBarSetNotifyDryRun']) {
      try { delete window[k]; } catch (err) {}
    }
  };

  const instance = { version: BAR_VERSION, apply, remove };
  window.__sprBarInstance = instance;

  function setPace(on) {
    pace = !!on;
    try { localStorage.setItem(PACE_KEY, pace ? 'on' : 'off'); } catch (err) {}
    render();
  }
  function setNotify(partial) {
    for (const k of Object.keys(NOTIFY_DEFAULTS)) {
      if (partial && typeof partial[k] === 'boolean') notifySettings[k] = partial[k];
    }
    writeJSON(NOTIFY_KEY, notifySettings);
    renderPanel();
    try { checkNotify(); } catch (err) {}
  }

  window.__sprBarSetLimits = (arr, meta) => {
    try {
      const prevLimits = st.limits;
      st.limits = (arr || []).map(l => ({
        name: String(l.name || l.id || '?'),
        usedPercent: Number(l.usedPercent != null ? l.usedPercent : l.used) || 0,
        resetsAtMs: Number(l.resetsAtMs || l.resetsAt) || null,
        windowDurationMins: Number(l.windowDurationMins) || null
      }));
      if (meta) { st.live = !!meta.live; st.meta = meta; }
      refreshDone();
      render();
      // A push after a reset replaces the old window: announce that reset first.
      try { checkResets(prevLimits); checkNotify(); } catch (err) {}
      return true;
    } catch (err) { return false; }
  };
  window.__sprBarSetMode = m => { st.mode = m === 'left' ? 'left' : 'used'; writeMode(st.mode); render(); };
  window.__sprBarSetPanel = open => { setPanel(open); return panelOpen; };
  window.__sprBarRefreshDone = refreshDone;
  window.__sprBarSetPace = on => { setPace(on); return pace; };
  window.__sprBarSetNotify = partial => { setNotify(partial); return Object.assign({}, notifySettings); };
  window.__sprBarTestNotify = () => {
    if (!canNotify()) return { ok: false, permission: notifyPermission() };
    try { show('LimitBar · test', 'Test notification from codex-limitbar', 'spr-test'); return { ok: true, permission: 'granted' }; }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  };
  window.__sprBarSetNotifyDryRun = on => {
    notifyDryRun = !!on; dryStore = {}; dryLog = [];
    return notifyDryRun;
  };
  window.__sprBarGetState = () => ({
    version: BAR_VERSION, mode: st.mode, live: st.live, meta: st.meta, limits: st.limits,
    theme: document.documentElement.dataset.theme || null, panelOpen, pace,
    notify: { settings: Object.assign({}, notifySettings), permission: notifyPermission(), dryRun: notifyDryRun, log: dryLog.slice() }
  });
  window.__sprBarRemove = remove;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else start();
  return JSON.stringify({ version: BAR_VERSION, status: started ? 'installed' : 'deferred' });
})();
