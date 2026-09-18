// SLA-breach urgent-notification producer (omnichannel tasks 24/34/35). The
// pure piece between the per-channel SLA clocks (server/sla-clocks.mjs) and
// the quiet-hours decision path (server/notify-prefs.mjs #decideNotification):
// when a thread's SLA clock breaches, it emits a notification record with
// `urgent: true`, which decideNotification always delivers — even inside
// quiet hours.
//
// The producer never writes anything and never schedules anything; the
// alerted-thread ledger is caller-owned (a Map). A breached thread alerts
// exactly once: the alert is cleared when the thread stops being breached
// (responded, at-risk again after a fresh inbound, on_track, not_applicable,
// unknown_channel), so a later re-breach alerts again but a stuck breach does
// not re-page the owner on every sweep.
//
// SLA targets are the provisional task-25 example values from sla-clocks.mjs
// (Telegram/whatsapp <= 2h, email <= 24h); the responsiveness policy is John's
// call, so targets stay injectable here too. Frozen outputs; malformed
// inputs throw SlaNotifyError.
import { assessSlaBatch, slaTargets, validateSlaTargets } from "./sla-clocks.mjs";

class SlaNotifyError extends Error { constructor(code, message) { super(message); this.name = "SlaNotifyError"; this.code = code; } }
const fail = (code, message) => { throw new SlaNotifyError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_sla_notify", message); };

export const SLA_BREACH_KIND = "sla_breach";

const elapsedLabel = elapsedMs => {
  const minutes = Math.round(elapsedMs / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  const days = Math.floor(hours / 24);
  const leftover = hours % 24;
  return leftover === 0 ? `${days}d` : `${days}d ${leftover}h`;
};

// Create an urgent-notification producer for SLA breaches.
// store: caller-owned Map (threadId -> alert record), targets: injectable
// per-channel SLA targets (defaults to the provisional slaTargets).
export function createSlaBreachProducer({ store, targets } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  if (targets !== undefined) {
    try { validateSlaTargets(targets); }
    catch (error) { fail("invalid_sla_notify", `targets are invalid: ${error instanceof Error ? error.message : error}`); }
  }
  const alerted = store ?? new Map();
  const effectiveTargets = targets ?? slaTargets;

  // Sweep threads and produce one urgent notification record per newly
  // breached thread. Returns the records produced by this sweep (never
  // re-alerts for a thread whose alert is already in the ledger).
  const produce = (threads, { now } = {}) => {
    check(Array.isArray(threads) && threads.length <= 10000, "threads must be a list of at most 10000");
    check(typeof now === "number" && Number.isFinite(now) && now >= 0, "now must be a non-negative ms timestamp");
    const { assessed } = assessSlaBatch(threads, { now, targets: effectiveTargets });
    const produced = [];
    for (const assessment of assessed) {
      if (assessment.status === "breached") {
        if (alerted.has(assessment.threadId)) continue; // already paged for this breach
        const record = Object.freeze({
          kind: SLA_BREACH_KIND,
          urgent: true,
          threadId: assessment.threadId,
          channel: assessment.channel,
          elapsedMs: assessment.elapsedMs,
          targetMs: assessment.targetMs,
          targetLabel: assessment.label,
          awaitingSince: assessment.awaitingSince,
          deadlineAt: assessment.deadlineAt,
          producedAt: new Date(now).toISOString(),
          summary: `SLA breached on ${assessment.channel}: thread ${assessment.threadId} ` +
            `waiting ${elapsedLabel(assessment.elapsedMs)} (target ${assessment.label ?? elapsedLabel(assessment.targetMs)})`,
        });
        alerted.set(assessment.threadId, record);
        produced.push(record);
        continue;
      }
      // The breach cleared (responded, back on track, at risk again after a
      // fresh inbound, or no clock): forget the alert so a later re-breach
      // alerts again.
      alerted.delete(assessment.threadId);
    }
    return Object.freeze(produced);
  };
  // Read the ledger: alert records currently active (breached and unanswered).
  const activeAlerts = () => Object.freeze([...alerted.values()].map(record => record));
  // Drop one thread's alert without a sweep (e.g. the owner acknowledged it
  // out of band); a still-breached thread will re-alert on the next produce.
  const clearAlert = threadId => {
    check(typeof threadId === "string" && threadId.length > 0, "threadId must be a non-empty string");
    return alerted.delete(threadId);
  };
  return Object.freeze({ produce, activeAlerts, clearAlert, kind: SLA_BREACH_KIND });
}
export { SlaNotifyError };
