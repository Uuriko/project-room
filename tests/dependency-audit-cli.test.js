// WORKER-35 hardening: dependency-audit.mjs output-write failures.
// F4: an unwritable --out/--json-out path is a config error -> clean message
// on stderr + exit 2, never an uncaught stack trace with exit 1.
// The npm invocation is stubbed on PATH (clean audit payload) so the test
// reaches the write step without touching the network.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = `${root}/scripts/dependency-audit.mjs`;

function runWithStubNpm(args) {
  const dir = mkdtempSync(join(tmpdir(), "w35-dep-cli-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "npm"), '#!/bin/sh\nprintf \'{"vulnerabilities":{}}\'\n');
  chmodSync(join(dir, "bin", "npm"), 0o755);
  const env = { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` };
  return spawnSync(process.execPath, [script, ...args],
    { cwd: root, env, encoding: "utf8", timeout: 60000 });
}

test("F4a: unwritable --out exits 2 with a clean message, no stack trace", () => {
  const dir = mkdtempSync(join(tmpdir(), "w35-dep-cli-"));
  const r = runWithStubNpm([`--out=${join(dir, "no-such-dir", "report.md")}`]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
  assert.match(r.stderr, /dependency-audit: cannot write output file: ENOENT/);
  assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace");
});

test("F4b: unwritable --json-out exits 2 with a clean message, no stack trace", () => {
  const dir = mkdtempSync(join(tmpdir(), "w35-dep-cli-"));
  const r = runWithStubNpm([`--json-out=${join(dir, "no-such-dir", "summary.json")}`]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
  assert.match(r.stderr, /dependency-audit: cannot write output file: ENOENT/);
  assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace");
});

test("F4c: happy path still writes both files and exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "w35-dep-cli-"));
  const out = join(dir, "report.md"), jsonOut = join(dir, "summary.json");
  const r = runWithStubNpm([`--out=${out}`, `--json-out=${jsonOut}`]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr.slice(0, 300)}`);
  assert.ok(existsSync(out) && existsSync(jsonOut), "both files written");
  assert.match(readFileSync(out, "utf8"), /Weekly Dependency Audit/);
  assert.match(readFileSync(jsonOut, "utf8"), /"tool": "dependency-audit"/);
});
