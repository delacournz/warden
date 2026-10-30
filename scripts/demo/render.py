# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Draws the demo frame (title + typing terminal + phone ring) as raw RGB on stdout, from plan.json.

usage: render.py plan.json mask.png [--mask-only]
The phone video is composited by ffmpeg (demo.ts); this writes the mask it needs.
"""

import json
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
PHONE = (1289, 50, 451, 980)  # x, y, w, h (matches timeline.ts)
PHONE_RADIUS = 62
BODY_TOP = 380

# the docs site's Device Hub dark tokens (apps/docs/DESIGN.md), same as the example app's theme.css
BG = (15, 15, 14)  # ground
SURFACE = (23, 23, 21)  # surface
LINE = (48, 47, 42)  # hairline
TEXT = (243, 241, 234)  # ink
MUTED = (156, 153, 143)  # ink-2
FAINT = (111, 108, 100)  # ink-2 toward ground
SCAN = (255, 106, 61)  # accent
OPEN = (48, 209, 88)  # lease

plan = json.load(open(sys.argv[1]))
fonts = plan["fontsDir"]
MONO = f"{fonts}/martian-mono/400Regular/MartianMono_400Regular.ttf"
DISPLAY = f"{fonts}/mona-sans/800ExtraBold/MonaSans_800ExtraBold.ttf"
BODY = f"{fonts}/mona-sans/400Regular/MonaSans_400Regular.ttf"

layout = plan["layout"]
FPS = plan["fps"]
OUTRO_AT = plan["outroS"]
STEPS = plan["steps"]
PITCH, OUT_OFF, FONT_PX = layout["entryPitch"], layout["outputOffset"], layout["fontPx"]

title_font = ImageFont.truetype(DISPLAY, 70)
sub_font = ImageFont.truetype(BODY, 30)
mono = ImageFont.truetype(MONO, FONT_PX)
mono_small = ImageFont.truetype(MONO, 19)


def fit(text: str, font: ImageFont.FreeTypeFont, width: int) -> str:
    while text and font.getlength(text) > width:
        text = text[:-2] + "…"
    return text


def base() -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    x, y, w, h = PHONE
    d.rounded_rectangle((x - 3, y - 3, x + w + 3, y + h + 3), radius=PHONE_RADIUS + 3, outline=LINE, width=3)
    d.text((150, 118), plan["title"], font=title_font, fill=TEXT)
    d.text((152, 214), plan["subtitle"], font=sub_font, fill=MUTED)
    d.rounded_rectangle((150, 300, 1170, 900), radius=18, fill=SURFACE)
    d.line((150, 352, 1170, 352), fill=LINE, width=1)
    for i, c in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        d.ellipse((176 + i * 26, 318, 190 + i * 26, 332), fill=c)
    d.text((280, 314), plan["terminalTitle"], font=mono_small, fill=FAINT)
    d.text((150, 960), plan["footer"]["left"], font=mono_small, fill=FAINT)
    d.text((1170, 960), plan["footer"]["right"], font=mono_small, fill=FAINT, anchor="ra")
    return img


def check(d: ImageDraw.ImageDraw, cx: int, cy: int) -> None:
    # the mono face has no check glyph: draw it as a vector, scaled to the font
    s = FONT_PX / 25
    pts = [(1, 16), (7, 22), (17, 9)]
    d.line([(cx + px * s, cy + py * s) for px, py in pts], fill=OPEN, width=max(2, round(3 * s)), joint="curve")


def frame(bg: Image.Image, t: float) -> Image.Image:
    img = bg.copy()
    d = ImageDraw.Draw(img)
    x0 = 182
    text_w = 1170 - 32 - x0 - 30
    started = [i for i, s in enumerate(STEPS) if t >= s["typeStartS"]]
    scroll_by = max(0, len(started) - layout["visibleEntries"]) if layout["scroll"] else 0
    y = BODY_TOP - scroll_by * PITCH
    cursor = None
    for i, s in enumerate(STEPS):
        if t < s["typeStartS"]:
            cursor = cursor or (x0, y)
            break
        cmd = s["shown"]
        span = max(1e-6, s["fireS"] - s["typeStartS"])
        typed = cmd[: max(0, min(len(cmd), int((t - s["typeStartS"]) / span * len(cmd))))]
        if y >= BODY_TOP - 1:
            d.text((x0, y), "$", font=mono, fill=SCAN)
            d.text((x0 + 30, y), fit(typed, mono, text_w), font=mono, fill=TEXT)
        if t < s["outputS"]:
            cursor = (x0 + 30 + d.textlength(typed, font=mono) + (4 if typed else 0), y)
            break
        out = s["output"]
        if y >= BODY_TOP - 1:
            oy = y + OUT_OFF
            if out["kind"] == "ok":
                check(d, x0 + 30, oy)
                d.text((x0 + 30 + round(30 * FONT_PX / 25), oy), fit(out["text"], mono, text_w), font=mono, fill=OPEN)
            else:
                d.text((x0 + 30, oy), fit(out["text"], mono, text_w), font=mono, fill=MUTED)
        y += PITCH
    if t >= OUTRO_AT:
        note = fit(plan["outro"], mono, text_w)
        d.text((x0, y), note, font=mono, fill=FAINT)
        cursor = cursor or (x0 + d.textlength(note, font=mono) + 12, y)
    cursor = cursor or (x0, y)
    if int(t * 2) % 2 == 0 or t < OUTRO_AT:
        cx, cy = cursor
        d.rectangle((cx, cy + 3, cx + round(13 * FONT_PX / 25), cy + round(31 * FONT_PX / 25)), fill=TEXT)
    return img


mask = Image.new("L", (PHONE[2], PHONE[3]), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, PHONE[2] - 1, PHONE[3] - 1), radius=PHONE_RADIUS, fill=255)
mask.save(sys.argv[2])
if "--mask-only" in sys.argv:
    sys.exit(0)

bg = base()
out = sys.stdout.buffer
for n in range(int(plan["durationS"] * FPS)):
    out.write(frame(bg, n / FPS).tobytes())
