// Allocation consumes the canonical package script; timing data never selects membership.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
export const SHARD_COUNT = 6;
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
  const owner = new Map(); // file -> 0-based shard; timing data rebalances membership, never selects it.
  for (const file of [...files].sort((a, b) => estimate(b) - estimate(a) || compare(a, b))) {
    const shard = [...shards].sort((a, b) => a.estimatedMs - b.estimatedMs || a.index - b.index)[0];
    shard.files.push(file); shard.estimatedMs += estimate(file); owner.set(file, shard.index - 1);
  }
  // Deterministic best-improvement local search: the greedy pass can strand
  // weight on the heaviest shard when no single later file fits. Every pass
  // tries each single-file move and each pairwise swap in canonical order and
  // applies the one that lowers the makespan most (first in canonical order
  // wins ties), repeating until no move helps. A move that would empty a shard
  // is never taken: every shard must keep at least one file.
  const loads = () => shards.map(shard => shard.estimatedMs);
  const counts = shards.map(shard => shard.files.length);
  for (;;) {
    const current = loads(), before = Math.max(...current);
    const afterLoads = updates => {
      const next = [...current];
      for (const [shard, delta] of updates) next[shard] += delta;
      return Math.max(...next);
    };
    let best = null;
    const consider = candidate => { if (candidate.gain > 0 && (!best || candidate.gain > best.gain)) best = candidate; };
    for (const file of files) {
      const from = owner.get(file), weight = estimate(file);
      if (counts[from] === 1) continue;
      for (let to = 0; to < SHARD_COUNT; to++) {
        if (to === from) continue;
        const gain = before - afterLoads([[from, -weight], [to, weight]]);
        consider({ gain, apply() { owner.set(file, to); counts[from]--; counts[to]++; shards[from].estimatedMs -= weight; shards[to].estimatedMs += weight; } });
      }
    }
    for (let a = 0; a < files.length; a++) for (let b = a + 1; b < files.length; b++) {
      const fa = files[a], fb = files[b], sa = owner.get(fa), sb = owner.get(fb);
      if (sa === sb) continue;
      const wa = estimate(fa), wb = estimate(fb);
      const gain = before - afterLoads([[sa, wb - wa], [sb, wa - wb]]);
      consider({ gain, apply() { owner.set(fa, sb); owner.set(fb, sa); shards[sa].estimatedMs += wb - wa; shards[sb].estimatedMs += wa - wb; } });
    }
    if (!best) break;
    best.apply();
  }
  for (const shard of shards) { shard.files = []; shard.estimatedMs = 0; }
  for (const file of files) {
    const shard = shards[owner.get(file)];
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
  if (!Array.isArray(receipts) || !receipts.length) throw new Error("Missing browser shard receipts");
  // A re-run shard uploads a second receipt for the same shard under a new
  // attempt number. The latest attempt per shard is authoritative: this is
  // what lets one failed shard be re-run without re-running the whole
  // matrix, and lets a re-run aggregator accept the untouched shards'
  // earlier receipts. runId + revision + planHash still bind every receipt
  // to this exact run and suite.
  const attemptNumber = receipt => {
    const n = Number(receipt?.runAttempt);
    return Number.isFinite(n) ? n : -1;
  };
  const latest = new Map();
  for (const receipt of receipts) {
    const index = receipt?.index;
    if (!Number.isInteger(index) || index < 1 || index > SHARD_COUNT) throw new Error("Browser shard receipt has invalid index");
    const current = latest.get(index);
    if (!current || attemptNumber(receipt) > attemptNumber(current)) latest.set(index, receipt);
  }
  if (latest.size !== SHARD_COUNT) throw new Error("Missing or duplicate browser shard receipts");
  for (const shard of plan.shards) {
    const receipt = latest.get(shard.index);
    if (receipt.total !== SHARD_COUNT || receipt.status !== 0 || receipt.signal !== null || receipt.planHash !== plan.planHash || receipt.revision !== revision || receipt.runId !== runId || JSON.stringify(receipt.files) !== JSON.stringify(shard.files) || !shard.files.length) {
      throw new Error(`Browser shard ${shard.index} has missing, failed, stale or mismatched evidence`);
    }
  }
  return { scripts: plan.files.length, shards: SHARD_COUNT };
}
