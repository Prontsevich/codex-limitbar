// node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtAgo, formatReport, redact, summarize } from '../lib/doctor.mjs';

const checks = [
  { id: 'system', label: 'System', status: 'ok', summary: 'macOS 27.0 · Node 24.0.0' },
  { id: 'bar', label: 'Bar', status: 'warn', summary: 'v24 live vs v25 on disk', hint: 'restart the helper' },
  { id: 'page', label: 'Shell page', status: 'skip', summary: 'skipped' },
  { id: 'log', label: 'Log', status: 'ok', summary: 'fine', details: ['[t] limits live (interval): 5h 4%'] },
];

test('summarize counts statuses; exit code only on fail', () => {
  assert.deepEqual(summarize(checks), { counts: { ok: 2, warn: 1, fail: 0, skip: 1 }, exitCode: 0 });
  assert.equal(summarize([...checks, { id: 'x', status: 'fail', summary: 'boom' }]).exitCode, 1);
  assert.equal(summarize([]).exitCode, 0);
});

test('formatReport: marks, aligned labels, indented details and hints, footer', () => {
  const out = formatReport(checks).split('\n');
  assert.equal(out[0], 'codex-limitbar doctor');
  assert.equal(out[1], '✓ System      macOS 27.0 · Node 24.0.0');
  assert.equal(out[2], '! Bar         v24 live vs v25 on disk');
  assert.equal(out[3], '    → restart the helper');
  assert.equal(out[4], '– Shell page  skipped');
  assert.equal(out[6], '    [t] limits live (interval): 5h 4%');
  assert.equal(out.at(-1), 'no failures, 1 warning(s)');
  assert.equal(formatReport([{ id: 'a', status: 'fail', summary: 'x' }]).split('\n').at(-1), '1 failed, 0 warning(s)');
  assert.equal(formatReport([{ id: 'a', status: 'ok', summary: 'x' }]).split('\n').at(-1), 'all checks passed');
});

test('redact strips uuids, bearer tokens and long opaque strings, keeps log text', () => {
  const line = '[2026-09-27T21:05:15.244Z] limits ERR (manual) via /Applications/ChatGPT.app: Bearer abc.def '
    + 'c8ded100-546f-4675-ba70-0841b8aaf849 RateLimitResetCredit_e20a95670444819186a04231a9a9a932';
  const r = redact(line);
  assert.ok(r.startsWith('[2026-09-27T21:05:15.244Z] limits ERR (manual) via /Applications/ChatGPT.app:'));
  assert.ok(!r.includes('abc.def') && r.includes('Bearer <redacted>'));
  assert.ok(!r.includes('c8ded100') && r.includes('<uuid>'));
  assert.ok(!r.includes('e20a9567') && r.includes('<redacted>'));
  assert.equal(redact('limits live (interval): 5h 4%, Weekly 1% · plan=plus'), 'limits live (interval): 5h 4%, Weekly 1% · plan=plus');
});

test('fmtAgo', () => {
  assert.equal(fmtAgo(5000), '5 s ago');
  assert.equal(fmtAgo(4 * 60000), '4 min ago');
  assert.equal(fmtAgo(125 * 60000), '2 h 5 min ago');
  assert.equal(fmtAgo(3 * 86400000), '3 d ago');
});
