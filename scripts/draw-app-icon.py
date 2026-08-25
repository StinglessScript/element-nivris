#!/usr/bin/env python3
"""Draws a simple placeholder AppIcon.iconset (teal "N" mark) for the standalone macOS .app
bundles. Maintainer-only tool — run via build-standalone-mac.sh, not needed by end users.
Usage: draw-app-icon.py <output-iconset-dir>
"""
import sys
from PIL import Image, ImageDraw, ImageFont

out_dir = sys.argv[1]
teal = (10, 124, 122, 255)
bg = (238, 242, 247, 255)

# (filename, pixel size)
targets = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

cache = {}
for name, sz in targets:
    if sz not in cache:
        img = Image.new("RGBA", (sz, sz), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        radius = int(sz * 0.22)
        d.rounded_rectangle([0, 0, sz - 1, sz - 1], radius=radius, fill=bg)
        border = max(1, int(sz * 0.03))
        d.rounded_rectangle(
            [int(sz * 0.06), int(sz * 0.06), sz - 1 - int(sz * 0.06), sz - 1 - int(sz * 0.06)],
            radius=radius,
            outline=teal,
            width=border,
        )
        try:
            font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", int(sz * 0.56))
        except Exception:
            font = ImageFont.load_default()
        text = "N"
        bbox = d.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        d.text(((sz - tw) / 2 - bbox[0], (sz - th) / 2 - bbox[1]), text, font=font, fill=teal)
        cache[sz] = img
    cache[sz].save(f"{out_dir}/{name}")

print("done")
