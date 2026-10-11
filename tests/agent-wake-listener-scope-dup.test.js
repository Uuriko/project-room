// WAVE-500 guild 9 slice A1 (claim wave500-g9-remedy-scope-dup) — FAIL-FIRST
// repro for #2536 blocker (1): overlapping live scopes replay the same wake.
// Two LIVE listener leases whose scopes overlap (agent-wide roomId=null,
// whose claim matches every room's signals, plus a room-scoped lease) can
// both claim — and therefore both deliver — a single enqueued wake signal.
// Repro only: no fix. Expected to FAIL until the overlap is fenced.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AgentHeartbeats, agentHeartbeatSchema,
} from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;
const ROOM = "muse-room";

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  const at = T0;
  t.after(() => db.close());
  return { hb: new AgentHeartbeats({ db, now: () => at }, {}) };
}

const wakeable = (agentId = "ai_scope") =>
  ({ agentId, hostId: "host-1", mode: "pull-only" });

test("FAIL-FIRST: overlapping live scopes must not both deliver the same wake", t => {
  const { hb } = unit(t);
  hb.heartbeat(wakeable());
  // Agent-wide (roomId=null) and room-scoped leases are keyed on different
  // room_key rows, so BOTH are live at once — their scopes overlap.
  const agentWide = hb.acquireListenerLease({ agentId: "ai_scope", roomId: null, listenerId: "listener-wide", ttlMs: 60000 });
  const roomScoped = hb.acquireListenerLease({ agentId: "ai_scope", roomId: ROOM, listenerId: "listener-room", ttlMs: 60000 });
  assert.equal(agentWide.acquired, true, "agent-wide lease acquires");
  assert.equal(roomScoped.acquired, true, "room-scoped lease acquires alongside it");

  // One wake signal, targeted at the room.
  hb.enqueueWake({ agentId: "ai_scope", kind: "mention", roomId: ROOM, messageId: "m1" });

  const first = hb.claimWakeBatch({ agentId: "ai_scope", roomId: null, fencingToken: agentWide.fencingToken, limit: 5 });
  assert.equal(first.signals.length, 1, "agent-wide lease claims the signal");

  // Blocker (1): the room-scoped lease ALSO claims the very same signal —
  // one wake, two deliveries. A fenced design must return nothing here.
  const second = hb.claimWakeBatch({ agentId: "ai_scope", roomId: ROOM, fencingToken: roomScoped.fencingToken, limit: 5 });
  assert.equal(second.signals.length, 0,
    "room-scoped lease must not re-deliver an already-claimed wake — " +
    `got ${second.signals.length} signal(s): ${second.signals.map(s => s.signalId).join(",")} ` +
    `(redelivered=${second.signals.map(s => s.redelivered).join(",")})`);
});
