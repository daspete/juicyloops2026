#!/usr/bin/env bash
# Builds the open-source test plugins the bridge's plugin tests load (Linux builds, in Docker):
#   CLAP: Clack's example polysynth and gain (MIT/Apache-2.0)          -> fixtures/build/clap/*.clap
#   VST3: vst3-rs' example gain (MIT/Apache-2.0),
#         vst3-host's TestSynth (MIT)                                  -> fixtures/build/vst3/*.vst3
# Sources are fetched at pinned commits into fixtures/src (gitignored). Only test fixtures: nothing is shipped.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
ensure_image

CLACK_COMMIT=27ca28391b57a61bad4bb5099288a7bf9247350d
VST3RS_COMMIT=b2a45f2d40e602eff5a224b41613735388868590
VST3HOST_COMMIT=49fc189177c72cf799d5034fcca81d8aacc3d7a6

SRC="$BRIDGE_DIR/fixtures/src"
OUT="$BRIDGE_DIR/fixtures/build"
mkdir -p "$SRC" "$OUT/clap" "$OUT/vst3"

fetch() { # name url commit
  if [[ ! -d "$SRC/$1/.git" ]]; then
    git clone -q "$2" "$SRC/$1"
  fi
  git -C "$SRC/$1" fetch -q --depth 1 origin "$3" 2>/dev/null || true
  git -C "$SRC/$1" -c advice.detachedHead=false checkout -q "$3"
}
fetch clack https://github.com/prokopyl/clack.git "$CLACK_COMMIT"
fetch vst3-rs https://github.com/coupler-rs/vst3-rs.git "$VST3RS_COMMIT"
fetch rust-vst3-host https://github.com/HelgeSverre/rust-vst3-host.git "$VST3HOST_COMMIT"

build() { # dir cargo-args...
  local dir="$1"; shift
  docker_run sh -c "cd fixtures/src/$dir && CARGO_TARGET_DIR=/src/vst-bridge/target/fixtures cargo build --release $*"
}
build clack -p clack-plugin-polysynth -p clack-plugin-gain
build vst3-rs --example gain
build rust-vst3-host -p vst3-host-testplug

T="$BRIDGE_DIR/target/fixtures/release"
cp "$T/libclack_plugin_polysynth.so" "$OUT/clap/clack-polysynth.clap"
cp "$T/libclack_plugin_gain.so" "$OUT/clap/clack-gain.clap"

bundle() { # library name
  local dir="$OUT/vst3/$2.vst3/Contents/x86_64-linux"
  rm -rf "$OUT/vst3/$2.vst3"; mkdir -p "$dir"
  cp "$1" "$dir/$2.so"
}
bundle "$T/examples/libgain.so" "RsGain"
bundle "$T/libvst3_host_testplug.so" "TestSynth"
echo "fixtures in $OUT:"; find "$OUT" -name '*.clap' -o -name '*.so' | sed "s|$OUT/||"
