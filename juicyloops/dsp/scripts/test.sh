#!/usr/bin/env bash
# Runs the Rust unit tests (host target) in the pinned image. Extra args go to cargo test.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
ensure_rust_image
docker_run "$RUST_IMAGE" cargo test --workspace --locked "$@"
