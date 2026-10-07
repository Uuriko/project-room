// Bounty lifecycle state machine tests — hard tasks 102 + 112.
//
// ≥15 transition tests plus the 6 timeout scenarios from the escrow-timeout
// policy doc.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createBounty, transition, canTransition, applyTimeouts, isTerminal, TERMINAL, DEFAULT_TIMEOUTS,
} from "../scripts/exchange/bounty-lifecycle.mjs";

const T0 = 1_700_000_000_000;
const mk = (over = {}) => createBounty({ id: "b1", title: "Fix it", amount: 100, sponsor: "sponsor1", at: T0, ...over });
const step = (b, event, at = T0) => transition(b, event, { at, actor: "tester" });
const drive = (b, ...events) => events.reduce((acc, e) => step(acc, e), b);

test("happy path: draft → funded → claimed → submitted → in_review → paid", () => {
  const b = drive(mk(), "fund", "claim", "submit", "start_review", "approve");
  assert.equal(b.state, "paid");
  assert.ok(isTerminal(b));
  assert.equal(b.history.length, 6, "create + 5 transitions are journaled");
  assert.deepEqual(b.history.map(h => h.to),
    ["draft", "funded", "claimed", "submitted", "in_review", "paid"]);
});

test("dispute path: in_review → disputed → resolved_paid", () => {
  const b = drive(mk(), "fund", "claim", "submit", "start_review", "dispute", "resolve_pay");
  assert.equal(b.state, "resolved_paid");
  assert.ok(isTerminal(b));
});

test("dispute path: disputed → resolved_refunded", () => {
  const b = drive(mk(), "fund", "claim", "submit", "dispute", "resolve_refund");
  assert.equal(b.state, "resolved_refunded");
});

test("dispute can open from submitted, before review starts", () => {
  const b = drive(mk(), "fund", "claim", "submit", "dispute");
  assert.equal(b.state, "disputed");
});

test("request_changes sends the bounty back to claimed with fresh deadlines", () => {
  let b = drive(mk(), "fund", "claim", "submit", "start_review", "request_changes");
  assert.equal(b.state, "claimed");
  assert.ok(b.claimDeadline > T0 && b.submissionDeadline > T0, "deadlines restart");
  b = drive(b, "submit", "start_review", "approve");
  assert.equal(b.state, "paid");
});

test("release_claim re-opens the bounty to funded", () => {
  const b = drive(mk(), "fund", "claim", "release_claim");
  assert.equal(b.state, "funded");
  assert.ok(canTransition(b, "claim"), "a new claimant can take it");
});

test("sponsor_cancel is only pre-claim; cancel_draft kills drafts", () => {
  assert.equal(step(mk(), "cancel_draft").state, "cancelled");
  assert.equal(drive(mk(), "fund", "sponsor_cancel").state, "cancelled");
  assert.throws(() => drive(mk(), "fund", "claim", "sponsor_cancel"), err => err.code === "invalid_transition",
    "no unilateral sponsor cancel after a claim — that path is dispute");
});

test("invalid transitions throw invalid_transition", () => {
  const b = mk();
  for (const event of ["claim", "submit", "approve", "dispute", "resolve_pay"]) {
    assert.throws(() => step(b, event), err => err.code === "invalid_transition", `${event} from draft`);
  }
  assert.throws(() => step(b, "nope"), err => err.code === "unknown_event");
});

test("terminal states never transition", () => {
  for (const state of TERMINAL) {
    const b = { ...mk(), state };
    assert.ok(!canTransition(b, "claim") && !canTransition(b, "fund"), `${state} is terminal`);
    assert.throws(() => step(b, "claim"), err => err.code === "invalid_transition");
  }
});

test("claim stamps claim and submission deadlines; funding deadline clears on fund", () => {
  const b = drive(mk(), "fund", "claim");
  assert.equal(b.claimDeadline, T0 + DEFAULT_TIMEOUTS.claimTtlMs);
  assert.equal(b.submissionDeadline, T0 + DEFAULT_TIMEOUTS.submissionTtlMs);
  assert.equal(b.fundingDeadline, null);
});

test("timeouts are per-bounty tunable", () => {
  const b = mk({ timeouts: { claimTtlMs: 1000 } });
  const { bounty, fired } = applyTimeouts(transition(b, "fund", { at: T0 }), T0 + 500);
  assert.deepEqual(fired, [], "custom deadline not yet lapsed");
  const claimed = drive(b, "fund", "claim");
  const late = applyTimeouts(claimed, T0 + 1001);
  assert.deepEqual(late.fired, ["claim_timeout"]);
  assert.equal(late.bounty.state, "funded");
});

test("history records every transition with actor and clock", () => {
  const b = drive(mk(), "fund", "claim");
  assert.deepEqual(b.history[1], { event: "fund", from: "draft", to: "funded", at: T0, actor: "tester" });
  assert.deepEqual(b.history[2], { event: "claim", from: "funded", to: "claimed", at: T0, actor: "tester" });
});

// --- Task 112: the six timeout scenarios ---

test("112.1: unfunded draft expires after the funding window", () => {
  const b = mk();
  const { bounty, fired } = applyTimeouts(b, T0 + DEFAULT_TIMEOUTS.fundingWindowMs);
  assert.deepEqual(fired, ["expire_unfunded"]);
  assert.equal(bounty.state, "expired");
  assert.ok(isTerminal(bounty));
});

test("112.2: claimed bounty with no submission returns to funded after the claim TTL", () => {
  const b = drive(mk(), "fund", "claim");
  const { bounty, fired } = applyTimeouts(b, T0 + DEFAULT_TIMEOUTS.claimTtlMs);
  assert.deepEqual(fired, ["claim_timeout"]);
  assert.equal(bounty.state, "funded");
});

test("112.3: slow work — submission TTL lapses even with an extended claim TTL", () => {
  const b = mk({ timeouts: { claimTtlMs: 1000, submissionTtlMs: 2000 } });
  const claimed = drive(b, "fund", "claim");
  const mid = applyTimeouts(claimed, T0 + 1500);
  assert.deepEqual(mid.fired, ["claim_timeout"], "claim TTL fires first");
  const claimed2 = drive(mk({ timeouts: { claimTtlMs: 5000, submissionTtlMs: 2000 } }), "fund", "claim");
  const late = applyTimeouts(claimed2, T0 + 2500);
  assert.deepEqual(late.fired, ["claim_timeout"], "submission TTL also returns to funded");
  assert.equal(late.bounty.state, "funded");
});

test("112.4: silent reviewers — in_review auto-pays after the review TTL", () => {
  const b = drive(mk(), "fund", "claim", "submit", "start_review");
  const { bounty, fired } = applyTimeouts(b, T0 + DEFAULT_TIMEOUTS.reviewTtlMs);
  assert.deepEqual(fired, ["review_timeout"]);
  assert.equal(bounty.state, "paid", "approval by default: silence is consent");
});

test("112.5: undecided dispute refunds the sponsor after the dispute TTL", () => {
  const b = drive(mk(), "fund", "claim", "submit", "dispute");
  const { bounty, fired } = applyTimeouts(b, T0 + DEFAULT_TIMEOUTS.disputeTtlMs);
  assert.deepEqual(fired, ["dispute_timeout"]);
  assert.equal(bounty.state, "resolved_refunded", "no arbiter decision → sponsor refunded");
});

test("112.6: timeouts are idempotent; terminal states never time out", () => {
  const b = drive(mk(), "fund", "claim");
  const first = applyTimeouts(b, T0 + DEFAULT_TIMEOUTS.claimTtlMs + 1);
  assert.deepEqual(first.fired, ["claim_timeout"]);
  const second = applyTimeouts(first.bounty, T0 + DEFAULT_TIMEOUTS.claimTtlMs + 999999);
  assert.deepEqual(second.fired, [], "re-applying changes nothing");
  for (const state of TERMINAL) {
    const t = applyTimeouts({ ...mk(), state }, T0 + 10 ** 15);
    assert.deepEqual(t.fired, [], `${state} never times out`);
    assert.equal(t.bounty.state, state);
  }
});

test("no timeout fires early", () => {
  const b = drive(mk(), "fund", "claim", "submit", "start_review");
  const { fired } = applyTimeouts(b, T0 + DEFAULT_TIMEOUTS.reviewTtlMs - 1);
  assert.deepEqual(fired, []);
  const d = drive(mk(), "fund", "claim", "submit", "dispute");
  assert.deepEqual(applyTimeouts(d, T0 + DEFAULT_TIMEOUTS.disputeTtlMs - 1).fired, []);
});
