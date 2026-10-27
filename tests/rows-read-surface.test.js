// SPEED-PLAN 0.2: per-request store counters surfaced on room.do_request.
// The DurableDatabase adapter already counted rowsRead and the projection
// cache already knew its hits from its misses — neither was exported. These
// tests pin the counting semantics the DO boundary diffs per request:
// cache counters are cumulative (never reset by clear()), an adapter with
// no row counter reports null instead of a fabricated zero, and a request
// that reads zero rows still reports rowsRead: 0 (the anonymous tools/list
// shape the census exists to prove).
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { DurableDatabase, durableStorage } from "../cloudflare/storage.mjs";
import { createDoContext } from "./helpers/do-storage-emulator.mjs";
import { doRequestEntry, storeCounterDeltas } from "../cloudflare/request-timing.mjs";

test("rowsRead surface: projection-cache counters count lookup outcomes on the Node door", t => {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom("commons"));
  const base = store.storeCounters();
  // node:sqlite exposes no rowsRead counter: null, never a made-up zero.
  assert.equal(base.rowsRead, null);

  store.room("commons");
  const afterFirst = store.storeCounters();
  assert.equal(afterFirst.projectionCacheHits + afterFirst.projectionCacheMisses,
    base.projectionCacheHits + base.projectionCacheMisses + 1, "one lookup counted exactly once");

  store.room("commons");
  const afterSecond = store.storeCounters();
  assert.equal(afterSecond.projectionCacheHits, afterFirst.projectionCacheHits + 1, "repeat read at the same sequence is a hit");
  assert.equal(afterSecond.projectionCacheMisses, afterFirst.projectionCacheMisses, "a hit is not also a miss");
});

test("rowsRead surface: cache evictions are counted when the room cap drops entries", t => {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  // The cache holds 32 rooms; reading a 33rd distinct room must evict.
  // Initialize first: a rooms write invalidates the whole cache, so reads
  // interleaved with initialization would never accumulate 33 entries.
  for (let i = 0; i < 33; i++) store.initialize(initialRoom(`room-${i}`));
  for (let i = 0; i < 33; i++) store.room(`room-${i}`);
  const counters = store.storeCounters();
  assert.ok(counters.projectionCacheEvictions >= 1, `expected at least one eviction, got ${counters.projectionCacheEvictions}`);
  assert.ok(counters.projectionCacheHits + counters.projectionCacheMisses >= 33, "every room read was counted");
});

test("rowsRead surface: DurableDatabase rowsRead accumulates and diffs per read", t => {
  const ctx = createDoContext();
  const store = new RoomStore(null, { database: new DurableDatabase(ctx.storage), storagePlatform: durableStorage });
  t.after(() => { store.close(); ctx.storage.close(); });
  store.initialize(initialRoom("commons"));
  const before = store.storeCounters();
  assert.ok(Number.isFinite(before.rowsRead), "the DO adapter reports a numeric rowsRead");
  store.room("commons");
  const after = store.storeCounters();
  assert.ok(after.rowsRead > before.rowsRead, "a room read reads rows");
  const deltas = storeCounterDeltas(before, after);
  assert.equal(deltas.rowsRead, after.rowsRead - before.rowsRead);
  assert.ok(deltas.rowsRead > 0);
});

test("rowsRead surface: do_request entry shape and delta clamping", () => {
  // No counters (paused object): the line keeps its original shape.
  assert.deepEqual(doRequestEntry({ method: "GET", path: "/api/health", status: 200, appMs: 3 }),
    { event: "room.do_request", method: "GET", path: "/api/health", status: 200, appMs: 3 });
  // A zero-row request reports rowsRead 0 — present, not omitted.
  const entry = doRequestEntry({ method: "POST", path: "/mcp", status: 200, appMs: 5,
    counters: { rowsRead: 0, projectionCacheHits: 0, projectionCacheMisses: 0, projectionCacheEvictions: 0 } });
  assert.equal(entry.rowsRead, 0);
  assert.equal(entry.projectionCacheHits, 0);
  assert.equal(entry.projectionCacheMisses, 0);
  assert.equal(entry.projectionCacheEvictions, 0);
  // Missing snapshot on either side yields no counters at all.
  assert.equal(storeCounterDeltas(null, { rowsRead: 1 }), null);
  assert.equal(storeCounterDeltas({ rowsRead: 1 }, null), null);
  // A counter that went backwards (fresh cache object) clamps to zero,
  // never a negative census.
  const clamped = storeCounterDeltas(
    { rowsRead: 10, projectionCacheHits: 4, projectionCacheMisses: 2, projectionCacheEvictions: 1 },
    { rowsRead: 3, projectionCacheHits: 4, projectionCacheMisses: 2, projectionCacheEvictions: 1 });
  assert.equal(clamped.rowsRead, 0);
  // An adapter without a row counter keeps rowsRead null through the delta.
  const nodeDoor = storeCounterDeltas(
    { rowsRead: null, projectionCacheHits: 0, projectionCacheMisses: 0, projectionCacheEvictions: 0 },
    { rowsRead: null, projectionCacheHits: 1, projectionCacheMisses: 0, projectionCacheEvictions: 0 });
  assert.equal(nodeDoor.rowsRead, null);
  assert.equal(nodeDoor.projectionCacheHits, 1);
});
