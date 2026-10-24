#!/usr/bin/env node
/**
 * scripts/time-constants-check.mjs
 *
 * Time-constant registry gate (#3686, defect class: one time constant,
 * several semantic roles).
 *
 * Every time constant declared in server/ — an ALL-CAPS const/let declarator
 * carrying a non-first time-unit token (_MS / _SECONDS / _MINUTES / _HOURS /
 * _DAYS) or a TTL / WINDOW token — must appear in
 * scripts/time-constants-registry.json
 * with exactly one semantic role and a named boundary behaviour. The gate
 * fails when:
 *
 *   - a declaration in server/ has no registry row (unregistered constant);
 *   - a registry row names no live declaration (stale row — the baseline is
 *     shrink-only, so rows leave only by deleting the constant);
 *   - a row is missing its role or boundary behaviour, or its `roles` list
 *     and `multiRole` flag disagree;
 *   - a multi-role row is not in the registry's grandfathered
 *     `multiRoleBaseline` (new constants are single-role, no exceptions);
 *   - the registry's registry-of-registries row (the #4067 manifest shape,
 *     embedded as `manifestRow`) is missing or incomplete, so this registry
 *     stays registerable in scripts/registry-manifest.json the moment that
 *     manifest lands.
 *
 * The gate changes NO runtime semantics. Known contradictions between
 * registered constants (e.g. WAKEABLE_WINDOW_MS vs MAX_CADENCE_SECONDS,
 * #3592) are recorded on the rows, not fixed here.
 *
 * Dependency-free (node builtins only), read-only, no network.
 * Usage: node scripts/time-constants-check.mjs [root]
 * Exit 0 = every time constant in server/ is registered, single-role.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const REGISTRY_PATH = "scripts/time-constants-registry.json";

/** A declarator name is a time constant iff it is ALL-CAPS and a non-first
 *  underscore-separated token is a time unit or a TTL / WINDOW marker
 *  (so WAKEABLE_WINDOW_MS, MENTION_TIMEOUT_MS_DEFAULT and
 *  BOARD_LEASE_HOURS_MIN count). The non-first-token rule keeps rates and
 *  conversions out: PUSH_PER_AGENT_HOUR, MS_PER_DAY, ISO_SECOND and the
 *  bare unit helper DAY are not time constants. */
const TIME_TOKENS = new Set(["MS", "SECONDS", "MINUTES", "HOURS", "DAYS", "TTL", "WINDOW", "WINDOWS"]);

export function isTimeConstantName(name) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return false;
  return name.split("_").some((token, i) => i > 0 && TIME_TOKENS.has(token));
}

const DECL_LINE_RE = /\b(?:const|let|var)\s+([^;]+)/g;
const DECLARATOR_RE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=(?!=)/;

export function scanServerConstants(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) {
        const rel = relative(root, path).split(sep).join("/");
        const lines = readFileSync(path, "utf8").split("\n");
        lines.forEach((line, i) => {
          for (const m of line.matchAll(DECL_LINE_RE)) {
            for (const segment of m[1].split(",")) {
              const d = DECLARATOR_RE.exec(segment);
              if (d && isTimeConstantName(d[1])) {
                found.push({ name: d[1], file: rel, line: i + 1 });
              }
            }
          }
        });
      }
    }
  };
  walk(join(root, "server"));
  return found.sort((a, b) => (a.file + a.name).localeCompare(b.file + b.name));
}

export function loadRegistry(root) {
  return JSON.parse(readFileSync(join(root, REGISTRY_PATH), "utf8"));
}

const MANIFEST_ROW_FIELDS = [
  "id", "name", "family", "enumerates", "sourceOfTruth", "artefacts",
  "closureChecks", "closureStatus", "derivedOrHand", "canary", "lastFailure",
];

export function checkRegistry(registry, found) {
  const problems = [];
  const rows = registry.constants ?? [];
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.file}::${row.name}`;
    if (byKey.has(key)) problems.push(`duplicate registry row for ${key}`);
    byKey.set(key, row);
    if (!row.name || !isTimeConstantName(row.name)) problems.push(`registry row ${key || "(unnamed)"} has a missing or non-time-constant name`);
    if (!row.file || !row.file.startsWith("server/")) problems.push(`registry row ${key} must name a file under server/`);
    if (!row.value) problems.push(`registry row ${key} is missing its declared value`);
    if (!row.unit) problems.push(`registry row ${key} is missing its unit`);
    if (!Array.isArray(row.roles) || row.roles.length === 0 || row.roles.some((r) => !r || typeof r !== "string")) {
      problems.push(`registry row ${key} must name at least one semantic role in roles[]`);
    }
    const multi = Array.isArray(row.roles) && row.roles.length > 1;
    if (multi && row.multiRole !== true) problems.push(`registry row ${key} has ${row.roles.length} roles but is not marked multiRole`);
    if (!multi && row.multiRole === true) problems.push(`registry row ${key} is marked multiRole but lists a single role`);
    if (multi && !(registry.multiRoleBaseline ?? []).includes(key)) {
      problems.push(`registry row ${key} is multi-role but not in the shrink-only multiRoleBaseline (new constants must be single-role)`);
    }
    if (!row.boundary) problems.push(`registry row ${key} is missing its boundary behaviour`);
  }
  for (const key of registry.multiRoleBaseline ?? []) {
    if (!byKey.has(key)) problems.push(`multiRoleBaseline names ${key}, which has no registry row (stale baseline entry)`);
  }
  const foundKeys = new Set();
  for (const decl of found) {
    const key = `${decl.file}::${decl.name}`;
    foundKeys.add(key);
    if (!byKey.has(key)) {
      problems.push(`unregistered time constant ${decl.name} at ${decl.file}:${decl.line} — add a row to ${REGISTRY_PATH} naming its single semantic role and boundary behaviour`);
    }
  }
  for (const key of byKey.keys()) {
    if (!foundKeys.has(key)) problems.push(`stale registry row ${key} — no live declaration in server/ (baseline is shrink-only: delete the row with the constant)`);
  }
  const row = registry.manifestRow;
  if (!row) {
    problems.push("registry is missing manifestRow — the #4067 registry-of-registries row that registers this registry");
  } else {
    for (const field of MANIFEST_ROW_FIELDS) {
      if (!row[field] || (Array.isArray(row[field]) && row[field].length === 0)) {
        problems.push(`manifestRow is missing field ${field} (registry-of-registries shape, PR #4067)`);
      }
    }
    if (row && !(row.artefacts ?? []).includes(REGISTRY_PATH)) {
      problems.push(`manifestRow.artefacts must include ${REGISTRY_PATH} (self-registration)`);
    }
  }
  return problems;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = process.argv[2] ? join(process.cwd(), process.argv[2]) : process.cwd();
  const registry = loadRegistry(root);
  const found = scanServerConstants(root);
  const problems = checkRegistry(registry, found);
  const multi = (registry.constants ?? []).filter((r) => r.multiRole === true).length;
  console.log(`time-constants census: ${found.length} time constants declared in server/, ${registry.constants.length} registry rows, ${multi} multi-role (grandfathered baseline ${registry.multiRoleBaseline.length}).`);
  if (registry.knownConflicts?.length) {
    for (const c of registry.knownConflicts) console.log(`time-constants: known conflict (registered, not fixed here): ${c}`);
  }
  if (problems.length > 0) {
    console.error(`time-constants-check: FAIL - ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("time-constants-check: OK - every time constant in server/ is registered with a single role and boundary behaviour.");
}
