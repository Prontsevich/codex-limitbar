import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHandler, UI_URI, VERSION } from '../spr-prototype/spr-server.mjs';
import { prepareMarketplace } from '../spr-prototype/spr-prepare.mjs';

const call = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const sample = time => ({ limits: [{ name: 'Weekly', usedPercent: 73, resetsAtMs: time + 60000 }],
  meta: { live: true, updatedAtMs: time, resetCredits: 2 } });

test('portable package uses a contained executable launcher and starts without Node on PATH', async t => {
  const build = await mkdtemp(path.join(tmpdir(), "spr-plugin ' package-"));
  t.after(() => rm(build, { recursive: true, force: true }));
  await prepareMarketplace({ build });
  const plugin = path.join(build, 'plugins', 'spr-limitbar-prototype');
  const manifest = JSON.parse(await readFile(path.join(plugin, 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(path.join(plugin, 'mcp.json'), 'utf8'));
  assert.equal(manifest.version, VERSION);
  assert.equal(mcp.mcpServers['spr-limitbar'].command, './spr-launch.sh');
  assert.deepEqual(mcp.mcpServers['spr-limitbar'].args, []);
  const launcher = path.join(plugin, 'spr-launch.sh');
  assert.ok((await stat(launcher)).mode & 0o100);
  const child = spawn(launcher, [], { cwd: tmpdir(), env: { ...process.env, PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const lines = createInterface({ input: child.stdout });
  const replies = [];
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('launcher timeout')); }, 5000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    lines.on('line', line => {
      replies.push(JSON.parse(line));
      if (replies.length === 2) child.stdin.end();
    });
    child.on('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('exit ' + code)); });
    child.stdin.write(JSON.stringify(call('initialize')) + '\n' + JSON.stringify(call('tools/list', {}, 2)) + '\n');
  });
  assert.equal(replies[0].result.serverInfo.version, VERSION);
  assert.deepEqual(replies[1].result.tools.map(tool => tool.name), ['spr_show_limits', 'spr_read_limits']);
});

test('MCP discovery advertises both entrypoints and serves a self-contained UI resource', async () => {
  const handle = createHandler({ readLimits: async () => sample(1000) });
  const init = await handle(call('initialize', { protocolVersion: '2025-06-18' }));
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.extensions['io.modelcontextprotocol/ui']);
  const { result } = await handle(call('tools/list'));
  const show = result.tools.find(tool => tool.name === 'spr_show_limits');
  assert.deepEqual(show._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
  assert.equal(show._meta.ui.resourceUri, UI_URI);
  assert.equal(result.tools.find(tool => tool.name === 'spr_read_limits')._meta.ui.resourceUri, undefined);
  const resource = await handle(call('resources/read', { uri: UI_URI }));
  assert.equal(resource.result.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.deepEqual(resource.result.contents[0]._meta['openai/ui'].availableDisplayModes, ['inline', 'fullscreen', 'pip']);
  assert.match(resource.result.contents[0].text, /ui\/initialize/);
  assert.doesNotMatch(resource.result.contents[0].text, /<script[^>]+src=|fetch\(|Notification\./);
  assert.equal((await handle(call('resources/read', { uri: 'file:///etc/passwd' }))).error.code, -32602);
});

test('concurrent refreshes coalesce and recent reads are cached across tools', async () => {
  let time = 1000, reads = 0, release;
  const handle = createHandler({ now: () => time, readLimits: async () => {
    reads++; await new Promise(resolve => { release = resolve; }); return sample(time);
  } });
  const a = handle(call('tools/call', { name: 'spr_show_limits' }));
  const b = handle(call('tools/call', { name: 'spr_read_limits' }, 2));
  assert.equal(reads, 1); release();
  assert.deepEqual((await a).result, (await b).result);
  await handle(call('tools/call', { name: 'spr_read_limits' }));
  assert.equal(reads, 1);
  time += 10001;
  const fresh = handle(call('tools/call', { name: 'spr_read_limits' }));
  assert.equal(reads, 2); release(); await fresh;
});

test('failed reads preserve last values as stale and omit raw RPC errors', async () => {
  let time = 1000, fail = false;
  const handle = createHandler({ now: () => time, readLimits: async () => fail
    ? { error: 'private-account-id secret-token' } : sample(time) });
  await handle(call('tools/call', { name: 'spr_read_limits' }));
  fail = true; time += 10001;
  const response = await handle(call('tools/call', { name: 'spr_read_limits' }));
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.meta.live, false);
  assert.equal(response.result.structuredContent.meta.updatedAtMs, 1000);
  assert.equal(response.result.structuredContent.limits[0].usedPercent, 73);
  assert.doesNotMatch(JSON.stringify(response), /private-account-id|secret-token/);
});

test('invalid tool requests and notifications do not start a limits read', async () => {
  let reads = 0;
  const handle = createHandler({ readLimits: async () => { reads++; return sample(1000); } });
  assert.equal((await handle(call('tools/call', { name: 'spr_read_limits', arguments: { accountId: 'other' } }))).error.code, -32602);
  assert.equal((await handle(call('tools/call', { name: 'unknown' }))).error.code, -32602);
  assert.equal((await handle(call('unknown'))).error.code, -32601);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(reads, 0);
});

test('stdio transport survives malformed JSON and emits only JSON-RPC on stdout', async () => {
  const child = spawn(process.execPath, [new URL('../spr-prototype/spr-server.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const replies = [];
  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('stdio timeout')); }, 5000);
    child.on('error', reject);
    lines.on('line', line => {
      replies.push(JSON.parse(line));
      if (replies.length === 3) { clearTimeout(timeout); child.stdin.end(); }
    });
    child.on('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('exit ' + code)); });
  });
  child.stdin.write('{broken\n' + JSON.stringify(call('initialize')) + '\n' + JSON.stringify(call('tools/list', {}, 2)) + '\n');
  await done;
  assert.equal(replies.length, 3);
  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies[1].result.serverInfo.name, 'spr-limitbar-prototype');
  assert.equal(replies[2].result.tools.length, 2);
});
