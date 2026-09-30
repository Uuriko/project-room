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
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { browserPlan, parseShard } from "./browser-shards.mjs";

// Under test-results/ so the existing upload-artifact step keeps it too.
export const RESULTS_FILE = "test-results/browser-junit.xml";

// Build node's argv from the test:browser script string. Every flag after
// `node --test` (notably --test-concurrency=1) and the file list are kept.
export function ciArgs(script, destination = RESULTS_FILE, shard = null) {
  const plan = browserPlan(script);
  return [
    "--test",
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=junit", `--test-reporter-destination=${destination}`,
    "--test-reporter=./scripts/browser-ci-reporter.mjs", "--test-reporter-destination=stdout",
    ...plan.flags, ...(shard ? plan.shards[shard.index - 1].files : plan.files),
  ];
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length > 1 || (argv.length && !argv[0].startsWith("--shard="))) throw new Error("Usage: browser-ci.mjs [--shard=1/4]");
  const shard = argv.length ? parseShard(argv[0].slice(8)) : null;
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const script = pkg.scripts?.["test:browser"];
  const plan = browserPlan(script);
  const suffix = shard ? `-${shard.index}-of-${shard.total}` : "";
  const destination = `test-results/browser-junit${suffix}.xml`;
  // The receipt filename carries the run attempt: a single-shard re-run
  // uploads a second receipt for the same shard, and the aggregator keeps
  // the latest attempt per shard instead of requiring every receipt to
  // share one attempt number.
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "local";
  const receiptPath = `test-results/browser-shard${suffix}-attempt-${attempt}.json`;
  const files = shard ? plan.shards[shard.index - 1].files : plan.files;
  if (!files.length) throw new Error("Refusing an empty browser shard");
  mkdirSync(dirname(destination), { recursive: true });
  rmSync(receiptPath, { force: true });
  rmSync(destination, { force: true });
  console.log(`browser-ci: ${shard ? `shard ${shard.index}/${shard.total}` : "full suite"}, ${files.length} scripts; spec + annotations -> stdout, junit -> ${destination}`);
  const started = Date.now();
  const result = spawnSync(process.execPath, ciArgs(script, destination, shard), { stdio: "inherit" });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (shard) writeFileSync(receiptPath, JSON.stringify({
    ...shard, files, planHash: plan.planHash, status, signal: result.signal,
    revision: process.env.GITHUB_SHA ?? "local", runId: process.env.GITHUB_RUN_ID ?? "local",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "local", elapsedMs: Date.now() - started,
  }, null, 2) + "\n");
  process.exit(status);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) main();
