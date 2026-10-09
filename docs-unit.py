#!/usr/bin/env python3
"""GUILD-09 docs work unit: document what each suite in the batch actually proves.
Usage: docs-unit.py <batch-n>  (1..10)
Writes findings/guild-09/docs/batch-<n>.md
"""
import sys, os, re

n = int(sys.argv[1])
WT = os.path.expanduser('~/workspace/pr-wave1000-guild-09')
OUTDIR = f'{WT}/findings/guild-09/docs'
os.makedirs(OUTDIR, exist_ok=True)
manifest = [l.strip() for l in open(f'{WT}/findings/guild-09/slice-manifest.txt') if l.strip()]
B = 89
batch = manifest[(n-1)*B : n*B]

def analyze(path):
    try:
        s = open(path).read()
    except Exception as e:
        return {'error': str(e)}
    tests = len(re.findall(r'(?:^|[\s;])test\s*\(', s))
    asserts = len(re.findall(r'\bassert\.(?:equal|deepEqual|deepStrictEqual|strictEqual|notEqual|notDeepEqual|ok|match|throws|rejects|doesNotThrow|fail|ifError)\s*\(', s))
    raw_assert = len(re.findall(r'\bassert\s*\(', s))
    imports = re.findall(r'from\s+"(\.\./[^"]+)"', s)
    server_imports = sorted({i for i in imports if '/server/' in i or i.startswith('../scripts/') or i.startswith('../machine/')})
    # heuristic: does it hit HTTP? boots a server?
    httpish = bool(re.search(r'localhost|127\.0\.0\.1|fetch\(|http\.|createServer|listen\(', s))
    dbish = bool(re.search(r'DatabaseSync|sqlite|new Database', s))
    lines = s.count('\n') + 1
    return {'tests': tests, 'asserts': asserts, 'raw_assert': raw_assert, 'imports': server_imports,
            'http': httpish, 'db': dbish, 'lines': lines}

out = [f'# Guild-09 docs batch {n}', '',
       f'{len(batch)} suites. For each: what it proves, assertion density, coverage surface.', '']
no_assert, thin = [], []
for f in batch:
    a = analyze(f'{WT}/tests/{f}')
    if 'error' in a:
        out.append(f'## {f}\n\n- ERROR: {a["error"]}\n'); continue
    proves = []
    if a['http']: proves.append('HTTP surface')
    if a['db']: proves.append('sqlite-backed behavior')
    if a['imports']: proves.append('covers: ' + ', '.join(a['imports'][:4]))
    if not proves: proves.append('pure unit logic (no http/db detected)')
    density = f"{a['asserts']} strict assertions / {a['tests']} test() blocks"
    flag = ''
    if a['asserts'] == 0 and a['raw_assert'] == 0:
        flag = ' **NO REAL ASSERTIONS**'; no_assert.append(f)
    elif a['asserts'] == 0 and a['raw_assert'] > 0:
        flag = ' (bare assert() only)'; thin.append(f)
    elif a['tests'] > 0 and a['asserts'] / max(a['tests'],1) < 1:
        flag = ' (thin: <1 strict assert per test)'; thin.append(f)
    out.append(f'## {f}{flag}\n\n- {a["lines"]} lines; {density}\n- proves: {"; ".join(proves)}\n')
out += ['', '## Batch summary', '',
        f'- suites: {len(batch)}',
        f'- NO REAL ASSERTIONS: {len(no_assert)}' + (f' — {", ".join(no_assert)}' if no_assert else ''),
        f'- thin/weak assertions: {len(thin)}' + (f' — {", ".join(thin[:20])}' + ('…' if len(thin) > 20 else '') if thin else '')]
open(f'{OUTDIR}/batch-{n}.md', 'w').write('\n'.join(out) + '\n')
print(f'batch {n}: {len(batch)} suites, {len(no_assert)} no-assert, {len(thin)} thin')
