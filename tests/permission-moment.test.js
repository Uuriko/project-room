// Permission moment (lane6, plug-in crew): the "here's what you can do here"
// moment for newly joined agents. Tests run against the pure builder plus a
// real RoomStore + real HTTP server for the REST route and the MCP
// room_check_access field: legibility of the permission vocabulary, fail-closed
// unknown tokens, read-only tier surfacing, and one-shot welcome wiring.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { buildPermissionMoment, PermissionMomentError, PERMISSION_MOMENT_SCHEMA } from "../server/permission-moment.mjs";
import { EVENT_TYPES as T, PERMISSIONS, event } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { seedStarter } from "../server/starter-room.mjs";
import { runGuideStep } from "../server/room-guide.mjs";

const ROOM = "permission-moment-demo";

const member = (permissions, overrides = {}) => ({
  id: "agent-1", displayName: "Demo Agent", kind: "agent", permissions: [...permissions], ...overrides,
});
const momentOf = (permissions, overrides = {}) =>
  buildPermissionMoment({ member: member(permissions), roomId: ROOM, ...overrides });

// Every permission in the vocabulary renders exactly one legible capability
// with an executable next action. A permission added to src/events.js without
// a legibility entry fails this test — the vocabulary must never outrun the
// explanation.
test("vocabulary coverage: every PERMISSIONS token renders one legible capability", () => {
  for (const token of PERMISSIONS) {
    const granted = momentOf([token]);
    assert.equal(granted.youCan.length, 1, `granted ${token} must render one capability`);
    const [cap] = granted.youCan;
    assert.equal(cap.permission, token);
    assert.ok(typeof cap.title === "string" && cap.title.length > 3, `${token} needs a plain-language title`);
    assert.ok(typeof cap.means === "string" && cap.means.length > 10, `${token} needs a plain-language explanation`);
    // Every capability is one step away: an MCP tool where one exists, the
    // REST route always. A null mcpTool must say so in the note.
    assert.ok(cap.tryNow.mcpTool === null || (typeof cap.tryNow.mcpTool === "string" && cap.tryNow.mcpTool.length > 0),
      `${token} mcpTool must be a tool name or null`);
    if (cap.tryNow.mcpTool === null) {
      assert.ok(/no .*mcp tool/i.test(cap.tryNow.note), `${token} must disclose the missing MCP tool`);
    }
    assert.ok(typeof cap.tryNow.rest.method === "string" && typeof cap.tryNow.rest.path === "string",
      `${token} needs an executable REST call`);
    assert.ok(cap.tryNow.rest.path.includes(ROOM), `${token} REST path must be room-scoped`);

    const missing = momentOf([]);
    const absent = missing.notGranted.find(entry => entry.permission === token);
    assert.ok(absent, `missing ${token} must appear in notGranted`);
    assert.ok(typeof absent.howToGet === "string" && absent.howToGet.length > 10,
      `${token} must say how to get it`);
    assert.ok(!missing.youCan.some(entry => entry.permission === token),
      `${token} must not appear in youCan when not granted`);
  }
});

// An unknown token in a member record fails closed instead of rendering
// garbage or silently dropping the capability.
test("unknown permission token fails closed", () => {
  assert.throws(() => momentOf(["fly_spaceship"]), PermissionMomentError);
  assert.throws(() => momentOf(["accept_work", "fly_spaceship"]), PermissionMomentError);
});

test("collaborate profile renders four capabilities and a start-here", () => {
  const packet = momentOf(["steer", "accept_work", "complete_work", "verify"]);
  assert.equal(packet.schema, PERMISSION_MOMENT_SCHEMA);
  assert.equal(packet.profile, "collaborate");
  assert.equal(packet.youCan.length, 4);
  assert.ok(packet.headline.toLowerCase().includes("claim"), "headline should name the headline action");
  assert.equal(packet.startHere.permission, "accept_work");
  assert.ok(packet.startHere.tryNow.rest.path.includes(ROOM));
  assert.equal(packet.pausedWrites, false);
});

// A demoted (t1_readonly) agent must SEE the demotion in the moment: granted
// write capabilities are flagged paused so it does not discover the 403 by
// trial and error.
test("read-only tier surfaces paused writes", () => {
  const packet = momentOf(["steer", "accept_work", "complete_work", "verify"], { autonomyTier: "t1_readonly" });
  assert.equal(packet.pausedWrites, true);
  assert.match(packet.headline, /paus/i);
  for (const cap of packet.youCan) {
    if (["accept_work", "complete_work", "steer", "verify", "manage_claims", "write_external"].includes(cap.permission)) {
      assert.equal(cap.paused, true, `${cap.permission} must be flagged paused at t1_readonly`);
    }
  }
  assert.ok(packet.pausedNote.length > 10, "paused note must explain what still works");
});

test("owner profile covers the whole vocabulary", () => {
  const packet = momentOf([...PERMISSIONS], { isOwner: true });
  assert.equal(packet.profile, "owner");
  assert.equal(packet.youCan.length, PERMISSIONS.length);
  assert.deepEqual(packet.notGranted, []);
});

test("malformed input fails fast", () => {
  assert.throws(() => buildPermissionMoment({}), PermissionMomentError);
  assert.throws(() => buildPermissionMoment({ member: member(["accept_work"]), roomId: "" }), PermissionMomentError);
  assert.throws(() => buildPermissionMoment({ member: member("nope"), roomId: ROOM }), PermissionMomentError);
});

test("output is frozen", () => {
  const packet = momentOf(["accept_work", "verify"]);
  assert.ok(Object.isFrozen(packet));
  assert.ok(Object.isFrozen(packet.youCan));
  assert.ok(packet.youCan.every(cap => Object.isFrozen(cap) && Object.isFrozen(cap.tryNow)));
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-permission-moment-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize([
    event({ type: T.ROOM_CREATED, actorId: "owner", roomId: ROOM,
      data: { roomId: ROOM, ownerId: "owner", title: "Permission Moment Demo", purpose: "Fixture room for the permission moment.", kind: "personal" } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: ROOM,
      data: { memberId: "owner", displayName: "Room owner", kind: "human", permissions: [...PERMISSIONS] } }),
  ]);
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  store.command(ownerKey, ROOM, { id: "pm-add-worker", type: T.MEMBER_ADDED, data: {
    memberId: "worker", displayName: "Moment Worker", kind: "agent",
    permissions: ["steer", "accept_work", "complete_work", "verify"], accountableHumanId: "owner" } });
  store.command(ownerKey, ROOM, { id: "pm-add-paused", type: T.MEMBER_ADDED, data: {
    memberId: "paused", displayName: "Paused Worker", kind: "agent",
    permissions: ["accept_work", "complete_work"], accountableHumanId: "owner" } });
  setTier(store.db, ROOM, "paused", "t1_readonly", { updatedBy: "owner", nowMs: Date.now() });
  const workerKey = store.issueAccessKey(ROOM, "worker");
  const pausedKey = store.issueAccessKey(ROOM, "paused");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey, workerKey, pausedKey };
}

async function serve(t, store) {
  const server = createRoomServer({ store });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return origin;
}

test("REST my-permissions returns the caller's own legible packet", async t => {
  const f = fixture(t);
  const origin = await serve(t, f.store);
  const response = await fetch(`${origin}/api/rooms/${ROOM}/my-permissions`, {
    headers: { Authorization: `Bearer ${f.workerKey}` },
  });
  assert.equal(response.status, 200);
  const packet = await response.json();
  assert.equal(packet.schema, PERMISSION_MOMENT_SCHEMA);
  assert.equal(packet.memberId, "worker");
  assert.equal(packet.profile, "collaborate");
  assert.equal(packet.youCan.length, 4);
  assert.equal(packet.pausedWrites, false);
});

test("REST my-permissions reflects a read-only tier", async t => {
  const f = fixture(t);
  const origin = await serve(t, f.store);
  const response = await fetch(`${origin}/api/rooms/${ROOM}/my-permissions`, {
    headers: { Authorization: `Bearer ${f.pausedKey}` },
  });
  assert.equal(response.status, 200);
  const packet = await response.json();
  assert.equal(packet.memberId, "paused");
  assert.equal(packet.pausedWrites, true);
  assert.ok(packet.youCan.every(cap => cap.paused === true));
});

test("REST my-permissions requires auth", async t => {
  const f = fixture(t);
  const origin = await serve(t, f.store);
  const response = await fetch(`${origin}/api/rooms/${ROOM}/my-permissions`);
  assert.equal(response.status, 401);
});

// The additive permissionMoment field on the call every MCP agent makes at
// session start. Guards the wiring against MCP refactors that would silently
// drop the moment while the raw tokens survive.
test("MCP room_check_access carries the permission moment", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-permission-mcp-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("mcp-demo"));
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }),
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const identity = store.identities.create("Mcp Agent");
  const created = rooms.create(identity.secret, { title: "MCP Demo", purpose: "Permission moment fixture" });
  const mcp = createHostedRoomMcp(store);
  const call = (name, args) => mcp(
    { jsonrpc: "2.0", id: "c", method: "tools/call", params: { name, arguments: args } },
    { authorization: `Bearer ${identity.secret}` });
  const result = await call("room_check_access", { roomId: created.roomId });
  assert.ok(!result.error, `room_check_access failed: ${JSON.stringify(result.error)}`);
  // Hosted MCP wraps tool output in a JSON-RPC content envelope.
  const payload = JSON.parse(result.result.content[0].text);
  assert.ok(payload.permissionMoment, "room_check_access must carry the permission moment");
  assert.equal(payload.permissionMoment.schema, PERMISSION_MOMENT_SCHEMA);
  assert.equal(payload.permissionMoment.memberId, created.ownerMemberId);
  assert.ok(payload.permissionMoment.youCan.length > 0);
  assert.ok(payload.permissions.length > 0, "raw tokens stay for machine readers");
});

// The welcome moment: after the guide assigns the first joined agent their
// starter choice, it also posts their permission set in plain language —
// exactly once, even if the guide step re-runs.
test("room guide welcomes a joined agent with their permission moment, once", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-permission-guide-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize([
    event({ type: T.ROOM_CREATED, actorId: "owner", roomId: "guide-demo",
      data: { roomId: "guide-demo", ownerId: "owner", title: "Guide Demo", purpose: "Permission moment fixture", kind: "personal" } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: "guide-demo",
      data: { memberId: "owner", displayName: "Owner", kind: "human", permissions: [...PERMISSIONS] } }),
  ]);
  const ownerKey = store.issueAccessKey("guide-demo", "owner");
  const seeded = seedStarter(store, "guide-demo", { ownerMemberId: "owner" });
  store.command(ownerKey, "guide-demo", { id: "g-add-agent", type: T.MEMBER_ADDED, data: {
    memberId: "newbie", displayName: "Newbie", kind: "agent",
    permissions: ["accept_work", "complete_work"], accountableHumanId: "owner" } });
  const agentKey = store.issueAccessKey("guide-demo", "newbie");
  const choiceTitle = store.workClaims.get("guide-demo", seeded.choiceClaimIds[0]).title;
  store.command(agentKey, "guide-demo", { id: "g-pick", type: T.MESSAGE_POSTED, data: {
    messageId: "g-pick", body: choiceTitle } });
  runGuideStep(store, "guide-demo", Date.now());
  runGuideStep(store, "guide-demo", Date.now()); // re-run must not double-post
  const bodies = (store.room("guide-demo").state.messages ?? [])
    .map(message => message.body).filter(body => typeof body === "string");
  assert.ok(bodies.some(body => body.includes("@Newbie")), "the assignment message is still posted");
  const moments = bodies.filter(body => body.includes("Claim work from the board"));
  assert.equal(moments.length, 1, "the permission moment is posted exactly once");
  assert.ok(moments[0].includes("Full list anytime"), "the moment points at the always-on route");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
});
