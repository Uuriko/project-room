// RRC §B: the room-create 429 names its budget. The limiter stays generic;
// the room-create call site states capacity, refill, per-identity scope and
// the wait, with a Retry-After header agreeing with the body. Successful
// creates and the rooms list expose the remaining budget up front, and the
// distinct pilot_limit 409 keeps its own copy.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema, AGENT_ROOM_CREATE_CAPACITY, AGENT_ROOM_CREATE_REFILL_PER_SECOND, roomCreateBudgetMessage, roomCreateBudgetView } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";

function setup(t, limiter) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-create-budget-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, { rateLimiter: limiter });
  const identity = store.identities.create("Budget Agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms, identity };
}

test("the budget message and view name capacity, refill and per-identity scope (pure)", () => {
  const message = roomCreateBudgetMessage(27851);
  assert.match(message, /room creation is limited to 3 rooms per identity/i);
  assert.match(message, /one room every 8 hours/);
  assert.match(message, /wait 27851 seconds/);
  const limiter = createRateLimiter({
    capacity: AGENT_ROOM_CREATE_CAPACITY, refillPerSecond: AGENT_ROOM_CREATE_REFILL_PER_SECOND
  });
  assert.deepEqual(roomCreateBudgetView(limiter, "identity-budget-view"),
    { capacity: 3, remaining: 3, refillSecondsPerToken: 28800, scope: "per-identity" });
  limiter.check("identity-budget-view");
  assert.equal(roomCreateBudgetView(limiter, "identity-budget-view").remaining, 2);
});

const args = roomId => ({
  roomId, title: `Room ${roomId}`, purpose: "Budget test room.", kind: "personal", displayName: "Budget Agent"
});

test("creates expose remaining budget; the 4th create's 429 names the budget, scope and wait", async t => {
  const limiter = createRateLimiter({
    capacity: AGENT_ROOM_CREATE_CAPACITY, refillPerSecond: AGENT_ROOM_CREATE_REFILL_PER_SECOND
  });
  const { rooms, identity } = setup(t, limiter);
  const first = rooms.create(identity.secret, args("budget-one"));
  assert.equal(first.createBudget.capacity, 3);
  assert.equal(first.createBudget.remaining, 2);
  assert.equal(first.createBudget.scope, "per-identity");
  assert.equal(first.createBudget.refillSecondsPerToken, 28800);
  assert.equal(rooms.create(identity.secret, args("budget-two")).createBudget.remaining, 1);
  assert.equal(rooms.create(identity.secret, args("budget-three")).createBudget.remaining, 0);
  // The rooms list carries the same up-front budget statement.
  assert.equal(rooms.list(identity.secret).createBudget.remaining, 0);

  let error;
  try { rooms.create(identity.secret, args("budget-four")); } catch (caught) { error = caught; }
  assert.ok(error, "the 4th create must be refused");
  assert.equal(error.status, 429);
  assert.equal(error.code, "rate_limited");
  assert.match(error.message, /room creation is limited to 3 rooms per identity/i);
  assert.match(error.message, /one room every 8 hours/);
  const wait = /wait (\d+) seconds/.exec(error.message);
  assert.ok(wait, "the body states the wait in seconds");
  assert.ok(Number(wait[1]) > 0 && Number(wait[1]) <= 28800);
  assert.equal(error.headers?.["Retry-After"], wait[1], "Retry-After agrees with the body");
  assert.doesNotMatch(error.message, /Bounded pilot capacity/);
});

test("the pilot_limit 409 keeps its own copy and cannot be confused with the budget 429", async t => {
  const limiter = createRateLimiter({ capacity: 1000, refillPerSecond: 1000 });
  const { store, rooms, identity } = setup(t, limiter);
  const insert = store.db.prepare(
    "INSERT INTO agent_room_ownership(identity_id, room_id, created_at, request_id) VALUES(?,?,?,?)");
  for (let i = 0; i < 100; i += 1) insert.run(identity.identityId, `prior-room-${i}`, Date.now(), null);
  assert.throws(() => rooms.create(identity.secret, args("one-room-too-many")),
    err => err.status === 409 && err.code === "pilot_limit"
      && err.message === "Bounded pilot capacity reached; no room was created");
});
