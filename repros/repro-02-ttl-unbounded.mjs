// REPRO-02 (w500-g5-c2): ttlMs is unbounded — absurd values are accepted, and
// the extreme end POISONS the (agent, room) slot permanently.
//
// FAIL-FIRST: asserts acquireListenerLease rejects an absurd ttlMs with 422
// invalid_listener_lease. Fails on 02d4bc0bf three ways:
//   (a) ttlMs = Number.MAX_SAFE_INTEGER is ACCEPTED. SQLite stores
//       lease_expires_at = now + ttlMs = 9008949254740991 — beyond the JS
//       safe-integer range.
//   (b) From then on, EVERY lease operation on that (agent, room) throws an
//       unhandled ERR_OUT_OF_RANGE RangeError when node:sqlite reads the
//       row back (acquire, claimWakeBatch, ackWakes all SELECT
//       lease_expires_at). No 422, no recovery short of DB surgery — the
//       slot is poisoned, not just wedged.
//   (c) ttlMs = 1e15 (~31,688 years) is accepted and simply wedges the slot:
//       every rival acquire is refused { acquired:false }.
//
// Precedent in the same file: checkCadenceSeconds caps cadence at
// MAX_CADENCE_SECONDS (7 days). The lease TTL needs a similar bound.
// Run: node repros/repro-02-ttl-unbounded.mjs
import { unit, AGENT, ROOM } from "./harness.mjs";

const { hb, now, close } = unit();
hb.heartbeat({ agentId: AGENT, hostId: "host-1", mode: "pull-only" });

// (a) extreme end: accepted, row written beyond the JS safe-integer range.
const maxed = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "squatter-max", ttlMs: Number.MAX_SAFE_INTEGER });
console.log("(a) ttlMs=MAX_SAFE_INTEGER accepted, acquired:", maxed.acquired);

// (b) the slot is now poisoned: the next acquire's row read-back throws.
let poison = null;
try {
  hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "legit-listener", ttlMs: 60000 });
} catch (e) { poison = `${e.code ?? e.name}: ${String(e.message).slice(0, 70)}`; }
console.log("(b) next acquire on the poisoned slot ->", poison ?? "worked?!");

// (c) fresh agent: a large-but-bindable TTL wedges the slot for millennia.
const AGENT2 = "ai_lease_2";
hb.heartbeat({ agentId: AGENT2, hostId: "host-1", mode: "pull-only" });
const huge = hb.acquireListenerLease({ agentId: AGENT2, roomId: ROOM, listenerId: "squatter", ttlMs: 1e15 });
const years = (huge.leaseExpiresAt - now()) / (365.25 * 24 * 3600 * 1000);
const rival = hb.acquireListenerLease({ agentId: AGENT2, roomId: ROOM, listenerId: "rival", ttlMs: 60000 });
console.log("(c) ttlMs=1e15 accepted, lease runs ~" + Math.round(years) + " years; rival refused:", !rival.acquired);
close();

if (maxed.acquired && poison) {
  console.log("REPRO-02 CONFIRMED: unbounded ttlMs — MAX_SAFE_INTEGER accepted then poisons the slot (" + poison + "); 1e15 wedges it ~" + Math.round(years) + " years");
  process.exit(1);
}
console.log("REPRO-02 FIXED: absurd ttlMs is rejected with 422 invalid_listener_lease");
