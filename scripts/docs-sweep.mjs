#!/usr/bin/env node
// docs-sweep.mjs — the docs gate: ONE runnable command over the registry
// validator (DS-1) and the F-01 doc-freshness lint, with the governance
// FLAG -> DEMOTE -> DELETE ladder and the promotion table wired in.
// (DS-2, Docs Programme; spec: docs-programme §3.3 + automation §§1-3.)
//
//   node docs-sweep.mjs --registry <registry.json> --tree <dir>
//       [--census <graded.json>] [--overrides <seed-overrides.json>]
//       [--freshness-root <repo checkout>] [--base <label>]
//       [--prs 4114,4123] [--now YYYY-MM-DD] [--triage <triage.json>]
//       [--state-dir <dir>] [--no-state] [--json <out>] [--summary <out>]
//
// Corpus is read from the registry itself. The F-01 leg (check 9) runs
// only for the repo corpus — its normative set is the repo's docs; for the
// workspace corpus check 9 reports NOT-APPLICABLE. For the repo corpus an
// UNRUN F-01 makes the run INCOMPLETE (exit 2), never silently green.
//
// Check classes and severities are DATA: docs-sweep-promotion.json names
// each class advisory or blocking (per-corpus overrides allowed) with its
// evidence and promotion trigger. Blocking findings print REQUIRED and
// drive exit 1. The promotion guard: with --triage, a blocking class
// whose FP rate this run exceeds 30% is demoted for that run (DEGRADED,
// exit 2) — F-01's downgrade rule generalised to every class.
//
// The ladder (governance §3.3): one cadence cycle per step. A finding's
// rung is its consecutive-run persistence in the sweep state
// (fleet-tools/state/docs-sweep/<corpus>.json): 1st run FLAG, 2nd DEMOTE,
// 3rd+ DELETE-CANDIDATE. Per-path worst rungs are exported to
// demotions-<corpus>.json, which gen-doc-index consumes: DEMOTE strips a
// doc out of the index's trust sections; DELETE-CANDIDATE omits it.
// The sweep never deletes anything; DELETE-CANDIDATE names candidates
// for the next landing batch's evidence pass. State updates are
// idempotent per (corpus, date, base): re-running the same census with a
// triage file replaces that run's record instead of double-counting it.
//
// Exit codes: 0 = no blocking findings, run complete · 1 = blocking
// findings · 2 = INCOMPLETE (a leg did not run) or DEGRADED (FP guard
// fired, or F-01 reported DEGRADED/INCOMPLETE).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VALIDATE = path.join(HERE, "doc-registry", "validate.mjs");
const FRESHNESS = path.join(HERE, "doc-freshness", "doc-freshness.mjs");
const PROMOTION_PATH = process.env.DOCS_SWEEP_PROMOTION
  ? path.resolve(process.env.DOCS_SWEEP_PROMOTION)
  : path.join(HERE, "docs-sweep-promotion.json");
const DEFAULT_STATE_DIR = path.join(HERE, "state", "docs-sweep");

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")) args[k] = process.argv[++i];
    else args[k] = true;
  }
}
if (!args.registry || !args.tree) {
  console.error("usage: docs-sweep.mjs --registry <registry.json> --tree <dir> [--census f] [--overrides f] [--freshness-root dir] [--base label] [--prs n,n] [--now YYYY-MM-DD] [--triage f] [--state-dir dir] [--no-state] [--json out] [--summary out]");
  process.exit(2);
}
const NOW = args.now || new Date().toISOString().slice(0, 10);
const registryPath = path.resolve(args.registry);
const tree = path.resolve(args.tree);
const reg = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const corpus = reg.corpus || "unknown";
const promotion = JSON.parse(fs.readFileSync(PROMOTION_PATH, "utf8"));
const FP_THRESHOLD = promotion.fp_threshold ?? 0.30;
const stateDir = args["state-dir"] ? path.resolve(args["state-dir"]) : DEFAULT_STATE_DIR;
const useState = !args["no-state"];
fs.mkdirSync(stateDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(stateDir, ".tmp-"));

let base = args.base || null;
if (!base && corpus === "repo") {
  try { base = execFileSync("git", ["-C", tree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { base = reg.reconciled_at_base || "(unknown base)"; }
}
if (!base) base = `workspace@${NOW}`;

function spawnJson(cmd, cmdArgs) {
  try {
    execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0 };
  } catch (e) { return { code: e.status ?? 1, stderr: String(e.stderr || e.message || "") }; }
}

// ---------- triage ----------
const triage = args.triage ? JSON.parse(fs.readFileSync(path.resolve(args.triage), "utf8")) : null;

// ---------- leg 1: registry validator ----------
const valOut = path.join(tmpDir, "validate.json");
const valArgs = [VALIDATE, "--registry", registryPath, "--tree", tree, "--json", valOut, "--today", NOW];
if (args.census) valArgs.push("--census", path.resolve(args.census));
if (args.overrides) valArgs.push("--overrides", path.resolve(args.overrides));
const valRun = spawnJson("node", valArgs);
let val = null, valError = null;
if (valRun.code === 2 || !fs.existsSync(valOut)) valError = `validator failed (exit ${valRun.code}): ${(valRun.stderr || "").slice(0, 300)}`;
else val = JSON.parse(fs.readFileSync(valOut, "utf8"));

// ---------- leg 2: F-01 (repo corpus only) ----------
let f01 = null, f01Error = null, f01Applicable = corpus === "repo";
if (f01Applicable) {
  const root = args["freshness-root"] ? path.resolve(args["freshness-root"]) : tree;
  const f01Out = path.join(tmpDir, "freshness.json");
  const f01Args = [FRESHNESS, "--root", root, "--base", base, "--now", NOW, "--json", f01Out,
    "--cache-dir", path.join(stateDir, "f01-cache")];
  if (args.prs) f01Args.push("--prs", args.prs);
  if (triage) {
    const sub = {};
    for (const [k, v] of Object.entries(triage)) {
      const m = k.match(/^freshness\.\d+:(.+)$/);
      if (m) sub[m[1]] = v;
    }
    if (Object.keys(sub).length) {
      const subPath = path.join(tmpDir, "f01-triage.json");
      fs.writeFileSync(subPath, JSON.stringify(sub));
      f01Args.push("--triage", subPath);
    }
  }
  const r = spawnJson("node", f01Args);
  if (!fs.existsSync(f01Out)) f01Error = `F-01 produced no run record (exit ${r.code}): ${(r.stderr || "").slice(0, 300)}`;
  else f01 = JSON.parse(fs.readFileSync(f01Out, "utf8"));
}

// ---------- findings ----------
const findings = [];   // {id, class, check, path, evidence, f01Severity?}
const suppressed = []; // {id, class, path, evidence, by}
const rowPaths = new Set((reg.docs || []).map((r) => r.path));
const liveException = new Map();
for (const r of reg.docs || []) {
  if (r.exception && r.exception.expires >= NOW) liveException.set(r.path, r.exception);
}
function add(cls, check, subjectPath, evidence, extra = {}) {
  findings.push({ id: `${cls}:${subjectPath}${extra.idSuffix || ""}`, class: cls, check, path: subjectPath, evidence, ...extra });
}
if (val) {
  for (const e of val.schemaErrors) {
    const m = e.match(/(\S+\.(?:md|txt|rst|json|yaml))/);
    add("registry.schema-errors", "R1", m ? m[1] : "(registry)", e, { idSuffix: `:${findings.length}` });
  }
  for (const p of val.dangling) add("registry.dangling", "R2", p, "registry row exists, file absent from tree");
  for (const mm of val.memberMissing) {
    const member = mm.split(": ").slice(1).join(": ");
    add("registry.dangling", "R2", member || mm, `family member missing — ${mm}`);
  }
  for (const d of val.topicDups) for (const p of d.paths) add("registry.topic-duplicates", "R3", p, `topic "${d.topic}" also owned by ${d.paths.find((x) => x !== p)}`);
  for (const [cls, paths] of Object.entries(val.unregisteredByClass || {})) {
    for (const p of paths) add("registry.unregistered", "R4", p, `unregistered file — census class: ${cls}`);
  }
  if (!val.unregisteredByClass && val.unregistered) {
    for (const p of val.unregistered) add("registry.unregistered", "R4", p, "unregistered file");
  }
  for (const o of val.overcap) {
    const f = { cls: "registry.over-cap", path: o.path, evidence: `${o.size} B vs cap ${o.cap} (${o.ratio}x)` };
    if (liveException.has(o.path)) suppressed.push({ id: `registry.over-cap:${o.path}`, ...f, by: `registry exception until ${liveException.get(o.path).expires}: ${liveException.get(o.path).reason}` });
    else add("registry.over-cap", "R5", o.path, f.evidence);
  }
  for (const f of val.familyOvercap || []) add("registry.over-cap", "R5", f.family, `family total ${f.total} B vs budget ${f.budget}`);
  for (const t of val.pastTtl) add("registry.past-ttl", "R6", t.path, `last_reviewed ${t.last_reviewed} + ttl ${t.ttl_days} d < seed date`);
  for (const e of val.expiredExceptions) add("registry.expired-exceptions", "R7", e.path, `exception expired ${e.expires}`);
}
let dedupedTtl = 0;
if (f01) {
  const NAMES = { 1: "status claims vs API", 2: "named-path existence", 3: "same-PR update rule", 4: "stamp aging", 5: "config claims", 6: "count claims carry a method", 7: "discovery-source coverage" };
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    const chk = f01.checks?.[n];
    if (!chk) continue;
    for (const f of chk.findings || []) {
      findings.push({
        id: `freshness.${n}:${f.id}`, class: `freshness.${n}`, check: `9.${n}`,
        path: f.doc, evidence: `${f.message}${f.line ? ` (line ${f.line})` : ""}`,
        f01Severity: f.severity, f01Name: NAMES[n],
      });
    }
  }
  for (const s of f01.suppressed || []) {
    suppressed.push({ id: `freshness.${s.check}:${s.id}`, class: `freshness.${s.check}`, path: s.doc, evidence: s.message, by: `F-01 exception until ${s.expires}` });
  }
  // automation S1.2 check-3 dedupe: the sweep's TTL line for a path yields
  // to F-01 check 4's aging line for the same path.
  const f4paths = new Set((f01.checks?.[4]?.findings || []).map((f) => f.doc));
  for (let i = findings.length - 1; i >= 0; i--) {
    if (findings[i].class === "registry.past-ttl" && f4paths.has(findings[i].path)) { findings.splice(i, 1); dedupedTtl++; }
  }
}

// ---------- modes, FP guard ----------
function classEntry(cls) {
  const classes = promotion.classes || {};
  if (classes[cls]) return classes[cls];
  // tolerate long keys ("freshness.1-status-claims") — the short class id
  // is the join key for findings, triage, and state, so resolve by prefix
  const hit = Object.keys(classes).find((k) => k.startsWith(cls + "-"));
  return hit ? classes[hit] : null;
}
function classMode(cls) {
  const c = classEntry(cls);
  if (!c) return "advisory";
  if (c.mode_by_corpus && c.mode_by_corpus[corpus]) return c.mode_by_corpus[corpus];
  return c.mode || "advisory";
}
const degradedClasses = [];
const classFp = {};
if (triage) {
  const per = {};
  for (const f of findings) {
    const v = triage[f.id];
    if (!v) continue;
    per[f.class] = per[f.class] || { tp: 0, fp: 0 };
    if (v === "fp") per[f.class].fp++; else if (v === "tp") per[f.class].tp++;
  }
  for (const [cls, c] of Object.entries(per)) {
    const rate = c.fp / (c.tp + c.fp);
    classFp[cls] = { ...c, rate: +rate.toFixed(3) };
    if (classMode(cls) === "blocking" && rate > FP_THRESHOLD) degradedClasses.push(cls);
  }
}
function severityOf(f) {
  const mode = classMode(f.class);
  if (degradedClasses.includes(f.class)) return "ACTION";
  if (f.class.startsWith("freshness.")) {
    if (f.f01Severity === "NOTE") return "NOTE";
    if (f.f01Severity === "FAIL") return mode === "blocking" ? "REQUIRED" : "ACTION";
    return "ACTION"; // WARN
  }
  return mode === "blocking" ? "REQUIRED" : "ACTION";
}
for (const f of findings) f.severity = severityOf(f);

// ---------- ladder ----------
const statePath = path.join(stateDir, `${corpus}.json`);
let state = { version: 1, corpus, runs: [] };
if (useState && fs.existsSync(statePath)) {
  try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { /* fresh state */ }
}
const runKey = `${corpus}|${NOW}|${base}`;
const currentIds = findings.map((f) => f.id);
let ladder = {};
if (useState) {
  state.runs = state.runs.filter((r) => r.key !== runKey);
  state.runs.push({ key: runKey, at: NOW, base, finding_ids: currentIds });
  state.runs.sort((a, b) => (a.at < b.at ? -1 : 1));
  for (const f of findings) {
    let streak = 0;
    for (let i = state.runs.length - 1; i >= 0; i--) {
      if (state.runs[i].finding_ids.includes(f.id)) streak++;
      else break;
    }
    const rung = streak >= 3 ? "DELETE-CANDIDATE" : streak === 2 ? "DEMOTE" : "FLAG";
    ladder[f.id] = { consecutive: streak, rung, first_seen: state.runs[state.runs.length - streak]?.at || NOW };
    f.rung = rung;
  }
  state.ladder = ladder;
  state.updated_at = NOW;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
  // demotions export for gen-doc-index (registered row paths only)
  const dem = {};
  for (const f of findings) {
    if (!f.rung || f.rung === "FLAG") continue;
    if (!rowPaths.has(f.path)) continue;
    if (!dem[f.path] || f.rung === "DELETE-CANDIDATE") dem[f.path] = f.rung;
  }
  fs.writeFileSync(path.join(stateDir, `demotions-${corpus}.json`),
    JSON.stringify({ corpus, at: NOW, base, paths: dem }, null, 1));
}

// ---------- verdict ----------
const incomplete = [];
if (valError) incomplete.push(`registry validator — ${valError}`);
if (f01Applicable) {
  if (f01Error) incomplete.push(`9. F-01 doc-freshness — ${f01Error}`);
  else if (f01.incompleteChecks?.length) incomplete.push(`9. F-01 checks INCOMPLETE: ${f01.incompleteChecks.join(", ")}`);
}
const degraded = [...degradedClasses];
if (f01 && f01.verdict === "DEGRADED") degraded.push("freshness (F-01 aggregate)");
const required = findings.filter((f) => f.severity === "REQUIRED");
const exit = (incomplete.length || degraded.length) ? 2 : required.length ? 1 : 0;
const verdict = incomplete.length ? "INCOMPLETE" : degraded.length ? "DEGRADED" : required.length ? "FAIL" : "PASS";

// ---------- output ----------
const CHECK_TITLES = {
  R1: "registry schema errors", R2: "dangling registry (rows + family members)",
  R3: "topic duplicates", R4: "unregistered docs", R5: "oversize vs budget",
  R6: "TTL expired (registry clock)", R7: "expired registry exceptions",
};
const out = [];
out.push(`DOCS SWEEP — ${corpus} corpus @ ${base} (census mode, registry ${path.basename(registryPath)}, ${NOW})`);
const checksOrder = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "9.1", "9.2", "9.3", "9.4", "9.5", "9.6", "9.7"];
for (const chk of checksOrder) {
  const fs_ = findings.filter((f) => f.check === chk);
  const cls = fs_[0]?.class || (chk.startsWith("9.") ? `freshness.${chk.slice(2)}` : null);
  if (chk.startsWith("9.")) {
    if (!f01Applicable) { out.push(`9.${chk.slice(2)} [N/A] F-01 — repo-corpus leg, not applicable to the ${corpus} corpus`); continue; }
    if (f01Error) { out.push(`9.${chk.slice(2)} [UNRUN] F-01 — ${f01Error}`); continue; }
    const f01chk = f01.checks?.[chk.slice(2)];
    if (f01chk?.status === "INCOMPLETE") { out.push(`9.${chk.slice(2)} [UNRUN] ${f01chk.name || ""} — ${f01chk.reason}`); continue; }
  }
  if (chk.startsWith("R") && valError) { out.push(`${chk} [UNRUN] ${CHECK_TITLES[chk]} — validator failed`); continue; }
  if (!fs_.length) { out.push(`${chk} [OK] ${CHECK_TITLES[chk] || fs_[0]?.f01Name || ""} (0)`); continue; }
  const worst = fs_.some((f) => f.severity === "REQUIRED") ? "REQUIRED" : fs_.every((f) => f.severity === "NOTE") ? "NOTE" : "ACTION";
  const modeNote = cls ? ` · class ${cls}: ${classMode(cls)}${degradedClasses.includes(cls) ? " — DEMOTED this run by the FP guard" : ""}` : "";
  out.push(`${chk} [${worst}] ${CHECK_TITLES[chk] || fs_[0].f01Name || ""} (${fs_.length})${modeNote}`);
  for (const f of fs_) out.push(`   - [${f.severity}] ${f.path} — ${f.evidence}${f.rung ? ` · ladder: ${f.rung}` : ""} · ${f.id}`);
}
if (suppressed.length) {
  out.push(`SUPPRESSED BY DATED EXCEPTION (${suppressed.length}) — reported, never silent:`);
  for (const s of suppressed) out.push(`   - ${s.path} — ${s.evidence} · ${s.by}`);
}
if (dedupedTtl) out.push(`deduped: ${dedupedTtl} registry TTL line(s) yielded to F-01 check 4 for the same path`);
if (triage) {
  out.push("FP GUARD (per class, this run's triage): " +
    (Object.keys(classFp).length
      ? Object.entries(classFp).map(([c, v]) => `${c}: ${(v.rate * 100).toFixed(1)}% FP (${v.fp}/${v.tp + v.fp})`).join(" · ")
      : "no triaged findings"));
} else out.push("FP GUARD: not evaluated (no --triage file)");
const ladderMoves = findings.filter((f) => f.rung && f.rung !== "FLAG");
if (ladderMoves.length) {
  out.push("LADDER MOVES this run:");
  for (const f of ladderMoves) out.push(`   - ${f.rung} ${f.path} (${f.class}, ${ladder[f.id].consecutive} consecutive runs)`);
}
out.push(`VERDICT: ${verdict}${required.length ? ` — ${required.length} REQUIRED finding(s)` : ""}${incomplete.length ? ` — incomplete: ${incomplete.join("; ")}` : ""}${degraded.length ? ` — degraded classes: ${degraded.join(", ")}` : ""}`);
console.log(out.join("\n"));

if (args.json) {
  fs.writeFileSync(path.resolve(args.json), JSON.stringify({
    tool: "docs-sweep (DS-2)", corpus, base, at: NOW, mode: "census",
    registry: registryPath, tree,
    checks: checksOrder.map((chk) => ({
      id: chk, title: CHECK_TITLES[chk] || null,
      class: findings.find((f) => f.check === chk)?.class || null,
      mode: findings.find((f) => f.check === chk) ? classMode(findings.find((f) => f.check === chk).class) : null,
      findings: findings.filter((f) => f.check === chk),
    })),
    suppressed, classFp, degraded, incomplete, verdict,
    totals: {
      findings: findings.length, required: required.length,
      action: findings.filter((f) => f.severity === "ACTION").length,
      note: findings.filter((f) => f.severity === "NOTE").length,
      suppressed: suppressed.length,
    },
    validatorSummary: val?.summary || null,
    f01: f01 ? { verdict: f01.verdict, incompleteChecks: f01.incompleteChecks, triage: f01.triage } : null,
  }, null, 1));
}
if (args.summary) {
  const s = [];
  s.push(`## Docs sweep — ${corpus} @ ${base} (${NOW})`);
  s.push(`Verdict: **${verdict}** · findings ${findings.length} (REQUIRED ${required.length}) · suppressed ${suppressed.length} · ladder moves ${ladderMoves.length}`);
  for (const chk of checksOrder) {
    const fs_ = findings.filter((f) => f.check === chk);
    if (fs_.length) {
      const sevCounts = {};
      for (const f of fs_) sevCounts[f.severity] = (sevCounts[f.severity] || 0) + 1;
      const sevStr = Object.entries(sevCounts).map(([k, v]) => `${v} ${k}`).join(", ");
      s.push(`- ${chk} ${CHECK_TITLES[chk] || fs_[0].f01Name || ""}: ${fs_.length} (${sevStr})`);
    }
  }
  if (incomplete.length) s.push(`- INCOMPLETE: ${incomplete.join("; ")}`);
  if (degraded.length) s.push(`- DEGRADED: ${degraded.join(", ")}`);
  fs.writeFileSync(path.resolve(args.summary), s.join("\n") + "\n");
}
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(exit);
