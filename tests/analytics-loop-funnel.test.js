// Authoring gate (test-audit): this test owns the AN-FUNNEL-2 attribution
// contract — an actor's first loop (entered -> directed/claimed -> reviewed
// -> accepted -> receipt held) computed from recorded events and public-work
// tables. No existing coverage (the function is new). Credible regressions:
// counting the worker's own attestation as the loop's review, counting a
// later claim's stages as the first loop's, treating a public submission
// receipt as acceptance, or backdating a loop to before the actor entered.
// No production seam: loopFunnel is the real boundary scripts/an-funnel-2.mjs
// calls.
import test from "node:test";
import assert from "node:assert/strict";
import { LOOP_FUNNEL_DEFINITIONS, loopFunnel } from "../server/analytics/loop-funnel.mjs";

const MIN = 60000;
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const at = (minutes) => T0 + minutes * MIN;

function byActor(result, actorId) {
  return result.actors.find(a => a.actorId === actorId);
}

const HUMAN = { memberId: "m_h", kind: "human", roomId: "r1", at: at(2) };
const AGENT = { memberId: "m_a", kind: "agent", roomId: "r1", at: at(1) };
const SIGNUP = [{ accountId: "a1", at: at(0) }];
const BINDING = [{ roomId: "r1", memberId: "m_h", accountId: "a1" }];

function claimEvent(minutes, fields) {
  return { roomId: "r1", claimId: "c1", actorId: "m_a", at: at(minutes), ...fields };
}

test("full board loop: every stage exactly once, in order, for both actors", () => {
  const result = loopFunnel({
    members: [HUMAN, AGENT],
    signups: SIGNUP,
    memberships: BINDING,
    claimEvents: [
      claimEvent(5, { actorId: "m_h", action: "created", claimState: "unclaimed", ownerId: null }),
      claimEvent(8, { action: "claimed", claimState: "claimed", ownerId: "m_a" }),
      claimEvent(20, { actorId: "m_h", action: "reviewed", verdict: "approve", claimState: "in_progress", ownerId: "m_a" }),
      // A second, later review must not move the stage: first wins.
      claimEvent(22, { actorId: "m_rev", action: "reviewed", verdict: "comment", claimState: "in_progress", ownerId: "m_a" }),
      claimEvent(25, { action: "state_changed", claimState: "done", ownerId: "m_a" }),
      claimEvent(30, { actorId: "system", action: "pr_merged", claimState: "done", ownerId: "m_a" }),
      // A second claim by the director must not displace the first loop.
      { roomId: "r1", claimId: "c2", actorId: "m_h", action: "created", claimState: "unclaimed", ownerId: null, at: at(40) }
    ]
  });

  const agent = byActor(result, "m_a");
  assert.equal(agent.enteredAt, at(1));
  assert.equal(agent.loopRef, "c1");
  assert.equal(agent.loopRole, "claimer");
  assert.equal(agent.directedOrClaimedAt, at(8));
  assert.equal(agent.reviewedAt, at(20));
  assert.equal(agent.acceptedAt, at(20));
  assert.equal(agent.acceptedVia, "review");
  assert.equal(agent.receiptAt, at(30));
  assert.equal(agent.receiptId, "rc_c1");
  assert.equal(agent.receiptKind, "wcr");
  assert.equal(agent.minutesToReceipt, 29);
  assert.equal(agent.minutesClaimToReceipt, 22);
  assert.equal(agent.sawBoardAt, null);

  const human = byActor(result, "m_h");
  assert.equal(human.enteredAt, at(0));
  assert.equal(human.enteredBasis, "signup");
  assert.equal(human.loopRole, "director");
  assert.equal(human.directedOrClaimedAt, at(5));
  assert.equal(human.reviewedAt, at(20));
  assert.equal(human.acceptedAt, at(20));
  assert.equal(human.receiptAt, at(30));
  assert.equal(human.receiptId, "rc_c1");

  assert.equal(result.summary.actors, 2);
  assert.equal(result.summary.withLoop, 2);
  assert.equal(result.summary.reviewed, 2);
  assert.equal(result.summary.accepted, 2);
  assert.equal(result.summary.receipts, 2);
  assert.equal(result.summary.receiptRate, 1);
  assert.equal(result.summary.humans.receipts, 1);
  assert.equal(result.summary.agents.receipts, 1);
  assert.equal(result.summary.board.claims, 2);
  assert.equal(result.summary.board.receipts, 1);
});

test("loop abandoned at review stops there: no acceptance, no receipt", () => {
  const result = loopFunnel({
    members: [HUMAN, AGENT],
    signups: SIGNUP,
    memberships: BINDING,
    claimEvents: [
      claimEvent(5, { actorId: "m_h", action: "created", claimState: "unclaimed", ownerId: null }),
      claimEvent(8, { action: "claimed", claimState: "claimed", ownerId: "m_a" }),
      claimEvent(15, { actorId: "m_h", action: "reviewed", verdict: "changes_requested", claimState: "in_progress", ownerId: "m_a" })
    ]
  });
  const agent = byActor(result, "m_a");
  assert.equal(agent.reviewedAt, at(15));
  assert.equal(agent.acceptedAt, null);
  assert.equal(agent.receiptAt, null);
  assert.equal(agent.receiptId, null);
  assert.equal(result.summary.reviewed, 2);
  assert.equal(result.summary.accepted, 0);
  assert.equal(result.summary.receipts, 0);
});

test("merged-delivery completion without any review: acceptance via completion", () => {
  const result = loopFunnel({
    members: [HUMAN, AGENT],
    signups: SIGNUP,
    memberships: BINDING,
    claimEvents: [
      claimEvent(5, { actorId: "m_h", action: "created", claimState: "unclaimed", ownerId: null }),
      claimEvent(8, { action: "claimed", claimState: "claimed", ownerId: "m_a" }),
      claimEvent(25, { action: "state_changed", claimState: "done", ownerId: "m_a" }),
      claimEvent(18, { actorId: "system", action: "pr_merged", claimState: "in_progress", ownerId: "m_a" })
    ]
  });
  const agent = byActor(result, "m_a");
  assert.equal(agent.reviewedAt, null);
  assert.equal(agent.acceptedAt, at(25));
  assert.equal(agent.acceptedVia, "completion");
  // Receipt is due at the later of done and merged.
  assert.equal(agent.receiptAt, at(25));
});

test("the worker's own attestation stamp is not the loop's review", () => {
  const result = loopFunnel({
    members: [HUMAN, AGENT],
    signups: SIGNUP,
    memberships: BINDING,
    claimEvents: [
      claimEvent(5, { actorId: "m_h", action: "created", claimState: "unclaimed", ownerId: null }),
      claimEvent(8, { action: "claimed", claimState: "claimed", ownerId: "m_a" }),
      claimEvent(12, { action: "reviewed", claimState: "in_progress", ownerId: "m_a" })
    ]
  });
  const agent = byActor(result, "m_a");
  assert.equal(agent.reviewedAt, null);
  assert.equal(result.summary.board.reviewed, 0);
});

test("a claim from before the actor entered is clock-skew noise, not a loop", () => {
  const result = loopFunnel({
    members: [{ memberId: "m_late", kind: "human", roomId: "r1", at: at(50) }],
    claimEvents: [
      { roomId: "r1", claimId: "c0", actorId: "m_late", action: "created", claimState: "unclaimed", ownerId: null, at: at(5) }
    ]
  });
  const actor = byActor(result, "m_late");
  assert.equal(actor.enteredAt, at(50));
  assert.equal(actor.loopRef, null);
  assert.equal(actor.directedOrClaimedAt, null);
});

test("public loop: submission receipt precedes review; acceptance is the decision", () => {
  const result = loopFunnel({
    publicTasks: [{
      taskId: "pw-1", namespaceId: "ns1", roomId: "r9", createdAt: at(0),
      history: [
        { at: at(10), actorId: "ai_x", action: "claimed" },
        { at: at(11), actorId: "ai_x", action: "state:in_progress" },
        { at: at(40), actorId: "ai_x", action: "state:done" }
      ],
      receipt: { receiptId: "pwr_1", identityId: "ai_x", at: at(40) },
      verification: { actorId: "m_h", at: at(50), verdict: "PASS" },
      decision: { actorId: "m_h", at: at(55), decision: "accepted" }
    }, {
      taskId: "pw-2", namespaceId: "ns1", roomId: "r9", createdAt: at(0),
      history: [{ at: at(12), actorId: "ai_y", action: "claimed" }],
      receipt: { receiptId: "pwr_2", identityId: "ai_y", at: at(20) },
      verification: null,
      decision: null
    }]
  });

  const x = byActor(result, "ai_x");
  assert.equal(x.kind, "agent");
  assert.equal(x.enteredAt, at(10));
  assert.equal(x.enteredBasis, "first_board_action");
  assert.equal(x.loopSystem, "public");
  assert.equal(x.directedOrClaimedAt, at(10));
  assert.equal(x.receiptAt, at(40));
  assert.equal(x.receiptId, "pwr_1");
  assert.equal(x.reviewedAt, at(50));
  assert.equal(x.acceptedAt, at(55));
  assert.equal(x.acceptedVia, "review");

  const y = byActor(result, "ai_y");
  assert.equal(y.receiptAt, at(20));
  assert.equal(y.reviewedAt, null);
  assert.equal(y.acceptedAt, null);

  assert.deepEqual(result.summary.public, { tasks: 2, claimed: 2, submitted: 2, reviewed: 1, accepted: 1 });
});

test("a public claim by a linked identity attaches to that member's loop", () => {
  const result = loopFunnel({
    members: [{ memberId: "m_z", kind: "agent", roomId: "r9", at: at(1) }],
    identityLinks: [{ roomId: "r9", memberId: "m_z", identityId: "ai_z" }],
    publicTasks: [{
      taskId: "pw-9", namespaceId: "ns9", roomId: "r9", createdAt: at(0),
      history: [{ at: at(10), actorId: "ai_z", action: "claimed" }],
      receipt: { receiptId: "pwr_9", identityId: "ai_z", at: at(30) },
      verification: null,
      decision: null
    }]
  });
  assert.equal(byActor(result, "ai_z"), undefined);
  const member = byActor(result, "m_z");
  assert.equal(member.loopSystem, "public");
  assert.equal(member.loopRef, "pw-9");
  assert.equal(member.receiptId, "pwr_9");
});

test("definitions pin the unmeasured stage and the activation definition", () => {
  assert.match(LOOP_FUNNEL_DEFINITIONS.sawBoard, /UNMEASURED/);
  assert.match(LOOP_FUNNEL_DEFINITIONS.activation, /first-receipt-held/);
  assert.match(LOOP_FUNNEL_DEFINITIONS.receiptHeld, /BEFORE review/);
});
