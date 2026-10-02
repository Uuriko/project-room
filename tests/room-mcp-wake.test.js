// Hosted MCP wake, heartbeat, and webhook tools.
// Synthetic fixtures only. Identity secrets are checked by absence in
// responses and are never printed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const JOIN_TOOLS = ["room_join_packet", "room_join_kits", "room_join_prompt", "room_mcp_snippet"];
const WAKE_TOOLS = [
  "wake.register", "wake.clear", "heartbeat.set", "heartbeat.get", "heartbeat.ack",
  "wake.pause", "wake.resume", "webhook.subscribe", "webhook.list", "webhook.unsubscribe"
];
const PUBLIC_DNS = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
const PRIVATE_DNS = { resolve4: async () => ["10.1.2.3"], resolve6: async () => [] };
const WAKE_URL = "https://host.example.test/wake";
const PUSH_TOKEN = "push-token-not-a-secret-xyz";
const PUSH_CRED = "push-bearer-not-a-secret";

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-wake-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    resolve({ origin: `http://127.0.0.1:${server.address().port}`, store, rooms });
  }));
}

function rpc(origin, method, params, secret) {
  return fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, ...(params === undefined ? {} : { params }) })
  });
}

async function call(origin, name, args, secret) {
  const response = await rpc(origin, "tools/call", { name, arguments: args }, secret);
  const body = await response.json();
  return { status: response.status, body, value: body.result?.structuredContent, raw: JSON.stringify(body) };
}

function roomFor(store, rooms, owner) {
  return rooms.create(owner.secret, {
    roomId: "wake-den", title: "Wake den", purpose: "Wake tools", kind: "personal", displayName: "Wake owner"
  });
}

test("wake tools stay behind a live identity secret", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Wake owner");
  const created = roomFor(store, rooms, owner);
  const listed = await rpc(origin, "tools/list");
  assert.deepEqual((await listed.json()).result.tools.map(tool => tool.name), [...JOIN_TOOLS, "public_work_recommend", "public_work_read_task"]);
  const open = await call(origin, "wake.register", { hostId: "host-1", wakeUrl: WAKE_URL });
  assert.equal(open.status, 401);
  assert.equal(open.body.error.code, -32001);
  assert.equal(open.body.error.data.reason, "auth_required");
  assert.equal(open.body.result, undefined);
  const bad = await rpc(origin, "tools/list", undefined, "pri_" + "x".repeat(43));
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).result, undefined);
  const roomKey = store.issueAccessKey(created.roomId, created.ownerMemberId);
  for (const name of ["wake.register", "heartbeat.set", "webhook.subscribe", "wake.pause"]) {
    const keyed = await call(origin, name, {
      hostId: "host-1", wakeUrl: WAKE_URL, mode: "wakeable", url: WAKE_URL, events: ["message.posted"],
      roomId: created.roomId, memberId: created.ownerMemberId, requestId: "pause-1", reason: null
    }, roomKey);
    assert.equal(keyed.status, 401, name);
    assert.equal(keyed.body.result, undefined, name);
  }
  const names = (await (await rpc(origin, "tools/list", { profile: "full" }, owner.secret)).json()).result.tools.map(tool => tool.name);
  for (const name of WAKE_TOOLS) assert.equal(names.includes(name.replaceAll(".", "_")), true, name);
  assert.equal(names.includes("room_join_packet"), true);
});

test("an enrolled identity registers, reads, and clears an HTTPS wakeUrl", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Wake owner");
  const other = store.identities.create("Wake other");
  roomFor(store, rooms, owner);
  const insecure = await call(origin, "wake.register", { hostId: "host-1", wakeUrl: "http://insecure.example.test/wake" }, owner.secret);
  assert.equal(insecure.body.result.isError, true);
  assert.equal(insecure.value.status, 422);
  assert.equal(insecure.value.code, "invalid_heartbeat");
  const loopback = await call(origin, "wake.register", { hostId: "host-1", wakeUrl: "https://127.0.0.1/wake" }, owner.secret);
  assert.equal(loopback.value.code, "invalid_heartbeat");
  const local = await call(origin, "heartbeat.set", { hostId: "host-1", mode: "wakeable", wakeUrl: "https://localhost/wake" }, owner.secret);
  assert.equal(local.value.code, "invalid_heartbeat");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_hosts").get().n, 0);
  assert.equal(insecure.raw.includes(owner.secret), false);

  const registered = await call(origin, "wake.register", { hostId: "host-1", wakeUrl: WAKE_URL, cadenceSeconds: 120 }, owner.secret);
  assert.equal(registered.status, 200);
  assert.equal(registered.body.error, undefined);
  assert.equal(registered.value.host.mode, "wakeable");
  assert.equal(registered.value.host.wakeUrl, WAKE_URL);
  assert.equal(registered.value.host.agentId, owner.identityId);
  assert.equal(registered.value.host.cadenceSeconds, 120);
  assert.equal(registered.value.pushConfigured, false);
  const row = store.db.prepare("SELECT mode, wake_url FROM agent_hosts WHERE agent_id=?").get(owner.identityId);
  assert.equal(row.mode, "wakeable");
  assert.equal(row.wake_url, WAKE_URL);

  const shaped = await call(origin, "wake.register", { hostId: "bad id", wakeUrl: WAKE_URL }, owner.secret);
  assert.equal(shaped.body.error.code, -32602);
  const pullWithUrl = await call(origin, "heartbeat.set", { hostId: "host-1", mode: "pull-only", wakeUrl: WAKE_URL }, owner.secret);
  assert.equal(pullWithUrl.value.code, "invalid_heartbeat");
  assert.equal(store.db.prepare("SELECT wake_url FROM agent_hosts WHERE agent_id=?").get(owner.identityId).wake_url, WAKE_URL);

  store.agentHeartbeats.enqueueWake({
    agentId: owner.identityId, kind: "mention", roomId: "wake-den", messageId: "msg-wake"
  });
  const seen = await call(origin, "heartbeat.get", {}, owner.secret);
  assert.equal(seen.value.status, "online");
  assert.equal(seen.value.hosts[0].wakeUrl, WAKE_URL);
  const pending = await call(origin, "heartbeat.set", { hostId: "host-1", mode: "wakeable", wakeUrl: WAKE_URL, cadenceSeconds: 120, workWakes: true }, owner.secret);
  assert.equal(pending.value.host.workWakes, true);
  assert.equal(pending.value.pendingWakes.length, 1);
  const signalId = pending.value.pendingWakes[0].signalId;
  const acked = await call(origin, "heartbeat.ack", { signalIds: [signalId] }, owner.secret);
  assert.deepEqual(acked.value.acknowledged, [signalId]);
  const again = await call(origin, "heartbeat.ack", { signalIds: [signalId] }, owner.secret);
  assert.deepEqual(again.value.acknowledged, []);

  const hidden = await call(origin, "heartbeat.get", {}, other.secret);
  assert.equal(hidden.value.status, "unregistered");
  assert.equal(hidden.raw.includes(WAKE_URL), false);
  assert.equal(hidden.raw.includes(owner.secret), false);

  const cleared = await call(origin, "wake.clear", { hostId: "host-1" }, owner.secret);
  assert.equal(cleared.value.host.mode, "pull-only");
  assert.equal(cleared.value.host.wakeUrl, null);
  assert.equal(store.db.prepare("SELECT mode, wake_url FROM agent_hosts WHERE agent_id=?").get(owner.identityId).wake_url, null);
  assert.equal(cleared.raw.includes(owner.secret), false);
});

test("push registration reuses the subscribe-time public DNS check and does not echo credentials", async t => {
  const { origin, store } = await serve(t);
  const owner = store.identities.create("Push owner");
  store.agentHeartbeats.setPushTransport({ dnsResolvers: PRIVATE_DNS });
  const rejected = await call(origin, "wake.register", {
    hostId: "host-1", wakeUrl: WAKE_URL,
    pushNotification: { url: "https://evil.example.test/hook", token: PUSH_TOKEN, authentication: { schemes: ["bearer"], credentials: PUSH_CRED } }
  }, owner.secret);
  assert.equal(rejected.value.code, "invalid_heartbeat");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_hosts").get().n, 0);
  assert.equal(rejected.raw.includes(PUSH_TOKEN), false);
  assert.equal(rejected.raw.includes(PUSH_CRED), false);
  assert.equal(rejected.raw.includes(owner.secret), false);

  store.agentHeartbeats.setPushTransport({ dnsResolvers: PUBLIC_DNS });
  const accepted = await call(origin, "heartbeat.set", {
    hostId: "host-1", mode: "wakeable", wakeUrl: WAKE_URL,
    pushNotification: { url: "https://push.example.test/hook", token: PUSH_TOKEN }
  }, owner.secret);
  assert.equal(accepted.body.error, undefined);
  assert.equal(accepted.value.pushConfigured, true);
  assert.equal(accepted.value.reachability.mode, "push");
  assert.equal(accepted.raw.includes(PUSH_TOKEN), false);
  assert.equal(accepted.raw.includes(owner.secret), false);
  const stored = store.db.prepare("SELECT push_url, push_token FROM agent_push_configs WHERE agent_id=?").get(owner.identityId);
  assert.equal(stored.push_url, "https://push.example.test/hook");
  assert.equal(stored.push_token, PUSH_TOKEN);
});

test("webhook subscribe list and unsubscribe stay on this identity", async t => {
  const { origin, store } = await serve(t);
  const owner = store.identities.create("Hook owner");
  const other = store.identities.create("Hook other");
  const callerSecret = "caller-signing-secret-0123";
  const httpUrl = await call(origin, "webhook.subscribe", { url: "http://insecure.example.test/hook", events: ["message.posted"] }, owner.secret);
  assert.equal(httpUrl.value.status, 422);
  assert.equal(httpUrl.value.code, "invalid_subscription");
  const unknown = await call(origin, "webhook.subscribe", { url: "https://hooks.example.test/room", events: ["message-posted"] }, owner.secret);
  assert.equal(unknown.value.code, "invalid_subscription");
  assert.match(unknown.value.message, /message\.posted/);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_webhook_subs").get().n, 0);

  const supplied = await call(origin, "webhook.subscribe", {
    url: "https://hooks.example.test/room", events: ["message.posted", "agent.wake"], secret: callerSecret
  }, owner.secret);
  assert.equal(supplied.body.error, undefined);
  assert.equal(supplied.value.enabled, true);
  assert.equal(supplied.value.agentId, owner.identityId);
  assert.equal("secret" in supplied.value, false);
  assert.equal(supplied.raw.includes(callerSecret), false);
  assert.equal(supplied.raw.includes(owner.secret), false);
  const subscriptionId = supplied.value.subscriptionId;

  const generated = await call(origin, "webhook.subscribe", {
    url: "https://hooks.example.test/other", events: ["*"]
  }, owner.secret);
  assert.equal(generated.body.error, undefined);
  // RC-2026-09-27-2729 (UFO-steal slice 2): the signing secret never leaves
  // the server — not even once. The tool carries only the `secretRef`
  // sentinel; no `secret` field exists on the response at all.
  assert.equal("secret" in generated.value, false);
  assert.equal(typeof generated.value.secretRef, "string");
  assert.ok(generated.value.secretRef.startsWith("pr_sentinel_"));
  assert.ok(generated.value.secretRef.endsWith(generated.value.subscriptionId));
  assert.equal(generated.raw.includes(owner.secret), false);
  const shown = generated.value.secretRef;

  const listed = await call(origin, "webhook.list", {}, owner.secret);
  assert.equal(listed.value.subscriptions.length, 2);
  for (const sub of listed.value.subscriptions) {
    assert.equal("secret" in sub, false);
    assert.equal(typeof sub.secretRef, "string");
    assert.ok(sub.secretRef.startsWith("pr_sentinel_"));
  }
  assert.equal(listed.raw.includes(callerSecret), false);
  const otherList = await call(origin, "webhook.list", {}, other.secret);
  assert.deepEqual(otherList.value.subscriptions, []);

  const stolen = await call(origin, "webhook.unsubscribe", { subscriptionId }, other.secret);
  assert.equal(stolen.body.result.isError, true);
  assert.equal(stolen.value.status, 404);
  assert.equal(stolen.value.code, "unknown_subscription");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_webhook_subs WHERE subscription_id=?").get(subscriptionId).n, 1);

  const removed = await call(origin, "webhook.unsubscribe", { subscriptionId }, owner.secret);
  assert.equal(removed.value.unsubscribed, true);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_webhook_subs WHERE subscription_id=?").get(subscriptionId).n, 0);
  assert.equal(removed.raw.includes(owner.secret), false);
  assert.equal(removed.raw.includes(shown), false);
});

test("wake.pause and wake.resume use the room wake-queue pause path", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Pause owner");
  const peer = store.identities.create("Pause peer");
  const created = roomFor(store, rooms, owner);
  store.identities.link(owner.secret, created.roomId, {
    identityId: peer.identityId, displayName: "Pause peer", permissions: []
  });
  const outsider = await call(origin, "wake.pause", {
    roomId: created.roomId, memberId: created.ownerMemberId, requestId: "pause-1", reason: "away"
  }, store.identities.create("Pause outsider").secret);
  assert.equal(outsider.body.result.isError, true);
  assert.equal(outsider.value.status, 401);

  const cross = await call(origin, "wake.pause", {
    roomId: created.roomId, memberId: created.ownerMemberId, requestId: "pause-peer", reason: "no"
  }, peer.secret);
  assert.equal(cross.value.status, 403);
  assert.equal(cross.value.code, "wake_pause_not_permitted");
  assert.equal(store.wakeQueue.pauseStatus(created.roomId, created.ownerMemberId), null);

  const paused = await call(origin, "wake.pause", {
    roomId: created.roomId, memberId: created.ownerMemberId, requestId: "pause-1", reason: "away"
  }, owner.secret);
  assert.equal(paused.body.error, undefined);
  assert.equal(paused.value.duplicate, false);
  assert.equal(paused.value.pause.reason, "away");
  assert.equal(paused.value.memberId, created.ownerMemberId);
  assert.equal(paused.raw.includes(owner.secret), false);
  const retry = await call(origin, "wake.pause", {
    roomId: created.roomId, memberId: created.ownerMemberId, requestId: "pause-1", reason: "away"
  }, owner.secret);
  assert.equal(retry.value.duplicate, true);
  const changed = await call(origin, "wake.pause", {
    roomId: created.roomId, memberId: created.ownerMemberId, requestId: "pause-1", reason: "different"
  }, owner.secret);
  assert.equal(changed.value.code, "idempotency_conflict");

  const resumed = await call(origin, "wake.resume", {
    roomId: created.roomId, memberId: created.ownerMemberId, requestId: "resume-1"
  }, owner.secret);
  assert.equal(resumed.value.receipt.state, "active");
  assert.equal(store.wakeQueue.pauseStatus(created.roomId, created.ownerMemberId), null);
  const missing = await call(origin, "wake.resume", { roomId: created.roomId }, owner.secret);
  assert.equal(missing.body.error, undefined);
  assert.equal(missing.value.receipt.state, "active");
  const extra = await call(origin, "wake.resume", { roomId: created.roomId, note: "no" }, owner.secret);
  assert.equal(extra.body.error.code, -32602);
  assert.equal(extra.body.error.data.reason, "invalid_arguments");
});

test("a session cookie without a bearer secret gets the anonymous MCP catalog", async t => {
  const { origin, store } = await serve(t);
  store.initialize(initialRoom("commons"));
  const accessKey = store.issueAccessKey("commons", "owner");
  const login = await fetch(`${origin}/api/session`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey }),
  });
  assert.equal(login.status, 201);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const listed = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/list" }),
  });
  const catalog = await listed.json();
  assert.deepEqual(catalog.result.tools.map(tool => tool.name), [...JOIN_TOOLS, "public_work_recommend", "public_work_read_task"]);
  const roomCall = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name: "wake_register", arguments: { hostId: "host-1", wakeUrl: WAKE_URL } } }),
  });
  const denied = await roomCall.json();
  assert.equal(denied.result, undefined);
  assert.equal(denied.error.data.reason, "auth_required");
  const bearer = store.identities.create("Cookie contrast");
  const withBearer = await rpc(origin, "tools/list", { profile: "full" }, bearer.secret);
  const names = (await withBearer.json()).result.tools.map(tool => tool.name);
  assert.equal(names.includes("wake_register"), true);
});
