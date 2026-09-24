// Push wake path (RC-2026-09-24-203): extended heartbeat body, per-host
// reachability windows, pointer-only push delivery, failure suspension and
// re-arm, the four event triggers, and the agent-card capability flag.
// Synthetic fixtures only — fetch and DNS are injected mocks; no real
// network calls, no real credentials.
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
import { agentCard } from "../deploy/agent-discovery.mjs";

const T0 = 1_750_000_000_000;
const PUSH_URL = "https://push.example.test/hooks/room";
const TOKEN = "opaque-push-token-123";

function unit(t, { staleAfterMs = HEARTBEAT_STALE_AFTER_MS } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at }, { staleAfterMs });
  t.after(() => db.close());
  return { hb, advance: ms => { at += ms; }, at: () => at };
}

const wakeable = (hostId = "host-1", extra = {}) => ({
  agentId: "ai_testagent", hostId, mode: "wakeable",
  wakeUrl: "https://host.example.test/wake", ...extra,
});
const pushSub = (extra = {}) => ({
  url: PUSH_URL, token: TOKEN, ...extra,
});

// Mock transport: records every POST, answers with a controllable status.
// DNS resolves the push host to a public address by default.
function mockTransport({ status = 200 } = {}) {
  const calls = [];
  let currentStatus = status;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: opts.body });
    return {
      status: currentStatus,
      headers: { get: () => null },
      text: async () => (currentStatus === 200 ? "" : "receiver-error"),
    };
  };
  const dnsResolvers = {
    resolve4: async () => ["93.184.216.34"],
    resolve6: async () => [],
  };
  return { calls, fetchImpl, dnsResolvers, setStatus: s => { currentStatus = s; } };
}

const pushFailuresOf = (hb, agentId = "ai_testagent", hostId = "host-1") => {
  const row = hb.db.prepare("SELECT push_failures AS failures, push_suspended AS suspended FROM agent_push_configs WHERE agent_id=? AND host_id=?")
    .get(agentId, hostId);
  return { failures: row?.failures ?? null, suspended: row?.suspended ?? null };
};

// ---- Validation ----

test("heartbeat validates cadenceSeconds", t => {
  const { hb } = unit(t);
  for (const bad of [0, -5, NaN, Infinity, "300", null]) {
    if (bad === null) continue; // null means "absent"
    assert.throws(() => hb.heartbeat({ ...wakeable(), cadenceSeconds: bad }), err =>
      err instanceof HeartbeatError && err.status === 422 && /cadenceSeconds/.test(err.message), `cadence ${String(bad)}`);
  }
  const { host } = hb.heartbeat({ ...wakeable(), cadenceSeconds: 300 });
  assert.equal(host.cadenceSeconds, 300);
  const bare = hb.heartbeat({ ...wakeable("host-2") });
  assert.equal(bare.host.cadenceSeconds, null, "absent cadence reads null");
});

test("heartbeat validates pushNotification shape", t => {
  const { hb } = unit(t);
  const badSubs = [
    [{ ...pushSub({ url: "http://insecure.test/hook" }) }, /pushNotification\.url/],
    [{ ...pushSub({ url: "https://127.0.0.1/hook" }) }, /pushNotification\.url/],
    [{ ...pushSub({ url: "https://10.0.0.5/hook" }) }, /pushNotification\.url/],
    [{ url: PUSH_URL }, /token/],
    [{ ...pushSub({ token: "" }) }, /token/],
    [{ ...pushSub({ token: "x".repeat(501) }) }, /token/],
    [{ ...pushSub({ authentication: { schemes: ["basic"], credentials: "c" } }) }, /schemes/],
    [{ ...pushSub({ authentication: { schemes: ["bearer"] } }) }, /credentials/],
    [{ ...pushSub({ authentication: { schemes: ["bearer", "bearer"], credentials: "c" } }) }, /schemes/],
    [{ ...pushSub({ authentication: "bearer-token" }) }, /authentication/],
    [{ ...pushSub({ extra: true }) }, /pushNotification accepts/],
    ["not-an-object", /pushNotification must be an object/],
  ];
  for (const [sub, pattern] of badSubs) {
    assert.throws(() => hb.heartbeat({ ...wakeable(), pushNotification: sub }), err =>
      err instanceof HeartbeatError && err.status === 422 && pattern.test(err.message), `sub ${JSON.stringify(sub)?.slice(0, 60)}`);
  }
  // Valid shapes pass, with and without authentication.
  const withAuth = hb.heartbeat({ ...wakeable(), pushNotification: pushSub({ authentication: { schemes: ["bearer"], credentials: "cred-1" } }) });
  assert.equal(withAuth.pushConfigured, true);
  const withoutAuth = hb.heartbeat({ ...wakeable("host-2"), pushNotification: pushSub() });
  assert.equal(withoutAuth.pushConfigured, true);
});

test("heartbeat response never echoes the token or credentials", t => {
  const { hb } = unit(t);
  const secret = "super-secret-token-value";
  const creds = "super-secret-credentials-value";
  const res = hb.heartbeat({ ...wakeable(), cadenceSeconds: 300,
    pushNotification: pushSub({ token: secret, authentication: { schemes: ["bearer"], credentials: creds } }) });
  const serialized = JSON.stringify(res);
  assert.ok(!serialized.includes(secret), "token must never appear in the response");
  assert.ok(!serialized.includes(creds), "bearer credentials must never appear in the response");
});

test("old heartbeat bodies keep working; pushConfigured defaults false", t => {
  const { hb } = unit(t);
  const bare = hb.heartbeat({ agentId: "ai_testagent", hostId: "h", mode: "wakeable", wakeUrl: "https://host.example.test/wake" });
  assert.equal(bare.pushConfigured, false);
  assert.equal(bare.reachability.mode, "poller", "inside the window with no push reads poller");
  assert.equal(typeof bare.reachability.reachableUntil, "number");
  const poller = hb.heartbeat({ agentId: "ai_testagent", hostId: "p", mode: "pull-only" });
  assert.equal(poller.pushConfigured, false);
  assert.equal(poller.reachability.mode, "poller");
});

test("one subscription per host: each heartbeat replaces the push config", t => {
  const { hb } = unit(t);
  hb.heartbeat({ ...wakeable(), pushNotification: pushSub({ url: "https://a.example.test/hook" }) });
  const replaced = hb.heartbeat({ ...wakeable(), pushNotification: pushSub({ url: "https://b.example.test/hook" }) });
  assert.equal(replaced.pushConfigured, true);
  const row = hb.db.prepare("SELECT push_url AS url FROM agent_push_configs WHERE agent_id=? AND host_id=?")
    .get("ai_testagent", "host-1");
  assert.equal(row.url, "https://b.example.test/hook");
  const count = hb.db.prepare("SELECT COUNT(*) AS n FROM agent_push_configs WHERE agent_id=? AND host_id=?")
    .get("ai_testagent", "host-1").n;
  assert.equal(count, 1, "a second heartbeat replaces, not duplicates");
  // A bare heartbeat leaves the subscription alone (backward compatible).
  hb.heartbeat({ ...wakeable() });
  const kept = hb.db.prepare("SELECT push_url AS url FROM agent_push_configs WHERE agent_id=? AND host_id=?")
    .get("ai_testagent", "host-1");
  assert.equal(kept.url, "https://b.example.test/hook", "bare heartbeats never wipe a configured subscription");
});

// ---- Reachability window rule ----

test("reachability window is max(180s, cadenceSeconds * 1.5) per host", t => {
  const { hb, advance } = unit(t);
  // No cadence: the 180s default.
  hb.heartbeat(wakeable("no-cadence"));
  advance(HEARTBEAT_STALE_AFTER_MS + 1);
  assert.equal(hb.statusOf("ai_testagent").status, "offline", "undeclared hosts read stale after 180s");
  assert.equal(hb.statusOf("ai_testagent").hosts.find(h => h.hostId === "no-cadence").state, "stale");
});

test("a declared cadence stretches the window", t => {
  const { hb, advance } = unit(t);
  hb.heartbeat(wakeable("cadenced", { cadenceSeconds: 300 })); // window = 450s
  advance(200_000);
  let status = hb.statusOf("ai_testagent");
  assert.equal(status.status, "online", "200s < 450s window stays online");
  assert.equal(status.hosts[0].state, "online");
  advance(250_001); // 450001 total
  status = hb.statusOf("ai_testagent");
  assert.equal(status.status, "offline", "past 450s the host reads stale");
});

test("a short cadence never shrinks the 180s floor", t => {
  const { hb, advance } = unit(t);
  hb.heartbeat(wakeable("short", { cadenceSeconds: 60 })); // 60*1.5=90s < 180s floor
  advance(100_000);
  assert.equal(hb.statusOf("ai_testagent").status, "online", "100s < 180s floor stays online");
  advance(80_001);
  assert.equal(hb.statusOf("ai_testagent").status, "offline");
});

test("windowFor exposes the rule directly", t => {
  const { hb } = unit(t);
  assert.equal(hb.windowFor(null), 180000);
  assert.equal(hb.windowFor(undefined), 180000);
  assert.equal(hb.windowFor(300), 450000);
  assert.equal(hb.windowFor(60), 180000);
  assert.equal(hb.windowFor(-10), 180000);
});

// ---- Push delivery ----

async function offlineWithPush(t, transport, sub = pushSub()) {
  const { hb, advance } = unit(t);
  hb.setPushTransport(transport);
  hb.heartbeat({ ...wakeable(), cadenceSeconds: 300, pushNotification: sub });
  advance(450_001); // past the 300s cadence window (450s)
  assert.equal(hb.statusOf("ai_testagent").status, "offline");
  return { hb };
}

test("push delivery POSTs a pointer-only body with the token header", async t => {
  const transport = mockTransport();
  const { hb } = await offlineWithPush(t, transport);
  hb.pushNotify({ identityId: "ai_testagent", eventType: "message.posted", roomId: "room-1", id: "evt-1", ts: T0 });
  await hb.flushPushes();
  assert.equal(transport.calls.length, 1);
  const call = transport.calls[0];
  assert.equal(call.url, PUSH_URL);
  assert.equal(call.headers["Content-Type"], "application/json");
  assert.equal(call.headers["X-Room-Notification-Token"], TOKEN);
  const body = JSON.parse(call.body);
  assert.deepEqual(Object.keys(body).sort(), ["eventType", "id", "roomId", "ts"]);
  assert.deepEqual(body, { eventType: "message.posted", roomId: "room-1", id: "evt-1", ts: T0 });
  assert.deepEqual(pushFailuresOf(hb), { failures: 0, suspended: 0 }, "2xx resets failures");
});

test("all four event types flow through the pointer body", async t => {
  const transport = mockTransport();
  const { hb } = await offlineWithPush(t, transport);
  for (const eventType of ["message.posted", "dm.posted", "bond.proposed", "assignment.created"]) {
    hb.pushNotify({ identityId: "ai_testagent", eventType, roomId: "r", id: `id-${eventType}`, ts: T0 });
  }
  await hb.flushPushes();
  assert.equal(transport.calls.length, 4);
  assert.deepEqual(transport.calls.map(c => JSON.parse(c.body).eventType),
    ["message.posted", "dm.posted", "bond.proposed", "assignment.created"]);
});

test("three consecutive failures suspend the subscription", async t => {
  const transport = mockTransport({ status: 500 });
  const { hb } = await offlineWithPush(t, transport);
  for (let i = 1; i <= 3; i++) {
    hb.pushNotify({ identityId: "ai_testagent", eventType: "dm.posted", roomId: "r", id: `e${i}`, ts: T0 });
    await hb.flushPushes();
    const { failures, suspended } = pushFailuresOf(hb);
    assert.equal(failures, i, `failure ${i} counted`);
    assert.equal(suspended, i >= 3 ? 1 : 0);
  }
  // Suspended: no more POSTs.
  const callsBefore = transport.calls.length;
  hb.pushNotify({ identityId: "ai_testagent", eventType: "dm.posted", roomId: "r", id: "e4", ts: T0 });
  await hb.flushPushes();
  assert.equal(transport.calls.length, callsBefore, "suspended subscriptions are not POSTed");
  // The next heartbeat reports the suspended state (the HTTP layer turns it
  // into a rearm-push hint in next[] — covered in the HTTP section).
  const res = hb.heartbeat({ ...wakeable() });
  assert.equal(res.pushSuspended, true);
  assert.equal(res.reachability.mode, "poller", "suspended push degrades to poller");
});

test("a fresh pushNotification re-arms a suspended subscription", async t => {
  const transport = mockTransport({ status: 500 });
  const { hb } = await offlineWithPush(t, transport);
  for (let i = 0; i < 3; i++) {
    hb.pushNotify({ identityId: "ai_testagent", eventType: "dm.posted", roomId: "r", id: `e${i}`, ts: T0 });
    await hb.flushPushes();
  }
  assert.equal(pushFailuresOf(hb).suspended, 1);
  transport.setStatus(200);
  const rearmed = hb.heartbeat({ ...wakeable(), pushNotification: pushSub({ url: "https://push.example.test/hooks/room" }) });
  assert.deepEqual(pushFailuresOf(hb), { failures: 0, suspended: 0 }, "re-arm resets counters");
  assert.equal(rearmed.pushSuspended, false, "no suspension reported once re-armed");
  assert.equal(rearmed.reachability.mode, "push");
});

test("push fires only for offline agents with a usable push subscription", async t => {
  const transport = mockTransport();
  const { hb, advance } = unit(t);
  hb.setPushTransport(transport);
  // Online agent: no push.
  hb.heartbeat({ ...wakeable("online-host"), pushNotification: pushSub() });
  hb.pushNotify({ identityId: "ai_testagent", eventType: "message.posted", roomId: "r", id: "e1", ts: T0 });
  await hb.flushPushes();
  assert.equal(transport.calls.length, 0, "online agents are never pushed");
  // Pull-only host with a push config: no push (wakeable-only rule).
  hb.heartbeat({ agentId: "ai_poller", hostId: "p1", mode: "pull-only", pushNotification: pushSub() });
  advance(HEARTBEAT_STALE_AFTER_MS + 1);
  hb.pushNotify({ identityId: "ai_poller", eventType: "message.posted", roomId: "r", id: "e2", ts: T0 });
  await hb.flushPushes();
  assert.equal(transport.calls.length, 0, "pull-only hosts never get push POSTs");
  // No push config at all: no push.
  hb.heartbeat({ agentId: "ai_bare", hostId: "b1", mode: "wakeable", wakeUrl: "https://host.example.test/wake" });
  hb.pushNotify({ identityId: "ai_bare", eventType: "message.posted", roomId: "r", id: "e3", ts: T0 });
  await hb.flushPushes();
  assert.equal(transport.calls.length, 0, "unconfigured hosts are never pushed");
  // Unregistered agent: no push, no throw.
  hb.pushNotify({ identityId: "ai_nobody", eventType: "message.posted", roomId: "r", id: "e4", ts: T0 });
  await hb.flushPushes();
  assert.equal(transport.calls.length, 0);
});

test("a success after failures resets the counter before suspension", async t => {
  const transport = mockTransport({ status: 500 });
  const { hb } = await offlineWithPush(t, transport);
  hb.pushNotify({ identityId: "ai_testagent", eventType: "dm.posted", roomId: "r", id: "e1", ts: T0 });
  await hb.flushPushes();
  assert.equal(pushFailuresOf(hb).failures, 1);
  transport.setStatus(200);
  hb.pushNotify({ identityId: "ai_testagent", eventType: "dm.posted", roomId: "r", id: "e2", ts: T0 });
  await hb.flushPushes();
  assert.deepEqual(pushFailuresOf(hb), { failures: 0, suspended: 0 });
});

// ---- HTTP integration ----

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
const errorCode = async res => (await res.json()).error?.code;

test("HTTP: extended heartbeat body and response fields", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("push-agent");
  f.store.agentHeartbeats.setPushTransport({
    dnsResolvers: { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] },
  });

  const token = "http-test-token-xyz";
  const res = await post(origin, "/api/agent-heartbeats", {
    hostId: "h1", mode: "wakeable", wakeUrl: "https://host.example.test/wake",
    cadenceSeconds: 300,
    pushNotification: { url: PUSH_URL, token, authentication: { schemes: ["bearer"], credentials: "cred" } },
  }, identity.secret);
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.ok(!raw.includes(token), "token never echoed in the HTTP response");
  const doc = JSON.parse(raw);
  assert.equal(doc.pushConfigured, true);
  assert.equal(doc.reachability.mode, "push");
  assert.ok(doc.reachability.reachableUntil > Date.now());
  assert.equal(doc.host.cadenceSeconds, 300);
  assert.ok(!doc.next.some(h => h.action === "rearm-push"), "no re-arm hint when healthy");

  // Unknown body fields still 422.
  assert.equal(await errorCode(await post(origin, "/api/agent-heartbeats",
    { hostId: "h1", mode: "wakeable", wakeUrl: "https://host.example.test/wake", bogus: 1 }, identity.secret)),
    "invalid_heartbeat");
  // Old bodies still 200.
  assert.equal((await post(origin, "/api/agent-heartbeats",
    { hostId: "h1", mode: "wakeable", wakeUrl: "https://host.example.test/wake" }, identity.secret)).status, 200);
});

test("HTTP: subscribe-time SSRF guard rejects private targets", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("ssrf-agent");
  const beat = sub => post(origin, "/api/agent-heartbeats", {
    hostId: "h1", mode: "wakeable", wakeUrl: "https://host.example.test/wake",
    pushNotification: sub,
  }, identity.secret);

  // Literal private IPs are rejected synchronously.
  assert.equal(await errorCode(await beat({ url: "https://127.0.0.1/hook", token: TOKEN })), "invalid_heartbeat");
  assert.equal(await errorCode(await beat({ url: "https://10.9.9.9/hook", token: TOKEN })), "invalid_heartbeat");
  // Non-https is rejected.
  assert.equal(await errorCode(await beat({ url: "http://example.test/hook", token: TOKEN })), "invalid_heartbeat");

  // A name that resolves to a private address is rejected via injected DNS.
  f.store.agentHeartbeats.setPushTransport({
    dnsResolvers: { resolve4: async () => ["10.1.2.3"], resolve6: async () => [] },
  });
  assert.equal(await errorCode(await beat({ url: "https://evil.example.test/hook", token: TOKEN })), "invalid_heartbeat");

  // A name that resolves public passes with injected DNS (no real network).
  f.store.agentHeartbeats.setPushTransport({
    dnsResolvers: { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] },
  });
  const ok = await beat({ url: "https://good.example.test/hook", token: TOKEN });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).pushConfigured, true);
});

test("HTTP: suspended push yields a rearm-push hint, re-arm clears it", async t => {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("rearm-agent");
  const transport = mockTransport({ status: 500 });
  f.store.agentHeartbeats.setPushTransport(transport);
  const sub = { hostId: "h1", mode: "wakeable", wakeUrl: "https://host.example.test/wake",
    cadenceSeconds: 60, pushNotification: { url: PUSH_URL, token: TOKEN } };
  assert.equal((await post(origin, "/api/agent-heartbeats", sub, identity.secret)).status, 200);
  at += 200_000; // past the 180s floor window for the 60s cadence
  for (let i = 0; i < 3; i++) {
    f.store.agentHeartbeats.pushNotify({ identityId: identity.identityId, eventType: "dm.posted", roomId: "commons", id: `e${i}`, ts: at });
  }
  await f.store.agentHeartbeats.flushPushes();
  const suspended = await (await post(origin, "/api/agent-heartbeats",
    { hostId: "h1", mode: "wakeable", wakeUrl: "https://host.example.test/wake" }, identity.secret)).json();
  const rearm = suspended.next.find(h => h.action === "rearm-push");
  assert.ok(rearm, "suspended subscription surfaces a rearm-push hint in next[]");
  assert.equal(rearm.method, "POST");
  assert.equal(rearm.path, "/api/agent-heartbeats");
  assert.match(rearm.description, /suspended after 3 failed deliveries/);
  assert.equal(suspended.pushConfigured, true, "push is still configured while suspended");
  assert.equal(suspended.reachability.mode, "poller", "suspended push degrades to poller");
  // Re-arm with a fresh pushNotification clears the hint.
  const cleared = await (await post(origin, "/api/agent-heartbeats", sub, identity.secret)).json();
  assert.ok(!cleared.next.some(h => h.action === "rearm-push"), "re-armed subscription drops the hint");
  assert.equal(cleared.reachability.mode, "push");
});

// ---- Event triggers (store-level, mocked transport) ----

async function triggerFixture(t, memberId = "pushagent") {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("push-trigger-agent");
  f.store.identities.link(f.keys.owner, "commons", {
    identityId: identity.identityId, memberId, displayName: "Push Agent",
    permissions: ["accept_work"],
  });
  const transport = mockTransport();
  f.store.agentHeartbeats.setPushTransport(transport);
  // Register a wakeable host with a push subscription, then let it go stale.
  const hbRes = await post(origin, "/api/agent-heartbeats", {
    hostId: "push-host", mode: "wakeable", wakeUrl: "https://host.example.test/wake",
    cadenceSeconds: 300, pushNotification: { url: PUSH_URL, token: TOKEN },
  }, identity.secret);
  assert.equal(hbRes.status, 200, "heartbeat with push registers");
  at += 450_001; // past the declared 300s cadence window (450s)
  assert.equal(f.store.agentHeartbeats.statusOf(identity.identityId).status, "offline");
  const command = (type, data) => f.store.command(f.keys.owner, "commons", { id: randomUUID(), type, data });
  return { f, origin, identity, transport, command, advance: ms => { at += ms; } };
}

const flushedBodies = async (f, transport) => {
  await f.store.agentHeartbeats.flushPushes();
  return transport.calls.map(c => JSON.parse(c.body));
};

test("trigger: @mention of an offline agent POSTs message.posted", async t => {
  const { f, transport, command } = await triggerFixture(t);
  command("message.posted", { messageId: "mention-push-1", body: "hey @pushagent, you are needed" });
  const bodies = await flushedBodies(f, transport);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].eventType, "message.posted");
  assert.equal(bodies[0].roomId, "commons");
  assert.equal(bodies[0].id, "mention-push-1");
  assert.ok(!("body" in bodies[0]), "pointer-only: no message body in the push");
});

test("trigger: room DM to an offline agent POSTs dm.posted", async t => {
  const { f, transport, command } = await triggerFixture(t);
  // Consent-bound DMs: the owner's DM to pushagent needs approval first.
  f.store.dmConsents.request("commons", "owner", "pushagent", "test fixture");
  f.store.dmConsents.decide("commons", "pushagent", "owner", "approve");
  command("message.posted", { messageId: "dm-push-1", body: "direct ping", toMemberId: "pushagent" });
  const bodies = await flushedBodies(f, transport);
  const dm = bodies.find(b => b.eventType === "dm.posted");
  assert.ok(dm, "a dm.posted doorbell was POSTed");
  assert.equal(dm.id, "dm-push-1");
});

test("trigger: bond proposal POSTs bond.proposed to the offline party", async t => {
  const { f, transport, identity } = await triggerFixture(t, "bondagent");
  const proposer = f.store.identities.create("bond-proposer");
  f.store.identities.link(f.keys.owner, "commons", {
    identityId: proposer.identityId, memberId: "proposer",
    displayName: "Proposer", permissions: ["accept_work"],
  });
  const proposed = f.store.command(proposer.secret, "commons", {
    id: randomUUID(), type: "bond.propose", data: { to: identity.identityId, scopes: ["peer.dm"] },
  });
  assert.equal(proposed.event.type, "bond.proposed");
  const bodies = await flushedBodies(f, transport);
  assert.equal(bodies.length, 1, "exactly one doorbell: the offline proposed-to party");
  assert.equal(bodies[0].eventType, "bond.proposed");
  assert.equal(bodies[0].id, proposed.event.data.bondId);
});

test("trigger: collab assignment to an offline agent POSTs assignment.created", async t => {
  const { f, origin, transport } = await triggerFixture(t, "taskagent");
  const threadId = randomUUID(); // assignThread journals by thread id; no thread row needed
  const assignRes = await post(origin, "/api/rooms/commons/collab/assignments", {
    threadId, assignee: { kind: "agent", id: "taskagent" },
  }, f.keys.owner);
  assert.equal(assignRes.status, 201, "assignment created");
  const { assignmentId } = await assignRes.json();
  const bodies = await flushedBodies(f, transport);
  assert.equal(bodies.length, 1, "exactly one doorbell for the assignment");
  assert.equal(bodies[0].eventType, "assignment.created");
  assert.equal(bodies[0].id, assignmentId);
  assert.equal(bodies[0].roomId, "commons");
});

test("trigger: assignment to an offline agent without push config POSTs nothing", async t => {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("no-push-agent");
  f.store.identities.link(f.keys.owner, "commons", {
    identityId: identity.identityId, memberId: "nopush",
    displayName: "No Push", permissions: ["accept_work"],
  });
  const transport = mockTransport();
  f.store.agentHeartbeats.setPushTransport(transport);
  const assignRes = await post(origin, "/api/rooms/commons/collab/assignments", {
    threadId: randomUUID(), assignee: { kind: "agent", id: "nopush" },
  }, f.keys.owner);
  assert.equal(assignRes.status, 201, "assignment itself still succeeds");
  await f.store.agentHeartbeats.flushPushes();
  assert.equal(transport.calls.length, 0, "no push config, no doorbell");
});

test("agent card advertises pushNotifications capability", () => {
  const card = agentCard();
  assert.equal(card.capabilities.pushNotifications, true);
});

test("pushNotify on an unknown identity never throws", async t => {
  const { hb } = unit(t);
  hb.setPushTransport(mockTransport());
  hb.pushNotify({ identityId: "ai_ghost", eventType: "dm.posted", roomId: "r", id: "g1", ts: T0 });
  await hb.flushPushes();
  assert.ok(true, "fire-and-forget ignores unknown identities silently");
});
