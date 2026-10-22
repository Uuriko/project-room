// Issue #3910 (bug sweep 2026-10-16, lane 11 STREAMS-WAKE) — regression
// specimens for the 3 Low findings, one per finding:
//   F2  WakeQueue enqueue into a leased row silently discards the new
//       intent: the receipt must distinguish "absorbed" from "dropped".
//   F3  No time-based retention for acked wake signals or their claim
//       rows: pruneWakeSignals must reap both, and only those.
//   F4  A coalesced wake still fires the push doorbell: the mention
//       fan-out must ring push only when a NEW signal was enqueued.
// In-memory stores only, so the specimens run anywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  AgentHeartbeats, agentHeartbeatSchema, HEARTBEAT_STALE_AFTER_MS,
} from "../server/agent-heartbeats.mjs";
import * as heartbeatsModule from "../server/agent-heartbeats.mjs";

// Read through the module namespace so this specimen also loads at the
// pre-fix head (where the retention export does not exist yet) and each
// finding fails on its own assertion there.
const WAKE_SIGNAL_RETENTION_MS = heartbeatsModule.WAKE_SIGNAL_RETENTION_MS ?? 30 * 24 * 60 * 60 * 1000;

const T0 = 1_750_000_000_000;

function memStore(t) {
  let at = Date.now();
  const store = new RoomStore(":memory:", { now: () => at });
  t.after(() => store.close());
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  return { store, keys, setAt: ms => { at = ms; }, advance: ms => { at += ms; }, at: () => at };
}

// ---- F2 ---------------------------------------------------------------

test("F2: enqueue into a leased row reports the new intent as NOT absorbed; a pending row absorbs it", t => {
  const f = memStore(t);
  const enqueue = (intent) => f.store.wakeQueue.enqueue(f.keys.owner, "commons",
    { requestId: randomUUID(), queueKey: "recipe:draft-catch-up", intent, dueAt: f.at(), maxAttempts: 3 });

  const first = enqueue({ recipe: "v1" });
  assert.equal(first.receipt.coalesced, false);
  assert.equal(first.receipt.absorbed, true, "a fresh enqueue's intent is taken");

  const pending = enqueue({ recipe: "v2" });
  assert.equal(pending.receipt.coalesced, true);
  assert.equal(pending.receipt.absorbed, true, "a pending row absorbs the new intent (it replaces the stored one)");

  const memberId = f.store.authenticate(f.keys.owner, "commons").member.id;
  const leased = f.store.wakeQueue.lease("commons", memberId, "recipe:draft-catch-up", randomUUID());
  assert.equal(leased.state, "leased");

  const dropped = enqueue({ recipe: "v3" });
  assert.equal(dropped.receipt.coalesced, true, "a leased row still coalesces (no second row)");
  assert.equal(dropped.receipt.absorbed, false,
    "a leased row is left alone, so the receipt must say the new intent was dropped, not absorbed");
  const rows = f.store.wakeQueue.list(f.keys.owner, "commons").wakes;
  assert.equal(rows.length, 1, "still exactly one row for the queue key");
  assert.deepEqual(rows[0].intent, { recipe: "v2" }, "the leased row keeps the intent it leased with");
});

// ---- F3 ---------------------------------------------------------------

test("F3: pruneWakeSignals reaps acked signals past retention and their claim rows, nothing else", t => {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at, transaction: fn => { db.exec("BEGIN IMMEDIATE"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } } });
  t.after(() => db.close());
  hb.heartbeat({ agentId: "ai_testagent", hostId: "host-1", mode: "pull-only" });

  // An old signal that gets claimed and acked.
  const old = hb.enqueueWake({ agentId: "ai_testagent", kind: "mention", roomId: "r", messageId: "old-1" }).signal;
  const lease = hb.acquireListenerLease({ agentId: "ai_testagent", roomId: "r", listenerId: "listener-1" });
  assert.equal(lease.acquired, true);
  const claimed = hb.claimWakeBatch({ agentId: "ai_testagent", roomId: "r", fencingToken: lease.fencingToken });
  assert.equal(claimed.signals.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_wake_signal_claims").get().n, 1);
  hb.ackWakes({ agentId: "ai_testagent", signalIds: [old.signalId], roomId: "r", fencingToken: lease.fencingToken });

  // An old signal that is never acked (still pending).
  const pending = hb.enqueueWake({ agentId: "ai_testagent", kind: "mention", roomId: "r", messageId: "pending-1" }).signal;

  at += WAKE_SIGNAL_RETENTION_MS + 1;

  // A freshly acked signal, inside the retention window.
  const fresh = hb.enqueueWake({ agentId: "ai_testagent", kind: "dm", roomId: "r", messageId: "fresh-1" }).signal;
  hb.ackWakes({ agentId: "ai_testagent", signalIds: [fresh.signalId], roomId: "r" });

  const result = hb.pruneWakeSignals();
  assert.equal(result.deleted, 1, "exactly the acked-and-expired signal is reaped");
  assert.equal(result.claimsDeleted, 1, "its claim row is reaped with it");
  const remaining = db.prepare("SELECT signal_id FROM agent_wake_signals").all().map(r => r.signal_id);
  assert.deepEqual(remaining.sort(), [fresh.signalId, pending.signalId].sort(),
    "unacked signals and recently-acked signals stay");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_wake_signal_claims").get().n, 0);

  const again = hb.pruneWakeSignals();
  assert.equal(again.deleted, 0, "a second prune is a no-op once the window is clean");
});

// ---- F4 ---------------------------------------------------------------

test("F4: a coalesced mention wake does not ring the push doorbell a second time", t => {
  const f = memStore(t);
  const identity = f.store.identities.create("doorbell-agent");
  f.store.identities.link(f.keys.owner, "commons", {
    identityId: identity.identityId, memberId: "agent",
    displayName: "Agent", permissions: [],
  });
  const beat = f.store.agentHeartbeats.heartbeat({
    agentId: identity.identityId, hostId: "host-1", mode: "wakeable",
    wakeUrl: "https://host.example.test/wake",
    pushNotification: { url: "https://push.example.test/hook", token: "opaque-push-token-123" },
  });
  assert.equal(beat.pushConfigured, true);
  f.advance(HEARTBEAT_STALE_AFTER_MS + 1000);
  assert.equal(f.store.agentHeartbeats.statusOf(identity.identityId).status, "offline");

  let pushCalls = 0;
  f.store.agentHeartbeats.pushNotify = () => { pushCalls += 1; };
  f.store.agentPlugin.deliverWakePing = () => ({ deliveries: [] });

  // The durable signal for this message already exists (e.g. an earlier
  // fan-out iteration for the same identity created it): the mention
  // fan-out's enqueue will coalesce, so the doorbell must NOT ring.
  f.store.agentHeartbeats.enqueueWake({ agentId: identity.identityId, kind: "mention", roomId: "commons", messageId: "coal-1" });
  f.store.command(f.keys.owner, "commons", {
    id: randomUUID(), type: "message.posted",
    data: { messageId: "coal-1", body: "@Agent please look" },
  });
  assert.equal(pushCalls, 0, "coalesced wake: no duplicate push doorbell");
  assert.equal(f.store.agentHeartbeats.pendingWakes(identity.identityId).length, 1,
    "the one durable signal is still queued for the host to pull");

  // A genuinely new message enqueues a new signal and rings exactly once.
  f.store.command(f.keys.owner, "commons", {
    id: randomUUID(), type: "message.posted",
    data: { messageId: "coal-2", body: "@Agent and this one" },
  });
  assert.equal(pushCalls, 1, "a new signal rings the doorbell exactly once");
});
