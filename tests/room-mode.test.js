// Room mode (ROADBLOCKS dev-mode slice 1): a room-level `mode` field —
// "production" (default) or "lab" — set ONLY at creation and only when the
// server env flag ROOM_LAB_MODE_ENABLED is exactly "1" (default OFF).
// Mode is immutable after creation: no event, command or replayed create
// can flip a room that has history. Read models expose the mode; a room
// whose stored projection has no mode reads as "production" everywhere.
// This slice changes NO behaviour beyond creation + read.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { applyEvent, emptyRoomState, event, EVENT_TYPES as T, PERMISSIONS, ROOM_MODES, roomMode } from "../src/events.js";
import { roomLabModeEnabled, requestedRoomMode } from "../server/room-mode.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";

const owner = "owner";
const seed = (roomId, extra = {}) => [
  event({ type: T.ROOM_CREATED, actorId: owner, roomId, data: { roomId, ownerId: owner, title: "Mode", purpose: "Synthetic mode test", ...extra } }),
  event({ type: T.MEMBER_ADDED, actorId: owner, roomId, data: { memberId: owner, displayName: "Room owner", kind: "human", permissions: [...PERMISSIONS] } })
];

// Creation paths read the flag from the process env (the server's env);
// tests flip it inside a scoped block and always restore it.
function withLabFlag(value, fn) {
  const before = process.env.ROOM_LAB_MODE_ENABLED;
  if (value === undefined) delete process.env.ROOM_LAB_MODE_ENABLED; else process.env.ROOM_LAB_MODE_ENABLED = value;
  try { return fn(); }
  finally {
    if (before === undefined) delete process.env.ROOM_LAB_MODE_ENABLED; else process.env.ROOM_LAB_MODE_ENABLED = before;
  }
}

test("reducer: mode is validated at creation, defaults to production, and cannot be set later", () => {
  assert.deepEqual([...ROOM_MODES], ["production", "lab"]);
  assert.equal(roomMode(undefined), "production");
  assert.equal(roomMode({}), "production", "a room from before the mode attribute reads as production");
  assert.equal(roomMode({ mode: "lab" }), "lab");
  assert.equal(roomMode({ mode: "staging" }), "production", "an unknown stored value never reads as lab");

  const plain = seed("r").reduce(applyEvent, emptyRoomState());
  assert.equal(Object.hasOwn(plain.room, "mode"), false, "creation without mode stores no mode key");
  assert.equal(roomMode(plain.room), "production");

  const lab = seed("l", { mode: "lab" }).reduce(applyEvent, emptyRoomState());
  assert.equal(lab.room.mode, "lab");
  assert.equal(roomMode(lab.room), "lab");

  assert.throws(() => seed("x", { mode: "staging" }).reduce(applyEvent, emptyRoomState()), /mode must be production or lab/);

  // Immutability: a second room.created naming a different mode is refused
  // by the existing already-exists guard; no later handler writes room.mode.
  for (const state of [plain, lab]) {
    assert.throws(() => applyEvent(state, event({ type: T.ROOM_CREATED, actorId: owner, roomId: state.room.id,
      data: { roomId: state.room.id, ownerId: owner, title: "Flip", purpose: "Flip attempt", mode: state.room.id === "l" ? "production" : "lab" } })),
      /Room already exists/);
    assert.equal(roomMode(state.room), state.room.id === "l" ? "lab" : "production");
  }
});

test("flag: ROOM_LAB_MODE_ENABLED is on only for exactly \"1\", and the request resolver refuses lab while off", () => {
  assert.equal(roomLabModeEnabled({}), false, "unset is OFF by default");
  assert.equal(roomLabModeEnabled({ ROOM_LAB_MODE_ENABLED: "0" }), false);
  assert.equal(roomLabModeEnabled({ ROOM_LAB_MODE_ENABLED: "true" }), false, "only \"1\" turns it on, as with ROOM_PER_ROOM_OBJECTS");
  assert.equal(roomLabModeEnabled({ ROOM_LAB_MODE_ENABLED: "1" }), true);

  assert.equal(requestedRoomMode(undefined, {}), "production", "no mode requested reads as the production default");
  assert.equal(requestedRoomMode("production", {}), "production");
  assert.equal(requestedRoomMode("lab", { ROOM_LAB_MODE_ENABLED: "1" }), "lab");
  // Refusal shape: the creation-field shape both room-creation paths already
  // use for an invalid kind — 422 invalid_room_request, never a silent coerce.
  assert.throws(() => requestedRoomMode("lab", {}), { status: 422, code: "invalid_room_request" });
  assert.throws(() => requestedRoomMode("lab", { ROOM_LAB_MODE_ENABLED: "0" }), { status: 422, code: "invalid_room_request" });
  assert.throws(() => requestedRoomMode("staging", { ROOM_LAB_MODE_ENABLED: "1" }), { status: 422, code: "invalid_room_request" });
  assert.throws(() => requestedRoomMode(null, { ROOM_LAB_MODE_ENABLED: "1" }), { status: 422, code: "invalid_room_request" });
});

function accountSetup(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const login = accountId => {
    const key = f.store.issueAccountAccessKey(accountId), slot = f.store.createAccountSessionSlot();
    const session = f.store.loginAccountSession(slot.token, key, 0);
    return { token: slot.token, binding: session.sessionBinding };
  };
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "admin", displayName: "Avery", kind: "human", permissions: ["manage_members"] } });
  f.store.createAccount("admin-account"); f.store.bindHumanAccount("commons", "admin", "admin-account");
  return { f, admin: login("admin-account") };
}
const accountRequest = (overrides = {}) => ({ roomId: "mode-room", title: "Mode room", purpose: "Plan the pilot", kind: "personal", displayName: "Admin", ...overrides });

test("account rooms: lab requires the flag, mode is stored and listed, and a replay cannot flip it", t => {
  const { f, admin } = accountSetup(t);
  const roomsBefore = f.store.db.prepare("SELECT count(*) AS n FROM rooms").get().n;

  withLabFlag(undefined, () => {
    assert.throws(() => f.store.createAccountRoom(admin.token, admin.binding, accountRequest({ mode: "lab" })),
      { status: 422, code: "invalid_room_request" }, "flag off (unset): requesting lab is refused, not coerced");
  });
  withLabFlag("0", () => {
    assert.throws(() => f.store.createAccountRoom(admin.token, admin.binding, accountRequest({ mode: "lab" })),
      { status: 422, code: "invalid_room_request" }, "flag off (\"0\"): requesting lab is refused");
  });
  assert.throws(() => withLabFlag("1", () => f.store.createAccountRoom(admin.token, admin.binding, accountRequest({ mode: "staging" }))),
    { status: 422, code: "invalid_room_request" }, "an unknown mode is refused even with the flag on");
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM rooms").get().n, roomsBefore, "refused creates wrote no room");

  const created = withLabFlag("1", () => f.store.createAccountRoom(admin.token, admin.binding, accountRequest({ mode: "lab" })));
  assert.equal(created.room.mode, "lab");
  assert.equal(created.duplicate, false);
  assert.equal(f.store.room("mode-room").state.room.mode, "lab", "the projection carries the mode");
  assert.equal(roomMode(f.store.room("mode-room").state.room), "lab");

  // Idempotent replay with the same mode returns the room; a replay naming
  // a different mode is the flip attempt and is refused as a conflict.
  const replay = withLabFlag("1", () => f.store.createAccountRoom(admin.token, admin.binding, accountRequest({ mode: "lab" })));
  assert.equal(replay.duplicate, true); assert.equal(replay.room.mode, "lab");
  assert.throws(() => withLabFlag("1", () => f.store.createAccountRoom(admin.token, admin.binding, accountRequest({}))),
    { status: 409, code: "room_exists" }, "replaying the create without lab must not silently flip the room to production");
  assert.equal(f.store.room("mode-room").state.room.mode, "lab");

  // Default create (no mode field) is production, flag on or off.
  const plain = withLabFlag(undefined, () => f.store.createAccountRoom(admin.token, admin.binding, accountRequest({ roomId: "plain-room" })));
  assert.equal(plain.room.mode, "production");
  assert.equal(roomMode(f.store.room("plain-room").state.room), "production");

  // The account read model lists the mode for every room, old rooms included.
  const listed = Object.fromEntries(f.store.accountRooms(admin.token, admin.binding).rooms.map(room => [room.id, room.mode]));
  assert.deepEqual(listed, { commons: "production", "mode-room": "lab", "plain-room": "production" });
});

function agentSetup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-mode-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, { rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  const identity = store.identities.create("Mode Agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms, identity };
}
const agentRequest = (overrides = {}) => ({ roomId: "mode-den", title: "Mode Den", purpose: "A room for mode tests.", kind: "personal", displayName: "Den Keeper", ...overrides });

test("agent rooms: lab requires the flag, mode is stored and listed, and a replay cannot flip it", t => {
  const { store, rooms, identity } = agentSetup(t);
  withLabFlag(undefined, () => {
    assert.throws(() => rooms.create(identity.secret, agentRequest({ mode: "lab" })),
      { status: 422, code: "invalid_room_request" }, "flag off: requesting lab is refused, not coerced");
  });
  assert.equal(store.db.prepare("SELECT 1 FROM rooms WHERE id='mode-den'").get(), undefined, "the refused create wrote no room");

  const created = withLabFlag("1", () => rooms.create(identity.secret, agentRequest({ mode: "lab" })));
  assert.equal(created.mode, "lab"); assert.equal(created.duplicate, false);
  assert.equal(store.room("mode-den").state.room.mode, "lab");

  const replay = withLabFlag("1", () => rooms.create(identity.secret, agentRequest({ mode: "lab" })));
  assert.equal(replay.duplicate, true); assert.equal(replay.mode, "lab");
  assert.throws(() => withLabFlag("1", () => rooms.create(identity.secret, agentRequest({}))),
    { status: 409, code: "room_exists" }, "replaying the create without lab must not flip the room to production");
  assert.equal(store.room("mode-den").state.room.mode, "lab");

  const plain = withLabFlag(undefined, () => rooms.create(identity.secret, agentRequest({ roomId: "plain-den" })));
  assert.equal(plain.mode, "production");

  const listed = Object.fromEntries(rooms.list(identity.secret).rooms.map(room => [room.roomId, room.mode]));
  assert.equal(listed["mode-den"], "lab");
  assert.equal(listed["plain-den"], "production");
});
