// server/event-survival-metrics.mjs — pure calculation helpers for WAVE-500
// event-survival telemetry (W16: dashboard + gauge integration).
//
// These are pure functions: no IO, no store access, no clock. The
// WAVE-300 trip-wire registry (server/tripwires.mjs, telemetry-prod lane)
// wires their outputs into gauges; capture-baseline.mjs and the ops
// dashboard consume the JSON shapes documented below.
//
// Conventions follow telemetry-prod:
// - ratios are plain numbers in [0, 1] unless the input is out of bounds;
// - status thresholds are STRICT (a value exactly at the threshold has not
//   tripped), matching gaugeStatus() in server/tripwires.mjs;
// - caps are INJECTED (defaults match PILOT_LIMITS in server/store.mjs:
//   eventsPerRoom = 1_000_000, projectionBytes = 4 MiB), never imported,
//   so this module stays importable in runtimes without the store.
//
// Spec: docs/wave500/TELEMETRY-EXTENSION.md

// Per-namespace budget thresholds: remaining budget RATIO trips warn below
// 25% and critical below 10% remaining — the per-namespace ladder from
// docs/wave500/EVENT-BUDGET-DESIGN.md §3 (50/25/10 alerts; the 10% tripwire
// must fire before the first 409). Only the two binding edges are gauges:
// the 50% informational alert lives in the dashboard, not the trip-wire.
export const NAMESPACE_WARN_RATIO = 0.25;
export const NAMESPACE_CRITICAL_RATIO = 0.1;

// Rotation watermark phases from docs/wave500/ROOM-ROTATION-DESIGN.md §1
// (75% NOTICE, 85% WARN, 95% FREEZE-PENDING, 100% EXHAUSTED; OR across the
// two budgets — a message-heavy room dies on events, a receipt-heavy room
// dies on projection bytes).
export const WATERMARK_NOTICE = 0.75;
export const WATERMARK_WARN = 0.85;
export const WATERMARK_FREEZE_PENDING = 0.95;
export const WATERMARK_EXHAUSTED = 1.0;

// Compaction effectiveness thresholds: the gauge trips when a sweep saves
// little — paired with the budget gauge (budget burning + compaction
// ineffective = danger). A 0-save sweep can be legitimate (nothing to
// coalesce), so warn/critical here are advisory, never 4xx.
export const COMPACTION_WARN_RATIO = 0.2;
export const COMPACTION_CRITICAL_RATIO = 0.05;

const asCount = v => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

// Pure: per-namespace budget usage.
//
// events: spent-since-enable counters, either
//   - Array<{ namespace: string, events: number }>, or
//   - a plain { [namespace]: number } map.
// budgets: { enabled: boolean, namespaces: { [name]: { floor, burst, maxBorrow } } }
//   where ceiling = floor + burst + maxBorrow (cf. EVENT-BUDGET-DESIGN.md §2:
//   e.g. floor 20k + burst 20k + maxBorrow 10k = 50k ceiling per namespace).
//
// Returns { enabled, namespaces: [...], unmetered: [...] }.
// Each metered namespace: { namespace, consumed, floor, burst, maxBorrow,
// ceiling, borrowed, remaining, remainingRatio, status }.
//   borrowed = max(0, consumed - floor): the chunk drawn from headroom + the
//   shared borrow pool (auto-granted in 5k chunks; never another floor's).
//   remainingRatio = remaining / ceiling; status is ok|warn|critical on the
//   NAMESPACE_*_RATIO edges above. Namespaces seen in events but absent from
//   budgets.namespaces are listed in `unmetered` — visible, never dropped.
export function namespaceUsage(events, budgets) {
  const cfg = budgets ?? {};
  const enabled = cfg.enabled === true;
  const nsConfig = cfg.namespaces ?? {};

  const rows = Array.isArray(events)
    ? events
    : Object.entries(events ?? {}).map(([namespace, count]) => ({ namespace, events: count }));

  const namespaces = [];
  const unmetered = [];
  for (const row of rows) {
    const name = String(row?.namespace ?? "");
    const def = nsConfig[name];
    if (!def) {
      if (name && !unmetered.includes(name)) unmetered.push(name);
      continue;
    }
    const consumed = asCount(row?.events);
    const floor = asCount(def.floor);
    const burst = asCount(def.burst);
    const maxBorrow = asCount(def.maxBorrow);
    const ceiling = floor + burst + maxBorrow;
    const remaining = Math.max(0, ceiling - consumed);
    const remainingRatio = ceiling > 0 ? remaining / ceiling : (consumed > 0 ? 0 : 1);
    const status =
      remainingRatio < NAMESPACE_CRITICAL_RATIO ? "critical"
      : remainingRatio < NAMESPACE_WARN_RATIO ? "warn"
      : "ok";
    namespaces.push({
      namespace: name,
      consumed,
      floor,
      burst,
      maxBorrow,
      ceiling,
      borrowed: Math.max(0, consumed - floor),
      remaining,
      remainingRatio,
      status,
    });
  }
  return { enabled, namespaces, unmetered };
}

// Pure: effectiveness of one compaction/coalescing sweep.
//
// before/after: { bytes: number, events: number } measured around the sweep
// (cf. W10 server/event-coalesce.mjs). Growth (after > before) is not
// negative savings — it reads as 0 saved.
//
// Returns { bytesBefore, bytesAfter, bytesSaved, bytesSavedRatio,
// eventsBefore, eventsAfter, eventsSaved, eventsSavedRatio }.
// bytesSavedRatio is the gauge value: direction "low" in the registry —
// warn below COMPACTION_WARN_RATIO, critical below
// COMPACTION_CRITICAL_RATIO.
export function compactionStats(before, after) {
  const bytesBefore = asCount(before?.bytes);
  const bytesAfter = asCount(after?.bytes);
  const eventsBefore = asCount(before?.events);
  const eventsAfter = asCount(after?.events);
  const bytesSaved = Math.max(0, bytesBefore - bytesAfter);
  const eventsSaved = Math.max(0, eventsBefore - eventsAfter);
  return {
    bytesBefore,
    bytesAfter,
    bytesSaved,
    bytesSavedRatio: bytesBefore > 0 ? bytesSaved / bytesBefore : 0,
    eventsBefore,
    eventsAfter,
    eventsSaved,
    eventsSavedRatio: eventsBefore > 0 ? eventsSaved / eventsBefore : 0,
  };
}

// Pure: rotation watermark — how close a room is to the forced
// rotation/archive path.
//
// sequence: current room sequence (monotonic event count).
// projectionBytes: current projection byte size.
// caps: { eventsPerRoom, projectionCapBytes } — defaults are PILOT_LIMITS
//   (eventsPerRoom = 1_000_000, projectionCapBytes = 4 MiB per
//   server/store.mjs:427).
//
// Returns { sequence, projectionBytes, eventRatio, projectionRatio,
// watermarkRatio, binding, phase }.
//   watermarkRatio = max(eventRatio, projectionRatio) (OR across budgets).
//   binding = whichever budget is larger ("events" on ties — the honest
//   ops fact: a client should read which meter is driving the phase).
//   phase: "ok" | "notice" | "warn" | "freeze-pending" | "exhausted" on the
//   WATERMARK_* edges from ROOM-ROTATION-DESIGN.md §1.
// The registry's gauge value is watermarkRatio, direction "high",
// warnAt 0.75, criticalAt 0.95.
export function rotationWatermark(sequence, projectionBytes, caps = {}) {
  const eventsPerRoom = caps.eventsPerRoom ?? 1_000_000;
  const projectionCapBytes = caps.projectionCapBytes ?? 4 * 1024 * 1024;
  const seq = asCount(sequence);
  const bytes = asCount(projectionBytes);
  const eventRatio = eventsPerRoom > 0 ? seq / eventsPerRoom : 0;
  const projectionRatio = projectionCapBytes > 0 ? bytes / projectionCapBytes : 0;
  const watermarkRatio = Math.max(eventRatio, projectionRatio);
  const binding = projectionRatio > eventRatio ? "projection" : "events";
  const phase =
    watermarkRatio >= WATERMARK_EXHAUSTED ? "exhausted"
    : watermarkRatio >= WATERMARK_FREEZE_PENDING ? "freeze-pending"
    : watermarkRatio >= WATERMARK_WARN ? "warn"
    : watermarkRatio >= WATERMARK_NOTICE ? "notice"
    : "ok";
  return { sequence: seq, projectionBytes: bytes, eventRatio, projectionRatio, watermarkRatio, binding, phase };
}
