#!/usr/bin/env bash
# Release build for Windows (x86_64), cross-compiled with MinGW: dist/windows/juicyloops-bridge.exe
# Not code-signed: sign it (signtool) before handing it to people, or SmartScreen will warn.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
ensure_image
docker_run sh -c 'CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc cargo build --release --locked --target x86_64-pc-windows-gnu'
mkdir -p "$BRIDGE_DIR/dist/windows"
cp "$BRIDGE_DIR/target/x86_64-pc-windows-gnu/release/juicyloops-bridge.exe" "$BRIDGE_DIR/dist/windows/"
echo "built dist/windows/juicyloops-bridge.exe"
