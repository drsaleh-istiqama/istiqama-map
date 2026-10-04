"""Optimise the user-guide screenshots.

Reads the raw PNGs written by apps/web/tests/e2e/screenshots.spec.ts
(.local/screens/guide/<lang>/*.png) and writes small palette PNGs to docs/screens/<lang>/.

    python docs/screens/optimize.py            # every language found
    python docs/screens/optimize.py ar         # one language

Phone shots are taken at device scale factor 2 (786 px wide); they are kept at that width so
Arabic text stays crisp. Desktop shots wider than 1280 px are scaled down. Every image is
reduced to a 256-colour adaptive palette (no dithering: flat UI colours stay clean) and saved
with PNG optimisation. Needs Pillow (no network access).
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / ".local" / "screens" / "guide"
OUT = ROOT / "docs" / "screens"
MAX_WIDTH = 1280


def optimise(src: Path, dst: Path) -> tuple[int, int]:
    image = Image.open(src).convert("RGB")
    if image.width > MAX_WIDTH:
        height = round(image.height * MAX_WIDTH / image.width)
        image = image.resize((MAX_WIDTH, height), Image.Resampling.LANCZOS)
    palette = image.quantize(
        colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE
    )
    dst.parent.mkdir(parents=True, exist_ok=True)
    palette.save(dst, format="PNG", optimize=True)
    return src.stat().st_size, dst.stat().st_size


def main(argv: list[str]) -> int:
    langs = argv or sorted(p.name for p in RAW.iterdir() if p.is_dir()) if RAW.exists() else argv
    if not langs:
        print(f"no raw screenshots in {RAW}")
        return 1
    total_in = total_out = count = 0
    for lang in langs:
        for src in sorted((RAW / lang).glob("*.png")):
            size_in, size_out = optimise(src, OUT / lang / src.name)
            total_in += size_in
            total_out += size_out
            count += 1
    all_out = sum(p.stat().st_size for p in OUT.rglob("*.png"))
    print(
        f"{count} images: {total_in / 1e6:.2f} MB -> {total_out / 1e6:.2f} MB; "
        f"docs/screens total {all_out / 1e6:.2f} MB"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
