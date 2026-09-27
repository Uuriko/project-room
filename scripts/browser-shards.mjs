// Allocation consumes the canonical package script; timing data never selects membership.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
export const SHARD_COUNT = 4;
const timings = JSON.parse(readFileSync(new URL("./browser-ci-durations.json", import.meta.url), "utf8")).milliseconds;
export function parseShard(value) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value ?? "");
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[2]) !== SHARD_COUNT || Number(match[1]) > SHARD_COUNT) {
    throw new Error(`Shard must be 1/${SHARD_COUNT} through ${SHARD_COUNT}/${SHARD_COUNT}`);
  }
  return { index: Number(match[1]), total: SHARD_COUNT };
}
export function browserPlan(script) {
  const words = String(script ?? "").trim().split(/\s+/);
  if (words[0] !== "node" || words[1] !== "--test") throw new Error('test:browser must start with "node --test"');
  if (words.some(word => word.startsWith("--test-reporter"))) throw new Error("test:browser already sets --test-reporter");
  const flags = words.slice(2).filter(word => word.startsWith("--"));
  const files = words.slice(2).filter(word => !word.startsWith("--"));
  if (flags.some(flag => !/^--test-concurrency=[1-9]\d*$/.test(flag)) || !files.length || files.some(file => !/^scripts\/[\w./-]+\.mjs$/.test(file)) || new Set(files).size !== files.length) {
    throw new Error("Browser suite must contain explicit unique scripts/*.mjs paths and only --test-concurrency=N");
  }
  const shards = Array.from({ length: SHARD_COUNT }, (_, i) => ({ index: i + 1, files: [], estimatedMs: 0 }));
  const estimate = file => Number.isFinite(timings[file]) && timings[file] > 0 ? timings[file] : 10000;
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  for (const file of [...files].sort((a, b) => estimate(b) - estimate(a) || compare(a, b))) {
    const shard = [...shards].sort((a, b) => a.estimatedMs - b.estimatedMs || a.index - b.index)[0];
    shard.files.push(file); shard.estimatedMs += estimate(file);
  }
  // Retain the canonical relative order within each shard.
  for (const shard of shards) shard.files.sort((a, b) => files.indexOf(a) - files.indexOf(b));
  const planHash = createHash("sha256").update(JSON.stringify({ script, shards })).digest("hex");
  return { flags, files, shards, planHash };
}
export function verifyBrowserShards(plan, receipts, { matrixResult, revision, runId, runAttempt }) {
  if (matrixResult !== "success") throw new Error(`Browser matrix did not succeed: ${matrixResult ?? "missing"}`);
  if (!revision || !runId || !runAttempt) throw new Error("Missing run identity");
  if (!Array.isArray(receipts) || receipts.length !== SHARD_COUNT) throw new Error("Missing or duplicate browser shard receipts");
  for (const shard of plan.shards) {
    const matches = receipts.filter(receipt => receipt?.index === shard.index);
    const receipt = matches[0];
    if (matches.length !== 1 || receipt.total !== SHARD_COUNT || receipt.status !== 0 || receipt.signal !== null || receipt.planHash !== plan.planHash || receipt.revision !== revision || receipt.runId !== runId || receipt.runAttempt !== runAttempt || JSON.stringify(receipt.files) !== JSON.stringify(shard.files) || !shard.files.length) {
      throw new Error(`Browser shard ${shard.index} has missing, failed, stale or mismatched evidence`);
    }
  }
  return { scripts: plan.files.length, shards: SHARD_COUNT };
}
