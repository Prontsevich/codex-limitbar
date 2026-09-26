// lib/limits.mjs — read Codex rate limits from `codex app-server` (stdio JSON-RPC:
// initialize -> initialized -> account/rateLimits/read) and turn the response into
// the bar's `[{name, usedPercent, resetsAtMs}]` + meta shape.
// Protocol reference: skills/codex-limitbar/references/rate-limits-protocol.md

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function nameForWindow(mins) {
  const m = Number(mins) || 0;
  if (m >= 10080) return 'Weekly';
  if (m >= 1440 && m % 1440 === 0) return (m / 1440) + 'd';
  if (m >= 60 && m % 60 === 0) return (m / 60) + 'h';
  return m ? m + 'm' : '?';
}

// Pure: the `result` of account/rateLimits/read -> {limits, meta} | {error}.
// Windows are derived from `windowDurationMins`; one window is normal (the 5h
// window is suspended for many accounts).
export function parseLimits(result, now = Date.now()) {
  if (!result || typeof result !== 'object') return { error: 'empty result' };
  const byId = result.rateLimitsByLimitId;
  let bucket = byId && byId.codex;
  if (!bucket && byId && typeof byId === 'object') {
    const keys = Object.keys(byId);
    if (keys.length === 1) bucket = byId[keys[0]];
  }
  if (!bucket) bucket = result.rateLimits;
  if (!bucket || typeof bucket !== 'object') return { error: 'no rate-limit bucket' };
  const win = w => (w && typeof w.usedPercent === 'number')
    ? { name: nameForWindow(w.windowDurationMins), usedPercent: w.usedPercent, resetsAtMs: w.resetsAt ? w.resetsAt * 1000 : null }
    : null;
  const limits = [win(bucket.primary), win(bucket.secondary)].filter(Boolean);
  if (!limits.length) return { error: 'no rate-limit windows in the bucket' };
  const rc = result.rateLimitResetCredits;
  return {
    limits,
    meta: {
      live: true,
      planType: bucket.planType || null,
      resetCredits: rc && typeof rc.availableCount === 'number' ? rc.availableCount : null,
      updatedAtMs: now,
    },
  };
}

// Candidate executables, best first: the CLI bundled with the app (same version the
// UI talks to), then PATH, then the usual per-user and Homebrew locations.
export function codexCandidates({ app, env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const out = [];
  if (app) out.push(platform === 'darwin' ? path.join(app, 'Contents', 'Resources', exe) : path.join(app, 'resources', exe));
  for (const dir of String(env.PATH || '').split(path.delimiter)) if (dir) out.push(path.join(dir, exe));
  out.push(path.join(home, '.local', 'bin', exe), path.join(home, '.local', 'share', 'mise', 'shims', exe));
  if (platform !== 'win32') out.push('/opt/homebrew/bin/codex', '/usr/local/bin/codex');
  return [...new Set(out)];
}

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

export function findCodex(opts = {}, check = isExecutable) {
  for (const c of codexCandidates(opts)) if (check(c)) return c;
  return null;
}

// Every app-server child still alive; killChildren() is the last-resort cleanup
// for an agent that exits mid-poll (call it from a process 'exit' handler).
const live = new Set();

export function killChildren() {
  for (const c of live) { try { c.kill('SIGKILL'); } catch {} }
  live.clear();
}

// Spawn discipline: cwd = tmpdir, PWD overridden, OLDPWD/INIT_CWD dropped (the
// server must not see where the agent was started), stderr ignored, 15 s budget.
// A child that ignores SIGTERM is SIGKILLed after a grace period.
export function rpcFetch(bin, { timeoutMs = 15000, killGraceMs = 2000 } = {}) {
  return new Promise(resolve => {
    const env = Object.assign({}, process.env, { PWD: os.tmpdir() });
    delete env.OLDPWD; delete env.INIT_CWD;
    let child;
    try {
      child = spawn(bin, ['app-server', '--listen', 'stdio://'], { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (err) { resolve({ error: 'spawn: ' + String((err && err.message) || err) }); return; }
    live.add(child);
    child.on('exit', () => live.delete(child));
    let buf = '', stage = 0, done = false;
    const finish = out => {
      if (done) return; done = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch {} }
        }, killGraceMs).unref();
      }
      resolve(out);
    };
    const timer = setTimeout(() => finish({ error: 'timeout after ' + Math.round(timeoutMs / 1000) + ' s' }), timeoutMs);
    const send = obj => { try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch {} };
    child.on('error', err => finish({ error: 'child: ' + String((err && err.message) || err) }));
    child.on('exit', () => finish({ error: 'exited before responding' }));
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      buf += chunk.toString('utf8');
      if (buf.length > 4 << 20) { finish({ error: 'response too large' }); return; }
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
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
    send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'codex-limitbar', title: 'Codex LimitBar', version: '2.0.0' } } });
  });
}
