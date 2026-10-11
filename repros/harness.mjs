// Shared harness for w500-g5-c2 lease-renewal probes.
// Probes server/agent-heartbeats.mjs @ 02d4bc0bf (pre-hold #2536 lease layer).
// Minimal store double: the test suite (tests/agent-wake-listener-lease.test.js)
// uses exactly this shape.
import { DatabaseSync } from "node:sqlite";
import {
  AgentHeartbeats,
  HeartbeatError,
  agentHeartbeatSchema,
  wakeListenerLeaseSchema,
} from "../server/agent-heartbeats.mjs";

export const T0 = 1_750_000_000_000;
export const ROOM = "muse-room";
export const AGENT = "ai_lease";

export function unit() {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const store = { db, now: () => at };
  const hb = new AgentHeartbeats(store, {});
  return {
    hb,
    db,
    now: () => at,
    advance: (ms) => { at += ms; },
    close: () => db.close(),
  };
}

// One live lease held by listenerId for AGENT/ROOM (heartbeat first so the
// agent is registered, mirroring the suite's leased() helper).
export function leased(listenerId = "listener-a", ttlMs = 60000) {
  const u = unit();
  u.hb.heartbeat({ agentId: AGENT, hostId: "host-1", mode: "pull-only" });
  const lease = u.hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId, ttlMs });
  return { ...u, lease };
}

export function errOf(fn) {
  try { fn(); } catch (e) { return e; }
  return null;
}

export function expectCode(fn, status, code) {
  const e = errOf(fn);
  if (!(e instanceof HeartbeatError))
    throw new Error(`expected HeartbeatError(${status},${code}), got ${e ? `${e.name}: ${e.message}` : "no throw"}`);
  if (e.status !== status || e.code !== code)
    throw new Error(`expected (${status},${code}), got (${e.status},${e.code}): ${e.message}`);
  return e;
}
