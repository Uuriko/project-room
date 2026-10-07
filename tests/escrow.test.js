// ACP escrow -> evaluator -> release state machine (lane 9, prototype).
// Pure logic: amounts are abstract units; the machine moves nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { createEscrow, EscrowError } from "../server/escrow.mjs";

const throwsCode = (fn, code) =>
  assert.throws(fn, (error) => error instanceof EscrowError && error.code === code);

const PAYER = "agent:alice";
const PAYEE = "agent:bob";
const EVALUATOR = "agent:carol";
const ARBITER = "agent:dave";

const T0 = 1_790_000_000_000; // fixed epoch ms for determinism
const FUND_BY = T0 + 3_600_000;
const EVAL_START_BY = T0 + 7_200_000;
const EVAL_DONE_BY = T0 + 14_400_000;

function machine(now = T0) {
  return createEscrow({ now: () => now });
}

function open(m, overrides = {}) {
  return m.create({
    payer: PAYER,
    payee: PAYEE,
    evaluator: EVALUATOR,
    arbiter: ARBITER,
    amount: 500,
    fundBy: FUND_BY,
    evalStartBy: EVAL_START_BY,
    evalCompleteBy: EVAL_DONE_BY,
    ...overrides,
  });
}

// Runs the funded happy path: created -> funded -> in_evaluation.
function toEvaluating(m, id) {
  m.fund(id, { by: PAYER });
  return m.beginEvaluation(id, { by: EVALUATOR });
}

test("create: proposed state, frozen record, created event logged", () => {
  const m = machine();
  const e = open(m, { id: "e1" });
  assert.equal(e.id, "e1");
  assert.equal(e.state, "proposed");
  assert.equal(e.amount, 500);
  assert.equal(e.payer, PAYER);
  assert.ok(Object.isFrozen(e));
  const log = m.log("e1");
  assert.equal(log.length, 1);
  assert.equal(log[0].event, "created");
  assert.equal(log[0].from, null);
  assert.equal(log[0].to, "proposed");
});

test("create: auto-generated ids are unique", () => {
  const m = machine();
  const a = open(m);
  const b = open(m);
  assert.notEqual(a.id, b.id);
});

test("create rejects malformed input", () => {
  const m = machine();
  throwsCode(() => m.create({ payer: "", payee: PAYEE, evaluator: EVALUATOR, amount: 1 }), "invalid_escrow");
  throwsCode(() => m.create({ payer: PAYER, payee: PAYEE, evaluator: EVALUATOR, amount: 0 }), "invalid_escrow");
  throwsCode(() => m.create({ payer: PAYER, payee: PAYEE, evaluator: EVALUATOR, amount: -5 }), "invalid_escrow");
  throwsCode(() => m.create({ payer: PAYER, payee: PAYEE, evaluator: EVALUATOR, amount: 1.5 }), "invalid_escrow");
  throwsCode(() => m.create({ payer: PAYER, payee: PAYEE, evaluator: EVALUATOR, amount: 1,
    fundBy: T0 - 1, evalStartBy: EVAL_START_BY, evalCompleteBy: EVAL_DONE_BY }), "invalid_escrow");
  throwsCode(() => m.create({ payer: PAYER, payee: PAYEE, evaluator: EVALUATOR, amount: 1,
    fundBy: EVAL_START_BY, evalStartBy: FUND_BY, evalCompleteBy: EVAL_DONE_BY }), "invalid_escrow");
});

test("happy path: proposed -> funded -> in_evaluation -> released", () => {
  const m = machine();
  const e = open(m, { id: "e2" });
  assert.equal(m.fund("e2", { by: PAYER }).state, "funded");
  assert.equal(m.beginEvaluation("e2", { by: EVALUATOR }).state, "in_evaluation");
  const released = m.release("e2", { by: EVALUATOR });
  assert.equal(released.state, "released");
  assert.equal(released.amount, 500); // amount untouched: no money movement
  const log = m.log("e2");
  assert.deepEqual(log.map((x) => x.to), ["proposed", "funded", "in_evaluation", "released"]);
  assert.deepEqual(log.map((x) => x.seq), [0, 1, 2, 3]);
});

test("fund: only the declared payer may fund", () => {
  const m = machine();
  open(m, { id: "e3" });
  throwsCode(() => m.fund("e3", { by: PAYEE }), "unauthorized");
  throwsCode(() => m.fund("e3", { by: EVALUATOR }), "unauthorized");
  assert.equal(m.get("e3").state, "proposed");
});

test("fund: double fund and fund on unknown id rejected", () => {
  const m = machine();
  open(m, { id: "e4" });
  m.fund("e4", { by: PAYER });
  throwsCode(() => m.fund("e4", { by: PAYER }), "invalid_transition");
  throwsCode(() => m.fund("nope", { by: PAYER }), "invalid_escrow");
});

test("beginEvaluation: only evaluator, only from funded", () => {
  const m = machine();
  open(m, { id: "e5" });
  throwsCode(() => m.beginEvaluation("e5", { by: EVALUATOR }), "invalid_transition");
  m.fund("e5", { by: PAYER });
  throwsCode(() => m.beginEvaluation("e5", { by: PAYER }), "unauthorized");
  throwsCode(() => m.beginEvaluation("e5", { by: PAYEE }), "unauthorized");
});

test("release: only evaluator from in_evaluation", () => {
  const m = machine();
  open(m, { id: "e6" });
  m.fund("e6", { by: PAYER });
  throwsCode(() => m.release("e6", { by: EVALUATOR }), "invalid_transition");
  m.beginEvaluation("e6", { by: EVALUATOR });
  throwsCode(() => m.release("e6", { by: PAYER }), "unauthorized");
  throwsCode(() => m.release("e6", { by: PAYEE }), "unauthorized");
  throwsCode(() => m.release("e6", { by: ARBITER }), "unauthorized");
});

test("refund from funded: payer or evaluator may refund", () => {
  const m1 = machine();
  open(m1, { id: "r1" });
  m1.fund("r1", { by: PAYER });
  assert.equal(m1.refund("r1", { by: PAYER, reason: "work never started" }).state, "refunded");

  const m2 = machine();
  open(m2, { id: "r2" });
  m2.fund("r2", { by: PAYER });
  assert.equal(m2.refund("r2", { by: EVALUATOR, reason: "out of scope" }).state, "refunded");
  throwsCode(() => m2.refund("r2", { by: PAYER }), "invalid_transition"); // terminal
});

test("refund from funded: payee and arbiter may not refund", () => {
  const m = machine();
  open(m, { id: "r3" });
  m.fund("r3", { by: PAYER });
  throwsCode(() => m.refund("r3", { by: PAYEE }), "unauthorized");
  throwsCode(() => m.refund("r3", { by: ARBITER }), "unauthorized");
});

test("refund from in_evaluation: evaluator only, fail verdict", () => {
  const m = machine();
  open(m, { id: "r4" });
  toEvaluating(m, "r4");
  throwsCode(() => m.refund("r4", { by: PAYER }), "unauthorized");
  assert.equal(m.refund("r4", { by: EVALUATOR, reason: "criterion unmet" }).state, "refunded");
});

test("refund requires a reason", () => {
  const m = machine();
  open(m, { id: "r5" });
  m.fund("r5", { by: PAYER });
  throwsCode(() => m.refund("r5", { by: PAYER }), "invalid_escrow");
});

test("dispute: from funded or in_evaluation, payer or payee, reason required", () => {
  const m = machine();
  open(m, { id: "d1" });
  m.fund("d1", { by: PAYER });
  throwsCode(() => m.dispute("d1", { by: PAYER }), "invalid_escrow");
  assert.equal(m.dispute("d1", { by: PAYER, reason: "terms changed" }).state, "disputed");

  const m2 = machine();
  open(m2, { id: "d2" });
  toEvaluating(m2, "d2");
  throwsCode(() => m2.dispute("d2", { by: ARBITER, reason: "x" }), "unauthorized");
  assert.equal(m2.dispute("d2", { by: PAYEE, reason: "underpaid" }).state, "disputed");
});

test("dispute: evaluator, arbiter, and outsiders may not raise", () => {
  const m = machine();
  open(m, { id: "d3" });
  m.fund("d3", { by: PAYER });
  throwsCode(() => m.dispute("d3", { by: EVALUATOR, reason: "x" }), "unauthorized");
  throwsCode(() => m.dispute("d3", { by: "agent:stranger", reason: "x" }), "unauthorized");
  // payer is a party, so a well-formed raise from funded succeeds
  assert.equal(m.dispute("d3", { by: PAYER, reason: "work stalled" }).state, "disputed");
});

test("dispute from terminal or disputed state rejected", () => {
  const m = machine();
  open(m, { id: "d4" });
  m.fund("d4", { by: PAYER });
  m.dispute("d4", { by: PAYER, reason: "x" });
  throwsCode(() => m.dispute("d4", { by: PAYEE, reason: "y" }), "invalid_transition");
  m.resolveDispute("d4", { by: ARBITER, outcome: "refund", note: "split decision" });
  throwsCode(() => m.dispute("d4", { by: PAYER, reason: "z" }), "invalid_transition");
});

test("resolveDispute: only arbiter, outcome branches to terminal resolved", () => {
  const m = machine();
  open(m, { id: "d5" });
  toEvaluating(m, "d5");
  m.dispute("d5", { by: PAYEE, reason: "scope drift" });
  throwsCode(() => m.resolveDispute("d5", { by: EVALUATOR, outcome: "release", note: "n" }), "unauthorized");
  throwsCode(() => m.resolveDispute("d5", { by: ARBITER, outcome: "maybe", note: "n" }), "invalid_escrow");
  const r = m.resolveDispute("d5", { by: ARBITER, outcome: "release", note: "work verified" });
  assert.equal(r.state, "resolved");
  assert.equal(r.disputeOutcome, "release");
});

test("resolveDispute refund outcome records refund", () => {
  const m = machine();
  open(m, { id: "d6" });
  toEvaluating(m, "d6");
  m.dispute("d6", { by: PAYER, reason: "abandoned" });
  const r = m.resolveDispute("d6", { by: ARBITER, outcome: "refund", note: "no delivery" });
  assert.equal(r.state, "resolved");
  assert.equal(r.disputeOutcome, "refund");
});

test("terminal states reject all further moves", () => {
  const m = machine();
  open(m, { id: "t1" });
  toEvaluating(m, "t1");
  m.release("t1", { by: EVALUATOR });
  for (const move of [
    () => m.release("t1", { by: EVALUATOR }),
    () => m.refund("t1", { by: EVALUATOR, reason: "x" }),
    () => m.dispute("t1", { by: PAYER, reason: "x" }),
    () => m.resolveDispute("t1", { by: ARBITER, outcome: "release", note: "x" }),
  ]) {
    throwsCode(move, "invalid_transition");
  }
});

test("sweep: proposed past fundBy expires", () => {
  const m = machine();
  open(m, { id: "s1" });
  const res = m.sweep(FUND_BY + 1);
  assert.equal(m.get("s1").state, "expired");
  assert.equal(res.applied.length, 1);
  assert.equal(res.applied[0].to, "expired");
  assert.equal(res.applied[0].actor.kind, "rule");
  assert.deepEqual(res.stuck, []);
});

test("sweep: funded past evalStartBy auto-refunds", () => {
  const m = machine();
  open(m, { id: "s2" });
  m.fund("s2", { by: PAYER });
  const res = m.sweep(EVAL_START_BY + 1);
  assert.equal(m.get("s2").state, "refunded");
  assert.equal(res.applied[0].to, "refunded");
});

test("sweep: stuck in_evaluation is flagged, never auto-decided", () => {
  const m = machine();
  open(m, { id: "s3" });
  toEvaluating(m, "s3");
  const res = m.sweep(EVAL_DONE_BY + 1);
  assert.equal(m.get("s3").state, "in_evaluation");
  assert.deepEqual(res.applied, []);
  assert.equal(res.stuck.length, 1);
  assert.equal(res.stuck[0].id, "s3");
});

test("sweep: healthy escrows untouched; rerun does not duplicate log entries", () => {
  const m = machine();
  open(m, { id: "s4" });
  open(m, { id: "s5" });
  m.sweep(FUND_BY + 1);
  const n = m.log("s5").length;
  assert.equal(m.log("s5")[1].at, FUND_BY + 1); // log carries the sweep time
  m.sweep(FUND_BY + 2);
  assert.equal(m.log("s5").length, n);
  assert.equal(m.get("s4").state, "expired");
  assert.equal(m.get("s5").state, "expired");
});

test("log: every transition records before/after, actor, monotonic seq", () => {
  const m = machine();
  open(m, { id: "l1" });
  toEvaluating(m, "l1");
  m.release("l1", { by: EVALUATOR });
  const log = m.log("l1");
  assert.equal(log[1].from, "proposed");
  assert.equal(log[1].to, "funded");
  assert.equal(log[1].actor.id, PAYER);
  assert.ok(log.every((x, i) => x.seq === i));
  assert.ok(log.every((x) => x.at === T0));
  assert.ok(Object.isFrozen(log));
  assert.ok(log.every((x) => Object.isFrozen(x)));
});

test("get: unknown id throws invalid_escrow; list enumerates all", () => {
  const m = machine();
  throwsCode(() => m.get("missing"), "invalid_escrow");
  open(m, { id: "q1" });
  open(m, { id: "q2" });
  assert.deepEqual(m.list().map((x) => x.id).sort(), ["q1", "q2"]);
});
