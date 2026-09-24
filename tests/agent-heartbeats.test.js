// Wakeable agent presence (RC-2026-09-18-051): heartbeat endpoint, host
// status transitions, wake queueing/delivery, and wake-on-mention.
// Synthetic fixtures only — no network calls, no real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import {
  AgentHeartbeats, HeartbeatError, agentHeartbeatSchema,
  HEARTBEAT_STALE_AFTER_MS,
} from "../server/agent-heartbeats.mjs";
import { buildWakePing, WAKE_PING_EVENT } from "../server/outbound-webhooks.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

const T0 = 1_750_000_000_000;

// ---- Pure unit tests over an in-memory SQLite database ----

function unit(t, { staleAfterMs = HEARTBEAT_STALE_AFTER_MS } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at }, { staleAfterMs });
  t.after(() => db.close());
  return { hb, advance: ms => { at += ms; }, at: () => at };
}

const wakeable = (hostId = "host-1") => ({
  agentId: "ai_testagent", hostId, mode: "wakeable", wakeUrl: "https://host.example.test/wake",
});

// HTTP heartbeat bodies carry no agentId: the route owns the identity.
const beat = (hostId = "host-1") => ({
  hostId, mode: "wakeable", wakeUrl: "https://host.example.test/wake",
});

test("heartbeat validates mode, host id, and the wakeable wake-URL contract", t => {
  const { hb } = unit(t);
  assert.throws(() => hb.heartbeat({ ...wakeable(), mode: "sleepy" }), err =>
    err instanceof HeartbeatError && err.status === 422 && err.code === "invalid_heartbeat");
  assert.throws(() => hb.heartbeat({ ...wakeable(), hostId: "bad id!" }), /hostId/);
  assert.throws(() => hb.heartbeat({ agentId: "ai_testagent", hostId: "h", mode: "wakeable", wakeUrl: null }), /wake URL/);
  assert.throws(() => hb.heartbeat({ agentId: "ai_testagent", hostId: "h", mode: "wakeable", wakeUrl: "http://insecure.test/wake" }), /wake URL/);
  assert.throws(() => hb.heartbeat({ ...wakeable(), mode: "pull-only" }), /pull-only/);
  // pull-only without a wake URL is the valid polling shape.
  const { host } = hb.heartbeat({ agentId: "ai_testagent", hostId: "poller", mode: "pull-only" });
  assert.equal(host.mode, "pull-only");
  assert.equal(host.wakeUrl, null);
});

test("heartbeat upserts hosts and derives online/offline/unregistered status", t => {
  const { hb, advance, at } = unit(t);
  assert.equal(hb.statusOf("ai_testagent").status, "unregistered", "no hosts yet");
  hb.heartbeat(wakeable("host-1"));
  let status = hb.statusOf("ai_testagent");
  assert.equal(status.status, "online");
  assert.equal(status.lastSeenAt, at());
  assert.equal(status.hosts.length, 1);
  assert.equal(status.hosts[0].state, "online");
  advance(HEARTBEAT_STALE_AFTER_MS + 1);
  status = hb.statusOf("ai_testagent");
  assert.equal(status.status, "offline", "stale host reads offline");
  assert.equal(status.hosts[0].state, "stale");
  // A fresh heartbeat from a second host brings the agent back online;
  // the stale host keeps its own state.
  hb.heartbeat(wakeable("host-2"));
  status = hb.statusOf("ai_testagent");
  assert.equal(status.status, "online");
  assert.equal(status.hosts.length, 2);
  assert.deepEqual(status.hosts.map(h => h.state).sort(), ["online", "stale"]);
  // Re-heartbeat updates the existing host row instead of duplicating it.
  hb.heartbeat(wakeable("host-1"));
  assert.equal(hb.statusOf("ai_testagent").hosts.length, 2);
});

test("wake signals coalesce per message and deliver through pending/ack", t => {
  const { hb } = unit(t);
  hb.heartbeat(wakeable());
  const first = hb.enqueueWake({ agentId: "ai_testagent", kind: "mention", roomId: "room-1", messageId: "msg-1" });
  assert.equal(first.enqueued, true);
  assert.equal(first.signal.kind, "mention");
  const dup = hb.enqueueWake({ agentId: "ai_testagent", kind: "mention", roomId: "room-1", messageId: "msg-1" });
  assert.equal(dup.enqueued, false, "same message wakes once");
  assert.equal(dup.signal.signalId, first.signal.signalId);
  hb.enqueueWake({ agentId: "ai_testagent", kind: "dm", roomId: "room-1", messageId: "msg-2" });
  const pending = hb.pendingWakes("ai_testagent");
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map(s => s.messageId), ["msg-1", "msg-2"], "oldest first");
  // Heartbeat returns the pending signals without consuming them.
  const { pendingWakes } = hb.heartbeat(wakeable());
  assert.equal(pendingWakes.length, 2);
  // Ack is idempotent: unknown and already-delivered ids report nothing.
  assert.deepEqual(hb.ackWakes({ agentId: "ai_testagent", signalIds: [pending[0].signalId] }).acknowledged, [pending[0].signalId]);
  assert.deepEqual(hb.ackWakes({ agentId: "ai_testagent", signalIds: [pending[0].signalId, "ws_nope"] }).acknowledged, []);
  assert.equal(hb.pendingWakes("ai_testagent").length, 1);
  assert.throws(() => hb.ackWakes({ agentId: "ai_testagent", signalIds: [] }), /signalIds/);
});

test("wakeIfOffline only wakes offline registered agents", t => {
  const { hb, advance } = unit(t);
  assert.equal(hb.wakeIfOffline({ agentId: "ai_testagent", kind: "mention", messageId: "m1" }).woken, false,
    "unregistered agent has nowhere to deliver");
  hb.heartbeat(wakeable());
  assert.equal(hb.wakeIfOffline({ agentId: "ai_testagent", kind: "mention", messageId: "m1" }).woken, false,
    "online agent already sees the message");
  advance(HEARTBEAT_STALE_AFTER_MS + 1);
  const { woken, enqueued, signal } = hb.wakeIfOffline({ agentId: "ai_testagent", kind: "dm", roomId: "r", messageId: "m2" });
  assert.equal(woken, true);
  assert.equal(enqueued, true);
  assert.equal(signal.kind, "dm");
  assert.equal(hb.pendingWakes("ai_testagent").length, 1);
});

test("hosts and signals survive a restart (new instance on the same database)", t => {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const first = new AgentHeartbeats({ db, now: () => at });
  first.heartbeat(wakeable());
  first.enqueueWake({ agentId: "ai_testagent", kind: "mention", roomId: "r", messageId: "m1" });
  const second = new AgentHeartbeats({ db, now: () => at });
  assert.equal(second.verifySchema(), true);
  assert.equal(second.statusOf("ai_testagent").status, "online");
  assert.equal(second.pendingWakes("ai_testagent").length, 1);
  db.close();
});

test("buildWakePing carries the canonical agent.wake payload", () => {
  const signal = { signalId: "ws_1", agentId: "ai_x", kind: "mention", roomId: "r", messageId: "m" };
  const payload = buildWakePing({ agentId: "ai_x", signal });
  assert.equal(payload.event, WAKE_PING_EVENT);
  assert.equal(payload.event, "agent.wake");
  assert.equal(payload.agentId, "ai_x");
  assert.deepEqual(payload.signal, signal);
  assert.throws(() => buildWakePing({ agentId: "ai_x", signal: { kind: "mention" } }), /signalId/);
});

// ---- HTTP integration: heartbeat endpoints, mention trigger, directory ----

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});
const errorCode = async res => (await res.json()).error?.code;

// Fixture with a controllable clock and one linked agent identity whose
// member id is "wakeagent" (so "@wakeagent" resolves to it).
test("heartbeat endpoints: auth, scopes, validation, and the ack roundtrip", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("hb-agent");

  assert.equal((await post(origin, "/api/agent-heartbeats", beat())).status, 401);
  const scoped = await (await post(origin, "/api/agent-keys",
    { scopes: ["heartbeats:report", "heartbeats:read"] }, identity.secret)).json();
  const readOnly = await (await post(origin, "/api/agent-keys",
    { scopes: ["heartbeats:read"] }, identity.secret)).json();
  const wrongScope = await (await post(origin, "/api/agent-keys",
    { scopes: ["directory:publish"] }, identity.secret)).json();

  assert.equal((await post(origin, "/api/agent-heartbeats", wakeable(), wrongScope.credential)).status, 403);
  assert.equal(await errorCode(await post(origin, "/api/agent-heartbeats",
    { hostId: "h", mode: "wakeable" }, scoped.credential)), "invalid_heartbeat");

  const reported = await post(origin, "/api/agent-heartbeats", beat("host-a"), scoped.credential);
  assert.equal(reported.status, 200);
  const reportedDoc = await reported.json();
  assert.equal(reportedDoc.agentId, identity.identityId);
  assert.equal(reportedDoc.host.mode, "wakeable");
  assert.deepEqual(reportedDoc.pendingWakes, []);
  assert.deepEqual(reportedDoc.next, [], "no acks to teach when nothing is queued");

  const status = await get(origin, "/api/agent-heartbeats", readOnly.credential);
  assert.equal(status.status, 200);
  const statusDoc = await status.json();
  assert.equal(statusDoc.status, "online");
  assert.equal(statusDoc.hosts.length, 1);

  // Owner identity secret grants both scopes without a key.
  const ownerStatus = await get(origin, "/api/agent-heartbeats", identity.secret);
  assert.equal(ownerStatus.status, 200);

  // Enqueue a signal directly, then drive the heartbeat → ack roundtrip.
  f.store.agentHeartbeats.enqueueWake({ agentId: identity.identityId, kind: "mention", roomId: "commons", messageId: "m-x" });
  const withPending = await (await post(origin, "/api/agent-heartbeats", beat("host-a"), scoped.credential)).json();
  assert.equal(withPending.pendingWakes.length, 1);
  assert.equal(withPending.next[0].action, "ack-wakes");
  const acked = await post(origin, "/api/agent-heartbeats/ack",
    { signalIds: withPending.pendingWakes.map(s => s.signalId) }, readOnly.credential);
  assert.equal(acked.status, 403, "heartbeats:read cannot ack");
  const ackedOk = await post(origin, "/api/agent-heartbeats/ack",
    { signalIds: withPending.pendingWakes.map(s => s.signalId) }, scoped.credential);
  assert.equal(ackedOk.status, 200);
  assert.equal((await ackedOk.json()).acknowledged.length, 1);
  const after = await (await post(origin, "/api/agent-heartbeats", beat("host-a"), scoped.credential)).json();
  assert.deepEqual(after.pendingWakes, []);
});

test("mention of an offline agent enqueues a wake and journals the webhook ping", async t => {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("wake-agent");
  f.store.identities.link(f.keys.owner, "commons", {
    identityId: identity.identityId, memberId: "wakeagent",
    displayName: "Wake Agent", permissions: ["accept_work"],
  });
  // Consent-bound DMs: the owner's test DM to wakeagent needs approval.
  f.store.dmConsents.request("commons", "owner", "wakeagent", "test fixture");
  f.store.dmConsents.decide("commons", "wakeagent", "owner", "approve");

  // Register a wakeable host, then let it go stale.
  assert.equal((await post(origin, "/api/agent-heartbeats", beat("host-1"), identity.secret)).status, 200);
  const sub = await (await post(origin, "/api/agent-webhooks",
    { url: "https://agent.example.test/wake", events: ["agent.wake"] }, identity.secret)).json();
  assert.equal(sub.events[0], "agent.wake", "agents can subscribe to their wake pings");
  at += HEARTBEAT_STALE_AFTER_MS + 1000;

  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "message.posted",
    data: { messageId: "mention-1", body: "hey @wakeagent, take a look when you are back" } });

  const pending = f.store.agentHeartbeats.pendingWakes(identity.identityId);
  assert.equal(pending.length, 1, "one wake signal for the mention");
  assert.equal(pending[0].kind, "mention");
  assert.equal(pending[0].messageId, "mention-1");

  const journal = f.store.agentPlugin.webhookJournalFor({ identityId: identity.identityId, subscriptionId: sub.subscriptionId });
  const wakeDeliveries = journal.filter(d => d.eventType === "agent.wake");
  // Subscription URL + the registered wakeUrl (same ping, same sender).
  assert.equal(wakeDeliveries.length, 2, "the wake ping is journaled pending for the subscriber and its wakeUrl");
  assert.ok(wakeDeliveries.every(d => d.state === "pending"));
  assert.equal(wakeDeliveries[0].attempts, 0, "journal entries are secret-safe and carry no payload data");
  assert.equal(wakeDeliveries[0].data, undefined);

  // A DM wakes with kind dm (coalescing on messageId is covered at the
  // unit level; the room itself rejects duplicate messageIds).
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "message.posted",
    data: { messageId: "dm-1", body: "direct ping", toMemberId: "wakeagent" } });
  const afterDm = f.store.agentHeartbeats.pendingWakes(identity.identityId);
  assert.equal(afterDm.length, 2);
  assert.equal(afterDm[1].kind, "dm");

  // The next heartbeat delivers both signals.
  const hb = await (await post(origin, "/api/agent-heartbeats", beat("host-1"), identity.secret)).json();
  assert.deepEqual(hb.pendingWakes.map(s => s.messageId), ["mention-1", "dm-1"]);
});

test("online agents and non-agent mentions are never woken", async t => {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("wake-agent-2");
  f.store.identities.link(f.keys.owner, "commons", {
    identityId: identity.identityId, memberId: "wakeagent2",
    displayName: "Wake Agent Two", permissions: ["accept_work"],
  });
  await post(origin, "/api/agent-heartbeats", beat("host-1"), identity.secret);

  // Fresh heartbeat: the agent is online, so the mention wakes nobody.
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "message.posted",
    data: { messageId: "online-mention", body: "hey @wakeagent2 you are here" } });
  assert.deepEqual(f.store.agentHeartbeats.pendingWakes(identity.identityId), []);

  // Mentions that resolve to nobody (or to humans) wake nobody either.
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "message.posted",
    data: { messageId: "nobody-mention", body: "hey @ghost-agent and @guest" } });
  assert.deepEqual(f.store.agentHeartbeats.pendingWakes(identity.identityId), []);
});

test("room presence lists agent members with additive host presence", async t => {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("wake-agent-3");
  f.store.identities.link(f.keys.owner, "commons", {
    identityId: identity.identityId, memberId: "wakeagent3",
    displayName: "Wake Agent Three", permissions: ["accept_work"],
  });
  const presenceOf = async () => {
    const res = await get(origin, "/api/rooms/commons/presence", f.keys.owner);
    assert.equal(res.status, 200);
    return (await res.json()).members.find(m => m.memberId === "wakeagent3");
  };

  // No heartbeat yet: the agent is not in the presence list, or unregistered.
  assert.equal((await presenceOf())?.presence ?? null, null,
    "agents without hosts have no presence field or are absent");

  await post(origin, "/api/agent-heartbeats", beat("host-1"), identity.secret);
  let listed = await presenceOf();
  assert.ok(listed, "online agents appear in presence");
  assert.equal(listed.presence.status, "online");
  assert.equal(typeof listed.presence.lastSeenAt, "number");

  at += HEARTBEAT_STALE_AFTER_MS + 1000;
  listed = await presenceOf();
  assert.ok(listed, "offline agents with registered hosts are still listed");
  assert.equal(listed.presence.status, "offline");
  assert.equal(listed.watching, false);

  // Human members keep presence: null (additive, not breaking).
  const humans = (await (await get(origin, "/api/rooms/commons/presence", f.keys.owner)).json()).members;
  assert.ok(humans.every(m => m.kind === "agent" || m.presence === null));
});

test("directory cards carry host-reported presence (additive field)", async t => {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("dir-presence");
  const keyPair = generateKeyPair();
  const card = { name: "Presence Agent", description: "Card presence fixture.", capabilities: ["chat"], version: "1.0.0" };
  const published = await post(origin, "/api/agent-directory/cards", {
    agentId: "presence-agent",
    card,
    publicKey: keyPair.publicKey,
    signature: signCard({ agentId: "presence-agent", card, privateKey: keyPair.privateKey }),
    visibility: "public",
  }, identity.secret);
  assert.equal(published.status, 201);

  // No host registered yet: presence is present but unregistered.
  let doc = await (await get(origin, "/api/agents/directory/presence-agent")).json();
  assert.deepEqual(doc.presence, { status: "unregistered", lastSeenAt: null, hosts: 0 });

  await post(origin, "/api/agent-heartbeats", beat("host-1"), identity.secret);
  doc = await (await get(origin, "/api/agents/directory/presence-agent")).json();
  assert.equal(doc.presence.status, "online");
  assert.equal(doc.presence.hosts, 1);
  assert.equal(typeof doc.presence.lastSeenAt, "number");

  at += HEARTBEAT_STALE_AFTER_MS + 1000;
  doc = await (await get(origin, "/api/agents/directory/presence-agent")).json();
  assert.equal(doc.presence.status, "offline");
});
