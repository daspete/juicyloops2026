#!/usr/bin/env bash
# Release build for Linux (x86_64, glibc 2.36+) into dist/linux: the program, its icons, a desktop entry and
# install.sh, which puts all three in place for the user (app menu entry with the Juicy Loops icon).
set -euo pipefail
source "$(dirname "$0")/lib.sh"
ensure_image
docker_run cargo build --release --locked
out="$BRIDGE_DIR/dist/linux"
rm -rf "$out"
mkdir -p "$out/icons"
cp "$BRIDGE_DIR/target/release/juicyloops-bridge" "$out/"
cp "$BRIDGE_DIR/assets/linux/juicyloops-bridge.desktop" "$BRIDGE_DIR/assets/linux/install.sh" "$out/"
for size in 16 32 48 64 128 256 512; do
  cp "$BRIDGE_DIR/assets/icon-$size.png" "$out/icons/"
done
chmod 755 "$out/juicyloops-bridge" "$out/install.sh"
echo "built dist/linux (juicyloops-bridge, install.sh, desktop entry, icons)"
