"""Render docs/support.png, the card above the README's Ko-fi section.

Composed from the same pieces as the banner, for the same reason: the mark is
`src-tauri/icon-source.png` itself rather than a redrawing of it, the colours
are the interface's own constants, and the nick is set in the brand face
instead of being approximated.

The one colour from outside the palette is Ko-fi's red, and only on the words
that are Ko-fi's. A support card repainted in a donation platform's brand would
read as an advertisement wearing the project's clothes.

The stripe is the product's own argument in one line: eight seconds taken out
of forty, orange for what goes and dusk for what stays, which is the rule the
whole interface follows.

The brand fonts ship as woff2 inside node_modules, which Pillow cannot read, so
they are converted in memory. Needs `pip install pillow fonttools brotli`.
"""
import io
import pathlib
import sys

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICON = ROOT / "src-tauri" / "icon-source.png"
TARGET = ROOT / "docs" / "support.png"
FONT_DIR = ROOT / "node_modules" / "@fontsource-variable"
DISPLAY = FONT_DIR / "bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2"
BODY = FONT_DIR / "instrument-sans/files/instrument-sans-latin-wght-normal.woff2"

WIDTH, HEIGHT = 880, 260
SS = 2  # supersampling, downsampled at the end

MATTE = (9, 10, 11)
PANEL = (16, 19, 22)
LINE = (35, 40, 45)
BLOCK = (36, 52, 74)
ORANGE = (249, 129, 30)
PAPER = (244, 230, 214)
DUSK = (27, 64, 107)
DUSK_LIFT = (91, 135, 188)
MUTED = (141, 146, 153)

# Ko-fi's own red, used only where it says Ko-fi.
KOFI = (255, 94, 91)


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


def cut_stripe(base: Image.Image, x: int, y: int, width: int, height: int) -> None:
    """Eight seconds out of forty, in one line.

    The removed stretch is orange and hatched, the survivors are the block
    colour: the same pair the timeline draws, at the proportion the README's
    screenshots were taken at. It is here because it is what the donation is for.
    """
    draw = ImageDraw.Draw(base, "RGBA")
    radius = height // 2

    # 00:11.933 to 00:19.933 of a forty second clip, which is the cut in the
    # screenshots the README already shows.
    start = x + round(width * (11.933 / 40))
    end = x + round(width * (19.933 / 40))

    draw.rounded_rectangle([x, y, start, y + height], radius, fill=(*BLOCK, 255))
    draw.rounded_rectangle([end, y, x + width, y + height], radius, fill=(*BLOCK, 255))

    condemned = Image.new("RGBA", (end - start, height), (0, 0, 0, 0))
    hatch = ImageDraw.Draw(condemned)
    hatch.rectangle([0, 0, end - start - 1, height - 1], fill=(58, 30, 12, 255))
    for offset in range(-height, end - start + height, 7 * SS):
        hatch.line([(offset, height), (offset + height, 0)], fill=(*ORANGE, 110), width=2 * SS)
    base.alpha_composite(condemned, (start, y))

    # The two rails, the one thing in the interface allowed to be this loud.
    for at in (start, end):
        draw.line(
            [(at, y - 4 * SS), (at, y + height + 4 * SS)], fill=(*ORANGE, 255), width=2 * SS
        )


def main() -> int:
    for path in (ICON, DISPLAY, BODY):
        if not path.exists():
            print(f"{path} is missing", file=sys.stderr)
            return 1

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    base = Image.new("RGBA", (WIDTH * SS, HEIGHT * SS), (*MATTE, 255))
    draw = ImageDraw.Draw(base, "RGBA")

    # The panel, inset, so the card reads as a piece of the interface.
    pad = 14 * SS
    draw.rounded_rectangle(
        [pad, pad, WIDTH * SS - pad, HEIGHT * SS - pad],
        radius=18 * SS,
        fill=(*PANEL, 255),
        outline=(*LINE, 255),
        width=SS,
    )

    # A single pool of dusk behind the mark, which is the only light in the card.
    halo = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ImageDraw.Draw(halo).ellipse(
        [40 * SS, 30 * SS, 300 * SS, 250 * SS], fill=(*DUSK, 46)
    )
    base.alpha_composite(halo.filter(ImageFilter.GaussianBlur(40 * SS)))

    mark_size = 150 * SS
    mark = Image.open(ICON).convert("RGBA").resize((mark_size, mark_size), Image.LANCZOS)
    base.alpha_composite(mark, (46 * SS, (HEIGHT * SS - mark_size) // 2))

    nick = load(DISPLAY, 42, 700)
    line = load(BODY, 19, 450)
    small = load(BODY, 15, 500)

    text_x = 228 * SS
    baseline = 98 * SS

    draw.text((text_x, baseline), "omtstm", font=nick, fill=(*PAPER, 255), anchor="ls")
    nick_width = draw.textlength("omtstm", font=nick)
    draw.text(
        (text_x + nick_width + 12 * SS, baseline),
        "· ko-fi",
        font=small,
        fill=(*KOFI, 255),
        anchor="ls",
    )

    for index, text in enumerate(
        [
            "If Snip Join saved you an afternoon, you can buy me a coffee.",
            "Anything from $5, and thank you.",
        ]
    ):
        draw.text(
            (text_x, (128 + index * 26) * SS), text, font=line, fill=(*MUTED, 255), anchor="ls"
        )

    # The stripe, and what it means, in the words the interface uses.
    #
    # The caption is measured and the stripe takes what is left, rather than both
    # being guessed: a fallback face is wider than the intended one, and a
    # guessed split clips the last word on whichever machine lacks the font.
    caption = "8s out, in about a second"
    caption_width = draw.textlength(caption, font=small)
    stripe_y = 176 * SS
    stripe_height = 12 * SS
    right_edge = (WIDTH - 42) * SS
    gap = 18 * SS
    stripe_width = max(160 * SS, right_edge - caption_width - gap - text_x)

    cut_stripe(base, text_x, stripe_y, stripe_width, stripe_height)
    draw.text(
        (text_x + stripe_width + gap, stripe_y + stripe_height),
        caption,
        font=small,
        fill=(*DUSK_LIFT, 255),
        anchor="ls",
    )

    base.convert("RGB").resize((WIDTH, HEIGHT), Image.LANCZOS).save(TARGET)
    print(f"wrote {TARGET.relative_to(ROOT)} at {WIDTH}x{HEIGHT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
