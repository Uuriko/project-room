// Lane 12 (acp-build-disputes): escrow dispute + appeals tests.
//
// Lane 7's claim escrow machine (server/claim-escrow.mjs, PR #1787) is a
// single-party bond machine with no dispute transitions: the seated
// evaluator signs the verdict, approve -> released, reject -> slashed. That
// reproduces ACP's dispute hole in room form: one signature is final with
// no appeal, and nothing prices a challenge. This module owns what the
// machine leaves out: dispute bonds (the disputer stakes too), appeals (a
// second independent panel, majority rules, exactly one escalation), and
// finality (the settlement directive, including panel overturns of the
// arbiter). The machine is driven through
// server/claim-escrow-dispute-adapter.mjs, which exposes the dispute-capable
// escrow view (get/dispute/resolveDispute) over the real lane-7 machine:
// "disputed"/"resolved" are overlay states reported by the adapter while
// the machine keeps its raw state, and the adapter drives approve/reject
// only when the ruler is the seated evaluator in in_evaluation — every
// other ruling is a settlement-layer directive.
//
// Authoring-gate answers (test-audit SKILL.md):
// 1. Contracts: exact 25% dispute bond / 50% appeal bond as preconditions;
//    standing (payer|payee dispute; evaluator/arbiter structurally refused);
//    one dispute per escrow; arbiter-only tier-0 ruling; aggrieved-party
//    appeal standing; 3-seat panel independence + majority rule; exactly
//    one escalation; frivolous = no appeal as of right; pre-ruling
//    withdrawal refused (the machine has no un-dispute transition);
//    stall backstop with the conservative default; exactly-once
//    onDisputeFinalized with bond movements and the overturn flag.
// 2. Credible regressions: free disputes (griefing freeze); evaluator
//    disputing; second dispute on one escrow; non-arbiter ruling;
//    appeal by the non-aggrieved party; panel stacked with the arbiter;
//    second escalation; appeal after a frivolous ruling; settlement
//    honoring the machine's raw `resolved` over a panel overturn;
//    disputes stalling forever when the arbiter never rules.
// 3. Existing coverage gap: server/claim-escrow.mjs owns the machine's own
//    transitions (its PR #1787 tests cover them); bounty-disputes owns the
//    bounty-keyed ladder; dispute-arbiters owns decider seating. Nothing
//    owns the bond precondition, the appeal tier, or the finality
//    directive for escrow disputes. This module is the contract owner.
//    Tests use the REAL lane-7 machine through the dispute adapter (no
//    behavioral mocks: a fake would implement the asserted behavior).
// 4. No test-only production seams: the hooks (onDisputeOpened /
//    onDisputeFinalized) and the injectable clock are the production
//    integration surface (keeper wiring, lane-10 registry adapter).
import test from "node:test";
import assert from "node:assert/strict";
import { createClaimEscrows } from "../server/claim-escrow.mjs";
import { createClaimEscrowDisputeAdapter } from "../server/claim-escrow-dispute-adapter.mjs";
import { createEscrowDisputes, EscrowDisputeError } from "../server/escrow-disputes.mjs";

const throwsCode = (fn, code) =>
  assert.throws(fn, error => error instanceof EscrowDisputeError && error.code === code);

const PAYER = "agent:payer-1";       // buyer side — wants refund
const PAYEE = "agent:payee-1";       // seller side — wants release
const EVALUATOR = "agent:evaluator-1";
const ARBITER = "agent:arbiter-1";
const PANEL = ["agent:panel-a", "agent:panel-b", "agent:panel-c"];
const T0 = Date.parse("2026-10-07T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// amount 100 -> dispute bond exactly 25, appeal bond exactly 50.
// The lane-7 machine is single-party (claimant posts the bond); the adapter
// projects the payer|payee pair the dispute layer needs, defaulting to a
// distinct arbiter seat per test.
function setup({ arbiterOf } = {}) {
  let now = T0;
  const opened = [];
  const finalized = [];
  const machine = createClaimEscrows();
  const escrows = createClaimEscrowDisputeAdapter({ machine,
    partiesOf: () => ({ payer: PAYER, payee: PAYEE }),
    arbiterOf: arbiterOf ?? (() => ARBITER) });
  const ed = createEscrowDisputes({ escrows, nowMs: () => now,
    appealWindowMs: HOUR, disputeTimeoutMs: 14 * DAY,
    onDisputeOpened: event => opened.push(event),
    onDisputeFinalized: event => finalized.push(event) });
  return { ed, escrows, machine, opened, finalized,
    advance: ms => { now += ms; } };
}

function funded(api, id = "esc1") {
  api.machine.create({ escrowId: id, claimId: `claim-${id}`, claimant: PAYER,
    bondUnits: 100, denomination: "credit", leaseExpiresAt: null });
  api.machine.lockBond(id, { by: PAYER });
  return id;
}
function inEvaluation(api, id = "esc1") {
  funded(api, id);
  api.machine.submitWork(id, { by: PAYER });
  api.machine.seatEvaluator(id, { evaluator: EVALUATOR });
  return id;
}
// Payee disputes an in-evaluation escrow; returns the dispute record.
function disputed(api, id = "esc1") {
  inEvaluation(api, id);
  return api.ed.openDispute(id, { by: PAYEE, bond: 25, reason: "evaluator stalling" });
}
function ruled(api, { outcome = "refund", id = "esc1" } = {}) {
  disputed(api, id);
  return api.ed.ruleDispute(id, { arbiter: ARBITER, outcome,
    reasonCodes: ["evidence-insufficient"], note: "work not demonstrated" });
}

test("openDispute: payee stakes the exact 25% bond, escrow freezes, registry hook fires", () => {
  const api = setup();
  const rec = disputed(api);
  assert.equal(rec.state, "disputed");
  assert.equal(rec.bondSnapshot, 25);
  assert.equal(api.escrows.get("esc1").state, "disputed");
  assert.equal(api.opened.length, 1);
  assert.equal(api.opened[0].escrowId, "esc1");
  assert.equal(api.opened[0].evaluator, EVALUATOR);
  assert.equal(api.opened[0].raisedBy, PAYEE);
  assert.ok(Object.isFrozen(rec));
});

test("openDispute: payer may dispute from in_evaluation", () => {
  const api = setup();
  inEvaluation(api);
  const rec = api.ed.openDispute("esc1", { by: PAYER, bond: 25, reason: "evaluator captured" });
  assert.equal(rec.state, "disputed");
  assert.equal(api.escrows.get("esc1").state, "disputed");
});

test("openDispute: anything but the exact 25% bond throws bond_invalid, machine untouched", () => {
  const api = setup();
  inEvaluation(api);
  throwsCode(() => api.ed.openDispute("esc1", { by: PAYEE, bond: 24, reason: "x" }), "bond_invalid");
  throwsCode(() => api.ed.openDispute("esc1", { by: PAYEE, bond: 26, reason: "x" }), "bond_invalid");
  assert.equal(api.escrows.get("esc1").state, "in_evaluation");
  assert.equal(api.ed.size(), 0);
});

test("openDispute: the evaluator cannot dispute (exposure rule)", () => {
  const api = setup();
  inEvaluation(api);
  throwsCode(() => api.ed.openDispute("esc1", { by: EVALUATOR, bond: 25, reason: "x" }), "not_authorized");
  assert.equal(api.escrows.get("esc1").state, "in_evaluation");
});

test("openDispute: the arbiter cannot dispute either", () => {
  const api = setup();
  inEvaluation(api);
  throwsCode(() => api.ed.openDispute("esc1", { by: ARBITER, bond: 25, reason: "x" }), "not_authorized");
});

test("openDispute: a stranger with no seat cannot dispute", () => {
  const api = setup();
  inEvaluation(api);
  throwsCode(() => api.ed.openDispute("esc1", { by: "agent:stranger", bond: 25, reason: "x" }), "not_authorized");
});

test("openDispute: non-disputable escrow states throw, no record created", () => {
  const api = setup();
  api.machine.create({ escrowId: "esc1", claimId: "claim-esc1", claimant: PAYER,
    bondUnits: 100, denomination: "credit", leaseExpiresAt: null });
  throwsCode(() => api.ed.openDispute("esc1", { by: PAYER, bond: 25, reason: "x" }), "invalid_transition");
  assert.equal(api.ed.size(), 0);
});

test("openDispute: one dispute per escrow", () => {
  const api = setup();
  disputed(api);
  throwsCode(() => api.ed.openDispute("esc1", { by: PAYER, bond: 25, reason: "again" }), "dispute_exists");
});

test("ruleDispute: the designated arbiter rules, machine resolves, appeal window opens", () => {
  const api = setup();
  const rec = ruled(api, { outcome: "refund" });
  assert.equal(rec.state, "ruled");
  assert.equal(rec.arbiterRuling.outcome, "refund");
  assert.equal(rec.arbiterRuling.arbiter, ARBITER);
  assert.equal(api.escrows.get("esc1").state, "resolved");
  assert.equal(api.escrows.get("esc1").disputeOutcome, "refund");
  assert.equal(api.finalized.length, 0); // not final: appeal window is open
});

test("ruleDispute: anyone but the designated arbiter throws not_arbiter", () => {
  const api = setup();
  disputed(api);
  throwsCode(() => api.ed.ruleDispute("esc1", { arbiter: EVALUATOR, outcome: "refund",
    reasonCodes: ["evidence-insufficient"], note: "x" }), "not_arbiter");
  assert.equal(api.escrows.get("esc1").state, "disputed");
});

test("ruleDispute: frivolous ruling is final immediately, no appeal as of right, bond forfeited", () => {
  const api = setup();
  disputed(api);
  const fin = api.ed.ruleDispute("esc1", { arbiter: ARBITER, outcome: "refund",
    reasonCodes: ["frivolous"], note: "griefing dispute" });
  assert.equal(fin.state, "final");
  assert.equal(fin.finalOutcome, "refund");
  assert.deepEqual(fin.bondMovements, [
    { party: PAYEE, amount: 25, direction: "forfeit-to-pool", reason: "frivolous" },
  ]);
  throwsCode(() => api.ed.appealDispute("esc1", { by: PAYEE, bond: 50, panel: PANEL }), "frivolous");
  assert.equal(api.finalized.length, 1);
  assert.equal(api.finalized[0].overturned, false);
});

test("lapseAppealWindow: before the window elapses it throws appeal_window_open", () => {
  const api = setup();
  ruled(api);
  throwsCode(() => api.ed.lapseAppealWindow("esc1"), "appeal_window_open");
  assert.equal(api.ed.get("esc1").state, "ruled");
});

test("lapseAppealWindow: no appeal -> arbiter ruling is final; winner's bond returns, loser's forfeits", () => {
  const api = setup();
  ruled(api, { outcome: "refund" }); // payee disputed wanting release; payer wins
  api.advance(HOUR + 1);
  const fin = api.ed.lapseAppealWindow("esc1");
  assert.equal(fin.state, "final");
  assert.equal(fin.finalOutcome, "refund");
  assert.deepEqual(fin.bondMovements, [
    { party: PAYEE, amount: 25, direction: "forfeit-to-pool", reason: "challenge-failed" },
  ]);
  assert.equal(api.finalized[0].overturned, false);
  assert.equal(api.finalized[0].tier, 0);
});

test("lapseAppealWindow: disputer wins on the ruling -> bond returned", () => {
  const api = setup();
  inEvaluation(api);
  api.ed.openDispute("esc1", { by: PAYER, bond: 25, reason: "payee ghosted" });
  api.ed.ruleDispute("esc1", { arbiter: ARBITER, outcome: "refund",
    reasonCodes: ["evidence-insufficient"], note: "no deliverable" });
  api.advance(HOUR + 1);
  const fin = api.ed.lapseAppealWindow("esc1");
  assert.equal(fin.finalOutcome, "refund");
  assert.deepEqual(fin.bondMovements, [
    { party: PAYER, amount: 25, direction: "return-to-party", reason: "challenge-succeeded" },
  ]);
});

test("appealDispute: the aggrieved party stakes exactly 2x and seats an independent panel", () => {
  const api = setup();
  ruled(api, { outcome: "refund" }); // payee aggrieved
  throwsCode(() => api.ed.appealDispute("esc1", { by: PAYEE, bond: 49, panel: PANEL }), "bond_invalid");
  const rec = api.ed.appealDispute("esc1", { by: PAYEE, bond: 50, panel: PANEL });
  assert.equal(rec.state, "appealed");
  assert.deepEqual(rec.appeal.panel, PANEL);
  assert.equal(rec.appeal.bond, 50);
});

test("appealDispute: the non-aggrieved party has no standing", () => {
  const api = setup();
  ruled(api, { outcome: "refund" }); // payer won; payer cannot appeal its own win
  throwsCode(() => api.ed.appealDispute("esc1", { by: PAYER, bond: 50, panel: PANEL }), "no_standing");
});

test("appealDispute: a panel stacked with the arbiter is refused", () => {
  const api = setup();
  ruled(api, { outcome: "refund" });
  throwsCode(() => api.ed.appealDispute("esc1", { by: PAYEE, bond: 50,
    panel: [ARBITER, "agent:panel-b", "agent:panel-c"] }), "panel_not_independent");
});

test("appealDispute: a panel stacked with a party is refused", () => {
  const api = setup();
  ruled(api, { outcome: "refund" });
  throwsCode(() => api.ed.appealDispute("esc1", { by: PAYEE, bond: 50,
    panel: [PAYER, "agent:panel-b", "agent:panel-c"] }), "panel_not_independent");
});

test("appealDispute: malformed panels are refused", () => {
  const api = setup();
  ruled(api, { outcome: "refund" });
  throwsCode(() => api.ed.appealDispute("esc1", { by: PAYEE, bond: 50,
    panel: ["agent:a", "agent:b"] }), "panel_invalid");
  throwsCode(() => api.ed.appealDispute("esc1", { by: PAYEE, bond: 50,
    panel: ["agent:a", "agent:a", "agent:b"] }), "panel_invalid");
});

test("appealDispute: after the window lapses the appeal right expires", () => {
  const api = setup();
  ruled(api, { outcome: "refund" });
  api.advance(HOUR + 1);
  throwsCode(() => api.ed.appealDispute("esc1", { by: PAYEE, bond: 50, panel: PANEL }), "appeal_window_closed");
});

test("ruleAppeal: panel majority overturns the arbiter; both bonds return; overturn flagged", () => {
  const api = setup();
  ruled(api, { outcome: "refund" }); // payee aggrieved, wants release
  api.ed.appealDispute("esc1", { by: PAYEE, bond: 50, panel: PANEL });
  const fin = api.ed.ruleAppeal("esc1", {
    votes: [
      { lane: "agent:panel-a", outcome: "release" },
      { lane: "agent:panel-b", outcome: "release" },
      { lane: "agent:panel-c", outcome: "refund" },
    ],
    reasonCodes: ["criterion-unmet"],
  });
  assert.equal(fin.state, "final");
  assert.equal(fin.finalOutcome, "release");
  assert.equal(fin.overturned, true);
  assert.deepEqual(fin.bondMovements, [
    { party: PAYEE, amount: 25, direction: "return-to-party", reason: "challenge-succeeded" },
    { party: PAYEE, amount: 50, direction: "return-to-party", reason: "appeal-succeeded" },
  ]);
  assert.equal(api.finalized.length, 1);
  assert.equal(api.finalized[0].overturned, true);
  assert.equal(api.finalized[0].panelMajority, true);
  assert.equal(api.finalized[0].tier, 1);
  // The machine still reads the arbiter's ruling: the directive overrules it.
  assert.equal(api.escrows.get("esc1").disputeOutcome, "refund");
  assert.equal(api.finalized[0].arbiterOutcome, "refund");
});

test("ruleAppeal: panel upholds the arbiter; appellant bond forfeited", () => {
  const api = setup();
  ruled(api, { outcome: "refund" });
  api.ed.appealDispute("esc1", { by: PAYEE, bond: 50, panel: PANEL });
  const fin = api.ed.ruleAppeal("esc1", {
    votes: [
      { lane: "agent:panel-a", outcome: "refund" },
      { lane: "agent:panel-b", outcome: "refund" },
      { lane: "agent:panel-c", outcome: "refund" },
    ],
    reasonCodes: ["evidence-insufficient"],
  });
  assert.equal(fin.finalOutcome, "refund");
  assert.equal(fin.overturned, false);
  assert.deepEqual(fin.bondMovements, [
    { party: PAYEE, amount: 25, direction: "forfeit-to-pool", reason: "challenge-failed" },
    { party: PAYEE, amount: 50, direction: "forfeit-to-pool", reason: "appeal-failed" },
  ]);
});

test("ruleAppeal: votes from outside the panel throw; duplicates throw", () => {
  const api = setup();
  ruled(api, { outcome: "refund" });
  api.ed.appealDispute("esc1", { by: PAYEE, bond: 50, panel: PANEL });
  throwsCode(() => api.ed.ruleAppeal("esc1", {
    votes: [
      { lane: "agent:panel-a", outcome: "release" },
      { lane: "agent:panel-b", outcome: "release" },
      { lane: "agent:intruder", outcome: "release" },
    ],
    reasonCodes: ["criterion-unmet"],
  }), "vote_invalid");
  throwsCode(() => api.ed.ruleAppeal("esc1", {
    votes: [
      { lane: "agent:panel-a", outcome: "release" },
      { lane: "agent:panel-a", outcome: "release" },
      { lane: "agent:panel-b", outcome: "refund" },
    ],
    reasonCodes: ["criterion-unmet"],
  }), "vote_invalid");
});

test("exactly one escalation: appealing the panel's ruling throws appeal_exhausted", () => {
  const api = setup();
  ruled(api, { outcome: "refund" });
  api.ed.appealDispute("esc1", { by: PAYEE, bond: 50, panel: PANEL });
  api.ed.ruleAppeal("esc1", {
    votes: PANEL.map(lane => ({ lane, outcome: "refund" })),
    reasonCodes: ["evidence-insufficient"],
  });
  throwsCode(() => api.ed.appealDispute("esc1", { by: PAYEE, bond: 100, panel: PANEL }), "appeal_exhausted");
});

test("withdrawDispute: after the ruling, the loser accepts it; all staked bonds forfeited", () => {
  const api = setup();
  ruled(api, { outcome: "refund" });
  const fin = api.ed.withdrawDispute("esc1", { by: PAYEE });
  assert.equal(fin.state, "final");
  assert.equal(fin.finalOutcome, "refund"); // the ruling stands
  assert.deepEqual(fin.bondMovements, [
    { party: PAYEE, amount: 25, direction: "forfeit-to-pool", reason: "withdrawn" },
  ]);
  assert.equal(api.finalized.length, 1);
});

test("withdrawDispute: withdrawing the appeal abandons it; the ruling stands", () => {
  const api = setup();
  ruled(api, { outcome: "refund" });
  api.ed.appealDispute("esc1", { by: PAYEE, bond: 50, panel: PANEL });
  const fin = api.ed.withdrawDispute("esc1", { by: PAYEE });
  assert.equal(fin.finalOutcome, "refund");
  assert.deepEqual(fin.bondMovements, [
    { party: PAYEE, amount: 25, direction: "forfeit-to-pool", reason: "withdrawn" },
    { party: PAYEE, amount: 50, direction: "forfeit-to-pool", reason: "withdrawn" },
  ]);
});

test("withdrawDispute: pre-ruling withdrawal is refused — the arbiter always rules", () => {
  const api = setup();
  disputed(api);
  throwsCode(() => api.ed.withdrawDispute("esc1", { by: PAYEE }), "withdraw_too_early");
  assert.equal(api.ed.get("esc1").state, "disputed");
});

test("resolveStalled: arbiter never rules past the timeout -> conservative default, directive fired", () => {
  const api = setup();
  disputed(api);
  api.advance(14 * DAY + 1);
  const fin = api.ed.resolveStalled("esc1");
  assert.equal(fin.state, "final");
  assert.equal(fin.finalOutcome, "refund"); // funds return to the payer
  assert.deepEqual(fin.bondMovements, [
    { party: PAYEE, amount: 25, direction: "forfeit-to-pool", reason: "abandoned" },
  ]);
  assert.equal(api.finalized.length, 1);
  assert.equal(api.finalized[0].tier, 0);
  // The adapter never mutates the machine on a stall: it still reads its raw
  // state, so the settlement layer must honor the directive, not the raw
  // machine state.
  assert.equal(api.escrows.get("esc1").state, "disputed");
});

test("resolveStalled: before the timeout it throws stall_window_open", () => {
  const api = setup();
  disputed(api);
  api.advance(13 * DAY);
  throwsCode(() => api.ed.resolveStalled("esc1"), "stall_window_open");
});

test("finality is exactly-once: onDisputeFinalized fires once per dispute", () => {
  const api = setup();
  ruled(api, { outcome: "refund" });
  api.advance(HOUR + 1);
  api.ed.lapseAppealWindow("esc1");
  assert.equal(api.finalized.length, 1);
  throwsCode(() => api.ed.lapseAppealWindow("esc1"), "already_final");
  throwsCode(() => api.ed.appealDispute("esc1", { by: PAYEE, bond: 50, panel: PANEL }), "already_final");
  assert.equal(api.finalized.length, 1);
});

test("finalized directive carries the full settlement packet", () => {
  const api = setup();
  ruled(api, { outcome: "refund" });
  api.advance(HOUR + 1);
  api.ed.lapseAppealWindow("esc1");
  const packet = api.finalized[0];
  assert.equal(packet.escrowId, "esc1");
  assert.equal(packet.finalOutcome, "refund");
  assert.equal(packet.arbiterOutcome, "refund");
  assert.equal(packet.overturned, false);
  assert.equal(packet.raisedBy, PAYEE);
  assert.ok(Array.isArray(packet.bondMovements));
  assert.ok(typeof packet.finalizedAt === "string");
});

test("adapter: when the ruler is the seated evaluator, the ruling drives the machine", () => {
  const api = setup({ arbiterOf: record => record.evaluator });
  inEvaluation(api);
  api.ed.openDispute("esc1", { by: PAYER, bond: 25, reason: "verdict too harsh" });
  const rec = api.ed.ruleDispute("esc1", { arbiter: EVALUATOR, outcome: "refund",
    reasonCodes: ["evidence-insufficient"], note: "re-review" });
  assert.equal(rec.state, "ruled");
  // The adapter drove machine.reject: the raw machine state is slashed,
  // while the dispute view reports the ruling.
  assert.equal(api.machine.get("esc1").state, "slashed");
  assert.equal(api.escrows.get("esc1").state, "resolved");
  assert.equal(api.escrows.get("esc1").disputeOutcome, "refund");
});

test("adapter: a panel overturn never rewrites the machine — the directive rules", () => {
  const api = setup({ arbiterOf: record => record.evaluator });
  inEvaluation(api);
  api.ed.openDispute("esc1", { by: PAYER, bond: 25, reason: "verdict too harsh" });
  api.ed.ruleDispute("esc1", { arbiter: EVALUATOR, outcome: "refund",
    reasonCodes: ["evidence-insufficient"], note: "re-review" });
  api.ed.appealDispute("esc1", { by: PAYEE, bond: 50, panel: PANEL });
  const fin = api.ed.ruleAppeal("esc1", {
    votes: PANEL.map(lane => ({ lane, outcome: "release" })),
    reasonCodes: ["criterion-unmet"],
  });
  assert.equal(fin.finalOutcome, "release");
  assert.equal(fin.overturned, true);
  // Machine still reads slashed; the settlement layer honors finalOutcome.
  assert.equal(api.machine.get("esc1").state, "slashed");
  assert.equal(api.escrows.get("esc1").disputeOutcome, "refund");
});
