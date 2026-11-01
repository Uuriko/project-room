#!/usr/bin/env node
/**
 * scripts/run-quarantined-tests.mjs
 *
 * Zero-Bug System: non-blocking lane for quarantined flaky tests.
 *
 * Reads tests/quarantine.json and runs each quarantined test with
 * QUARANTINE_RUN=1 (so env-gated quarantined tests execute). Entries use
 * the "file > test name" convention; a bare file entry runs the whole file.
 *
 * Exits non-zero when any quarantined test fails — the zero-bug-quarantine
 * workflow keeps this job non-blocking via `continue-on-error: true`, so a
 * red result reports honestly without ever failing a PR.
 *
 * Vacuity hardening (T-4, find:run-quarantined-tests-001 / SYSTEMIC-MAP
 * F-28): a gate that runs zero things must not look like a gate that ran.
 * - Every entry is existence-checked BEFORE anything runs: the file must
 *   exist and a named test must appear in that file. A dangling entry is
 *   a harness error (exit 2), never a silent pass — previously a
 *   `--test-name-pattern` that matched nothing exited 0 having run zero
 *   tests, and a forgotten list was indistinguishable from a healthy one.
 * - An empty list prints an explicit EMPTY canary line (exit stays 0: an
 *   empty quarantine is legitimate), so "lane healthy, list empty" is
 *   greppable and distinct from a run that executed entries.
 *
 * Dependency-free: uses only node builtins.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const jsonPath = path.join(repoRoot, "tests", "quarantine.json");

// Split an entry's "file > test name" spec into its parts.
export function parseEntry(entry) {
  const spec = String(entry?.test ?? "").trim();
  const sep = spec.indexOf(" > ");
  const file = (sep === -1 ? spec : spec.slice(0, sep)).trim();
  const name = sep === -1 ? null : spec.slice(sep + 3).trim();
  return { spec, file, name };
}

// Existence check: every entry must point at a real file, and a named
// test must literally appear in that file (test names are declared as
// string literals in this repo's node:test files). Returns a list of
// human-readable problems; empty means every entry can actually run.
// `io` is injectable for tests: { exists(absPath), read(absPath) }.
export function checkEntries(entries, io = {
  exists: abs => existsSync(abs),
  read: abs => readFileSync(abs, "utf8"),
}) {
  const problems = [];
  for (const entry of entries) {
    const { spec, file, name } = parseEntry(entry);
    if (!file) {
      problems.push(`entry has no test file: ${JSON.stringify(entry)}`);
      continue;
    }
    const abs = path.join(repoRoot, file);
    if (!io.exists(abs)) {
      problems.push(`quarantined file does not exist: ${file} (entry: ${spec})`);
      continue;
    }
    if (name) {
      let text = "";
      try { text = io.read(abs); } catch { text = ""; }
      if (!text.includes(name)) {
        problems.push(`quarantined test name not found in ${file}: ${name} — a --test-name-pattern matching nothing would run zero tests and pass`);
      }
    }
  }
  return problems;
}

function main() {
  let data;
  try {
    data = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (err) {
    console.error(`run-quarantined-tests: cannot read/parse ${jsonPath}: ${err.message}`);
    process.exit(2);
  }

  const entries = Array.isArray(data.quarantined) ? data.quarantined : null;
  if (!entries) {
    console.error("run-quarantined-tests: quarantine.json must contain {\"quarantined\": [...]}");
    process.exit(2);
  }
  if (entries.length === 0) {
    // Zero-count canary: loud, greppable, and distinct from a real run.
    console.log("run-quarantined-tests: EMPTY — quarantine list is empty; zero tests run. Lane is alive and its existence checker is armed (a dangling entry would exit 2).");
    process.exit(0);
  }

  const problems = checkEntries(entries);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`run-quarantined-tests: existence check failed: ${problem}`);
    console.error(`run-quarantined-tests: ${problems.length} dangling quarantined entr${problems.length === 1 ? "y" : "ies"} — refusing to report a green lane that cannot run them`);
    process.exit(2);
  }

  // The runner passes the test name to --test-name-pattern, which is a regex:
  // escape it so an exact test name matches literally.
  const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  let failures = 0;
  for (const entry of entries) {
    const { spec, file, name } = parseEntry(entry);
    const args = ["--test"];
    if (name) args.push("--test-name-pattern", escapeRegExp(name));
    args.push(file);
    console.log(`\n=== quarantined: ${spec} ===`);
    const result = spawnSync(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env, QUARANTINE_RUN: "1" },
      stdio: "inherit",
    });
    if (result.status !== 0) {
      failures += 1;
      console.error(`run-quarantined-tests: FAILED (exit ${result.status}): ${spec}`);
    }
  }

  if (failures > 0) {
    console.error(`\nrun-quarantined-tests: ${failures}/${entries.length} quarantined test(s) failed`);
    process.exit(1);
  }
  console.log(`\nrun-quarantined-tests: all ${entries.length} quarantined test(s) passed`);
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
