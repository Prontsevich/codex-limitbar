#!/usr/bin/env node
// bridge-install.mjs — TEMPLATE. Copy into the app's own project dir and adapt the
// CONFIG block, then run it against an app started with `--inspect=<port>`.
//
// Installs a persistent UI-injection bridge into an Electron main process:
//   - hooks existing webContents and every future one (web-contents-created)
//   - re-injects the UI on did-finish-load / did-navigate (survives reloads)
//   - a bar RESERVES layout space (pads the app's full-height layout container) and
//     self-heals on re-render, instead of overlaying the app's bottom controls
//   - optionally reloads the main window (persistence test) and captures a screenshot
//   - closes the inspector port afterwards (an open port = local code execution in the app)
//
// usage: node bridge-install.mjs <inspect-port> [--log <path>] [--reload-main]
//                                [--close-inspector <ms>] [--capture-after <ms>] [--capture-out <path>]
//
// Pairs with scripts/inspect-attach.mjs (one-shot evals). Recipe + verification:
// references/runtime-injection.md (§3b for the reserve-space shape, §3c for hot-swap iteration).
//
// Reinstall discipline (§3c): bump `version` in CONFIG on EVERY edit. The old bridge is
// disposed on reinstall — otherwise its self-heal keeps re-applying the old DOM/CSS.
//
// Serialization rule: the payload below ships as SOURCE TEXT — driver module-scope names
// do not exist inside the app. Values must travel through the payload's own `cfg` object
// or be substituted textually BEFORE sending; never leave runtime code referencing a
// driver-module constant (it throws ReferenceError inside the app).

const argv = process.argv.slice(2);
const port = argv[0];
const flags = new Set(argv.slice(1));
const val = (name, def = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };

if (!port || port.startsWith('--')) {
  console.error('usage: node bridge-install.mjs <inspect-port> [--log path] [--reload-main] [--close-inspector ms] [--capture-after ms] [--capture-out path]');
  process.exit(1);
}

const cfg = {
  // ---- CONFIG: adapt these ----
  shellUrlPattern: '^app://-/(index\\.html|detached-window\\.html)', // REGEX (as source) for the app's LOCAL shell webContents
  excludeUrlPattern: 'initialRoute=%2Favatar-overlay',                  // REGEX of overlay routes sharing the shell URL prefix ('' = none); prefer exact-URL filtering when available
  elementId: 'bar',                                                     // idempotency key for the injected node
  barText: 'STATUS',                                                    // placeholder content; wire real data later
  barHeight: 28,                                                        // px; the strip reserved in the app layout
  version: 2,                                                           // BUMP ON EVERY EDIT — same version on reinstall leaves the old bridge and its self-heal in place
  // ----------------------------
  log: val('--log'),
  reloadMain: flags.has('--reload-main'),
  closeMs: flags.has('--close-inspector') ? Number(val('--close-inspector', 600)) : 0,
  captureAfter: flags.has('--capture-after') ? Number(val('--capture-after', 5000)) : 0,
  captureOut: val('--capture-out'),
};

// This whole function is serialized and executed INSIDE the app's main process.
function mainPayload() {
  const cfg = __CFG__;
  // No global `require` in the main-process eval context — reach it via process.mainModule.
  const req = (typeof require === 'function') ? require : (process.mainModule && process.mainModule.require.bind(process.mainModule));
  const e = req('electron');
  const fs = req('fs');
  const say = m => { try { if (cfg.log) fs.appendFileSync(cfg.log, '[' + new Date().toISOString() + '] ' + m + '\n'); } catch (err) {} };

  // Runs inside EACH shell renderer. Keep it idempotent; return a small status object.
  // The strip is RESERVED (layout padded) rather than overlaid — see §3b of the reference.
  function injectDom() {
    const ID = __ELEMENT_ID__;
    const H = __BAR_H__;
    const TXT = __BAR_TEXT__;

    const ensureBar = () => {
      let d = document.getElementById(ID);
      if (d) return 'already';
      d = document.createElement('div');
      d.id = ID;
      // Placeholder look. Replace it with the host app's own surface/border values — read them
      // from its CSS custom properties or computed styles — and keep it FLAT: gradient + shadow
      // reads as "pseudo-3D" and the user rejects it. See references/chatgpt-desktop-app.md §
      // "Status-bar look" for the accepted spec (mini bars, traffic-light by remaining, no glyphs).
      d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:' + H + 'px;z-index:2147483647;display:flex;align-items:center;gap:14px;padding:0 14px;font:500 12px/' + H + 'px -apple-system,BlinkMacSystemFont,sans-serif;color:#e8e8ea;background:linear-gradient(180deg,rgba(32,32,36,.96),rgba(22,22,26,.98));border-top:1px solid rgba(255,255,255,.14);box-shadow:0 -4px 16px rgba(0,0,0,.35);';
      d.textContent = TXT;
      document.documentElement.appendChild(d);
      return 'injected';
    };

    // Reserve the strip: pad every full-height, non-fixed child of #root/body by H px so
    // the app's flex content (sidebar, composer) shrinks instead of sitting under the bar.
    const ensurePad = () => {
      const root = document.getElementById('root') || document.body;
      const padded = [];
      for (const el of root.children) {
        if (el.id === ID) continue;
        if (getComputedStyle(el).position === 'fixed') continue;
        const r = el.getBoundingClientRect();
        if (r.height < innerHeight * 0.85 || r.width < innerWidth * 0.5) continue;
        if (!el.dataset.barPadded) { el.dataset.barOrigPad = el.style.paddingBottom || ''; el.dataset.barPadded = '1'; }
        if (el.style.paddingBottom !== H + 'px') el.style.paddingBottom = H + 'px';
        padded.push(el.tagName.toLowerCase());
      }
      return padded;
    };

    // Teardown: window.__barRemove() restores the layout exactly.
    window.__barRemove = () => {
      const b = document.getElementById(ID); if (b) b.remove();
      for (const el of document.querySelectorAll('[data-bar-padded]')) {
        el.style.paddingBottom = el.dataset.barOrigPad || '';
        delete el.dataset.barPadded;
        delete el.dataset.barOrigPad;
      }
    };

    const status = ensureBar();
    const padded = ensurePad();
    if (!window.__barGuard) {
      window.__barGuard = true;
      // React re-renders / route switches wipe inline padding and can drop the node.
      let t = 0;
      new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => { ensureBar(); ensurePad(); }, 250); })
        .observe(document.documentElement, { childList: true, subtree: true });
      setInterval(() => { ensureBar(); ensurePad(); }, 1500);
      addEventListener('resize', () => { ensureBar(); ensurePad(); });
    }
    return { status, padded, vh: innerHeight, barH: H };
  }

  return (async () => {
    const INJECT = '(' + injectDom.toString()
      .replace(/__ELEMENT_ID__/g, () => JSON.stringify(cfg.elementId))
      .replace(/__BAR_TEXT__/g, () => JSON.stringify(cfg.barText))
      .replace(/__BAR_H__/g, () => String(cfg.barHeight))
      + ')()';
    const re = new RegExp(cfg.shellUrlPattern);
    const exre = cfg.excludeUrlPattern ? new RegExp(cfg.excludeUrlPattern) : null;
    const eligible = url => { const u = String(url || ''); return re.test(u) && !(exre && exre.test(u)); };

    if (!globalThis.__bridge || globalThis.__bridge.state.version !== cfg.version) {
      if (globalThis.__bridge) {
        say('hot-swap: disposing bridge v' + globalThis.__bridge.state.version);
        try { await globalThis.__bridge.dispose(); } catch (err) { say('dispose ERR: ' + String(err)); }
      }
      const state = { version: cfg.version, injectedCount: 0, startedAt: new Date().toISOString() };
      const inject = async wc => {
        if (state.dead || !wc || wc.isDestroyed() || !eligible(wc.getURL())) return null;
        try {
          const r = await wc.executeJavaScript(INJECT, true);
          state.injectedCount++;
          say('inject wc=' + wc.id + ' (' + ((r && r.status) || 'ok') + ') padded=' + JSON.stringify((r && r.padded) || []) + ' url=' + String(wc.getURL()).slice(0, 80));
          return r;
        } catch (err) { say('inject ERR wc=' + wc.id + ': ' + String((err && err.message) || err)); return null; }
      };
      const injectAll = () => { for (const wc of e.webContents.getAllWebContents()) inject(wc); };
      const hook = wc => { wc.on('did-finish-load', () => inject(wc)); wc.on('did-navigate', () => inject(wc)); };
      for (const wc of e.webContents.getAllWebContents()) hook(wc);
      e.app.on('web-contents-created', (_ev, wc) => { hook(wc); inject(wc); });
      // Mark dead + pull this version's UI out of every shell so a successor install starts clean.
      const dispose = async () => {
        state.dead = true;
        for (const wc of e.webContents.getAllWebContents()) {
          if (!wc.isDestroyed() && eligible(wc.getURL())) {
            try { await wc.executeJavaScript('window.__barRemove && window.__barRemove()', true); } catch (err) {}
          }
        }
      };
      globalThis.__bridge = { state, inject, injectAll, dispose };
      say('bridge installed (pid=' + process.pid + ', electron=' + process.versions.electron + ')');
      injectAll();
    } else {
      say('bridge v' + cfg.version + ' already installed; re-running injections');
      globalThis.__bridge.injectAll();
    }

    // Persistence test: reload the main window; the hook must bring the UI back by itself.
    if (cfg.reloadMain) {
      const win = e.BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && eligible(w.webContents.getURL()));
      if (win) { say('reloading main window (wc=' + win.webContents.id + ')'); win.webContents.reload(); }
      else say('reload skipped: main window not found');
    }

    // Security: close the inspector once the bridge lives in memory.
    if (cfg.closeMs > 0) {
      setTimeout(() => { try { req('inspector').close(); say('inspector port closed'); } catch (err) { say('inspector close ERR: ' + String(err)); } }, cfg.closeMs);
      say('inspector close scheduled in ' + cfg.closeMs + ' ms');
    }

    // Evidence: a screenshot of the injected window.
    if (cfg.captureAfter > 0 && cfg.captureOut) {
      setTimeout(async () => {
        try {
          const win = e.BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && eligible(w.webContents.getURL()));
          if (!win) { say('capture skipped: main window not found'); return; }
          // capturePage() runs at the window's device scale; for a small element pass a region
          // {x, y, width, height} and zoom the result visually instead of squinting at a full shot (§3c).
          const img = await win.webContents.capturePage();
          fs.writeFileSync(cfg.captureOut, img.toPNG());
          say('capture saved: ' + cfg.captureOut + ' ' + JSON.stringify(img.getSize()));
        } catch (err) { say('capture ERR: ' + String((err && err.message) || err)); }
      }, cfg.captureAfter);
      say('capture scheduled in ' + cfg.captureAfter + ' ms');
    }

    return JSON.stringify(globalThis.__bridge.state);
  })();
}

const expr = '(' + mainPayload.toString().replace('__CFG__', () => JSON.stringify(cfg)) + ')()';

async function main() {
  let targets;
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(5000) });
    targets = await r.json();
  } catch (err) { console.error('cannot reach inspector on port ' + port + ': ' + err); process.exit(2); }

  const target = (targets || []).find(t => t.webSocketDebuggerUrl);
  if (!target) { console.error('no inspector target: ' + JSON.stringify(targets)); process.exit(2); }
  // Safety rail: only ever evaluate in an Electron main process.
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

  await new Promise(res => setTimeout(res, 1500));  // let scheduled close/capture run
  try { ws.close(); } catch (e) {}
  process.exit(0);
}

main();
