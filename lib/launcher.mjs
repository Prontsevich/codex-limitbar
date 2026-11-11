// Install a small macOS app that runs start.sh without opening Terminal.
// Usage: node lib/launcher.mjs <install|check|uninstall> <repo> <launcher.app> [app] [node]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [mode, repo, destination, app, node] = process.argv.slice(2);
if (!['install', 'check', 'uninstall'].includes(mode) || !repo || !destination) {
  throw new Error('usage: launcher.mjs <install|check|uninstall> <repo> <launcher.app> [app] [node]');
}
const marker = path.join(destination, 'Contents/Resources/spr-limitbar-repo');
const exists = fs.existsSync(destination) || (() => {
  try { fs.lstatSync(destination); return true; } catch { return false; }
})();
const owned = exists && !fs.lstatSync(destination).isSymbolicLink() && (() => {
  try { return fs.readFileSync(marker, 'utf8').trim() === repo; } catch { return false; }
})();
if (mode === 'check') {
  console.log(`launcher: ${owned ? destination : exists ? `${destination} exists but is not ours` : `not installed (would create ${destination})`}`);
} else if (mode === 'uninstall') {
  if (owned) {
    fs.rmSync(destination, { recursive: true });
    console.log(`done:  remove ${destination}`);
  } else if (exists) console.log(`skip:  ${destination} is not our launcher`);
} else {
  if (!app || !node) throw new Error('install requires the app and Node paths');
  if (exists && !owned) throw new Error(`${destination} exists and is not our launcher; move it away first`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), '.spr-limitbar-launcher-'));
  try {
    const contents = path.join(staging, 'Contents');
    const resources = path.join(contents, 'Resources');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.mkdirSync(resources);
    fs.writeFileSync(path.join(resources, 'spr-limitbar-repo'), `${repo}\n`);
    fs.writeFileSync(path.join(resources, 'spr-limitbar-node'), `${node}\n`);
    fs.writeFileSync(path.join(resources, 'spr-limitbar-app'), `${app}\n`);
    let icon = '';
    try {
      let name = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (!path.extname(name)) name += '.icns';
      fs.copyFileSync(path.join(app, 'Contents/Resources', path.basename(name)), path.join(resources, 'spr-limitbar.icns'));
      icon = '<key>CFBundleIconFile</key><string>spr-limitbar.icns</string>';
    } catch { /* The launcher also works without an app icon. */ }
    fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.spr.limitbar.launcher</string>
<key>CFBundleName</key><string>Codex with LimitBar</string>
<key>CFBundleDisplayName</key><string>Codex with LimitBar</string>
<key>CFBundleExecutable</key><string>spr-limitbar-launcher</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
${icon}
</dict></plist>
`);
    fs.writeFileSync(path.join(contents, 'MacOS/spr-limitbar-launcher'), `#!/bin/bash
set -eu
RESOURCES="$(cd "$(dirname "$0")/../Resources" && pwd)"
REPO="$(cat "$RESOURCES/spr-limitbar-repo")"
export CODEX_LIMITBAR_NODE="$(cat "$RESOURCES/spr-limitbar-node")"
export CODEX_LIMITBAR_APP="$(cat "$RESOURCES/spr-limitbar-app")"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
LOG="$HOME/Library/Logs/spr-limitbar-launcher.log"
mkdir -p "$(dirname "$LOG")"
if "$REPO/start.sh" >"$LOG" 2>&1; then exit 0; fi
/usr/bin/osascript - "$LOG" <<'APPLESCRIPT'
on run argv
  display alert "Codex with LimitBar could not start" message "See " & item 1 of argv & ". If the repository was moved, run install.sh --app again." as critical
end run
APPLESCRIPT
exit 1
`, { mode: 0o755 });
    if (owned) fs.rmSync(destination, { recursive: true });
    fs.renameSync(staging, destination);
    console.log(`launcher: installed ${destination}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
