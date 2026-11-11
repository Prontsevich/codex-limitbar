#!/usr/bin/env node
// limitbar.mjs — the codex-limitbar agent. Attaches to a ChatGPT desktop app that was
// launched with --remote-debugging-port, injects bar.js into the app-shell page(s)
// over CDP, and keeps it fed with live Codex rate limits from the app or a direct
// `codex app-server` read. Runs until the app quits (or SIGTERM, which removes the bar).
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
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_APP, SHELL_URL, IdentityError, evaluate, isShellUrl, portOwner, verifyIdentity } from './lib/cdp.mjs';
import { findCodex, killChildren, parseLimits, rpcFetch } from './lib/limits.mjs';
import { watchNativeLimits } from './lib/native-limits.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'usage: node limitbar.mjs --port <p> [--app <ChatGPT.app>] [--log <path>] [--capture <png>] [--once]';
const STATE_DIR = process.env.CODEX_LIMITBAR_STATE_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'spr-limitbar');
const STATE_FILE = path.join(STATE_DIR, 'agent.json');
// The last limits read. The page compares it with its first fresh snapshot, so a roll that
// happened while the app was closed is still announced on the next start.
const SNAPSHOT_FILE = path.join(STATE_DIR, 'limits.json');
const SNAPSHOT_MAX_AGE_MS = 30 * 86400000;   // older than this cannot describe a live cycle

const POLL_MS = 5 * 60 * 1000;
const FOREGROUND_MAX_AGE_MS = 60 * 1000;
const RESET_GRACE_MS = 5 * 1000;
const RESET_TIME_TOLERANCE_MS = 60 * 1000;
const CREDIT_DETAILS_MAX_AGE_MS = 15 * 60 * 1000;
const TICK_MS = 30 * 1000;
const WAKE_GAP_MS = 90 * 1000;       // a tick that arrives this late means the Mac slept
const RECONNECT_MS = 30 * 1000;      // how long to wait for the app to come back on the same port
const MANUAL_MIN_MS = 10 * 1000;     // manual refreshes closer than this reuse the last read
const BINDING = '__sprBarRefreshBinding';   // page -> agent channel for limits and refresh signals

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

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const opts = IS_MAIN ? parseArgs(process.argv.slice(2)) : { app: DEFAULT_APP, once: false };

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

function fmtGap(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? m + 'm' : Math.round(m / 60) + 'h';
}

function readSnapshot() {
  try {
    const s = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    if (!s || !Array.isArray(s.limits) || !(Date.now() - Number(s.atMs) < SNAPSHOT_MAX_AGE_MS)) return null;
    return { atMs: Number(s.atMs), limits: s.limits, accountScope: s.accountScope ?? null };
  } catch { return null; }
}

function writeSnapshot(snapshot) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot) + '\n');
  } catch (err) { say('snapshot write ERR: ' + err.message); }
}

function readBar() {
  const source = fs.readFileSync(opts.bar, 'utf8');
  const m = /BAR_VERSION\s*=\s*(\d+)/.exec(source);
  return { source, version: m ? Number(m[1]) : null };
}

const HAS_BAR = "typeof window.__sprBarSetLimits === 'function'";
const REMOVE_BAR = 'try { window.__sprBarStopNative?.(); } finally { window.__sprBarRemove?.(true); }';
const REFRESH_DONE = 'window.__sprBarRefreshDone && window.__sprBarRefreshDone()';

export class Agent {
  constructor(bar) {
    this.bar = bar;
    this.conn = null;
    this.appPid = null;
    this.sessions = new Map();     // targetId -> {sessionId, scriptId, url}
    this.attaching = new Map();   // targetId -> in-flight attach promise
    this.limits = null;
    this.polling = null;
    this.lastPollAt = 0;
    this.nativeRevision = 0;
    this.accountId = null;
    this.creditDetails = null;
    this.directBaseline = null;
    this.stopping = false;
    this.stateWritten = false;
    this.codexBin = null;
    this.reconnecting = false;
    this.prev = readSnapshot();   // the last read of the previous run, if any
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
    // Events queued by an old socket must not delete sessions on its replacement.
    const current = fn => (...args) => { if (this.conn === c && !this.stopping) return fn(...args); };
    c.on('Target.targetCreated', current(({ targetInfo }) => this.onTarget(targetInfo)));
    c.on('Target.targetInfoChanged', current(({ targetInfo }) => this.onTarget(targetInfo)));
    c.on('Target.targetDestroyed', current(({ targetId }) => this.sessions.delete(targetId)));
    c.on('Target.detachedFromTarget', current(({ sessionId }) => {
      for (const [tid, s] of this.sessions) if (s.sessionId === sessionId) this.sessions.delete(tid);
    }));
    c.on('Page.loadEventFired', current((_p, sessionId) => this.onLoad(sessionId)));
    c.on('Runtime.bindingCalled', current((p, sessionId) => {
      if (p?.name === BINDING) this.onBinding(p.payload, sessionId);
    }));
    c.onClose(current(() => this.onClosed()));

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
      await s.conn.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: s.scriptId }, s.sessionId).catch(() => {});
      await s.conn.send('Runtime.removeBinding', { name: BINDING }, s.sessionId).catch(() => {});
      await s.conn.send('Target.detachFromTarget', { sessionId: s.sessionId }).catch(() => {});
      say('released target ' + t.targetId.slice(0, 8) + ' (url no longer eligible)');
    }
  }

  // Concurrent callers (the targetCreated burst from setDiscoverTargets and our own
  // getTargets pass) share one in-flight attach per target.
  attach(t) {
    const inflight = this.attaching.get(t.targetId);
    if (inflight) return inflight;
    const p = this.doAttach(t).finally(() => {
      if (this.attaching.get(t.targetId) === p) this.attaching.delete(t.targetId);
    });
    this.attaching.set(t.targetId, p);
    return p;
  }

  async doAttach(t) {
    const c = this.conn;
    try {
      const { sessionId } = await c.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      await c.send('Page.enable', {}, sessionId);
      await c.send('Runtime.enable', {}, sessionId);
      // Before the bar runs, so it sees the refresh channel. A --once client never
      // listens, so it adds none (the bar then hides its refresh button).
      if (!opts.once) await c.send('Runtime.addBinding', { name: BINDING }, sessionId);
      const token = opts.once ? null : randomUUID();
      const source = token
        ? this.bar.source + '\n;(' + watchNativeLimits.toString() + ')(' + JSON.stringify(token) + ');'
        : this.bar.source;
      const { identifier } = await c.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
      if (c !== this.conn || this.stopping) return;
      const s = { conn: c, sessionId, scriptId: identifier, url: t.url, targetId: t.targetId, token, source };
      this.sessions.set(t.targetId, s);
      await this.inject(s, 'attach');
    } catch (err) {
      say('attach ERR target=' + t.targetId.slice(0, 8) + ': ' + err.message);
      if (this.sessions.get(t.targetId)?.conn === c) this.sessions.delete(t.targetId);
      this.recoverConnection(c, err.message);
    }
  }

  async inject(s, why) {
    if (s.conn !== this.conn || this.stopping) return;
    try {
      await evaluate(s.conn, s.sessionId, s.source);
      if (s.conn !== this.conn || this.stopping) return;
      say('injected target=' + s.targetId.slice(0, 8) + ' (' + why + ') bar=v' + this.bar.version + ' url=' + String(s.url).slice(0, 80));
      if (!this.stateWritten && !opts.once) {   // --once runs beside a live agent: never touch its state
        this.stateWritten = true;
        writeState({ appPid: this.appPid, barVersion: this.bar.version, startedAt: new Date().toISOString() });
      }
      await this.pushTo(s);
    } catch (err) {
      say('inject ERR target=' + s.targetId.slice(0, 8) + ': ' + err.message);
      this.recoverConnection(s.conn, err.message);
      throw err;
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
    } catch (err) { say('reload check ERR: ' + err.message); this.recoverConnection(s.conn, err.message); }
  }

  async pushTo(s) {
    const js = this.limitsJs();
    if (!js || s.conn !== this.conn || this.stopping) return;
    try { await evaluate(s.conn, s.sessionId, js); }
    catch (err) {
      say('push ERR target=' + s.targetId.slice(0, 8) + ': ' + err.message);
      this.recoverConnection(s.conn, err.message);
    }
  }

  recoverConnection(conn, reason) {
    if (opts.once || !this.tick || this.stopping || this.reconnecting || conn !== this.conn) return;
    // Page exceptions are payload bugs, not a broken transport. Reconnecting would
    // repeat them forever. A transport timeout can leave the WebSocket open.
    if (reason.startsWith('page exception:')) return;
    say('CDP recovery: ' + reason);
    this.onClosed(); // Start recovery even if the old socket's close handshake hangs.
    conn.close();
  }

  async pushAll() { await Promise.all([...this.sessions.values()].map(s => this.pushTo(s))); }

  mainSession() {
    const sessions = [...this.sessions.values()];
    return sessions.find(s => s.url === SHELL_URL) || sessions[0];
  }

  hasFreshNative(now = Date.now()) {
    const at = this.mainSession()?.nativeAt;
    return !!at && now - at < POLL_MS;
  }

  onBinding(payload, sessionId) {
    const s = [...this.sessions.values()].find(x => x.sessionId === sessionId);
    if (!s || this.stopping) return;
    if (payload === 'refresh') return this.onRefreshRequest(s);
    const now = Date.now();
    if (payload === 'panel' || payload === 'foreground') {
      const meta = this.limits?.meta;
      if ((!meta?.live || meta.error || now - meta.updatedAtMs >= FOREGROUND_MAX_AGE_MS)
          && now - this.lastPollAt >= MANUAL_MIN_MS) return this.poll(payload);
      return;
    }
    if (s !== this.mainSession() || !s.token || typeof payload !== 'string' || payload.length > 8192) return;
    let msg;
    try { msg = JSON.parse(payload); } catch { return; }
    if (msg?.token !== s.token) return;
    if (msg.accountId !== null
        && (typeof msg.accountId !== 'string' || !msg.accountId || msg.accountId.length > 128)) return;
    if (msg.result === null) {
      if (s.nativeAccountId !== msg.accountId) this.nativeRevision++;
      s.nativeAt = 0;
      // An ambiguous cache does not authorize switching to the CLI's account.
      s.nativeAccountId = msg.accountId ?? s.nativeAccountId;
      return;
    }
    const at = msg.updatedAtMs;
    if (!msg.accountId || !Number.isSafeInteger(at) || at <= 0 || at > now) return;
    if (msg.accountId === s.nativeAccountId && at < s.nativeAt) return;
    const parsed = parseLimits(msg.result, at);
    if (parsed.error) return;
    const accountChanged = !!this.accountId && this.accountId !== msg.accountId;
    const scopeChanged = s.nativeAccountId !== msg.accountId;
    s.nativeAccountId = msg.accountId;
    const behind = this.nativeSnapshotIsBehind(parsed.limits, msg.accountId);
    s.nativeAt = behind ? 0 : at;
    const useSnapshot = !behind && now - at < POLL_MS
      && (accountChanged || at > (this.limits?.meta.updatedAtMs || 0));
    if (scopeChanged || useSnapshot) this.nativeRevision++;
    if (!useSnapshot) return;
    return this.acceptLimits(parsed, 'native', msg.accountId);
  }

  nativeSnapshotIsBehind(windows, accountId) {
    const displayed = this.accountId === accountId ? this.limits?.limits : null;
    const direct = this.directBaseline?.accountId === accountId ? this.directBaseline.limits : null;
    // A native refetch can replay its last snapshot with a new cache timestamp.
    return windows.some(next => {
      const sameWindow = previous => previous.windowDurationMins === next.windowDurationMins;
      const shown = displayed?.find(sameWindow);
      if (next.resetsAtMs && shown?.resetsAtMs && next.resetsAtMs < shown.resetsAtMs - RESET_TIME_TOLERANCE_MS) return true;
      const baseline = direct?.find(sameWindow);
      if (!baseline || next.usedPercent >= baseline.usedPercent) return false;
      return !(next.resetsAtMs && baseline.resetsAtMs && next.resetsAtMs > baseline.resetsAtMs + RESET_TIME_TOLERANCE_MS);
    });
  }

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
  async onRefreshRequest(s) {
    if (this.polling) await this.polling;
    else if (Date.now() - this.lastPollAt >= MANUAL_MIN_MS) await this.poll('manual');
    else { say('manual refresh throttled (last read ' + Math.round((Date.now() - this.lastPollAt) / 1000) + ' s ago)'); await this.pushTo(s); }
    if (s.conn === this.conn) await evaluate(s.conn, s.sessionId, REFRESH_DONE).catch(() => {});
  }

  usableCreditDetails(count, now = Date.now()) {
    const details = this.creditDetails;
    if (details && details.accountId === this.mainSession()?.nativeAccountId && details.count === count
        && now - details.atMs < CREDIT_DETAILS_MAX_AGE_MS
        && (!details.fields.resetCreditsNextExpiresAtMs || details.fields.resetCreditsNextExpiresAtMs > now)) return details.fields;
  }

  async acceptLimits(parsed, reason, accountId) {
    const accountChanged = !!(this.accountId && accountId && this.accountId !== accountId);
    if (accountId) this.accountId = accountId;
    const accountScope = accountId ? createHash('sha256').update('spr-limitbar account\0' + accountId).digest('hex') : null;
    const prev = this.prev?.accountScope === accountScope ? this.prev : null;
    const atMs = parsed.meta.updatedAtMs;
    const native = reason === 'native';
    if (!native) this.directBaseline = { accountId, limits: parsed.limits };
    const windows = JSON.stringify(parsed.limits);
    const persist = !native || !prev || atMs - prev.atMs >= POLL_MS || windows !== JSON.stringify(prev.limits);
    // A newly loaded bar can still compare against the most recent persisted window.
    parsed.meta.prevLimits = prev?.limits ?? null;
    parsed.meta.prevAtMs = prev?.atMs ?? null;
    parsed.meta.source = native ? 'native' : 'app-server';
    parsed.meta.accountChanged = accountChanged;
    if (native && !parsed.meta.resetCreditsList.length) {
      Object.assign(parsed.meta, this.usableCreditDetails(parsed.meta.resetCredits));
    }
    if (persist || this.limits?.meta.source !== 'native') {
      say('limits live (' + reason + '): ' + parsed.limits.map(l => l.name + ' ' + Math.round(l.usedPercent) + '%').join(', ') + ' · plan=' + parsed.meta.planType);
    }
    if (reason === 'initial') say('prev snapshot: ' + (prev ? fmtGap(Date.now() - prev.atMs) + ' old' : 'none'));
    this.limits = parsed;
    if (persist) {
      this.prev = { atMs, limits: parsed.limits, accountScope };
      if (!opts.once) writeSnapshot(this.prev);
    }
    await this.pushAll();
  }

  poll(reason) {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      const nativeRevision = this.nativeRevision;
      const session = this.mainSession();
      this.lastPollAt = Date.now();
      const bin = findCodex({ app: opts.app });
      if (bin !== this.codexBin) { this.codexBin = bin; say('limits source: ' + (bin || 'none')); }
      const out = bin ? await rpcFetch(bin) : { error: 'codex binary not found' };
      if (session === this.mainSession()) await this.applyDirectRead(out, reason, nativeRevision);
    })().finally(() => { this.polling = null; });
    return this.polling;
  }

  async applyDirectRead(out, reason, nativeRevision) {
    if (this.stopping) return;
    const accountId = out.result?.accountId;
    const nativeAccount = this.mainSession()?.nativeAccountId;
    const fresh = this.hasFreshNative();
    const keepNative = nativeRevision !== this.nativeRevision || (fresh && reason === 'credit-details');
    const parsed = out.error ? out : parseLimits(out.result);
    if (!parsed.error && nativeAccount && accountId !== nativeAccount) {
      parsed.error = 'Direct read did not match the active ChatGPT account';
    }
    if (parsed.error) {
      say('limits ERR (' + reason + '): ' + parsed.error);
      if (!keepNative && (!fresh || reason === 'manual')) await this.pushError(parsed.error);
      return;
    }
    const { resetCredits: count, resetCreditsList, resetCreditTitle, resetCreditsNextExpiresAtMs } = parsed.meta;
    if (accountId && count > 0) {
      this.creditDetails = {
        accountId, count, atMs: parsed.meta.updatedAtMs,
        fields: { resetCreditsList, resetCreditTitle, resetCreditsNextExpiresAtMs },
      };
    }
    if (!keepNative) return this.acceptLimits(parsed, reason, accountId);
    const current = this.limits;
    const details = this.usableCreditDetails(current?.meta.resetCredits);
    if (details && this.accountId === nativeAccount && current.meta.source === 'native' && !current.meta.resetCreditsList.length) {
      Object.assign(current.meta, details);
      await this.pushAll();
    }
    if (reason === 'manual') say('limits read (manual): kept newer native snapshot');
  }

  startTimers() {
    let last = Date.now();
    this.tick = setInterval(() => {
      const now = Date.now();
      const gap = now - last;
      last = now;
      if (gap > WAKE_GAP_MS) this.recoverConnection(this.conn, 'wake after ' + Math.round(gap / 1000) + ' s');
      else if (!this.sessions.size) this.recoverConnection(this.conn, 'no attached shell pages');
      else if (this.limits?.limits.some(({ resetsAtMs, usedPercent }) =>
        usedPercent > 0 && resetsAtMs > 0 && resetsAtMs + RESET_GRACE_MS > this.lastPollAt
        && now >= resetsAtMs + RESET_GRACE_MS)) this.poll('reset');
      else if (now - this.lastPollAt >= POLL_MS) {
        if (!this.hasFreshNative(now)) this.poll('interval');
        else if (this.limits?.meta.resetCredits > 0 && !this.limits.meta.resetCreditsList?.length
            && !this.usableCreditDetails(this.limits.meta.resetCredits, now)) this.poll('credit-details');
      }
    }, TICK_MS);
  }

  async capture(file) {
    const s = this.mainSession();
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
    this.conn = null;
    this.sessions.clear();
    this.attaching.clear();
    this.stateWritten = false;
    say('recovering browser connection');
    // The app may relaunch itself with the same argv (e.g. its Node permission-model
    // restart); reattach if the same port comes back owned by the app.
    let missingSince = Date.now();
    let retryMs = 1000;
    while (!this.stopping) {
      await new Promise(r => setTimeout(r, retryMs));
      if (this.stopping) return;
      try {
        await this.connect();
        this.reconnecting = false;
        say('CDP restored; shell reattached');
        if (!this.hasFreshNative()) {
          if (this.polling) await this.polling;
          if (!this.hasFreshNative() && !this.stopping) this.poll('reattach');
        }
        return;
      } catch (err) {
        say('reattach ERR: ' + err.message);
        const failed = this.conn;
        this.conn = null;
        this.sessions.clear();
        this.attaching.clear();
        if (failed && !failed.closed) failed.close();
        // Keep retrying while the verified app still owns the port. A sleeping or
        // busy renderer can need longer than the app-relaunch grace period.
        try { portOwner(opts.port, opts.app); missingSince = Date.now(); } catch {}
        if (Date.now() - missingSince >= RECONNECT_MS) break;
        retryMs = Math.min(retryMs * 2, TICK_MS);
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
  say('agent pid=' + process.pid + ' running; bar=v' + bar.version + ' fallbackMin=' + POLL_MS / 60000);
  agent.startTimers();
  if (!agent.hasFreshNative()) await agent.poll('initial');
  if (opts.capture) await agent.capture(opts.capture);
}

if (IS_MAIN) main();
