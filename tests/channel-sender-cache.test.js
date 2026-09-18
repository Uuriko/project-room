// Channel-sender cache policy (audit bug #5): the per-(provider, account,
// connection) sender map evicts least-recently-used entries at capacity
// instead of clear()ing the whole map (which dropped transports that were
// still in use). Tests the exported LRU primitive behind resolveChannelTransport.
import test from "node:test";
import assert from "node:assert/strict";
import { touchLruEntry } from "../server/http.mjs";

test("touchLruEntry: builds, stores and returns the value for a missing key", () => {
  const map = new Map();
  let built = 0;
  const first = touchLruEntry(map, "a", () => { built += 1; return { id: "a" }; }, 2);
  assert.equal(built, 1);
  assert.deepEqual(first, { id: "a" });
  const second = touchLruEntry(map, "a", () => { built += 1; return { id: "a2" }; }, 2);
  assert.equal(built, 1, "the factory is not called again on a hit");
  assert.equal(second, first, "a hit returns the identical cached object");
});

test("touchLruEntry: a hit marks the key most-recently-used", () => {
  const map = new Map();
  touchLruEntry(map, "a", () => "A", 2);
  touchLruEntry(map, "b", () => "B", 2);
  touchLruEntry(map, "a", () => "A2", 2); // refresh recency of "a"
  touchLruEntry(map, "c", () => "C", 2); // at capacity: evicts "b", not "a"
  assert.equal(map.has("a"), true);
  assert.equal(map.has("b"), false);
  assert.equal(map.has("c"), true);
});

test("touchLruEntry: evicts the least-recently-used entry at capacity", () => {
  const map = new Map();
  touchLruEntry(map, "a", () => "A", 2);
  touchLruEntry(map, "b", () => "B", 2);
  touchLruEntry(map, "c", () => "C", 2);
  assert.equal(map.size, 2, "the map never grows past capacity");
  assert.equal(map.has("a"), false, "the oldest entry is evicted");
  assert.deepEqual([...map.keys()], ["b", "c"], "insertion order is preserved");
});

test("touchLruEntry: capacity 1 keeps only the newest entry", () => {
  const map = new Map();
  touchLruEntry(map, "a", () => "A", 1);
  touchLruEntry(map, "b", () => "B", 1);
  assert.deepEqual([...map.keys()], ["b"]);
});
