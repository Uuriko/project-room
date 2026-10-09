#!/usr/bin/env python3
"""Extract per-module summary: header comment (first 30 lines, // or /* blocks),
exported names, and one-line purpose from description keywords.
Writes .guild10/module-summaries.json for undocumented modules."""
import json, re, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
undoc = json.load(open(ROOT / "findings/guild-10/coverage-matrix.json"))["undocumented"]

def summarize(path):
    try: lines = path.read_text().splitlines()
    except: return {"error": "unreadable"}
    header = []
    for ln in lines[:40]:
        s = ln.strip()
        if s.startswith("//") or s.startswith("/*") or s.startswith("*") or s.startswith("#!") or s == "":
            header.append(ln)
        elif s.startswith("import ") or s.startswith("export "):
            break
        elif s and not s.startswith("import"):
            # first code line; stop after capturing a bit more
            break
    hdr = "\n".join(header).strip()
    # strip comment markers for a clean purpose line
    clean = re.sub(r"^[\s/*#]+", "", hdr, flags=re.M).strip()
    src = "\n".join(lines)
    exports = sorted(set(re.findall(r"export\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_][\w]*)", src)))
    exports += sorted(set(re.findall(r"export\s*\{\s*([^}]+)\s*\}", src)))
    # main entry hints
    main_hint = None
    m = re.search(r"if\s*\(\s*(?:import\.meta\.url|process\.argv)", src)
    if m: main_hint = "runnable as CLI"
    return {"header": clean[:1200], "exports": exports[:12], "cli": main_hint,
            "loc": len(lines)}

out = {}
for r in undoc:
    p = ROOT / r["module"]
    out[r["module"]] = summarize(p)

(ROOT / ".guild10" / "module-summaries.json").write_text(json.dumps(out, indent=1))
print("summarized", len(out))
# quick family stats
fams = {}
for m in out:
    if "browser-check" in m: fams.setdefault("browser-check", []).append(m)
    elif m.startswith("server/"): fams.setdefault("server", []).append(m)
    else: fams.setdefault("scripts", []).append(m)
for k, v in fams.items(): print(k, len(v))
