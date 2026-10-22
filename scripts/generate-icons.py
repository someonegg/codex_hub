from PIL import Image, ImageDraw
from pathlib import Path
# Run with Python 3 and Pillow; no runtime dependency is added to the app.
# All artwork stays inside the maskable icon's central safe circle.
public_directory = Path(__file__).resolve().parents[1] / "public"
(public_directory / "icons").mkdir(parents=True, exist_ok=True)
svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#18262d"/>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="m144 192 64 64-64 64" stroke="#f7fafa" stroke-width="32"/>
    <path d="M240 256h48m0-80v160m0-160h64m-64 80h64m-64 80h64" stroke="#7dd3c8" stroke-width="24"/>
  </g>
  <g fill="#7dd3c8"><circle cx="352" cy="176" r="20"/><circle cx="352" cy="256" r="20"/><circle cx="352" cy="336" r="20"/></g>
</svg>
'''
(public_directory / "favicon.svg").write_text(svg)


def render(size):
    scale = 4
    image = Image.new("RGB", (512 * scale, 512 * scale), "#18262d")
    draw = ImageDraw.Draw(image)

    def line(points, color, width):
        points = [(x * scale, y * scale) for x, y in points]
        draw.line(points, fill=color, width=width * scale, joint="curve")
        radius = width * scale / 2
        for x, y in points:
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)

    line([(144, 192), (208, 256), (144, 320)], "#f7fafa", 32)
    branches = [
        [(240, 256), (288, 256)],
        [(288, 176), (288, 336)],
        [(288, 176), (352, 176)],
        [(288, 256), (352, 256)],
        [(288, 336), (352, 336)],
    ]
    for points in branches:
        line(points, "#7dd3c8", 24)
    for y in (176, 256, 336):
        draw.ellipse(
            (332 * scale, (y - 20) * scale, 372 * scale, (y + 20) * scale),
            fill="#7dd3c8",
        )
    return image.resize((size, size), Image.Resampling.LANCZOS)


for size in (192, 512):
    render(size).save(public_directory / f"icons/icon-{size}.png")
render(512).save(public_directory / "icons/icon-maskable-512.png")
render(180).save(public_directory / "apple-touch-icon.png")
render(64).save(public_directory / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
