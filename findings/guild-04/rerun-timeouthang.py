#!/usr/bin/env python3
"""Re-run TIMEOUT-HANG mutants with a 600s timeout to classify KILLED vs SURVIVED."""
import json, re, shutil, subprocess, os, time, sys

WT = "/home/hatch/workspace/pr-wave1000-guild-04"
JOBS = [
    ("findings/guild-04/specs/spec-room-export-html.json", "H2"),
    ("findings/guild-04/specs/spec-room-export-html.json", "H3"),
    ("findings/guild-04/specs/spec-room-export-html.json", "H4"),
    ("findings/guild-04/specs/spec-room-export-html.json", "H5"),
    ("findings/guild-04/specs/spec-room-export.json", "E2"),
    ("findings/guild-04/specs/spec-room-export.json", "E3"),
    ("findings/guild-04/specs/spec-room-export.json", "E4"),
    ("findings/guild-04/specs/spec-room-export.json", "E5"),
]
OUT = os.path.join(WT, "findings/guild-04/timeouthang-rerun.log")

def log(msg):
    print(msg, flush=True)
    with open(OUT, "a") as f: f.write(msg + "\n")

for spec_rel, mid in JOBS:
    spec_path = os.path.join(WT, spec_rel)
    spec = json.load(open(spec_path))
    m = [x for x in spec["mutants"] if x["id"] == mid][0]
    src = os.path.join(spec["cwd"], spec["file"])
    orig = open(src).read()
    bak = src + ".thbak"
    shutil.copyfile(src, bak)
    try:
        matches = list(re.finditer(m["pattern"], orig))
        if len(matches) != m.get("count", 1):
            log(f"{mid}: INAPPLICABLE (matched {len(matches)}x)")
            continue
        open(src, "w").write(re.sub(m["pattern"], m["repl"], orig, count=m.get("count", 1)))
        env = dict(os.environ); env["TMPDIR"] = os.path.join(WT, ".tmp")
        os.makedirs(env["TMPDIR"], exist_ok=True)
        t0 = time.time()
        try:
            p = subprocess.run(["node", "--test"] + [os.path.join(spec["cwd"], t) for t in spec["tests"]],
                               cwd=spec["cwd"], env=env, capture_output=True, text=True, timeout=600)
            dt = round(time.time() - t0, 1)
            status = "KILLED" if p.returncode != 0 else "SURVIVED"
            log(f"{mid}: {status} in {dt}s (rc={p.returncode})")
        except subprocess.TimeoutExpired:
            log(f"{mid}: TIMEOUT-HANG again (600s)")
    finally:
        shutil.copyfile(bak, src); os.remove(bak)
        assert open(src).read() == orig, f"RESTORE FAILED for {mid}"
log("ALL DONE - all originals restored")
