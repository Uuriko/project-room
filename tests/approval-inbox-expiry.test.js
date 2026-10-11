// Fail-first tests for server/approval-inbox-expiry.mjs (WAVE-500 guild 10 slice 10/50).
// Invariants under test: expired is terminal; sweeps NEVER approve or reject;
// nudge flag fires past 50% of TTL; a card's expiry can be renewed exactly once.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ExpiryError,
  cardStatuses,
  sweepExpired,
  flagNudges,
  cardsNeedingNudge,
  renewCard,
} from "../server/approval-inbox-expiry.mjs";

const makeCard = (over = {}) => ({
  id: `card-${Math.random().toString(36).slice(2, 8)}`,
  status: "pending",
  title: "Human decision needed",
  requestedBy: "agent-1",
  createdAt: 0,
  expiresAt: 1000, // TTL 1000ms unless overridden (ISO strings also accepted)
  needsNudge: false,
  renewalsUsed: 0,
  expiredAt: null,
  journal: [],
  ...over,
});

// Minimal fake implementing the store seam the sibling (slice 1) owns.
const makeStore = (cards = []) => {
  const byId = new Map(cards.map((c) => [c.id, c]));
  return {
    listCards: () => [...byId.values()],
    getCard: (id) => byId.get(id) ?? null,
    saveCard: (card) => { byId.set(card.id, card); },
  };
};

const journaled = (card, kind) => card.journal.filter((e) => e.kind === kind);

test("cardStatuses covers the unified inbox lifecycle", () => {
  assert.deepEqual([...cardStatuses].sort(), ["approved", "changes", "expired", "pending", "rejected"]);
});

test("sweepExpired expires a pending card past its expiresAt", () => {
  const card = makeCard();
  const store = makeStore([card]);
  const out = sweepExpired({ store, now: 1001 });
  assert.deepEqual(out.expired, [card.id]);
  assert.equal(card.status, "expired");
  assert.equal(card.expiredAt, new Date(1001).toISOString());
  const entries = journaled(card, "expired");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].by, "system");
  assert.match(entries[0].note, /never auto-approved/i);
});

test("sweepExpired never approves and never rejects — expiry is terminal", () => {
  const past = makeCard({ id: "past" });
  const store = makeStore([past]);
  sweepExpired({ store, now: 5000 });
  assert.equal(past.status, "expired");
  assert.notEqual(past.status, "approved");
  assert.notEqual(past.status, "rejected");
  // Sweeping the whole inbox twice still approves nothing.
  const mixed = [makeCard({ id: "a" }), makeCard({ id: "b", status: "approved" })];
  const s2 = makeStore(mixed);
  sweepExpired({ store: s2, now: 9999 });
  assert.ok(mixed.every((c) => c.status !== "approved" || c.id === "b"));
});

test("sweepExpired leaves approved/rejected/changes cards alone even past expiry", () => {
  const cards = [
    makeCard({ id: "a", status: "approved" }),
    makeCard({ id: "r", status: "rejected" }),
    makeCard({ id: "c", status: "changes" }),
  ];
  const store = makeStore(cards);
  const out = sweepExpired({ store, now: 60_000 });
  assert.deepEqual(out.expired, []);
  assert.deepEqual(cards.map((c) => c.status), ["approved", "rejected", "changes"]);
  assert.ok(cards.every((c) => journaled(c, "expired").length === 0));
});

test("sweepExpired ignores cards without an expiresAt and cards not yet due", () => {
  const noTtl = makeCard({ id: "no-ttl", expiresAt: null });
  const fresh = makeCard({ id: "fresh" });
  const store = makeStore([noTtl, fresh]);
  const out = sweepExpired({ store, now: 999 });
  assert.deepEqual(out.expired, []);
  assert.equal(noTtl.status, "pending");
  assert.equal(fresh.status, "pending");
});

test("sweepExpired is idempotent — a second pass sweeps nothing new", () => {
  const card = makeCard();
  const store = makeStore([card]);
  sweepExpired({ store, now: 1001 });
  const second = sweepExpired({ store, now: 2000 });
  assert.deepEqual(second.expired, []);
  assert.equal(journaled(card, "expired").length, 1);
});

test("flagNudges flags a pending card past 50% of its TTL", () => {
  const card = makeCard();
  const store = makeStore([card]);
  const out = flagNudges({ store, now: 501 }); // 50.1% of a 1000ms TTL
  assert.deepEqual(out.flagged, [card.id]);
  assert.equal(card.needsNudge, true);
  assert.equal(journaled(card, "nudge_flagged").length, 1);
});

test("flagNudges does not flag before 50% of the TTL", () => {
  const card = makeCard();
  const store = makeStore([card]);
  const out = flagNudges({ store, now: 499 });
  assert.deepEqual(out.flagged, []);
  assert.equal(card.needsNudge, false);
});

test("flagNudges is idempotent and skips expired / TTL-less / already-expired cards", () => {
  const flagged = makeCard({ id: "f", needsNudge: true });
  const dead = makeCard({ id: "dead", status: "expired" });
  const noTtl = makeCard({ id: "no-ttl", expiresAt: null });
  const store = makeStore([flagged, dead, noTtl]);
  const out = flagNudges({ store, now: 800 });
  assert.deepEqual(out.flagged, []); // already-flagged is not re-flagged
  assert.equal(journaled(flagged, "nudge_flagged").length, 0);
  assert.equal(dead.needsNudge, false);
  assert.equal(noTtl.needsNudge, false);
});

test("cardsNeedingNudge query returns only pending flagged cards for the notify slice", () => {
  const pending = makeCard({ id: "p", needsNudge: true });
  const unflagged = makeCard({ id: "u", needsNudge: false });
  const expiredFlag = makeCard({ id: "x", status: "expired", needsNudge: true });
  const store = makeStore([pending, unflagged, expiredFlag]);
  assert.deepEqual(cardsNeedingNudge(store).map((c) => c.id), ["p"]);
});

test("renewCard extends expiry once with a reason, journaled", () => {
  const card = makeCard();
  const store = makeStore([card]);
  const renewed = renewCard({ store, cardId: card.id, by: "agent-1", newExpiresAt: 3000, reason: "human is in a meeting", now: 500 });
  assert.equal(renewed.expiresAt, 3000);
  assert.equal(renewed.renewalsUsed, 1);
  assert.equal(renewed.needsNudge, false);
  const entries = journaled(card, "renewed");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].by, "agent-1");
  assert.equal(entries[0].note, "human is in a meeting");
  assert.equal(entries[0].oldExpiresAt, 1000);
  assert.equal(entries[0].newExpiresAt, 3000);
});

test("renewCard refuses a second renewal", () => {
  const card = makeCard();
  const store = makeStore([card]);
  renewCard({ store, cardId: card.id, by: "agent-1", newExpiresAt: 3000, reason: "first", now: 500 });
  assert.throws(
    () => renewCard({ store, cardId: card.id, by: "agent-1", newExpiresAt: 4000, reason: "second", now: 500 }),
    (err) => err instanceof ExpiryError && err.code === "expiry_already_renewed",
  );
});

test("renewCard refuses anyone but the requester", () => {
  const card = makeCard();
  const store = makeStore([card]);
  assert.throws(
    () => renewCard({ store, cardId: card.id, by: "agent-2", newExpiresAt: 3000, reason: "nope", now: 500 }),
    (err) => err instanceof ExpiryError && err.code === "expiry_not_requester",
  );
  assert.equal(card.renewalsUsed, 0);
});

test("renewCard refuses terminal cards — expired is terminal, never resurrected", () => {
  const expired = makeCard({ id: "e", status: "expired", expiredAt: 1000 });
  const approved = makeCard({ id: "a", status: "approved" });
  const store = makeStore([expired, approved]);
  for (const id of ["e", "a"]) {
    assert.throws(
      () => renewCard({ store, cardId: id, by: "agent-1", newExpiresAt: 3000, reason: "late", now: 1500 }),
      (err) => err instanceof ExpiryError && err.code === "expiry_terminal",
    );
  }
  assert.equal(expired.status, "expired");
});

test("renewCard requires a non-empty reason and a forward-moving window", () => {
  const card = makeCard();
  const store = makeStore([card]);
  assert.throws(
    () => renewCard({ store, cardId: card.id, by: "agent-1", newExpiresAt: 3000, reason: "  ", now: 500 }),
    (err) => err instanceof ExpiryError && err.code === "expiry_reason_required",
  );
  assert.throws(
    () => renewCard({ store, cardId: card.id, by: "agent-1", newExpiresAt: 400, reason: "past", now: 500 }),
    (err) => err instanceof ExpiryError && err.code === "expiry_invalid_window",
  );
  assert.throws(
    () => renewCard({ store, cardId: card.id, by: "agent-1", newExpiresAt: 1000, reason: "same", now: 500 }),
    (err) => err instanceof ExpiryError && err.code === "expiry_invalid_window",
  );
  assert.equal(card.renewalsUsed, 0);
  assert.equal(card.expiresAt, 1000);
});

test("renewCard throws on unknown cards and on cards with no expiry to extend", () => {
  const noTtl = makeCard({ id: "no-ttl", expiresAt: null });
  const store = makeStore([noTtl]);
  assert.throws(
    () => renewCard({ store, cardId: "missing", by: "agent-1", newExpiresAt: 3000, reason: "x", now: 500 }),
    (err) => err instanceof ExpiryError && err.code === "expiry_card_not_found",
  );
  assert.throws(
    () => renewCard({ store, cardId: "no-ttl", by: "agent-1", newExpiresAt: 3000, reason: "x", now: 500 }),
    (err) => err instanceof ExpiryError && err.code === "expiry_invalid_window",
  );
});

test("expiry sweep clears a stale nudge flag — expired cards stop blocking and stop nudging", () => {
  const card = makeCard({ needsNudge: true });
  const store = makeStore([card]);
  sweepExpired({ store, now: 1001 });
  assert.equal(card.status, "expired");
  assert.equal(card.needsNudge, false);
  assert.deepEqual(cardsNeedingNudge(store), []);
});

test("ISO-8601 dates work end to end — sweep, nudge flag, and renewal", () => {
  const created = "2026-10-10T18:00:00.000Z";
  const expires = "2026-10-10T19:00:00.000Z"; // 1h TTL
  const card = makeCard({ createdAt: created, expiresAt: expires });
  const store = makeStore([card]);
  // 31 minutes in: past 50% of TTL -> flagged.
  const flagOut = flagNudges({ store, now: Date.parse("2026-10-10T18:31:00.000Z") });
  assert.deepEqual(flagOut.flagged, [card.id]);
  assert.equal(card.needsNudge, true);
  // Renew with an ISO string: stored as given, normalized on read.
  const newExpiry = "2026-10-10T20:00:00.000Z";
  const renewed = renewCard({ store, cardId: card.id, by: "agent-1", newExpiresAt: newExpiry,
    reason: "human asked for more time", now: Date.parse("2026-10-10T18:31:00.000Z") });
  assert.equal(renewed.expiresAt, newExpiry);
  assert.equal(renewed.renewalsUsed, 1);
  assert.equal(renewed.needsNudge, false);
  // Still pending before the new expiry, expired after it.
  assert.deepEqual(sweepExpired({ store, now: Date.parse("2026-10-10T19:30:00.000Z") }).expired, []);
  const sweepOut = sweepExpired({ store, now: Date.parse("2026-10-10T20:00:01.000Z") });
  assert.deepEqual(sweepOut.expired, [card.id]);
  assert.equal(card.status, "expired");
});
