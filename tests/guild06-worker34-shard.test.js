// WAVE-2000 G06 worker-34 shard hardening (scripts at index % 50 == 33).
//
// F1: scripts/analytics-backfill.mjs: unknown arguments and a missing --db
//     exit 1; the guild-06 convention (tests/guild06-usage-errors.test.js) is
//     a usage line on stderr + exit 2. Also `--db --report` silently swallows
//     the --report flag as the database path and dies later with
//     "unable to open database file" instead of a usage error.
// F2: scripts/server-json-check.mjs: a malformed server.json on disk crashes
//     with an uncaught SyntaxError stack (exit 1) instead of a clean config
//     error naming the file (exit 2).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const backfill = join(ROOT, "scripts", "analytics-backfill.mjs");

function runBackfill(args) {
  const r = spawnSync(process.execPath, [backfill, ...args], { encoding: "utf8", cwd: ROOT, timeout: 30000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("F1a: unknown argument is a usage error (exit 2), not a bare exit 1", () => {
  const r = runBackfill(["--bogus"]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 200)}`);
  assert.match(r.stderr, /usage:/i, "usage line goes to stderr");
  assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace on a usage error");
});

test("F1b: missing --db is a usage error (exit 2)", () => {
  const r = runBackfill([]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 200)}`);
  assert.match(r.stderr, /--db/, "stderr names the required --db flag");
});

test("F1c: --db must not swallow a following flag as its value", () => {
  const r = runBackfill(["--db", "--report"]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 200)}`);
  assert.doesNotMatch(r.stderr, /unable to open database/i, "no late confusing db-open error");
  assert.match(r.stderr, /--db/i, "stderr names the --db problem");
});

test("F1d: a real database path still works (--db value is consumed once)", () => {
  // Sanity: the missing-value guard must not break normal --db <path> parsing.
  const r = runBackfill(["--db", join(ROOT, "does-not-exist.sqlite"), "--report"]);
  assert.equal(r.status, 1, `a nonexistent db is a runtime failure (exit 1), got ${r.status}: ${r.stderr.slice(0, 200)}`);
  assert.doesNotMatch(r.stderr, /usage:/i, "not misreported as a usage error");
});

// F2: the check script resolves ../server.json relative to its own location,
// so the test runs a verbatim copy in a sandbox with a broken manifest.
function serverJsonSandbox(manifestText) {
  const dir = mkdtempSync(join(tmpdir(), "w34-server-json-"));
  const dest = join(dir, "bin", "server-json-check.mjs");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(join(ROOT, "scripts", "server-json-check.mjs"), "utf8"));
  writeFileSync(join(dir, "server.json"), manifestText);
  return { dir, dest };
}

test("F2: malformed server.json is a clean config error (exit 2), not an uncaught stack", t => {
  const { dir, dest } = serverJsonSandbox("not valid json{{{");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [dest], { encoding: "utf8", timeout: 15000 });
  const stderr = r.stderr ?? "";
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${stderr.slice(0, 300)}`);
  assert.doesNotMatch(stderr, /SyntaxError|^\s*at\s/m, "no stack trace on a config error");
  assert.match(stderr, /server\.json/i, "stderr names the bad file");
});

test("F2: missing server.json is a clean config error (exit 2)", t => {
  const { dir, dest } = serverJsonSandbox("{\"name\":\"x\"}");
  rmSync(join(dir, "server.json"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [dest], { encoding: "utf8", timeout: 15000 });
  const stderr = r.stderr ?? "";
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${stderr.slice(0, 300)}`);
  assert.doesNotMatch(stderr, /^\s*at\s/m, "no stack trace on a config error");
});

test("F2: a valid server.json still checks clean (exit 0)", t => {
  const { dir, dest } = serverJsonSandbox(JSON.stringify({
    name: "io.github.Uuriko/project-room", description: "ok", version: "1.2.3",
    remotes: [{ url: "https://room.trydemigod.com" }],
  }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [dest], { encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${(r.stderr ?? "").slice(0, 200)}`);
});
