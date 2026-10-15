import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  AgentRooms,
  agentRoomSchema,
  ensureAgentRoomRequestIdColumn
} from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";

// Issue #2915: room-create duplicate detection compared ownerId, title,
// purpose, kind and displayName but never the starter flag (part of
// CREATE_FIELDS, parsed as wantStarter). A replay that differed only in
// starter was silently answered duplicate:true — e.g. a first create with
// starter:false replayed with starter:true returned starter:null instead
// of the 409 every other differing field produces. Both idempotency keys
// (client roomId and client requestId) had the same omission.
//
// The original create's starter choice is recoverable from the room
// itself: a starter was wanted iff the starter work claim exists, which
// is exactly what a fresh create produces and what the duplicate response
// returns as `starter`.

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-agent-rooms-starter-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  ensureAgentRoomRequestIdColumn(store.db);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const identity = store.identities.create("Owning Agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms, identity };
}

const createArgs = (overrides = {}) => ({
  title: "Agent Den", purpose: "A room owned by an agent, for agent things.",
  kind: "personal", displayName: "Den Keeper", ...overrides
});

const attempt = (rooms, secret, args) => {
  try { return { ok: true, result: rooms.create(secret, args) }; }
  catch (error) { return { ok: false, status: error.status, code: error.code, message: error.message }; }
};

const roomCount = store =>
  store.db.prepare("SELECT count(*) AS n FROM agent_room_ownership").get().n;

test("roomId replay with a different starter flag is a 409, not a duplicate", t => {
  const { store, rooms, identity } = setup(t);
  const first = rooms.create(identity.secret, createArgs({ roomId: "plain-den", starter: false }));
  assert.equal(first.duplicate, false);
  assert.equal(first.starter, null, "the first create honoured starter:false");

  const clash = attempt(rooms, identity.secret, createArgs({ roomId: "plain-den", starter: true }));
  assert.equal(clash.ok, false, "a replay asking for a starter the original refused must not pass as a duplicate");
  assert.equal(clash.status, 409);
  assert.equal(clash.code, "room_exists");
  assert.equal(roomCount(store), 1, "the conflicting replay created nothing");
});

test("roomId replay dropping the starter is a 409, and an identical replay still duplicates", t => {
  const { store, rooms, identity } = setup(t);
  const first = rooms.create(identity.secret, createArgs({ roomId: "starter-den", starter: true }));
  assert.equal(first.duplicate, false);
  assert.ok(first.starter, "the first create produced the starter");

  const clash = attempt(rooms, identity.secret, createArgs({ roomId: "starter-den", starter: false }));
  assert.equal(clash.ok, false);
  assert.equal(clash.status, 409);
  assert.equal(clash.code, "room_exists");

  const replay = rooms.create(identity.secret, createArgs({ roomId: "starter-den", starter: true }));
  assert.equal(replay.duplicate, true, "a replay with the same starter flag is still the same request");
  assert.equal(replay.roomId, first.roomId);
  assert.deepEqual(replay.starter, first.starter);
  assert.equal(roomCount(store), 1);
});

test("requestId replay with a different starter flag is a 409 request_conflict", t => {
  const { store, rooms, identity } = setup(t);
  const first = rooms.create(identity.secret, createArgs({ requestId: "req-starter", starter: false }));
  assert.equal(first.duplicate, false);
  assert.equal(first.starter, null);

  const clash = attempt(rooms, identity.secret, createArgs({ requestId: "req-starter", starter: true }));
  assert.equal(clash.ok, false, "the requestId branch must compare starter too");
  assert.equal(clash.status, 409);
  assert.equal(clash.code, "request_conflict");
  assert.equal(roomCount(store), 1, "the conflicting retry created nothing");

  const replay = rooms.create(identity.secret, createArgs({ requestId: "req-starter", starter: false }));
  assert.equal(replay.duplicate, true, "a requestId replay with the same starter flag still duplicates");
  assert.equal(replay.roomId, first.roomId);
  assert.equal(replay.starter, null);
});

test("requestId replay dropping the starter is a 409 request_conflict", t => {
  const { store, rooms, identity } = setup(t);
  const first = rooms.create(identity.secret, createArgs({ requestId: "req-starter-2" }));
  assert.equal(first.duplicate, false);
  assert.ok(first.starter, "omitting starter defaults to wanting one");

  const clash = attempt(rooms, identity.secret, createArgs({ requestId: "req-starter-2", starter: false }));
  assert.equal(clash.ok, false);
  assert.equal(clash.status, 409);
  assert.equal(clash.code, "request_conflict");
  assert.equal(roomCount(store), 1);
});
