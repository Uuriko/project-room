// IDEMPOTENCY-CAP: prune policy for the bounty idempotency replay cache.
//
// Contract pinned here:
//  (a) a prune run deletes only out-of-window version=2 rows (age leg:
//      90 days; count leg: per-room excess over 20,000, never younger than
//      the 30-day count floor); rows inside the window survive;
//  (b) a replay of a surviving key still returns the recorded response
//      without re-executing;
//  (c) a replay of a pruned key executes fresh — the ONE accepted
//      behavioural change of the policy;
//  (d) legacy version-NULL rows are never pruned, so the
//      idempotency_actor_mismatch refusal they back cannot silently turn
//      into a fresh execution.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  BountyEscrow, pruneBountyIdempotency,
  IDEMPOTENCY_RETENTION_MS, IDEMPOTENCY_MAX_ROWS_PER_ROOM, IDEMPOTENCY_COUNT_FLOOR_MS
} from "../server/bounty-escrow.mjs";

const ROOM = "room-prune";
const LANE = "id:agent/pruner";
const DAY = 24 * 3600 * 1000;
const T0 = 1_786_000_000_000;

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  let clock = T0;
  const escrow = new BountyEscrow(store, { now: () => clock, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  const bounty = escrow.postBounty(ROOM, { poster: LANE, title: "T", criteria: "C", amount: 10,
    deadline: new Date(T0 + 365 * DAY).toISOString() }).bounty;
  return { escrow, db, bounty, setClock: ms => { clock = ms; } };
}

const count = (db, room = ROOM) =>
  db.prepare("SELECT COUNT(*) AS n FROM bounty_idempotency WHERE room_id=?").get(room).n;

test("(a)+(b)+(c) age leg: out-of-window rows pruned, surviving key replays, pruned key executes fresh", () => {
  const { escrow, db, bounty, setClock } = makeEscrow();
  let executions = 0;
  const thunk = () => { executions += 1; return { ok: true, n: executions }; };
  const scope = { callerLane: LANE, bountyId: bounty.bountyId, payload: { x: 1 } };

  escrow.idemExecute(ROOM, "old-key", "bounty.fund", 200, thunk, scope);
  assert.equal(executions, 1);

  // A second key written 2 days before the prune instant: inside the window.
  setClock(T0 + IDEMPOTENCY_RETENTION_MS - 2 * DAY);
  escrow.idemExecute(ROOM, "fresh-key", "bounty.fund", 200, thunk, scope);
  assert.equal(executions, 2);
  assert.equal(count(db), 2);

  const pruneNow = T0 + IDEMPOTENCY_RETENTION_MS + DAY;
  const result = pruneBountyIdempotency(db, { now: pruneNow, limit: 500 });
  assert.deepEqual(result, { pruned: 1, byAge: 1, byCount: 0 });
  assert.equal(count(db), 1, "only the out-of-window row is gone");

  // (b) surviving key still replays the recorded body, no re-execution.
  const replay = escrow.idemExecute(ROOM, "fresh-key", "bounty.fund", 200, thunk, scope);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, { ok: true, n: 2 });
  assert.equal(executions, 2);

  // (c) pruned key behaves as a fresh operation: the accepted semantics.
  const fresh = escrow.idemExecute(ROOM, "old-key", "bounty.fund", 200, thunk, scope);
  assert.equal(fresh.replayed, false);
  assert.equal(executions, 3);
});

test("(d) legacy version-NULL rows are never pruned and still refuse with actor mismatch", () => {
  const { escrow, db, bounty } = makeEscrow();
  escrow.idemExecute(ROOM, "legacy", "bounty.fund", 200, () => ({ ok: true }),
    { callerLane: LANE, bountyId: bounty.bountyId });
  db.exec("UPDATE bounty_idempotency SET version = NULL, scope_key = NULL WHERE idem_key = 'legacy'");

  const result = pruneBountyIdempotency(db, { now: T0 + 10 * IDEMPOTENCY_RETENTION_MS, limit: 500 });
  assert.equal(result.pruned, 0);
  assert.equal(count(db), 1);
  assert.throws(
    () => escrow.idemExecute(ROOM, "legacy", "bounty.fund", 200, () => ({ ok: true }),
      { callerLane: LANE, bountyId: bounty.bountyId }),
    error => error.code === "idempotency_actor_mismatch");
});

function seedRows(db, room, n, createdAtMs) {
  const insert = db.prepare(`INSERT INTO bounty_idempotency
    (room_id, idem_key, route, status, response, created_at, scope_key, caller_lane, version, request_hash)
    VALUES (?,?,?,?,?,?,?,?,2,?)`);
  db.exec("BEGIN");
  try {
    for (let i = 0; i < n; i++) {
      // Stagger by one minute so "oldest" is deterministic.
      insert.run(room, `k-${i}`, "bounty.fund", 200, JSON.stringify({ ok: true }),
        new Date(createdAtMs + i * 60_000).toISOString(), `v2:seed-${room}-${i}`, LANE, null);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

test("(a) count leg: per-room excess over the cap is pruned oldest-first, bounded by the count floor", () => {
  const { db } = makeEscrow();
  const pruneNow = T0 + 200 * DAY;
  // 40 days old at prune time: inside the 90-day age window (age leg must
  // not touch them) but older than the 30-day count floor.
  seedRows(db, ROOM, IDEMPOTENCY_MAX_ROWS_PER_ROOM + 10, pruneNow - 40 * DAY);
  // A second room over the cap whose excess is younger than the count
  // floor: the count leg must leave every row alone.
  seedRows(db, "room-young", IDEMPOTENCY_MAX_ROWS_PER_ROOM + 5, pruneNow - 10 * DAY);

  const result = pruneBountyIdempotency(db, { now: pruneNow, limit: 100_000 });
  assert.equal(result.byAge, 0);
  assert.equal(result.byCount, 10);
  assert.equal(count(db), IDEMPOTENCY_MAX_ROWS_PER_ROOM);
  assert.equal(count(db, "room-young"), IDEMPOTENCY_MAX_ROWS_PER_ROOM + 5);
  // Oldest-first: k-0..k-9 gone, k-10 survives.
  const oldest = db.prepare("SELECT idem_key FROM bounty_idempotency WHERE room_id=? ORDER BY created_at LIMIT 1").get(ROOM);
  assert.equal(oldest.idem_key, "k-10");
});

test("prune honours the per-call batch limit and tolerates a missing table", () => {
  const { db } = makeEscrow();
  seedRows(db, ROOM, 10, T0);
  const result = pruneBountyIdempotency(db, { now: T0 + IDEMPOTENCY_RETENTION_MS + DAY, limit: 3 });
  assert.deepEqual(result, { pruned: 3, byAge: 3, byCount: 0 });
  assert.equal(count(db), 7);

  const empty = new DatabaseSync(":memory:");
  assert.deepEqual(pruneBountyIdempotency(empty, { now: T0 }), { pruned: 0, byAge: 0, byCount: 0 });
  assert.throws(() => pruneBountyIdempotency(empty, { now: 1.5 }), TypeError);
});
