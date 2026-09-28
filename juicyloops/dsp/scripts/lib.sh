# Shared helpers for the dsp scripts. Sourced, not executed.
# All compilers run in pinned Docker images; the host needs only bash and docker.

DSP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM_OUT_DEFAULT="$DSP_DIR/../frontend/src/juicyloops/dsp/wasm"

# Rust + binaryen image, built locally from docker/rust.Dockerfile (base image pinned by digest there).
RUST_IMAGE="juicyloops-dsp-rust:1.98.1-b133"
# Emscripten for the Signalsmith Stretch C++ build (ships its own pinned clang + binaryen).
EMSDK_IMAGE="emscripten/emsdk:6.0.10@sha256:e077d54e2b8970575ebc4f185ac1de0b95c05f2b266134d4ba27449af7aebf65"

ensure_rust_image() {
  if ! docker image inspect "$RUST_IMAGE" >/dev/null 2>&1; then
    echo "building $RUST_IMAGE" >&2
    docker build -q -t "$RUST_IMAGE" -f "$DSP_DIR/docker/rust.Dockerfile" "$DSP_DIR/docker" >/dev/null
  fi
}

# Runs a command as the host user with the dsp dir mounted at a fixed path (/src/dsp), so paths baked into
# the binaries are identical on every machine. Cargo's registry cache lives in dsp/.cargo-home (gitignored).
# Extra `-v` mounts can be passed via the DOCKER_EXTRA array.
docker_run() {
  local image="$1"; shift
  local tty=()
  [[ -t 0 && -t 1 ]] && tty=(-t)
  docker run --rm "${tty[@]}" \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -e CARGO_HOME=/src/dsp/.cargo-home \
    -e CARGO_TARGET_DIR=/src/dsp/target \
    -e SOURCE_DATE_EPOCH=0 \
    -v "$DSP_DIR":/src/dsp \
    "${DOCKER_EXTRA[@]}" \
    -w /src/dsp \
    "$image" "$@"
}
DOCKER_EXTRA=()
