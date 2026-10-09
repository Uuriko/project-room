#!/usr/bin/env python3
"""guild-10 coverage: for each code module, check docs/ for coverage.
A module is COVERED if a doc file basename matches, or any docs/*.md mentions
the module path/basename in a section, or it appears in docs/INDEX.md trees.
Writes findings/guild-10/coverage-matrix.json + .md"""
import json, re, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
F = ROOT / "findings" / "guild-10"
F.mkdir(parents=True, exist_ok=True)

DOC_TEXTS = {}
for f in DOCS.rglob("*.md"):
    try: DOC_TEXTS[str(f.relative_to(ROOT))] = f.read_text()
    except: pass

def covered(basename, stem):
    hits = []
    for doc, txt in DOC_TEXTS.items():
        if basename in txt or stem.replace("-", " ") in txt.lower():
            hits.append(doc)
    return hits

MODS = []
for pat in ["server/*.mjs", "scripts/room", "scripts/*.mjs", "scripts/*.js",
            "client/*.html", "client/*.js", "server.mjs"]:
    for f in sorted(ROOT.glob(pat)):
        if f.is_file() and not f.name.startswith("."):
            MODS.append(str(f.relative_to(ROOT)))
# dedupe
MODS = sorted(set(MODS))

rows = []
for mod in MODS:
    base = pathlib.Path(mod).name
    stem = pathlib.Path(mod).stem
    hits = covered(base, stem)
    rows.append({"module": mod, "covered": bool(hits), "docs": hits[:6]})

undoc = [r for r in rows if not r["covered"]]
json.dump({"total": len(rows), "covered": len(rows) - len(undoc),
           "undocumented": undoc, "all": rows},
          open(F / "coverage-matrix.json", "w"), indent=1)
md = ["# guild-10 doc coverage matrix", f"modules: {len(rows)}, covered: {len(rows)-len(undoc)}, undocumented: {len(undoc)}", ""]
for r in undoc:
    md.append(f"- [UNDOC] {r['module']}")
(F / "coverage-matrix.md").write_text("\n".join(md))
print(f"total={len(rows)} covered={len(rows)-len(undoc)} undocumented={len(undoc)}")
