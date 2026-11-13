# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Draws the static layers of the dev reel: underlay.png (ground, terminal card with title bar, phone ring, footer
facts) and mask.png (the phone's rounded corners). The moving layers (TUI gif, phone video) are composited by ffmpeg.

usage: dev-frame.py layout.json underlay.png mask.png
"""

import json
import sys

from PIL import Image, ImageDraw, ImageFont

lay = json.load(open(sys.argv[1]))
W, H = lay["width"], lay["height"]
BG = (15, 15, 14)
SURFACE = (23, 23, 21)
LINE = (48, 47, 42)
FAINT = (111, 108, 100)

mono = ImageFont.truetype(lay["monoFont"], 17)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)
cx, cy, cw, ch = lay["card"]
d.rounded_rectangle((cx, cy, cx + cw, cy + ch), radius=18, fill=SURFACE, outline=LINE, width=1)
d.line((cx, cy + lay["titleBar"], cx + cw, cy + lay["titleBar"]), fill=LINE, width=1)
for i, c in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
    d.ellipse((cx + 24 + i * 26, cy + 15, cx + 38 + i * 26, cy + 29), fill=c)
d.text((cx + 120, cy + 13), lay["terminalTitle"], font=mono, fill=FAINT)
px, py, pw, ph, pr = lay["phone"]
d.rounded_rectangle((px - 3, py - 3, px + pw + 3, py + ph + 3), radius=pr + 3, outline=LINE, width=3)
d.text((lay["margin"], lay["footerY"]), lay["footerLeft"], font=mono, fill=FAINT)
d.text((W - lay["margin"], lay["footerY"]), lay["footerRight"], font=mono, fill=FAINT, anchor="ra")
img.save(sys.argv[2])

mask = Image.new("L", (pw, ph), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, pw - 1, ph - 1), radius=pr, fill=255)
mask.save(sys.argv[3])
