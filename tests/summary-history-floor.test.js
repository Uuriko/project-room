// summaryHistoryFloor fails closed: a store that cannot report a floor (no
// historyFloor method, or one that throws) must hide all message text from a
// summary read, never show all of it.
import test from "node:test";
import assert from "node:assert/strict";
import { messageVisibleToViewer, summaryHistoryFloor } from "../server/history-visibility.mjs";

const message = { id: "m1", authorId: "alice", body: "hello", createdAt: "2026-01-01T00:00:00.000Z", toMemberId: null };

test("a store without historyFloor denies all message text", () => {
  for (const store of [{}, null, undefined, { historyFloor: "not a function" }]) {
    const floor = summaryHistoryFloor(store, "room", "bob");
    assert.ok(floor, "a deny-all floor, not null");
    assert.equal(messageVisibleToViewer(message, "bob", floor), false);
  }
});

test("a historyFloor that throws denies all message text", () => {
  const store = { historyFloor() { throw new Error("db unavailable"); } };
  const floor = summaryHistoryFloor(store, "room", "bob");
  assert.equal(messageVisibleToViewer(message, "bob", floor), false);
});

test("a working historyFloor is passed through unchanged, including a null floor", () => {
  const calls = [];
  const store = { historyFloor: (...args) => { calls.push(args); return null; } };
  assert.equal(summaryHistoryFloor(store, "room", "bob", 7), null);
  assert.deepEqual(calls, [["room", "bob", 7]]);
  assert.equal(messageVisibleToViewer(message, "bob", null), true);
});
