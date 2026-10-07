import test from "node:test";
import assert from "node:assert/strict";
import {
  UNIFY_R_STREAMS,
  unifyREnabled,
  sessionWatermark,
  ackDurableCursor,
  foldHorizonsMin,
  cursorKey,
  createMemoryReadCursorStore,
} from "../server/read-cursor.mjs";

test("UNIFY_R streams are the four named attention streams", () => {
  assert.deepEqual([...UNIFY_R_STREAMS], [
    "needs-me",
    "mentions",
    "updates",
    "mcp-messages",
  ]);
});

test("flag rollback: UNIFY_R_CURSOR=0 disables", () => {
  assert.equal(unifyREnabled({}), false);
  assert.equal(unifyREnabled({ UNIFY_R_CURSOR: "0" }), false);
  assert.equal(unifyREnabled({ UNIFY_R_CURSOR: "false" }), false);
});

test("two readers with no ack leave durable cursor unchanged", () => {
  const store = createMemoryReadCursorStore({ roomId: "commons" });
  assert.equal(store.getReadCursor("m1", "needs-me"), null);
  // session watermarks only
  const s1 = sessionWatermark(store.getReadCursor("m1", "needs-me"), 10);
  const s2 = sessionWatermark(store.getReadCursor("m1", "needs-me"), 40);
  assert.equal(s1, 10);
  assert.equal(s2, 40);
  assert.equal(store.getReadCursor("m1", "needs-me"), null);
});

test("ack regress is a no-op (advance-only MAX)", () => {
  assert.equal(ackDurableCursor(50, 40), 50);
  assert.equal(ackDurableCursor(50, 50), 50);
  assert.equal(ackDurableCursor(50, 60), 60);
  assert.equal(ackDurableCursor(null, 7), 7);
  const store = createMemoryReadCursorStore({ roomId: "commons" });
  store.ackReadCursor("m1", "mentions", 100);
  store.ackReadCursor("m1", "mentions", 80);
  assert.equal(store.getReadCursor("m1", "mentions"), 100);
});

test("disagreement fixture folds to MIN", () => {
  assert.equal(foldHorizonsMin([100, 40, 70]), 40);
  assert.equal(foldHorizonsMin([null, 12, undefined]), 12);
  assert.equal(foldHorizonsMin([]), null);
  const store = createMemoryReadCursorStore({ roomId: "commons" });
  store.ackReadCursor("m1", "updates", 200);
  assert.equal(store.migrateFold("m1", "updates", [150, 90]), 90);
  assert.equal(store.getReadCursor("m1", "updates"), 90);
});

test("session watermark never writes below durable", () => {
  assert.equal(sessionWatermark(100, 50), 100);
  assert.equal(sessionWatermark(100, 120), 120);
  assert.equal(sessionWatermark(null, 5), 5);
});

test("cursorKey rejects unknown streams", () => {
  assert.equal(cursorKey("m", "needs-me", {roomId:"commons"}), JSON.stringify(["commons","m","needs-me",""]));
  assert.throws(() => cursorKey("m", "nope", {roomId:"commons"}), /unknown streamId/);
});

test("scope keys separate identical members across rooms and threads", () => {
  assert.notEqual(cursorKey("m","mentions",{roomId:"a"}),cursorKey("m","mentions",{roomId:"b"}));
  assert.notEqual(cursorKey("m","mentions",{roomId:"a",threadId:"x"}),cursorKey("m","mentions",{roomId:"a",threadId:"y"}));
  assert.throws(()=>cursorKey("m","mentions"),/roomId/);
});
test("fractional and overflowing positions cannot become read acknowledgments", () => {
  for(const value of [0.5,Infinity,Number.MAX_SAFE_INTEGER+1,"9999999999999999999999999999999999999999999999999"]) assert.equal(ackDurableCursor(3,value),3);
});
