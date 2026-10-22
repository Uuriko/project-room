// MIG-WAKE spec S7: per-agent wake health, served in one read.
//
// Before S7 the server kept every wake number (signal rows, the #3345
// accounting counters, the loss-class journal) but served none of them
// per agent: wake health was knowable only by auditing the hook log by
// hand. GET /api/wake-health returns one agent's health — pending count,
// oldest pending age, last acked, journaled failures — read from the
// stores as they already exist. No counter semantics change: this file
// pins that the read returns exactly what was seeded, and names what
// the stores do NOT keep per agent as gaps instead of inventing it.
//
// Authoring gate (repo test-audit):
// 1. seed-and-read exactness — contract: wakeHealthForAgent returns the
//    seeded per-agent values exactly (counts, stamps, ages), attributed
//    to the right agent only. Regression: an aggregation that sums the
//    room/store-keyed agent_wake_counters (which have NO per-agent
//    dimension) would report fleet numbers as one agent's health.
// 2. permission shape — contract: self always; another agent only when
//    caller and target share a room (identity_links co-membership), or
//    the target belongs to a room access key's bound room; everyone else
//    403, unauthenticated 401, a key without heartbeats:read 403.
//    Regression: an any-credential read leaks per-agent activity (the
//    leak GET /api/wake-status's scoping was built to prevent).
// 3. gap honesty — contract: counters/failureRate are null and `gaps`
//    names why (no per-agent counter dimension; delivered_at is the ack
//    stamp until S3; capped/429 are client states). Regression: a null
//    silently upgraded to a derived number nobody recorded.
//
// Synthetic fixtures only — loopback HTTP, no external calls or real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { agentHeartbeatSchema } from "../server/agent-heartbeats.mjs";
import {
  ensureWakeMetricsSchema, recordWakeEvent, WAKE_STOCK_STALE_MS,
} from "../server/wake-metrics.mjs";
import { wakeHealthForAgent, WAKE_HEALTH_GAPS } from "../server/wake-health.mjs";
import { WAKE_HEALTH_ROUTES } from "../server/routes/wake-health.mjs";
import { ROUTES, assertRouteRow } from "../server/routes/table.mjs";

const T0 = 1_750_000_000_000;
const HOUR = 60 * 60 * 1000;

function seedSignal(db, { id, agentId, kind = "mention", roomId = "r1", createdAt, deliveredAt = null }) {
  db.prepare(`INSERT INTO agent_wake_signals (signal_id, agent_id, kind, room_id, message_id, created_at, delivered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, agentId, kind, roomId, `m_${id}`, createdAt, deliveredAt);
}

function unitDb(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  ensureWakeMetricsSchema(db);
  t.after(() => db.close());
  return db;
}

test("wake-health route-table row is well-formed and registered", () => {
  assert.equal(WAKE_HEALTH_ROUTES.length, 1);
  const [row] = WAKE_HEALTH_ROUTES;
  assert.deepEqual(assertRouteRow(row), []);
  assert.equal(row.id, "wake-health");
  assert.equal(row.method, "GET");
  assert.equal(row.path, "/api/wake-health");
  assert.ok(ROUTES.includes(row), "route table serves the wake-health row");
});

test("wakeHealthForAgent returns exactly the seeded per-agent values", t => {
  const db = unitDb(t);
  const now = T0;
  // ai_h: 3 pending (one aged past the 24h stock horizon), 2 acked.
  seedSignal(db, { id: "s1", agentId: "ai_h", createdAt: T0 - 1000 });
  seedSignal(db, { id: "s2", agentId: "ai_h", kind: "dm", createdAt: T0 - 25 * HOUR });
  seedSignal(db, { id: "s3", agentId: "ai_h", createdAt: T0 - 500 });
  seedSignal(db, { id: "s4", agentId: "ai_h", createdAt: T0 - 9000, deliveredAt: T0 - 8000 });
  seedSignal(db, { id: "s5", agentId: "ai_h", createdAt: T0 - 3000, deliveredAt: T0 - 2000 });
  // Another agent's rows never leak into ai_h's health.
  seedSignal(db, { id: "s6", agentId: "ai_other", createdAt: T0 - 100 });
  recordWakeEvent(db, { at: T0 - 100, roomId: "r1", store: "signals", event: "failed",
    kind: "mention", subjectId: "ai_h", reason: "enqueue_error" });
  recordWakeEvent(db, { at: T0 - 50, roomId: "r1", store: "signals", event: "suppressed_no_identity",
    kind: "dm", subjectId: "ai_h", reason: "no_identity_link" });
  recordWakeEvent(db, { at: T0 - 10, roomId: "r1", store: "signals", event: "failed",
    kind: "mention", subjectId: "ai_other", reason: "enqueue_error" });

  const h = wakeHealthForAgent(db, { agentId: "ai_h", now });
  assert.equal(h.agentId, "ai_h");
  assert.equal(h.asOf, now);
  assert.deepEqual(h.signals, {
    pending: 3,
    pendingAged: 1,
    oldestPendingAt: T0 - 25 * HOUR,
    oldestPendingAgeMs: 25 * HOUR,
    acked: 2,
    lastEmittedAt: T0 - 500,
    lastAckedAt: T0 - 2000,
  });
  assert.equal(h.failures.journaled, 2);
  assert.deepEqual(h.failures.byReason, { enqueue_error: 1, no_identity_link: 1 });
  assert.equal(h.failures.recent.length, 2);
  assert.equal(h.failures.recent[0].reason, "no_identity_link", "recent is newest first");
  assert.equal(h.failures.recent[0].at, T0 - 50);

  const other = wakeHealthForAgent(db, { agentId: "ai_other", now });
  assert.equal(other.signals.pending, 1);
  assert.equal(other.failures.journaled, 1);
});

test("wakeHealthForAgent on an unknown agent reads zeros and nulls, never throws", t => {
  const db = unitDb(t);
  const h = wakeHealthForAgent(db, { agentId: "ai_nobody", now: T0 });
  assert.deepEqual(h.signals, {
    pending: 0, pendingAged: 0, oldestPendingAt: null, oldestPendingAgeMs: null,
    acked: 0, lastEmittedAt: null, lastAckedAt: null,
  });
  assert.equal(h.failures.journaled, 0);
  assert.deepEqual(h.failures.recent, []);
});

test("wakeHealthForAgent on a pre-metrics DB degrades to zeros, never throws", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const h = wakeHealthForAgent(db, { agentId: "ai_legacy", now: T0 });
  assert.equal(h.signals.pending, 0);
  assert.equal(h.failures.journaled, 0);
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
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

async function keyedAgent(f, origin, name, scopes = ["heartbeats:report", "heartbeats:read"]) {
  const identity = f.store.identities.create(name);
  const scoped = await (await post(origin, "/api/agent-keys",
    { scopes }, identity.secret)).json();
  return { identity, credential: scoped.credential };
}

test("GET /api/wake-health returns the caller's own seeded health exactly", async t => {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  const origin = await startServer(t, f);
  const me = await keyedAgent(f, origin, "wake-health-agent");
  const id = me.identity.identityId;
  seedSignal(f.store.db, { id: "h1", agentId: id, createdAt: at - 2000 });
  seedSignal(f.store.db, { id: "h2", agentId: id, createdAt: at - (WAKE_STOCK_STALE_MS + 1000) });
  seedSignal(f.store.db, { id: "h3", agentId: id, createdAt: at - 9000, deliveredAt: at - 7000 });
  recordWakeEvent(f.store.db, { at: at - 100, roomId: "r1", store: "signals", event: "failed",
    kind: "mention", subjectId: id, reason: "enqueue_error" });

  const res = await get(origin, "/api/wake-health", me.credential);
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.equal(doc.agentId, id);
  assert.equal(doc.signals.pending, 2);
  assert.equal(doc.signals.pendingAged, 1);
  assert.equal(doc.signals.oldestPendingAt, at - (WAKE_STOCK_STALE_MS + 1000));
  assert.equal(doc.signals.oldestPendingAgeMs, WAKE_STOCK_STALE_MS + 1000);
  assert.equal(doc.signals.acked, 1);
  assert.equal(doc.signals.lastAckedAt, at - 7000);
  assert.equal(doc.failures.journaled, 1);
  // Gap honesty: nothing derived that the stores do not keep per agent.
  assert.equal(doc.counters, null);
  assert.equal(doc.failureRate, null);
  assert.deepEqual(doc.gaps, [...WAKE_HEALTH_GAPS]);
  assert.ok(doc.gaps.some(g => g.includes("agent_wake_counters")), "counter gap is named");

  assert.equal((await get(origin, "/api/wake-health")).status, 401, "unauthenticated is refused");
});

test("GET /api/wake-health refuses callers outside the permission shape", async t => {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  const origin = await startServer(t, f);
  const target = await keyedAgent(f, origin, "wake-health-target");
  const outsider = await keyedAgent(f, origin, "wake-health-outsider");
  const noScope = await keyedAgent(f, origin, "wake-health-noscope", ["heartbeats:report"]);
  seedSignal(f.store.db, { id: "t1", agentId: target.identity.identityId, createdAt: at - 1000 });

  // A key without heartbeats:read is refused at the scope gate.
  assert.equal((await get(origin, "/api/wake-health", noScope.credential)).status, 403,
    "missing heartbeats:read scope is refused");
  // An identity sharing no room with the target cannot read its health.
  const refused = await get(origin, `/api/wake-health?agentId=${target.identity.identityId}`, outsider.credential);
  assert.equal(refused.status, 403, "non-co-member is refused");
  // The target reading itself is always allowed.
  const self = await get(origin, `/api/wake-health?agentId=${target.identity.identityId}`, target.credential);
  assert.equal(self.status, 200, "self read by explicit id is allowed");
  assert.equal((await self.json()).signals.pending, 1);

  // Co-membership opens the read: link both into the same room.
  for (const [i, a] of [target, outsider].entries()) {
    f.store.identities.link(f.keys.owner, "commons", {
      identityId: a.identity.identityId, memberId: a.identity.identityId,
      displayName: `wake health ${i}`, permissions: ["write_external"],
    });
  }
  const shared = await get(origin, `/api/wake-health?agentId=${target.identity.identityId}`, outsider.credential);
  assert.equal(shared.status, 200, "co-member may read");
  const doc = await shared.json();
  assert.equal(doc.agentId, target.identity.identityId);
  assert.equal(doc.signals.pending, 1);
});
