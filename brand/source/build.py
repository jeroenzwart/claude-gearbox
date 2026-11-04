"""Builds the gearbox logo masters as filled outlines (no strokes, no text).

Run: python3 brand/source/build.py   (writes the SVG masters into brand/)
"""
import math
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent

INK = '#16181D'
GREEN = '#0F7A55'
MINT = '#5BD6A0'
PAPER = '#F6F4EE'

# Wordmark grid: x-height 100, bowl centreline radius 39, stroke 22.
HALF = 11
RADIUS = 39
LIFT = 30
GAPS = [14, 10, 20, 14, 10, 10]


def number(value):
    text = f'{value:.2f}'.rstrip('0').rstrip('.')

    return '0' if text == '-0' else text


def xy(x, y):
    return f'{number(x)} {number(y)}'


def polar(cx, cy, r, degrees):
    angle = math.radians(degrees)

    return cx + r * math.cos(angle), cy + r * math.sin(angle)


def ring(cx, cy, r=RADIUS, half=HALF):
    outer, inner = r + half, r - half

    return (
        f'M {xy(cx - outer, cy)} A {number(outer)} {number(outer)} 0 0 1 {xy(cx + outer, cy)} '
        f'A {number(outer)} {number(outer)} 0 0 1 {xy(cx - outer, cy)} Z '
        f'M {xy(cx - inner, cy)} A {number(inner)} {number(inner)} 0 0 0 {xy(cx + inner, cy)} '
        f'A {number(inner)} {number(inner)} 0 0 0 {xy(cx - inner, cy)} Z'
    )


def capsule(x0, y0, x1, y1, half=HALF):
    length = math.hypot(x1 - x0, y1 - y0)
    normal_x, normal_y = (y1 - y0) / length * half, -(x1 - x0) / length * half
    h = number(half)

    return (
        f'M {xy(x0 + normal_x, y0 + normal_y)} L {xy(x1 + normal_x, y1 + normal_y)} '
        f'A {h} {h} 0 0 1 {xy(x1 - normal_x, y1 - normal_y)} L {xy(x0 - normal_x, y0 - normal_y)} '
        f'A {h} {h} 0 0 1 {xy(x0 + normal_x, y0 + normal_y)} Z'
    )


def arc(cx, cy, start, end, r=RADIUS, half=HALF):
    """An arc stroke with round caps, running clockwise from start to end (degrees)."""
    outer, inner = r + half, r - half
    large = 1 if end - start > 180 else 0
    h = number(half)

    return (
        f'M {xy(*polar(cx, cy, outer, start))} A {number(outer)} {number(outer)} 0 {large} 1 {xy(*polar(cx, cy, outer, end))} '
        f'A {h} {h} 0 0 1 {xy(*polar(cx, cy, inner, end))} '
        f'A {number(inner)} {number(inner)} 0 {large} 0 {xy(*polar(cx, cy, inner, start))} '
        f'A {h} {h} 0 0 1 {xy(*polar(cx, cy, outer, start))} Z'
    )


def letter_g(x, dy):
    cx = x + 50

    return 100, [ring(cx, 128 + dy), capsule(cx + 39, 89 + dy, cx + 39, 168 + dy), arc(cx, 168 + dy, 0, 150)]


def letter_e(x, dy):
    cx = x + 50

    return 100, [capsule(cx - 39, 128 + dy, cx + 39, 128 + dy), arc(cx, 128 + dy, 40, 360)]


def letter_a(x, dy):
    cx = x + 50

    return 100, [ring(cx, 128 + dy), capsule(cx + 39, 89 + dy, cx + 39, 167 + dy)]


def letter_r(x, dy):
    stem = x + 11

    return 81, [capsule(stem, 89 + dy, stem, 167 + dy), arc(stem + 39, 128 + dy, 180, 300)]


def letter_b(x, dy):
    cx = x + 50

    return 100, [ring(cx, 128 + dy), capsule(x + 11, 49 + dy, x + 11, 167 + dy)]


def letter_o(x, dy):
    return 100, [ring(x + 50, 128 + dy)]


def letter_x(x, dy):
    return 90, [capsule(x + 11, 89 + dy, x + 79, 167 + dy), capsule(x + 79, 89 + dy, x + 11, 167 + dy)]


def wordmark(x0, y_offset=0):
    """The stepped wordmark: 'box' sits one tread (LIFT) above 'gear'. Returns (right edge, path data)."""
    letters = [letter_g, letter_e, letter_a, letter_r, letter_b, letter_o, letter_x]
    paths = []
    x = x0
    for index, letter in enumerate(letters):
        lift = -LIFT / 2 if index >= 4 else LIFT / 2
        width, letter_paths = letter(x, y_offset + lift)
        paths += letter_paths
        x += width + (GAPS[index] if index < len(GAPS) else 0)

    return x, ' '.join(paths)


def box(x, y, size, seam=16):
    """The box cut in two along a rising two-step seam. Drawn on a 176 grid, scaled to size."""
    scale = size / 176
    half = seam / 2
    corner = 36

    def at(px, py):
        return xy(x + (px - 40) * scale, y + (py - 40) * scale)

    c = number(corner * scale)
    upper = (
        f'M {at(40, 168 - half)} H {number(x + (100 - half - 40) * scale)} V {number(y + (128 - half - 40) * scale)} '
        f'H {number(x + (156 - half - 40) * scale)} V {number(y + (88 - half - 40) * scale)} H {number(x + size)} '
        f'V {number(y + corner * scale)} A {c} {c} 0 0 0 {at(216 - corner, 40)} H {number(x + corner * scale)} '
        f'A {c} {c} 0 0 0 {at(40, 40 + corner)} Z'
    )
    lower = (
        f'M {at(40, 168 + half)} H {number(x + (100 + half - 40) * scale)} V {number(y + (128 + half - 40) * scale)} '
        f'H {number(x + (156 + half - 40) * scale)} V {number(y + (88 + half - 40) * scale)} H {number(x + size)} '
        f'V {number(y + size - corner * scale)} A {c} {c} 0 0 1 {at(216 - corner, 216)} H {number(x + corner * scale)} '
        f'A {c} {c} 0 0 1 {at(40, 216 - corner)} Z'
    )

    return f'{upper} {lower}'


def document(width, height, body, title='gearbox'):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {number(width)} {number(height)}" '
        f'width="{number(width)}" height="{number(height)}"><title>{title}</title>{body}</svg>\n'
    )


def shape(data, colour):
    return f'<path d="{data}" fill="{colour}"/>'


def write(name, content):
    (OUT / f'{name}.svg').write_text(content)


def symbols():
    write('gearbox-symbol', document(256, 256, shape(box(40, 40, 176), GREEN)))
    write('gearbox-symbol-small', document(256, 256, shape(box(40, 40, 176, seam=24), GREEN)))
    # Light on dark looks heavier, so the seam opens up a little.
    write('gearbox-symbol-on-dark', document(256, 256, shape(box(40, 40, 176, seam=18), MINT)))


def wordmarks():
    end, data = wordmark(30)
    width = end + 30
    write('gearbox-wordmark', document(width, 256, shape(data, INK)))
    write('gearbox-wordmark-on-dark', document(width, 256, shape(data, PAPER)))


def horizontal():
    # The box spans from the x-height of 'box' (y 63) to the baseline of 'gear' (y 193).
    size = 130
    end, data = wordmark(30 + size + 52)
    width = end + 30
    write('gearbox-horizontal', document(width, 256, shape(box(30, 63, size), GREEN) + shape(data, INK)))
    write('gearbox-horizontal-on-dark', document(width, 256, shape(box(30, 63, size, seam=18), MINT) + shape(data, PAPER)))


def stacked():
    end, _ = wordmark(30)
    width = end + 30
    size = 200
    # Wordmark ascender top sits at y 23 in its own frame; place it 50 below the box.
    _, data = wordmark(30, y_offset=30 + size + 50 - 23)
    height = 30 + size + 50 + 210 + 30
    left = (width - size) / 2
    write('gearbox-stacked', document(width, height, shape(box(left, 30, size), GREEN) + shape(data, INK)))
    write('gearbox-stacked-on-dark', document(width, height, shape(box(left, 30, size, seam=18), MINT) + shape(data, PAPER)))


if __name__ == '__main__':
    symbols()
    wordmarks()
    horizontal()
    stacked()
