#!/usr/bin/env python3
"""Orphan-doc analysis: for each docs/**/*.md, count inbound references from
README.md, AGENTS.md, docs/INDEX.md and all other docs/*.md files.
Writes findings/guild-10/dead-code.md (orphan section)."""
import json, re, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
F = ROOT / "findings" / "guild-10"

docs = sorted(str(f.relative_to(ROOT)) for f in DOCS.rglob("*.md"))
# also .html twins don't count as references
ref_blobs = {}
for f in DOCS.rglob("*.md"):
    try: ref_blobs[str(f.relative_to(ROOT))] = f.read_text()
    except: pass
for extra in ["README.md", "AGENTS.md", "CONTRIBUTING.md"]:
    p = ROOT / extra
    if p.exists(): ref_blobs[extra] = p.read_text()

inbound = {d: 0 for d in docs}
for src, txt in ref_blobs.items():
    for d in docs:
        if src == d: continue
        base = pathlib.Path(d).name
        # reference if basename or relative path appears
        if base in txt or d.replace("docs/", "") in txt:
            inbound[d] += 1

orphans = sorted(d for d, n in inbound.items() if n == 0)
thin = []
for d in orphans:
    p = ROOT / d
    try: lines = p.read_text().splitlines()
    except: continue
    thin.append({"doc": d, "lines": len(lines)})

json.dump({"total_docs": len(docs), "orphans": thin},
          open(F / "orphan-docs.json", "w"), indent=1)
print("docs:", len(docs), "orphans:", len(orphans))
for o in thin[:40]:
    print(o["lines"], o["doc"])
