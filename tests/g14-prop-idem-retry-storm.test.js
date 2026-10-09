// Guild-14 property test: idempotency retry storms via idemExecute.
// Same key + same payload replayed 50x executes once. Same key + different
// payload errors (never returns a stale body). A thunk that throws leaves NO
// idempotency row: retry re-executes; the retry's replay returns the body.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-g14-idem";
const LANE = "id:agent/jill";
let nowMs = 1_786_000_000_000;

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT g14i");
    try { const out = fn(); db.exec("RELEASE g14i"); return out; }
    catch (e) { db.exec("ROLLBACK TO g14i"); db.exec("RELEASE g14i"); throw e; }
  };
  const escrow = new BountyEscrow({ db, transaction, readTransaction: transaction },
    { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}
const scopeFor = (lane, bountyId, payload) => ({ callerLane: lane, bountyId, payload });
const expectCode = (fn, code) => {
  try { fn(); } catch (e) { assert.equal(e.code, code, `expected ${code}, got ${e && e.code}: ${e && e.message}`); return; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};

test("g14-idem: 50 replays with same payload execute exactly once", () => {
  const { escrow } = makeEscrow();
  let executions = 0;
  const thunk = () => { executions++; return { n: executions }; };
  const payload = { op: "claim", id: "b1" };
  const first = escrow.idemExecute(ROOM, "k1", "claim", 200, thunk, scopeFor(LANE, "b1", payload));
  assert.equal(first.replayed, false);
  for (let i = 0; i < 50; i++) {
    const r = escrow.idemExecute(ROOM, "k1", "claim", 200, thunk, scopeFor(LANE, "b1", payload));
    assert.equal(r.replayed, true);
    assert.deepEqual(r.body, { n: 1 });
  }
  assert.equal(executions, 1);
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true);
});

test("g14-idem: same key with different payload is rejected, never replays", () => {
  const { escrow } = makeEscrow();
  let executions = 0;
  const scope = p => scopeFor(LANE, "b1", p);
  escrow.idemExecute(ROOM, "k2", "claim", 200, () => { executions++; return { n: executions }; }, scope({ a: 1 }));
  expectCode(() => escrow.idemExecute(ROOM, "k2", "claim", 200, () => { executions++; return { n: executions }; }, scope({ a: 2 })),
    "idempotency_key_reused");
  assert.equal(executions, 1); // the second thunk never ran
});

test("g14-idem: unscoped keys are refused outright", () => {
  const { escrow } = makeEscrow();
  expectCode(() => escrow.idemExecute(ROOM, "k3", "claim", 200, () => ({}), {}), "idempotency_scope_required");
});

test("g14-idem: throwing thunk leaves no row; retry executes; replay returns it", () => {
  const { escrow, db } = makeEscrow();
  let calls = 0;
  const flaky = () => { calls++; if (calls === 1) throw new Error("boom-mid-settlement"); return { settled: true }; };
  assert.throws(() => escrow.idemExecute(ROOM, "k4", "payout", 200, flaky, scopeFor(LANE, "b9", { op: "p" })), /boom-mid-settlement/);
  const rows = db.prepare("SELECT COUNT(*) AS n FROM bounty_idempotency WHERE room_id=? AND idem_key='k4'").get(ROOM).n;
  assert.equal(rows, 0, "failed attempt must leave no idempotency row");
  const retry = escrow.idemExecute(ROOM, "k4", "payout", 200, flaky, scopeFor(LANE, "b9", { op: "p" }));
  assert.equal(retry.replayed, false);
  assert.deepEqual(retry.body, { settled: true });
  const replay = escrow.idemExecute(ROOM, "k4", "payout", 200, flaky, scopeFor(LANE, "b9", { op: "p" }));
  assert.equal(replay.replayed, true);
  assert.equal(calls, 2, "no double-apply after retry");
});
