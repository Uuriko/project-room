// Required `browser` gate: successful Actions dependency AND all four exact-run receipts.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { browserPlan, verifyBrowserShards } from "./browser-shards.mjs";
const directory = process.argv[2];
if (!directory || process.argv.length !== 3) throw new Error("Usage: browser-shards-check.mjs RECEIPT_DIRECTORY");
const receipts = readdirSync(directory).filter(name => /^browser-shard-.*\.json$/.test(name)).map(name => JSON.parse(readFileSync(join(directory, name), "utf8")));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const result = verifyBrowserShards(browserPlan(pkg.scripts?.["test:browser"]), receipts, {
  matrixResult: process.env.BROWSER_MATRIX_RESULT, revision: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
});
console.log(`browser: all ${result.shards} shards succeeded; ${result.scripts} scripts covered exactly once`);
