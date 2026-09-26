#!/usr/bin/env node
// inspect-attach.mjs — evaluate an expression file inside a RUNNING Electron app's
// main process over its Node inspector port (app started with `--inspect=<port>`).
//
// The main-process eval context has NO global `require`; payloads should reach it via
//   process.mainModule.require.bind(process.mainModule)
// (see references/runtime-injection.md).
//
// usage:
//   node inspect-attach.mjs <port> <expr-file> [--expect <target-title>]
//                          [--url <substring>] [--exact-url] [--png <out.png>]
//
// --url matches by substring; add --exact-url for exact equality (overlay windows can
// share the main window's URL prefix).
//
// examples:
//   node inspect-attach.mjs 9333 expr-windows.txt
//   node inspect-attach.mjs 9333 expr-capture.txt --png before.png
//
// Exit codes: 0 ok | 2 cannot reach/choose a target | 3 target title mismatch
//             4 payload threw | 5 driver/transport error
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const val = (name, def = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };

const port = argv[0];
const exprFile = argv[1];
if (!port || !exprFile || String(port).startsWith('--')) {
  console.error('usage: node inspect-attach.mjs <port> <expr-file> [--expect <title>] [--url <substr>] [--exact-url] [--png out.png]');
  process.exit(2);
}

const cfg = {
  expect: val('--expect'),
  urlFilter: val('--url', ''),
  // Equality instead of substring: overlay windows can share the main window's URL prefix
  // (e.g. `app://-/index.html?initialRoute=%2Favatar-overlay` vs `app://-/index.html`).
  exactUrl: argv.includes('--exact-url'),
  png: val('--png'),
};
const expr = readFileSync(exprFile, 'utf8');

async function main() {
  let targets;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
    targets = await r.json();
  } catch (err) {
    console.error(`cannot reach inspector on port ${port} — is the app running with --inspect=${port}? (${err})`);
    process.exit(2);
  }

  let pool = (targets || []).filter(t => t.webSocketDebuggerUrl);
  if (cfg.urlFilter) {
    pool = pool.filter(t => cfg.exactUrl ? String(t.url || '') === cfg.urlFilter : String(t.url || '').includes(cfg.urlFilter));
  }
  pool.sort((a, b) => ((a.type === 'page') ? 0 : 1) - ((b.type === 'page') ? 0 : 1));
  const target = pool[0];
  if (!target) {
    console.error('no matching target. available: ' + JSON.stringify((targets || []).map(t => ({ type: t.type, title: t.title, url: t.url })), null, 1));
    process.exit(2);
  }

  // Safety rail: never evaluate against an unknown debug port.
  const expect = cfg.expect || 'electron/js2c/browser_init';
  if (expect !== '-' && String(target.title) !== expect) {
    console.error(`refusing: target title is ${JSON.stringify(target.title)}, expected ${JSON.stringify(expect)}` +
      ' — pass --expect - to override, or --url to select a renderer target deliberately');
    process.exit(3);
  }

  console.error('target: ' + JSON.stringify({ type: target.type, title: target.title, url: target.url }));

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const done = pending.get(m.id); pending.delete(m.id); done(m); }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  await send('Runtime.enable');
  const res = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
    timeout: 120000,
  });
  const r = res.result || {};
  if (r.exceptionDetails) {
    console.error('EXCEPTION: ' + JSON.stringify(r.exceptionDetails, null, 1));
    process.exit(4);
  }
  const v = r.result && r.result.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(r.result, null, 1));

  if (cfg.png) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result && shot.result.data) {
      writeFileSync(cfg.png, Buffer.from(shot.result.data, 'base64'));
      console.log('SCREENSHOT_SAVED ' + cfg.png);
    } else {
      console.log('SCREENSHOT_ERROR ' + JSON.stringify(shot.error || shot));
    }
  }

  ws.close();
  process.exit(0);
}

main().catch(err => { console.error('DRIVER_ERROR ' + String(err)); process.exit(5); });
