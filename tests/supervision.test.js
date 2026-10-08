// Supervision inbox backend (herdr redesign lane B6): pure card state machine
// + deterministic ≤2-suggestion decider (server/supervision.mjs).
//
// Authoring-gate answers (repo test-audit skill):
// 1. Protects the supervision card state-machine contract (9 states,
//    pending_undo retract deadline, illegal-transition rejection) and the
//    deterministic ≤2-suggestion decider rules from phase1/inbox-mapping.md.
// 2. Credible regressions: retract allowed after the undo deadline (fake
//    recall), decider emitting 3 suggestions, blocked_lane cards derived from
//    heuristics instead of self-reported claim state.
// 3. No existing coverage: server/supervision.mjs is new; server/inbox-triage.mjs
//    is a different concept (message spam/rules decider), not a card machine.
// 4. No test-only seams: only the named exports the routes module genuinely
//    imports (derive/decide/transition/sort + constants).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SupervisionError,
  CARD_KINDS,
  CARD_STATES,
  DEFAULT_UNDO_HOLD_MS,
  MAX_UNDO_HOLD_MS,
  MANUAL_REVIEW_POLICIES,
  cardIdOf,
  deriveCards,
  decideSuggestions,
  applyCardTransition,
  sortCards,
} from "../server/supervision.mjs";

const NOW = 1_789_000_000_000; // fixed clock for determinism
const ROOM = "room-1";
const OP = "member-op";

const baseClaim = (over = {}) => ({
  id: "claim-1",
  title: "Fix the router",
  state: "claimed",
  owner: "member-other",
  reviewers: [OP],
  reviewPolicy: "independent_principal",
  pullRequest: { number: 42, headSha: "abc1234def" },
  headSha: "abc1234def",
  ciState: "success",
  failingChecks: [],
  deliveryMode: null,
  note: null,
  completedAtMs: null,
  revision: 3,
  reviews: [],
  dependsOn: [],
  files: ["server/routing.mjs"],
  ...over,
});

// ---------------------------------------------------------------------------
// constants / ids
// ---------------------------------------------------------------------------

test("taxonomy exports the four card kinds and nine lifecycle states", () => {
  assert.deepEqual([...CARD_KINDS].sort(),
    ["blocked_lane", "done_receipt", "needs_input", "review_request"]);
  assert.deepEqual([...CARD_STATES].sort(),
    ["acting", "dismissed", "dispatched", "new", "pending_undo", "resolved", "seen", "snoozed", "stale"]);
});

test("undo hold defaults and bounds", () => {
  assert.equal(DEFAULT_UNDO_HOLD_MS, 6000);
  assert.equal(MAX_UNDO_HOLD_MS, 10000);
});

test("manual review policy names the repo's independent_principal policy", () => {
  // Grounded in server/work-claims.mjs REVIEW_POLICIES — the manual family.
  assert.ok(MANUAL_REVIEW_POLICIES.includes("independent_principal"));
});

test("cardIdOf is deterministic and prefixed", () => {
  const a = cardIdOf("review_request|claim|c1|r3");
  assert.equal(a, cardIdOf("review_request|claim|c1|r3"));
  assert.ok(a.startsWith("sv_"));
  assert.notEqual(a, cardIdOf("review_request|claim|c1|r4"));
});

// ---------------------------------------------------------------------------
// deriveCards — card taxonomy from existing data
// ---------------------------------------------------------------------------

test("review_request derives from a reviewable claim naming the operator as reviewer", () => {
  const cards = deriveCards({ roomId: ROOM, operatorId: OP, claims: [baseClaim()], now: NOW });
  assert.equal(cards.length, 1);
  const [card] = cards;
  assert.equal(card.kind, "review_request");
  assert.equal(card.state, "new");
  assert.equal(card.memberId, OP);
  assert.equal(card.roomId, ROOM);
  assert.equal(card.sourceRef.type, "claim");
  assert.equal(card.sourceRef.id, "claim-1");
  assert.equal(card.id, cardIdOf(card.dedupeKey));
});

test("no review_request when the policy is not the manual family", () => {
  const cards = deriveCards({
    roomId: ROOM, operatorId: OP,
    claims: [baseClaim({ reviewPolicy: "self_attested" })], now: NOW,
  });
  assert.equal(cards.length, 0);
});

test("no review_request when the operator is not a named reviewer", () => {
  const cards = deriveCards({
    roomId: ROOM, operatorId: "member-stranger",
    claims: [baseClaim()], now: NOW,
  });
  assert.equal(cards.length, 0);
});

test("no review_request when there is no reviewable artifact (no PR ref / head)", () => {
  const cards = deriveCards({
    roomId: ROOM, operatorId: OP,
    claims: [baseClaim({ pullRequest: null, headSha: null })], now: NOW,
  });
  assert.equal(cards.length, 0);
});

test("review_request re-arms when the PR head moves after the operator's verdict", () => {
  const cards = deriveCards({
    roomId: ROOM, operatorId: OP,
    claims: [baseClaim({
      reviews: [{ memberId: OP, verdict: "approve", headSha: "oldhead1" }],
      pullRequest: { number: 42, headSha: "newhead22" },
      headSha: "newhead22",
    })],
    now: NOW,
  });
  assert.equal(cards.length, 1);
});

test("review_request suppressed when the operator already attested this exact head", () => {
  const cards = deriveCards({
    roomId: ROOM, operatorId: OP,
    claims: [baseClaim({ reviews: [{ memberId: OP, verdict: "approve", headSha: "abc1234def" }] })],
    now: NOW,
  });
  assert.equal(cards.length, 0);
});

test("blocked_lane derives ONLY from the self-reported blocked claim state", () => {
  const cards = deriveCards({
    roomId: ROOM, operatorId: OP,
    claims: [baseClaim({ state: "blocked", owner: OP, note: "need the API key" })],
    now: NOW,
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "blocked_lane");
  // The inbox never infers blockedness from heuristics: a claimed (not
  // blocked) claim with a worrying note produces no blocked_lane card.
  const none = deriveCards({
    roomId: ROOM, operatorId: OP,
    claims: [baseClaim({ state: "claimed", note: "this looks stuck to me" })],
    now: NOW,
  });
  assert.equal(none.filter(c => c.kind === "blocked_lane").length, 0);
});

test("blocked_lane fires for a reviewer or a dependent of the blocked claim", () => {
  const forReviewer = deriveCards({
    roomId: ROOM, operatorId: OP,
    claims: [baseClaim({ state: "blocked", owner: "member-other" })],
    now: NOW,
  });
  assert.equal(forReviewer.length, 1);
  const forDependent = deriveCards({
    roomId: ROOM, operatorId: OP,
    claims: [
      baseClaim({ id: "claim-a", state: "blocked", owner: "member-x", reviewers: [] }),
      baseClaim({ id: "claim-b", state: "claimed", owner: OP, dependsOn: ["claim-a"] }),
    ],
    now: NOW,
  });
  assert.equal(forDependent.filter(c => c.kind === "blocked_lane").length, 1);
});

test("blocked_lane does not fire for an unrelated member", () => {
  const cards = deriveCards({
    roomId: ROOM, operatorId: "member-stranger",
    claims: [baseClaim({ state: "blocked", owner: "member-other", reviewers: [] })],
    now: NOW,
  });
  assert.equal(cards.length, 0);
});

test("done_receipt derives from a recently completed claim the operator owned or verified", () => {
  const cards = deriveCards({
    roomId: ROOM, operatorId: OP,
    claims: [baseClaim({
      state: "done", owner: OP, completedAtMs: NOW - 3600_000, deliveryMode: "merged",
    })],
    now: NOW,
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "done_receipt");
  // Ancient completions do not re-card on every roll-up.
  const old = deriveCards({
    roomId: ROOM, operatorId: OP,
    claims: [baseClaim({ state: "done", owner: OP, completedAtMs: NOW - 30 * 24 * 3600_000 })],
    now: NOW,
  });
  assert.equal(old.length, 0);
});

test("needs_input derives from ASK/@mention messages with no reply from another author", () => {
  const cards = deriveCards({
    roomId: ROOM, operatorId: OP,
    messages: [{
      id: "m1", seq: 101, authorId: "member-other", body: "ASK: should we gate on CI?",
      prefix: "ASK", mentions: [], claimRef: null, hasReplyFromOtherAuthors: false,
    }],
    now: NOW,
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "needs_input");
  // Answered already → no card.
  const answered = deriveCards({
    roomId: ROOM, operatorId: OP,
    messages: [{
      id: "m1", seq: 101, authorId: "member-other", body: "ASK: should we gate on CI?",
      prefix: "ASK", mentions: [], claimRef: null, hasReplyFromOtherAuthors: true,
    }],
    now: NOW,
  });
  assert.equal(answered.length, 0);
});

test("needs_input derives from incoming reply-requests (structured agent asks)", () => {
  const cards = deriveCards({
    roomId: ROOM, operatorId: OP,
    replyRequests: [{ id: "rr1", from: "member-other", status: "incoming", question: "which head?", seq: 55 }],
    now: NOW,
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "needs_input");
  assert.equal(cards[0].sourceRef.type, "reply_request");
});

test("REVIEW-prefixed message addressing the operator spawns a review_request", () => {
  const cards = deriveCards({
    roomId: ROOM, operatorId: OP,
    messages: [{
      id: "m9", seq: 200, authorId: "member-other", body: "REVIEW: claim-1 is ready",
      prefix: "REVIEW", mentions: [OP], claimRef: "claim-1", hasReplyFromOtherAuthors: false,
    }],
    claims: [baseClaim()],
    now: NOW,
  });
  const review = cards.filter(c => c.kind === "review_request");
  assert.equal(review.length, 1);
  assert.equal(review[0].urgent, true); // Trigger A: explicitly requested → interrupt-class
});

test("blocked_lane is interrupt-class (urgent); done_receipt is ambient", () => {
  const cards = deriveCards({
    roomId: ROOM, operatorId: OP,
    claims: [
      baseClaim({ id: "b1", state: "blocked", owner: OP }),
      baseClaim({ id: "d1", state: "done", owner: OP, completedAtMs: NOW - 1000 }),
    ],
    now: NOW,
  });
  const byId = Object.fromEntries(cards.map(c => [c.context.claimId, c]));
  assert.equal(byId.b1.urgent, true);
  assert.equal(byId.d1.urgent, false);
});

test("deriveCards output is frozen", () => {
  const cards = deriveCards({ roomId: ROOM, operatorId: OP, claims: [baseClaim()], now: NOW });
  assert.ok(Object.isFrozen(cards));
  assert.ok(Object.isFrozen(cards[0]));
});

// ---------------------------------------------------------------------------
// decideSuggestions — ≤2 deterministic next actions per card
// ---------------------------------------------------------------------------

const liveFor = (over = {}) => ({ roomId: ROOM, ...over });

test("review_request with green CI suggests APPROVE-on-this-head first", () => {
  const [card] = deriveCards({ roomId: ROOM, operatorId: OP, claims: [baseClaim()], now: NOW });
  const sug = decideSuggestions(card, liveFor({ claim: baseClaim() }));
  assert.ok(sug.length <= 2);
  assert.equal(sug[0].kind, "post_approve");
  assert.equal(sug[0].gate, "retractable");
  assert.match(sug[0].title, /abc1234/);
  assert.match(sug[0].reason, /lander rule/);
  assert.equal(sug[0].api.method, "POST");
  assert.equal(sug[0].api.path, `/api/rooms/${ROOM}/work-claims/claim-1/review`);
  assert.ok(sug[0].api.body.note.includes("abc1234def"));
});

test("review_request with red CI suggests request-changes naming the failing checks", () => {
  const [card] = deriveCards({ roomId: ROOM, operatorId: OP, claims: [baseClaim()], now: NOW });
  const sug = decideSuggestions(card, liveFor({
    claim: baseClaim({ ciState: "failure", failingChecks: ["lint", "unit"] }),
  }));
  assert.equal(sug[0].kind, "request_changes");
  assert.match(sug[0].reason, /lint, unit/);
  assert.equal(sug[0].gate, "retractable");
});

test("review_request without green CI falls back to open-diff + hand-review", () => {
  const [card] = deriveCards({ roomId: ROOM, operatorId: OP, claims: [baseClaim()], now: NOW });
  const sug = decideSuggestions(card, liveFor({
    claim: baseClaim({ ciState: "pending" }),
    routerHint: { lane: "grokbot", reasons: ["touched server/routing.mjs in #900"], confidence: 0.8 },
  }));
  const kinds = sug.map(s => s.kind);
  assert.ok(kinds.includes("open_diff"));
  const hand = sug.find(s => s.kind === "hand_review");
  assert.ok(hand);
  assert.match(hand.title, /grokbot/);
  assert.match(hand.reason, /#900/); // the router's logged reason propagates
});

test("low-confidence router output suppresses lane-naming suggestions", () => {
  const [card] = deriveCards({ roomId: ROOM, operatorId: OP, claims: [baseClaim()], now: NOW });
  const sug = decideSuggestions(card, liveFor({
    claim: baseClaim({ ciState: "pending" }),
    routerHint: { lane: "grokbot", reasons: ["weak signal"], confidence: 0.2 },
  }));
  assert.ok(!sug.some(s => s.kind === "hand_review"),
    "broadcast (confidence < 0.35) must not name a lane");
});

test("blocked_lane with a named missing input suggests sending the unblocking reply", () => {
  const cards = deriveCards({
    roomId: ROOM, operatorId: OP,
    claims: [baseClaim({ state: "blocked", owner: OP, note: "blocked: need the API key" })],
    now: NOW,
  });
  const card = cards.find(c => c.kind === "blocked_lane");
  const sug = decideSuggestions(card, liveFor({
    missingInput: { summary: "the API key", draft: "Here is the key: …" },
    routerHint: { lane: "instinct", reasons: ["owns the key vault"], confidence: 0.9 },
  }));
  assert.equal(sug[0].kind, "unblock_reply");
  assert.equal(sug[0].draft, "Here is the key: …");
  assert.equal(sug[0].gate, "retractable");
  assert.equal(sug[1].kind, "reassign");
  assert.match(sug[1].title, /instinct/);
});

test("blocked_lane without a providable input suggests escalate-to-owner", () => {
  const cards = deriveCards({
    roomId: ROOM, operatorId: OP,
    claims: [baseClaim({ state: "blocked", owner: "member-other", note: "stuck on infra" })],
    now: NOW,
  });
  const card = cards.find(c => c.kind === "blocked_lane");
  const sug = decideSuggestions(card, liveFor({}));
  assert.equal(sug[0].kind, "escalate_owner");
  assert.ok(sug.length <= 2);
});

test("done_receipt suggests acknowledge + at most one take-next-claim", () => {
  const [card] = deriveCards({
    roomId: ROOM, operatorId: OP,
    claims: [baseClaim({ state: "done", owner: OP, completedAtMs: NOW - 1000 })],
    now: NOW,
  });
  const sug = decideSuggestions(card, liveFor({
    nextClaim: { id: "claim-2", title: "Follow-up polish", reason: "shares files server/routing.mjs" },
  }));
  assert.equal(sug[0].kind, "acknowledge");
  assert.equal(sug[1].kind, "take_next_claim");
  assert.match(sug[1].title, /Follow-up polish/);
  assert.equal(sug[1].api.path, `/api/rooms/${ROOM}/work-claims/claim-2/claim`);
  const takeNext = sug.filter(s => s.kind === "take_next_claim");
  assert.equal(takeNext.length, 1, "never more than one next-claim suggestion");
});

test("needs_input suggests open-thread and decline", () => {
  const [card] = deriveCards({
    roomId: ROOM, operatorId: OP,
    messages: [{
      id: "m1", seq: 101, authorId: "member-other", body: "ASK: gate on CI?",
      prefix: "ASK", mentions: [], claimRef: null, hasReplyFromOtherAuthors: false,
    }],
    now: NOW,
  });
  const sug = decideSuggestions(card, liveFor({}));
  assert.ok(sug.length <= 2);
  assert.equal(sug[0].kind, "open_thread");
  assert.equal(sug[0].gate, "none");
  assert.equal(sug[0].ref.messageId, "m1");
});

test("every suggestion carries a one-line reason (anti-silent-routing)", () => {
  const cards = deriveCards({
    roomId: ROOM, operatorId: OP,
    claims: [
      baseClaim({ id: "r1" }),
      baseClaim({ id: "b1", state: "blocked", owner: OP }),
      baseClaim({ id: "d1", state: "done", owner: OP, completedAtMs: NOW - 1000 }),
    ],
    messages: [{
      id: "m1", seq: 101, authorId: "member-other", body: "@member-op ?",
      prefix: null, mentions: [OP], claimRef: null, hasReplyFromOtherAuthors: false,
    }],
    now: NOW,
  });
  for (const card of cards) {
    for (const s of decideSuggestions(card, liveFor({}))) {
      assert.ok(typeof s.reason === "string" && s.reason.length > 0, `suggestion ${s.kind} needs a reason`);
      assert.ok(s.id === "s1" || s.id === "s2");
    }
  }
});

test("decideSuggestions is deterministic: same inputs, same outputs", () => {
  const [card] = deriveCards({ roomId: ROOM, operatorId: OP, claims: [baseClaim()], now: NOW });
  const live = liveFor({ claim: baseClaim() });
  assert.deepEqual(decideSuggestions(card, live), decideSuggestions(card, live));
});

test("decideSuggestions validates its inputs", () => {
  assert.throws(() => decideSuggestions(null, {}), SupervisionError);
  assert.throws(() => decideSuggestions({ kind: "nope" }, {}), SupervisionError);
});

// ---------------------------------------------------------------------------
// applyCardTransition — pure state machine
// ---------------------------------------------------------------------------

const newCard = (over = {}) => Object.freeze({
  id: "sv_x", dedupeKey: "k", roomId: ROOM, memberId: OP, kind: "review_request",
  state: "new", priority: "high", urgent: false,
  title: "t", summary: "s", reason: "r",
  sourceRef: Object.freeze({ type: "claim", id: "claim-1" }),
  context: Object.freeze({ claimId: "claim-1" }),
  createdAtMs: NOW, updatedAtMs: NOW,
  ...over,
});
const suggestions2 = [
  { id: "s1", index: 1, kind: "post_approve", title: "a", reason: "r", gate: "retractable", api: { method: "POST", path: "/x", body: {} }, deepLink: null, draft: null, badge: "↩ retractable" },
  { id: "s2", index: 2, kind: "hand_review", title: "b", reason: "r", gate: "confirm", api: { method: "POST", path: "/y", body: {} }, deepLink: null, draft: null, badge: "⚠ confirm" },
];

test("focus moves new → seen", () => {
  const out = applyCardTransition(newCard(), { type: "focus" }, { now: NOW + 1 });
  assert.equal(out.state, "seen");
  assert.equal(out.seenAtMs, NOW + 1);
  assert.ok(Object.isFrozen(out));
});

test("pick on a retractable suggestion moves to pending_undo with a deadline", () => {
  const card = newCard({ state: "seen" });
  const out = applyCardTransition(card, { type: "pick", suggestion: suggestions2[0] }, { now: NOW });
  assert.equal(out.state, "pending_undo");
  assert.equal(out.undoDeadlineMs, NOW + DEFAULT_UNDO_HOLD_MS);
  assert.equal(out.pickedSuggestion.index, 1);
});

test("pick honours an explicit hold window within 0..10s", () => {
  const card = newCard({ state: "seen" });
  const out = applyCardTransition(card, { type: "pick", suggestion: suggestions2[0], holdMs: 2000 }, { now: NOW });
  assert.equal(out.undoDeadlineMs, NOW + 2000);
  assert.throws(
    () => applyCardTransition(card, { type: "pick", suggestion: suggestions2[0], holdMs: 11_000 }, { now: NOW }),
    err => err instanceof SupervisionError && err.code === "invalid_input");
});

test("pick on a confirm-gated suggestion requires the confirm path", () => {
  const card = newCard({ state: "seen" });
  assert.throws(
    () => applyCardTransition(card, { type: "pick", suggestion: suggestions2[1] }, { now: NOW }),
    err => err instanceof SupervisionError && err.code === "confirm_required");
});

test("pick on a gate-none suggestion records nothing (navigation only)", () => {
  const card = newCard({ state: "seen" });
  const nav = { ...suggestions2[0], gate: "none" };
  assert.throws(
    () => applyCardTransition(card, { type: "pick", suggestion: nav }, { now: NOW }),
    err => err instanceof SupervisionError && err.code === "nothing_to_hold");
});

test("start_confirm opens the confirm challenge on a confirm-gated suggestion", () => {
  const card = newCard({ state: "seen" });
  const out = applyCardTransition(card, { type: "start_confirm", suggestion: suggestions2[1] }, { now: NOW });
  assert.equal(out.state, "acting");
  assert.equal(out.pickedSuggestion.index, 2);
});

test("start_confirm refuses a retractable suggestion", () => {
  const card = newCard({ state: "seen" });
  assert.throws(
    () => applyCardTransition(card, { type: "start_confirm", suggestion: suggestions2[0] }, { now: NOW }),
    err => err instanceof SupervisionError && err.code === "not_confirm_gated");
});

test("confirm moves acting → pending_undo with a zero-second window (cannot be undone)", () => {
  const card = newCard({ state: "acting", pickedSuggestion: suggestions2[1] });
  const out = applyCardTransition(card, { type: "confirm", confirmed: true }, { now: NOW });
  assert.equal(out.state, "pending_undo");
  assert.equal(out.undoDeadlineMs, NOW); // window already lapsed
});

test("confirm requires an explicit {confirmed:true}", () => {
  const card = newCard({ state: "acting", pickedSuggestion: suggestions2[1] });
  assert.throws(
    () => applyCardTransition(card, { type: "confirm", confirmed: false }, { now: NOW }),
    err => err instanceof SupervisionError && err.code === "confirmation_required");
});

test("retract before the deadline returns the card to seen — nothing was fired", () => {
  const card = newCard({
    state: "pending_undo", pickedSuggestion: suggestions2[0], undoDeadlineMs: NOW + 6000,
  });
  const out = applyCardTransition(card, { type: "retract" }, { now: NOW + 1000 });
  assert.equal(out.state, "seen");
  assert.equal(out.pickedSuggestion, undefined);
});

test("retract after the deadline is rejected (the write already fired)", () => {
  const card = newCard({
    state: "pending_undo", pickedSuggestion: suggestions2[0], undoDeadlineMs: NOW + 6000,
  });
  assert.throws(
    () => applyCardTransition(card, { type: "retract" }, { now: NOW + 7000 }),
    err => err instanceof SupervisionError && err.code === "undo_expired");
});

test("fired after the deadline moves pending_undo → dispatched", () => {
  const card = newCard({
    state: "pending_undo", pickedSuggestion: suggestions2[0], undoDeadlineMs: NOW + 6000,
  });
  const out = applyCardTransition(card, { type: "fired" }, { now: NOW + 7000 });
  assert.equal(out.state, "dispatched");
  assert.equal(out.firedAtMs, NOW + 7000);
});

test("fired before the deadline is rejected (the window is still open)", () => {
  const card = newCard({
    state: "pending_undo", pickedSuggestion: suggestions2[0], undoDeadlineMs: NOW + 6000,
  });
  assert.throws(
    () => applyCardTransition(card, { type: "fired" }, { now: NOW + 1000 }),
    err => err instanceof SupervisionError && err.code === "undo_window_open");
});

test("dismiss is an audit trail, never a delete", () => {
  const card = newCard({ state: "seen" });
  const out = applyCardTransition(card, { type: "dismiss", note: "not my lane" }, { now: NOW });
  assert.equal(out.state, "dismissed");
  assert.equal(out.dismissNote, "not my lane");
});

test("snooze sets a future wake time; wake re-arms to new", () => {
  const card = newCard({ state: "seen" });
  const out = applyCardTransition(card, { type: "snooze", untilMs: NOW + 3600_000 }, { now: NOW });
  assert.equal(out.state, "snoozed");
  assert.equal(out.snoozedUntilMs, NOW + 3600_000);
  const woken = applyCardTransition(out, { type: "wake" }, { now: NOW + 3600_000 });
  assert.equal(woken.state, "new");
});

test("snooze rejects a past or absurdly distant wake time", () => {
  const card = newCard({ state: "seen" });
  assert.throws(
    () => applyCardTransition(card, { type: "snooze", untilMs: NOW - 1 }, { now: NOW }),
    err => err instanceof SupervisionError && err.code === "invalid_input");
  assert.throws(
    () => applyCardTransition(card, { type: "snooze", untilMs: NOW + 400 * 24 * 3600_000 }, { now: NOW }),
    err => err instanceof SupervisionError && err.code === "invalid_input");
});

test("resolve acknowledges a card", () => {
  const out = applyCardTransition(newCard({ state: "seen" }), { type: "resolve" }, { now: NOW });
  assert.equal(out.state, "resolved");
});

test("mark_stale retires a card whose source resolved elsewhere", () => {
  const out = applyCardTransition(newCard({ state: "seen" }), { type: "mark_stale" }, { now: NOW });
  assert.equal(out.state, "stale");
});

test("rearm brings stale/dismissed cards back to new (timed_out mention re-arms)", () => {
  const out = applyCardTransition(newCard({ state: "stale" }), { type: "rearm" }, { now: NOW });
  assert.equal(out.state, "new");
});

test("illegal transitions throw", () => {
  const card = newCard({ state: "dispatched" });
  assert.throws(
    () => applyCardTransition(card, { type: "retract" }, { now: NOW }),
    err => err instanceof SupervisionError && err.code === "illegal_transition");
  assert.throws(
    () => applyCardTransition(newCard(), { type: "fired" }, { now: NOW }),
    err => err instanceof SupervisionError && err.code === "illegal_transition");
  assert.throws(
    () => applyCardTransition(newCard(), { type: "wat" }, { now: NOW }),
    err => err instanceof SupervisionError && err.code === "illegal_transition");
});

// ---------------------------------------------------------------------------
// sortCards — priority order
// ---------------------------------------------------------------------------

test("sortCards orders urgent first, then high/normal/low, then newest", () => {
  const mk = (id, urgent, priority, createdAtMs) => newCard({ id, urgent, priority, createdAtMs });
  const cards = [
    mk("a", false, "normal", NOW),
    mk("b", true, "urgent", NOW - 1000),
    mk("c", false, "low", NOW + 1000),
    mk("d", false, "high", NOW),
  ];
  const sorted = sortCards(cards).map(c => c.id);
  assert.deepEqual(sorted, ["b", "d", "a", "c"]);
});
