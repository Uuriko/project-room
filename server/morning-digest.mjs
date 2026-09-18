// Morning digest (omnichannel task 21). A pure daily-brief builder: it wires
// the pure digest-mode.mjs sender grouping and the inbox-triage.mjs decider
// into one overnight summary across channels (Telegram + email arrivals).
//
// Input is caller-supplied arrivals; nothing here reads the store, the
// network, or any secret. Each arrival becomes one per-thread row grouped by
// channel, then by sender (busiest first, via digest-mode's buildDigest), then
// by thread, with the triage decision and a set of inert one-tap action
// descriptors (reply, snooze, file, handoff — descriptors only; nothing is
// executed, matching the decider's "never moves anything" contract).
//
// Delivery is in-app first: the HTTP layer builds this from the inbox thread
// view on demand. Format, delivery channel, and daily time are John's call
// (task 22), so there is no scheduler and no push path here — just the brief.
// Frozen outputs; malformed inputs throw MorningDigestError.
import { buildDigest } from "./digest-mode.mjs";
import { triageMessage, ACTIONS } from "./inbox-triage.mjs";

class MorningDigestError extends Error { constructor(code, message) { super(message); this.name = "MorningDigestError"; this.code = code; } }
const fail = (code, message) => { throw new MorningDigestError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_digest", message); };

const isoOf = value => {
  check(typeof value === "string" && Number.isFinite(Date.parse(value)), "since/occurredAt must be parseable timestamps");
  return value;
};
const arrivalOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "arrivals must be objects");
  check(typeof value.id === "string" && value.id.length > 0 && value.id.length <= 512, "arrival id must be 1..512 characters");
  check(typeof value.channel === "string" && value.channel.length > 0, "arrival channel must be text");
  check(typeof value.threadId === "string" && value.threadId.length > 0, "arrival threadId must be text");
  check(typeof value.senderId === "string" && value.senderId.length > 0, "arrival senderId must be text");
  if (value.senderLabel !== undefined) check(typeof value.senderLabel === "string", "arrival senderLabel must be text");
  check(typeof value.subject === "string", "arrival subject must be text");
  if (value.excerpt !== undefined && value.excerpt !== null) check(typeof value.excerpt === "string", "arrival excerpt must be text");
  isoOf(value.occurredAt);
  if (value.spamScore !== undefined && value.spamScore !== null)
    check(typeof value.spamScore === "number" && value.spamScore >= 0 && value.spamScore <= 100, "arrival spamScore must be 0..100");
  if (value.matchedRules !== undefined && value.matchedRules !== null) check(Array.isArray(value.matchedRules), "arrival matchedRules must be a list");
  if (value.sla !== undefined && value.sla !== null) check(typeof value.sla === "object" && !Array.isArray(value), "arrival sla must be an object");
  return value;
};
// Default triage wiring: the shared decider over the arrival's own signals.
// Spam stays flag-only in the digest (task 33's default): a quarantined item
// is listed with a review action, never silently hidden from the brief.
const defaultTriage = arrival => triageMessage({ id: arrival.id },
  { spamScore: arrival.spamScore ?? null, matchedRules: arrival.matchedRules ?? [] });
// One-tap actions for a triage decision. Inert descriptors: the client maps
// them onto the existing inbox commands (reply draft, snooze, file, handoff);
// the digest itself performs nothing.
const oneTapActions = (decision, { threadId, channel, sourceIds, senderId, senderLabel, subject, occurredAt, sla }) => {
  const reply = { type: "reply", label: "Reply", target: { threadId, channel, sourceIds } };
  const snooze = { type: "snooze", label: decision.detail ? `Snooze ${decision.detail}` : "Snooze",
    target: { threadId }, params: { delay: decision.detail ?? null } };
  const file = { type: "file", label: decision.detail ? `File to ${decision.detail}` : "File",
    target: { threadId }, params: { folder: decision.detail ?? null } };
  const handoff = { type: "handoff", label: "Hand off",
    target: { threadId, channel },
    context: { threadId, channel, sourceIds, senderId, senderLabel, subject, occurredAt,
      sla: sla ? { status: sla.status, elapsedMs: sla.elapsedMs, awaitingSince: sla.awaitingSince } : null,
      reasons: decision.reasons } };
  switch (decision.action) {
    case "needs_human": return [handoff, reply];
    case "flag": return [reply, file, snooze];
    case "snooze": return [snooze, reply];
    case "file": return [file, reply];
    case "quarantine": return [{ type: "review", label: "Review", target: { threadId, channel, sourceIds } }];
    default: return [reply, snooze, file];
  }
};
// Build the morning digest. `since` is the window start (the route defaults
// it to 24h ago); `date` labels the brief (YYYY-MM-DD). `triage` is an
// injectable decider for tests and future policy. Optional `now` stamps
// generatedAt; caller-supplied so the module stays clock-free by default.
export function buildMorningDigest({ arrivals, since, date, triage = null, now = null }) {
  check(Array.isArray(arrivals) && arrivals.length <= 10000, "arrivals must be a list of at most 10000");
  const windowStart = isoOf(since);
  check(typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date), "date must be YYYY-MM-DD");
  if (triage !== null) check(typeof triage === "function", "triage must be a function");
  if (now !== null) isoOf(now);
  const decide = triage ?? defaultTriage;
  const checked = arrivals.map(arrivalOf).filter(a => a.occurredAt >= windowStart);
  const byChannel = new Map();
  for (const arrival of checked) {
    if (!byChannel.has(arrival.channel)) byChannel.set(arrival.channel, []);
    byChannel.get(arrival.channel).push(arrival);
  }
  const channels = [...byChannel.entries()].map(([channel, list]) => {
    // Reuse the pure digest-mode builder for the per-channel sender grouping.
    const senderIds = [...new Set(list.map(a => a.senderId))];
    const digest = buildDigest({ messages: list.map(a => ({ messageId: a.id, senderId: a.senderId, subject: a.subject })),
      senders: senderIds, date });
    const byId = new Map(list.map(a => [a.id, a]));
    const senderGroups = digest.sections.map(section => {
      const sendersArrivals = section.messageIds.map(id => byId.get(id));
      const byThread = new Map();
      for (const arrival of sendersArrivals) {
        if (!byThread.has(arrival.threadId)) byThread.set(arrival.threadId, []);
        byThread.get(arrival.threadId).push(arrival);
      }
      const threads = [...byThread.entries()].map(([threadId, threadArrivals]) => {
        const latest = [...threadArrivals].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
        const decision = decide(latest);
        check(decision && ACTIONS.includes(decision.action), "triage must return a known triage action");
        const sourceIds = Object.freeze([...new Set(threadArrivals.map(a => a.id))]);
        const sla = latest.sla ?? null;
        return Object.freeze({ threadId, sourceIds,
          senderId: latest.senderId, senderLabel: latest.senderLabel ?? latest.senderId,
          subject: latest.subject, excerpt: latest.excerpt ?? null,
          newCount: threadArrivals.length, occurredAt: latest.occurredAt,
          triage: Object.freeze({ action: decision.action, reasons: Object.freeze([...decision.reasons]) }),
          sla: sla ? Object.freeze({ status: sla.status, elapsedMs: sla.elapsedMs ?? null,
            awaitingSince: sla.awaitingSince ?? null, targetMs: sla.targetMs ?? null }) : null,
          actions: Object.freeze(oneTapActions(decision, { threadId, channel, sourceIds,
            senderId: latest.senderId, senderLabel: latest.senderLabel ?? latest.senderId,
            subject: latest.subject, occurredAt: latest.occurredAt, sla })) });
      });
      threads.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
      const first = sendersArrivals[0];
      return Object.freeze({ senderId: section.senderId, senderLabel: first.senderLabel ?? section.senderId,
        count: section.count, threads: Object.freeze(threads) });
    });
    return Object.freeze({ channel, count: list.length, newThreads: senderGroups.reduce((n, g) => n + g.threads.length, 0),
      senderGroups: Object.freeze(senderGroups) });
  });
  // Busiest channel first; threads inside already newest-first.
  channels.sort((a, b) => b.count - a.count);
  const allThreads = channels.flatMap(c => c.senderGroups.flatMap(g => g.threads));
  const threadIdsWhere = predicate => Object.freeze(allThreads.filter(predicate).map(t => t.threadId));
  return Object.freeze({ date, since: windowStart, generatedAt: now ?? new Date().toISOString(),
    totalArrivals: checked.length,
    channels: Object.freeze(channels),
    needsHuman: threadIdsWhere(t => t.triage.action === "needs_human"),
    quarantined: threadIdsWhere(t => t.triage.action === "quarantine"),
    breached: threadIdsWhere(t => t.sla?.status === "breached"),
    atRisk: threadIdsWhere(t => t.sla?.status === "at_risk") });
}
export { MorningDigestError };
