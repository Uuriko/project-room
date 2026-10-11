#!/usr/bin/env node
// flaky-weekly-shard.mjs — one shard of the weekly flaky-detect lane (TST-01A).
// Detection only: never gates CI. .github/workflows/flaky-weekly.yml runs it.
//
//   node scripts/flaky-weekly-shard.mjs --shard=I/N [--runs=5] [--timeout=ms]
//        [--budget-minutes=M] [--out=dir] [--dir=tests]
//
// The shard owns every Node-discovered test file whose sorted index i satisfies
// i % N === I - 1 (round robin, so each file is in exactly one shard). For each
// file it runs scripts/flaky-detect.mjs logic and writes one JSON record
// (the detectFlaky result) to <out>/<file path with "/" replaced by "__">.json.
// It then writes <out>/shard-summary.json. When the time budget runs out, the
// remaining files are listed under "skipped" in the summary, not dropped.
// Exit code is always 0 unless the arguments are invalid (exit 2).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { detectFlaky } from "./flaky-detect.mjs";
import { discoverUnitTests } from "./unit-shards.mjs";

export function parseShardArg(value) {
  const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value ?? "");
  if (!m) throw new Error("--shard must look like I/N, for example 3/8");
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (index > total || total > 64) throw new Error("--shard needs 1 <= I <= N <= 64");
  return { index, total };
}

export function shardFiles(files, { index, total }) {
  return [...files].sort().filter((_, i) => i % total === index - 1);
}

export function recordName(file) {
  return `${file.replace(/[\\/]/g, "__")}.json`;
}

export function parseArgs(argv) {
  const opts = { shard: null, runs: 5, timeout: 120_000, budgetMinutes: 0, out: "flaky-report", dir: "tests" };
  for (const arg of argv) {
    const [k, v] = arg.split(/=(.*)/s);
    if (k === "--shard") opts.shard = parseShardArg(v);
    else if (k === "--runs") opts.runs = Number(v);
    else if (k === "--timeout") opts.timeout = Number(v);
    else if (k === "--budget-minutes") opts.budgetMinutes = Number(v);
    else if (k === "--out") opts.out = v;
    else if (k === "--dir") opts.dir = v;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.shard) throw new Error("--shard is required");
  if (!Number.isInteger(opts.runs) || opts.runs < 2) throw new Error("--runs must be an integer >= 2");
  if (!Number.isInteger(opts.timeout) || opts.timeout < 1000) throw new Error("--timeout must be >= 1000 ms");
  if (!Number.isFinite(opts.budgetMinutes) || opts.budgetMinutes < 0) throw new Error("--budget-minutes must be >= 0");
  return opts;
}

export async function runShard(opts, { detect = detectFlaky, now = Date.now, discover = discoverUnitTests } = {}) {
  const files = shardFiles(discover(opts.dir), opts.shard);
  mkdirSync(opts.out, { recursive: true });
  const started = now();
  const deadline = opts.budgetMinutes > 0 ? started + opts.budgetMinutes * 60_000 : Infinity;
  const summary = { shard: `${opts.shard.index}/${opts.shard.total}`, runs: opts.runs, files: files.length,
    checked: 0, flakyFiles: [], errorFiles: [], skipped: [] };
  for (const file of files) {
    if (now() >= deadline) { summary.skipped.push(file); continue; }
    const result = await detect(file, { runs: opts.runs, timeout: opts.timeout });
    writeFileSync(path.join(opts.out, recordName(file)), `${JSON.stringify(result, null, 2)}\n`);
    summary.checked += 1;
    if (result.flaky?.length) summary.flakyFiles.push({ file, tests: result.flaky.map((f) => f.name) });
    if (result.exitCode === 2) summary.errorFiles.push({ file, error: result.error ?? (result.runErrors ?? [])[0] ?? null });
  }
  summary.elapsedMs = now() - started;
  writeFileSync(path.join(opts.out, "shard-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

const isMain = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href; }
  catch { return false; }
})();

if (isMain) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(`flaky-weekly-shard: ${err.message}`); process.exit(2); }
  const s = await runShard(opts);
  console.log(`flaky-weekly-shard ${s.shard}: checked ${s.checked}/${s.files}, flaky files ${s.flakyFiles.length}, error files ${s.errorFiles.length}, skipped ${s.skipped.length}`);
  for (const f of s.flakyFiles) console.log(`  FLAKY ${f.file}: ${f.tests.join(" | ")}`);
}
