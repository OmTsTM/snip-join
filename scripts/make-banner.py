"""Render docs/banner.png, the image at the top of the README.

Composed rather than drawn by hand so it can be regenerated when the logo or
the wording changes, and so the palette can only ever be the palette: the
colours below are the ones sampled from logo.png that the interface itself
uses.

The motif on the right is the product in one picture — a stretch taken out of
a timeline, and the two ends closing up. Orange is the part
being removed and nothing else, which is the rule the interface follows.

The brand fonts ship as woff2 inside node_modules, which Pillow cannot read, so
they are converted in memory. Needs `pip install pillow fonttools brotli`.
"""
import io
import pathlib
import sys

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICON = ROOT / "src-tauri" / "icon-source.png"
TARGET = ROOT / "docs" / "banner.png"
FONT_DIR = ROOT / "node_modules" / "@fontsource-variable"
DISPLAY = FONT_DIR / "bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2"
BODY = FONT_DIR / "instrument-sans/files/instrument-sans-latin-wght-normal.woff2"

WIDTH, HEIGHT = 1280, 420
SS = 2  # supersampling; the hairlines and curves need it

MATTE = (9, 10, 11)
DUSK = (27, 64, 107)
PAPER = (244, 230, 214)
ORANGE = (249, 129, 30)
MUTED = (138, 151, 168)
BLOCK = (36, 52, 74)
ARC = (70, 140, 210)


def load(woff2: pathlib.Path, size: int, weight: float) -> ImageFont.FreeTypeFont:
    """Reads a fontsource woff2 as a TrueType Pillow will accept."""
    ttf = TTFont(woff2)
    ttf.flavor = None
    buffer = io.BytesIO()
    ttf.save(buffer)
    buffer.seek(0)
    font = ImageFont.truetype(buffer, size * SS)
    font.set_variation_by_axes([weight])
    return font


def background(base: Image.Image) -> None:
    """A vertical wash from the window at dusk down to the matte."""
    draw = ImageDraw.Draw(base)
    h = HEIGHT * SS
    top = (14, 18, 26)
    for y in range(h):
        t = (y / h) ** 0.9
        draw.line(
            [(0, y), (WIDTH * SS, y)],
            fill=tuple(int(top[i] + (MATTE[i] - top[i]) * t) for i in range(3)),
        )


def glow(base: Image.Image, centre, radius: int, colour, strength: float) -> None:
    """A soft radial light, so the tile sits in the image rather than on it."""
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    steps = 56
    for i in range(steps, 0, -1):
        t = i / steps
        r = int(radius * t)
        draw.ellipse(
            [centre[0] - r, centre[1] - r, centre[0] + r, centre[1] + r],
            fill=(*colour, int(255 * strength * (1 - t) ** 2.2)),
        )
    base.alpha_composite(layer)


def dashed_rect(draw, box, colour, dash: int = 7, space: int = 5) -> None:
    """An outline that reads as an absence rather than as an empty container."""
    left, top, right, bottom = box
    dash, space = dash * SS, space * SS
    for x in range(left, right, dash + space):
        end = min(x + dash, right)
        draw.line([(x, top), (end, top)], fill=(*colour, 255), width=SS)
        draw.line([(x, bottom), (end, bottom)], fill=(*colour, 255), width=SS)
    for y in range(top, bottom, dash + space):
        end = min(y + dash, bottom)
        draw.line([(left, y), (left, end)], fill=(*colour, 255), width=SS)
        draw.line([(right, y), (right, end)], fill=(*colour, 255), width=SS)


def chevron(draw, centre_x: int, y: int, size: int, colour) -> None:
    """The one arrow between the two tracks: source above, result below."""
    draw.line(
        [(centre_x - size, y - size // 2), (centre_x, y + size // 2), (centre_x + size, y - size // 2)],
        fill=(*colour, 235),
        width=3 * SS,
        joint="curve",
    )


def timeline(base: Image.Image, x0: int, y0: int, width: int) -> None:
    draw = ImageDraw.Draw(base, "RGBA")
    track = 50 * SS
    gap = 74 * SS
    radius = 5 * SS

    # --- the cut points a copy is allowed to begin on ----------------------
    ruler = y0 - 24 * SS
    draw.line([(x0, ruler), (x0 + width, ruler)], fill=(*DUSK, 160), width=2 * SS)
    for i in range(17):
        x = x0 + round(i * width / 16)
        major = i % 4 == 0
        draw.line(
            [(x, ruler - (10 if major else 5) * SS), (x, ruler)],
            fill=(110, 170, 235, 255) if major else (*DUSK, 210),
            width=2 * SS,
        )

    cut_a = x0 + round(width * 0.40)
    cut_b = x0 + round(width * 0.62)

    # --- source ------------------------------------------------------------
    draw.rounded_rectangle([x0, y0, cut_a, y0 + track], radius, fill=(*BLOCK, 255))
    draw.rounded_rectangle([cut_b, y0, x0 + width, y0 + track], radius, fill=(*BLOCK, 255))

    # Hatched, not solid: the stretch is going away rather than being another
    # kind of content.
    condemned = Image.new("RGBA", (cut_b - cut_a, track), (0, 0, 0, 0))
    hatch = ImageDraw.Draw(condemned)
    hatch.rounded_rectangle([0, 0, cut_b - cut_a - 1, track - 1], radius, fill=(58, 30, 12, 255))
    for x in range(-track, cut_b - cut_a + track, 9 * SS):
        hatch.line([(x, track), (x + track, 0)], fill=(*ORANGE, 80), width=2 * SS)
    mask = Image.new("L", condemned.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, cut_b - cut_a - 1, track - 1], radius, fill=255
    )
    base.paste(condemned, (cut_a, y0), mask)

    # The rails, the one thing in the interface allowed to be this loud.
    for x in (cut_a, cut_b):
        draw.line([(x, y0 - 9 * SS), (x, y0 + track + 9 * SS)], fill=(*ORANGE, 255), width=3 * SS)
        draw.ellipse([x - 4 * SS, y0 - 13 * SS, x + 4 * SS, y0 - 5 * SS], fill=(*ORANGE, 255))

    # --- the join -----------------------------------------------------------
    y1 = y0 + track + gap
    joined = x0 + width - (cut_b - cut_a)
    chevron(draw, x0 + width // 2, y0 + track + gap // 2, 13 * SS, ARC)

    # --- result -------------------------------------------------------------
    draw.rounded_rectangle([x0, y1, joined, y1 + track], radius, fill=(*BLOCK, 255))
    # The seam the cut left behind, which the interface draws as a torn edge.
    draw.line(
        [(cut_a, y1 - 3 * SS), (cut_a, y1 + track + 3 * SS)], fill=(*ORANGE, 210), width=2 * SS
    )
    # The length that went away, held open so the picture says the video got
    # shorter rather than merely showing a shorter bar. Dashed, or it reads as
    # one more block instead of as an absence.
    dashed_rect(draw, [joined + 6 * SS, y1, x0 + width, y1 + track], (58, 68, 82))


def main() -> int:
    for path in (ICON, DISPLAY, BODY):
        if not path.exists():
            print(f"{path} is missing", file=sys.stderr)
            return 1

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    base = Image.new("RGBA", (WIDTH * SS, HEIGHT * SS), (*MATTE, 255))
    background(base)
    glow(base, (196 * SS, 210 * SS), 215 * SS, DUSK, 0.032)

    icon_size = 232 * SS
    icon = Image.open(ICON).convert("RGBA").resize((icon_size, icon_size), Image.LANCZOS)
    base.alpha_composite(icon, (80 * SS, (HEIGHT * SS - icon_size) // 2))

    draw = ImageDraw.Draw(base)
    draw.text(
        (370 * SS, 196 * SS),
        "Snip Join",
        font=load(DISPLAY, 70, 700),
        fill=PAPER,
        anchor="ls",
    )

    body = load(BODY, 20, 450)
    for i, line in enumerate(
        ["Cut a stretch out of any video in seconds.", "No decoding, no encoding, no waiting."]
    ):
        draw.text((372 * SS, (232 + i * 28) * SS), line, font=body, fill=MUTED, anchor="ls")

    timeline(base, 806 * SS, 138 * SS, 396 * SS)

    base.convert("RGB").resize((WIDTH, HEIGHT), Image.LANCZOS).save(TARGET)
    print(f"wrote {TARGET.relative_to(ROOT)} at {WIDTH}x{HEIGHT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
