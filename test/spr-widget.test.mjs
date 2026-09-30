import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../spr-prototype/spr-widget.html', import.meta.url), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

function harness() {
  const nodes = new Map(), messages = [], listeners = new Map();
  const timeouts = new Map(), intervals = new Set();
  let timerId = 0, height = 160, resizeCallback, disconnected = false;
  class Node {
    constructor() { this.children = []; this.textContent = ''; this.style = {}; this.events = new Map(); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    addEventListener(name, fn) { this.events.set(name, fn); }
    getBoundingClientRect() { return { height }; }
  }
  const el = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const parent = { postMessage: message => { messages.push(message); } };
  const window = { parent, addEventListener: (name, fn) => listeners.set(name, fn) };
  const document = {
    hidden: false, documentElement: new Node(),
    getElementById: el, querySelector: selector => el(selector), createElement: () => new Node(),
    addEventListener: (name, fn) => listeners.set(name, fn),
  };
  vm.runInNewContext(script, {
    window, document, Date, Number, Math, Map, Promise, Error,
    ResizeObserver: class { constructor(fn) { resizeCallback = fn; } observe() {} disconnect() { disconnected = true; } },
    setTimeout: fn => { timeouts.set(++timerId, fn); return timerId; }, clearTimeout: id => timeouts.delete(id),
    setInterval: () => { intervals.add(++timerId); return timerId; }, clearInterval: id => intervals.delete(id),
  });
  const receive = data => listeners.get('message')({ source: parent, data });
  return { messages, el, receive, timeouts, intervals,
    resize: value => { height = value; resizeCallback(); },
    get disconnected() { return disconnected; },
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('UI reports growing/shrinking content and disconnects on host teardown', async () => {
  const ui = harness();
  const init = ui.messages.find(message => message.method === 'ui/initialize');
  // A host request can reuse our id without being mistaken for our initialize response.
  ui.receive({ jsonrpc: '2.0', id: init.id, method: 'host/unknown' });
  assert.equal(ui.messages.at(-1).error.code, -32601);
  ui.receive({ jsonrpc: '2.0', id: init.id, result: { hostContext: { theme: 'light' } } });
  await settle();
  const read = ui.messages.find(message => message.method === 'tools/call');
  assert.ok(read);
  ui.receive({ jsonrpc: '2.0', id: read.id, result: {
    structuredContent: { limits: [
      { name: '5h', usedPercent: 10, resetsAtMs: Date.now() + 60000 },
      { name: 'Weekly', usedPercent: 73, resetsAtMs: Date.now() + 60000 },
    ], meta: { live: true, updatedAtMs: Date.now() } },
  } });
  await settle();
  ui.resize(420);
  ui.resize(420); // Identical sizes do not cause host resize loops.
  ui.resize(280);
  assert.deepEqual(ui.messages.filter(message => message.method === 'ui/notifications/size-changed').map(message => message.params.height), [200, 460, 320]);
  assert.ok(ui.messages.findIndex(message => message.method === 'ui/notifications/initialized') < ui.messages.findIndex(message => message.method === 'ui/notifications/size-changed'));
  assert.equal(ui.el('spr-windows').children.length, 2);
  assert.match(ui.el('spr-meta').textContent, /Live/);
  ui.receive({ jsonrpc: '2.0', id: 'teardown', method: 'ui/resource-teardown' });
  assert.equal(ui.disconnected, true);
  assert.equal(ui.intervals.size, 0);
  assert.equal(ui.timeouts.size, 0);
  const count = ui.messages.length;
  ui.resize(500);
  assert.equal(ui.messages.length, count);
});

test('UI marks retained numbers stale when a refresh request fails', async () => {
  const ui = harness();
  const init = ui.messages[0];
  ui.receive({ jsonrpc: '2.0', id: init.id, result: { hostContext: {} } });
  await settle();
  const read = ui.messages.find(message => message.method === 'tools/call');
  ui.receive({ jsonrpc: '2.0', id: read.id, result: { structuredContent: {
    limits: [{ name: 'Weekly', usedPercent: 73 }], meta: { live: true, updatedAtMs: Date.now() },
  } } });
  await settle();
  ui.el('spr-refresh').events.get('click')();
  const refresh = ui.messages.at(-1);
  ui.receive({ jsonrpc: '2.0', id: refresh.id, error: { code: -32603, message: 'Host unavailable' } });
  await settle();
  assert.match(ui.el('spr-meta').textContent, /Stale/);
  assert.equal(ui.el('spr-windows').children.length, 1);
  assert.equal(ui.el('spr-error').textContent, 'Host unavailable');
  ui.receive({ jsonrpc: '2.0', id: 'teardown', method: 'ui/resource-teardown' });
});
