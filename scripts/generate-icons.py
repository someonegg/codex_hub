"""Generate the light terminal SVG/PNG/ICO icons from shared geometry.

Requires Python 3 and Pillow.
"""
from pathlib import Path

from PIL import Image, ImageDraw

BACKGROUND = '#edf4f1'
PANEL_COLOR = '#f3f8f5'
PROMPT_COLOR = '#28474d'
FRAME_COLOR = '#69aa9f'
SCALE = 4
FRAME_WIDTH = 18
FRAME_LEFT, FRAME_TOP = 110, 100
FRAME_RIGHT, FRAME_BOTTOM = 400, 410
FRAME_RADIUS = 60
PROMPT_WIDTH = 19
PROMPT = [((211, 210), (165, 256), (211, 302)), ((251, 315), (302, 315))]
ENDPOINTS = [(350, y, 12) for y in (185, 256, 327)]


def svg():
    left, right = FRAME_LEFT, FRAME_RIGHT
    top, bottom, radius = FRAME_TOP, FRAME_BOTTOM, FRAME_RADIUS
    paths = ''.join(
        '<polyline points="' + ' '.join(f'{x},{y}' for x, y in points) + '"/>'
        for points in PROMPT
    )
    circles = ''.join(
        f'<circle cx="{x}" cy="{y}" r="{radius}"/>'
        for x, y, radius in ENDPOINTS
    )
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="{BACKGROUND}"/>
  <rect x="{left}" y="{top}" width="{right-left}" height="{bottom-top}" rx="{radius}" fill="{PANEL_COLOR}" stroke="{FRAME_COLOR}" stroke-width="{FRAME_WIDTH}"/>
  <g fill="none" stroke="{PROMPT_COLOR}" stroke-width="{PROMPT_WIDTH}" stroke-linecap="round" stroke-linejoin="round">{paths}</g>
  <g fill="{FRAME_COLOR}">{circles}</g>
</svg>
'''


def canvas():
    image = Image.new('RGB', (512 * SCALE, 512 * SCALE), BACKGROUND)
    draw = ImageDraw.Draw(image)

    def line(points, color, width):
        draw.line([(x * SCALE, y * SCALE) for x, y in points],
                  fill=color, width=width * SCALE, joint='curve')
        for x, y in points:
            circle(x, y, width / 2, color)

    def circle(x, y, radius, color):
        draw.ellipse(((x-radius)*SCALE, (y-radius)*SCALE,
                      (x+radius)*SCALE, (y+radius)*SCALE), fill=color)

    # SVG strokes are centered on the rounded rectangle's boundary.
    for inset, color in [(-FRAME_WIDTH / 2, FRAME_COLOR), (FRAME_WIDTH / 2, PANEL_COLOR)]:
        draw.rounded_rectangle(
            tuple(round(value * SCALE) for value in (
                FRAME_LEFT + inset, FRAME_TOP + inset,
                FRAME_RIGHT - inset, FRAME_BOTTOM - inset)),
            radius=round((FRAME_RADIUS - inset) * SCALE),
            fill=color,
        )
    for points in PROMPT:
        line(points, PROMPT_COLOR, PROMPT_WIDTH)
    for x, y, radius in ENDPOINTS:
        circle(x, y, radius, FRAME_COLOR)
    return image


def main():
    directory = Path(__file__).resolve().parents[1] / 'public'
    (directory / 'icons').mkdir(parents=True, exist_ok=True)
    (directory / 'favicon.svg').write_text(svg())
    master = canvas()
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
