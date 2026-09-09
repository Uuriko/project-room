from html import escape
from pathlib import Path
import re

from PIL import Image as PILImage
from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Image, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[1]
OUTPUT = ROOT / 'output/pdf/project-room-research-and-plan-v2-2026-09-07.pdf'
FONT = Path('/Users/johnpotter/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/Resources/fonts/truetype')
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
for name, filename in [('RoomSans', 'DejaVuSans.ttf'), ('RoomSans-Bold', 'DejaVuSans-Bold.ttf')]:
    pdfmetrics.registerFont(TTFont(name, str(FONT / filename)))
pdfmetrics.registerFontFamily('RoomSans', normal='RoomSans', bold='RoomSans-Bold', italic='RoomSans', boldItalic='RoomSans-Bold')

INK = colors.HexColor('#162A30')
ACCENT = colors.HexColor('#176B70')
MUTED = colors.HexColor('#52636A')
RULE = colors.HexColor('#D5E0E1')
PALE = colors.HexColor('#F2F6F6')
WIDTH = 514
styles = {
    'body': ParagraphStyle('body', fontName='RoomSans', fontSize=10.3, leading=14.6, textColor=INK, spaceAfter=8),
    'caption': ParagraphStyle('caption', fontName='RoomSans', fontSize=9.35, leading=13.3, textColor=INK, spaceAfter=7),
    'h1': ParagraphStyle('h1', fontName='RoomSans-Bold', fontSize=38, leading=44, textColor=INK, spaceBefore=56, spaceAfter=22, keepWithNext=True),
    'h2': ParagraphStyle('h2', fontName='RoomSans-Bold', fontSize=21, leading=26, textColor=INK, spaceAfter=14, keepWithNext=True),
    'h3': ParagraphStyle('h3', fontName='RoomSans-Bold', fontSize=11, leading=14.5, textColor=ACCENT, spaceBefore=9, spaceAfter=4, keepWithNext=True),
    'bullet': ParagraphStyle('bullet', fontName='RoomSans', fontSize=10.3, leading=14.6, textColor=INK, leftIndent=12, firstLineIndent=-9, spaceAfter=8),
    'table': ParagraphStyle('table', fontName='RoomSans', fontSize=8.8, leading=12, textColor=INK),
}


def inline(value):
    parts, pos = [], 0
    for match in re.finditer(r'\[([^\]]+)\]\((https?://[^\s)]+)\)', value):
        parts.append(escape(value[pos:match.start()]))
        parts.append(f'<a href="{escape(match.group(2), quote=True)}" color="#176B70"><u>{escape(match.group(1))}</u></a>')
        pos = match.end()
    parts.append(escape(value[pos:]))
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', ''.join(parts))
    return re.sub(r'`([^`]+)`', r'\1', text)


class ReportDoc(SimpleDocTemplate):
    def afterFlowable(self, flowable):
        if isinstance(flowable, Paragraph) and flowable.style.name == 'h2':
            title = flowable.getPlainText()
            key = f'chapter-{len(self.chapter_pages)}'
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(title, key, 0, False)
            self.chapter_pages.append((self.page, title))


def page_frame(canvas, doc):
    canvas.saveState()
    canvas.setTitle('Project Room - Research and plan, version 2')
    canvas.setAuthor('Project Room research for John Potter')
    canvas.setSubject('48 new questions, eight decisions revisited, seven product comparisons')
    canvas.setFont('RoomSans-Bold', 7.5)
    canvas.setFillColor(ACCENT)
    canvas.drawString(49, 762, 'PROJECT ROOM')
    canvas.setFont('RoomSans', 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawRightString(563, 762, 'RESEARCH / DECISIONS / PLAN  -  V2')
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.5)
    canvas.line(49, 751, 563, 751)
    canvas.line(49, 39, 563, 39)
    canvas.setFont('RoomSans', 7)
    canvas.drawString(49, 25, '7 September 2026  |  Proposals, not implementation or legal clearance')
    canvas.drawRightString(563, 25, str(doc.page))
    canvas.restoreState()


raw = (BASE / 'report-source.md').read_text()
for prefix, count in [('N', 48), ('R', 8)]:
    ids = [int(x) for x in re.findall(rf'^### {prefix}(\d{{2}})\.', raw, re.M)]
    assert ids == list(range(1, count + 1)), f'{prefix} coverage failed: {ids}'
assert not re.search(r'turn\d+(search|view)|TODO|TBD', raw)
lines, story, pending = raw.splitlines(), [], []
shot_count = 0
image_section = False


def flush():
    if pending:
        story.append(Paragraph(inline(' '.join(pending)), styles['caption' if image_section else 'body']))
        pending.clear()


i = 0
while i < len(lines):
    line = lines[i].strip()
    if not line:
        flush()
    elif line == '<!-- pagebreak -->':
        flush()
        story.append(PageBreak())
    elif line.startswith('<!-- shots:'):
        flush()
        names = [name.strip() for name in line.removeprefix('<!-- shots:').removesuffix('-->').split('|')]
        assert len(names) == 2
        cells = []
        for name in names:
            path = BASE / 'screenshots' / name
            with PILImage.open(path) as picture:
                width, height = picture.size
            scale = min(218 / width, 440 / height)
            cells.append(Image(str(path), width=width * scale, height=height * scale, hAlign='CENTER'))
            shot_count += 1
        table = Table([cells], colWidths=[WIDTH / 2] * 2, hAlign='CENTER')
        table.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('TOPPADDING', (0, 0), (-1, -1), 6),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 12),
            ('BACKGROUND', (0, 0), (-1, -1), PALE),
        ]))
        story.extend([table, Spacer(1, 10)])
    elif line.startswith('# '):
        flush()
        story.append(Paragraph(inline(line[2:]), styles['h1']))
    elif line.startswith('## '):
        flush()
        image_section = 'Browser evidence:' in line
        story.append(Paragraph(inline(line[3:]), styles['h2']))
    elif line.startswith('### '):
        flush()
        story.append(Paragraph(inline(line[4:]), styles['h3']))
    elif line.startswith('|'):
        flush()
        rows = []
        while i < len(lines) and lines[i].strip().startswith('|'):
            cells = [cell.strip() for cell in lines[i].strip().strip('|').split('|')]
            if not all(re.fullmatch(r':?-+:?', cell) for cell in cells):
                rows.append([Paragraph(inline(cell), styles['table']) for cell in cells])
            i += 1
        assert all(len(row) == 3 for row in rows)
        table = Table(rows, colWidths=[104, 205, 205], repeatRows=1, hAlign='LEFT')
        table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), PALE),
            ('LINEBELOW', (0, 0), (-1, 0), .7, ACCENT),
            ('LINEBELOW', (0, 1), (-1, -1), .4, RULE),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 7),
            ('RIGHTPADDING', (0, 0), (-1, -1), 7),
            ('TOPPADDING', (0, 0), (-1, -1), 8),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
        ]))
        story.extend([table, Spacer(1, 12)])
        continue
    elif line.startswith('- '):
        flush()
        story.append(Paragraph('- ' + inline(line[2:]), styles['bullet']))
    else:
        pending.append(line)
    i += 1
flush()
assert shot_count == 4

doc = ReportDoc(str(OUTPUT), pagesize=letter, rightMargin=49, leftMargin=49, topMargin=54, bottomMargin=53)
doc.chapter_pages = []
doc.build(story, onFirstPage=page_frame, onLaterPages=page_frame)
reader = PdfReader(OUTPUT)
pdf_text = '\n'.join(page.extract_text() or '' for page in reader.pages)
for prefix, count in [('N', 48), ('R', 8)]:
    ids = [int(x) for x in re.findall(rf'(?m)^{prefix}(\d{{2}})\.', pdf_text)]
    assert ids == list(range(1, count + 1)), f'PDF {prefix} coverage failed: {ids}'
links = [annotation.get_object().get('/A', {}).get('/URI')
         for page in reader.pages for annotation in page.get('/Annots', [])
         if annotation.get_object().get('/A')]
assert len(links) > 80, f'Missing citations: {len(links)}'
assert all(len((page.extract_text() or '').strip()) > 150 for page in reader.pages), 'Unexpected empty page'
print(f'PDF: {OUTPUT}')
print(f'Pages: {len(reader.pages)}; questions: 48; reconsiderations: 8; external links: {len(links)}; unique links: {len(set(links))}; screenshots: {shot_count}; bytes: {OUTPUT.stat().st_size}')
for page, title in doc.chapter_pages:
    print(f'{page:02}: {title}')
