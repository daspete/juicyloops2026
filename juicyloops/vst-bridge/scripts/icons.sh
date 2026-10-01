#!/usr/bin/env bash
# Renders the app icon into every format the builds use, and writes them next to it:
#   icon-<size>.png   16..1024 from icon.svg (Linux, and the sources of the Windows icon)
#   icon.ico          Windows: embedded into juicyloops-bridge.exe (build.rs, assets/windows.rc)
#   icon.icns         macOS, from icon-macos.svg (the macOS icon grid): the Juicy Loops Bridge.app bundle
#   icon-64.rgba      raw 64x64 RGBA for the plugin windows' icon (src/gui.rs), so no image decoder is needed
# The outputs are committed; run this only after changing an icon SVG. Needs only Docker.
set -euo pipefail
ASSETS="$(cd "$(dirname "$0")/../assets" && pwd)"
docker run --rm -v "$ASSETS":/assets -w /assets debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 sh -euc '
  apt-get update -qq >/dev/null
  apt-get install -y -qq --no-install-recommends librsvg2-bin imagemagick icnsutils >/dev/null
  for size in 16 24 32 48 64 128 256 512 1024; do
    rsvg-convert -w $size -h $size icon.svg -o icon-$size.png
  done
  convert icon-16.png icon-24.png icon-32.png icon-48.png icon-64.png icon-128.png icon-256.png icon.ico
  mkdir -p /tmp/mac
  for size in 16 32 128 256 512 1024; do
    rsvg-convert -w $size -h $size icon-macos.svg -o /tmp/mac/$size.png
  done
  png2icns icon.icns /tmp/mac/16.png /tmp/mac/32.png /tmp/mac/128.png /tmp/mac/256.png /tmp/mac/512.png /tmp/mac/1024.png >/dev/null
  convert icon-64.png -depth 8 rgba:icon-64.rgba
  chown '"$(id -u):$(id -g)"' icon*
'
ls -l "$ASSETS"
