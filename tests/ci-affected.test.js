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
  addServedClientEdges,
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


test("served client changes account for all seven affected work checks, including budget omissions", () => {
  const plan = selectAffectedBrowser(["src/app.js"]);
  const names = ["action-recovery", "assisted-work", "draft-return", "native-result", "refine-draft", "visual-regression", "work-reuse"];
  const accounted = [...plan.selected, ...plan.omitted].map(row => row.test);
  for (const name of names) assert.ok(accounted.includes(`scripts/${name}-browser-check.mjs`), name);
  assert.equal(new Set(accounted).size, accounted.length);
  assert.ok(plan.omitted.length > 0, "bounded selection must disclose related checks that did not fit");
  for (const row of plan.omitted) assert.equal(plan.files.includes(row.test), false);
  assert.equal(plan.coverage, "affected");
  assert.equal(plan.budgetMs, 600000);
});

test("served edges follow HTML assets and room fixtures, excluding unrelated Playwright pages", () => {
  const sources = {
    "index.html": '<script src="./src/entry.js"></script><link href="./src/styles.css" rel="stylesheet">',
    "scripts/room.mjs": 'import { chromium } from "playwright";',
    "scripts/unrelated.mjs": 'import { chromium } from "playwright";',
  };
  const reverse = new Map([["server/http.mjs", new Set(["scripts/fixture.mjs"])],
    ["scripts/fixture.mjs", new Set(["scripts/room.mjs"])]]);
  addServedClientEdges({ reverse, read: file => sources[file], known: new Set([...Object.keys(sources), "src/entry.js", "src/styles.css"]),
    codeFiles: ["scripts/room.mjs", "scripts/unrelated.mjs"] });
  assert.deepEqual([...reverse.get("src/entry.js")], ["index.html"]);
  assert.deepEqual([...reverse.get("src/styles.css")], ["index.html"]);
  assert.deepEqual([...reverse.get("index.html")], ["scripts/room.mjs"]);
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
