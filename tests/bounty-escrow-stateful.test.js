// Stateful property harness for the bounty escrow machine (F-32 / C-5).
//
// fast-check model-based testing (fc.commands / fc.modelRun) against a
// reference model of the POST-#3726 transition table
// (tests/escrow-stateful-model.mjs). Every generated op runs against the
// model and the REAL BountyEscrow (in-memory node:sqlite, injected clock)
// in lockstep; after every op the harness asserts:
//   - outcome agreement (success, or refusal with the same error code);
//   - full snapshot agreement: per-lane lots (payable/locked/attributed/
//     approved, in millis), pool, per-bounty state/claimant/open-dispute
//     seat, and per-lane flake-strike counts;
//   - the D-1 invariant set (tests/escrow-stateful-model.mjs
//     checkInvariants), including the HISTORY invariant: a bounty in
//     approved/paid must have everAccepted set — vesting is gated on an
//     acceptance verdict, which is exactly what pre-#3726 code violated
//     (dispute on submitted work, rejected ruling vesting the award).
//
// This lane changes NO machine semantics: a divergence here is a finding
// to file, never a reason to weaken the model or an invariant.
//
// Determinism: fixed default seed (repo convention, cf.
// tests/claims-state-machine.property.test.js); replay any failure with
//   PROPERTY_TEST_SEED=<seed> node --test tests/bounty-escrow-stateful.test.js
// fast-check also prints the seed + counterexample path on failure, and
// its shrinking reduces a failing tape to a minimal repro.
//
// Generation: purely random tapes almost never complete an ordered
// lifecycle chain, so each lifecycle command targets a bounty that is
// actually in its home state (the generated index picks among the
// candidates); ~10% of commands are "loose" and fire at the raw index
// whatever its state, keeping wrong-state refusal coverage. Actors are
// chosen state-relatively (poster / claimant / seated decider / …)
// weighted toward the legal actor, with wrong-actor, wrong-bond and
// bogus-outcome sprinkling. Clock ticks come from the differ's boundary
// set (deadline, challenge-window, +14d dispute timeout, +7d cooldown,
// +30d strike decay, each ±1ms where the boundary is strict). The test
// ends with a coverage self-check: every bounty state must have been
// reached across the runs, or the harness itself fails — a property
// test that explores nothing is worse than none.
//
// Generator bounds (documented in the model header): amounts
// 1 milli–5 credits (never binds the 5-credit probation claim cap, so
// the reputation projection stays out of scope), <= 6 live bounties.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import {
  EscrowModel, LANES, POOL, OUTCOMES, BOUNTY_STATES, checkInvariants,
} from "./escrow-stateful-model.mjs";

const ROOM = "room-stateful";
const T0 = 1_786_000_000_000;
const seed = Number(process.env.PROPERTY_TEST_SEED ?? 20261018);
const NUM_RUNS = Number(process.env.PROPERTY_TEST_RUNS ?? 100);
const MAX_COMMANDS = 80;
const MAX_BOUNTIES = 6;

const toMillis = (credits) => Math.round(credits * 1000);
const HOUR = 3_600_000, DAY = 24 * HOUR;
const statesReached = new Set();

function makeReal(clock) {
  const db = new DatabaseSync(":memory:");
  const transaction = (fn) => {
    db.exec("SAVEPOINT escrow_stateful");
    try { const out = fn(); db.exec("RELEASE escrow_stateful"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_stateful"); db.exec("RELEASE escrow_stateful"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => clock.now, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return { escrow, ids: [], prev: null };
}

function realSnapshot(r) {
  const accounts = {};
  for (const lane of [...LANES, POOL]) {
    const b = r.escrow.balances(ROOM, lane);
    accounts[lane] = {
      payable: toMillis(b.payable), locked: toMillis(b.locked),
      attributed: toMillis(b.attributed), approved: toMillis(b.approved),
    };
  }
  const bounties = r.ids.map((id) => {
    const v = r.escrow.getBounty(ROOM, id);
    const dispute = v.disputeId ? r.escrow.getDispute(ROOM, v.disputeId) : null;
    return {
      state: v.state, claimant: v.claimant, poster: v.poster,
      // disputeId is never cleared at settlement (it names the resolved
      // record); a dispute is OPEN exactly while the bounty is disputed.
      disputeOpen: v.state === "disputed",
      decider: dispute ? dispute.decider : undefined,
      challenger: dispute ? dispute.raisedBy : undefined,
      // The attestation is the durable acceptance evidence: set by
      // acceptWork, never cleared — the real side's everAccepted.
      everAccepted: v.attestation !== null && v.attestation !== undefined,
    };
  });
  const strikes = Object.fromEntries(LANES.map((lane) => [
    lane, r.escrow.balances(ROOM, lane).flake.strikes,
  ]));
  return { accounts, bounties, strikes };
}

function assertAgreement(m, r, label) {
  const expected = m.snapshot();
  const actual = realSnapshot(r);
  for (const b of actual.bounties) statesReached.add(b.state);
  assert.deepEqual(actual.accounts, expected.accounts, `${label}: ledger lots diverged`);
  assert.equal(actual.bounties.length, expected.bounties.length, `${label}: bounty count diverged`);
  actual.bounties.forEach((b, i) => {
    const e = expected.bounties[i];
    assert.equal(b.state, e.state, `${label}: bounty ${i} state`);
    assert.equal(b.claimant, e.claimant, `${label}: bounty ${i} claimant`);
    assert.equal(b.disputeOpen, e.disputeOpen, `${label}: bounty ${i} disputeOpen`);
    if (e.disputeOpen) {
      assert.equal(b.decider, e.decider, `${label}: bounty ${i} dispute decider`);
      assert.equal(b.challenger, e.challenger, `${label}: bounty ${i} dispute challenger`);
    }
    assert.equal(b.everAccepted, e.everAccepted, `${label}: bounty ${i} everAccepted`);
  });
  assert.deepEqual(actual.strikes, expected.strikes, `${label}: flake strikes diverged`);
  const violations = checkInvariants(actual, r.prev);
  assert.deepEqual(violations, [], `${label}: invariant violations`);
  r.prev = actual;
}

// Resolve a state-relative actor mode against the model's pre-op state
// (model and real agree pre-op by the previous op's snapshot assertion).
function pickLane(m, index, mode, lane) {
  const b = m.bounty(index);
  if (!b) return lane;
  switch (mode) {
    case "poster": return b.poster;
    case "claimant": return b.claimant ?? lane;
    case "nonPoster": return LANES.find((l) => l !== b.poster);
    case "nonClaimant": return LANES.find((l) => l !== b.claimant);
    case "designated": return b.deciderName ?? b.verifier ?? lane;
    case "cleanChallenger": {
      const designated = b.deciderName ?? b.verifier;
      return LANES.find((l) => l !== b.claimant && l !== designated) ?? lane;
    }
    case "seated": return b.dispute?.decider ?? lane;
    case "challenger": return b.dispute?.challenger ?? lane;
    default: return lane; // "random"
  }
}

// One command = one op applied to model and real in lockstep. Model
// first (it is the oracle); a refusal must refuse identically on the
// real side, with the same error code, and move nothing.
class Op {
  constructor(data) { Object.assign(this, data); }
  label() { return this.constructor.name; }
  toString() { return `${this.label()}(${JSON.stringify(this)})`; }
  check() { return true; }
  run(m, r) {
    // Resolve target/actor/bond against the PRE-op model state and
    // cache them: modelCall mutates the model, so resolving again in
    // realCall would aim the real op at a different bounty.
    this.resolve?.(m);
    const expected = this.modelCall(m);
    if (process.env.HARNESS_DEBUG) {
      const key = `${this.label()}:${expected.ok ? "ok" : expected.code}`;
      globalThis.__opCounts = globalThis.__opCounts ?? {};
      globalThis.__opCounts[key] = (globalThis.__opCounts[key] ?? 0) + 1;
    }
    let actual;
    try { actual = { ok: true, out: this.realCall(r) }; }
    catch (error) { actual = { ok: false, code: error.code ?? `uncoded:${error.message}` }; }
    assert.equal(actual.ok, expected.ok,
      `${this}: model=${JSON.stringify(expected)} real=${JSON.stringify(actual)}`);
    if (!expected.ok)
      assert.equal(actual.code, expected.code, `${this}: refusal code`);
    if (expected.ok && expected.action !== undefined)
      assert.equal(actual.out?.action, expected.action, `${this}: keeper action`);
    if (expected.ok) this.afterOk?.(m, r, actual.out);
    assertAgreement(m, r, this.toString());
  }
}

// A lifecycle command: targets one bounty. Loose commands fire at the
// raw generated index; targeted commands select among the bounties in
// their home states (index modulo the candidate count), so a drawn
// command almost always lands inside the lifecycle.
class Targeted extends Op {
  homeStates() { return []; }
  target(m) {
    if (this.loose) return m.bounty(this.index) ? this.index : -1;
    const candidates = [];
    m.bounties.forEach((b, i) => { if (this.homeStates().includes(b.state)) candidates.push(i); });
    if (!candidates.length) return -1;
    return candidates[this.index % candidates.length];
  }
  check(m) { return this.target(m) !== -1; }
  resolve(m) {
    this._target = this.target(m);
    this._actor = pickLane(m, this._target, this.mode, this.lane);
  }
  actor() { return this._actor; }
}

const laneArb = fc.constantFrom(...LANES);
const optLaneArb = fc.constantFrom(null, ...LANES);
const indexArb = fc.integer({ min: 0, max: MAX_BOUNTIES - 1 });
const amountArb = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 1000, max: 5000 }) }, // >= 1cr: 3d challenge window
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 999 }) },     // micro: 24h window
  { weight: 1, arbitrary: fc.constantFrom(0, -1000, 1_000_001_000) },
);
// Weighted mode sets: the legal actor dominates, wrong actors sprinkle.
const actorMode = (legal, ...wrong) => fc.constantFrom(legal, legal, legal, ...wrong);
const looseArb = fc.oneof(
  { weight: 9, arbitrary: fc.constant(false) },
  { weight: 1, arbitrary: fc.constant(true) },
);

class Post extends Op {
  label() { return "post"; }
  check(m) { return m.bounties.length < MAX_BOUNTIES; }
  modelCall(m) {
    return m.post({
      poster: this.poster, verifier: this.verifier, decider: this.decider,
      amountMillis: this.amountMillis, deadlineMs: m.now + this.deadlineInMs,
    });
  }
  realCall(r) {
    return r.escrow.postBounty(ROOM, {
      poster: this.poster, title: "T", criteria: "C",
      amount: this.amountMillis / 1000,
      deadline: new Date(r.clockNow() + this.deadlineInMs).toISOString(),
      verifierId: this.verifier, disputeDeciderId: this.decider,
    });
  }
  afterOk(m, r, out) { r.ids.push(out.bounty.bountyId); }
}

class Fund extends Targeted {
  label() { return "fund"; }
  homeStates() { return ["proposed"]; }
  modelCall(m) { return m.fund(this._target, this.actor()); }
  realCall(r) { return r.escrow.fundBounty(ROOM, r.ids[this._target], { funder: this.actor() }); }
}

class Decline extends Targeted {
  label() { return "decline"; }
  homeStates() { return ["proposed"]; }
  modelCall(m) { return m.decline(this._target, this.actor()); }
  realCall(r) {
    return r.escrow.declineBounty(ROOM, r.ids[this._target],
      { decliner: this.actor(), reason: "not now" });
  }
}

class Claim extends Targeted {
  label() { return "claim"; }
  homeStates() { return ["funded"]; }
  modelCall(m) { return m.claim(this._target, this.actor()); }
  realCall(r) { return r.escrow.claimBounty(ROOM, r.ids[this._target], { claimant: this.actor() }); }
}

class Submit extends Targeted {
  label() { return "submit"; }
  homeStates() { return ["claimed"]; }
  modelCall(m) { return m.submit(this._target, this.actor()); }
  realCall(r) {
    return r.escrow.submitWork(ROOM, r.ids[this._target], {
      claimant: this.actor(),
      evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" },
    });
  }
}

class Accept extends Targeted {
  label() { return "accept"; }
  homeStates() { return ["submitted"]; }
  modelCall(m) { return m.accept(this._target, this.actor()); }
  realCall(r) {
    return r.escrow.acceptWork(ROOM, r.ids[this._target], {
      acceptor: this.actor(),
      verifierAttestation: {
        at: new Date(r.clockNow()).toISOString(), note: "lgtm",
        citations: [{ criterionId: "c1", verdict: "pass" }],
      },
    });
  }
}

class Reject extends Targeted {
  label() { return "reject"; }
  homeStates() { return ["submitted"]; }
  target(m) {
    if (this.loose) return m.bounty(this.index) ? this.index : -1;
    const candidates = [];
    m.bounties.forEach((b, i) => { if (b.state === "submitted" || b.settled) candidates.push(i); });
    if (!candidates.length) return -1;
    return candidates[this.index % candidates.length];
  }
  modelCall(m) { return m.reject(this._target, this.actor()); }
  realCall(r) {
    return r.escrow.rejectWork(ROOM, r.ids[this._target],
      { rejector: this.actor(), reason: "bad work" });
  }
}

class Dispute extends Targeted {
  label() { return process.env.HARNESS_DEBUG ? `dispute${this._wasHome ? ":home" : ":loose"}@${this._targetState ?? "?"}` : "dispute"; }
  homeStates() { return ["accepted"]; }
  target(m) {
    if (!this.loose) return super.target(m);
    // Loose disputes aim at SUBMITTED bounties when one exists: the
    // submitted -> disputed edge is the #3726 shape, and it deserves
    // deliberate pressure, not just uniform-index luck.
    const submitted = [];
    m.bounties.forEach((b, i) => { if (b.state === "submitted") submitted.push(i); });
    if (submitted.length) return submitted[this.index % submitted.length];
    return m.bounty(this.index) ? this.index : -1;
  }
  resolve(m) {
    super.resolve(m);
    this._wasHome = m.bounty(this._target)?.state === "accepted";
    this._targetState = m.bounty(this._target)?.state;
    const b = m.bounty(this._target);
    const required = b ? Math.ceil(b.amountMillis * 0.25) : 0;
    this._bondMillis = { exact: required, zero: 0, double: required * 2, "minus-1": required - 1 }[this.bondKind];
  }
  modelCall(m) { return m.dispute(this._target, this.actor(), this._bondMillis); }
  realCall(r) {
    return r.escrow.disputeBounty(ROOM, r.ids[this._target], {
      challenger: this.actor(), bond: this._bondMillis / 1000, grounds: "bad work",
    });
  }
}

class Decide extends Targeted {
  label() { return "decide"; }
  homeStates() { return ["disputed"]; }
  reasonCodes() { return { valid: ["criterion-unmet"], bogus: ["bogus-code"], empty: [] }[this.reasonsKind]; }
  modelCall(m) { return m.decide(this._target, this.actor(), this.outcome, this.reasonCodes()); }
  realCall(r) {
    return r.escrow.decideDispute(ROOM, r.ids[this._target], {
      decider: this.actor(), outcome: this.outcome, reasonCodes: this.reasonCodes(),
    });
  }
}

class Finalize extends Targeted {
  label() { return "finalize"; }
  homeStates() { return ["proposed", "funded", "claimed", "submitted", "accepted", "disputed", "approved"]; }
  resolve(m) { this._target = this.target(m); }
  modelCall(m) { return m.finalize(this._target); }
  realCall(r) { return r.escrow.finalizeBounty(ROOM, r.ids[this._target], {}); }
}

class CloseEpoch extends Op {
  label() { return "closeEpoch"; }
  modelCall(m) { return m.closeEpoch(); }
  realCall(r) { return r.escrow.closeEpoch(ROOM, {}); }
}

class Transfer extends Op {
  label() { return "transfer"; }
  modelCall(m) { return m.transfer(this.from, this.to, this.amountMillis); }
  realCall(r) { return r.escrow.transfer(ROOM, { from: this.from, to: this.to, amount: this.amountMillis / 1000 }); }
}

class Tick extends Op {
  label() { return "tick"; }
  modelCall(m) { return m.tick(this.ms); }
  realCall(r) { r.advance(this.ms); return null; }
}

// Weighted: small steps dominate so lifecycle chains can complete
// between ticks; the boundary values (±1ms around the deadline, the
// challenge window, +14d, +7d, +30d marks) stay in the set.
const TICKS = [
  0, 1, 60_000, 60_000, 60_000, 60_000, 60_000, HOUR - 1, HOUR, HOUR, HOUR, HOUR, HOUR + 1,
  DAY - 1, DAY, DAY, DAY + 1, 3 * DAY - 1, 3 * DAY, 3 * DAY + 1,
  7 * DAY, 14 * DAY, 14 * DAY + 1, 30 * DAY, 31 * DAY,
];

const postArb = fc.record({
  poster: laneArb, verifier: optLaneArb, decider: optLaneArb,
  amountMillis: amountArb,
  deadlineInMs: fc.constantFrom(DAY, 3 * DAY, 10 * DAY, 10 * DAY, HOUR, -1000, 1000),
}).map((d) => new Post(d));
const fundArb = fc.record({ index: indexArb, loose: looseArb, mode: actorMode("poster", "random"), lane: laneArb }).map((d) => new Fund(d));
const declineArb = fc.record({ index: indexArb, loose: looseArb, mode: actorMode("poster", "random"), lane: laneArb }).map((d) => new Decline(d));
const claimArb = fc.record({ index: indexArb, loose: looseArb, mode: actorMode("nonPoster", "poster", "random"), lane: laneArb }).map((d) => new Claim(d));
const submitArb = fc.record({ index: indexArb, loose: looseArb, mode: actorMode("claimant", "random"), lane: laneArb }).map((d) => new Submit(d));
const acceptArb = fc.record({ index: indexArb, loose: looseArb, mode: actorMode("poster", "claimant", "random"), lane: laneArb }).map((d) => new Accept(d));
const rejectArb = fc.record({ index: indexArb, loose: looseArb, mode: actorMode("poster", "claimant", "random"), lane: laneArb }).map((d) => new Reject(d));
// Disputes run 50% loose: the loose arm aims at submitted bounties
// (the #3726 edge), and that edge deserves sustained pressure in
// every run, not a 10% coin flip.
const looseHalfArb = fc.oneof(
  { weight: 1, arbitrary: fc.constant(false) },
  { weight: 1, arbitrary: fc.constant(true) },
);
const disputeArb = fc.record({
  index: indexArb, loose: looseHalfArb, mode: actorMode("cleanChallenger", "claimant", "designated", "random"), lane: laneArb,
  bondKind: fc.constantFrom("exact", "exact", "exact", "exact", "zero", "double", "minus-1"),
}).map((d) => new Dispute(d));
const decideArb = fc.record({
  index: indexArb, loose: looseArb, mode: actorMode("seated", "challenger", "random"), lane: laneArb,
  outcome: fc.constantFrom(...OUTCOMES, ...OUTCOMES, "bogus-outcome"),
  reasonsKind: fc.constantFrom("valid", "valid", "valid", "bogus", "empty"),
}).map((d) => new Decide(d));
const finalizeArb = fc.record({ index: indexArb, loose: looseArb }).map((d) => new Finalize(d));
const transferArb = fc.record({
  from: laneArb, to: fc.constantFrom(...LANES, POOL), amountMillis: amountArb,
}).map((d) => new Transfer(d));
const tickArb = fc.record({ ms: fc.constantFrom(...TICKS) }).map((d) => new Tick(d));

// Lifecycle ops listed twice: fc.commands draws uniformly over the
// array, so duplication is the weighting that lets chains complete.
// Narrow-check ops (claim/submit/accept/dispute/decide) get extra
// slots: their checks pass rarely, so uniform weighting starves the
// deep lifecycle (accept -> dispute -> decide) that this harness
// exists to explore.
const commandArbs = [
  postArb, postArb, postArb, fundArb, fundArb,
  claimArb, claimArb, claimArb, submitArb, submitArb, submitArb,
  acceptArb, acceptArb, acceptArb, rejectArb,
  disputeArb, disputeArb, disputeArb, disputeArb, decideArb, decideArb, decideArb, decideArb,
  finalizeArb, declineArb, fc.constant(new CloseEpoch({})), fc.constant(new CloseEpoch({})),
  transferArb, tickArb, tickArb,
];

function setup() {
  const clock = { now: T0 };
  const model = new EscrowModel({ now: T0 });
  const real = makeReal(clock);
  real.clockNow = () => clock.now;
  real.advance = (ms) => { clock.now += ms; };
  real.modelRef = model; // actor modes + targets + bonds resolve on the model
  return { model, real };
}

test("escrow machine: stateful model harness (post-#3726 table, history invariants)", () => {
  const commandsArb = fc.commands(commandArbs, { maxCommands: MAX_COMMANDS, size: "max" });
  fc.assert(
    fc.property(commandsArb, (cmds) => { fc.modelRun(setup, cmds); }),
    { seed, numRuns: NUM_RUNS },
  );
  if (process.env.HARNESS_DEBUG) console.log("op outcomes:", globalThis.__opCounts);
  // Coverage self-check: the runs above must have visited every state
  // of the machine except `paid`, or the harness explored nothing and
  // must not pass. `paid` needs an epoch draw landing after an
  // approval — too stochastic to demand of every seed; it is covered
  // deterministically by the scripted tape below instead.
  const expectedStates = BOUNTY_STATES.filter((s) => s !== "paid");
  assert.deepEqual([...statesReached].filter((s) => s !== "paid").sort(), expectedStates.sort(),
    `harness coverage: reached ${[...statesReached].sort().join(",")}`);
});

test("escrow machine: scripted tape reaches paid (epoch sweep after auto-approve)", () => {
  const [JILL, GROK, INSTINCT] = LANES;
  const tape = [
    new Post({ poster: JILL, verifier: INSTINCT, decider: null, amountMillis: 2000, deadlineInMs: 10 * DAY }),
    new Fund({ index: 0, loose: false, mode: "poster", lane: JILL }),
    new Claim({ index: 0, loose: false, mode: "nonPoster", lane: JILL }),
    new Submit({ index: 0, loose: false, mode: "claimant", lane: JILL }),
    new Accept({ index: 0, loose: false, mode: "poster", lane: JILL }),
    new Tick({ ms: 3 * DAY }), // challenge window (3d at >= 1cr) closes
    new CloseEpoch({}),        // keeper auto-approves; not swept this epoch
    new CloseEpoch({}),        // sweep: 99% payout, 1% pool fee, bond home
  ];
  const { model, real } = setup();
  fc.modelRun(() => ({ model, real }), tape);
  const snap = model.snapshot();
  assert.equal(snap.bounties[0].state, "paid");
  assert.equal(snap.accounts[GROK].payable, 101_980); // 99 + 1.98 net + 1 bond back
  assert.equal(snap.accounts[JILL].payable, 98_000);
  assert.equal(snap.accounts[POOL].payable, 20);      // floor(1% of 2000)
});

test("escrow machine: harness setup starts at the genesis snapshot", () => {
  const { model, real } = setup();
  assertAgreement(model, real, "genesis");
  const snap = realSnapshot(real);
  for (const lane of LANES) assert.equal(snap.accounts[lane].payable, 100_000);
  assert.deepEqual(checkInvariants(snap), []);
});
