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

// The runner passes the test name to --test-name-pattern, which is a regex:
// escape it so an exact test name matches literally.
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Normalize one quarantine.json entry to { file, name }.
 * Entries are objects with a "test" key, but a bare string entry is accepted
 * too (W46: it used to be reported as "entry has no test file"). The "file >
 * test name" convention applies to both; a bare file runs the whole file.
 * Returns null when the entry names no file.
 */
export function parseQuarantineEntry(entry) {
  const spec = String(typeof entry === "string" ? entry : entry?.test ?? "").trim();
  const sep = spec.indexOf(" > ");
  const file = (sep === -1 ? spec : spec.slice(0, sep)).trim();
  if (!file) return null;
  const name = sep === -1 ? null : spec.slice(sep + 3).trim();
  return { file, name: name || null };
}

/** Describe how a child run ended: "exit N", or the signal when it was killed. */
export function describeExit(result) {
  if (result?.status !== null && result?.status !== undefined) return `exit ${result.status}`;
  return `signal ${result?.signal ?? "unknown"}`;
}

// W46: the runner body lives in main() behind the CLI guard below. The
// module used to execute the whole quarantine suite on import, so importing
// it for parseQuarantineEntry/describeExit (unit tests) ran every quarantined
// browser suite as a side effect.
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
    console.log("run-quarantined-tests: nothing quarantined — nothing to run");
    process.exit(0);
  }

  let failures = 0;
  for (const entry of entries) {
    const parsed = parseQuarantineEntry(entry);
    if (!parsed) {
      console.error(`run-quarantined-tests: entry has no test file: ${JSON.stringify(entry)}`);
      failures += 1;
      continue;
    }
    const { file, name } = parsed;
    const spec = name ? `${file} > ${name}` : file;
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
      console.error(`run-quarantined-tests: FAILED (${describeExit(result)}): ${spec}`);
    }
  }

  if (failures > 0) {
    console.error(`\nrun-quarantined-tests: ${failures}/${entries.length} quarantined test(s) failed`);
    process.exit(1);
  }
  console.log(`\nrun-quarantined-tests: all ${entries.length} quarantined test(s) passed`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) main();
