#!/usr/bin/env python3
"""Verify the bundled .woff2 substitute faces preserve their source .ttf metrics.

Metric compatibility is the whole point of the substitute pack: a .woff2 that silently
changed advance widths or OS/2 line metrics would drift line breaks away from Word.
woff2 is lossless, so this should always pass - but it must be reproducible, not a
one-off, so it lives here as a CI step rather than an ad-hoc run.

Prerequisites:
    pip install fonttools brotli
    The source .ttf files (LibreOffice ships them). Override the location with
    TTF_SRC_DIR if they live elsewhere.

Usage:
    python3 verify-bundled-metrics.py        # exit 0 = all metrics preserved, 1 = mismatch

Compares, for every bundled face, the source .ttf and the committed .woff2:
unitsPerEm, hhea ascent/descent, OS/2 win + typo ascent/descent, and every glyph's
advance width.
"""
import os
import sys

try:
    from fontTools.ttLib import TTFont
except ImportError:
    sys.exit("fonttools not installed - run: pip install fonttools brotli")

ASSETS = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "assets"))
TTF_SRC = os.environ.get(
    "TTF_SRC_DIR", "/Applications/LibreOffice.app/Contents/Resources/fonts/truetype"
)
FAMILIES = ["Carlito", "Caladea", "LiberationSans", "LiberationSerif", "LiberationMono"]
FACES = ["Regular", "Bold", "Italic", "BoldItalic"]


def metric_fingerprint(font):
    head, hhea, os2 = font["head"], font["hhea"], font["OS/2"]
    advances = tuple(font["hmtx"][g][0] for g in font.getGlyphOrder())
    return (
        head.unitsPerEm,
        hhea.ascent,
        hhea.descent,
        os2.usWinAscent,
        os2.usWinDescent,
        os2.sTypoAscender,
        os2.sTypoDescender,
        advances,
    )


def main():
    ok = True
    skipped = 0
    for family in FAMILIES:
        for face in FACES:
            woff2 = os.path.join(ASSETS, f"{family}-{face}.woff2")
            ttf = os.path.join(TTF_SRC, f"{family}-{face}.ttf")
            if not os.path.exists(woff2):
                print(f"MISSING  bundled {family}-{face}.woff2")
                ok = False
                continue
            if not os.path.exists(ttf):
                print(f"SKIP     {family}-{face}: source .ttf not found (set TTF_SRC_DIR)")
                skipped += 1
                continue
            same = metric_fingerprint(TTFont(ttf)) == metric_fingerprint(TTFont(woff2))
            print(f"{'OK  ' if same else 'FAIL'}     {family}-{face}")
            ok = ok and same
    print()
    if skipped:
        print(f"WARNING: {skipped} face(s) skipped (no source .ttf) - not fully verified")
    print("ALL METRICS PRESERVED" if ok else "METRIC VERIFICATION FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
