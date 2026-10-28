#!/usr/bin/env node
/**
 * scripts/report-unit-failures.mjs
 *
 * CI honesty: the "Report failures to PR" step in .github/workflows/test.yml
 * names the failing tests instead of pointing at the job log. Reads the
 * shard receipt written by scripts/unit-ci.mjs (latest attempt wins) and
 * writes the markdown comment body to --body-file (or stdout).
 *
 * Usage: node scripts/report-unit-failures.mjs --shard=1/3 [--body-file=path]
 *        node scripts/report-unit-failures.mjs --all [--body-file=path]
 *        node scripts/report-unit-failures.mjs --affected [--body-file=path]
 * Env: GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID (for the run link).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseShard, SHARD_COUNT } from "./unit-shards.mjs";
import { formatFailureComment } from "./failing-tests.mjs";

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(name + "="));
  return hit ? hit.slice(name.length + 1) : null;
}

function latestReceipt(dir, index, total) {
  let best = null;
  let bestAttempt = -1;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null; // shard never ran (earlier step failed): fall back to the log pointer
  }
  for (const name of names) {
    const m = new RegExp(
      `^unit-shard-${index}-of-${total}-attempt-(\\d+)\\.json$`
    ).exec(name);
    if (!m) continue;
    const attempt = Number(m[1]);
    if (attempt > bestAttempt) {
      bestAttempt = attempt;
      best = join(dir, name);
    }
  }
  return best ? JSON.parse(readFileSync(best, "utf8")) : null;
}

function latestMatchingReceipt(dir, pattern) {
  let best = null;
  let bestAttempt = -1;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const match = pattern.exec(name);
    if (!match) continue;
    const attempt = Number(match[1]);
    if (attempt > bestAttempt) {
      bestAttempt = attempt;
      best = join(dir, name);
    }
  }
  return best ? JSON.parse(readFileSync(best, "utf8")) : null;
}

function main() {
  const all = process.argv.includes("--all");
  const affected = process.argv.includes("--affected");
  const shardArg = arg("--shard");
  const modes = Number(all) + Number(affected) + Number(Boolean(shardArg));
  if (modes !== 1) throw new Error("Usage: report-unit-failures.mjs --shard=1/3 | --all | --affected [--body-file=path]");
  let comment;
  if (all || affected) {
    const pattern = all ? /^unit-all-attempt-(\d+)\.json$/ : /^unit-affected-attempt-(\d+)\.json$/;
    const receipt = latestMatchingReceipt("test-results", pattern);
    comment = {
      failures: Array.isArray(receipt?.failures) ? receipt.failures : [],
      title: "## Unit test failures\n",
    };
  } else {
    const { index, total } = parseShard(shardArg);
    if (total !== SHARD_COUNT) throw new Error(`expected ${SHARD_COUNT} shards`);
    const receipt = latestReceipt("test-results", index, total);
    comment = {
      shard: index,
      total,
      failures: Array.isArray(receipt?.failures) ? receipt.failures : [],
    };
  }
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  const runUrl =
    GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
      ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
      : "";
  const body = formatFailureComment({ ...comment, runUrl });
  const bodyFile = arg("--body-file");
  if (bodyFile) writeFileSync(bodyFile, body);
  else process.stdout.write(body);
}

main();
