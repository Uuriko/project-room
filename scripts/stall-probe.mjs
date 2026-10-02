import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Fires one request per second for N seconds and fails when p99 latency
// exceeds the budget. Requests stay in flight together, which is the shape
// of a Durable Object input-gate stall (a sequential probe would hide it).
//
//   node scripts/stall-probe.mjs --url https://room.trydemigod.com --seconds 20 --path /api/health
//
// CI: .github/workflows/stall-probe.yml (workflow_dispatch). The verdict
// function is covered by tests/edge-stall.test.js without hitting a network.

export function percentile(samples, p) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error("stall probe needs at least one sample");
  if (!Number.isFinite(p) || p <= 0 || p > 100) throw new Error("percentile must be in (0, 100]");
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function probeVerdict(samples, { maxP99Ms = 3000 } = {}) {
  const p99 = percentile(samples, 99);
  const max = samples.reduce((hi, sample) => Math.max(hi, sample), 0);
  return { ok: p99 <= maxP99Ms, p99, max, samples: samples.length, maxP99Ms };
}

export function parseProbeArgs(argv) {
  const opts = { url: "", seconds: 20, path: "/api/health", maxP99Ms: 3000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url") opts.url = next ?? "";
    else if (arg === "--seconds") opts.seconds = Number(next);
    else if (arg === "--path") opts.path = next ?? "";
    else if (arg === "--max-ms") opts.maxP99Ms = Number(next);
    else continue;
    i += 1;
  }
  return opts;
}

export async function probeOnce(url, fetchImpl = globalThis.fetch) {
  const started = performance.now();
  const response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
  const elapsedMs = performance.now() - started;
  await response.arrayBuffer?.().catch(() => {});
  return { elapsedMs, status: response.status };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runStallProbe({ url, seconds, path, maxP99Ms, fetchImpl, sleepImpl = sleep } = {}) {
  const target = new URL(path || "/", url).href;
  const count = seconds;
  if (!Number.isInteger(count) || count < 1 || count > 120) throw new Error("--seconds must be an integer from 1 to 120");
  const samples = [];
  const tasks = [];
  for (let i = 0; i < count; i++) {
    tasks.push(probeOnce(target, fetchImpl).then(result => {
      samples.push(result.elapsedMs);
      return result;
    }));
    if (i < count - 1) await sleepImpl(1000);
  }
  const results = await Promise.all(tasks);
  const verdict = probeVerdict(samples, { maxP99Ms });
  return { target, results, verdict };
}

async function main() {
  const opts = parseProbeArgs(process.argv.slice(2));
  if (!opts.url) {
    console.error("Usage: node scripts/stall-probe.mjs --url https://host [--seconds 20] [--path /api/health] [--max-ms 3000]");
    process.exit(2);
  }
  const { target, results, verdict } = await runStallProbe(opts);
  for (const [index, result] of results.entries()) {
    console.log(`${index + 1}\t${result.status}\t${result.elapsedMs.toFixed(0)}ms`);
  }
  console.log(JSON.stringify({ target, ...verdict, p99: Math.round(verdict.p99), max: Math.round(verdict.max) }));
  if (!verdict.ok) {
    console.error(`stall probe failed: p99 ${Math.round(verdict.p99)}ms exceeds ${verdict.maxP99Ms}ms`);
    process.exit(1);
  }
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main().catch(error => { console.error(error?.message ?? error); process.exit(1); });
