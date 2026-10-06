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
 * Dependency-free: uses only node builtins.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const jsonPath = path.join(repoRoot, "tests", "quarantine.json");

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
  console.log("run-quarantined-tests: nothing quarantined — nothing to run");
  process.exit(0);
}

// The runner passes the test name to --test-name-pattern, which is a regex:
// escape it so an exact test name matches literally.
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let failures = 0;
for (const entry of entries) {
  const spec = String(entry?.test ?? "").trim();
  const sep = spec.indexOf(" > ");
  const file = (sep === -1 ? spec : spec.slice(0, sep)).trim();
  const name = sep === -1 ? null : spec.slice(sep + 3).trim();
  if (!file) {
    console.error(`run-quarantined-tests: entry has no test file: ${JSON.stringify(entry)}`);
    failures += 1;
    continue;
  }
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
