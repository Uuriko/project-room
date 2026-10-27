// Wake accounting on the isolated runner (the #4994 cure for audit
// D3-5 P1): recordWakeEvent's counter+journal write runs through the
// isolated transaction runner RoomStore registers for its db
// (server/wake-transaction.mjs), replacing the raw SAVEPOINT block —
// which the TST-07 lint forbids in server/** and the Durable Object
// runtime forbids outright (its storage refuses SQL transaction
// statements; nested rollback comes from transactionSync).
//
// The operator suite pins the partial-failure rollback on a bare
// node:sqlite db; this suite pins the same semantics on RoomStore-owned
// dbs on BOTH platforms:
// 1. Durable Object-shaped db (DurableDatabase over the DO storage
//    emulator): a partial failure rolls the counter back, and no SQL
//    transaction statement is ever attempted on the DO surface.
// 2. DO, nested: a failing record inside a caller's open transaction
//    rolls back only the accounting writes; the caller's own write in
//    the same transaction still commits.
// 3. Node (nodeStorage), nested: the same isolation through the
//    SAVEPOINT path.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { DurableDatabase, durableStorage } from "../cloudflare/storage.mjs";
import { createDoContext } from "./helpers/do-storage-emulator.mjs";
import { recordWakeEvent, wakeRecordFailures, resetWakeRecordFailuresForTests } from "../server/wake-metrics.mjs";

function silenceRecordLog(fn) {
  const original = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = original; }
}

function doStore(t) {
  const ctx = createDoContext();
  const store = new RoomStore(null, { database: new DurableDatabase(ctx.storage), storagePlatform: durableStorage });
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); ctx.storage.close(); });
  return { store, storage: ctx.storage };
}

function nodeStore(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  return store;
}

const countersOf = db => db.prepare("SELECT event, n FROM agent_wake_counters ORDER BY event").all()
  .map(row => ({ event: row.event, n: row.n }));

// A successful record, then the journal table is dropped so the next
// reason-bearing record fails AFTER its counter insert — the D3-5 P1
// partial failure. Returns the failing record's result.
function partialFailure(db) {
  assert.equal(recordWakeEvent(db, { at: 1, store: "signals", event: "emitted" }), true);
  db.exec("DROP TABLE agent_wake_failures");
  return silenceRecordLog(() =>
    recordWakeEvent(db, { at: 2, store: "signals", event: "failed", reason: "enqueue_error" }));
}

test("DO-shaped db: a partial failure rolls the counter back via transactionSync", t => {
  resetWakeRecordFailuresForTests();
  t.after(() => resetWakeRecordFailuresForTests());
  const { store, storage } = doStore(t);
  assert.equal(partialFailure(store.db), false);
  assert.deepEqual(countersOf(store.db), [{ event: "emitted", n: 1 }],
    "the failed counter row was rolled back with its unwritable journal row");
  assert.equal(wakeRecordFailures().total, 1);
  assert.ok(storage.stats.transactions > 0, "writes went through transactionSync");
  assert.equal(storage.stats.rejected, 0, "no SQL transaction statement was ever attempted on the DO surface");
});

test("DO-shaped db: a failing record inside a caller's transaction rolls back only the accounting writes", t => {
  resetWakeRecordFailuresForTests();
  t.after(() => resetWakeRecordFailuresForTests());
  const { store } = doStore(t);
  assert.equal(recordWakeEvent(store.db, { at: 1, store: "signals", event: "emitted" }), true);
  store.db.exec("DROP TABLE agent_wake_failures");
  store.db.exec("CREATE TABLE caller_scratch (v TEXT)");
  const result = store.transaction(() => {
    store.db.prepare("INSERT INTO caller_scratch VALUES ('caller-write')").run();
    return silenceRecordLog(() =>
      recordWakeEvent(store.db, { at: 2, store: "signals", event: "failed", reason: "enqueue_error" }));
  });
  assert.equal(result, false, "the record reported its failure without throwing into the caller");
  assert.deepEqual(store.db.prepare("SELECT v FROM caller_scratch").all().map(row => row.v), ["caller-write"],
    "the caller's write committed");
  assert.deepEqual(countersOf(store.db), [{ event: "emitted", n: 1 }],
    "the accounting write rolled back alone");
});

test("node db: a failing record inside a caller's transaction rolls back only the accounting writes", t => {
  resetWakeRecordFailuresForTests();
  t.after(() => resetWakeRecordFailuresForTests());
  const store = nodeStore(t);
  assert.equal(recordWakeEvent(store.db, { at: 1, store: "signals", event: "emitted" }), true);
  store.db.exec("DROP TABLE agent_wake_failures");
  store.db.exec("CREATE TABLE caller_scratch (v TEXT)");
  const result = store.transaction(() => {
    store.db.prepare("INSERT INTO caller_scratch VALUES ('caller-write')").run();
    return silenceRecordLog(() =>
      recordWakeEvent(store.db, { at: 2, store: "signals", event: "failed", reason: "enqueue_error" }));
  });
  assert.equal(result, false);
  assert.deepEqual(store.db.prepare("SELECT v FROM caller_scratch").all().map(row => row.v), ["caller-write"],
    "the caller's write committed");
  assert.deepEqual(countersOf(store.db), [{ event: "emitted", n: 1 }],
    "the accounting write rolled back alone (SAVEPOINT path)");
});
