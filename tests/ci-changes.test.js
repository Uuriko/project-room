import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { classifyChanges } from "../scripts/ci-changes.mjs";

test("coverage runs when measured source modules change", () => {
  assert.equal(classifyChanges(["server/store.mjs"]).coverage, true);
  assert.equal(classifyChanges(["src/board-ui.js"]).coverage, true);
  assert.equal(classifyChanges(["machine/test/machine.test.mjs"]).coverage, true);
});

test("coverage runs when test files change (they feed the measurement)", () => {
  assert.equal(classifyChanges(["tests/store.test.js"]).coverage, true);
});

test("coverage runs when the gate's own config, script, classifier, or workflow changes", () => {
  assert.equal(classifyChanges(["coverage-thresholds.json"]).coverage, true);
  assert.equal(classifyChanges(["scripts/coverage-thresholds.mjs"]).coverage, true);
  assert.equal(classifyChanges(["scripts/ci-changes.mjs"]).coverage, true);
  assert.equal(classifyChanges([".github/workflows/test.yml"]).coverage, true);
});

test("coverage runs when a new test-discoverable script is added", () => {
  // node --test discovers **/{test,test/**/*,test-*,*[._-]test}: a new
  // scripts/*test* file executes and can move module coverage.
  assert.equal(classifyChanges(["scripts/load-test.mjs"]).coverage, true);
  assert.equal(classifyChanges(["scripts/check-smoke-test.mjs"]).coverage, true);
});

test("coverage skips when the diff cannot move module line coverage", () => {
  assert.equal(classifyChanges(["docs/INDEX.md"]).coverage, false);
  assert.equal(classifyChanges(["scripts/deploy-prod.mjs"]).coverage, false);
  assert.equal(classifyChanges(["README.md", "docs/ROOM-API.md"]).coverage, false);
  assert.equal(classifyChanges([".github/workflows/qa2-agent-eval.yml"]).coverage, false);
});

test("coverage classification does not disturb the browser/eval outputs", () => {
  const docsOnly = classifyChanges(["CONTRIBUTING.md"]);
  assert.equal(docsOnly.browser, false);
  assert.equal(docsOnly.eval, false);
  const serverOnly = classifyChanges(["server/store.mjs"]);
  assert.equal(serverOnly.browser, true);
  assert.equal(serverOnly.eval, true);
});

test("browser runs for server journeys, imported fixtures, and unknown inputs", () => {
  for (const file of ["docs/legal/terms.md", "docs/agents/codex.md", "docs/CODEX-ROOM-HOST.md", "server/http.mjs", "server/work-claims.mjs", "server.mjs", "scripts/a11y-axe-helper.mjs", "scripts/helpers/google-oauth-fixture.mjs", "scripts/acceptance-fixture.mjs", "deploy/room-entry.mjs", "strings/en.js", "tests/fixtures/new-case.json", "future-runtime/input.bin"]) {
    assert.equal(classifyChanges([file]).browser, true, file);
  }
});

test("browser skips genuine documentation-only diffs but runs mixed changes", () => {
  const docs = ["README.md", "CONTRIBUTING.md", "docs/INDEX.md", "docs/history/receipt.txt"];
  assert.equal(classifyChanges(docs).browser, false);
  assert.equal(classifyChanges([...docs, "server/http.mjs"]).browser, true);
  assert.equal(classifyChanges(["scripts/fixtures/README.md"]).browser, true, "documentation-shaped fixture is not a docs-only change");
});

// Exercise the workflow-facing output, including its existing fail-open-to-run
// contract: only successful classification can emit an intentional false.
test("CI CLI emits browser skips only for classified docs and fails safely on unknown filters", t => {
  const dir = mkdtempSync(join(tmpdir(), "ci-change-plan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "scripts"));
  cpSync("scripts/ci-changes.mjs", join(dir, "scripts/ci-changes.mjs"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { "test:browser": "node --test scripts/journey.mjs" } }));
  const env = { ...process.env, EVENT_NAME: "pull_request" };
  for (const key of ["GITHUB_ACTIONS", "GITHUB_OUTPUT", "CI_CHANGED_FILES", "BASE_SHA", "HEAD_SHA"]) delete env[key];
  const invoke = more => spawnSync(process.execPath, ["scripts/ci-changes.mjs"], { cwd: dir, env: { ...env, ...more }, encoding: "utf8", timeout: 5000 });
  const docs = invoke({ CI_CHANGED_FILES: "docs/history/receipt.txt\nCONTRIBUTING.md" });
  assert.equal(docs.status, 0, docs.stderr);
  assert.match(docs.stdout, /browser=false/);
  for (const file of ["server/http.mjs", "scripts/a11y-axe-helper.mjs", "future-runtime/input.bin"]) {
    const result = invoke({ CI_CHANGED_FILES: file });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /browser=true/);
  }
  const unknownEvent = invoke({ EVENT_NAME: "merge_group" });
  assert.equal(unknownEvent.status, 0, unknownEvent.stderr);
  assert.match(unknownEvent.stdout, /browser=true/);
  for (const more of [{}, { BASE_SHA: "not-a-commit", HEAD_SHA: "also-unknown" }]) {
    const failed = invoke(more);
    assert.notEqual(failed.status, 0);
    assert.doesNotMatch(failed.stdout, /browser=false/);
  }
  writeFileSync(join(dir, "package.json"), "{}");
  const missingSuite = invoke({ CI_CHANGED_FILES: "README.md" });
  assert.notEqual(missingSuite.status, 0);
  assert.doesNotMatch(missingSuite.stdout, /browser=false/);
});
