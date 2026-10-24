// Gate canary for scripts/check-workflow-pins.mjs (#3681 tranche T4).
//
// Runs the real gate as a subprocess with its cwd inside a fixture tree
// under a spaced path (the gate scans .github/workflows + .github/actions
// under the cwd). Must-fail fixtures assert a non-zero exit AND that the
// output names the planted target; the control asserts zero.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = fileURLToPath(new URL("../scripts/check-workflow-pins.mjs", import.meta.url));
const SHA = "11d5960a326750d5838078e36cf38b85af677262";

function fixture(t, workflowBody) {
  const dir = mkdtempSync(join(tmpdir(), "gate canary pins-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", "canary.yml"), workflowBody);
  return dir;
}

function runGate(dir) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [GATE], { cwd: dir, env, encoding: "utf8", timeout: 60000 });
}

const workflow = (uses) =>
  ["name: canary", "on: [push]", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", `      - uses: ${uses}`, ""].join("\n");

test("canary: a tag-pinned uses ref fails and the output names the target", (t) => {
  const run = runGate(fixture(t, workflow("actions/checkout@v4")));
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /UNPINNED/);
  assert.match(run.stderr, /canary\.yml/);
  assert.match(run.stderr, /actions\/checkout@v4/);
});

test("canary: a full-SHA-pinned workflow passes", (t) => {
  const run = runGate(fixture(t, workflow(`actions/checkout@${SHA}`)));
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /all refs pinned/);
});

test("canary: an unparsable workflow fails naming the file instead of passing silently", (t) => {
  const run = runGate(fixture(t, "jobs: [unclosed\n"));
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /canary\.yml/);
});
