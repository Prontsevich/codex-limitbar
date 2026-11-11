// bar.js — the LIMITS status bar and its details panel, injected into the ChatGPT
// desktop shell page (app://-/index.html) over CDP. Evaluated both before the DOM
// exists (Page.addScriptToEvaluateOnNewDocument) and into an already-loaded page
// (Runtime.evaluate); both paths converge on the same idempotent apply().
//
// Contract with the helper:
//   - `BAR_VERSION` below is read by the helper with /BAR_VERSION = (\d+)/.
//   - window.__sprBarSetLimits([{name, usedPercent, resetsAtMs, windowDurationMins?}], meta)
//       meta: {live, planType, resetCredits, resetCreditsNextExpiresAtMs?, resetCreditTitle?,
//              resetCreditsList?: [{expiresAtMs, title}],
//              limitReached?, spendControlReached?, usageAllowed?, updatedAtMs, error?}
//   - window.__sprBarSetMode('used' | 'left')
//   - window.__sprBarSetPanel(open, view?) — open/close the details panel; view 'main' | 'settings' | 'credits'
//   - window.__sprBarSetPace(bool) — show/hide the pace markers and pace lines
//   - window.__sprBarSetNotify({reset, credit, low25, low10}) — notification settings
//   - window.__sprBarSetThresholds({crit, low, mid} | {scope, crit, low, mid} | {scope, reset: true})
//       — color thresholds by remaining %; `scope` is '' (all windows), 'default' or a
//       `windowDurationMins`. With no scope, applies to the global defaults.
//   - window.__sprBarTestNotify() — one clearly labelled test notification
//   - window.__sprBarSetNotifyDryRun(bool) — record would-be notifications instead of
//       showing them (in-memory dedupe while on; for tests)
//   - window.__sprBarGetState() -> {version, mode, position, placement, sidebarStyle, live, limits, meta, theme, panelOpen,
//       panelView, pace, event, notify: {settings, permission, dryRun, log}}
//   - window.__sprBarRemove(animate?) -> full teardown, restores the layout exactly
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
// "LimitBar" and fire at most once per window cycle. A weekly reset is announced in the
// bar itself as well, so the event never depends on that permission; the system
// notification is an addition. Permission is asked for in exactly one place — the
// Settings button — and never on load or on a timer.
(() => {
  const BAR_VERSION = 56;
  const ID = 'spr-statusbar';
  const PANEL_ID = ID + '-panel';
  const STYLE_ID = ID + '-style';
  const LS_KEY = 'spr-statusbar-mode';
  const POSITION_KEY = 'spr-statusbar-position';
  const SIDEBAR_STYLE_KEY = 'spr-statusbar-sidebar-style';
  const SIDEBAR_STYLES = [
    ['vertical', 'Vertical'], ['horizontal', 'Horizontal'], ['rings', 'Rings'], ['slots', 'Vibe Slots']
  ];
  const PACE_KEY = 'spr-statusbar-pace';
  const NOTIFY_KEY = 'spr-statusbar-notify';
  const NOTIFIED_KEY = 'spr-statusbar-notified';
  const THRESH_KEY = 'spr-statusbar-thresholds';
  const EVENT_KEY = 'spr-statusbar-event';
  const NOTIFY_DEFAULTS = { reset: true, credit: true, low25: false, low10: false };
  // Color thresholds by REMAINING percent: red below crit, orange below low, yellow
  // below mid, green otherwise. Configurable in Settings, globally and per window.
  const THRESH_DEFAULTS = { crit: 10, low: 25, mid: 50 };
  const THRESH_LIMITS = { crit: [1, 45], low: [2, 75], mid: [3, 95] };
  const THRESH_ROWS = [['mid', 'Yellow below'], ['low', 'Orange below'], ['crit', 'Red below']];
  const scopeOf = l => String(l.windowDurationMins || 0);
  const NOTIFY_TITLE = 'LimitBar · Codex';
  const DEDUPE_TTL_MS = 45 * 86400000;
  const RESET_NOTIFY_MAX_LATE_MS = 6 * 3600000;   // a reset seen much later is old news
  const WEEKLY_MINS = 10080;                       // only the weekly window's reset is announced
  const CREDIT_WARN_MS = 24 * 3600000;
  const EVENT_MS = 45000;                          // a reset chip stays this long in the bar
  const EVENT_VISIBLE_MS = 24 * 3600000;           // ...but the panel remembers it for a day
  const SCHEDULE_TOLERANCE_MS = 3 * 3600000;       // a roll this close to resetsAt is the weekly schedule
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
  const readPosition = () => {
    try { return localStorage.getItem(POSITION_KEY) === 'sidebar' ? 'sidebar' : 'bottom'; } catch (err) { return 'bottom'; }
  };
  const validSidebarStyle = style => SIDEBAR_STYLES.some(([key]) => key === style);
  const readSidebarStyle = () => {
    try {
      const style = localStorage.getItem(SIDEBAR_STYLE_KEY);
      if (validSidebarStyle(style)) return style;
    } catch (err) {}
    return 'vertical';
  };
  const readJSON = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v && typeof v === 'object' ? v : def; } catch (err) { return def; } };
  const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (err) {} };
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const isDefaultThresh = t => t.crit === THRESH_DEFAULTS.crit && t.low === THRESH_DEFAULTS.low && t.mid === THRESH_DEFAULTS.mid;
  const readPace = () => { try { return localStorage.getItem(PACE_KEY) !== 'off'; } catch (err) { return true; } };
  // Thresholds: {d: {crit, low, mid}, w: {'<windowDurationMins>': {…}}} — a window entry
  // overrides the defaults for that window only. Values are clamped; an override equal to
  // the defaults is dropped so the stored shape stays minimal.
  const readThreshes = () => {
    const v = readJSON(THRESH_KEY, {});
    const read = o => {
      const t = {};
      for (const k of ['crit', 'low', 'mid']) {
        const n = Number(o && o[k]);
        t[k] = Number.isFinite(n) ? clamp(Math.round(n), THRESH_LIMITS[k][0], THRESH_LIMITS[k][1]) : THRESH_DEFAULTS[k];
      }
      return t;
    };
    const out = { d: read(v.d), w: {} };
    if (v.w && typeof v.w === 'object') {
      for (const k of Object.keys(v.w)) {
        const t = read(v.w[k]);
        if (k !== '0' && !isDefaultThresh(t)) out.w[k] = t;
      }
    }
    return out;
  };
  const readNotify = () => {
    const v = readJSON(NOTIFY_KEY, {}), out = {};
    for (const k of Object.keys(NOTIFY_DEFAULTS)) out[k] = typeof v[k] === 'boolean' ? v[k] : NOTIFY_DEFAULTS[k];
    return out;
  };

  // Sticky state: survives re-injection, so pushed limits are not lost on a hot-swap.
  const st = window.__sprBarState = window.__sprBarState || { mode: readMode(), live: false, meta: null, limits: null };
  // The last announced reset also survives a reload — the panel's line is worth a day, the
  // chip in the bar is not (only `chipUntilMs` gates it, and that is never restored).
  if (!st.event) {
    const e = readJSON(EVENT_KEY, null);
    if (e && typeof e.atMs === 'number' && Date.now() - e.atMs < EVENT_VISIBLE_MS) {
      st.event = { chip: e.chip || e.text, text: e.text || e.chip, body: e.body, atMs: e.atMs, resetAtMs: e.resetAtMs || null, chipUntilMs: 0 };
    }
  }
  let pace = readPace();
  let position = readPosition();
  let sidebarStyle = readSidebarStyle();
  let notifySettings = readNotify();
  let threshes = readThreshes();

  // Traffic light by REMAINING amount, mapped to the app's semantic text tokens
  // (they carry per-theme contrast, e.g. caution is dark amber in the light theme).
  // Ordering is enforced: red < orange < yellow, whatever the stored values.
  const threshFor = l => {
    const t = (l && threshes.w[scopeOf(l)]) || threshes.d;
    return { mid: Math.max(t.mid, t.low + 1, t.crit + 2), low: Math.max(t.low, t.crit + 1), crit: t.crit };
  };
  const levelFor = (remaining, t) => {
    const c = t || threshes.d;
    return remaining < c.crit ? 'crit' : remaining < c.low ? 'low' : remaining < c.mid ? 'mid' : 'ok';
  };
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
  // "14:05" for today, "28 Oct 14:05" otherwise — an event noticed days late must not read
  // as if it happened this morning.
  const whenLabel = ms => {
    const d = new Date(ms), t = new Date();
    const same = d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
    return same ? hhmm(ms) : fmtDate(ms) + ' ' + hhmm(ms);
  };
  // Deterministic short date ("22 Oct", "+ year" only outside the current year) — the
  // system locale is not used, so the panel reads the same on every machine.
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = ms => {
    const d = new Date(ms);
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '');
  };
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
  // Available reset credits pushed by the agent (soonest expiry first). Older agents did
  // not carry the list: the drill-in then stays hidden rather than showing an empty screen.
  const creditsList = () => {
    const list = st.meta && Array.isArray(st.meta.resetCreditsList) ? st.meta.resetCreditsList : [];
    return list.filter(c => c && typeof c.expiresAtMs === 'number');
  };
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

  // An event the user must see even when the page may not notify: the reset chip in the
  // bar is the announcement, the system notification is an addition. The dedupe key is
  // marked here regardless of the permission, so one window cycle yields exactly one
  // event — never a backlog that fires in a burst once permission is granted later.
  // A reset only interrupts when it is off schedule. A roll that lands on the announced
  // `resetsAt` is simply what the plan does every week — it is recorded in the panel, in
  // silence. Anything further from the stamp is the provider's own decision and gets the
  // chip and, when allowed, the system notification.
  let eventTimer = 0;
  const announce = (key, body, opts) => {
    const o = opts || {};
    if (loadNotified()[key]) return false;
    markNotified(key);
    const now = Date.now();
    const chip = o.chip || o.text;
    const text = o.text || chip;
    st.event = { chip, text, body, atMs: now, resetAtMs: o.resetAtMs || null, chipUntilMs: o.quiet ? 0 : now + EVENT_MS };
    writeJSON(EVENT_KEY, { chip, text, body, atMs: now, resetAtMs: o.resetAtMs || null });
    clearTimeout(eventTimer);
    // The chip is transient, the panel's line is not: the flag expires, the record stays.
    if (!o.quiet) eventTimer = setTimeout(() => { if (st.event) st.event.chipUntilMs = 0; render(); }, EVENT_MS);
    if (!o.quiet) {
      if (notifyDryRun) dryLog.push({ key, body });
      else if (canNotify()) { try { show(NOTIFY_TITLE, body, key); } catch (err) {} }
    }
    render();
    return true;
  };

  // Resets of the given limits (the current ones on every tick, the previous ones right
  // before a push replaces them), threshold crossings and expiring reset credits.
  const windowId = l => String(l.windowDurationMins || l.name);
  const checkResets = limits => {
    if (!notifySettings.reset || !Array.isArray(limits)) return;
    const now = Date.now();
    for (const l of limits) {
      if (!l.resetsAtMs || now < l.resetsAtMs || now - l.resetsAtMs > RESET_NOTIFY_MAX_LATE_MS) continue;
      const weekly = (Number(l.windowDurationMins) || 0) >= WEEKLY_MINS || (!l.windowDurationMins && l.name === 'Weekly');
      if (!weekly || !((Number(l.usedPercent) || 0) > 0)) continue;   // 5-hour resets are routine; an unused week is no news
      const name = winName(l);
      // The stamp has passed while this snapshot still showed usage: the ordinary weekly
      // roll, seen late. Record it, do not interrupt.
      announce('reset:' + windowId(l) + ':' + slot(l.resetsAtMs),
        name + ' has reset — full quota available',
        { chip: name + ' reset', text: name + ' reset', quiet: true, resetAtMs: l.resetsAtMs });
    }
  };

  // The reported `resetsAt` is not the moment the counters zero out: measured on this
  // account the weekly usage dropped ~45 min BEFORE its stamp, and by the time the stamp
  // passed the snapshot already held the new window — so the clock test above never fired.
  // A new cycle is therefore also detected by comparing two pushes: the same window whose
  // reset moved forward has rolled over. `prev` may come from the previous run of the agent
  // (the app was closed), which is the only way a roll during that gap gets noticed.
  // Whether it was the schedule is decided by where the new cycle started: at the stamp the
  // old one announced, or somewhere else entirely. That test does not care how long we were
  // away — a roll two days after closing still compares the two stamps, not the clock.
  const checkRollover = (prev, next, offline) => {
    if (!notifySettings.reset || !Array.isArray(prev) || !Array.isArray(next)) return;
    for (const n of next) {
      const p = prev.find(x => windowId(x) === windowId(n));
      if (!p || !p.resetsAtMs || !n.resetsAtMs) continue;
      if (n.resetsAtMs <= p.resetsAtMs + 60000) continue;            // same cycle, not a roll
      if (!((Number(p.usedPercent) || 0) > 0)) continue;              // nothing had been used
      const weekly = (Number(n.windowDurationMins) || 0) >= WEEKLY_MINS || (!n.windowDurationMins && n.name === 'Weekly');
      if (!weekly) continue;
      const mins = Number(n.windowDurationMins) || 0;
      const cycleStart = mins ? n.resetsAtMs - mins * 60000 : Date.now();
      const onSchedule = Math.abs(cycleStart - p.resetsAtMs) <= SCHEDULE_TOLERANCE_MS;
      const name = winName(n);
      announce('reset:' + windowId(p) + ':' + slot(p.resetsAtMs),
        name + ' has reset — full quota available',
        {
          chip: name + ' reset',
          text: name + ' reset' + (onSchedule ? '' : ' (off schedule)' + (offline ? ', while closed' : '')),
          quiet: onSchedule,
          resetAtMs: cycleStart
        });
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
  const GEAR = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M12.9 8.6L14.3 9.5L13.5 11.4L11.9 11.0L11.0 11.9L11.4 13.5L9.5 14.3L8.6 12.9L7.4 12.9L6.5 14.3L4.6 13.5L5.0 11.9L4.1 11.0L2.5 11.4L1.7 9.5L3.1 8.6L3.1 7.4L1.7 6.5L2.5 4.6L4.1 5.0L5.0 4.1L4.6 2.5L6.5 1.7L7.4 3.1L8.6 3.1L9.5 1.7L11.4 2.5L11.0 4.1L11.9 5.0L13.5 4.6L14.3 6.5L12.9 7.4Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
  const BACK = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const RIGHT = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 6.5 5l-3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const REFRESH = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const LEVER = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">'
    + '<path d="M4.25 12.5h6.25V5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<circle cx="10.5" cy="12.5" r="1.55" fill="currentColor"/>'
    + '<circle class="spr-pull-knob" cx="10.5" cy="4" r="2.65"/><circle cx="9.7" cy="3.15" r=".65" fill="#fff9"/></svg>';

  const P = '#' + PANEL_ID;
  const S = '#' + ID + '.spr-sidebar';
  const HS = S + '[data-spr-sidebar-style="horizontal"]';
  const VS = S + '[data-spr-sidebar-style="slots"]';
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
    // The reset chip takes the label's slot: it stays readable at narrow widths, where
    // the label is hidden.
    '#' + ID + ' .spr-event{color:var(--spr-ok);font-size:11px;font-weight:600;letter-spacing:.2px;flex:none}',
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
    // The sidebar button participates in the native footer's flex layout.
    S + '{position:relative;inset:auto;z-index:auto;width:36px;height:var(--spr-sidebar-height);flex:none;justify-content:center;gap:9px;padding:0;border:0;line-height:normal;--spr-sidebar-weight:4px;--spr-sidebar-height:36px}',
    S + '[data-spr-sidebar-count="1"]{--spr-sidebar-weight:6px}',
    S + ' .spr-track{width:var(--spr-sidebar-weight);height:24px}',
    S + '[data-spr-sidebar-style="vertical"][data-spr-sidebar-count="2"]:has(.spr-weekly-track) .spr-track{align-self:flex-end;margin-bottom:4px}',
    S + '[data-spr-sidebar-style="vertical"][data-spr-sidebar-count="2"] .spr-weekly-track{height:28px}',
    S + ' .spr-fill{position:absolute;inset:auto 0 0;transition:height .25s ease}',
    S + ' .spr-tick{top:auto;left:-2px;width:calc(var(--spr-sidebar-weight) + 4px);height:1px;margin:0 0 -.5px}',
    HS + '{flex-direction:column;gap:7px}',
    HS + ' .spr-track{width:24px;height:var(--spr-sidebar-weight)}',
    HS + ' .spr-weekly-track{--spr-sidebar-weight:6px}',
    HS + ' .spr-fill{position:static;transition:width .25s ease}',
    HS + ' .spr-tick{top:-2px;bottom:auto;width:1px;height:calc(var(--spr-sidebar-weight) + 4px);margin:0 0 0 -.5px}',
    S + ' .spr-rings{width:32px;height:32px;fill:none}',
    S + ' .spr-ring-track{stroke:var(--spr-track)}',
    S + ' .spr-ring-mark{stroke:var(--spr-fg2);stroke-width:1}',
    S + ' .spr-ring-mark-halo{stroke:var(--app-color-background-surface,Canvas);stroke-width:3;stroke-linecap:round}',
    S + ' .spr-ring-mark-inner{stroke:var(--spr-fg);stroke-width:1.5;stroke-linecap:round}',
    S + ' .spr-sidebar-status{position:absolute;z-index:1;top:3px;right:3px;line-height:0}',
    S + ' .spr-sidebar-status .spr-dot{width:4px;height:4px}',
    '@media (prefers-reduced-motion:reduce){' + S + ' .spr-fill{transition:none}}',

    // Vibe Slots is a dark cabinet in both app themes, with accent colors for the quota.
    VS + '[data-spr-sidebar-count="2"]{--spr-sidebar-height:56px}',
    VS + ' .spr-slot-case{position:absolute;inset:2px 6px 2px 1px;box-sizing:border-box;display:grid;align-content:center;gap:2px;padding:2px 1px;border-radius:4px;border:1px solid #58535f;background:linear-gradient(125deg,#58535f,#35323b 28% 70%,#58535f);box-shadow:inset 0 0 0 .45px #f0c98d8c}',
    VS + ' .spr-slot-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.6px;font:600 15px/1 ui-monospace,monospace}',
    VS + ' .spr-slot-row+.spr-slot-row{margin-top:3px}',
    VS + ' .spr-slot-reel{min-width:0;height:14px;overflow:hidden;border-radius:1px;background:linear-gradient(#19191f,#212127 23% 76%,#1b1b20)}',
    VS + ' .spr-slot-strip{display:block}',
    VS + ' .spr-slot-strip span{display:grid;place-items:center;height:14px}',
    VS + ' .spr-slot-strip .spr-slot-emoji{font:9.5px/1 "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif}',
    VS + ' .spr-slot-percent{font-size:8px;line-height:1;text-align:center;color:#f0c98d}',
    VS + ' .spr-slot-lever{position:absolute;left:31px;top:11px;width:2px;height:13px}',
    VS + '[data-spr-sidebar-count="2"] .spr-slot-lever{top:20px}',
    VS + ' .spr-slot-arm{position:absolute;inset:0;transform-origin:50% 100%;border-radius:1px;background:linear-gradient(90deg,#a7a7b4,#ebdce0 55%,#a7a7b4)}',
    VS + ' .spr-slot-lever::after{content:"";position:absolute;left:50%;bottom:-1px;width:4px;height:4px;transform:translateX(-50%);border-radius:50%;background:#a7a7b4}',
    VS + ' .spr-slot-knob{position:absolute;z-index:1;left:50%;top:-2px;width:6px;height:6px;transform:translateX(-50%);border-radius:50%;background:radial-gradient(circle at 35% 28%,#ffb2a3,#dc3b45 48%,#711320 88%)}',

    // ---- the details panel (menu tokens: same surface, shadow and radius as app menus) ----
    // The shell's peeking sidebar uses z-40; app dialogs and menus use z-50.
    P + '{',
    '  position:fixed;z-index:49;width:min(320px, calc(100vw - 24px));overflow:auto;',
    '  padding:6px 0;color:var(--spr-fg);font-size:var(--menu-font-size, 13px);line-height:1.35;',
    '  background:var(--menu-background-color, var(--app-color-background-elevated-primary-opaque, Canvas));',
    '  border-radius:var(--popover-radius, 15px);',
    '  box-shadow:var(--menu-box-shadow, 0 0 0 .5px rgba(128,128,128,.2), 0 8px 16px -4px rgba(0,0,0,.3));',
    '  user-select:none;-webkit-user-select:none;cursor:default;',
    '  transform-origin:24px 100%;animation:spr-pop .18s cubic-bezier(.2,.8,.2,1);',
    '}',
    P + '.spr-closing{animation:spr-out .14s ease-in forwards;pointer-events:none}',
    P + '.spr-resizing{overflow:hidden;transition:height .22s cubic-bezier(.2,.8,.2,1)}',
    P + '.spr-swap > *{animation:spr-fade .2s ease-out}',
    '@keyframes spr-pop{from{opacity:0;transform:translateY(6px) scale(.97)}to{opacity:1;transform:none}}',
    '@keyframes spr-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(4px) scale(.98)}}',
    '@keyframes spr-fade{from{opacity:0}to{opacity:1}}',
    '@keyframes spr-spin{to{transform:rotate(360deg)}}',
    P + ' .spr-sec{padding:8px 14px}',
    P + ' .spr-hr{height:1px;margin:4px 14px;background:var(--menu-separator-background-color, var(--app-color-border, rgba(128,128,128,.2)))}',
    P + ' .spr-head{display:flex;align-items:center;gap:8px}',
    P + ' .spr-title{font-weight:600;color:var(--spr-fg)}',
    P + ' .spr-badge{font-size:11px;font-weight:500;line-height:18px;padding:0 7px;border-radius:999px;color:var(--spr-fg2);background:var(--spr-hover);text-transform:capitalize}',
    P + ' .spr-sub{display:flex;align-items:center;gap:6px;margin-top:2px;font-size:12px;color:var(--spr-fg3)}',
    P + ' .spr-actions{margin-left:auto;display:inline-flex;align-items:center;gap:2px}',
    P + ' .spr-icon{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:var(--radius-md, 10px);color:var(--spr-fg2);cursor:pointer}',
    P + ' .spr-icon:hover{background:var(--spr-hover);color:var(--spr-fg)}',
    P + ' .spr-icon.spr-back{margin-left:-10px}',   // chevron flush with the content edge (after all:unset)
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
    // The last-reset row carries a long label ("… (off schedule), while closed"): the label
    // wraps, the time stays on one line.
    P + ' .spr-event-row{align-items:baseline;gap:10px}',
    P + ' .spr-event-row .spr-ok{min-width:0;flex:1 1 auto}',
    P + ' .spr-event-row .spr-when{flex:none;white-space:nowrap;font-variant-numeric:tabular-nums}',
    P + ' .spr-row b{font-weight:600}',
    P + ' .spr-muted{font-size:12px;color:var(--spr-fg3)}',
    P + ' .spr-strong{color:var(--spr-fg)}',
    P + ' .spr-warn{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--spr-low)}',
    P + ' .spr-warn + .spr-warn{margin-top:4px}',
    P + ' .spr-warn.spr-crit{color:var(--spr-crit)}',
    // used/left toggle mirrors the app's own mode toggle (Chat / Work) tokens.
    P + ' .spr-toggle{display:inline-flex;padding:2px;gap:2px;border-radius:999px;background:var(--color-background-mode-toggle-track, var(--spr-track));flex:none}',
    P + ' .spr-toggle button{all:unset;cursor:pointer;font-size:12px;line-height:20px;height:20px;padding:0 10px;border-radius:999px;color:var(--color-text-mode-toggle-inactive, var(--spr-fg3));box-sizing:border-box}',
    P + ' .spr-toggle button.on{background:var(--color-background-mode-toggle-selected, var(--app-color-background-control, transparent));color:var(--color-text-mode-toggle-primary, var(--spr-fg));box-shadow:0 0 0 .5px var(--color-border-mode-toggle-selected, transparent)}',
    P + ' .spr-toggle button:focus-visible{box-shadow:inset 0 0 0 1px var(--spr-fg3)}',
    P + ' .spr-h{margin-bottom:4px;color:var(--spr-fg3);font-size:var(--font-small-caps-md-size, 11px);font-weight:var(--font-small-caps-md-weight, 600);letter-spacing:var(--font-small-caps-md-tracking, .65px);text-transform:uppercase}',
    P + ' .spr-opt{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:26px;font-size:12px;color:var(--spr-fg2)}',
    P + ' .spr-opt-seg{margin-bottom:2.5px}',   // 24 px toggle in a 26 px row: evens its gap to the next switch with the 7 px between switches
    P + ' .spr-position-style{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .34s cubic-bezier(.42,0,.25,1),opacity .23s ease}',
    P + ' .spr-position-style[data-spr-expanded]{grid-template-rows:1fr;opacity:1}',
    P + ' .spr-position-style-clip{min-height:0;overflow:clip}',
    '@media (prefers-reduced-motion:reduce){' + P + ' .spr-position-style{transition:none}}',
    // Switches use the app's own switch tokens (track, thumb, checked accent).
    P + ' .spr-sw{all:unset;box-sizing:border-box;position:relative;flex:none;width:var(--switch-track-width, 32px);height:var(--switch-track-height, 19px);border-radius:999px;background:var(--switch-track-color, var(--spr-track));cursor:pointer;transition:background-color .15s ease}',
    P + ' .spr-sw::after{content:"";position:absolute;top:var(--switch-thumb-offset, 3px);left:var(--switch-thumb-offset, 3px);width:var(--switch-thumb-size, 13px);height:var(--switch-thumb-size, 13px);border-radius:50%;background:var(--switch-thumb-color, #fff);box-shadow:var(--switch-thumb-shadow, 0 1px 2px rgba(0,0,0,.2));transition:transform .15s ease}',
    P + ' .spr-sw[aria-checked="true"]{background:var(--switch-track-color-checked, var(--spr-ok-fill))}',
    P + ' .spr-sw[aria-checked="true"]::after{transform:translateX(calc(var(--switch-track-width, 32px) - var(--switch-thumb-size, 13px) - 2 * var(--switch-thumb-offset, 3px)))}',
    P + ' .spr-sw:focus-visible{box-shadow:0 0 0 1.5px var(--spr-fg3)}',
    P + ' .spr-hint{margin-top:4px;font-size:11px;color:var(--spr-fg3)}',
    P + ' .spr-select{box-sizing:border-box;width:116px;max-width:100%;padding:3px 7px;font:inherit;color:var(--spr-fg);background:var(--spr-hover);border:1px solid var(--spr-track);border-radius:var(--radius-sm,7px);color-scheme:light dark}',
    'html[data-theme="dark"] ' + P + ' .spr-select{color-scheme:dark}',
    'html[data-theme="light"] ' + P + ' .spr-select{color-scheme:light}',
    P + ' .spr-select option{color:var(--spr-fg);background:var(--menu-background-color,var(--app-color-background-elevated-primary-opaque,Canvas))}',
    '@supports (appearance:base-select){',
    P + ' .spr-select,' + P + ' .spr-select::picker(select){appearance:base-select}',
    P + ' .spr-select::picker-icon{margin-inline-start:auto;color:var(--spr-fg3)}',
    P + ' .spr-select::picker(select){min-inline-size:116px;margin-block:4px;padding:3px;color:var(--spr-fg);background:var(--menu-background-color,var(--app-color-background-elevated-primary-opaque,Canvas));border:1px solid var(--spr-track);border-radius:var(--radius-sm,7px);box-shadow:var(--menu-box-shadow,0 6px 16px #0004);font:inherit}',
    P + ' .spr-select option{display:flex;min-height:24px;align-items:center;gap:5px;padding:3px 6px;border-radius:var(--radius-sm,7px);background:transparent}',
    P + ' .spr-select option:hover,' + P + ' .spr-select option:focus-visible{background:var(--spr-hover)}',
    P + ' .spr-select option::checkmark{order:1;margin-inline-start:auto;color:var(--spr-fg2)}',
    '}',
    P + ' .spr-hint + .spr-opt{margin-top:7px}',
    P + ' .spr-cfg{min-width:56px;display:flex;align-items:center;justify-content:flex-end}',
    P + ' .spr-num{display:inline-flex;border:0.5px solid var(--app-color-border, rgba(128,128,128,.2));border-radius:var(--radius-sm, 7px);overflow:hidden}',
    P + ' .spr-num button{all:unset;box-sizing:border-box;cursor:pointer;width:22px;height:24px;text-align:center;font-size:13px;line-height:24px;color:var(--spr-fg2)}',
    P + ' .spr-num button:hover{background:var(--spr-hover);color:var(--spr-fg)}',
    P + ' .spr-num input{all:unset;box-sizing:border-box;width:32px;height:24px;text-align:center;font-size:12px;color:var(--spr-fg);font-variant-numeric:tabular-nums;border-left:0.5px solid var(--app-color-border, rgba(128,128,128,.2));border-right:0.5px solid var(--app-color-border, rgba(128,128,128,.2))}',
    P + ' .spr-num :focus-visible{background:var(--spr-hover)}',
    P + ' .spr-link{all:unset;cursor:pointer;font-size:12px;color:var(--spr-fg2);border-radius:var(--radius-sm, 7px);padding:1px 4px;margin-left:-4px}',
    P + ' .spr-link:hover{background:var(--spr-hover);color:var(--spr-fg)}',
    P + ' .spr-link:disabled{opacity:.4;cursor:default;background:none}',
    P + ' .spr-pull-knob{fill:var(--app-color-accent-red,#e74f5c)}',
    P + ' .spr-pull[aria-disabled="true"]{opacity:.5;cursor:default;background:none}',
    // Drill-in rows (e.g. "View all" in the reset-credits section, one per credit).
    P + ' .spr-item{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;padding:3px 6px;margin:0 -6px;border-radius:var(--radius-sm, 7px);cursor:pointer;font-size:12px;color:var(--spr-fg2)}',
    P + ' .spr-item:hover{background:var(--spr-hover);color:var(--spr-fg)}',
    P + ' .spr-item:focus-visible{box-shadow:inset 0 0 0 1px var(--spr-fg3)}',
    P + ' .spr-item .spr-item-end{margin-left:auto;display:inline-flex;align-items:center;gap:6px;color:var(--spr-fg3);flex:none;font-variant-numeric:tabular-nums}',
    P + ' .spr-item .spr-item-end svg{flex:none}',
    P + ' .spr-crow{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:12px;color:var(--spr-fg2);margin-top:2px}',
    P + ' .spr-crow b{font-weight:500;color:var(--spr-fg)}',
    P + ' .spr-crow span{color:var(--spr-fg3);flex:none;font-variant-numeric:tabular-nums}',
    P + ' .spr-about{font-size:12px;line-height:1.6;color:var(--spr-fg3)}',
    P + ' .spr-about code{font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:11px;color:var(--spr-fg2);font-variant-ligatures:none}',
    '@media (prefers-reduced-motion:reduce){' + P + ',' + P + '.spr-closing,' + P + '.spr-swap > *{animation:none}' + P + '.spr-resizing{transition:none}' + P + ' .spr-icon[aria-busy="true"] svg{animation:none}#' + ID + ' .spr-end svg,' + P + ' .spr-sw,' + P + ' .spr-sw::after{transition:none}}'
  ].join('\n');

  // ---- layout discovery ---------------------------------------------------------------
  // The current shell marks its frame inside a display: contents wrapper.
  // Older shells use a direct child of #root, identified by class or geometry.
  const findLayouts = () => {
    const root = document.getElementById('root');
    if (!root) return [];
    const frames = [...root.querySelectorAll('[data-app-shell-frame]')];
    if (frames.length) return frames;
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
    const el = layout.querySelector('[class*="_PageSurface_"], [data-app-shell-workspace] > [class^="PageSurface-"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width >= innerWidth * 0.3 && r.height >= innerHeight * 0.5 ? el : null;
  };

  const findSidebar = layout => {
    const rail = layout.querySelector('nav[class~="group/sidebar-rail"]');
    const footer = rail?.querySelector(':scope > .shrink-0.w-9 > .flex.flex-col');
    if (!footer?.querySelector('button[aria-haspopup="menu"]')) return null;
    const r = rail.getBoundingClientRect();
    return r.width && r.height && r.right > 0 && r.left < innerWidth && getComputedStyle(rail).visibility === 'visible' ? footer : null;
  };

  let lastHtml = '';
  let lastPanelHtml = '';
  let trigger = null;
  let layouts = [];
  let card = null;
  let sidebar = null;
  let indicatorMotion = null;
  let panelOpen = false;
  let panelAnchor = null;
  let panelView = 'main';          // 'main' (information) | 'settings'
  let threshScope = null;          // Settings: null = follow the first window, else 'default' | '<windowDurationMins>'
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
  // Escape steps back one level: Settings/Reset credits → main view → closed.
  const pickerOpen = select => !!select && window.CSS?.supports('selector(select:open)') && select.matches(':open');
  const onEscape = ev => {
    if (ev.key !== 'Escape') return;
    if (pickerOpen(document.querySelector(P + ' .spr-select'))) return;
    ev.stopPropagation();
    if (panelView === 'settings') { setView('main', '[data-spr-settings]'); return; }
    if (panelView === 'credits') { setView('main', '[data-spr-credits]'); return; }
    setPanel(false);
    const bar = document.getElementById(ID); if (bar) bar.focus();
  };
  const onBlur = () => setPanel(false);

  const onPanelClick = ev => {
    const el = ev.target && ev.target.closest ? ev.target : null;
    if (!el) return;
    const placement = el.closest('[data-spr-position]');
    if (placement) {
      const next = placement.dataset.sprPosition === 'sidebar' ? 'sidebar' : 'bottom';
      if (position !== next) {
        pinSettingsPanel();
        position = next;
        try { localStorage.setItem(POSITION_KEY, position); } catch (err) {}
        apply();
      }
      return;
    }
    const mode = el.closest('[data-spr-mode]');
    if (mode) {
      const next = mode.dataset.sprMode === 'left' ? 'left' : 'used';
      if (st.mode !== next) {
        pinSettingsPanel();
        st.mode = next;
        writeMode(st.mode);
        render();
      }
      return;
    }
    if (el.closest('[data-spr-refresh]')) { requestRefresh(); return; }
    if (el.closest('[data-spr-pull]')) { replaySlots(); return; }
    if (el.closest('[data-spr-settings]')) { setView('settings', '[data-spr-mode].on'); return; }
    if (el.closest('[data-spr-credits]')) { setView('credits', '[data-spr-back]'); return; }
    if (el.closest('[data-spr-back]')) { setView('main', panelView === 'credits' ? '[data-spr-credits]' : '[data-spr-settings]'); return; }
    const scopeBtn = el.closest('[data-spr-scope]');
    if (scopeBtn) { threshScope = scopeBtn.getAttribute('data-spr-scope'); renderPanel(); return; }
    const step = el.closest('[data-spr-step]');
    if (step && !step.disabled) {
      const parts = step.getAttribute('data-spr-step').split(':');
      const level = parts[0], dir = Number(parts[1]) || 0;
      const scope = curScope();
      setThresh(scope, { [level]: threshValue(scope)[level] + dir });
      return;
    }
    if (el.closest('[data-spr-thresh-reset]')) { resetThresh(curScope()); return; }
    if (el.closest('[data-spr-notify-enable]')) { requestNotifyPermission(); return; }
    const sw = el.closest('[data-spr-switch]');
    if (sw) {
      const key = sw.getAttribute('data-spr-switch');
      const on = sw.getAttribute('aria-checked') !== 'true';
      if (key === 'pace') {
        pinSettingsPanel();
        setPace(on);
      }
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

  // The one place that asks for notification permission: an explicit click in Settings.
  // Never on load, never on a timer — a surprise OS dialog is worse than a silent bar, and
  // the reset is announced in the bar without any permission at all. The panel is reopened
  // afterwards because the system prompt can blur the window and close it.
  const requestNotifyPermission = () => {
    const done = () => { try { setPanel(true, 'settings'); } catch (err) {} renderPanel(); };
    try {
      if (typeof Notification !== 'function' || typeof Notification.requestPermission !== 'function') { done(); return; }
      if (Notification.permission !== 'default') { done(); return; }
      const res = Notification.requestPermission(() => done());
      if (res && typeof res.then === 'function') res.then(done, done);
    } catch (err) { done(); }
  };

  // ---- color thresholds (Settings) -------------------------------------------------------
  const curScope = () => threshScope || 'default';
  const threshValue = scope => scope === 'default' ? threshes.d : threshFor({ windowDurationMins: Number(scope) });
  const writeThreshes = () => {
    const w = {};
    for (const k of Object.keys(threshes.w)) if (!isDefaultThresh(threshes.w[k])) w[k] = threshes.w[k];
    writeJSON(THRESH_KEY, { d: threshes.d, w });
  };
  // Set one level of one scope. `settle()` keeps the values ordered red < orange < yellow
  // and inside their ranges, so what is stored is what the bar uses and what the fields
  // show. A global change drops any window override that now equals the defaults.
  const settle = (t, level) => {
    if (level !== 'crit') { t.crit = Math.min(t.crit, t.low - 1); }
    if (level === 'mid') { t.low = Math.min(t.low, t.mid - 1); }
    t.crit = clamp(t.crit, THRESH_LIMITS.crit[0], THRESH_LIMITS.crit[1]);
    t.low = clamp(t.low, Math.max(THRESH_LIMITS.low[0], t.crit + 1), THRESH_LIMITS.low[1]);
    t.mid = clamp(t.mid, Math.max(THRESH_LIMITS.mid[0], t.low + 1), THRESH_LIMITS.mid[1]);
    return t;
  };
  const setThresh = (scope, partial) => {
    const level = ['crit', 'low', 'mid'].filter(k => partial && partial[k] != null && Number.isFinite(Number(partial[k])));
    if (!level.length) return;
    const base = scope === 'default' ? Object.assign({}, threshes.d) : Object.assign({}, threshFor({ windowDurationMins: Number(scope) }));
    for (const k of level) base[k] = clamp(Math.round(Number(partial[k])), THRESH_LIMITS[k][0], THRESH_LIMITS[k][1]);
    const t = settle(base, level.length === 1 ? level[0] : null);
    if (scope === 'default') {
      threshes.d = t;
      for (const k of Object.keys(threshes.w)) if (isDefaultThresh(threshes.w[k])) delete threshes.w[k];
    } else if (isDefaultThresh(t)) {
      delete threshes.w[scope];
    } else {
      threshes.w[scope] = t;
    }
    writeThreshes();
    render();
  };
  const resetThresh = scope => {
    if (scope === 'default') { threshes = { d: Object.assign({}, THRESH_DEFAULTS), w: {} }; }
    else delete threshes.w[scope];
    writeThreshes();
    render();
  };

  // Switches the open panel between its views; the panel is anchored by its bottom
  // edge, so a taller or shorter view grows/shrinks upward without a jump.
  const motionPreference = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reducedMotion = () => !!motionPreference?.matches;

  // Height tween between views: freeze the old height, swap the content, then
  // transition to the new natural height (bottom-anchored, so the top edge moves).
  let resizeTimer = 0;
  const animateSwap = (p, from) => {
    clearTimeout(resizeTimer);
    p.classList.remove('spr-resizing', 'spr-swap');
    p.style.height = '';
    const to = p.offsetHeight;
    if (reducedMotion() || !from || from === to) return;
    p.style.height = from + 'px';
    void p.offsetHeight;                       // commit the start height before transitioning
    p.classList.add('spr-resizing', 'spr-swap');
    p.style.height = to + 'px';
    resizeTimer = setTimeout(() => { p.classList.remove('spr-resizing', 'spr-swap'); p.style.height = ''; }, 260);
  };

  function setView(view, focusSel) {
    if (!panelOpen) return;
    const next = view === 'settings' ? 'settings' : view === 'credits' ? 'credits' : 'main';
    const cur = document.getElementById(PANEL_ID);
    const from = cur ? cur.offsetHeight : 0;
    const changed = next !== panelView;
    panelView = next;
    renderPanel();
    const p = document.getElementById(PANEL_ID);
    if (p && changed) animateSwap(p, from);
    const target = p && focusSel ? p.querySelector(focusSel) : null;
    if (target) target.focus();
    if (p) p.scrollTop = 0;
  }

  function setPanel(open, view) {
    open = !!open && indicatorMotion?.kind !== 'remove' && !!document.getElementById(ID);
    if (open && panelOpen) { setView(view); return; }
    if (open === panelOpen) return;
    panelOpen = open;
    panelAnchor = null;
    panelView = open && (view === 'settings' || view === 'credits') ? view : 'main';   // opening starts on the main view
    if (open) threshScope = null;                                    // threshold scope resets with the panel
    const bar = document.getElementById(ID);
    if (bar) bar.setAttribute('aria-expanded', String(open));
    if (open) {
      document.addEventListener('pointerdown', onDocPointer, true);
      // The app can stop Escape before it reaches document-level listeners.
      addEventListener('keydown', onEscape, true);
      addEventListener('blur', onBlur);
      panelTick = setInterval(() => { render(); }, 10000);
      renderPanel();
      try { window.__sprBarRefreshBinding?.('panel'); } catch {}
    } else {
      document.removeEventListener('pointerdown', onDocPointer, true);
      removeEventListener('keydown', onEscape, true);
      removeEventListener('blur', onBlur);
      clearInterval(panelTick); panelTick = 0;
      const p = document.getElementById(PANEL_ID);
      if (p) {
        clearTimeout(resizeTimer);
        if (reducedMotion()) p.remove();
        else {
          p.classList.add('spr-closing');      // ensurePanel drops it if the panel reopens meanwhile
          const gone = () => p.remove();
          p.addEventListener('animationend', gone, { once: true });
          setTimeout(gone, 250);               // no animationend (hidden tab, reduced motion race)
        }
      }
      lastPanelHtml = '';
    }
  }

  const ensurePanel = () => {
    let p = document.getElementById(PANEL_ID);
    if (p && p.classList.contains('spr-closing')) { p.remove(); p = null; }   // reopened mid-close
    if (!p) {
      p = document.createElement('div');
      p.id = PANEL_ID;
      p.setAttribute('role', 'dialog');
      p.setAttribute('aria-label', 'Codex usage limits');
      p.addEventListener('click', onPanelClick);
      p.addEventListener('input', onPanelInput);
      p.addEventListener('change', onPanelInput);
      p.addEventListener('keydown', onPanelKey);
      (document.body || document.documentElement).appendChild(p);
      lastPanelHtml = '';
    }
    return p;
  };
  // Threshold value fields: `input` for live typing, `change`/blur for the commit of
  // values the browser did not fire an `input` for (autofill, spinners are ours anyway).
  const onPanelInput = ev => {
    const t = ev.target;
    if (t?.hasAttribute?.('data-spr-sidebar-style')) {
      if (ev.type === 'change' && validSidebarStyle(t.value) && t.value !== sidebarStyle) {
        pinSettingsPanel();
        sidebarStyle = t.value;
        try { localStorage.setItem(SIDEBAR_STYLE_KEY, sidebarStyle); } catch (err) {}
        apply();
      }
      return;
    }
    if (!t || !t.hasAttribute || !t.hasAttribute('data-spr-value')) return;
    commitThreshField(t);
  };
  const onPanelKey = ev => {
    const t = ev.target;
    if (ev.key !== 'Enter' || !t || !t.hasAttribute || !t.hasAttribute('data-spr-value')) return;
    ev.preventDefault();
    commitThreshField(t);
    if (t.blur) t.blur();
  };
  // Commits the field's value, clamps it, and writes the clamped number back into the
  // field (the panel is re-rendered only when the value actually changes, so typing a
  // two-digit number is not interrupted).
  const commitThreshField = input => {
    const level = input.getAttribute('data-spr-value'), scope = curScope();
    const raw = Number(String(input.value).replace(/[^0-9]/g, ''));
    const cur = threshValue(scope)[level];
    const v = Number.isFinite(raw) && String(input.value).trim() !== '' ? clamp(raw, THRESH_LIMITS[level][0], THRESH_LIMITS[level][1]) : cur;
    if (String(input.value) !== String(v)) input.value = String(v);
    if (v !== cur) setThresh(scope, { [level]: v });
  };

  const pinSettingsPanel = () => {
    if (!panelOpen || panelView !== 'settings' || panelAnchor !== null) return;
    const p = document.getElementById(PANEL_ID);
    if (p) panelAnchor = p.offsetLeft;
  };

  // Both placements share the same bottom edge. Display changes keep the
  // horizontal position of the open panel until it closes.
  const placePanel = () => {
    const p = document.getElementById(PANEL_ID), bar = document.getElementById(ID);
    if (!p || !bar) return;
    const w = p.offsetWidth || 320;
    const r = bar.getBoundingClientRect();
    const toRight = sidebar && r.right + 8 + w + 12 <= innerWidth;
    const preferredLeft = panelAnchor ?? Math.round(toRight ? r.right + 8 : r.left);
    const left = clamp(preferredLeft, 12, Math.max(12, innerWidth - w - 12)) + 'px';
    const bottomPx = H + 6;
    const bottom = bottomPx + 'px';
    const maxH = Math.max(0, innerHeight - bottomPx - 12) + 'px';
    if (p.style.left !== left) p.style.left = left;
    if (p.style.bottom !== bottom) p.style.bottom = bottom;
    if (p.style.maxHeight !== maxH) p.style.maxHeight = maxH;
  };

  // ---- rendering ----------------------------------------------------------------------
  const ensureBar = host => {
    // The app may temporarily detach and later restore the same sidebar subtree.
    let d = trigger || document.getElementById(ID);
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
      lastHtml = '';
    }
    if (host) {
      if (host.firstElementChild !== d) host.prepend(d);
    } else if (d.parentElement !== document.body) {
      document.body.appendChild(d);
    }
    trigger = d;
    return d;
  };

  const usage = l => {
    const used = clamp(Number(l.usedPercent) || 0, 0, 100);
    const remaining = 100 - used;
    return {
      lvl: levelFor(remaining, threshFor(l)),
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

  const sidebarBars = (meters, horizontal) => {
    const axis = horizontal ? 'width' : 'height';
    const edge = horizontal ? 'left' : 'bottom';
    return meters.map(u => '<span class="spr-track spr-' + u.lvl + (u.weekly ? ' spr-weekly-track' : '') + '" aria-hidden="true">'
      + '<span class="spr-fill" style="' + axis + ':' + u.fill + '%"></span>'
      + (u.mark == null ? '' : '<span class="spr-tick" style="' + edge + ':' + u.mark + '%"></span>') + '</span>').join('');
  };

  const sidebarRings = meters => {
    const single = meters.length === 1;
    const weight = single ? 3.5 : 2.6;
    return '<svg class="spr-rings" viewBox="0 0 32 32" aria-hidden="true">'
      + meters.map((u, index) => {
        const inner = !single && index === 0;
        const r = single ? 10.5 : inner ? 7 : 12;
        const circle = '<circle cx="16" cy="16" r="' + r + '" stroke-width="' + weight + '"';
        const y = 16 - r;
        const tick = weight / 2 + .8;
        // Give the short inner tick room toward the center without reaching the outer arc.
        const line = ' x1="16" x2="16" y1="' + (y - (inner ? 1.5 : tick)) + '" y2="' + (y + (inner ? 4 : tick))
          + '" transform="rotate(' + (u.mark * 3.6) + ' 16 16)"/>';
        return circle + ' class="spr-ring-track"/>'
          + (u.fill > 0 ? circle + ' class="spr-ring-fill" style="stroke:var(--spr-' + u.lvl + '-fill)" pathLength="100" stroke-dasharray="'
            + u.fill + ' 100" stroke-linecap="round" transform="rotate(-90 16 16)"/>' : '')
          + (u.mark == null ? '' : (inner ? '<line class="spr-ring-mark-halo"' + line : '')
            + '<line class="spr-ring-mark' + (inner ? ' spr-ring-mark-inner' : '') + '"' + line);
      }).join('') + '</svg>';
  };

  const slotSpecial = () => st.mode === 'left' ? '⭐' : '💀';
  const slotFaces = value => value === 100 ? [slotSpecial(), slotSpecial()]
    : [...String(Math.min(99, Math.round(value))).padStart(2, '0')];
  const slotEmoji = face => face === '⭐' || face === '💀';

  const sidebarSlots = meters => '<span class="spr-slot-case" aria-hidden="true">'
    + meters.map(u => '<span class="spr-slot-row" style="color:var(--spr-' + u.lvl + '-fill)">'
      + slotFaces(u.fill).map(face => '<span class="spr-slot-reel" data-spr-face="' + face + '"><span class="spr-slot-strip">'
        + (slotEmoji(face) ? '<span class="spr-slot-emoji">' : '<span>') + face + '</span></span></span>').join('') + '</span>').join('')
    + '<span class="spr-slot-percent">%</span></span>'
    + '<span class="spr-slot-lever" aria-hidden="true"><span class="spr-slot-arm"></span><span class="spr-slot-knob"></span></span>';

  let slotMotion = null;
  const shownSlotFaces = bar => [...bar.querySelectorAll('[data-spr-face]')].map(reel => reel.dataset.sprFace);
  const canAnimateSlots = bar => !!bar?.isConnected && !reducedMotion() && !document.hidden && typeof bar.animate === 'function';
  const canReplaySlots = () => sidebar && trigger?.dataset.sprSidebarStyle === 'slots' &&
    hasData() && !slotMotion && canAnimateSlots(trigger);
  const syncPullButton = () => {
    const button = document.querySelector(P + ' [data-spr-pull]');
    if (button) {
      button.setAttribute('aria-disabled', String(!canReplaySlots()));
      button.title = reducedMotion() ? 'Reduce Motion is enabled' : 'Pull lever';
    }
  };
  const replaySlots = () => {
    if (!canReplaySlots()) return;
    const faces = shownSlotFaces(trigger);
    if (faces.length) spinSlots(trigger, faces);
  };
  const stopSlots = () => {
    if (!slotMotion) return;
    const { animations, restore } = slotMotion;
    slotMotion = null;
    for (const animation of animations) animation.cancel();
    for (const finish of restore) finish();
    syncPullButton();
  };
  const onMotionContext = () => {
    if (!document.hidden && !reducedMotion()) { syncPullButton(); return; }
    stopSlots();
    syncPullButton();
    const kind = indicatorMotion?.kind;
    cancelIndicatorMotion();
    if (kind === 'move') apply(true);
    if (kind === 'remove') remove();
  };

  const spinSlots = (bar, from) => {
    if (!canAnimateSlots(bar)) return;
    const motion = { animations: [], restore: [] };
    slotMotion = motion;
    syncPullButton();
    const finished = [];
    const animate = (el, frames, options) => {
      const animation = el.animate(frames, options);
      motion.animations.push(animation);
      finished.push(animation.finished.catch(() => {}));
    };
    try {
      const pull = { duration: 370, easing: 'ease-in-out' };
      animate(bar.querySelector('.spr-slot-arm'), [
        { transform: 'scaleY(1)' }, { transform: 'scaleY(0)', offset: .24 },
        { transform: 'scaleY(-.46)', offset: .38 }, { transform: 'scaleY(-.46)', offset: .48 },
        { transform: 'scaleY(0)', offset: .68 }, { transform: 'scaleY(1.1)', offset: .91 },
        { transform: 'scaleY(1)' }
      ], pull);
      animate(bar.querySelector('.spr-slot-knob'), [
        { transform: 'translate(-50%, 0) scale(1)' },
        { transform: 'translate(-50%, 12px) scale(1.22)', offset: .24 },
        { transform: 'translate(-50%, 18px) scale(1)', offset: .38 },
        { transform: 'translate(-50%, 18px) scale(1)', offset: .48 },
        { transform: 'translate(-50%, 12px) scale(1.22)', offset: .68 },
        { transform: 'translate(-50%, -1.2px) scale(1)', offset: .91 },
        { transform: 'translate(-50%, 0) scale(1)' }
      ], pull);
      [...bar.querySelectorAll('.spr-slot-strip')].forEach((strip, i) => {
        const final = strip.firstElementChild;
        const digits = Array.from({ length: 12 }, (_, step) => {
          const value = (step + i * 3) % 11;
          return value === 10 ? slotSpecial() : String(value);
        });
        const rolling = [from[i], ...digits].map(face => {
          const cell = document.createElement('span');
          cell.textContent = face;
          if (slotEmoji(face)) cell.className = 'spr-slot-emoji';
          return cell;
        });
        const h = strip.parentElement.clientHeight;
        const offset = rolling.length * h;
        motion.restore.push(() => strip.replaceChildren(final));
        strip.replaceChildren(...rolling, final);
        animate(strip, [
          { transform: 'translateY(0)', easing: 'cubic-bezier(.32,.44,.22,1)' },
          { transform: 'translateY(-' + (offset + h * .21) + 'px)', offset: .89, easing: 'ease-out' },
          { transform: 'translateY(-' + offset + 'px)' }
        ], { delay: 240, duration: 500 + (i % 2) * 85 + Math.floor(i / 2) * 155, fill: 'forwards' });
      });
    } catch (err) {
      stopSlots();
    }
    Promise.all(finished).then(() => {
      if (slotMotion === motion) stopSlots();
    });
  };

  const sidebarWindowMins = l => l.windowDurationMins || (l.name === 'Weekly' ? WEEKLY_MINS : 0);
  const renderSidebar = (bar, event, spin) => {
    const limits = hasData() ? st.limits.slice().sort((a, b) => sidebarWindowMins(a) - sidebarWindowMins(b)) : [];
    const lines = [];
    // The current protocol supplies at most two windows. Keep all windows visible
    // in the bar if another caller supplies more.
    const style = limits.length > 2 && (sidebarStyle === 'rings' || sidebarStyle === 'slots') ? 'vertical' : sidebarStyle;
    const meters = limits.map(l => {
      const u = usage(l), pc = pace && paceFor(l);
      const value = style === 'slots' && u.fill < 100 ? Math.min(99.99, Number(u.fill.toFixed(2))) : u.shown;
      lines.push(titleFor(l) + ': ' + value + '% ' + u.word + (u.left ? ' · resets in ' + u.left : ''));
      return { ...u, mark: pc ? markPos(pc) : null, weekly: sidebarWindowMins(l) === WEEKLY_MINS };
    });
    const from = style === 'slots' && spin ? shownSlotFaces(bar) : [];
    const count = String(meters.length);
    const shapeChanged = bar.dataset.sprSidebarStyle &&
      (bar.dataset.sprSidebarStyle !== style || bar.dataset.sprSidebarCount !== count);
    let before;
    if (shapeChanged && indicatorMotion?.kind !== 'move') {
      const css = getComputedStyle(bar);
      before = {
        height: css.height, opacity: css.opacity, marginBottom: css.marginBottom,
        target: css.getPropertyValue('--spr-sidebar-height')
      };
    }
    bar.dataset.sprSidebarStyle = style;
    bar.dataset.sprSidebarCount = count;
    let html = '';
    if (!limits.length) {
      html = statusDot();
      lines.push(st.meta?.error ? 'Limits unavailable' : 'Waiting for data');
    } else {
      if (style === 'slots') html = sidebarSlots(meters);
      else if (style === 'rings') html = sidebarRings(meters);
      else html = sidebarBars(meters, style === 'horizontal');
    }
    if (event) lines.push(event.chip || event.text);
    if (html !== lastHtml) { stopSlots(); bar.innerHTML = html; lastHtml = html; }
    // A weekly-reset dot can arrive just after a live push. Updating the dot
    // independently lets the reels finish the spin that reveals the reset.
    const stale = isStale();
    const previousStatus = bar.querySelector('.spr-sidebar-status');
    if (meters.length && (stale || event)) {
      const status = previousStatus || document.createElement('span');
      status.className = 'spr-sidebar-status';
      status.setAttribute('aria-hidden', 'true');
      const dot = statusDot();
      if (status.innerHTML !== dot) status.innerHTML = dot;
      if (!previousStatus) bar.appendChild(status);
      if (stale) lines.push('Data is stale');
    } else previousStatus?.remove();
    if (stale) stopSlots();
    else if (from.length && from.length === meters.length * 2) {
      const next = meters.flatMap(u => slotFaces(u.fill));
      if (spin === 'manual' || next.some((face, index) => face !== from[index])) {
        stopSlots();
        spinSlots(bar, from);
      }
    }
    if (before && before.target !== getComputedStyle(bar).getPropertyValue('--spr-sidebar-height')) {
      animateIndicator(bar, 'resize', { fromStyle: before, done: () => apply(true) });
    }
    const title = lines.join('\n');
    if (bar.title !== title) bar.title = title;
    const label = 'Codex usage limits, ' + lines.join(', ') + ', open details';
    if (bar.getAttribute('aria-label') !== label) bar.setAttribute('aria-label', label);
  };

  const renderBar = spin => {
    const bar = document.getElementById(ID);
    if (!bar) return;
    const ev = st.event && st.event.chipUntilMs && Date.now() < st.event.chipUntilMs ? st.event : null;
    if (sidebar) { renderSidebar(bar, ev, spin); return; }
    stopSlots();
    delete bar.dataset.sprSidebarStyle;
    delete bar.dataset.sprSidebarCount;
    if (bar.hasAttribute('title')) bar.removeAttribute('title');
    let html = ev
      ? '<span class="spr-event">' + esc(ev.chip || ev.text) + '</span>'
      : '<span class="spr-label">Limits</span>';
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

  // One threshold row per level, each with a −/+ stepper: the row is a single
  // labelled control, the number itself is editable for exact values.
  const threshOptHTML = (level, label, value, disabled) => {
    const l = esc(label);
    return '<div class="spr-opt"><span>' + l + '</span>'
      + '<span class="spr-cfg"><span class="spr-num">'
      + '<button type="button" data-spr-step="' + level + ':-1" aria-label="Decrease ' + l + '"' + (disabled || value <= THRESH_LIMITS[level][0] ? ' disabled' : '') + '>−</button>'
      + '<input type="text" inputmode="numeric" data-spr-value="' + level + '" value="' + value + '" aria-label="' + l + ' percent">'
      + '<button type="button" data-spr-step="' + level + ':1" aria-label="Increase ' + l + '"' + (disabled || value >= THRESH_LIMITS[level][1] ? ' disabled' : '') + '>+</button>'
      + '</span></span></div>';
  };

  const panelHTML = () => {
    const m = st.meta || {};
    const data = hasData();
    let h = '<div class="spr-sec"><div class="spr-head"><span class="spr-title">Codex</span>';
    if (m.planType) h += '<span class="spr-badge">' + esc(m.planType) + '</span>';
    h += '<span class="spr-actions">';
    if (sidebar && trigger?.dataset.sprSidebarStyle === 'slots') {
      h += '<button class="spr-icon spr-pull" type="button" data-spr-pull aria-label="Pull lever">' + LEVER + '</button>';
    }
    if (canRefresh()) {
      h += '<button class="spr-icon" type="button" data-spr-refresh aria-label="Refresh limits"'
        + (refreshing ? ' aria-busy="true"' : '') + '>' + REFRESH + '</button>';
    }
    h += '<button class="spr-icon" type="button" data-spr-settings aria-label="LimitBar settings">' + GEAR + '</button></span>';
    h += '</div><div class="spr-sub">';
    if (m.updatedAtMs) {
      h += statusDot() + '<span>'
        + (isStale() ? 'Stale · updated ' : 'Updated ') + fmtAgo(Date.now() - m.updatedAtMs) + '</span>';
    } else {
      h += statusDot() + '<span>' + (m.error ? 'Limits unavailable' : 'Waiting for the first read…') + '</span>';
    }
    h += '</div></div>';

    // The last announced reset stays here for a day; the chip in the bar is transient.
    if (st.event && Date.now() - st.event.atMs < EVENT_VISIBLE_MS) {
      h += '<div class="spr-hr"></div><div class="spr-sec"><div class="spr-row spr-event-row">'
        + '<span class="spr-ok">' + esc(st.event.text) + '</span><span class="spr-when">'
        + whenLabel(st.event.resetAtMs || st.event.atMs) + '</span></div></div>';
    }

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
      if (creditsList().length) {
        h += '<button type="button" class="spr-item" data-spr-credits aria-label="View every reset credit">'
          + '<span>View all</span><span class="spr-item-end">' + creditsList().length + RIGHT + '</span></button>';
      }
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

    return h;
  };

  // Reset-credits view: one row per available credit, soonest expiry first. Reached from
  // the main view's "View all" row; ← / Escape return to main.
  const creditsHTML = () => {
    const now = Date.now();
    const list = creditsList();
    let h = '<div class="spr-sec"><div class="spr-head">'
      + '<button class="spr-icon spr-back" type="button" data-spr-back aria-label="Back">' + BACK + '</button>'
      + '<span class="spr-title">Reset credits</span>'
      + '<span class="spr-badge">' + list.length + '</span></div></div>';

    h += '<div class="spr-hr"></div><div class="spr-sec">';
    if (!list.length) {
      h += '<div class="spr-muted">No reset credits available.</div>';
    } else {
      list.forEach((c, i) => {
        h += '<div class="spr-crow"><b>' + esc(c.title || 'Reset credit') + '</b>'
          + '<span>' + (c.expiresAtMs > now ? 'in ' + fmtLeft(c.expiresAtMs - now) + ' · ' : 'expired · ') + fmtDate(c.expiresAtMs) + '</span></div>';
      });
    }
    h += '</div>';

    h += '<div class="spr-hr"></div><div class="spr-sec"><div class="spr-hint">'
      + 'Spending a credit happens in ChatGPT itself — this view only lists them.</div></div>';
    return h;
  };

  // Settings view: display options, color thresholds, notification switches, about.
  const settingsHTML = () => {
    let h = '<div class="spr-sec"><div class="spr-head">'
      + '<button class="spr-icon spr-back" type="button" data-spr-back aria-label="Back">' + BACK + '</button>'
      + '<span class="spr-title">Settings</span></div></div>';

    h += '<div class="spr-hr"></div><div class="spr-sec"><div class="spr-h">Display</div>'
      + '<div class="spr-opt spr-opt-seg"><span>Position</span>'
      + '<span class="spr-toggle" role="group" aria-label="Indicator position">'
      + '<button type="button" data-spr-position="bottom">Bottom</button>'
      + '<button type="button" data-spr-position="sidebar">Sidebar</button>'
      + '</span></div>'
      + '<div class="spr-position-style" inert aria-hidden="true"><div class="spr-position-style-clip">'
      + '<label class="spr-opt"><span>Sidebar style</span><select class="spr-select" data-spr-sidebar-style>'
      + SIDEBAR_STYLES.map(([key, label]) => '<option value="' + key + '">' + label + '</option>').join('')
      + '</select></label></div></div>'
      + '<div class="spr-opt spr-opt-seg"><span>Show</span>'
      + '<span class="spr-toggle" role="group" aria-label="Show used or left">'
      + '<button type="button" data-spr-mode="used" class="' + (st.mode === 'used' ? 'on' : '') + '" aria-pressed="' + (st.mode === 'used') + '">used</button>'
      + '<button type="button" data-spr-mode="left" class="' + (st.mode === 'left' ? 'on' : '') + '" aria-pressed="' + (st.mode === 'left') + '">left</button>'
      + '</span></div>'
      + switchHTML('pace', 'Pace marker', pace) + '</div>';

    // Color thresholds: the scope selector picks the global defaults or one window;
    // values are % remaining. The global row is the fallback for windows without an override.
    const scope = threshScope || 'default';
    const scoped = scope !== 'default';
    const tv = scoped ? threshFor({ windowDurationMins: Number(scope) }) : threshes.d;
    h += '<div class="spr-hr"></div><div class="spr-sec"><div class="spr-h">Color thresholds</div>'
      + '<div class="spr-opt spr-opt-seg"><span>Apply to</span>'
      + '<span class="spr-toggle" role="group" aria-label="Threshold scope">'
      + '<button type="button" data-spr-scope="default" class="' + (!scoped ? 'on' : '') + '" aria-pressed="' + (!scoped) + '">All</button>'
      + (hasData() ? st.limits.map(l => '<button type="button" data-spr-scope="' + esc(scopeOf(l)) + '" class="' + (scoped && scope === scopeOf(l) ? 'on' : '') + '" aria-pressed="' + (scoped && scope === scopeOf(l)) + '">' + esc(titleFor(l)) + '</button>').join('') : '')
      + '</span></div>'
      + THRESH_ROWS.map(([level, label]) => threshOptHTML(level, label, tv[level], false)).join('')
      + '<div class="spr-hint">% remaining. '
      + (scoped
        ? 'Applies to the ' + esc(titleFor({ windowDurationMins: Number(scope), name: scope })) + ' window only.'
        : 'Applies to every window unless a window overrides it.')
      + '</div>'
      + '<div class="spr-opt"><button type="button" class="spr-link" data-spr-thresh-reset'
      + ((scoped ? !threshes.w[scope] : (isDefaultThresh(threshes.d) && !Object.keys(threshes.w).length)) ? ' disabled' : '') + '>Reset to defaults</button></div>'
      + '</div>';

    h += '<div class="spr-hr"></div><div class="spr-sec"><div class="spr-h">Notify me</div>'
      + switchHTML('notify:reset', 'When the weekly limit resets', notifySettings.reset)
      + switchHTML('notify:credit', 'Reset credit expires within 24 h', notifySettings.credit)
      + switchHTML('notify:low25', 'Less than 25% left', notifySettings.low25)
      + switchHTML('notify:low10', 'Less than 10% left', notifySettings.low10);
    if (!canNotify()) {
      const perm = notifyPermission();
      if (perm === 'default') {
        h += '<div class="spr-opt"><span>System notifications</span>'
          + '<button type="button" class="spr-link" data-spr-notify-enable>Enable…</button></div>'
          + '<div class="spr-hint">Asks macOS once, from this button only. The reset is announced in the bar either way.</div>';
      } else if (perm === 'denied') {
        h += '<div class="spr-hint">Blocked for ChatGPT in System Settings → Notifications. The reset is announced in the bar either way.</div>';
      } else {
        h += '<div class="spr-hint">This page cannot show system notifications. The reset is announced in the bar either way.</div>';
      }
    } else {
      h += '<div class="spr-hint">System notifications are allowed.</div>';
    }
    h += '</div>';

    h += '<div class="spr-hr"></div><div class="spr-sec"><div class="spr-h">About</div><div class="spr-about">'
      + '<div>LimitBar v' + BAR_VERSION + '</div>'
      + '<div>Source: ' + (st.meta?.source === 'native' ? 'ChatGPT window' : 'ChatGPT app-server') + '</div>'
      + '<div>Automatic updates · 5 min fallback</div>'
      + '<div>Diagnostics: <code>./start.sh --doctor</code></div>'
      + '</div></div>';
    return h;
  };

  function renderPanel() {
    if (!panelOpen) return;
    const p = ensurePanel();
    const html = panelView === 'settings' ? settingsHTML() : panelView === 'credits' ? creditsHTML() : panelHTML();
    const label = panelView === 'settings' ? 'LimitBar settings' : panelView === 'credits' ? 'LimitBar reset credits' : 'Codex usage limits';
    let from = 0;
    if (p.getAttribute('aria-label') !== label) p.setAttribute('aria-label', label);
    if (html !== lastPanelHtml) {
      if (panelView === 'settings' && panelAnchor !== null) from = p.offsetHeight;
      // Keep keyboard focus on the same control across a re-render.
      const a = document.activeElement;
      const sel = a && p.contains(a)
        ? (a.hasAttribute('data-spr-refresh') ? '[data-spr-refresh]'
          : a.hasAttribute('data-spr-pull') ? '[data-spr-pull]'
          : a.hasAttribute('data-spr-settings') ? '[data-spr-settings]'
          : a.hasAttribute('data-spr-credits') ? '[data-spr-credits]'
          : a.hasAttribute('data-spr-back') ? '[data-spr-back]'
          : a.hasAttribute('data-spr-position') ? '[data-spr-position="' + a.dataset.sprPosition + '"]'
          : a.hasAttribute('data-spr-sidebar-style') ? 'select[data-spr-sidebar-style]'
          : a.hasAttribute('data-spr-mode') ? '[data-spr-mode="' + a.getAttribute('data-spr-mode') + '"]'
          : a.hasAttribute('data-spr-switch') ? '[data-spr-switch="' + a.getAttribute('data-spr-switch') + '"]' : null)
        : null;
      p.innerHTML = html;
      lastPanelHtml = html;
      if (sel) { const again = p.querySelector(sel); if (again) again.focus(); }
    }
    // Updating the value without rebuilding the native picker keeps its focus.
    let picker = p.querySelector('select[data-spr-sidebar-style]');
    if (picker) {
      const visible = position === 'sidebar';
      const row = picker.closest('.spr-position-style');
      for (const button of p.querySelectorAll('[data-spr-position]')) {
        const selected = button.dataset.sprPosition === position;
        button.classList.toggle('on', selected);
        button.setAttribute('aria-pressed', String(selected));
      }
      if (!visible) {
        const open = pickerOpen(picker);
        const moveFocus = open || row.contains(document.activeElement);
        if (open) {
          // Detaching the select dismisses its native top-layer picker.
          const closed = picker.cloneNode(true);
          picker.replaceWith(closed);
          picker = closed;
        }
        if (moveFocus) p.querySelector('[data-spr-position="bottom"]').focus({ preventScroll: true });
      }
      row.inert = !visible;
      row.setAttribute('aria-hidden', String(!visible));
      row.toggleAttribute('data-spr-expanded', visible);
      if (picker.value !== sidebarStyle) picker.value = sidebarStyle;
    }
    syncPullButton();
    placePanel();
    if (from) animateSwap(p, from);
  }

  const render = spin => {
    if (indicatorMotion?.kind !== 'remove') { renderBar(spin); renderPanel(); }
  };

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
    bar.classList.toggle('spr-sidebar', !!sidebar);
    const flat = !sidebar && !card;
    if (bar.classList.contains('spr-flat') !== flat) bar.classList.toggle('spr-flat', flat);
    let left = '0px', right = '0px';
    if (!sidebar && card) {
      const r = card.getBoundingClientRect();
      left = Math.max(0, Math.round(r.left)) + 'px';
      right = Math.max(0, Math.round(innerWidth - r.right)) + 'px';
    }
    if (bar.style.left !== left) bar.style.left = left;
    if (bar.style.right !== right) bar.style.right = right;
  };

  const cancelIndicatorMotion = () => {
    const motion = indicatorMotion;
    indicatorMotion = null;
    if (motion) for (const animation of motion.animations) animation.cancel();
  };

  const measurePadding = elements => elements.map(el => ({
    el, from: parseFloat(getComputedStyle(el).paddingBottom) || 0
  }));
  const originalPadding = el => {
    const inline = el.style.paddingBottom;
    el.style.paddingBottom = el.dataset.sprOrigPad || '';
    const value = parseFloat(getComputedStyle(el).paddingBottom) || 0;
    el.style.paddingBottom = inline;
    return value;
  };

  const animateIndicator = (bar, kind, { host = null, done, padding = [], fromStyle } = {}) => {
    if (reducedMotion() || document.hidden || typeof bar.animate !== 'function') return null;
    const entering = kind === 'enter';
    const showing = entering || kind === 'resize';
    const style = fromStyle || getComputedStyle(bar);
    const from = { opacity: entering ? 0 : Number(style.opacity) };
    const to = { opacity: showing ? 1 : 0 };
    if (sidebar) {
      const gap = parseFloat(getComputedStyle(sidebar).rowGap) || 0;
      from.height = entering ? '0px' : style.height;
      from.marginBottom = entering ? -gap + 'px' : style.marginBottom;
      to.height = showing ? getComputedStyle(bar).getPropertyValue('--spr-sidebar-height').trim() : '0px';
      to.marginBottom = showing ? '0px' : -gap + 'px';
    } else if (!showing) {
      padding = measurePadding(layouts.filter(el => el.isConnected && el.dataset.sprPadded));
    }
    cancelIndicatorMotion();
    const pads = padding.map(p => ({ ...p, to: showing ? H : originalPadding(p.el) }));
    if (!sidebar) {
      // Match the bar's slide to the space reserved by the content layout.
      const shift = edge => Math.max(0, H - Math.min(H, ...pads.map(p => p[edge])));
      from.transform = 'translateY(' + shift('from') + 'px)';
      to.transform = 'translateY(' + shift('to') + 'px)';
    }
    const options = { duration: showing ? 220 : 180, easing: 'ease-in-out', fill: 'both' };
    const motion = { kind, host, animations: [] };
    indicatorMotion = motion;
    const finished = [];
    const play = (el, frames) => {
      const animation = el.animate(frames, options);
      motion.animations.push(animation);
      finished.push(animation.finished.catch(() => {}));
    };
    try {
      for (const p of pads) play(p.el, [{ paddingBottom: p.from + 'px' }, { paddingBottom: p.to + 'px' }]);
      play(bar, [from, to]);
    } catch (err) { cancelIndicatorMotion(); return null; }
    motion.finished = Promise.all(finished).then(() => {
      if (indicatorMotion !== motion) return;
      cancelIndicatorMotion();
      done?.();
    });
    return motion;
  };

  let ro = null;
  const observeSizes = () => {
    if (!ro) return;
    ro.disconnect();
    for (const el of layouts) ro.observe(el);
    if (card) ro.observe(card);
    if (sidebar) ro.observe(sidebar);
  };

  const apply = (immediate = false) => {
    if (indicatorMotion?.kind === 'remove') return { bar: 'closing' };
    if (!document.body) return { bar: 'no-body' };
    const found = findLayouts();
    if (!found.length) {
      // No app layout yet (boot, or a route without it): never float over unknown UI.
      cancelIndicatorMotion();
      stopSlots();
      setPanel(false);
      if (trigger) { trigger.remove(); trigger = null; lastHtml = ''; }
      for (const el of document.querySelectorAll('[data-spr-padded]')) restorePad(el);
      layouts = []; card = null; sidebar = null;
      return { bar: 'no-layout' };
    }
    ensureStyle();
    const nextSidebar = position === 'sidebar' ? findSidebar(found[0]) : null;
    const connected = !!trigger?.isConnected;
    const moving = connected && sidebar !== nextSidebar;
    if (indicatorMotion?.kind === 'move') {
      if (!immediate && moving && indicatorMotion.host === nextSidebar) {
        renderPanel();
        return { bar: 'moving' };
      }
      if (!immediate && connected && !moving && !reducedMotion() && !document.hidden) {
        indicatorMotion.kind = 'enter';
        for (const animation of indicatorMotion.animations) animation.reverse();
        renderPanel();
        return { bar: 'moving' };
      }
      cancelIndicatorMotion();
    }
    // Release the outgoing trigger's space as it disappears, then move it.
    if (!immediate && moving && animateIndicator(trigger, 'move', { host: nextSidebar, done: () => apply(true) })) {
      renderPanel();
      return { bar: 'moving' };
    }
    const padding = !nextSidebar && (!connected || moving) ? measurePadding(found) : [];
    const bar = ensureBar(nextSidebar);
    ensurePad(nextSidebar ? [] : found);
    const nextCard = findCard(found[0]);
    const changed = nextSidebar !== sidebar || nextCard !== card || found.length !== layouts.length || found.some((el, i) => el !== layouts[i]);
    layouts = found; card = nextCard; sidebar = nextSidebar;
    if (changed) observeSizes();
    place(bar);
    render();
    if (!connected || moving) animateIndicator(bar, 'enter', { padding, done: () => apply(true) });
    return { bar: 'ok', padded: sidebar ? 0 : layouts.length, card: !!card };
  };

  // ---- lifecycle -------------------------------------------------------------------------
  let tick = 0, debounce = 0, mo = null, started = false;
  const onResize = () => apply();
  // The tick also drives notifications, so a reset is announced on time without
  // waiting for the next poll.
  const onTick = () => { apply(); try { checkNotify(); } catch (err) {} };
  const onReady = () => start();
  const onStorage = ev => {
    if (ev.key !== POSITION_KEY && ev.key !== SIDEBAR_STYLE_KEY && ev.key !== null) return;
    const next = readPosition();
    const nextStyle = readSidebarStyle();
    if (next !== position || nextStyle !== sidebarStyle) {
      pinSettingsPanel();
      position = next;
      sidebarStyle = nextStyle;
      apply();
    }
  };

  const needsApply = () => {
    const bar = document.getElementById(ID);
    const found = findLayouts();
    if (!found.length) return !!bar || document.querySelectorAll('[data-spr-padded]').length > 0;
    if (!bar || bar.dataset.sprVersion !== String(BAR_VERSION)) return true;
    if (panelOpen && !document.getElementById(PANEL_ID)) return true;
    const host = position === 'sidebar' ? findSidebar(found[0]) : null;
    if (host !== sidebar || bar.parentElement !== (host || document.body)) return true;
    if (host) return host.firstElementChild !== bar || !!document.querySelector('[data-spr-padded]');
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
    addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onMotionContext);
    motionPreference?.addEventListener('change', onMotionContext);
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => { if (!indicatorMotion) apply(); });
      observeSizes();
    }
    // React re-renders / route switches can drop the padding or the layout node.
    mo = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { if (needsApply()) apply(); }, 250);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  const remove = () => {
    cancelIndicatorMotion();
    setPanel(false);
    stopSlots();
    started = false;
    clearInterval(tick);
    clearTimeout(debounce);
    clearTimeout(refreshTimer);
    clearTimeout(eventTimer);
    st.event = null;
    try { localStorage.removeItem(EVENT_KEY); } catch (err) {}
    refreshing = false;
    removeEventListener('resize', onResize);
    removeEventListener('storage', onStorage);
    document.removeEventListener('visibilitychange', onMotionContext);
    motionPreference?.removeEventListener('change', onMotionContext);
    document.removeEventListener('DOMContentLoaded', onReady);
    if (mo) { mo.disconnect(); mo = null; }
    if (ro) { ro.disconnect(); ro = null; }
    if (trigger) { trigger.remove(); trigger = null; }
    const p = document.getElementById(PANEL_ID); if (p) p.remove();
    const s = document.getElementById(STYLE_ID); if (s) s.remove();
    for (const el of document.querySelectorAll('[data-spr-padded]')) restorePad(el);
    layouts = []; card = null; sidebar = null; lastHtml = ''; lastPanelHtml = '';
    if (window.__sprBarInstance === instance) delete window.__sprBarInstance;
    notifyDryRun = false; dryStore = {}; dryLog = [];
    for (const k of ['__sprBarSetLimits', '__sprBarSetMode', '__sprBarSetPanel', '__sprBarGetState', '__sprBarRemove', '__sprBarRefreshDone',
      '__sprBarSetPace', '__sprBarSetNotify', '__sprBarSetThresholds', '__sprBarTestNotify', '__sprBarSetNotifyDryRun']) {
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

  let receivedLivePush = false;
  window.__sprBarSetLimits = (arr, meta) => {
    try {
      // After a reload or a fresh app start the page has nothing to compare against; the
      // agent then supplies the snapshot it wrote before the gap (possibly the previous run).
      const own = Array.isArray(st.limits) && st.limits.length ? st.limits : null;
      const fromPrevRun = !own && !!(meta && Array.isArray(meta.prevLimits) && meta.prevLimits.length);
      const prevLimits = own || (fromPrevRun ? meta.prevLimits : null);
      st.limits = (arr || []).map(l => ({
        name: String(l.name || l.id || '?'),
        usedPercent: Number(l.usedPercent != null ? l.usedPercent : l.used) || 0,
        resetsAtMs: Number(l.resetsAtMs || l.resetsAt) || null,
        windowDurationMins: Number(l.windowDurationMins) || null
      }));
      if (meta) { st.live = !!meta.live; st.meta = meta; }
      const live = meta?.live && !meta.error;
      const manual = refreshing && meta?.source !== 'native';
      const spin = live ? (manual ? 'manual' : receivedLivePush ? 'auto' : null) : null;
      if (live) receivedLivePush = true;
      if (meta?.source !== 'native') refreshDone();
      render(spin);
      // A push after a reset replaces the old window: announce that reset first.
      try {
        if (!meta?.accountChanged) { checkResets(prevLimits); checkRollover(prevLimits, st.limits, fromPrevRun); }
        checkNotify();
      } catch (err) {}
      return true;
    } catch (err) { return false; }
  };
  window.__sprBarSetMode = m => { st.mode = m === 'left' ? 'left' : 'used'; writeMode(st.mode); render(); };
  window.__sprBarSetPanel = (open, view) => { setPanel(open, view); return panelOpen; };
  window.__sprBarRefreshDone = refreshDone;
  window.__sprBarSetPace = on => { setPace(on); return pace; };
  window.__sprBarSetNotify = partial => { setNotify(partial); return Object.assign({}, notifySettings); };
  window.__sprBarSetThresholds = (arg = {}) => {
    const a = (arg && typeof arg === 'object') ? arg : {};
    const scope = a.scope == null || a.scope === '' ? 'default' : String(a.scope);
    if (a.reset) resetThresh(scope);
    else setThresh(scope, { crit: a.crit, low: a.low, mid: a.mid });
    return JSON.parse(JSON.stringify(threshes));
  };
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
    version: BAR_VERSION, mode: st.mode, position, placement: sidebar ? 'sidebar' : 'bottom', sidebarStyle, live: st.live, meta: st.meta, limits: st.limits,
    event: st.event ? Object.assign({}, st.event) : null,
    theme: document.documentElement.dataset.theme || null, panelOpen, panelView: panelOpen ? panelView : 'main', pace,
    thresholds: { defaults: Object.assign({}, threshes.d), windows: JSON.parse(JSON.stringify(threshes.w)) },
    notify: { settings: Object.assign({}, notifySettings), permission: notifyPermission(), dryRun: notifyDryRun, log: dryLog.slice() }
  });
  window.__sprBarRemove = animate => {
    if (animate !== true || !trigger?.isConnected) return remove();
    if (indicatorMotion?.kind === 'remove') return indicatorMotion.finished;
    const motion = animateIndicator(trigger, 'remove', { done: remove });
    if (!motion) return remove();
    setPanel(false);
    stopSlots();
    return motion.finished;
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else start();
  return JSON.stringify({ version: BAR_VERSION, status: started ? 'installed' : 'deferred' });
})();
