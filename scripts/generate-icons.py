"""Rebuild app icons from the same C-and-seats geometry as public/brand.svg (Pillow)."""
from math import cos, sin, radians
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SCALE = 3
im = Image.new('RGBA', (1024 * SCALE, 1024 * SCALE))
draw = ImageDraw.Draw(im)
def box(values):
    return tuple(round(v * SCALE) for v in values)
draw.rounded_rectangle(box((32, 32, 992, 992)), radius=220 * SCALE, fill='#191a20')
draw.rounded_rectangle(box((33, 33, 991, 991)), radius=220 * SCALE, outline='#34333e', width=2 * SCALE)
def xy(x, y):
    return ((176 + x * 14) * SCALE, (176 + y * 14) * SCALE)
def dot(x, y, r, fill):
    a, b = xy(x-r, y-r), xy(x+r, y+r)
    draw.ellipse((*a, *b), fill=fill)
# Pillow strokes an arc inward; place caps at the stroke's middle radius.
# Use an expanded bounding box to center the six-unit stroke at radius sixteen.
draw.arc((*xy(5, 5), *xy(43, 43)), 60, 300, fill='#c5b8ee', width=84 * SCALE)
for angle in (60, 300):
    dot(24 + 16*cos(radians(angle)), 24 + 16*sin(radians(angle)), 3, '#c5b8ee')
dot(40, 18, 3.5, '#c5b8ee')
dot(24, 24, 4, '#6f6987')
im = im.resize((1024, 1024), Image.Resampling.LANCZOS)
for target in ('build/icon.png', 'resources/icon.png'):
    im.save(ROOT / target)
im.save(ROOT / 'build/icon.ico', sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
im.save(ROOT / 'build/icon.icns')

# The hosted Slack app's Home tab images (served at /icons/<name>.png): the mark, and a plain
# monogram for each service it connects. Our own drawings in each service's colour, not their logos.
from PIL import ImageFont
ICONS = ROOT / 'src/main/icons'
ICONS.mkdir(exist_ok=True)
im.resize((256, 256), Image.Resampling.LANCZOS).save(ICONS / 'consortium.png', optimize=True)
FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
for name, bg, fg, text in (
    ('openrouter', '#6467f2', '#ffffff', 'OR'),
    ('github', '#24292f', '#ffffff', 'GH'),
    ('linear', '#5e6ad2', '#ffffff', 'L'),
    ('datadog', '#632ca6', '#ffffff', 'D'),
    ('sentry', '#362d59', '#ffffff', 'S'),
    ('notion', '#ffffff', '#191a20', 'N'),
    ('atlassian', '#0052cc', '#ffffff', 'A'),
    ('custom', '#191a20', '#c5b8ee', '{ }'),
):
    S = 256
    icon = Image.new('RGBA', (S, S))
    d = ImageDraw.Draw(icon)
    d.rounded_rectangle((0, 0, S - 1, S - 1), radius=56, fill=bg, outline='#d6d3de' if bg == '#ffffff' else None, width=6)
    font = ImageFont.truetype(FONT, 150 if len(text) == 1 else 104)
    d.text((S / 2, S / 2 + 4), text, font=font, fill=fg, anchor='mm')
    icon.resize((64, 64), Image.Resampling.LANCZOS).save(ICONS / f'{name}.png', optimize=True)
