// 200-hard-tasks #88: channel permission matrix.
//
// Exhaustively pins the role×action permission grid for room channels:
//   actions — channel.create / channel.rename / channel.archive
//   roles   — room owner, human member, agent member, zero-permission member,
//             revoked member (active:false), non-member (never enrolled)
// at two enforcement levels:
//   L1 reducer (src/events.js applyEvent): owner-only rename/archive;
//      create is membership-gated only (no permission-bit check).
//   L2 store.command tier gate (server/autonomy-tiers.mjs): a t1_readonly
//      agent is refused 403 agent_readonly on all three commands; a
//      t2_standard agent follows the reducer grid exactly.
//
// If any cell of this grid changes intentionally, the matrix — not the
// behavior — is the thing to update; until then every cell is pinned.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVENT_TYPES as T,
  DEFAULT_CHANNEL_ID,
  applyEvent,
  replay,
} from "../src/events.js";
import { seedEvents } from "../src/seed.js";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { demoteToReadonly } from "../server/autonomy-tiers.mjs";

const ROOM_ID = "room-project-room-v0";
const AT = "2026-10-07T16:00:00.000Z";

let n = 0;
const evt = (type, actorId, data) => ({
  id: `chpm-${++n}-${randomUUID()}`,
  idempotencyKey: `chpm-key-${n}`,
  roomId: ROOM_ID,
  type,
  actorId,
  at: AT,
  causationId: null,
  data,
});

const addMember = (id, kind, permissions = []) =>
  evt(T.MEMBER_ADDED, "potter", { memberId: id, displayName: id, kind, permissions });

// Reducer-level fixture: seed + one member per role + one channel owned by
// the room owner to serve as the rename/archive target.
function reducerState() {
  let state = replay(seedEvents);
  state = applyEvent(state, addMember("bare", "human", []));
  state = applyEvent(state, addMember("doomed", "human", []));
  const rev = state.members.doomed.revision;
  state = applyEvent(state, evt(T.MEMBER_ACCESS_CHANGED, "potter", {
    memberId: "doomed",
    expectedMemberRevision: rev,
    permissions: [],
    active: false,
  }));
  state = applyEvent(state, evt(T.CHANNEL_CREATED, "potter", { channelId: "ch-ops", name: "ops" }));
  return state;
}

const create = (actor, name) => evt(T.CHANNEL_CREATED, actor, { channelId: `ch-${name}`, name });
const rename = (actor, channelId, name) => evt(T.CHANNEL_RENAMED, actor, { channelId, name });
const archive = (actor, channelId) => evt(T.CHANNEL_ARCHIVED, actor, { channelId });

const failsWith = (state, event, message) =>
  assert.throws(() => applyEvent(state, event), new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

// ---------------------------------------------------------------- L1 matrix

test("L1: the room owner may create, rename and archive channels", () => {
  let state = applyEvent(reducerState(), create("potter", "owner-made"));
  assert.ok(state.channels["ch-owner-made"]);
  state = applyEvent(state, rename("potter", "ch-ops", "renamed"));
  assert.equal(state.channels["ch-ops"].name, "renamed");
  state = applyEvent(state, archive("potter", "ch-ops"));
  assert.ok(state.channels["ch-ops"].archivedAt);
});

test("L1: a human member may create channels but not rename or archive", () => {
  let state = applyEvent(reducerState(), create("maya", "maya-made"));
  assert.ok(state.channels["ch-maya-made"]);
  failsWith(state, rename("maya", "ch-ops", "hijacked"), "Only the Room owner may manage channels");
  failsWith(state, archive("maya", "ch-ops"), "Only the Room owner may manage channels");
  // The denied attempts left the channel untouched.
  assert.equal(state.channels["ch-ops"].name, "ops");
  assert.equal(state.channels["ch-ops"].archivedAt, null);
});

test("L1: an agent member may create channels but not rename or archive", () => {
  let state = applyEvent(reducerState(), create("codex", "codex-made"));
  assert.ok(state.channels["ch-codex-made"]);
  failsWith(state, rename("codex", "ch-ops", "hijacked"), "Only the Room owner may manage channels");
  failsWith(state, archive("codex", "ch-ops"), "Only the Room owner may manage channels");
});

test("L1: a zero-permission member keeps the create right (membership gate, not bit gate)", () => {
  let state = applyEvent(reducerState(), create("bare", "bare-made"));
  assert.ok(state.channels["ch-bare-made"]);
  failsWith(state, rename("bare", "ch-ops", "hijacked"), "Only the Room owner may manage channels");
  failsWith(state, archive("bare", "ch-ops"), "Only the Room owner may manage channels");
});

test("L1: a revoked member (active:false) is refused every channel action", () => {
  const state = reducerState();
  assert.equal(state.members.doomed.active, false);
  failsWith(state, create("doomed", "ghost"), "Member access revoked");
  failsWith(state, rename("doomed", "ch-ops", "hijacked"), "Member access revoked");
  failsWith(state, archive("doomed", "ch-ops"), "Member access revoked");
});

test("L1: a non-member is refused every channel action", () => {
  const state = reducerState();
  failsWith(state, create("outsider", "intrusion"), "Unknown member: outsider");
  failsWith(state, rename("outsider", "ch-ops", "hijacked"), "Unknown member: outsider");
  failsWith(state, archive("outsider", "ch-ops"), "Unknown member: outsider");
});

test("L1: channel guardrails — unknown channel, archived channel, main channel, duplicate name", () => {
  let state = reducerState();
  // Rename/archive of an unknown channel is refused for the owner too.
  failsWith(state, rename("potter", "ch-missing", "x"), "Unknown channel");
  failsWith(state, archive("potter", "ch-missing"), "Unknown channel");
  // An archived channel can no longer be renamed.
  state = applyEvent(state, archive("potter", "ch-ops"));
  failsWith(state, rename("potter", "ch-ops", "late"), "Channel is archived");
  // The main channel can be renamed by the owner but never archived.
  state = applyEvent(state, rename("potter", DEFAULT_CHANNEL_ID, "lobby"));
  assert.equal(state.channels[DEFAULT_CHANNEL_ID].name, "lobby");
  failsWith(state, archive("potter", DEFAULT_CHANNEL_ID), "The main channel can't be archived");
  // Names are unique across the room.
  failsWith(state, create("potter", "lobby"), "Channel name is taken");
});

// ------------------------------------------------------------ L2 tier level

function storeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "chpm-store-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.parse("2026-10-07T16:00:00Z") });
  store.initialize(initialRoom("commons"));
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data) =>
    store.command(keys[actor], "commons", { id: randomUUID(), type, data });
  send("owner", T.MEMBER_ADDED, { memberId: "human", displayName: "Human member", kind: "human", permissions: ["accept_work"] });
  send("owner", T.MEMBER_ADDED, { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work"], accountableHumanId: "owner" });
  keys.human = store.issueAccessKey("commons", "human");
  keys.agent = store.issueAccessKey("commons", "agent");
  // An owner-owned channel to serve as the rename/archive target.
  send("owner", T.CHANNEL_CREATED, { channelId: "ch-ops", name: "ops" });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, keys, send };
}

const capture = (fn) => { try { fn(); } catch (error) { return error; } throw new Error("expected the function to throw"); };

test("L2: a t2_standard agent keeps the reducer grid through store.command", t => {
  const f = storeFixture(t);
  f.send("agent", T.CHANNEL_CREATED, { channelId: "ch-agent-made", name: "agent-made" });
  const renameRefused = capture(() => f.send("agent", T.CHANNEL_RENAMED, { channelId: "ch-ops", name: "hijacked" }));
  assert.equal(renameRefused.status, 422);
  assert.equal(renameRefused.code, "command_rejected");
  assert.match(renameRefused.message, /Only the Room owner may manage channels/);
  const archiveRefused = capture(() => f.send("agent", T.CHANNEL_ARCHIVED, { channelId: "ch-ops" }));
  assert.equal(archiveRefused.status, 422);
  assert.equal(archiveRefused.code, "command_rejected");
  assert.match(archiveRefused.message, /Only the Room owner may manage channels/);
});

test("L2: a t2_standard human member may create channels but not rename or archive", t => {
  const f = storeFixture(t);
  f.send("human", T.CHANNEL_CREATED, { channelId: "ch-human-made", name: "human-made" });
  const renameRefused = capture(() => f.send("human", T.CHANNEL_RENAMED, { channelId: "ch-ops", name: "hijacked" }));
  assert.equal(renameRefused.code, "command_rejected");
  const archiveRefused = capture(() => f.send("human", T.CHANNEL_ARCHIVED, { channelId: "ch-ops" }));
  assert.equal(archiveRefused.code, "command_rejected");
});

test("L2: a t1_readonly agent is refused 403 agent_readonly on every channel command", t => {
  const f = storeFixture(t);
  demoteToReadonly(f.store.db, "commons", "agent", { updatedBy: "owner", nowMs: Date.now() });
  for (const [type, data] of [
    [T.CHANNEL_CREATED, { channelId: "ch-readonly-try", name: "readonly-try" }],
    [T.CHANNEL_RENAMED, { channelId: "ch-ops", name: "hijacked" }],
    [T.CHANNEL_ARCHIVED, { channelId: "ch-ops" }],
  ]) {
    const refused = capture(() => f.send("agent", type, data));
    assert.equal(refused.status, 403, `${type} should be 403`);
    assert.equal(refused.code, "agent_readonly", `${type} should be agent_readonly`);
  }
  // Nothing landed: the refused create left no channel behind.
  const room = f.store.room("commons");
  assert.ok(!room.state.channels["ch-readonly-try"]);
  assert.equal(room.state.channels["ch-ops"].archivedAt, null);
});

test("L2: demoting an agent to t1_readonly wins on its very next command", t => {
  const f = storeFixture(t);
  // Before demotion the agent can create (reducer grid).
  f.send("agent", T.CHANNEL_CREATED, { channelId: "ch-before-demote", name: "before-demote" });
  demoteToReadonly(f.store.db, "commons", "agent", { updatedBy: "owner", nowMs: Date.now() });
  const refused = capture(() => f.send("agent", T.CHANNEL_CREATED, { channelId: "ch-after-demote", name: "after-demote" }));
  assert.equal(refused.code, "agent_readonly");
});
