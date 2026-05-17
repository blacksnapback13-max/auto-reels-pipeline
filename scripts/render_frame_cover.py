#!/usr/bin/env python3
import json
import math
import os
import re
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps


WIDTH = 1080
HEIGHT = 1920
FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Helvetica.ttf",
    "/System/Library/Fonts/Supplemental/Verdana Bold.ttf",
]


def load_font(size):
    for candidate in FONT_CANDIDATES:
        if os.path.exists(candidate):
            try:
                return ImageFont.truetype(candidate, size=size)
            except Exception:
                continue
    return ImageFont.load_default(size=size)


def normalize_text(text):
    return re.sub(r"\s+", " ", text or "").strip()


def text_size(draw, text, font, stroke_width=0):
    bbox = draw.textbbox((0, 0), text, font=font, stroke_width=stroke_width)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def palette_values(name):
    return {
        "warm": {
            "accent": (255, 199, 92, 255),
            "accent2": (255, 119, 78, 255),
            "bg": (12, 18, 20, 255),
            "paper": (255, 246, 226, 255),
            "color": 1.10,
            "contrast": 1.16,
            "brightness": 1.02,
        },
        "contrast": {
            "accent": (255, 255, 255, 255),
            "accent2": (15, 224, 190, 255),
            "bg": (6, 8, 10, 255),
            "paper": (246, 246, 240, 255),
            "color": 1.05,
            "contrast": 1.34,
            "brightness": 0.97,
        },
        "clean": {
            "accent": (96, 203, 185, 255),
            "accent2": (250, 250, 250, 255),
            "bg": (20, 28, 30, 255),
            "paper": (245, 248, 245, 255),
            "color": 0.96,
            "contrast": 1.10,
            "brightness": 1.08,
        },
        "shadow-light": {
            "accent": (255, 178, 103, 255),
            "accent2": (255, 225, 151, 255),
            "bg": (9, 8, 12, 255),
            "paper": (255, 239, 214, 255),
            "color": 1.04,
            "contrast": 1.24,
            "brightness": 0.96,
        },
    }.get(name or "warm")


def normalize_layout(value):
    aliases = {
        "cinematic": "cutout",
        "realistic": "poster",
        "documentary": "magazine",
        "premium": "headline",
        "dramatic": "split",
    }
    value = (value or "cutout").strip().lower()
    value = aliases.get(value, value)
    if value in {"cutout", "poster", "magazine", "split", "headline"}:
        return value
    return "cutout"


def cover_resize(image, scale=1.0, x_bias=0.5, y_bias=0.5):
    image = image.convert("RGB")
    ratio = max(WIDTH / image.width, HEIGHT / image.height) * scale
    resized = image.resize((math.ceil(image.width * ratio), math.ceil(image.height * ratio)), Image.Resampling.LANCZOS)
    max_left = max(0, resized.width - WIDTH)
    max_top = max(0, resized.height - HEIGHT)
    left = int(max_left * x_bias)
    top = int(max_top * y_bias)
    return resized.crop((left, top, left + WIDTH, top + HEIGHT)).convert("RGBA")


def fit_inside(image, width, height):
    ratio = min(width / image.width, height / image.height)
    return image.resize((round(image.width * ratio), round(image.height * ratio)), Image.Resampling.LANCZOS)


def stylize_frame(image, settings):
    palette = palette_values(settings.get("palette"))
    image = ImageEnhance.Color(image).enhance(palette["color"])
    image = ImageEnhance.Contrast(image).enhance(palette["contrast"])
    image = ImageEnhance.Brightness(image).enhance(palette["brightness"])
    return ImageEnhance.Sharpness(image).enhance(1.12).convert("RGBA")


def vertical_gradient(top, bottom):
    gradient = Image.new("RGBA", (1, HEIGHT), (0, 0, 0, 0))
    for y in range(HEIGHT):
        t = y / max(1, HEIGHT - 1)
        gradient.putpixel((0, y), tuple(round(top[i] * (1 - t) + bottom[i] * t) for i in range(4)))
    return gradient.resize((WIDTH, HEIGHT))


def add_vignette(image, strength=130):
    radial = Image.radial_gradient("L").resize((WIDTH, HEIGHT))
    radial = ImageOps.invert(radial).point(lambda p: min(255, int(p * strength / 100)))
    overlay = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    overlay.putalpha(radial)
    return Image.alpha_composite(image, overlay)


def blurred_background(frame, settings, scale=1.22, blur=22):
    palette = palette_values(settings.get("palette"))
    bg = cover_resize(frame, scale=scale).filter(ImageFilter.GaussianBlur(blur))
    bg = stylize_frame(bg, settings)
    bg = Image.alpha_composite(bg, vertical_gradient((0, 0, 0, 120), (0, 0, 0, 175)))
    color_wash = Image.new("RGBA", (WIDTH, HEIGHT), palette["bg"])
    color_wash.putalpha(74)
    bg = Image.alpha_composite(bg, color_wash)
    return add_vignette(bg, 120)


def percentile(values, pct):
    if not values:
        return 0
    values = sorted(values)
    index = int(max(0, min(len(values) - 1, round((len(values) - 1) * pct))))
    return values[index]


def detect_subject_box(image):
    rgb = image.convert("RGB")
    w, h = rgb.size
    x1, x2 = int(w * 0.22), int(w * 0.78)
    y1, y2 = int(h * 0.24), int(h * 0.86)
    xs = []
    ys = []
    pixels = rgb.load()
    step = 4
    for y in range(y1, y2, step):
        for x in range(x1, x2, step):
            r, g, b = pixels[x, y]
            value = max(r, g, b)
            sat = value - min(r, g, b)
            if sat > 42 and 42 < value < 245:
                center_weight = 1.0 - abs((x / w) - 0.5)
                if center_weight > 0.58:
                    xs.append(x)
                    ys.append(y)
    if len(xs) < 80:
        return (int(w * 0.25), int(h * 0.28), int(w * 0.75), int(h * 0.86))

    left = percentile(xs, 0.04)
    right = percentile(xs, 0.96)
    top = percentile(ys, 0.02)
    bottom = percentile(ys, 0.98)
    center = percentile(xs, 0.50)
    raw_w = max(1, right - left)
    max_w = int(w * 0.46)
    if raw_w > max_w:
        left = center - max_w // 2
        right = center + max_w // 2
        raw_w = right - left
    pad_x = int(raw_w * 0.18)
    pad_top = int((bottom - top) * 0.26)
    pad_bottom = int((bottom - top) * 0.38)
    return (
        max(0, left - pad_x),
        max(0, top - pad_top),
        min(w, right + pad_x),
        min(h, bottom + pad_bottom),
    )


def subject_mask(crop):
    mask = Image.new("L", crop.size, 0)
    draw = ImageDraw.Draw(mask)
    pad_x = int(crop.width * 0.08)
    pad_y = int(crop.height * 0.01)
    draw.rounded_rectangle(
        (pad_x, pad_y, crop.width - pad_x, crop.height - pad_y),
        radius=max(34, int(crop.width * 0.28)),
        fill=255,
    )
    return mask.filter(ImageFilter.GaussianBlur(1.2))


def build_subject(frame, settings):
    layout = normalize_layout(settings.get("style"))
    motion = settings.get("motion") or "dynamic"
    box = detect_subject_box(frame)
    crop = frame.crop(box).convert("RGBA")
    target_h = {
        "closeup": 1360,
        "dynamic": 1220,
        "breakthrough": 1280,
        "calm": 1060,
    }.get(motion, 1200)
    if layout == "magazine":
        target_h = 980
    if layout == "headline":
        target_h = 1120
    ratio = target_h / crop.height
    subject = crop.resize((round(crop.width * ratio), target_h), Image.Resampling.LANCZOS)
    mask = subject_mask(subject)
    return subject, mask


def paste_shadowed(base, layer, mask, xy, outline=(255, 255, 255, 255), outline_px=10, shadow_px=30):
    x, y = xy
    shadow = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    shadow_mask = mask.filter(ImageFilter.GaussianBlur(shadow_px))
    shadow.putalpha(shadow_mask.point(lambda p: int(p * 0.58)))
    base.alpha_composite(shadow, (x + 18, y + 26))

    if outline_px > 0:
        outline_mask = mask.filter(ImageFilter.MaxFilter(outline_px * 2 + 1)).filter(ImageFilter.GaussianBlur(1.5))
        outline_img = Image.new("RGBA", layer.size, outline)
        outline_img.putalpha(outline_mask)
        base.alpha_composite(outline_img, (x, y))

    clipped = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    clipped.alpha_composite(layer)
    clipped.putalpha(mask)
    base.alpha_composite(clipped, (x, y))
    return base


def wrap_text(draw, text, font, max_width, stroke_width):
    words = text.split()
    lines = []
    current = []
    for word in words:
        candidate = " ".join(current + [word])
        if current and text_size(draw, candidate, font, stroke_width)[0] > max_width:
            lines.append(" ".join(current))
            current = [word]
        else:
            current.append(word)
    if current:
        lines.append(" ".join(current))
    return lines


def fit_text(draw, text, max_width, max_lines=4, max_size=104, min_size=42):
    for size in range(max_size, min_size - 1, -4):
        font = load_font(size)
        stroke = max(3, round(size * 0.055))
        lines = wrap_text(draw, text, font, max_width, stroke)
        if len(lines) <= max_lines:
            line_h = text_size(draw, "AGRUYQ", font, stroke)[1]
            return font, stroke, lines, line_h
    font = load_font(min_size)
    stroke = 3
    return font, stroke, wrap_text(draw, text, font, max_width, stroke)[:max_lines], text_size(draw, "AGRUYQ", font, stroke)[1]


def headline_from_config(config):
    explicit = normalize_text(config.get("headline") or "")
    explicit = re.sub(r"[.!?]+$", "", explicit)
    if explicit:
        return explicit

    description = re.sub(r"#\S+", "", config.get("description") or "").strip()
    text = normalize_text(re.split(r"\n\s*\n", description)[0].strip())
    sentence = re.match(r"^(.{22,}?[.!?])\s+", text)
    if sentence:
        text = sentence.group(1)
    if not text:
        text = normalize_text(config.get("reelText") or "")
    text = re.sub(r"[.!?]+$", "", text)
    if len(text) > 62:
        text = re.sub(r"\s+\S*$", "", text[:62]).strip()
    if text:
        return text

    title = normalize_text(config.get("title") or "")
    title = re.sub(r"[.!?]+$", "", title)
    if len(title) > 62:
        title = re.sub(r"\s+\S*$", "", title[:62]).strip()
    return title


def text_anchor(settings):
    zone = settings.get("textZone") or "top"
    if zone == "center":
        return HEIGHT * 0.42
    if zone == "bottom":
        return HEIGHT * 0.70
    return HEIGHT * 0.13


def draw_headline(image, text, settings, box, align="left", max_lines=4, max_size=106, panel=False):
    if not text or settings.get("textZone") == "none":
        return
    palette = palette_values(settings.get("palette"))
    draw = ImageDraw.Draw(image)
    x1, y1, x2, y2 = box
    max_width = x2 - x1
    font, stroke, lines, line_h = fit_text(draw, text.upper(), max_width, max_lines=max_lines, max_size=max_size)
    gap = int(line_h * 0.18)
    block_h = len(lines) * line_h + max(0, len(lines) - 1) * gap
    if y2 - y1 > block_h:
        y1 = int(y1 + (y2 - y1 - block_h) * 0.18)

    if panel:
        pad = 34
        panel_img = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
        panel_draw = ImageDraw.Draw(panel_img)
        panel_draw.rounded_rectangle(
            (max(38, x1 - pad), max(38, y1 - pad), min(WIDTH - 38, x2 + pad), min(HEIGHT - 38, y1 + block_h + pad)),
            radius=34,
            fill=(0, 0, 0, 116),
        )
        panel_img = panel_img.filter(ImageFilter.GaussianBlur(0.5))
        image.alpha_composite(panel_img)
        draw = ImageDraw.Draw(image)

    draw.rounded_rectangle((x1, max(40, y1 - 28), x1 + 72, max(46, y1 - 14)), radius=7, fill=palette["accent"])
    for index, line in enumerate(lines):
        line_w = text_size(draw, line, font, stroke)[0]
        if align == "center":
            x = int(x1 + (max_width - line_w) / 2)
        elif align == "right":
            x = int(x2 - line_w)
        else:
            x = int(x1)
        y = int(y1 + index * (line_h + gap))
        draw.text((x + 5, y + 7), line, font=font, fill=(0, 0, 0, 165), stroke_width=stroke + 2, stroke_fill=(0, 0, 0, 165))
        draw.text((x, y), line, font=font, fill=(255, 255, 255, 255), stroke_width=stroke, stroke_fill=(0, 0, 0, 235))


def thumbnail_text_zone(settings):
    zone = settings.get("textZone") or "top"
    if zone == "center":
        return (58, 560, WIDTH - 58, 1210), (70, 498), (70, 1768)
    if zone == "bottom":
        return (58, 1090, WIDTH - 58, 1706), (70, 1028), (70, 78)
    return (58, 148, WIDTH - 58, 778), (70, 88), (70, 1768)


def badge_text_from_config(config):
    combined = normalize_text(" ".join([
        config.get("headline") or "",
        config.get("description") or "",
        config.get("reelText") or "",
        config.get("title") or "",
    ])).lower()
    if re.search(r"счаст|деньг|миллион|бизнес|тачк|богат|успех", combined):
        return "НЕ ПРО ДЕНЬГИ"
    if re.search(r"бог|господ|вер|псалом|молит|иисус|христ|бож|чуд", combined):
        return "СИЛЬНАЯ МЫСЛЬ"
    if re.search(r"мама|семь|сест|дет|сынок|доч", combined):
        return "ДОСМОТРИ"
    if re.search(r"убега|беж|бег|устал|втор(ое|ом) дых|сил|путь", combined):
        return "НЕ СДАВАЙСЯ"
    if re.search(r"страх|тревог|злюсь|разруш|боль|рана|стыд", combined):
        return "ВАЖНО"
    return "ДОСМОТРИ"


def draw_trigger_badge(image, config, settings, xy):
    if settings.get("textZone") == "none":
        return
    palette = palette_values(settings.get("palette"))
    label = badge_text_from_config(config).upper()
    draw = ImageDraw.Draw(image)
    font = load_font(34)
    w, h = text_size(draw, label, font)
    x, y = xy
    draw.rounded_rectangle((x + 8, y + 9, x + w + 58, y + h + 29), radius=24, fill=(0, 0, 0, 150))
    draw.rounded_rectangle((x, y, x + w + 50, y + h + 22), radius=22, fill=palette["accent"], outline=(255, 255, 255, 120), width=2)
    draw.text((x + 25, y + 9), label, font=font, fill=(10, 12, 12, 255))


def draw_thumbnail_headline(image, text, settings, box, align="left", max_lines=3, max_size=148):
    if not text or settings.get("textZone") == "none":
        return
    palette = palette_values(settings.get("palette"))
    accent_fill = palette["accent2"] if palette["accent"][:3] == (255, 255, 255) else palette["accent"]
    draw = ImageDraw.Draw(image)
    x1, y1, x2, y2 = box
    max_width = x2 - x1
    font, stroke, lines, line_h = fit_text(
        draw,
        normalize_text(text).upper(),
        max_width,
        max_lines=max_lines,
        max_size=max_size,
        min_size=62,
    )
    gap = max(10, int(line_h * 0.10))
    block_h = len(lines) * line_h + max(0, len(lines) - 1) * gap
    if y2 - y1 > block_h:
        y1 = int(y1 + (y2 - y1 - block_h) * 0.24)

    panel_pad_x = 30
    panel_pad_y = 24
    panel = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    panel_draw = ImageDraw.Draw(panel)
    panel_draw.rounded_rectangle(
        (
            max(26, x1 - panel_pad_x),
            max(26, y1 - panel_pad_y),
            min(WIDTH - 26, x2 + panel_pad_x),
            min(HEIGHT - 26, y1 + block_h + panel_pad_y),
        ),
        radius=38,
        fill=(0, 0, 0, 128),
        outline=(255, 255, 255, 58),
        width=2,
    )
    image.alpha_composite(panel)
    draw = ImageDraw.Draw(image)

    for index, line in enumerate(lines):
        line_w = text_size(draw, line, font, stroke)[0]
        if align == "center":
            x = int(x1 + (max_width - line_w) / 2)
        elif align == "right":
            x = int(x2 - line_w)
        else:
            x = int(x1)
        y = int(y1 + index * (line_h + gap))
        strip = (
            max(26, x - 20),
            max(26, y - 8),
            min(WIDTH - 26, x + line_w + 20),
            min(HEIGHT - 26, y + line_h + 14),
        )
        draw.rounded_rectangle(strip, radius=22, fill=(0, 0, 0, 92))
        fill = accent_fill if index == len(lines) - 1 and len(lines) > 1 else (255, 255, 255, 255)
        draw.text((x + 7, y + 11), line, font=font, fill=(0, 0, 0, 210), stroke_width=stroke + 4, stroke_fill=(0, 0, 0, 210))
        draw.text((x, y), line, font=font, fill=fill, stroke_width=stroke, stroke_fill=(0, 0, 0, 255))

    underline_y = int(y1 + block_h + 22)
    draw.rounded_rectangle((x1, underline_y, min(x1 + 260, x2), underline_y + 14), radius=7, fill=accent_fill)


def draw_reel_badge(image, config, settings, xy=(70, 1770)):
    palette = palette_values(settings.get("palette"))
    draw = ImageDraw.Draw(image)
    reel = int(config.get("reelNumber") or 1)
    label = f"REEL {reel:02d}"
    font = load_font(28)
    w, h = text_size(draw, label, font)
    x, y = xy
    draw.rounded_rectangle((x, y, x + w + 34, y + h + 18), radius=18, fill=(0, 0, 0, 150), outline=palette["accent"], width=2)
    draw.text((x + 17, y + 8), label, font=font, fill=(255, 255, 255, 255))


def blur_readability_region(image, box, alpha=100, blur=10):
    x1, y1, x2, y2 = box
    x1 = max(0, min(WIDTH, int(x1)))
    y1 = max(0, min(HEIGHT, int(y1)))
    x2 = max(x1, min(WIDTH, int(x2)))
    y2 = max(y1, min(HEIGHT, int(y2)))
    if x2 <= x1 or y2 <= y1:
        return image
    region = image.crop((x1, y1, x2, y2)).filter(ImageFilter.GaussianBlur(blur))
    wash = Image.new("RGBA", region.size, (0, 0, 0, alpha))
    region = Image.alpha_composite(region, wash)
    image.alpha_composite(region, (x1, y1))
    return image


def render_ai_background(background, headline, config, settings):
    image = cover_resize(background, scale=1.04, y_bias=0.46)
    image = stylize_frame(image, settings)
    image = Image.alpha_composite(image, vertical_gradient((0, 0, 0, 86), (0, 0, 0, 132)))
    image = add_vignette(image, 145)

    zone = settings.get("textZone") or "top"
    if zone == "center":
        image = blur_readability_region(image, (0, 460, WIDTH, 1300), alpha=86, blur=12)
    elif zone == "bottom":
        image = blur_readability_region(image, (0, 940, WIDTH, HEIGHT), alpha=116, blur=12)
    elif zone != "none":
        image = blur_readability_region(image, (0, 0, WIDTH, 860), alpha=118, blur=12)
    image = blur_readability_region(image, (0, 820, WIDTH, HEIGHT), alpha=84, blur=11)
    image = blur_readability_region(image, (0, 1320, WIDTH, HEIGHT), alpha=126, blur=13)

    overlay = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    if zone == "center":
        draw.rounded_rectangle((-30, 470, WIDTH + 30, 1290), radius=64, fill=(0, 0, 0, 82))
    elif zone == "bottom":
        draw.rectangle((0, 940, WIDTH, HEIGHT), fill=(0, 0, 0, 116))
    elif zone != "none":
        draw.rectangle((0, 0, WIDTH, 842), fill=(0, 0, 0, 120))
    image.alpha_composite(overlay)

    box, badge_xy, reel_badge_xy = thumbnail_text_zone(settings)
    draw_trigger_badge(image, config, settings, badge_xy)
    draw_thumbnail_headline(image, headline, settings, box, align="left", max_lines=3, max_size=148)
    draw_reel_badge(image, config, settings, xy=reel_badge_xy)
    return image


def render_cutout(frame, headline, config, settings):
    palette = palette_values(settings.get("palette"))
    image = blurred_background(frame, settings, scale=1.28, blur=26)
    draw = ImageDraw.Draw(image)
    draw.arc((-240, 350, WIDTH + 240, 1730), start=205, end=333, fill=palette["accent"], width=5)
    draw.arc((-180, 460, WIDTH + 180, 1840), start=205, end=333, fill=(255, 255, 255, 90), width=2)

    subject, mask = build_subject(frame, settings)
    x = int((WIDTH - subject.width) / 2)
    y = int(HEIGHT * 0.34)
    paste_shadowed(image, subject, mask, (x, y), outline=palette["paper"], outline_px=9, shadow_px=28)
    draw_headline(image, headline, settings, (70, int(text_anchor(settings)), WIDTH - 70, int(text_anchor(settings)) + 520), align="left", max_lines=4, max_size=106, panel=False)
    draw_reel_badge(image, config, settings)
    return image


def render_poster(frame, headline, config, settings):
    image = cover_resize(frame, scale=1.06, y_bias=0.46)
    image = stylize_frame(image, settings)
    image = Image.alpha_composite(image, vertical_gradient((0, 0, 0, 155), (0, 0, 0, 105)))
    image = add_vignette(image, 126)
    y = int(text_anchor(settings))
    draw_headline(image, headline, settings, (74, y, WIDTH - 74, y + 560), align="center", max_lines=4, max_size=104, panel=True)
    draw_reel_badge(image, config, settings, xy=(70, 1758))
    return image


def render_magazine(frame, headline, config, settings):
    palette = palette_values(settings.get("palette"))
    image = Image.new("RGBA", (WIDTH, HEIGHT), palette["bg"])
    image = Image.alpha_composite(image, blurred_background(frame, settings, scale=1.35, blur=36))
    card = cover_resize(frame, scale=1.0, y_bias=0.45)
    card = fit_inside(stylize_frame(card, settings), 840, 1180)
    card_frame = Image.new("RGBA", (card.width + 34, card.height + 34), palette["paper"])
    card_frame.alpha_composite(card, (17, 17))
    mask = Image.new("L", card_frame.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, card_frame.width, card_frame.height), radius=28, fill=255)
    card_frame.putalpha(mask)
    shadow = Image.new("RGBA", card_frame.size, (0, 0, 0, 0))
    shadow.putalpha(mask.filter(ImageFilter.GaussianBlur(28)).point(lambda p: int(p * 0.55)))
    image.alpha_composite(shadow, (120, 642))
    image.alpha_composite(card_frame, (100, 610))
    draw_headline(image, headline, settings, (72, 104, WIDTH - 72, 560), align="center", max_lines=3, max_size=98, panel=False)
    draw_reel_badge(image, config, settings, xy=(742, 1620))
    return image


def render_split(frame, headline, config, settings):
    palette = palette_values(settings.get("palette"))
    image = Image.new("RGBA", (WIDTH, HEIGHT), palette["bg"])
    top = Image.new("RGBA", (WIDTH, int(HEIGHT * 0.44)), palette["bg"])
    bottom = cover_resize(frame, scale=1.08, y_bias=0.54).crop((0, int(HEIGHT * 0.30), WIDTH, HEIGHT))
    bottom = stylize_frame(bottom, settings)
    image.alpha_composite(bottom, (0, int(HEIGHT * 0.38)))
    image.alpha_composite(top, (0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, int(HEIGHT * 0.39), WIDTH, int(HEIGHT * 0.405)), fill=palette["accent"])
    draw_headline(image, headline, settings, (78, 125, WIDTH - 78, 690), align="left", max_lines=4, max_size=112, panel=False)
    draw_reel_badge(image, config, settings, xy=(74, 1768))
    return image


def render_headline(frame, headline, config, settings):
    palette = palette_values(settings.get("palette"))
    image = blurred_background(frame, settings, scale=1.30, blur=30)
    subject, mask = build_subject(frame, {**settings, "motion": "calm"})
    subject = subject.resize((round(subject.width * 0.82), round(subject.height * 0.82)), Image.Resampling.LANCZOS)
    mask = mask.resize(subject.size, Image.Resampling.LANCZOS)
    paste_shadowed(image, subject, mask, (int((WIDTH - subject.width) / 2), 790), outline=(255, 255, 255, 210), outline_px=7, shadow_px=30)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, WIDTH, 760), fill=(0, 0, 0, 128))
    draw_headline(image, headline, settings, (62, 112, WIDTH - 62, 740), align="center", max_lines=4, max_size=122, panel=False)
    draw.rounded_rectangle((68, 1538, WIDTH - 68, 1630), radius=46, fill=(0, 0, 0, 150), outline=palette["accent"], width=3)
    small_font = load_font(34)
    line = "СОХРАНИ, ЕСЛИ ЭТО ПРО ТЕБЯ"
    tw, th = text_size(draw, line, small_font)
    draw.text(((WIDTH - tw) / 2, 1561), line, font=small_font, fill=palette["paper"])
    draw_reel_badge(image, config, settings, xy=(72, 1752))
    return image


def render(config):
    source_key = "background" if config.get("background") else "frame"
    frame = Image.open(Path(config[source_key])).convert("RGBA")
    settings = config.get("settings") or {}
    layout = normalize_layout(settings.get("style"))
    headline = headline_from_config(config)
    if source_key == "background":
        image = render_ai_background(frame, headline, config, settings)
    elif layout == "poster":
        image = render_poster(frame, headline, config, settings)
    elif layout == "magazine":
        image = render_magazine(frame, headline, config, settings)
    elif layout == "split":
        image = render_split(frame, headline, config, settings)
    elif layout == "headline":
        image = render_headline(frame, headline, config, settings)
    else:
        image = render_cutout(frame, headline, config, settings)

    output_path = Path(config["output"])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(output_path, "PNG", optimize=True)


def main():
    if len(sys.argv) != 2:
        print("usage: render_frame_cover.py config.json", file=sys.stderr)
        return 2
    config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    render(config)
    print(json.dumps({"ok": True}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
