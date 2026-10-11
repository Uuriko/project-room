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
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
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

// Bound the entire entry, including module loading and cleanup. Node's own
// test timeout cannot interrupt a synchronous loop or a stuck test runner.
const timeoutMs = Number(process.env.QUARANTINE_TEST_TIMEOUT_MS ?? 180000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) {
  console.error("run-quarantined-tests: QUARANTINE_TEST_TIMEOUT_MS must be an integer from 1 to 180000");
  process.exit(2);
}

function execute(args) {
  return new Promise(resolve => {
    // Linux CI gets a private process group so a stuck test or its children
    // cannot survive the timeout and suppress the remaining registry entries.
    const grouped = process.platform !== "win32";
    const child = spawn(process.execPath, args, {
      cwd: repoRoot, env: { ...process.env, QUARANTINE_RUN: "1" },
      stdio: "inherit", detached: grouped,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (grouped) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (err) {
        if (err.code !== "ESRCH") console.error(`run-quarantined-tests: timeout cleanup: ${err.message}`);
      }
    }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); resolve({ error, status: null, timedOut }); });
    child.once("close", (status, signal) => { clearTimeout(timer); resolve({ status, signal, timedOut }); });
  });
}

function executedTest(receiptPath, file, name) {
  const events = readFileSync(receiptPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const expectedFile = path.resolve(repoRoot, file);
  const names = new Map();
  let matched = false, completed = false, nonemptyFile = false;
  for (const { type, data } of events) {
    if (type === "test:start") {
      const parent = names.get(data.parentId);
      names.set(data.testId, parent ? `${parent} ${data.name}` : data.name);
    }
    if (type === "test:summary") {
      if (!data.file) completed = data.success === true;
      if (data.file === expectedFile && data.counts?.tests > 0) nonemptyFile = true;
    }
    if (type === "test:pass" && data.file === expectedFile && data.details?.type === "test" &&
        !Object.hasOwn(data, "skip") && !Object.hasOwn(data, "todo") &&
        (!name || names.get(data.testId) === name)) matched = true;
  }
  // A zero-test file still generates a passing file wrapper. Require the
  // file's own structured summary as well as an actual named test event.
  return completed && nonemptyFile && matched;
}

mkdirSync(path.join(repoRoot, ".tmp"), { recursive: true });
let failures = 0;
for (const entry of entries) {
  const spec = String(entry?.test ?? "").trim();
  const sep = spec.indexOf(" > ");
  const file = (sep === -1 ? spec : spec.slice(0, sep)).trim();
  const name = sep === -1 ? null : spec.slice(sep + 3).trim();
  if (!file || (sep !== -1 && !name)) {
    console.error(`run-quarantined-tests: entry has no test file or name: ${JSON.stringify(entry)}`);
    failures += 1;
    continue;
  }
  const temporary = mkdtempSync(path.join(repoRoot, ".tmp", "quarantine-"));
  const receipt = path.join(temporary, "events.jsonl");
  const args = ["--test", `--test-timeout=${timeoutMs}`,
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    `--test-reporter=${path.join(here, "quarantine-test-reporter.mjs")}`, `--test-reporter-destination=${receipt}`];
  if (name) args.push("--test-name-pattern", `^${escapeRegExp(name)}$`);
  args.push(file);
  console.log(`\n=== quarantined: ${spec} ===`);
  try {
    const result = await execute(args);
    if (result.timedOut) throw new Error(`timed out after ${timeoutMs} ms`);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`exit ${result.status}${result.signal ? ` (${result.signal})` : ""}`);
    if (!executedTest(receipt, file, name)) throw new Error("no non-skipped test executed with the requested identity (or incomplete evidence)");
  } catch (err) {
    failures += 1;
    console.error(`run-quarantined-tests: FAILED (${err.message}): ${spec}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\nrun-quarantined-tests: ${failures}/${entries.length} quarantined test(s) failed`);
  process.exit(1);
}
console.log(`\nrun-quarantined-tests: all ${entries.length} quarantined test(s) passed`);
