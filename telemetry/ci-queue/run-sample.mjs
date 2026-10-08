#!/usr/bin/env node
// run-sample.mjs — one 15-minute sample of the CI queue (FIX-22c).
//
// Usage:
//   node telemetry/ci-queue/run-sample.mjs [--repo owner/name]
//       [--out path/to/samples.jsonl] [--source-fixture fixture.json]
//       [--now 2026-10-08T20:00:00.000Z]
//
// Appends exactly one ci.queue_depth_sample record to the local JSONL log
// and prints "sample recorded ...". Exit code 2 when the rho>1 knee detector
// fires (wire that to a pager or room post); exit 0 otherwise.
// No credentials, no external writes: reads local CI state via `gh`,
// records locally.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sampleOnce, writeSample, loadSamples } from "./queue-depth-sampler.mjs";
import { createGitHubActionsSource } from "./github-actions-source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function parseArgs(argv) {
  const args = {
    repo: "Uuriko/project-room",
    out: path.join(repoRoot, "telemetry/ci-queue/samples.jsonl"),
    sourceFixture: null,
    now: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--source-fixture") args.sourceFixture = argv[++i];
    else if (a === "--now") args.now = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

function fixtureSource(file) {
  const snap = JSON.parse(fs.readFileSync(file, "utf8"));
  return { name: "fixture", async fetch() { return snap; } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = args.sourceFixture
    ? fixtureSource(args.sourceFixture)
    : createGitHubActionsSource({ repo: args.repo });
  const previous = await loadSamples(args.out);
  const record = await sampleOnce(source, {
    repo: args.repo,
    now: args.now,
    previousSamples: previous,
  });
  await writeSample(args.out, record);
  console.log(
    `sample recorded: queued=${record.queued} running=${record.running} p50_wait_s=${record.p50_wait_s} -> ${args.out}`
  );
  if (record.knee.alert) {
    console.error(`KNEE ALERT: ${record.knee.reason}`);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`run-sample failed: ${err.message}`);
  process.exit(1);
});
