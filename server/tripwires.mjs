// server/tripwires.mjs — in-process trip-wire gauges (WAVE-300 telemetry productionization).
//
// LOAD-BEARING CONSTRAINT: telemetry itself must be cheap.
// - Trip-wire checks emit ZERO room events.
// - ZERO writes to any read path.
// - Nothing here runs per request except a handful of in-memory counter ops
//   (penalty-box entry, command-outcome recording). Every expensive read
//   (room-store SQL, event-loop histogram sampling) happens on the slow
//   collect() tick (>= 60 s), never per request — the reaper pattern:
//   compute on tick/sample, never per-request.
//
// Worker-safe: no static node: imports anywhere in this module. The event-loop
// sampler is resolved lazily through process.getBuiltinModule inside try/catch,
// so this module stays importable in runtimes without node:perf_hooks
// (Cloudflare workerd); a missing sampler leaves the event-loop gauge at its
// neutral default instead of breaking module load.
//
// Gauges: { name, value, warnAt, criticalAt, status: ok|warn|critical|unknown, updatedAt }.
// "unknown" only appears when a gauge never held a numeric value; every gauge
// starts at a documented neutral default, so reads are always numeric.

export const PENALTY_WINDOW_MS = 15 * 60 * 1000;
export const COMMAND_OUTCOME_WINDOW_MS = 15 * 60 * 1000;
export const TRIPWIRE_TICK_MS = 60_000;

const GAUGE_DEFS = [
  { name: "event_budget_remaining_ratio", direction: "low", warnAt: 0.2, criticalAt: 0.1,
    initialValue: 1, unit: "ratio",
    description: "Minimum remaining room-event budget across rooms, as a fraction of PILOT_LIMITS.eventsPerRoom. Read from the room store on the slow tick, never per request." },
  { name: "write_limiter_penalty_entries", direction: "high", warnAt: 5, criticalAt: 20,
    inclusive: true, // contract pins warn >= 5, critical >= 20 (not strict >)
    initialValue: 0, unit: "count",
    description: "Write-limiter refusals (penalty-box entries) in the trailing 15-minute window." },
  { name: "event_loop_delay_ms_p99", direction: "high", warnAt: 50, criticalAt: 200,
    initialValue: 0, unit: "ms",
    description: "p99 event-loop delay from node:perf_hooks monitorEventLoopDelay, sampled then reset on each tick so every tick measures its own window." },
  { name: "projection_bytes_ratio", direction: "high", warnAt: 0.7, criticalAt: 0.9,
    initialValue: 0, unit: "ratio",
    description: "Largest room projection size as a fraction of PILOT_LIMITS.projectionBytes. Read from the room store on the slow tick, never per request." },
  { name: "commands_silent_timeout_ratio", direction: "high", warnAt: 0.1, criticalAt: 0.3,
    initialValue: 0, unit: "ratio",
    description: "Silent /commands timeouts over all /commands outcomes in the trailing 15-minute window." },
];

const COMMAND_OUTCOMES = new Set(["ok", "429", "5xx", "other", "timeout"]);

// Pure: status for a gauge definition and a numeric value. Thresholds are
// strict by default (a value exactly AT the threshold has not tripped); a def
// may set inclusive: true when the contract pins >= / <= boundaries (the
// write-limiter penalty gauge: warn >= 5, critical >= 20).
export function gaugeStatus(def, value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "unknown";
  if (def.direction === "low") {
    const beyond = def.inclusive ? (v, t) => v <= t : (v, t) => v < t;
    if (beyond(value, def.criticalAt)) return "critical";
    if (beyond(value, def.warnAt)) return "warn";
    return "ok";
  }
  const beyond = def.inclusive ? (v, t) => v >= t : (v, t) => v > t;
  if (beyond(value, def.criticalAt)) return "critical";
  if (beyond(value, def.warnAt)) return "warn";
  return "ok";
}

// Pure: minimum remaining event-budget ratio across room rows ({ sequence }).
// No rooms means no budget consumed, so the ratio reads as full.
export function eventBudgetRemainingRatio(rows, eventsPerRoom) {
  if (!Array.isArray(rows) || rows.length === 0) return 1;
  let min = 1;
  for (const row of rows) {
    const seq = Number(row?.sequence);
    if (!Number.isFinite(seq)) continue;
    const remaining = Math.max(0, eventsPerRoom - seq) / eventsPerRoom;
    if (remaining < min) min = remaining;
  }
  return min;
}

// Pure: largest projection size as a fraction of the limit, from room rows
// ({ projectionBytes }).
export function projectionBytesRatio(rows, projectionBytesLimit) {
  if (!Array.isArray(rows) || rows.length === 0 || !(projectionBytesLimit > 0)) return 0;
  let max = 0;
  for (const row of rows) {
    const bytes = Number(row?.projectionBytes);
    if (!Number.isFinite(bytes) || bytes < 0) continue;
    const ratio = bytes / projectionBytesLimit;
    if (ratio > max) max = ratio;
  }
  return max;
}

// Pure: silent-timeout ratio over a list of recorded command outcomes.
export function silentTimeoutRatio(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return 0;
  let timeouts = 0;
  for (const outcome of outcomes) if (outcome === "timeout") timeouts++;
  return timeouts / outcomes.length;
}

// Lazily resolve the event-loop sampler without a static node: import, so
// runtimes without node:perf_hooks (Cloudflare workerd) degrade to null
// instead of failing module load. The caller enables the monitor.
function defaultEventLoopMonitor() {
  try {
    const getBuiltin = globalThis.process?.getBuiltinModule;
    if (typeof getBuiltin !== "function") return null;
    const { monitorEventLoopDelay } = getBuiltin.call(globalThis.process, "node:perf_hooks") ?? {};
    if (typeof monitorEventLoopDelay !== "function") return null;
    const monitor = monitorEventLoopDelay({ resolution: 20 });
    monitor.enable();
    return monitor;
  } catch {
    return null;
  }
}

export function createTripwires({ now = () => Date.now(), limits = null, eventLoopMonitor = undefined } = {}) {
  // limits: { eventsPerRoom, projectionBytes } — injected (PILOT_LIMITS) so
  // this module never imports server/store.mjs. eventLoopMonitor: an already
  // constructed sampler (tests), or undefined to resolve the default lazily,
  // or null to run without event-loop sampling.
  const values = new Map();
  for (const def of GAUGE_DEFS) values.set(def.name, { value: def.initialValue, updatedAt: 0 });
  const monitor = eventLoopMonitor === undefined ? defaultEventLoopMonitor() : eventLoopMonitor;
  let penaltyEntries = []; // ms timestamps, non-decreasing
  let commandOutcomes = []; // { at, outcome }, non-decreasing

  const defFor = name => {
    const def = GAUGE_DEFS.find(d => d.name === name);
    if (!def) throw new Error(`unknown trip-wire gauge "${name}"`);
    return def;
  };

  const setGauge = (name, value, atMs) => {
    const slot = values.get(name);
    slot.value = value;
    slot.updatedAt = atMs;
  };

  // Prune expired window entries; re-evaluates the windowed gauges so a quiet
  // period decays them back to ok even with no new events.
  const pruneWindows = atMs => {
    const penaltyCutoff = atMs - PENALTY_WINDOW_MS;
    if (penaltyEntries.length > 0 && penaltyEntries[0] < penaltyCutoff) {
      penaltyEntries = penaltyEntries.filter(t => t >= penaltyCutoff);
      setGauge("write_limiter_penalty_entries", penaltyEntries.length, atMs);
    }
    const outcomeCutoff = atMs - COMMAND_OUTCOME_WINDOW_MS;
    if (commandOutcomes.length > 0 && commandOutcomes[0].at < outcomeCutoff) {
      commandOutcomes = commandOutcomes.filter(entry => entry.at >= outcomeCutoff);
      setGauge("commands_silent_timeout_ratio",
        silentTimeoutRatio(commandOutcomes.map(entry => entry.outcome)), atMs);
    }
  };

  const api = {
    gaugeNames() { return GAUGE_DEFS.map(d => d.name); },

    gauge(name) {
      const def = defFor(name);
      const slot = values.get(name);
      return { name, value: slot.value, warnAt: def.warnAt, criticalAt: def.criticalAt,
        status: gaugeStatus(def, slot.value), updatedAt: slot.updatedAt };
    },

    snapshot() {
      return { updatedAt: now(), gauges: GAUGE_DEFS.map(def => api.gauge(def.name)) };
    },

    // Hook point: write-limiter refusal -> penalty-box entry. One in-memory
    // op on the refusal path only.
    recordWriteLimiterPenalty(atMs = now()) {
      penaltyEntries.push(atMs);
      pruneWindows(atMs);
      setGauge("write_limiter_penalty_entries", penaltyEntries.length, atMs);
    },

    // Hook point: /commands request outcome. One in-memory op per request.
    recordCommandOutcome(outcome, atMs = now()) {
      const normalized = COMMAND_OUTCOMES.has(outcome) ? outcome : "other";
      commandOutcomes.push({ at: atMs, outcome: normalized });
      pruneWindows(atMs);
      setGauge("commands_silent_timeout_ratio",
        silentTimeoutRatio(commandOutcomes.map(entry => entry.outcome)), atMs);
    },

    // Per-request tracker for /commands: the caller records the terminal
    // outcome ("ok" | "429" | "5xx" | "other"); a connection that closes
    // before any response was written records "timeout". The listener is
    // request-scoped (once) and removed on close — no leak.
    trackCommandOutcome(res) {
      let settled = false;
      const record = outcome => {
        if (settled) return;
        settled = true;
        api.recordCommandOutcome(outcome);
      };
      try {
        res?.once?.("close", () => {
          if (!settled && res.writableEnded !== true) record("timeout");
        });
      } catch { /* best-effort; the explicit record() path still works */ }
      return { record };
    },

    // Slow tick (>= 60 s): the ONLY place that touches the room store or the
    // event-loop histogram. Never throws — a failed tick keeps the last
    // values and retries on the next tick.
    collect(store) {
      const atMs = now();
      const db = store?.db;
      if (db && limits) {
        try {
          const rows = db.prepare("SELECT sequence, LENGTH(projection) AS projectionBytes FROM rooms").all();
          setGauge("event_budget_remaining_ratio",
            eventBudgetRemainingRatio(rows, limits.eventsPerRoom), atMs);
          setGauge("projection_bytes_ratio",
            projectionBytesRatio(rows, limits.projectionBytes), atMs);
        } catch { /* keep last values; retry next tick */ }
      }
      if (monitor) {
        try {
          // percentile() returns NANOSECONDS; convert to ms. An empty
          // histogram reports a constant 511ns — treat no-sample ticks as
          // unknown rather than a (false) reading.
          const samples = typeof monitor.count === "number" ? monitor.count : -1;
          if (samples === 0) {
            // No samples this window: leave the gauge untouched so it keeps
            // reporting "unknown" instead of the histogram's constant 511ns.
          } else {
            const p99ns = monitor.percentile(99);
            monitor.reset();
            setGauge("event_loop_delay_ms_p99", p99ns / 1e6, atMs);
          }
        } catch { /* keep last value; retry next tick */ }
      }
      pruneWindows(atMs);
    },

    stop() {
      try { monitor?.disable?.(); } catch { /* best-effort */ }
    },
  };
  return api;
}
