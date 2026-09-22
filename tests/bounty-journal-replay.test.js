// Journal-replay determinism (integration-map slice #7: write-master discipline).
//
// The room's architectural claim: bounty-ledger balances are DERIVED from the
// append-only hash-chained `bounty_journal`, never stored. These tests are the
// CI-enforced proof:
//
//   1. A scripted, interleaved bounty-lifecycle scenario runs against a
//      scratch store: fund -> claim -> submit -> accept -> approve -> payout
//      (with the 1% fee), dispute release / split / upheld, timeout refund,
//      expired-unfunded proposal, and plain transfers.
//   2. The journal-derived state is captured as a canonical hash plus the
//      full movement-level receipt set (via the production history() and
//      verifyConservation() read paths).
//   3. The raw journal rows are replayed verbatim into a fresh store —
//      arriving out of order and with duplicate deliveries — and the rebuilt
//      state must be byte-identical: same state hash, same receipt set,
//      conservation still green.
//
// Journal-format audit (2026-09-22): every balance-affecting write flows
// through the single _append() — the only INSERT INTO bounty_journal in the
// codebase. The hash core (prev_hash | entry_id | account | at | kind |
// bounty | lot | amount | lot_state | memo | actor) is fully re-derivable
// from stored columns; the two legs of each zero-sum movement share one
// lot_id; genesis is one row per lane. No write-path change was needed: the
// journal is already a complete write-master for balances, receipt chains,
// and the conservation identity. (Bounty state-machine rows, dispute records,
// and bounty_events are NOT journal-derived — deliberately out of scope; the
// digest covers journal-derived state only.)
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, bountyEscrowSchema } from "../server/bounty-escrow.mjs";

const ROOM = "room-replay";
const JILL = "id:agent/jill";       // poster lane
const GROK = "id:agent/grokbot";    // worker lane
const INSTINCT = "id:agent/instinct"; // verifier / challenger lane
const CODEX = "id:agent/codex";     // worker / challenger lane

let nowMs = 1_787_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();
const EVIDENCE = { evidenceUrl: "https://example.com/work/1", summary: "did the thing" };
const attest = () => ({ at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] });

// Minimal in-memory store double (same SAVEPOINT pattern as
// tests/bounty-escrow.test.js; RoomStore.transaction behaves the same).
function makeStore(db) {
  const transaction = fn => {
    db.exec("SAVEPOINT replay_test");
    try { const out = fn(); db.exec("RELEASE replay_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO replay_test"); db.exec("RELEASE replay_test"); throw error; }
  };
  return { db, transaction, readTransaction: transaction };
}

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const escrow = new BountyEscrow(makeStore(db), { now: () => nowMs });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}

const expectConserved = escrow => {
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};

let titleCounter = 0;
function postFund(escrow, { poster, amount, verifier = null }) {
  const bounty = escrow.postBounty(ROOM, {
    poster, title: `replay work ${++titleCounter}`, criteria: "done right",
    amount, deadline: isoFuture(3_600_000), verifierId: verifier,
  }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: poster });
  return bounty.bountyId;
}

// Phase A: the interleaved lifecycle script. Proposals, funding, claims,
// submissions, acceptances, disputes, and a transfer interleave across six
// bounties — the journal's per-account chains interleave in seq order.
function phaseA(escrow) {
  const b1 = postFund(escrow, { poster: JILL, amount: 10, verifier: INSTINCT });
  const b2 = postFund(escrow, { poster: JILL, amount: 5, verifier: INSTINCT });
  const b3 = postFund(escrow, { poster: JILL, amount: 8, verifier: CODEX });
  escrow.claimBounty(ROOM, b1, { claimant: GROK });
  const b4 = postFund(escrow, { poster: INSTINCT, amount: 4, verifier: CODEX });
  escrow.claimBounty(ROOM, b2, { claimant: CODEX });
  escrow.claimBounty(ROOM, b3, { claimant: GROK });
  escrow.claimBounty(ROOM, b4, { claimant: GROK });
  escrow.submitWork(ROOM, b1, { claimant: GROK, evidence: EVIDENCE });
  escrow.submitWork(ROOM, b4, { claimant: GROK, evidence: EVIDENCE });
  escrow.submitWork(ROOM, b2, { claimant: CODEX, evidence: EVIDENCE });
  escrow.acceptWork(ROOM, b1, { acceptor: JILL, verifierAttestation: attest() });
  escrow.acceptWork(ROOM, b2, { acceptor: JILL, verifierAttestation: attest() });
  // b4: pre-accept dispute, challenge rejected -> award vests (release).
  escrow.disputeBounty(ROOM, b4, { challenger: JILL, bond: 1, grounds: "looks off" });
  escrow.decideDispute(ROOM, b4, { decider: CODEX, outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
  // b5: accept, then post-accept dispute -> split (half vests, half refunds).
  const b5 = postFund(escrow, { poster: JILL, amount: 6, verifier: INSTINCT });
  escrow.claimBounty(ROOM, b5, { claimant: CODEX });
  escrow.submitWork(ROOM, b5, { claimant: CODEX, evidence: EVIDENCE });
  escrow.acceptWork(ROOM, b5, { acceptor: JILL, verifierAttestation: attest() });
  escrow.disputeBounty(ROOM, b5, { challenger: GROK, bond: 1.5, grounds: "partial credit" });
  escrow.decideDispute(ROOM, b5, { decider: INSTINCT, outcome: "split", reasonCodes: ["criterion-unmet"] });
  // b6: dispute upheld -> full refund, challenger bond returned, claim bond
  // slashed to the pool.
  const b6 = postFund(escrow, { poster: JILL, amount: 8, verifier: INSTINCT });
  escrow.claimBounty(ROOM, b6, { claimant: GROK });
  escrow.submitWork(ROOM, b6, { claimant: GROK, evidence: EVIDENCE });
  escrow.disputeBounty(ROOM, b6, { challenger: CODEX, bond: 2, grounds: "plagiarized" });
  escrow.decideDispute(ROOM, b6, { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  // b7: proposed, never funded.
  escrow.postBounty(ROOM, { poster: JILL, title: "replay work 7", criteria: "maybe",
    amount: 2, deadline: isoFuture(3_600_000) });
  // A plain payable -> payable transfer between lanes.
  escrow.transfer(ROOM, { from: GROK, to: CODEX, amount: 1.5 });
  return { b1, b2, b3, b4, b5, b6 };
}

// Phase B: time passes. b3 (claimed, never submitted) times out and refunds;
// the epoch keeper auto-approves b1/b2, sweeps b4/b5 then b1/b2 to paid, and
// expires unfunded b7.
function phaseB(escrow, ids) {
  tick(4 * 24 * 3600 * 1000 + 1); // past 3-day challenge windows and 1h deadlines
  const r3 = escrow.finalizeBounty(ROOM, ids.b3, { caller: INSTINCT });
  assert.equal(r3.action, "refunded");
  escrow.closeEpoch(ROOM, {});
  escrow.closeEpoch(ROOM, {});
}

// --- canonical state digest -------------------------------------------------
// Everything here derives from bounty_journal rows alone: per-account
// balances by lot state, per-account ordered hash chains, the conservation
// vector, and the lot_id-grouped movement set. Two stores with identical
// journal content produce identical digests, byte for byte.
const sha256hex = value => createHash("sha256").update(value, "utf8").digest("hex");
const sortKeys = obj => Object.fromEntries(Object.keys(obj).sort().map(k => [k, obj[k]]));

function stateDigest(db, roomId) {
  const rows = db.prepare("SELECT * FROM bounty_journal WHERE room_id=? ORDER BY seq").all(roomId);
  const balances = {};
  const chains = {};
  const movements = new Map();
  let genesis = 0, total = 0;
  const byState = {};
  for (const r of rows) {
    const bk = `${r.account_id}|${r.lot_state}`;
    balances[bk] = (balances[bk] ?? 0) + r.amount;
    (chains[r.account_id] ??= []).push([r.entry_id, r.prev_hash, r.hash]);
    if (r.kind === "genesis") genesis += r.amount;
    total += r.amount;
    byState[r.lot_state] = (byState[r.lot_state] ?? 0) + r.amount;
    const mk = r.lot_id ?? `entry:${r.entry_id}`;
    if (!movements.has(mk))
      movements.set(mk, { lot: r.lot_id, kind: r.kind, bounty: r.bounty_id, minSeq: r.seq, legs: [] });
    const m = movements.get(mk);
    if (r.seq < m.minSeq) m.minSeq = r.seq;
    m.legs.push({ seq: r.seq, account: r.account_id, lotState: r.lot_state, amount: r.amount,
      at: r.at, memo: r.memo, actorKind: r.actor_kind, actorId: r.actor_id, entry: r.entry_id });
  }
  const movArr = [...movements.values()]
    .sort((a, b) => a.minSeq - b.minSeq)
    .map(m => ({ lot: m.lot, kind: m.kind, bounty: m.bounty,
      legs: m.legs.sort((a, b) => a.seq - b.seq).map(({ seq, ...leg }) => leg) }));
  return sha256hex(JSON.stringify({
    balances: sortKeys(balances), chains: sortKeys(chains),
    genesis, total, byState: sortKeys(byState), movements: movArr,
  }));
}

// --- receipt set ------------------------------------------------------------
// The union of the production history() read path over every account that
// ever touched the journal. Byte-identical serialization means the replayed
// store serves exactly the same receipts.
function receiptSet(escrow, roomId) {
  const accounts = [...new Set(escrow.db.prepare(
    "SELECT account_id AS a FROM bounty_journal WHERE room_id=?").all(roomId).map(r => r.a))].sort();
  const seen = new Map();
  for (const account of accounts)
    for (const r of escrow.history(roomId, account))
      if (!seen.has(r.receiptId)) seen.set(r.receiptId, r);
  return [...seen.values()].sort((a, b) => (a.receiptId < b.receiptId ? -1 : 1));
}

// --- journal import (the replay path under test) ----------------------------
// Rows may arrive in any order and may be delivered more than once. Import
// is idempotent on entry_id; a redelivered row carrying CONFLICTING bytes is
// rejected loudly (tamper-evident), never merged.
const JOURNAL_COLUMNS = ["seq", "room_id", "entry_id", "account_id", "at", "kind",
  "bounty_id", "lot_id", "amount", "lot_state", "prev_hash", "hash", "memo", "actor_kind", "actor_id",
  "track"]; // track joins the journal hash core when present: the replay must carry it.
const canonicalRow = r => JOURNAL_COLUMNS.map(c => r[c] ?? null);

function importJournal(db, roomId, rows) {
  db.exec(bountyEscrowSchema); // idempotent: the replay target starts empty
  const insert = db.prepare(`INSERT INTO bounty_journal (${JOURNAL_COLUMNS.join(", ")})
    VALUES (${JOURNAL_COLUMNS.map(() => "?").join(",")})`);
  const find = db.prepare("SELECT * FROM bounty_journal WHERE entry_id=?");
  let inserted = 0, duplicates = 0;
  for (const r of rows) {
    const existing = find.get(r.entry_id);
    if (existing) {
      duplicates++;
      assert.deepEqual(canonicalRow(existing), canonicalRow(r),
        `duplicate delivery of ${r.entry_id} carries conflicting bytes`);
      continue;
    }
    insert.run(...JOURNAL_COLUMNS.map(c => r[c]));
    inserted++;
  }
  return { inserted, duplicates };
}

// Deterministic shuffle (seeded LCG): the test's own disorder must be
// reproducible, not random.
function shuffled(rows, seed) {
  let s = seed >>> 0;
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000;
  const a = [...rows];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const journalRows = db => db.prepare("SELECT * FROM bounty_journal WHERE room_id=? ORDER BY seq").all(ROOM);

function runFullScenario() {
  const { escrow, db } = makeEscrow();
  const ids = phaseA(escrow);
  phaseB(escrow, ids);
  expectConserved(escrow);
  return { escrow, db, ids };
}

// --- the tests ---------------------------------------------------------------

test("scenario reaches the expected terminal states and conserves at every boundary", () => {
  const { escrow } = makeEscrow();
  const ids = phaseA(escrow);
  expectConserved(escrow);
  phaseB(escrow, ids);
  expectConserved(escrow);
  assert.equal(escrow.getBounty(ROOM, ids.b1).state, "paid");
  assert.equal(escrow.getBounty(ROOM, ids.b2).state, "paid");
  assert.equal(escrow.getBounty(ROOM, ids.b3).state, "refunded"); // timeout
  assert.equal(escrow.getBounty(ROOM, ids.b4).state, "paid");     // dispute released
  assert.equal(escrow.getBounty(ROOM, ids.b5).state, "paid");     // dispute split
  assert.equal(escrow.getBounty(ROOM, ids.b6).state, "refunded"); // dispute upheld
});

test("journal replay from genesis rebuilds byte-identical state", () => {
  const { escrow: escA, db: dbA } = runFullScenario();
  const hashA = stateDigest(dbA, ROOM);
  const receiptsA = JSON.stringify(receiptSet(escA, ROOM));

  const rows = journalRows(dbA);
  assert.ok(rows.length > 50, `scenario too small to be meaningful (${rows.length} rows)`);

  // Disorder the delivery: shuffled order plus duplicate redelivery of a quarter
  // of the rows (seeded, so the disorder itself is deterministic).
  const delivery = shuffled(rows, 42);
  const redelivered = shuffled(rows, 1337).slice(0, Math.floor(rows.length / 4));
  delivery.push(...redelivered);

  const dbB = new DatabaseSync(":memory:");
  const { inserted, duplicates } = importJournal(dbB, ROOM, delivery);
  assert.equal(inserted, rows.length);
  assert.equal(duplicates, redelivered.length);

  const escB = new BountyEscrow(makeStore(dbB), { now: () => nowMs });
  const conservedB = escB.verifyConservation(ROOM);
  assert.equal(conservedB.ok, true,
    `replayed store fails conservation: ${JSON.stringify(conservedB.violations)}`);
  assert.equal(stateDigest(dbB, ROOM), hashA, "replayed state hash differs from the live store");
  assert.equal(JSON.stringify(receiptSet(escB, ROOM)), receiptsA,
    "replayed receipt set differs from the live store");
});

test("double replay is deterministic and idempotent", () => {
  const { db: dbA } = runFullScenario();
  const rows = journalRows(dbA);
  const hashA = stateDigest(dbA, ROOM);

  const replayOnce = seed => {
    const db = new DatabaseSync(":memory:");
    importJournal(db, ROOM, shuffled(rows, seed));
    return db;
  };
  const dbB = replayOnce(7), dbC = replayOnce(99);
  assert.equal(stateDigest(dbB, ROOM), hashA);
  assert.equal(stateDigest(dbC, ROOM), hashA);
  assert.equal(stateDigest(dbB, ROOM), stateDigest(dbC, ROOM));

  // Re-importing the same delivery into an already-replayed store is a no-op.
  const again = importJournal(dbB, ROOM, rows);
  assert.equal(again.inserted, 0);
  assert.equal(again.duplicates, rows.length);
  assert.equal(stateDigest(dbB, ROOM), hashA);
});

test("mid-sequence snapshot + resume rebuilds identical state", () => {
  const { escrow: escA, db: dbA } = makeEscrow();
  const ids = phaseA(escA);
  const snapRows = journalRows(dbA);
  const snapHash = stateDigest(dbA, ROOM);

  phaseB(escA, ids);
  const finalRows = journalRows(dbA);
  const finalHash = stateDigest(dbA, ROOM);
  const finalReceipts = JSON.stringify(receiptSet(escA, ROOM));

  // Snapshot the journal mid-sequence into a fresh store, verify, then resume
  // with only the tail rows.
  const dbS = new DatabaseSync(":memory:");
  importJournal(dbS, ROOM, shuffled(snapRows, 11));
  assert.equal(stateDigest(dbS, ROOM), snapHash, "snapshot state hash differs");

  const tail = finalRows.filter(r => r.seq > snapRows.length);
  assert.ok(tail.length > 0, "phase B must add journal rows");
  importJournal(dbS, ROOM, shuffled(tail, 12));
  assert.equal(stateDigest(dbS, ROOM), finalHash, "resumed state hash differs");

  const escS = new BountyEscrow(makeStore(dbS), { now: () => nowMs });
  const conservedS = escS.verifyConservation(ROOM);
  assert.equal(conservedS.ok, true,
    `resumed store fails conservation: ${JSON.stringify(conservedS.violations)}`);
  assert.equal(JSON.stringify(receiptSet(escS, ROOM)), finalReceipts,
    "resumed receipt set differs");
});

test("duplicate delivery with conflicting bytes is rejected, never merged", () => {
  const { db: dbA } = runFullScenario();
  const rows = journalRows(dbA);
  const dbB = new DatabaseSync(":memory:");
  importJournal(dbB, ROOM, rows);

  const tampered = { ...rows[10], amount: rows[10].amount + 1 };
  assert.throws(() => importJournal(dbB, ROOM, [tampered]), /conflicting bytes/);

  // The rejected tamper leaves the store untouched and still verifying.
  const escB = new BountyEscrow(makeStore(dbB), { now: () => nowMs });
  assert.equal(escB.verifyConservation(ROOM).ok, true);
  assert.equal(stateDigest(dbB, ROOM), stateDigest(dbA, ROOM));
});
