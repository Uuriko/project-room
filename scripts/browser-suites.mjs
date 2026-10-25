// Derive the browser suite list from disk (bug sweep 2026-10-16 lane 14
// F1, issue #3900).
//
// `test:browser` used to be a hand-maintained list in package.json. It
// drifted: real suites sat on disk in no CI path at all (activity-feed,
// message-menu-phone, refine-draft) while the required `browser` gate
// reported full coverage, and one known-red suite (qa5-a11y-c) was
// invisible to the gate that would have noticed. The list is the files
// on disk: every scripts/*-check.mjs is in the suite unless it is named
// in BROWSER_SUITE_EXCLUSIONS below with the reason it runs elsewhere
// (or nowhere, said out loud). package.json's test:browser is
// `node scripts/browser-suites.mjs --run`, which executes that
// derivation. tests/browser-suites.test.js fails CI when the npm script
// stops pointing at this runner, or when an exclusion names a file that
// is not on disk. Adding a check file joins the suite unless it is
// excluded here with a reason a reviewer can check.
//
// Run the suite: npm run test:browser
// Print the derived node --test command: node scripts/browser-suites.mjs
// Verify exclusions and the npm script: node scripts/browser-suites.mjs --check
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// npm script. CI resolves this to the derived `node --test` command.
// An explicit `node --test ...` string is still accepted so shard
// fixtures can supply their own file list.
export const BROWSER_RUN_COMMAND = "node scripts/browser-suites.mjs --run";

// Every scripts/*-check.mjs that is NOT a browser-job suite, and why.
// A reason names the gate or workflow that runs the file instead, or
// states plainly that nothing runs it — an unwired file must be a visible
// decision here, never an accident of a hand-kept list elsewhere.
export const BROWSER_SUITE_EXCLUSIONS = {
  // John deferred the private email workspace from v1.
  "gmail-setup-browser-check.mjs": "Deferred email workspace; retained only for future reconsideration, not run in v1",
  "gmail-workspace-browser-check.mjs": "Deferred email workspace; retained only for future reconsideration, not run in v1",
  "inbox-unified-check.mjs": "Deferred email workspace; retained only for future reconsideration, not run in v1",
  "inbox-collaboration-check.mjs": "Deferred email workspace; retained only for future reconsideration, not run in v1",
  "inbox-quarantine-review-check.mjs": "Deferred email workspace; retained only for future reconsideration, not run in v1",
  "inbox-telegram-check.mjs": "Deferred email workspace; retained only for future reconsideration, not run in v1",
  "inbox-conversation-browser-check.mjs": "Deferred email workspace; retained only for future reconsideration, not run in v1",
  "inbox-browser-check.mjs": "Deferred email workspace; retained only for future reconsideration, not run in v1",
  "account-workspace-check.mjs": "Deferred email workspace; retained only for future reconsideration, not run in v1",

  // Aggregator gates: test.yml runs these against the shard receipts.
  "browser-shards-check.mjs": "test.yml `browser` aggregator job runs it against the shard receipts; it is the gate, not a suite",
  "unit-shards-check.mjs": "shard receipt gate covered by tests/unit-shards.test.js; CI runs unit-ci --all in one job",
  // `npm run check` (contract job) spawns these directly.
  "design-contrast-check.mjs": "spawned by scripts/check.mjs (npm run check)",
  "docs-link-check.mjs": "spawned by scripts/check.mjs (npm run check)",
  "github-app-check.mjs": "spawned by scripts/check.mjs (npm run check); also `npm run github-app:check`",
  "secret-scan-check.mjs": "spawned by scripts/check.mjs (npm run check)",
  "server-json-check.mjs": "spawned by scripts/check.mjs (npm run check) and run by mcp-registry-publish.yml",
  "syntax-check.mjs": "imported and run by scripts/check.mjs (npm run check)",
  "skills-sync-check.mjs": "run by the lint gate (scripts/lint.mjs)",
  // Dedicated workflows run these.
  "answer-engine-check.mjs": "run by .github/workflows/answer-engine-check.yml",
  "listing-check.mjs": "run by .github/workflows/listing-check.yml",
  "pr-diff-size-check.mjs": "run by .github/workflows/pr-gates.yml; it is the diff-size gate, not a suite",
  "quarantine-check.mjs": "run by .github/workflows/pr-gates.yml",
  "review-scope-check.mjs": "run by .github/workflows/review-mechanical.yml",
  // Gate machinery whose logic is exercised by the unit suite.
  "route-docs-check.mjs": "shared route-docs machinery: imported by tests (route-docs-check, openapi-*, invite-only-boundary, developer-contract); the gate runs via npm run check",
  "bounty-conservation-check.mjs": "operator tool: scheduled read-only prod verifier requiring --db/$ROOM_DB; its logic is unit-tested (tests/bounty-conservation-check.test.js)",
  // Not runnable in CI by design.
  "live-codex-host-check.mjs": "opt-in live-model qualification fixture requiring a codex executable and an evidence directory; its header forbids CI wiring",
  "agent-fast-path-check.mjs": "plain-script synthetic HTTP journey (top-level script, not a node:test suite, no browser); no CI invoker — recorded here so the gap is explicit",
  // Known-failing on main: wiring them now would merge a red gate.
  // Wire each when its issue closes (and drop the exclusion).
  "qa5-a11y-c-browser-check.mjs": "KNOWN-FAILING on main (0/6) — issue #3842; wire when it closes",
  "manual-owner-exercise-check.mjs": "KNOWN-FAILING on main — issue #3837; wire when it closes",
};

export function checkFilesOnDisk(scriptsDir) {
  return readdirSync(scriptsDir)
    .filter(name => name.endsWith("-check.mjs"))
    .sort();
}

// The derived suite: every check file on disk that is not excluded, as
// scripts/-relative paths in filename order.
export function deriveBrowserSuites(scriptsDir = join(root, "scripts")) {
  return checkFilesOnDisk(scriptsDir)
    .filter(name => !(name in BROWSER_SUITE_EXCLUSIONS))
    .map(name => `scripts/${name}`);
}

export function browserScriptString(files) {
  return `node --test --test-concurrency=1 ${files.join(" ")}`;
}

export function canonicalBrowserScript(scriptsDir = join(root, "scripts")) {
  return browserScriptString(deriveBrowserSuites(scriptsDir));
}

// Fixtures and any caller that still passes an explicit `node --test`
// file list keep that list. The npm script (and an empty string) resolve
// to the disk derivation. Anything else is a mistake.
export function resolveBrowserScript(script, scriptsDir = join(root, "scripts")) {
  const trimmed = String(script ?? "").trim();
  if (trimmed.startsWith("node --test ")) return trimmed;
  if (trimmed === BROWSER_RUN_COMMAND || trimmed === "") return canonicalBrowserScript(scriptsDir);
  throw new Error(`test:browser must be "${BROWSER_RUN_COMMAND}" or an explicit "node --test ..." list`);
}

// Exclusions must name real files. The committed npm script must be the
// runner. A hand-written `node --test` list, if one is put back, must
// still match the derivation exactly.
export function browserSuiteProblems({ scriptsDir = join(root, "scripts"), packageJsonPath = join(root, "package.json") } = {}) {
  const problems = [];
  const onDisk = checkFilesOnDisk(scriptsDir);
  for (const name of Object.keys(BROWSER_SUITE_EXCLUSIONS)) {
    if (!onDisk.includes(name)) problems.push(`exclusion names a file not on disk: scripts/${name} (remove the stale exclusion)`);
    if (!String(BROWSER_SUITE_EXCLUSIONS[name]).trim()) problems.push(`exclusion for scripts/${name} has no reason`);
  }
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const committed = String(pkg.scripts?.["test:browser"] ?? "").trim();
  if (committed === BROWSER_RUN_COMMAND) return problems;
  const derived = canonicalBrowserScript(scriptsDir);
  if (committed !== derived) {
    const committedFiles = new Set(committed.split(/\s+/).filter(word => word.startsWith("scripts/")));
    const derivedFiles = new Set(deriveBrowserSuites(scriptsDir));
    for (const file of derivedFiles) if (!committedFiles.has(file)) problems.push(`suite missing from test:browser: ${file}`);
    for (const file of committedFiles) if (!derivedFiles.has(file)) problems.push(`test:browser names a file the derivation excludes or cannot find: ${file}`);
    if (!problems.length) problems.push("test:browser differs from the derived list (order or flags); point it at the runner");
  }
  return problems;
}

function main() {
  if (process.argv.includes("--write")) {
    console.error("browser-suites: the file list is derived from disk. package.json test:browser is `node scripts/browser-suites.mjs --run`.");
    process.exit(1);
  }
  if (process.argv.includes("--check")) {
    const problems = browserSuiteProblems();
    if (problems.length) {
      for (const problem of problems) console.error(`browser-suites: ${problem}`);
      console.error("browser-suites: record an exclusion in scripts/browser-suites.mjs, or point test:browser at the runner");
      process.exit(1);
    }
    console.log(`browser-suites: test:browser runs the disk-derived list (${deriveBrowserSuites().length} suites)`);
    return;
  }
  if (process.argv.includes("--run")) {
    const files = deriveBrowserSuites();
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], { stdio: "inherit" });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  }
  console.log(canonicalBrowserScript());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
