// Lane 7 (acp-build-escrow-flow): claim-escrow state machine tests.
//
// Authoring-gate answers (test-audit SKILL.md):
// 1. Contracts: the escrow transition set (unescrowed → bond_locked →
//    work_submitted → in_evaluation → released|slashed|refunded|expired),
//    evaluator-independence (evaluator ≠ claimant, ≠ excluded attesters),
//    bond-snapshot immutability, terminal-state idempotence, and the
//    exactly-once onEscrowSettled packet.
// 2. Credible regressions: approve-before-evaluator-seated, evaluator ==
//    claimant (self-dealing), double settlement callback, bond repricing,
//    transitions out of terminal states.
// 3. Existing coverage gap: bounty-disputes owns the dispute ladder,
//    bounty-escrow owns bounty lots, work-claims owns claim lifecycle —
//    nothing binds claim ↔ bond ↔ independent evaluator ↔ settlement for
//    work claims. This module is the contract owner.
import test from "node:test";
import assert from "node:assert/strict";
import { createClaimEscrows, EscrowError } from "../server/claim-escrow.mjs";

const throwsCode = (fn, code) =>
  assert.throws(fn, error => error instanceof EscrowError && error.code === code);

const BASE = { escrowId: "e1", claimId: "claim-7", claimant: "agent:quill",
  bondUnits: 100, denomination: "dasha-paper", leaseExpiresAt: "2026-10-14T00:00:00.000Z" };

function fresh() { return createClaimEscrows(); }

// Drives an escrow to in_evaluation with an independent evaluator.
function toEvaluation(escrows, id = "e1", evaluator = "agent:instinct") {
  escrows.create({ ...BASE, escrowId: id });
  escrows.lockBond(id, { by: "agent:quill" });
  escrows.submitWork(id, { by: "agent:quill", evidenceHash: `sha256:${"a".repeat(64)}` });
  return escrows.seatEvaluator(id, { evaluator, by: "escrow-keeper" });
}

test("happy path: unescrowed → bond_locked → work_submitted → in_evaluation → released", () => {
  const escrows = fresh();
  const created = escrows.create(BASE);
  assert.equal(created.state, "unescrowed");
  assert.ok(Object.isFrozen(created));
  assert.equal(escrows.lockBond("e1", { by: "agent:quill" }).state, "bond_locked");
  const submitted = escrows.submitWork("e1", { by: "agent:quill", evidenceHash: `sha256:${"b".repeat(64)}` });
  assert.equal(submitted.state, "work_submitted");
  assert.equal(escrows.seatEvaluator("e1", { evaluator: "agent:instinct", by: "escrow-keeper" }).state, "in_evaluation");
  const released = escrows.approve("e1", { by: "agent:instinct", reasonCodes: ["criteria-met"] });
  assert.equal(released.state, "released");
  assert.equal(released.verdict.outcome, "approve");
  assert.deepEqual(released.verdict.reasonCodes, ["criteria-met"]);
});

test("reject path: in_evaluation → slashed, bond snapshot preserved", () => {
  const escrows = fresh();
  toEvaluation(escrows);
  const slashed = escrows.reject("e1", { by: "agent:instinct", reasonCodes: ["criteria-unmet"] });
  assert.equal(slashed.state, "slashed");
  assert.equal(slashed.bondSnapshot, 100); // never repriced
  assert.equal(slashed.verdict.outcome, "reject");
});

test("withdraw before submit refunds; withdraw after submit is illegal", () => {
  const escrows = fresh();
  escrows.create(BASE);
  escrows.lockBond("e1", { by: "agent:quill" });
  assert.equal(escrows.withdraw("e1", { by: "agent:quill" }).state, "refunded");
  throwsCode(() => escrows.withdraw("e1", { by: "agent:quill" }), "invalid_transition"); // terminal
  const escrows2 = fresh();
  escrows2.create({ ...BASE, escrowId: "e2" });
  escrows2.lockBond("e2", { by: "agent:quill" });
  escrows2.submitWork("e2", { by: "agent:quill" });
  throwsCode(() => escrows2.withdraw("e2", { by: "agent:quill" }), "invalid_transition"); // submitted is owed a verdict
});

test("expire refunds from bond_locked and in_evaluation; never from terminal", () => {
  const escrows = fresh();
  escrows.create({ ...BASE, escrowId: "e3" });
  escrows.lockBond("e3", { by: "agent:quill" });
  assert.equal(escrows.expire("e3", { at: "2026-10-15T00:00:00.000Z" }).state, "expired");
  toEvaluation(escrows, "e4");
  assert.equal(escrows.expire("e4", { at: "2026-10-15T00:00:00.000Z" }).state, "expired");
  throwsCode(() => escrows.expire("e3", { at: "2026-10-15T00:00:00.000Z" }), "invalid_transition");
});

test("evaluator independence: claimant and excluded members are refused", () => {
  const escrows = fresh();
  escrows.create(BASE);
  escrows.lockBond("e1", { by: "agent:quill" });
  escrows.submitWork("e1", { by: "agent:quill" });
  throwsCode(() => escrows.seatEvaluator("e1", { evaluator: "agent:quill", by: "escrow-keeper" }), "evaluator_not_independent");
  throwsCode(() => escrows.seatEvaluator("e1",
    { evaluator: "agent:fo", by: "escrow-keeper", excluded: ["agent:fo"] }), "evaluator_not_independent");
  // an attester from the claim round is excludable too
  throwsCode(() => escrows.seatEvaluator("e1",
    { evaluator: "agent:grok", by: "escrow-keeper", excluded: ["agent:grok", "agent:tab"] }), "evaluator_not_independent");
});

test("only the seated evaluator may sign the verdict", () => {
  const escrows = fresh();
  toEvaluation(escrows);
  throwsCode(() => escrows.approve("e1", { by: "agent:quill", reasonCodes: ["criteria-met"] }), "not_evaluator");
  throwsCode(() => escrows.reject("e1", { by: "agent:fo", reasonCodes: ["criteria-unmet"] }), "not_evaluator");
});

test("verdicts require an evaluator: approve/reject from work_submitted is illegal", () => {
  const escrows = fresh();
  escrows.create(BASE);
  escrows.lockBond("e1", { by: "agent:quill" });
  escrows.submitWork("e1", { by: "agent:quill" });
  throwsCode(() => escrows.approve("e1", { by: "agent:instinct", reasonCodes: ["criteria-met"] }), "invalid_transition");
  throwsCode(() => escrows.reject("e1", { by: "agent:instinct", reasonCodes: ["criteria-unmet"] }), "invalid_transition");
});

test("only the claimant may lock, submit, and withdraw", () => {
  const escrows = fresh();
  escrows.create(BASE);
  throwsCode(() => escrows.lockBond("e1", { by: "agent:fo" }), "not_claimant");
  escrows.lockBond("e1", { by: "agent:quill" });
  throwsCode(() => escrows.submitWork("e1", { by: "agent:fo" }), "not_claimant");
  throwsCode(() => escrows.withdraw("e1", { by: "agent:fo" }), "not_claimant");
});

test("bond cannot be locked twice and the snapshot is never repriced", () => {
  const escrows = fresh();
  escrows.create(BASE);
  escrows.lockBond("e1", { by: "agent:quill" });
  throwsCode(() => escrows.lockBond("e1", { by: "agent:quill" }), "invalid_transition");
  const record = escrows.get("e1");
  assert.equal(record.bondSnapshot, 100);
  assert.equal(record.denomination, "dasha-paper");
});

test("onEscrowSettled fires exactly once per escrow with the terminal record", () => {
  const packets = [];
  const escrows = createClaimEscrows({ onEscrowSettled: packet => packets.push(packet) });
  toEvaluation(escrows);
  escrows.approve("e1", { by: "agent:instinct", reasonCodes: ["criteria-met"] });
  assert.equal(packets.length, 1);
  assert.equal(packets[0].escrowId, "e1");
  assert.equal(packets[0].claimId, "claim-7");
  assert.equal(packets[0].terminal, "released");
  assert.equal(packets[0].bondSnapshot, 100);
  assert.ok(Object.isFrozen(packets[0]));
  // terminal states are final: no further transition, no second packet
  throwsCode(() => escrows.approve("e1", { by: "agent:instinct", reasonCodes: ["criteria-met"] }), "invalid_transition");
  assert.equal(packets.length, 1);
});

test("denomination is paper-only: credit or dasha-paper; anything else is refused", () => {
  const escrows = fresh();
  throwsCode(() => escrows.create({ ...BASE, escrowId: "x", denomination: "usdc" }), "invalid_escrow");
  throwsCode(() => escrows.create({ ...BASE, escrowId: "x", denomination: "eth" }), "invalid_escrow");
  assert.equal(escrows.create({ ...BASE, escrowId: "c", denomination: "credit" }).denomination, "credit");
});

test("duplicate escrow ids and unknown ids are refused", () => {
  const escrows = fresh();
  escrows.create(BASE);
  throwsCode(() => escrows.create(BASE), "invalid_escrow");
  throwsCode(() => escrows.get("nope"), "invalid_escrow");
  throwsCode(() => escrows.lockBond("nope", { by: "agent:quill" }), "invalid_escrow");
});
