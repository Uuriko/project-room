// server/approval-inbox-expiry.mjs
// WAVE-500 guild 10 slice 10/50 — expiry sweeps for the unified approval inbox.
//
// The unified approval inbox is the one live surface for pending HUMAN
// decisions (cards replacing the scattered tap list; canonical doc:
// docs/APPROVAL-INBOX.md, guild-10 slice 19). Card lifecycle:
//   pending -> approved | rejected | changes | expired
// Decisions (approve | approve-session | deny-stop) are made ONLY by humans, in
// the inbox core (sibling slices). This module never writes
// approved/rejected/changes. It owns exactly three things:
//   1. sweepExpired — pending cards past expiresAt become "expired". Expiry is
//      terminal: expired cards are never auto-approved and never auto-rejected
//      — they just stop blocking the human. (Silence is not consent.)
//   2. flagNudges / cardsNeedingNudge — pending cards past 50% of their TTL get
//      a needsNudge flag. The sibling notify slice sends the nudge; this module
//      never sends anything.
//   3. renewCard — the requesting agent may extend expiry exactly once, with a
//      reason, journaled. Only the requester (requestedBy), only while
//      pending, only one renewal. An expired card is never resurrected; it can
//      only be re-requested as a fresh card (per the canonical doc).
//
// Card shape (aligned with docs/APPROVAL-INBOX.md; operational fields added):
//   {
//     id: string,
//     status: "pending"|"approved"|"rejected"|"changes"|"expired",
//     title: string,
//     requestedBy: string,             // agent identity — only they may renew
//     createdAt: <ISO-8601 | ms epoch>,
//     expiresAt: <ISO-8601 | ms epoch> | null,  // null = no TTL: never swept, never nudged
//     needsNudge: boolean,             // operational — set by flagNudges
//     renewalsUsed: number,            // operational — 0|1, one renewal ever
//     expiredAt: <ISO-8601 | ms epoch> | null,  // operational — set by sweepExpired
//     journal: [{ at: <iso>, by: string, kind: string, note: string, ... }]
//   }
// Date fields accept ISO-8601 strings or ms epochs; the module normalizes on
// read and stores renewal values back as given.
//
// Store seam (owned by sibling slice 1 — this module must NOT reach past it):
//   {
//     listCards(): Card[],
//     getCard(id): Card | null,
//     saveCard(card): void,
//   }
// Pure logic: the clock is injected (defaults to Date.now()), no I/O, no sends.

export class ExpiryError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "ExpiryError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
const fail = (code, message, detail) => { throw new ExpiryError(code, message, detail); };

export const cardStatuses = Object.freeze(["pending", "approved", "rejected", "changes", "expired"]);
export const MAX_RENEWALS = 1;

const isoOf = (ms) => new Date(ms).toISOString();

/** Normalize a date field: ISO-8601 string or ms epoch -> ms epoch, else null. */
const msOf = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return null;
};

/** A card's decision window, or null when it has no usable TTL. */
const windowOf = (card) => {
  const created = msOf(card.createdAt);
  const expires = msOf(card.expiresAt);
  if (created == null || expires == null || expires <= created) return null;
  return { created, expires, ttl: expires - created };
};

const journaled = (card, kind, now, by, note, extra = {}) => {
  card.journal.push({ at: isoOf(now), by, kind, note, ...extra });
};

/**
 * Move every pending card past its expiresAt to "expired" (terminal).
 * Never approves, never rejects — expiry only stops the card from blocking.
 * Idempotent: already-expired cards are never re-swept.
 */
export function sweepExpired({ store, now = Date.now() }) {
  const expired = [];
  for (const card of store.listCards()) {
    if (card.status !== "pending") continue;
    const w = windowOf(card);
    if (!w || w.expires > now) continue;
    card.status = "expired";
    card.expiredAt = isoOf(now);
    card.needsNudge = false; // expired cards stop nudging — they stop blocking
    journaled(card, "expired", now, "system",
      "Card expired with no human decision. Expiry is terminal: expired cards " +
      "are never auto-approved and never auto-rejected; they stop blocking the inbox.");
    store.saveCard(card);
    expired.push(card.id);
  }
  return { expired, sweptAt: isoOf(now) };
}

/**
 * Flag pending cards that are at/past 50% of their TTL without a decision.
 * Idempotent: already-flagged cards are not re-flagged, and cards the sweep
 * owns (past expiresAt) are left for the sweep. The notify slice sends nudges
 * for cardsNeedingNudge() — this function only flags.
 */
export function flagNudges({ store, now = Date.now() }) {
  const flagged = [];
  for (const card of store.listCards()) {
    if (card.status !== "pending") continue;
    if (card.needsNudge) continue;
    const w = windowOf(card);
    if (!w) continue;
    if (w.expires <= now) continue; // sweep's territory, not the nudge's
    if ((now - w.created) * 2 < w.ttl) continue;
    card.needsNudge = true;
    journaled(card, "nudge_flagged", now, "system",
      "Card is at/past 50% of its TTL with no human decision; flagged for the notify slice.");
    store.saveCard(card);
    flagged.push(card.id);
  }
  return { flagged };
}

/** Query for the sibling notify slice: pending cards currently flagged for a nudge. */
export function cardsNeedingNudge(store) {
  return store.listCards().filter((card) => card.status === "pending" && card.needsNudge === true);
}

/**
 * Extend a pending card's expiry — once, by the requesting agent, with a
 * reason. The new expiry is stored as given (ISO string or ms epoch).
 * Throws ExpiryError with code:
 *   expiry_card_not_found | expiry_not_requester | expiry_terminal |
 *   expiry_already_renewed | expiry_reason_required | expiry_invalid_window
 */
export function renewCard({ store, cardId, by, newExpiresAt, reason, now = Date.now() }) {
  const card = store.getCard(cardId);
  if (!card) fail("expiry_card_not_found", `no approval card ${cardId}`);
  if (by !== card.requestedBy) {
    fail("expiry_not_requester", "only the requesting agent may renew a card's expiry", { cardId, by });
  }
  if (card.status !== "pending") {
    fail("expiry_terminal", `card ${cardId} is ${card.status} — renewal is only for pending cards`, { status: card.status });
  }
  if (card.renewalsUsed >= MAX_RENEWALS) {
    fail("expiry_already_renewed", `card ${cardId} already used its one renewal`);
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    fail("expiry_reason_required", "a renewal needs a non-empty reason (journaled)");
  }
  const w = windowOf(card);
  const next = msOf(newExpiresAt);
  if (!w || next == null || next <= now || next <= w.expires) {
    fail("expiry_invalid_window", "newExpiresAt must move the expiry forward from now", {
      cardId, currentExpiresAt: card.expiresAt, newExpiresAt,
    });
  }
  const oldExpiresAt = card.expiresAt;
  card.expiresAt = newExpiresAt;
  card.renewalsUsed += 1;
  card.needsNudge = false; // fresh window — the nudge clock restarts
  journaled(card, "renewed", now, by, reason.trim(), { oldExpiresAt, newExpiresAt });
  store.saveCard(card);
  return card;
}
