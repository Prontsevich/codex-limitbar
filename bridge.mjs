#!/usr/bin/env node
// bridge.mjs — installs the LIMITS status-bar bridge into a running ChatGPT (Electron)
// main process over its Node inspector port.
//
// v9: identifiers renamed hermes-* -> spr-*; a migration sweep clears a live pre-rename
//     bar and its self-heal guard on first install.
// v12: dispose resolution fixed (state.dispose vs top-level — the old check never
//      matched, so a superseded bridge kept its listeners and re-injected its payload
//      on every reload until the app restarted); the sweep also deletes legacy globals.
// v11: the pre-rename storage key (hermes-statusbar-mode) is migrated into
//      spr-statusbar-mode, then deleted on every payload evaluation — the sticky state
//      object means a readMode migration cannot run retroactively in a live realm.
// v10: the sweep also runs in apply() every cycle — a stale pre-rename bridge's resize
//      listener can resurrect its own bar minutes after the swap.
// v8: live limits — the bridge spawns `codex app-server` in the app's main process,
//     speaks stdio JSON-RPC (initialize -> account/rateLimits/read) and pushes the real
//     windows into the bar every 5 minutes (and right after the Mac wakes).
// v7: the divider between limits is brighter and larger so it actually reads as a seam.
// v6: the divider between limits is a clearly visible bullet (was a faint middot).
// v5: label order — the limit name sits LEFT of the mini bar; percent + time-to-reset
//     stay on the right. The ↻ glyph (misread as a refresh button) is gone: the time is
//     plain text, the tooltip carries the exact reset moment.
// v4: Orca-style layout — mini progress bars, per-limit relative countdown ("how long
//     until reset"), traffic-light color driven by the REMAINING amount, a used/left
//     toggle (persisted in localStorage), and a flat app-panel look (no gradient/shadow).
// v3: the bar reserves real layout space (padding-bottom on the app layout container)
//     instead of overlaying the bottom strip.
//
// usage: node bridge.mjs <inspect-port> [--log <path>] [--reload-main]
//                        [--close-inspector <ms>] [--capture-after <ms>] [--capture-out <path>]

const argv = process.argv.slice(2);
const port = argv[0];
const flags = new Set(argv.slice(1));

const val = (name, def = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };

if (!port || port.startsWith('--')) {
  console.error('usage: node bridge.mjs <inspect-port> [--log path] [--reload-main] [--close-inspector ms] [--capture-after ms] [--capture-out path]');
  process.exit(1);
}

const cfg = {
  log: val('--log'),
  reloadMain: flags.has('--reload-main'),
  closeMs: flags.has('--close-inspector') ? Number(val('--close-inspector', 600)) : 0,
  captureAfter: flags.has('--capture-after') ? Number(val('--capture-after', 5000)) : 0,
  captureOut: val('--capture-out'),
};

const BAR_HEIGHT = 28;
const BRIDGE_VERSION = 12;

// This function is serialized and executed inside the app's main process.
function mainPayload() {
  const cfg = __CFG__;
  const BAR_HEIGHT = __BAR_H__;
  const VERSION = __VERSION__;
  const req = (typeof require === 'function') ? require : (process.mainModule && process.mainModule.require.bind(process.mainModule));
  const e = req('electron');
  const fs = req('fs');
  const say = m => { try { if (cfg.log) fs.appendFileSync(cfg.log, '[' + new Date().toISOString() + '] ' + m + '\n'); } catch (err) {} };
  const cp = req('child_process');
  const os = req('os');

  // ---- live limits -----------------------------------------------------------------
  // Method borrowed from codex-limits-mcp: ask `codex app-server` over stdio JSON-RPC
  // (initialize -> initialized -> account/rateLimits/read). The MCP server itself is
  // not involved; the app's own bundled codex binary is the preferred source.

  function bundledCodex() {
    try {
      const p = e.app.getAppPath();              // .../Contents/Resources/app.asar
      const dir = p.slice(0, p.lastIndexOf('/'));
      return dir + '/codex';
    } catch (err) { return null; }
  }

  function findCodex() {
    const home = process.env.HOME || '';
    const cands = [bundledCodex(), home + '/.local/bin/codex', home + '/.local/share/mise/shims/codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex'];
    for (const c of cands) {
      if (!c) continue;
      try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (err) {}
    }
    return null;
  }

  function nameForWindow(mins) {
    const m = Number(mins) || 0;
    if (m >= 10080) return 'Weekly';
    if (m >= 1440 && m % 1440 === 0) return (m / 1440) + 'd';
    if (m >= 60 && m % 60 === 0) return (m / 60) + 'h';
    return m ? m + 'm' : '?';
  }

  function rpcFetch(bin) {
    return new Promise(resolve => {
      let child;
      const env = Object.assign({}, process.env, { PWD: os.tmpdir() });
      delete env.OLDPWD; delete env.INIT_CWD;
      try {
        child = cp.spawn(bin, ['app-server', '--listen', 'stdio://'], { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'] });
      } catch (err) { resolve({ error: 'spawn: ' + String((err && err.message) || err) }); return; }
      let buf = '', stage = 0, done = false;
      const finish = out => {
        if (done) return; done = true;
        clearTimeout(timer);
        try { child.kill('SIGTERM'); } catch (err) {}
        resolve(out);
      };
      const timer = setTimeout(() => finish({ error: 'timeout after 15 s' }), 15000);
      const send = obj => { try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch (err) {} };
      child.on('error', err => finish({ error: 'child: ' + String((err && err.message) || err) }));
      child.on('exit', () => finish({ error: 'exited before responding' }));
      child.stdout.on('data', chunk => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch (err) { continue; }
          if (stage === 0 && msg.id === 1) {
            if (msg.error) { finish({ error: 'initialize: ' + JSON.stringify(msg.error) }); return; }
            stage = 1;
            send({ method: 'initialized', params: {} });
            send({ method: 'account/rateLimits/read', id: 2 });
          } else if (stage === 1 && msg.id === 2) {
            if (msg.error) { finish({ error: 'rateLimits: ' + JSON.stringify(msg.error) }); return; }
            finish({ result: msg.result });
            return;
          }
        }
      });
      send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'chatgpt-limitbar', title: 'ChatGPT Limit Bar', version: '1.0.0' } } });
    });
  }

  function parseLimits(result) {
    if (!result || typeof result !== 'object') return { error: 'empty result' };
    const byId = result.rateLimitsByLimitId;
    let bucket = byId && byId.codex;
    if (!bucket && byId) { const keys = Object.keys(byId); if (keys.length === 1) bucket = byId[keys[0]]; }
    if (!bucket) bucket = result.rateLimits;
    if (!bucket) return { error: 'no rate-limit bucket' };
    const win = w => (w && typeof w.usedPercent === 'number')
      ? { name: nameForWindow(w.windowDurationMins), usedPercent: w.usedPercent, resetsAtMs: w.resetsAt ? w.resetsAt * 1000 : null }
      : null;
    const limits = [win(bucket.primary), win(bucket.secondary)].filter(Boolean);
    if (!limits.length) return { error: 'no rate-limit windows in the bucket' };
    return {
      limits,
      meta: {
        live: true,
        planType: bucket.planType || null,
        resetCredits: result.rateLimitResetCredits ? result.rateLimitResetCredits.availableCount : null,
        updatedAtMs: Date.now()
      }
    };
  }

  function injectDom() {
    const ID = 'spr-statusbar';
    const H = __BAR_H__;
    const V = __VERSION__;
    const LS_KEY = 'spr-statusbar-mode';

    // Pre-rename (hermes-* / __hermes*) sweep. A live older bridge keeps its own hooks:
    // its resize listener can resurrect its bar, so this re-runs on every apply cycle.
    const sweepLegacy = () => {
      try { if (window.__hermesBarRemove) window.__hermesBarRemove(); } catch (err) {}
      try { clearInterval(window.__hermesBarTick); } catch (err) {}
      try { if (window.__hermesBarObserver) window.__hermesBarObserver.disconnect(); } catch (err) {}
      try { const lb = document.getElementById('hermes-statusbar'); if (lb) lb.remove(); } catch (err) {}
      try { const ls = document.getElementById('hermes-statusbar-style'); if (ls) ls.remove(); } catch (err) {}
      try {
        for (const el of document.querySelectorAll('[data-hermes-padded]')) {
          el.style.paddingBottom = el.dataset.hermesOrigPad || '';
          delete el.dataset.hermesPadded;
          delete el.dataset.hermesOrigPad;
        }
      } catch (err) {}
      // Legacy hooks left on window cannot be "undone", only deleted — and a stale
      // main-process listener may re-inject them (until the app restarts), so this
      // removal repeats on every cycle.
      for (const k of ['__hermesBarSetLimits', '__hermesBarSetMode', '__hermesBarGetState',
        '__hermesBarRemove', '__hermesBarGuard', '__hermesBarTick', '__hermesBarStateV4',
        '__hermesBarObserver']) {
        try { delete window[k]; } catch (err) {}
      }
    };
    sweepLegacy();

    // Hot-swap: tear down a guard left by an older bridge version — its interval and
    // MutationObserver would otherwise fight this instance over the bar and padding.
    const prevRemove = window.__sprBarRemove;
    const prevGuard = window.__sprBarGuard;
    if (prevRemove && prevGuard && prevGuard !== V) {
      try { prevRemove(); } catch (err) {}
    }

    const readMode = () => {
      try {
        let m = localStorage.getItem(LS_KEY);
        const leg = localStorage.getItem('hermes-statusbar-mode');
        if (leg != null) {
          if (m == null) { localStorage.setItem(LS_KEY, leg); m = leg; } // carry the preference over once
          localStorage.removeItem('hermes-statusbar-mode');
        }
        return m === 'left' ? 'left' : 'used';
      } catch (err) { return 'used'; }
    };
    const writeMode = m => { try { localStorage.setItem(LS_KEY, m); } catch (err) {} };

    // Shared state survives repeated injections; sample data until wired to the
    // Codex app-server (account/rateLimits/read).
    const st = window.__sprBarStateV4 = window.__sprBarStateV4 || {
      mode: readMode(),
      live: false,
      meta: null,
      limits: [
        { name: '5h', usedPercent: 32, resetsAtMs: Date.now() + (2 * 60 + 14) * 60000 },
        { name: 'Weekly', usedPercent: 61, resetsAtMs: Date.now() + (3 * 24 + 5) * 3600000 }
      ]
    };

    // Sticky state: readMode may not have run in this realm — make sure the pre-rename
    // key is gone either way (readMode already copied its value when it could).
    try { localStorage.removeItem('hermes-statusbar-mode'); } catch (err) {}

    const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
    // Traffic light by REMAINING amount; palette matches the bar's own colors.
    const colorFor = remaining => remaining < 10 ? '#f85149' : remaining < 25 ? '#f0883e' : remaining < 50 ? '#e3b341' : '#7ee787';
    const fmtLeft = ms => {
      const s = Math.max(0, Math.round(ms / 1000));
      const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
      if (d > 0) return d + 'd ' + h + 'h';
      if (h > 0) return h + 'h ' + m + 'm';
      if (m > 0) return m + 'm';
      return '<1m';
    };
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const ensureStyle = () => {
      let s = document.getElementById(ID + '-style');
      if (!s) {
        s = document.createElement('style');
        s.id = ID + '-style';
        (document.head || document.documentElement).appendChild(s);
      }
      s.textContent = [
        '#' + ID + '{position:fixed;left:0;right:0;bottom:0;height:' + H + 'px;z-index:2147483647;display:flex;align-items:center;gap:12px;padding:0 12px;font:500 12px/' + H + 'px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e8e8ea;background:var(--color-surface,#0b0e14);border-top:1px solid var(--color-border,rgba(191,189,182,.084));font-variant-numeric:tabular-nums;user-select:none;box-sizing:border-box;overflow:hidden;}',
        '#' + ID + ' .hs-label{opacity:.6;text-transform:uppercase;font-size:10px;letter-spacing:.8px}',
        '#' + ID + ' .hs-block{display:inline-flex;align-items:center;gap:8px;min-width:0}',
        '#' + ID + ' .hs-track{display:inline-block;width:64px;height:5px;border-radius:999px;background:rgba(191,189,182,.14);overflow:hidden;flex:none}',
        '#' + ID + ' .hs-fill{display:block;height:100%;border-radius:999px;transition:width .25s ease,background-color .25s ease}',
        '#' + ID + ' .hs-name{color:rgba(191,189,182,.55);font-size:11px}',
        '#' + ID + ' .hs-val{display:inline-flex;align-items:baseline;gap:4px}',
        '#' + ID + ' .hs-val b{font-weight:600}',
        '#' + ID + ' .hs-val span{color:rgba(191,189,182,.5);font-size:11px}',
        '#' + ID + ' .hs-reset{color:rgba(191,189,182,.45);font-size:11px}',
        '#' + ID + ' .hs-sep{color:rgba(191,189,182,.85);font-size:17px;line-height:1;padding:0 2px}',
        '#' + ID + ' .hs-spacer{margin-left:auto}',
        '#' + ID + ' .hs-toggle{display:inline-flex;padding:1px;border-radius:6px;background:rgba(191,189,182,.08)}',
        '#' + ID + ' .hs-toggle button{all:unset;cursor:pointer;font-size:11px;line-height:18px;height:18px;padding:0 8px;border-radius:5px;color:rgba(191,189,182,.55)}',
        '#' + ID + ' .hs-toggle button.on{background:rgba(191,189,182,.14);color:#e8e8ea}',
        '#' + ID + ' .hs-note{font-size:11px;color:rgba(191,189,182,.35)}',
        '@media (max-width:900px){#' + ID + ' .hs-note{display:none}}'
      ].join('\n');
    };

    const blockHTML = l => {
      const used = clamp(Number(l.usedPercent) || 0, 0, 100);
      const remaining = 100 - used;
      const c = colorFor(remaining);
      const shown = Math.round(st.mode === 'left' ? remaining : used);
      const fillW = st.mode === 'left' ? remaining : used;
      const word = st.mode === 'left' ? 'left' : 'used';
      const left = l.resetsAtMs ? fmtLeft(l.resetsAtMs - Date.now()) : '—';
      const title = l.resetsAtMs ? ('resets in ' + left + ' · ' + new Date(l.resetsAtMs).toLocaleString()) : 'reset time not reported';
      // Layout: [name] [mini bar] [NN% used] [time-to-reset]
      return '<span class="hs-block">'
        + '<span class="hs-name">' + esc(l.name) + '</span>'
        + '<span class="hs-track"><span class="hs-fill" style="width:' + fillW + '%;background:' + c + '"></span></span>'
        + '<span class="hs-val"><b style="color:' + c + '">' + shown + '%</b><span>' + word + '</span></span>'
        + '<span class="hs-reset" title="' + esc(title) + '">' + left + '</span>'
        + '</span>';
    };

    const render = () => {
      const bar = document.getElementById(ID);
      if (!bar) return;
      let html = '<span class="hs-label">LIMITS</span>';
      for (let i = 0; i < st.limits.length; i++) {
        if (i > 0) html += '<span class="hs-sep">&bull;</span>';
        html += blockHTML(st.limits[i]);
      }
      html += '<span class="hs-toggle hs-spacer">'
        + '<button data-hs-mode="used" class="' + (st.mode === 'used' ? 'on' : '') + '">used</button>'
        + '<button data-hs-mode="left" class="' + (st.mode === 'left' ? 'on' : '') + '">left</button>'
        + '</span>';
      let note = 'sample data &middot; local bridge';
      let noteTitle = 'demo values; the first live fetch from the Codex app-server is pending';
      if (st.live && st.meta) {
        const d = new Date(st.meta.updatedAtMs || Date.now());
        const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
        note = 'live &middot; updated ' + hh + ':' + mm;
        noteTitle = 'plan ' + (st.meta.planType || '?')
          + (st.meta.resetCredits != null ? ' · ' + st.meta.resetCredits + ' reset credits' : '')
          + ' · source: local codex app-server';
      }
      html += '<span class="hs-note" title="' + esc(noteTitle) + '">' + note + '</span>';
      bar.innerHTML = html;
    };

    // Full-height layout containers directly under #root (or body): padding them by H px
    // reserves the strip; their flex content (sidebar, composer, webview) shrinks instead
    // of sitting under the bar. Fixed-position nodes and boot loaders are skipped.
    const findLayouts = () => {
      const out = [];
      const root = document.getElementById('root') || document.body;
      for (const ch of root.children) {
        if (ch.id === ID || ch.id === ID + '-style') continue;
        const cls = String(ch.className || '');
        if (/startup|loader|toast/i.test(cls)) continue;
        const cs = getComputedStyle(ch);
        if (cs.position === 'fixed') continue;
        const r = ch.getBoundingClientRect();
        if (r.height >= innerHeight * 0.85 && r.width >= innerWidth * 0.5) out.push(ch);
      }
      return out;
    };

    const ensurePad = () => {
      const found = findLayouts();
      const padded = [];
      // revert padding on elements that no longer qualify (e.g. a boot loader that left)
      for (const el of document.querySelectorAll('[data-spr-padded]')) {
        if (found.indexOf(el) === -1) {
          el.style.paddingBottom = el.dataset.sprOrigPad || '';
          delete el.dataset.sprPadded;
          delete el.dataset.sprOrigPad;
        }
      }
      for (const el of found) {
        if (!el.dataset.sprPadded) {
          el.dataset.sprOrigPad = el.style.paddingBottom || '';
          el.dataset.sprPadded = '1';
        }
        if (el.style.paddingBottom !== H + 'px') el.style.paddingBottom = H + 'px';
        padded.push(el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ').slice(0, 2).join('.'));
      }
      return padded;
    };

    const ensureBar = () => {
      let d = document.getElementById(ID);
      // A bar from an older bridge version: rebuild it in place.
      if (d && d.dataset.hsVersion !== String(V)) { d.remove(); d = null; }
      let status = 'already';
      if (!d) {
        d = document.createElement('div');
        d.id = ID;
        d.setAttribute('role', 'status');
        document.documentElement.appendChild(d);
        status = 'injected';
      }
      d.dataset.hsVersion = String(V);
      if (d.dataset.hsClick !== '1') {
        d.dataset.hsClick = '1';
        d.addEventListener('click', ev => {
          const t = ev.target && ev.target.closest ? ev.target.closest('[data-hs-mode]') : null;
          if (!t) return;
          st.mode = t.getAttribute('data-hs-mode') === 'left' ? 'left' : 'used';
          writeMode(st.mode);
          render();
        });
      }
      return status;
    };

    const apply = () => {
      sweepLegacy();
      ensureStyle();
      const bar = ensureBar();
      render();
      const padded = ensurePad();
      return { bar, padded, vh: innerHeight, mode: st.mode, barH: H, version: V };
    };

    // Public hooks (also handy for wiring live limits later):
    //   __sprBarSetLimits([{name, usedPercent, resetsAtMs}])
    //   __sprBarSetMode('used'|'left') · __sprBarGetState() · __sprBarRemove()
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
    window.__sprBarGetState = () => ({ version: V, mode: st.mode, live: st.live, meta: st.meta, limits: st.limits, vh: innerHeight });

    // Test/teardown hook: restores the layout exactly.
    window.__sprBarRemove = () => {
      const b = document.getElementById(ID); if (b) b.remove();
      const s = document.getElementById(ID + '-style'); if (s) s.remove();
      for (const el of document.querySelectorAll('[data-spr-padded]')) {
        el.style.paddingBottom = el.dataset.sprOrigPad || '';
        delete el.dataset.sprPadded;
        delete el.dataset.sprOrigPad;
      }
      try { clearInterval(window.__sprBarTick); } catch (err) {}
      try { if (window.__sprBarObserver) window.__sprBarObserver.disconnect(); } catch (err) {}
      window.__sprBarGuard = 0;
    };

    const first = apply();
    if (window.__sprBarGuard !== V) {
      window.__sprBarGuard = V;
      // Live countdown + periodic full re-apply (also catches layout re-mounts).
      window.__sprBarTick = setInterval(apply, 20000);
      addEventListener('resize', () => apply());
      let t = 0;
      window.__sprBarObserver = new MutationObserver(() => {
        clearTimeout(t);
        t = setTimeout(() => {
          const bar = document.getElementById(ID);
          if (!bar || bar.dataset.hsVersion !== String(V) || document.querySelectorAll('[data-spr-padded]').length === 0 || document.getElementById('hermes-statusbar') || document.querySelectorAll('[data-hermes-padded]').length > 0) apply();
        }, 250);
      });
      window.__sprBarObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    return first;
  }

  return (async () => {
    const INJECT = '(' + injectDom.toString() + ')()';
    // App-shell main window only: exact app://-/index.html (or a non-overlay route query).
    // The avatar-overlay window and embedded web pages are deliberately excluded.
    const eligible = url => {
      const u = String(url || '');
      if (u === 'app://-/index.html') return true;
      if (u.startsWith('app://-/index.html?') && !u.includes('avatar-overlay')) return true;
      return false;
    };

    const needInstall = !globalThis.__sprBridge ||
      !globalThis.__sprBridge.state || globalThis.__sprBridge.state.version !== VERSION;

    if (needInstall) {
      // Hot-swap housekeeping: drop listeners from a previous bridge version so two
      // injectors never fight over the same bar/padding.
      const prev = globalThis.__sprBridge || globalThis.__hermesBridge;
      // dispose lives on state.dispose (older shape) or on the bridge object itself
      // (newer shape) — checking only prev.dispose silently skipped cleanup, leaving
      // stale listeners that re-injected the old payload on every reload.
      const prevDispose = prev && (typeof prev.dispose === 'function'
        ? prev.dispose
        : (prev.state && typeof prev.state.dispose === 'function' ? prev.state.dispose : null));
      if (typeof prevDispose === 'function') {
        try { prevDispose(); say('previous bridge v' + ((prev.state && prev.state.version) || '?') + ' disposed'); }
        catch (err) { say('dispose ERR: ' + String((err && err.message) || err)); }
      }
      try { delete globalThis.__hermesBridge; } catch (err) {}
      const state = { version: VERSION, injectedCount: 0, startedAt: new Date().toISOString(), perWc: {}, listeners: [], limits: null, pollMs: 300000 };
      const limitsJs = () => state.limits
        ? 'window.__sprBarSetLimits && window.__sprBarSetLimits(' + JSON.stringify(state.limits.limits) + ',' + JSON.stringify(state.limits.meta) + ')'
        : null;
      const inject = async wc => {
        if (!wc || wc.isDestroyed() || !eligible(wc.getURL())) return null;
        try {
          const r = await wc.executeJavaScript(INJECT, true);
          state.injectedCount++;
          state.perWc[wc.id] = { url: String(wc.getURL()).slice(0, 90), result: r, at: new Date().toISOString() };
          say('inject wc=' + wc.id + ' (' + ((r && r.bar) || 'ok') + ') padded=' + JSON.stringify((r && r.padded) || []) + ' url=' + String(wc.getURL()).slice(0, 80));
          const ljs = limitsJs();
          if (ljs) wc.executeJavaScript(ljs, true).catch(() => {});
          return r;
        } catch (err) {
          state.perWc[wc.id] = { error: String((err && err.message) || err) };
          say('inject ERR wc=' + wc.id + ': ' + String((err && err.message) || err));
          return null;
        }
      };
      const injectAll = () => { for (const wc of e.webContents.getAllWebContents()) inject(wc); };
      const pushLimits = () => {
        const js = limitsJs();
        if (!js) return;
        for (const wc of e.webContents.getAllWebContents()) {
          if (wc.isDestroyed() || !eligible(wc.getURL())) continue;
          wc.executeJavaScript(js, true).catch(() => {});
        }
      };
      const pollLimits = async () => {
        const bin = findCodex();
        if (!bin) { say('limits: codex binary not found'); return; }
        const out = await rpcFetch(bin);
        if (out.error) { say('limits ERR via ' + bin + ': ' + out.error); return; }
        const parsed = parseLimits(out.result);
        if (parsed.error) { say('limits parse ERR: ' + parsed.error); return; }
        state.limits = { limits: parsed.limits, meta: parsed.meta };
        say('limits live: ' + parsed.limits.map(l => l.name + ' ' + Math.round(l.usedPercent) + '%').join(', ') + ' · plan=' + parsed.meta.planType + ' · via ' + bin);
        pushLimits();
      };
      const onResume = () => { say('power resume: refetching limits'); pollLimits(); };
      const hook = wc => {
        const onLoad = () => inject(wc);
        const onNav = () => inject(wc);
        wc.on('did-finish-load', onLoad);
        wc.on('did-navigate', onNav);
        state.listeners.push({ wc, onLoad, onNav });
      };
      const appHandler = (_ev, wc) => { hook(wc); inject(wc); };
      for (const wc of e.webContents.getAllWebContents()) hook(wc);
      e.app.on('web-contents-created', appHandler);
      state.dispose = () => {
        try { e.app.removeListener('web-contents-created', appHandler); } catch (err) {}
        for (const L of state.listeners) {
          try { L.wc.removeListener('did-finish-load', L.onLoad); L.wc.removeListener('did-navigate', L.onNav); } catch (err) {}
        }
        state.listeners.length = 0;
        try { clearInterval(state.pollTimer); } catch (err) {}
        try { e.powerMonitor.removeListener('resume', onResume); } catch (err) {}
      };
      globalThis.__sprBridge = { state, inject, injectAll, pushLimits, pollLimits, dispose: state.dispose };
      state.pollTimer = setInterval(pollLimits, state.pollMs);
      try { e.powerMonitor.on('resume', onResume); } catch (err) {}
      say('bridge v' + VERSION + ' installed (pid=' + process.pid + ', electron=' + process.versions.electron + ', barH=' + BAR_HEIGHT + ', limitsPoll=' + Math.round(state.pollMs / 60000) + 'min)');
      injectAll();
      setTimeout(pollLimits, 500);
    } else {
      say('bridge already installed; re-running injections');
      globalThis.__sprBridge.injectAll();
      if (globalThis.__sprBridge.pushLimits) globalThis.__sprBridge.pushLimits();
      if (globalThis.__sprBridge.pollLimits) globalThis.__sprBridge.pollLimits();
    }

    if (cfg.reloadMain) {
      const win = e.BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && String(w.webContents.getURL()).startsWith('app://-/index.html') && !String(w.webContents.getURL()).includes('avatar-overlay'));
      if (win) { say('reloading main window (wc=' + win.webContents.id + ')'); win.webContents.reload(); }
      else say('reload skipped: main window not found');
    }

    if (cfg.closeMs > 0) {
      setTimeout(() => { try { req('inspector').close(); say('inspector port closed'); } catch (err) { say('inspector close ERR: ' + String(err)); } }, cfg.closeMs);
      say('inspector close scheduled in ' + cfg.closeMs + ' ms');
    }

    if (cfg.captureAfter > 0 && cfg.captureOut) {
      setTimeout(async () => {
        try {
          const win = e.BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && String(w.webContents.getURL()) === 'app://-/index.html');
          if (!win) { say('capture skipped: main window not found'); return; }
          const img = await win.webContents.capturePage();
          fs.writeFileSync(cfg.captureOut, img.toPNG());
          say('capture saved: ' + cfg.captureOut + ' ' + JSON.stringify(img.getSize()));
        } catch (err) { say('capture ERR: ' + String((err && err.message) || err)); }
      }, cfg.captureAfter);
      say('capture scheduled in ' + cfg.captureAfter + ' ms');
    }

    return JSON.stringify({
      version: globalThis.__sprBridge.state.version,
      injectedCount: globalThis.__sprBridge.state.injectedCount,
      startedAt: globalThis.__sprBridge.state.startedAt,
      perWc: globalThis.__sprBridge.state.perWc,
      limits: globalThis.__sprBridge.state.limits ? globalThis.__sprBridge.state.limits.limits.map(l => l.name + '=' + Math.round(l.usedPercent) + '%') : null
    });
  })();
}

const expr = '(' + mainPayload.toString()
  .replace('__CFG__', () => JSON.stringify(cfg))
  .replace(/__BAR_H__/g, () => String(BAR_HEIGHT))
  .replace(/__VERSION__/g, () => String(BRIDGE_VERSION)) + ')()';

async function main() {
  let targets;
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(5000) });
    targets = await r.json();
  } catch (err) {
    console.error('cannot reach inspector on port ' + port + ': ' + err);
    process.exit(2);
  }
  const target = (targets || []).find(t => t.webSocketDebuggerUrl);
  if (!target) { console.error('no inspector target: ' + JSON.stringify(targets)); process.exit(2); }
  if (String(target.title) !== 'electron/js2c/browser_init') {
    console.error('refusing: inspector target is not an Electron main process (title=' + target.title + ')');
    process.exit(3);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const done = pending.get(m.id); pending.delete(m.id); done(m); }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  await send('Runtime.enable');
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 120000 });
  const r = res.result || {};
  if (r.exceptionDetails) { console.error('EXCEPTION: ' + JSON.stringify(r.exceptionDetails, null, 1)); process.exit(4); }
  console.log(r.result && typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result));
  await new Promise(res => setTimeout(res, 1500));
  try { ws.close(); } catch (e) {}
  process.exit(0);
}

main();
