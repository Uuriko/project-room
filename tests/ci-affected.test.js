// Pull-request selection must keep the safety net when the diff does not
// name those tests. The budget inside selectTests can drop a slow file; the
// union in scripts/ci-affected.mjs puts it back.
import test from "node:test";
import assert from "node:assert/strict";
import { browserPlan } from "../scripts/browser-shards.mjs";
import { canonicalBrowserScript } from "../scripts/browser-suites.mjs";
import {
  isSafetyBrowser,
  isSafetyUnitTest,
  selectAffectedBrowser,
  selectAffectedUnit,
  withSafety,
} from "../scripts/ci-affected.mjs";

test("the safety net is a union, and a docs-only diff still selects it", () => {
  assert.equal(isSafetyUnitTest("tests/perf-budget.test.js"), true);
  assert.equal(isSafetyUnitTest("tests/invariants/harness-smoke.test.mjs"), true);
  assert.equal(isSafetyUnitTest("tests/public-work-stranger-journey.test.js"), true);
  assert.equal(isSafetyUnitTest("tests/design-tokens-lint.test.js"), true);
  assert.equal(isSafetyUnitTest("tests/events.test.js"), false);

  const once = withSafety(
    [{ test: "tests/perf-budget.test.js", distance: 1, via: "imports server/http.mjs", ms: 1 }],
    ["tests/perf-budget.test.js", "tests/ux-copy.test.js"],
  );
  assert.equal(once.filter(row => row.test === "tests/perf-budget.test.js").length, 1);
  assert.equal(once.some(row => row.test === "tests/ux-copy.test.js" && row.via === "safety net"), true);

  const changed = ["docs/RELEASE-MERGE-GATE.md"];
  const unit = selectAffectedUnit(changed);
  for (const file of [
    "tests/perf-budget.test.js",
    "tests/invariants/harness-smoke.test.mjs",
    "tests/public-work-stranger-journey.test.js",
    "tests/journey-coverage.test.js",
    "tests/design-tokens-lint.test.js",
    "tests/ux-copy.test.js",
  ]) assert.ok(unit.files.includes(file), file);

  const browser = selectAffectedBrowser(changed);
  const required = browserPlan(canonicalBrowserScript()).files.filter(isSafetyBrowser);
  assert.ok(required.length > 0);
  for (const file of required) assert.ok(browser.files.includes(file), file);
  const placed = browser.plan.shards.flatMap(shard => shard.files);
  assert.equal(new Set(placed).size, placed.length);
  assert.deepEqual(placed.toSorted(), [...browser.files].toSorted());
});
