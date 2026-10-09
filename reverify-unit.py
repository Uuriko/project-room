#!/usr/bin/env python3
"""GUILD-09 re-verify work unit: rebase a wave branch's SCRATCH copy onto
origin/main, run FULL touched suites (my slice only), adversarially review diff.
Usage: reverify-unit.py <n> <branch>
Writes findings/guild-09/reverify/rev-<n>.md (+ .log). Cleans its scratch worktree.
"""
import sys, os, re, subprocess

n, branch = sys.argv[1], sys.argv[2]
WT = os.path.expanduser('~/workspace/pr-wave1000-guild-09')
SCR = os.path.expanduser(f'~/workspace/guild09-rev-{n}')
OUTDIR = f'{WT}/findings/guild-09/reverify'
os.makedirs(OUTDIR, exist_ok=True)
log = open(f'{OUTDIR}/rev-{n}.log', 'w')

def say(*a):
    print(*a, file=log, flush=True); print(*a, flush=True)

def sh(cmd, cwd=None, timeout=120):
    try:
        p = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, '', 'TIMEOUT'

say(f'REVERIFY r{n}: origin/{branch}')
sh(f'git -C ~/workspace/project-room worktree remove --force {SCR}', timeout=60)
rc, out, err = sh(f'git -C ~/workspace/project-room worktree add --detach {SCR} origin/{branch}', timeout=240)
if rc != 0:
    say('worktree add FAILED', (out + err)[-500:])
    open(f'{OUTDIR}/rev-{n}.md', 'w').write(f'# r{n} {branch}\n\nworktree add failed.\n')
    sys.exit(1)
sh(f'ln -sfn ~/workspace/project-room/node_modules {SCR}/node_modules')
sh(f'mkdir -p {SCR}/.tmp')
sh(f'git -C {SCR} checkout -qb rev-{n}-scratch', timeout=60)
rc, out, err = sh(f'git -C {SCR} rebase origin/main', timeout=420)
rebased = (rc == 0)
if not rebased:
    sh(f'git -C {SCR} rebase --abort', timeout=60)
say('rebased onto origin/main:', rebased, (out + err)[-200:] if not rebased else '')

rc, diffnames, _ = sh(f'git -C {SCR} diff --name-only origin/main...HEAD', timeout=60)
files = [l.strip() for l in diffnames.split('\n') if l.strip()]
manifest = set(l.strip() for l in open(f'{WT}/findings/guild-09/slice-manifest.txt') if l.strip())
def in_my_slice(fname):
    base = fname[6:] if fname.startswith('tests/') else fname
    if not re.search(r'\.test\.(js|mjs)$', base): return False
    if re.search(r'claim|room', base, re.I): return False
    return True
my_tests = sorted({f[6:] for f in files if f.startswith('tests/') and in_my_slice(f)})
new_tests = sorted({t for t in my_tests if t not in manifest})
server_files = sorted({f for f in files if f.startswith('server/')})
other_tests = sorted({f for f in files if f.startswith('tests/') and not in_my_slice(f)})
say(f'touched files: {len(files)}')
say(f'my-slice suites to run: {my_tests}')
say(f'of which new-on-branch (not in origin/main manifest): {new_tests}')
say(f'server files: {server_files}')
say(f'excluded from run (claim/room or non-test): {other_tests}')

# If the branch touches covered server code but no my-slice test, run top importers.
extra_suites = []
if not my_tests and server_files:
    si = [l for l in open(f'{WT}/findings/guild-09/suite-imports.txt').read().split('\n') if l.strip()]
    for sf in server_files[:2]:
        needle = '../' + sf
        for row in si:
            f = row.split(' :: ')[0]
            if needle in row and f not in extra_suites and f not in my_tests:
                extra_suites.append(f)
            if len(extra_suites) >= 3:
                break
    say(f'no my-slice tests; running top importing suites for touched server files: {extra_suites}')

results = {}
for t in my_tests + extra_suites:
    env = dict(os.environ, TMPDIR=f'{SCR}/.tmp')
    try:
        p = subprocess.run(['node', '--test', f'tests/{t}'], cwd=SCR, env=env,
                           capture_output=True, text=True, timeout=280)
        tail = (p.stdout or '') + (p.stderr or '')
        results[t] = (p.returncode, tail[-900:])
    except subprocess.TimeoutExpired:
        results[t] = (124, 'TIMEOUT')
    say(f'suite {t}: exit={results[t][0]}')

# Adversarial diff review
rc, stat, _ = sh(f'git -C {SCR} diff --stat origin/main...HEAD | tail -8', timeout=60)
rc, tdiff, _ = sh(f'git -C {SCR} diff origin/main...HEAD -- tests/', timeout=60)
removed_asserts = len(re.findall(r'^-\s*assert\.', tdiff, re.M))
removed_tests = len(re.findall(r'^-\s*(?:test|suite)\s*\(', tdiff, re.M))
added_asserts = len(re.findall(r'^\+\s*assert\.', tdiff, re.M))
added_tests = len(re.findall(r'^\+\s*(?:test|suite)\s*\(', tdiff, re.M))
# source-side red flags: weakened validation (removed check/fail/throw guards)
rc, sdiff, _ = sh(f'git -C {SCR} diff origin/main...HEAD -- server/', timeout=60)
removed_guards = len(re.findall(r'^-\s*.*\b(check|fail|throw new|require\w+)\b', sdiff, re.M))

md = [f'# rev-{n} re-verify: origin/{branch}', '',
      f'- rebased onto origin/main: **{rebased}**' + ('' if rebased else ' (ran suites on un-rebased head)'),
      f'- touched files: {len(files)}',
      f'- my-slice suites run ({len(results)}): ' + (', '.join(results) if results else 'none'),
      '', '## Suite results', '']
for t, (code, tail) in results.items():
    md.append(f'- `{t}`: exit={code}')
    if code != 0:
        md.append(f'  - tail: {tail[-400:].strip()[:400]}')
md += ['', '## Adversarial diff review', '',
       f'- test diff: +{added_tests} test blocks / +{added_asserts} asserts, -{removed_tests} test blocks / -{removed_asserts} asserts',
       f'- server diff: removed guard-like lines: {removed_guards}',
       f'- diffstat tail: {stat.strip()[:600]}', '']
flags = []
if removed_tests > 0 or removed_asserts > added_asserts:
    flags.append('ASSERTION/TEST REMOVAL in test diff — inspect whether coverage was weakened.')
if not rebased:
    flags.append('REBASE FAILED — branch may be stale/conflicted; results are on the un-rebased head.')
if any(c != 0 for c, _ in results.values()):
    flags.append('SUITE FAILURE — breakage confirmed on this branch head.')
if not flags:
    flags.append('no red flags: suites green, no test/assert removal, clean rebase.')
md += ['## Verdict', ''] + [f'- {f}' for f in flags]
open(f'{OUTDIR}/rev-{n}.md', 'w').write('\n'.join(md) + '\n')
say('verdict:', ' | '.join(flags))
sh(f'git -C ~/workspace/project-room worktree remove --force {SCR}', timeout=120)
say('scratch cleaned')
log.close()
