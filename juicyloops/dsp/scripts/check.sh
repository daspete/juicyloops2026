#!/usr/bin/env bash
# Rebuilds all .wasm artifacts into a temp dir and fails if they differ from the committed ones.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
"$DSP_DIR/scripts/build.sh" "$tmp" >/dev/null

status=0
for f in "$tmp"/*.wasm; do
  name="$(basename "$f")"
  if ! cmp -s "$f" "$WASM_OUT_DEFAULT/$name"; then
    echo "out of date: $name (run yarn dsp:build and commit the result)" >&2
    status=1
  fi
done
for f in "$WASM_OUT_DEFAULT"/*.wasm; do
  [[ -e "$tmp/$(basename "$f")" ]] || { echo "stale file not produced by the build: $(basename "$f")" >&2; status=1; }
done
[[ $status -eq 0 ]] && echo "wasm artifacts up to date"
exit $status
