#!/usr/bin/env node
//
// task-base.mjs — FIX-31: base-SHA freshness probe.
//
// Norm: `record` the origin/main SHA when you start a task, then `check`
// it before every push. If the base moved, rebase onto the new base first
// instead of pushing a stale branch.
//
//   node scripts/task-base.mjs record   # query origin/main, write .task-base
//   node scripts/task-base.mjs check    # re-query; exit 0 fresh, 1 moved
//
// .task-base lives in the repo root and is gitignored (local machine state,
// never committed). Env overrides (used by tests): TASK_BASE_REMOTE,
// TASK_BASE_REF.
//

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REMOTE = process.env.TASK_BASE_REMOTE || "origin";
const REF = process.env.TASK_BASE_REF || "refs/heads/main";
const BASE_FILE_NAME = ".task-base";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

function queryBaseSha() {
  let out;
  try {
    out = execFileSync("git", ["ls-remote", REMOTE, REF], { encoding: "utf8" });
  } catch (e) {
    const detail = e.stderr ? String(e.stderr).trim() : e.message;
    console.error(`failed to query ${REMOTE} ${REF}: ${detail}`);
    process.exit(2);
  }
  const line = out.split("\n").find((l) => l.trim().length > 0);
  const sha = line ? line.split("\t")[0].trim() : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    console.error(`unexpected ls-remote output from ${REMOTE} ${REF}: ${out.trim()}`);
    process.exit(2);
  }
  return sha;
}

function baseFilePath() {
  return path.join(repoRoot(), BASE_FILE_NAME);
}

function cmdRecord() {
  const sha = queryBaseSha();
  const payload = JSON.stringify(
    { base: sha, recordedAt: new Date().toISOString() },
    null,
    2
  ) + "\n";
  fs.writeFileSync(baseFilePath(), payload, "utf8");
  console.log(`recorded base ${sha} in ${BASE_FILE_NAME}`);
}

function cmdCheck() {
  const file = baseFilePath();
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    console.log(
      `no ${BASE_FILE_NAME} recorded; run \`node scripts/task-base.mjs record\` first`
    );
    process.exit(1);
  }
  const oldSha = saved.base;
  const newSha = queryBaseSha();
  if (newSha === oldSha) {
    console.log(`base fresh: ${newSha}`);
    process.exit(0);
  }
  console.log(`base moved ${oldSha} -> ${newSha}; rebase before pushing`);
  process.exit(1);
}

const [subcommand] = process.argv.slice(2);
if (subcommand === "record") {
  cmdRecord();
} else if (subcommand === "check") {
  cmdCheck();
} else {
  console.error("usage: node scripts/task-base.mjs <record|check>");
  process.exit(2);
}
