// server/approval-inbox-notify.mjs
//
// Notification hooks for the unified approval inbox (WAVE-500 guild 10).
//
// The inbox is one live surface for pending HUMAN decisions, as cards:
//   { id, kind, title, what, context, options[] { label, consequence },
//     requestedBy, createdAt, expiresAt, status }
// Decisions (approve | approve-session | deny-stop) are recorded by HUMANS
// only. This module is the NOTIFY slice: it turns inbox EVENTS into
// notifications for the room owner — it never decides anything.
//
// Events:
//   onCardOpened(card)       → wake signal + human-readable notice for the owner.
//   onCardExpiringSoon(card) → re-notify with an escalation note.
//   onCardExpired(card)      → re-notify: the card lapsed with NO decision —
//                              explicitly NOT auto-approved, NOT auto-denied.
//
// Rate limit: max 1 notification per (card, event) per hour, enforced through
// the injected marker store. Production wires a durable store (one marker row
// per card+event); tests inject an in-memory map.
//
// Wake mechanism: the existing server/agent-heartbeats.mjs `enqueueWake`
// ({ agentId, kind, roomId, messageId }) — READ ONLY from this module: it is
// never imported or edited here; the caller wires the real store's bound
// method as `enqueueWake`. kind is "mention" (a WAKE_KINDS member); messageId
// is minted per attempt as `approval-inbox:<cardId>:<event>:<now>` so the
// wake store's (agent_id, message_id) coalescing treats each re-notify as a
// genuinely new signal while the rate limiter caps volume.
//
// Pure-ish: every side effect (wake queue, sender, marker store) and the
// clock are injected. No imports, no ambient I/O.

export const INBOX_NOTIFY_EVENTS = Object.freeze(["opened", "expiring-soon", "expired"]);

/** Max 1 notification per (card, event) per this window. */
export const RATE_LIMIT_MS = 3600_000;

/** Wake kind for owner notifications — a member of WAKE_KINDS in agent-heartbeats.mjs. */
export const WAKE_KIND = "mention";

// Card statuses that already record a human outcome: never re-notify these
// (the decision is on the record; pinging again would nag about settled work).
const DECIDED_STATUSES = new Set([
  "decided",
  "approved",
  "approve",
  "approve-session",
  "denied",
  "deny-stop",
  "cancelled",
  "superseded",
]);

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`approval-inbox-notify: ${name} must be a non-empty string`);
  }
  return value;
}

function validateCard(card) {
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    throw new TypeError("approval-inbox-notify: card is required");
  }
  requireNonEmptyString(card.id, "card.id");
  return card;
}

function cardStatusOf(card) {
  return typeof card.status === "string" ? card.status.toLowerCase().trim() : "";
}

// A terminal status suppresses the notify — EXCEPT the "expired" event itself:
// onCardExpired is precisely the notification that the card lapsed, and it
// must fire even when the card's status already reads "expired".
function isTerminal(card, event) {
  const status = cardStatusOf(card);
  if (DECIDED_STATUSES.has(status)) return true;
  return status === "expired" && event !== "expired";
}

function describeCard(card) {
  const lines = [`[${card.kind ?? "unknown"}] ${card.title ?? "(untitled card)"}`];
  if (card.what) lines.push(`What: ${card.what}`);
  if (card.requestedBy) lines.push(`Requested by: ${card.requestedBy}`);
  if (card.expiresAt) lines.push(`Expires: ${card.expiresAt}`);
  if (Array.isArray(card.options) && card.options.length > 0) {
    lines.push("Options:");
    for (const option of card.options) {
      lines.push(` - ${option?.label ?? "?"} — ${option?.consequence ?? "no consequence noted"}`);
    }
  }
  return lines.join("\n");
}

const EVENT_COPY = {
  opened: (card) =>
    `New approval needed:\n${describeCard(card)}\n` +
    `Open the approval inbox to decide. Decisions: approve | approve-session | deny-stop.`,
  "expiring-soon": (card) =>
    `ESCALATION — expiring soon, still undecided:\n${describeCard(card)}\n` +
    `Still needs a human decision. Nothing has been decided for you.`,
  expired: (card) =>
    `EXPIRED — approval lapsed with no decision:\n${describeCard(card)}\n` +
    `The card expired WITHOUT a decision. It was NOT auto-approved and NOT auto-denied. ` +
    `A human must still decide (re-open or deny-stop).`,
};

function defaultMarkerStore() {
  const marks = new Map();
  return {
    lastNotified: (cardId, event) => marks.get(`${cardId}:${event}`) ?? null,
    markNotified: (cardId, event, at) => { marks.set(`${cardId}:${event}`, at); },
  };
}

/**
 * Build the inbox notifier. All dependencies are injected:
 *   enqueueWake({ agentId, kind, roomId, messageId }) — the heartbeat store's
 *       enqueueWake, bound by the caller (READ ONLY here; never edited).
 *   sender({ to, cardId, event, text, messageId }) — delivers the human-readable
 *       notice to the room owner.
 *   ownerAgentId — the room owner's agent id; the only wake target.
 *   roomId — room scope for the wake signal (default null).
 *   now — () => ms epoch; injected so tests control the clock.
 *   markerStore — { lastNotified(cardId, event), markNotified(cardId, event, atMs) };
 *       durable in production (one row per card+event). Defaults to in-memory.
 *
 * The notifier exposes exactly three hooks — onCardOpened, onCardExpiringSoon,
 * onCardExpired — and nothing else. It cannot record a decision: no decision
 * writer is injected, imported, or reachable, and the card object is never
 * mutated.
 */
export function createInboxNotifier(deps = {}) {
  const { enqueueWake, sender, ownerAgentId, roomId = null, now, markerStore } = deps;
  if (typeof enqueueWake !== "function") {
    throw new TypeError(
      "approval-inbox-notify: enqueueWake is required — wire the heartbeat store's bound enqueueWake",
    );
  }
  if (typeof sender !== "function") {
    throw new TypeError("approval-inbox-notify: sender(notice) is required");
  }
  requireNonEmptyString(ownerAgentId, "ownerAgentId");
  const clock = typeof now === "function" ? now : () => Date.now();
  const markers = markerStore ?? defaultMarkerStore();
  if (
    typeof markers.lastNotified !== "function" ||
    typeof markers.markNotified !== "function"
  ) {
    throw new TypeError(
      "approval-inbox-notify: markerStore must implement lastNotified(cardId, event) and markNotified(cardId, event, atMs)",
    );
  }

  function notify(card, event) {
    validateCard(card);
    if (isTerminal(card, event)) return { notified: false, reason: "already-decided" };
    const at = clock();
    if (!Number.isFinite(at)) {
      throw new TypeError("approval-inbox-notify: now() must return a finite ms epoch");
    }
    const last = markers.lastNotified(card.id, event);
    if (Number.isFinite(last) && at - last < RATE_LIMIT_MS) {
      return { notified: false, reason: "rate-limited" };
    }
    const messageId = `approval-inbox:${card.id}:${event}:${at}`;
    const text = EVENT_COPY[event](card);
    const wake = enqueueWake({ agentId: ownerAgentId, kind: WAKE_KIND, roomId, messageId });
    sender({ to: ownerAgentId, cardId: card.id, event, text, messageId });
    markers.markNotified(card.id, event, at);
    return { notified: true, messageId, signal: wake?.signal ?? null };
  }

  return Object.freeze({
    onCardOpened: (card) => notify(card, "opened"),
    onCardExpiringSoon: (card) => notify(card, "expiring-soon"),
    onCardExpired: (card) => notify(card, "expired"),
  });
}
