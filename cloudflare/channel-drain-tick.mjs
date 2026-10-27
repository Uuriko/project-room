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

// #3927 R3: the durable stamp of the inflight drain's start, written to
// DO storage when a drain starts and deleted when it ends. The inflight
// fields themselves are instance memory, so without this stamp an
// eviction would reset the stuck clock above — a successor instance
// would report a fresh start (a success) for a drain that has in fact
// been outstanding past the bound. Lives here for the same reason as
// CHANNEL_DRAIN_STUCK_MS: room.mjs cannot carry test-only exports.
export const CHANNEL_DRAIN_INFLIGHT_KEY = 'cron:channel-drain-inflight:v1';

// B3-2 F1: the durable mirror of a completed drain's outcome, written to
// DO storage when the outcome is stashed and deleted when recordCronTick
// consumes it. The outcome itself is instance memory, so without this
// record an eviction between completion and the heartbeat record lost
// it permanently — the successor reported the drain `unobserved`. The
// record holds { outcome, held } in the stash's shape (the head outcome
// plus one queued behind it while the head awaits its record).
export const CHANNEL_DRAIN_OUTCOME_KEY = 'cron:channel-drain-outcome:v1';

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
// exactly once, after the heartbeat record that reports it is durable)
// instead of pre-reporting success for work nobody has observed; `start`
// says whether this call must launch a new background drain.
//
// A tick that consumed no completed outcome observed nothing about the
// backlog's health, so its result is marked `unobserved`: the heartbeat
// records the run but must not grade it as a success — an inflight tick
// used to zero a failure the previous tick had recorded, before the
// replacement drain had completed (#3927 R2). Only a consumed outcome
// (clean or failing) is conclusive.
//
// `orphaned` says the inflight drain's instance is gone (only its
// durable start stamp survives): the drain will never complete, so past
// the stuck bound the tick reports the wedge AND starts a replacement —
// a live drain past the bound is merely wedged and must not be doubled.
// B3-2 F1: write the durable outcome mirror — the post-consumption
// rewrite recordCronTick performs once the heartbeat record is durable,
// and the stash-time mirror #drainChannelsInBackground's stash performs.
// This lives here, not as a ProjectRoom method, for two reasons: a
// private method's brand check rejects the plain-object receivers the
// heartbeat glue is exercised against in tests (room.mjs's prototype
// methods run against DO-shaped stubs there), and room.mjs cannot carry
// extra exports without widening the runtime's RPC surface. The mirror
// holds a JSON copy of the stash; the in-memory fields keep the original
// objects, so recordCronTick's identity comparisons are unaffected on
// the instance that stashed them. An empty stash deletes the record, so
// a successor instance's peek finds no outcome to report.
export async function persistChannelDrainOutcome(storage, outcome, held) {
  const current = outcome ?? null;
  const queued = held ?? null;
  if (current === null && queued === null) {
    await storage.delete(CHANNEL_DRAIN_OUTCOME_KEY);
    return;
  }
  const copy = value => value === null ? null : JSON.parse(JSON.stringify(value));
  await storage.put(CHANNEL_DRAIN_OUTCOME_KEY, { outcome: copy(current), held: copy(queued) });
}

export function channelDrainTickShape({ connections, inflight, inflightSince, now, completed, orphaned = false }) {
  const report = drainOutcomeFields(completed);
  const unobserved = completed == null ? { unobserved: 1 } : {};
  if (!inflight) return { start: true, result: { started: 1, background: 1, connections, ...report, ...unobserved } };
  const inflightMs = Number.isFinite(inflightSince) ? Math.max(0, now - inflightSince) : 0;
  if (inflightMs > CHANNEL_DRAIN_STUCK_MS) {
    return { start: orphaned === true, result: { started: 0, background: 1, inflight: 1, stuck: 1,
      inflightSeconds: Math.round(inflightMs / 1000), ...report,
      errors: Math.max(1, report.errors ?? 0), scanError: 'channel_drain_stuck' } };
  }
  return { start: false, result: { started: 0, background: 1, inflight: 1, connections, ...report, ...unobserved } };
}
