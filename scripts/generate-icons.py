"""Generate SVG/PNG/ICO from shared geometry and color stops.

Requires Python 3 and Pillow. Only the mint frame has subtle shading.
"""
from pathlib import Path

from PIL import Image, ImageDraw

INK = '#16262d'
IVORY = '#f7faf8'
MINT = '#80d5c8'
SCALE = 4
# Frame bounds, corner radius, and stroke width are shared by both renderers.
FRAME = ((110, 100, 400, 410), 60, 34)
PROMPT_WIDTH = 28
PROMPT = [((202, 207), (153, 256), (202, 305)), ((250, 318), (305, 318))]
ENDPOINTS = [(350, y, 23) for y in (183, 255, 327)]
FRAME_STOPS = [(0, '#8bdace'), (0.45, MINT), (1, '#76c8bc')]


def rgb(color):
    return tuple(bytes.fromhex(color.lstrip('#')))


def frame_color(progress, stops):
    for (start, first), (end, last) in zip(stops, stops[1:]):
        if progress <= end:
            blend = max(0, (progress - start) / (end - start))
            return tuple(round(a + (b - a) * blend) for a, b in zip(rgb(first), rgb(last)))
    return rgb(stops[-1][1])


def svg(stops):
    (left, top, right, bottom), radius, width = FRAME
    gradient = ''.join(
        f'<stop offset="{offset}" stop-color="{color}"/>'
        for offset, color in stops
    )
    paths = ''.join(
        '<polyline points="' + ' '.join(f'{x},{y}' for x, y in points) + '"/>'
        for points in PROMPT
    )
    circles = ''.join(
        f'<circle cx="{x}" cy="{y}" r="{radius}"/>'
        for x, y, radius in ENDPOINTS
    )
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="frame" gradientUnits="userSpaceOnUse" x1="0" y1="{top-width/2}" x2="0" y2="{bottom+width/2}">{gradient}</linearGradient></defs>
  <rect width="512" height="512" fill="{INK}"/>
  <rect x="{left}" y="{top}" width="{right-left}" height="{bottom-top}" rx="{radius}" fill="none" stroke="url(#frame)" stroke-width="{width}"/>
  <g fill="none" stroke="{IVORY}" stroke-width="{PROMPT_WIDTH}" stroke-linecap="round" stroke-linejoin="round">{paths}</g>
  <g fill="{MINT}">{circles}</g>
</svg>
'''


def canvas(stops):
    resolution = 512 * SCALE
    image = Image.new('RGB', (resolution, resolution), INK)
    mask = Image.new('L', image.size, 0)
    draw = ImageDraw.Draw(mask)
    (left, top, right, bottom), radius, width = FRAME
    for inset, fill in [(-width / 2, 255), (width / 2, 0)]:
        bounds = (left + inset, top + inset, right - inset, bottom - inset)
        draw.rounded_rectangle(
            tuple(round(value * SCALE) for value in bounds),
            radius=round((radius - inset) * SCALE),
            fill=fill,
        )
    ramp = Image.new('RGB', (1, resolution))
    for y in range(resolution):
        progress = (y / SCALE - (top - width / 2)) / (bottom - top + width)
        ramp.putpixel((0, y), frame_color(progress, stops))
    image.paste(ramp.resize(image.size), (0, 0), mask)
    draw = ImageDraw.Draw(image)
    cap_radius = PROMPT_WIDTH / 2
    for points in PROMPT:
        draw.line(
            [(x * SCALE, y * SCALE) for x, y in points],
            fill=IVORY,
            width=PROMPT_WIDTH * SCALE,
            joint='curve',
        )
        for x, y in points:
            draw.ellipse(
                ((x - cap_radius) * SCALE, (y - cap_radius) * SCALE,
                 (x + cap_radius) * SCALE, (y + cap_radius) * SCALE),
                fill=IVORY,
            )
    for x, y, radius in ENDPOINTS:
        draw.ellipse(
            ((x - radius) * SCALE, (y - radius) * SCALE,
             (x + radius) * SCALE, (y + radius) * SCALE),
            fill=MINT,
        )
    return image


def main():
    directory = Path(__file__).resolve().parents[1] / 'public'
    (directory / 'icons').mkdir(parents=True, exist_ok=True)
    (directory / 'favicon.svg').write_text(svg(FRAME_STOPS))
    master = canvas(FRAME_STOPS)
    for size, name in [
        (192, 'icons/icon-192.png'),
        (512, 'icons/icon-512.png'),
        (512, 'icons/icon-maskable-512.png'),
        (180, 'apple-touch-icon.png'),
    ]:
        master.resize((size, size), Image.Resampling.LANCZOS).save(directory / name)
    # Supply independently downsampled frames, avoiding an extra resize from 64px.
    frames = [
        master.resize((size, size), Image.Resampling.LANCZOS)
        for size in (16, 32, 48, 64)
    ]
    frames[-1].save(
        directory / 'favicon.ico',
        append_images=frames[:-1],
        sizes=[frame.size for frame in frames],
    )


if __name__ == '__main__':
    main()
