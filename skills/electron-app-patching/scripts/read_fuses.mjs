#!/usr/bin/env node
// Dependency-free Electron fuse decode, read straight from the binary the app actually ships.
// Why not `npx @electron/fuses read --app <bundle>`: that CLI assumes the framework is
// literally "Contents/Frameworks/Electron Framework.framework/Electron Framework" and fails
// on renamed frameworks (e.g. ChatGPT.app ships "Codex Framework.framework").
//
// Usage: node read_fuses.mjs "/Applications/App.app/Contents/Frameworks/<X> Framework.framework/Versions/A/<X> Framework"
//
// Wire format (stable since Electron 12): sentinel bytes, then [version][count][count state chars].
// State chars: '1' ENABLE, '0' DISABLE, 'r' REMOVED, 0x90 INHERIT.
import { openSync, readSync, closeSync } from 'node:fs';

const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const STATE = { 0x30: 'DISABLE', 0x31: 'ENABLE', 0x72: 'REMOVED', 0x90: 'INHERIT' };
const NAMES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
  'WasmTrapHandlers',
];

const path = process.argv[2];
if (!path) {
  console.error('usage: node read_fuses.mjs <electron-framework-binary>');
  process.exit(2);
}

const CHUNK = 16 << 20;
const fd = openSync(path, 'r');
const buf = Buffer.alloc(CHUNK);
let hay = Buffer.alloc(0);
let base = 0; // file offset of hay[0]
let found = null;

for (;;) {
  const i = hay.indexOf(SENTINEL);
  if (i !== -1 && hay.length >= i + SENTINEL.length + 2 + NAMES.length) {
    found = { hay, i, off: base + i };
    break;
  }
  if (i !== -1) {
    // sentinel found but wire is cut off by the chunk edge — keep from it and read more
    base += i;
    hay = Buffer.from(hay.subarray(i));
  } else {
    const keep = SENTINEL.length - 1;
    const drop = Math.max(0, hay.length - keep);
    base += drop;
    hay = Buffer.from(hay.subarray(drop));
  }
  const n = readSync(fd, buf, 0, CHUNK, null);
  if (n <= 0) break;
  hay = Buffer.concat([hay, buf.subarray(0, n)]);
}
closeSync(fd);

if (!found) {
  console.error('No fuse sentinel found — not an Electron binary, or Electron < 12.');
  process.exit(1);
}

const h = found.hay;
const w = found.i + SENTINEL.length;
const version = h[w];
const count = h[w + 1];
console.log(`sentinel at file offset ${found.off}; fuse wire version '${String.fromCharCode(version)}', ${count} fuses`);
for (let k = 0; k < count; k++) {
  const c = h[w + 2 + k];
  console.log(`  ${(NAMES[k] ?? `fuse#${k}`).padEnd(42)} ${STATE[c] ?? `0x${c.toString(16)}`}`);
}
