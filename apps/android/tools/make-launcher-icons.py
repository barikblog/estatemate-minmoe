#!/usr/bin/env python3
"""Generate the Sornix EstateOS launcher icons for the Android client.

Why a script instead of hand-drawn files: the Android client is the resident
app, and a launcher icon is part of shipping it. Committing the generator means
the mark (the "SE" monogram on the portal's blue) is reproducible and reviewable
in a diff, and the PNGs it writes can be regenerated if the brand colours in
`app/src/main/res/values/colors.xml` change.

What it writes into app/src/main/res/:

  mipmap-mdpi..xxxhdpi/ic_launcher.png        legacy square icon (48..192 px)
  mipmap-mdpi..xxxhdpi/ic_launcher_round.png   legacy round icon
  drawable-mdpi..xxxhdpi/ic_launcher_foreground.png
                                               adaptive-icon foreground layer
  mipmap-anydpi-v26/ic_launcher.xml            adaptive icon (background + foreground)
  mipmap-anydpi-v26/ic_launcher_round.xml
  values/ic_launcher_background.xml            the adaptive background colour

Usage (needs Pillow; the build itself does not):

    python3 tools/make-launcher-icons.py            # (re)write the icon set
    python3 tools/make-launcher-icons.py --check    # CI gate: complete, sized, no stale icon
    python3 tools/make-launcher-icons.py --strict   # developer check: pixels too

`--check` regenerates into a temporary directory and compares file names and
image geometry against what is committed, so CI fails on a missing icon, a wrong
size, or a leftover icon from a previous brand — without depending on the
rasteriser or the font build of the machine running it (those differ slightly
between FreeType releases, and a red build on an identical icon helps nobody).
`--strict` additionally requires the committed pixels to match this machine's
rendering, which is what a developer runs after changing the mark or the palette.

The monogram is drawn with a font rather than a vector path on purpose: a
three-layer adaptive icon built from text rasterised at the exact densities is
what every launcher actually renders, with no font fallback at runtime.
"""

from __future__ import annotations

import argparse
import pathlib
import sys
import tempfile

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - only reached when the tool is missing
    print("Pillow is required: python3 -m pip install pillow", file=sys.stderr)
    raise SystemExit(2)

HERE = pathlib.Path(__file__).resolve().parent
RES = HERE.parent / "app" / "src" / "main" / "res"

# The portal palette (apps/web/src/App.tsx and MainActivity.kt use the same
# values): blue primary, navy ink, green accent.
BLUE = (23, 105, 224, 255)
GREEN = (53, 208, 127, 255)
WHITE = (255, 255, 255, 255)

# Launcher icon sizes the platform asks for, per density.
LEGACY_SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
# An adaptive-icon foreground layer is 108dp; only the middle 72dp is safe from
# the mask, so the monogram is drawn inside that fraction of the canvas.
FOREGROUND_SIZES = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}

# How much pixel jitter is antialiasing rather than a changed icon. FreeType
# builds hint glyphs slightly differently, so a few edge pixels may differ; any
# pixel differing by more than STRUCTURAL_DELTA, or more than
# PIXEL_SHARE_TOLERANCE of the image changing at all, is a real difference (a
# different mark, colour, size or a stale file).
PIXEL_DELTA_TOLERANCE = 16
STRUCTURAL_DELTA = 96
PIXEL_SHARE_TOLERANCE = 0.02

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
]


def load_font(size: int) -> "ImageFont.FreeTypeFont":
    for candidate in FONT_CANDIDATES:
        if pathlib.Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    raise SystemExit(
        "no bold font found; install DejaVu Sans or Liberation Sans, or add the "
        "font you want to FONT_CANDIDATES in this script"
    )


def centered(draw: "ImageDraw.ImageDraw", text: str, font, canvas: int, y_center: int) -> None:
    box = draw.textbbox((0, 0), text, font=font)
    width = box[2] - box[0]
    height = box[3] - box[1]
    draw.text(
        ((canvas - width) / 2 - box[0], y_center - height / 2 - box[1]),
        text,
        font=font,
        fill=WHITE,
    )


def draw_mark(canvas: int, *, monogram_fraction: float, accent: bool) -> "Image.Image":
    """The mark itself: a white SE monogram, with a green accent bar beneath.

    Drawn on a transparent canvas, so the same code makes the legacy icon (on a
    blue plate) and the adaptive foreground (which the system composites).
    """
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    font = load_font(max(10, int(canvas * monogram_fraction)))
    y_center = int(canvas * (0.46 if accent else 0.5))
    centered(draw, "SE", font, canvas, y_center)
    if accent:
        bar_width = int(canvas * 0.20)
        bar_height = max(2, int(canvas * 0.035))
        left = (canvas - bar_width) // 2
        top = int(canvas * 0.70)
        draw.rounded_rectangle(
            (left, top, left + bar_width, top + bar_height),
            radius=bar_height // 2,
            fill=GREEN,
        )
    return image


def rounded_plate(canvas: int) -> "Image.Image":
    plate = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(plate)
    radius = int(canvas * 0.22)
    draw.rounded_rectangle((0, 0, canvas - 1, canvas - 1), radius=radius, fill=BLUE)
    return plate


def circle_plate(canvas: int) -> "Image.Image":
    plate = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(plate)
    draw.ellipse((0, 0, canvas - 1, canvas - 1), fill=BLUE)
    return plate


def write_png(image: "Image.Image", path: pathlib.Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)


def generate(root: pathlib.Path) -> list[pathlib.Path]:
    written: list[pathlib.Path] = []
    for density, size in LEGACY_SIZES.items():
        mark = draw_mark(size, monogram_fraction=0.42, accent=True)
        square = Image.alpha_composite(rounded_plate(size), mark)
        round_icon = Image.alpha_composite(circle_plate(size), mark)
        for name, image in (("ic_launcher", square), ("ic_launcher_round", round_icon)):
            path = root / f"mipmap-{density}" / f"{name}.png"
            write_png(image, path)
            written.append(path)
    for density, size in FOREGROUND_SIZES.items():
        # The monogram sits in the middle 66% of the layer, which is the part the
        # adaptive mask never crops.
        foreground = draw_mark(size, monogram_fraction=0.30, accent=True)
        path = root / f"drawable-{density}" / "ic_launcher_foreground.png"
        write_png(foreground, path)
        written.append(path)

    anydpi = root / "mipmap-anydpi-v26"
    for name in ("ic_launcher.xml", "ic_launcher_round.xml"):
        path = anydpi / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            '<?xml version="1.0" encoding="utf-8"?>\n'
            "<!-- Generated by tools/make-launcher-icons.py: the adaptive icon the\n"
            "     system masks. Background = the portal blue, foreground = the SE mark. -->\n"
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '    <background android:drawable="@color/ic_launcher_background" />\n'
            '    <foreground android:drawable="@drawable/ic_launcher_foreground" />\n'
            "</adaptive-icon>\n",
            encoding="utf-8",
        )
        written.append(path)

    background = root / "values" / "ic_launcher_background.xml"
    background.parent.mkdir(parents=True, exist_ok=True)
    background.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<!-- Generated by tools/make-launcher-icons.py (the portal's primary blue). -->\n"
        "<resources>\n"
        '    <color name="ic_launcher_background">#1769E0</color>\n'
        "</resources>\n",
        encoding="utf-8",
    )
    written.append(background)
    return written


def relpaths(paths: list[pathlib.Path], base: pathlib.Path) -> list[str]:
    return sorted(str(path.relative_to(base)) for path in paths)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help=(
            "verify the committed icon set instead of writing it: every file the "
            "generator produces is present, correctly sized, and no stale icon is "
            "left behind (safe to gate CI on any machine)"
        ),
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help=(
            "with --check, also require the committed pixels to match this "
            "machine's rasteriser (developer check; a different FreeType build "
            "may hint a glyph a hair differently)"
        ),
    )
    args = parser.parse_args()

    if not args.check and not args.strict:
        written = generate(RES)
        for path in relpaths(written, RES):
            print(f"wrote res/{path}")
        return 0

    with tempfile.TemporaryDirectory() as tmp:
        generated = pathlib.Path(tmp)
        written = generate(generated)
        relative = relpaths(written, generated)
        problems: list[str] = []
        notes: list[str] = []

        for rel in relative:
            expected = generated / rel
            committed = RES / rel
            if not committed.exists():
                problems.append(f"missing: res/{rel}")
                continue
            if rel.endswith(".png"):
                with Image.open(expected) as want, Image.open(committed) as got:
                    if want.size != got.size:
                        problems.append(f"wrong size: res/{rel} is {got.size}, the generator writes {want.size}")
                        continue
                    if want.mode != got.mode:
                        problems.append(f"wrong colour mode: res/{rel} is {got.mode}, the generator writes {want.mode}")
                        continue
                    if want.tobytes() == got.tobytes():
                        continue
                    if not args.strict:
                        # Structure only: the file is the right shape and colour
                        # mode. Pixel equality is deliberately not required here,
                        # because FreeType builds differ in glyph hinting and a
                        # red CI on an identical icon helps nobody.
                        notes.append(
                            f"res/{rel} does not match this machine's rasteriser pixel-for-pixel "
                            "(run --strict locally, or regenerate, after changing the mark)"
                        )
                        continue
                    over, worst, total = pixel_difference(want, got)
                    share = over / total
                    if worst > STRUCTURAL_DELTA or share > PIXEL_SHARE_TOLERANCE:
                        problems.append(
                            f"differs from the generator: res/{rel} "
                            f"({over}/{total} px over {PIXEL_DELTA_TOLERANCE} levels, worst {worst})"
                        )
                    else:
                        notes.append(
                            f"res/{rel}: {over}/{total} px differ by up to {worst} levels "
                            "(rasteriser antialiasing, accepted)"
                        )
            elif committed.read_bytes() != expected.read_bytes():
                problems.append(f"differs from the generator: res/{rel}")

        # Anything committed in an icon slot that the generator does not write is
        # a leftover: an icon from a previous brand that a launcher could still
        # pick up.
        produced = set(relative)
        for pattern in (
            "mipmap-*/ic_launcher*.png",
            "mipmap-anydpi-v26/ic_launcher*.xml",
            "drawable-*/ic_launcher_foreground.png",
            "values/ic_launcher_background.xml",
        ):
            for committed in sorted(RES.glob(pattern)):
                rel = str(committed.relative_to(RES))
                if rel not in produced:
                    problems.append(f"stale icon not produced by the generator: res/{rel}")

        for note in notes:
            print(f"::notice::launcher icons: {note}")
        if problems:
            for problem in problems:
                print(f"::error::launcher icons: {problem}", file=sys.stderr)
            print("run: python3 apps/android/tools/make-launcher-icons.py", file=sys.stderr)
            return 1
        mode = "strict" if args.strict else "structural"
        print(f"launcher icons OK ({len(produced)} files, {mode} check)")
        return 0


def pixel_difference(a: "Image.Image", b: "Image.Image") -> tuple[int, int, int]:
    """Pixels differing by more than the jitter tolerance, the worst delta, and the total.

    The per-pixel delta is the largest of the four channels; ImageChops keeps this off the
    deprecated per-pixel APIs (``getdata``/``load``) that Pillow is retiring.
    """
    diff = ImageChops.difference(a, b)
    bands = [diff.getchannel(index) for index in range(4)]
    worst_per_pixel = ImageChops.lighter(
        ImageChops.lighter(bands[0], bands[1]),
        ImageChops.lighter(bands[2], bands[3]),
    )
    histogram = worst_per_pixel.histogram()
    over = sum(histogram[PIXEL_DELTA_TOLERANCE + 1:])
    worst = max((level for level, count in enumerate(histogram) if count), default=0)
    return over, worst, a.size[0] * a.size[1]


if __name__ == "__main__":
    raise SystemExit(main())
