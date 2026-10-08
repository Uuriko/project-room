// Adversarial challenge of #1950 (b2-evaluator-seat-slash-race).
//
// #1950 fixed the SEQUENTIAL slash-then-finalize double-count: finalizeVerdict
// now converts only the surviving encumbrance. But every bond mutation in this
// module is read-modify-write, and the module's default store.transaction is
// per-operation (autocommit). Under concurrent writers a stale write must fail
// loudly (seat/write-conflict) instead of silently clobbering the winner —
// otherwise:
//
//   - slash x assignPanel: the assigner resurrects a fully-slashed bond to
//     active with a fresh encumbrance, and the NEXT finalize double-counts
//     the slice (moved > posted) — the exact bug #1950 fixed, reintroduced
//     through a neighboring function;
//   - slash x slash: a partial slash erases a concurrent full slash (units
//     reappear, fraudster back to active);
//   - finalize x finalize: the already-finalized guard fails open and the
//     second call "succeeds", so a retry-after-timeout can double-apply
//     downstream effects.
//
// Deterministic races via the `now` hook: the hook runs the competing
// operation on a second connection at the precise point between the victim's
// read phase and write phase. No threads, no timing luck — the interleave is
// exact. File-backed database shared by all connections; no
// store.transaction is passed, so the module default (autocommit) applies.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEvaluatorSeat,
  EvaluatorSeatError,
} from "../server/evaluator-seat.mjs";

const ROOM = "room-eval-write-conflict";
const EVA = "id:agent/eva";

const scratch = mkdtempSync(join(tmpdir(), "eval-race-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let fileSeq = 0;
function openDb() {
  const db = new DatabaseSync(join(scratch, `race-${process.pid}-${fileSeq++}.db`));
  return db;
}

// One race world: three connections on one file, controllable clock.
// seatA's `now` is a one-shot hook: the first call runs `rival()` on seatB,
// then returns the clock. seatMain is the neutral observer.
function makeWorld() {
  const file = join(scratch, `race-${process.pid}-${fileSeq++}.db`);
  const dbMain = new DatabaseSync(file);
  const dbA = new DatabaseSync(file);
  const dbB = new DatabaseSync(file);
  let nowMs = 1_787_000_000_000;
  const tick = ms => { nowMs += ms; };
  let armed = null;
  const seatMain = createEvaluatorSeat({ db: dbMain }, { now: () => nowMs });
  const seatB = createEvaluatorSeat({ db: dbB }, { now: () => nowMs });
  const seatA = createEvaluatorSeat({ db: dbA }, {
    now: () => {
      if (armed) { const fn = armed; armed = null; fn(); }
      return nowMs;
    },
  });
  return {
    seatMain, seatA, seatB, tick,
    armRival: fn => { armed = fn; },
    close: () => { for (const db of [dbMain, dbA, dbB]) db.close(); },
  };
}

const FULL_SLASH = seatB => bondId => seatB.slashBond(ROOM, bondId, {
  reason: "double-sign",
  proof: { commits: ["a".repeat(64), "b".repeat(64)] },
  decider: "judge-x",
});

function assertWriteConflict(fn) {
  assert.throws(fn, e => e instanceof EvaluatorSeatError && e.code === "seat/write-conflict");
}

function assertConserved(bond) {
  assert.ok(bond.encumberedMillis >= 0, `no negative balances: encumbered went ${bond.encumberedMillis}`);
  const moved = bond.forfeitedMillis + bond.slashedMillis + bond.releasedMillis;
  assert.ok(moved <= bond.postedMillis, `no double-count: ${moved} moved out of ${bond.postedMillis} posted`);
}

test("slash racing assignPanel: the assign fails with seat/write-conflict, no resurrection", () => {
  const w = makeWorld();
  try {
    const bond = w.seatMain.postBond(ROOM, { evaluator: EVA, amountMillis: 5000 });
    w.armRival(() => FULL_SLASH(w.seatB)(bond.bondId));
    assertWriteConflict(() => w.seatA.assignPanel(ROOM, "job-race-assign", {
      client: "id:agent/client", provider: "id:agent/provider",
      candidates: [EVA], jobValueMillis: 200_000, panelSize: 1,
    }));
    const afterRace = w.seatMain.getBond(ROOM, EVA);
    assert.equal(afterRace.slashedMillis, 5000, "the full slash survives the race");
    assert.equal(afterRace.encumberedMillis, 0);
    assert.equal(afterRace.state, "slashed", "a fully-slashed bond is not resurrected to active");
    assertConserved(afterRace);
    // And the bond is no longer assignable: no phantom encumbrance was created.
    assert.throws(
      () => w.seatMain.assignPanel(ROOM, "job-after", {
        client: "id:agent/client", provider: "id:agent/provider",
        candidates: [EVA], jobValueMillis: 200_000, panelSize: 1,
      }),
      e => e instanceof EvaluatorSeatError && e.code === "seat/insufficient-eligible");
  } finally { w.close(); }
});

test("partial slash racing a full slash: the loser fails with seat/write-conflict, no erasure", () => {
  const w = makeWorld();
  try {
    const bond = w.seatMain.postBond(ROOM, { evaluator: EVA, amountMillis: 5000 });
    w.armRival(() => FULL_SLASH(w.seatB)(bond.bondId));
    assertWriteConflict(() => w.seatA.slashBond(ROOM, bond.bondId, {
      reason: "evidence-fraud", proof: { artifact: "x" }, decider: "judge-y", amountMillis: 2000,
    }));
    const afterRace = w.seatMain.getBond(ROOM, EVA);
    assert.equal(afterRace.slashedMillis, 5000, "the full slash is not clobbered by the partial");
    assert.equal(afterRace.state, "slashed");
    assertConserved(afterRace);
  } finally { w.close(); }
});

test("finalize racing finalize: exactly one wins, the loser sees seat/already-finalized", () => {
  const w = makeWorld();
  try {
    w.seatMain.postBond(ROOM, { evaluator: EVA, amountMillis: 5000 });
    w.seatMain.assignPanel(ROOM, "job-race-finalize", {
      client: "id:agent/client", provider: "id:agent/provider",
      candidates: [EVA], jobValueMillis: 200_000, panelSize: 1,
    });
    w.tick(50 * 3600 * 1000); // past commit + reveal windows
    w.armRival(() => w.seatB.finalizeVerdict(ROOM, "job-race-finalize"));
    assert.throws(
      () => w.seatA.finalizeVerdict(ROOM, "job-race-finalize"),
      e => e instanceof EvaluatorSeatError && e.code === "seat/already-finalized",
      "the racing finalizer must not silently succeed");
    const afterRace = w.seatMain.getBond(ROOM, EVA);
    assert.equal(afterRace.forfeitedMillis, 1000, "the slice is forfeited exactly once");
    assert.equal(afterRace.encumberedMillis, 0);
    assertConserved(afterRace);
    // A clean retry-after-timeout also reports already-finalized, never double-applies.
    assert.throws(
      () => w.seatMain.finalizeVerdict(ROOM, "job-race-finalize"),
      e => e instanceof EvaluatorSeatError && e.code === "seat/already-finalized");
  } finally { w.close(); }
});

test("slash racing finalize: the slash survives, finalize converts only surviving encumbrance", () => {
  const w = makeWorld();
  try {
    const bond = w.seatMain.postBond(ROOM, { evaluator: EVA, amountMillis: 5000 });
    w.seatMain.assignPanel(ROOM, "job-race-slash", {
      client: "id:agent/client", provider: "id:agent/provider",
      candidates: [EVA], jobValueMillis: 200_000, panelSize: 1,
    });
    w.tick(50 * 3600 * 1000);
    w.armRival(() => FULL_SLASH(w.seatB)(bond.bondId));
    const done = w.seatA.finalizeVerdict(ROOM, "job-race-slash");
    assert.equal(done.state, "deadlocked");
    const afterRace = w.seatMain.getBond(ROOM, EVA);
    assert.equal(afterRace.slashedMillis, 5000, "the fraud slash is preserved in full");
    assert.equal(afterRace.state, "slashed", "finalize does not resurrect the slashed bond");
    assertConserved(afterRace);
  } finally { w.close(); }
});
