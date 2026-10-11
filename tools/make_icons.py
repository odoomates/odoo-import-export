"""Generate the extension icons (run once; output is committed in src/icons).

    python3 tools/make_icons.py      # needs Pillow

An Odoo-purple tile with two arrows (import: in, in white; export: out, in Odoo teal) over a tray holding a small bar
chart (analyze). Drawn at 1024 px and scaled down; 16 and 32 px use a simplified drawing (bigger
arrows, no bars) so they stay readable in the toolbar.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "src" / "icons"
S = 1024
TOP, BOTTOM = (154, 98, 145), (88, 52, 98)  # Odoo purple, lighter top-left to deep bottom-right
OUT_COLOR = (0, 196, 186, 255)  # Odoo teal: the export arrow
WHITE = (255, 255, 255, 255)
INK = (113, 75, 103, 255)
SH = (6, 32, 70, 95)

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def mask(r=.235):
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * r), fill=255)
    return m

def background():
    g = Image.new("RGBA", (S, S))
    px = g.load()
    for y in range(S):
        for x in range(S):
            t = min(1, max(0, (x * .45 + y * .55) / S))
            px[x, y] = lerp(TOP, BOTTOM, t) + (255,)
    # soft glow in the top-left corner (no hard band)
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([-S * .35, -S * .35, S * .55, S * .55], fill=(255, 255, 255, 38))
    glow = glow.filter(ImageFilter.GaussianBlur(S * .12))
    g.alpha_composite(glow)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(g, (0, 0), mask())
    return out

def arrow(d, x, y0, y1, color, up, w, head):
    w, head = int(S * w), int(S * head)
    if up:
        d.rounded_rectangle([x - w // 2, y0 + head * .7, x + w // 2, y1], radius=w // 2, fill=color)
        d.polygon([(x - head, y0 + head), (x + head, y0 + head), (x, y0 - head * .2)], fill=color)
    else:
        d.rounded_rectangle([x - w // 2, y0, x + w // 2, y1 - head * .7], radius=w // 2, fill=color)
        d.polygon([(x - head, y1 - head), (x + head, y1 - head), (x, y1 + head * .2)], fill=color)

def motif(d, shadow, small):
    c = SH if shadow else None
    # tray (the spreadsheet / Odoo)
    tray = [int(S * .16), int(S * .56), int(S * .84), int(S * .84)]
    d.rounded_rectangle(tray, radius=int(S * .075), fill=c or WHITE)
    if not small and not shadow:
        for k, hgt in enumerate((.09, .15, .21)):
            bx = int(S * (.30 + k * .145)); bw = int(S * .095)
            d.rounded_rectangle([bx, int(S * .765 - S * hgt), bx + bw, int(S * .765)], radius=int(S * .025), fill=INK)
    w, head = (.12, .15) if small else (.09, .115)
    top = .12 if small else .13
    arrow(d, int(S * .36), int(S * top), int(S * .50), c or WHITE, False, w, head)   # import: in
    arrow(d, int(S * .64), int(S * top), int(S * .50), c or OUT_COLOR, True, w, head)    # export: out

def icon(small=False):
    img = background()
    sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    motif(ImageDraw.Draw(sh), True, small)
    sh = sh.filter(ImageFilter.GaussianBlur(S * .02))
    clipped = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    clipped.paste(sh, (0, int(S * .018)), mask())
    img.alpha_composite(clipped)
    motif(ImageDraw.Draw(img), False, small)
    return img



def main():
    OUT.mkdir(parents=True, exist_ok=True)
    big, small = icon(False), icon(True)
    for size in (16, 32, 48, 128):
        src = small if size <= 32 else big
        src.resize((size, size), Image.LANCZOS).save(OUT / f"icon-{size}.png")


if __name__ == "__main__":
    main()
