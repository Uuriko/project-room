// Room mode (ROADBLOCKS dev-mode slice 1): a room-level `mode` field —
// "production" (default) or "lab" — set ONLY at creation and only when the
// server env flag ROOM_LAB_MODE_ENABLED is exactly "1" (default OFF).
// Mode is immutable after creation: no event, command, replayed create or
// history import can flip a room that has history. Read models expose the
// mode; a room whose stored projection has no mode reads as "production"
// everywhere. This slice changes NO behaviour beyond creation + read.
//
// Critic cures (ROADBLOCKS Part 5, F1/F3/F4):
// - F1: importEvents refuses a log whose resolved mode differs from the
//   room's existing mode (422 invalid_import) — the import door could
//   otherwise flip any room in either direction with no flag check.
// - F3: a lab room's id must carry the `lab-` prefix at creation, on both
//   creation paths (same 422 invalid_room_request refusal shape).
// - F4: the creation paths read the arm through the store's featureEnv
//   bag (the codebase's featureEnv(store) pattern) when the store carries
//   one, falling back to process.env — never process.env alone.
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

// Creation paths read the flag from the server's env bag (the store's
// featureEnv when it carries one, else the process env); tests flip the
// process env inside a scoped block and always restore it.
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
const accountRequest = (overrides = {}) => ({ roomId: "lab-mode-room", title: "Mode room", purpose: "Plan the pilot", kind: "personal", displayName: "Admin", ...overrides });

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
  assert.equal(f.store.room("lab-mode-room").state.room.mode, "lab", "the projection carries the mode");
  assert.equal(roomMode(f.store.room("lab-mode-room").state.room), "lab");

  // Idempotent replay with the same mode returns the room; a replay naming
  // a different mode is the flip attempt and is refused as a conflict.
  const replay = withLabFlag("1", () => f.store.createAccountRoom(admin.token, admin.binding, accountRequest({ mode: "lab" })));
  assert.equal(replay.duplicate, true); assert.equal(replay.room.mode, "lab");
  assert.throws(() => withLabFlag("1", () => f.store.createAccountRoom(admin.token, admin.binding, accountRequest({}))),
    { status: 409, code: "room_exists" }, "replaying the create without lab must not silently flip the room to production");
  assert.equal(f.store.room("lab-mode-room").state.room.mode, "lab");

  // Default create (no mode field) is production, flag on or off.
  const plain = withLabFlag(undefined, () => f.store.createAccountRoom(admin.token, admin.binding, accountRequest({ roomId: "plain-room" })));
  assert.equal(plain.room.mode, "production");
  assert.equal(roomMode(f.store.room("plain-room").state.room), "production");

  // The account read model lists the mode for every room, old rooms included.
  const listed = Object.fromEntries(f.store.accountRooms(admin.token, admin.binding).rooms.map(room => [room.id, room.mode]));
  assert.deepEqual(listed, { commons: "production", "lab-mode-room": "lab", "plain-room": "production" });
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
const agentRequest = (overrides = {}) => ({ roomId: "lab-mode-den", title: "Mode Den", purpose: "A room for mode tests.", kind: "personal", displayName: "Den Keeper", ...overrides });

test("agent rooms: lab requires the flag, mode is stored and listed, and a replay cannot flip it", t => {
  const { store, rooms, identity } = agentSetup(t);
  withLabFlag(undefined, () => {
    assert.throws(() => rooms.create(identity.secret, agentRequest({ mode: "lab" })),
      { status: 422, code: "invalid_room_request" }, "flag off: requesting lab is refused, not coerced");
  });
  assert.equal(store.db.prepare("SELECT 1 FROM rooms WHERE id='lab-mode-den'").get(), undefined, "the refused create wrote no room");

  const created = withLabFlag("1", () => rooms.create(identity.secret, agentRequest({ mode: "lab" })));
  assert.equal(created.mode, "lab"); assert.equal(created.duplicate, false);
  assert.equal(store.room("lab-mode-den").state.room.mode, "lab");

  const replay = withLabFlag("1", () => rooms.create(identity.secret, agentRequest({ mode: "lab" })));
  assert.equal(replay.duplicate, true); assert.equal(replay.mode, "lab");
  assert.throws(() => withLabFlag("1", () => rooms.create(identity.secret, agentRequest({}))),
    { status: 409, code: "room_exists" }, "replaying the create without lab must not flip the room to production");
  assert.equal(store.room("lab-mode-den").state.room.mode, "lab");

  const plain = withLabFlag(undefined, () => rooms.create(identity.secret, agentRequest({ roomId: "plain-den" })));
  assert.equal(plain.mode, "production");

  const listed = Object.fromEntries(rooms.list(identity.secret).rooms.map(room => [room.roomId, room.mode]));
  assert.equal(listed["lab-mode-den"], "lab");
  assert.equal(listed["plain-den"], "production");
});

test("lab prefix (F3): a lab room id must start with lab- on both creation paths", t => {
  const { f, admin } = accountSetup(t);
  const roomsBefore = f.store.db.prepare("SELECT count(*) AS n FROM rooms").get().n;
  withLabFlag("1", () => {
    assert.throws(() => f.store.createAccountRoom(admin.token, admin.binding, accountRequest({ roomId: "unmarked-room", mode: "lab" })),
      { status: 422, code: "invalid_room_request" }, "account path: lab under an unmarked id is refused even with the flag on");
  });
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM rooms").get().n, roomsBefore, "the refused create wrote no room");
  const marked = withLabFlag("1", () => f.store.createAccountRoom(admin.token, admin.binding, accountRequest({ roomId: "lab-marked-room", mode: "lab" })));
  assert.equal(marked.room.mode, "lab", "account path: a lab- id creates the lab room");

  const agent = agentSetup(t);
  withLabFlag("1", () => {
    assert.throws(() => agent.rooms.create(agent.identity.secret, agentRequest({ roomId: "unmarked-den", mode: "lab" })),
      { status: 422, code: "invalid_room_request" }, "agent path: lab under an unmarked id is refused even with the flag on");
    // A lab request that lets the server slug the id from the title is
    // refused the same way: the derived id carries no lab- prefix.
    const { roomId, ...noId } = agentRequest({ mode: "lab" });
    assert.throws(() => agent.rooms.create(agent.identity.secret, noId),
      { status: 422, code: "invalid_room_request" }, "agent path: a server-derived id cannot be a lab id");
  });
  assert.equal(agent.store.db.prepare("SELECT 1 FROM rooms WHERE id='unmarked-den'").get(), undefined, "the refused create wrote no room");
  const markedDen = withLabFlag("1", () => agent.rooms.create(agent.identity.secret, agentRequest({ roomId: "lab-marked-den", mode: "lab" })));
  assert.equal(markedDen.mode, "lab", "agent path: a lab- id creates the lab room");

  // The resolver itself pins the rule when an id is supplied.
  assert.throws(() => requestedRoomMode("lab", { ROOM_LAB_MODE_ENABLED: "1" }, "unmarked"),
    { status: 422, code: "invalid_room_request" });
  assert.equal(requestedRoomMode("lab", { ROOM_LAB_MODE_ENABLED: "1" }, "lab-marked"), "lab");
  assert.equal(requestedRoomMode("production", {}, "unmarked"), "production", "the prefix binds lab requests only");
});

test("featureEnv (F4): the creation paths read the arm through the store's featureEnv bag", t => {
  const bag = { ROOM_LAB_MODE_ENABLED: "1" };
  assert.equal(bag.ROOM_LAB_MODE_ENABLED, "1");

  const { f, admin } = accountSetup(t);
  f.store.featureEnv = { ROOM_LAB_MODE_ENABLED: "1" };
  const viaBag = withLabFlag(undefined, () => f.store.createAccountRoom(admin.token, admin.binding, accountRequest({ roomId: "lab-bag-room", mode: "lab" })));
  assert.equal(viaBag.room.mode, "lab", "account path: armed by the featureEnv bag with process.env unset (the Worker arming route)");
  f.store.featureEnv = {};
  assert.throws(() => withLabFlag("1", () => f.store.createAccountRoom(admin.token, admin.binding, accountRequest({ roomId: "lab-bag-two", mode: "lab" }))),
    { status: 422, code: "invalid_room_request" }, "account path: a featureEnv bag without the flag wins over process.env — the bag replaces, not merges");
  delete f.store.featureEnv;

  const agent = agentSetup(t);
  agent.store.featureEnv = { ROOM_LAB_MODE_ENABLED: "1" };
  const viaBagDen = withLabFlag(undefined, () => agent.rooms.create(agent.identity.secret, agentRequest({ roomId: "lab-bag-den", mode: "lab" })));
  assert.equal(viaBagDen.mode, "lab", "agent path: armed by the featureEnv bag with process.env unset");
  agent.store.featureEnv = {};
  assert.throws(() => withLabFlag("1", () => agent.rooms.create(agent.identity.secret, agentRequest({ roomId: "lab-bag-den-two", mode: "lab" }))),
    { status: 422, code: "invalid_room_request" }, "agent path: a featureEnv bag without the flag wins over process.env");
  delete agent.store.featureEnv;
});

test("import (F1): a history import cannot flip a room's mode in either direction, and a mode-identical import still works", t => {
  const { store } = agentSetup(t);
  store.initialize(seed("prod-direct"));
  store.initialize(seed("lab-direct", { mode: "lab" }));
  const prodKey = store.issueAccessKey("prod-direct", owner);
  const labKey = store.issueAccessKey("lab-direct", owner);
  const cloneLines = (token, roomId) => [...store.exportEvents(token, roomId)]
    .map(line => ({ sequence: line.sequence, event: structuredClone(line.event) }));
  const withCreatedMode = (lines, mode) => lines.map(line => {
    if (line.event.type !== T.ROOM_CREATED) return line;
    const data = { ...line.event.data };
    if (mode === undefined) delete data.mode; else data.mode = mode;
    return { sequence: line.sequence, event: { ...line.event, data } };
  });

  // Mode-identical imports replay cleanly in both rooms.
  const prodLines = cloneLines(prodKey, "prod-direct");
  assert.equal(store.importEvents(prodKey, "prod-direct", prodLines).imported, prodLines.length);
  assert.equal(roomMode(store.room("prod-direct").state.room), "production");
  const labLines = cloneLines(labKey, "lab-direct");
  assert.equal(store.importEvents(labKey, "lab-direct", labLines).imported, labLines.length);
  assert.equal(store.room("lab-direct").state.room.mode, "lab");

  // Production -> lab: a crafted log whose room.created carries mode lab
  // is refused with the import path's existing conflict shape, and the
  // room's history and mode are untouched.
  assert.throws(() => store.importEvents(prodKey, "prod-direct", withCreatedMode(prodLines, "lab")),
    { status: 422, code: "invalid_import" }, "absent -> lab import flip is refused");
  assert.equal(roomMode(store.room("prod-direct").state.room), "production");
  assert.deepEqual(cloneLines(prodKey, "prod-direct").map(line => line.event.id), prodLines.map(line => line.event.id),
    "the refused import left the production room's history intact");

  // Lab -> production: a crafted log whose room.created drops the mode is
  // refused the same way; a lab room cannot be laundered by import.
  assert.throws(() => store.importEvents(labKey, "lab-direct", withCreatedMode(labLines, undefined)),
    { status: 422, code: "invalid_import" }, "lab -> absent (production) import flip is refused");
  assert.throws(() => store.importEvents(labKey, "lab-direct", withCreatedMode(labLines, "production")),
    { status: 422, code: "invalid_import" }, "lab -> production import flip is refused");
  assert.equal(store.room("lab-direct").state.room.mode, "lab");
  assert.deepEqual(cloneLines(labKey, "lab-direct").map(line => line.event.id), labLines.map(line => line.event.id),
    "the refused imports left the lab room's history intact");
});
