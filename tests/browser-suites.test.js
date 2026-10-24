import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BROWSER_SUITE_EXCLUSIONS,
  browserSuiteProblems,
  deriveBrowserSuites,
} from "../scripts/browser-suites.mjs";

// Bug sweep 2026-10-16 lane 14 F1 (#3900): test:browser was a hand-kept
// list that drifted from the disk — four real suites ran in no CI path
// while the required browser gate reported full coverage. The list is now
// derived from disk; this test is the drift gate.
test("package.json test:browser is exactly the disk-derived suite list", () => {
  const problems = browserSuiteProblems();
  assert.deepEqual(problems, [], `browser suite list drift (regenerate: node scripts/browser-suites.mjs --write):\n${problems.join("\n")}`);
});

test("the formerly orphaned suites are wired into the derived list", () => {
  const suites = deriveBrowserSuites(new URL("../scripts", import.meta.url).pathname);
  for (const file of [
    "scripts/activity-feed-browser-check.mjs",
    "scripts/manual-owner-exercise-check.mjs",
    "scripts/message-menu-phone-browser-check.mjs",
    "scripts/refine-draft-browser-check.mjs",
  ]) assert.ok(suites.includes(file), `${file} must stay wired`);
});

test("known-failing suites stay excluded until their issues close", () => {
  // Wiring a red suite would merge a permanently red required gate; the
  // exclusion names the tracking issue instead (#3842). The manual-owner
  // exercise left this list when #3837 closed; it is pinned as wired above.
  assert.match(BROWSER_SUITE_EXCLUSIONS["qa5-a11y-c-browser-check.mjs"], /#3842/);
  const suites = deriveBrowserSuites(new URL("../scripts", import.meta.url).pathname);
  assert.ok(!suites.includes("scripts/qa5-a11y-c-browser-check.mjs"));
  assert.ok(suites.includes("scripts/manual-owner-exercise-check.mjs"));
});

test("derivation: a new check file joins the suite unless explicitly excluded", t => {
  const dir = mkdtempSync(join(tmpdir(), "browser-suites-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scriptsDir = join(dir, "scripts");
  mkdirSync(scriptsDir);
  for (const name of ["a-check.mjs", "b-browser-check.mjs", "qa5-a11y-c-browser-check.mjs", "helper.mjs"])
    writeFileSync(join(scriptsDir, name), "// fixture\n");
  assert.deepEqual(deriveBrowserSuites(scriptsDir), ["scripts/a-check.mjs", "scripts/b-browser-check.mjs"]);
});

test("problems name a suite missing from package.json and a stale exclusion", t => {
  const dir = mkdtempSync(join(tmpdir(), "browser-suites-pkg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scriptsDir = join(dir, "scripts");
  mkdirSync(scriptsDir);
  writeFileSync(join(scriptsDir, "a-check.mjs"), "// fixture\n");
  const packageJsonPath = join(dir, "package.json");
  writeFileSync(packageJsonPath, JSON.stringify({ scripts: { "test:browser": "node --test --test-concurrency=1" } }));
  const problems = browserSuiteProblems({ scriptsDir, packageJsonPath });
  assert.ok(problems.some(problem => problem.includes("suite missing from test:browser: scripts/a-check.mjs")), problems.join("\n"));
  assert.ok(problems.some(problem => problem.includes("exclusion names a file not on disk")), problems.join("\n"));
});

test("durations cover every derived suite (the shard balance gate reads them)", () => {
  const measured = JSON.parse(readFileSync(new URL("../scripts/browser-ci-durations.json", import.meta.url), "utf8")).milliseconds;
  const suites = deriveBrowserSuites(new URL("../scripts", import.meta.url).pathname);
  const missing = suites.filter(file => !(Number.isFinite(measured[file]) && measured[file] > 0));
  assert.deepEqual(missing, [], `suites without measured durations: ${missing.join(", ")}`);
});
