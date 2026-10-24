// Gate canary for scripts/ci-changes.mjs (#3681 tranche T1).
//
// The census in lanes/B-3681.md found ZERO full canaries (must-fail fixture +
// control + exit-code assertions) across the gate fleet. This file runs the
// real gate as a subprocess from a fixture directory whose path contains a
// space (the #2886/#3152 spaces-in-path fail-open class):
//   - a diff touching src/ + server/ + a spaced path must enable the
//     browser, eval and coverage suites in GITHUB_OUTPUT;
//   - a docs-only diff must disable all three, explicitly;
//   - an empty selection must still emit explicit false outputs, never
//     silence (zero-target case: the gate is a classifier, so an empty PR
//     diff legitimately selects nothing — what must never happen is a
//     missing output, which downstream jobs read as their default);
//   - a pull_request run with no BASE_SHA/HEAD_SHA and no file list must
//     fail closed (non-zero exit naming the missing inputs), not guess;
//   - a non-PR event runs the full suites (control).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = fileURLToPath(new URL("../scripts/ci-changes.mjs", import.meta.url));

function runGate(t, overrides) {
  const dir = mkdtempSync(join(tmpdir(), "gate canary ci changes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outputFile = join(dir, "github output.txt");
  const env = {
    ...process.env,
    GITHUB_ACTIONS: "",
    EVENT_NAME: "pull_request",
    GITHUB_OUTPUT: outputFile,
    ...overrides,
  };
  delete env.NODE_TEST_CONTEXT;
  if (!("CI_CHANGED_FILES" in overrides)) delete env.CI_CHANGED_FILES;
  if (!("BASE_SHA" in overrides)) delete env.BASE_SHA;
  if (!("HEAD_SHA" in overrides)) delete env.HEAD_SHA;
  const run = spawnSync(process.execPath, [GATE], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: 120000,
  });
  const outputs = existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "";
  return { run, outputs };
}

test("canary: src, server and spaced-path changes enable browser, eval and coverage", (t) => {
  const { run, outputs } = runGate(t, {
    CI_CHANGED_FILES: ["src/board-ui.js", "server/store.mjs", "src/spaced dir/widget.js"].join("\n"),
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(outputs, /^browser=true$/m);
  assert.match(outputs, /^eval=true$/m);
  assert.match(outputs, /^coverage=true$/m);
});

test("canary: docs-only diff disables all three suites explicitly", (t) => {
  const { run, outputs } = runGate(t, {
    CI_CHANGED_FILES: ["docs/INDEX.md", "README.md"].join("\n"),
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(outputs, /^browser=false$/m);
  assert.match(outputs, /^eval=false$/m);
  assert.match(outputs, /^coverage=false$/m);
});

test("canary: empty selection still emits explicit false outputs", (t) => {
  const { run, outputs } = runGate(t, { CI_CHANGED_FILES: "" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(outputs, /^browser=false$/m);
  assert.match(outputs, /^eval=false$/m);
  assert.match(outputs, /^coverage=false$/m);
});

test("canary: pull_request without BASE_SHA/HEAD_SHA fails closed naming the inputs", (t) => {
  const { run } = runGate(t, {});
  assert.notEqual(run.status, 0, "gate must not guess a diff when its inputs are missing");
  assert.match(run.stdout + run.stderr, /BASE_SHA and HEAD_SHA/);
});

test("canary: non-PR events run the full suites", (t) => {
  const { run, outputs } = runGate(t, { EVENT_NAME: "push" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(outputs, /^browser=true$/m);
  assert.match(outputs, /^eval=true$/m);
  assert.match(outputs, /^coverage=true$/m);
});
