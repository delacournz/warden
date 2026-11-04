# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Static layers of the multi-lane reel: underlay.png (ground, one terminal card + phone ring per lane, the shell
card, footer) and mask.png (one phone's rounded corners; all phones share a size).

usage: lanes-frame.py layout.json underlay.png mask.png
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


def card(box, title):
    x, y, w, h = box
    d.rounded_rectangle((x, y, x + w, y + h), radius=18, fill=SURFACE, outline=LINE, width=1)
    d.line((x, y + lay["titleBar"], x + w, y + lay["titleBar"]), fill=LINE, width=1)
    for i, c in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        d.ellipse((x + 24 + i * 26, y + 15, x + 38 + i * 26, y + 29), fill=c)
    d.text((x + 120, y + 13), title, font=mono, fill=FAINT)


for row in lay["rows"]:
    card(row["card"], row["title"])
    px, py, pw, ph, pr = row["phone"]
    d.rounded_rectangle((px - 3, py - 3, px + pw + 3, py + ph + 3), radius=pr + 3, outline=LINE, width=3)
card(lay["shell"]["card"], lay["shell"]["title"])
d.text((W - lay["margin"], lay["footerY"]), lay["footerRight"], font=mono, fill=FAINT, anchor="ra")
img.save(sys.argv[2])

pw, ph, pr = lay["rows"][0]["phone"][2], lay["rows"][0]["phone"][3], lay["rows"][0]["phone"][4]
mask = Image.new("L", (pw, ph), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, pw - 1, ph - 1), radius=pr, fill=255)
mask.save(sys.argv[3])
