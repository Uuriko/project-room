import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// Lane-01 Low bundle (issue #3903): the plain transaction path must reject an
// async function loudly — the Cloudflare platform and the isolated path
// already do — instead of committing around its first await and letting the
// continuation write in autocommit. And close() must be idempotent so a
// double-close in a teardown path cannot mask the real shutdown error.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-store-hardening-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

const archivedAt = store => store.db.prepare("SELECT archived_at FROM rooms WHERE id='commons'").get().archived_at;
const stampRoom = store => store.db.prepare("UPDATE rooms SET archived_at='2099-01-01' WHERE id='commons'").run();
const SYNC_ERROR = /Room transactions must remain synchronous/;

test("a synchronous transaction still commits (control)", t => {
  const store = fixture(t);
  store.transaction(() => stampRoom(store));
  assert.equal(archivedAt(store), "2099-01-01");
});

test("plain transaction rejects an async function and rolls back its writes", t => {
  const store = fixture(t);
  assert.throws(() => store.transaction(async () => {
    stampRoom(store);
    await null;
  }), SYNC_ERROR);
  assert.equal(store.db.isTransaction, false);
  assert.equal(archivedAt(store), null);
});

test("plain transaction refuses the async function itself, at the call site", async t => {
  const store = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let outcome;
  try {
    outcome = store.transaction(async () => {
      await gate;
      stampRoom(store);
    });
  } catch (error) { outcome = error; }
  // On the defective path `outcome` is the pending promise: the call site
  // hears nothing, and the closure's late write lands in autocommit when
  // the gate opens. (No implementation can cancel a caller's stray
  // continuation — the isolated path and the Cloudflare platform share
  // this shape; the contract is that the refusal is loud and synchronous,
  // before any write, and the transaction the closure started in is
  // rolled back, per the sibling test above.)
  assert.ok(outcome instanceof Error && SYNC_ERROR.test(outcome.message),
    "transaction() must throw the synchronous-transaction error immediately");
  assert.equal(store.db.isTransaction, false);
  assert.equal(archivedAt(store), null);
  release();
  await new Promise(resolve => setImmediate(resolve));
  // The refusal left the store consistent and usable.
  assert.equal(store.db.isTransaction, false);
  store.transaction(() => stampRoom(store));
  assert.equal(archivedAt(store), "2099-01-01");
});

test("readTransaction rejects an async function", t => {
  const store = fixture(t);
  assert.throws(() => store.readTransaction(async () => 1), SYNC_ERROR);
  // The read path recovers: a synchronous read transaction still works.
  assert.equal(store.readTransaction(() => archivedAt(store)), null);
});

test("an async function in a nested plain transaction rolls back the outer transaction", t => {
  const store = fixture(t);
  assert.throws(() => store.transaction(() => {
    stampRoom(store);
    store.transaction(async () => {});
  }), SYNC_ERROR);
  assert.equal(store.db.isTransaction, false);
  assert.equal(archivedAt(store), null);
});

test("isolated transaction still rejects an async function (control)", t => {
  const store = fixture(t);
  assert.throws(() => store.transaction(async () => {}, { isolated: true }), SYNC_ERROR);
});

test("close() is idempotent: repeated closes are a safe no-op", t => {
  const store = fixture(t);
  store.close();
  assert.doesNotThrow(() => store.close());
  assert.doesNotThrow(() => store.close());
});

test("the first close() still closes the store", t => {
  const store = fixture(t);
  store.close();
  assert.throws(() => store.room("commons"));
});

test("close() re-entered from within the database close is a no-op", t => {
  const store = fixture(t);
  const db = store.db;
  const realClose = db.close.bind(db);
  let calls = 0;
  let reentered = false;
  db.close = () => {
    calls += 1;
    if (!reentered) { reentered = true; store.close(); }
    realClose();
  };
  store.close();
  store.close();
  assert.equal(calls, 1);
});
