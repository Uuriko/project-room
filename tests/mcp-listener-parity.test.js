// Exercises server/agent-listener-contract.mjs through real hosted MCP requests,
// including transaction rollback, current authority, and lease-fenced ACK.
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
import { installFakeWebhookDns } from "./helpers/fake-webhook-dns.mjs";

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-wake-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  // Test-only DNS: fixture webhook URLs (https://*.test) go through the
  // fully fail-closed production gate, so a fake resolver stands in.
  installFakeWebhookDns(store);
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

test("MCP explicit lease acquisition, contention and fenced ACK", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Lease owner");
  roomFor(store, rooms, owner);
  const args = { hostId: "mcp-first", mode: "pull-only", listenerLease: { roomId: "wake-den" } };
  const first = await call(origin, "heartbeat_set", args, owner.secret);
  assert.equal(first.body.result.isError, undefined, first.raw);
  assert.equal(first.value.listener.acquired, true);
  const token = first.value.listener.fencingToken;
  const signal = store.agentHeartbeats.enqueueWake({ agentId: owner.identityId, roomId: "wake-den", kind: "mention", messageId: "lease-message" });
  const contender = await call(origin, "heartbeat_set", { ...args, hostId: "mcp-other" }, owner.secret);
  assert.equal(contender.value.listener.acquired, false);
  const signalIds = [signal.signal.signalId];
  const refused = await call(origin, "heartbeat_ack", { signalIds }, owner.secret);
  assert.equal(refused.value.code, "listener_fenced");
  const wrong = await call(origin, "heartbeat_ack", { signalIds, fencingToken: "wrong" }, owner.secret);
  assert.equal(wrong.body.result.isError, true);
  store.agentHeartbeats.releaseListenerLease({ agentId: owner.identityId, roomId: "wake-den", fencingToken: token });
  const replacement = await call(origin, "heartbeat_set", { ...args, hostId: "mcp-other" }, owner.secret);
  assert.equal(replacement.value.listener.acquired, true);
  const stale = await call(origin, "heartbeat_ack", { signalIds, fencingToken: token }, owner.secret);
  assert.equal(stale.body.result.isError, true);
  const ack = await call(origin, "heartbeat_ack", { signalIds, fencingToken: replacement.value.listener.fencingToken }, owner.secret);
  assert.deepEqual(ack.value.acknowledged, signalIds);
  const duplicate = await call(origin, "heartbeat_ack", { signalIds, fencingToken: replacement.value.listener.fencingToken }, owner.secret);
  assert.deepEqual(duplicate.value.acknowledged, []);
});

test("MCP room lease validates current membership and rolls back heartbeat on refusal", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Lease owner");
  roomFor(store, rooms, owner);
  const args = { hostId: "scoped-host", mode: "pull-only", listenerLease: { roomId: "wake-den" } };
  const foreign = store.identities.create("Foreign identity");
  const refused = await call(origin, "heartbeat_set", args, foreign.secret);
  assert.equal(refused.value.code, "room_mismatch");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_hosts WHERE agent_id=?").get(foreign.identityId).n, 0);
  const linked = store.identities.link(owner.secret, "wake-den", { identityId: foreign.identityId, displayName: "Linked peer", permissions: [] });
  const initial = await call(origin, "heartbeat_set", args, foreign.secret);
  assert.equal(initial.value.listener.acquired, true);
  const member = store.room("wake-den").state.members[linked.memberId];
  store.command(owner.secret, "wake-den", { id: crypto.randomUUID(), type: "member.access_changed", data: { memberId: member.id, expectedMemberRevision: member.revision, active: false, permissions: member.permissions } });
  const suspended = await call(origin, "heartbeat_set", { ...args, hostId: "new-host" }, foreign.secret);
  assert.equal(suspended.value.code, "room_mismatch");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_hosts WHERE agent_id=? AND host_id='new-host'").get(foreign.identityId).n, 0);
});

test("MCP scoped lease cannot cross rooms or survive membership revocation", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Lease person");
  roomFor(store, rooms, owner);
  const peer = store.identities.create("Peer");
  const linked = store.identities.link(owner.secret, "wake-den", { identityId: peer.identityId, displayName: "Peer", permissions: [] });
  const key = store.agentPlugin.issueApiKey({ identityId: peer.identityId, scopes: ["mcp:wake", "mcp:room:wake-den"] });
  const args = { hostId: "scoped", mode: "pull-only", listenerLease: true };
  const deniedKey = store.agentPlugin.issueApiKey({ identityId: peer.identityId, scopes: ["mcp:room:wake-den"] });
  const denied = await call(origin, "heartbeat_set", args, `rak_${deniedKey.secret}`);
  assert.equal(denied.body.error?.data?.hint, "API key lacks the mcp:wake scope", denied.raw);
  const other = await call(origin, "heartbeat_set", { ...args, listenerLease: { roomId: "other" } }, `rak_${key.secret}`);
  assert.equal(other.value?.code, "room_mismatch", other.raw);
  const first = await call(origin, "heartbeat_set", args, `rak_${key.secret}`);
  assert.equal(first.value.listener.acquired, true, first.raw);
  const signal = store.agentHeartbeats.enqueueWake({ agentId: peer.identityId, roomId: "wake-den", kind: "mention", messageId: "pending" }).signal;
  const member = store.room("wake-den").state.members[linked.memberId];
  store.command(owner.secret, "wake-den", { id: crypto.randomUUID(), type: "member.access_changed", data: { memberId: member.id, expectedMemberRevision: member.revision, active: false, permissions: member.permissions } });
  const ack = await call(origin, "heartbeat_ack", { signalIds: [signal.signalId], fencingToken: first.value.listener.fencingToken }, `rak_${key.secret}`);
  assert.equal(ack.value.code, "scoped_key_room_refused");
  const renewed = await call(origin, "heartbeat_set", args, `rak_${key.secret}`);
  assert.equal(renewed.value.code, "scoped_key_room_refused");
  assert.ok(store.agentHeartbeats.pendingWakes(peer.identityId, { roomId: "wake-den" }).some(item => item.signalId === signal.signalId));
});

test("MCP opt-in push registration reauthenticates after asynchronous DNS", async t => {
  const { origin, store } = await serve(t);
  const owner = store.identities.create("Push owner");
  let arrived, release;
  const entered = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  store.agentHeartbeats.setPushTransport({ dnsResolvers: { resolve4: async () => { arrived(); await gate; return ["93.184.216.34"]; }, resolve6: async () => [] } });
  const request = call(origin, "wake_register", { hostId: "delayed", wakeUrl: "https://wake.example.test/hook", pushNotification: { url: "https://push.example.test/hook", token: "fixture-token" }, listenerLease: true }, owner.secret);
  await Promise.race([entered, request.then(result => { throw new Error(`Request ended before DNS: ${result.raw}`); })]);
  store.identities.revoke(owner.identityId, owner.secret);
  release();
  const result = await request;
  assert.equal(result.value?.code, "unauthenticated", result.raw);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_hosts WHERE agent_id=?").get(owner.identityId).n, 0);
});

test("MCP wake register and clear renew opt-in leases and reject malformed options", async t => {
  const { origin, store } = await serve(t);
  const owner = store.identities.create("Lease person");
  const first = await call(origin, "wake_register", { hostId: "host", wakeUrl: "https://wake.example.test/hook", listenerLease: true }, owner.secret);
  assert.equal(first.value.listener.acquired, true, first.raw);
  const cleared = await call(origin, "wake_clear", { hostId: "host", listenerLease: true }, owner.secret);
  assert.equal(cleared.value.listener.fencingToken, first.value.listener.fencingToken);
  assert.equal(cleared.value.listener.renewed, true);
  for (const listenerLease of [false, {}, { roomId: "wake-den", extra: true }]) {
    const result = await call(origin, "heartbeat_set", { hostId: "bad", mode: "pull-only", listenerLease }, owner.secret);
    assert.ok(result.body.error || result.body.result?.isError, result.raw);
  }
});
