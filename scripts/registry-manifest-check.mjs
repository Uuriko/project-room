#!/usr/bin/env node
/**
 * scripts/registry-manifest-check.mjs
 *
 * Registry-of-registries gate (F-26 + F-28, under #3673).
 *
 * Two halves, both mechanical:
 *
 * 1. Meta-census. Walk the tree and find every registry-shaped artefact
 *    (filename-token heuristic + JSON content heuristic, the battery-gamma
 *    section 2.2 method). Every hit must be covered by
 *    scripts/registry-manifest.json: as a registry row's artefact or
 *    closure check, as a gate row's artefact, as a named as-read entry, or
 *    by a named census exception. A new registry born unregistered fails
 *    CI here. Every workflow file must likewise be a gate row.
 *
 * 2. Per-family closure for the registries atlas-8/battery-gamma classed
 *    HAND-OPEN (R2, R13, R14, R17, R18, R19, R23, R26, R28, R31, R32, R33)
 *    plus the A8 allowlist contract. Each family check diffs the registry
 *    against the live set it claims to enumerate; named exceptions live
 *    in the manifest row itself, never in this script, and a stale
 *    exception (one that names something no longer live) also fails.
 *
 * Dependency-free (node builtins only), read-only, no network.
 * Usage: node scripts/registry-manifest-check.mjs [root]
 * Exit 0 = manifest complete and every family closure holds.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MANIFEST_PATH = "scripts/registry-manifest.json";
const SKIP_DIRS = new Set([".git", "node_modules", "archive"]);

export function walkFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return out.sort();
}

export function stringLeaves(value) {
  if (typeof value === "string") return 1;
  if (Array.isArray(value)) return value.reduce((n, v) => n + stringLeaves(v), 0);
  if (value && typeof value === "object") return Object.values(value).reduce((n, v) => n + stringLeaves(v), 0);
  return 0;
}

export function loadManifest(root) {
  return JSON.parse(readFileSync(join(root, MANIFEST_PATH), "utf8"));
}

function filenameTokens(name) {
  return basename(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function exceptionMatches(path, exceptions) {
  return exceptions.find((ex) =>
    (ex.path && ex.path === path) ||
    (ex.prefix && path.startsWith(ex.prefix)) ||
    (ex.suffix && path.endsWith(ex.suffix)));
}

/** The meta-census: every registry-shaped file, and whether the manifest covers it. */
export function metaCensus(root, manifest, files = walkFiles(root)) {
  const covered = new Set();
  for (const row of manifest.registries ?? []) {
    for (const p of [...(row.artefacts ?? []), ...(row.closureChecks ?? [])]) covered.add(p);
  }
  for (const gate of manifest.gates ?? []) for (const p of gate.artefacts ?? []) covered.add(p);
  for (const entry of manifest.asRead ?? []) covered.add(entry.path);
  covered.add(MANIFEST_PATH);

  const tokens = new Set(manifest.metaCensus?.filenameTokens ?? []);
  const exceptions = manifest.metaCensus?.exceptions ?? [];
  const hits = [];
  const uncovered = [];
  for (const path of files) {
    let via = null;
    if (filenameTokens(path).some((t) => tokens.has(t))) via = "filename";
    if (!via && path.endsWith(".json") && !exceptionMatches(path, exceptions) && !covered.has(path)) {
      try {
        const parsed = JSON.parse(readFileSync(join(root, path), "utf8"));
        if (stringLeaves(parsed) >= 10) via = "content";
      } catch { /* not JSON content; the filename heuristic already had its chance */ }
    }
    if (!via) continue;
    hits.push({ path, via });
    if (!covered.has(path) && !exceptionMatches(path, exceptions)) uncovered.push({ path, via });
  }
  return { hits, uncovered, covered };
}

/** Shape, existence, census, and gate-set checks over the manifest itself. */
export function checkManifest(root, manifest, files = walkFiles(root)) {
  const problems = [];
  const fileSet = new Set(files);
  if (manifest.version !== 1) problems.push(`manifest version must be 1, got ${manifest.version}`);

  const seenIds = new Set();
  for (const row of manifest.registries ?? []) {
    if (!row.id || seenIds.has(row.id)) problems.push(`registry row with missing/duplicate id: ${row.id ?? "?"}`);
    seenIds.add(row.id);
    for (const field of ["name", "family", "enumerates", "sourceOfTruth", "closureStatus", "canary", "lastFailure"]) {
      if (typeof row[field] !== "string" || !row[field].trim()) problems.push(`${row.id}: missing/empty "${field}" (every gate row carries canary + last-failure, F-28)`);
    }
    if (!Array.isArray(row.artefacts) || row.artefacts.length === 0) problems.push(`${row.id}: artefacts must be a non-empty list`);
    if (!Array.isArray(row.closureChecks) || row.closureChecks.length === 0) problems.push(`${row.id}: closureChecks must be a non-empty list`);
    for (const p of [...(row.artefacts ?? []), ...(row.closureChecks ?? [])]) {
      if (!fileSet.has(p)) problems.push(`${row.id}: named path does not exist in tree: ${p}`);
    }
  }
  const gateIds = new Set();
  for (const gate of manifest.gates ?? []) {
    if (!gate.id || gateIds.has(gate.id)) problems.push(`gate row with missing/duplicate id: ${gate.id ?? "?"}`);
    gateIds.add(gate.id);
    for (const field of ["name", "canary", "lastFailure"]) {
      if (typeof gate[field] !== "string" || !gate[field].trim()) problems.push(`gate ${gate.id}: missing/empty "${field}" (F-28)`);
    }
    for (const p of gate.artefacts ?? []) if (!fileSet.has(p)) problems.push(`gate ${gate.id}: named path does not exist in tree: ${p}`);
  }
  for (const entry of manifest.asRead ?? []) {
    if (!entry.path || !entry.reason) problems.push(`asRead entry missing path or reason: ${entry.path ?? "?"}`);
    else if (!fileSet.has(entry.path)) problems.push(`asRead path does not exist in tree: ${entry.path}`);
  }

  // Gate-set diff: every workflow file is a gate row, and vice versa.
  const gateArtefacts = new Set((manifest.gates ?? []).flatMap((g) => g.artefacts ?? []));
  for (const path of files) {
    if (path.startsWith(".github/workflows/") && /\.(yml|yaml)$/.test(path) && !gateArtefacts.has(path)) {
      problems.push(`workflow is not a gate row in the manifest: ${path}`);
    }
  }

  const { hits, uncovered } = metaCensus(root, manifest, files);
  for (const hit of uncovered) {
    problems.push(`unregistered registry-shaped artefact (${hit.via} census): ${hit.path} - add a manifest row, name it in a row, or record it in asRead with a reason`);
  }
  return { problems, census: { filesWalked: files.length, shapeHits: hits.length, uncovered: uncovered.length } };
}

// ---------------------------------------------------------------------------
// Per-family closure checks for the HAND-OPEN registries (C-4, worst first).
// Each returns a list of problem strings; an absent family artefact means
// the family is not present in this tree and the existence check above has
// already reported the manifest row that names it.
// ---------------------------------------------------------------------------

function readIf(root, path) {
  const full = join(root, path);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

/** Balanced-paren CREATE TABLE scan over server/**. Returns Map name -> body. */
export function ddlTables(root, files) {
  const tables = new Map();
  for (const path of files) {
    if (!path.startsWith("server/") || !path.endsWith(".mjs")) continue;
    const src = readFileSync(join(root, path), "utf8");
    const re = /CREATE TABLE(?: IF NOT EXISTS)?\s+([A-Za-z0-9_]+)\s*\(/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      let depth = 0;
      let i = re.lastIndex - 1;
      const start = i;
      for (; i < src.length; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") { depth--; if (depth === 0) break; }
      }
      if (!tables.has(m[1])) tables.set(m[1], src.slice(start + 1, i));
      re.lastIndex = i;
    }
  }
  return tables;
}

const KEYED_COLUMNS = /\b(room_id|account_id|identity_id)\b/;

async function familyR14(root, files) {
  if (!existsSync(join(root, "server/writer-fence.mjs"))) return [];
  const fence = await import(pathToFileURL(join(root, "server/writer-fence.mjs")).href);
  const registered = new Set([...fence.applicationTables, ...fence.lazyAdditiveTables]);
  const problems = [];
  for (const table of ddlTables(root, files).keys()) {
    if (!registered.has(table)) problems.push(`R14 writer-fence: DDL table in no fence set (applicationTables/lazyAdditiveTables): ${table}`);
  }
  return problems;
}

async function familyR13(root, files, row) {
  if (!existsSync(join(root, "server/purge-registry.mjs"))) return [];
  const purge = await import(pathToFileURL(join(root, "server/purge-registry.mjs")).href);
  const purgeTables = new Set(purge.PURGE_TABLES.map((r) => r.table));
  const exceptions = new Map((row.exceptions ?? []).map((ex) => [ex.table, ex.reason]));
  const keyed = new Map();
  for (const [table, body] of ddlTables(root, files)) if (KEYED_COLUMNS.test(body)) keyed.set(table, body);
  const problems = [];
  for (const table of keyed.keys()) {
    if (!purgeTables.has(table) && !exceptions.has(table)) {
      problems.push(`R13 purge: keyed DDL table with no purge row and no named manifest exception: ${table}`);
    }
  }
  for (const table of exceptions.keys()) {
    if (!keyed.has(table)) problems.push(`R13 purge: manifest exception is stale (table no longer a keyed DDL table): ${table}`);
    if (purgeTables.has(table)) problems.push(`R13 purge: manifest exception is stale (table now has a purge row): ${table}`);
  }
  return problems;
}

function familyR2(root, files) {
  const src = readIf(root, "scripts/candidate-runtime-fixture.mjs");
  if (src === null) return [];
  const fileSet = new Set(files);
  const adds = [...src.matchAll(/paths\.add\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const problems = [];
  const seen = new Set();
  for (const add of adds) {
    if (seen.has(add)) problems.push(`R2 candidate fixture: duplicate paths.add: ${add}`);
    seen.add(add);
    if (!fileSet.has(add)) problems.push(`R2 candidate fixture: paths.add names a file not in the tree: ${add}`);
  }
  return problems;
}

function familyR17(root, files, row) {
  const src = readIf(root, "coverage-thresholds.json");
  if (src === null) return [];
  const rows = new Set(Object.values(JSON.parse(src).modules ?? {}).map((m) => m.dir));
  const exceptions = new Set((row.exceptions ?? []).map((ex) => ex.table));
  const counts = new Map();
  for (const path of files) {
    if (!path.includes("/") || path.startsWith("tests/")) continue;
    if (!/\.(mjs|js)$/.test(path)) continue;
    const top = path.split("/")[0];
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  const problems = [];
  for (const [dir, count] of counts) {
    if (count >= 10 && !rows.has(dir) && !exceptions.has(dir)) {
      problems.push(`R17 coverage: top-level code directory with ${count} code files has no thresholds row and no named manifest exception: ${dir}`);
    }
  }
  for (const dir of exceptions) {
    if (!counts.has(dir)) problems.push(`R17 coverage: manifest exception is stale (directory gone): ${dir}`);
    if (rows.has(dir)) problems.push(`R17 coverage: manifest exception is stale (directory now has a thresholds row): ${dir}`);
  }
  return problems;
}

async function familyR18(root, files, row) {
  const src = readIf(root, "scripts/unit-ci-durations.json");
  if (src === null) return [];
  const keys = new Set(Object.keys(JSON.parse(src).milliseconds ?? {}));
  const shards = await import(pathToFileURL(join(root, "scripts/unit-shards.mjs")).href);
  const discovered = new Set(shards.discoverUnitTests(root).map((p) => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p)));
  const problems = [];
  for (const key of keys) if (!discovered.has(key)) problems.push(`R18 unit durations: entry names a test file discovery no longer finds (stale): ${key}`);
  const unmeasured = [...discovered].filter((p) => !keys.has(p)).length;
  if (typeof row.unmeasuredCeiling === "number" && unmeasured > row.unmeasuredCeiling) {
    problems.push(`R18 unit durations: ${unmeasured} discovered test files have no measured duration, above the manifest ceiling of ${row.unmeasuredCeiling} - refresh the table or raise the ceiling in the manifest with the new count`);
  }
  return { problems, note: `R18 unit durations: ${keys.size} measured, ${unmeasured} unmeasured (ceiling ${row.unmeasuredCeiling ?? "none"})` };
}

function familyR19(root) {
  const durSrc = readIf(root, "scripts/browser-ci-durations.json");
  const pkgSrc = readIf(root, "package.json");
  if (durSrc === null || pkgSrc === null) return [];
  const keys = new Set(Object.keys(JSON.parse(durSrc).milliseconds ?? {}));
  const script = JSON.parse(pkgSrc).scripts?.["test:browser"] ?? "";
  const listed = new Set([...script.matchAll(/scripts\/[\w.-]+\.mjs/g)].map((m) => m[0]));
  const problems = [];
  for (const key of keys) if (!listed.has(key)) problems.push(`R19 browser durations: entry not in package.json test:browser: ${key}`);
  for (const file of listed) if (!keys.has(file)) problems.push(`R19 browser durations: test:browser file has no durations entry: ${file}`);
  return problems;
}

function familyR23(root, files) {
  const pkgSrc = readIf(root, "cloudflare/package.json");
  if (pkgSrc === null) return [];
  const disk = new Set(files.filter((f) => f.startsWith("cloudflare/") && f.endsWith(".check.mjs")).map((f) => basename(f)));
  const pinned = new Set();
  for (const value of Object.values(JSON.parse(pkgSrc).scripts ?? {})) {
    for (const m of String(value).matchAll(/([\w.-]+\.check\.mjs)/g)) pinned.add(m[1]);
  }
  const problems = [];
  for (const name of disk) if (!pinned.has(name)) problems.push(`R23 cloudflare pins: check on disk runs nowhere (not in cloudflare/package.json scripts): ${name}`);
  for (const name of pinned) if (!disk.has(name)) problems.push(`R23 cloudflare pins: script pins a check that is not on disk: ${name}`);
  return problems;
}

function familyR26(root) {
  const src = readIf(root, "scripts/listings.json");
  if (src === null) return [];
  const rows = JSON.parse(src).rows ?? [];
  const required = ["id", "title", "kind", "group", "url", "expect", "update", "owner"];
  const problems = [];
  const ids = new Set();
  for (const row of rows) {
    for (const field of required) {
      const v = row[field];
      if (v === undefined || v === null || (typeof v === "string" && !v.trim())) problems.push(`R26 listings: row ${row.id ?? "?"} missing/empty field: ${field}`);
    }
    if (row.id) {
      if (ids.has(row.id)) problems.push(`R26 listings: duplicate row id: ${row.id}`);
      ids.add(row.id);
    }
    if (row.url) { try { new URL(row.url); } catch { problems.push(`R26 listings: row ${row.id ?? "?"} url does not parse: ${row.url}`); } }
  }
  return problems;
}

function familyR28(root) {
  const candSrc = readIf(root, "scripts/CANDIDATE-MANIFEST.json");
  const fenceSrc = readIf(root, "server/writer-fence.mjs");
  if (candSrc === null || fenceSrc === null) return [];
  const pinned = JSON.parse(candSrc).storeSchemaVersion;
  const current = Number(/STORE_SCHEMA_VERSION\s*=\s*(\d+)/.exec(fenceSrc)?.[1]);
  if (pinned !== current) return [`R28 candidate manifest: storeSchemaVersion ${pinned} != writer-fence STORE_SCHEMA_VERSION ${current} - re-pin with node scripts/candidate-manifest.mjs --write`];
  return [];
}

function familyR31(root, files, row) {
  if (!existsSync(join(root, "scripts/visual-regression-baselines"))) return [];
  const onDisk = new Set(files.filter((f) => f.startsWith("scripts/visual-regression-baselines/") && f.endsWith(".png")).map((f) => basename(f, ".png")));
  const referenced = new Set();
  for (const script of ["scripts/visual-regression-browser-check.mjs", "scripts/visual-regression-helper.mjs"]) {
    const src = readIf(root, script);
    if (src === null) continue;
    for (const m of src.matchAll(/["']([a-z0-9-]+)\.png["']/g)) referenced.add(m[1]);
    for (const m of src.matchAll(/compareScreenshotBuffer\([^,]+,\s*["']([a-z0-9-]+)["']/g)) referenced.add(m[1]);
  }
  const exceptions = new Set((row.exceptions ?? []).map((ex) => ex.table));
  const problems = [];
  for (const name of onDisk) if (!referenced.has(name)) problems.push(`R31 visual baselines: PNG on disk is referenced by no capture name in the visual scripts: ${name}`);
  for (const name of referenced) if (!onDisk.has(name) && !exceptions.has(name)) problems.push(`R31 visual baselines: capture name has no PNG on disk and no named manifest exception: ${name}`);
  for (const name of exceptions) if (!referenced.has(name)) problems.push(`R31 visual baselines: manifest exception is stale (name no longer referenced): ${name}`);
  return problems;
}

function familyR32(root) {
  const problems = [];
  const checkSrc = readIf(root, "scripts/check.mjs") ?? "";
  for (const needle of ["journey-coverage.mjs", "check-wiki.mjs", "wiki-build.mjs"]) {
    if (!checkSrc.includes(needle)) problems.push(`R32 journey/wiki/skills: scripts/check.mjs no longer wires ${needle}`);
  }
  const lintSrc = readIf(root, "scripts/lint.mjs") ?? "";
  if (!lintSrc.includes("skills-sync-check")) problems.push("R32 journey/wiki/skills: scripts/lint.mjs no longer wires skills-sync-check.mjs");
  return problems;
}

function familyR33(root, files, row) {
  const onDisk = new Set(files.filter((f) => f.startsWith("deploy/") && /\.(service|timer)$/.test(f)));
  const registered = new Set((row.artefacts ?? []).filter((p) => /\.(service|timer)$/.test(p)));
  const problems = [];
  for (const path of onDisk) if (!registered.has(path)) problems.push(`R33 deploy units: unit file on disk is not named in the manifest row: ${path}`);
  for (const path of registered) if (!onDisk.has(path)) problems.push(`R33 deploy units: manifest row names a unit not on disk: ${path}`);
  return problems;
}

function familyA8(root) {
  const src = readIf(root, ".github/secret-scan-allowlist.txt");
  if (src === null) return [];
  const problems = [];
  for (const line of src.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const hash = trimmed.indexOf("#");
    if (hash < 0 || !trimmed.slice(hash + 1).trim()) problems.push(`A8 secret-scan allowlist: active entry without a reason after #: ${trimmed}`);
  }
  return problems;
}

const FAMILY_CHECKS = {
  R2: (root, files) => familyR2(root, files),
  R13: (root, files, row) => familyR13(root, files, row),
  R14: (root, files) => familyR14(root, files),
  R17: (root, files, row) => familyR17(root, files, row),
  R18: (root, files, row) => familyR18(root, files, row),
  R19: (root) => familyR19(root),
  R23: (root, files) => familyR23(root, files),
  R26: (root) => familyR26(root),
  R28: (root) => familyR28(root),
  R31: (root, files, row) => familyR31(root, files, row),
  R32: (root) => familyR32(root),
  R33: (root, files, row) => familyR33(root, files, row),
  A8: (root) => familyA8(root),
};

/** Run every family closure named by the manifest. Returns { problems, notes }. */
export async function familyProblems(root, manifest, files = walkFiles(root)) {
  const problems = [];
  const notes = [];
  for (const row of manifest.registries ?? []) {
    const check = FAMILY_CHECKS[row.id];
    if (!check) continue;
    const result = await check(root, files, row);
    if (Array.isArray(result)) problems.push(...result);
    else { problems.push(...result.problems); if (result.note) notes.push(result.note); }
  }
  return { problems, notes };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = process.argv[2] ? join(process.cwd(), process.argv[2]) : process.cwd();
  const manifest = loadManifest(root);
  const files = walkFiles(root);
  const { problems: shapeProblems, census } = checkManifest(root, manifest, files);
  const { problems: famProblems, notes } = await familyProblems(root, manifest, files);
  console.log(`registry-manifest census: ${census.filesWalked} files walked, ${census.shapeHits} registry-shaped artefacts, ${census.uncovered} unregistered; ${manifest.registries.length} registry rows, ${manifest.gates.length} gate rows, ${manifest.asRead.length} as-read entries.`);
  for (const note of notes) console.log(`registry-manifest: ${note}`);
  const problems = [...shapeProblems, ...famProblems];
  if (problems.length > 0) {
    console.error(`registry-manifest-check: FAIL - ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("registry-manifest-check: OK - every registry-shaped artefact is registered and every HAND-OPEN family closure holds.");
}
