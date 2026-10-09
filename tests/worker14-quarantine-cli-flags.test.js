// Worker-14 fail-first: scripts/quarantine-review-coverage.mjs must reject
// unknown CLI flags instead of silently ignoring them. A typo'd
// `--fomat json` currently falls through to text output with exit 0, the
// same class the guild-06 direct pass fixed in 13 other scripts (exit 2).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = `${root}/scripts/quarantine-review-coverage.mjs`;

const run = (args) => spawnSync(process.execPath, [script, ...args], {
  encoding: "utf8", timeout: 20000, cwd: root,
});

test("unknown long flag exits 2 with an error, not silent success", () => {
  const r = run(["--store", "/no/such.db", "--bogus-flag"]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
  assert.match(r.stderr, /unknown option/i, "names the unknown option");
  assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace");
});

test("typo'd --fomat json is rejected instead of silently yielding text", () => {
  const r = run(["--store", "/no/such.db", "--fomat", "json"]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
  assert.match(r.stderr, /unknown option/i);
});

test("unknown flag after all valid args is still rejected", () => {
  const r = run(["--store", "/no/such.db", "--now", "1", "--extra"]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
  assert.match(r.stderr, /unknown option/i);
});

test("--help still exits 0", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--store/);
});
