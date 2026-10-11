// VERIFY (w500-g5-c2): renewal behaviors expected to hold on 02d4bc0bf.
// Exit 0 = all hold; non-zero = a regression in expected behavior.
// Run: node repros/verify-renewal.mjs
import assert from "node:assert/strict";
import { leased, AGENT, ROOM } from "./harness.mjs";

// 1. Renew before expiry: same token, renewed:true, expiry extended.
{
  const { hb, advance, lease, close } = leased("listener-a", 60000);
  const t1 = lease.fencingToken;
  advance(30000);
  const r = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "listener-a", ttlMs: 60000 });
  assert.equal(r.acquired, true);
  assert.equal(r.renewed, true);
  assert.equal(r.fencingToken, t1, "token stable across renewal");
  assert.ok(r.leaseExpiresAt > lease.leaseExpiresAt, "expiry extended");
  close();
  console.log("ok: renew-before-expiry keeps the fencing token, renewed:true, expiry extended");
}

// 2. Renew after expiry: NEW token, renewed:false, acquired:true (free for anyone).
{
  const { hb, advance, lease, close } = leased("listener-a", 60000);
  const t1 = lease.fencingToken;
  advance(60001);
  const r = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "listener-a", ttlMs: 60000 });
  assert.equal(r.acquired, true);
  assert.equal(r.renewed, false);
  assert.notEqual(r.fencingToken, t1, "post-expiry re-acquire mints a new token");
  close();
  console.log("ok: renew-after-expiry mints a new token (expired lease is free for anyone)");
}

// 3. TTL extension on renew: a larger ttlMs moves the expiry out.
{
  const { hb, advance, lease, close } = leased("listener-a", 1000);
  advance(500);
  const r = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "listener-a", ttlMs: 120000 });
  assert.equal(r.leaseExpiresAt, 1_750_000_000_000 + 500 + 120000);
  close();
  console.log("ok: renew applies the new ttlMs to leaseExpiresAt");
}

// 4. Renew racing a second listener AFTER the boundary: newcomer wins, old renew refused.
{
  const { hb, advance, close } = leased("listener-a", 60000);
  advance(60001);
  const b = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "listener-b", ttlMs: 60000 });
  assert.equal(b.acquired, true);
  const a2 = hb.acquireListenerLease({ agentId: AGENT, roomId: ROOM, listenerId: "listener-a", ttlMs: 60000 });
  assert.equal(a2.acquired, false, "stale renew after takeover is refused");
  assert.equal(a2.activeListenerId, "listener-b");
  close();
  console.log("ok: post-boundary takeover refuses the stale listener's renew, names the holder");
}

// 5. Release with a wrong token releases nothing.
{
  const { hb, lease, close } = leased("listener-a", 60000);
  const r = hb.releaseListenerLease({ agentId: AGENT, roomId: ROOM, fencingToken: "bogus" });
  assert.equal(r.released, false);
  const ok = hb.releaseListenerLease({ agentId: AGENT, roomId: ROOM, fencingToken: lease.fencingToken });
  assert.equal(ok.released, true);
  close();
  console.log("ok: release with wrong token is a no-op; right token releases");
}

console.log("VERIFY: all expected renewal behaviors hold");
