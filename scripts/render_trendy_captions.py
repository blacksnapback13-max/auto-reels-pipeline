#!/usr/bin/env python3
import json
import math
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter


FONT_CANDIDATES = [
    os.environ.get("CAPTION_FONT_PATH", ""),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Helvetica.ttf",
    "/System/Library/Fonts/Supplemental/Verdana Bold.ttf",
]


def load_font(size):
    for candidate in FONT_CANDIDATES:
        if candidate and os.path.exists(candidate):
            try:
                return ImageFont.truetype(candidate, size=size)
            except Exception:
                continue
    for family in ("DejaVuSans-Bold.ttf", "Arial.ttf"):
        try:
            return ImageFont.truetype(family, size=size)
        except Exception:
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def text_size(draw, text, font, stroke_width=0):
    bbox = draw.textbbox((0, 0), text, font=font, stroke_width=stroke_width)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def measure_words(draw, words, font, stroke_width):
    sizes = []
    for word in words:
        sizes.append(text_size(draw, word, font, stroke_width))
    return sizes


def wrap_words(draw, words, font, max_width, stroke_width):
    if not words:
        return []

    space_w = text_size(draw, " ", font, stroke_width)[0]
    lines = []
    current = []
    current_w = 0

    for word in words:
        word_w = text_size(draw, word, font, stroke_width)[0]
        next_w = word_w if not current else current_w + space_w + word_w
        if current and next_w > max_width:
            lines.append(current)
            current = [word]
            current_w = word_w
        else:
            current.append(word)
            current_w = next_w

    if current:
        lines.append(current)

    if len(lines) > 2:
        merged = lines[0]
        for line in lines[1:]:
            merged += line
        midpoint = math.ceil(len(merged) / 2)
        return [merged[:midpoint], merged[midpoint:]]

    return lines


def fit_layout(draw, words, width):
    max_width = int(width * 0.82)
    for size in range(62, 34, -4):
        font = load_font(size)
        stroke = max(2, round(size * 0.055))
        lines = wrap_words(draw, words, font, max_width, stroke)
        if len(lines) <= 2:
            line_widths = [line_width(draw, line, font, stroke) for line in lines]
            if line_widths and max(line_widths) <= max_width:
                return font, stroke, lines

    font = load_font(34)
    return font, 2, wrap_words(draw, words, font, max_width, 2)


def line_width(draw, words, font, stroke_width):
    if not words:
        return 0
    space_w = text_size(draw, " ", font, stroke_width)[0]
    return sum(text_size(draw, word, font, stroke_width)[0] for word in words) + space_w * (len(words) - 1)


def rounded_rect(draw, xy, radius, fill):
    draw.rounded_rectangle(xy, radius=radius, fill=fill)


def render_caption(chunk, output_path, width=1080, height=1920):
    text = (chunk.get("text") or "").strip()
    if not text:
        return

    words = text.split()
    emphasis = int(chunk.get("emphasisIndex", len(words) - 1))
    emphasis = max(0, min(len(words) - 1, emphasis))

    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    font, stroke, lines = fit_layout(draw, words, width)

    line_h = text_size(draw, "АГРУYQ", font, stroke)[1]
    gap = int(line_h * 0.18)
    block_h = len(lines) * line_h + max(0, len(lines) - 1) * gap
    y = int(height * 0.705 - block_h / 2)

    word_index = 0
    shadow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)

    for line_no, line in enumerate(lines):
        space_w = text_size(draw, " ", font, stroke)[0]
        total_w = line_width(draw, line, font, stroke)
        x = int((width - total_w) / 2)
        line_y = y + line_no * (line_h + gap)

        for word in line:
            word_w, word_h = text_size(draw, word, font, stroke)
            is_emphasis = word_index == emphasis
            fill = (255, 220, 72, 255) if is_emphasis else (255, 255, 255, 255)

            shadow_draw.text(
                (x + 4, line_y + 5),
                word,
                font=font,
                fill=(0, 0, 0, 135),
                stroke_width=stroke + 1,
                stroke_fill=(0, 0, 0, 135),
            )

            draw.text(
                (x, line_y),
                word,
                font=font,
                fill=fill,
                stroke_width=stroke,
                stroke_fill=(0, 0, 0, 255),
            )

            x += word_w + space_w
            word_index += 1

    glow = shadow.filter(ImageFilter.GaussianBlur(radius=2))
    combined = Image.alpha_composite(glow, image)
    combined.save(output_path)


def main():
    if len(sys.argv) != 3:
        print("usage: render_trendy_captions.py captions.json output_dir", file=sys.stderr)
        return 2

    config_path = Path(sys.argv[1])
    output_dir = Path(sys.argv[2])
    output_dir.mkdir(parents=True, exist_ok=True)

    data = json.loads(config_path.read_text(encoding="utf-8"))
    width = int(data.get("width", 1080))
    height = int(data.get("height", 1920))

    for index, chunk in enumerate(data.get("chunks", [])):
        output_path = output_dir / f"cap_{index:03d}.png"
        render_caption(chunk, output_path, width=width, height=height)

    print(json.dumps({"count": len(data.get("chunks", []))}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
