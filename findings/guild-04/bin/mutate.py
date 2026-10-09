#!/usr/bin/env python3
"""Mutation driver for wave1000 guild-04 (store-room slice).
Usage: python3 mutate.py <spec.json>
Spec: {"file": "server/x.mjs", "tests": ["tests/a.test.js"], "cwd": "/abs/path",
       "mutants": [{"id":"M1","desc":"...","pattern":"...","repl":"...","count":1,
                    "note":"optional"}]}
For each mutant: backup, apply (regex must match exactly `count` times,
else mutant is INAPPLICABLE and skipped), run node --test on mapped tests
with worktree-local TMPDIR, classify KILLED (nonzero exit) / SURVIVED
(exit 0), restore original. Appends JSONL to results file given by --out.
Always restores the original file, even on crash.
"""
import json, os, re, shutil, subprocess, sys, tempfile, time

def main():
    spec_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else spec_path + ".results.jsonl"
    with open(spec_path) as f:
        spec = json.load(f)
    cwd = spec["cwd"]
    src = os.path.join(cwd, spec["file"])
    tests = [os.path.join(cwd, t) for t in spec["tests"]]
    with open(src, "r", encoding="utf-8") as f:
        original = f.read()
    backup = src + ".mutbak"
    shutil.copyfile(src, backup)
    results = []
    try:
        for m in spec["mutants"]:
            mid, desc = m["id"], m["desc"]
            try:
                matches = list(re.finditer(m["pattern"], original))
                if len(matches) != m.get("count", 1):
                    results.append({"id": mid, "desc": desc, "status": "INAPPLICABLE",
                                    "detail": f"pattern matched {len(matches)}x, expected {m.get('count',1)}"})
                    continue
                mutated = re.sub(m["pattern"], m["repl"], original, count=m.get("count", 1))
                with open(src, "w", encoding="utf-8") as f:
                    f.write(mutated)
                env = dict(os.environ)
                env["TMPDIR"] = os.path.join(cwd, ".tmp")
                os.makedirs(env["TMPDIR"], exist_ok=True)
                t0 = time.time()
                p = subprocess.run(["node", "--test"] + tests,
                                   cwd=cwd, env=env, capture_output=True, text=True,
                                   timeout=int(m.get("timeout", 300)))
                dt = round(time.time() - t0, 1)
                status = "KILLED" if p.returncode != 0 else "SURVIVED"
                results.append({"id": mid, "desc": desc, "status": status,
                                "secs": dt, "tail": (p.stdout + p.stderr)[-600:]})
            except subprocess.TimeoutExpired:
                results.append({"id": mid, "desc": desc, "status": "TIMEOUT-HANG",
                                "detail": "test run exceeded timeout — possible hang introduced"})
            except Exception as e:
                results.append({"id": mid, "desc": desc, "status": "ERROR", "detail": repr(e)})
            finally:
                shutil.copyfile(backup, src)
    finally:
        shutil.copyfile(backup, src)
        os.remove(backup)
    # verify restore
    with open(src, "r", encoding="utf-8") as f:
        assert f.read() == original, "RESTORE FAILED — source not identical!"
    with open(out_path, "w", encoding="utf-8") as f:
        for r in results:
            f.write(json.dumps(r) + "\n")
    killed = sum(1 for r in results if r["status"] == "KILLED")
    surv = sum(1 for r in results if r["status"] == "SURVIVED")
    inap = sum(1 for r in results if r["status"] == "INAPPLICABLE")
    other = len(results) - killed - surv - inap
    print(f"{spec['file']}: {len(results)} mutants — KILLED={killed} SURVIVED={surv} INAPPLICABLE={inap} OTHER={other}")
    for r in results:
        if r["status"] != "KILLED":
            print(f"  [{r['status']}] {r['id']}: {r['desc']}")

if __name__ == "__main__":
    main()
