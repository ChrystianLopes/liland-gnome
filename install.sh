#!/usr/bin/env bash
# Installs (or updates) the Liland GNOME extension for the current user.
set -euo pipefail
UUID="liland@zorin.local"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
glib-compile-schemas "$SRC/schemas"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -r "$SRC" "$DEST"
echo "✓ instalado em $DEST"
if gnome-extensions list | grep -q "$UUID"; then
  gnome-extensions enable "$UUID" && echo "✓ ativado"
else
  echo "→ encerre a sessão e entre de novo (Wayland), depois rode: gnome-extensions enable $UUID"
fi
