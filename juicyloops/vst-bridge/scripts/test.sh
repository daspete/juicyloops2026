#!/usr/bin/env bash
# Unit and integration tests. The plugin tests use real CLAP and VST3 plugins built by scripts/fixtures.sh and
# are skipped (with a note) when those are missing; pass --fixtures to build them first.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
ensure_image
if [[ "${1:-}" == "--fixtures" ]]; then
  bash "$(dirname "$0")/fixtures.sh"
fi
docker_run cargo test --locked -- --nocapture
