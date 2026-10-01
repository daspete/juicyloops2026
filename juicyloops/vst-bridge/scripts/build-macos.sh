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
mkdir -p dist/macos
lipo -create -output dist/macos/juicyloops-bridge \
  target/aarch64-apple-darwin/release/juicyloops-bridge \
  target/x86_64-apple-darwin/release/juicyloops-bridge
echo "built dist/macos/juicyloops-bridge (universal). Sign and notarize before distributing:"
echo "  codesign --options runtime --timestamp -s 'Developer ID Application: …' dist/macos/juicyloops-bridge"
