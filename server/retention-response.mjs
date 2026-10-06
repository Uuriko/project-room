// Retention response mechanics (research brief 2026-09-28, agent-retention
// mechanics #1 and #2): first-contribution response SLA + no-zero-reply
// watchdog. Pure, dependency-free, deterministic; frozen outputs. It reads
// the same normalized work-claim item shape server/work-claims.mjs produces
// (id, owner, history: [{ at, agentId, action, note }]) and never writes
// anything itself — the HTTP layer applies retentionAck() and serves
// retentionReport().
//
// Model:
// - A contribution is a claim event (the item's first "claimed" stamp) or a
//   receipt event (the "state:done" stamp). The author is the stamp's agentId.
// - A member response is any later history entry by a different member —
//   never "system", never the author. Verdict-class responses are "reviewed"
//   stamps (recordReview verdicts: approve / changes_requested / comment, and
//   attestWork review notes): the machine-readable verdict the SLA asks for.
// - The ack (action "retention_ack", agentId "system") is the bot's immediate
//   structured receipt — seen / queued — so no contribution sits at zero
//   replies from t=0. It counts for the zero-reply watch, never for the SLA
//   verdict: only a member's review answers the SLA.
// - Deliberately non-punitive: nothing here strikes, demotes, or penalizes.
//   Breaches and watch entries are queues for reviewers, not sanctions — the
//   brief's evidence (agent-retention.md) flags absence-penalties as a
//   documented retention destroyer, so enforcement is out of scope by design.

export const FIRST_RESPONSE_SLA_HOURS = 24;
export const ZERO_REPLY_WINDOW_HOURS = 48;
// Trailing window the rate/latency metrics are computed over.
export const RETENTION_METRIC_WINDOW_DAYS = 30;

const SYSTEM = "system";
const ACK_ACTION = "retention_ack";
const REVIEWED_ACTION = "reviewed";
const CLAIMED_ACTION = "claimed";
const DONE_ACTION = "state:done";

const toMs = value => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") { const ms = Date.parse(value); if (Number.isFinite(ms)) return ms; }
  throw new TypeError("now must be a ms epoch, Date, or ISO timestamp");
};
const nowMsOf = value => (value === undefined ? Date.now() : toMs(value));
const isoOf = ms => new Date(ms).toISOString();
const historyOf = item => (item && Array.isArray(item.history) ? item.history : []);
const isSystem = agentId => agentId === SYSTEM || agentId === null || agentId === undefined;

// The item's original claim: the earliest "claimed" stamp. Pause transitions
// stamp "state:claimed", never "claimed", so the earliest "claimed" is always
// the contribution event.
const claimEventOf = item => {
  let found = null;
  for (const entry of historyOf(item)) {
    if (entry?.action !== CLAIMED_ACTION) continue;
    if (typeof entry?.at !== "string" || !Number.isFinite(Date.parse(entry.at))) continue;
    if (isSystem(entry.agentId)) continue;
    if (!found || entry.at < found.at) found = entry;
  }
  return found;
};

// The done receipt: "state:done" is stamped once (done is immutable).
const receiptEventOf = item => {
  const entry = [...historyOf(item)].reverse().find(entry => entry?.action === DONE_ACTION);
  return entry && typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at)) ? entry : null;
};

// Member responses to one contribution: later history entries by a different
// member. verdictOnly keeps the "reviewed" stamps (recordReview verdicts and
// attestWork notes) — the machine-readable verdict class. The bot's own
// retention_ack receipt never counts, even though it carries the actor's id
// (it must, so content-trust treats it like the claim stamp it rides with).
const responsesTo = (item, authorId, afterAt, { verdictOnly = false } = {}) => {
  const after = Date.parse(afterAt);
  return historyOf(item)
    .filter(entry => entry && typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at)))
    .filter(entry => Date.parse(entry.at) > after)
    .filter(entry => entry.action !== ACK_ACTION)
    .filter(entry => !isSystem(entry.agentId) && entry.agentId !== authorId)
    .filter(entry => !verdictOnly || entry.action === REVIEWED_ACTION)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
};

const ackAtOf = (item, afterAt) => {
  const after = Date.parse(afterAt);
  const ack = historyOf(item)
    .filter(entry => entry?.action === ACK_ACTION && typeof entry?.at === "string"
      && Number.isFinite(Date.parse(entry.at)) && Date.parse(entry.at) >= after)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))[0];
  return ack ? Date.parse(ack.at) : null;
};

// True when memberId has never contributed in this room: never owned a claim
// and never authored a non-system history entry. The route checks this in the
// claim's pre-claim state, so the member's own about-to-land "claimed" stamp
// is not in the scanned items yet.
export function isFirstContribution(items, memberId) {
  if (typeof memberId !== "string" || memberId.length === 0 || isSystem(memberId)) return false;
  const list = Array.isArray(items) ? items : [];
  return !list.some(item => item?.owner === memberId
    || historyOf(item).some(entry => entry?.agentId === memberId && !isSystem(entry.agentId)));
}

// The bot's immediate structured receipt, appended to a freshly claimed item.
// first marks the member's first contribution: the note carries the 24h
// verdict SLA deadline. Machine-readable key=value note, plain ASCII.
// The receipt carries the actor's (claimant/assignee) agent id — not
// "system" — so the room's content-trust marking treats it exactly like the
// claim stamp it rides with: the actor's own viewers see it unmarked,
// everyone else sees member-authored data. responsesTo() excludes it by
// action, so the receipt itself never answers the SLA or the watchdog.
export function retentionAck(item, { now = undefined, first = false, agentId = undefined } = {}) {
  if (!item || typeof item.id !== "string") throw new TypeError("retentionAck needs a work-claim item with an id");
  if (typeof agentId !== "string" || agentId.length === 0 || isSystem(agentId)) {
    throw new TypeError("retentionAck needs the actor's member agentId");
  }
  const atMs = nowMsOf(now);
  const dueIso = isoOf(atMs + FIRST_RESPONSE_SLA_HOURS * 3600 * 1000);
  const note = first
    ? `retention-ack seen=1 first=1 sla_due=${dueIso}`
    : `retention-ack seen=1 first=0`;
  const stamp = Object.freeze({ at: isoOf(atMs), agentId, action: ACK_ACTION, note });
  return Object.freeze({ ...item, history: Object.freeze([...historyOf(item), stamp]) });
}

// First-contribution response SLA (mechanic #1). For every member, their
// earliest claim event and earliest receipt event across the room's items:
// - first claim: answered by a verdict-class member response ("reviewed")
//   within the SLA, or by completion (state:done) inside the SLA window;
//   breached when the window lapses with neither; pending otherwise.
// - first receipt: answered at once by the room's own receipt machinery —
//   every done transition commits a room event and a receipts-search
//   projection, so the receipt is never unacknowledged; kept as an auditable
//   record, never breached.
export function assessFirstContributionSla(items, { now = undefined, slaHours = FIRST_RESPONSE_SLA_HOURS } = {}) {
  const atMs = nowMsOf(now);
  if (!(typeof slaHours === "number" && Number.isFinite(slaHours) && slaHours > 0)) {
    throw new TypeError("slaHours must be a positive number");
  }
  const slaMs = slaHours * 3600 * 1000;
  const list = Array.isArray(items) ? items : [];
  const firsts = new Map(); // memberId -> { claim: {itemId, at}, receipt: {itemId, at} }
  const track = (memberId, kind, itemId, at) => {
    if (typeof memberId !== "string" || memberId.length === 0 || isSystem(memberId)) return;
    let slot = firsts.get(memberId);
    if (!slot) { slot = { claim: null, receipt: null }; firsts.set(memberId, slot); }
    if (!slot[kind] || at < slot[kind].at) slot[kind] = { itemId, at };
  };
  for (const item of list) {
    if (!item || typeof item.id !== "string") continue;
    const claim = claimEventOf(item);
    if (claim) track(claim.agentId, "claim", item.id, claim.at);
    const receipt = receiptEventOf(item);
    if (receipt) track(receipt.agentId, "receipt", item.id, receipt.at);
  }
  const byId = new Map(list.filter(item => item && typeof item.id === "string").map(item => [item.id, item]));
  const entries = [];
  for (const [memberId, slot] of [...firsts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (slot.claim) {
      const claimAt = Date.parse(slot.claim.at);
      const dueAt = claimAt + slaMs;
      const item = byId.get(slot.claim.itemId);
      const verdict = responsesTo(item, memberId, slot.claim.at, { verdictOnly: true })[0] ?? null;
      const verdictAt = verdict ? Date.parse(verdict.at) : null;
      const done = receiptEventOf(item);
      const doneAt = done ? Date.parse(done.at) : null;
      let status, answeredAt = null, answeredBy = null, latencyMs = null;
      if (verdictAt !== null && verdictAt <= dueAt) {
        status = "answered"; answeredAt = verdict.at; answeredBy = verdict.agentId; latencyMs = verdictAt - claimAt;
      } else if (doneAt !== null && doneAt <= dueAt) {
        status = "answered"; answeredAt = done.at; answeredBy = "completion"; latencyMs = doneAt - claimAt;
      } else if (atMs > dueAt) {
        status = "breached";
      } else {
        status = "pending";
      }
      entries.push(Object.freeze({ memberId, kind: "first-claim", itemId: slot.claim.itemId,
        at: slot.claim.at, dueAt: isoOf(dueAt), status,
        ...(answeredAt ? { answeredAt, answeredBy, latencyMs } : {}),
        ...(status === "answered" && answeredBy === "completion" ? { verdict: false } : {}),
      }));
    }
    if (slot.receipt) {
      entries.push(Object.freeze({ memberId, kind: "first-receipt", itemId: slot.receipt.itemId,
        at: slot.receipt.at, dueAt: isoOf(Date.parse(slot.receipt.at) + slaMs), status: "answered",
        answeredAt: slot.receipt.at, answeredBy: "room-receipt-machinery", latencyMs: 0 }));
    }
  }
  return Object.freeze({ entries: Object.freeze(entries) });
}

// No-zero-reply watchdog (mechanic #2). Every claim event is a contribution
// that must close the loop: the watch lists claims past the reply window
// with still no member response. unacked flags the bot-failure backstop —
// past the window with not even the system ack. Metrics run over the
// trailing window so the room sees its Moltbook number, not an all-time
// average: zeroReplyRate is the share of windowed claims with no member
// response once the reply window elapsed (target: 0%).
export function assessZeroReply(items, { now = undefined, windowHours = ZERO_REPLY_WINDOW_HOURS,
  metricDays = RETENTION_METRIC_WINDOW_DAYS } = {}) {
  const atMs = nowMsOf(now);
  if (!(typeof windowHours === "number" && Number.isFinite(windowHours) && windowHours > 0)) {
    throw new TypeError("windowHours must be a positive number");
  }
  const windowMs = windowHours * 3600 * 1000;
  const metricMs = metricDays * 24 * 3600 * 1000;
  const list = Array.isArray(items) ? items : [];
  const watch = [];
  let contributions = 0, unanswered = 0, unackedCount = 0;
  for (const item of list) {
    if (!item || typeof item.id !== "string") continue;
    const claim = claimEventOf(item);
    if (!claim) continue;
    // Completion closes the loop: a done claim was answered by its receipt,
    // exactly like the SLA model's "answeredBy: completion". Counting done
    // claims as zero-reply inflates the rate and fills the reviewer queue
    // with items nobody needs to look at.
    if (receiptEventOf(item)) continue;
    const claimAt = Date.parse(claim.at);
    const elapsed = atMs - claimAt >= windowMs;
    const firstResponse = responsesTo(item, claim.agentId, claim.at)[0] ?? null;
    const ackAt = ackAtOf(item, claim.at);
    const seen = ackAt !== null || firstResponse !== null;
    // The watch is the reviewer queue: claims past the reply window with
    // still no member response. Answered claims never appear here.
    if (elapsed && !firstResponse) {
      watch.push(Object.freeze({ itemId: item.id, memberId: claim.agentId, claimedAt: claim.at,
        state: item.state ?? null, acked: seen, unacked: !seen,
        respondedAt: null }));
    }
    if (atMs - claimAt <= metricMs && elapsed) {
      contributions += 1;
      if (!firstResponse) unanswered += 1;
      if (!seen) unackedCount += 1;
    }
  }
  watch.sort((a, b) => (a.claimedAt < b.claimedAt ? -1 : a.claimedAt > b.claimedAt ? 1 : 0));
  const zeroReplyRate = contributions === 0 ? 0 : unanswered / contributions;
  return Object.freeze({
    watch: Object.freeze(watch),
    contributions, unanswered, unackedCount, zeroReplyRate,
    alert: unackedCount > 0 || zeroReplyRate > 0,
  });
}

// Median ms from claim to first member response, over the trailing metric
// window. measured is the claim count behind the median.
export function firstResponseLatency(items, { now = undefined, metricDays = RETENTION_METRIC_WINDOW_DAYS } = {}) {
  const atMs = nowMsOf(now);
  const metricMs = metricDays * 24 * 3600 * 1000;
  const list = Array.isArray(items) ? items : [];
  const latencies = [];
  for (const item of list) {
    if (!item || typeof item.id !== "string") continue;
    const claim = claimEventOf(item);
    if (!claim) continue;
    const claimAt = Date.parse(claim.at);
    if (atMs - claimAt > metricMs) continue;
    const first = responsesTo(item, claim.agentId, claim.at)[0] ?? null;
    if (first) latencies.push(Date.parse(first.at) - claimAt);
  }
  latencies.sort((a, b) => a - b);
  const measured = latencies.length;
  const medianMs = measured === 0 ? null
    : measured % 2 === 1 ? latencies[(measured - 1) / 2]
    : (latencies[measured / 2 - 1] + latencies[measured / 2]) / 2;
  return Object.freeze({ medianMs, measured });
}

// The retention dashboard: SLA queue + watchdog + latency in one read.
export function retentionReport(items, { now = undefined } = {}) {
  const atMs = nowMsOf(now);
  const sla = assessFirstContributionSla(items, { now: atMs });
  const queue = sla.entries.filter(entry => entry.kind === "first-claim" && entry.status !== "answered");
  const answered = sla.entries.filter(entry => entry.status === "answered");
  const zeroReply = assessZeroReply(items, { now: atMs });
  const latency = firstResponseLatency(items, { now: atMs });
  return Object.freeze({
    generatedAt: isoOf(atMs),
    slaHours: FIRST_RESPONSE_SLA_HOURS,
    zeroReplyWindowHours: ZERO_REPLY_WINDOW_HOURS,
    sla: Object.freeze({
      queue: Object.freeze(queue),
      answered: Object.freeze(answered),
      breached: queue.filter(entry => entry.status === "breached").length,
      pending: queue.filter(entry => entry.status === "pending").length,
    }),
    zeroReply: Object.freeze({
      watch: zeroReply.watch,
      contributions: zeroReply.contributions,
      unanswered: zeroReply.unanswered,
      unacked: zeroReply.unackedCount,
      rate: zeroReply.zeroReplyRate,
      alert: zeroReply.alert,
    }),
    latency,
  });
}
