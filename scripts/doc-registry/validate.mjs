#!/usr/bin/env node
// validate.mjs — doc registry validator (DS-1, Docs Programme).
// Schema check + tree<->registry join dry-run. Zero dependencies.
//
// Usage:
//   node validate.mjs --registry <registry.json> --tree <dir>
//                     [--census <graded.json>] [--overrides <seed-overrides.json>]
//                     [--json <out.json>] [--strict] [--today YYYY-MM-DD]
//
// Exit codes: 0 = structurally sound · 1 = blocking findings
// (schema errors, dangling rows, topic duplicates; --strict also blocks
// on unregistered files and over-cap rows) · 2 = usage error.
// Unregistered/over-cap/past-TTL are REPORTED, not blocking, in v1: the
// seed describes the post-cut target state and is first run against a
// pre-cut tree. DS-2 promotes classes to blocking as the cut lands.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const k = args[i].slice(2);
    opt[k] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
  }
}
if (!opt.registry || !opt.tree) {
  console.error("usage: validate.mjs --registry <file> --tree <dir> [--census <graded.json>] [--overrides <seed-overrides.json>] [--json <out>] [--strict]");
  process.exit(2);
}
const TODAY = opt.today || new Date().toISOString().slice(0, 10);

const reg = JSON.parse(fs.readFileSync(opt.registry, "utf8"));
const treeRoot = path.resolve(opt.tree);

// ---------- glob: ** crosses dirs, * within a segment ----------
function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}
const matchGlob = (glob, p) => globRe(glob).test(p);

// ---------- walk pruning (declared before the tree walk) ----------
// A directory is pruned when an exclusion glob covers everything under
// it, or when workspace-style scope (roots + extra files) cannot reach
// any scoped file beneath it. Without this, validating the workspace
// corpus walks every lane scratch dir and embedded clone on the disk.
const exclusionGlobs = (reg.exclusions || []).map((e) => e.glob);
function excludedDir(rel) {
  return exclusionGlobs.some((g) => {
    const re = globRe(g);
    return re.test(rel) || re.test(rel + "/__probe__");
  });
}
const scopeRootsEarly = (reg.scope && reg.scope.roots) || null;
const extraEarly = new Set((reg.scope && reg.scope.extra_files) || []);
function underRoot(rel) {
  if (!scopeRootsEarly) return true;
  return scopeRootsEarly.some((r) =>
    r === "." ? !rel.includes("/") : rel === r || rel.startsWith(r + "/"));
}
function ancestorOfScoped(rel) {
  if (!scopeRootsEarly) return true;
  for (const r of scopeRootsEarly)
    if (r !== "." && (r === rel || r.startsWith(rel + "/"))) return true;
  for (const f of extraEarly) if (f.startsWith(rel + "/")) return true;
  return false;
}
function prunableDir(rel) {
  if (excludedDir(rel)) return true;
  if (!scopeRootsEarly) return false;
  return !underRoot(rel) && !ancestorOfScoped(rel);
}
function recordableFile(rel) {
  if (!scopeRootsEarly) return true;
  if (extraEarly.has(rel)) return true;
  if (!rel.includes("/")) return scopeRootsEarly.includes(".");
  return underRoot(rel.slice(0, rel.lastIndexOf("/"))) || underRoot(rel);
}

// ---------- tree enumeration ----------
function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    const rel = base ? base + "/" + e.name : e.name;
    if (e.isDirectory()) { if (!prunableDir(rel)) walk(full, rel, out); }
    else if (e.isFile() && recordableFile(rel)) out.set(rel, fs.statSync(full).size);
  }
}
const allFiles = new Map();
walk(treeRoot, "", allFiles);
// Extra-scope files live under directories the walk prunes on purpose
// (excluded embedded clones). Stat them directly; absence stays visible
// to the dangling check.
for (const f of extraEarly) {
  try { allFiles.set(f, fs.statSync(path.join(treeRoot, f)).size); } catch { /* absent */ }
}
// Registered rows under pruned directories (e.g. the pinned archive
// files under the archive/** exclusion) are likewise verified directly:
// the registry asserts them, so existence is checked per assertion.
for (const r of reg.docs || []) {
  const targets = r.kind === "file" && r.existence === "present" ? [r.path]
    : r.kind === "family" && Array.isArray(r.members) ? r.members : [];
  for (const f of targets)
    if (!allFiles.has(f)) {
      try { allFiles.set(f, fs.statSync(path.join(treeRoot, f)).size); } catch { /* absent = dangling */ }
    }
}

const scope = reg.scope || { extensions: [".md", ".txt", ".rst"], extra_files: [] };
const exts = new Set(scope.extensions || []);
const extra = new Set(scope.extra_files || []);
let scoped = [...allFiles.keys()].filter(
  (p) => exts.has(path.posix.extname(p)) || extra.has(p));
if (Array.isArray(scope.roots)) {
  // workspace-style scope: '.' = depth-1 files only; named roots = subtrees
  scoped = scoped.filter((p) => {
    if (extra.has(p)) return true;
    if (!p.includes("/")) return scope.roots.includes(".");
    return scope.roots.some((r) => r !== "." && (p === r || p.startsWith(r + "/")));
  });
}
const tree = new Map(scoped.map((p) => [p, allFiles.get(p)]));

// ---------- schema ----------
const TYPES = ["CONTRACT", "CANONICAL", "RUNBOOK", "GENERATED", "DECISION", "WORKING", "ARCHIVE"];
const STATUSES = ["active", "stale-flagged", "demoted", "retired"];
const EXIST = ["present", "planned", "served"];
const TTL_NULL_OK = new Set(["ARCHIVE", "GENERATED", "DECISION"]);
const schemaErrors = [];
const rows = reg.docs || [];
rows.forEach((r, i) => {
  const id = `row[${i}] ${r.path || "?"}`;
  for (const k of ["path", "kind", "status", "seed_state", "existence"])
    if (!(k in r)) schemaErrors.push(`${id}: missing field ${k}`);
  if (!STATUSES.includes(r.status)) schemaErrors.push(`${id}: bad status ${r.status}`);
  if (!EXIST.includes(r.existence)) schemaErrors.push(`${id}: bad existence ${r.existence}`);
  if (r.seed_state === "UNCLASSIFIED") {
    if (!r.classification_note) schemaErrors.push(`${id}: UNCLASSIFIED without classification_note`);
  } else {
    if (!TYPES.includes(r.type)) schemaErrors.push(`${id}: bad/missing type ${r.type}`);
    if (!r.owner_role) schemaErrors.push(`${id}: classified row without owner_role`);
    if (!TTL_NULL_OK.has(r.type) && !(Number.isInteger(r.ttl_days) && r.ttl_days > 0))
      schemaErrors.push(`${id}: type ${r.type} requires a positive ttl_days`);
  }
  if (r.existence === "planned" && !r.planned_via)
    schemaErrors.push(`${id}: planned row without planned_via`);
  if (r.kind === "family" && (!r.family_id || !r.member_glob))
    schemaErrors.push(`${id}: family row without family_id/member_glob`);
  if (r.exception) {
    if (!r.exception.reason || !/^\d{4}-\d{2}-\d{2}$/.test(r.exception.expires || ""))
      schemaErrors.push(`${id}: malformed exception`);
  }
  if (!Array.isArray(r.audience) || r.audience.length === 0)
    schemaErrors.push(`${id}: audience must be a non-empty array`);
});

// topic uniqueness across active CANONICAL file rows
const topicSeen = new Map(); const topicDups = [];
for (const r of rows) {
  if (r.kind === "file" && r.type === "CANONICAL" && r.status === "active" && r.topic) {
    if (topicSeen.has(r.topic))
      topicDups.push({ topic: r.topic, paths: [topicSeen.get(r.topic), r.path] });
    else topicSeen.set(r.topic, r.path);
  }
}

// ---------- join ----------
const fileRows = new Map(rows.filter((r) => r.kind === "file").map((r) => [r.path, r]));
const famRows = rows.filter((r) => r.kind === "family");
const mirrors = reg.mirrors || [];
const exclusions = (reg.exclusions || []).map((e) => ({ ...e, re: globRe(e.glob) }));

function familyCovers(r, p) {
  if (Array.isArray(r.members) && r.members.includes(p)) return "member";
  const realRoot = !r.path.startsWith("(");
  if (realRoot && !(p === r.path || p.startsWith(r.path.endsWith("/") ? r.path : r.path + "/"))) {
    if (!p.startsWith(r.path)) return null;
  }
  if (matchGlob(r.member_glob, p) || (realRoot && matchGlob(r.path + r.member_glob, p)))
    return "glob";
  return null;
}
function coverage(p) {
  if (fileRows.has(p)) return { by: "row", row: fileRows.get(p) };
  let best = null;
  for (const r of famRows) {
    const how = familyCovers(r, p);
    if (how === "member") return { by: "family-member", row: r };
    if (how === "glob") {
      const score = r.path.startsWith("(") ? 0 : r.path.length;
      if (!best || score > best.score) best = { by: "family-glob", row: r, score };
    }
  }
  if (best) return best;
  for (const m of mirrors)
    if (p.startsWith(m.to_prefix)) return { by: "mirror", row: m };
  for (const e of exclusions) if (e.re.test(p)) return { by: "exclusion", row: e };
  return null;
}

const census = opt.census ? new Map(JSON.parse(fs.readFileSync(opt.census, "utf8")).map((r) => [r.path, r])) : null;
const overrides = opt.overrides
  ? new Map(JSON.parse(fs.readFileSync(opt.overrides, "utf8")).overrides.map((o) => [o.path, o])) : null;
function censusClass(p) {
  if (overrides && overrides.has(p) && overrides.get(p).programme.startsWith("MERGE-SOURCE"))
    return "programme-merge-source (post-census reroute, not seeded)";
  if (!census) return "unregistered";
  const r = census.get(p);
  if (!r) return "not-in-census (new since base, or non-md/txt artefact)";
  const d = r.disposition;
  if (d === "DELETE") return "DELETE class (cut candidate, never seeded)";
  if (d.startsWith("ARCHIVE-OUT")) return "EVICT class (cut candidate, never seeded)";
  if (d.startsWith("MERGE")) return "MERGE class (source, never seeded)";
  if (d.startsWith("KEEP")) return "KEEP-GAP (census keep, no registry row — classification gap)";
  return d;
}

const unregistered = []; let mirrorCovered = 0, excludedCount = 0, familyCovered = 0, rowCovered = 0;
for (const p of tree.keys()) {
  const c = coverage(p);
  if (!c) unregistered.push(p);
  else if (c.by === "row") rowCovered++;
  else if (c.by.startsWith("family")) familyCovered++;
  else if (c.by === "mirror") mirrorCovered++;
  else if (c.by === "exclusion") excludedCount++;
}
const unregByClass = {};
for (const p of unregistered) {
  const k = censusClass(p);
  (unregByClass[k] = unregByClass[k] || []).push(p);
}

// dangling / planned / served
const dangling = [], memberMissing = [], planned = [], served = [];
for (const r of rows) {
  if (r.existence === "planned") { planned.push(r.path); continue; }
  if (r.existence === "served") { served.push(r.path); continue; }
  if (r.kind === "file") {
    if (!allFiles.has(r.path)) dangling.push(r.path);
  } else if (Array.isArray(r.members)) {
    for (const m of r.members) if (!allFiles.has(m)) memberMissing.push(`${r.family_id}: ${m}`);
  }
}

// over-cap + past-TTL
const overcap = [], familyOvercap = [], pastTtl = [];
const now = Date.parse((reg.seeded_at || TODAY) + "T00:00:00Z");
for (const r of rows) {
  if (r.existence !== "present") continue;
  if (r.kind === "file" && r.size_cap_bytes != null && allFiles.has(r.path)) {
    const s = allFiles.get(r.path);
    if (s > r.size_cap_bytes)
      overcap.push({ path: r.path, size: s, cap: r.size_cap_bytes, ratio: +(s / r.size_cap_bytes).toFixed(1) });
  }
  if (r.kind === "family" && Array.isArray(r.members) && r.budget_bytes != null) {
    const total = r.members.reduce((a, m) => a + (allFiles.get(m) || 0), 0);
    if (total > r.budget_bytes)
      familyOvercap.push({ family: r.family_id, total, budget: r.budget_bytes });
  }
  if (r.ttl_days && r.last_reviewed) {
    const due = Date.parse(r.last_reviewed + "T00:00:00Z") + r.ttl_days * 864e5;
    if (due < now) pastTtl.push({ path: r.path, type: r.type, last_reviewed: r.last_reviewed, ttl_days: r.ttl_days });
  }
}
const expiredExceptions = rows.filter((r) => r.exception && r.exception.expires < TODAY)
  .map((r) => ({ path: r.path, expires: r.exception.expires }));

// ---------- report ----------
const byType = {}, byKind = {};
for (const r of rows) {
  byType[r.type || "UNCLASSIFIED"] = (byType[r.type || "UNCLASSIFIED"] || 0) + 1;
  byKind[r.kind] = (byKind[r.kind] || 0) + 1;
}
const summary = {
  registry: opt.registry, corpus: reg.corpus, tree: opt.tree, today: TODAY,
  rows: rows.length, byKind, byType,
  unclassified: rows.filter((r) => r.seed_state === "UNCLASSIFIED").length,
  treeFilesInScope: tree.size,
  covered: { row: rowCovered, family: familyCovered, mirror: mirrorCovered, exclusion: excludedCount },
  unregistered: unregistered.length,
  unregisteredByClass: Object.fromEntries(Object.entries(unregByClass).map(([k, v]) => [k, v.length])),
  dangling: dangling.length, familyMembersMissing: memberMissing.length,
  planned: planned.length, served: served.length,
  topicDuplicates: topicDups.length, schemaErrors: schemaErrors.length,
  overcap: overcap.length, familyOvercap: familyOvercap.length,
  pastTtl: pastTtl.length, expiredExceptions: expiredExceptions.length,
};
const blocking = schemaErrors.length + dangling.length + memberMissing.length + topicDups.length +
  (opt.strict ? unregistered.length + overcap.length : 0);

console.log(`== doc-registry validation — corpus ${reg.corpus} — ${TODAY}`);
console.log(`registry rows: ${rows.length} (${byKind.file || 0} file, ${byKind.family || 0} family) · by type: ${JSON.stringify(byType)}`);
console.log(`tree files in scope: ${tree.size} · covered: row ${rowCovered} · family ${familyCovered} · mirror ${mirrorCovered} · exclusion ${excludedCount}`);
console.log(`UNREGISTERED: ${unregistered.length}`);
for (const [k, v] of Object.entries(unregByClass)) console.log(`  ${v.length}\t${k}`);
console.log(`DANGLING rows: ${dangling.length}${dangling.length ? " — " + dangling.join(", ") : ""}`);
console.log(`family members missing: ${memberMissing.length}${memberMissing.length ? " — " + memberMissing.join(", ") : ""}`);
console.log(`planned rows: ${planned.length} · served rows: ${served.length}`);
console.log(`topic duplicates: ${topicDups.length}${topicDups.length ? " — " + JSON.stringify(topicDups) : ""}`);
console.log(`schema errors: ${schemaErrors.length}${schemaErrors.length ? "\n  " + schemaErrors.join("\n  ") : ""}`);
console.log(`over-cap rows: ${overcap.length}`);
for (const o of overcap) console.log(`  ${o.path} — ${o.size} B vs cap ${o.cap} (${o.ratio}x)`);
console.log(`family over-budget: ${familyOvercap.length}${familyOvercap.length ? " — " + JSON.stringify(familyOvercap) : ""}`);
console.log(`past-TTL rows (at seed date): ${pastTtl.length}`);
console.log(`expired exceptions: ${expiredExceptions.length}`);
console.log(blocking ? `RESULT: FAIL (${blocking} blocking findings)` : "RESULT: structurally sound (exit 0); findings above are reported, not blocking, in v1");

if (opt.json) {
  fs.writeFileSync(opt.json, JSON.stringify(
    { summary, unregistered, unregisteredByClass: unregByClass, dangling,
      memberMissing, planned, served, topicDups, schemaErrors, overcap,
      familyOvercap, pastTtl, expiredExceptions }, null, 1));
}
process.exit(blocking ? 1 : 0);
