// WAKE-S34, re-cut by WAKE-QUEUE-1 Step 1 (SPEC §9): wake lifecycle
// states — pickup distinct from ack, and a CLAIMED state productised
// from the listener lease/claim layer (SPEC §4 Stage 2). A claim is
// not a turn start: TurnStarted (Stage 4) is a separate record that
// does not exist yet, and nothing here claims or implies it.
//
// Contract (MIG-WAKE Specs S3 + S4 as re-cut; review seat seq 17376:
// served / claimed / evidence / accepted stay DISTINCT):
// 1. A signal a consumer's poll or heartbeat retrieves is counted as
//    a pickup on the wake accounting served leg while its ack stamp
//    (deliveredAt) stays null — pickup is not completion. A serve
//    stamps nothing per item: views carry no servedAt, and no serves
//    table exists (SPEC §9 dropped it; the counter leg needs no table).
// 2. A claimed signal reads as claimed (claimedAt + claimedLive) with
//    its lease, on the claim response AND on plain poll/heartbeat reads,
//    so a bystander consumer can tell claimed from merely pending.
// 3. A consumer dying mid-work (lease lapses, no ack) leaves the signal
//    pending with claimed expired (claimedAt kept, claimedLive false),
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
import { WAKE_CLAIM_ROUTES } from "../server/routes/wake-claim.mjs";

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
const claimedTotal = hb =>
  Object.values(hb.accounting().byStore.signals.claimedByDoor ?? {}).reduce((a, b) => a + b, 0);

test("specimen 1: pickup is counted at serve and stays distinct from ack", t => {
  const { hb, advance, db } = unit(t);
  register(hb);
  const { signal } = hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m1" });
  assert.equal(signal.claimedAt, null, "a fresh signal is queued, not claimed");
  assert.equal(signal.deliveredAt, null);
  assert.ok(!("servedAt" in signal) && !("startedAt" in signal),
    "views carry no serve stamp and no started stamp (SPEC §9 re-cut)");
  advance(5000);
  const page = hb.pendingWakes(AGENT, { hostId: "host-1", roomId: ROOM });
  assert.equal(page.length, 1);
  assert.equal(page[0].deliveredAt, null, "pickup is not ack: the ack stamp stays null");
  assert.equal(servedTotal(hb), 1, "the serve counted once on the served leg");
  // A second host's serve is another pickup, counted, stamping nothing.
  register(hb, "host-2");
  advance(7000);
  const page2 = hb.pendingWakes(AGENT, { hostId: "host-2", roomId: ROOM });
  assert.equal(page2[0].deliveredAt, null);
  assert.ok(!("servedAt" in page2[0]), "a serve never mints a per-item stamp");
  // The row is untouched by serving: still pending, still unacked.
  const row = db.prepare("SELECT delivered_at FROM agent_wake_signals WHERE signal_id=?").get(signal.signalId);
  assert.equal(row.delivered_at, null, "serving never writes the ack stamp");
  // No serves table exists to stamp into (SPEC §9: the table is dropped).
  const servesTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_wake_signal_serves'").get();
  assert.equal(servesTable, undefined, "serving creates no agent_wake_signal_serves table");
  // Accounting: one pickup per serve (two serves), zero acks.
  assert.equal(servedTotal(hb), 2, "each serve counts on the served leg");
  assert.deepEqual(hb.accounting().byStore.signals.ackedByDoor, {}, "nothing was acked");
});

test("specimen 2: a claimed signal reads claimed with its live lease on every read", t => {
  const { hb, at } = unit(t);
  register(hb);
  hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m1" });
  const lease = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "host-1", ttlMs: 60000 });
  const { signals } = hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: lease.fencingToken });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].claimedAt, at(), "the claim stamps claimed at claim time");
  assert.equal(signals[0].claimedLive, true, "the claiming lease is live");
  assert.equal(signals[0].redelivered, false, "first claim is not a redelivery");
  const page = hb.pendingWakes(AGENT, { hostId: "host-1", roomId: ROOM });
  assert.equal(page[0].claimedAt, at(), "plain pending reads show the claimed stamp");
  assert.equal(page[0].claimedLive, true);
  assert.equal(page[0].deliveredAt, null, "claimed is not acked");
  assert.equal(claimedTotal(hb), 1, "the claimed leg counts the claim");
});

test("specimen 3: consumer death leaves the signal pending, claimed expired, never acked", t => {
  const { hb, advance } = unit(t);
  register(hb);
  const { signal } = hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m1" });
  const lease = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "host-1", ttlMs: 30000 });
  hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: lease.fencingToken });
  const claimedStamp = hb.pendingWakes(AGENT, { hostId: "host-1", roomId: ROOM })[0].claimedAt;
  // The consumer dies: its lease lapses with no ack and no release.
  advance(31000);
  const page = hb.pendingWakes(AGENT, { hostId: "host-1", roomId: ROOM });
  assert.equal(page.length, 1, "the signal is still pending after the consumer died");
  assert.equal(page[0].deliveredAt, null, "it was never acked");
  assert.equal(page[0].claimedAt, claimedStamp, "the claimed stamp survives as history");
  assert.equal(page[0].claimedLive, false, "the claimed state expired with the lease's fencing");
  // A fresh listener re-claims: redelivery is flagged, claimed is live again.
  const lease2 = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "host-2", ttlMs: 30000 });
  const again = hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: lease2.fencingToken });
  assert.equal(again.signals.length, 1);
  assert.equal(again.signals[0].redelivered, true, "the reclaim replays the batch flagged redelivered");
  assert.equal(again.signals[0].claimedLive, true);
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
  assert.equal(pending(), 2, "claiming both; both are still pending");
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

test("the claim route row is registered once, with MCP parity declared", () => {
  assert.equal(WAKE_CLAIM_ROUTES.length, 1);
  const [row] = WAKE_CLAIM_ROUTES;
  assert.equal(row.method, "POST");
  assert.equal(row.path, "/api/agent-heartbeats/claim");
  assert.equal(row.parity, "mcp:heartbeat_claim");
  assert.equal(row.schema.body.required[0], "fencingToken");
});

test("specimen 5: the claim doors — HTTP route and MCP heartbeat_claim mark claimed; a stale token is refused", async t => {
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
  assert.equal(typeof claimed.signals[0].claimedAt, "number", "the HTTP claim marks the signal claimed");
  assert.equal(claimed.signals[0].claimedLive, true);
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
