#!/usr/bin/env node
// room-telemetry-collector.mjs — FIX-54 (WAVE-300 ranked-fixes burn-down)
//
// Read-only room telemetry collector with self-instrumentation. It samples
// room read-latency (p50/p99), read timeout rate, and event-emission rate,
// and fires a `metric.surface_degraded` alarm condition when reads degrade.
//
// READ-ONLY DISCIPLINE (audited by tests/room-telemetry-collector.test.js):
//   - The collector itself performs no HTTP at all; every room read goes
//     through the injected `probe({ signal, cursor })` function.
//   - While a probe runs, `guardedProbe` replaces globalThis.fetch with a
//     guard that throws on any non-GET/HEAD method, so even a buggy probe
//     adapter cannot mutate room state.
//   - The only writes the collector performs are its own local files:
//     the JSONL output file and the cursor checkpoint file (atomic tmp+rename).
//   - It never imports server-side store modules and never touches room state.
//
// Cursor checkpointing to disk is REQUIRED: checkpoint.json carries the read
// cursor, the sliding window, counters and alarm state, so a restart resumes
// without re-scanning.
//
// Usage:
//   node scripts/room-telemetry-collector.mjs collect --out <dir> [options]
//   node scripts/room-telemetry-collector.mjs collect --out <dir> --once
//   node scripts/room-telemetry-collector.mjs --help
//
// Live reads use ROOM_AGENT_CONFIG (saved connection dir) or
// ROOM_AGENT_ORIGIN / ROOM_AGENT_ROOM / ROOM_AGENT_TOKEN (/ ROOM_AGENT_MEMBER).
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { agentConnectionFromEnvironment } from "../client/agent-connection.mjs";

export const SCHEMA_VERSION = 1;
export const ALARM_NAME = "metric.surface_degraded";

// ---------------------------------------------------------------------------
// Pure math: percentiles over a latency sample set.
// ---------------------------------------------------------------------------

/** Linear-interpolation percentile over an ascending-sorted array. */
export function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) throw new Error("percentile of empty sample set");
  if (!(p >= 0 && p <= 100)) throw new Error("percentile out of range");
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** {count,min,max,mean,p50,p99} for successful-read latencies (ms). */
export function summarizeReadLatencies(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p99: percentile(sorted, 99),
  };
}

// ---------------------------------------------------------------------------
// Sliding window of read samples.
// ---------------------------------------------------------------------------

export class ReadWindow {
  constructor(maxSamples = 200) {
    if (!Number.isSafeInteger(maxSamples) || maxSamples < 1) throw new Error("window needs a positive size");
    this.maxSamples = maxSamples;
    this.samples = [];
  }

  push(sample) {
    this.samples.push({
      latencyMs: sample.latencyMs,
      ok: sample.ok === true,
      timedOut: sample.timedOut === true,
      error: sample.error === true,
      at: sample.at,
      sequence: Number.isSafeInteger(sample.sequence) ? sample.sequence : 0,
      eventCountTotal: Number.isSafeInteger(sample.eventCountTotal) ? sample.eventCountTotal : 0,
    });
    while (this.samples.length > this.maxSamples) this.samples.shift();
  }

  stats(nowMs) {
    const reads = this.samples.length;
    const okSamples = this.samples.filter(s => s.ok);
    const timeouts = this.samples.filter(s => s.timedOut).length;
    const errors = this.samples.filter(s => s.error && !s.timedOut).length;
    const first = this.samples[0], last = this.samples[this.samples.length - 1];
    let eventRatePerSec = 0;
    if (first && last && last.at > first.at) {
      eventRatePerSec = (last.eventCountTotal - first.eventCountTotal) / ((last.at - first.at) / 1000);
    }
    return {
      reads,
      okReads: okSamples.length,
      timeouts,
      errors,
      timeoutRate: reads ? timeouts / reads : 0,
      eventRatePerSec,
      eventCountTotal: last ? last.eventCountTotal : 0,
      sequence: last ? last.sequence : 0,
      latency: summarizeReadLatencies(okSamples.map(s => s.latencyMs)),
      windowMs: first && last ? last.at - first.at : 0,
      evaluatedAt: new Date(nowMs).toISOString(),
    };
  }

  snapshot() {
    return { maxSamples: this.maxSamples, samples: this.samples.slice(-this.maxSamples) };
  }

  restore(state) {
    if (!state || !Array.isArray(state.samples)) return;
    this.maxSamples = Number.isSafeInteger(state.maxSamples) && state.maxSamples > 0 ? state.maxSamples : this.maxSamples;
    this.samples = state.samples.slice(-this.maxSamples);
  }
}

// ---------------------------------------------------------------------------
// Collector.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  intervalMs: 5000,
  readTimeoutMs: 10000,
  windowSamples: 200,
  degradedP99Ms: 2000,
  degradedTimeoutRate: 0.05,
  minSamplesForAlarm: 10,
  emitEvery: 12,
  checkpointEvery: 12,
};

export class TelemetryCollector {
  constructor({ probe, checkpointPath, outputPath, clock = () => Date.now(), sleeper = sleep, options = {} }) {
    if (typeof probe !== "function") throw new Error("collector needs a probe function");
    if (typeof checkpointPath !== "string" || !checkpointPath) throw new Error("collector needs a checkpointPath");
    if (typeof outputPath !== "string" || !outputPath) throw new Error("collector needs an outputPath");
    this.probe = probe;
    this.checkpointPath = checkpointPath;
    this.outputPath = outputPath;
    this.clock = clock;
    this.sleeper = sleeper;
    this.options = { ...DEFAULTS, ...options };
    this.window = new ReadWindow(this.options.windowSamples);
    this.cursor = { sequence: 0, eventCountTotal: 0 };
    this.self = { probes: 0, okReads: 0, timeouts: 0, errors: 0, checkpointWrites: 0, checkpointWriteLatencies: [], restarts: 0 };
    this.alarm = { active: false, firedAt: null, clearedAt: null };
    this.ticks = 0;
    this.startedAt = this.clock();
    this.stopped = false;
    this.#restore();
  }

  #restore() {
    const saved = TelemetryCollector.loadCheckpoint(this.checkpointPath);
    if (!saved) return;
    this.window.restore(saved.window);
    if (saved.cursor) {
      this.cursor.sequence = Number.isSafeInteger(saved.cursor.sequence) ? saved.cursor.sequence : 0;
      this.cursor.eventCountTotal = Number.isSafeInteger(saved.cursor.eventCountTotal) ? saved.cursor.eventCountTotal : 0;
    }
    if (saved.self) {
      for (const key of ["probes", "okReads", "timeouts", "errors", "checkpointWrites"]) {
        if (Number.isSafeInteger(saved.self[key])) this.self[key] = saved.self[key];
      }
      this.self.restarts = (Number.isSafeInteger(saved.self.restarts) ? saved.self.restarts : 0) + 1;
    } else {
      this.self.restarts = 1;
    }
    if (saved.alarm && saved.alarm.active === true) this.alarm = { active: true, firedAt: saved.alarm.firedAt ?? null, clearedAt: null };
  }

  static loadCheckpoint(path) {
    try {
      const raw = readFileSync(path, "utf8");
      const value = JSON.parse(raw);
      if (!value || value.v !== SCHEMA_VERSION) return null;
      return value;
    } catch {
      return null;
    }
  }

  /** Read-only guard: while the probe runs, any non-GET/HEAD fetch throws. */
  async guardedProbe(probeFn, args) {
    const realFetch = globalThis.fetch;
    const guard = (input, init) => {
      const method = String(init?.method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        const error = new Error(`read-only guard blocked ${method} request to the room`);
        error.code = "read_only_violation";
        throw error;
      }
      return realFetch(input, init);
    };
    globalThis.fetch = guard;
    try {
      return await probeFn(args);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  async #probeWithTimeout() {
    const { readTimeoutMs } = this.options;
    const controller = new AbortController();
    let timedOut = false;
    // The timeout arm must not preempt a probe that settles promptly: the
    // injected sleeper models elapsed time, so it yields to the event loop
    // (macrotask or later) rather than resolving synchronously. A probe that
    // only needs microtasks therefore always wins the race; a genuinely
    // stuck probe loses it and is counted as a timeout.
    const timeout = this.sleeper(readTimeoutMs).then(() => {
      timedOut = true;
      controller.abort();
      const error = new Error(`room read timed out after ${readTimeoutMs}ms`);
      error.code = "read_timeout";
      throw error;
    });
    try {
      const t0 = this.clock();
      const result = await Promise.race([
        this.guardedProbe(this.probe, { signal: controller.signal, cursor: { ...this.cursor } }),
        timeout,
      ]);
      return { result, latencyMs: this.clock() - t0, timedOut: false };
    } catch (error) {
      if (timedOut || error?.code === "read_timeout") return { error, latencyMs: readTimeoutMs, timedOut: true };
      return { error, latencyMs: 0, timedOut: false };
    }
  }

  /** One sample cycle: probe, record, maybe emit, maybe checkpoint, evaluate alarm. */
  async tick() {
    const at = this.clock();
    const outcome = await this.#probeWithTimeout();
    // A read-only violation is a probe-adapter bug, not a transient read
    // failure: surface it loudly instead of recording it as an error sample.
    if (outcome.error?.code === "read_only_violation") throw outcome.error;
    this.self.probes += 1;
    if (outcome.timedOut) {
      this.self.timeouts += 1;
      this.window.push({ latencyMs: outcome.latencyMs, ok: false, timedOut: true, at, sequence: this.cursor.sequence, eventCountTotal: this.cursor.eventCountTotal });
    } else if (outcome.error) {
      this.self.errors += 1;
      this.window.push({ latencyMs: outcome.latencyMs, ok: false, error: true, at, sequence: this.cursor.sequence, eventCountTotal: this.cursor.eventCountTotal });
    } else {
      this.self.okReads += 1;
      const { sequence = 0, eventCount = 0 } = outcome.result ?? {};
      if (Number.isSafeInteger(sequence) && sequence > this.cursor.sequence) this.cursor.sequence = sequence;
      if (Number.isSafeInteger(eventCount) && eventCount > 0) this.cursor.eventCountTotal += eventCount;
      this.window.push({ latencyMs: outcome.latencyMs, ok: true, at, sequence: this.cursor.sequence, eventCountTotal: this.cursor.eventCountTotal });
    }
    this.ticks += 1;
    this.#evaluateAlarm(at);
    if (this.ticks % this.options.emitEvery === 0) this.emit({ kind: "sample" });
    if (this.ticks % this.options.checkpointEvery === 0) await this.checkpoint();
    return this.stats();
  }

  #evaluateAlarm(at) {
    const { degradedP99Ms, degradedTimeoutRate, minSamplesForAlarm } = this.options;
    const st = this.window.stats(at);
    const reasons = [];
    if (st.reads >= minSamplesForAlarm) {
      if (st.timeoutRate > degradedTimeoutRate) reasons.push(`timeout_rate ${st.timeoutRate.toFixed(3)} > ${degradedTimeoutRate}`);
      if (st.okReads >= 3 && st.latency && st.latency.p99 > degradedP99Ms) {
        reasons.push(`read p99 ${st.latency.p99.toFixed(1)}ms > ${degradedP99Ms}ms`);
      }
    }
    const degraded = reasons.length > 0;
    if (degraded && !this.alarm.active) {
      this.alarm = { active: true, firedAt: new Date(at).toISOString(), clearedAt: null };
      this.emit({ kind: "alarm", alarm: ALARM_NAME, active: true, reason: reasons.join("; ") });
    } else if (!degraded && this.alarm.active) {
      this.alarm = { active: false, firedAt: this.alarm.firedAt, clearedAt: new Date(at).toISOString() };
      this.emit({ kind: "alarm", alarm: ALARM_NAME, active: false, reason: "reads recovered below alarm thresholds" });
    }
  }

  selfStats() {
    const writes = this.self.checkpointWriteLatencies;
    return {
      probes: this.self.probes,
      okReads: this.self.okReads,
      timeouts: this.self.timeouts,
      errors: this.self.errors,
      checkpointWrites: this.self.checkpointWrites,
      checkpointWriteMsP50: writes.length ? percentile([...writes].sort((a, b) => a - b), 50) : 0,
      uptimeMs: this.clock() - this.startedAt,
      restarts: this.self.restarts,
      alarmActive: this.alarm.active,
    };
  }

  stats() {
    const now = this.clock();
    return {
      v: SCHEMA_VERSION,
      reads: this.self.probes,
      cursor: { ...this.cursor },
      window: this.window.stats(now),
      self: this.selfStats(),
    };
  }

  emit(record) {
    mkdirSync(dirname(this.outputPath), { recursive: true });
    const line = JSON.stringify({ v: SCHEMA_VERSION, ts: new Date(this.clock()).toISOString(), ...record, window: this.window.stats(this.clock()), self: this.selfStats() });
    appendFileSync(this.outputPath, line + "\n");
    return line;
  }

  /** Atomic cursor checkpoint to disk (tmp file + rename). Required for resume. */
  async checkpoint() {
    const t0 = this.clock();
    const payload = {
      v: SCHEMA_VERSION,
      updatedAt: new Date(t0).toISOString(),
      cursor: { ...this.cursor },
      window: this.window.snapshot(),
      self: { ...this.self, checkpointWriteLatencies: this.self.checkpointWriteLatencies.slice(-50) },
      alarm: { ...this.alarm },
      ticks: this.ticks,
    };
    mkdirSync(dirname(this.checkpointPath), { recursive: true });
    const tmp = `${this.checkpointPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload) + "\n");
    renameSync(tmp, this.checkpointPath);
    const writeMs = this.clock() - t0;
    this.self.checkpointWrites += 1;
    this.self.checkpointWriteLatencies.push(writeMs);
    if (this.self.checkpointWriteLatencies.length > 50) this.self.checkpointWriteLatencies.shift();
    this.emit({ kind: "checkpoint", path: this.checkpointPath });
  }

  async run({ maxTicks = Infinity } = {}) {
    while (!this.stopped && this.ticks < maxTicks) {
      await this.tick();
      if (!this.stopped && this.ticks < maxTicks) await this.sleeper(this.options.intervalMs);
    }
    await this.checkpoint();
  }

  stop() { this.stopped = true; }
}

// ---------------------------------------------------------------------------
// Live probe adapter: GET-only reads through RoomAgentClient.
// ---------------------------------------------------------------------------

/**
 * Build the production probe from the environment. The probe performs exactly
 * one GET read per tick (room messages after the checkpointed cursor), which
 * yields both the read latency sample and the event-emission signal.
 */
export function roomProbeFromEnvironment(env = process.env) {
  const config = agentConnectionFromEnvironment(env);
  const client = new RoomAgentClient(config);
  return async ({ signal, cursor }) => {
    const page = await client.roomMessages({ after: cursor?.sequence ?? 0, limit: 10, signal });
    const messages = Array.isArray(page?.messages) ? page.messages : [];
    const lastSequence = messages.length ? messages[messages.length - 1].sequence : (cursor?.sequence ?? 0);
    return { sequence: lastSequence, eventCount: messages.length };
  };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { command: null, out: null, once: false, options: {} };
  const rest = [...argv];
  const num = (name) => {
    const i = rest.indexOf(name);
    if (i === -1) return undefined;
    const value = Number(rest.splice(i, 2)[1]);
    if (!Number.isFinite(value)) throw new Error(`${name} needs a number`);
    return value;
  };
  args.command = rest.shift() ?? null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--out") args.out = rest[++i];
    else if (rest[i] === "--once") args.once = true;
    else if (rest[i] === "--help" || rest[i] === "-h") args.command = "help";
  }
  const map = { "--interval-ms": "intervalMs", "--read-timeout-ms": "readTimeoutMs", "--window": "windowSamples",
    "--p99-alarm-ms": "degradedP99Ms", "--timeout-rate-alarm": "degradedTimeoutRate",
    "--min-samples": "minSamplesForAlarm", "--emit-every": "emitEvery", "--checkpoint-every": "checkpointEvery",
    "--duration-ms": "durationMs" };
  for (const [flag, key] of Object.entries(map)) {
    const value = num(flag);
    if (value !== undefined) args.options[key] = value;
  }
  return args;
}

const HELP = `room-telemetry-collector (FIX-54) — read-only room telemetry collector.

Samples room read-latency (p50/p99), read timeout rate, and event-emission
rate; fires a metric.surface_degraded alarm when reads degrade. Checkpoints
its cursor to disk so restarts resume without re-scanning.

Read-only: the only writes are the local JSONL output and the checkpoint
file. Room reads are GET-only, enforced at runtime by a fetch guard.

Usage:
  node scripts/room-telemetry-collector.mjs collect --out <dir> [options]
  node scripts/room-telemetry-collector.mjs collect --out <dir> --once

Options:
  --interval-ms N        ms between samples (default 5000)
  --duration-ms N        stop after N ms (collect mode)
  --read-timeout-ms N    per-read timeout; exceeded reads count as timeouts (default 10000)
  --window N             sliding-window sample count (default 200)
  --p99-alarm-ms N       p99 latency alarm threshold (default 2000)
  --timeout-rate-alarm F timeout-rate alarm threshold (default 0.05)
  --min-samples N        reads before the alarm can fire (default 10)
  --emit-every N         emit a sample record every N ticks (default 12)
  --checkpoint-every N   checkpoint every N ticks (default 12)

Environment: ROOM_AGENT_CONFIG (saved connection dir) or ROOM_AGENT_ORIGIN,
ROOM_AGENT_ROOM, ROOM_AGENT_TOKEN, ROOM_AGENT_MEMBER.
`;

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.command === "help" || args.command === "--help" || args.command === "-h" || args.command === null) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.command !== "collect" || !args.out) {
    process.stderr.write("usage: node scripts/room-telemetry-collector.mjs collect --out <dir> [--once] [options]\n");
    return 2;
  }
  const outDir = args.out;
  const collector = new TelemetryCollector({
    probe: roomProbeFromEnvironment(env),
    checkpointPath: join(outDir, "checkpoint.json"),
    outputPath: join(outDir, "telemetry.jsonl"),
    options: args.options,
  });
  if (args.once) {
    const stats = await collector.tick();
    await collector.checkpoint();
    process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
    return 0;
  }
  const stop = () => collector.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const durationMs = args.options.durationMs;
  const tickBudget = Number.isFinite(durationMs)
    ? Math.max(1, Math.ceil(durationMs / (collector.options.intervalMs || 5000)) + 1)
    : Infinity;
  await collector.run({ maxTicks: tickBudget });
  return 0;
}

const invoked = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop() ?? "");
if (invoked) {
  main().then(code => process.exit(code), error => { process.stderr.write(`telemetry-collector: ${error?.message ?? error}\n`); process.exit(1); });
}
