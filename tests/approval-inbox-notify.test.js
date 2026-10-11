// approval-inbox-notify.test.js — FAIL-FIRST tests for the approval-inbox NOTIFY slice.
//
// The unified approval inbox is one live surface for pending HUMAN decisions.
// This slice turns inbox EVENTS into notifications for the room owner:
//   onCardOpened(card)       → wake signal + human-readable notice.
//   onCardExpiringSoon(card) → re-notify with an escalation note.
//   onCardExpired(card)      → re-notify: the card lapsed and NOTHING was auto-decided.
//
// Invariants under test:
//   - opened notifies the room owner (wake via the injected enqueueWake);
//   - max 1 notification per (card, event) per hour (durable marker, injected);
//   - expiry events escalate and explicitly say nothing was auto-decided;
//   - the module NEVER decides: it has no decision capability and never mutates the card.

import test from "node:test";
import assert from "node:assert/strict";
import {
  createInboxNotifier,
  INBOX_NOTIFY_EVENTS,
  RATE_LIMIT_MS,
} from "../server/approval-inbox-notify.mjs";

const T0 = Date.parse("2026-10-11T03:30:00.000Z");

function makeCard(overrides = {}) {
  return {
    id: "card-1",
    kind: "money",
    title: "Approve $60 Connects top-up",
    what: "Top up Upwork Connects for the buyer pipeline round 5.",
    context: "36 buyers ranked; proposals cost Connects.",
    options: [
      { label: "Approve", consequence: "Spends $60 from the card on file." },
      { label: "Approve-session", consequence: "Approves this and similar spends for the session." },
      { label: "Deny-stop", consequence: "Round 5 stays parked." },
    ],
    requestedBy: "jill",
    createdAt: "2026-10-11T03:00:00.000Z",
    expiresAt: "2026-10-12T03:00:00.000Z",
    status: "open",
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const wakes = [];
  const sends = [];
  const marks = new Map();
  let now = T0;
  return {
    wakes,
    sends,
    marks,
    setNow: (ms) => { now = ms; },
    enqueueWake: (args) => {
      wakes.push(args);
      return { enqueued: true, signal: { signal_id: "ws_test", ...args, created_at: now } };
    },
    sender: (notice) => { sends.push(notice); return { sent: true }; },
    markerStore: {
      lastNotified: (cardId, event) => marks.get(`${cardId}:${event}`) ?? null,
      markNotified: (cardId, event, at) => { marks.set(`${cardId}:${event}`, at); },
    },
    ownerAgentId: "owner-human-1",
    roomId: "muse-room",
    now: () => now,
    ...overrides,
  };
}

// --- opened notifies --------------------------------------------------------

test("onCardOpened enqueues a wake signal for the room owner", () => {
  const deps = makeDeps();
  const notifier = createInboxNotifier(deps);
  const result = notifier.onCardOpened(makeCard());

  assert.equal(result.notified, true);
  assert.equal(deps.wakes.length, 1);
  const wake = deps.wakes[0];
  assert.equal(wake.agentId, "owner-human-1");
  assert.equal(wake.kind, "mention");
  assert.match(wake.messageId, /card-1/);
  assert.equal(typeof result.messageId, "string");
});

test("onCardOpened sends a human-readable notice with the card details", () => {
  const deps = makeDeps();
  const notifier = createInboxNotifier(deps);
  notifier.onCardOpened(makeCard());

  assert.equal(deps.sends.length, 1);
  const notice = deps.sends[0];
  assert.equal(notice.cardId, "card-1");
  assert.equal(notice.event, "opened");
  assert.match(notice.text, /Approve \$60 Connects top-up/);
  assert.match(notice.text, /Top up Upwork Connects/);
  assert.match(notice.text, /jill/);
  assert.match(notice.text, /Approve-session/);
});

// --- rate limit: max 1 per card per hour -------------------------------------

test("rate limit: a second open within the hour does not re-notify", () => {
  const deps = makeDeps();
  const notifier = createInboxNotifier(deps);
  const first = notifier.onCardOpened(makeCard());
  deps.setNow(T0 + 30 * 60_000); // +30 min
  const second = notifier.onCardOpened(makeCard());

  assert.equal(first.notified, true);
  assert.equal(second.notified, false);
  assert.equal(second.reason, "rate-limited");
  assert.equal(deps.wakes.length, 1);
  assert.equal(deps.sends.length, 1);
});

test("rate limit: notifying again after the hour passes", () => {
  const deps = makeDeps();
  const notifier = createInboxNotifier(deps);
  notifier.onCardOpened(makeCard());
  deps.setNow(T0 + RATE_LIMIT_MS + 1);
  const again = notifier.onCardOpened(makeCard());

  assert.equal(again.notified, true);
  assert.equal(deps.wakes.length, 2);
  assert.equal(deps.sends.length, 2);
});

test("rate limit is per event: an expiry notice is not blocked by the open notice", () => {
  const deps = makeDeps();
  const notifier = createInboxNotifier(deps);
  notifier.onCardOpened(makeCard());
  deps.setNow(T0 + 30 * 60_000); // +30 min — open would be rate-limited
  const expiring = notifier.onCardExpiringSoon(makeCard());

  assert.equal(expiring.notified, true);
  assert.equal(deps.wakes.length, 2);
  assert.equal(expiring.messageId !== undefined, true);
});

// --- expiry escalates, never auto-decides ------------------------------------

test("onCardExpiringSoon re-notifies with an escalation note", () => {
  const deps = makeDeps();
  const notifier = createInboxNotifier(deps);
  const result = notifier.onCardExpiringSoon(makeCard());

  assert.equal(result.notified, true);
  assert.equal(deps.sends.length, 1);
  const notice = deps.sends[0];
  assert.equal(notice.event, "expiring-soon");
  assert.match(notice.text, /expiring soon/i);
  assert.match(notice.text, /escalat/i);
  assert.match(notice.text, /still needs a human decision/i);
});

test("onCardExpired re-notifies and explicitly says nothing was auto-decided", () => {
  const deps = makeDeps();
  const notifier = createInboxNotifier(deps);
  const result = notifier.onCardExpired(makeCard({ status: "expired" }));

  assert.equal(result.notified, true);
  assert.equal(deps.sends.length, 1);
  const notice = deps.sends[0];
  assert.equal(notice.event, "expired");
  assert.match(notice.text, /expired/i);
  assert.match(notice.text, /NOT auto-approved|not auto-approved|nothing was auto-decided/i);
  assert.match(notice.text, /human/i);
});

// --- never auto-decides ------------------------------------------------------

test("never auto-decides: hooks never mutate the card and expose no decision API", () => {
  const deps = makeDeps();
  const notifier = createInboxNotifier(deps);
  assert.deepEqual(Object.keys(notifier).sort(), ["onCardExpired", "onCardExpiringSoon", "onCardOpened"]);

  const frozen = makeCard();
  Object.freeze(frozen);
  assert.doesNotThrow(() => notifier.onCardOpened(frozen));
  deps.setNow(T0 + 2 * RATE_LIMIT_MS);
  assert.doesNotThrow(() => notifier.onCardExpiringSoon(frozen));
  deps.setNow(T0 + 4 * RATE_LIMIT_MS);
  assert.doesNotThrow(() => notifier.onCardExpired(makeCard({ status: "expired" })));

  assert.equal("decision" in frozen, false);
  assert.equal(frozen.status, "open"); // untouched
});

test("already-decided cards are not notified", () => {
  const deps = makeDeps();
  const notifier = createInboxNotifier(deps);
  for (const status of ["decided", "approved", "denied", "cancelled"]) {
    const result = notifier.onCardOpened(makeCard({ id: `card-${status}`, status }));
    assert.equal(result.notified, false, status);
    assert.equal(result.reason, "already-decided", status);
  }
  assert.equal(deps.wakes.length, 0);
  assert.equal(deps.sends.length, 0);
});

// --- input validation --------------------------------------------------------

test("invalid card id throws", () => {
  const deps = makeDeps();
  const notifier = createInboxNotifier(deps);
  assert.throws(() => notifier.onCardOpened({ ...makeCard(), id: "" }), TypeError);
  assert.throws(() => notifier.onCardOpened(null), TypeError);
});

test("missing deps throw at construction", () => {
  const deps = makeDeps();
  assert.throws(() => createInboxNotifier({ ...deps, enqueueWake: undefined }), TypeError);
  assert.throws(() => createInboxNotifier({ ...deps, sender: undefined }), TypeError);
  assert.throws(() => createInboxNotifier({ ...deps, ownerAgentId: "" }), TypeError);
  assert.throws(() => createInboxNotifier({ ...deps, markerStore: {} }), TypeError);
});

test("module constants: events list and hourly rate limit", () => {
  assert.deepEqual([...INBOX_NOTIFY_EVENTS].sort(), ["expired", "expiring-soon", "opened"]);
  assert.equal(RATE_LIMIT_MS, 3600_000);
});
