// CI queue-depth sampler core (FIX-22c).
//
// Pure module: no network, no child processes, no env credentials.
// A "source" is any object with an async fetch() returning
// { queued: number, running: number, waits_s: number[] }.
// The live GitHub Actions source lives in github-actions-source.mjs;
// tests use scripted fixtures.

export const SAMPLE_TYPE = "ci.queue_depth_sample";
export const DEFAULT_INTERVAL_S = 900; // 15-minute cadence

const DEFAULT_KNEE = {
  window: 8, // samples (~2h at the 15-minute cadence)
  minSlopePerMin: 0.05, // queued-depth growth rate that counts as diverging
  minDepth: 10, // ignore growth under a trivially small queue
  hardKneeDepth: 100, // backlog this big is past the knee regardless of trend
  minR2: 0.6, // linear fit must actually fit: no alert on noise
};

export function p50(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function maxOrNull(values) {
  if (!values || values.length === 0) return null;
  return Math.max(...values);
}

function makeId(timestampIso) {
  const compact = timestampIso.replace(/[-:.]/g, "").replace("Z", "Z");
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `ciqd-${compact}-${rand}`;
}

// Least-squares slope (per minute) and R^2 of queued depth over time.
function fitTrend(samples) {
  const t0 = Date.parse(samples[0].timestamp);
  const xs = samples.map((s) => (Date.parse(s.timestamp) - t0) / 60000);
  const ys = samples.map((s) => s.queued);
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let ssxx = 0;
  let ssxy = 0;
  let sst = 0;
  for (let i = 0; i < n; i++) {
    ssxx += (xs[i] - meanX) ** 2;
    ssxy += (xs[i] - meanX) * (ys[i] - meanY);
    sst += (ys[i] - meanY) ** 2;
  }
  const slope = ssxx === 0 ? 0 : ssxy / ssxx;
  const r2 = sst === 0 ? 0 : (ssxy * ssxy) / (ssxx * sst || 1);
  return { slope, r2: ssxx === 0 || sst === 0 ? 0 : r2, meanQueued: meanY };
}

// Estimate rho = lambda / mu from a sample window.
// Arrivals per interval = completions per interval + queue delta.
// We approximate per-interval service capacity by mean in-flight runs R:
// rho_hat ~= 1 + delta_q / max(1, R). Directionally right: growing while
// saturated => rho > 1; draining => rho < 1. Coarse but documented.
function estimateRho(samples) {
  const withRunning = samples.filter((s) => typeof s.running === "number");
  const qs = samples.map((s) => s.queued);
  const deltaQ = (qs[qs.length - 1] - qs[0]) / Math.max(1, samples.length - 1);
  if (withRunning.length === 0) return null;
  const meanRunning =
    withRunning.reduce((a, s) => a + s.running, 0) / withRunning.length;
  return 1 + Math.max(deltaQ, 0) / Math.max(1, meanRunning);
}

// Knee detector: the observable signature of rho > 1 is a queue that grows
// unboundedly instead of draining. samples: [{ timestamp, queued, running? }]
// ascending by time. Returns { alert, reason, rho_hat }.
export function detectKnee(samples, opts = {}) {
  const o = { ...DEFAULT_KNEE, ...opts };
  if (!samples || samples.length === 0) {
    return { alert: false, reason: "no history", rho_hat: null };
  }
  const latest = samples[samples.length - 1];
  const rho_hat = estimateRho(samples);
  if (latest.queued >= o.hardKneeDepth) {
    return {
      alert: true,
      reason: `hard knee: queued ${latest.queued} >= ${o.hardKneeDepth}`,
      rho_hat,
    };
  }
  const windowed = samples.slice(-o.window);
  if (windowed.length < 4) {
    return { alert: false, reason: "insufficient history", rho_hat };
  }
  const { slope, r2 } = fitTrend(windowed);
  if (slope >= o.minSlopePerMin && r2 >= o.minR2 && latest.queued >= o.minDepth) {
    return {
      alert: true,
      reason: `diverging queue: +${slope.toFixed(3)} queued/min over ${windowed.length} samples (R^2=${r2.toFixed(2)})`,
      rho_hat,
    };
  }
  if (slope < 0) {
    return { alert: false, reason: `draining window (${slope.toFixed(3)} queued/min)`, rho_hat };
  }
  return {
    alert: false,
    reason: `stable window (slope ${slope.toFixed(3)} queued/min, R^2=${r2.toFixed(2)})`,
    rho_hat,
  };
}

// One sample: read the source, shape the record, evaluate the knee against
// previousSamples (which must already be in ascending time order).
export async function sampleOnce(
  source,
  { repo = "Uuriko/project-room", now = null, previousSamples = [], kneeOpts = {} } = {}
) {
  const snapshot = await source.fetch();
  const waits = snapshot.waits_s ?? [];
  const timestamp = now || new Date().toISOString();
  const record = {
    type: SAMPLE_TYPE,
    id: makeId(timestamp),
    timestamp,
    repo,
    interval_s: DEFAULT_INTERVAL_S,
    queued: snapshot.queued,
    running: snapshot.running,
    p50_wait_s: p50(waits),
    max_wait_s: maxOrNull(waits),
    knee: detectKnee([...previousSamples, { timestamp, queued: snapshot.queued, running: snapshot.running }], kneeOpts),
  };
  return record;
}

export async function writeSample(filePath, record) {
  const { appendFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
}

export async function loadSamples(filePath) {
  const { readFile } = await import("node:fs/promises");
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
