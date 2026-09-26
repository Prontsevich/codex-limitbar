// node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { codexCandidates, findCodex, nameForWindow, parseLimits, rpcFetch } from '../lib/limits.mjs';

const NOW = 1_790_000_000_000;

// Shape from skills/codex-limitbar/references/rate-limits-protocol.md
const bucket = (over = {}) => Object.assign({
  limitId: 'codex', limitName: null,
  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1787203791 },
  secondary: { usedPercent: 73, windowDurationMins: 10080, resetsAt: 1787800000 },
  credits: { hasCredits: false, unlimited: false, balance: '0' },
  planType: 'plus', rateLimitReachedType: null,
}, over);

test('nameForWindow derives names from the window length', () => {
  assert.equal(nameForWindow(300), '5h');
  assert.equal(nameForWindow(10080), 'Weekly');
  assert.equal(nameForWindow(20160), 'Weekly');
  assert.equal(nameForWindow(1440), '1d');
  assert.equal(nameForWindow(4320), '3d');
  assert.equal(nameForWindow(90), '90m');
  assert.equal(nameForWindow(0), '?');
  assert.equal(nameForWindow(undefined), '?');
});

test('both windows, reset credits and plan', () => {
  const b = bucket();
  const r = parseLimits({ rateLimits: b, rateLimitsByLimitId: { codex: b }, rateLimitResetCredits: { availableCount: 3, credits: [] } }, NOW);
  assert.deepEqual(r.limits, [
    { name: '5h', usedPercent: 12, resetsAtMs: 1787203791000 },
    { name: 'Weekly', usedPercent: 73, resetsAtMs: 1787800000000 },
  ]);
  assert.deepEqual(r.meta, { live: true, planType: 'plus', resetCredits: 3, updatedAtMs: NOW });
});

test('weekly-only account (secondary null) yields one limit', () => {
  const b = bucket({ primary: { usedPercent: 95, windowDurationMins: 10080, resetsAt: 1787203791 }, secondary: null });
  const r = parseLimits({ rateLimits: b, rateLimitResetCredits: { availableCount: 0, credits: [] } }, NOW);
  assert.equal(r.limits.length, 1);
  assert.equal(r.limits[0].name, 'Weekly');
  assert.equal(r.meta.resetCredits, 0);
});

test('rateLimitsByLimitId wins over rateLimits; codex key preferred', () => {
  const codex = bucket({ primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1 }, secondary: null });
  const other = bucket({ primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1 }, secondary: null });
  const r = parseLimits({ rateLimits: other, rateLimitsByLimitId: { other, codex } }, NOW);
  assert.equal(r.limits[0].usedPercent, 1);
});

test('a single non-codex key in rateLimitsByLimitId is used', () => {
  const only = bucket({ planType: 'pro', secondary: null });
  const r = parseLimits({ rateLimitsByLimitId: { 'codex-pro': only } }, NOW);
  assert.equal(r.meta.planType, 'pro');
  assert.equal(r.limits.length, 1);
});

test('several non-codex keys fall back to rateLimits', () => {
  const r = parseLimits({ rateLimits: bucket({ secondary: null }), rateLimitsByLimitId: { a: bucket(), b: bucket() } }, NOW);
  assert.equal(r.limits.length, 1);
});

test('missing reset time and missing reset credits', () => {
  const b = bucket({ primary: { usedPercent: 5, windowDurationMins: 300 }, secondary: null, planType: undefined });
  const r = parseLimits({ rateLimits: b }, NOW);
  assert.equal(r.limits[0].resetsAtMs, null);
  assert.equal(r.meta.resetCredits, null);
  assert.equal(r.meta.planType, null);
});

test('garbage and empty input produce errors, never throw', () => {
  assert.ok(parseLimits(null).error);
  assert.ok(parseLimits(undefined).error);
  assert.ok(parseLimits('nope').error);
  assert.ok(parseLimits({}).error);
  assert.ok(parseLimits({ rateLimits: 7 }).error);
  assert.ok(parseLimits({ rateLimits: { primary: null, secondary: null } }).error);
  assert.ok(parseLimits({ rateLimits: { primary: { usedPercent: '50' } } }).error);
});

test('codexCandidates: bundled CLI first, platform-aware', () => {
  const mac = codexCandidates({ app: '/Applications/ChatGPT.app', env: { PATH: '/usr/bin:/opt/x' }, platform: 'darwin', home: '/Users/u' });
  assert.equal(mac[0], '/Applications/ChatGPT.app/Contents/Resources/codex');
  assert.ok(mac.includes('/opt/x/codex'));
  assert.ok(mac.includes('/Users/u/.local/bin/codex'));
  const win = codexCandidates({ app: 'C:\\Apps\\ChatGPT', env: { PATH: '' }, platform: 'win32', home: 'C:\\Users\\u' });
  assert.equal(path.basename(win[0]), 'codex.exe');
  assert.ok(!win.includes('/opt/homebrew/bin/codex'));
});

test('findCodex returns the first executable candidate', () => {
  const opts = { app: '/A.app', env: { PATH: '/p1:/p2' }, platform: 'darwin', home: '/h' };
  assert.equal(findCodex(opts, p => p === '/p2/codex'), '/p2/codex');
  assert.equal(findCodex(opts, () => false), null);
});

test('rpcFetch SIGKILLs an app-server that ignores SIGTERM', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spr-limits-'));
  const bin = path.join(dir, 'codex');
  const pidFile = path.join(dir, 'pid');
  fs.writeFileSync(bin, '#!' + process.execPath + '\n'
    + "require('fs').writeFileSync(" + JSON.stringify(pidFile) + ", String(process.pid));\n"
    + "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n", { mode: 0o755 });
  const out = await rpcFetch(bin, { timeoutMs: 500, killGraceMs: 300 });
  assert.match(out.error, /timeout/);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(), true, 'still alive right after SIGTERM');
  await new Promise(r => setTimeout(r, 700));
  assert.equal(alive(), false, 'killed after the grace period');
  fs.rmSync(dir, { recursive: true, force: true });
});
