# Shared helpers for the bridge scripts. Sourced, not executed.
# The compilers run in a pinned Docker image; the host needs only bash and docker.

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BRIDGE_IMAGE="juicyloops-vst-bridge-rust:1.98.1-cross3"

ensure_image() {
  if ! docker image inspect "$BRIDGE_IMAGE" >/dev/null 2>&1; then
    echo "building $BRIDGE_IMAGE" >&2
    docker build -q -t "$BRIDGE_IMAGE" -f "$BRIDGE_DIR/docker/rust.Dockerfile" "$BRIDGE_DIR/docker" >/dev/null
  fi
}

# Runs a command as the host user with the bridge dir mounted at /src/vst-bridge. Cargo's registry cache lives in
# vst-bridge/.cargo-home (gitignored). Extra docker arguments can be passed via the DOCKER_EXTRA array.
docker_run() {
  local tty=()
  [[ -t 0 && -t 1 ]] && tty=(-t)
  docker run --rm "${tty[@]}" \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -e CARGO_HOME=/src/vst-bridge/.cargo-home \
    -e CARGO_TARGET_DIR=/src/vst-bridge/target \
    -v "$BRIDGE_DIR":/src/vst-bridge \
    "${DOCKER_EXTRA[@]}" \
    -w /src/vst-bridge \
    "$BRIDGE_IMAGE" "$@"
}
DOCKER_EXTRA=()
