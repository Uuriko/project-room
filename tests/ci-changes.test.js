import test from "node:test";
import assert from "node:assert/strict";
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
  const docsOnly = classifyChanges(["docs/INDEX.md"]);
  assert.equal(docsOnly.browser, false);
  assert.equal(docsOnly.eval, false);
  const serverOnly = classifyChanges(["server/store.mjs"]);
  assert.equal(serverOnly.browser, false);
  assert.equal(serverOnly.eval, true);
});
