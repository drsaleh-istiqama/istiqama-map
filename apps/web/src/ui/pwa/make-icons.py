"""Render the application icons from the geometry of public/icons/icon.svg.

Run from the repository root (needs Pillow):

    python apps/web/src/ui/pwa/make-icons.py

Writes into apps/web/public/:
    icons/icon-192.png, icons/icon-512.png        purpose "any" (rounded square, transparent corners)
    icons/icon-maskable-512.png                   purpose "maskable" (full bleed, pin inside the safe zone)
    icons/apple-touch-icon.png                    180 px, opaque (iOS masks it itself)
    icons/shortcut-add.png, icons/shortcut-map.png   96 px manifest shortcut icons
    favicon.ico                                   16 / 32 / 48 px

The drawing is original: a navy rounded square with a gold map pin whose head holds a
crescent. Shapes are drawn at 4x and reduced with Lanczos for clean edges.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

NAVY = (15, 37, 69, 255)  # #0f2545
GOLD = (200, 162, 74, 255)  # #c8a24a
SS = 4  # supersampling factor
PUBLIC = Path(__file__).resolve().parents[3] / "public"


def cubic(p0, p1, p2, p3, steps=48):
    points = []
    for i in range(steps + 1):
        t = i / steps
        a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t**2, t**3
        points.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))
    return points


def pin_outline():
    """M256 424 C256 424 134 300 134 214 A122 122 0 0 1 378 214 C378 300 256 424 256 424 Z"""
    left = cubic((256, 424), (256, 424), (134, 300), (134, 214))
    arc = [(256 + 122 * math.cos(math.radians(a)), 214 + 122 * math.sin(math.radians(a))) for a in range(180, 361, 2)]
    right = cubic((378, 214), (378, 300), (256, 424), (256, 424))
    return left + arc + right


def transform(points, scale, shift_y):
    """Scale around the visual centre of the pin (256, 258), then centre it on the canvas."""
    return [(256 + (x - 256) * scale, 256 + (y - 258) * scale + shift_y) for x, y in points]


def circle(draw, cx, cy, r, fill, scale, shift_y, k):
    (x, y) = transform([(cx, cy)], scale, shift_y)[0]
    rr = r * scale
    draw.ellipse([(x - rr) * k, (y - rr) * k, (x + rr) * k, (y + rr) * k], fill=fill)


def draw_mark(draw, k, scale=1.0, shift_y=0.0):
    draw.polygon([(x * k, y * k) for x, y in transform(pin_outline(), scale, shift_y)], fill=GOLD)
    circle(draw, 256, 212, 74, NAVY, scale, shift_y, k)
    circle(draw, 256, 212, 50, GOLD, scale, shift_y, k)
    circle(draw, 274, 200, 42, NAVY, scale, shift_y, k)


def render(size, *, rounded, scale=1.0, frame=False, glyph=None):
    k = size * SS / 512
    image = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    if rounded:
        draw.rounded_rectangle([0, 0, 512 * k - 1, 512 * k - 1], radius=112 * k, fill=NAVY)
        if frame:
            ring = Image.new("RGBA", image.size, (0, 0, 0, 0))
            ImageDraw.Draw(ring).rounded_rectangle(
                [20 * k, 20 * k, 492 * k, 492 * k], radius=94 * k, outline=GOLD[:3] + (140,), width=max(1, round(6 * k))
            )
            image = Image.alpha_composite(image, ring)
            draw = ImageDraw.Draw(image)
    else:
        draw.rectangle([0, 0, image.width, image.height], fill=NAVY)
    if glyph == "plus":
        arm, half = 150 * k, 30 * k
        c = 256 * k
        draw.rounded_rectangle([c - arm, c - half, c + arm, c + half], radius=half, fill=GOLD)
        draw.rounded_rectangle([c - half, c - arm, c + half, c + arm], radius=half, fill=GOLD)
    else:
        # The pin's visual centre sits 2 px below the canvas centre in the 1:1 drawing.
        draw_mark(draw, k, scale, shift_y=2.0 if scale == 1.0 else 0.0)
    return image.resize((size, size), Image.LANCZOS)


def main():
    icons = PUBLIC / "icons"
    icons.mkdir(parents=True, exist_ok=True)

    render(192, rounded=True, frame=True).save(icons / "icon-192.png", optimize=True)
    render(512, rounded=True, frame=True).save(icons / "icon-512.png", optimize=True)
    # Maskable: full bleed, content within the central 80 % (pin scaled to 74 %).
    render(512, rounded=False, scale=0.74).convert("RGB").save(icons / "icon-maskable-512.png", optimize=True)
    # iOS: opaque square, slightly larger mark than the maskable one.
    render(180, rounded=False, scale=0.86).convert("RGB").save(icons / "apple-touch-icon.png", optimize=True)
    render(96, rounded=True, glyph="plus").save(icons / "shortcut-add.png", optimize=True)
    render(96, rounded=True, scale=0.92).save(icons / "shortcut-map.png", optimize=True)

    favicon = render(256, rounded=True)
    favicon.save(PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    for path in sorted(list(icons.glob("*.png")) + [PUBLIC / "favicon.ico"]):
        print(f"{path.relative_to(PUBLIC)}  {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
