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

// PRODUCT-200 B7: POST /api/agent-rooms accepts an optional client-generated
// requestId as an idempotency key. The client-supplied roomId already serves
// as one, but a create that lets the server mint the room id (the auto-slug
// path) has no retry key: a dropped response retried with fresh params mints
// a second room. requestId closes that hole.

function setup(t, { capacity = 1000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-agent-rooms-requestid-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  ensureAgentRoomRequestIdColumn(store.db);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity, refillPerSecond: capacity })
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

test("auto-slug create retried with the same requestId returns the original room", t => {
  const { store, rooms, identity } = setup(t);
  const first = rooms.create(identity.secret, createArgs({ requestId: "req-1" }));
  assert.equal(first.duplicate, false);
  assert.ok(first.roomId.startsWith("agent-den-"), `auto-slug room id, got ${first.roomId}`);

  const retry = rooms.create(identity.secret, createArgs({ requestId: "req-1" }));
  assert.equal(retry.duplicate, true, "the retry is recognised as the same request");
  assert.equal(retry.roomId, first.roomId, "the retry names the original room, not a new one");
  assert.equal(roomCount(store), 1, "no second room was created");
});

test("a reused requestId with different params is a 409, not a new room", t => {
  const { store, rooms, identity } = setup(t);
  const first = rooms.create(identity.secret, createArgs({ requestId: "req-2" }));
  assert.equal(first.duplicate, false);

  const clash = attempt(rooms, identity.secret, createArgs({ requestId: "req-2", title: "A Different Den" }));
  assert.equal(clash.ok, false);
  assert.equal(clash.code, "request_conflict");
  assert.equal(roomCount(store), 1, "the conflicting retry created nothing");
});

test("a requestId is scoped to the identity that used it", t => {
  const { store, rooms, identity } = setup(t);
  const other = store.identities.create("Second Agent");
  rooms.create(identity.secret, createArgs({ requestId: "req-3" }));

  // A different identity reusing the key gets its own room: keys never leak
  // across identities.
  const theirs = rooms.create(other.secret, createArgs({ requestId: "req-3" }));
  assert.equal(theirs.duplicate, false);
  assert.equal(roomCount(store), 2);
});

test("a malformed requestId is a 422", t => {
  const { rooms, identity } = setup(t);
  const bad = attempt(rooms, identity.secret, createArgs({ requestId: "not a valid id!!" }));
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 422);
});

test("an unknown requestId field is still rejected", t => {
  const { rooms, identity } = setup(t);
  const bad = attempt(rooms, identity.secret, createArgs({ requestID: "req-4" }));
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 422);
});

test("a requestId retry does not spend creation budget", t => {
  const { rooms, identity } = setup(t, { capacity: 1 });
  const first = rooms.create(identity.secret, createArgs({ requestId: "req-budget" }));
  assert.equal(first.duplicate, false);

  const retry = rooms.create(identity.secret, createArgs({ requestId: "req-budget" }));
  assert.equal(retry.duplicate, true);

  // The budget holds one real creation: the retry must not have spent it.
  const second = attempt(rooms, identity.secret, createArgs({ requestId: "req-budget-2" }));
  assert.equal(second.ok, false, `second real creation is refused, got ${second.code}`);
  assert.equal(second.code, "rate_limited");
});
