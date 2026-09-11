"""Render src-tauri/icon-source.png from logo.png.

The logo is artwork on a matte: a rounded tile sitting on a darker background
with a drop shadow under it. Handing that whole canvas to `tauri icon` is what
makes a taskbar icon read as a black square — the shadow and the matte become
opaque pixels around the mark.

So the tile is cut out and everything outside it made transparent. The bounds
and the corner radius below were measured off the rim highlight the tile carries
on its edge, not guessed: `TILE` is where that rim sits, and `RADIUS` is the
value whose arc passes through the rim at every depth sampled down the corner.

Re-run this after changing logo.png, then `pnpm tauri icon src-tauri/icon-source.png`.
"""
import pathlib
import sys

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "logo.png"
TARGET = ROOT / "src-tauri" / "icon-source.png"
# The mark in the title bar. Derived here rather than exported by hand, so the
# window and the taskbar cannot end up showing two different logos.
BRAND_MARK = ROOT / "src" / "presentation" / "assets" / "brand-mark.png"
BRAND_MARK_SIZE = 96
# The splash window shows the tile at 84 CSS pixels, which is 168 physical ones
# on a display scaled to 200%.
BRAND_TILE = ROOT / "src" / "presentation" / "assets" / "brand-tile.png"
BRAND_TILE_SIZE = 256

# Left, top, right, bottom of the tile within logo.png.
TILE = (89, 79, 1168, 1128)
RADIUS = 220
# Supersampling factor for the corner mask: the arc is drawn large and scaled
# down, which is the cheapest way to get an edge without stair steps.
SCALE = 4
OUTPUT_SIZE = 1024


def main() -> int:
    if not SOURCE.exists():
        print(f"{SOURCE} is missing", file=sys.stderr)
        return 1

    logo = Image.open(SOURCE).convert("RGBA")
    tile = logo.crop(TILE)
    width, height = tile.size

    mask = Image.new("L", (width * SCALE, height * SCALE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, width * SCALE - 1, height * SCALE - 1), radius=RADIUS * SCALE, fill=255
    )
    tile.putalpha(mask.resize((width, height), Image.LANCZOS))

    # The tile is a little wider than it is tall. Squaring it by padding rather
    # than by stretching keeps the scissors circular.
    side = max(width, height)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.alpha_composite(tile, ((side - width) // 2, (side - height) // 2))

    square.resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.LANCZOS).save(TARGET)
    print(f"wrote {TARGET.relative_to(ROOT)} at {OUTPUT_SIZE}x{OUTPUT_SIZE}")

    square.resize((BRAND_MARK_SIZE, BRAND_MARK_SIZE), Image.LANCZOS).save(BRAND_MARK)
    print(f"wrote {BRAND_MARK.relative_to(ROOT)} at {BRAND_MARK_SIZE}x{BRAND_MARK_SIZE}")

    square.resize((BRAND_TILE_SIZE, BRAND_TILE_SIZE), Image.LANCZOS).save(BRAND_TILE)
    print(f"wrote {BRAND_TILE.relative_to(ROOT)} at {BRAND_TILE_SIZE}x{BRAND_TILE_SIZE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
