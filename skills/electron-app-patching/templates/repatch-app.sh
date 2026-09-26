#!/usr/bin/env bash
# Repack a macOS Electron app's asar with a patch, update the integrity hash if required,
# re-sign ad-hoc and relaunch. Copy and adapt: set APP, PATCH_CMD, WORK.
# Prototype against a COPY of the app first; keep this script for re-runs after every update.
set -euo pipefail

APP="${APP:?set APP, e.g. /Applications/YourApp.app}"
WORK="${WORK:-$HOME/electron-patch}"
PATCH_CMD="${PATCH_CMD:?set PATCH_CMD, e.g. python3 apply_patch.py}"
ASAR="$APP/Contents/Resources/app.asar"
APP_NAME="$(basename "$APP" .app)"

mkdir -p "$WORK"; cd "$WORK"
# local module is used for the header-hash step below (npx resolves its own CLI for extract/pack)
[ -d node_modules/@electron/asar ] || npm i --silent @electron/asar

# 1. Quit the app
if pgrep -x "$APP_NAME" >/dev/null; then osascript -e "quit app \"$APP_NAME\"" || true; sleep 2; fi

# 2. Back up the original asar once
[ -f app.asar.orig.bak ] || cp "$ASAR" app.asar.orig.bak

# 3. Extract fresh
rm -rf asar-extracted
npx -y @electron/asar extract "$ASAR" asar-extracted

# 4. Apply the patch to asar-extracted (edit to your patch command)
$PATCH_CMD asar-extracted

# 5. Repack keeping the ORIGINAL unpack layout. Derive the globs from the app's own
#    app.asar.unpacked when they differ; native modules left packed will fail to load.
rm -rf app.asar.patched app.asar.patched.unpacked
npx -y @electron/asar pack asar-extracted app.asar.patched \
  --unpack '**/{*.node,*.dylib,spawn-helper,*.so}'

# 6. Swap asar + unpacked together
cp "$ASAR" app.asar.pre-patch.bak
rm -rf "$APP/Contents/Resources/app.asar.unpacked"
cp -R app.asar.patched.unpacked "$APP/Contents/Resources/app.asar.unpacked"
cp app.asar.patched "$ASAR"

# 7. ONLY if the EmbeddedAsarIntegrityValidation fuse is ENABLED (check with
#    scripts/read_fuses.mjs first): update Info.plist → ElectronAsarIntegrity.
#    Formula: sha256 over the asar header JSON string (rawHeader.headerString).
#    A wrong or missing hash makes Electron forcefully terminate the app at launch.
NEW_HASH=$(NODE_PATH="$WORK/node_modules" node - "$ASAR" <<'NODE'
const asar = require('@electron/asar');
const crypto = require('node:crypto');
const h = asar.getRawHeader(process.argv[2]);
process.stdout.write(crypto.createHash('sha256').update(h.headerString).digest('hex'));
NODE
)
python3 - "$APP/Contents/Info.plist" "$NEW_HASH" <<'PY'
import plistlib, sys
plist_path, new_hash = sys.argv[1], sys.argv[2]
with open(plist_path, 'rb') as f:
    plist = plistlib.load(f)
plist['ElectronAsarIntegrity']['Resources/app.asar']['hash'] = new_hash
with open(plist_path, 'wb') as f:
    plistlib.dump(plist, f)
print('integrity hash updated:', new_hash[:16], '...')
PY

# 8. Re-sign ad-hoc. The Developer ID signature is gone after this: expect TCC permission
#    resets (Accessibility, Screen Recording, Automation, Mic/Camera) and possible
#    Keychain / Safe Storage prompts that the user must re-grant.
codesign --force --deep --sign - "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

open -a "$APP"
echo "DONE — patched asar installed into $APP"
