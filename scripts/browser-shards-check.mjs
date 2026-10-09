// Required `browser` gate: successful Actions dependency AND all four exact-run receipts.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { browserPlan, verifyBrowserShards } from "./browser-shards.mjs";
const directory = process.argv[2];
if (!directory || directory.startsWith("-") || process.argv.length !== 3) {
  process.stderr.write("Usage: browser-shards-check.mjs RECEIPT_DIRECTORY\n");
  process.exit(2);
}
let names;
try {
  names = readdirSync(directory);
} catch (error) {
  process.stderr.write(`browser-shards-check: cannot read receipt directory ${directory}: ${error.message}\n`);
  process.exit(1);
}
// A corrupt or unreadable receipt is a gate failure, not a crash: name the
// bad file on stderr and exit 1 like the unreadable-directory case above.
const receipts = [];
for (const name of names.filter(name => /^browser-shard-.*\.json$/.test(name))) {
  const path = join(directory, name);
  try {
    receipts.push(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    process.stderr.write(`browser-shards-check: cannot read receipt ${path}: ${error.message.split("\n")[0]}\n`);
    process.exit(1);
  }
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
let result;
try {
  result = verifyBrowserShards(browserPlan(pkg.scripts?.["test:browser"]), receipts, {
    matrixResult: process.env.BROWSER_MATRIX_RESULT, revision: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
} catch (error) {
  process.stderr.write(`browser-shards-check: ${error.message.split("\n")[0]}\n`);
  process.exit(1);
}
console.log(`browser: all ${result.shards} shards succeeded; ${result.scripts} scripts covered exactly once`);
