// A webhook subscription names the rooms it receives. A hook scoped to room A
// gets nothing from room B. A legacy unscoped row (room_ids_json NULL) still
// gets both. MCP subscribe without rooms uses the current room. Leaving a
// room removes it from the hook, and an empty list disables the row. A room
// the identity is not seated in is 422 room_not_member. HTTP may omit rooms
// until 2026-11-23; that response carries scope.rooms "all" and a warning.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { installFakeWebhookDns } from "./helpers/fake-webhook-dns.mjs";
import { WEBHOOK_ROOMS_REQUIRED_AT } from "../server/webhook-room-scope.mjs";

function open(t, now) {
  const directory = mkdtempSync(join(tmpdir(), "webhook-room-scope-"));
  let clock = now;
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  installFakeWebhookDns(store);
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams();
      server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    resolve({
      origin: `http://127.0.0.1:${server.address().port}`,
      store,
      rooms,
      advance: ms => { clock += ms; },
    });
  }));
}

async function seatedPair(t, now) {
  const opened = await open(t, now);
  const { store, rooms, advance } = opened;
  const owner = store.identities.create("Wren");
  const peer = store.identities.create("Lark");
  rooms.create(owner.secret, { roomId: "room-a", title: "A", purpose: "p", kind: "personal", displayName: "Wren" });
  advance(1000);
  rooms.create(owner.secret, { roomId: "room-b", title: "B", purpose: "p", kind: "personal", displayName: "Wren" });
  advance(1000);
  store.identities.link(owner.secret, "room-a", { identityId: peer.identityId, displayName: "Lark", permissions: [] });
  advance(1000);
  store.identities.link(owner.secret, "room-b", { identityId: peer.identityId, displayName: "Lark", permissions: [] });
  advance(1000);
  rooms.create(owner.secret, { roomId: "room-c", title: "C", purpose: "p", kind: "personal", displayName: "Wren" });
  return { ...opened, owner, peer };
}

const deliveries = (store, subscriptionId) =>
  store.db.prepare("SELECT COUNT(*) AS n FROM agent_webhook_deliveries WHERE subscription_id=?").get(subscriptionId).n;

function postMessage(store, secret, roomId, body) {
  store.command(secret, roomId, {
    id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body },
  });
}

function leave(store, ownerSecret, roomId, identityId) {
  const seat = store.db.prepare(
    "SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, identityId);
  const member = store.room(roomId).state.members[seat.memberId];
  store.command(ownerSecret, roomId, {
    id: randomUUID(),
    type: "member.access_changed",
    data: {
      memberId: seat.memberId,
      expectedMemberRevision: member.revision,
      permissions: member.permissions,
      active: false,
    },
  });
}

async function httpSubscribe(origin, secret, body) {
  const response = await fetch(`${origin}/api/agent-webhooks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, body: json };
}

async function mcpSubscribe(origin, secret, args, query = "") {
  const response = await fetch(`${origin}/room/mcp${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "x", method: "tools/call", params: { name: "webhook_subscribe", arguments: args } }),
  });
  const json = await response.json();
  return json.result?.structuredContent ?? json.error ?? null;
}

const HOOK = "https://scoped.example.test/hook";

test("a hook scoped to room A gets nothing from room B; an unscoped hook gets both", async t => {
  const { origin, store, owner, peer } = await seatedPair(t, Date.UTC(2026, 10, 1));
  const scoped = await httpSubscribe(origin, peer.secret, { url: HOOK, events: ["message.posted"], rooms: ["room-a"] });
  assert.equal(scoped.status, 201, JSON.stringify(scoped.body));
  assert.deepEqual(scoped.body.rooms, ["room-a"]);
  assert.equal(scoped.body.warning, undefined);
  const legacy = await httpSubscribe(origin, peer.secret, {
    url: "https://legacy.example.test/hook", events: ["message.posted"],
  });
  assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
  assert.equal(legacy.body.rooms, "all");
  assert.deepEqual(legacy.body.scope, { rooms: "all" });
  assert.equal(typeof legacy.body.warning, "string");
  assert.match(legacy.body.warning, /2026-11-23/);
  const listed = await (await fetch(`${origin}/api/agent-webhooks`, {
    headers: { authorization: `Bearer ${peer.secret}` },
  })).json();
  const byId = Object.fromEntries(listed.subscriptions.map(row => [row.subscriptionId, row.rooms]));
  assert.deepEqual(byId[scoped.body.subscriptionId], ["room-a"]);
  assert.equal(byId[legacy.body.subscriptionId], "all");

  postMessage(store, owner.secret, "room-b", "only b");
  assert.equal(deliveries(store, scoped.body.subscriptionId), 0, "room B must not reach a hook scoped to room A");
  assert.equal(deliveries(store, legacy.body.subscriptionId), 1, "an unscoped hook still receives room B");
  postMessage(store, owner.secret, "room-a", "only a");
  assert.equal(deliveries(store, scoped.body.subscriptionId), 1);
  assert.equal(deliveries(store, legacy.body.subscriptionId), 2, "an unscoped hook still receives room A");

  const narrowed = await httpSubscribe(origin, peer.secret, { url: HOOK, events: ["message.posted"], rooms: ["room-b"] });
  assert.equal(narrowed.body.subscriptionId, scoped.body.subscriptionId, "the same url and events stay one subscription");
  postMessage(store, owner.secret, "room-a", "after narrow");
  assert.equal(deliveries(store, scoped.body.subscriptionId), 1, "retargeting the hook to room B stops room A");
  postMessage(store, owner.secret, "room-b", "after narrow b");
  assert.equal(deliveries(store, scoped.body.subscriptionId), 2);
});

test("MCP subscribe without rooms uses the current room", async t => {
  const { origin, store, owner, peer } = await seatedPair(t, Date.UTC(2026, 10, 1));
  const queried = await mcpSubscribe(origin, peer.secret, { url: HOOK, events: ["message.posted"] }, "?room=room-a");
  assert.equal(queried?.rooms && queried.rooms[0], "room-a", JSON.stringify(queried));
  assert.deepEqual(queried.rooms, ["room-a"]);
  postMessage(store, owner.secret, "room-b", "other room");
  assert.equal(deliveries(store, queried.subscriptionId), 0);
  postMessage(store, owner.secret, "room-a", "this room");
  assert.equal(deliveries(store, queried.subscriptionId), 1);

  const latest = await mcpSubscribe(origin, peer.secret, {
    url: "https://latest.example.test/hook", events: ["message.posted"],
  });
  assert.deepEqual(latest.rooms, ["room-b"], "with several seats and no room query, the most recently linked room is current");
  const star = await mcpSubscribe(origin, peer.secret, {
    url: "https://star.example.test/hook", events: ["message.posted"], rooms: "*",
  });
  assert.equal(star.rooms, "all");
  postMessage(store, owner.secret, "room-a", "star a");
  assert.equal(deliveries(store, star.subscriptionId), 1);
});

test("leaving a room removes it from the hook and an empty list disables the row", async t => {
  const { origin, store, owner, peer } = await seatedPair(t, Date.UTC(2026, 10, 1));
  const made = await httpSubscribe(origin, peer.secret, {
    url: HOOK, events: ["message.posted"], rooms: ["room-a", "room-b"],
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.rooms, ["room-a", "room-b"]);
  leave(store, owner.secret, "room-a", peer.identityId);
  const afterA = store.db.prepare(
    "SELECT room_ids_json AS rooms, enabled FROM agent_webhook_subs WHERE subscription_id=?").get(made.body.subscriptionId);
  assert.deepEqual(JSON.parse(afterA.rooms), ["room-b"]);
  assert.equal(afterA.enabled, 1);
  postMessage(store, owner.secret, "room-a", "left");
  assert.equal(deliveries(store, made.body.subscriptionId), 0, "a left room no longer delivers");
  postMessage(store, owner.secret, "room-b", "still here");
  assert.equal(deliveries(store, made.body.subscriptionId), 1);
  leave(store, owner.secret, "room-b", peer.identityId);
  const afterB = store.db.prepare(
    "SELECT room_ids_json AS rooms, enabled FROM agent_webhook_subs WHERE subscription_id=?").get(made.body.subscriptionId);
  assert.equal(afterB.rooms, "[]");
  assert.equal(afterB.enabled, 0, "an empty room list disables the subscription and keeps the row");
});

test("a room the identity is not seated in is 422 room_not_member", async t => {
  const { origin, peer } = await seatedPair(t, Date.UTC(2026, 10, 1));
  const refused = await httpSubscribe(origin, peer.secret, {
    url: HOOK, events: ["message.posted"], rooms: ["room-c"],
  });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error.code, "room_not_member");
});

test("after 2026-11-23, omitting rooms is 422 rooms_required", async t => {
  assert.equal(WEBHOOK_ROOMS_REQUIRED_AT, Date.UTC(2026, 10, 23));
  const { origin, peer } = await seatedPair(t, WEBHOOK_ROOMS_REQUIRED_AT);
  const omitted = await httpSubscribe(origin, peer.secret, { url: HOOK, events: ["message.posted"] });
  assert.equal(omitted.status, 422);
  assert.equal(omitted.body.error.code, "rooms_required");
  const starred = await httpSubscribe(origin, peer.secret, { url: HOOK, events: ["message.posted"], rooms: "*" });
  assert.equal(starred.status, 201, JSON.stringify(starred.body));
  assert.equal(starred.body.rooms, "all");
  assert.equal(starred.body.warning, undefined);
});
