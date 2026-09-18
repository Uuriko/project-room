// Per-channel SLA clocks (omnichannel task 24). A pure, dependency-free
// time-to-first-response tracker: given a thread's messages (each with an
// occurredAt timestamp and a direction), it clocks how long the latest inbound
// message has waited for the owner's first reply and reports one status:
//
//   on_track    waiting, below the at-risk threshold
//   at_risk     waiting, at or past the at-risk threshold (75% of target)
//   breached    waiting longer than the channel's target
//   responded   the owner replied; the clock stopped at first response
//   not_applicable  no inbound message to clock
//   unknown_channel the channel has no configured target
//
// Channel-mismatched SLAs are the #1 omnichannel failure: a 5-minute-old
// Telegram DM and a 5-hour-old email must not share one clock. Targets are
// per channel (Telegram/whatsapp in minutes-scale, email in hours-scale).
// Defaults ship from task 25's example (Telegram <= 2h, email <= 24h); the
// responsiveness policy itself is John's call, so targets are injectable and
// the batch sweep reports per-channel open counts for the end-of-day
// "nothing closes unowned" review (task 26).
//
// The module never writes anything and never schedules anything; callers
// (the inbox thread view, the morning digest) supply the messages and the
// clock. Frozen outputs; malformed inputs throw SlaError.
class SlaError extends Error { constructor(code, message) { super(message); this.name = "SlaError"; this.code = code; } }
const fail = (code, message) => { throw new SlaError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_sla_input", message); };

const HOUR_MS = 3600000;
// Default responsiveness targets. These are the task-25 example values, not a
// decided policy: John sets the bar. Override per call via `targets`.
export const slaTargets = Object.freeze({
  telegram: Object.freeze({ targetMs: 2 * HOUR_MS, label: "2h" }),
  whatsapp: Object.freeze({ targetMs: 2 * HOUR_MS, label: "2h" }),
  email: Object.freeze({ targetMs: 24 * HOUR_MS, label: "24h" }),
  default: Object.freeze({ targetMs: 24 * HOUR_MS, label: "24h" }),
});
// A thread becomes at_risk when the wait reaches this fraction of its target.
export const atRiskRatio = 0.75;

const targetOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "targets must be an object");
  const out = {};
  for (const [channel, target] of Object.entries(value)) {
    check(typeof channel === "string" && channel.length > 0, "target channel names must be text");
    check(target !== null && typeof target === "object" && !Array.isArray(target), "each target must be an object");
    check(Number.isSafeInteger(target.targetMs) && target.targetMs > 0 && target.targetMs <= 30 * 24 * HOUR_MS,
      "targetMs must be a positive integer up to 30 days");
    if (target.label !== undefined) check(typeof target.label === "string" && target.label.length > 0, "target label must be text");
    out[channel] = Object.freeze({ targetMs: target.targetMs, ...(target.label !== undefined ? { label: target.label } : {}) });
  }
  check(Object.keys(out).length > 0, "targets must not be empty");
  return Object.freeze(out);
};
export const validateSlaTargets = value => targetOf(value);

const msOf = value => {
  check(typeof value === "number" && Number.isFinite(value) && value >= 0, "now must be a non-negative ms timestamp");
  return value;
};
const messageOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "messages must be objects");
  check(typeof value.id === "string" && value.id.length > 0 && value.id.length <= 512, "message id must be 1..512 characters");
  check(typeof value.occurredAt === "string" && Number.isFinite(Date.parse(value.occurredAt)), "message occurredAt must be a parseable timestamp");
  check(value.direction === "inbound" || value.direction === "outbound", "message direction must be inbound or outbound");
  return value;
};
// The SLA target for a channel: the channel's own target, else the default,
// else none (unknown_channel) rather than a guessed clock.
const targetFor = (channel, targets) => targets[channel] ?? targets.default ?? null;

// Assess one thread. The clock starts at the latest inbound message; the
// first outbound message at or after it stops the clock. A later inbound
// restarts it (the reply only answered what came before).
export function assessThreadSla({ threadId, channel, messages, now, targets = slaTargets }) {
  check(typeof threadId === "string" && threadId.length > 0 && threadId.length <= 1024, "threadId must be 1..1024 characters");
  check(typeof channel === "string" && channel.length > 0, "channel must be text");
  check(Array.isArray(messages) && messages.length <= 10000, "messages must be a list of at most 10000");
  const at = msOf(now), validated = targetOf(targets);
  const timed = messages.map(messageOf).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const inbound = timed.filter(m => m.direction === "inbound");
  const target = targetFor(channel, validated);
  if (!target) return Object.freeze({ threadId, channel, status: "unknown_channel", targetMs: null, label: null,
    elapsedMs: null, awaitingSince: null, respondedMs: null, withinTarget: null });
  if (inbound.length === 0) return Object.freeze({ threadId, channel, status: "not_applicable", targetMs: target.targetMs,
    label: target.label ?? null, elapsedMs: null, awaitingSince: null, respondedMs: null, withinTarget: null });
  const latest = inbound[inbound.length - 1];
  const reply = timed.find(m => m.direction === "outbound" && m.occurredAt >= latest.occurredAt);
  if (reply) {
    const respondedMs = new Date(reply.occurredAt).getTime() - new Date(latest.occurredAt).getTime();
    return Object.freeze({ threadId, channel, status: "responded", targetMs: target.targetMs, label: target.label ?? null,
      elapsedMs: respondedMs, awaitingSince: latest.occurredAt, respondedMs, withinTarget: respondedMs <= target.targetMs });
  }
  const elapsedMs = at - new Date(latest.occurredAt).getTime();
  check(elapsedMs >= 0, "now must not precede the latest inbound message");
  const status = elapsedMs > target.targetMs ? "breached" : elapsedMs >= atRiskRatio * target.targetMs ? "at_risk" : "on_track";
  return Object.freeze({ threadId, channel, status, targetMs: target.targetMs, label: target.label ?? null,
    elapsedMs, awaitingSince: latest.occurredAt, respondedMs: null, withinTarget: status !== "breached",
    deadlineAt: new Date(new Date(latest.occurredAt).getTime() + target.targetMs).toISOString() });
}
// Batch sweep: assess many threads and roll up per-channel open counts plus
// the at-risk/breached lists the inbox and the end-of-day review surface.
export function assessSlaBatch(threads, { now, targets = slaTargets } = {}) {
  check(Array.isArray(threads) && threads.length <= 10000, "threads must be a list of at most 10000");
  const at = msOf(now), validated = targetOf(targets);
  const assessed = threads.map(thread => assessThreadSla({ ...thread, now: at, targets: validated }));
  const open = assessed.filter(a => ["on_track", "at_risk", "breached"].includes(a.status));
  const openByChannel = {};
  for (const a of open) openByChannel[a.channel] = (openByChannel[a.channel] ?? 0) + 1;
  return Object.freeze({ assessed: Object.freeze(assessed),
    openByChannel: Object.freeze(openByChannel),
    atRisk: Object.freeze(open.filter(a => a.status === "at_risk").map(a => a.threadId)),
    breached: Object.freeze(open.filter(a => a.status === "breached").map(a => a.threadId)),
    openCount: open.length });
}
export { SlaError };
