// Per-agent wake health (MIG-WAKE spec S7).
//
// The wake fabric records plenty — signal rows in agent_wake_signals,
// the #3345 outcome counters, the loss-class journal — but before S7
// none of it was served per agent: wake health for one agent was
// knowable only by auditing the client hook log by hand. This module is
// the read side: one agent's pending stock, oldest pending age, last
// ack and journaled failures, aggregated from the stores exactly as
// they already exist. It records nothing and changes no counter
// semantics — a pure read in wakeAccounting's shape (bounded queries,
// every section degrades to zeros/nulls on a pre-metrics database,
// never an error).
//
// What the stores do NOT keep per agent is named, not derived:
// agent_wake_counters is keyed (room_id, store, event, door, kind), so
// per-agent emitted / coalesced / delivered counts — and with them a
// per-agent failure rate — do not exist; the failure journal (subject
// id + allowlisted reason, capped at the most recent 1,000 rows) is the
// attributable per-agent loss record. A signal's page inclusion
// ("picked up") is not stamped per signal on this build: delivered_at
// is written at ack, so lastAckedAt is the freshest delivery-side stamp
// (spec S3 adds the pickup stamp). "Capped" and "429-degraded" are
// client-bridge states; the server keeps no counter for them at all.

import { ensureWakeMetricsSchema, WAKE_STOCK_STALE_MS } from "./wake-metrics.mjs";

export const WAKE_HEALTH_GAPS = Object.freeze([
  "per-agent counters are not kept: agent_wake_counters is keyed by (room_id, store, event, door, kind) with no per-agent dimension, so per-agent emitted/coalesced/delivered counts and a per-agent failure rate are not served — the failures journal is the attributable per-agent loss record (capped at the most recent 1000 rows)",
  "last delivered (page inclusion) is not stamped per signal on this build: delivered_at is written at ack, so lastAckedAt is the freshest delivery-side stamp (wake spec S3 adds the pickup stamp)",
  "capped and 429-degraded are client-bridge states; the server keeps no counter for them",
]);

const isMissingTable = error => /no such (table|column)/i.test(String(error?.message ?? ""));

const emptySignals = () => ({ pending: 0, pendingAged: 0, oldestPendingAt: null,
  oldestPendingAgeMs: null, acked: 0, lastEmittedAt: null, lastAckedAt: null });

// One agent's wake health at `now`. Frozen result:
//   signals: pending stock + ages + ack stamps from agent_wake_signals
//   failures: the agent's journaled loss rows (count, by reason, the
//     five most recent) from agent_wake_failures
export function wakeHealthForAgent(db, { agentId, now = 0 } = {}) {
  const signals = emptySignals();
  const failures = { journaled: 0, byReason: {}, recent: [] };
  try {
    const row = db.prepare(`SELECT
        SUM(CASE WHEN delivered_at IS NULL THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN delivered_at IS NULL AND created_at <= ? THEN 1 ELSE 0 END) AS pendingAged,
        MIN(CASE WHEN delivered_at IS NULL THEN created_at END) AS oldestPendingAt,
        SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS acked,
        MAX(created_at) AS lastEmittedAt,
        MAX(delivered_at) AS lastAckedAt
      FROM agent_wake_signals WHERE agent_id=?`).get(now - WAKE_STOCK_STALE_MS, agentId);
    if (row) {
      signals.pending = row.pending ?? 0;
      signals.pendingAged = row.pendingAged ?? 0;
      signals.oldestPendingAt = row.oldestPendingAt ?? null;
      signals.oldestPendingAgeMs = signals.oldestPendingAt === null
        ? null : Math.max(0, now - signals.oldestPendingAt);
      signals.acked = row.acked ?? 0;
      signals.lastEmittedAt = row.lastEmittedAt ?? null;
      signals.lastAckedAt = row.lastAckedAt ?? null;
    }
  } catch (error) { if (!isMissingTable(error)) throw error; }
  try {
    ensureWakeMetricsSchema(db);
    const byReason = db.prepare(
      "SELECT reason, COUNT(*) AS n FROM agent_wake_failures WHERE subject_id=? GROUP BY reason").all(agentId);
    for (const row of byReason) { failures.byReason[row.reason] = row.n; failures.journaled += row.n; }
    failures.recent = db.prepare(
      "SELECT at, room_id AS roomId, kind, reason FROM agent_wake_failures WHERE subject_id=? ORDER BY id DESC LIMIT 5")
      .all(agentId).map(row => Object.freeze(row));
  } catch (error) { if (!isMissingTable(error)) throw error; }
  return Object.freeze({
    agentId, asOf: now,
    signals: Object.freeze(signals),
    failures: Object.freeze({ ...failures, byReason: Object.freeze(failures.byReason),
      recent: Object.freeze(failures.recent) }),
  });
}
