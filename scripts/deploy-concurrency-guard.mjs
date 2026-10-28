#!/usr/bin/env node
// Pre-publish concurrency guard for the production deploy lane.
//
// deploy-prod.yml declares the `production-deploy` concurrency group, but on
// 2026-10-27 two dispatch runs overlapped anyway (PERF-50 H5: runs
// 40576770224 and 40577459218 published/smoked/recovered against the same
// production concurrently). The group is therefore treated as a queueing
// hint, not as enforcement: immediately before the first wrangler publish,
// the deploy job lists in-progress runs of BOTH production workflows
// (deploy-prod and rollback-prod share the group) and this guard refuses
// the publish when any run other than the current one is in progress.
// Queued/pending runs do not block: they are not publishing, and each will
// run this same guard at its own publish point.
//
//   gh api repos/<repo>/actions/workflows/deploy-prod.yml/runs?status=in_progress > active.json
//   node scripts/deploy-concurrency-guard.mjs --self <run-id> active.json [more.json...]
//
// Exits 0 when publication may proceed, 1 when another run is in progress,
// 2 on usage/input errors. Pure classification is exported for tests.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function findBlockingRuns(payloads, selfRunId) {
  const self = String(selfRunId ?? "");
  const blocking = [];
  for (const payload of payloads ?? []) {
    const runs = Array.isArray(payload) ? payload : payload?.workflow_runs;
    if (!Array.isArray(runs)) continue;
    for (const run of runs) {
      if (!run || String(run.id) === self) continue;
      if (run.status !== "in_progress") continue;
      blocking.push({
        id: run.id,
        name: typeof run.name === "string" ? run.name : "unknown workflow",
        status: run.status,
        htmlUrl: typeof run.html_url === "string" ? run.html_url : null,
      });
    }
  }
  return blocking;
}

function main(argv) {
  const selfAt = argv.indexOf("--self");
  const self = selfAt >= 0 ? argv[selfAt + 1] : "";
  const files = argv.filter((arg, i) => i !== selfAt && i !== selfAt + 1 && !arg.startsWith("--"));
  if (!self || files.length === 0) {
    console.error("usage: deploy-concurrency-guard.mjs --self <run-id> <runs.json> [more-runs.json...]");
    return 2;
  }
  const payloads = [];
  for (const file of files) {
    try {
      payloads.push(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      console.error(`deploy-concurrency-guard: cannot read ${file}: ${error?.message ?? error}`);
      return 2;
    }
  }
  const blocking = findBlockingRuns(payloads, self);
  if (blocking.length > 0) {
    for (const run of blocking) {
      console.error(`::error title=deploy concurrency::refusing to publish: ${run.name} run ${run.id} is already in progress${run.htmlUrl ? ` (${run.htmlUrl})` : ""}`);
    }
    return 1;
  }
  console.log(`deploy-concurrency-guard: no other production run in progress (self ${self}); publication may proceed`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
