#!/usr/bin/env python3
"""GUILD-09 hardening/mutation work unit.
Usage: harden-unit.py <unit-id> <test-file> <source-relpath> <mode>
mode: harden | mutate
- baseline run of the suite
- generate up to 6 semantic break candidates (=== / !== flips, return true/false flips)
- apply each, run suite, restore (try/finally)
- verdict: hardened/killed | false-positive/survived | baseline-red
mode=mutate: runs ALL my-slice suites importing the source (cap 6) per mutant.
Writes findings/guild-09/hardening/unit-<id>.json (+ .log)
"""
import sys, os, re, subprocess, json

uid, testfile, src, mode = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
WT = os.path.expanduser('~/workspace/pr-wave1000-guild-09')
OUTDIR = f'{WT}/findings/guild-09/hardening'
os.makedirs(OUTDIR, exist_ok=True)
log = open(f'{OUTDIR}/unit-{uid}.log', 'w')
def say(*a):
    print(*a, file=log, flush=True); print(*a, flush=True)

def run_tests(tests):
    env = dict(os.environ, TMPDIR=f'{WT}/.tmp')
    try:
        p = subprocess.run(['node', '--test'] + [f'tests/{t}' for t in tests],
                           cwd=WT, env=env, capture_output=True, text=True, timeout=280)
        out = (p.stdout or '') + (p.stderr or '')
        return p.returncode, out[-2000:]
    except subprocess.TimeoutExpired:
        return 124, 'TIMEOUT'

def blank(m): return ' ' * len(m.group(0))

def visible(line):
    s = re.sub(r'//.*$', blank, line)
    s = re.sub(r"'(?:[^'\\]|\\.)*'", blank, s)
    s = re.sub(r'"(?:[^"\\]|\\.)*"', blank, s)
    s = re.sub(r'`(?:[^`\\]|\\.)*`', blank, s)
    return s

srcpath = f'{WT}/{src}'
orig = open(srcpath).read()
lines = orig.split('\n')

cands = []
for i, line in enumerate(lines):
    v = visible(line)
    for m in re.finditer(r'!==|===', v):
        op = m.group(0)
        flip = '===' if op == '!==' else '!=='
        nl = line[:m.start()] + flip + line[m.end():]
        cands.append((i, nl, f'flip {op}->{flip} L{i+1}'))
        break  # one operator flip per line
    m2 = re.search(r'\breturn (true|false)\b', v)
    if m2:
        fv = 'false' if m2.group(1) == 'true' else 'true'
        nl = line[:m2.start(1)] + fv + line[m2.end(1):]
        cands.append((i, nl, f'return {m2.group(1)}->{fv} L{i+1}'))

seen, final = set(), []
for i, nl, desc in cands:
    if (i, desc) in seen: continue
    seen.add((i, desc)); final.append((i, nl, desc))
    if len(final) >= 6: break

# suites to run per mutant
if mode == 'mutate':
    suites = []
    si = open(f'{WT}/findings/guild-09/suite-imports.txt').read().split('\n')
    for row in si:
        if not row.strip(): continue
        f, _, rest = row.partition(' :: ')
        if f == testfile or f in suites: continue
        if src.replace('server/', '../server/') in rest or f'../{src}' in rest:
            suites.append(f)
    suites = [testfile] + suites[:int(os.environ.get('SUITE_CAP', '5'))]
else:
    suites = [testfile]

say(f'UNIT {uid} mode={mode} test={testfile} src={src} suites={len(suites)} breaks={len(final)}')
base_code, base_tail = run_tests(suites)
say(f'baseline_exit={base_code}')

result = {'unit': uid, 'mode': mode, 'test': testfile, 'src': src,
          'suites': suites, 'baseline_exit': base_code, 'attempts': [], 'verdict': None}
if base_code != 0:
    result['verdict'] = 'baseline-red'
    result['restored_ok'] = open(srcpath).read() == orig
    result['baseline_tail'] = base_tail[-800:]
    json.dump(result, open(f'{OUTDIR}/unit-{uid}.json', 'w'), indent=1)
    say('VERDICT=baseline-red (attempts skipped)')
    log.close(); sys.exit(0)
verdict = None
for i, nl, desc in final:
    mutated = lines.copy(); mutated[i] = nl
    try:
        open(srcpath, 'w').write('\n'.join(mutated))
        code, tail = run_tests(suites)
    finally:
        open(srcpath, 'w').write(orig)
    syntax_err = 'SyntaxError' in tail
    att = {'break': desc, 'exit': code, 'syntax_error': syntax_err, 'tail': tail[-500:]}
    result['attempts'].append(att)
    say(f'attempt {desc}: exit={code} syntax_err={syntax_err}')
    if code != 0 and not syntax_err:
        verdict = 'hardened' if mode == 'harden' else 'killed'
        result['killing_break'] = desc
        result['killing_tail'] = tail[-500:]
        break
    if code != 0 and syntax_err:
        att['note'] = 'red via syntax error only - weak evidence, continuing'

if verdict is None:
    # baseline was green (red baselines exit early above), so all-green breaks = not covered
    verdict = 'false-positive' if mode == 'harden' else 'survived'
result['verdict'] = verdict
# confirm source restored byte-identical
restored_ok = open(srcpath).read() == orig
result['restored_ok'] = restored_ok
json.dump(result, open(f'{OUTDIR}/unit-{uid}.json', 'w'), indent=1)
say(f'VERDICT={verdict} restored_ok={restored_ok}')
log.close()
