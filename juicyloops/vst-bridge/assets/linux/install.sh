#!/usr/bin/env sh
# Installs the Juicy Loops Bridge for this user: the program into ~/.local/bin, its icon and a menu entry (it opens
# in a terminal, which shows the pairing token). Run it from the unpacked folder: ./install.sh
# To remove it again: ./install.sh --uninstall
set -eu
cd "$(dirname "$0")"
bin="${XDG_BIN_HOME:-$HOME/.local/bin}"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
icons="$data/icons/hicolor"

if [ "${1:-}" = "--uninstall" ]; then
    rm -f "$bin/juicyloops-bridge" "$data/applications/juicyloops-bridge.desktop"
    for size in 16 32 48 64 128 256 512; do
        rm -f "$icons/${size}x${size}/apps/juicyloops-bridge.png"
    done
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$data/applications" >/dev/null 2>&1 || true
    command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t "$icons" >/dev/null 2>&1 || true
    echo "Removed the Juicy Loops Bridge. Its settings stay in ~/.config/juicyloops-bridge."
    exit 0
fi

mkdir -p "$bin" "$data/applications"
install -m 755 juicyloops-bridge "$bin/juicyloops-bridge"
for size in 16 32 48 64 128 256 512; do
    mkdir -p "$icons/${size}x${size}/apps"
    install -m 644 "icons/icon-$size.png" "$icons/${size}x${size}/apps/juicyloops-bridge.png"
done
# The menu entry with the full path, so it works even when ~/.local/bin is not on PATH.
sed "s|^Exec=.*|Exec=$bin/juicyloops-bridge|" juicyloops-bridge.desktop > "$data/applications/juicyloops-bridge.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$data/applications" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t "$icons" >/dev/null 2>&1 || true
echo "Installed. Start \"Juicy Loops Bridge\" from your app menu, or run $bin/juicyloops-bridge"
