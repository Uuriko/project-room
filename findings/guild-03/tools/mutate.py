#!/usr/bin/env python3
"""Guild-03 mutation runner. Sequential by design: mutates one file in the
worktree at a time, runs the affected test file(s), restores via git.

spec JSON: {"units":[{"id","file","tests":[...],"mutants":[{"id","kind","old","new"}]}]}
old must occur exactly once; mutant must pass `node --check`.
KILLED = at least one affected test fails. SURVIVED = all pass.
"""
import json, os, subprocess, sys, time

def run(cmd, cwd, timeout=180, env=None):
    e = dict(os.environ); e.update(env or {})
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=e)
        return p.returncode, (p.stdout + p.stderr)[-4000:]
    except subprocess.TimeoutExpired:
        return 124, "TIMEOUT"

def main():
    spec_path, out_path = sys.argv[1], sys.argv[2]
    repo = os.path.expanduser("~/workspace/pr-wave1000-guild-03")
    tmpdir = os.path.join(repo, ".tmp")
    os.makedirs(tmpdir, exist_ok=True)
    if spec_path.endswith(".py"):
        ns = {}
        exec(open(spec_path).read(), ns)
        spec = ns["SPEC"]
    else:
        spec = json.load(open(spec_path))
    results = []
    for unit in spec["units"]:
        fpath = os.path.join(repo, unit["file"])
        src = open(fpath).read()
        for m in unit["mutants"]:
            tag = f'{unit["id"]}:{m["id"]}'
            n = src.count(m["old"])
            if n != 1:
                results.append((tag, unit["file"], m["kind"], "SKIPPED", f"old occurs {n}x (need 1)"))
                continue
            mutated = src.replace(m["old"], m["new"])
            open(fpath, "w").write(mutated)
            rc, out = run(["node", "--check", fpath], repo, 30)
            if rc != 0:
                results.append((tag, unit["file"], m["kind"], "INVALID", "syntax error after mutation"))
            else:
                t0 = time.time()
                failed, details = [], []
                for t in unit["tests"]:
                    rc, out = run(["node", "--test", t], repo, 240, {"TMPDIR": tmpdir})
                    if rc != 0:
                        failed.append(t); details.append(f"{t}: FAIL rc={rc}\n{out[-1500:]}")
                dt = round(time.time() - t0, 1)
                if failed:
                    results.append((tag, unit["file"], m["kind"], "KILLED", f"{dt}s; failing: {', '.join(failed)}"))
                else:
                    results.append((tag, unit["file"], m["kind"], "SURVIVED", f"{dt}s; all {len(unit['tests'])} test file(s) pass"))
            subprocess.run(["git", "checkout", "--", unit["file"]], cwd=repo, capture_output=True)
    # verify clean
    rc, _ = run(["git", "status", "--porcelain", "--", "server/"], repo, 30)
    with open(out_path, "a") as fh:
        fh.write(f"\n## mutation run {time.strftime('%Y-%m-%d %H:%M %Z')}\n")
        for tag, fil, kind, verdict, note in results:
            fh.write(f"- `{tag}` {fil} [{kind}] → **{verdict}** — {note}\n")
        k = sum(1 for r in results if r[3] == "KILLED"); s = sum(1 for r in results if r[3] == "SURVIVED")
        fh.write(f"\nsummary: {len(results)} mutants, {k} killed, {s} survived, rest skipped/invalid\n")
    print(f"done: {len(results)} mutants, {k} killed, {s} survived")

if __name__ == "__main__":
    main()
