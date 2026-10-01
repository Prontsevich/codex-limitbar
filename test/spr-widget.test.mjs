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
    constructor() {
      this.children = []; this.textContent = ''; this.events = new Map(); this.attributes = new Map();
      this.style = { setProperty(key, value) { this[key] = value; }, removeProperty(key) { delete this[key]; } };
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes.set(key, value); }
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
  return { messages, el, receive, timeouts, intervals, document,
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

test('UI applies host CSS variables and updates them when the theme changes', async () => {
  const ui = harness();
  const init = ui.messages[0];
  assert.deepEqual(Array.from(init.params.appCapabilities.availableDisplayModes), ['inline', 'fullscreen', 'pip']);
  ui.receive({ jsonrpc: '2.0', id: init.id, result: { hostContext: {
    theme: 'dark', displayMode: 'fullscreen', availableDisplayModes: ['fullscreen', 'pip'],
    styles: { variables: { '--color-background-primary': '#101010', '--color-text-secondary': '#d0d0d0', color: 'red', '--invalid': null } },
  } } });
  await settle();
  const root = ui.document.documentElement;
  assert.equal(root.style['--color-background-primary'], '#101010');
  assert.equal(root.style['--color-text-secondary'], '#d0d0d0');
  assert.equal(root.style.color, undefined);
  assert.equal(root.style['--invalid'], undefined);
  assert.equal(root.style.colorScheme, 'dark');
  assert.equal(ui.el('spr-pip').hidden, false);
  ui.receive({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'light', styles: { variables: {
    '--color-background-primary': '#fafafa', '--color-text-primary': '#202020',
  } } } });
  assert.equal(root.style.colorScheme, 'light');
  assert.equal(root.style['--color-background-primary'], '#fafafa');
  assert.equal(root.style['--color-text-secondary'], undefined);
  ui.receive({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: 'pip' } });
  assert.equal(root.style['--color-background-primary'], '#fafafa');
  assert.equal(root.attributes.get('data-spr-display-mode'), 'pip');
  assert.equal(ui.el('spr-pip').textContent, 'Full view');
  ui.receive({ jsonrpc: '2.0', id: 'teardown', method: 'ui/resource-teardown' });
});

test('UI handles actual display modes, rejection and errors without marking limits stale', async () => {
  const ui = harness();
  ui.receive({ jsonrpc: '2.0', id: ui.messages[0].id, result: { hostContext: {
    theme: 'dark', displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen', 'pip'],
  } } });
  await settle();
  const read = ui.messages.find(message => message.method === 'tools/call');
  ui.receive({ jsonrpc: '2.0', id: read.id, result: { structuredContent: {
    limits: [{ name: 'Weekly', usedPercent: 73 }], meta: { live: true, updatedAtMs: Date.now() },
  } } });
  await settle();
  const button = ui.el('spr-pip');
  button.events.get('click')();
  const request = ui.messages.at(-1);
  assert.equal(request.method, 'ui/request-display-mode');
  assert.equal(request.params.mode, 'pip');
  assert.equal(button.disabled, true);
  button.events.get('click')();
  assert.equal(ui.messages.at(-1), request);
  ui.receive({ jsonrpc: '2.0', id: request.id, result: { mode: 'pip' } });
  await settle();
  assert.equal(button.textContent, 'Full view');
  assert.equal(button.disabled, false);
  assert.equal(ui.messages.filter(message => message.method === 'ui/notifications/size-changed').at(-1).params.height, 184);
  button.events.get('click')();
  const full = ui.messages.at(-1);
  assert.equal(full.params.mode, 'fullscreen');
  ui.receive({ jsonrpc: '2.0', id: full.id, result: { mode: 'fullscreen' } });
  await settle();
  assert.equal(button.textContent, 'Compact view');
  button.events.get('click')();
  ui.receive({ jsonrpc: '2.0', id: ui.messages.at(-1).id, result: { mode: 'fullscreen' } });
  await settle();
  assert.match(ui.el('spr-view-status').textContent, /host kept fullscreen/);
  assert.match(ui.el('spr-meta').textContent, /Live/);
  assert.equal(ui.el('spr-error').hidden, true);
  button.events.get('click')();
  ui.receive({ jsonrpc: '2.0', id: ui.messages.at(-1).id, error: { code: -32601, message: 'Method not found' } });
  await settle();
  assert.match(ui.el('spr-view-status').textContent, /could not switch views/);
  assert.match(ui.el('spr-meta').textContent, /Live/);
  button.events.get('click')();
  ui.timeouts.values().next().value();
  await settle();
  assert.equal(button.disabled, false);
  assert.match(ui.el('spr-view-status').textContent, /could not switch views/);
  assert.match(ui.el('spr-meta').textContent, /Live/);
  // A fresh context without PiP shows an explicit capability notice.
  ui.receive({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { availableDisplayModes: ['inline', 'fullscreen'] } });
  assert.equal(button.hidden, true);
  ui.receive({ jsonrpc: '2.0', id: 'teardown', method: 'ui/resource-teardown' });
});

test('UI explains unavailable Compact view when the host declares only full and inline modes', async () => {
  const ui = harness();
  ui.receive({ jsonrpc: '2.0', id: ui.messages[0].id, result: { hostContext: {
    displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'],
  } } });
  await settle();
  const button = ui.el('spr-pip');
  assert.equal(button.hidden, true);
  assert.match(ui.el('spr-view-status').textContent, /not offered by this host/);
  ui.receive({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { availableDisplayModes: ['inline', 'fullscreen'] } });
  assert.equal(button.hidden, true);
  ui.receive({ jsonrpc: '2.0', id: 'teardown', method: 'ui/resource-teardown' });
});

test('standard host without an optional modes list can try PiP and return to full view', async () => {
  const ui = harness(); // No legacy window.openai API is installed.
  ui.receive({ jsonrpc: '2.0', id: ui.messages[0].id, result: { hostContext: { theme: 'light', displayMode: 'inline' } } });
  await settle();
  const read = ui.messages.find(message => message.method === 'tools/call');
  ui.receive({ jsonrpc: '2.0', id: read.id, result: { structuredContent: {
    limits: [], meta: { live: true, updatedAtMs: Date.now() },
  } } });
  await settle();
  const button = ui.el('spr-pip');
  assert.equal(button.hidden, false);
  button.events.get('click')();
  const compact = ui.messages.at(-1);
  assert.equal(compact.method, 'ui/request-display-mode');
  assert.equal(compact.params.mode, 'pip');
  ui.receive({ jsonrpc: '2.0', id: compact.id, result: { mode: 'pip' } });
  await settle();
  assert.equal(button.hidden, false);
  assert.equal(button.textContent, 'Full view');
  button.events.get('click')();
  const full = ui.messages.at(-1);
  assert.equal(full.params.mode, 'fullscreen');
  ui.receive({ jsonrpc: '2.0', id: full.id, result: { mode: 'fullscreen' } });
  await settle();
  assert.equal(button.hidden, false);
  assert.equal(button.textContent, 'Compact view');
  ui.receive({ jsonrpc: '2.0', id: 'teardown', method: 'ui/resource-teardown' });
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
