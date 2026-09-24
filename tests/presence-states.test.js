// #660: agent presence and working states.
// Pure helper tests (no DB) + store.presence() integration tests.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  presenceState,
  PRESENCE_LIVE_WINDOW_MS,
  PRESENCE_WORKING_WINDOW_MS,
  PRESENCE_IDLE_WINDOW_MS,
  PRESENCE_UNREACHABLE_AFTER_MS,
} from "../src/presence-state.js";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";

// ---------------------------------------------------------------------------
// Pure helper: presenceState()
// ---------------------------------------------------------------------------

const NOW = 1_000_000_000_000;
const min = 60_000;

test("presenceState: active session -> working", () => {
  assert.equal(presenceState({ kind: "agent", hasActiveSession: true, now: NOW }), "working");
  assert.equal(presenceState({ kind: "human", hasActiveSession: true, now: NOW }), "working");
});

test("presenceState: agent with live host + recent command -> working", () => {
  assert.equal(presenceState({
    kind: "agent", hasActiveSession: false,
    hostStatus: "online", hostLastSeenAt: NOW - 2 * min, lastCommandAt: NOW - 2 * min,
    now: NOW,
  }), "working");
});

test("presenceState: agent with live host but stale command -> not working", () => {
  // Host is live but the agent hasn't issued a command recently: listening.
  assert.equal(presenceState({
    kind: "agent", hasActiveSession: false,
    hostStatus: "online", hostLastSeenAt: NOW - 2 * min, lastCommandAt: NOW - 30 * min,
    now: NOW,
  }), "listening");
});

test("presenceState: watching -> listening", () => {
  assert.equal(presenceState({ kind: "agent", watching: true, now: NOW }), "listening");
  assert.equal(presenceState({ kind: "human", watching: true, now: NOW }), "listening");
});

test("presenceState: host heartbeat within live window -> listening", () => {
  assert.equal(presenceState({
    kind: "agent", hostStatus: "offline", hostLastSeenAt: NOW - 3 * min, now: NOW,
  }), "listening");
});

test("presenceState: human command within live window -> listening", () => {
  assert.equal(presenceState({
    kind: "human", lastCommandAt: NOW - 3 * min, now: NOW,
  }), "listening");
});

test("presenceState: seen within idle window, no live signal -> idle", () => {
  assert.equal(presenceState({
    kind: "agent", lastSeenAt: NOW - 30 * min, now: NOW,
  }), "idle");
  assert.equal(presenceState({
    kind: "human", lastSeenAt: NOW - 30 * min, lastCommandAt: NOW - 30 * min, now: NOW,
  }), "idle");
});

test("presenceState: agent with registered host, gone 2h -> unreachable", () => {
  assert.equal(presenceState({
    kind: "agent", hostStatus: "offline",
    hostLastSeenAt: NOW - 120 * min, lastSeenAt: NOW - 120 * min,
    now: NOW,
  }), "unreachable");
});

test("presenceState: human, gone 2h -> idle (never unreachable)", () => {
  assert.equal(presenceState({
    kind: "human", lastSeenAt: NOW - 120 * min, lastCommandAt: NOW - 120 * min,
    now: NOW,
  }), "idle");
});

test("presenceState: unregistered agent host (null status), gone 2h -> idle", () => {
  // No registered host: we cannot say "down", so idle — and the presence
  // object stays null per the RC-051 contract (tested at the store level).
  assert.equal(presenceState({
    kind: "agent", hostStatus: null, lastSeenAt: NOW - 120 * min, now: NOW,
  }), "idle");
});

test("presenceState: custom unreachable threshold (3x heartbeat interval)", () => {
  // A 10-minute heartbeat interval gives a 30-minute unreachable threshold.
  assert.equal(presenceState({
    kind: "agent", hostStatus: "offline",
    lastSeenAt: NOW - 45 * min, unreachableAfterMs: 30 * min, now: NOW,
  }), "unreachable");
  assert.equal(presenceState({
    kind: "agent", hostStatus: "offline",
    lastSeenAt: NOW - 20 * min, unreachableAfterMs: 30 * min, now: NOW,
  }), "idle");
});

test("presenceState: thresholds are the documented constants", () => {
  assert.equal(PRESENCE_LIVE_WINDOW_MS, 5 * 60 * 1000);
  assert.equal(PRESENCE_WORKING_WINDOW_MS, 5 * 60 * 1000);
  assert.equal(PRESENCE_IDLE_WINDOW_MS, 60 * 60 * 1000);
  assert.equal(PRESENCE_UNREACHABLE_AFTER_MS, 60 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// Integration: store.presence()
// ---------------------------------------------------------------------------

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-presence-states-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  return { store, ownerKey };
}

const byId = (members, id) => members.find(m => m.memberId === id);

test("presence: additive fields present, existing fields unchanged", () => {
  const { store, ownerKey } = serve(test);
  const { members } = store.presence(ownerKey, "commons", []);
  assert.ok(members.length >= 1);
  for (const m of members) {
    // Existing fields (byte-identical contract).
    assert.equal(typeof m.memberId, "string");
    assert.equal(typeof m.displayName, "string");
    assert.equal(typeof m.kind, "string");
    assert.equal(typeof m.watching, "boolean");
    assert.ok(Array.isArray(m.workingOn));
    assert.ok("lastSeenAt" in m);
    assert.ok("statusMessage" in m);
    assert.ok("presence" in m);
    // #660 additive fields.
    assert.ok(["working", "listening", "idle", "unreachable"].includes(m.state), `state=${m.state}`);
    assert.equal(typeof m.isOwner, "boolean");
    assert.ok(Array.isArray(m.scopes));
    assert.ok("ownerIdentityId" in m);
  }
});

test("presence: owner projects isOwner=true, scopes mirror permissions", () => {
  const { store, ownerKey } = serve(test);
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent1", displayName: "Agent One", kind: "agent", permissions: ["accept_work", "complete_work"] },
  });
  const { members } = store.presence(ownerKey, "commons", []);
  const owner = byId(members, "owner");
  const agent = byId(members, "agent1");
  assert.equal(owner.isOwner, true);
  assert.equal(agent.isOwner, false);
  assert.deepEqual(agent.scopes, ["accept_work", "complete_work"]);
  assert.ok(Array.isArray(owner.scopes));
});

test("presence: member with active session -> working with workingOn", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-presence-states-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work", "complete_work"] },
  });
  // Graduated autonomy tiers: the fixture agent is operator-promoted so the
  // presence test exercises it as a working agent.
  setTier(store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.WORK_PROPOSED,
    data: { workItemId: "state-one", title: "State probe", definitionOfDone: "Seen", accountableMemberId: "agent", mode: "read" },
  });
  const agentKey = store.issueAccessKey("commons", "agent");
  const server = (await import("../server/http.mjs")).createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const started = await fetch(origin + "/api/rooms/commons/work-sessions", {
    method: "POST",
    headers: { Origin: origin, Authorization: `Bearer ${agentKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: randomUUID(), workItemId: "state-one", expectedRevision: 0, action: "set_status", status: "processing" }),
  });
  assert.equal(started.status, 201);
  const { members } = store.presence(agentKey, "commons", []);
  const agent = byId(members, "agent");
  assert.equal(agent.state, "working");
  assert.equal(agent.workingOn.length, 1);
  assert.equal(agent.workingOn[0].workItemId, "state-one");
});

test("presence: unregistered agent host keeps presence=null (RC-051 contract)", () => {
  const { store, ownerKey } = serve(test);
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work"] },
  });
  // No identity link and no host heartbeat: presence stays null, state is
  // derived from the remaining signals (idle — member.added is recent).
  const { members } = store.presence(ownerKey, "commons", []);
  const agent = byId(members, "agent");
  assert.equal(agent.presence, null);
  assert.equal(agent.ownerIdentityId, null);
  assert.ok(["idle", "listening"].includes(agent.state));
});

test("presence: agent with identity link projects ownerIdentityId", () => {
  const { store, ownerKey } = serve(test);
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work"] },
  });
  // Simulate an identity + link (normally created via the agent-identities API).
  store.db.prepare(
    "INSERT INTO agent_identities(identity_id, secret_hash, display_name, created_at) VALUES(?,?,?,?)"
  ).run("identity-abc-123", "hash-placeholder", "Test Agent Identity", Date.now());
  store.db.prepare(
    "INSERT INTO identity_links(room_id, identity_id, member_id, linked_at) VALUES(?,?,?,?)"
  ).run("commons", "identity-abc-123", "agent", Date.now());
  const { members } = store.presence(ownerKey, "commons", []);
  const agent = byId(members, "agent");
  assert.equal(agent.ownerIdentityId, "identity-abc-123");
  // No host ever reported: presence stays null (unregistered), never unreachable.
  assert.equal(agent.presence, null);
  assert.notEqual(agent.state, "unreachable");
});

test("presence: human never shows unreachable", () => {
  const { store, ownerKey } = serve(test);
  const { members } = store.presence(ownerKey, "commons", []);
  for (const m of members) {
    if (m.kind === "human") assert.notEqual(m.state, "unreachable");
  }
});
