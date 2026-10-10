// Orchestration overhead measurement harness (200-hard-tasks #29).
// Measures gateway/orchestration overhead per job on a local mock stack:
// queue wait, routing, authorization, metering (REAL tokenizer), receipt
// signing (REAL Ed25519), dispatch. Runs at concurrency 1/10/100 and reports
// p50/p99 per stage plus the top-3 overhead sources. Seeded RNG.
import { generateReceiptKeyPair, signBytes, canonicalJson } from "../server/bounty-receipts.mjs";
import { countTokens } from "../server/tokenizer.mjs";

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ms = () => Number(process.hrtime.bigint()) / 1e6;
const sleep = (ms_) => new Promise((r) => setTimeout(r, ms_));

// Mock provider fleet for the routing stage.
function makeFleet(n, rand) {
  return Array.from({ length: n }, (_, i) => ({
    id: `provider-${i}`,
    score: 0.5 + rand() * 0.5,
    latencyMs: 1000 + rand() * 7000,
  }));
}

export async function measureOverhead({ jobs = 200, concurrency = 10, seed = 1, prompt = null } = {}) {
  const rand = mulberry32(seed);
  const fleet = makeFleet(20, rand);
  const keypair = generateReceiptKeyPair();
  const text = prompt || "Summarize the following meeting notes in three bullet points. ".repeat(8);
  const stages = ["queue", "route", "authorize", "meter", "sign", "dispatch"];
  const records = [];

  // Simple worker pool: `concurrency` workers pull job indices.
  let next = 0;
  const submittedAt = new Map();

  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= jobs) return;
      submittedAt.set(idx, ms());
      const t = {};
      // queue: time from submit until a worker picks the job up
      t.queue = ms() - submittedAt.get(idx);
      // route: score the fleet and pick the best available provider
      {
        const s = ms();
        let best = fleet[0];
        for (const p of fleet) {
          const value = p.score * 1000 - p.latencyMs * 0.01 + rand();
          if (value > best._v || best._v === undefined) {
            best = p;
            best._v = value;
          }
        }
        for (const p of fleet) delete p._v;
        void best;
        t.route = ms() - s;
      }
      // authorize: membership + spend-allowance check (mock)
      {
        const s = ms();
        await sleep(0.5 + rand() * 1.5);
        t.authorize = ms() - s;
      }
      // meter: REAL tokenization of the prompt
      {
        const s = ms();
        countTokens(text, "cl100k");
        t.meter = ms() - s;
      }
      // sign: REAL Ed25519 receipt signature
      {
        const s = ms();
        signBytes(canonicalJson({ job: `job-${idx}`, prompt: text.slice(0, 64), at: "2026-10-07T00:00:00.000Z" }), keypair.seedHex);
        t.sign = ms() - s;
      }
      // dispatch: mock network hop to the provider
      {
        const s = ms();
        await sleep(1 + rand() * 3);
        t.dispatch = ms() - s;
      }
      t.total = t.queue + t.route + t.authorize + t.meter + t.sign + t.dispatch;
      records.push(t);
    }
  }

  const wall = ms();
  // Warmup: 5 unmeasured jobs so rank loading / regex compile / keygen
  // don't pollute the steady-state numbers (cold start reported separately).
  const warmJobs = Math.min(5, jobs);
  {
    let w = 0;
    const warm = async () => {
      while (w < warmJobs) {
        w++;
        countTokens(text, "cl100k");
        signBytes(canonicalJson({ job: "warm", at: "2026-10-07T00:00:00.000Z" }), keypair.seedHex);
      }
    };
    await warm();
  }
  const coldStartMs = ms() - wall;
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = ms() - wall;
  return { jobs, concurrency, seed, wallMs: +wallMs.toFixed(1), coldStartMs: +coldStartMs.toFixed(1), records };
}

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export function summarize(run) {
  const stages = ["queue", "route", "authorize", "meter", "sign", "dispatch", "total"];
  const summary = {};
  for (const s of stages) {
    const vals = run.records.map((r) => r[s]).sort((a, b) => a - b);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    summary[s] = {
      mean: +mean.toFixed(3),
      p50: +percentile(vals, 0.5).toFixed(3),
      p99: +percentile(vals, 0.99).toFixed(3),
    };
  }
  // Top-3 overhead sources by mean contribution (excluding total).
  const top3 = stages
    .filter((s) => s !== "total")
    .map((s) => ({ stage: s, meanMs: summary[s].mean, share: summary[s].mean / summary.total.mean }))
    .sort((a, b) => b.meanMs - a.meanMs)
    .slice(0, 3)
    .map((x) => ({ ...x, meanMs: +x.meanMs.toFixed(3), share: +(x.share * 100).toFixed(1) + "%" }));
  return { jobs: run.jobs, concurrency: run.concurrency, wallMs: run.wallMs, coldStartMs: run.coldStartMs, stages: summary, top3 };
}

export async function sweep(concurrencies = [1, 10, 100], opts = {}) {
  const out = [];
  for (const c of concurrencies) {
    out.push(summarize(await measureOverhead({ ...opts, concurrency: c })));
  }
  return out;
}
