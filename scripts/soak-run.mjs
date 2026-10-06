// Q007 soak harness — orchestrator.
//
// Boots the real server in a child process (with scripts/soak-preload.mjs
// instrumentation loaded via --import; the server's own code is untouched),
// applies sustained HTTP load, then evaluates memory growth, event-loop lag,
// file-descriptor growth, unhandled rejections, and crashes.
//
// Usage:
//   SOAK_DURATION_S=900 SOAK_LOAD_RPS=10 node scripts/soak-run.mjs
//   SOAK_DURATION_S=86400 node scripts/soak-run.mjs   # the full 24 h run
//
// Exit code: 0 = PASS, 1 = FAIL (threshold exceeded, rejection, or crash),
//            2 = harness error (could not boot the server, etc).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const cfg = {
  durationS: int("SOAK_DURATION_S", 900),
  loadRps: num("SOAK_LOAD_RPS", 10),
  maxHeapGrowthMB: num("SOAK_MAX_HEAP_GROWTH_MB", 25),
  maxLagP99Ms: num("SOAK_MAX_LAG_P99_MS", 250),
  maxFdGrowth: int("SOAK_MAX_FD_GROWTH", 25),
  crashRecovery: bool("SOAK_CRASH_RECOVERY", false),
  crashAtS: int("SOAK_CRASH_AT_S", 300),
  injectLeak: bool("SOAK_INJECT_LEAK", false),
  injectRejection: bool("SOAK_INJECT_REJECTION", false),
};
function int(name, dflt) { const v = process.env[name]; return v === undefined || v === "" ? dflt : Number.parseInt(v, 10); }
function num(name, dflt) { const v = process.env[name]; return v === undefined || v === "" ? dflt : Number(v); }
function bool(name, dflt) { const v = process.env[name]; return v === undefined || v === "" ? dflt : v === "1" || v === "true"; }

if (!Number.isFinite(cfg.durationS) || cfg.durationS < 5) fail(2, `SOAK_DURATION_S must be >= 5 (got ${cfg.durationS})`);
if (!Number.isFinite(cfg.loadRps) || cfg.loadRps < 1 || cfg.loadRps > 500) fail(2, `SOAK_LOAD_RPS must be 1..500 (got ${cfg.loadRps})`);

const workdir = mkdirSync(join(tmpdir(), `soak-${process.pid}-${Date.now()}`), { recursive: true });
const dbPath = join(workdir, "room.sqlite");
const metricsPath = join(workdir, "metrics.ndjson");
const reportPath = process.env.SOAK_REPORT_PATH || join(workdir, "soak-report.json");

const port = await pickPort();
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  PORT: String(port),
  HOST: "127.0.0.1",
  ROOM_ORIGIN: origin,
  ROOM_DB: dbPath,
  ROOM_INSTANCE_LOCK_PATH: join(workdir, ".soak.lock"),
  SOAK_METRICS_PATH: metricsPath,
  SOAK_INJECT_LEAK: cfg.injectLeak ? "1" : "0",
  SOAK_INJECT_REJECTION: cfg.injectRejection ? "1" : "0",
};

const report = {
  verdict: "fail", failures: [], config: { ...cfg, port, workdir },
  startedAt: new Date().toISOString(),
  boot: null, load: null, metrics: null, crashRecovery: null, finishedAt: null,
};

console.log(`[soak] port=${port} duration=${cfg.durationS}s rps=${cfg.loadRps} db=${dbPath}`);

// Exclusion windows: sample timestamps inside any window are not evaluated
// against thresholds. Boot cold-start, post-ready warmup, and crash-recovery
// restarts all block the loop for legitimate one-off reasons.
const WARMUP_MS = 5000;
const excludeWindows = [];

// ---- boot the server -------------------------------------------------------
let child = spawn(process.execPath, ["--import", join(root, "scripts", "soak-preload.mjs"), "server.mjs"], {
  cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
});
let unexpectedExit = null;
child.on("exit", (code, signal) => {
  unexpectedExit = { code, signal, at: Date.now() };
});
child.stdout.on("data", () => { /* readiness tracked below */ });
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let ready = false;
const bootT0 = Date.now();
try {
  ready = await waitFor(() => unexpectedExit === null && probeReady(), 30_000, "server ready");
} catch (e) {
  unexpectedExit = unexpectedExit || { code: null, signal: "boot-timeout" };
}
const bootMs = Date.now() - bootT0;
const readyAt = Date.now(); // first successful readiness probe
report.boot = { ready, bootMs, readyAt, unexpectedExit };
if (!ready) {
  if (unexpectedExit) {
    report.failures.push(`server crashed during boot (exit=${unexpectedExit.code} signal=${unexpectedExit.signal})`);
  } else {
    report.failures.push("server never became ready (readiness probe timed out)");
  }
  console.log(`[soak] server not ready: ${JSON.stringify(unexpectedExit)}`);
} else {
  console.log(`[soak] server ready in ${bootMs} ms`);
}

// ---- load driver -----------------------------------------------------------
// (skipped entirely when the server never became ready)
const stats = { requests: 0, ok2xx: 0, byStatus: {}, errors: 0 };
let crashRecoveredAt = null;
let runCrashed = unexpectedExit !== null;

if (ready) {
  const paths = ["/api/health", "/.well-known/agent-card.json", "/growth/health", "/"];
  const { Agent, get } = await import("node:http");
  const agent = new Agent({ keepAlive: true, maxSockets: 32 });
  const endAt = Date.now() + cfg.durationS * 1000;
  let pathIdx = 0;

  const driveTimer = setInterval(drive, Math.max(1, Math.round(1000 / cfg.loadRps)));
  function drive() {
    if (Date.now() >= endAt) { clearInterval(driveTimer); return; }
    const path = paths[pathIdx % paths.length];
    pathIdx += 1;
    stats.requests += 1;
    void hit(path);
  }
  function hit(path) {
    return new Promise((resolve) => {
      const req = get(origin + path, { agent }, (res) => {
        stats.byStatus[res.statusCode] = (stats.byStatus[res.statusCode] || 0) + 1;
        if (res.statusCode >= 200 && res.statusCode < 300) stats.ok2xx += 1;
        res.resume(); res.on("end", resolve);
      });
      req.on("error", () => { stats.errors += 1; resolve(); });
      req.setTimeout(10_000, () => { req.destroy(); stats.errors += 1; resolve(); });
    });
  }

  // Crash-recovery leg: kill -9 mid-run (not counted as a failure), restart the
  // same DB on the same port, verify the server serves again, measure downtime.
  // Samples inside the kill/restart window are excluded from evaluation: the
  // fresh process's own cold start is not soak lag.
  if (cfg.crashRecovery) {
    const killAt = Date.now() + Math.min(cfg.crashAtS * 1000, (cfg.durationS - 60) * 1000);
    const killTimer = setInterval(async () => {
      if (Date.now() < killAt) return;
      clearInterval(killTimer);
      if (unexpectedExit) return; // server already dead: real crash, leg is moot
      clearInterval(driveTimer);
      runCrashed = false; // the intentional SIGKILL is not a crash
      const killStartedAt = Date.now();
      console.log("[soak] crash-recovery leg: SIGKILL");
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
      child = respawn();
      const ok = await waitFor(() => probeReady(), 30_000, "server re-ready").catch(() => false);
      const downtimeMs = Date.now() - killStartedAt;
      crashRecoveredAt = { ok, downtimeMs };
      if (ok) excludeWindows.push({ from: killStartedAt, to: Date.now() + WARMUP_MS, reason: "crash-recovery restart" });
      console.log(`[soak] server restarted after SIGKILL: ready=${ok} downtime=${downtimeMs}ms`);
      if (!ok) { report.failures.push("crash recovery failed: server did not come back after SIGKILL"); }
      else if (Date.now() < endAt) setInterval(drive, Math.max(1, Math.round(1000 / cfg.loadRps))).unref();
    }, 250);
    killTimer.unref();
  }

  // NOTE: this interval must stay ref'd: it is the only handle guaranteed to
  // outlive the run. (If the child crashes, keep-alive sockets all close and
  // an unref'd waiter would let the loop drain -> Node exit 13.)
  await new Promise((r) => {
    const t = setInterval(() => { if (Date.now() >= endAt) { clearInterval(t); r(); } }, 500);
  });
  report.crashRecovery = crashRecoveredAt;
  report.load = { ...stats, durationS: cfg.durationS };

  // ---- graceful shutdown ---------------------------------------------------
  clearInterval(driveTimer);
  if (unexpectedExit) {
    runCrashed = true;
    report.failures.push(`server crashed during soak (exit=${unexpectedExit.code} signal=${unexpectedExit.signal})`);
    console.log(`[soak] server exited during run: ${JSON.stringify(unexpectedExit)}`);
  } else {
    console.log("[soak] SIGTERM for graceful shutdown");
    const shutdownAt = Date.now();
    report.shutdownAt = shutdownAt;
    child.kill("SIGTERM");
    const shutdownExit = await new Promise((r) => {
      const to = setTimeout(() => { child.kill("SIGKILL"); }, 15_000);
      child.once("exit", (code, signal) => { clearTimeout(to); r({ code, signal }); });
    });
    // Graceful SIGTERM shutdown ends with process.exit(0); anything else is a crash.
    if (shutdownExit.code !== 0 || shutdownExit.signal !== null) {
      runCrashed = true;
      report.failures.push(`server exited abnormally on shutdown (exit=${shutdownExit.code} signal=${shutdownExit.signal})`);
    }
  }
} else if (unexpectedExit === null) {
  // Never became ready but still alive (hung boot): put it down so no
  // orphan server process survives the harness.
  child.kill("SIGKILL");
}

// ---- evaluate metrics ------------------------------------------------------
// Boot and shutdown windows are excluded from threshold evaluation: the
// server's synchronous cold-start work (schema/integrity) and the graceful
// shutdown sequence (snapshot writes) legitimately block the loop and are
// not soak regressions. A 5 s warmup after first readiness lets the loop
// settle under load before measurement starts.
const samples = existsSync(metricsPath)
  ? readFileSync(metricsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const rejections = samples.filter((s) => s.type === "unhandledRejection");
const evalFrom = readyAt + WARMUP_MS;
excludeWindows.push({ from: 0, to: evalFrom, reason: "boot + warmup" });
const evalTo = report.shutdownAt || Date.now();
const data = samples.filter((s) =>
  s.type === "sample" && s.t < evalTo &&
  !excludeWindows.some((w) => s.t >= w.from && s.t < w.to));
report.metricsExclusions = {
  warmupMs: WARMUP_MS,
  totalSamples: samples.filter((s) => s.type === "sample").length,
  evaluatedSamples: data.length,
  windows: excludeWindows,
};

if (rejections.length > 0) {
  report.failures.push(`${rejections.length} unhandled rejection(s): ${rejections[0].message}`);
}
if (data.length < 5) {
  report.failures.push(`only ${data.length} metric samples collected; instrumentation may be broken`);
} else {
  const mem = (xs) => xs.map((s) => s.heapUsedMB).sort((a, b) => a - b);
  const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const k = Math.max(3, Math.floor(data.length * 0.1));
  const first = mem(data.slice(0, k)), last = mem(data.slice(-k));
  const growthMB = q(last, 0.5) - q(first, 0.5);
  const lagP99 = q(data.map((s) => s.lagMaxWindowMs).sort((a, b) => a - b), 0.99);
  const lagMax = Math.max(...data.map((s) => s.lagMaxWindowMs));
  const fds = data.map((s) => s.fd).filter((f) => f !== null);
  const fdGrowth = fds.length ? fds[fds.length - 1] - fds[0] : null;
  report.metrics = {
    samples: data.length,
    heapFirstMB: round(q(first, 0.5)), heapLastMB: round(q(last, 0.5)), heapGrowthMB: round(growthMB),
    lagP99Ms: lagP99, lagMaxMs: lagMax,
    fdFirst: fds[0] ?? null, fdLast: fds[fds.length - 1] ?? null, fdGrowth,
    unhandledRejections: rejections.length, crashed: runCrashed,
    requests: stats.requests, ok2xx: stats.ok2xx, byStatus: stats.byStatus, errors: stats.errors,
  };
  console.log(`[soak] heap ${report.metrics.heapFirstMB} -> ${report.metrics.heapLastMB} MB (Δ ${report.metrics.heapGrowthMB})`
    + ` | lag p99=${lagP99}ms max=${lagMax}ms | fd ${fds[0] ?? "?"} -> ${fds[fds.length - 1] ?? "?"}`);
  if (growthMB > cfg.maxHeapGrowthMB) report.failures.push(`heap growth ${round(growthMB)} MB > ${cfg.maxHeapGrowthMB} MB threshold`);
  if (lagP99 > cfg.maxLagP99Ms) report.failures.push(`event-loop lag p99 ${lagP99} ms > ${cfg.maxLagP99Ms} ms threshold`);
  if (fdGrowth !== null && fdGrowth > cfg.maxFdGrowth) report.failures.push(`fd growth ${fdGrowth} > ${cfg.maxFdGrowth} threshold`);
}

finish();

function respawn() {
  unexpectedExit = null;
  const c = spawn(process.execPath, ["--import", join(root, "scripts", "soak-preload.mjs"), "server.mjs"], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
  });
  c.on("exit", (code, signal) => { unexpectedExit = { code, signal, at: Date.now() }; });
  c.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  return c;
}

async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch { /* retry */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function probeReady() {
  try {
    const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch { return false; }
}

async function pickPort() {
  const { createServer } = await import("node:net");
  for (let i = 0; i < 20; i += 1) {
    const port = 40000 + Math.floor(Math.random() * 9999);
    const ok = await new Promise((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error("could not find a free port");
}

function round(v) { return Math.round(v * 10) / 10; }

function fail(code, message) {
  console.error(`[soak] ${message}`);
  process.exit(code);
}

function finish() {
  report.finishedAt = new Date().toISOString();
  report.verdict = report.failures.length === 0 ? "pass" : "fail";
  try { writeFileSync(reportPath, JSON.stringify(report, null, 2)); } catch { /* best effort */ }
  console.log(`[soak] verdict=${report.verdict} report=${reportPath}`);
  for (const f of report.failures) console.log(`[soak] FAIL: ${f}`);
  process.exit(report.failures.length === 0 ? 0 : 1);
}
