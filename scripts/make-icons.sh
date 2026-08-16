#!/usr/bin/env bash
# Regenerate the extension icons: a Bluesky-blue tile with an open eye,
# the "hidden post made visible" idea. Requires ImageMagick.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/icons"
mkdir -p "$out"

base="$out/icon512.png"

magick_cmd=$(command -v magick || command -v convert)

"$magick_cmd" -size 512x512 xc:none \
  -fill '#1083fe' -draw 'roundrectangle 0,0 511,511 112,112' \
  -fill white -draw 'path "M 72,256 C 150,138 362,138 440,256 C 362,374 150,374 72,256 Z"' \
  -fill '#1083fe' -draw 'circle 256,256 256,326' \
  -fill white -draw 'circle 300,212 300,232' \
  "$base"

for size in 16 32 48 128; do
  "$magick_cmd" "$base" -resize "${size}x${size}" "$out/icon${size}.png"
done

rm -f "$base"
echo "wrote $out/icon{16,32,48,128}.png"
