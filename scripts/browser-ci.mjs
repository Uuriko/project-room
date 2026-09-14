// CI wrapper for `npm run test:browser` (BUILD-01 task B50).
//
// The browser job's only failure signal used to be "Process completed with
// exit code 1": the raw log and the evidence artifact live behind a blob-store
// redirect that some environments cannot reach, so nobody could tell which
// of the ~60 Playwright suites failed. This wrapper runs the *same* suite
// list as test:browser (read from package.json, so journey-coverage keeps a
// single source of truth) with two reporters: `spec` to stdout for humans
// reading the log, and `junit` to RESULTS_FILE for
// scripts/report-test-failures.mjs, which turns it into GitHub annotations
// and a job summary — both readable through the GitHub API.
//
// `test:browser` itself is unchanged for local use.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

// Under test-results/ so the existing upload-artifact step keeps it too.
export const RESULTS_FILE = "test-results/browser-junit.xml";

// Build node's argv from the test:browser script string. Every flag after
// `node --test` (notably --test-concurrency=1) and the file list are kept.
export function ciArgs(script, destination = RESULTS_FILE) {
  const words = String(script ?? "").trim().split(/\s+/).filter(Boolean);
  if (words[0] !== "node" || words[1] !== "--test") {
    throw new Error(`test:browser must start with "node --test" (got "${words.slice(0, 2).join(" ")}")`);
  }
  if (words.some(w => w.startsWith("--test-reporter"))) {
    throw new Error("test:browser already sets --test-reporter; test:browser:ci adds spec + junit itself");
  }
  return [
    "--test",
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=junit", `--test-reporter-destination=${destination}`,
    ...words.slice(2),
  ];
}

function main() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const args = ciArgs(pkg.scripts?.["test:browser"]);
  // The junit reporter does not create directories (Node 24 exits with 7).
  mkdirSync(dirname(RESULTS_FILE), { recursive: true });
  console.log(`browser-ci: spec -> stdout, junit -> ${RESULTS_FILE}`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) main();
