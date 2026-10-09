// Guild-06 worker-36 fail-first regression: CLI argument/parse errors in this
// worker's shard must print a clean message (+ Usage:) to stderr and exit
// 2 (usage) or 1 (failed operation) — never an uncaught stack trace.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = (p) => `${root}/scripts/${p}`;

function run(name, args, { timeout = 20000 } = {}) {
  return spawnSync(process.execPath, [script(name), ...args], {
    encoding: "utf8",
    timeout,
    cwd: root,
  });
}

function assertCleanUsage(r, name, expectedExit) {
  assert.equal(r.status, expectedExit, `${name}: expected exit ${expectedExit}, got ${r.status}: ${String(r.stderr).slice(0, 400)}`);
  assert.match(r.stderr, /Usage:/i, `${name}: usage goes to stderr`);
  assert.doesNotMatch(r.stderr, /^\s*at\s/m, `${name}: no stack trace`);
}

test("deploy-checks --bogus: unknown option exits 2 with usage, no stack", () => {
  assertCleanUsage(run("deploy-checks.mjs", ["--bogus"]), "deploy-checks --bogus", 2);
});

test("deploy-checks --check --write: mutually exclusive stays exit 2", () => {
  assertCleanUsage(run("deploy-checks.mjs", ["--check", "--write"]), "deploy-checks --check --write", 2);
});

test("unit-ci --shard=99/3: invalid shard exits 2 with usage, no stack", () => {
  assertCleanUsage(run("unit-ci.mjs", ["--shard=99/3"]), "unit-ci --shard=99/3", 2);
});

test("unit-ci --shard=bogus: unparsable shard exits 2 with usage, no stack", () => {
  assertCleanUsage(run("unit-ci.mjs", ["--shard=bogus"]), "unit-ci --shard=bogus", 2);
});

test("deploy-checks --write to missing directory: clean error exit 1, no stack", () => {
  const dir = mkdtempSync(join(tmpdir(), "worker36-deploy-write-"));
  const manifest = join(dir, "no-such-subdir", ".asset-hashes.json");
  const r = run("deploy-checks.mjs", ["--write", "--assets", "server.mjs", "--manifest", manifest]);
  assert.equal(r.status, 1, `deploy-checks --write: expected exit 1, got ${r.status}: ${String(r.stderr).slice(0, 400)}`);
  assert.match(r.stderr, /cannot write manifest/i, "deploy-checks --write: clean write-failure message");
  assert.doesNotMatch(r.stderr, /^\s*at\s/m, "deploy-checks --write: no stack trace");
});
