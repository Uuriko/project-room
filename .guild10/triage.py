#!/usr/bin/env python3
"""guild-10 triage: re-verify raw scanner items against current HEAD.
Usage: triage.py <check> [args]
Checks: endpoints | paths | links | verbs | env | openapi
Writes findings/guild-10/triage/<check>.json + .md
"""
import json, re, glob, subprocess, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
TRI = ROOT / "findings" / "guild-10" / "triage"
TRI.mkdir(parents=True, exist_ok=True)
OUT = ROOT / ".guild10" / "out"

def load_all():
    items = []
    for f in sorted(OUT.glob("*.json")):
        d = json.load(open(f))
        for it in d.get("items", []):
            it["_unit"] = f.stem
            items.append(it)
    return items

def git(*a):
    r = subprocess.run(["git", "-C", str(ROOT)] + list(a), capture_output=True, text=True)
    return r.stdout

def check_endpoints(items):
    """ENDPOINT_NOT_IN_CODE: for each doc'd METHOD path, grep server/ for path fragment.
    Confirmed = no occurrence of any significant path fragment in server/*.mjs."""
    srv = list((ROOT / "server").rglob("*.mjs"))
    texts = {}
    for f in srv:
        try: texts[f.name] = f.read_text()
        except: pass
    confirmed, fp = [], []
    seen = set()
    for it in items:
        if it.get("type") != "ENDPOINT_NOT_IN_CODE": continue
        det = it.get("detail", "")
        m = re.match(r"(\w+)\s+(/\S+):", det)
        if not m: continue
        meth, path = m.groups()
        key = (meth, path)
        if key in seen: continue
        seen.add(key)
        segs = [s for s in path.split("/") if s and not s.startswith("{") and not s.startswith(":") and "${" not in s]
        sig = [s for s in segs if len(s) > 2]
        hit = False
        for sn, txt in texts.items():
            if all(s in txt for s in sig[-2:]):  # last two significant segments
                hit = True; break
        if hit: fp.append(it)
        else: confirmed.append(it)
    return confirmed, fp

def check_paths(items):
    """REPO_PATH_MISSING / DEAD_FILE_REF: re-check existence at HEAD."""
    confirmed, fp = [], []
    seen = set()
    for it in items:
        if it.get("type") not in ("REPO_PATH_MISSING", "DEAD_FILE_REF"): continue
        m = re.search(r"(?:path|file)\s+([\w.\-/]+)\s+does\snot\s+exist|missing\s+file\s+([\w.\-/]+)", it.get("detail", ""))
        rp = m.group(1) or m.group(2) if m else None
        if not rp:
            m2 = re.search(r"`((?:server|scripts|docs|tests|public|web|agents)/[\w.\-/]+)`", it.get("text", ""))
            rp = m2.group(1) if m2 else None
        if not rp or rp in seen: continue
        seen.add(rp)
        exists = (ROOT / rp).exists()
        (fp if exists else confirmed).append({**it, "path": rp})
    return confirmed, fp

def check_links(items):
    """BROKEN_LINK: re-check resolution at HEAD."""
    confirmed, fp = [], []
    seen = set()
    for it in items:
        if it.get("type") != "BROKEN_LINK": continue
        doc, line = it.get("doc"), it.get("line")
        p = ROOT / doc
        try: ln = p.read_text().splitlines()[line - 1]
        except: continue
        ms = re.findall(r"\[[^\]]*\]\(([^)\s]+)\)", ln)
        for tgt in ms:
            if tgt.startswith(("http://", "https://", "mailto:")) : continue
            if (tgt, doc) in seen: continue
            seen.add((tgt, doc))
            tgt_path, _, _anc = tgt.partition("#")
            res = (p.parent / tgt_path).resolve() if tgt_path else p
            if res.exists(): fp.append({**it, "tgt": tgt})
            else: confirmed.append({**it, "tgt": tgt})
    return confirmed, fp

def check_verbs(items):
    """DEAD_ROOM_VERB / UNKNOWN_ROOM_FLAG: re-check scripts/room source."""
    src = (ROOT / "scripts" / "room").read_text()
    verbs = set(re.findall(r'''(?:verb\s*===?\s*|case\s*)["']([a-z][a-z0-9\-]*)["']''', src))
    confirmed, fp = [], []
    seen = set()
    for it in items:
        if it.get("type") not in ("DEAD_ROOM_VERB", "UNKNOWN_ROOM_FLAG"): continue
        det = it.get("detail", "")
        if it.get("type") == "DEAD_ROOM_VERB":
            m = re.search(r"verb '([\w\-]+)'", det)
            v = m.group(1) if m else None
            key = ("verb", v)
            if v and v not in seen:
                seen.add(key)
                if v in verbs or v in src: fp.append({**it, "verb": v})
                else: confirmed.append({**it, "verb": v})
        else:
            m = re.search(r"flag (--[\w\-]+)", det)
            f_ = m.group(1) if m else None
            if f_ and f_ not in seen:
                seen.add(f_)
                if f_ in src: fp.append({**it, "flag": f_})
                else: confirmed.append({**it, "flag": f_})
    return confirmed, fp

def check_env(items):
    """ENV_VAR_CANDIDATE: check if process.env.<VAR> read anywhere in server/scripts/cloudflare."""
    roots = [ROOT / "server", ROOT / "scripts", ROOT / "cloudflare", ROOT / "bin"]
    blobs = []
    for r in roots:
        if not r.exists(): continue
        for f in r.rglob("*"):
            if f.suffix in (".mjs", ".js", ".ts", ".sh", ".json", ".yml", ".yaml", "") and f.is_file():
                try:
                    if f.stat().st_size < 2_000_000: blobs.append(f.read_text())
                except: pass
    big = "\n".join(blobs)
    confirmed, fp = [], []
    seen = set()
    for it in items:
        if it.get("type") != "ENV_VAR_CANDIDATE": continue
        m = re.search(r"env var ([A-Z][A-Z0-9_]*)", it.get("detail", ""))
        v = m.group(1) if m else None
        if not v or v in seen: continue
        seen.add(v)
        if re.search(r"\b(process\.env\." + re.escape(v) + r"|" + re.escape(v) + r"\s*[:=])", big):
            fp.append({**it, "var": v})
        else:
            confirmed.append({**it, "var": v})
    return confirmed, fp

def check_openapi(items):
    """PATH_NOT_FOUND_IN_CODE: re-check with fuzzy fragment grep over server/."""
    srv_blobs = []
    for f in (ROOT / "server").rglob("*.mjs"):
        try: srv_blobs.append(f.read_text())
        except: pass
    big = "\n".join(srv_blobs)
    confirmed, fp = [], []
    seen = set()
    for it in items:
        if it.get("type") != "PATH_NOT_FOUND_IN_CODE": continue
        p, meth = it.get("path"), it.get("method")
        key = (p, meth)
        if key in seen: continue
        seen.add(key)
        segs = [s for s in p.split("/") if s and "{" not in s and "}" not in s and len(s) > 2]
        hit = any(all(s in big for s in segs[i:i+2]) for i in range(max(1, len(segs)-1)))
        (fp if hit else confirmed).append(it)
    return confirmed, fp

CHECKS = {"endpoints": check_endpoints, "paths": check_paths, "links": check_links,
          "verbs": check_verbs, "env": check_env, "openapi": check_openapi}

def main():
    chk = sys.argv[1]
    items = load_all()
    confirmed, fp = CHECKS[chk](items)
    res = {"check": chk, "confirmed": len(confirmed), "false_positive": len(fp),
           "items": confirmed}
    (TRI / f"{chk}.json").write_text(json.dumps(res, indent=1))
    md = [f"# triage {chk}", f"confirmed: {len(confirmed)}, false-positive: {len(fp)}", ""]
    for it in confirmed:
        md.append(f"- {it.get('doc', it.get('path',''))}:{it.get('line','')} — {it.get('detail','')}")
    (TRI / f"{chk}.md").write_text("\n".join(md))
    print(f"{chk}: confirmed={len(confirmed)} fp={len(fp)}")

if __name__ == "__main__":
    main()
