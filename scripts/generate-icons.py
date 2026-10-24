from pathlib import Path

from PIL import Image, ImageDraw

# Run with Python 3 and Pillow; no runtime dependency is added to the app.
# C: a terminal prompt and three agent endpoints inside a mint terminal frame.
# Foreground artwork stays inside the maskable icon's central safe circle.
public_directory = Path(__file__).resolve().parents[1] / "public"
(public_directory / "icons").mkdir(parents=True, exist_ok=True)
INK = "#16262d"
IVORY = "#f7faf8"
MINT = "#80d5c8"
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="{INK}"/>
  <rect x="110" y="100" width="290" height="310" rx="60" fill="none" stroke="{MINT}" stroke-width="34"/>
  <g fill="none" stroke="{IVORY}" stroke-width="28" stroke-linecap="round" stroke-linejoin="round">
    <path d="m202 207-49 49 49 49M250 318h55"/>
  </g>
  <g fill="{MINT}"><circle cx="348" cy="188" r="29"/><circle cx="348" cy="264" r="29"/><circle cx="348" cy="340" r="29"/></g>
</svg>
'''
(public_directory / "favicon.svg").write_text(svg)


def render(size):
    scale = 4
    image = Image.new("RGB", (512 * scale, 512 * scale), INK)
    draw = ImageDraw.Draw(image)
    # Draw the frame as nested rounded rectangles, matching the SVG stroke.
    draw.rounded_rectangle(
        (93 * scale, 83 * scale, 417 * scale, 427 * scale),
        radius=77 * scale,
        fill=MINT,
    )
    draw.rounded_rectangle(
        (127 * scale, 117 * scale, 383 * scale, 393 * scale),
        radius=43 * scale,
        fill=INK,
    )

    def rounded_line(points):
        draw.line(
            [(x * scale, y * scale) for x, y in points],
            fill=IVORY,
            width=28 * scale,
            joint="curve",
        )
        for x, y in points:
            draw.ellipse(
                ((x - 14) * scale, (y - 14) * scale,
                 (x + 14) * scale, (y + 14) * scale),
                fill=IVORY,
            )

    rounded_line([(202, 207), (153, 256), (202, 305)])
    rounded_line([(250, 318), (305, 318)])
    for y in (188, 264, 340):
        draw.ellipse(
            (319 * scale, (y - 29) * scale, 377 * scale, (y + 29) * scale),
            fill=MINT,
        )
    return image.resize((size, size), Image.Resampling.LANCZOS)


for size in (192, 512):
    render(size).save(public_directory / f"icons/icon-{size}.png")
render(512).save(public_directory / "icons/icon-maskable-512.png")
render(180).save(public_directory / "apple-touch-icon.png")
render(64).save(public_directory / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
