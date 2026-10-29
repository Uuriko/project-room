// Pull-request selection for the unit and browser suites.
//
// The full suites stay on main, the merge queue (the landing batch), schedule,
// and workflow_dispatch. A pull request runs the tests related to its diff,
// capped by the same CI-time budget verify:affected uses, and always runs the
// safety net: story tests, the rule-check unit tests, and the page-weight
// test. Browser journey checks are the story tests on that suite. Timing data
// places files onto shards; it does not drop a safety-net file.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { browserPlan } from "./browser-shards.mjs";
import { canonicalBrowserScript } from "./browser-suites.mjs";
import { discoverUnitTests } from "./unit-shards.mjs";
import { buildReverseGraph, changedFiles, parseGitPathList, parseImports, resolveSpecifier, selectTests } from "./verify-affected.mjs";

const root = resolve(import.meta.dirname, "..");
const CODE_EXT = new Set([".js", ".mjs", ".cjs"]);
const UNIT_BUDGET_SECONDS = 300;
export const BROWSER_AFFECTED_BUDGET_MS = 10 * 60 * 1000;

const RULE_UNIT_TESTS = [
  "tests/design-tokens-lint.test.js",
  "tests/design-tokens.test.js",
  "tests/design-tokens-css-sync.test.js",
  "tests/ux-copy.test.js",
  "tests/antislop-ui-batch.test.js",
  "tests/untested-modules-lint.test.js",
];

export function isStoryUnitTest(file) {
  return (file.startsWith("tests/invariants/") && file.endsWith(".test.mjs"))
    || /journey\.test\.(?:js|mjs)$/.test(file)
    || file === "tests/journey-coverage.test.js";
}

export function isPageWeightTest(file) {
  return file === "tests/perf-budget.test.js";
}

export function isRuleUnitTest(file) {
  return RULE_UNIT_TESTS.includes(file);
}

export function isSafetyUnitTest(file) {
  return isStoryUnitTest(file) || isPageWeightTest(file) || isRuleUnitTest(file);
}

export function isSafetyBrowser(file) {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return base.endsWith("journey-check.mjs") || base === "auth-journeys-browser-check.mjs";
}

export function withSafety(selected, required, estimate = () => 0) {
  const have = new Set(selected.map(row => row.test));
  const out = selected.slice();
  for (const test of required) {
    if (have.has(test)) continue;
    have.add(test);
    out.push({ test, distance: 0, via: "safety net", ms: estimate(test) });
  }
  return out;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function loadTimings(name) {
  return JSON.parse(readFileSync(join(root, "scripts", name), "utf8")).milliseconds ?? {};
}

function graph(cwd, changed) {
  const tracked = parseGitPathList(git(["ls-files"], cwd));
  const known = new Set([...tracked, ...changed.filter(file => existsSync(join(cwd, file)))]);
  const cache = new Map();
  const read = file => {
    if (!cache.has(file)) cache.set(file, readFileSync(join(cwd, file), "utf8"));
    return cache.get(file);
  };
  const codeFiles = [...known].filter(file => CODE_EXT.has(extname(file)) && !file.startsWith("node_modules/") && existsSync(join(cwd, file)));
  return { read, known, codeFiles, reverse: buildReverseGraph(codeFiles, read, known) };
}

function repoRelativeTests(cwd) {
  const files = discoverUnitTests(cwd).filter(file => !file.includes("node_modules"));
  if (cwd === ".") return files;
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return files.map(file => (file.startsWith(prefix) ? file.slice(prefix.length) : file));
}

export function selectAffectedUnit(changed, cwd = root) {
  const tests = repoRelativeTests(cwd);
  const { read, reverse } = graph(cwd, changed);
  const timings = loadTimings("unit-ci-durations.json");
  const workers = Math.max(1, availableParallelism() - 1);
  const picked = selectTests({
    changed, tests, reverse, read, timings,
    budgetMs: UNIT_BUDGET_SECONDS * 1000 * workers,
  });
  const estimate = file => (Number.isFinite(timings[file]) && timings[file] > 0 ? timings[file] : 15000);
  const selected = withSafety(picked.selected, tests.filter(isSafetyUnitTest), estimate);
  return { changed, selected, files: selected.map(row => row.test) };
}

export function affectedUnitFiles(base, cwd = root) {
  if (!base) throw new Error("affected unit selection needs a base revision");
  return selectAffectedUnit(changedFiles(base, cwd), cwd);
}

// Browser checks load the client over HTTP, so their Node imports cannot
// describe the served HTML -> client module relationship. Conservatively
// connect Playwright consumers (and their importers) to the room entry page.
export function addServedClientEdges({ reverse, read, known, codeFiles }) {
  const edge = (dependency, consumer) => {
    if (!reverse.has(dependency)) reverse.set(dependency, new Set());
    reverse.get(dependency).add(consumer);
  };
  if (!known.has("index.html")) return;
  for (const match of read("index.html").matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/g)) {
    const target = resolveSpecifier("index.html", match[1], known);
    if (target) edge(target, "index.html");
  }
  const roomConsumers = new Set(["server/http.mjs"]);
  for (const file of roomConsumers) {
    for (const importer of reverse.get(file) ?? []) roomConsumers.add(importer);
  }
  for (const file of codeFiles) {
    if (roomConsumers.has(file) && [...parseImports(read(file))].some(spec => /^(?:playwright|@playwright\/test)(?:\/|$)/.test(spec))) {
      edge("index.html", file);
    }
  }
}

export function selectAffectedBrowser(changed, cwd = root) {
  const script = canonicalBrowserScript();
  const suite = browserPlan(script).files;
  const dependencies = graph(cwd, changed);
  addServedClientEdges(dependencies);
  const { read, reverse } = dependencies;
  const timings = loadTimings("browser-ci-durations.json");
  const picked = selectTests({
    changed, tests: suite, reverse, read, timings,
    budgetMs: BROWSER_AFFECTED_BUDGET_MS,
    smoke: [],
  });
  const estimate = file => (Number.isFinite(timings[file]) && timings[file] > 0 ? timings[file] : 10000);
  const selected = withSafety(picked.selected, suite.filter(isSafetyBrowser), estimate);
  const have = new Set(selected.map(row => row.test));
  const files = suite.filter(file => have.has(file));
  if (!files.length) throw new Error("Refusing an empty affected browser suite");
  const omitted = picked.skipped.filter(row => !have.has(row.test));
  return { changed, files, selected, omitted, coverage: "affected", budgetMs: BROWSER_AFFECTED_BUDGET_MS,
    plan: browserPlan(script, { only: files }) };
}

export function affectedBrowserFiles(base, cwd = root) {
  if (!base) throw new Error("affected browser selection needs a base revision");
  return selectAffectedBrowser(changedFiles(base, cwd), cwd);
}

function runNodeTests(files) {
  if (!files.length) throw new Error("Refusing an empty safety-net run");
  const result = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--run-stories")) {
    const files = repoRelativeTests(root).filter(isStoryUnitTest);
    console.log(`safety net: ${files.length} story test file(s)`);
    return runNodeTests(files);
  }
  if (argv.includes("--run-page-weight")) {
    console.log("safety net: page weight");
    return runNodeTests(["tests/perf-budget.test.js"]);
  }
  if (argv.includes("--list-unit")) {
    const base = argv.find(arg => arg.startsWith("--base="))?.slice(7) || "origin/main";
    const plan = affectedUnitFiles(base);
    for (const row of plan.selected) console.log(`${row.test}  (${row.via})`);
    return;
  }
  throw new Error("Usage: ci-affected.mjs --run-stories | --run-page-weight | --list-unit [--base=ref]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
