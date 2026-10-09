// scan-secrets input handling: bad inputs must fail closed with a clean
// message and exit 2, never an uncaught stack trace and exit 1.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const gate = path.join(root, "scripts", "scan-secrets.mjs");

function run(args, cwd) {
  const result = spawnSync(process.execPath, [gate, ...args], { encoding: "utf8", cwd, timeout: 15000 });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

function assertCleanFailure(result, what) {
  assert.equal(result.status, 2, `${what}: expected exit 2, got ${result.status}\n${result.stderr}`);
  assert.ok(!/^\s+at /m.test(result.stderr), `${what}: no stack trace on stderr, got:\n${result.stderr}`);
}

test("a missing --diff file fails closed with exit 2 and no stack trace", () => {
  const missing = path.join(mkdtempSync(path.join(tmpdir(), "scan-secrets-hard-")), "no-such.diff");
  const result = run(["--diff", missing]);
  assertCleanFailure(result, "missing --diff");
  assert.match(result.stderr, /no-such\.diff/, "the error names the file it could not read");
});

test("running outside a git repo without --diff fails closed with exit 2 and no stack trace", () => {
  // /tmp, not tmpdir(): a TMPDIR override can point inside the repo worktree,
  // which would silently make this a git directory and the test meaningless.
  const outside = mkdtempSync(path.join("/tmp", "scan-secrets-nogit-"));
  const result = run([], outside);
  assertCleanFailure(result, "non-git cwd");
  assert.match(result.stderr, /scan-secrets:/, "the error is a scan-secrets message, not a bare git failure");
});

test("an unreadable diff that then scans clean still exits 0", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "scan-secrets-hard-"));
  const diffPath = path.join(dir, "change.diff");
  const body = [
    "diff --git a/server/pay.mjs b/server/pay.mjs",
    "--- a/server/pay.mjs",
    "+++ b/server/pay.mjs",
    "@@ -1 +1,2 @@",
    " context",
    "+const x = 1;",
    "",
  ].join("\n");
  writeFileSync(diffPath, body);
  const result = run(["--diff", diffPath]);
  assert.equal(result.status, 0, result.stderr);
});
