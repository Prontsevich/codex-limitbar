#!/usr/bin/env node
// lib/doctor.mjs — read-only diagnostics for codex-limitbar (`./start.sh --doctor`).
// Checks the machine, the app, the bundled CLI, the live page and the agent, and
// prints one line per check. It never quits/restarts ChatGPT, never starts/stops the
// agent and never changes the page: every page probe is a getter-only evaluate.
// It never prints tokens, account ids, credit ids or raw app-server responses.
//
// usage: node lib/doctor.mjs [--app <ChatGPT.app>] [--log <path>] [--json]
// exit: 0 when no check failed, 1 otherwise.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_APP, SHELL_URL, evaluate, verifyIdentity } from './cdp.mjs';
import { findCodex, killChildren, parseLimits, rpcFetch } from './limits.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const STALE_MS = 15 * 60 * 1000;

// ---- pure helpers (unit-tested) ----------------------------------------------------

export const MARKS = { ok: '✓', warn: '!', fail: '✗', skip: '–' };

// Checks -> counts + exit code (1 when anything failed).
export function summarize(checks) {
  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;
  return { counts, exitCode: counts.fail > 0 ? 1 : 0 };
}

// Human report: one line per check, hint and details indented under it.
export function formatReport(checks) {
  const width = Math.max(0, ...checks.map(c => String(c.label || c.id).length));
  const lines = ['codex-limitbar doctor'];
  for (const c of checks) {
    lines.push((MARKS[c.status] || '?') + ' ' + String(c.label || c.id).padEnd(width) + '  ' + c.summary);
    for (const d of c.details || []) lines.push('    ' + d);
    if (c.hint) lines.push('    → ' + c.hint);
  }
  const { counts } = summarize(checks);
  lines.push('');
  lines.push(counts.fail ? counts.fail + ' failed, ' + counts.warn + ' warning(s)'
    : counts.warn ? 'no failures, ' + counts.warn + ' warning(s)' : 'all checks passed');
  return lines.join('\n');
}

// Defensive redaction for log lines: UUIDs, bearer tokens, long opaque strings.
export function redact(line) {
  return String(line)
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, '<redacted>');
}

export function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + ' s ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 48) return h + ' h ' + (m % 60) + ' min ago';
  return Math.floor(h / 24) + ' d ago';
}

// ---- probes -------------------------------------------------------------------------

function run(cmd, args, timeout = 5000) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

function realpathOr(p) { try { return fs.realpathSync(p); } catch { return p; } }

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + ': timeout after ' + Math.round(ms / 1000) + ' s')), ms); })
  ]);
}

const plist = (app, key) => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]);

function frameworkInfo(app) {
  const dir = path.join(app, 'Contents', 'Frameworks');
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => / Framework\.framework$/.test(n)); } catch {}
  if (!names.length) return null;
  const name = names[0];
  let version = null;
  try { version = fs.readlinkSync(path.join(dir, name, 'Versions', 'Current')); } catch {}
  return { name: name.replace(/\.framework$/, ''), version };
}

function appMainPid(app) {
  const exe = plist(app, 'CFBundleExecutable') || 'ChatGPT';
  const full = path.join(app, 'Contents', 'MacOS', exe);
  const out = run('/usr/bin/pgrep', ['-f', '^' + full.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)']);
  const pid = Number(out.split('\n')[0]) || null;
  return { pid, exe: full };
}

function appPort(pid) {
  const cmd = run('/bin/ps', ['-o', 'command=', '-p', String(pid)]);
  const m = /--remote-debugging-port=(\d+)/.exec(cmd);
  return m ? Number(m[1]) : null;
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function barVersionOnDisk() {
  try { const m = /BAR_VERSION\s*=\s*(\d+)/.exec(fs.readFileSync(path.join(REPO, 'bar.js'), 'utf8')); return m ? Number(m[1]) : null; }
  catch { return null; }
}

// Getter-only page probe: reads layout/theme/bar state, changes nothing.
const PAGE_PROBE = `(() => {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const layout = document.querySelector('[class*="_Layout_"]');
  const lcs = layout ? getComputedStyle(layout) : cs;
  const tok = n => (cs.getPropertyValue(n) || lcs.getPropertyValue(n) || '').trim();
  let bar = null;
  if (typeof window.__sprBarGetState === 'function') {
    try {
      const s = window.__sprBarGetState();
      bar = { version: s.version, live: !!s.live, limits: (s.limits || []).length,
              error: s.meta && s.meta.error ? String(s.meta.error).slice(0, 160) : null };
    } catch (e) { bar = { broken: String(e && e.message || e).slice(0, 160) }; }
  }
  return JSON.stringify({
    url: location.href, theme: root.dataset.theme || null,
    layout: !!layout, card: !!document.querySelector('[class*="_PageSurface_"]'),
    surface: tok('--app-color-background-surface'), fg: tok('--app-color-text-foreground'),
    bars: document.querySelectorAll('#spr-statusbar').length, bar
  });
})()`;

async function runChecks({ app, log, stateDir }) {
  const checks = [];
  const add = c => { checks.push(c); return c; };

  // 1. platform + Node
  const mac = process.platform === 'darwin' ? run('/usr/bin/sw_vers', ['-productVersion']) : '';
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add({
    id: 'system', label: 'System',
    status: process.platform !== 'darwin' || nodeMajor < 22 ? 'fail' : 'ok',
    summary: (process.platform === 'darwin' ? 'macOS ' + (mac || '?') : process.platform + ' (unsupported)') + ' · Node ' + process.versions.node,
    hint: process.platform !== 'darwin' ? 'codex-limitbar supports macOS only'
      : nodeMajor < 22 ? 'install Node.js >= 22 (global WebSocket), or set CODEX_LIMITBAR_NODE' : undefined
  });

  // 2. app bundle
  const appOk = fs.existsSync(path.join(app, 'Contents', 'Info.plist'));
  if (appOk) {
    const fw = frameworkInfo(app);
    add({
      id: 'app', label: 'ChatGPT', status: 'ok',
      summary: (plist(app, 'CFBundleShortVersionString') || '?') + ' (' + (plist(app, 'CFBundleVersion') || '?') + ')'
        + (fw ? ' · ' + fw.name + ' ' + (fw.version || '?') : '') + ' · ' + app
    });
  } else {
    add({ id: 'app', label: 'ChatGPT', status: 'fail', summary: 'not found at ' + app, hint: 'install the ChatGPT desktop app, or set CODEX_LIMITBAR_APP' });
  }

  // 3. bundled CLI
  const bin = appOk ? findCodex({ app }) : null;
  if (!appOk) add({ id: 'cli', label: 'Codex CLI', status: 'skip', summary: 'skipped (no app)' });
  else if (!bin) add({ id: 'cli', label: 'Codex CLI', status: 'fail', summary: 'no codex binary found', hint: 'expected <app>/Contents/Resources/codex-cli/bin/codex (ChatGPT 26.924+)' });
  else {
    const inBundle = realpathOr(bin).startsWith(realpathOr(app) + path.sep);
    add({
      id: 'cli', label: 'Codex CLI', status: inBundle ? 'ok' : 'warn',
      summary: (run(bin, ['--version']) || 'version unknown') + ' · ' + bin,
      hint: inBundle ? undefined : 'the app\'s bundled CLI was not found; using a standalone one from PATH (its location may have moved in a ChatGPT update)'
    });
  }

  // 4. app-server probe (numbers only)
  if (!bin) add({ id: 'limits', label: 'Limits read', status: 'skip', summary: 'skipped (no CLI)' });
  else {
    const out = await rpcFetch(bin, { timeoutMs: 15000 });
    if (out.error) add({ id: 'limits', label: 'Limits read', status: 'fail', summary: 'app-server: ' + out.error, hint: 'sign in inside ChatGPT (or run `codex login`) and retry' });
    else {
      const p = parseLimits(out.result);
      if (p.error) add({ id: 'limits', label: 'Limits read', status: 'fail', summary: 'unexpected response: ' + p.error, hint: 'the protocol may have changed; see skills/codex-limitbar/references/rate-limits-protocol.md' });
      else {
        const m = p.meta;
        add({
          id: 'limits', label: 'Limits read', status: m.usageAllowed ? 'ok' : 'warn',
          summary: 'plan ' + (m.planType || '?') + ' · ' + p.limits.map(l => l.name + ' ' + Math.round(l.usedPercent) + '% used').join(' · ')
            + (m.resetCredits != null ? ' · ' + m.resetCredits + ' reset credit(s)' : '')
            + (m.limitReached ? ' · limit reached' : ''),
          hint: m.usageAllowed ? undefined : 'the account reports ordinary usage as not allowed'
        });
      }
    }
  }

  // 5. running app + CDP port
  const { pid: appPid } = appOk ? appMainPid(app) : { pid: null };
  const port = appPid ? appPort(appPid) : null;
  if (!appOk) add({ id: 'running', label: 'App process', status: 'skip', summary: 'skipped (no app)' });
  else if (!appPid) add({ id: 'running', label: 'App process', status: 'skip', summary: 'ChatGPT is not running', hint: './start.sh opens it with the bar' });
  else if (!port) add({ id: 'running', label: 'App process', status: 'warn', summary: 'pid ' + appPid + ', started without a debugging port', hint: 'run ./start.sh (restarts ChatGPT once)' });
  else add({ id: 'running', label: 'App process', status: 'ok', summary: 'pid ' + appPid + ' · CDP port ' + port + ' (127.0.0.1)' });

  // 6. identity + 7. live page
  let conn = null, targetId = null;
  if (!port) {
    add({ id: 'identity', label: 'Identity', status: 'skip', summary: 'skipped (no debugging port)' });
  } else {
    try {
      const id = await withTimeout(verifyIdentity({ port, app }), 12000, 'identity check');
      conn = id.conn; targetId = id.pageTargetId;
      add({ id: 'identity', label: 'Identity', status: 'ok', summary: 'port owned by ' + id.exe + ' · ' + id.browser + ' · shell page verified' });
    } catch (err) {
      add({ id: 'identity', label: 'Identity', status: 'fail', summary: err.message, hint: 'quit ChatGPT and run ./start.sh again (it picks a fresh port)' });
    }
  }

  const diskVersion = barVersionOnDisk();
  if (!conn) {
    add({ id: 'page', label: 'Shell page', status: 'skip', summary: 'skipped (identity not verified)' });
    add({ id: 'bar', label: 'Bar', status: 'skip', summary: 'skipped (identity not verified)' });
  } else {
    let pg = null, perr = null;
    try {
      const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true }, undefined, 5000);
      try { pg = JSON.parse(await evaluate(conn, sessionId, PAGE_PROBE, 5000)); }
      finally { await conn.send('Target.detachFromTarget', { sessionId }, undefined, 3000).catch(() => {}); }
    } catch (err) { perr = err.message; }
    finally { conn.close(); }

    if (!pg) {
      add({ id: 'page', label: 'Shell page', status: 'fail', summary: 'page probe failed: ' + perr });
      add({ id: 'bar', label: 'Bar', status: 'skip', summary: 'skipped (page probe failed)' });
    } else {
      const tokens = !!(pg.surface && pg.fg);
      add({
        id: 'page', label: 'Shell page', status: pg.layout && tokens ? (pg.card ? 'ok' : 'warn') : 'fail',
        summary: (pg.url === SHELL_URL ? SHELL_URL : pg.url) + ' · layout ' + (pg.layout ? 'found' : 'MISSING')
          + ' · card ' + (pg.card ? 'found' : 'missing') + ' · theme tokens ' + (tokens ? 'ok' : 'MISSING') + ' · theme ' + (pg.theme || '?'),
        hint: !pg.layout ? 'the app layout changed: the bar will not draw (no layout → no bar); bar.js needs an update'
          : !tokens ? 'the app theme tokens changed: bar colors fall back to defaults'
          : !pg.card ? 'content card not found: the bar uses its full-width fallback' : undefined
      });
      const b = pg.bar;
      if (!b) {
        add({ id: 'bar', label: 'Bar', status: 'warn', summary: 'not injected in the page (bars: ' + pg.bars + ')', hint: 'run ./start.sh' });
      } else if (b.broken) {
        add({ id: 'bar', label: 'Bar', status: 'fail', summary: '__sprBarGetState threw: ' + b.broken });
      } else {
        const problems = [];
        if (pg.bars !== 1) problems.push(pg.bars + ' bar nodes (expected 1)');
        if (diskVersion != null && b.version !== diskVersion) problems.push('v' + b.version + ' live vs v' + diskVersion + ' on disk');
        if (!b.live) problems.push(b.error ? 'not live: ' + b.error : 'no live data yet');
        add({
          id: 'bar', label: 'Bar', status: problems.length ? 'warn' : 'ok',
          summary: 'v' + b.version + ' · ' + (b.live ? 'live' : 'not live') + ' · ' + b.limits + ' limit row(s)' + (problems.length ? ' · ' + problems.join('; ') : ''),
          hint: diskVersion != null && b.version !== diskVersion ? 'restart the helper: ./start.sh --stop && ./start.sh'
            : !b.live ? 'see the Limits read check above and the log below' : undefined
        });
      }
    }
  }

  // 8. agent
  const stateFile = path.join(stateDir, 'agent.json');
  let st = null;
  try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  if (!st) {
    add({ id: 'agent', label: 'Agent', status: appPid ? 'warn' : 'skip', summary: 'not running (no ' + stateFile + ')', hint: appPid ? 'run ./start.sh' : undefined });
  } else {
    const alive = Number.isInteger(st.pid) && pidAlive(st.pid) && /limitbar\.mjs/.test(run('/bin/ps', ['-o', 'command=', '-p', String(st.pid)]));
    const issues = [];
    if (!alive) issues.push('pid ' + st.pid + ' is not a running limitbar.mjs (stale state file)');
    else {
      if (appPid && st.appPid !== appPid) issues.push('attached to app pid ' + st.appPid + ', running app is ' + appPid);
      if (port && st.port !== port) issues.push('attached to port ' + st.port + ', app port is ' + port);
    }
    add({
      id: 'agent', label: 'Agent', status: issues.length ? 'warn' : 'ok',
      summary: issues.length ? issues.join('; ') : 'pid ' + st.pid + ' · port ' + st.port + ' · app pid ' + st.appPid + ' · bar v' + st.barVersion + ' · since ' + st.startedAt,
      hint: issues.length ? 'run ./start.sh (it replaces a stale agent)' : undefined
    });
  }

  // 9. log
  let text = null;
  try {
    const fd = fs.openSync(log, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch {}
  if (text == null) {
    add({ id: 'log', label: 'Log', status: 'skip', summary: 'no log yet at ' + log });
  } else {
    const lines = text.split('\n').filter(Boolean);
    const tsOf = l => { const m = /^\[([^\]]+)\]/.exec(l); const t = m ? Date.parse(m[1]) : NaN; return Number.isFinite(t) ? t : null; };
    const lastGood = [...lines].reverse().find(l => /limits live \(/.test(l));
    const lastGoodAt = lastGood ? tsOf(lastGood) : null;
    const notable = lines.filter(l => /ERR|REFUSING/.test(l)).slice(-5).map(redact);   // failures only; healthy reads are summarized above
    const fresh = lastGoodAt && Date.now() - lastGoodAt < STALE_MS;
    add({
      id: 'log', label: 'Log', status: fresh ? 'ok' : 'warn',
      summary: log + ' · last good read ' + (lastGoodAt ? fmtAgo(Date.now() - lastGoodAt) : 'never'),
      details: notable,
      hint: fresh ? undefined : 'no successful read in the last 15 min — check the Limits read and Agent lines above'
    });
  }

  return checks;
}

// ---- CLI ------------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const opts = {
    app: DEFAULT_APP,
    log: path.join(os.homedir(), 'Library', 'Logs', 'spr-limitbar.log'),
    stateDir: process.env.CODEX_LIMITBAR_STATE_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'spr-limitbar'),
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--app') opts.app = argv[++i];
    else if (a === '--log') opts.log = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') { console.log('usage: node lib/doctor.mjs [--app <ChatGPT.app>] [--log <path>] [--json]'); return 0; }
    else { console.error('unknown argument: ' + a); return 2; }
  }
  if (!opts.app) { console.error('--app needs a path'); return 2; }
  const checks = await runChecks(opts);
  const clean = checks.map(({ label, ...c }) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))));
  console.log(opts.json ? JSON.stringify(clean, null, 1) : formatReport(checks));
  return summarize(checks).exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathOr(process.argv[1])).href) {
  process.on('exit', killChildren);
  main().then(code => process.exit(code), err => { console.error('doctor crashed: ' + (err && err.stack || err)); process.exit(1); });
}
