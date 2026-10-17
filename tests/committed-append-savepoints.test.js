import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

function fixture(t) {
  const f = createAcceptanceFixture();
  const { store } = f;
  store.roomFlood = { consume() {} };
  t.after(() => { store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const observed = [];
  const unsubscribe = store.onEventAppended(roomId => observed.push({ roomId, inTransaction: store.db.isTransaction }));
  t.after(unsubscribe);
  const before = store.eventStamp("commons");
  const post = id => store.command(f.keys.owner, "commons", { id, type: "message.posted", data: { messageId: id, body: id } });
  return { store, observed, before, post };
}

test("isolated success publishes one wake only after the outer commit", t => {
  const { store, observed, before, post } = fixture(t);
  store.transaction(() => {
    post("outer");
    store.transaction(() => post("inner"), { isolated: true });
    assert.deepEqual(observed, []);
    assert.equal(store.eventStamp("commons"), before);
  });
  assert.deepEqual(observed, [{ roomId: "commons", inTransaction: false }]);
  assert.equal(store.eventStamp("commons"), before + 1);
});

test("outer rollback after isolated success never publishes an uncommitted wake", t => {
  const { store, observed, before, post } = fixture(t);
  const head = store.headSequence("commons");
  assert.throws(() => store.transaction(() => {
    store.transaction(() => post("rolled-back"), { isolated: true });
    throw new Error("abort outer");
  }), /abort outer/);
  assert.equal(store.headSequence("commons"), head);
  assert.deepEqual(observed, []);
  assert.equal(store.eventStamp("commons"), before);
});

test("isolated rollback preserves an earlier outer append's committed wake", t => {
  const { store, observed, before, post } = fixture(t);
  const head = store.headSequence("commons");
  store.transaction(() => {
    post("committed");
    assert.throws(() => store.transaction(() => {
      post("rolled-back");
      throw new Error("abort isolated");
    }, { isolated: true }), /abort isolated/);
  });
  assert.equal(store.headSequence("commons"), head + 1);
  assert.deepEqual(observed, [{ roomId: "commons", inTransaction: false }]);
  assert.equal(store.eventStamp("commons"), before + 1);
});

test("isolated rollback alone does not leave a stale wake for the next transaction", t => {
  const { store, observed, before, post } = fixture(t);
  store.transaction(() => {
    assert.throws(() => store.transaction(() => {
      post("rolled-back");
      throw new Error("abort isolated");
    }, { isolated: true }), /abort isolated/);
  });
  store.transaction(() => {});
  assert.deepEqual(observed, []);
  assert.equal(store.eventStamp("commons"), before);
  post("later-commit");
  assert.deepEqual(observed, [{ roomId: "commons", inTransaction: false }]);
  assert.equal(store.eventStamp("commons"), before + 1);
});

test("rolled-back savepoint discards its successful deeper savepoint without losing outer work", t => {
  const { store, observed, before, post } = fixture(t);
  const head = store.headSequence("commons");
  store.transaction(() => {
    post("outer-commit");
    assert.throws(() => store.transaction(() => {
      store.transaction(() => post("deep-rollback"), { isolated: true });
      throw new Error("abort middle");
    }, { isolated: true }), /abort middle/);
    assert.deepEqual(observed, []);
  });
  assert.equal(store.headSequence("commons"), head + 1);
  assert.deepEqual(observed, [{ roomId: "commons", inTransaction: false }]);
  assert.equal(store.eventStamp("commons"), before + 1);
});
