"""Validate the captured backlog, without claiming historical or code completeness.
Run: python3 docs/backlog/validate.py
Refresh source snapshots deliberately; updating this snapshot never closes tasks.
"""
from pathlib import Path
import json
import re

base = Path(__file__).resolve().parent
repo = base.parent.parent
inventory = json.loads((base / 'project-room-total-backlog.json').read_text())
items = inventory['items']
ids = [item['id'] for item in items]
assert len(ids) == len(set(ids)), 'Duplicate stable IDs'
for item in items:
    for field in ('id', 'title', 'section', 'kind', 'status', 'phase', 'ledger', 'acceptance'):
        assert item.get(field), (item['id'], 'missing', field)
ledger = set(re.findall(r'^\| ((?:A|R|P|M|G|AU|AD)\d+(?:\.\d+)?) \|', (repo / 'docs/DELIVERY-LEDGER.md').read_text(), re.M))
mapped = {key for item in items for key in item['ledger']}
assert ledger <= mapped, ('Unmapped ledger obligations', ledger - mapped)
assert mapped <= ledger, ('Unknown ledger IDs', mapped - ledger)
expected_ideas = {'IDEA-' + batch + str(i).zfill(2) for batch, count in [('I', 10), ('II', 12), ('III', 12)] for i in range(1, count + 1)}
assert {i for i in ids if i.startswith('IDEA-')} == expected_ideas
assert {i for i in ids if i.startswith('NATIVE-')} == {'NATIVE-MAC'+str(i).zfill(2) for i in range(1,49)}
for kind, prefix in [('issues', 'GH-I-'), ('prs', 'GH-PR-')]:
    rows = json.loads((base / ('github-open-' + kind + '-2026-10-18.json')).read_text())
    captured = {prefix + str(row['number']): row for row in rows}
    actual = {item['id']: item for item in items if item['id'].startswith(prefix)}
    assert set(actual) == set(captured), ('Source inventory mismatch', kind)
    for key, row in captured.items():
        assert actual[key]['title'] == row['title'] and actual[key]['url'] == row['url'], key
markdown = (repo / 'docs/PROJECT-ROOM-TOTAL-BACKLOG.md').read_text()
for key in ids:
    assert markdown.count('**' + key + '**') + markdown.count('**' + key + ' —') == 1, ('Markdown parity', key)
print(f'PASS: {len(items)} unique entries, {len(ledger)} ledger IDs, 34 ideas, 48 native checks, complete captured issue/PR parity.')
print('This validates inventory integrity, not unseen source coverage or completed implementation.')
