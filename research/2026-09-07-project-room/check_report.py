from pathlib import Path
import json
from PIL import Image, ImageOps, ImageDraw
import pdfplumber

ROOT = Path(__file__).resolve().parents[2]
PDF = ROOT / 'output/pdf/project-room-research-and-plan-2026-09-07.pdf'
IMAGES = ROOT / 'tmp/pdfs/project-room-research-payments'
with pdfplumber.open(PDF) as doc:
    violations = []
    for i, page in enumerate(doc.pages, 1):
        chars = page.chars
        text = page.extract_text() or ''
        for char in chars:
            if char['x0'] < 45 or char['x1'] > 567 or char['top'] < 20 or char['bottom'] > 775:
                violations.append((i, char['text'], char['x0'], char['top']))
        print(f'PAGE {i:02}: {len(text)} chars; {len(text.splitlines())} lines; ending: {text.splitlines()[-3:-1]}')
    assert not violations, f'Page bounds violations: {violations[:10]}'
paths = sorted(IMAGES.glob('page-*.png'))
for start in range(0, len(paths), 10):
    batch = paths[start:start + 10]
    sheet = Image.new('RGB', (1050, 1510), '#DCE4E5')
    draw = ImageDraw.Draw(sheet)
    for offset, path in enumerate(batch):
        page = Image.open(path).convert('RGB')
        thumb = ImageOps.contain(page, (195, 260))
        col, row = offset % 2, offset // 2
        x, y = 40 + col * 525, 35 + row * 298
        # Bigger than a dense 5-column sheet, so headings and sparsity remain legible.
        thumb = ImageOps.contain(page, (440, 265))
        sheet.paste(thumb, (x, y))
        draw.text((x + 220, y + 10), f'Page {start + offset + 1}', fill='#162A30')
    out = IMAGES / f'contact-{start // 10 + 1}.png'
    sheet.save(out)
    print(f'CONTACT {out}')
