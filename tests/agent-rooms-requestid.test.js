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
import { createWork } from "../server/work-claims.mjs";
import { EVENT_TYPES as T, replay } from "../src/events.js";

// PRODUCT-200 B7: POST /api/agent-rooms accepts an optional client-generated
// requestId as an idempotency key. The client-supplied roomId already serves
// as one, but a create that lets the server mint the room id (the auto-slug
// path) has no retry key: a dropped response retried with fresh params mints
// a second room. requestId closes that hole.

function setup(t, { capacity = 1000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-agent-rooms-requestid-"));
  let store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  ensureAgentRoomRequestIdColumn(store.db);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity, refillPerSecond: capacity })
  });
  const identity = store.identities.create("Owning Agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms, identity, reopen() {
    store.close();
    store = new RoomStore(join(directory, "room.sqlite"));
    return { store, rooms: new AgentRooms(store) };
  } };
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

// Both keys identify the complete normalized create request, including whether
// it seeds a starter. A conflicting replay must not look like a success.
for (const key of ["requestId", "roomId"]) {
  for (const [firstStarter, retryStarter] of [[false, true], [true, false], [false, undefined], [undefined, false]]) {
    test(`${key} rejects a starter change from ${firstStarter} to ${retryStarter}`, t => {
      const { store, rooms, identity } = setup(t);
      const args = createArgs({ [key]: "starter-retry", ...(firstStarter === undefined ? {} : { starter: firstStarter }) });
      const first = rooms.create(identity.secret, args);
      const before = store.room(first.roomId).sequence;
      const retryArgs = { ...args };
      if (retryStarter === undefined) delete retryArgs.starter;
      else retryArgs.starter = retryStarter;
      assert.throws(() => rooms.create(identity.secret, retryArgs),
        error => error.status === 409 && error.code === (key === "requestId" ? "request_conflict" : "room_exists"));
      assert.equal(roomCount(store), 1);
      assert.equal(store.room(first.roomId).sequence, before, "a rejected retry leaves room events unchanged");
      assert.equal(Boolean(store.workClaims.get(first.roomId, "starter")), firstStarter !== false);
    });
  }
  for (const [firstStarter, retryStarter] of [[false, false], [true, true], [true, undefined], [undefined, true]]) {
    test(`${key} accepts equivalent starter values ${firstStarter} and ${retryStarter}`, t => {
      const { store, rooms, identity } = setup(t);
      const args = createArgs({ [key]: "starter-retry", ...(firstStarter === undefined ? {} : { starter: firstStarter }) });
      const first = rooms.create(identity.secret, args);
      const before = store.room(first.roomId).sequence;
      const retryArgs = { ...args };
      if (retryStarter === undefined) delete retryArgs.starter;
      else retryArgs.starter = retryStarter;
      const retry = rooms.create(identity.secret, retryArgs);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.roomId, first.roomId);
      assert.deepEqual(retry.starter, first.starter);
      assert.equal(roomCount(store), 1);
      assert.equal(store.room(first.roomId).sequence, before, "an identical retry creates no room events");
    });
  }
}

for (const key of ["requestId", "roomId"]) {
  for (const starter of [false, true]) {
    test(`${key} preserves starter:${starter} intent across board edits, replay and reopen`, t => {
      const fixture = setup(t);
      const { store, rooms, identity } = fixture;
      const args = createArgs({ [key]: "starter-history", starter });
      const first = rooms.create(identity.secret, args);
      if (starter) store.workClaims.delete(first.roomId, "starter");
      else store.workClaims.set(first.roomId, createWork({ id: "starter", title: "A later task" }, { now: store.now(), agentId: identity.identityId }));
      // Generic settings commands refuse creation metadata. Ordinary settings
      // updates must preserve it too.
      assert.throws(() => store.command(identity.secret, first.roomId, {
        id: "starter-tamper", type: T.ROOM_POLICY_SET,
        data: { requireIndependentReview: false, requireOwnerDecision: false, agentStarterRequested: !starter }
      }), error => error.status === 422 && error.code === "invalid_command");
      store.command(identity.secret, first.roomId, {
        id: "starter-settings", type: T.ROOM_POLICY_SET,
        data: { requireIndependentReview: false, requireOwnerDecision: false }
      });
      const events = store.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence").all(first.roomId).map(row => JSON.parse(row.body));
      assert.equal(replay(events).room.agentStarterRequested, starter);
      assert.equal(store.room(first.roomId).state.room.agentStarterRequested, starter);
      const reopened = fixture.reopen();
      const retry = reopened.rooms.create(identity.secret, args);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.roomId, first.roomId);
      assert.equal(Boolean(retry.starter), !starter, "the response still describes the current board");
      assert.throws(() => reopened.rooms.create(identity.secret, { ...args, starter: !starter }),
        error => error.status === 409 && error.code === (key === "requestId" ? "request_conflict" : "room_exists"));
      assert.equal(roomCount(reopened.store), 1);
    });
  }
  test(`${key} preserves legacy replay behavior when creation intent is absent`, t => {
    const { store, rooms, identity } = setup(t);
    const roomId = "legacy-agent-room";
    const args = createArgs({ [key]: key === "roomId" ? roomId : "legacy-request" });
    const events = initialRoom(roomId, identity.identityId);
    Object.assign(events[0].data, { title: args.title, purpose: args.purpose, kind: args.kind });
    Object.assign(events[1].data, { displayName: args.displayName, kind: "agent", identityId: identity.identityId });
    store.initialize(events);
    store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
      .run(roomId, identity.identityId, identity.identityId, store.now());
    store.db.prepare("INSERT INTO agent_room_ownership(identity_id,room_id,created_at,request_id) VALUES(?,?,?,?)")
      .run(identity.identityId, roomId, store.now(), args.requestId ?? null);
    assert.equal(store.room(roomId).state.room.agentStarterRequested, undefined);
    for (const starter of [false, true]) {
      const retry = rooms.create(identity.secret, { ...args, starter });
      assert.equal(retry.duplicate, true);
      assert.equal(retry.roomId, roomId);
      assert.equal(retry.starter, null, "a legacy retry must not seed a missing task");
    }
    assert.equal(roomCount(store), 1);
  });
}
