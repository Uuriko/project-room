// Guild-06 worker-12: CLI hardening for shard-12 scripts.
//
// scripts/check-deps-exist.mjs and scripts/soak-run.mjs silently ignored
// every CLI argument: --bogus ran the full gate / booted a soak server,
// a dangling --root silently fell back to scanning cwd, and --help ran the
// tool instead of printing help. Per the guild-06 convention (see
// tests/guild06-usage-errors.test.js), usage errors go to stderr with a
// "Usage:" line and exit 2 — never an uncaught stack trace — and --help
// prints usage to stdout and exits 0.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmpBase = join(root, ".tmp");
const fixture = join(tmpBase, "guild06-worker-12-cde-fixture");

function ensureFixture() {
  mkdirSync(fixture, { recursive: true });
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({ name: "empty-fixture", version: "1.0.0" }),
  );
}

function run(script, args, { timeout = 20000, cwd = root, envExtra = {} } = {}) {
  mkdirSync(tmpBase, { recursive: true });
  return spawnSync(process.execPath, [`${root}/scripts/${script}`, ...args], {
    encoding: "utf8",
    timeout,
    cwd,
    env: { ...process.env, TMPDIR: tmpBase, ...envExtra },
  });
}

function assertUsageError(r, name) {
  assert.equal(r.status, 2, `${name}: expected exit 2, got ${r.status}: ${(r.stderr || "").slice(0, 300)}`);
  assert.match(r.stderr, /Usage:/i, `${name}: usage line goes to stderr`);
  assert.doesNotMatch(r.stderr, /^\s*at\s/m, `${name}: no stack trace`);
}

// --- scripts/check-deps-exist.mjs -------------------------------------------

test("check-deps-exist: unknown flag exits 2 with usage on stderr", () => {
  ensureFixture();
  const r = run("check-deps-exist.mjs", ["--root", fixture, "--bogus"]);
  assertUsageError(r, "check-deps-exist --bogus");
});

test("check-deps-exist: dangling --root exits 2 with usage on stderr", () => {
  ensureFixture();
  // cwd = the fixture so a silent cwd-fallback would exit 0 on a clean scan;
  // the only way to pass is to reject the missing value.
  const r = run("check-deps-exist.mjs", ["--root"], { cwd: fixture });
  assertUsageError(r, "check-deps-exist --root (dangling)");
});

test("check-deps-exist: --help exits 0 with usage on stdout", () => {
  const r = run("check-deps-exist.mjs", ["--help"]);
  assert.equal(r.status, 0, `check-deps-exist --help: expected exit 0, got ${r.status}`);
  assert.match(r.stdout, /Usage:/i, "check-deps-exist --help: usage goes to stdout");
});

test("check-deps-exist: --root=<dir> form is accepted", () => {
  ensureFixture();
  const r = run("check-deps-exist.mjs", [`--root=${fixture}`]);
  assert.equal(r.status, 0, `check-deps-exist --root=<dir>: expected exit 0, got ${r.status}: ${(r.stderr || "").slice(0, 300)}`);
  assert.match(r.stdout, /clean/);
});

test("check-deps-exist: valid --root <dir> still scans clean", () => {
  ensureFixture();
  const r = run("check-deps-exist.mjs", ["--root", fixture]);
  assert.equal(r.status, 0, `check-deps-exist --root <dir>: expected exit 0, got ${r.status}: ${(r.stderr || "").slice(0, 300)}`);
  assert.match(r.stdout, /clean/);
});

// --- scripts/soak-run.mjs ----------------------------------------------------

test("soak-run: unknown flag exits 2 with usage on stderr, never boots a server", () => {
  const r = run("soak-run.mjs", ["--bogus"], {
    timeout: 60000,
    envExtra: { SOAK_DURATION_S: "5" }, // self-limits a regression run
  });
  assertUsageError(r, "soak-run --bogus");
  assert.doesNotMatch(r.stdout, /\[soak\] port=/, "soak-run --bogus: must not boot the server");
});

test("soak-run: --help exits 0 with usage on stdout", () => {
  const r = run("soak-run.mjs", ["--help"], {
    timeout: 60000,
    envExtra: { SOAK_DURATION_S: "5" }, // self-limits a regression run
  });
  assert.equal(r.status, 0, `soak-run --help: expected exit 0, got ${r.status}`);
  assert.match(r.stdout, /Usage:/i, "soak-run --help: usage goes to stdout");
});
