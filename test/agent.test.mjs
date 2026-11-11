import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { Agent } from '../limitbar.mjs';
import { watchNativeLimits } from '../lib/native-limits.mjs';

function connection(send) {
  return { send, closed: false, closes: 0, close() { this.closed = true; this.closes++; } };
}

function session(conn, targetId = 'shell') {
  return { conn, targetId, sessionId: targetId + '-session', scriptId: 'script', url: 'app://-/index.html' };
}

const cached = { limits: [{ name: '5h', usedPercent: 12 }], meta: { live: true, updatedAtMs: 1 } };

test('an open but unresponsive CDP socket is replaced and cached limits are delivered again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const agent = new Agent({ source: '', version: 31 });
  agent.tick = {}; // The agent has completed startup.
  const broken = connection(async () => { throw new Error('Runtime.evaluate: timeout'); });
  const old = session(broken);
  agent.conn = broken;
  agent.sessions.set(old.targetId, old);
  agent.attaching.set('old-attach', Promise.resolve());
  agent.limits = cached;
  const delivered = [];
  const replacement = connection(async (method, params) => {
    assert.equal(method, 'Runtime.evaluate');
    delivered.push(params.expression);
    return {};
  });
  let connections = 0;
  agent.connect = async () => {
    connections++;
    agent.conn = replacement;
    const freshSession = session(replacement);
    agent.sessions.set(freshSession.targetId, freshSession);
    await agent.pushTo(freshSession);
  };
  let finish;
  const restored = new Promise(resolve => { finish = resolve; });
  agent.poll = async reason => {
    assert.equal(reason, 'reattach');
    agent.limits = { ...cached, meta: { live: true, updatedAtMs: 2 } };
    await agent.pushAll();
    finish();
  };

  // Two failures from the same socket must share one recovery, even when its
  // close() never emits a close event.
  await Promise.all([agent.pushTo(old), agent.pushTo(old)]);
  assert.equal(broken.closes, 1);
  assert.equal(agent.conn, null);
  assert.equal(agent.attaching.size, 0);
  t.mock.timers.tick(1000);
  await restored;

  assert.equal(connections, 1);
  assert.equal(agent.reconnecting, false);
  assert.equal(agent.sessions.get('shell').conn, replacement);
  assert.equal(delivered.length, 2);
  assert.match(delivered[0], /"updatedAtMs":1/);
  assert.match(delivered[1], /"updatedAtMs":2/);

  // A delayed failure from the old socket must not close the replacement.
  agent.recoverConnection(broken, 'Runtime.evaluate: timeout');
  await agent.pushTo(old);
  assert.equal(replacement.closes, 0);
  assert.equal(delivered.length, 2);
});

test('payload exceptions do not restart a healthy connection', async () => {
  const agent = new Agent({ source: '', version: 31 });
  agent.tick = {};
  agent.conn = connection(async () => ({ exceptionDetails: { text: 'payload failed' } }));
  agent.limits = cached;
  await agent.pushTo(session(agent.conn));
  assert.equal(agent.conn.closes, 0);
  assert.equal(agent.reconnecting, false);
});

test('an attach completing on the old socket cannot replace or unlock a new attach', async () => {
  const agent = new Agent({ source: '', version: 31 });
  let releaseOld;
  const oldConnection = connection((method) => method === 'Target.attachToTarget'
    ? new Promise(resolve => { releaseOld = resolve; })
    : Promise.resolve({ identifier: 'old-script' }));
  agent.conn = oldConnection;
  const target = { targetId: 'shell', url: 'app://-/index.html' };
  const oldAttach = agent.attach(target);

  // Recovery discards the old bookkeeping and attaches the same target again.
  agent.attaching.clear();
  const newConnection = connection(async method => method === 'Target.attachToTarget'
    ? { sessionId: 'new-session' } : { identifier: 'new-script' });
  agent.conn = newConnection;
  let releaseNew;
  let started;
  const injecting = new Promise(resolve => { started = resolve; });
  agent.inject = () => { started(); return new Promise(resolve => { releaseNew = resolve; }); };
  const newAttach = agent.attach(target);
  await injecting;
  releaseOld({ sessionId: 'old-session' });
  await oldAttach;
  assert.equal(agent.sessions.get('shell').conn, newConnection);
  assert.equal(agent.sessions.get('shell').sessionId, 'new-session');
  assert.equal(agent.attaching.get('shell'), newAttach);
  releaseNew();
  await newAttach;
  assert.equal(agent.attaching.size, 0);
});

test('the first tick after sleep reconnects before polling; ordinary ticks keep their cadence', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000000 });
  const agent = new Agent({ source: '', version: 31 });
  agent.conn = connection(async () => ({}));
  agent.sessions.set('shell', session(agent.conn));
  agent.lastPollAt = Date.now();
  const recoveries = [];
  const polls = [];
  agent.recoverConnection = (conn, reason) => recoveries.push({ conn, reason });
  agent.poll = reason => polls.push(reason);
  agent.startTimers();
  t.mock.timers.tick(30000);
  assert.deepEqual(polls, []);
  assert.deepEqual(recoveries, []);
  // Advance wall time without running callbacks, as suspend/resume does.
  t.mock.timers.setTime(Date.now() + 120000);
  t.mock.timers.tick(30000);
  assert.equal(recoveries.length, 1);
  assert.match(recoveries[0].reason, /^wake after /);
  assert.equal(recoveries[0].conn, agent.conn);
  assert.deepEqual(polls, []);
  clearInterval(agent.tick);
});

test('stopping suppresses recovery', () => {
  const agent = new Agent({ source: '', version: 31 });
  agent.tick = {};
  agent.conn = connection(async () => ({}));
  agent.stopping = true;
  agent.recoverConnection(agent.conn, 'Runtime.evaluate: timeout');
  assert.equal(agent.conn.closes, 0);
  assert.equal(agent.reconnecting, false);
});

test('the page watches only the observed account and releases the cache subscription', async () => {
  const messages = [];
  const window = new EventTarget();
  const document = new EventTarget();
  window.top = window;
  window.__sprBarRefreshBinding = message => messages.push(JSON.parse(message));
  const query = {
    queryKey: ['rate-limit-status', 'user', 'active-account'],
    getObserversCount: () => 1,
    state: { dataUpdatedAt: 1, data: {
      user_id: 'user', account_id: 'active-account', plan_type: 'plus',
      rate_limit: { allowed: true, primary_window: { used_percent: 30, limit_window_seconds: 604800 } },
      rate_limit_reset_credits: { available_count: 1 },
    } },
  };
  const old = { ...query, queryKey: ['rate-limit-status', 'user', 'old-account'], getObserversCount: () => 0 };
  let subscriber;
  const cache = {
    getAll: () => [old, query],
    subscribe(fn) {
      subscriber = fn;
      return () => { subscriber = null; throw new Error('unsupported cleanup'); };
    },
  };
  window.__codexRoot = { _internalRoot: { current: {
    tag: 10, memoizedProps: { value: { queryClient: { getQueryCache: () => cache } } },
  } } };
  runInNewContext('(' + watchNativeLimits + ')("test-token")', {
    window, document, location: new URL('app://-/index.html'), queueMicrotask, setTimeout, clearTimeout,
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].result.rateLimits.primary.windowDurationMins, 10080);
  assert.equal(messages[0].result.rateLimitResetCredits.availableCount, 1);
  assert.equal(messages[0].result.rateLimits.secondary, null);
  assert.equal(JSON.stringify(messages[0]).includes('user'), false);

  subscriber({ query });
  await Promise.resolve();
  assert.equal(messages.length, 1);
  query.state.dataUpdatedAt = 2;
  subscriber({ query });
  await Promise.resolve();
  assert.equal(messages[1].updatedAtMs, 2);

  query.getObserversCount = () => 0;
  subscriber({ query });
  await Promise.resolve();
  assert.equal(messages[2].result, null);
  window.__sprBarStopNative();
  assert.equal(subscriber, null);
  assert.equal(window.__sprBarStopNative, undefined);
});

test('fresh native data suppresses polling, while overdue resets and missing data are read', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000000 });
  const agent = new Agent({ source: '', version: 55 });
  agent.conn = connection(async () => ({}));
  const shell = session(agent.conn);
  shell.token = 'test-token';
  agent.sessions.set(shell.targetId, shell);
  agent.acceptLimits = (parsed, reason) => {
    assert.equal(reason, 'native');
    agent.limits = parsed;
  };
  const polls = [];
  agent.poll = reason => { polls.push(reason); agent.lastPollAt = Date.now(); };
  const message = (at, token = shell.token) => JSON.stringify({
    token, accountId: 'account', updatedAtMs: at,
    result: { rateLimits: { primary: { usedPercent: 50, resetsAt: 1060, windowDurationMins: 300 } } },
  });
  agent.onBinding(message(Date.now(), 'wrong-token'), shell.sessionId);
  agent.onBinding(message(Date.now() - 300000), shell.sessionId);
  assert.equal(agent.limits, null);
  agent.onBinding(message(Date.now()), shell.sessionId);
  assert.equal(agent.limits.meta.updatedAtMs, Date.now());
  agent.startTimers();
  agent.onBinding('panel', shell.sessionId);
  t.mock.timers.tick(60000);
  assert.deepEqual(polls, []);
  t.mock.timers.tick(30000);
  assert.deepEqual(polls, ['reset']);
  t.mock.timers.tick(30000);
  assert.deepEqual(polls, ['reset']);
  agent.onBinding('foreground', shell.sessionId);
  assert.deepEqual(polls, ['reset', 'foreground']);
  for (let tick = 0; tick < 10; tick++) t.mock.timers.tick(30000);
  assert.deepEqual(polls, ['reset', 'foreground', 'interval']);
  clearInterval(agent.tick);
});

test('stale native data only falls back to a direct read for the same account', async () => {
  const agent = new Agent({ source: '', version: 55 });
  const shell = session(agent.conn);
  shell.token = 'test-token';
  shell.nativeAt = Date.now() - 360000;
  shell.nativeAccountId = 'active';
  agent.sessions.set(shell.targetId, shell);
  const errors = [];
  const accepted = [];
  agent.pushError = error => errors.push(error);
  agent.acceptLimits = (parsed, reason, accountId) => accepted.push({ reason, accountId });
  const direct = accountId => ({ result: {
    accountId, rateLimits: { primary: { usedPercent: 50, windowDurationMins: 300 } },
  } });
  await agent.applyDirectRead(direct('different'), 'interval', 0);
  await agent.applyDirectRead(direct('active'), 'interval', 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /active ChatGPT account/);
  assert.deepEqual(accepted, [{ reason: 'interval', accountId: 'active' }]);
  agent.onBinding(JSON.stringify({ token: shell.token, result: null, accountId: null }), shell.sessionId);
  await agent.applyDirectRead(direct('different'), 'interval', 0);
  assert.equal(accepted.length, 1);
  await agent.applyDirectRead(direct('different'), 'interval', agent.nativeRevision);
  assert.equal(accepted.length, 1);
  await agent.applyDirectRead(direct('active'), 'interval', agent.nativeRevision);
  assert.equal(accepted.length, 2);
});

test('a direct read fills in credits without replacing newer native windows', async () => {
  const agent = new Agent({ source: '', version: 55 });
  const shell = session(agent.conn);
  const now = Date.now();
  shell.nativeAt = now;
  shell.nativeAccountId = 'active';
  agent.sessions.set(shell.targetId, shell);
  agent.nativeRevision = 1;
  agent.accountId = 'active';
  agent.limits = {
    limits: [{ name: 'Weekly', usedPercent: 50 }],
    meta: { source: 'native', updatedAtMs: now, resetCredits: 1, resetCreditsList: [] },
  };
  const expiresAt = Math.ceil(now / 1000) + 3600;
  const result = {
    accountId: 'active',
    rateLimits: { primary: { usedPercent: 48, windowDurationMins: 10080 } },
    rateLimitResetCredits: { availableCount: 1, credits: [{ status: 'available', expiresAt, title: 'Reset' }] },
  };
  await agent.applyDirectRead({ result }, 'manual', 0);
  assert.equal(agent.limits.limits[0].usedPercent, 50);
  assert.equal(agent.limits.meta.updatedAtMs, now);
  assert.deepEqual(agent.limits.meta.resetCreditsList, [{ expiresAtMs: expiresAt * 1000, title: 'Reset' }]);
});

test('a cache replay cannot undo a direct read, but a new window can', () => {
  const agent = new Agent({ source: '', version: 55 });
  const shell = session(agent.conn);
  shell.token = 'test-token';
  agent.sessions.set(shell.targetId, shell);
  const now = Date.now();
  const resetsAt = Math.ceil(now / 1000) + 3600;
  agent.accountId = 'active';
  agent.limits = {
    limits: [{ name: '5h', usedPercent: 80, windowDurationMins: 300, resetsAtMs: resetsAt * 1000 }],
    meta: { source: 'app-server', updatedAtMs: now - 1000 },
  };
  agent.directBaseline = { accountId: 'active', limits: agent.limits.limits };
  agent.acceptLimits = parsed => { agent.limits = parsed; parsed.meta.source = 'native'; };
  const publish = (usedPercent, reset) => agent.onBinding(JSON.stringify({
    token: shell.token, accountId: 'active', updatedAtMs: now,
    result: { rateLimits: { primary: { usedPercent, resetsAt: reset, windowDurationMins: 300 } } },
  }), shell.sessionId);
  publish(50, resetsAt);
  publish(50, null);
  publish(99, resetsAt - 18000);
  assert.equal(agent.limits.limits[0].usedPercent, 80);
  assert.equal(agent.hasFreshNative(), false);
  publish(80, resetsAt);
  assert.equal(agent.limits.meta.source, 'native');
  agent.limits.meta.updatedAtMs = now - 1;
  publish(50, resetsAt);
  assert.equal(agent.limits.limits[0].usedPercent, 80);
  publish(3, resetsAt + 18000);
  assert.equal(agent.limits.limits[0].usedPercent, 3);
  assert.equal(agent.hasFreshNative(), true);
  publish(99, resetsAt);
  assert.equal(agent.limits.limits[0].usedPercent, 3);
});

test('persisted rollover history is scoped across agent restarts', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spr-limitbar-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const previous = process.env.CODEX_LIMITBAR_STATE_DIR;
  let IsolatedAgent;
  try {
    process.env.CODEX_LIMITBAR_STATE_DIR = directory;
    ({ Agent: IsolatedAgent } = await import('../limitbar.mjs?account-history-test'));
  } finally {
    if (previous === undefined) delete process.env.CODEX_LIMITBAR_STATE_DIR;
    else process.env.CODEX_LIMITBAR_STATE_DIR = previous;
  }
  const file = path.join(directory, 'limits.json');
  const limits = [{ name: 'Weekly', usedPercent: 50 }];
  fs.writeFileSync(file, JSON.stringify({ atMs: Date.now(), limits }));
  const read = account => {
    const agent = new IsolatedAgent({ source: '', version: 55 });
    const result = { limits, meta: { updatedAtMs: Date.now(), resetCreditsList: [] } };
    return agent.acceptLimits(result, 'native', account).then(() => result.meta.prevLimits);
  };
  assert.equal(await read('first-account'), null); // legacy snapshot cannot identify its account
  assert.equal(fs.readFileSync(file, 'utf8').includes('first-account'), false);
  assert.deepEqual(await read('first-account'), limits);
  assert.equal(await read('second-account'), null);
});
