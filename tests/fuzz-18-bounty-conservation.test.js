// tests/fuzz-18-bounty-conservation.test.js — WAVE-400 fuzz worker: bounty
// escrow conservation under hostile random op sequences.
//
// Target: server/bounty-escrow.mjs (post/fund/claim/submit/accept/reject/
// dispute/decide/finalize/closeEpoch/transfer + triage ops). Hand-rolled
// mulberry32 seeded RNG; seed = Number(process.env.FUZZ_SEED ?? 20261008).
//
// Money laws checked:
//   L1 CONSERVATION — sum of all journal amounts is constant across every
//      op (genesis total; every movement is zero-sum double-entry).
//   L2 NO-NEGATIVES — no (account, lot_state) bucket ever goes negative.
//   L3 PAYOUT CAP — per bounty, total paid out (payout + fee, positive legs)
//      never exceeds the funded amount, across partial releases and splits.
//   L4 AWARD NET-ZERO — per bounty, the award-kind journal legs net to zero
//      (a dispute settlement can never pay the same funds to both sides).
//   L5 FULL verifyConservation() passes after every sequence (hash chains,
//      per-state escrow coverage, terminal emptiness).
//   L6 FAILED OPS ARE PURE — a throwing op leaves the journal row count
//      (and therefore every balance) unchanged.
//
// Distinct from tests/bounty-conservation-check.test.js, which covers the
// cron script's CLI contract against hand-built fixtures: this file hammers
// the escrow API itself with generated hostile sequences.
//
// A violation throws with the seed, sequence index, op index, and the full
// op log needed to replay it — that IS the bug report (findings are not
// fixed here, only reported to the parent).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  BountyEscrow,
  bountyEscrowSchema,
  GENESIS_LANES,
  GENESIS_CREDITS,
  MILLIS_PER_CREDIT,
  DISPUTE_BOND_RATIO,
} from "../server/bounty-escrow.mjs";

const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`[fuzz-18] bounty-escrow conservation fuzz seed=${SEED}`);

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(SEED);
const pick = arr => arr[(rng() * arr.length) | 0];
const lane = () => pick(GENESIS_LANES);
const maybeLane = (exclude = []) => {
  const pool = GENESIS_LANES.filter(l => !exclude.includes(l));
  return pool.length ? pick(pool) : lane();
};

const ROOM = "fuzzroom";
const BASE_MS = Date.parse("2026-10-08T00:00:00.000Z");
const DAY = 86_400_000;
const AWARD_KINDS = ["escrow-lock", "attribute", "approve", "payout", "refund", "fee"];

function freshFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(bountyEscrowSchema);
  const t = fn => fn();
  const store = { db, transaction: t, readTransaction: t };
  let nowMs = BASE_MS;
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  const genesisTotal = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS t FROM bounty_journal WHERE kind='genesis'")
    .get().t;
  assert.equal(genesisTotal, GENESIS_LANES.length * GENESIS_CREDITS * MILLIS_PER_CREDIT);
  return {
    db, escrow,
    get nowMs() { return nowMs; },
    advance(ms) { nowMs += ms; },
  };
}

// Hostile amount picker (credits). ~8% of draws are invalid shapes.
function pickAmount() {
  if (rng() < 0.08) {
    return pick([0, -1, -0.5, NaN, Infinity, "10", null, undefined, 0.0005, 1.0005, 1e7, 1_000_001, 0.1 + 0.2]);
  }
  return pick([0.001, 0.002, 0.01, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 99.999, 100]);
}

function bountyInfo(escrow, id) {
  try {
    return escrow.getBounty(ROOM, id);
  } catch {
    return null;
  }
}

// Refresh the cached live state of a tracked bounty.
function refreshBounty(fx, b) {
  const info = bountyInfo(fx.escrow, b.id);
  if (!info) { b.dead = true; return b; }
  return Object.assign(b, {
    state: info.state, poster: info.poster, verifier: info.verifier,
    claimant: info.claimant, amountMillis: info.amountMillis,
    approvalMode: info.approvalMode, rubric: info.rubric,
    challengeEndsMs: info.challengeEndsMs, deadlineMs: info.deadlineMs,
    disputeOpenedMs: info.disputeOpenedMs,
  });
}

function advancePast(fx, ms) {
  if (Number.isFinite(ms) && fx.nowMs < ms) fx.advance(ms - fx.nowMs + 1000);
}

function validEvidence() {
  return { evidenceUrl: "https://x.test/w/" + ((rng() * 1e9) | 0), summary: "did the work " + ((rng() * 1e6) | 0) };
}

function validCitations(b) {
  const criteria = b.rubric?.criteria ?? [{ criterionId: "c1" }];
  return criteria.map(c => ({ criterionId: c.criterionId, verdict: pick(["pass", "fail"]) }));
}

// State-driven op: picks a live bounty and fires an op that is *usually*
// valid for its current state (15% hostile role/arg). Drives deep chains:
// post -> fund -> claim -> submit -> accept -> dispute -> decide,
// plus keeper timeouts and epoch sweeps.
function genValidOp(fx, bounties) {
  const { escrow } = fx;
  const live = bounties.filter(b => !b.dead);
  if (!live.length) return null;
  const b = refreshBounty(fx, pick(live));
  if (b.dead) return null;
  const id = b.id;
  const hostile = rng() < 0.15;
  const mk = (name, args, run, onOk) => ({ name, args: { bountyId: id, ...args }, run, onOk });

  switch (b.state) {
    case "proposed": {
      const r = rng();
      if (r < 0.55) {
        const funder = hostile ? lane() : b.poster;
        return mk("fund", { funder }, () => escrow.fundBounty(ROOM, id, { funder }),
          res => refreshBounty(fx, Object.assign(b, { state: res.bounty.state })));
      }
      if (r < 0.65) { // keeper expiry
        advancePast(fx, b.deadlineMs);
        const args = rng() < 0.5 ? { caller: lane() } : {};
        return mk("finalize", args, () => escrow.finalizeBounty(ROOM, id, args),
          res => { stats.finalize[res.action] = (stats.finalize[res.action] ?? 0) + 1; refreshBounty(fx, b); });
      }
      if (r < 0.75) {
        const decliner = hostile ? lane() : b.poster;
        return mk("decline", { decliner }, () => escrow.declineBounty(ROOM, id, { decliner, reason: "nope " + ((rng() * 1e6) | 0) }));
      }
      if (r < 0.85) {
        const n = 1 + ((rng() * 3) | 0);
        const rubric = Array.from({ length: n }, (_, i) => ({ criterionId: `r${i}_${((rng() * 1e6) | 0)}`, description: `d${i}` }));
        const poster = hostile ? lane() : b.poster;
        return mk("rubric", { poster, nCrit: n }, () => escrow.updateRubric(ROOM, id, { poster, rubric }),
          () => refreshBounty(fx, b));
      }
      const snoozer = hostile ? lane() : b.poster;
      return mk("snooze", { snoozer }, () => escrow.snoozeBounty(ROOM, id, { snoozer, until: new Date(fx.nowMs + DAY).toISOString() }));
    }
    case "funded": {
      const r = rng();
      if (r < 0.7) {
        const claimant = hostile && rng() < 0.5 ? b.poster : maybeLane([b.poster]);
        return mk("claim", { claimant }, () => escrow.claimBounty(ROOM, id, { claimant }));
      }
      advancePast(fx, b.deadlineMs); // keeper timeout-refund
      const args = rng() < 0.5 ? { caller: lane() } : {};
      return mk("finalize", args, () => escrow.finalizeBounty(ROOM, id, args),
        res => { stats.finalize[res.action] = (stats.finalize[res.action] ?? 0) + 1; refreshBounty(fx, b); });
    }
    case "claimed": {
      const r = rng();
      if (r < 0.7) {
        const claimant = hostile ? lane() : b.claimant;
        const evidence = hostile && rng() < 0.5 ? {} : validEvidence();
        return mk("submit", { claimant }, () => escrow.submitWork(ROOM, id, { claimant, evidence }));
      }
      advancePast(fx, b.deadlineMs);
      const args = rng() < 0.5 ? { caller: lane() } : {};
      return mk("finalize", args, () => escrow.finalizeBounty(ROOM, id, args),
        res => { stats.finalize[res.action] = (stats.finalize[res.action] ?? 0) + 1; refreshBounty(fx, b); });
    }
    case "submitted": {
      const r = rng();
      if (r < 0.4) {
        const acceptor = hostile ? lane()
          : b.approvalMode === "agent" ? (b.verifier ?? b.poster) : b.poster;
        const citations = hostile && rng() < 0.5 ? [{ criterionId: "nope", verdict: "pass" }] : validCitations(b);
        return mk("accept", { acceptor },
          () => escrow.acceptWork(ROOM, id, { acceptor, verifierAttestation: { at: new Date(fx.nowMs).toISOString(), citations, note: "ok" } }));
      }
      if (r < 0.55) {
        const rejector = hostile ? lane() : b.poster;
        return mk("reject", { rejector },
          () => escrow.rejectWork(ROOM, id, { rejector, reason: "bad work " + ((rng() * 1e6) | 0) }));
      }
      if (r < 0.75) return genDisputeOp(fx, b, hostile);
      advancePast(fx, b.deadlineMs); // keeper: submitted-but-unverified settles at zero
      const args = rng() < 0.5 ? { caller: lane() } : {};
      return mk("finalize", args, () => escrow.finalizeBounty(ROOM, id, args),
        res => { stats.finalize[res.action] = (stats.finalize[res.action] ?? 0) + 1; refreshBounty(fx, b); });
    }
    case "accepted": {
      if (rng() < 0.5) return genDisputeOp(fx, b, hostile);
      advancePast(fx, b.challengeEndsMs); // keeper auto-approve
      const args = rng() < 0.5 ? { caller: lane() } : {};
      return mk("finalize", args, () => escrow.finalizeBounty(ROOM, id, args),
        res => { stats.finalize[res.action] = (stats.finalize[res.action] ?? 0) + 1; refreshBounty(fx, b); });
    }
    case "disputed": {
      const r = rng();
      if (r < 0.7) {
        const decider = hostile ? lane() : (b.verifier ?? lane());
        const outcome = hostile && rng() < 0.4
          ? pick(["bogus", undefined, "timeout-default"])
          : pick(["upheld", "split", "release"]);
        const args = { decider, outcome, reasonCodes: ["rc1"] };
        return mk("decide", { decider, outcome }, () => escrow.decideDispute(ROOM, id, args),
          res => { stats.decideOk[res.resolution?.kind] = (stats.decideOk[res.resolution?.kind] ?? 0) + 1; refreshBounty(fx, b); });
      }
      advancePast(fx, (b.disputeOpenedMs ?? fx.nowMs) + 14 * DAY + 1000); // 14d timeout-default
      const args = rng() < 0.5 ? { caller: lane() } : {};
      return mk("finalize", args, () => escrow.finalizeBounty(ROOM, id, args),
        res => { stats.finalize[res.action] = (stats.finalize[res.action] ?? 0) + 1; refreshBounty(fx, b); });
    }
    case "approved": {
      const args = rng() < 0.5 ? { caller: lane() } : {};
      return mk("epoch", args, () => escrow.closeEpoch(ROOM, args),
        res => { stats.epochs++; stats.paid += res.summary.paid.length; });
    }
    default: // paid / refunded / cancelled — hostile re-entry attempts
      return genHostileOp(fx, bounties, b);
  }
}

function genDisputeOp(fx, b, hostile) {
  const { escrow } = fx;
  const id = b.id;
  const challenger = hostile ? (rng() < 0.5 ? b.claimant : lane()) : maybeLane([b.claimant].filter(Boolean));
  const bond = !hostile || rng() < 0.5
    ? Math.ceil(b.amountMillis * DISPUTE_BOND_RATIO) / MILLIS_PER_CREDIT
    : pick([Math.floor(b.amountMillis * DISPUTE_BOND_RATIO) / MILLIS_PER_CREDIT, 0, -1]);
  const grounds = hostile && rng() < 0.3 ? "" : "grounds " + ((rng() * 1e6) | 0);
  return { name: "dispute", args: { bountyId: id, challenger, bond },
    run: () => escrow.disputeBounty(ROOM, id, { challenger, bond, grounds }) };
}

// Fully hostile soup: wrong states, wrong roles, invalid shapes, unknown ids.
function genHostileOp(fx, bounties, b = null) {
  const { escrow } = fx;
  const live = bounties.filter(x => !x.dead);
  const id = b ? b.id : (live.length && rng() < 0.9 ? pick(live).id : "ROOM-9999");
  const r = rng();
  if (r < 0.14) return { name: "fund", args: { bountyId: id, funder: lane() }, run: () => escrow.fundBounty(ROOM, id, { funder: lane() }) };
  if (r < 0.26) { const c = lane(); return { name: "claim", args: { bountyId: id, claimant: c }, run: () => escrow.claimBounty(ROOM, id, { claimant: c }) }; }
  if (r < 0.36) { const c = lane(); return { name: "submit", args: { bountyId: id, claimant: c }, run: () => escrow.submitWork(ROOM, id, { claimant: c, evidence: validEvidence() }) }; }
  if (r < 0.46) { const a = lane(); return { name: "accept", args: { bountyId: id, acceptor: a }, run: () => escrow.acceptWork(ROOM, id, { acceptor: a, verifierAttestation: { at: new Date(fx.nowMs).toISOString(), citations: [{ criterionId: "c1", verdict: "pass" }], note: "x" } }) }; }
  if (r < 0.54) { const ch = lane(); return { name: "dispute", args: { bountyId: id, challenger: ch }, run: () => escrow.disputeBounty(ROOM, id, { challenger: ch, bond: 1, grounds: "g" }) }; }
  if (r < 0.62) { const d = lane(); return { name: "decide", args: { bountyId: id, decider: d }, run: () => escrow.decideDispute(ROOM, id, { decider: d, outcome: pick(["upheld", "split", "release"]), reasonCodes: ["rc"] }) }; }
  if (r < 0.70) { const args = rng() < 0.5 ? { caller: lane() } : {}; return { name: "finalize", args: { bountyId: id }, run: () => escrow.finalizeBounty(ROOM, id, args) }; }
  if (r < 0.76) { const args = rng() < 0.5 ? { caller: lane() } : {}; return { name: "epoch", args, run: () => escrow.closeEpoch(ROOM, args) }; }
  if (r < 0.88) {
    const from = lane();
    let to = lane();
    const tr = rng();
    if (tr < 0.1) to = from;
    else if (tr < 0.2) to = "pool";
    else if (tr < 0.3) to = "id:agent/outsider";
    const amount = pickAmount();
    return { name: "transfer", args: { from, to, amount }, run: () => escrow.transfer(ROOM, { from, to, amount }) };
  }
  // triage tail
  const tr = rng();
  const p = lane();
  if (tr < 0.35) return { name: "decline", args: { bountyId: id, decliner: p }, run: () => escrow.declineBounty(ROOM, id, { decliner: p, reason: "x" }) };
  if (tr < 0.6) return { name: "snooze", args: { bountyId: id, snoozer: p }, run: () => escrow.snoozeBounty(ROOM, id, { snoozer: p, until: new Date(fx.nowMs + DAY).toISOString() }) };
  if (tr < 0.8) { const cands = bounties.filter(x => !x.dead && x.id !== id); const c = cands.length ? pick(cands).id : "ROOM-9999"; return { name: "duplicate", args: { bountyId: id, canonicalId: c }, run: () => escrow.duplicateBounty(ROOM, id, { marker: p, canonicalId: c }) }; }
  return { name: "post-hostile", args: { poster: p, amount: pickAmount() },
    run: () => escrow.postBounty(ROOM, { poster: p, title: "T", criteria: "C", amount: pickAmount(), deadline: new Date(fx.nowMs + DAY).toISOString() }) };
}

// Post is always available: seeds the bounty pool.
function genPostOp(fx, bounties) {
  const { escrow } = fx;
  const poster = lane();
  const amount = rng() < 0.9 ? pick([0.001, 0.01, 0.1, 0.5, 1, 2.5, 5, 10, 25, 50, 100]) : pickAmount();
  const verifier = rng() < 0.65 ? maybeLane([poster]) : null;
  const approvalMode = verifier && rng() < 0.4 ? "agent" : "human";
  const args = {
    poster, title: "T" + ((rng() * 1e6) | 0), criteria: "C" + ((rng() * 1e6) | 0),
    amount, deadline: new Date(fx.nowMs + pick([3_600_000, DAY, 7 * DAY])).toISOString(),
    ...(verifier ? { verifierId: verifier } : {}), approvalMode,
  };
  return { name: "post", args: { poster, amount, verifier, approvalMode },
    run: () => escrow.postBounty(ROOM, args),
    onOk: res => bounties.push(refreshBounty(fx, { id: res.bounty.bountyId })) };
}

// Build one random op: ~12% fresh post, ~58% state-driven (deep chains),
// ~30% hostile soup.
function genOp(fx, bounties) {
  const r = rng();
  if (r < 0.12 || !bounties.some(b => !b.dead)) return genPostOp(fx, bounties);
  if (r < 0.70) return genValidOp(fx, bounties) ?? genHostileOp(fx, bounties);
  return genHostileOp(fx, bounties);
}

// --- lightweight per-op invariants -------------------------------------------
function journalCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM bounty_journal").get().n;
}
function globalSum(db) {
  return db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM bounty_journal").get().t;
}
function negativeBucket(db) {
  return db.prepare(`SELECT account_id, lot_state, SUM(amount) AS t FROM bounty_journal
    GROUP BY account_id, lot_state HAVING t < 0 LIMIT 1`).get() ?? null;
}

// --- per-sequence deep invariants --------------------------------------------
function checkSequenceDeep(fx, genesisTotal, seq, log) {
  const { db, escrow } = fx;
  const ctx = `seed=${SEED} seq=${seq}`;
  const fail = (law, detail) => {
    throw new Error(
      `FUZZ-18 CONSERVATION VIOLATION\nlaw: ${law}\n${ctx}\ndetail: ${detail}\n` +
      `op log (replay in order, same seed):\n${JSON.stringify(log, null, 1)}`);
  };
  // L1 + L2, cheap
  const sum = globalSum(db);
  if (sum !== genesisTotal) fail("L1 CONSERVATION", `global sum ${sum} != genesis ${genesisTotal}`);
  const neg = negativeBucket(db);
  if (neg) fail("L2 NO-NEGATIVES", `${neg.account_id}/${neg.lot_state} = ${neg.t}`);
  // L3 payout cap + L4 award net-zero, per bounty
  for (const row of db.prepare("SELECT bounty_id, amount_millis FROM bounty_records").all()) {
    const paidOut = db.prepare(`SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END),0) AS t
      FROM bounty_journal WHERE bounty_id=? AND kind IN ('payout','fee')`).get(row.bounty_id).t;
    if (paidOut > row.amount_millis)
      fail("L3 PAYOUT CAP", `bounty ${row.bounty_id} paid out ${paidOut} > funded ${row.amount_millis}`);
    const net = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM bounty_journal
      WHERE bounty_id=? AND kind IN (${AWARD_KINDS.map(k => `'${k}'`).join(",")})`).get(row.bounty_id).t;
    if (net !== 0)
      fail("L4 AWARD NET-ZERO", `bounty ${row.bounty_id} award legs net to ${net} (money created/destroyed or paid twice)`);
  }
  // L5 full verifier
  const vc = escrow.verifyConservation(ROOM);
  if (!vc.ok) fail("L5 verifyConservation", vc.violations.join(" | "));
}

const SEQUENCES = Number(process.env.FUZZ_SEQUENCES ?? 10_000);

const stats = { decideOk: {}, finalize: {}, epochs: 0, paid: 0 };

test("fuzz-18: random bounty-escrow sequences conserve money", () => {
  let ops = 0, throws = 0;
  const t0 = Date.now();
  for (let seq = 0; seq < SEQUENCES; seq++) {
    const fx = freshFixture();
    const { db, escrow } = fx;
    const genesisTotal = db
      .prepare("SELECT COALESCE(SUM(amount),0) AS t FROM bounty_journal WHERE kind='genesis'").get().t;
    const bounties = [];
    const log = [];
    const nOps = 6 + ((rng() * 14) | 0);
    for (let i = 0; i < nOps; i++) {
      if (rng() < 0.30) fx.advance((rng() * 14 * DAY) | 0); // hostile clock jumps
      const op = genOp(fx, bounties);
      const before = journalCount(db);
      let threw = null;
      try {
        const res = op.run();
        if (op.onOk) op.onOk(res);
      } catch (e) {
        threw = `${e.code ?? e.name}: ${String(e.message).slice(0, 160)}`;
        throws++;
      }
      ops++;
      log.push({ i, op: op.name, args: op.args, threw });
      // L1/L2 after every op
      const sum = globalSum(db);
      if (sum !== genesisTotal) {
        throw new Error(`FUZZ-18 L1 CONSERVATION after op #${i} (${op.name}) seed=${SEED} seq=${seq}: ` +
          `sum=${sum} genesis=${genesisTotal}\nlog:\n${JSON.stringify(log, null, 1)}`);
      }
      const neg = negativeBucket(db);
      if (neg) {
        throw new Error(`FUZZ-18 L2 NO-NEGATIVES after op #${i} (${op.name}) seed=${SEED} seq=${seq}: ` +
          `${neg.account_id}/${neg.lot_state}=${neg.t}\nlog:\n${JSON.stringify(log, null, 1)}`);
      }
      // L6 failed ops must be pure
      if (threw) {
        const after = journalCount(db);
        if (after !== before) {
          throw new Error(`FUZZ-18 L6 FAILED-OP MUTATED JOURNAL after op #${i} (${op.name}) seed=${SEED} seq=${seq}: ` +
            `rows ${before} -> ${after} (threw: ${threw})\nlog:\n${JSON.stringify(log, null, 1)}`);
        }
      }
      if (op.name === "epoch") { /* counted in stats */ }
    }
    checkSequenceDeep(fx, genesisTotal, seq, log);
    db.close();
    if ((seq + 1) % 2000 === 0) console.log(`[fuzz-18] ${seq + 1}/${SEQUENCES} sequences, ${ops} ops, ${throws} throws`);
  }
  console.log(`[fuzz-18] DONE seed=${SEED}: ${SEQUENCES} sequences, ${ops} ops, ${throws} expected throws, ` +
    `${stats.epochs} epochs, ${stats.paid} payouts — zero conservation violations`);
  console.log(`[fuzz-18] path coverage: decide outcomes=${JSON.stringify(stats.decideOk)} finalize actions=${JSON.stringify(stats.finalize)}`);
});
