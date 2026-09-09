from pathlib import Path
import re

import pdfplumber
from PIL import Image, ImageDraw, ImageOps
from pypdf import PdfReader

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[1]
PDF = ROOT / 'output/pdf/project-room-research-and-plan-v2-2026-09-07.pdf'
IMAGES = ROOT / 'tmp/pdfs/project-room-v2'
SOURCE = (BASE / 'report-source.md').read_text()
reader = PdfReader(PDF)
source_links = set(re.findall(r'\]\((https?://[^\s)]+)\)', SOURCE))
ledger_links = set(re.findall(r'\]\((https?://[^\s)]+)\)', (BASE / 'SOURCE-LEDGER.md').read_text()))
assert source_links <= ledger_links, f'Missing source provenance: {source_links - ledger_links}'
pdf_links = {a.get_object().get('/A', {}).get('/URI')
             for page in reader.pages for a in page.get('/Annots', [])
             if a.get_object().get('/A')}
assert source_links == pdf_links
assert len(list((BASE / 'screenshots').glob('*.png'))) == 15
with pdfplumber.open(PDF) as doc:
    violations = []
    for i, page in enumerate(doc.pages, 1):
        text = page.extract_text() or ''
        for char in page.chars:
            if char['x0'] < 45 or char['x1'] > 567 or char['top'] < 20 or char['bottom'] > 775:
                violations.append((i, char['text'], char['x0'], char['top']))
        assert '\ufffd' not in text
        print(f'PAGE {i:02}: {len(text)} chars; {len(text.splitlines())} lines; images: {len(page.images)}')
    assert not violations, f'Page bounds violations: {violations[:10]}'
paths = sorted(IMAGES.glob('page-*.png'))
assert len(paths) == len(reader.pages)
for start in range(0, len(paths), 9):
    batch = paths[start:start + 9]
    sheet = Image.new('RGB', (1300, 1760), '#DCE4E5')
    draw = ImageDraw.Draw(sheet)
    for offset, path in enumerate(batch):
        with Image.open(path) as page:
            thumb = ImageOps.contain(page.convert('RGB'), (400, 520))
        col, row = offset % 3, offset // 3
        x, y = 24 + col * 428, 28 + row * 580
        sheet.paste(thumb, (x, y))
        draw.text((x, y + 530), f'Page {start + offset + 1}', fill='#162A30')
    out = IMAGES / f'contact-{start // 9 + 1}.png'
    sheet.save(out)
    print(f'CONTACT {out}')
print(f'PASS: {len(reader.pages)} pages; {len(source_links)} unique external citations; 15 source screenshots; no text bounds violations.')
