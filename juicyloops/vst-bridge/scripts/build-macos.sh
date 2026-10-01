#!/usr/bin/env bash
# macOS build. Linking for macOS needs Apple's SDK, which cannot be shipped in a Docker image, so this runs ON a
# Mac (or a macOS CI runner, see README "Building"): a universal binary for Apple silicon and Intel.
#   rustup target add aarch64-apple-darwin x86_64-apple-darwin
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Run this on macOS. Here, scripts/check.sh at least type-checks the macOS build." >&2
  exit 1
fi
# The oldest macOS the binary runs on, for both architectures (the release notes promise macOS 11+).
export MACOSX_DEPLOYMENT_TARGET=11.0
cargo build --release --locked --target aarch64-apple-darwin
cargo build --release --locked --target x86_64-apple-darwin
# The app: "Juicy Loops Bridge.app" with the Juicy Loops icon, and a zip of it (ditto keeps the bundle's permissions).
version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
app="dist/macos/Juicy Loops Bridge.app"
rm -rf dist/macos
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
lipo -create -output "$app/Contents/MacOS/juicyloops-bridge" \
  target/aarch64-apple-darwin/release/juicyloops-bridge \
  target/x86_64-apple-darwin/release/juicyloops-bridge
cp assets/icon.icns "$app/Contents/Resources/icon.icns"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Juicy Loops Bridge</string>
  <key>CFBundleDisplayName</key><string>Juicy Loops Bridge</string>
  <key>CFBundleIdentifier</key><string>at.daspete.juicyloops.bridge</string>
  <key>CFBundleExecutable</key><string>juicyloops-bridge</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>$MACOSX_DEPLOYMENT_TARGET</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
chmod 755 "$app/Contents/MacOS/juicyloops-bridge"
(cd dist/macos && ditto -c -k --keepParent "Juicy Loops Bridge.app" juicyloops-bridge-macos.zip)
echo "built $app (universal) and dist/macos/juicyloops-bridge-macos.zip. Sign and notarize before distributing:"
echo "  codesign --deep --options runtime --timestamp -s 'Developer ID Application: …' \"$app\""
