// bar.js — the LIMITS status bar, injected into the ChatGPT desktop shell page
// (app://-/index.html) over CDP. Evaluated both before the DOM exists
// (Page.addScriptToEvaluateOnNewDocument) and into an already-loaded page
// (Runtime.evaluate); both paths converge on the same idempotent apply().
//
// Contract with the helper:
//   - `BAR_VERSION` below is read by the helper with /BAR_VERSION = (\d+)/.
//   - window.__sprBarSetLimits([{name, usedPercent, resetsAtMs}], meta)
//       meta: {live, planType, resetCredits, updatedAtMs, error?}
//   - window.__sprBarSetMode('used' | 'left')
//   - window.__sprBarGetState() -> {version, mode, live, limits, meta, theme}
//   - window.__sprBarRemove() -> full teardown, restores the layout exactly
//
// Colors come only from the app's own CSS tokens, so the bar follows the
// light/dark theme with no JS. The bar only appears once the app layout is
// found: it reserves space (padding on the layout container) and never
// overlays app UI.
(() => {
  const BAR_VERSION = 21;
  const ID = 'spr-statusbar';
  const STYLE_ID = ID + '-style';
  const LS_KEY = 'spr-statusbar-mode';
  const H = 28;
  const STALE_MS = 15 * 60 * 1000;

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

  // Sticky state: survives re-injection, so pushed limits are not lost on a hot-swap.
  const st = window.__sprBarState = window.__sprBarState || { mode: readMode(), live: false, meta: null, limits: null };

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
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const CSS = [
    '#' + ID + '{',
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
    '  position:fixed;bottom:0;left:0;right:0;height:' + H + 'px;z-index:25;',
    '  display:flex;align-items:center;gap:12px;padding:0 12px;box-sizing:border-box;overflow:hidden;',
    '  font-family:var(--font-ui-family, var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif));',
    '  font-size:12px;font-weight:500;line-height:' + H + 'px;color:var(--spr-fg2);',
    '  font-variant-numeric:tabular-nums;user-select:none;-webkit-user-select:none;white-space:nowrap;',
    '  background:transparent;',
    '}',
    // Fallback shape (no inset card found): a plain strip on the app surface.
    '#' + ID + '.spr-flat{background:var(--app-color-background-surface-under, var(--color-surface-secondary, Canvas));border-top:1px solid var(--app-color-border, rgba(128,128,128,.2));}',
    '#' + ID + ' .spr-label{color:var(--spr-fg3);font-size:var(--font-small-caps-md-size, 11px);font-weight:var(--font-small-caps-md-weight, 600);letter-spacing:var(--font-small-caps-md-tracking, .65px);text-transform:uppercase}',
    '#' + ID + ' .spr-block{display:inline-flex;align-items:center;gap:8px;min-width:0}',
    '#' + ID + ' .spr-name{color:var(--spr-fg2)}',
    '#' + ID + ' .spr-track{display:inline-block;width:64px;height:4px;border-radius:999px;background:var(--spr-track);overflow:hidden;flex:none}',
    '#' + ID + ' .spr-fill{display:block;height:100%;border-radius:999px;transition:width .25s ease}',
    '#' + ID + ' .spr-ok .spr-fill{background:var(--spr-ok-fill)}',
    '#' + ID + ' .spr-mid .spr-fill{background:var(--spr-mid-fill)}',
    '#' + ID + ' .spr-low .spr-fill{background:var(--spr-low-fill)}',
    '#' + ID + ' .spr-crit .spr-fill{background:var(--spr-crit-fill)}',
    '#' + ID + ' .spr-val{display:inline-flex;align-items:baseline;gap:4px}',
    '#' + ID + ' .spr-val b{font-weight:600}',
    '#' + ID + ' .spr-val span,#' + ID + ' .spr-reset{color:var(--spr-fg3)}',
    '#' + ID + ' .spr-ok{color:var(--spr-ok)}',
    '#' + ID + ' .spr-mid{color:var(--spr-mid)}',
    '#' + ID + ' .spr-low{color:var(--spr-low)}',
    '#' + ID + ' .spr-crit{color:var(--spr-crit)}',
    '#' + ID + ' .spr-sep{width:1px;height:12px;background:var(--spr-fg3);flex:none}',
    '#' + ID + ' .spr-spacer{margin-left:auto}',
    // used/left toggle mirrors the app's own mode toggle (Chat / Work) tokens.
    '#' + ID + ' .spr-toggle{display:inline-flex;padding:2px;gap:2px;border-radius:999px;background:var(--color-background-mode-toggle-track, var(--spr-track));flex:none}',
    '#' + ID + ' .spr-toggle button{all:unset;cursor:pointer;font-size:11px;line-height:18px;height:18px;padding:0 9px;border-radius:999px;color:var(--color-text-mode-toggle-inactive, var(--spr-fg3));box-sizing:border-box}',
    '#' + ID + ' .spr-toggle button.on{background:var(--color-background-mode-toggle-selected, var(--app-color-background-control, transparent));color:var(--color-text-mode-toggle-primary, var(--spr-fg));box-shadow:0 0 0 .5px var(--color-border-mode-toggle-selected, transparent)}',
    '#' + ID + ' .spr-note{color:var(--spr-fg3);font-size:11px}',
    '#' + ID + ' .spr-note.spr-stale{color:var(--spr-low)}',
    '#' + ID + ' .spr-wait{color:var(--spr-fg3)}',
    '@media (max-width:900px){#' + ID + ' .spr-note{display:none}}',
    '@media (max-width:720px){#' + ID + ' .spr-reset,#' + ID + ' .spr-label{display:none}}'
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
  let layouts = [];
  let card = null;

  const ensureStyle = () => {
    let s = document.getElementById(STYLE_ID);
    if (!s) {
      s = document.createElement('style');
      s.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(s);
    }
    if (s.textContent !== CSS) s.textContent = CSS;
  };

  const onClick = ev => {
    const t = ev.target && ev.target.closest ? ev.target.closest('[data-spr-mode]') : null;
    if (!t) return;
    st.mode = t.getAttribute('data-spr-mode') === 'left' ? 'left' : 'used';
    writeMode(st.mode);
    render();
  };

  const ensureBar = () => {
    let d = document.getElementById(ID);
    if (d && d.dataset.sprVersion !== String(BAR_VERSION)) { d.remove(); d = null; lastHtml = ''; }
    if (!d) {
      d = document.createElement('div');
      d.id = ID;
      d.setAttribute('role', 'status');
      d.dataset.sprVersion = String(BAR_VERSION);
      d.addEventListener('click', onClick);
      (document.body || document.documentElement).appendChild(d);
      lastHtml = '';
    }
    return d;
  };

  const blockHTML = l => {
    const used = clamp(Number(l.usedPercent) || 0, 0, 100);
    const remaining = 100 - used;
    const lvl = levelFor(remaining);
    const shown = Math.round(st.mode === 'left' ? remaining : used);
    const fillW = st.mode === 'left' ? remaining : used;
    const left = l.resetsAtMs ? fmtLeft(l.resetsAtMs - Date.now()) : '—';
    const title = l.resetsAtMs ? ('resets in ' + left + ' · ' + new Date(l.resetsAtMs).toLocaleString()) : 'reset time not reported';
    // Layout: [name] [mini bar] [NN% used] [time-to-reset]
    return '<span class="spr-block">'
      + '<span class="spr-name">' + esc(l.name) + '</span>'
      + '<span class="spr-track spr-' + lvl + '"><span class="spr-fill" style="width:' + fillW + '%"></span></span>'
      + '<span class="spr-val"><b class="spr-' + lvl + '">' + shown + '%</b><span>' + (st.mode === 'left' ? 'left' : 'used') + '</span></span>'
      + '<span class="spr-reset" title="' + esc(title) + '">' + left + '</span>'
      + '</span>';
  };

  const render = () => {
    const bar = document.getElementById(ID);
    if (!bar) return;
    let html = '<span class="spr-label">Limits</span>';
    const limits = Array.isArray(st.limits) ? st.limits : null;
    if (limits && limits.length) {
      limits.forEach((l, i) => { if (i > 0) html += '<span class="spr-sep"></span>'; html += blockHTML(l); });
      html += '<span class="spr-toggle spr-spacer">'
        + '<button data-spr-mode="used" class="' + (st.mode === 'used' ? 'on' : '') + '">used</button>'
        + '<button data-spr-mode="left" class="' + (st.mode === 'left' ? 'on' : '') + '">left</button>'
        + '</span>';
    } else {
      const err = st.meta && st.meta.error;
      html += '<span class="spr-wait"' + (err ? ' title="' + esc(err) + '"' : '') + '>'
        + (err ? 'limits unavailable' : 'waiting for data…') + '</span><span class="spr-spacer"></span>';
    }
    if (st.meta && st.meta.updatedAtMs && limits && limits.length) {
      const d = new Date(st.meta.updatedAtMs);
      const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
      const stale = !st.live || Date.now() - st.meta.updatedAtMs > STALE_MS || !!st.meta.error;
      const title = 'plan ' + (st.meta.planType || '?')
        + (st.meta.resetCredits != null ? ' · ' + st.meta.resetCredits + ' reset credits' : '')
        + ' · source: local codex app-server'
        + (st.meta.error ? ' · last refresh failed: ' + st.meta.error : '');
      html += '<span class="spr-note' + (stale ? ' spr-stale' : '') + '" title="' + esc(title) + '">'
        + (stale ? 'stale' : 'live') + ' &middot; updated ' + hh + ':' + mm + '</span>';
    }
    if (html !== lastHtml) { bar.innerHTML = html; lastHtml = html; }
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
  const onReady = () => start();

  const needsApply = () => {
    const bar = document.getElementById(ID);
    const found = findLayouts();
    if (!found.length) return !!bar || document.querySelectorAll('[data-spr-padded]').length > 0;
    if (!bar || bar.dataset.sprVersion !== String(BAR_VERSION)) return true;
    if (found.some(el => el.style.paddingBottom !== H + 'px')) return true;
    if (found.length !== layouts.length || found.some((el, i) => el !== layouts[i])) return true;
    return findCard(found[0]) !== card;
  };

  function start() {
    if (started) return;
    started = true;
    document.removeEventListener('DOMContentLoaded', onReady);
    apply();
    // Countdown refresh + periodic safety re-apply.
    tick = setInterval(apply, 20000);
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
    started = false;
    clearInterval(tick);
    clearTimeout(debounce);
    removeEventListener('resize', onResize);
    document.removeEventListener('DOMContentLoaded', onReady);
    if (mo) { mo.disconnect(); mo = null; }
    if (ro) { ro.disconnect(); ro = null; }
    const b = document.getElementById(ID); if (b) b.remove();
    const s = document.getElementById(STYLE_ID); if (s) s.remove();
    for (const el of document.querySelectorAll('[data-spr-padded]')) restorePad(el);
    layouts = []; card = null; lastHtml = '';
    if (window.__sprBarInstance === instance) delete window.__sprBarInstance;
    for (const k of ['__sprBarSetLimits', '__sprBarSetMode', '__sprBarGetState', '__sprBarRemove']) {
      try { delete window[k]; } catch (err) {}
    }
  };

  const instance = { version: BAR_VERSION, apply, remove };
  window.__sprBarInstance = instance;

  window.__sprBarSetLimits = (arr, meta) => {
    try {
      st.limits = (arr || []).map(l => ({
        name: String(l.name || l.id || '?'),
        usedPercent: Number(l.usedPercent != null ? l.usedPercent : l.used) || 0,
        resetsAtMs: Number(l.resetsAtMs || l.resetsAt) || null
      }));
      if (meta) { st.live = !!meta.live; st.meta = meta; }
      render();
      return true;
    } catch (err) { return false; }
  };
  window.__sprBarSetMode = m => { st.mode = m === 'left' ? 'left' : 'used'; writeMode(st.mode); render(); };
  window.__sprBarGetState = () => ({
    version: BAR_VERSION, mode: st.mode, live: st.live, meta: st.meta, limits: st.limits,
    theme: document.documentElement.dataset.theme || null
  });
  window.__sprBarRemove = remove;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else start();
  return JSON.stringify({ version: BAR_VERSION, status: started ? 'installed' : 'deferred' });
})();
