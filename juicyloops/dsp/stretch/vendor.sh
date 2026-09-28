#!/usr/bin/env bash
# Re-vendors the header-only Signalsmith sources listed in vendor/VERSIONS (edit the commits there first).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() { # name url commit
  git -C "$tmp" init -q "$1"
  git -C "$tmp/$1" fetch -q --depth 1 "$2" "$3"
  git -C "$tmp/$1" checkout -q FETCH_HEAD
}

while read -r name url _version commit; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  fetch "$name" "$url" "$commit"
done < "$here/vendor/VERSIONS"

v="$here/vendor"
cp "$tmp/signalsmith-stretch/signalsmith-stretch.h" "$tmp/signalsmith-stretch/LICENSE.txt" "$v/signalsmith-stretch/"
cp "$tmp/signalsmith-linear/fft.h" "$tmp/signalsmith-linear/stft.h" "$tmp/signalsmith-linear/LICENSE.txt" "$v/signalsmith-linear/"
cp "$tmp/signalsmith-linear/include/signalsmith-linear/stft.h" "$v/signalsmith-linear/include/signalsmith-linear/"
echo "vendored into $v"
