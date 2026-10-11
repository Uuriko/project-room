// REPRO-03 (w500-g5-c2): agentId validation in acquireListenerLease throws
// code "invalid_heartbeat" while every other parameter of the SAME call
// (roomId, listenerId, ttlMs) throws "invalid_listener_lease".
//
// FAIL-FIRST: asserts all parameter errors from acquireListenerLease use the
// listener-lease error code. Fails on 02d4bc0bf: checkAgentId() hardcodes
// "invalid_heartbeat", so a client switching on error.code sees two codes
// for one API (claimWakeBatch has the same split: invalid_heartbeat vs
// invalid_wake_claim).
// Run: node repros/repro-03-agentid-error-code.mjs
import { unit, AGENT, ROOM } from "./harness.mjs";
import { HeartbeatError } from "../server/agent-heartbeats.mjs";

const { hb, close } = unit();
const good = { agentId: AGENT, roomId: ROOM, listenerId: "listener-a", ttlMs: 60000 };
const cases = {
  agentId: { ...good, agentId: "not an id!!" },
  roomId: { ...good, roomId: "" },
  listenerId: { ...good, listenerId: "bad id" },
  ttlMs: { ...good, ttlMs: -5 },
};
const codes = {};
for (const [param, args] of Object.entries(cases)) {
  try {
    hb.acquireListenerLease(args);
    codes[param] = "(no throw?!)";
  } catch (e) {
    codes[param] = e instanceof HeartbeatError ? `${e.status} ${e.code}` : `${e.name}`;
  }
}
close();
console.log("error codes by parameter:", JSON.stringify(codes, null, 2));
const distinct = new Set(Object.values(codes));
if (distinct.size > 1) {
  console.log("REPRO-03 CONFIRMED: inconsistent error codes within one API (" + [...distinct].join(", ") + ")");
  process.exit(1);
}
console.log("REPRO-03 FIXED: single error code for the listener-lease API");
