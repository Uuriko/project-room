// Pull-request selection must keep the safety net when the diff does not
// name those tests. The budget inside selectTests can drop a slow file; the
// union in scripts/ci-affected.mjs puts it back.
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBrowserSelection } from "../scripts/browser-ci.mjs";
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


test("shared browser changes run every check, including slow and indirectly loaded suites", () => {
  const full = browserPlan(canonicalBrowserScript());
  for (const file of ["src/app.js", "index.html", "server/http.mjs", "scripts/runtime-package.mjs"]) {
    const selection = selectAffectedBrowser([file]);
    assert.equal(selection.coverage, "full", file);
    assert.deepEqual(selection.files, full.files, file);
    assert.equal(selection.plan.planHash, full.planHash, file);
    assert.deepEqual(selection.omitted, [], file);
    assert.equal(selection.budgetMs, null, file);
  }
});

test("a change isolated to a browser check still uses targeted selection", () => {
  const file = "scripts/updates-browser-check.mjs";
  const selection = selectAffectedBrowser([file]);
  assert.equal(selection.coverage, "affected");
  assert.ok(selection.files.includes(file));
  assert.ok(selection.files.length < browserPlan(canonicalBrowserScript()).files.length);
  assert.equal(selection.budgetMs, null);
});

test("browser evidence persists affected scope and omissions even for an empty shard", t => {
  const dir = mkdtempSync(join(tmpdir(), "browser-selection-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const selected = [{ test: "scripts/selected.mjs", via: "changed", ms: 1 }];
  const omitted = [{ test: "scripts/omitted.mjs", via: "imports src/app.js", ms: 700000, reason: "slow_check_limit" }];
  const selection = { scope: "affected", base: "base-sha", changed: ["src/app.js"], budgetMs: 600000, selected, omitted };
  const path = join(dir, "selection.json");
  writeBrowserSelection({ files: [selected[0].test], shards: [{ files: [] }], planHash: "plan", selection }, path, "head-sha");
  const actual = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(actual, { schemaVersion: 1, revision: "head-sha", planHash: "plan", ...selection });
  assert.equal(Object.hasOwn(actual, "status"), false, "selection is not proof of execution");
  assert.equal(writeBrowserSelection({ files: [], planHash: "empty" }, path).scope, "full");
});

test("a browser suite addition always runs the directory-derived registration rule", () => {
  const plan = selectAffectedUnit(["scripts/public-work-availability-browser-check.mjs"]);
  assert.ok(plan.files.includes("tests/browser-suites.test.js"),
    "a new browser file changes the dynamic suite registry even without a static import");
});
