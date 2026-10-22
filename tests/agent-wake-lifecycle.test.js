// WAKE-S34: wake lifecycle states — pickup distinct from ack, and a
// started state productised from the listener lease/claim layer.
//
// Contract (MIG-WAKE Specs S3 + S4; review seat seq 17376: received /
// started / evidence / accepted stay DISTINCT):
// 1. A signal a consumer's poll or heartbeat retrieves shows a pickup
//    stamp (servedAt) while its ack stamp (deliveredAt) stays null —
//    pickup is not completion. The first serve wins: another host's
//    later serve does not move the stamp, and each host's first pickup
//    counts once in the wake accounting (served leg, distinct from acked).
// 2. A claimed signal reads as started (startedAt + startedLive) with
//    its lease, on the claim response AND on plain poll/heartbeat reads,
//    so a bystander consumer can tell started from merely pending.
// 3. A consumer dying mid-work (lease lapses, no ack) leaves the signal
//    pending with started expired (startedAt kept, startedLive false),
//    never acked; the next listener's claim replays it flagged
//    redelivered, and only its ack removes it.
// 4. Ack-only removal: serving and claiming never shrink the pending
//    set; only ackWakes does.
// 5. Doors: POST /api/agent-heartbeats/claim and MCP heartbeat_claim
//    reach the same claim path; a stale fencing token is refused.
//
// Synthetic fixtures only — in-memory stores and loopback HTTP.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHeartbeats, agentHeartbeatSchema } from "../server/agent-heartbeats.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

const T0 = 1_750_000_000_000;
const ROOM = "muse-room";
const AGENT = "ai_life";

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  t.after(() => db.close());
  const transaction = fn => {
    if (db.isTransaction) return fn();
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  };
  return { hb: new AgentHeartbeats({ db, now: () => at, transaction }, {}),
    advance: ms => { at += ms; }, db, at: () => at };
}

const register = (hb, hostId = "host-1") =>
  hb.heartbeat({ agentId: AGENT, hostId, mode: "pull-only" });

const servedTotal = hb =>
  Object.values(hb.accounting().byStore.signals.servedByDoor ?? {}).reduce((a, b) => a + b, 0);
const startedTotal = hb =>
  Object.values(hb.accounting().byStore.signals.startedByDoor ?? {}).reduce((a, b) => a + b, 0);

test("specimen 1: pickup is stamped at first serve and stays distinct from ack", t => {
  const { hb, advance, db, at } = unit(t);
  register(hb);
  const { signal } = hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m1" });
  assert.equal(signal.servedAt, null, "a fresh signal has never been picked up");
  assert.equal(signal.deliveredAt, null);
  advance(5000);
  const page = hb.pendingWakes(AGENT, { hostId: "host-1", roomId: ROOM });
  assert.equal(page.length, 1);
  assert.equal(page[0].servedAt, at(), "first serve stamps the pickup at serve time");
  assert.equal(page[0].deliveredAt, null, "pickup is not ack: the ack stamp stays null");
  // A second host's first serve does not move the pickup stamp.
  register(hb, "host-2");
  advance(7000);
  const page2 = hb.pendingWakes(AGENT, { hostId: "host-2", roomId: ROOM });
  assert.equal(page2[0].servedAt, page[0].servedAt, "first pickup wins across hosts");
  assert.equal(page2[0].deliveredAt, null);
  // The row is untouched by serving: still pending, still unacked.
  const row = db.prepare("SELECT delivered_at FROM agent_wake_signals WHERE signal_id=?").get(signal.signalId);
  assert.equal(row.delivered_at, null, "serving never writes the ack stamp");
  // Accounting: one first-pickup per host (two hosts), zero acks.
  assert.equal(servedTotal(hb), 2, "each host's first pickup counts once on the served leg");
  assert.deepEqual(hb.accounting().byStore.signals.ackedByDoor, {}, "nothing was acked");
});

test("specimen 2: a claimed signal reads started with its live lease on every read", t => {
  const { hb, at } = unit(t);
  register(hb);
  hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m1" });
  const lease = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "host-1", ttlMs: 60000 });
  const { signals } = hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: lease.fencingToken });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].startedAt, at(), "the claim stamps started at claim time");
  assert.equal(signals[0].startedLive, true, "the claiming lease is live");
  assert.equal(signals[0].redelivered, false, "first claim is not a redelivery");
  const page = hb.pendingWakes(AGENT, { hostId: "host-1", roomId: ROOM });
  assert.equal(page[0].startedAt, at(), "plain pending reads show the started stamp");
  assert.equal(page[0].startedLive, true);
  assert.equal(page[0].deliveredAt, null, "started is not acked");
  assert.equal(startedTotal(hb), 1, "the started leg counts the claim");
});

test("specimen 3: consumer death leaves the signal pending, started expired, never acked", t => {
  const { hb, advance } = unit(t);
  register(hb);
  const { signal } = hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m1" });
  const lease = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "host-1", ttlMs: 30000 });
  hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: lease.fencingToken });
  const claimedAt = hb.pendingWakes(AGENT, { hostId: "host-1", roomId: ROOM })[0].startedAt;
  // The consumer dies: its lease lapses with no ack and no release.
  advance(31000);
  const page = hb.pendingWakes(AGENT, { hostId: "host-1", roomId: ROOM });
  assert.equal(page.length, 1, "the signal is still pending after the consumer died");
  assert.equal(page[0].deliveredAt, null, "it was never acked");
  assert.equal(page[0].startedAt, claimedAt, "the started stamp survives as history");
  assert.equal(page[0].startedLive, false, "the started state expired with the lease's fencing");
  // A fresh listener re-claims: redelivery is flagged, started is live again.
  const lease2 = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "host-2", ttlMs: 30000 });
  const again = hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: lease2.fencingToken });
  assert.equal(again.signals.length, 1);
  assert.equal(again.signals[0].redelivered, true, "the reclaim replays the batch flagged redelivered");
  assert.equal(again.signals[0].startedLive, true);
  const acked = hb.ackWakes({ agentId: AGENT, signalIds: [signal.signalId], roomId: ROOM, fencingToken: lease2.fencingToken });
  assert.deepEqual(acked.acknowledged, [signal.signalId]);
  assert.equal(hb.pendingWakes(AGENT, { hostId: "host-1", roomId: ROOM }).length, 0, "only the ack removed it");
});

test("specimen 4: ack-only removal — serve, claim and release never shrink the pending set", t => {
  const { hb } = unit(t);
  register(hb);
  hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m1" });
  hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m2" });
  const pending = () => hb.pendingWakes(AGENT, { hostId: "host-1", roomId: ROOM }).length;
  assert.equal(pending(), 2);
  const lease = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "host-1", ttlMs: 60000 });
  hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: lease.fencingToken });
  assert.equal(pending(), 2, "claiming started both; both are still pending");
  hb.releaseListenerLease({ agentId: AGENT, roomId: ROOM, fencingToken: lease.fencingToken });
  assert.equal(pending(), 2, "releasing the lease frees the claims, not the signals");
  const ids = hb.pendingWakes(AGENT, { hostId: "host-1", roomId: ROOM }).map(s => s.signalId);
  // A released claim must be re-claimed before its ack is accepted: the
  // owner fence refuses a tokenless ack over a claim row (by design —
  // an abandoned batch is redelivered, never silently deleted).
  assert.throws(() => hb.ackWakes({ agentId: AGENT, signalIds: [ids[0]], roomId: ROOM }),
    error => error.code === "wake_signal_fenced", "a tokenless ack over a released claim is fenced");
  assert.equal(pending(), 2, "the refused ack removed nothing");
  const lease2 = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "host-1", ttlMs: 60000 });
  hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: lease2.fencingToken });
  hb.ackWakes({ agentId: AGENT, signalIds: [ids[0]], roomId: ROOM, fencingToken: lease2.fencingToken });
  assert.equal(pending(), 1, "the ack is the only removal");
});

// ---- Doors (specimen 5) ----

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "wake-lifecycle-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    resolve({ origin: `http://127.0.0.1:${server.address().port}`, store });
  }));
}

function rpc(origin, method, params, secret) {
  return fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, ...(params === undefined ? {} : { params }) }),
  });
}

async function call(origin, name, args, secret) {
  const response = await rpc(origin, "tools/call", { name, arguments: args }, secret);
  const body = await response.json();
  return { status: response.status, body, value: body.result?.structuredContent };
}

test("specimen 5: the claim doors — HTTP route and MCP heartbeat_claim mark started; a stale token is refused", async t => {
  const { origin, store } = await serve(t);
  const owner = store.identities.create("Lifecycle owner");
  const agentId = owner.identityId;
  const hbSet = await call(origin, "heartbeat_set",
    { hostId: "host-1", mode: "pull-only", listenerLease: true }, owner.secret);
  const token = hbSet.value?.listener?.fencingToken;
  assert.ok(typeof token === "string" && token.length > 0, "the lease heartbeat issued a fencing token");
  store.agentHeartbeats.enqueueWake({ agentId, kind: "mention", roomId: null, messageId: "door-1" });
  // HTTP claim door.
  const res = await fetch(`${origin}/api/agent-heartbeats/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.secret}` },
    body: JSON.stringify({ fencingToken: token }),
  });
  assert.equal(res.status, 200, "the claim route answers");
  const claimed = await res.json();
  assert.equal(claimed.signals.length, 1);
  assert.equal(typeof claimed.signals[0].startedAt, "number", "the HTTP claim marks the signal started");
  assert.equal(claimed.signals[0].startedLive, true);
  // MCP claim door exists in the full catalog.
  const names = (await (await rpc(origin, "tools/list", { profile: "full" }, owner.secret)).json())
    .result.tools.map(tool => tool.name);
  assert.ok(names.includes("heartbeat_claim"), "heartbeat_claim is in the enrolled catalog");
  // A stale fencing token is refused on the MCP door too (tools/call
  // surfaces store refusals as isError results with the typed code).
  const bad = await call(origin, "heartbeat_claim", { fencingToken: "not-the-token" }, owner.secret);
  assert.equal(bad.value?.code, "stale_listener", "a stale token claim is refused, never a silent claim");
  assert.equal(bad.value?.status, 409);
});
