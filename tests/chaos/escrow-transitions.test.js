// Chaos properties for the bounty escrow state machine (server/bounty-escrow.mjs).
//
// Random fund/release/slash/settle sequences over an in-memory escrow with
// mockable time. After EVERY op — applied or rejected — the invariants hold:
//
//   P3 money conserved:  verifyConservation() is clean and totalIssued is
//        constant (genesis is the one and only mint; every movement is a
//        zero-sum journal pair).
//   P4 no double-release: at most one payout per bounty, and a payout never
//        exceeds the bounty amount.
//   P5 terminal states terminal: paid/refunded/cancelled never change again.
//
// Rejected ops (illegal transitions, insufficient funds, bad decider, ...)
// are EXPECTED in random sequences: the properties must hold for failures
// too. Money-adjacent: this file is fail-first — see the scratch validation
// note in docs/CHAOS.md.
//
// Permanent prevention: runs on every CI pass (smoke) and deeper with
// CHAOS_MODE=full. One-off bug-finding fuzzing is WAVE-400's lane.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  BountyEscrow,
  GENESIS_LANES,
  GENESIS_CREDITS,
  MILLIS_PER_CREDIT,
  DISPUTE_BOND_RATIO,
} from "../../server/bounty-escrow.mjs";
import { runProperty } from "./harness.mjs";

const ROOM = "chaos-room";
const TERMINAL = new Set(["paid", "refunded", "cancelled"]);
const EXPECTED_ISSUED = GENESIS_LANES.length * GENESIS_CREDITS; // 400: the one and only mint
const DISPUTE_OUTCOMES = ["upheld", "rejected", "split", "frivolous"];
const REASON_CODES = ["receipt-incomplete", "criterion-unmet", "evidence-insufficient", "duplicate-work"];

// In-memory store double (same shape as tests/bounty-escrow.test.js):
// node:sqlite plus a SAVEPOINT-based transaction() supporting the nesting
// the escrow relies on.
function buildFixture(seed) {
  const db = new DatabaseSync(":memory:");
  let nowMs = 1_786_000_000_000 + (seed % 100_000);
  const transaction = fn => {
    db.exec("SAVEPOINT chaos_escrow");
    try {
      const out = fn();
      db.exec("RELEASE chaos_escrow");
      return out;
    } catch (error) {
      db.exec("ROLLBACK TO chaos_escrow");
      db.exec("RELEASE chaos_escrow");
      throw error;
    }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return {
    db,
    escrow,
    nowMs: () => nowMs,
    tick: ms => { nowMs += ms; },
    bounties: [], // driver-visible: { bountyId, poster, amountMillis, claimant, verifier, decider, state }
  };
}

const isoAt = fx => new Date(fx.nowMs()).toISOString();
const isoFuture = (fx, ms) => new Date(fx.nowMs() + ms).toISOString();
const otherLane = (rng, lane) => rng.pick(GENESIS_LANES.filter(l => l !== lane));

// Refresh tracked bounty states from the records table (source of truth).
function refreshStates(fx) {
  const rows = fx.db.prepare("SELECT bounty_id, state FROM bounty_records WHERE room_id = ?").all(ROOM);
  const byId = new Map(rows.map(r => [r.bounty_id, r.state]));
  for (const b of fx.bounties) b.state = byId.get(b.bountyId) ?? b.state;
}

const candidates = (fx, states) => {
  refreshStates(fx);
  const inStates = fx.bounties.filter(b => states.includes(b.state));
  return inStates.length > 0 ? inStates : fx.bounties;
};

// --- ops --------------------------------------------------------------------
function opPost(fx, rng) {
  const poster = rng.pick(GENESIS_LANES);
  const amount = rng.int(1, 5); // <= PROBATION_MAX_CLAIM_CREDITS so claims can succeed
  const verifier = otherLane(rng, poster); // seated decider if this bounty is disputed
  const { bounty } = fx.escrow.postBounty(ROOM, {
    poster,
    title: `chaos bounty ${rng.int(1, 999999)}`,
    criteria: "chaos criteria",
    amount,
    deadline: isoFuture(fx, rng.int(1, 7) * 86_400_000),
    verifierId: verifier,
  });
  fx.bounties.push({
    bountyId: bounty.bountyId,
    poster,
    amountMillis: Math.round(amount * MILLIS_PER_CREDIT),
    claimant: null,
    verifier,
    decider: null,
    state: bounty.state,
  });
  return `post ${bounty.bountyId} ${amount}cr by ${poster}`;
}

function opFund(fx, rng) {
  const b = rng.pick(candidates(fx, ["proposed"]));
  fx.escrow.fundBounty(ROOM, b.bountyId, { funder: b.poster });
  return `fund ${b.bountyId}`;
}

function opClaim(fx, rng) {
  const b = rng.pick(candidates(fx, ["funded"]));
  // Claimant must differ from the verifier: the dispute decider has to be
  // independent of the executor, otherwise disputes seat no decider and the
  // decide path stays uncovered.
  const claimant = rng.pick(GENESIS_LANES.filter(l => l !== b.poster && l !== b.verifier));
  fx.escrow.claimBounty(ROOM, b.bountyId, { claimant });
  b.claimant = claimant;
  return `claim ${b.bountyId} by ${claimant}`;
}

function opSubmit(fx, rng) {
  const pool = candidates(fx, ["claimed"]).filter(b => b.claimant);
  const b = rng.pick(pool.length > 0 ? pool : fx.bounties);
  fx.escrow.submitWork(ROOM, b.bountyId, {
    claimant: b.claimant ?? otherLane(rng, b.poster),
    evidence: { evidenceUrl: "https://example.com/chaos/pr", summary: "chaos did the thing" },
  });
  return `submit ${b.bountyId}`;
}

const attestation = fx => ({
  at: isoAt(fx),
  note: "chaos lgtm",
  citations: [{ criterionId: "c1", verdict: "pass" }],
});

function opAccept(fx, rng) {
  const b = rng.pick(candidates(fx, ["submitted"]));
  fx.escrow.acceptWork(ROOM, b.bountyId, { acceptor: b.poster, verifierAttestation: attestation(fx) });
  return `accept ${b.bountyId}`;
}

function opReject(fx, rng) {
  const b = rng.pick(candidates(fx, ["submitted"]));
  fx.escrow.rejectWork(ROOM, b.bountyId, { rejector: b.poster, reason: "chaos reject" });
  return `reject ${b.bountyId}`;
}

function opDispute(fx, rng) {
  const pool = candidates(fx, ["submitted", "accepted"]).filter(b => b.claimant);
  const b = rng.pick(pool.length > 0 ? pool : fx.bounties);
  const challenger = otherLane(rng, b.claimant ?? b.poster);
  const bond = Math.ceil(b.amountMillis * DISPUTE_BOND_RATIO) / MILLIS_PER_CREDIT;
  const res = fx.escrow.disputeBounty(ROOM, b.bountyId, {
    challenger,
    bond,
    grounds: "chaos dispute grounds",
  });
  b.decider = res.dispute?.decider ?? null;
  return `dispute ${b.bountyId} by ${challenger} (decider ${b.decider ?? "none"})`;
}

function opDecide(fx, rng) {
  const pool = candidates(fx, ["disputed"]).filter(b => b.decider);
  const b = rng.pick(pool.length > 0 ? pool : fx.bounties);
  const decider = b.decider ?? b.verifier;
  const outcome = rng.pick(DISPUTE_OUTCOMES);
  const reasonCodes = [rng.pick(REASON_CODES)];
  fx.escrow.decideDispute(ROOM, b.bountyId, { decider, outcome, reasonCodes });
  return `decide ${b.bountyId} -> ${outcome}`;
}

function opFinalize(fx, rng) {
  const b = rng.pick(fx.bounties);
  const res = fx.escrow.finalizeBounty(ROOM, b.bountyId, { caller: rng.pick(GENESIS_LANES) });
  return `finalize ${b.bountyId} -> ${res.action}`;
}

function opEpoch(fx, rng) {
  const res = fx.escrow.closeEpoch(ROOM, { caller: rng.pick(GENESIS_LANES) });
  const s = res.summary;
  return `epoch: approved=${s.approved.length} swept=${s.swept.length} refunded=${s.refunded.length} released=${s.released.length} failed=${s.failed?.length ?? 0}`;
}

function opTransfer(fx, rng) {
  const from = rng.pick(GENESIS_LANES);
  const to = otherLane(rng, from);
  const amount = rng.int(1, 3);
  fx.escrow.transfer(ROOM, { from, to, amount });
  return `transfer ${amount}cr ${from} -> ${to}`;
}

function opTick(fx, rng) {
  const hours = rng.int(1, 480); // up to 20d: crosses challenge windows + dispute timeouts
  fx.tick(hours * 3_600_000);
  return `tick +${hours}h`;
}

// --- invariants ---------------------------------------------------------------
function checkEscrowInvariants(fx) {
  const { escrow, db } = fx;

  // P3: money conserved — the journal is the ledger; the one and only mint
  // is genesis, every movement is a zero-sum pair, terminal bounties hold
  // nothing, and per-account hash chains verify.
  const conservation = escrow.verifyConservation(ROOM);
  assert.equal(conservation.ok, true,
    `conservation violated: ${JSON.stringify(conservation.violations)}`);
  assert.equal(conservation.totalIssued, EXPECTED_ISSUED,
    `total issued ${conservation.totalIssued} != genesis ${EXPECTED_ISSUED}`);

  // P4: no double-release — the award leaves escrow at most once per bounty.
  // One payout movement is TWO journal rows (debit + credit share a lot_id),
  // so count distinct lot_ids, not rows.
  for (const row of db.prepare(
    `SELECT bounty_id, COUNT(DISTINCT lot_id) AS n,
       COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS paid
     FROM bounty_journal WHERE room_id = ? AND kind = 'payout' GROUP BY bounty_id`
  ).all(ROOM)) {
    assert.ok(row.n <= 1, `bounty ${row.bounty_id} paid out ${row.n} times`);
    const bounty = db.prepare("SELECT amount_millis FROM bounty_records WHERE bounty_id = ?").get(row.bounty_id);
    assert.ok(bounty && row.paid <= bounty.amount_millis,
      `bounty ${row.bounty_id} paid ${row.paid} > award ${bounty?.amount_millis}`);
  }

  // P5: terminal states are terminal.
  refreshStates(fx);
  for (const b of fx.bounties) {
    if (b._wasTerminal && b.state !== b._wasTerminal)
      assert.fail(`bounty ${b.bountyId} left terminal state ${b._wasTerminal} -> ${b.state}`);
    if (TERMINAL.has(b.state)) b._wasTerminal = b.state;
  }
}

test("P3/P4/P5: random fund/release/slash/settle sequences conserve money and respect finality", async () => {
  const statesSeen = new Set();
  const terminalSeen = new Set();
  let payoutsSeen = 0;
  let disputesDecided = 0;
  await runProperty({
    name: "escrow-transitions",
    file: "tests/chaos/escrow-transitions.test.js",
    defaultSeeds: { smoke: 25, full: 150 },
    defaultOps: { smoke: 60, full: 150 },
    defaultSeedBase: 0xe5c207,
    build: seed => buildFixture(seed),
    perform: (fx, rng) => {
      if (fx.bounties.length === 0) return opPost(fx, rng);
      const op = rng.weighted([
        [18, "post"], [14, "fund"], [12, "claim"], [10, "submit"],
        [8, "accept"], [5, "reject"], [8, "dispute"], [6, "decide"],
        [6, "finalize"], [6, "epoch"], [8, "transfer"], [5, "tick"],
      ]);
      switch (op) {
        case "post": return opPost(fx, rng);
        case "fund": return opFund(fx, rng);
        case "claim": return opClaim(fx, rng);
        case "submit": return opSubmit(fx, rng);
        case "accept": return opAccept(fx, rng);
        case "reject": return opReject(fx, rng);
        case "dispute": return opDispute(fx, rng);
        case "decide": return opDecide(fx, rng);
        case "finalize": return opFinalize(fx, rng);
        case "epoch": return opEpoch(fx, rng);
        case "transfer": return opTransfer(fx, rng);
        default: return opTick(fx, rng);
      }
    },
    checkInvariants: fx => {
      checkEscrowInvariants(fx);
      for (const b of fx.bounties) {
        statesSeen.add(b.state);
        if (TERMINAL.has(b.state)) terminalSeen.add(b.state);
      }
      // Cheap deep-path counters (small in-memory tables): prove the random
      // walk reaches payouts and decided disputes rather than churning at
      // the intake states. Per-seed fixtures, so keep the max across seeds.
      payoutsSeen = Math.max(payoutsSeen, fx.db.prepare(
        "SELECT COUNT(*) AS n FROM bounty_journal WHERE room_id = ? AND kind = 'payout' AND amount > 0").get(ROOM).n);
      disputesDecided = Math.max(disputesDecided, fx.db.prepare(
        "SELECT COUNT(*) AS n FROM bounty_events WHERE room_id = ? AND type = 'bounty.decided'").get(ROOM).n);
    },
  });
  console.log(`chaos coverage: states seen: ${[...statesSeen].sort().join(", ") || "none"}`);
  console.log(`chaos coverage: terminal states seen: ${[...terminalSeen].sort().join(", ") || "none"}`);
  console.log(`chaos coverage: payouts ${payoutsSeen}, disputes decided ${disputesDecided}`);
});
