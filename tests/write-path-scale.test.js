import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { event as makeEvent, EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";
import { hydrateProjection } from "../server/projection-at-rest.mjs";

// C1 write-path-at-scale: the projection cache contract.
//
// server/store.mjs keeps a parsed-projection cache (MSG-0) so a large room is
// not JSON.parsed on every read. The complexity budget this file guards: a
// write must not force a re-parse of the projection it just wrote, and a
// write to one room must not evict another room's cached projection. Both
// are observable without timing: count JSON.parse calls whose input is
// exactly the current rooms.projection (the technique tests/agent-fleet.test.js
// already uses), so the tests are deterministic, not wall-clock sensitive.
//
// Authoring-gate answers: (1) the contract is the MSG-0 cache comment in
// store.mjs — a hit reads sequence only until the sequence changes or a
// rooms write drops the entry; (2) a regression to whole-cache clears (or a
// broken post-write refresh) makes the parse counters go nonzero; (3) no
// existing test covers write-path invalidation — agent-fleet.test.js only
// nulls the cache, nothing asserts per-write behavior; (4) no production
// seam added — the probe wraps the JSON.parse global like the fleet test.

const MESSAGE_COUNT = 500;

function fixture(t, roomIds) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-write-scale-"));
  let nowMs = Date.now();
  // Advancing clock defeats the per-member flood guard (burst 30, refill
  // 0.5/s) so the benchmark-style write loops below never 429.
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => (nowMs += 2100) });
  const keys = {};
  for (const roomId of roomIds) {
    // initialize() reduces the events in one transaction: thousands of
    // messages without per-command overhead.
    store.initialize([
      ...initialRoom(roomId, "owner"),
      ...Array.from({ length: MESSAGE_COUNT }, (_, i) => makeEvent({
        type: T.MESSAGE_POSTED, actorId: "owner", roomId,
        data: { messageId: `${roomId}-m${i}`, body: `scale body ${roomId} ${i} ` + "x".repeat(160) },
      })),
    ]);
    const ownerKey = store.issueAccessKey(roomId, "owner");
    store.command(ownerKey, roomId, {
      id: crypto.randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId: "agent", displayName: "agent", kind: "agent",
        permissions: ["accept_work", "complete_work", "verify"] },
    });
    setTier(store.db, roomId, "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
    keys[roomId] = store.issueAccessKey(roomId, "agent");
  }
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const post = (roomId, body) => store.command(keys[roomId], roomId,
    { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: crypto.randomUUID(), body } });
  return { store, keys, post, directory };
}

// Count JSON.parse calls whose input is exactly the room's current stored
// projection. Returns { parses(), restore() }.
function countProjectionParses(store, roomId) {
  const { n: length } = store.db.prepare("SELECT length(projection) AS n FROM rooms WHERE id=?").get(roomId);
  const parse = JSON.parse;
  let parses = 0;
  JSON.parse = function (text, ...rest) {
    if (typeof text === "string" && text.length === length) parses++;
    return parse.call(this, text, ...rest);
  };
  return { parses: () => parses, restore: () => { JSON.parse = parse; } };
}

test("a committed write leaves the room projection cached for the next write", t => {
  const { store, post } = fixture(t, ["scale"]);
  post("scale", "first write populates the cache");
  const probe = countProjectionParses(store, "scale");
  try {
    post("scale", "second write must not re-parse the projection");
    assert.equal(probe.parses(), 0,
      `write re-parsed the ${MESSAGE_COUNT}-message projection ${probe.parses()} time(s)`);
  } finally {
    probe.restore();
  }
});

test("a write to one room does not evict another room's cached projection", t => {
  const { store, post } = fixture(t, ["roomA", "roomB"]);
  store.room("roomB"); // populate roomB's cache entry
  post("roomA", "a write to room A");
  const probe = countProjectionParses(store, "roomB");
  try {
    store.room("roomB");
    assert.equal(probe.parses(), 0, "room B's projection was re-parsed after a write to room A");
  } finally {
    probe.restore();
  }
});

test("the post-write cache entry matches the persisted projection", t => {
  const { store, post } = fixture(t, ["scale"]);
  post("scale", "cache me");
  post("scale", "cache me twice");
  // Fresh parse+hydrate of the persisted row, independent of the cache.
  const row = store.db.prepare("SELECT sequence, projection FROM rooms WHERE id=?").get("scale");
  const expected = hydrateProjection(store.db, "scale", JSON.parse(row.projection)).state;
  const cached = store.room("scale");
  assert.equal(cached.sequence, row.sequence);
  assert.deepEqual(cached.state, expected);
});

test("the post-write cache entry matches with bodies stored at rest", t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-write-scale-bodies-"));
  let nowMs = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"),
    { now: () => (nowMs += 2100), bodiesAtRest: true });
  store.initialize(initialRoom("scale", "owner"));
  const ownerKey = store.issueAccessKey("scale", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const big = "large body " + "y".repeat(600); // over BODY_AT_REST_MIN_CHARS: slimmed in the row
  store.command(ownerKey, "scale",
    { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: crypto.randomUUID(), body: big } });
  store.command(ownerKey, "scale",
    { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: crypto.randomUUID(), body: "small" } });
  const cached = store.room("scale");
  // The stored row carries bodyRef, not the body; hydration must restore it.
  const stored = store.db.prepare("SELECT projection FROM rooms WHERE id=?").get("scale").projection;
  assert.ok(stored.includes("bodyRef"), "large body is slimmed in the stored row");
  const row = store.db.prepare("SELECT sequence, projection FROM rooms WHERE id=?").get("scale");
  const expected = hydrateProjection(store.db, "scale", JSON.parse(row.projection)).state;
  assert.equal(cached.sequence, row.sequence);
  assert.deepEqual(cached.state, expected);
  assert.equal(cached.state.messages.at(-2).body, big, "hydrated body matches the posted text");
});

test("a rolled-back rooms write does not leave a stale cache entry", t => {
  const { store } = fixture(t, ["scale"]);
  const before = store.room("scale").sequence;
  assert.throws(() => store.transaction(() => {
    store.db.prepare("UPDATE rooms SET sequence=? WHERE id=?").run(before + 100, "scale");
    throw new Error("boom");
  }), /boom/);
  const after = store.room("scale");
  assert.equal(after.sequence, before, "rollback restored the sequence; no uncommitted parse outlives the transaction");
  assert.equal(after.state.messages.length, MESSAGE_COUNT);
});
