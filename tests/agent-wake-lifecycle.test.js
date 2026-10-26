// WAKE-S34, re-cut by WAKE-QUEUE-1 Step 1 (SPEC §9) and extended by
// the Step 1 substrate re-charter: wake lifecycle states — pickup
// distinct from ack, and a CLAIMED state productised from the
// listener lease/claim layer (SPEC §4 Stage 2). A claim is not a
// turn start: TurnStarted (Stage 4) is a separate record that does
// not exist yet, and nothing here claims or implies it.
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
// Substrate (re-charter builds 1–3):
// 6. Every wake item carries an idempotency key, minted at enqueue,
//    stable across a coalesced re-enqueue, distinct per item, and
//    present on enqueue, poll and claim payloads (E-03).
// 7. The claim row is its own evidence: holder + lease-expiry
//    snapshot stay readable after the lease row is overwritten by a
//    later lease (rollover); the fencing token appears in no view.
// 8. Every fencing refusal of a post-claim write is journaled —
//    claim (stale_listener), ack (listener_fenced, wake_signal_fenced)
//    and release refusals land in the wake failure journal with the
//    item, the writing holder, the code and the time, and the refused
//    write itself never lands (SPEC §5.3).
// 9. The release door: the holder releases named claims before lease
//    expiry (HTTP + MCP parity); the items are Queued at once and
//    replay flagged redelivered; a stale release is refused and
//    journaled; another listener's claims are never freed.
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
const refusedTotal = hb => hb.accounting().byStore.signals.stale_write_refused ?? 0;
const journal = hb => hb.accounting().failures;

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
  // A second host's serve is another pickup, counted, stamping
  // nothing. The host-2 heartbeat is itself a serve on the heartbeat
  // door, so it counts too — per-serve counting has no dedupe table.
  register(hb, "host-2");
  assert.equal(servedTotal(hb), 2, "the second host's heartbeat serve counts as a pickup");
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
  // Accounting: one pickup per serve (three serves across two doors
  // and two hosts), zero acks.
  assert.equal(servedTotal(hb), 3, "each serve counts on the served leg");
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
  assert.equal(signals[0].claimHolder, "host-1", "the claim response names the holder");
  assert.equal(signals[0].claimLeaseExpiresAt, lease.leaseExpiresAt, "the claim response carries the lease-expiry snapshot");
  assert.equal(signals[0].redelivered, false, "first claim is not a redelivery");
  const page = hb.pendingWakes(AGENT, { hostId: "host-1", roomId: ROOM });
  assert.equal(page[0].claimedAt, at(), "plain pending reads show the claimed stamp");
  assert.equal(page[0].claimedLive, true);
  assert.equal(page[0].claimHolder, "host-1", "plain pending reads name the holder");
  assert.equal(page[0].claimLeaseExpiresAt, lease.leaseExpiresAt);
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

test("specimen 6: the carried idempotency key — minted at enqueue, stable across coalesce, on every payload", t => {
  const { hb, db } = unit(t);
  register(hb);
  const first = hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m1" });
  assert.equal(first.enqueued, true);
  const key = first.signal.idempotencyKey;
  assert.ok(typeof key === "string" && key.startsWith("wk_") && key.length > 8,
    "the enqueue payload carries a minted key");
  assert.notEqual(key, first.signal.signalId, "the key is not the signal id");
  assert.notEqual(key, "m1", "the key is not the message id");
  // The same logical wake enqueued again coalesces: no new row, and
  // the payload carries the ORIGINAL key — the key is the dedupe
  // identity downstream stages bind to.
  const again = hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m1" });
  assert.equal(again.enqueued, false, "the re-enqueue coalesced");
  assert.equal(again.signal.idempotencyKey, key, "the coalesced payload carries the original key");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_wake_signals").get().n, 1, "still exactly one wake item");
  // A different logical wake gets a different key.
  const other = hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m2" });
  assert.notEqual(other.signal.idempotencyKey, key, "distinct items carry distinct keys");
  // The key rides poll payloads and claim payloads.
  const page = hb.pendingWakes(AGENT, { hostId: "host-1", roomId: ROOM });
  assert.equal(page.find(s => s.signalId === first.signal.signalId).idempotencyKey, key,
    "the poll payload carries the key");
  const lease = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "host-1", ttlMs: 60000 });
  const { signals } = hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: lease.fencingToken });
  assert.equal(signals.find(s => s.signalId === first.signal.signalId).idempotencyKey, key,
    "the claim payload carries the key");
});

test("specimen 7: claim evidence survives lease rollover; the fencing token is in no view", t => {
  const { hb, advance, at } = unit(t);
  register(hb);
  hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m1" });
  const lease1 = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "host-1", ttlMs: 30000 });
  const claimedAt = at();
  const { signals } = hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: lease1.fencingToken });
  assert.equal(signals[0].claimHolder, "host-1");
  assert.equal(signals[0].claimLeaseExpiresAt, claimedAt + 30000);
  // Rollover: lease1 lapses and a different listener's lease
  // overwrites the lease row for the same agent and room.
  advance(31000);
  const lease2 = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "host-2", ttlMs: 60000 });
  assert.notEqual(lease2.fencingToken, lease1.fencingToken);
  // A second reader still reads the ORIGINAL claim evidence from the
  // claim row — holder and expiry snapshot as they stood at claim
  // time — even though the lease row now names host-2 and a later
  // expiry.
  const page = hb.pendingWakes(AGENT, { hostId: "host-2", roomId: ROOM });
  assert.equal(page[0].claimedAt, claimedAt, "the claim stamp is the original");
  assert.equal(page[0].claimHolder, "host-1", "the holder is read from the claim row, not the overwritten lease");
  assert.equal(page[0].claimLeaseExpiresAt, claimedAt + 30000, "the expiry snapshot is the claim-time value");
  assert.equal(page[0].claimedLive, false, "liveness still comes from the live lease join");
  // The fencing token — either lease's — appears in no view.
  for (const view of [...page, ...signals]) {
    assert.ok(!JSON.stringify(view).includes(lease1.fencingToken), "lease 1 token never appears in a view");
    assert.ok(!JSON.stringify(view).includes(lease2.fencingToken), "lease 2 token never appears in a view");
  }
  // The re-claim refreshes the evidence to the new holder.
  const again = hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: lease2.fencingToken });
  assert.equal(again.signals[0].claimHolder, "host-2", "a re-claim rewrites the evidence to its own holder");
  assert.equal(again.signals[0].claimLeaseExpiresAt, lease2.leaseExpiresAt);
});

test("specimen 8: fencing refusals are journaled with item, holder, code and time — and never land", t => {
  const { hb, advance, at } = unit(t);
  register(hb);
  const { signal } = hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m1" });
  const pendingCount = () => hb.pendingWakes(AGENT, { hostId: "host-1", roomId: ROOM }).length;

  // (a) A claim under no live lease: stale_listener, journaled with
  // no item (the refusal names a batch, not an item).
  const claimAt = at();
  assert.throws(() => hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: "bogus-token" }),
    error => error.code === "stale_listener" && error.status === 409);
  assert.equal(refusedTotal(hb), 1, "the refused claim counted on the stale_write_refused leg");
  let entry = journal(hb).recent.find(e => e.reason === "stale_listener");
  assert.ok(entry, "the claim refusal is in the journal");
  assert.equal(entry.at, claimAt, "the journal records the refusal time");
  assert.equal(entry.holderId, AGENT, "the journal records the writing holder");
  assert.equal(entry.itemId, null, "a refused claim names no item");

  // (b) An ack under a wrong token while the real lease is live:
  // listener_fenced, journaled per item.
  const lease = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "host-1", ttlMs: 30000 });
  hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: lease.fencingToken });
  assert.throws(() => hb.ackWakes({ agentId: AGENT, signalIds: [signal.signalId], roomId: ROOM, fencingToken: "not-the-token" }),
    error => error.code === "listener_fenced" && error.status === 409);
  assert.equal(pendingCount(), 1, "the refused ack removed nothing");
  entry = journal(hb).recent.find(e => e.reason === "listener_fenced");
  assert.ok(entry, "the listener_fenced refusal is in the journal");
  assert.equal(entry.itemId, signal.signalId, "the journal names the refused item");
  assert.equal(entry.holderId, AGENT);

  // (c) A tokenless ack over a claim whose lease has died:
  // wake_signal_fenced (the owner fence), journaled per item.
  advance(31000);
  assert.throws(() => hb.ackWakes({ agentId: AGENT, signalIds: [signal.signalId], roomId: ROOM }),
    error => error.code === "wake_signal_fenced" && error.status === 409);
  assert.equal(pendingCount(), 1, "the fenced ack removed nothing");
  entry = journal(hb).recent.find(e => e.reason === "wake_signal_fenced");
  assert.ok(entry, "the wake_signal_fenced refusal is in the journal");
  assert.equal(entry.itemId, signal.signalId);
  assert.deepEqual(journal(hb).byReason, { stale_listener: 1, listener_fenced: 1, wake_signal_fenced: 1 },
    "all three refusal codes are journaled");
  assert.equal(refusedTotal(hb), 3, "the counter leg totals the three refusals");
  // None of the refused writes landed: the signal is still claimable
  // and a proper claim + ack still settles it.
  const lease2 = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "host-2", ttlMs: 30000 });
  const reclaimed = hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: lease2.fencingToken });
  assert.equal(reclaimed.signals[0].redelivered, true);
  hb.ackWakes({ agentId: AGENT, signalIds: [signal.signalId], roomId: ROOM, fencingToken: lease2.fencingToken });
  assert.equal(pendingCount(), 0, "only the fenced ack removed it");
});

test("specimen 9: the release door at the store — valid release requeues flagged; stale release is refused and journaled", t => {
  const { hb, advance } = unit(t);
  register(hb);
  const a = hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m1" }).signal;
  const b = hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m2" }).signal;
  const lease = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "host-1", ttlMs: 60000 });
  hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: lease.fencingToken });

  // A stale release is refused, journaled per item, and frees nothing.
  assert.throws(() => hb.releaseWakeClaims({ agentId: AGENT, roomId: ROOM, fencingToken: "not-the-token", signalIds: [a.signalId] }),
    error => error.code === "stale_listener" && error.status === 409);
  const staleEntry = journal(hb).recent.find(e => e.reason === "stale_listener" && e.itemId === a.signalId);
  assert.ok(staleEntry, "the stale release refusal is journaled with its item");
  let page = hb.pendingWakes(AGENT, { hostId: "host-1", roomId: ROOM });
  assert.equal(page.find(s => s.signalId === a.signalId).claimedLive, true, "the stale release freed nothing");

  // A valid release frees exactly the named claim; the lease and the
  // other claim stand.
  const released = hb.releaseWakeClaims({ agentId: AGENT, roomId: ROOM, fencingToken: lease.fencingToken, signalIds: [a.signalId] });
  assert.deepEqual(released.released, [a.signalId]);
  page = hb.pendingWakes(AGENT, { hostId: "host-1", roomId: ROOM });
  const freed = page.find(s => s.signalId === a.signalId);
  assert.equal(freed.claimedAt, null, "the released item reads unclaimed at once");
  assert.equal(freed.claimHolder, null, "the released item carries no holder");
  assert.equal(freed.redelivered, true, "the released item is flagged for redelivery");
  const kept = page.find(s => s.signalId === b.signalId);
  assert.equal(kept.claimedLive, true, "the unreleased claim stands under the same lease");
  assert.equal(kept.claimHolder, "host-1");

  // The next claim replays the released item flagged redelivered and
  // does not duplicate the still-claimed one.
  const again = hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: lease.fencingToken });
  assert.deepEqual(again.signals.map(s => s.signalId), [a.signalId], "only the released item is re-claimed");
  assert.equal(again.signals[0].redelivered, true);

  // Settle both, then the foreign-claim skip: a claim held under a
  // dead lease's token cannot be freed by the NEXT lease's holder —
  // the release names it, the store skips it, the claim stands.
  hb.ackWakes({ agentId: AGENT, signalIds: [a.signalId, b.signalId], roomId: ROOM, fencingToken: lease.fencingToken });
  assert.equal(hb.pendingWakes(AGENT, { hostId: "host-1", roomId: ROOM }).length, 0, "both settled by their holder's ack");
  const c = hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m3" }).signal;
  hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: lease.fencingToken });
  advance(61000);
  const lease2 = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "host-2", ttlMs: 60000 });
  const skipped = hb.releaseWakeClaims({ agentId: AGENT, roomId: ROOM, fencingToken: lease2.fencingToken, signalIds: [c.signalId] });
  assert.deepEqual(skipped.released, [], "another token's claim is skipped, never freed");
  const stillClaimed = hb.pendingWakes(AGENT, { hostId: "host-2", roomId: ROOM })
    .find(s => s.signalId === c.signalId);
  assert.equal(stillClaimed.claimHolder, "host-1", "the foreign claim still stands under its own holder");
  const replay = hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: lease2.fencingToken });
  assert.equal(replay.signals[0].redelivered, true, "the skipped claim still replays flagged to its next claimer");
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

test("the claim and release route rows are registered once, with MCP parity declared", () => {
  assert.equal(WAKE_CLAIM_ROUTES.length, 2);
  const [claim, release] = WAKE_CLAIM_ROUTES;
  assert.equal(claim.method, "POST");
  assert.equal(claim.path, "/api/agent-heartbeats/claim");
  assert.equal(claim.parity, "mcp:heartbeat_claim");
  assert.equal(claim.schema.body.required[0], "fencingToken");
  assert.equal(release.method, "POST");
  assert.equal(release.path, "/api/agent-heartbeats/release-claims");
  assert.equal(release.parity, "mcp:heartbeat_release_claim");
  assert.deepEqual(release.schema.body.required, ["fencingToken", "signalIds"]);
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
  assert.ok(typeof claimed.signals[0].idempotencyKey === "string", "the HTTP claim carries the idempotency key");
  // MCP claim door exists in the full catalog.
  const names = (await (await rpc(origin, "tools/list", { profile: "full" }, owner.secret)).json())
    .result.tools.map(tool => tool.name);
  assert.ok(names.includes("heartbeat_claim"), "heartbeat_claim is in the enrolled catalog");
  assert.ok(names.includes("heartbeat_release_claim"), "heartbeat_release_claim is in the enrolled catalog");
  // A stale fencing token is refused on the MCP door too (tools/call
  // surfaces store refusals as isError results with the typed code).
  const bad = await call(origin, "heartbeat_claim", { fencingToken: "not-the-token" }, owner.secret);
  assert.equal(bad.value?.code, "stale_listener", "a stale token claim is refused, never a silent claim");
  assert.equal(bad.value?.status, 409);
  // The release doors: HTTP release frees the claim; a re-claim via
  // MCP replays it flagged; MCP release frees it again; a stale MCP
  // release is refused stale_listener.
  const signalId = claimed.signals[0].signalId;
  const relRes = await fetch(`${origin}/api/agent-heartbeats/release-claims`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.secret}` },
    body: JSON.stringify({ fencingToken: token, signalIds: [signalId] }),
  });
  assert.equal(relRes.status, 200, "the release route answers");
  assert.deepEqual((await relRes.json()).released, [signalId], "the HTTP release freed the claim");
  const reclaimed = await call(origin, "heartbeat_claim", { fencingToken: token }, owner.secret);
  assert.equal(reclaimed.value?.signals?.length, 1, "the MCP claim replays the released signal");
  assert.equal(reclaimed.value.signals[0].redelivered, true, "the replay is flagged redelivered");
  const mcpRelease = await call(origin, "heartbeat_release_claim",
    { fencingToken: token, signalIds: [signalId] }, owner.secret);
  assert.deepEqual(mcpRelease.value?.released, [signalId], "the MCP release freed the claim");
  const badRelease = await call(origin, "heartbeat_release_claim",
    { fencingToken: "not-the-token", signalIds: [signalId] }, owner.secret);
  assert.equal(badRelease.value?.code, "stale_listener", "a stale token release is refused, never a silent free");
  assert.equal(badRelease.value?.status, 409);
});
