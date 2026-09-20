import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  AGENT_ROOM_CREATE_CAPACITY,
  AGENT_ROOM_CREATE_REFILL_PER_SECOND,
  AgentRooms,
  agentRoomSchema
} from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";

// POST /api/agent-rooms takes the client-chosen roomId as an idempotency key:
// the same identity retrying the same request gets duplicate: true and no new
// room. The per-identity budget used to be charged before that short-circuit,
// so a replay - the exact thing an idempotency key exists for - paid for a room
// it did not create.
//
// It is only visible at the real capacity. The suite beside this one builds its
// AgentRooms with capacity 1000, which no replay can exhaust, so the existing
// idempotency test never reaches the limiter and the existing budget test uses
// two different room ids, which are two real creations. These use the shipped
// numbers: capacity 3, refill 3/86400, one token per eight hours.

function setup(t, { capacity = AGENT_ROOM_CREATE_CAPACITY, refillPerSecond = AGENT_ROOM_CREATE_REFILL_PER_SECOND } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-agent-rooms-budget-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, { rateLimiter: createRateLimiter({ capacity, refillPerSecond }) });
  const identity = store.identities.create("Owning Agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms, identity };
}

const createArgs = (roomId = "agent-den") => ({
  roomId, title: "Agent Den", purpose: "A room owned by an agent, for agent things.",
  kind: "personal", displayName: "Den Keeper"
});

const attempt = (rooms, secret, args) => {
  try { return { ok: true, result: rooms.create(secret, args) }; }
  catch (error) { return { ok: false, status: error.status, code: error.code }; }
};

test("an identical retry does not spend creation budget", t => {
  const { rooms, identity } = setup(t);

  const first = rooms.create(identity.secret, createArgs());
  assert.equal(first.duplicate, false, "the first call really creates the room");

  // A client whose response was dropped retries. Twice, because that is what a
  // retry policy does.
  for (const attemptNumber of [1, 2]) {
    const replay = rooms.create(identity.secret, createArgs());
    assert.equal(replay.duplicate, true, `retry ${attemptNumber} is recognised as the same request`);
  }

  // One room created out of a budget of three, so two creations must remain.
  const second = attempt(rooms, identity.secret, createArgs("agent-den-two"));
  assert.equal(second.ok, true, `a second room is still allowed, got ${second.code}`);
  const third = attempt(rooms, identity.secret, createArgs("agent-den-three"));
  assert.equal(third.ok, true, `a third room is still allowed, got ${third.code}`);

  // And the budget is still a budget: the fourth real creation is refused.
  const fourth = attempt(rooms, identity.secret, createArgs("agent-den-four"));
  assert.equal(fourth.ok, false);
  assert.equal(fourth.status, 429);
  assert.equal(fourth.code, "rate_limited");
});

test("the budget still counts rooms that were actually created", t => {
  const { rooms, identity } = setup(t, { capacity: 1, refillPerSecond: 1 / 86400 });
  assert.equal(rooms.create(identity.secret, createArgs("one")).duplicate, false);
  const refused = attempt(rooms, identity.secret, createArgs("two"));
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 429, "a second distinct room is over a capacity of one");
});

test("a replay is free even when the budget is already exhausted", t => {
  const { rooms, identity } = setup(t, { capacity: 1, refillPerSecond: 1 / 86400 });
  rooms.create(identity.secret, createArgs("one"));
  // No tokens left, but this creates nothing, so it must still answer.
  const replay = rooms.create(identity.secret, createArgs("one"));
  assert.equal(replay.duplicate, true, "an idempotent retry must not be rate limited");
  assert.equal(replay.roomId, "one");
});

test("claiming a room id that belongs to someone else is refused and costs nothing", t => {
  const { store, rooms, identity } = setup(t, { capacity: 1, refillPerSecond: 1 / 86400 });
  const other = store.identities.create("Another Agent");
  rooms.create(other.secret, createArgs("taken"));

  const conflict = attempt(rooms, identity.secret, createArgs("taken"));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, "room_exists");

  // Nothing was created, so this identity's single token is untouched.
  assert.equal(attempt(rooms, identity.secret, createArgs("mine")).ok, true);
});

test("an unknown secret is rejected before any budget is considered", t => {
  const { rooms, identity } = setup(t, { capacity: 1, refillPerSecond: 1 / 86400 });
  const denied = attempt(rooms, "pri_not-a-real-secret", createArgs("nope"));
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 401);
  assert.equal(attempt(rooms, identity.secret, createArgs("mine")).ok, true, "a stranger cannot drain another identity's budget");
});
