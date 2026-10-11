// REPRO-04 (w500-g5-c2): acquire is check-then-act, not atomic — two
// acquirers at the expiry boundary can BOTH be told { acquired:true } while
// only the last writer's token is live. The loser holds a dead-on-arrival
// token and discovers it only when claimWakeBatch 409s.
//
// Single-threaded JS can't interleave the method's SELECT and INSERT, so
// this white-box repro performs the interleaving the method itself performs:
// A's re-acquire SELECT sees the expired row; B's full acquire completes;
// A's upsert (verbatim SQL from acquireListenerLease) then overwrites B.
//
// FAIL-FIRST: asserts that when B is told acquired:true, B's token can
// actually claim. Fails on 02d4bc0bf: B's token is dead the moment A's
// upsert lands — B's claimWakeBatch throws 409 stale_listener.
// Run: node repros/repro-04-acquire-race-lost-update.mjs
import { randomBytes } from "node:crypto";
import { leased, AGENT, ROOM } from "./harness.mjs";

const TTL = 60000;
const u = leased("listener-a", TTL);
const { hb, db, now, advance, close } = u;
const tokenA = u.lease.fencingToken;

// 1. A's lease lapses exactly at the boundary (strict `>` treats E as expired).
advance(TTL);
const at = now();

// 2. A's re-acquire begins: the SELECT the method runs sees the expired row.
const existing = db.prepare(`SELECT listener_id AS listenerId, fencing_token AS fencingToken,
  lease_expires_at AS leaseExpiresAt FROM agent_wake_listener_leases WHERE agent_id=? AND room_key=?`)
  .get(AGENT, ROOM);
console.log("A's check sees:", JSON.stringify({ expired: existing.leaseExpiresAt <= at }));

// 3. Before A's upsert lands, B's full acquire runs to completion.
const b = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "listener-b", ttlMs: TTL });
console.log("B acquire:", JSON.stringify({ acquired: b.acquired }));

// 4. A's upsert lands (verbatim from acquireListenerLease's expired path).
const tokenA2 = randomBytes(16).toString("base64url");
db.prepare(`INSERT INTO agent_wake_listener_leases
  (agent_id, room_key, listener_id, fencing_token, lease_expires_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(agent_id, room_key) DO UPDATE SET listener_id=excluded.listener_id,
    fencing_token=excluded.fencing_token, lease_expires_at=excluded.lease_expires_at,
    updated_at=excluded.updated_at`)
  .run(AGENT, ROOM, "listener-a", tokenA2, at + TTL, at);
console.log("A's re-acquire upsert landed: acquired:true (implied), token rotated");

// 5. Whose token is actually live?
const live = db.prepare(`SELECT fencing_token AS t, listener_id AS l
  FROM agent_wake_listener_leases WHERE agent_id=? AND room_key=?`).get(AGENT, ROOM);
console.log("live lease row:", JSON.stringify({ listener: live.l, tokenIsA2: live.t === tokenA2, tokenIsB: live.t === b.fencingToken }));

// 6. B — told acquired:true — tries to use its token.
hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: ROOM, messageId: "m-race" });
let claimError = null;
try {
  hb.claimWakeBatch({ agentId: AGENT, roomId: ROOM, fencingToken: b.fencingToken, limit: 5 });
} catch (e) { claimError = `${e.status} ${e.code}`; }
console.log("B claimWakeBatch with its 'acquired' token:", claimError ?? "ok");
close();

if (b.acquired && claimError) {
  console.log("REPRO-04 CONFIRMED: B was told acquired:true but its token is dead (" + claimError + ") — last-writer-wins, loser uninformed");
  process.exit(1);
}
console.log("REPRO-04 FIXED: concurrent acquires serialize — exactly one winner, losers refused");
