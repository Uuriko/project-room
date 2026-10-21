import test from "node:test";
import assert from "node:assert/strict";
import { messageReadIndex } from "../server/message-read-index.mjs";
const frozen = records => Object.freeze(records.map(record => Object.freeze(record)));

test("immutable snapshots share read-only indexes, preserving DM order, replies and duplicate-ID lookup", () => {
  const rows = frozen([{ id: "a", authorId: "one", toMemberId: "two" },
    { id: "b", authorId: "two", replyToId: "a" }, { id: "a", authorId: "three", toMemberId: "two" }]);
  const index = messageReadIndex(rows);
  assert.equal(messageReadIndex(rows), index);
  assert.equal(index.get("a"), rows[2]);
  assert.deepEqual(index.receivedBy("two"), [rows[0], rows[2]]);
  assert.equal(index.hasReply("two", "a"), true);
  assert.equal(index.hasReply("three", "a"), false);
  assert.throws(() => index.receivedBy("two").pop(), TypeError);
  assert.throws(() => { index.get = () => null; }, TypeError);
  assert.deepEqual(index.receivedBy("absent"), []);
});

test("a cached immutable snapshot is not enumerated again", () => {
  let reads = 0;
  const source = frozen(Array.from({ length: 10000 }, (_, i) => ({ id: String(i), authorId: "a" })));
  const rows = new Proxy(source, { get(target, key, receiver) { if (/^\d+$/.test(String(key))) reads++; return Reflect.get(target, key, receiver); },
    ownKeys(target) { reads++; return Reflect.ownKeys(target); } });
  const first = messageReadIndex(rows), built = reads;
  for (let i = 0; i < 100; i++) assert.equal(messageReadIndex(rows).get("9999"), source[9999]);
  assert.ok(built >= 10000);
  assert.equal(reads, built, "warm lookup must not scan or recheck frozen entries");
  assert.equal(first, messageReadIndex(rows));
});

test("mutable and partially frozen snapshots recompute after identity, recipient and reply changes", () => {
  for (const freezeArray of [false, true]) {
    const message = { id: "old", authorId: "a", toMemberId: "b", replyToId: "x" };
    const rows = [message]; if (freezeArray) Object.freeze(rows);
    const old = messageReadIndex(rows);
    Object.assign(message, { id: "new", authorId: "b", toMemberId: "c", replyToId: "y" });
    const next = messageReadIndex(rows);
    assert.notEqual(old, next); assert.equal(next.get("old"), undefined);
    assert.equal(next.get("new"), message); assert.equal(next.receivedBy("b").length, 0);
    assert.equal(next.hasReply("a", "x"), false); assert.equal(next.hasReply("b", "y"), true);
  }
});

test("new snapshots preserve edits/deletion and accessor-backed indexed fields are never memoized", () => {
  const first = frozen([{ id: "a", body: "before" }]), second = frozen([{ id: "a", body: null, deletedAt: "now" }]);
  assert.notEqual(messageReadIndex(first), messageReadIndex(second));
  assert.equal(messageReadIndex(second).get("a").deletedAt, "now");
  let id = "before";
  const record = Object.freeze({ get id() { return id; } });
  const rows = Object.freeze([record]); const old = messageReadIndex(rows); id = "after";
  assert.notEqual(messageReadIndex(rows), old); assert.equal(messageReadIndex(rows).get("after"), record);
  let value = first[0];
  const accessorArray = []; Object.defineProperty(accessorArray, 0, { get: () => value }); Object.freeze(accessorArray);
  const a = messageReadIndex(accessorArray); value = second[0];
  assert.notEqual(messageReadIndex(accessorArray), a); assert.equal(messageReadIndex(accessorArray).get("a"), second[0]);
});

test("unindexed accessors remain live and are not evaluated or cached by the index", () => {
  let body = "before", reads = 0;
  const message = Object.freeze({ id: "a", get body() { reads++; return body; } });
  const rows = Object.freeze([message]); const index = messageReadIndex(rows);
  assert.equal(reads, 0);
  body = "after";
  assert.equal(messageReadIndex(rows), index);
  assert.equal(index.get("a").body, "after");
  assert.equal(reads, 1);
});
