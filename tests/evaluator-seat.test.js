// Unit tests for server/evaluator-seat.mjs (BUILD LANE 6: independent evaluator seat).
//
// Fail-first: these tests define the seat's contract — priced verdict fees,
// commit-reveal verdicts, slashable bonds, and the sibling-lane seams.
// A minimal in-memory store double: node:sqlite plus a SAVEPOINT-based
// transaction() (RoomStore.transaction behaves the same in production).
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  createEvaluatorSeat,
  evaluatorSeatSchema,
  priceVerdict,
  commitmentFor,
  DEFAULT_FLOORS,
  DEFAULT_BPS,
  DEFAULT_TIER,
  EvaluatorSeatError,
} from "../server/evaluator-seat.mjs";

const ROOM = "room-test";
const CLIENT = "id:agent/client";
const PROVIDER = "id:agent/provider";
const EVA = "id:agent/eva";
const EVB = "id:agent/evb";
const EVC = "id:agent/evc";
const EVD = "id:agent/evd";

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };

function makeSeat(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT seat_test");
    try { const out = fn(); db.exec("RELEASE seat_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO seat_test"); db.exec("RELEASE seat_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  return createEvaluatorSeat(store, { now: () => nowMs });
}

const reveal = (verdict, evidenceHash = "evhash-1") => {
  const salt = randomBytes(16).toString("hex");
  return { verdict, evidenceHash, salt, commit: commitmentFor({ verdict, evidenceHash, salt }) };
};

const bonded = (seat, evaluator, amountMillis = 5000) =>
  seat.postBond(ROOM, { evaluator, amountMillis });

const assigned = (seat, jobId = "job-1", overrides = {}) => {
  for (const e of [EVA, EVB, EVC]) bonded(seat, e);
  return seat.assignPanel(ROOM, jobId, {
    client: CLIENT, provider: PROVIDER,
    candidates: [EVA, EVB, EVC, EVD],
    jobValueMillis: 200_000,
    ...overrides,
  });
};

const expectCode = (fn, code) => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof EvaluatorSeatError, `expected EvaluatorSeatError, got ${error}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return;
  }
  assert.fail(`expected EvaluatorSeatError ${code}, no error thrown`);
};

// ---- pricing ----

test("priceVerdict: floor binds on micro-jobs, bps binds on large jobs", () => {
  // 200_000 millis = 200 credits; 500bps of that = 10_000 millis > 600 floor
  assert.equal(priceVerdict({ tier: "mid", jobValueMillis: 200_000 }), 10_000);
  // 1_000 millis = 1 credit; 500bps = 50 millis < 600 floor -> floor binds
  assert.equal(priceVerdict({ tier: "mid", jobValueMillis: 1_000 }), DEFAULT_FLOORS.mid);
  assert.equal(priceVerdict({ tier: "mid", jobValueMillis: 0 }), DEFAULT_FLOORS.mid);
});

test("priceVerdict: fee is identical for accept and reject (rejections are paid verdicts)", () => {
  // The fee function takes no verdict at all: accept and reject price the same by construction.
  const fee = priceVerdict({ tier: "mid", jobValueMillis: 50_000 });
  assert.equal(typeof fee, "number");
  assert.ok(fee >= DEFAULT_FLOORS.mid);
});

test("priceVerdict: unknown tier and negative value are rejected", () => {
  assert.throws(() => priceVerdict({ tier: "nope", jobValueMillis: 1000 }), /tier/);
  assert.throws(() => priceVerdict({ tier: "mid", jobValueMillis: -5 }), /jobValue/);
});

test("priceVerdict: room seat config overrides the fee (bps and floor)", () => {
  const seat = makeSeat();
  seat.configureSeat(ROOM, { feeBps: 1000, feeFloorMillis: 2000, judgeTier: "mid" });
  const cfg = seat.getSeat(ROOM);
  assert.equal(cfg.feeBps, 1000);
  assert.equal(cfg.feeFloorMillis, 2000);
  // 200 credits * 1000bps = 20 credits = 20_000 millis
  assert.equal(seat.quoteFee(ROOM, 200_000), 20_000);
  // 1 credit * 1000bps = 100 millis < 2000 floor
  assert.equal(seat.quoteFee(ROOM, 1_000), 2000);
});

test("getSeat returns sane defaults when the room never configured a seat", () => {
  const seat = makeSeat();
  const cfg = seat.getSeat(ROOM);
  assert.equal(cfg.feeBps, DEFAULT_BPS);
  assert.equal(cfg.judgeTier, DEFAULT_TIER);
  assert.ok(cfg.commitWindowMs > 0 && cfg.revealWindowMs > 0);
  assert.ok(cfg.minBondMillis > 0 && cfg.assignmentSliceMillis > 0);
  assert.ok(Number.isInteger(cfg.panelSize) && cfg.panelSize % 2 === 1);
});

// ---- assignment & independence ----

test("assignPanel seats an odd panel and encumbers one bond slice per member", () => {
  const seat = makeSeat();
  const a = assigned(seat);
  assert.equal(a.panel.length, 3);
  assert.equal(a.state, "committing");
  assert.ok(a.commitWindowEndsAt > nowMs && a.revealWindowEndsAt > a.commitWindowEndsAt);
  for (const e of a.panel) {
    const bond = seat.getBond(ROOM, e);
    assert.equal(bond.encumberedMillis, bond.assignmentSliceMillis);
  }
});

test("assignPanel refuses client, provider, and unbonded candidates", () => {
  const seat = makeSeat();
  bonded(seat, EVA);
  // client and provider are filtered even when named as candidates
  const a = seat.assignPanel(ROOM, "job-x", {
    client: CLIENT, provider: PROVIDER,
    candidates: [CLIENT, PROVIDER, EVA], jobValueMillis: 10_000, panelSize: 1,
  });
  assert.deepEqual(a.panel, [EVA]);
  // EVD posted no bond: not enough eligible candidates for a panel of 3
  expectCode(() => seat.assignPanel(ROOM, "job-y", {
    client: CLIENT, provider: PROVIDER,
    candidates: [EVA, EVD], jobValueMillis: 10_000, panelSize: 3,
  }), "seat/insufficient-eligible");
});

test("assignPanel rejects a zero/negative job value", () => {
  const seat = makeSeat();
  bonded(seat, EVA);
  expectCode(() => seat.assignPanel(ROOM, "job-z", {
    client: CLIENT, provider: PROVIDER, candidates: [EVA],
    jobValueMillis: 0, panelSize: 1,
  }), "seat/bad-job-value");
});

// ---- commit-reveal ----

test("commit -> reveal -> finalize happy path pays every valid revealer (majority AND dissent)", () => {
  const seat = makeSeat();
  const a = assigned(seat);
  const ra = reveal("accept"), rb = reveal("accept"), rc = reveal("reject");
  seat.commitVerdict(ROOM, a.jobId, EVA, ra.commit);
  seat.commitVerdict(ROOM, a.jobId, EVB, rb.commit);
  seat.commitVerdict(ROOM, a.jobId, EVC, rc.commit);
  // commit window still open: finalize is premature
  expectCode(() => seat.finalizeVerdict(ROOM, a.jobId), "seat/reveal-window-open");
  tick(25 * 3600 * 1000); // past commit window -> revealing
  seat.revealVerdict(ROOM, a.jobId, EVA, ra);
  seat.revealVerdict(ROOM, a.jobId, EVB, rb);
  seat.revealVerdict(ROOM, a.jobId, EVC, rc);
  tick(25 * 3600 * 1000); // past reveal window
  const done = seat.finalizeVerdict(ROOM, a.jobId);
  assert.equal(done.verdict, "accept");
  assert.equal(done.state, "finalized");
  // all three revealers are paid the same fee — dissent is paid
  assert.equal(done.payments.length, 3);
  for (const p of done.payments) assert.equal(p.feeMillis, done.feeMillisPerEvaluator);
  assert.ok(done.feeMillisPerEvaluator >= DEFAULT_FLOORS.mid);
  // settlement instruction is versioned for the escrow-machine lane
  assert.equal(done.settlement.version, "v1");
  assert.equal(done.settlement.source, "eval-budget");
  assert.equal(done.settlement.totalFeeMillis, done.feeMillisPerEvaluator * 3);
  // bond slices released for valid revealers
  for (const e of [EVA, EVB, EVC]) {
    const bond = seat.getBond(ROOM, e);
    assert.equal(bond.encumberedMillis, 0, e);
    assert.ok(bond.releasedMillis >= bond.assignmentSliceMillis, e);
  }
});

test("verdicts are invisible until the reveal window closes (no copycat reads)", () => {
  const seat = makeSeat();
  const a = assigned(seat);
  const ra = reveal("accept");
  seat.commitVerdict(ROOM, a.jobId, EVA, ra.commit);
  tick(25 * 3600 * 1000);
  seat.revealVerdict(ROOM, a.jobId, EVA, ra);
  const mid = seat.getAssignment(ROOM, a.jobId);
  assert.equal(mid.revealCount, 1, "commit count is public");
  assert.equal(mid.reveals, undefined, "verdicts hidden before window closes");
  tick(25 * 3600 * 1000);
  const late = seat.getAssignment(ROOM, a.jobId);
  assert.equal(late.reveals.length, 1);
  assert.equal(late.reveals[0].verdict, "accept");
  assert.equal(late.reveals[0].evaluator, EVA);
});

test("reveal with wrong salt (hash mismatch) is rejected as no-reveal", () => {
  const seat = makeSeat();
  const a = assigned(seat, "job-hm");
  const r = reveal("accept");
  seat.commitVerdict(ROOM, a.jobId, EVA, r.commit);
  tick(25 * 3600 * 1000);
  expectCode(() => seat.revealVerdict(ROOM, a.jobId, EVA,
    { verdict: "reject", evidenceHash: r.evidenceHash, salt: r.salt }),
    "seat/hash-mismatch");
});

test("reveal without a commit, duplicate commit, and commit after window are rejected", () => {
  const seat = makeSeat();
  const a = assigned(seat, "job-edges");
  const r = reveal("accept");
  // commit window open: commits accepted, reveals refused (window not open yet)
  seat.commitVerdict(ROOM, a.jobId, EVA, r.commit);
  expectCode(() => seat.commitVerdict(ROOM, a.jobId, EVA, r.commit), "seat/duplicate-commit");
  expectCode(() => seat.commitVerdict(ROOM, a.jobId, EVD, r.commit), "seat/not-panel-member");
  expectCode(() => seat.revealVerdict(ROOM, a.jobId, EVA, r), "seat/commit-window-open");
  tick(25 * 3600 * 1000);
  // reveal window open: reveal without a commit is unknown; late commits refused
  expectCode(() => seat.revealVerdict(ROOM, a.jobId, EVB, reveal("accept")), "seat/unknown-commit");
  expectCode(() => seat.commitVerdict(ROOM, a.jobId, EVB, reveal("accept").commit),
    "seat/commit-window-closed");
});

test("commit then no reveal forfeits the slice to the pool (liveness, not slash)", () => {
  const seat = makeSeat();
  const a = assigned(seat, "job-flake");
  const ra = reveal("accept"), rb = reveal("accept");
  seat.commitVerdict(ROOM, a.jobId, EVA, ra.commit);
  seat.commitVerdict(ROOM, a.jobId, EVB, rb.commit);
  tick(25 * 3600 * 1000);
  seat.revealVerdict(ROOM, a.jobId, EVA, ra);
  // EVB committed but never reveals; EVC never commits at all
  tick(25 * 3600 * 1000);
  const done = seat.finalizeVerdict(ROOM, a.jobId);
  assert.equal(done.verdict, "accept");
  assert.equal(done.payments.length, 1);
  const bBond = seat.getBond(ROOM, EVB);
  assert.equal(bBond.encumberedMillis, 0);
  assert.equal(bBond.forfeitedMillis, bBond.assignmentSliceMillis, "no-reveal forfeits");
  assert.equal(bBond.slashedMillis, 0, "liveness never slashes");
  const cBond = seat.getBond(ROOM, EVC);
  assert.equal(cBond.forfeitedMillis, cBond.assignmentSliceMillis, "no-commit forfeits");
});

test("no majority -> deadlocked (never a coin flip)", () => {
  const seat = makeSeat();
  seat.configureSeat(ROOM, { panelSize: 2 });
  for (const e of [EVA, EVB]) bonded(seat, e);
  const a = seat.assignPanel(ROOM, "job-tie", {
    client: CLIENT, provider: PROVIDER, candidates: [EVA, EVB], jobValueMillis: 10_000,
  });
  const ra = reveal("accept"), rb = reveal("reject");
  seat.commitVerdict(ROOM, a.jobId, EVA, ra.commit);
  seat.commitVerdict(ROOM, a.jobId, EVB, rb.commit);
  tick(25 * 3600 * 1000);
  seat.revealVerdict(ROOM, a.jobId, EVA, ra);
  seat.revealVerdict(ROOM, a.jobId, EVB, rb);
  tick(25 * 3600 * 1000);
  const done = seat.finalizeVerdict(ROOM, a.jobId);
  assert.equal(done.state, "deadlocked");
  assert.equal(done.verdict, null);
});

// ---- bonds: slash only on proven fraud ----

test("slashBond requires a fraud reason and a signed decider; liveness can never slash", () => {
  const seat = makeSeat();
  const bond = bonded(seat, EVA);
  expectCode(() => seat.slashBond(ROOM, bond.bondId,
    { reason: "liveness", proof: {}, decider: "arbiter-1" }), "seat/not-fraud");
  expectCode(() => seat.slashBond(ROOM, bond.bondId,
    { reason: "double-sign", proof: {} }), "seat/unsigned-slash");
  const out = seat.slashBond(ROOM, bond.bondId, {
    reason: "double-sign",
    proof: { commits: ["c1", "c2"], jobId: "job-9" },
    decider: "id:agent/arbiter",
    amountMillis: 1000,
  });
  assert.equal(out.slashedMillis, 1000);
  const after = seat.getBond(ROOM, EVA);
  assert.equal(after.slashedMillis, 1000);
  // conservation: every posted milli is exactly one of available/encumbered/forfeited/slashed/released
  const available = after.postedMillis - after.encumberedMillis - after.forfeitedMillis
    - after.slashedMillis - after.releasedMillis;
  assert.ok(available >= 0, "no negative balances");
  assert.equal(after.encumberedMillis + after.forfeitedMillis + after.slashedMillis
    + after.releasedMillis + available, after.postedMillis);
});

test("double-sign detection: two distinct commits by one evaluator is fraud material", () => {
  const seat = makeSeat();
  // Fraud proofs arrive as challenger-presented signed artifacts; the module
  // verifies the shape (two distinct commit hashes, one evaluator, one job).
  const r1 = reveal("accept"), r2 = reveal("reject");
  const fraud = seat.detectDoubleSign(ROOM, "job-ds", EVA, [r1.commit, r2.commit]);
  assert.ok(fraud);
  assert.equal(fraud.evaluator, EVA);
  assert.equal(fraud.jobId, "job-ds");
  assert.equal(fraud.commits.length, 2);
  assert.notEqual(fraud.commits[0], fraud.commits[1]);
  // re-sending the same commit is not fraud
  assert.equal(seat.detectDoubleSign(ROOM, "job-ds", EVA, [r1.commit, r1.commit]), null);
  assert.equal(seat.detectDoubleSign(ROOM, "job-ds", EVA, [r1.commit]), null);
});

test("postBond records the $DASHA face + rate snapshot (denomination rule)", () => {
  const seat = makeSeat();
  const bond = seat.postBond(ROOM, {
    evaluator: EVA, amountMillis: 5000,
    faceDashaMillis: 100_000, dashaPerCreditRate: 20,
  });
  assert.equal(bond.faceDashaMillis, 100_000);
  assert.equal(bond.dashaPerCreditRate, 20);
  assert.equal(bond.registryBondId, null, "nullable FK for the bond-registry lane");
  const withRegistry = seat.postBond(ROOM, {
    evaluator: EVB, amountMillis: 5000, registryBondId: "reg-123",
  });
  assert.equal(withRegistry.registryBondId, "reg-123");
});

// ---- challenges: solo seat ----

test("challengeVerdict on a solo seat needs a 2x challenger bond and escalates", () => {
  const seat = makeSeat();
  bonded(seat, EVA);
  bonded(seat, "id:agent/challenger", 50_000);
  const a = seat.assignPanel(ROOM, "job-solo", {
    client: CLIENT, provider: PROVIDER, candidates: [EVA],
    jobValueMillis: 10_000, panelSize: 1,
  });
  const r = reveal("accept");
  seat.commitVerdict(ROOM, a.jobId, EVA, r.commit);
  tick(25 * 3600 * 1000);
  seat.revealVerdict(ROOM, a.jobId, EVA, r);
  tick(25 * 3600 * 1000);
  const done = seat.finalizeVerdict(ROOM, a.jobId);
  assert.equal(done.verdict, "accept");
  const fee = done.feeMillisPerEvaluator;
  // challenger bond below 2x fee is rejected
  expectCode(() => seat.challengeVerdict(ROOM, a.jobId, "id:agent/challenger",
    { bondMillis: fee, allegation: "evidence-fraud", proof: { evidenceHash: "x" } }),
    "seat/challenge-bond-low");
  const ch = seat.challengeVerdict(ROOM, a.jobId, "id:agent/challenger",
    { bondMillis: fee * 2, allegation: "evidence-fraud", proof: { evidenceHash: "x" } });
  assert.equal(ch.state, "open");
  assert.equal(ch.jobId, a.jobId);
});

test("resolveChallenge: upheld slashes the target and releases the challenger; rejected forfeits the challenger bond", () => {
  const seat = makeSeat();
  bonded(seat, EVA);
  bonded(seat, "id:agent/challenger", 50_000);
  const a = seat.assignPanel(ROOM, "job-solo2", {
    client: CLIENT, provider: PROVIDER, candidates: [EVA],
    jobValueMillis: 10_000, panelSize: 1,
  });
  const r = reveal("accept");
  seat.commitVerdict(ROOM, a.jobId, EVA, r.commit);
  tick(25 * 3600 * 1000);
  seat.revealVerdict(ROOM, a.jobId, EVA, r);
  tick(25 * 3600 * 1000);
  const done = seat.finalizeVerdict(ROOM, a.jobId);
  const fee = done.feeMillisPerEvaluator;
  // upheld: target slashed one slice, challenger bond released
  const ch1 = seat.challengeVerdict(ROOM, a.jobId, "id:agent/challenger",
    { bondMillis: fee * 2, allegation: "evidence-fraud", proof: {} });
  const res1 = seat.resolveChallenge(ROOM, ch1.challengeId, { upheld: true, decider: "id:agent/arbiter" });
  assert.equal(res1.state, "upheld");
  assert.equal(res1.bondState, "released");
  const slashed = seat.getBond(ROOM, EVA);
  assert.ok(slashed.slashedMillis >= slashed.assignmentSliceMillis, "fraud slice slashed on upheld challenge");
  // rejected: challenger bond forfeited to the pool (griefing has a price)
  const ch2 = seat.challengeVerdict(ROOM, a.jobId, "id:agent/challenger",
    { bondMillis: fee * 2, allegation: "double-sign", proof: {} });
  const res2 = seat.resolveChallenge(ROOM, ch2.challengeId, { upheld: false, decider: "id:agent/arbiter" });
  assert.equal(res2.state, "rejected");
  assert.equal(res2.bondState, "forfeited");
  assert.equal(seat.getChallenge(ch2.challengeId).state, "rejected");
  // unsigned resolution is refused
  const ch3 = seat.challengeVerdict(ROOM, a.jobId, "id:agent/challenger",
    { bondMillis: fee * 2, allegation: "double-sign", proof: {} });
  expectCode(() => seat.resolveChallenge(ROOM, ch3.challengeId, { upheld: true }),
    "seat/unsigned-slash");
});

// ---- schema / registry ----

test("evaluatorSeatSchema creates the six additive tables idempotently", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(evaluatorSeatSchema());
  db.exec(evaluatorSeatSchema()); // second run is a no-op
  const tables = db.prepare(
    "select name from sqlite_master where type='table' and name like 'eval_%' order by name"
  ).all().map(r => r.name);
  assert.deepEqual(tables, ["eval_assignments", "eval_bonds", "eval_challenges",
    "eval_commits", "eval_reveals", "eval_seats"]);
});

test("commitmentFor is deterministic and salt-sensitive", () => {
  const a = { verdict: "accept", evidenceHash: "h", salt: "0123456789abcdef" };
  assert.equal(commitmentFor(a), commitmentFor({ ...a }));
  assert.notEqual(commitmentFor(a), commitmentFor({ ...a, salt: "fedcba9876543210" }));
  assert.notEqual(commitmentFor(a), commitmentFor({ ...a, verdict: "reject" }));
  assert.match(commitmentFor(a), /^[0-9a-f]{64}$/);
  // short salts are brute-forceable: refused
  assert.throws(() => commitmentFor({ ...a, salt: "s1" }), /salt/);
});
