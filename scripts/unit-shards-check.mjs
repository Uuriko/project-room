#!/usr/bin/env node
// Required `unit` gate: successful Actions matrix AND all exact-run receipts.
// Mirrors scripts/browser-shards-check.mjs: every tests/*.test.js file must be
// covered exactly once by a passing shard from this exact run/attempt plan.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { unitPlan, verifyUnitShards } from "./unit-shards.mjs";

const directory = process.argv[2];
if (!directory || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/unit-shards-check.mjs RECEIPT_DIRECTORY");
}
const receipts = readdirSync(directory)
  .filter((name) => /^unit-shard-.*\.json$/.test(name))
  .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
const result = verifyUnitShards(unitPlan("tests"), receipts, {
  matrixResult: process.env.UNIT_MATRIX_RESULT,
  revision: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
});
console.log(`unit: all ${result.shards} shards succeeded; ${result.files} test files covered exactly once`);
