#!/usr/bin/env bash
# Formatting, lints and a type-check of every target OS (Linux, Windows, macOS) without building them.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
ensure_image
docker_run cargo fmt --check
docker_run cargo clippy --all-targets --locked -- -D warnings
docker_run cargo check --locked --target x86_64-pc-windows-gnu
docker_run cargo check --locked --target aarch64-apple-darwin
echo "check ok"
