#!/usr/bin/env node
// Generate a host-specific local marketplace; the installed server runs from this checkout.
import { mkdir, writeFile, realpath, chmod } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { VERSION } from './spr-server.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export async function prepareMarketplace({ build = path.join(root, 'spr-prototype', '.spr-marketplace'), nodePath = process.execPath } = {}) {
const plugin = path.join(build, 'plugins', 'spr-limitbar-prototype');
await mkdir(path.join(build, '.agents', 'plugins'), { recursive: true });
await mkdir(plugin, { recursive: true });
const json = async (file, data) => writeFile(file, JSON.stringify(data, null, 2) + '\n');
await json(path.join(plugin, 'plugin.json'), {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'spr-limitbar-prototype', version: VERSION,
  description: 'Local Codex usage dashboard: an MCP Apps and Desktop entrypoint experiment.',
  author: { name: 'LimitBar' }, license: 'MIT',
  extensions: { 'com.openai': { interface: {
    displayName: 'LimitBar Prototype', shortDescription: 'Inspect local Codex usage limits',
    longDescription: 'A local MCP Apps experiment with sidebar and conversation entrypoints. Requires the LimitBar checkout.',
    developerName: 'LimitBar', category: 'Productivity', capabilities: ['Read', 'Interactive'],
    defaultPrompt: ['Show my Codex usage limits in LimitBar.'],
  } } },
});
await json(path.join(plugin, 'mcp.json'), {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: { 'spr-limitbar': {
    type: 'stdio', command: './spr-launch.sh', args: [],
  } },
});
// Portable MCP commands must be bare executable names or contained ./ paths.
// Keep machine-specific paths inside the development launcher, safely quoted.
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
await writeFile(path.join(plugin, 'spr-launch.sh'),
  '#!/bin/bash\n# Run the local LimitBar development server. No arguments required.\nset -eu\nexec ' +
  quote(await realpath(nodePath)) + ' ' + quote(path.join(root, 'spr-prototype', 'spr-server.mjs')) + '\n');
await chmod(path.join(plugin, 'spr-launch.sh'), 0o755);
await json(path.join(build, '.agents', 'plugins', 'marketplace.json'), {
  name: 'spr-limitbar-lab', interface: { displayName: 'LimitBar Lab' },
  plugins: [{
    name: 'spr-limitbar-prototype', source: { source: 'local', path: './plugins/spr-limitbar-prototype' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity',
  }],
});
return build;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await prepareMarketplace());
}
