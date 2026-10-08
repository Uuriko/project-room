// FIX-12 (WAVE-300 ranked-fixes burn-down): unprivileged succession fast path.
//
// When a claim holder dies, an unprivileged peer faces the full lease
// (~48h in the PHOENIX 2am drill) before it can take over, versus ~19s for
// a privileged reassign. The fast path: once the holder's server-observed
// heartbeat is stale beyond SUCCESSION_STALENESS_MS, any peer may succeed
// the claim in one call — minutes, not days.
//
// Guardrails under test:
// - heartbeats are HINTS, leases are AUTHORITY: silence inside the
//   threshold never transfers a claim (partition safety);
// - server clock only: staleness is measured from server-stamped
//   last_seen_at against the server now;
// - single serialized write: the eligibility check and the ownership
//   transfer commit in one transaction — exactly one holder, and a
//   returning holder's writes are fenced (403/409), never merged.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { SUCCESSION_STALENESS_MS } from "../server/work-claim-routes.mjs";

const CONTRIBUTE = ["accept_work", "complete_work"];

async function fixture(t) {
  let nowMs = Date.now();
  const store = new RoomStore(":memory:", { now: () => nowMs });
  t.after(() => store.close());
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, kind) => store.command(ownerKey, "commons", {
    id: `add-${id}`, type: "member.added",
    data: { memberId: id, displayName: id, kind, permissions: [...CONTRIBUTE] },
  });
  add("holder", "agent");
  add("peer", "agent");
  add("peer2", "agent");
  const holderKey = store.issueAccessKey("commons", "holder");
  const peerKey = store.issueAccessKey("commons", "peer");
  const peer2Key = store.issueAccessKey("commons", "peer2");
  // Heartbeats are keyed by agent identity; identity_links maps room members
  // onto the identities whose hosts report.
  const mkIdentity = name => store.identities.create(name).identityId;
  const holderIdentity = mkIdentity("Holder");
  const peerIdentity = mkIdentity("Peer");
  const peer2Identity = mkIdentity("Peer2");
  const link = (memberId, identityId) => store.db.prepare(
    "INSERT INTO identity_links (room_id, identity_id, member_id, linked_at) VALUES (?,?,?,?)"
  ).run("commons", identityId, memberId, nowMs);
  link("holder", holderIdentity);
  link("peer", peerIdentity);
  link("peer2", peer2Identity);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, path, body) => {
    const res = await fetch(`${origin}/api/rooms/commons${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, value: await res.json() };
  };
  return {
    store, call,
    heartbeat: (identityId, hostId = "lane-1") =>
      store.agentHeartbeats.heartbeat({ agentId: identityId, hostId }),
    advance: ms => { nowMs += ms; },
    get nowMs() { return nowMs; },
    ownerKey, holderKey, peerKey, peer2Key, holderIdentity, peerIdentity, peer2Identity,
  };
}

async function heldClaim(f, id, leaseHours = 48) {
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id })).status, 201);
  f.heartbeat(f.holderIdentity);
  const claimed = await f.call(f.holderKey, `/work-claims/${id}/claim`, { leaseHours });
  assert.equal(claimed.status, 200);
  return claimed.value;
}

test("kill-holder: an unprivileged peer succeeds a stale holder's claim in minutes", async t => {
  const f = await fixture(t);
  await heldClaim(f, "w1", 48);
  // The holder dies (no more heartbeats). A peer that tries immediately —
  // inside the staleness threshold — is refused: silence alone is a hint.
  f.advance(60_000);
  const early = await f.call(f.peerKey, "/work-claims/w1/succeed", {});
  assert.equal(early.status, 409);
  assert.equal(early.value.error.code, "succession_not_eligible");
  // Past the threshold the fast path fires: one call, well under the 48h lease.
  f.advance(SUCCESSION_STALENESS_MS);
  const took = await f.call(f.peerKey, "/work-claims/w1/succeed", {});
  assert.equal(took.status, 200);
  assert.equal(took.value.owner, "peer");
  assert.equal(took.value.state, "claimed");
  // The work lease moves with the claim (reassign parity) — the successor
  // resumes the round, it does not restart it.
  const remainingMs = Date.parse(took.value.leaseExpiresAt) - f.nowMs;
  assert.ok(remainingMs > 47 * 3600 * 1000, `lease preserved, ${remainingMs}ms remain`);
  const stamp = took.value.history.at(-1);
  assert.equal(stamp.action, "succeeded");
  assert.match(stamp.note, /holder/);
});

test("partition safety: a live-but-quiet holder keeps its claim", async t => {
  const f = await fixture(t);
  await heldClaim(f, "w1", 48);
  // Quiet for a minute — a transient partition, inside the threshold.
  f.advance(60_000);
  const r = await f.call(f.peerKey, "/work-claims/w1/succeed", {});
  assert.equal(r.status, 409);
  assert.equal(r.value.error.code, "succession_not_eligible");
  const read = await f.call(f.peerKey, "/work-claims/w1");
  assert.equal(read.value.owner, "holder");
});

test("partition safety: no heartbeat record means no staleness succession", async t => {
  const f = await fixture(t);
  // A holder whose identity never heartbeated: liveness unknown, so the
  // staleness arm stays shut — only a lapsed lease (sweep) can free it.
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id: "w2" })).status, 201);
  const claimed = await f.call(f.holderKey, "/work-claims/w2/claim", { leaseHours: 48 });
  assert.equal(claimed.status, 200);
  f.advance(SUCCESSION_STALENESS_MS + 60_000);
  const r = await f.call(f.peerKey, "/work-claims/w2/succeed", {});
  assert.equal(r.status, 409);
  assert.equal(r.value.error.code, "succession_not_eligible");
});

test("no split-brain: exactly one holder through succession and holder-return", async t => {
  const f = await fixture(t);
  await heldClaim(f, "w1", 48);
  f.advance(SUCCESSION_STALENESS_MS + 60_000);
  const took = await f.call(f.peerKey, "/work-claims/w1/succeed", {});
  assert.equal(took.status, 200);
  // A second peer cannot succeed the live successor — one holder only.
  f.heartbeat(f.peerIdentity);
  const steal = await f.call(f.peer2Key, "/work-claims/w1/succeed", {});
  assert.equal(steal.status, 409);
  assert.equal(steal.value.error.code, "succession_not_eligible");
  // The dead holder returns (its partition heals) and heartbeats: its
  // writes are fenced, never merged over the successor's claim.
  f.heartbeat(f.holderIdentity);
  const update = await f.call(f.holderKey, "/work-claims/w1/update", { note: "i am back" });
  assert.equal(update.status, 403);
  assert.equal(update.value.error.code, "work_not_owner");
  const renew = await f.call(f.holderKey, "/work-claims/w1/renew", {});
  assert.equal(renew.status, 403);
  const reclaim = await f.call(f.holderKey, "/work-claims/w1/claim", {});
  assert.equal(reclaim.status, 409);
  const read = await f.call(f.peerKey, "/work-claims/w1");
  assert.equal(read.value.owner, "peer");
  assert.equal(read.value.history.filter(h => h.action === "succeeded").length, 1);
});

test("succeed refuses unclaimed, terminal, and self-held claims", async t => {
  const f = await fixture(t);
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id: "w3" })).status, 201);
  const free = await f.call(f.peerKey, "/work-claims/w3/succeed", {});
  assert.equal(free.status, 409);
  assert.equal(free.value.error.code, "succession_not_held");
  await heldClaim(f, "w4", 48);
  const self = await f.call(f.holderKey, "/work-claims/w4/succeed", {});
  assert.equal(self.status, 409);
  assert.equal(self.value.error.code, "succession_self");
  const missing = await f.call(f.peerKey, "/work-claims/nope/succeed", {});
  assert.equal(missing.status, 404);
});

test("privileged reassign is unchanged by the succession path", async t => {
  const f = await fixture(t);
  await heldClaim(f, "w5", 48);
  const moved = await f.call(f.ownerKey, "/work-claims/w5/reassign", { newOwner: "peer" });
  assert.equal(moved.status, 200);
  assert.equal(moved.value.owner, "peer");
  assert.equal(moved.value.history.at(-1).action, "reassigned:peer");
});
