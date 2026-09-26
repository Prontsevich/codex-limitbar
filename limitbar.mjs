#!/usr/bin/env node
// limitbar.mjs — the codex-limitbar agent. Attaches to a ChatGPT desktop app that was
// launched with --remote-debugging-port, injects bar.js into the app-shell page(s)
// over CDP, and keeps it fed with live Codex rate limits read from the app's bundled
// `codex app-server`. Runs until the app quits (or SIGTERM, which removes the bar).
//
// usage: node limitbar.mjs --port <p> [--app <ChatGPT.app>] [--log <path>]
//                          [--capture <png>] [--once]
//   --port      the app's --remote-debugging-port
//   --app       app bundle to verify the port owner against (default /Applications/ChatGPT.app)
//   --log       append log lines here instead of stdout
//   --capture   save a PNG of the main window after the first live limits push
//   --once      inject + one limits push (+ capture), then disconnect, leaving the bar
//               in place until the next window reload
//
// Node >= 22 (global WebSocket). Dependency-free.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_APP, IdentityError, evaluate, isShellUrl, verifyIdentity } from './lib/cdp.mjs';
import { findCodex, killChildren, parseLimits, rpcFetch } from './lib/limits.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'usage: node limitbar.mjs --port <p> [--app <ChatGPT.app>] [--log <path>] [--capture <png>] [--once]';
const STATE_DIR = process.env.CODEX_LIMITBAR_STATE_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'spr-limitbar');
const STATE_FILE = path.join(STATE_DIR, 'agent.json');

const POLL_MS = 5 * 60 * 1000;
const TICK_MS = 30 * 1000;
const WAKE_GAP_MS = 90 * 1000;       // a tick that arrives this late means the Mac slept
const RECONNECT_MS = 30 * 1000;      // how long to wait for the app to come back on the same port
const MANUAL_MIN_MS = 10 * 1000;     // manual refreshes closer than this reuse the last read
const BINDING = '__sprBarRefreshBinding';   // page -> agent channel for the panel's refresh button

function parseArgs(argv) {
  const o = { app: DEFAULT_APP, bar: path.join(HERE, 'bar.js'), once: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v == null) { console.error(USAGE); process.exit(2); } return v; };
    if (a === '--port') o.port = Number(next());
    else if (a === '--app') o.app = next();
    else if (a === '--log') o.log = next();
    else if (a === '--capture') o.capture = next();
    else if (a === '--bar') o.bar = next();            // testing hook, undocumented
    else if (a === '--once') o.once = true;
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else { console.error('unknown argument: ' + a + '\n' + USAGE); process.exit(2); }
  }
  if (!Number.isInteger(o.port) || o.port <= 0 || o.port > 65535) { console.error(USAGE); process.exit(2); }
  return o;
}

const opts = parseArgs(process.argv.slice(2));

function say(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  if (opts.log) {
    try { fs.mkdirSync(path.dirname(opts.log), { recursive: true }); fs.appendFileSync(opts.log, line + '\n'); } catch {}
  } else {
    console.log(line);
  }
}

function writeState(extra) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(Object.assign({ pid: process.pid, port: opts.port, app: opts.app }, extra), null, 1) + '\n');
  } catch (err) { say('state write ERR: ' + err.message); }
}

function removeState() {
  try {
    const cur = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (cur.pid === process.pid) fs.unlinkSync(STATE_FILE);
  } catch {}
}

function readBar() {
  const source = fs.readFileSync(opts.bar, 'utf8');
  const m = /BAR_VERSION\s*=\s*(\d+)/.exec(source);
  return { source, version: m ? Number(m[1]) : null };
}

const HAS_BAR = "typeof window.__sprBarSetLimits === 'function'";
const REMOVE_BAR = 'window.__sprBarRemove && window.__sprBarRemove()';
const REFRESH_DONE = 'window.__sprBarRefreshDone && window.__sprBarRefreshDone()';

class Agent {
  constructor(bar) {
    this.bar = bar;
    this.conn = null;
    this.appPid = null;
    this.sessions = new Map();     // targetId -> {sessionId, scriptId, url}
    this.attaching = new Map();   // targetId -> in-flight attach promise
    this.limits = null;
    this.polling = null;
    this.lastPollAt = 0;
    this.stopping = false;
    this.stateWritten = false;
    this.codexBin = null;
  }

  limitsJs() {
    if (!this.limits) return null;
    return 'window.__sprBarSetLimits && window.__sprBarSetLimits(' + JSON.stringify(this.limits.limits) + ',' + JSON.stringify(this.limits.meta) + ')';
  }

  async connect() {
    const id = await verifyIdentity({ port: opts.port, app: opts.app });
    this.conn = id.conn;
    this.appPid = id.appPid;
    say('identity ok: app pid=' + id.appPid + ' exe=' + id.exe + ' browser=' + id.browser + ' port=' + opts.port);

    const c = this.conn;
    c.on('Target.targetCreated', ({ targetInfo }) => this.onTarget(targetInfo));
    c.on('Target.targetInfoChanged', ({ targetInfo }) => this.onTarget(targetInfo));
    c.on('Target.targetDestroyed', ({ targetId }) => this.sessions.delete(targetId));
    c.on('Target.detachedFromTarget', ({ sessionId }) => {
      for (const [tid, s] of this.sessions) if (s.sessionId === sessionId) this.sessions.delete(tid);
    });
    c.on('Page.loadEventFired', (_p, sessionId) => this.onLoad(sessionId));
    c.on('Runtime.bindingCalled', (p, sessionId) => { if (p && p.name === BINDING) this.onRefreshRequest(sessionId); });
    c.onClose(() => this.onClosed());

    await c.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await c.send('Target.getTargets');
    await Promise.all((targetInfos || []).map(t => this.onTarget(t)));
    if (!this.sessions.size) throw new Error('no eligible shell page to inject into');
  }

  eligible(t) { return t && t.type === 'page' && isShellUrl(t.url); }

  async onTarget(t) {
    if (this.stopping || !t) return;
    const s = this.sessions.get(t.targetId);
    if (this.eligible(t)) {
      if (!s) await this.attach(t);
      else s.url = t.url;
    } else if (s) {
      // navigated away from the shell: drop our script, leave the page alone
      this.sessions.delete(t.targetId);
      await this.conn.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: s.scriptId }, s.sessionId).catch(() => {});
      await this.conn.send('Runtime.removeBinding', { name: BINDING }, s.sessionId).catch(() => {});
      await this.conn.send('Target.detachFromTarget', { sessionId: s.sessionId }).catch(() => {});
      say('released target ' + t.targetId.slice(0, 8) + ' (url no longer eligible)');
    }
  }

  // Concurrent callers (the targetCreated burst from setDiscoverTargets and our own
  // getTargets pass) share one in-flight attach per target.
  attach(t) {
    const inflight = this.attaching.get(t.targetId);
    if (inflight) return inflight;
    const p = this.doAttach(t).finally(() => this.attaching.delete(t.targetId));
    this.attaching.set(t.targetId, p);
    return p;
  }

  async doAttach(t) {
    try {
      const c = this.conn;
      const { sessionId } = await c.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      await c.send('Page.enable', {}, sessionId);
      await c.send('Runtime.enable', {}, sessionId);
      // Before the bar runs, so it sees the refresh channel. A --once client never
      // listens, so it adds none (the bar then hides its refresh button).
      if (!opts.once) await c.send('Runtime.addBinding', { name: BINDING }, sessionId);
      const { identifier } = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: this.bar.source }, sessionId);
      const s = { sessionId, scriptId: identifier, url: t.url, targetId: t.targetId };
      this.sessions.set(t.targetId, s);
      await this.inject(s, 'attach');
    } catch (err) {
      say('attach ERR target=' + t.targetId.slice(0, 8) + ': ' + err.message);
    }
  }

  async inject(s, why) {
    try {
      await evaluate(this.conn, s.sessionId, this.bar.source);
      say('injected target=' + s.targetId.slice(0, 8) + ' (' + why + ') bar=v' + this.bar.version + ' url=' + String(s.url).slice(0, 80));
      if (!this.stateWritten && !opts.once) {   // --once runs beside a live agent: never touch its state
        this.stateWritten = true;
        writeState({ appPid: this.appPid, barVersion: this.bar.version, startedAt: new Date().toISOString() });
      }
      await this.pushTo(s);
    } catch (err) {
      say('inject ERR target=' + s.targetId.slice(0, 8) + ': ' + err.message);
    }
  }

  // After a reload the new-document script has already run; re-evaluate only if the
  // bar's hooks are missing, then push the latest numbers.
  async onLoad(sessionId) {
    const s = [...this.sessions.values()].find(x => x.sessionId === sessionId);
    if (!s || this.stopping) return;
    try {
      const present = await evaluate(this.conn, sessionId, HAS_BAR);
      if (!present) await this.inject(s, 'reload');
      else { say('reload: bar present in target=' + s.targetId.slice(0, 8)); await this.pushTo(s); }
    } catch (err) { say('reload check ERR: ' + err.message); }
  }

  async pushTo(s) {
    const js = this.limitsJs();
    if (!js) return;
    try { await evaluate(this.conn, s.sessionId, js); } catch (err) { say('push ERR target=' + s.targetId.slice(0, 8) + ': ' + err.message); }
  }

  async pushAll() { await Promise.all([...this.sessions.values()].map(s => this.pushTo(s))); }

  // A failed read keeps the last good numbers on screen (the bar marks them stale and
  // shows the error in its tooltip); with no numbers yet it shows "limits unavailable".
  async pushError(error) {
    const prev = this.limits;
    this.limits = {
      limits: prev ? prev.limits : [],
      meta: Object.assign({ live: false, planType: null, resetCredits: null, updatedAtMs: null }, prev && prev.meta, { error: String(error).slice(0, 200) })
    };
    await this.pushAll();
  }

  // The panel's refresh button. Throttled: a request right after a read re-pushes the
  // current numbers instead of spawning another app-server.
  async onRefreshRequest(sessionId) {
    const s = [...this.sessions.values()].find(x => x.sessionId === sessionId);
    if (!s || this.stopping) return;
    if (this.polling) await this.polling;
    else if (Date.now() - this.lastPollAt >= MANUAL_MIN_MS) await this.poll('manual');
    else { say('manual refresh throttled (last read ' + Math.round((Date.now() - this.lastPollAt) / 1000) + ' s ago)'); await this.pushTo(s); }
    await evaluate(this.conn, sessionId, REFRESH_DONE).catch(() => {});
  }

  poll(reason) {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      this.lastPollAt = Date.now();
      const bin = findCodex({ app: opts.app });
      if (bin !== this.codexBin) { this.codexBin = bin; say('limits source: ' + (bin || 'none')); }
      if (!bin) { say('limits: codex binary not found'); await this.pushError('codex binary not found'); return; }
      const out = await rpcFetch(bin);
      if (out.error) { say('limits ERR (' + reason + ') via ' + bin + ': ' + out.error); await this.pushError(out.error); return; }
      const parsed = parseLimits(out.result);
      if (parsed.error) { say('limits parse ERR: ' + parsed.error); await this.pushError(parsed.error); return; }
      this.limits = parsed;
      say('limits live (' + reason + '): ' + parsed.limits.map(l => l.name + ' ' + Math.round(l.usedPercent) + '%').join(', ') + ' · plan=' + parsed.meta.planType);
      await this.pushAll();
    })().finally(() => { this.polling = null; });
    return this.polling;
  }

  startTimers() {
    let last = Date.now();
    this.tick = setInterval(() => {
      const now = Date.now();
      const gap = now - last;
      last = now;
      if (gap > WAKE_GAP_MS) this.poll('wake');
      else if (now - this.lastPollAt >= POLL_MS) this.poll('interval');
    }, TICK_MS);
  }

  async capture(file) {
    const s = [...this.sessions.values()].find(x => x.url === 'app://-/index.html') || [...this.sessions.values()][0];
    if (!s) { say('capture skipped: no session'); return; }
    try {
      await new Promise(r => setTimeout(r, 800));
      const { data } = await this.conn.send('Page.captureScreenshot', { format: 'png' }, s.sessionId);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      say('capture saved: ' + file);
    } catch (err) { say('capture ERR: ' + err.message); }
  }

  async onClosed() {
    if (this.stopping || this.reconnecting) return;
    this.reconnecting = true;
    this.sessions.clear();
    this.stateWritten = false;
    say('browser connection closed (app quit or relaunched)');
    // The app may relaunch itself with the same argv (e.g. its Node permission-model
    // restart); reattach if the same port comes back owned by the app.
    const until = Date.now() + RECONNECT_MS;
    while (Date.now() < until && !this.stopping) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        await this.connect();
        this.reconnecting = false;
        say('reattached after relaunch');
        this.poll('reattach');
        return;
      } catch (err) {
        if (this.conn && !this.conn.closed) this.conn.close();
      }
    }
    say('app did not come back on port ' + opts.port + '; exiting');
    removeState();
    process.exit(0);
  }

  // Graceful stop: remove the bar live, drop the new-document scripts, detach.
  async stop(reason) {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.tick);
    say('stopping (' + reason + '): removing the bar from ' + this.sessions.size + ' page(s)');
    const guard = setTimeout(() => { removeState(); process.exit(0); }, 4000);
    if (this.conn && !this.conn.closed) {
      await Promise.all([...this.sessions.values()].map(async s => {
        await evaluate(this.conn, s.sessionId, REMOVE_BAR, 2000).catch(() => {});
        await this.conn.send('Runtime.removeBinding', { name: BINDING }, s.sessionId, 2000).catch(() => {});
        await this.conn.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: s.scriptId }, s.sessionId, 2000).catch(() => {});
        await this.conn.send('Target.detachFromTarget', { sessionId: s.sessionId }, undefined, 2000).catch(() => {});
      }));
      this.conn.close();
    }
    clearTimeout(guard);
    removeState();
    say('stopped');
    process.exit(0);
  }
}

async function main() {
  process.on('exit', killChildren);   // no app-server child outlives the agent
  let bar;
  try { bar = readBar(); }
  catch (err) { say('cannot read ' + opts.bar + ': ' + err.message); process.exit(2); }
  const agent = new Agent(bar);
  try {
    await agent.connect();
  } catch (err) {
    say((err instanceof IdentityError ? 'REFUSING: ' : 'connect ERR: ') + err.message);
    process.exit(err instanceof IdentityError ? 3 : 2);
  }

  if (opts.once) {
    await agent.poll('initial');
    if (opts.capture) await agent.capture(opts.capture);
    agent.stopping = true;               // disconnect without removing the bar
    agent.conn.close();
    say('once: done (bar stays until the next window reload)');
    process.exit(0);
  }

  // No SIGHUP handler: start.sh runs the agent under nohup, and a handler would undo that.
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => agent.stop(sig));
  say('agent pid=' + process.pid + ' running; bar=v' + bar.version + ' pollMin=' + POLL_MS / 60000);
  agent.startTimers();
  await agent.poll('initial');
  if (opts.capture) await agent.capture(opts.capture);
}

main();
