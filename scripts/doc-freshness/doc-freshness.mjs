#!/usr/bin/env node
// doc-freshness.mjs — F-01 doc-freshness lint v1 (fleet-side, census apparatus).
//
// Spec: ~/workspace/fixplan-2026-10-19/truth-layer.md §5 (charter F-01).
// Ratified: ~/workspace/fixplan-2026-10-19/JILL-RATIFICATION-V2.md §§5/8.
//
// The lint does not judge prose truth. It mechanically checks the seven
// shapes doc rot actually took (SPEC-DRIFT specimens SD-17/22/23/24/25/27/40):
//   1. status claims about PRs/issues vs the GitHub API state
//   2. backticked repo-relative paths exist in the tree at base
//      (forward references only via dated rules-config exceptions)
//   3. same-PR update rule: a PR touching a mapped surface must touch its
//      companion doc or carry a `no-doc-change: <reason>` waiver
//   4. "as of" / Version: / generated: stamp aging (status docs 14d WARN;
//      "Latest …" sections 35d FAIL)
//   5. backticked ENV_NAME=value claims exist in wrangler config / workflows
//   6. count claims carry a `counted: <method> @ <base>` annotation (WARN v1)
//   7. /api/ routes claimed by the served discovery source exist in the
//      route table / OpenAPI / legacy chain; unclaimed routes = coverage NOTE
//
// Discipline:
//  - A check that cannot run prints INCOMPLETE with its reason, never a
//    silent pass. API failure (incl. 429) => check 1 INCOMPLETE, never a guess.
//  - Exceptions (rules config) carry expiry dates. An expired exception
//    stops suppressing and itself raises a FAIL.
//  - Triage downgrade: with --triage, if the false-positive rate over
//    triaged findings exceeds 30%, the run reports DEGRADED and every
//    FAIL is downgraded to WARN (charter kill/downgrade rule).
//
// Exit codes: 0 = no FAIL (WARN/NOTE ok) · 1 = FAIL · 2 = DEGRADED or
// any check INCOMPLETE.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// ------------------------------------------------------------ args

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")) args[key] = process.argv[++i];
    else args[key] = true;
  }
}
const ROOT = args.root ? path.resolve(args.root) : null;
if (!ROOT) { console.error("usage: doc-freshness.mjs --root <repoDir> [--config rules.json] [--base <label>] [--now YYYY-MM-DD] [--live | --api-fixture file] [--batch file | --prs 1,2,3] [--triage file] [--json out] [--cache-dir dir]"); process.exit(64); }
const CONFIG_PATH = args.config ? path.resolve(args.config) : path.join(path.dirname(new URL(import.meta.url).pathname), "doc-freshness-rules.json");
const NOW = args.now ? new Date(`${args.now}T00:00:00Z`) : new Date();
const NOW_LABEL = NOW.toISOString().slice(0, 10);
const BASE_LABEL = args.base || "(unnamed base)";
const CACHE_DIR = args["cache-dir"] ? path.resolve(args["cache-dir"]) : path.join(process.env.TMPDIR || "/tmp", "doc-freshness-cache");

const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const REPO = cfg.repo || "Uuriko/project-room";

// ------------------------------------------------------------ helpers

function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
        else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
const globMatch = (glob, p) => globToRegex(glob).test(p);

function walkFiles(dirAbs, out = []) {
  let entries;
  try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const abs = path.join(dirAbs, e.name);
    if (e.isDirectory()) walkFiles(abs, out);
    else if (e.isFile()) out.push(abs);
  }
  return out;
}
const relOf = abs => path.relative(ROOT, abs).split(path.sep).join("/");

// Resolve a list of glob patterns to existing repo-relative files.
// Returns {files: [...], missingLiterals: [...]}.
function resolvePatterns(patterns) {
  const files = new Set(); const missing = [];
  const all = walkFiles(ROOT).map(relOf);
  for (const pat of patterns) {
    if (!/[*?]/.test(pat)) {
      if (fs.existsSync(path.join(ROOT, pat))) files.add(pat); else missing.push(pat);
    } else {
      for (const f of all) if (globMatch(pat, f)) files.add(f);
    }
  }
  return { files: [...files].sort(), missing };
}

function readRel(rel) { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return null; } }
function linesOf(text) { return text.split("\n"); }
function lineNoAt(text, idx) { return text.slice(0, idx).split("\n").length; }
function findingId(check, doc, line, key) {
  return crypto.createHash("sha1").update(`${check}|${doc}|${line}|${key}`).digest("hex").slice(0, 10);
}
function mkFinding(check, severity, doc, line, key, message, evidence) {
  return { id: findingId(check, doc, line ?? 0, key), check, severity, doc, line: line ?? null, message, evidence: evidence || "" };
}
function ageDays(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return Math.floor((NOW.getTime() - d.getTime()) / 86400000);
}

// ------------------------------------------------------------ exceptions

const suppressed = [];
const exceptionFindings = []; // failures raised by the exception machinery itself
function exceptionExpired(ex) { return ex.expires && ageDays(ex.expires) > 0; }

function checkExceptionsValid() {
  for (const ex of cfg.pathExceptions || []) {
    if (exceptionExpired(ex)) {
      exceptionFindings.push(mkFinding(2, "FAIL", "(rules config: pathExceptions)", null, `expired-path-exc:${ex.path}`,
        `path exception for ${ex.path} EXPIRED on ${ex.expires} — it no longer suppresses; land the doc or renew the exception on the record`,
        ex.reason || ""));
    }
  }
  for (const ex of cfg.exceptions || []) {
    if (exceptionExpired(ex)) {
      exceptionFindings.push(mkFinding(ex.check === "any" ? 0 : ex.check, "FAIL", "(rules config: exceptions)", null, `expired-exc:${ex.match}`,
        `exception "${ex.match}" EXPIRED on ${ex.expires} — it no longer suppresses`, ex.reason || ""));
    }
  }
}
function pathExceptionFor(p) {
  return (cfg.pathExceptions || []).find(ex => ex.path === p && !exceptionExpired(ex));
}
function generalExceptionFor(f) {
  return (cfg.exceptions || []).find(ex => {
    if (exceptionExpired(ex)) return false;
    if (ex.check !== "any" && ex.check !== f.check) return false;
    if (ex.doc && !globMatch(ex.doc, f.doc)) return false;
    if (ex.match && !(f.message.includes(ex.match) || f.evidence.includes(ex.match) || (f.doc || "").includes(ex.match))) return false;
    return true;
  });
}
function applyExceptions(findings) {
  const kept = [];
  for (const f of findings) {
    const ex = generalExceptionFor(f);
    if (ex) suppressed.push({ ...f, suppressedBy: ex.reason || ex.match, expires: ex.expires });
    else kept.push(f);
  }
  return kept;
}

// ------------------------------------------------------------ GitHub API (check 1 / --prs)

let apiFixture = null;
if (args["api-fixture"]) apiFixture = JSON.parse(fs.readFileSync(path.resolve(args["api-fixture"]), "utf8"));
class RateLimitError extends Error {}
function ghApi(apiPath) {
  let out;
  try {
    out = execFileSync("gh", ["api", apiPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = `${e.stderr || ""} ${e.message || ""}`;
    if (/429|rate limit/i.test(err)) throw new RateLimitError(err.trim().slice(0, 200));
    const notFound = /404|Not Found/.test(err);
    const wrapped = new Error(err.trim().slice(0, 200)); wrapped.notFound = notFound; throw wrapped;
  }
  return JSON.parse(out);
}
function apiStateFor(n) {
  // returns {kind: 'pr'|'issue', state, merged} — cached 15 min in live mode
  if (apiFixture) {
    const rec = apiFixture[String(n)];
    if (!rec) { const e = new Error(`no recorded fixture for #${n}`); e.notFound = true; e.fixtureMiss = true; throw e; }
    return rec;
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `state-${n}.json`);
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (Date.now() - c.fetchedAt < 15 * 60 * 1000) return c.data;
  } catch { /* cold cache */ }
  let data;
  try {
    const pr = ghApi(`repos/${REPO}/pulls/${n}`);
    data = { kind: "pr", state: pr.state, merged: !!pr.merged_at };
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    if (!e.notFound) throw e;
    const issue = ghApi(`repos/${REPO}/issues/${n}`);
    data = { kind: "issue", state: issue.state, merged: false };
  }
  fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), data }));
  return data;
}

// ------------------------------------------------------------ doc set

const normative = resolvePatterns(cfg.normativeDocs || []);
const stampPatterns = [...(cfg.normativeDocs || []), ...(cfg.stampDocsExtra || [])];
const stampSet = resolvePatterns(stampPatterns);
const coverageNotes = [];
if (normative.missing.length) coverageNotes.push(`configured normative docs absent from tree (not linted): ${normative.missing.join(", ")}`);

// ------------------------------------------------------------ check 1 — status claims vs API

function check1() {
  const findings = [];
  const OPENISH = ["in flight", "fix in flight", "pending", "open"];
  const DONEISH = ["landed", "merged", "closed", "shipped"];
  const PHRASES = [...OPENISH.map(p => ({ p, cls: "open" })), ...DONEISH.map(p => ({ p, cls: "done" }))];
  const claims = []; // {n, cls, phrase, doc, line, text}
  for (const doc of normative.files) {
    const text = readRel(doc); if (text == null) continue;
    const lines = linesOf(text);
    lines.forEach((lineText, i) => {
      const lower = lineText.toLowerCase();
      const negatedAt = idx => /\bnot\s+$/.test(lower.slice(Math.max(0, idx - 6), idx));
      for (const { p, cls } of PHRASES) {
        let idx = lower.indexOf(p);
        while (idx !== -1) {
          // phrase followed within 90 chars by a #ref, inside the same
          // clause/table cell (a "|" between phrase and ref breaks the claim),
          // and not negated ("not merged" is not a merged claim)
          if (!negatedAt(idx)) {
            const after = lineText.slice(idx, idx + 90);
            const m = after.match(/#(\d{3,6})\b/);
            if (m && !after.slice(0, m.index).includes("|")) {
              claims.push({ n: +m[1], cls, phrase: p, doc, line: i + 1, text: lineText.trim().slice(0, 200) });
            }
          }
          idx = lower.indexOf(p, idx + p.length);
        }
      }
      // #ref followed within 70 chars by a status phrase ("#3142 merged",
      // "#9004, still in flight"). If another #ref follows the phrase inside
      // the window, the phrase belongs to that ref (the "(fix in flight,
      // PR #3142)" shape) and the forward claim there covers it.
      const refRe = /#(\d{3,6})\b/g; let rm;
      while ((rm = refRe.exec(lineText)) !== null) {
        const window = lineText.slice(rm.index + rm[0].length, rm.index + rm[0].length + 70);
        const wlower = window.toLowerCase();
        for (const { p, cls } of PHRASES) {
          const pm = new RegExp(`\\b${p.replace(/ /g, "\\s+")}\\b`).exec(wlower);
          if (!pm) continue;
          if (/\bnot\s+$/.test(wlower.slice(Math.max(0, pm.index - 6), pm.index))) continue;
          if (/#\d{3,6}\b/.test(window.slice(pm.index + pm[0].length))) continue;
          claims.push({ n: +rm[1], cls, phrase: p, doc, line: i + 1, text: lineText.trim().slice(0, 200) });
        }
      }
    });
  }
  const seen = new Set();
  const uniqClaims = claims.filter(c => { const k = `${c.doc}|${c.line}|${c.n}|${c.cls}`; if (seen.has(k)) return false; seen.add(k); return true; });  let incompleteReason = null;
  for (const c of uniqClaims) {
    let actual;
    try { actual = apiStateFor(c.n); }
    catch (e) {
      if (e instanceof RateLimitError) { incompleteReason = `GitHub API rate limit (429) — fleet-wide stop per standing rules; check UNRUN rather than guessed: ${e.message}`; break; }
      if (e.fixtureMiss) { incompleteReason = `recorded API fixture has no entry for #${c.n}; live state not guessed`; break; }
      findings.push(mkFinding(1, "WARN", c.doc, c.line, `unresolvable:${c.n}`, `status claim about #${c.n} could not be resolved at the API (${e.message})`, c.text));
      continue;
    }
    const actualCls = actual.kind === "pr"
      ? (actual.state === "open" ? "open" : (actual.merged ? "done" : "closed-unmerged"))
      : (actual.state === "open" ? "open" : "done");
    if (actualCls !== c.cls) {
      findings.push(mkFinding(1, "FAIL", c.doc, c.line, `status:${c.n}:${c.cls}!=${actualCls}`,
        `doc claims #${c.n} "${c.phrase}" (${c.cls}) but API state is ${actual.kind} ${actual.state}${actual.kind === "pr" ? (actual.merged ? ", merged" : ", NOT merged") : ""}`,
        c.text));
    }
  }
  if (incompleteReason) return { status: "INCOMPLETE", reason: incompleteReason, findings };
  return { status: "RUN", findings, meta: { claimsChecked: uniqClaims.length } };
}

// ------------------------------------------------------------ check 2 — backticked path existence

function check2() {
  const findings = [];
  let skippedPatterns = 0;
  const seen = new Set();
  for (const doc of normative.files) {
    const text = readRel(doc); if (text == null) continue;
    const lines = linesOf(text);
    lines.forEach((lineText, i) => {
      const re = /`([^`\n]+)`/g; let m;
      while ((m = re.exec(lineText)) !== null) {
        let tok = m[1].trim();
        if (!/^(scripts|server|spec|docs)\//.test(tok)) continue;
        tok = tok.replace(/[:#]\d+(?:-\d+)?$/, "").replace(/\/$/, m2 => m2); // strip :line suffix
        tok = tok.replace(/[.,;:)\]]+$/, "");
        if (/[*<>{}…]|\.\.\./.test(tok)) { skippedPatterns++; continue; }
        const key = `${doc}|${tok}`;
        if (seen.has(key)) continue; seen.add(key);
        if (fs.existsSync(path.join(ROOT, tok))) continue;
        const ex = pathExceptionFor(tok);
        if (ex) { suppressed.push({ ...mkFinding(2, "FAIL", doc, i + 1, `path:${tok}`, `referenced path ${tok} absent from tree`, lineText.trim().slice(0, 200)), suppressedBy: ex.reason, expires: ex.expires }); continue; }
        findings.push(mkFinding(2, "FAIL", doc, i + 1, `path:${tok}`, `referenced path ${tok} does not exist in the tree at base`, lineText.trim().slice(0, 200)));
      }
    });
  }
  return { status: "RUN", findings, meta: { skippedPatternTokens: skippedPatterns } };
}

// ------------------------------------------------------------ check 3 — same-PR update rule

function loadBatch() {
  if (args.batch) {
    const b = JSON.parse(fs.readFileSync(path.resolve(args.batch), "utf8"));
    return b.prs || b;
  }
  if (args.prs) {
    const nums = String(args.prs).split(",").map(s => +s.trim()).filter(Boolean);
    const prs = [];
    for (const n of nums) {
      const pr = ghApi(`repos/${REPO}/pulls/${n}`);
      let files = [];
      try {
        const raw = execFileSync("gh", ["api", `repos/${REPO}/pulls/${n}/files`, "--paginate", "--jq", ".[].filename"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        files = raw.split("\n").map(s => s.trim()).filter(Boolean);
      } catch (e) { if (e instanceof RateLimitError) throw e; throw e; }
      prs.push({ number: n, files, body: pr.body || "" });
    }
    return prs;
  }
  return null;
}
function check3() {
  let prs;
  try { prs = loadBatch(); }
  catch (e) {
    if (e instanceof RateLimitError) return { status: "INCOMPLETE", reason: `GitHub API rate limit (429) while loading batch: ${e.message}`, findings: [] };
    return { status: "INCOMPLETE", reason: `batch could not be loaded: ${e.message}`, findings: [] };
  }
  if (!prs) return { status: "INCOMPLETE", reason: "no landing batch in scope (pass --batch <file> or --prs n,n,n). This check runs at batch close; a tree-only census run cannot execute it.", findings: [] };
  const findings = [];
  for (const pr of prs) {
    const files = pr.files || [];
    const body = pr.body || "";
    const waived = /no-doc-change:\s*\S+/.test(body);
    for (const rule of cfg.companionMap || []) {
      const hit = files.some(f => (rule.surfaces || []).some(g => globMatch(g, f)));
      if (!hit) continue;
      const companionTouched = (rule.docs || []).some(d => files.includes(d));
      if (!companionTouched && !waived) {
        findings.push(mkFinding(3, "FAIL", `PR #${pr.number}`, null, `companion:${rule.name}`,
          `PR touches a mapped surface (${rule.name}) but none of its companion docs (${(rule.docs || []).join(", ")}) is in the PR and the body carries no \`no-doc-change: <reason>\` waiver`,
          files.filter(f => (rule.surfaces || []).some(g => globMatch(g, f))).slice(0, 5).join(", ")));
      }
    }
  }
  return { status: "RUN", findings, meta: { prsChecked: prs.length } };
}

// ------------------------------------------------------------ check 4 — stamp aging

function check4() {
  const findings = [];
  const stampRes = [
    /\bas of (\d{4}-\d{2}-\d{2})/gi,
    /\bgenerated:\s*(\d{4}-\d{2}-\d{2})/gi,
    /\bVersion:[^\n]*?(\d{4}-\d{2}-\d{2})/gi,
  ];
  const statusSet = new Set(cfg.statusDocs || []);
  const staleDays = cfg.statusDocStaleDays ?? 14;
  const latestDays = cfg.latestSectionStaleDays ?? 35;
  for (const doc of stampSet.files) {
    const text = readRel(doc); if (text == null) continue;
    const lines = linesOf(text);
    let section = ""; let sectionLine = 0; let sectionHasStamp = false;
    const flushSection = () => {
      if (/latest/i.test(section) && !sectionHasStamp) {
        findings.push(mkFinding(4, "NOTE", doc, sectionLine, `latest-nostamp:${section}`, `"Latest" section carries no date stamp, so its freshness cannot be checked`, section));
      }
    };
    lines.forEach((lineText, i) => {
      const h = lineText.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flushSection(); section = h[2]; sectionLine = i + 1; sectionHasStamp = false; }
      for (const re of stampRes) {
        re.lastIndex = 0; let m;
        while ((m = re.exec(lineText)) !== null) {
          const date = m[1]; const age = ageDays(date); sectionHasStamp = true;
          if (/latest/i.test(section) && age > latestDays) {
            findings.push(mkFinding(4, "FAIL", doc, i + 1, `latest-stale:${date}:${section}`, `"Latest" section stamp ${date} is ${age} days old at census (limit ${latestDays})`, lineText.trim().slice(0, 200)));
          } else if (statusSet.has(doc) && age > staleDays) {
            findings.push(mkFinding(4, "WARN", doc, i + 1, `stale:${date}`, `status-bearing doc stamp ${date} is ${age} days old at census (limit ${staleDays}) — STALE`, lineText.trim().slice(0, 200)));
          }
        }
      }
    });
    flushSection();
  }
  return { status: "RUN", findings };
}

// ------------------------------------------------------------ check 5 — config claims

function check5() {
  const corpus = []; // {file, text}
  for (const pat of cfg.configFiles || []) {
    const { files } = resolvePatterns([pat]);
    for (const f of files) { const t = readRel(f); if (t != null) corpus.push({ file: f, text: t }); }
  }
  if (!corpus.length) return { status: "INCOMPLETE", reason: "no config files found (wrangler / workflows) in tree", findings: [] };
  const findings = [];
  const seen = new Set();
  for (const doc of normative.files) {
    const text = readRel(doc); if (text == null) continue;
    const lines = linesOf(text);
    lines.forEach((lineText, i) => {
      const re = /`([^`\n]+)`/g; let m;
      while ((m = re.exec(lineText)) !== null) {
        const em = m[1].trim().match(/^([A-Z][A-Z0-9_]{2,})=(\S+)$/);
        if (!em) continue;
        const [, name, value] = em;
        const key = `${doc}|${name}=${value}`;
        if (seen.has(key)) continue; seen.add(key);
        const nameHit = corpus.find(c => c.text.includes(name));
        if (!nameHit) {
          findings.push(mkFinding(5, "FAIL", doc, i + 1, `cfg:${name}`, `doc asserts \`${name}=${value}\` but ${name} appears in no config file (wrangler / workflows)`, lineText.trim().slice(0, 200)));
        } else if (value.length >= 3 && !nameHit.text.includes(value) && !corpus.some(c => c.text.includes(name) && c.text.includes(value))) {
          findings.push(mkFinding(5, "FAIL", doc, i + 1, `cfgval:${name}=${value}`, `doc asserts \`${name}=${value}\`; ${name} exists in config (${nameHit.file}) but the asserted value is not found with it`, lineText.trim().slice(0, 200)));
        }
      }
    });
  }
  return { status: "RUN", findings, meta: { configFilesRead: corpus.map(c => c.file) } };
}

// ------------------------------------------------------------ check 6 — count claims carry a method

function check6() {
  const findings = [];
  const NOUNS = "states?|codes?|tables?|routes?|tools?|jobs?|endpoints?";
  const reA = new RegExp(`\\b(\\d[\\d,]*)\\s+(${NOUNS})\\b`, "gi");
  const reB = new RegExp(`\\b(${NOUNS})\\s*[:=]?\\s*(\\d[\\d,]*)\\b`, "gi");
  for (const doc of normative.files) {
    const text = readRel(doc); if (text == null) continue;
    const paras = text.split(/\n\s*\n/);
    let offset = 0;
    for (const para of paras) {
      const startLine = text.slice(0, offset).split("\n").length;
      offset += para.length + 1;
      if (/counted:\s*\S+/.test(para)) continue;
      const hits = new Set();
      for (const re of [reA, reB]) {
        re.lastIndex = 0; let m;
        while ((m = re.exec(para)) !== null) hits.add(m[0].toLowerCase());
      }
      for (const hit of hits) {
        findings.push(mkFinding(6, "WARN", doc, startLine, `count:${hit}`, `count claim "${hit}" carries no \`counted: <method> @ <base>\` annotation in its paragraph (the count itself is never lint-verified)`, para.trim().slice(0, 160)));
      }
    }
  }
  return { status: "RUN", findings };
}

// ------------------------------------------------------------ check 7 — discovery-source coverage

function normalisePath(p) {
  return p.split("/").map(seg => {
    if (/^\{[^}]*\}$/.test(seg)) return "*";
    if (/^:/.test(seg)) return "*";
    if (/^[A-Z][A-Z0-9_]{1,}$/.test(seg)) return "*";
    if (seg.includes("${")) return "*";
    if (seg === "*") return "*";
    return seg;
  }).join("/");
}
function pathMatches(a, b) {
  const as = a.split("/"), bs = b.split("/");
  if (as.length !== bs.length) return false;
  return as.every((s, i) => s === "*" || bs[i] === "*" || s === bs[i]);
}
function check7() {
  const srcFiles = cfg.discoverySources || [];
  const claims = new Map(); // normalised -> {raw, doc, line}
  for (const src of srcFiles) {
    const rawText = readRel(src);
    if (rawText == null) return { status: "INCOMPLETE", reason: `discovery source ${src} absent from tree`, findings: [] };
    // Strip block comments and full-line // comments: claims live in the
    // served strings, not in the source's own commentary about them.
    // Comments are blanked, not removed, so line numbers stay true.
    const text = rawText
      .replace(/\/\*[\s\S]*?\*\//g, s => s.replace(/[^\n]/g, " "))
      .split("\n").map(l => (/^\s*\/\//.test(l) ? "" : l)).join("\n");
    const re = /\/api\/[A-Za-z0-9_\-./{}$:]+/g; let m;
    while ((m = re.exec(text)) !== null) {
      // A mention inside a denial ("there is no POST /api/bootstrap-agent-room")
      // is the source being honest, not a claim.
      const prefix = text.slice(Math.max(0, m.index - 60), m.index);
      if (/(\bno\s+(post|get|put|patch|delete)\b|\bthere is no\b|\bnot\s+an?\s+(post|get|put|patch|delete)\b)/i.test(prefix)) continue;
      const raw = m[0].replace(/[.,;:`'"”’)\]]+$/, "");
      const norm = normalisePath(raw);
      if (!claims.has(norm)) claims.set(norm, { raw, doc: src, line: lineNoAt(text, m.index) });
    }
  }
  const actuals = new Map(); // normalised -> source description
  const addActual = (raw, srcDesc) => { const n = normalisePath(raw); if (!actuals.has(n)) actuals.set(n, srcDesc); };
  const routesDir = cfg.routeSources?.routeModulesDir || "server/routes";
  for (const abs of walkFiles(path.join(ROOT, routesDir))) {
    const rel = relOf(abs); const text = fs.readFileSync(abs, "utf8");
    for (const re of [/path:\s*`([^`]+)`/g, /path:\s*"([^"]+)"/g, /path:\s*'([^']+)'/g]) {
      let m; while ((m = re.exec(text)) !== null) if (m[1].startsWith("/")) addActual(m[1], rel);
    }
  }
  for (const extra of cfg.routeSources?.extraRouteFiles || []) {
    const text = readRel(extra); if (text == null) continue;
    for (const re of [/route\(\s*"([^"]+)"/g, /path:\s*"([^"]+)"/g, /"(\/api\/[^"]+)"/g, /'(\/api\/[^']+)'/g]) {
      let m; while ((m = re.exec(text)) !== null) if (m[1].startsWith("/")) addActual(m[1], extra);
    }
  }
  const openapiRel = cfg.routeSources?.openapi;
  if (openapiRel) {
    const text = readRel(openapiRel);
    if (text != null) { const re = /^\s{2}(\/[^\s:]+):\s*$/gm; let m; while ((m = re.exec(text)) !== null) addActual(m[1], openapiRel); }
  }
  const findings = [];
  for (const [norm, c] of claims) {
    let ok = false;
    for (const a of actuals.keys()) if (pathMatches(norm, a)) { ok = true; break; }
    if (!ok) findings.push(mkFinding(7, "FAIL", c.doc, c.line, `claim:${norm}`, `discovery source claims route ${c.raw} but no matching route exists in the route table / OpenAPI / legacy chain at base`, ""));
  }
  const unclaimed = [...actuals.keys()].filter(a => a.startsWith("/api/") && ![...claims.keys()].some(c => pathMatches(c, a)));
  if (unclaimed.length) {
    findings.push(mkFinding(7, "NOTE", "(route table / OpenAPI)", null, "unclaimed-summary",
      `${unclaimed.length} routes exist at base but are not claimed by the discovery source (coverage note, not a defect): ${unclaimed.slice(0, 15).join(", ")}${unclaimed.length > 15 ? ", …" : ""}`,
      unclaimed.join("\n")));
  }
  return { status: "RUN", findings, meta: { claimsChecked: claims.size, actualRoutes: actuals.size, unclaimedCount: unclaimed.length, scopeNote: "route leg only (/api/ claims in the discovery source). Tool-name leg and behavioural (journey) claims are NOT lint-verified in v1 — journeys belong to probes (T-13)." } };
}

// ------------------------------------------------------------ run + verdict

checkExceptionsValid();
const results = {};
const runners = { 1: check1, 2: check2, 3: check3, 4: check4, 5: check5, 6: check6, 7: check7 };
for (const n of [1, 2, 3, 4, 5, 6, 7]) {
  try { results[n] = runners[n](); }
  catch (e) { results[n] = { status: "INCOMPLETE", reason: `check errored: ${e.message}`, findings: [] }; }
  results[n].findings = applyExceptions(results[n].findings || []);
}
if (exceptionFindings.length) {
  // expired exceptions surface under their own check number where known
  for (const f of exceptionFindings) {
    const target = results[f.check] && f.check >= 1 ? f.check : 2;
    results[target].findings.push(f);
  }
}

let allFindings = [];
for (const n of [1, 2, 3, 4, 5, 6, 7]) allFindings.push(...results[n].findings);

// triage + FP downgrade
let triageInfo = null;
if (args.triage) {
  const triage = JSON.parse(fs.readFileSync(path.resolve(args.triage), "utf8"));
  let tp = 0, fp = 0; const perCheck = {};
  for (const f of allFindings) {
    const v = triage[f.id];
    if (!v) continue;
    perCheck[f.check] = perCheck[f.check] || { tp: 0, fp: 0 };
    if (v === "fp") { fp++; perCheck[f.check].fp++; } else if (v === "tp") { tp++; perCheck[f.check].tp++; }
    f.triage = v;
  }
  const rate = (tp + fp) ? fp / (tp + fp) : 0;
  triageInfo = { tp, fp, rate, perCheck, degraded: rate > 0.30 && (tp + fp) > 0 };
  if (triageInfo.degraded) {
    for (const f of allFindings) if (f.severity === "FAIL") { f.downgradedFrom = "FAIL"; f.severity = "WARN"; }
  }
}

const incompleteChecks = [1, 2, 3, 4, 5, 6, 7].filter(n => results[n].status === "INCOMPLETE");
const hasFail = allFindings.some(f => f.severity === "FAIL");
const hasWarn = allFindings.some(f => f.severity === "WARN");
let verdict = hasFail ? "FAIL" : (hasWarn ? "WARN" : "PASS");
if (triageInfo?.degraded) verdict = "DEGRADED";

const NAMES = { 1: "status claims vs API", 2: "named-path existence", 3: "same-PR update rule", 4: "stamp aging", 5: "config claims", 6: "count claims carry a method", 7: "discovery-source coverage" };
const out = [];
out.push("DOC-FRESHNESS LINT v1 (F-01)");
out.push(`base: ${BASE_LABEL} · root: ${ROOT} · census date: ${NOW_LABEL} · mode: ${apiFixture ? "recorded API fixture" : "live GitHub API"}`);
for (const note of coverageNotes) out.push(`coverage note: ${note}`);
out.push("");
for (const n of [1, 2, 3, 4, 5, 6, 7]) {
  const r = results[n];
  const counts = {};
  for (const f of r.findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const countStr = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "no findings";
  out.push(`CHECK ${n} — ${NAMES[n]}: ${r.status}${r.status === "INCOMPLETE" ? ` — ${r.reason}` : ` (${countStr})`}`);
  if (r.meta) for (const [k, v] of Object.entries(r.meta)) out.push(`  meta ${k}: ${v}`);
  for (const f of r.findings) {
    out.push(`  ${f.severity} [${f.id}] ${f.doc}${f.line ? `:${f.line}` : ""} — ${f.message}${f.downgradedFrom ? ` (downgraded from ${f.downgradedFrom}: FP rate > 30%)` : ""}${f.triage ? ` [triage: ${f.triage}]` : ""}`);
    if (f.evidence) out.push(`      evidence: ${f.evidence.split("\n")[0].slice(0, 220)}`);
  }
}
if (suppressed.length) {
  out.push("");
  out.push(`SUPPRESSED BY DATED EXCEPTION (${suppressed.length}) — reported, never silent:`);
  for (const f of suppressed) out.push(`  [${f.id}] check ${f.check} ${f.doc}${f.line ? `:${f.line}` : ""} — ${f.message} · exception expires ${f.expires}: ${String(f.suppressedBy).slice(0, 160)}`);
}
if (triageInfo) {
  out.push("");
  out.push(`TRIAGE: ${triageInfo.tp} true-positive, ${triageInfo.fp} false-positive over ${triageInfo.tp + triageInfo.fp} triaged findings — FP rate ${(triageInfo.rate * 100).toFixed(1)}%${triageInfo.degraded ? " — exceeds 30%: all FAILs downgraded to WARN, run is DEGRADED" : ""}`);
}
out.push("");
out.push(`VERDICT: ${verdict}${incompleteChecks.length ? ` (INCOMPLETE checks: ${incompleteChecks.join(", ")})` : ""}`);
console.log(out.join("\n"));

if (args.json) {
  fs.writeFileSync(path.resolve(args.json), JSON.stringify({
    tool: "doc-freshness v1 (F-01)", base: BASE_LABEL, root: ROOT, censusDate: NOW_LABEL,
    mode: apiFixture ? "api-fixture" : "live",
    coverageNotes,
    checks: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map(n => [n, { name: NAMES[n], status: results[n].status, reason: results[n].reason || null, meta: results[n].meta || null, findings: results[n].findings }])),
    suppressed, triage: triageInfo, verdict, incompleteChecks,
  }, null, 2));
}
process.exit((triageInfo?.degraded || incompleteChecks.length) ? 2 : (hasFail ? 1 : 0));
