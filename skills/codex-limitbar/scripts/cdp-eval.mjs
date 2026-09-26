#!/usr/bin/env node
// cdp-eval.mjs — evaluate JavaScript in the ChatGPT desktop app's shell page
// (app://-/index.html) over the app's --remote-debugging-port, after verifying that
// the port really belongs to the app. Standalone (no repo imports) so the skill
// works from a copied install. Node >= 22.
//
// usage:
//   node cdp-eval.mjs --port <p> (<expr-file> | -e '<expression>')
//                     [--app /Applications/ChatGPT.app] [--png <out.png>]
//
// examples:
//   node cdp-eval.mjs --port 21913 -e 'JSON.stringify(window.__sprBarGetState && window.__sprBarGetState())'
//   node cdp-eval.mjs --port 21913 probe.js --png shot.png
//
// Identity check (refuses otherwise): the process listening on the port is the app's
// main executable (listeners may also be its own children), the endpoint speaks CDP,
// an exact app://-/index.html page exists, and it defines the shell globals
// `codexWindowType` + `electronBridge`.
//
// Exit codes: 0 ok | 2 usage/transport | 3 identity check failed | 4 page exception
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const USAGE = "usage: node cdp-eval.mjs --port <p> (<expr-file> | -e '<expr>') [--app <ChatGPT.app>] [--png <out.png>]";
const argv = process.argv.slice(2);
const o = { app: '/Applications/ChatGPT.app' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') o.port = Number(argv[++i]);
  else if (a === '--app') o.app = argv[++i];
  else if (a === '--png') o.png = argv[++i];
  else if (a === '-e') o.expr = argv[++i];
  else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
  else if (!o.file && !a.startsWith('-')) o.file = a;
  else { console.error(USAGE); process.exit(2); }
}
if (!o.port || (!o.expr && !o.file)) { console.error(USAGE); process.exit(2); }
const expression = o.expr != null ? o.expr : fs.readFileSync(o.file, 'utf8');

const fail = (code, msg) => { console.error(msg); process.exit(code); };
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return String((e && e.stdout) || ''); } };
const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
const exeOf = pid => run('/bin/ps', ['-o', 'comm=', '-p', String(pid)]).trim();
const ppidOf = pid => Number(run('/bin/ps', ['-o', 'ppid=', '-p', String(pid)]).trim()) || 0;

// 1. port owner
const pids = [...new Set(run('/usr/sbin/lsof', ['-nP', '-iTCP:' + o.port, '-sTCP:LISTEN', '-Fp']).split('\n').filter(l => l.startsWith('p')).map(l => Number(l.slice(1))))];
if (!pids.length) fail(3, 'nothing is listening on 127.0.0.1:' + o.port);
const macosDir = real(path.join(o.app, 'Contents', 'MacOS'));
const mains = pids.filter(pid => path.dirname(real(exeOf(pid))) === macosDir);
if (mains.length !== 1) fail(3, 'port ' + o.port + ' is not owned by ' + o.app + ': ' + pids.map(p => p + ' ' + exeOf(p)).join('; '));
for (const pid of pids) {
  if (pid === mains[0]) continue;
  let p = pid, ok = false;
  for (let i = 0; i < 8 && p > 1 && !ok; i++) { p = ppidOf(p); ok = p === mains[0]; }
  if (!ok) fail(3, 'port ' + o.port + ' is also held by an unrelated process ' + pid + ' ' + exeOf(pid));
}

// 2. CDP endpoint + shell page
const getJson = async route => (await fetch('http://127.0.0.1:' + o.port + route, { signal: AbortSignal.timeout(3000) })).json();
let ver, list;
try { ver = await getJson('/json/version'); list = await getJson('/json/list'); } catch (e) { fail(3, 'no DevTools endpoint on ' + o.port + ': ' + e.message); }
if (!/^(Headless)?Chrome\//.test(String(ver.Browser || ''))) fail(3, 'not a CDP endpoint: ' + ver.Browser);
const page = list.find(t => t.type === 'page' && t.url === 'app://-/index.html');
if (!page) fail(3, 'no app://-/index.html page target');

// 3. talk to the page
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws error')), { once: true }); }).catch(e => fail(2, e.message));
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalValue = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.error) fail(2, r.error.message);
  if (r.result.exceptionDetails) fail(4, 'EXCEPTION: ' + JSON.stringify(r.result.exceptionDetails, null, 1));
  return r.result.result.value;
};

const isShell = await evalValue("typeof window.codexWindowType !== 'undefined' && !!window.electronBridge");
if (isShell !== true) fail(3, 'the page does not look like the ChatGPT/Codex shell');

const value = await evalValue(expression);
console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1));
if (o.png) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(o.png, Buffer.from(s.result.data, 'base64'));
  console.error('saved ' + o.png);
}
ws.close();
process.exit(0);
