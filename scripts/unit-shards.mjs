// Allocation for the sharded unit suite (CI-speed lane).
//
// The `unit` merge-gate job ran `npm test` (every tests/*.test.js file) in one
// job: ~625s on hosted CI, the long pole of every PR head. This module splits
// the suite into SHARD_COUNT file shards with balanced estimated duration, so
// the `unit-shards` matrix finishes in roughly 1/SHARD_COUNT of the time.
//
// Allocation consumes the canonical file list; timing data never selects
// membership: every tests/*.test.js file is always in exactly one shard.
// Per-file durations live in scripts/unit-ci-durations.json (milliseconds,
// measured on hosted CI); files without a measurement get a conservative
// default so a new test file lands in a shard instead of breaking the plan.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

export const SHARD_COUNT = 3;

const timings = JSON.parse(
  readFileSync(new URL("./unit-ci-durations.json", import.meta.url), "utf8")
).milliseconds;

export function parseShard(value) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value ?? "");
  if (
    !match ||
    !Number.isSafeInteger(Number(match[1])) ||
    Number(match[2]) !== SHARD_COUNT ||
    Number(match[1]) > SHARD_COUNT
  ) {
    throw new Error(`Shard must be 1/${SHARD_COUNT} through ${SHARD_COUNT}/${SHARD_COUNT}`);
  }
  return { index: Number(match[1]), total: SHARD_COUNT };
}

export function unitPlan(testsDir = "tests") {
  const files = readdirSync(testsDir)
    .filter((f) => f.endsWith(".test.js"))
    .sort()
    .map((f) => `${testsDir}/${f}`);
  if (!files.length) throw new Error("unitPlan: no tests/*.test.js files found");
  if (new Set(files).size !== files.length) throw new Error("unitPlan: duplicate test files");
  const shards = Array.from({ length: SHARD_COUNT }, (_, i) => ({ index: i + 1, files: [], estimatedMs: 0 }));
  const estimate = (file) => {
    const ms = timings[file];
    return Number.isFinite(ms) && ms > 0 ? ms : 5000;
  };
  const owner = new Map(); // file -> 0-based shard
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  for (const file of [...files].sort((a, b) => estimate(b) - estimate(a) || compare(a, b))) {
    const shard = [...shards].sort((a, b) => a.estimatedMs - b.estimatedMs || a.index - b.index)[0];
    shard.files.push(file);
    shard.estimatedMs += estimate(file);
    owner.set(file, shard.index - 1);
  }
  // Deterministic best-improvement local search (same shape as
  // browser-shards.mjs): try every single-file move and pairwise swap in
  // canonical order, apply the one that lowers the makespan most, repeat
  // until no move helps. A move that would empty a shard is never taken.
  const loads = () => shards.map((shard) => shard.estimatedMs);
  const counts = shards.map((shard) => shard.files.length);
  for (;;) {
    const current = loads();
    const before = Math.max(...current);
    const afterLoads = (updates) => {
      const next = [...current];
      for (const [shard, delta] of updates) next[shard] += delta;
      return Math.max(...next);
    };
    let best = null;
    const consider = (candidate) => {
      if (candidate.gain > 0 && (!best || candidate.gain > best.gain)) best = candidate;
    };
    for (const file of files) {
      const from = owner.get(file);
      const weight = estimate(file);
      if (counts[from] === 1) continue;
      for (let to = 0; to < SHARD_COUNT; to++) {
        if (to === from) continue;
        const gain = before - afterLoads([[from, -weight], [to, weight]]);
        consider({
          gain,
          apply() {
            owner.set(file, to);
            counts[from]--;
            counts[to]++;
            shards[from].estimatedMs -= weight;
            shards[to].estimatedMs += weight;
          },
        });
      }
    }
    for (let a = 0; a < files.length; a++)
      for (let b = a + 1; b < files.length; b++) {
        const fa = files[a];
        const fb = files[b];
        const sa = owner.get(fa);
        const sb = owner.get(fb);
        if (sa === sb) continue;
        const wa = estimate(fa);
        const wb = estimate(fb);
        const gain = before - afterLoads([[sa, wb - wa], [sb, wa - wb]]);
        consider({
          gain,
          apply() {
            owner.set(fa, sb);
            owner.set(fb, sa);
            shards[sa].estimatedMs += wb - wa;
            shards[sb].estimatedMs += wa - wb;
          },
        });
      }
    if (!best) break;
    best.apply();
  }
  for (const shard of shards) {
    shard.files = [];
    shard.estimatedMs = 0;
  }
  for (const file of files) {
    const shard = shards[owner.get(file)];
    shard.files.push(file);
    shard.estimatedMs += estimate(file);
  }
  // Retain the canonical relative order within each shard.
  for (const shard of shards) shard.files.sort((a, b) => files.indexOf(a) - files.indexOf(b));
  const planHash = createHash("sha256").update(JSON.stringify({ files, shards })).digest("hex");
  return { files, shards, planHash };
}

export function verifyUnitShards(plan, receipts, { matrixResult, revision, runId, runAttempt }) {
  if (matrixResult !== "success") throw new Error(`Unit matrix did not succeed: ${matrixResult ?? "missing"}`);
  if (!revision || !runId || !runAttempt) throw new Error("Missing run identity");
  if (!Array.isArray(receipts) || !receipts.length) throw new Error("Missing unit shard receipts");
  // A re-run shard uploads a second receipt under a new attempt number; the
  // latest attempt per shard is authoritative, bound to this run by runId +
  // revision + planHash.
  const attemptNumber = (receipt) => {
    const n = Number(receipt?.runAttempt);
    return Number.isFinite(n) ? n : -1;
  };
  const latest = new Map();
  for (const receipt of receipts) {
    const index = receipt?.index;
    if (!Number.isInteger(index) || index < 1 || index > SHARD_COUNT)
      throw new Error("Unit shard receipt has invalid index");
    const current = latest.get(index);
    if (!current || attemptNumber(receipt) > attemptNumber(current)) latest.set(index, receipt);
  }
  if (latest.size !== SHARD_COUNT) throw new Error("Missing or duplicate unit shard receipts");
  for (const shard of plan.shards) {
    const receipt = latest.get(shard.index);
    if (
      receipt.total !== SHARD_COUNT ||
      receipt.status !== 0 ||
      receipt.signal !== null ||
      receipt.planHash !== plan.planHash ||
      receipt.revision !== revision ||
      receipt.runId !== runId ||
      JSON.stringify(receipt.files) !== JSON.stringify(shard.files) ||
      !shard.files.length
    ) {
      throw new Error(`Unit shard ${shard.index} has missing, failed, stale or mismatched evidence`);
    }
  }
  return { files: plan.files.length, shards: SHARD_COUNT };
}

// CLI: print the plan (for debugging / CI validation). Run from the repo root.
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const plan = unitPlan("tests");
  for (const shard of plan.shards) {
    console.log(`shard ${shard.index}/${SHARD_COUNT}: ${shard.files.length} files, ~${Math.round(shard.estimatedMs / 1000)}s`);
  }
  console.log("planHash:", plan.planHash);
}
