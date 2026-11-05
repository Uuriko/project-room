import test from "node:test";
import assert from "node:assert/strict";
import { stashGoogleRoom, consumeGoogleRoom } from "../src/google-room-return.js";
const storage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k,v) => m.set(k,v), removeItem: k => m.delete(k) }; };
test("Google room intent survives once in its own tab only", () => {
  const a = storage(), b = storage(); stashGoogleRoom("muse-room", a, 1000);
  assert.equal(consumeGoogleRoom(b, 1001), null);
  assert.equal(consumeGoogleRoom(a, 1001), "muse-room");
  assert.equal(consumeGoogleRoom(a, 1002), null);
});
test("stale, future, external, missing and storage-blocked intents fail closed", () => {
  for (const [room, at, now] of [["muse-room", 0, 600001], ["muse-room", 2, 1], ["https://evil.test", 0, 1], [null, 0, 1]]) {
    const s = storage(); stashGoogleRoom(room, s, at); assert.equal(consumeGoogleRoom(s, now), null);
  }
  const blocked = { getItem() { throw Error(); }, removeItem() { throw Error(); } };
  stashGoogleRoom("muse-room", blocked); assert.equal(consumeGoogleRoom(blocked), null);
});
test("starting without a room clears a previous abandoned destination", () => {
  const s = storage(); stashGoogleRoom("muse-room", s); stashGoogleRoom(null, s); assert.equal(consumeGoogleRoom(s), null);
});
