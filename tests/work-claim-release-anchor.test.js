// PRODUCT-200 reliability anchor A3: INVARIANT "RETRY NEVER DUPLICATES" —
// release replay anchor. A stale or delayed release replayed after an
// intervening re-claim must be REFUSED (never silently destroy the fresh
// claim). This is the P0 that #2088 (compare-and-release) fixed: the
// pre-#2088 /release checked owner === caller only, with no round token,
// so a timed-out retry replayed after release + re-claim destroyed the
// fresh round-2 claim.
//
// Fail-first: written against #2088's contract
// ({expectedClaimedAt, expectedHistoryLength} required on /release; stale
// round -> 409 work_claim_conflict). On pre-#2088 main the strict body
// shape 422s the round tokens, so this file FAILS until #2088 merges —
// then it permanently anchors the invariant.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { claimHistoryLength } from "../server/work-claims.mjs";

const MEMBERS = {
  holder: { id: "holder", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};

const call = (registry, memberId, route, id, body, query = "") => handleWorkClaims({
  req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
  res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${query}`),
  store: { roomAuthority: () => ({ ownerId: "owner", members: MEMBERS }), room: () => ({ state: { messages: [] } }) },
  roomId: "room1",
  auth: { member: { id: memberId, kind: MEMBERS[memberId].kind, permissions: MEMBERS[memberId].permissions } },
  workClaimRoute: route,
  workClaimId: id,
  helpers,
  registry,
});

// The round token a client reads before releasing (mirrors #2088's
// releaseWork contract: claimedAt + history length bind the claim round).
const roundOf = item => ({
  expectedClaimedAt: item.claimedAt,
  expectedHistoryLength: claimHistoryLength(item),
});

async function createAndClaim(registry, id) {
  const created = await call(registry, "holder", "create", null, { id });
  assert.equal(created.status, 201);
  const claimed = await call(registry, "holder", "claim", id, {});
  assert.equal(claimed.status, 200);
  assert.equal(claimed.value.state, "claimed");
  assert.equal(claimed.value.owner, "holder");
  return claimed.value;
}

const assertStaleReleaseRefused = (promise, label) => assert.rejects(promise, error => {
  assert.equal(error.status, 409, `${label}: expected 409, got ${error.status} (${error.code})`);
  assert.equal(error.code, "work_claim_conflict", `${label}: expected work_claim_conflict`);
  return true;
});

test("stale round-1 release replay is refused (409) and the fresh round-2 claim survives", async () => {
  const registry = createWorkClaimRegistry();

  // Round 1: claim, read the round token, release bound to it (happy path).
  const round1 = await createAndClaim(registry, "anchor-replay");
  const token1 = roundOf(round1);
  const released = await call(registry, "holder", "release", "anchor-replay",
    { ...token1, reason: "round 1 done" });
  assert.equal(released.status, 200);
  assert.equal(released.value.state, "unclaimed");

  // Round 2: re-claim. Release + re-claim both stamp history, so the round-2
  // history is strictly longer than round 1's.
  const round2 = await call(registry, "holder", "claim", "anchor-replay", {});
  assert.equal(round2.status, 200);
  const token2 = roundOf(round2.value);
  assert.ok(token2.expectedHistoryLength > token1.expectedHistoryLength,
    `round 2 history (${token2.expectedHistoryLength}) must exceed round 1 (${token1.expectedHistoryLength})`);

  // Replay the STALE round-1 release payload — a timed-out retry or delayed
  // duplicate landing after the intervening re-claim. This is the E5/D4
  // scenario: it must be refused, never applied.
  await assertStaleReleaseRefused(
    call(registry, "holder", "release", "anchor-replay", { ...token1, reason: "stale retry" }),
    "stale round-1 release");

  // The fresh round-2 claim survives untouched: still claimed, same holder,
  // same round token it had before the replay.
  const live = await call(registry, "holder", "read", "anchor-replay");
  assert.equal(live.status, 200);
  assert.equal(live.value.state, "claimed");
  assert.equal(live.value.owner, "holder");
  assert.equal(live.value.claimedAt, token2.expectedClaimedAt);
  assert.equal(claimHistoryLength(live.value), token2.expectedHistoryLength);
});

test("history length discriminates rounds when claimedAt collides (same-millisecond re-claim edge)", async () => {
  const registry = createWorkClaimRegistry();

  const round1 = await createAndClaim(registry, "anchor-samems");
  const token1 = roundOf(round1);
  const released = await call(registry, "holder", "release", "anchor-samems",
    { ...token1, reason: "round 1 done" });
  assert.equal(released.status, 200);
  const round2 = await call(registry, "holder", "claim", "anchor-samems", {});
  assert.equal(round2.status, 200);
  const token2 = roundOf(round2.value);
  assert.ok(token2.expectedHistoryLength > token1.expectedHistoryLength);

  // #2088 keeps the previous round's claimedAt on a same-millisecond
  // re-claim, so the timestamp alone cannot discriminate rounds. A release
  // carrying the CURRENT claimedAt but the STALE history length must still
  // be refused — the deterministic form of that edge, with no timing flake.
  await assertStaleReleaseRefused(
    call(registry, "holder", "release", "anchor-samems", {
      expectedClaimedAt: token2.expectedClaimedAt,
      expectedHistoryLength: token1.expectedHistoryLength,
      reason: "same-millisecond stale length",
    }),
    "current claimedAt + stale history length");

  // Fresh claim still survives.
  const live = await call(registry, "holder", "read", "anchor-samems");
  assert.equal(live.status, 200);
  assert.equal(live.value.state, "claimed");
  assert.equal(live.value.owner, "holder");
  assert.equal(live.value.claimedAt, token2.expectedClaimedAt);
});

test("a release bound to the CURRENT round still succeeds (no happy-path regression)", async () => {
  const registry = createWorkClaimRegistry();

  const round1 = await createAndClaim(registry, "anchor-happy");
  const token1 = roundOf(round1);
  const released = await call(registry, "holder", "release", "anchor-happy",
    { ...token1, reason: "fresh release" });
  assert.equal(released.status, 200);
  assert.equal(released.value.state, "unclaimed");
  assert.equal(released.value.owner, null);
});
