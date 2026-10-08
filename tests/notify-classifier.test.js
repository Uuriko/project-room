// Fail-first tests for server/notify-classifier.mjs — the canonical
// two-trigger notification classifier (herdr redesign, lane B19).
//
// The classifier answers one question: "does this room event interrupt
// THIS member?" It fires on exactly two triggers (two-trigger discipline
// from teardowns/getone-2026-10-06/wave2/copy-kit/notifications-spec.md):
//   (1) question/blocked item addressed to the recipient
//   (2) finish/done on something the recipient owns or verifies
// Everything else — including unknown event types — defaults to deny.
import test from "node:test";
import assert from "node:assert/strict";
import { shouldNotify } from "../server/notify-classifier.mjs";

const me = "member-jill";
const other = "member-fo";

const prefsFor = (memberId, extra = {}) => ({
  memberId,
  owned: [],
  verifies: [],
  ...extra,
});

const base = { senderId: other, seq: 100 };

// ---------- Trigger 1a: review explicitly requested of me ----------

test("review_request addressed to me with a needs_review artifact fires", () => {
  const event = {
    ...base,
    type: "review_request",
    addressedTo: [me],
    reviewArtifact: { claimId: "claim-1", status: "needs_review", prNumber: 1585, headSha: "abc123" },
    mentionState: "delivered",
  };
  assert.equal(shouldNotify(event, prefsFor(me)), true);
});

test("review_request addressed to someone else does not fire", () => {
  const event = {
    ...base,
    type: "review_request",
    addressedTo: [other, "member-tab"],
    reviewArtifact: { claimId: "claim-1", status: "needs_review" },
    mentionState: "delivered",
  };
  assert.equal(shouldNotify(event, prefsFor(me)), false);
});

test("review_request pointing at a non-reviewable artifact does not fire (malformed -> inbox card)", () => {
  const event = {
    ...base,
    type: "review_request",
    addressedTo: [me],
    reviewArtifact: { claimId: "claim-1", status: "in_progress" },
    mentionState: "delivered",
  };
  assert.equal(shouldNotify(event, prefsFor(me)), false);
});

test("review_request already responded does not fire again (mention lifecycle suppression)", () => {
  const event = {
    ...base,
    type: "review_request",
    addressedTo: [me],
    reviewArtifact: { claimId: "claim-1", status: "needs_review" },
    mentionState: "responded",
  };
  assert.equal(shouldNotify(event, prefsFor(me)), false);
});

test("fresh review_request after a timed_out mention re-arms the interrupt", () => {
  const event = {
    ...base,
    type: "review_request",
    addressedTo: [me],
    reviewArtifact: { claimId: "claim-1", status: "needs_review" },
    mentionState: "timed_out",
  };
  assert.equal(shouldNotify(event, prefsFor(me)), true);
});

// ---------- Trigger 1b: question addressed to me ----------

test("ASK question addressed to me fires", () => {
  const event = { ...base, type: "question", addressedTo: [me], text: "ASK: which API shape?" };
  assert.equal(shouldNotify(event, prefsFor(me)), true);
});

test("ASK question addressed to someone else does not fire", () => {
  const event = { ...base, type: "question", addressedTo: [other], text: "ASK: @fo thoughts?" };
  assert.equal(shouldNotify(event, prefsFor(me)), false);
});

// ---------- Trigger 1c: blocked on me ----------

test("blocked claim naming me directly in blockedOn fires", () => {
  const event = {
    ...base,
    type: "blocked",
    claim: { id: "claim-7", status: "blocked", ownerId: other, blockedOn: me },
  };
  assert.equal(shouldNotify(event, prefsFor(me)), true);
});

test("blocked claim naming a claim I own in blockedOn fires", () => {
  const event = {
    ...base,
    type: "blocked",
    claim: { id: "claim-7", status: "blocked", ownerId: other, blockedOn: "claim-3" },
  };
  assert.equal(shouldNotify(event, prefsFor(me, { owned: ["claim-3"] })), true);
});

test("blocked event whose claim already cleared (not blocked at classify time) does not fire", () => {
  const event = {
    ...base,
    type: "blocked",
    claim: { id: "claim-7", status: "done", ownerId: other, blockedOn: me },
  };
  assert.equal(shouldNotify(event, prefsFor(me)), false);
});

test("blocked claim naming someone else does not fire", () => {
  const event = {
    ...base,
    type: "blocked",
    claim: { id: "claim-7", status: "blocked", ownerId: other, blockedOn: "member-tab" },
  };
  assert.equal(shouldNotify(event, prefsFor(me)), false);
});

// ---------- Trigger 2: done on something I own or verify ----------

test("done on a claim I own fires", () => {
  const event = {
    ...base,
    type: "done",
    claim: { id: "claim-9", status: "done", ownerId: me, verifierIds: [] },
  };
  assert.equal(shouldNotify(event, prefsFor(me)), true);
});

test("done on a claim I own via prefs.owned fires", () => {
  const event = {
    ...base,
    type: "done",
    claim: { id: "claim-9", status: "done", ownerId: other, verifierIds: [] },
  };
  assert.equal(shouldNotify(event, prefsFor(me, { owned: ["claim-9"] })), true);
});

test("done on a claim I verify fires", () => {
  const event = {
    ...base,
    type: "done",
    claim: { id: "claim-9", status: "done", ownerId: other, verifierIds: [me] },
  };
  assert.equal(shouldNotify(event, prefsFor(me, { verifies: ["claim-9"] })), true);
});

test("done on someone else's claim fires for nobody", () => {
  const event = {
    ...base,
    type: "done",
    claim: { id: "claim-9", status: "done", ownerId: other, verifierIds: [] },
  };
  assert.equal(shouldNotify(event, prefsFor(me)), false);
});

// ---------- Default deny: everything else is ambient ----------

const ambientCases = [
  ["claim_created", { claim: { id: "c1", status: "claimed", ownerId: me } }],
  ["progress", { claim: { id: "c1", status: "in_progress", ownerId: me } }],
  ["ci_result", { claim: { id: "c1", status: "in_progress", ownerId: me } }],
  ["idea", { text: "IDEA: new feature" }],
  ["chat", { text: "hello everyone" }],
  ["mention", { addressedTo: [me], text: "@jill fyi" }],
  ["done", { claim: { id: "c1", status: "done", ownerId: other, verifierIds: [] } }],
  ["heartbeat", {}],
  ["sweep", {}],
  ["mystery_future_event", {}],
];
for (const [type, extra] of ambientCases) {
  test(`default deny: ${type} never interrupts`, () => {
    const event = { ...base, type, ...extra };
    assert.equal(shouldNotify(event, prefsFor(me)), false);
  });
}

test("unknown event type defaults to deny", () => {
  assert.equal(shouldNotify({ ...base, type: "not_a_real_type" }, prefsFor(me)), false);
});

test("self-emitted review_request does not notify me (sender skips self)", () => {
  const event = {
    type: "review_request",
    senderId: me,
    seq: 100,
    addressedTo: [me],
    reviewArtifact: { claimId: "claim-1", status: "needs_review" },
    mentionState: "delivered",
  };
  assert.equal(shouldNotify(event, prefsFor(me)), false);
});

test("self-emitted done on my own claim does not notify me", () => {
  const event = {
    type: "done",
    senderId: me,
    seq: 100,
    claim: { id: "claim-9", status: "done", ownerId: me, verifierIds: [] },
  };
  assert.equal(shouldNotify(event, prefsFor(me)), false);
});

// ---------- Malformed inputs fail fast (repo convention) ----------

test("throws on missing event", () => {
  assert.throws(() => shouldNotify(null, prefsFor(me)));
});

test("throws on missing prefs", () => {
  assert.throws(() => shouldNotify({ ...base, type: "done" }, null));
});

test("throws on empty memberId", () => {
  assert.throws(() => shouldNotify({ ...base, type: "done" }, prefsFor("")));
});

// ---------- Purity: no mutation of inputs ----------

test("does not mutate event or prefs", () => {
  const event = {
    ...base,
    type: "review_request",
    addressedTo: [me],
    reviewArtifact: { claimId: "claim-1", status: "needs_review" },
    mentionState: "delivered",
  };
  const prefs = prefsFor(me);
  const snapshot = JSON.stringify({ event, prefs });
  shouldNotify(event, prefs);
  assert.equal(JSON.stringify({ event, prefs }), snapshot);
});
