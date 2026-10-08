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
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
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

export function classifyChanges(files, suite = browserSuitePaths()) {
  const browser = files.some(file => BROWSER_EXACT.has(file) || file.startsWith("src/") || file.startsWith("og/") || file.startsWith("client/") || suite.includes(file));
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
const COVERAGE_EXACT = new Set([
  "coverage-thresholds.json",
  "scripts/coverage-thresholds.mjs",
  "scripts/ci-changes.mjs",
  ".github/workflows/test.yml",
]);

function isTestDiscoverableScript(file) {
  if (!file.startsWith("scripts/")) return false;
  const base = basename(file);
  return base.startsWith("test-") || /[._-]test\.(js|mjs|cjs)$/.test(base);
}

function coverageRelevant(files) {
  return files.some(
    file =>
      file.startsWith("server/") ||
      file.startsWith("src/") ||
      file.startsWith("machine/") ||
      file.startsWith("tests/") ||
      COVERAGE_EXACT.has(file) ||
      isTestDiscoverableScript(file)
  );
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
