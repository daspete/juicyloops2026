# Pinned build image for the VST bridge (juicyloops/vst-bridge).
# Same Rust base as the DSP crates; adds the MinGW toolchain so the Windows build can be cross-compiled here.
FROM rust:1.98.1-slim-bookworm@sha256:ff521445a372125ed4f76e1453a1f8098f2d05332d1601d30db1c1f62757e730

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64 \
 && rm -rf /var/lib/apt/lists/* \
 && rustup component add rustfmt clippy \
 && rustup target add x86_64-pc-windows-gnu aarch64-apple-darwin x86_64-apple-darwin \
 && chmod -R a+rwX /usr/local/cargo /usr/local/rustup \
 && rustc --version
