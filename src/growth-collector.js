// Track C slice C2 — In-memory growth event collector.
//
// Bounded ring buffer of validated C1 growth-event envelopes. Every event
// passes through C1's validateEvent as-is (unknown types, version drift,
// unknown/sensitive fields, bad actors/sources/timestamps all fail closed),
// and envelopes claiming the "never-collect" privacy class are refused at the
// door. When the buffer is full the oldest event is evicted and the eviction
// is counted. No network, no storage, no timers — deterministic and testable.

import { validateEvent } from "./growth-events.js";

export const DEFAULT_MAX_EVENTS = 10000;
export const DEFAULT_QUERY_LIMIT = 100;

const positiveInt = (value, label) => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
};

const filterTimestamp = (value, label) => {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO-8601 timestamp`);
  }
  return Date.parse(value);
};

const reasonOf = err => (err instanceof Error ? err.message : String(err));

// Create a bounded collector. maxEvents caps how many envelopes are kept;
// counters are cumulative since creation, so recorded === stored + dropped.
export function createCollector({ maxEvents = DEFAULT_MAX_EVENTS } = {}) {
  const capacity = positiveInt(maxEvents, "maxEvents");
  const slots = new Array(capacity);
  let head = 0; // index of the oldest stored entry
  let stored = 0; // entries currently in the buffer
  let recorded = 0; // envelopes ever accepted (monotonic id source)
  let dropped = 0; // evictions caused by overflow
  const perType = Object.create(null);
  const perActor = Object.create(null);

  // Stored entry: { id, envelope, occurredMs }. Iterate oldest -> newest.
  const eachStored = fn => {
    for (let i = 0; i < stored; i += 1) fn(slots[(head + i) % capacity]);
  };

  // Validate with C1, then store. Returns { ok: true, id } on success or
  // { ok: false, reason } when the event is invalid or must not be collected.
  function record(event) {
    let envelope;
    try {
      envelope = validateEvent(event);
    } catch (err) {
      return Object.freeze({ ok: false, reason: reasonOf(err) });
    }
    if (envelope.privacyClass === "never-collect") {
      return Object.freeze({ ok: false, reason: 'privacy class "never-collect" must not be collected' });
    }
    recorded += 1;
    const entry = { id: recorded, envelope, occurredMs: Date.parse(envelope.occurredAt) };
    if (stored === capacity) {
      head = (head + 1) % capacity;
      dropped += 1;
    } else {
      stored += 1;
    }
    slots[(head + stored - 1) % capacity] = entry;
    perType[envelope.type] = (perType[envelope.type] ?? 0) + 1;
    perActor[envelope.actor.kind] = (perActor[envelope.actor.kind] ?? 0) + 1;
    return Object.freeze({ ok: true, id: recorded });
  }

  // Filter stored envelopes. `actor` matches an actor id or an actor kind.
  // Results are newest-first (ties break by record id), capped by limit.
  function query({ type, actor, since, until, limit = DEFAULT_QUERY_LIMIT } = {}) {
    const sinceMs = since === undefined ? null : filterTimestamp(since, "since");
    const untilMs = until === undefined ? null : filterTimestamp(until, "until");
    const capped = Math.min(positiveInt(limit, "limit"), capacity);
    const matches = [];
    eachStored(entry => {
      const { envelope } = entry;
      if (type !== undefined && envelope.type !== type) return;
      if (actor !== undefined && envelope.actor.id !== actor && envelope.actor.kind !== actor) return;
      if (sinceMs !== null && entry.occurredMs < sinceMs) return;
      if (untilMs !== null && entry.occurredMs > untilMs) return;
      matches.push(entry);
    });
    matches.sort((a, b) => b.occurredMs - a.occurredMs || b.id - a.id);
    return Object.freeze(matches.slice(0, capped).map(entry => entry.envelope));
  }

  // Snapshot: buffer totals, cumulative counters, drop count, and the
  // oldest/newest stored timestamps (null when empty).
  function stats() {
    let oldest = null;
    let newest = null;
    eachStored(entry => {
      if (oldest === null || entry.occurredMs < oldest.occurredMs) oldest = entry;
      if (newest === null || entry.occurredMs > newest.occurredMs || (entry.occurredMs === newest.occurredMs && entry.id > newest.id)) newest = entry;
    });
    return Object.freeze({
      capacity,
      total: stored,
      recorded,
      dropped,
      perType: Object.freeze({ ...perType }),
      perActor: Object.freeze({ ...perActor }),
      oldest: oldest ? oldest.envelope.occurredAt : null,
      newest: newest ? newest.envelope.occurredAt : null
    });
  }

  return Object.freeze({ record, query, stats });
}
