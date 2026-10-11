// WAVE-500 guild 9 slice A2 (claim wave500-g9-remedy-ack-fence):
// FAIL-FIRST repro for #2536-remediation blocker (2) — ackWakes is not
// fenced by the signal's actual holder. claimWakeBatch records WHO holds
// each signal in agent_wake_signal_claims (claimed_by = fencing token),
// but ackWakes only checks the ack's fencingToken against the lease row —
// it never looks at the claims table. So a signal claimed by holder A can
// be drained by a different live holder B (or by nobody at all), deleting
// work A had claimed but not yet handled. REPRO ONLY — no fix here.
// The remedy lane owns the exact fix and the rejection code; these tests
// require only the layer's established fence shape (409 HeartbeatError).

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AgentHeartbeats, HeartbeatError, agentHeartbeatSchema,
} from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;
const ROOM = "muse-room";

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  t.after(() => db.close());
  return { hb: new AgentHeartbeats({ db, now: () => at }, {}), advance: ms => { at += ms; } };
}

const wakeable = (agentId = "ai_lease", hostId = "host-1") =>
  ({ agentId, hostId, mode: "pull-only" });

// Holder A acquires a lease, claims a batch, then its lease lapses with the
// batch still unacked — the claims table still records claimed_by = tokenA.
function claimedThenLapsed(t) {
  const { hb, advance } = unit(t);
  hb.heartbeat(wakeable());
  for (let i = 0; i < 2; i++) {
    hb.enqueueWake({ agentId: "ai_lease", kind: "mention", roomId: ROOM, messageId: `m${i}` });
  }
  const a = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-a", ttlMs: 60000 });
  assert.equal(a.acquired, true);
  const batch = hb.claimWakeBatch({ agentId: "ai_lease", roomId: ROOM, fencingToken: a.fencingToken, limit: 5 });
  assert.equal(batch.signals.length, 2, "holder A claims the batch");
  advance(60001); // A's lease lapses; A never acked.
  return { hb, signalIds: batch.signals.map(s => s.signalId) };
}

const foreignAck = (err) => err instanceof HeartbeatError && err.status === 409;

test("a different live lease holder cannot ack another holder's claimed batch", t => {
  const { hb, signalIds } = claimedThenLapsed(t);
  const b = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-b", ttlMs: 60000 });
  assert.equal(b.acquired, true, "B holds the only live lease");
  // The signals are still recorded as claimed_by = A's token; B never
  // claimed them, so B's ack must be refused. Today it is accepted.
  assert.throws(
    () => hb.ackWakes({ agentId: "ai_lease", signalIds, roomId: ROOM, fencingToken: b.fencingToken }),
    foreignAck,
    "holder B must not drain signals held by holder A's token",
  );
  assert.equal(hb.pendingWakes("ai_lease", { roomId: ROOM }).length, 2,
    "the foreign-acked signals must still be pending");
});

test("with no live lease, acks cannot drain another holder's claimed batch", t => {
  const { hb, signalIds } = claimedThenLapsed(t);
  // No listener is live at all now (A lapsed, B never acquired), but the
  // claims table still records claimed_by = A's token. An unfenced ack
  // must not drain them. Today it is accepted (backward-compat path).
  assert.throws(
    () => hb.ackWakes({ agentId: "ai_lease", signalIds, roomId: ROOM }),
    foreignAck,
    "unfenced acks must not drain signals held by another token",
  );
  assert.equal(hb.pendingWakes("ai_lease", { roomId: ROOM }).length, 2,
    "the foreign-acked signals must still be pending");
});
