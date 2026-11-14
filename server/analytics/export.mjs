// Hourly NDJSON export — DISABLED by classification ruling (2026-10-18,
// ANALYTICS-EXPORT-CLASSIFY; deep-map finding D-7).
//
// The export this module used to perform serialised analytics_events with
// RAW account_id / actor_id / ref_member_id / viewer_key to an external
// sink. It predates the data bright lines and breaches them as built:
// U2 (extracts leave de-identified/pseudonymised, never with raw
// identifiers), U1 (derived data only, never a raw event-level feed),
// U5 (extracts pass the same filters as the public read model). It also
// has no driver and no consumer in the repo: no job calls it, no sink is
// configured in any deployment config, and nothing reads the objects it
// would write.
//
// exportAnalytics therefore fails closed: it ignores any sink handed to
// it, writes nothing, stamps nothing, and reports disabled. Re-enabling
// an analytics egress requires a new extract built on the W4 anonymiser's
// keyed-HMAC pseudonymisation (PR #4109) — never this raw line format.
import { ensureAnalyticsSchema } from "./schema.mjs";

export function hourWindow(hour) {
  const stamp = typeof hour === "number" ? hour : Date.parse(hour ?? "");
  const when = Number.isFinite(stamp) ? stamp : Date.now() - 3600000;
  const date = new Date(when);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours());
  const label = new Date(start).toISOString();
  return {
    start,
    end: start + 3600000,
    date: label.slice(0, 10),
    hour: label.slice(11, 13)
  };
}

export function closedHour(now = Date.now()) {
  return hourWindow(now - 3600000);
}

export function nullSink() {
  return {
    kind: "null",
    async put() { return { stored: false }; },
    async head() { return null; }
  };
}

// Disabled: see the header. The sink and window arguments are accepted
// only so existing call sites keep their shape; both are ignored.
export async function exportAnalytics(db, sink, { hour, now = Date.now() } = {}) {
  void sink;
  void hour;
  void now;
  ensureAnalyticsSchema(db);
  return { exported: 0, key: null, configured: false, disabled: true };
}
