"""Generate the store promo images into store/ (Chrome: small tile 440x280, marquee 1400x560).

    python3 tools/make_store_images.py      # needs Pillow and the Noto Sans fonts
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "store"
FONTS = Path("/usr/share/fonts/truetype/noto")
PURPLE = (113, 75, 103)
PURPLE_DARK = (84, 54, 76)
TEAL = (0, 196, 186)
WHITE = (255, 255, 255)
SOFT = (236, 226, 233)


def font(name, size):
    return ImageFont.truetype(str(FONTS / name), size)


def tile(width, height, title_size, tag_size, icon_size, tagline):
    img = Image.new("RGB", (width, height), PURPLE)
    d = ImageDraw.Draw(img)
    d.polygon([(width * .58, 0), (width, 0), (width, height), (width * .38, height)], fill=PURPLE_DARK)
    icon = Image.open(ROOT / "src" / "icons" / "icon-128.png").convert("RGBA").resize((icon_size, icon_size), Image.LANCZOS)
    pad = round(height * .13)
    top = (height - icon_size) // 2 - round(height * .12)
    img.paste(icon, (pad, top), icon)
    x = pad + icon_size + round(pad * .6)
    bold = font("NotoSans-Bold.ttf", title_size)
    d.text((x, top - round(title_size * .12)), "Odoo", font=bold, fill=SOFT)
    w = d.textlength("Odoo ", font=bold)
    d.text((x + w, top - round(title_size * .12)), "Import Export", font=bold, fill=WHITE)
    d.text((x, top + round(title_size * 1.2)), "Import · Export · Analyze", font=font("NotoSans-SemiBold.ttf", tag_size), fill=TEAL)
    ty = top + icon_size + round(height * .08)
    for k, line in enumerate(tagline):
        d.text((pad, ty + k * round(tag_size * 1.4)), line, font=font("NotoSans-Regular.ttf", round(tag_size * .82)), fill=SOFT)
    return img


def main():
    OUT.mkdir(exist_ok=True)
    tile(440, 280, 25, 15, 64, ["Any Odoo model · Odoo 16 to 20"]).save(OUT / "promo-small-440x280.png")
    tile(1400, 560, 84, 40, 160, [
        "Spreadsheets in with automatic matching, a dry run and undo",
        "Excel or CSV out · charts with PNG, Excel and PDF · Odoo 16 to 20",
    ]).save(OUT / "promo-marquee-1400x560.png")


if __name__ == "__main__":
    main()
