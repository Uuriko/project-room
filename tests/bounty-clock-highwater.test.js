// CURE-CLOCK-HIGHWATER (deep-dive money-core S4): the escrow clock must
// never go backwards for a room, and future-dated flake strikes must not
// bind in the present.
//
// Specimen (C7 i / C8 sample 1, executed at bdc5a04b): a backwards step of
// the injected clock reopens windows the keeper already passed (dispute /
// submit succeed after rewind), journal/event `at` goes non-monotonic in
// seq order, and _flakeStrikes — lower-bound only — counts strikes
// recorded at T0+10d at full weight at T0 (rung-3 claim_cooldown).
//
// Cure: (1) BountyEscrow.nowMs(roomId) clamps to a persisted per-room
// high-water mark (bounty_clock_highwater) plus an in-memory mark;
// (2) _flakeStrikes gains an upper bound (struck_at_ms <= now).
//
// Harness: the tests/bounty-escrow.test.js pattern (in-memory node:sqlite
// store double, SAVEPOINT transactions, mutable injected clock).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-clock";
const JILL = "id:agent/jill";       // poster
const GROK = "id:agent/grokbot";    // worker
const INSTINCT = "id:agent/instinct"; // challenger

const T0 = 1_786_000_000_000;
const DAY = 24 * 3600 * 1000;

function makeWorld(start = T0) {
  const db = new DatabaseSync(":memory:");
  const clock = { t: start };
  const transaction = fn => {
    db.exec("SAVEPOINT hw_test");
    try { const out = fn(); db.exec("RELEASE hw_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO hw_test"); db.exec("RELEASE hw_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => clock.t, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return { escrow, db, clock };
}

const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};
const conserved = escrow => assert.equal(escrow.verifyConservation(ROOM).ok, true);
const postFund = (escrow, clock, { amount = 10, deadlineMs = 2 * DAY } = {}) => {
  const bounty = escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C", amount,
    deadline: new Date(clock.t + deadlineMs).toISOString() }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  return bounty;
};

test("(a2) rewind into an already-keepered challenge window: dispute stays closed, keeper still finalizes", () => {
  const { escrow, clock } = makeWorld();
  const bounty = postFund(escrow, clock);
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "done" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(clock.t).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  const accepted = escrow.getBounty(ROOM, bounty.bountyId);
  // Past the challenge window: dispute is refused (window closed).
  clock.t = accepted.challengeEndsMs + 1000;
  expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: INSTINCT, grounds: "bad work" }), "invalid_state");
  // Rewind to inside the window (C7 i-a1: the dispute opened here pre-cure).
  clock.t = T0 + DAY;
  expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: INSTINCT, grounds: "bad work" }), "invalid_state");
  // The clamped clock is still past the window, so the keeper finalizes.
  const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  assert.equal(fin.bounty.state, "approved");
  conserved(escrow);
});

test("(a2) rewind past a submission deadline: submit stays refused per the clamped clock", () => {
  const { escrow, clock } = makeWorld();
  const bounty = postFund(escrow, clock, { deadlineMs: DAY });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  clock.t = T0 + DAY + 1000; // deadline passed, keeper not run
  expectCode(() => escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "late" } }), "invalid_state");
  clock.t = T0 + 1000; // rewind to before the deadline (C7 i-b: submit succeeded pre-cure)
  expectCode(() => escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "late" } }), "invalid_state");
  conserved(escrow);
});

test("(a1) future-dated flake strikes do not impose claim_cooldown at T0", () => {
  const { escrow, db, clock } = makeWorld();
  // Strike rows exactly as persisted by a future-clock writer at T0+10d
  // (the C7 i-d specimen state), in a room whose high-water mark stands at
  // T0 (the rows predate the guard / arrived from a divergent handle).
  const insert = db.prepare(`INSERT INTO bounty_flakes
    (flake_id, room_id, lane, bounty_id, struck_at_ms, reason, rung) VALUES (?,?,?,?,?,?,?)`);
  for (let i = 0; i < 3; i++)
    insert.run(`flk_future_${i}`, ROOM, GROK, `B-${i}`, T0 + 10 * DAY, "timeout", i + 1);
  const state = escrow._flakeState(ROOM, GROK);
  assert.equal(state.strikes, 0, "future strikes must not count yet");
  assert.equal(state.cooldownUntilMs, null);
  // A fresh claim at T0 succeeds (pre-cure it failed claim_cooldown).
  const bounty = postFund(escrow, clock);
  const claimed = escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  assert.equal(claimed.bounty.state, "claimed");
  // Once time actually reaches the strikes, they count again.
  clock.t = T0 + 10 * DAY;
  const later = escrow._flakeState(ROOM, GROK);
  assert.equal(later.strikes, 3);
  assert.equal(later.rung, 3);
  conserved(escrow);
});

test("(a1, end-to-end) strikes recorded at a future clock bind only from the clamped time, never earlier", () => {
  const { escrow, clock } = makeWorld();
  // Three claims at T0+10d that time out at T0+10d+2h (C7 i-d construction).
  clock.t = T0 + 10 * DAY;
  for (let i = 0; i < 3; i++) {
    const bounty = postFund(escrow, clock, { deadlineMs: 3600 * 1000 });
    escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  }
  clock.t = T0 + 10 * DAY + 2 * 3600 * 1000;
  escrow.closeEpoch(ROOM, {});
  assert.equal(escrow._flakeState(ROOM, GROK).strikes, 3);
  // Rewind to T0: the guard evaluates the claim at the high-water mark
  // (T0+10d+2h), where the strikes HAVE happened and the 7d cooldown
  // legitimately runs — it never evaluates at the rewound T0.
  clock.t = T0;
  assert.equal(escrow.nowMs(ROOM), T0 + 10 * DAY + 2 * 3600 * 1000);
  const bounty = postFund(escrow, clock, { deadlineMs: 30 * DAY });
  expectCode(() => escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK }), "claim_cooldown");
  conserved(escrow);
});

test("(b) journal and event `at` stay monotonic in seq order under rewind", () => {
  const { escrow, db, clock } = makeWorld();
  const bounty = postFund(escrow, clock);
  clock.t = T0 + 5000;
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  clock.t = T0 - 60_000; // hard rewind before every stamp so far
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "done" } });
  const journalAts = db.prepare("SELECT at FROM bounty_journal WHERE room_id=? ORDER BY seq").all(ROOM).map(r => r.at);
  const eventAts = db.prepare("SELECT at FROM bounty_events WHERE room_id=? ORDER BY seq").all(ROOM).map(r => r.at);
  for (const ats of [journalAts, eventAts]) {
    assert.ok(ats.length >= 4);
    for (let i = 1; i < ats.length; i++)
      assert.ok(ats[i] >= ats[i - 1], `non-monotonic at: ${ats[i - 1]} -> ${ats[i]}`);
  }
  conserved(escrow);
});

test("(c) fresh room with a normal clock behaves exactly as before, and the mark persists across instances", () => {
  const { escrow, db, clock } = makeWorld();
  const bounty = postFund(escrow, clock);
  assert.equal(bounty.createdAt, new Date(T0).toISOString());
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  clock.t = T0 + 1000;
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "done" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(clock.t).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  const accepted = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(accepted.challengeEndsMs, T0 + 1000 + 3 * DAY, "challenge window stamped from the raw clock, unclamped");
  // The persisted mark holds the max observed, and a new escrow instance
  // over the same database (a restart) still clamps a rewound clock.
  const row = db.prepare("SELECT high_water_ms AS hw FROM bounty_clock_highwater WHERE room_id=?").get(ROOM);
  assert.equal(row.hw, T0 + 1000);
  const transaction = fn => {
    db.exec("SAVEPOINT hw_test2");
    try { const out = fn(); db.exec("RELEASE hw_test2"); return out; }
    catch (error) { db.exec("ROLLBACK TO hw_test2"); db.exec("RELEASE hw_test2"); throw error; }
  };
  const store2 = { db, transaction, readTransaction: transaction };
  const escrow2 = new BountyEscrow(store2, { now: () => T0 - DAY, allowLegacyStringLanes: true });
  assert.equal(escrow2.nowMs(ROOM), T0 + 1000);
  // A different fresh room in the same database is not clamped by ROOM's mark.
  escrow2.ensureGenesis("room-other");
  assert.equal(escrow2.nowMs("room-other"), T0 - DAY);
  conserved(escrow);
});

test("read-only paths never write the mark (cold-isolate discipline)", () => {
  const { escrow, db, clock } = makeWorld();
  postFund(escrow, clock);
  const before = db.prepare("SELECT high_water_ms AS hw FROM bounty_clock_highwater WHERE room_id=?").get(ROOM).hw;
  clock.t = T0 + 999_000;
  db.readOnlyTransaction = true;
  try {
    const bal = escrow.balances(ROOM, JILL); // read path observing a new maximum
    assert.ok(bal.total >= 0);
    assert.equal(escrow.nowMs(ROOM), T0 + 999_000, "in-memory mark still clamps within the instance");
  } finally { db.readOnlyTransaction = false; }
  const after = db.prepare("SELECT high_water_ms AS hw FROM bounty_clock_highwater WHERE room_id=?").get(ROOM).hw;
  assert.equal(after, before, "no persisted write may happen on a read-only path");
});
