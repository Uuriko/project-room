// Escrow differ as a repo test (F-32 / C-5): the historical #3726 and
// #3727 divergence shapes, reproduced as failing-then-fixed fixtures.
//
// The 2026-10-15 differential-escrow run (spec-only model vs the real
// machine, ~3,400 ops) found two unambiguous defects:
//   #3726 (D1+D2): a dispute could open on SUBMITTED work, and a
//     "rejected" ruling then vested the award as approved — no
//     acceptance, no attestation, no challenge window ever ran
//     (probe balances: poster 87.5, worker 112.4 on a 10-credit bounty).
//   #3727 (D3): a dispute could open with NO designated verifier — the
//     bond locked, the decider seat stayed empty, and the only exit was
//     the 14-day timeout.
// Both were fixed in the machine (Option A for #3726: disputes open only
// on accepted work; seat-or-refuse for #3727). This test pins the shapes
// so the class cannot silently return:
//
//   - a LEGACY variant of the reference model (the pre-fix shapes,
//     encoded in tests/escrow-stateful-model.mjs behind the
//     legacy3726 / legacy3727 options) is driven through the historical
//     tapes and MUST FAIL the D-1 invariant set — I3 (history:
//     approved/paid requires everAccepted) for #3726, I4 (an open
//     dispute has a seated, independent decider) for #3727 — landing on
//     the historical balances for #3726;
//   - the CURRENT model and the REAL BountyEscrow are driven through
//     the same tapes and must refuse the illegal ops with the filed
//     error codes, stay invariant-clean after every op, and agree on
//     the final snapshot exactly.
//
// The differ that found these was a one-off scratch driver; this file
// is its durable, in-repo form (the stateful harness in
// tests/bounty-escrow-stateful.test.js is the always-on counterpart).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import {
  EscrowModel, LANES, POOL, checkInvariants,
} from "./escrow-stateful-model.mjs";

const ROOM = "room-differ";
const T0 = 1_786_000_000_000;
const DAY = 24 * 3_600_000;
const [JILL, GROK, INSTINCT, CODEX] = LANES;

// Drive a model through a tape of [method, ...args] ops, checking the
// invariant set after every op (with the previous snapshot chained for
// the transition-legality invariant).
function driveModel(model, tape) {
  const outcomes = [];
  const violations = [];
  let prev = null;
  for (const [op, ...args] of tape) {
    outcomes.push(model[op](...args));
    const snap = model.snapshot();
    violations.push(...checkInvariants(snap, prev).map((v) => `${op}: ${v}`));
    prev = snap;
  }
  return { outcomes, violations, snapshot: prev };
}

function makeReal(clock) {
  const db = new DatabaseSync(":memory:");
  const transaction = (fn) => {
    db.exec("SAVEPOINT escrow_differ");
    try { const out = fn(); db.exec("RELEASE escrow_differ"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_differ"); db.exec("RELEASE escrow_differ"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => clock.now, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return escrow;
}

// Drive the real machine through the same tape shape the model takes.
// Ops translate 1:1 onto the module API; the clock is injected.
function driveReal(escrow, clock, tape) {
  const outcomes = [];
  const ids = [];
  const call = (fn) => {
    try { return { ok: true, out: fn() }; }
    catch (error) { return { ok: false, code: error.code ?? `uncoded:${error.message}` }; }
  };
  for (const [op, ...args] of tape) {
    let out;
    switch (op) {
      case "post": {
        const [spec] = args;
        out = call(() => escrow.postBounty(ROOM, {
          poster: spec.poster, title: "T", criteria: "C",
          amount: spec.amountMillis / 1000,
          deadline: new Date(spec.deadlineMs).toISOString(),
          verifierId: spec.verifier, disputeDeciderId: spec.decider,
        }));
        if (out.ok) ids.push(out.out.bounty.bountyId);
        break;
      }
      case "fund": out = call(() => escrow.fundBounty(ROOM, ids[args[0]], { funder: args[1] })); break;
      case "claim": out = call(() => escrow.claimBounty(ROOM, ids[args[0]], { claimant: args[1] })); break;
      case "submit":
        out = call(() => escrow.submitWork(ROOM, ids[args[0]], {
          claimant: args[1],
          evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" },
        }));
        break;
      case "accept":
        out = call(() => escrow.acceptWork(ROOM, ids[args[0]], {
          acceptor: args[1],
          verifierAttestation: {
            at: new Date(clock.now).toISOString(), note: "lgtm",
            citations: [{ criterionId: "c1", verdict: "pass" }],
          },
        }));
        break;
      case "dispute":
        out = call(() => escrow.disputeBounty(ROOM, ids[args[0]], {
          challenger: args[1], bond: args[2] / 1000, grounds: "bad work",
        }));
        break;
      case "decide":
        out = call(() => escrow.decideDispute(ROOM, ids[args[0]], {
          decider: args[1], outcome: args[2], reasonCodes: args[3],
        }));
        break;
      case "tick": clock.now += args[0]; out = { ok: true }; break;
      case "closeEpoch": out = call(() => escrow.closeEpoch(ROOM, {})); break;
      default: throw new Error(`unknown tape op ${op}`);
    }
    outcomes.push(out.ok ? { ok: true } : { ok: false, code: out.code });
  }
  return { outcomes, ids };
}

function realSnapshot(escrow, ids) {
  const toMillis = (credits) => Math.round(credits * 1000);
  const accounts = {};
  for (const lane of [...LANES, POOL]) {
    const b = escrow.balances(ROOM, lane);
    accounts[lane] = {
      payable: toMillis(b.payable), locked: toMillis(b.locked),
      attributed: toMillis(b.attributed), approved: toMillis(b.approved),
    };
  }
  return {
    accounts,
    bounties: ids.map((id) => {
      const v = escrow.getBounty(ROOM, id);
      return {
        state: v.state, claimant: v.claimant,
        everAccepted: v.attestation !== null && v.attestation !== undefined,
      };
    }),
  };
}

function assertSameOutcome(actual, expected, label) {
  assert.equal(actual.ok, expected.ok, `${label}: ok (real ${JSON.stringify(actual)} vs model ${JSON.stringify(expected)})`);
  if (!expected.ok) assert.equal(actual.code, expected.code, `${label}: refusal code`);
}

function assertFinalAgreement(real, modelRun, ids, label) {
  const actual = realSnapshot(real, ids);
  const expected = modelRun.snapshot;
  assert.deepEqual(actual.accounts, expected.accounts, `${label}: final ledger`);
  actual.bounties.forEach((b, i) => {
    assert.equal(b.state, expected.bounties[i].state, `${label}: bounty ${i} state`);
    assert.equal(b.claimant, expected.bounties[i].claimant, `${label}: bounty ${i} claimant`);
    assert.equal(b.everAccepted, expected.bounties[i].everAccepted, `${label}: bounty ${i} everAccepted`);
  });
}

// --- #3726: dispute on submitted work; rejected ruling vests ------------
// The historical tape (differ T15 + probe G4): the poster disputes their
// own bounty's submitted work; a "rejected" ruling settles as a release.
const TAPE_3726 = [
  ["post", { poster: JILL, verifier: INSTINCT, decider: null, amountMillis: 10_000, deadlineMs: T0 + 30 * DAY }],
  ["fund", 0, JILL],
  ["claim", 0, GROK],
  ["submit", 0, GROK],
  ["dispute", 0, JILL, 2_500],
  ["decide", 0, INSTINCT, "rejected", ["evidence-insufficient"]],
  ["closeEpoch"],
  ["closeEpoch"],
];

test("#3726 fixture (pre-fix shape): dispute from submitted vests without acceptance — I3 must fire", () => {
  const legacy = new EscrowModel({ now: T0, legacy3726: true });
  const { outcomes, violations, snapshot } = driveModel(legacy, TAPE_3726);
  // The pre-fix machine admitted both illegal ops…
  assert.equal(outcomes[4].ok, true, "legacy: dispute opens on submitted work");
  assert.equal(outcomes[5].ok, true, "legacy: the rejected ruling settles");
  // …and the history invariant names the crime: paid without acceptance.
  assert.ok(violations.some((v) => v.startsWith("decide: I3") || v.includes("I3")),
    `legacy: expected an I3 violation, got ${JSON.stringify(violations)}`);
  assert.equal(snapshot.bounties[0].state, "paid");
  assert.equal(snapshot.bounties[0].everAccepted, false);
  // The historical probe balances, to the milli (poster 87.5 — the
  // poster-challenger's bond compensated the worker — worker 112.4,
  // pool 0.1 fee).
  assert.equal(snapshot.accounts[JILL].payable, 87_500);
  assert.equal(snapshot.accounts[GROK].payable, 112_400);
  assert.equal(snapshot.accounts[POOL].payable, 100);
});

test("#3726 fixed: the same tape is refused at the dispute edge, model and real agree", () => {
  const current = driveModel(new EscrowModel({ now: T0 }), TAPE_3726);
  assert.deepEqual(current.outcomes[4], { ok: false, code: "invalid_state" },
    "current model: no dispute edge from submitted");
  assert.deepEqual(current.outcomes[5], { ok: false, code: "invalid_state" },
    "current model: with no dispute open, no ruling path exists");
  assert.deepEqual(current.violations, [], "current model: invariant-clean throughout");
  assert.equal(current.snapshot.bounties[0].state, "submitted");
  assert.equal(current.snapshot.accounts[JILL].payable, 90_000, "award still locked with the poster");
  assert.equal(current.snapshot.accounts[GROK].payable, 99_000, "claim bond still locked, nothing vested");

  const clock = { now: T0 };
  const escrow = makeReal(clock);
  const real = driveReal(escrow, clock, TAPE_3726);
  real.outcomes.forEach((out, i) => assertSameOutcome(out, current.outcomes[i], `tape3726 op ${i}`));
  assertFinalAgreement(escrow, current, real.ids, "#3726 fixed");
});

// --- #3727: dispute opens with an empty decider seat --------------------
// The historical tape (differ T12 + F3): no verifier, no dispute
// decider designated at posting; the dispute opened anyway and only the
// 14-day timeout could end it.
const TAPE_3727 = [
  ["post", { poster: JILL, verifier: null, decider: null, amountMillis: 4_000, deadlineMs: T0 + 30 * DAY }],
  ["fund", 0, JILL],
  ["claim", 0, GROK],
  ["submit", 0, GROK],
  ["accept", 0, JILL],
  ["dispute", 0, CODEX, 1_000],
  ["tick", 14 * DAY + 1],
  ["closeEpoch"],
  ["closeEpoch"],
];

test("#3727 fixture (pre-fix shape): dispute opens into an empty seat — I4 must fire", () => {
  const legacy = new EscrowModel({ now: T0, legacy3727: true });
  const { outcomes, violations, snapshot } = driveModel(legacy, TAPE_3727);
  assert.equal(outcomes[5].ok, true, "legacy: dispute opens with no decider designated");
  assert.ok(violations.some((v) => v.includes("I4")),
    `legacy: expected an I4 violation, got ${JSON.stringify(violations)}`);
  // The timeout default eventually releases it; the legacy row's bond
  // comes home to the challenger (never heard, never compensated away).
  assert.equal(snapshot.bounties[0].state, "paid");
  assert.equal(snapshot.accounts[CODEX].payable, 100_000, "legacy: undecidable dispute's bond returned in full");
});

test("#3727 fixed: seat-or-refuse at open, model and real agree", () => {
  const current = driveModel(new EscrowModel({ now: T0 }), TAPE_3727);
  assert.deepEqual(current.outcomes[5], { ok: false, code: "dispute_unavailable" },
    "current model: a dispute that cannot seat a decider is honestly unavailable");
  assert.deepEqual(current.violations, [], "current model: invariant-clean throughout");
  // The bond never locked; the accepted bounty rides its normal path
  // (challenge window passes inside the 14-day tick, epochs pay it).
  assert.equal(current.snapshot.accounts[CODEX].payable, 100_000);
  assert.equal(current.snapshot.bounties[0].state, "paid");
  assert.equal(current.snapshot.bounties[0].everAccepted, true);

  const clock = { now: T0 };
  const escrow = makeReal(clock);
  const real = driveReal(escrow, clock, TAPE_3727);
  real.outcomes.forEach((out, i) => assertSameOutcome(out, current.outcomes[i], `tape3727 op ${i}`));
  assertFinalAgreement(escrow, current, real.ids, "#3727 fixed");
});

// The legitimate dispute path the fixes preserved: from accepted, with
// a seated decider, a rejected ruling vests — and everAccepted is true,
// so the history invariant is satisfied, not bypassed.
test("post-fix dispute path: accepted -> disputed -> rejected ruling vests with everAccepted set", () => {
  const tape = [
    ["post", { poster: JILL, verifier: INSTINCT, decider: null, amountMillis: 10_000, deadlineMs: T0 + 30 * DAY }],
    ["fund", 0, JILL],
    ["claim", 0, GROK],
    ["submit", 0, GROK],
    ["accept", 0, JILL],
    ["dispute", 0, CODEX, 2_500],
    ["decide", 0, INSTINCT, "rejected", ["evidence-insufficient"]],
    ["closeEpoch"],
  ];
  const current = driveModel(new EscrowModel({ now: T0 }), tape);
  assert.ok(current.outcomes.every((o) => o.ok), `every op legal: ${JSON.stringify(current.outcomes)}`);
  assert.deepEqual(current.violations, []);
  assert.equal(current.snapshot.bounties[0].state, "paid");
  assert.equal(current.snapshot.bounties[0].everAccepted, true);
  // Decided release: the challenger's bond compensates the worker.
  assert.equal(current.snapshot.accounts[GROK].payable, 100_000 - 1_000 + 2_500 + 9_900 + 1_000);
  assert.equal(current.snapshot.accounts[CODEX].payable, 100_000 - 2_500);

  const clock = { now: T0 };
  const escrow = makeReal(clock);
  const real = driveReal(escrow, clock, tape);
  real.outcomes.forEach((out, i) => assertSameOutcome(out, current.outcomes[i], `legit tape op ${i}`));
  assertFinalAgreement(escrow, current, real.ids, "post-fix dispute path");
});
