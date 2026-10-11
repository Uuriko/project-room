// REPRO-01 (w500-g5-c2): lease renewal authenticates by listenerId alone —
// a caller that knows/guesses the listenerId harvests the LIVE fencing token
// without ever presenting one.
//
// FAIL-FIRST: asserts that a second caller naming the same listenerId is NOT
// handed the live fencing token. Fails on 02d4bc0bf: acquireListenerLease
// returns { acquired:true, renewed:true, fencingToken: <live token> }.
//
// Why it matters: the fencing token is the capability that gates
// claimWakeBatch/ackWakes. Renewal by ID alone lets any process that learns
// the (host-chosen, often predictable) listenerId take over the victim's
// queue — claim its signals, ack them away. Renewal should require the
// current token (compare-and-swap on (listenerId, fencingToken)).
// Run: node repros/repro-01-renew-leaks-token.mjs
import { leased, AGENT, ROOM } from "./harness.mjs";

const { hb, lease, close } = leased("listener-a", 60000);
const victimToken = lease.fencingToken;
console.log("victim acquired: token =", victimToken.slice(0, 12) + "...");

// A DIFFERENT process re-acquires naming the same listenerId, presenting no token.
const attacker = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "listener-a", ttlMs: 60000 });
console.log("attacker re-acquire by listenerId:", JSON.stringify({
  acquired: attacker.acquired, renewed: attacker.renewed,
  sameTokenAsVictim: attacker.fencingToken === victimToken,
}));

// The attacker can now act as the listener: claim + ack a real signal.
hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m-victim" });
const batch = hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: attacker.fencingToken, limit: 5 });
const acked = hb.ackWakes({
  agentId: AGENT, roomId: ROOM,
  signalIds: batch.signals.map(s => s.signalId), fencingToken: attacker.fencingToken,
});
console.log("attacker claimed+acked victim's signal:", acked.acknowledged.length === 1);
close();

if (attacker.acquired && attacker.fencingToken === victimToken) {
  console.log("REPRO-01 CONFIRMED: renew-by-listenerId leaks the live fencing token (no token required)");
  process.exit(1);
}
console.log("REPRO-01 FIXED: re-acquire without the token does not hand over the live token");
