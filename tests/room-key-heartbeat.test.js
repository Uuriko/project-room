// A saved room access key is the credential a seat already uses to read and
// post. It must be able to join the existing pull-only heartbeat registry so
// a later mention can queue a wake. It must not install a wake URL or clear
// a host the identity secret registered as wakeable.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { HEARTBEAT_STALE_AFTER_MS } from "../server/agent-heartbeats.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, body, secret) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
  body: JSON.stringify(body),
});
const errorCode = async res => (await res.json()).error?.code;

test("room access key registers pull-only presence and a stale mention queues a wake", async t => {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  const identity = f.store.identities.create("Pull Seat");
  f.store.identities.link(f.keys.owner, "commons", {
    identityId: identity.identityId,
    memberId: identity.identityId,
    displayName: "Pull Seat",
    permissions: ["accept_work"],
  });
  const roomKey = f.store.issueAccessKey("commons", identity.identityId);
  const origin = await startServer(t, f);

  const registered = await post(origin, "/api/agent-heartbeats", {
    hostId: "grok-home-1", mode: "pull-only", cadenceSeconds: 60,
  }, roomKey);
  assert.equal(registered.status, 200);
  const doc = await registered.json();
  assert.equal(doc.agentId, identity.identityId);
  assert.equal(doc.host.mode, "pull-only");
  assert.equal(doc.host.wakeUrl, null);
  assert.match(doc.host.hostId, /^rk_[a-f0-9]+_[a-f0-9]+$/);
  assert.deepEqual(doc.pendingWakes, []);

  at += HEARTBEAT_STALE_AFTER_MS + 1000;
  f.store.command(f.keys.owner, "commons", {
    id: randomUUID(),
    type: "message.posted",
    data: { messageId: "mention-pull-seat", body: `hey @${identity.identityId} the room is waiting` },
  });

  const woken = await post(origin, "/api/agent-heartbeats", {
    hostId: "grok-home-1", mode: "pull-only", cadenceSeconds: 60,
  }, roomKey);
  assert.equal(woken.status, 200);
  const after = await woken.json();
  assert.equal(after.pendingWakes.length, 1);
  assert.equal(after.pendingWakes[0].kind, "mention");
  assert.equal(after.pendingWakes[0].roomId, "commons");
  assert.equal(after.pendingWakes[0].messageId, "mention-pull-seat");
});

test("room access key cannot install a wake URL or replace a wakeable host", async t => {
  const f = createAcceptanceFixture();
  const identity = f.store.identities.create("Wake Seat");
  f.store.identities.link(f.keys.owner, "commons", {
    identityId: identity.identityId,
    memberId: identity.identityId,
    displayName: "Wake Seat",
    permissions: ["accept_work"],
  });
  const roomKey = f.store.issueAccessKey("commons", identity.identityId);
  const origin = await startServer(t, f);

  const wakeable = await post(origin, "/api/agent-heartbeats", {
    hostId: "secret-host", mode: "wakeable", wakeUrl: "https://host.example.test/wake",
  }, roomKey);
  assert.equal(wakeable.status, 403);
  assert.equal(await errorCode(wakeable), "room_key_wake_refused");
  assert.equal(f.store.agentHeartbeats.statusOf(identity.identityId).status, "unregistered");

  assert.equal((await post(origin, "/api/agent-heartbeats", {
    hostId: "secret-host", mode: "wakeable", wakeUrl: "https://host.example.test/wake",
  }, identity.secret)).status, 200);

  const replaced = await post(origin, "/api/agent-heartbeats", {
    hostId: "secret-host", mode: "pull-only",
  }, roomKey);
  assert.equal(replaced.status, 403);
  assert.equal(await errorCode(replaced), "room_key_wake_refused");
  const hosts = f.store.agentHeartbeats.statusOf(identity.identityId).hosts;
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].mode, "wakeable");
  assert.equal(hosts[0].wakeUrl, "https://host.example.test/wake");

  const human = await post(origin, "/api/agent-heartbeats", {
    hostId: "owner-host", mode: "pull-only",
  }, f.keys.owner);
  assert.equal(human.status, 403);
  assert.equal(await errorCode(human), "room_key_heartbeat_refused");
});

async function seat(t) {
  const f = createAcceptanceFixture();
  const identity = f.store.identities.create("Scoped seat");
  f.store.identities.link(f.keys.owner, "commons", { identityId: identity.identityId,
    memberId: "scoped-seat", permissions: [] });
  const roomKey = f.store.issueAccessKey("commons", "scoped-seat");
  return { f, identity, roomKey, origin: await startServer(t, f) };
}

test("room key cannot read or acknowledge another room's historical wake, or expose identity hosts", async t => {
  const { f, identity, roomKey, origin } = await seat(t);
  f.store.agentHeartbeats.heartbeat({ agentId: identity.identityId, hostId: "identity-private-host",
    mode: "wakeable", wakeUrl: "https://private-host.example.test/secret-path" });
  const other = f.store.agentHeartbeats.enqueueWake({ agentId: identity.identityId,
    kind: "mention", roomId: "former-room", messageId: "private-message" }).signal;
  const own = f.store.agentHeartbeats.enqueueWake({ agentId: identity.identityId,
    kind: "mention", roomId: "commons", messageId: "own-message" }).signal;
  const report = await post(origin, "/api/agent-heartbeats", { hostId: "local", mode: "pull-only" }, roomKey);
  assert.equal(report.status, 200);
  assert.deepEqual((await report.json()).pendingWakes.map(x => x.messageId), ["own-message"]);
  const read = await fetch(`${origin}/api/agent-heartbeats`, { headers: { authorization: `Bearer ${roomKey}` } });
  assert.equal(read.status, 200);
  const state = await read.json();
  assert.equal(JSON.stringify(state).includes("secret-path"), false);
  assert.equal(JSON.stringify(state).includes("identity-private-host"), false);
  const ack = await post(origin, "/api/agent-heartbeats/ack", { signalIds: [other.signalId, own.signalId] }, roomKey);
  assert.equal(ack.status, 200);
  assert.deepEqual((await ack.json()).acknowledged, [own.signalId]);
  assert.deepEqual(f.store.agentHeartbeats.pendingWakes(identity.identityId).map(x => x.messageId), ["private-message"]);
});

test("room key refuses revoked or ambiguous linked identity", async t => {
  const { f, identity, roomKey, origin } = await seat(t);
  const other = f.store.identities.create("Other");
  f.store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
    .run("commons", other.identityId, "scoped-seat", Date.now());
  assert.equal((await post(origin, "/api/agent-heartbeats", {hostId:"local",mode:"pull-only"},roomKey)).status,403);
  f.store.db.prepare("DELETE FROM identity_links WHERE identity_id=?").run(other.identityId);
  f.store.identities.revoke(identity.identityId, identity.secret);
  assert.equal((await post(origin, "/api/agent-heartbeats", {hostId:"local",mode:"pull-only"},roomKey)).status,403);
  assert.equal(f.store.agentHeartbeats.statusOf(identity.identityId).status,"unregistered");
});

for (const path of ["/api/agent-heartbeats", "/api/agent-heartbeats/ack"]) test(`room key revocation during upload refuses ${path}`, async t => {
  const { request: httpRequest } = await import("node:http");
  const { f, identity, roomKey, origin } = await seat(t);
  const signal = f.store.agentHeartbeats.enqueueWake({ agentId: identity.identityId,
    kind: "mention", roomId: "commons", messageId: "unacknowledged" }).signal;
  const data = path.endsWith("ack") ? { signalIds: [signal.signalId] } : {hostId:"local",mode:"pull-only"};
  let observed;
  const authenticated = new Promise(resolve => { observed = resolve; });
  const original = f.store.authenticate.bind(f.store);
  f.store.authenticate = (...args) => { const auth = original(...args);
    if (args[0] === roomKey) { f.store.authenticate = original; observed(); } return auth; };
  t.after(() => { f.store.authenticate = original; });
  const serialized = JSON.stringify(data);
  let request;
  const completed = new Promise((resolve, reject) => {
    request = httpRequest(new URL(path, origin), { method: "POST", headers: {
      authorization: `Bearer ${roomKey}`, "content-type":"application/json", "content-length":Buffer.byteLength(serialized)
    } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    request.on("error", reject);
  });
  t.after(() => request.destroy());
  request.write(serialized.slice(0,1)); await authenticated;
  f.store.revoke(roomKey); request.end(serialized.slice(1));
  assert.equal(await completed,401);
  assert.equal(f.store.agentHeartbeats.statusOf(identity.identityId).status,"unregistered");
  assert.equal(f.store.agentHeartbeats.pendingWakes(identity.identityId).length,1);
});

test("room key host names cannot modify identity-owned pull-only host configuration", async t => {
  const { f, identity, roomKey, origin } = await seat(t);
  f.store.agentHeartbeats.heartbeat({agentId:identity.identityId,hostId:"shared-name",mode:"pull-only",cadenceSeconds:120});
  const result=await post(origin,"/api/agent-heartbeats",{hostId:"shared-name",mode:"pull-only",cadenceSeconds:30},roomKey);
  assert.equal(result.status,200);
  const hosts=f.store.agentHeartbeats.statusOf(identity.identityId).hosts;
  assert.equal(hosts.find(x=>x.hostId==="shared-name").cadenceSeconds,120);
  assert.equal(hosts.length,2);
  const push=await post(origin,"/api/agent-heartbeats",{hostId:"local",mode:"pull-only",pushNotification:{url:"https://example.test"}},roomKey);
  assert.equal(push.status,403);
});

test("room key refuses multi-room identity and an unlinked member", async t => {
  const { f, identity, roomKey, origin } = await seat(t);
  // A real second active link (to a second member in the existing work room).
  const { initialRoom } = await import("../server/bootstrap.mjs");
  f.store.initialize(initialRoom("other-room"));
  const ownerKey=f.store.issueAccessKey("other-room","owner");
  f.store.identities.link(ownerKey,"other-room",{identityId:identity.identityId,permissions:[]});
  assert.equal((await post(origin,"/api/agent-heartbeats",{hostId:"local",mode:"pull-only"},roomKey)).status,403);
  f.store.db.prepare("DELETE FROM identity_links WHERE identity_id=?").run(identity.identityId);
  assert.equal((await post(origin,"/api/agent-heartbeats",{hostId:"local",mode:"pull-only"},roomKey)).status,403);
});
