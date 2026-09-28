# Pinned build image for the Rust DSP crates (juicyloops/dsp).
# Rebuilt automatically by scripts/*.sh; the tag encodes the versions below.
FROM rust:1.98.1-slim-bookworm@sha256:ff521445a372125ed4f76e1453a1f8098f2d05332d1601d30db1c1f62757e730

ARG BINARYEN_VERSION=133
ARG BINARYEN_SHA256=2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && rustup target add wasm32-unknown-unknown \
 && curl -fsSL -o /tmp/binaryen.tgz \
    "https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-x86_64-linux.tar.gz" \
 && echo "${BINARYEN_SHA256}  /tmp/binaryen.tgz" | sha256sum -c - \
 && tar -xzf /tmp/binaryen.tgz -C /opt \
 && ln -s /opt/binaryen-version_${BINARYEN_VERSION}/bin/wasm-opt /usr/local/bin/wasm-opt \
 && rm /tmp/binaryen.tgz \
 && chmod -R a+rwX /usr/local/cargo /usr/local/rustup \
 && wasm-opt --version && rustc --version
