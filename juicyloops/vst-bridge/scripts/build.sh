#!/usr/bin/env bash
# Release build for Linux (x86_64, glibc 2.36+): dist/linux/juicyloops-bridge
set -euo pipefail
source "$(dirname "$0")/lib.sh"
ensure_image
docker_run cargo build --release --locked
mkdir -p "$BRIDGE_DIR/dist/linux"
cp "$BRIDGE_DIR/target/release/juicyloops-bridge" "$BRIDGE_DIR/dist/linux/"
echo "built dist/linux/juicyloops-bridge"
