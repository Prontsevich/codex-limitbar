#!/usr/bin/env node
// A deliberately small, local-only MCP Apps experiment. No CDP or HTTP listener.
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { findCodex, rpcFetch, parseLimits, killChildren } from '../lib/limits.mjs';

export const VERSION = '0.1.1';
export const UI_URI = 'ui://spr-limitbar/v3.html';
const MIME = 'text/html;profile=mcp-app';
const schema = { type: 'object', properties: {}, additionalProperties: false };
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };

export const tools = [
  {
    name: 'spr_show_limits', title: 'LimitBar',
    description: 'Open LimitBar to inspect the locally signed-in Codex account usage windows and reset credits.',
    inputSchema: schema, annotations,
    _meta: {
      ui: { resourceUri: UI_URI, visibility: ['model', 'app'] },
      'openai/outputTemplate': UI_URI,
      'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] },
    },
  },
  {
    name: 'spr_read_limits', title: 'Refresh LimitBar',
    description: 'Read current Codex usage windows from the local app-server without opening another UI.',
    inputSchema: schema, annotations,
    _meta: { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true },
  },
];

export function createHandler({ readLimits, now = Date.now } = {}) {
  let cached = null;
  let lastReadAt = -Infinity;
  let inFlight = null;
  const fetchLimits = readLimits || (async () => {
    const bin = findCodex({ app: process.env.CODEX_LIMITBAR_APP || '/Applications/ChatGPT.app' });
    if (!bin) return { error: 'Codex CLI was not found. Install Codex or set CODEX_LIMITBAR_APP.' };
    const response = await rpcFetch(bin);
    return response.error ? { error: response.error } : parseLimits(response.result, now());
  });
  async function getLimits() {
    if (inFlight) return inFlight;
    if (cached && now() - lastReadAt < 10000) return cached;
    inFlight = (async () => {
      let data;
      try { data = await fetchLimits(); } catch { data = { error: 'The local limits read failed.' }; }
      if (data.error) {
        // Do not forward raw RPC error payloads: they can contain account identifiers.
        const previous = cached?.structuredContent;
        cached = {
          isError: true,
          content: [{ type: 'text', text: 'LimitBar could not read current limits. Check the local Codex runtime and login.' }],
          structuredContent: {
            limits: previous?.limits || [],
            meta: { ...previous?.meta, live: false, error: 'Limits unavailable. Check the local Codex runtime and login.' },
          },
        };
      } else {
        cached = {
          content: [{ type: 'text', text: 'Current local Codex usage windows and reset credits.' }],
          structuredContent: data,
        };
      }
      lastReadAt = now();
      return cached;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  return async function handle(message) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    }
    if (message.id === undefined) return null;
    const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
    const fail = (code, error) => ({ jsonrpc: '2.0', id: message.id, error: { code, message: error } });
    switch (message.method) {
      case 'initialize':
        return reply({
          protocolVersion: message.params?.protocolVersion || '2025-06-18',
          serverInfo: { name: 'spr-limitbar-prototype', version: VERSION },
          capabilities: { tools: {}, resources: {}, extensions: { 'io.modelcontextprotocol/ui': {} } },
          instructions: 'This is a local LimitBar experiment. Use spr_show_limits to display usage; no CDP is used.',
        });
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools });
      case 'resources/list':
        return reply({ resources: [{ uri: UI_URI, name: 'spr-limitbar', title: 'LimitBar', mimeType: MIME }] });
      case 'resources/templates/list': return reply({ resourceTemplates: [] });
      case 'resources/read': {
        if (message.params?.uri !== UI_URI) return fail(-32602, 'Unknown resource');
        const html = await readFile(new URL('./spr-widget.html', import.meta.url), 'utf8');
        return reply({ contents: [{
          uri: UI_URI, mimeType: MIME, text: html,
          _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
        }] });
      }
      case 'tools/call': {
        if (!tools.some(tool => tool.name === message.params?.name)) return fail(-32602, 'Unknown tool');
        const args = message.params.arguments ?? {};
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) {
          return fail(-32602, 'This tool takes an empty arguments object');
        }
        return reply(await getLimits());
      }
      default: return fail(-32601, 'Method not found');
    }
  };
}

export function serveStdio() {
  const handle = createHandler();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = message => { if (message) process.stdout.write(JSON.stringify(message) + '\n'); };
  input.on('line', async line => {
    if (!line.trim()) return;
    if (line.length > 1024 * 1024) { input.close(); process.stdin.destroy(); return; }
    let message;
    try { message = JSON.parse(line); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    try { send(await handle(message)); }
    catch { if (message?.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Internal error' } }); }
  });
  input.on('close', () => { killChildren(); process.exit(0); });
  process.on('exit', killChildren);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serveStdio();
