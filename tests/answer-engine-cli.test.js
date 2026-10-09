// WORKER-35 hardening: answer-engine-check.mjs CLI contract + crash-path safety.
// F1: unknown flags / malformed --date are usage errors (stderr usage + exit 2);
//     --help prints usage instead of running the weekly check.
// F2: the crash handler must never throw: loadCrashSecrets() falls back to []
//     when the prompt config cannot be loaded, so the original error is always
//     reported as one clean line instead of an unhandled rejection.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCrashSecrets } from "../scripts/answer-engine-check.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = `${root}/scripts/answer-engine-check.mjs`;
const run = (args) => {
  const outDir = mkdtempSync(join(tmpdir(), "w35-ae-cli-"));
  return spawnSync(process.execPath, [script, ...args, "--out-dir", outDir],
    { cwd: root, encoding: "utf8", timeout: 60000 });
};

test("F1a: unknown option exits 2 with usage on stderr, no stack trace", () => {
  const r = run(["--bogus-flag"]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 200)}`);
  assert.match(r.stderr, /unknown option: --bogus-flag/);
  assert.match(r.stderr, /Usage:/i);
  assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace");
});

test("F1b: --help prints usage and does not run the check", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}`);
  assert.match(r.stdout, /Usage:/i);
  assert.doesNotMatch(r.stdout, /Answer engines/, "--help must not run the weekly check");
});

test("F1c: malformed --date exits 2 (usage error), not 1", () => {
  for (const bad of ["not-a-date", "2026-13-99", "10/09/2026"]) {
    const r = run(["--date", bad]);
    assert.equal(r.status, 2, `--date ${bad}: expected exit 2, got ${r.status}: ${r.stderr.slice(0, 200)}`);
    assert.match(r.stderr, /Usage:/i);
    assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace");
  }
});

test("F1d: a typo'd --out-dir still runs (known flags are accepted)", () => {
  const r = run([]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr.slice(0, 200)}`);
});

test("F2a: loadCrashSecrets returns engine secrets from a working config", () => {
  const got = loadCrashSecrets(() => ({ engines: { a: { secret: "W35_TEST_SECRET_A" } } }));
  assert.deepEqual(got, [process.env.W35_TEST_SECRET_A]);
});

test("F2b: loadCrashSecrets returns [] instead of throwing when the config fails to load", () => {
  const got = loadCrashSecrets(() => { throw new Error("config exploded"); });
  assert.deepEqual(got, [], "crash path must never throw");
});
