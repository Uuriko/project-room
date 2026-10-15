// MCP listener-lease parity (#3481): the hosted MCP wake tools expose
// the REST heartbeat surface's listenerLease / fencingToken params with
// identical semantics — same binding rules (a rak_ key with exactly one
// mcp:room: scope leases only its bound room; an identity credential's
// { roomId } lease requires the live active agent member, #3501), same
// contention behavior (reported in the listener block, never an error),
// same ack fencing (tokenless / wrong-token acks under a live lease get
// 409 listener_fenced), and per-call binding re-derivation (an unlink or
// suspension ends the scoped listener at the next call, ack included).
// The REST counterparts are pinned by tests/scoped-listener-contract
// .test.js and tests/scoped-listener-default-lease.test.js; these are
// their MCP-path equivalents over the real hosted MCP door.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { installFakeWebhookDns } from "./helpers/fake-webhook-dns.mjs";

const WAKE_URL = "https://host.example.test/wake";

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "mcp-listener-lease-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  installFakeWebhookDns(store);
  for (const id of ["commons", "annex"]) store.initialize(initialRoom(id));
  const owners = Object.fromEntries(["commons", "annex"].map(id => [id, store.issueAccessKey(id, "owner")]));
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    resolve({ origin: `http://127.0.0.1:${server.address().port}`, store, owners });
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

function addMember(store, owners, name, roomId, memberId) {
  const identity = store.identities.create(name);
  store.identities.link(owners[roomId], roomId, { identityId: identity.identityId, memberId, displayName: name, permissions: [] });
  return identity;
}

function leaseRow(store, agentId, roomKey) {
  // The lease tables are created lazily by the first lease operation;
  // ensure them so a refused-first-request reads as "no row", not an error.
  store.agentHeartbeats.ensureListenerSchema();
  return store.db.prepare("SELECT listener_id AS listenerId, fencing_token AS fencingToken, lease_expires_at AS expiresAt FROM agent_wake_listener_leases WHERE agent_id=? AND room_key=?")
    .get(agentId, roomKey);
}

test("identity credential: listenerLease:true leases the roomless queue and fences ack", async t => {
  const { origin, store } = await serve(t);
  const peer = store.identities.create("Roomless listener");
  const beat = await call(origin, "heartbeat_set", { hostId: "h1", mode: "pull-only", listenerLease: true }, peer.secret);
  assert.equal(beat.body.error, undefined);
  assert.equal(beat.value.listener.acquired, true);
  assert.equal(beat.value.listener.renewed, false);
  assert.equal(typeof beat.value.listener.fencingToken, "string");
  assert.ok(leaseRow(store, peer.identityId, ""));
  // Renewal by the same host keeps the token.
  const renewed = await call(origin, "heartbeat_set", { hostId: "h1", mode: "pull-only", listenerLease: true }, peer.secret);
  assert.equal(renewed.value.listener.acquired, true);
  assert.equal(renewed.value.listener.renewed, true);
  assert.equal(renewed.value.listener.fencingToken, beat.value.listener.fencingToken);
  const wake = store.agentHeartbeats.enqueueWake({ agentId: peer.identityId, kind: "mention", messageId: "roomless-pointer" }).signal;
  const tokenless = await call(origin, "heartbeat_ack", { signalIds: [wake.signalId] }, peer.secret);
  assert.equal(tokenless.body.result.isError, true);
  assert.equal(tokenless.value.status, 409);
  assert.equal(tokenless.value.code, "listener_fenced");
  const wrong = await call(origin, "heartbeat_ack", { signalIds: [wake.signalId], fencingToken: "not-the-lease-token" }, peer.secret);
  assert.equal(wrong.value.status, 409);
  assert.equal(wrong.value.code, "listener_fenced");
  const fenced = await call(origin, "heartbeat_ack", { signalIds: [wake.signalId], fencingToken: beat.value.listener.fencingToken }, peer.secret);
  assert.equal(fenced.body.error, undefined);
  assert.deepEqual(fenced.value.acknowledged, [wake.signalId]);
  // A token on a lease-free queue is unnecessary and ack behaves as before.
  const plain = store.identities.create("Lease-free peer");
  const free = store.agentHeartbeats.enqueueWake({ agentId: plain.identityId, kind: "mention", messageId: "free-pointer" }).signal;
  const freeAck = await call(origin, "heartbeat_ack", { signalIds: [free.signalId], fencingToken: "no-lease-anywhere" }, plain.secret);
  assert.deepEqual(freeAck.value.acknowledged, [free.signalId]);
});

test("identity credential: lease contention is reported in the listener block, never an error", async t => {
  const { origin, store, owners } = await serve(t);
  const peer = addMember(store, owners, "Contended listener", "commons", "contended-peer");
  const first = await call(origin, "heartbeat_set",
    { hostId: "first", mode: "pull-only", listenerLease: { roomId: "commons" } }, peer.secret);
  assert.equal(first.value.listener.acquired, true);
  const second = await call(origin, "heartbeat_set",
    { hostId: "second", mode: "pull-only", listenerLease: { roomId: "commons" } }, peer.secret);
  assert.equal(second.body.error, undefined);
  assert.equal(second.status, 200);
  assert.equal(second.value.listener.acquired, false);
  assert.equal(second.value.listener.activeListenerId, "first");
  assert.equal(typeof second.value.listener.leaseExpiresAt, "number");
});

test("identity credential: a { roomId } lease requires the live active agent member, not just the link row (#3501)", async t => {
  const { origin, store, owners } = await serve(t);
  const outsider = store.identities.create("Not a member");
  const refused = await call(origin, "heartbeat_set",
    { hostId: "member-host", mode: "pull-only", listenerLease: { roomId: "commons" } }, outsider.secret);
  assert.equal(refused.body.result.isError, true);
  assert.equal(refused.value.status, 403);
  assert.equal(refused.value.code, "room_mismatch");
  assert.equal(leaseRow(store, outsider.identityId, "commons"), undefined);

  const peer = addMember(store, owners, "Lease member", "commons", "lease-member");
  const beat = await call(origin, "heartbeat_set",
    { hostId: "member-host", mode: "pull-only", listenerLease: { roomId: "commons" } }, peer.secret);
  assert.equal(beat.value.listener.acquired, true);
  // Suspend the member: the identity_links row survives, so only the live
  // member check refuses the renewal — and the refusal extends nothing.
  const member = store.room("commons").state.members["lease-member"];
  store.command(owners.commons, "commons", { id: crypto.randomUUID(), type: "member.access_changed", data: {
    memberId: member.id, expectedMemberRevision: member.revision, permissions: [], active: false } });
  const expiryBefore = leaseRow(store, peer.identityId, "commons").expiresAt;
  const renewed = await call(origin, "heartbeat_set",
    { hostId: "member-host", mode: "pull-only", listenerLease: { roomId: "commons" } }, peer.secret);
  assert.equal(renewed.value.status, 403);
  assert.equal(renewed.value.code, "room_mismatch");
  assert.equal(leaseRow(store, peer.identityId, "commons").expiresAt, expiryBefore);
  // Plain presence (no lease request) is not membership-gated, as on REST.
  const plain = await call(origin, "heartbeat_set", { hostId: "member-host", mode: "pull-only" }, peer.secret);
  assert.equal(plain.body.error, undefined);
});

test("scoped rak_ key: bound-room lease end to end over MCP, ack fenced by its token", async t => {
  const { origin, store, owners } = await serve(t);
  const peer = addMember(store, owners, "Scoped listener", "commons", "scoped-peer");
  const key = store.agentPlugin.issueOnboardingMcpToken({ identityId: peer.identityId, roomId: "commons", label: "scoped listener" });
  assert.match(key.credential, /^rak_/);
  const beat = await call(origin, "heartbeat_set", { hostId: "saved-host", mode: "pull-only", listenerLease: true }, key.credential);
  assert.equal(beat.body.error, undefined);
  assert.equal(beat.value.listener.acquired, true);
  // The lease's listener id lives in the key's host namespace, exactly as
  // the REST heartbeat stores it for the same credential + hostId.
  const row = leaseRow(store, peer.identityId, "commons");
  assert.ok(row.listenerId.startsWith("ak_"), row.listenerId);
  assert.ok(row.listenerId.endsWith("saved-host"), row.listenerId);
  assert.equal(row.fencingToken, beat.value.listener.fencingToken);
  // { roomId } naming the bound room is the same lease (renewal).
  const named = await call(origin, "heartbeat_set", { hostId: "saved-host", mode: "pull-only", listenerLease: { roomId: "commons" } }, key.credential);
  assert.equal(named.value.listener.acquired, true);
  assert.equal(named.value.listener.renewed, true);
  // Another room is refused: a scoped credential leases only its bound room.
  const other = await call(origin, "heartbeat_set", { hostId: "saved-host", mode: "pull-only", listenerLease: { roomId: "annex" } }, key.credential);
  assert.equal(other.value.status, 403);
  assert.equal(other.value.code, "room_mismatch");
  // The scoped listener contract rides along: no wake URL through the lease door.
  const waked = await call(origin, "heartbeat_set",
    { hostId: "saved-host", mode: "wakeable", wakeUrl: WAKE_URL, listenerLease: true }, key.credential);
  assert.equal(waked.value.status, 403);
  assert.equal(waked.value.code, "scoped_key_wake_refused");
  // Ack fencing: tokenless and wrong-token acks are refused; the lease
  // holder's token drains exactly the room's signal.
  const wake = store.agentHeartbeats.enqueueWake(
    { agentId: peer.identityId, kind: "mention", roomId: "commons", messageId: "scoped-pointer" }).signal;
  const tokenless = await call(origin, "heartbeat_ack", { signalIds: [wake.signalId] }, key.credential);
  assert.equal(tokenless.value.status, 409);
  assert.equal(tokenless.value.code, "listener_fenced");
  const ownerTokenless = await call(origin, "heartbeat_ack", { signalIds: [wake.signalId] }, peer.secret);
  assert.equal(ownerTokenless.value.status, 409, "the fence keys off the signal's room, not the caller");
  const fenced = await call(origin, "heartbeat_ack",
    { signalIds: [wake.signalId], fencingToken: beat.value.listener.fencingToken }, key.credential);
  assert.deepEqual(fenced.value.acknowledged, [wake.signalId]);
  assert.equal(store.agentHeartbeats.pendingWakes(peer.identityId, { roomId: "commons" }).length, 0);
});

test("scoped rak_ key: the binding is re-derived on every call — unlink ends lease and ack", async t => {
  const { origin, store, owners } = await serve(t);
  const peer = addMember(store, owners, "Unlinking listener", "commons", "unlink-peer");
  const key = store.agentPlugin.issueOnboardingMcpToken({ identityId: peer.identityId, roomId: "commons", label: "unlink listener" });
  const beat = await call(origin, "heartbeat_set", { hostId: "saved-host", mode: "pull-only", listenerLease: true }, key.credential);
  assert.equal(beat.value.listener.acquired, true);
  store.identities.unlink(owners.commons, "commons", peer.identityId);
  const deadLease = await call(origin, "heartbeat_set", { hostId: "saved-host", mode: "pull-only", listenerLease: true }, key.credential);
  assert.equal(deadLease.value.status, 403);
  assert.equal(deadLease.value.code, "scoped_key_room_refused");
  const wake = store.agentHeartbeats.enqueueWake(
    { agentId: peer.identityId, kind: "mention", roomId: "commons", messageId: "post-unlink-pointer" }).signal;
  const deadAck = await call(origin, "heartbeat_ack",
    { signalIds: [wake.signalId], fencingToken: beat.value.listener.fencingToken }, key.credential);
  assert.equal(deadAck.value.status, 403);
  assert.equal(deadAck.value.code, "scoped_key_room_refused");
});

test("a rak_ key scoped to several rooms is refused scoped lease use, as on REST", async t => {
  const { origin, store, owners } = await serve(t);
  const peer = addMember(store, owners, "Multi-room listener", "commons", "multi-peer");
  store.identities.link(owners.annex, "annex", { identityId: peer.identityId, memberId: "multi-peer-annex", displayName: "Multi-room listener", permissions: [] });
  const issued = store.agentPlugin.issueApiKey({ identityId: peer.identityId,
    scopes: ["mcp:room:commons", "mcp:room:annex", "mcp:wake", "heartbeats:report", "heartbeats:read"] });
  const multiKey = `rak_${issued.secret}`;
  const beat = await call(origin, "heartbeat_set", { hostId: "multi-host", mode: "pull-only", listenerLease: true }, multiKey);
  assert.equal(beat.value.status, 403);
  assert.equal(beat.value.code, "scoped_key_room_refused");
  const wake = store.agentHeartbeats.enqueueWake(
    { agentId: peer.identityId, kind: "mention", roomId: "commons", messageId: "multi-pointer" }).signal;
  const ack = await call(origin, "heartbeat_ack", { signalIds: [wake.signalId] }, multiKey);
  assert.equal(ack.value.status, 403);
  assert.equal(ack.value.code, "scoped_key_room_refused");
});

test("wake_register and wake_clear also carry listenerLease", async t => {
  const { origin, store } = await serve(t);
  const peer = store.identities.create("Register listener");
  const registered = await call(origin, "wake_register", { hostId: "wr-host", wakeUrl: WAKE_URL, listenerLease: true }, peer.secret);
  assert.equal(registered.body.error, undefined);
  assert.equal(registered.value.listener.acquired, true);
  assert.equal(typeof registered.value.listener.fencingToken, "string");
  const cleared = await call(origin, "wake_clear", { hostId: "wr-host", listenerLease: true }, peer.secret);
  assert.equal(cleared.body.error, undefined);
  assert.equal(cleared.value.host.mode, "pull-only");
  assert.equal(cleared.value.listener.acquired, true);
  assert.equal(cleared.value.listener.renewed, true);
  assert.equal(cleared.value.listener.fencingToken, registered.value.listener.fencingToken);
});

test("malformed listenerLease / fencingToken are refused as invalid arguments", async t => {
  const { origin, store } = await serve(t);
  const peer = store.identities.create("Shape peer");
  for (const listenerLease of ["yes", { roomId: "" }, { roomId: "commons", extra: 1 }, { room: "commons" }, [true]]) {
    const bad = await call(origin, "heartbeat_set", { hostId: "h1", mode: "pull-only", listenerLease }, peer.secret);
    assert.equal(bad.body.error?.code, -32602, JSON.stringify(listenerLease));
    assert.equal(bad.body.error?.data?.reason, "invalid_arguments", JSON.stringify(listenerLease));
  }
  const emptyToken = await call(origin, "heartbeat_ack", { signalIds: ["ws_x"], fencingToken: "" }, peer.secret);
  assert.equal(emptyToken.body.error?.code, -32602);
  assert.equal(emptyToken.body.error?.data?.reason, "invalid_arguments");
  const typedToken = await call(origin, "heartbeat_ack", { signalIds: ["ws_x"], fencingToken: 42 }, peer.secret);
  assert.equal(typedToken.body.error?.code, -32602);
  // Nothing was recorded by the refused calls.
  store.agentHeartbeats.ensureListenerSchema();
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_wake_listener_leases").get().n, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_hosts").get().n, 0);
});
