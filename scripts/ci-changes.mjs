// Decide which expensive CI suites a pull request actually needs.
//
// GitHub's `on.pull_request.paths` filter looks at the files in the pushing
// commit. Merging main into a branch therefore retriggers every suite whose
// paths main touched, even when the pull request's own diff does not. This
// script classifies `git diff <base>...<head>` (the merge-base / "Files
// changed" diff) instead.
//
// Push, schedule, and workflow_dispatch are not pull requests: both suites
// stay enabled so the main tip still runs the full test matrix.
//
// Outputs (GITHUB_OUTPUT): browser=true|false, eval=true|false, and
// coverage=true|false.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, globSync, readFileSync } from "node:fs";
import { dirname, resolve, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Keep in sync with the `on.pull_request.paths` list in qa2-agent-eval.yml.
const EVAL_PATTERNS = [
  "server/**",
  "src/**",
  "deploy/**",
  "cloudflare/**",
  "server.mjs",
  "scripts/qa2/**",
  "tests/qa2/**",
  "openapi*",
  "package*.json",
];

// There is no src/client/ or public/ tree. The browser suite loads root HTML
// plus src/, and several checks import the repo-root client/ agent modules.
const BROWSER_EXACT = new Set([
  "index.html",
  "join.html",
  "about.html",
  "offers.html",
  "favicon.svg",
  "icon.svg",
  "manifest.webmanifest",
  "push-sw.js",
  "package.json",
  "package-lock.json",
  "scripts/browser-ci.mjs",
  "scripts/browser-shards.mjs",
  "scripts/browser-shards-check.mjs",
  "scripts/browser-ci-durations.json",
  "scripts/test-env.sh",
  "scripts/report-test-failures.mjs",
]);

function globToRegExp(pattern) {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if ("\\^$.|+()[]{}?".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(re + "$");
}

function matchesAny(file, patterns) {
  return patterns.some(pattern => globToRegExp(pattern).test(file));
}

function browserSuitePaths() {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  return String(pkg.scripts?.["test:browser"] ?? "").split(/\s+/).filter(path => path.startsWith("scripts/"));
}

// The browser checks do not only load the files named in the test:browser
// script. Nearly every check creates the real room server (createRoomServer
// from server/http.mjs, a few spawn server.mjs) and imports shared helpers
// that are not themselves suite entries (scripts/acceptance-fixture.mjs,
// scripts/auth-signin.mjs, scripts/room-chrome.mjs, scripts/helpers/*, the
// server/ modules the server serves, …). A change to any of those runs
// against the browser suite, so it must enable it: server code always does
// (checks also reach it through dynamically built import URLs and spawned
// processes that a static scan cannot see), and every other file does when
// it is in the suite files' transitive relative-import closure. Computing
// the closure from the suite itself keeps this correct as helpers are
// added, without enabling the suite for unrelated scripts.
const IMPORT_RES = [
  /\bimport\s+(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+[^'"`;]*?\s+from\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];
const CODE_EXTS = [".js", ".mjs", ".cjs"];

function resolveImport(fromFile, spec) {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const base = resolve(root, dirname(fromFile), spec.split(/[?#]/)[0]);
  const candidates = [base, ...CODE_EXTS.map(ext => base + ext), ...CODE_EXTS.map(ext => resolve(base, `index${ext}`))];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return relative(root, candidate).split("\\").join("/");
  }
  return null;
}

// Transitive relative-import closure from a set of root files: every file
// reachable by following import/export-from/dynamic-import specifiers that
// resolve inside the tree. Shared by the browser and coverage classifiers.
function importClosure(roots) {
  const deps = new Set(roots);
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const file = queue.shift();
    if (!CODE_EXTS.some(ext => file.endsWith(ext))) continue;
    let source;
    try {
      source = readFileSync(resolve(root, file), "utf8");
    } catch {
      continue; // A root entry that is not on disk contributes no imports.
    }
    for (const re of IMPORT_RES) {
      re.lastIndex = 0;
      for (const match of source.matchAll(re)) {
        const target = resolveImport(file, match[1]);
        if (!target || target.startsWith("../")) continue;
        deps.add(target);
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
  }
  return deps;
}

let cachedBrowserDeps = null;

function browserDependencyPaths(suite) {
  const key = suite.join("\n");
  if (cachedBrowserDeps?.key === key) return cachedBrowserDeps.deps;
  const deps = importClosure(suite);
  cachedBrowserDeps = { key, deps };
  return deps;
}

export function classifyChanges(files, suite = browserSuitePaths()) {
  let deps = null;
  const browser = files.some(file => {
    if (
      BROWSER_EXACT.has(file) ||
      file === "server.mjs" ||
      file.startsWith("server/") ||
      file.startsWith("src/") ||
      file.startsWith("og/") ||
      file.startsWith("client/") ||
      suite.includes(file)
    ) {
      return true;
    }
    deps ??= browserDependencyPaths(suite);
    return deps.has(file);
  });
  const evalSuite = files.some(file => matchesAny(file, EVAL_PATTERNS));
  return { browser, eval: evalSuite, coverage: coverageRelevant(files) };
}

// The per-module coverage ratchet (test.yml `coverage` job) measures line
// coverage of server/, src/, machine/ from the root `node --test` suite.
// A pull request whose merge-base diff touches none of these can not move
// the verdict, so the suite re-run is skipped (the `test` merge gate treats
// the intentional skip as success, mirroring the browser skip). Anything
// that can move the verdict forces a run: measured source, the tests that
// execute it, new test-discoverable scripts (node --test picks up
// **/{test,test/**/*,test-*,*[._-]test}), and the gate's own config, script,
// classifier, and workflow.
//
// The flat prefix list alone had blind spots (bug sweep 2026-10-16 lane 14
// F2, issue #3901): files the root suite executes that sit in none of the
// measured prefixes — package.json / package-lock.json (dependency versions
// and `imports` remaps change which measured lines execute), server.mjs
// (the root entry point suites spawn; it is in no measured directory), and
// scripts/*.mjs helpers the tests import but that are not themselves
// test-discoverable (scripts/acceptance-fixture.mjs drives the store
// through the acceptance scenarios). The exact list covers the first two;
// the import closure from every Node-discovered test file covers the third
// the same way the browser classifier above covers its helpers, so a helper
// added tomorrow is classified by reachability, not by a hand-kept list.
const COVERAGE_EXACT = new Set([
  "coverage-thresholds.json",
  "scripts/coverage-thresholds.mjs",
  "scripts/ci-changes.mjs",
  ".github/workflows/test.yml",
  "package.json",
  "package-lock.json",
  "server.mjs",
]);

function isTestDiscoverableScript(file) {
  if (!file.startsWith("scripts/")) return false;
  const base = basename(file);
  return base.startsWith("test-") || /[._-]test\.(js|mjs|cjs)$/.test(base);
}

// Node's default test discovery from the repo root — the same pattern
// scripts/unit-shards.mjs (discoverUnitTests) uses to build the unit plan,
// so the closure is seeded from exactly the files the measured suite runs.
function discoverTestFiles() {
  const extensions = process.features?.typescript === false ? "js,mjs,cjs" : "js,mjs,cjs,ts,mts,cts";
  const pattern = `**/{test,test/**/*,test-*,*[._-]test}.{${extensions}}`;
  return globSync(pattern, { cwd: root, exclude: name => name.split(/[\\/]/).includes("node_modules") }).sort();
}

let cachedCoverageDeps = null;

function coverageDependencyPaths() {
  cachedCoverageDeps ??= importClosure(discoverTestFiles());
  return cachedCoverageDeps;
}

function coverageRelevant(files) {
  let deps = null;
  return files.some(file => {
    if (
      file.startsWith("server/") ||
      file.startsWith("src/") ||
      file.startsWith("machine/") ||
      file.startsWith("tests/") ||
      COVERAGE_EXACT.has(file) ||
      isTestDiscoverableScript(file)
    ) {
      return true;
    }
    deps ??= coverageDependencyPaths();
    return deps.has(file);
  });
}

function diffNames(base, head) {
  const out = execFileSync("git", ["diff", "--name-status", "--find-renames", "-z", `${base}...${head}`], { cwd: root }).toString("utf8");
  const parts = out.split("\0").filter(part => part !== "");
  const names = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    const next = () => {
      const name = parts[++i];
      if (!name) throw new Error(`truncated git diff near ${status}`);
      return name;
    };
    if (status.startsWith("R") || status.startsWith("C")) names.push(next(), next());
    else names.push(next());
  }
  return names;
}

function setOutput(name, value) {
  const line = `${name}=${value}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  console.log(`ci-changes: ${name}=${value}`);
}

function changedFiles() {
  if (!process.env.GITHUB_ACTIONS && process.env.CI_CHANGED_FILES != null) {
    return process.env.CI_CHANGED_FILES.split("\n").filter(Boolean);
  }
  const base = process.env.BASE_SHA;
  const head = process.env.HEAD_SHA;
  if (!base || !head) throw new Error("pull_request classification needs BASE_SHA and HEAD_SHA");
  return diffNames(base, head);
}

function main() {
  if (process.env.EVENT_NAME !== "pull_request") {
    setOutput("browser", "true");
    setOutput("eval", "true");
    setOutput("coverage", "true");
    console.log(`ci-changes: event ${process.env.EVENT_NAME || "(unset)"} runs the full suites`);
    return;
  }
  const files = changedFiles();
  const result = classifyChanges(files);
  console.log(`ci-changes: ${files.length} file(s) versus merge base`);
  for (const file of files.slice(0, 40)) console.log(`  ${file}`);
  if (files.length > 40) console.log(`  … ${files.length - 40} more`);
  setOutput("browser", result.browser ? "true" : "false");
  setOutput("eval", result.eval ? "true" : "false");
  setOutput("coverage", result.coverage ? "true" : "false");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
