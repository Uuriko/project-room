// Regression tests for #3682: the whole-tree secret scan
// (scripts/secret-scan-check.mjs) must judge a PR against its merge
// base, not against a moving main — and it must work from a checkout
// path containing spaces.
//
// Complement to the #3681 T3 canary (tests/gate-canary-secret-scan.test.js):
// the canary pins the absolute tree scan and the diff gate, and had to
// DROP its spaced-path tree fixture because the gate derived its root
// via `new URL("..", import.meta.url).pathname` (kept %20 escapes, so a
// spaced path crashed ENOENT and scanned nothing). The spaced fixtures
// below pin the fileURLToPath fix; the git fixtures pin the
// base-relative verdict: an unrelated main commit carrying a
// scanner-visible string must not flip a clean PR's verdict (#3543
// shape), while a secret the PR itself adds still fails.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECK = fileURLToPath(new URL("../scripts/secret-scan-check.mjs", import.meta.url));
const SCANNER = fileURLToPath(new URL("../server/secret-scan.mjs", import.meta.url));
// Planted keys are assembled at run time so this file never contains a
// scanner-visible literal (the diff gate scans added lines, tests too).
const MAIN_PLANT = ["AKIA", "1234567890ABCDEF"].join("");
const PR_PLANT = ["AKIA", "FEDCBA0987654321"].join("");
const plantFile = (key) => `export const FIXTURE_KEY = "${key}";\n`;

function runGate(script, args, cwd) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.GITHUB_EVENT_NAME;
  delete env.SECRET_SCAN_BASE_REF;
  delete env.SECRET_SCAN_ROOT;
  return spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8", timeout: 60000 });
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(cwd, message) {
  git(cwd, ["add", "-A"]);
  git(cwd, ["-c", "user.email=base-relative@example.invalid", "-c", "user.name=base-relative", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
}

function layout(dir) {
  mkdirSync(join(dir, "server"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  cpSync(SCANNER, join(dir, "server", "secret-scan.mjs"));
  cpSync(CHECK, join(dir, "scripts", "secret-scan-check.mjs"));
}

// A spaced-path git repo shaped like the #3543 incident:
//   C0 clean base ──► mainline commit C1 carrying a planted secret
//        └──► PR branch: one clean file, then a merge of mainline
// The PR tree therefore CONTAINS main's plant (as a PR merge checkout
// does) without the PR having introduced it.
function repoFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "secret scan base-relative-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  layout(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "src", "clean.mjs"), "export const clean = 1;\n");
  commit(dir, "clean base");
  git(dir, ["checkout", "-q", "-b", "mainline"]);
  writeFileSync(join(dir, "src", "main-plant.mjs"), plantFile(MAIN_PLANT));
  commit(dir, "unrelated main commit carrying a scanner-visible string");
  git(dir, ["checkout", "-q", "-b", "pr", "main"]);
  writeFileSync(join(dir, "src", "pr-clean.mjs"), "export const pr = 1;\n");
  commit(dir, "clean PR change");
  git(dir, ["-c", "user.email=base-relative@example.invalid", "-c", "user.name=base-relative", "merge", "-q", "--no-edit", "mainline"]);
  return dir;
}

test("regression #3682: an unrelated main plant does not flip a clean PR's base-relative verdict", (t) => {
  const dir = repoFixture(t);
  const result = runGate(join(dir, "scripts", "secret-scan-check.mjs"), ["--base", "mainline"], dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /no new findings vs base/);
  assert.match(result.stdout, /1 pre-existing finding\(s\) at base ignored/);
});

test("control: the same PR tree fails an absolute scan on main's plant (the old verdict)", (t) => {
  const dir = repoFixture(t);
  const result = runGate(join(dir, "scripts", "secret-scan-check.mjs"), [], dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /src\/main-plant\.mjs/);
  assert.match(result.stderr, /aws-access-key/);
});

test("base-relative verdict still fails on a secret the PR itself adds", (t) => {
  const dir = repoFixture(t);
  writeFileSync(join(dir, "src", "pr-plant.mjs"), plantFile(PR_PLANT));
  commit(dir, "PR adds its own secret");
  const result = runGate(join(dir, "scripts", "secret-scan-check.mjs"), ["--base", "mainline"], dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /src\/pr-plant\.mjs/);
  assert.doesNotMatch(result.stderr, /main-plant\.mjs/);
});

test("an explicit --base that cannot be scanned is fail-closed (exit 2)", (t) => {
  const dir = repoFixture(t);
  const result = runGate(join(dir, "scripts", "secret-scan-check.mjs"), ["--base", "no-such-ref-anywhere"], dir);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /could not scan the base tree/);
});

// The spaced-path tree fixtures the #3681 T3 canary had to drop: the
// gate's root derivation must decode the checkout path, not crash on it.
function treeFixture(t, withPlant) {
  const dir = mkdtempSync(join(tmpdir(), "secret scan tree-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  layout(dir);
  writeFileSync(join(dir, "src", "clean.mjs"), "export const clean = 1;\n");
  if (withPlant) writeFileSync(join(dir, "src", "planted.mjs"), plantFile(MAIN_PLANT));
  return dir;
}

test("spaced path: tree scan passes a clean fixture and reports a non-zero scan count", (t) => {
  const dir = treeFixture(t, false);
  const result = runGate(join(dir, "scripts", "secret-scan-check.mjs"), [], dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const match = /ok — (\d+) files scanned/.exec(result.stdout);
  assert.ok(match, result.stdout);
  assert.ok(Number(match[1]) >= 3, `expected the fixture's files to be scanned, got ${match[1]}`);
});

test("spaced path: tree scan fails on a planted secret and names the file", (t) => {
  const dir = treeFixture(t, true);
  const result = runGate(join(dir, "scripts", "secret-scan-check.mjs"), [], dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /src\/planted\.mjs/);
  assert.match(result.stderr, /aws-access-key/);
});
