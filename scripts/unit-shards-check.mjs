#!/usr/bin/env node
// Required `unit` gate: successful Actions matrix AND all exact-run receipts.
// Mirrors scripts/browser-shards-check.mjs: every tests/*.test.js file must be
// covered exactly once by a passing shard from this exact run/attempt plan.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { unitPlan, verifyUnitShards } from "./unit-shards.mjs";

const directory = process.argv[2];
if (!directory || directory.startsWith("-") || process.argv.length !== 3) {
  process.stderr.write("Usage: node scripts/unit-shards-check.mjs RECEIPT_DIRECTORY\n");
  process.exit(2);
}
let names;
try {
  names = readdirSync(directory);
} catch (error) {
  process.stderr.write(`unit-shards-check: cannot read receipt directory ${directory}: ${error.message}\n`);
  process.exit(1);
}
const receipts = [];
for (const name of names.filter((name) => /^unit-shard-.*\.json$/.test(name))) {
  const path = join(directory, name);
  try {
    receipts.push(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    process.stderr.write(`unit-shards-check: cannot read receipt ${path}: ${error.message.split("\n")[0]}\n`);
    process.exit(1);
  }
}
let result;
try {
  result = verifyUnitShards(unitPlan(), receipts, {
    matrixResult: process.env.UNIT_MATRIX_RESULT,
    revision: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
} catch (error) {
  process.stderr.write(`unit-shards-check: ${error.message.split("\n")[0]}\n`);
  process.exit(1);
}
console.log(`unit: all ${result.shards} shards succeeded; ${result.files} test files covered exactly once`);
