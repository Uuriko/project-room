// Gate canary for the secret-scan pair (#3681 tranche T3):
// scripts/secret-scan-check.mjs (whole-tree) and
// scripts/secret-scan-diff.mjs (added-lines / --files).
//
// Both gates run as subprocesses against fixture trees under a spaced path.
// The planted value is a fake AWS-shaped key that exists only in these
// fixtures (tests/ is outside both gates' scan scope by policy; the
// fixtures are written to temp dirs at run time). Must-fail runs assert a
// non-zero exit AND that the output names the planted file; controls
// assert zero. The diff gate's fail-closed fallback (unresolvable base
// ref -> scan the whole HEAD tree) is exercised directly: a zero-target
// diff must widen the scan, never skip it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECK = fileURLToPath(new URL("../scripts/secret-scan-check.mjs", import.meta.url));
const DIFF = fileURLToPath(new URL("../scripts/secret-scan-diff.mjs", import.meta.url));
const SCANNER = fileURLToPath(new URL("../server/secret-scan.mjs", import.meta.url));
const PLANTED = 'export const FIXTURE_KEY = "AKIA1234567890ABCDEF";\n';

function runGate(script, args, cwd) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8", timeout: 60000 });
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(cwd, message) {
  git(cwd, ["add", "-A"]);
  git(cwd, ["-c", "user.email=canary@example.invalid", "-c", "user.name=gate-canary", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
}

// Whole-tree fixture: the gate derives its root from its own location, so
// the gate + scanner are copied into the fixture in their real layout.
// DEVIATION (filed in the PR body): this fixture uses a NON-spaced path.
// scripts/secret-scan-check.mjs derives its root as
// `new URL("..", import.meta.url).pathname`, which keeps %20 escapes, so
// under any spaced checkout path the gate crashes with ENOENT before
// scanning anything (verified at this lane's base: exit 1, output names
// no target). A spaced-path canary for this gate is impossible without
// changing the gate itself, which this tranche must not do; the diff
// gate below carries the spaced-path half of T3.
function treeFixture(t, withPlant) {
  const dir = mkdtempSync(join(tmpdir(), "gate-canary-secret-tree-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "server"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  cpSync(SCANNER, join(dir, "server", "secret-scan.mjs"));
  cpSync(CHECK, join(dir, "scripts", "secret-scan-check.mjs"));
  writeFileSync(join(dir, "src", "clean.mjs"), "export const clean = 1;\n");
  if (withPlant) writeFileSync(join(dir, "src", "planted.mjs"), PLANTED);
  return dir;
}

test("canary: tree scan fails on a planted secret and names the file", (t) => {
  const dir = treeFixture(t, true);
  const result = runGate(join(dir, "scripts", "secret-scan-check.mjs"), [], dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /src\/planted\.mjs/);
  assert.match(result.stderr, /aws-access-key/);
});

test("canary: tree scan passes a clean fixture and reports a non-zero scan count", (t) => {
  const dir = treeFixture(t, false);
  const result = runGate(join(dir, "scripts", "secret-scan-check.mjs"), [], dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const match = /ok — (\d+) files scanned/.exec(result.stdout);
  assert.ok(match, result.stdout);
  assert.ok(Number(match[1]) >= 3, `expected the fixture's files to be scanned, got ${match[1]}`);
});

// Diff fixture: a real git repo; the gate is invoked from the repo so its
// module imports resolve, with cwd at the spaced fixture root.
function diffFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "gate canary secret diff-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "scripts", "clean.mjs"), "export const clean = 1;\n");
  commit(dir, "clean");
  writeFileSync(join(dir, "scripts", "planted.mjs"), PLANTED);
  commit(dir, "planted");
  return dir;
}

test("canary: diff scan --files fails on a planted secret and names the file", (t) => {
  const dir = diffFixture(t);
  const result = runGate(DIFF, ["--files", join(dir, "scripts", "planted.mjs")], dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /scripts\/planted\.mjs/);
  assert.match(result.stdout, /aws-access-key/);
});

test("canary: diff scan --files passes a clean file", (t) => {
  const dir = diffFixture(t);
  const result = runGate(DIFF, ["--files", join(dir, "scripts", "clean.mjs")], dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /secret-scan-diff: clean/);
});

test("canary: an unresolvable base ref widens to a full HEAD tree scan and still finds the plant", (t) => {
  const dir = diffFixture(t);
  const result = runGate(DIFF, ["--base", "canary-nonexistent-ref"], dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /does not resolve; scanning full HEAD tree/);
  assert.match(result.stdout, /scripts\/planted\.mjs/);
});
