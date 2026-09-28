#!/usr/bin/env bash
# Builds every committed .wasm artifact:
#   synth-worklet.wasm  Rust, wasm32-unknown-unknown, wasm-opt -O3
#   stretch.wasm        Signalsmith Stretch (C++) via Emscripten, standalone (one import: env.emscripten_notify_memory_growth)
# Usage: scripts/build.sh [out_dir]   (default: frontend/src/juicyloops/dsp/wasm)
set -euo pipefail
source "$(dirname "$0")/lib.sh"

out="${1:-$WASM_OUT_DEFAULT}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
DOCKER_EXTRA=(-v "$out":/out)

ensure_rust_image

echo "==> synth-worklet (rust)"
docker_run "$RUST_IMAGE" bash -euo pipefail -c '
  cargo build --release --locked --target wasm32-unknown-unknown -p juicyloops-synth-worklet
  # Features = what rustc enables for the default "generic" wasm32 CPU (all in Safari 15+, Chrome, Firefox).
  wasm-opt -O3 --strip-debug --strip-producers --strip-target-features \
    --enable-bulk-memory --enable-bulk-memory-opt --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals --enable-multivalue --enable-reference-types --enable-call-indirect-overlong \
    target/wasm32-unknown-unknown/release/juicyloops_synth_worklet.wasm -o /out/synth-worklet.wasm
'

echo "==> stretch (emscripten)"
docker_run "$EMSDK_IMAGE" bash -euo pipefail -c '
  cd stretch
  em++ stretch.cpp -o /out/stretch.wasm \
    -O3 -DNDEBUG -std=c++17 -fno-exceptions -fno-rtti -ffast-math \
    -I vendor/signalsmith-stretch -I vendor/signalsmith-linear/include \
    -sSTANDALONE_WASM=1 --no-entry -sFILESYSTEM=0 -sMALLOC=emmalloc -sABORTING_MALLOC=0 \
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=1mb -sMAXIMUM_MEMORY=2gb -sSTACK_SIZE=256kb
'
chmod 644 "$out"/*.wasm

ls -l "$out"/*.wasm
