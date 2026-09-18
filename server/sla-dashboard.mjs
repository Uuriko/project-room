// SLA dashboard (omnichannel task 26): response-time percentiles, breach
// counts, and the end-of-day open-conversation sweep ("nothing closes
// unowned") across Telegram and email.
//
// A pure, dependency-free aggregator on top of the assess-shaped thread list
// the SLA clocks consume ({ threadId, channel, messages: [{ id, occurredAt,
// direction }] }). The module never reads live state and never reimplements
// clock logic: assessment runs through assessSlaBatch from
// server/sla-clocks.mjs, ownership comes from an injected owners map (the
// caller builds it from the open handoffs journal — task 23's "nothing
// closes unowned" receipts), and journaled breach alerts feed the alert
// counts. Frozen outputs; malformed inputs throw SlaDashboardError.
//
// Three dashboard surfaces:
//
//   percentiles  p50/p95/p99 time-to-first-response per channel, measured
//                over threads that have a first owner reply (respondedMs).
//                A thread still awaiting a reply has no first response yet,
//                so it feeds the breach counts instead — that is a deliberate
//                survivorship note, not a bug: the percentiles answer "how
//                fast do answered threads get answered", the counts answer
//                "how many are still waiting".
//   breaches     breach counts by channel and severity (high = past target,
//                critical = past 2x target), plus at-risk counts by channel.
//   openSweep    the end-of-day "nothing closes unowned" review: every open
//                thread (still awaiting a reply — no response yet, whether or
//                not it is within SLA) with no owner, worst first. A thread
//                with an open handoff has an owner and is excluded; a thread
//                that got its first reply is not open and is excluded.
import { assessSlaBatch } from "./sla-clocks.mjs";

class SlaDashboardError extends Error { constructor(code, message) { super(message); this.name = "SlaDashboardError"; this.code = code; } }
const fail = (code, message) => { throw new SlaDashboardError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_sla_dashboard", message); };

// Severity of a waiting thread against its channel target:
//   low      on_track (below the at-risk threshold)
//   medium   at_risk (at or past 75% of target, still inside it)
//   high     breached (past target, below 2x)
//   critical breached past 2x the target
export const slaSeverities = Object.freeze(["low", "medium", "high", "critical"]);
export const criticalAtRatio = 2;
const severityRank = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1 });

export function severityFor({ elapsedMs, targetMs, status }) {
  check(typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs >= 0,
    "elapsedMs must be a non-negative number");
  check(typeof targetMs === "number" && Number.isFinite(targetMs) && targetMs > 0,
    "targetMs must be a positive number");
  if (status === "breached") return elapsedMs >= criticalAtRatio * targetMs ? "critical" : "high";
  if (status === "at_risk") return "medium";
  return "low";
}

// Nearest-rank percentiles over a sample list (ms integers). Empty samples
// give null percentiles with count 0 — an honest "no data" rather than zeros
// that would read as instant responses.
export function responseTimePercentiles(samplesMs) {
  check(Array.isArray(samplesMs) && samplesMs.length <= 100000, "samplesMs must be a list of at most 100000");
  for (const sample of samplesMs)
    check(typeof sample === "number" && Number.isFinite(sample) && sample >= 0, "samples must be non-negative numbers");
  const count = samplesMs.length;
  if (count === 0) return Object.freeze({ count: 0, p50Ms: null, p95Ms: null, p99Ms: null });
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const rank = p => sorted[Math.min(count - 1, Math.max(0, Math.ceil((p / 100) * count) - 1))];
  return Object.freeze({ count, p50Ms: Math.round(rank(50)), p95Ms: Math.round(rank(95)), p99Ms: Math.round(rank(99)) });
}

const msOf = value => {
  check(typeof value === "number" && Number.isFinite(value) && value >= 0, "now must be a non-negative ms timestamp");
  return value;
};
// owners: Map of threadId -> owner id (e.g. the open handoff's toAgent).
// breachAlerts: journaled alert views [{ threadId, channel, ... }]; only
// threadId and channel are read.
const ownersOf = value => {
  if (value === undefined || value === null) return new Map();
  check(value instanceof Map, "owners must be a Map of threadId -> owner id");
  for (const [threadId, owner] of value) {
    check(typeof threadId === "string" && threadId.length > 0, "owner threadIds must be non-empty strings");
    check(typeof owner === "string" && owner.length > 0, "owner ids must be non-empty strings");
  }
  return value;
};
const alertsOf = value => {
  if (value === undefined || value === null) return [];
  check(Array.isArray(value) && value.length <= 10000, "breachAlerts must be a list of at most 10000");
  for (const alert of value) {
    check(alert !== null && typeof alert === "object" && !Array.isArray(alert), "breachAlerts must be alert objects");
    check(typeof alert.threadId === "string" && alert.threadId.length > 0, "alert threadId must be a non-empty string");
    check(typeof alert.channel === "string" && alert.channel.length > 0, "alert channel must be a non-empty string");
  }
  return value;
};

// Build the dashboard. threads is the assess-shaped list the sweep reads;
// now is the ms epoch the clocks run against; targets is the injectable
// per-channel policy (task 25). The assessment is assessSlaBatch — the same
// clocks the inbox list and the sweep use — never a reimplementation.
export function buildSlaDashboard({ threads, now, targets, owners = null, breachAlerts = null } = {}) {
  check(Array.isArray(threads) && threads.length <= 10000, "threads must be a list of at most 10000");
  const at = msOf(now), ownerMap = ownersOf(owners), alerts = alertsOf(breachAlerts);
  const batch = assessSlaBatch(threads, { now: at, targets });

  // Time-to-first-response per channel: responded threads only.
  const respondedByChannel = {};
  for (const assessment of batch.assessed) {
    if (assessment.status !== "responded" || assessment.respondedMs === null) continue;
    (respondedByChannel[assessment.channel] ??= []).push(assessment.respondedMs);
  }
  const percentiles = {};
  for (const channel of Object.keys(respondedByChannel).sort())
    percentiles[channel] = responseTimePercentiles(respondedByChannel[channel]);

  // Breach counts by channel and severity, plus at-risk counts by channel.
  const breachesByChannel = {}, breachesBySeverity = { high: 0, critical: 0 }, atRiskByChannel = {};
  let breachTotal = 0, atRiskTotal = 0;
  for (const assessment of batch.assessed) {
    if (assessment.status === "breached") {
      const severity = severityFor({ elapsedMs: assessment.elapsedMs, targetMs: assessment.targetMs, status: assessment.status });
      breachesByChannel[assessment.channel] = (breachesByChannel[assessment.channel] ?? 0) + 1;
      breachesBySeverity[severity] += 1;
      breachTotal += 1;
    } else if (assessment.status === "at_risk") {
      atRiskByChannel[assessment.channel] = (atRiskByChannel[assessment.channel] ?? 0) + 1;
      atRiskTotal += 1;
    }
  }

  // Journaled breach alerts (the durable in-app sink) rolled up by channel.
  const journaledByChannel = {};
  for (const alert of alerts) journaledByChannel[alert.channel] = (journaledByChannel[alert.channel] ?? 0) + 1;

  // The end-of-day "nothing closes unowned" sweep: open threads (still
  // awaiting a first reply) with no owner. Worst first: severity, then
  // longest wait. Every entry carries owner: null as the explicit review
  // signal — the sweep lists only the unowned; owned threads are someone's.
  const sweep = [];
  for (const assessment of batch.assessed) {
    if (!["on_track", "at_risk", "breached"].includes(assessment.status)) continue;
    if (ownerMap.has(assessment.threadId)) continue;
    const severity = severityFor({ elapsedMs: assessment.elapsedMs, targetMs: assessment.targetMs, status: assessment.status });
    sweep.push(Object.freeze({ threadId: assessment.threadId, channel: assessment.channel,
      status: assessment.status, severity, awaitingSince: assessment.awaitingSince,
      elapsedMs: assessment.elapsedMs, targetMs: assessment.targetMs,
      label: assessment.label, deadlineAt: assessment.deadlineAt ?? null, owner: null }));
  }
  sweep.sort((a, b) => severityRank[b.severity] - severityRank[a.severity] || b.elapsedMs - a.elapsedMs);

  // Status rollup per channel for the overview cards.
  const statusByChannel = {};
  for (const assessment of batch.assessed) {
    const row = statusByChannel[assessment.channel] ??= { on_track: 0, at_risk: 0, breached: 0,
      responded: 0, not_applicable: 0, unknown_channel: 0 };
    row[assessment.status] = (row[assessment.status] ?? 0) + 1;
  }

  return Object.freeze({
    generatedAt: new Date(at).toISOString(),
    threadCount: batch.assessed.length,
    openCount: batch.openCount,
    openByChannel: batch.openByChannel,
    percentiles: Object.freeze(percentiles),
    breaches: Object.freeze({ total: breachTotal,
      byChannel: Object.freeze(breachesByChannel), bySeverity: Object.freeze(breachesBySeverity) }),
    atRisk: Object.freeze({ total: atRiskTotal, byChannel: Object.freeze(atRiskByChannel) }),
    journaledAlerts: Object.freeze({ total: alerts.length, byChannel: Object.freeze(journaledByChannel) }),
    statusByChannel: Object.freeze(statusByChannel),
    openSweep: Object.freeze(sweep),
  });
}

export { SlaDashboardError };
