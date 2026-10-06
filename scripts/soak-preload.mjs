// Q007 soak harness — server-side instrumentation (observe-only).
//
// Loaded into the server process with `node --import scripts/soak-preload.mjs`
// by scripts/soak-test.mjs. It changes nothing about how the server handles
// requests; it only samples the event loop, heap, and file descriptors, and
// records unhandled rejections. All samples are appended as NDJSON to the
// file in SOAK_METRICS_PATH.
//
// Fault-injection modes (failing-first proof only, set by the harness, never
// by the server):
//   SOAK_INJECT_LEAK=1      — retain ~1 MiB per sample window in a global list
//                             (simulates a slow heap leak)
//   SOAK_INJECT_REJECTION=1 — trigger one unhandled rejection ~2 s after load
//
// Timers are unref'd so they can never keep the process alive by themselves.
import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname } from "node:path";

const metricsPath = process.env.SOAK_METRICS_PATH;
if (!metricsPath) {
  console.error("[soak-preload] SOAK_METRICS_PATH is not set; instrumentation disabled");
} else {
  mkdirSync(dirname(metricsPath), { recursive: true });
}

const startEpoch = Date.now();
const bootHr = process.hrtime.bigint();

function record(obj) {
  if (!metricsPath) return;
  try {
    appendFileSync(metricsPath, JSON.stringify({ t: Date.now(), ...obj }) + "\n");
  } catch {
    // Never let instrumentation break the server under test.
  }
}

// Event-loop lag sampler: a 100 ms timer whose drift measures loop delay.
let lagWindowMax = 0;
let lastTick = Number(process.hrtime.bigint() / 1000000n);
const lagTimer = setInterval(() => {
  const now = Number(process.hrtime.bigint() / 1000000n);
  const drift = now - lastTick - 100;
  lastTick = now;
  if (drift > lagWindowMax) lagWindowMax = drift;
}, 100);
lagTimer.unref();

function fdCount() {
  try {
    // Linux-only; on other platforms this is null and the FD check is skipped.
    return readdirSync("/proc/self/fd").length;
  } catch {
    return null;
  }
}

// Fault-injection: an intentional slow leak so the harness can prove it
// detects heap growth (the failing-first leg of the soak test). A 131072-
// element SMI array occupies ~1 MiB of V8 heap (verified: exactly 1.0 MB per
// array in heapUsed). Strings and typed arrays are unsuitable: V8 stores
// padded strings as tiny cons-strings and typed-array backing stores are
// external memory, so neither moves heapUsed.
const leakSink = [];
if (process.env.SOAK_INJECT_LEAK === "1") {
  const leakTimer = setInterval(() => {
    leakSink.push(new Array(131072).fill(7)); // ~1 MiB per second window
  }, 1000);
  leakTimer.unref();
}

// Fault-injection: one unhandled rejection, to prove the harness fails on it.
// The process still crashes afterwards exactly as it would without the
// listener (default --unhandled-rejections=throw behavior): the listener
// records the rejection and rethrows it asynchronously, so observable
// behavior is unchanged — crash, non-zero exit.
let rejectionRecorded = false;
process.on("unhandledRejection", (reason) => {
  if (rejectionRecorded) return;
  rejectionRecorded = true;
  record({ type: "unhandledRejection", message: String(reason?.message ?? reason) });
  setImmediate(() => { throw reason instanceof Error ? reason : new Error(String(reason)); });
});

if (process.env.SOAK_INJECT_REJECTION === "1") {
  // Fires after the server's typical boot window (~4-10 s) so the rejection
  // lands mid-run. If boot is slower and the crash lands during boot, the
  // harness still fails correctly via the boot-crash + rejection records.
  const t = setTimeout(() => {
    Promise.reject(new Error("soak-injected-unhandled-rejection"));
  }, 12000);
  t.unref();
}

// 1 Hz sample writer.
let sampleCount = 0;
const sampleTimer = setInterval(() => {
  sampleCount += 1;
  const mem = process.memoryUsage();
  const elapsedS = Number(process.hrtime.bigint() - bootHr) / 1e9;
  record({
    type: "sample",
    n: sampleCount,
    elapsedS: Math.round(elapsedS),
    heapUsedMB: mem.heapUsed / 1048576,
    heapTotalMB: mem.heapTotal / 1048576,
    rssMB: mem.rss / 1048576,
    externalMB: mem.external / 1048576,
    lagMaxWindowMs: Math.round(lagWindowMax),
    fd: fdCount(),
  });
  lagWindowMax = 0;
}, 1000);
sampleTimer.unref();

record({
  type: "instrumentation",
  pid: process.pid,
  node: process.version,
  bootAt: new Date(startEpoch).toISOString(),
  injectLeak: process.env.SOAK_INJECT_LEAK === "1",
  injectRejection: process.env.SOAK_INJECT_REJECTION === "1",
});
