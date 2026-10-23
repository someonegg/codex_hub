from pathlib import Path

from PIL import Image, ImageDraw

# Run with Python 3 and Pillow; no runtime dependency is added to the app.
# M1: one rounded-square hub connects to three circular agent endpoints.
# All artwork stays inside the maskable icon's central safe circle.
public_directory = Path(__file__).resolve().parents[1] / "public"
(public_directory / "icons").mkdir(parents=True, exist_ok=True)
INK = "#18262d"
IVORY = "#f7fafa"
MINT = "#7dd3c8"
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="{INK}"/>
  <g fill="none" stroke="{MINT}" stroke-width="28" stroke-linecap="round" stroke-linejoin="round">
    <path d="M350 144h-64q-16 0-16 16v192q0 16 16 16h64M212 256h138"/>
  </g>
  <g fill="{MINT}"><circle cx="350" cy="144" r="28"/><circle cx="350" cy="256" r="28"/><circle cx="350" cy="368" r="28"/></g>
  <rect x="112" y="206" width="100" height="100" rx="22" fill="{IVORY}"/>
</svg>
'''
(public_directory / "favicon.svg").write_text(svg)


def render(size):
    scale = 4
    image = Image.new("RGB", (512 * scale, 512 * scale), INK)
    draw = ImageDraw.Draw(image)

    def line(points):
        draw.line(
            [(round(x * scale), round(y * scale)) for x, y in points],
            fill=MINT,
            width=28 * scale,
            joint="curve",
        )
        for x, y in (points[0], points[-1]):
            draw.ellipse(
                ((x - 14) * scale, (y - 14) * scale,
                 (x + 14) * scale, (y + 14) * scale),
                fill=MINT,
            )

    # Sample the same quadratic elbows used by the SVG master.
    upper = []
    lower = []
    for step in range(33):
        t = step / 32
        upper.append((286 - 32 * t + 16 * t * t, 144 + 16 * t * t))
        lower.append((270 + 16 * t * t, 352 + 32 * t - 16 * t * t))
    line([(350, 144), *upper, (270, 352), *lower, (350, 368)])
    line([(212, 256), (350, 256)])
    for y in (144, 256, 368):
        draw.ellipse(
            (322 * scale, (y - 28) * scale, 378 * scale, (y + 28) * scale),
            fill=MINT,
        )
    draw.rounded_rectangle(
        (112 * scale, 206 * scale, 212 * scale, 306 * scale),
        radius=22 * scale,
        fill=IVORY,
    )
    return image.resize((size, size), Image.Resampling.LANCZOS)


for size in (192, 512):
    render(size).save(public_directory / f"icons/icon-{size}.png")
render(512).save(public_directory / "icons/icon-maskable-512.png")
render(180).save(public_directory / "apple-touch-icon.png")
render(64).save(public_directory / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
