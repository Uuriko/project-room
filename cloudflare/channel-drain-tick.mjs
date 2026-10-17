// Bug sweep F-1: a background channel drain that has not settled within
// this bound is wedged. Drain ticks are deadline-bound to
// CRON_JOB_BUDGET_MS, so two minutes is far beyond a healthy drain; past
// it the drain RPC reports a failed tick instead of another success.
//
// This decision table lives outside cloudflare/room.mjs on purpose:
// room.mjs is the Worker entry module, so every top-level export becomes
// part of the runtime's handler/RPC surface and workerd rejects a
// non-function entry at startup. Keeping the table here lets tests import
// it without widening that surface.
export const CHANNEL_DRAIN_STUCK_MS = 120000;

// The fields of a completed drain tick that may cross the RPC to the
// heartbeat: the numeric digest plus the failure strings summaryFailure
// reads. The full summary (per-connection results, account and connection
// ids) never crosses — only the drain's outcome does.
function drainOutcomeFields(summary) {
  if (!summary || typeof summary !== 'object') return {};
  const out = {};
  for (const key of ['screened', 'parked', 'drained', 'deferred', 'errors']) {
    if (typeof summary[key] === 'number' && Number.isFinite(summary[key])) out[key] = summary[key];
  }
  if (summary.budgetExceeded) out.budgetExceeded = 1;
  if (summary.scanError) out.scanError = String(summary.scanError);
  return out;
}

// The drain RPC's decision table. The drain runs in the background, so a
// tick reports the last COMPLETED drain's outcome (consumed by the caller
// exactly once) instead of pre-reporting success for work nobody has
// observed; `start` says whether this call must launch a new background
// drain.
export function channelDrainTickShape({ connections, inflight, inflightSince, now, completed }) {
  const report = drainOutcomeFields(completed);
  if (!inflight) return { start: true, result: { started: 1, background: 1, connections, ...report } };
  const inflightMs = Number.isFinite(inflightSince) ? Math.max(0, now - inflightSince) : 0;
  if (inflightMs > CHANNEL_DRAIN_STUCK_MS) {
    return { start: false, result: { started: 0, background: 1, inflight: 1, stuck: 1,
      inflightSeconds: Math.round(inflightMs / 1000), ...report,
      errors: Math.max(1, report.errors ?? 0), scanError: 'channel_drain_stuck' } };
  }
  return { start: false, result: { started: 0, background: 1, inflight: 1, connections, ...report } };
}
