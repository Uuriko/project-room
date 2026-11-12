// Isolated transaction runner registry for wake accounting
// (server/wake-transaction.mjs).
//
// recordWakeEvent's counter+journal writes must be atomic AND isolated
// from a caller's open transaction. The registry is the reach from a raw
// db to the owning store's isolated transaction; this suite pins:
// 1. A registry miss fails closed — it throws BEFORE fn runs, so no
//    partial write is possible and no non-atomic fallback can hide.
// 2. A registered runner is used verbatim and its failures propagate.
// 3. RoomStore registers the isolated runner for its db at construction:
//    on nodeStorage an outermost run commits/rolls back as a unit, and a
//    nested run inside a caller's transaction rolls back only its own
//    writes when it throws (the caller's writes still commit).
import test from "node:test";
import assert from "node:assert/strict";
import { registerWakeTransactionRunner, runWakeTransaction } from "../server/wake-transaction.mjs";
import { RoomStore } from "../server/store.mjs";

test("a registry miss throws before fn runs (fail closed, no partial write)", () => {
  const db = {};
  let ran = false;
  assert.throws(() => runWakeTransaction(db, () => { ran = true; }),
    /no isolated store transaction is registered/);
  assert.equal(ran, false, "fn never ran, so nothing could be written");
});

test("a registered runner is invoked with fn and its result and errors pass through", () => {
  const db = {};
  const seen = [];
  registerWakeTransactionRunner(db, fn => { seen.push("run"); return fn(); });
  assert.equal(runWakeTransaction(db, () => 42), 42);
  assert.deepEqual(seen, ["run"]);
  registerWakeTransactionRunner(db, () => { throw new Error("runner boom"); });
  assert.throws(() => runWakeTransaction(db, () => {}), /runner boom/);
});

function scratchStore(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.db.exec("CREATE TABLE wake_tx_scratch (v TEXT)");
  const values = () => store.db.prepare("SELECT v FROM wake_tx_scratch ORDER BY v").all().map(row => row.v);
  const insert = v => store.db.prepare("INSERT INTO wake_tx_scratch VALUES (?)").run(v);
  return { store, values, insert };
}

test("RoomStore registers the isolated runner: an outermost run is one unit", t => {
  const { store, values, insert } = scratchStore(t);
  runWakeTransaction(store.db, () => insert("committed"));
  assert.deepEqual(values(), ["committed"]);
  assert.throws(() => runWakeTransaction(store.db, () => { insert("lost"); throw new Error("boom"); }), /boom/);
  assert.deepEqual(values(), ["committed"], "the throwing run rolled back as a unit");
});

test("RoomStore's runner is isolated: a nested failure rolls back only its own writes", t => {
  const { store, values, insert } = scratchStore(t);
  store.transaction(() => {
    insert("caller-a");
    assert.throws(() => runWakeTransaction(store.db, () => { insert("inner-lost"); throw new Error("inner boom"); }),
      /inner boom/);
    insert("caller-b");
  });
  assert.deepEqual(values(), ["caller-a", "caller-b"],
    "the caller's writes committed; the isolated run's writes rolled back alone");
});
