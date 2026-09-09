from pathlib import Path
from html import escape
import re

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle
from pypdf import PdfReader

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent.parent
SOURCE = BASE / 'report-source.md'
OUTPUT = ROOT / 'output/pdf/project-room-research-and-plan-2026-09-07.pdf'
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
FONT = Path('/Users/johnpotter/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/Resources/fonts/truetype')
pdfmetrics.registerFont(TTFont('RoomSans', str(FONT / 'DejaVuSans.ttf')))
pdfmetrics.registerFont(TTFont('RoomSans-Bold', str(FONT / 'DejaVuSans-Bold.ttf')))
pdfmetrics.registerFontFamily('RoomSans', normal='RoomSans', bold='RoomSans-Bold', italic='RoomSans', boldItalic='RoomSans-Bold')

INK = colors.HexColor('#162A30')
ACCENT = colors.HexColor('#176B70')
MUTED = colors.HexColor('#52636A')
RULE = colors.HexColor('#D5E0E1')
PALE = colors.HexColor('#F2F6F6')
styles = {
    'body': ParagraphStyle('body', fontName='RoomSans', fontSize=9.35, leading=13.3, textColor=INK, spaceAfter=7),
    'h1': ParagraphStyle('h1', fontName='RoomSans-Bold', fontSize=38, leading=44, textColor=INK, spaceBefore=56, spaceAfter=22, keepWithNext=True),
    'h2': ParagraphStyle('h2', fontName='RoomSans-Bold', fontSize=21, leading=26, textColor=INK, spaceAfter=14, keepWithNext=True),
    'h3': ParagraphStyle('h3', fontName='RoomSans-Bold', fontSize=10.35, leading=14, textColor=ACCENT, spaceBefore=8, spaceAfter=4, keepWithNext=True),
    'index': ParagraphStyle('index', fontName='RoomSans', fontSize=8.8, leading=12.4, textColor=INK, spaceAfter=10),
    'bullet': ParagraphStyle('bullet', fontName='RoomSans', fontSize=9.35, leading=13.3, textColor=INK, leftIndent=12, firstLineIndent=-9, spaceAfter=7),
    'table': ParagraphStyle('table', fontName='RoomSans', fontSize=8.1, leading=11, textColor=INK),
    'note': ParagraphStyle('note', fontName='RoomSans', fontSize=8.3, leading=11.6, textColor=MUTED, spaceBefore=5, spaceAfter=6),
}

def inline(value):
    out = []
    pos = 0
    for match in re.finditer(r'\[([^\]]+)\]\((https?://[^\s)]+)\)', value):
        out.append(escape(value[pos:match.start()]))
        out.append(f'<a href="{escape(match.group(2), quote=True)}" color="#176B70"><u>{escape(match.group(1))}</u></a>')
        pos = match.end()
    out.append(escape(value[pos:]))
    text = ''.join(out)
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'`([^`]+)`', r'\1', text)
    return text

class ReportDoc(SimpleDocTemplate):
    def afterFlowable(self, flowable):
        if isinstance(flowable, Paragraph) and flowable.style.name == 'h2':
            text = flowable.getPlainText()
            name = f'chapter-{len(self.chapter_pages)}'
            self.canv.bookmarkPage(name)
            self.canv.addOutlineEntry(text, name, 0, False)
            self.chapter_pages.append((self.page, text))

def page_frame(canvas, doc):
    canvas.saveState()
    canvas.setTitle('Project Room - 84 choices, two research rounds, one plan')
    canvas.setAuthor('Project Room research for John Potter')
    canvas.setSubject('Evidence-backed product research and staged planning, 7 September 2026')
    canvas.setFont('RoomSans-Bold', 7.5)
    canvas.setFillColor(ACCENT)
    canvas.drawString(49, 762, 'PROJECT ROOM')
    canvas.setFont('RoomSans', 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawRightString(563, 762, 'RESEARCH / DECISIONS / PLAN')
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.5)
    canvas.line(49, 751, 563, 751)
    canvas.line(49, 39, 563, 39)
    canvas.setFont('RoomSans', 7)
    canvas.drawString(49, 25, '7 September 2026  |  Proposals, not implementation or legal clearance')
    canvas.drawRightString(563, 25, str(doc.page))
    canvas.restoreState()

raw = SOURCE.read_text()
ids = [int(x) for x in re.findall(r'^### (\d{2})\.', raw, re.M)]
assert ids == list(range(1, 85)), f'Question coverage failed: {ids}'
assert not re.search(r'turn\d+(search|view)|TODO|TBD', raw), 'Unexpected source marker or placeholder'
lines = raw.splitlines()
story = []
index_mode = False
pending = []

def flush():
    if not pending:
        return
    text = ' '.join(pending)
    style = styles['index' if index_mode else 'body']
    if text.startswith('Evidence:'):
        style = styles['note']
    story.append(Paragraph(inline(text), style))
    pending.clear()

i = 0
while i < len(lines):
    line = lines[i].strip()
    if not line:
        flush()
    elif line == '<!-- pagebreak -->':
        flush()
        story.append(PageBreak())
    elif line.startswith('# '):
        flush()
        story.append(Paragraph(inline(line[2:]), styles['h1']))
    elif line.startswith('## '):
        flush()
        title = line[3:]
        index_mode = title.startswith('Evidence index')
        story.append(Paragraph(inline(title), styles['h2']))
    elif line.startswith('### '):
        flush()
        story.append(Paragraph(inline(line[4:]), styles['h3']))
    elif line.startswith('|'):
        flush()
        rows = []
        while i < len(lines) and lines[i].strip().startswith('|'):
            cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
            if not all(re.fullmatch(r':?-+:?', c) for c in cells):
                rows.append([Paragraph(inline(c), styles['table']) for c in cells])
            i += 1
        table = Table(rows, colWidths=[80, 80, 80, 171, 91], repeatRows=1, hAlign='LEFT')
        table.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,0), PALE),
            ('LINEBELOW', (0,0), (-1,0), .7, ACCENT),
            ('LINEBELOW', (0,1), (-1,-1), .4, RULE),
            ('VALIGN', (0,0), (-1,-1), 'TOP'),
            ('LEFTPADDING', (0,0), (-1,-1), 7),
            ('RIGHTPADDING', (0,0), (-1,-1), 7),
            ('TOPPADDING', (0,0), (-1,-1), 8),
            ('BOTTOMPADDING', (0,0), (-1,-1), 8),
        ]))
        story.extend([table, Spacer(1, 12)])
        continue
    elif line.startswith('- '):
        flush()
        story.append(Paragraph('- ' + inline(line[2:]), styles['bullet']))
    elif re.match(r'^\d\. ', line):
        flush()
        story.append(Paragraph(inline(line), styles['body']))
    else:
        pending.append(line)
    i += 1
flush()

doc = ReportDoc(str(OUTPUT), pagesize=letter, rightMargin=49, leftMargin=49, topMargin=54, bottomMargin=53)
doc.chapter_pages = []
doc.build(story, onFirstPage=page_frame, onLaterPages=page_frame)
reader = PdfReader(OUTPUT)
pdf_text = '\n'.join(page.extract_text() or '' for page in reader.pages)
atlas_text = pdf_text.split('A. Product and demand', 1)[1].split('5. One quiet experience', 1)[0]
pdf_ids = [int(x) for x in re.findall(r'(?m)^(\d{2})\.', atlas_text)]
assert pdf_ids == list(range(1, 85)), f'PDF question coverage failed: {pdf_ids}'
links = [a.get_object().get('/A', {}).get('/URI') for page in reader.pages for a in page.get('/Annots', []) if a.get_object().get('/A')]
assert len(links) > 70, f'Missing citations: {len(links)}'
assert all(len((page.extract_text() or '').strip()) > 150 for page in reader.pages), 'Unexpected empty page'
print(f'PDF: {OUTPUT}')
print(f'Pages: {len(reader.pages)}; numbered questions: {len(pdf_ids)}; external links: {len(links)}; bytes: {OUTPUT.stat().st_size}')
for page, title in doc.chapter_pages:
    print(f'{page:02}: {title}')
