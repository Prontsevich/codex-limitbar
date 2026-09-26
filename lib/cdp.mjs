// lib/cdp.mjs — a tiny dependency-free Chrome DevTools Protocol client plus the
// identity check that every codex-limitbar entry point runs before touching a port.
//
// Node >= 22: uses the global WebSocket and fetch.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_APP = '/Applications/ChatGPT.app';
export const SHELL_URL = 'app://-/index.html';

// Only the local app shell gets the bar: the exact shell URL or a routed variant of
// it. The avatar overlay shares the prefix (`?initialRoute=%2Favatar-overlay`), and
// remote chatgpt.com panes are never eligible.
export function isShellUrl(url) {
  const u = String(url || '');
  if (u === SHELL_URL) return true;
  return u.startsWith(SHELL_URL + '?') && !u.includes('avatar-overlay');
}

// Evaluated inside the page: globals the ChatGPT/Codex shell defines and a random
// Chromium page does not.
const SHELL_CHECK = "typeof window.codexWindowType !== 'undefined' && !!window.electronBridge";

export class IdentityError extends Error {}

export class CdpConnection {
  static connect(url, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP connect timeout: ' + url)); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new CdpConnection(ws)); }, { once: true });
      ws.addEventListener('error', ev => { clearTimeout(timer); reject(new Error('CDP connect failed: ' + ((ev && ev.message) || url))); }, { once: true });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closeHandlers = [];
    this.closed = false;
    ws.addEventListener('message', ev => this.#onMessage(ev));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP connection closed (' + p.method + ')')); }
      this.pending.clear();
      for (const fn of this.closeHandlers) { try { fn(); } catch {} }
    });
  }

  #onMessage(ev) {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(p.method + ': ' + (msg.error.message || JSON.stringify(msg.error))));
      else p.resolve(msg.result || {});
      return;
    }
    const fns = this.handlers.get(msg.method);
    if (fns) for (const fn of fns) { try { fn(msg.params || {}, msg.sessionId); } catch {} }
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (this.closed || this.ws.readyState !== 1) { reject(new Error('CDP connection is not open (' + method + ')')); return; }
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ': timeout')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  onClose(fn) { this.closeHandlers.push(fn); }

  close() { try { this.ws.close(); } catch {} }
}

// Runtime.evaluate in a flat session; throws on a page-side exception.
export async function evaluate(conn, sessionId, expression, timeoutMs = 15000) {
  const r = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId, timeoutMs);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('page exception: ' + ((d.exception && d.exception.description) || d.text || 'unknown'));
  }
  return r.result ? r.result.value : undefined;
}

export async function httpJson(port, route, timeoutMs = 3000) {
  const r = await fetch('http://127.0.0.1:' + port + route, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + route);
  return r.json();
}

function run(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (err) { return (err && err.stdout) ? String(err.stdout) : ''; }
}

function realpathOr(p) { try { return fs.realpathSync(p); } catch { return p; } }

export function listenerPids(port) {
  const out = run('/usr/sbin/lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fp']);
  return [...new Set(out.split('\n').filter(l => l.startsWith('p')).map(l => Number(l.slice(1))).filter(Boolean))];
}

export function processExe(pid) { return run('/bin/ps', ['-o', 'comm=', '-p', String(pid)]).trim(); }
function parentPid(pid) { return Number(run('/bin/ps', ['-o', 'ppid=', '-p', String(pid)]).trim()) || 0; }

function descendsFrom(pid, ancestor) {
  let p = pid;
  for (let i = 0; i < 8 && p > 1; i++) {
    p = parentPid(p);
    if (p === ancestor) return true;
  }
  return false;
}

// Which process owns the port. The listening socket can be inherited by the app's
// own children (e.g. a helper service), so exactly one listener must be the app's
// main executable and every other listener must descend from it.
export function portOwner(port, app = DEFAULT_APP) {
  const macosDir = realpathOr(path.join(app, 'Contents', 'MacOS'));
  const pids = listenerPids(port);
  if (!pids.length) throw new IdentityError('nothing is listening on 127.0.0.1:' + port);
  const mains = pids.filter(pid => path.dirname(realpathOr(processExe(pid))) === macosDir);
  if (mains.length !== 1) {
    const who = pids.map(pid => pid + ' ' + (processExe(pid) || '?')).join('; ');
    throw new IdentityError('port ' + port + ' is not owned by ' + app + ' (listeners: ' + who + ')');
  }
  const appPid = mains[0];
  const strangers = pids.filter(pid => pid !== appPid && !descendsFrom(pid, appPid));
  if (strangers.length) throw new IdentityError('port ' + port + ' is also held by unrelated processes: ' + strangers.join(', '));
  return { pid: appPid, exe: realpathOr(processExe(appPid)) };
}

// Full identity check. Returns an open browser-level connection to reuse, or
// throws IdentityError. Order: port owner -> /json/version -> shell page target ->
// shell globals inside that page.
export async function verifyIdentity({ port, app = DEFAULT_APP }) {
  const owner = portOwner(port, app);

  let ver;
  try { ver = await httpJson(port, '/json/version'); }
  catch (err) { throw new IdentityError('no DevTools endpoint on port ' + port + ': ' + err.message); }
  if (!/^(Headless)?Chrome\//.test(String(ver.Browser || '')) || !ver.webSocketDebuggerUrl) {
    throw new IdentityError('port ' + port + ' does not speak CDP (Browser=' + ver.Browser + ')');
  }

  const list = await httpJson(port, '/json/list');
  const page = (list || []).find(t => t.type === 'page' && t.url === SHELL_URL);
  if (!page) throw new IdentityError('no ' + SHELL_URL + ' page target on port ' + port + ' (is the main window open?)');

  const conn = await CdpConnection.connect(ver.webSocketDebuggerUrl);
  try {
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId: page.id, flatten: true });
    let ok;
    try { ok = await evaluate(conn, sessionId, SHELL_CHECK); }
    finally { await conn.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
    if (ok !== true) throw new IdentityError('the ' + SHELL_URL + ' page does not look like the ChatGPT/Codex shell');
  } catch (err) {
    conn.close();
    throw err;
  }
  return { appPid: owner.pid, exe: owner.exe, browser: ver.Browser, browserWsUrl: ver.webSocketDebuggerUrl, pageTargetId: page.id, conn };
}
