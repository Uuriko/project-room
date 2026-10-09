// PRODUCT-200 reliability anchor A3: INVARIANT "RETRY NEVER DUPLICATES" —
// release replay anchor. A stale or delayed release replayed after an
// intervening re-claim must be REFUSED (never silently destroy the fresh
// claim). This is the P0 that #2088 (compare-and-release) fixed: the
// pre-#2088 /release checked owner === caller only, with no round token,
// so a timed-out retry replayed after release + re-claim destroyed the
// fresh round-2 claim (QA-200 failseq E5 / D4).
//
// Fail-first: written against #2088's contract (/release requires
// {expectedClaimedAt, expectedHistoryLength}; a stale round is refused
// with 409 work_claim_conflict). On pre-#2088 main the strict body shape
// 422s the round tokens, so these scenarios FAIL until #2088 merges —
// then they permanently anchor the invariant. Anchor only; the fix
// itself stays in #2088.
import assert from "node:assert/strict";
import { invariant } from "./dsl.mjs";
import { invariantSuite } from "./runner.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../../server/work-claim-routes.mjs";
import { claimHistoryLength } from "../../server/work-claims.mjs";

const MEMBERS = {
  holder: { id: "holder", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    throw error;
  },
  body: async req => req.body,
};

// Drive the work-claims route the way the HTTP layer does: a fresh
// in-memory registry per scenario, holder as the claim owner.
const call = (registry, memberId, route, id, body, query = "") => handleWorkClaims({
  req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
  res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${query}`),
  store: {
    roomAuthority: () => ({ ownerId: "owner", members: MEMBERS }),
    room: () => ({ state: { messages: [] } }),
  },
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

const readClaim = (registry, id) => call(registry, "holder", "read", id, {});

invariantSuite([
  // Main anchor: claim (round 1) -> release with the round-1 token (200) ->
  // re-claim (round 2) -> replay the stale round-1 release -> REFUSED with
  // 409 work_claim_conflict, and the fresh round-2 claim survives untouched.
  invariant("release-replay-stale-round-refused", "stale release replay never destroys a fresh claim")
    .given(async (f, ctx) => {
      // DECLARE the world: round 1 claimed; read its round token.
      // (The runner still boots its disposable DB; this invariant pins the
      // work-claims registry contract, so state lives on the registry.)
      ctx.registry = createWorkClaimRegistry();
      const round1 = await createAndClaim(ctx.registry, "anchor-replay");
      ctx.token1 = roundOf(round1);
      return ctx;
    })
    .when(async (f, ctx) => {
      // ACT: release round 1 bound to its own token (the happy path — must
      // still work), re-claim (round 2), then replay the STALE round-1
      // release payload. A refusal here is the test signal; the DSL
      // captures it as ctx.error.
      const released = await call(ctx.registry, "holder", "release", "anchor-replay",
        { ...ctx.token1, reason: "round 1 done" });
      ctx.release1Status = released.status;
      const round2 = await call(ctx.registry, "holder", "claim", "anchor-replay", {});
      ctx.token2 = roundOf(round2.value);
      // The timed-out retry: the exact round-1 payload, replayed after the
      // world moved on. Pre-#2088 this silently released round 2.
      await call(ctx.registry, "holder", "release", "anchor-replay",
        { ...ctx.token1, reason: "stale retry" });
    })
    .then(async (f, ctx) => {
      // ASSERT: the happy-path release worked, the stale replay was
      // refused, and round 2 is intact.
      assert.equal(ctx.release1Status, 200, "round-1 release with its own token must succeed");
      assert.equal(ctx.error?.status, 409, `stale replay: expected 409, got ${ctx.error?.status} (${ctx.error?.code})`);
      assert.equal(ctx.error?.code, "work_claim_conflict");
      const current = await readClaim(ctx.registry, "anchor-replay");
      assert.equal(current.value.state, "claimed", "fresh round-2 claim must survive the stale replay");
      assert.equal(current.value.owner, "holder");
      assert.equal(current.value.claimedAt, ctx.token2.expectedClaimedAt, "round-2 claimedAt untouched");
    })
    .build(),

  // Edge anchor: same-millisecond re-claims keep the old claimedAt, so the
  // claimedAt half of the round token cannot discriminate rounds — the
  // history-length half must. A release carrying the CURRENT claimedAt but
  // a STALE history length is still refused.
  invariant("release-replay-history-length-discriminates", "stale history length refuses even with current claimedAt")
    .given(async (f, ctx) => {
      ctx.registry = createWorkClaimRegistry();
      const round1 = await createAndClaim(ctx.registry, "anchor-history-edge");
      ctx.token1 = roundOf(round1);
      return ctx;
    })
    .when(async (f, ctx) => {
      const released = await call(ctx.registry, "holder", "release", "anchor-history-edge",
        { ...ctx.token1, reason: "round 1 done" });
      ctx.release1Status = released.status;
      const round2 = await call(ctx.registry, "holder", "claim", "anchor-history-edge", {});
      ctx.token2 = roundOf(round2.value);
      // Forged stale round: current claimedAt (as if same-millisecond
      // re-claim collided), but the round-1 history length. Must still fail.
      await call(ctx.registry, "holder", "release", "anchor-history-edge", {
        expectedClaimedAt: ctx.token2.expectedClaimedAt,
        expectedHistoryLength: ctx.token1.expectedHistoryLength,
        reason: "forged stale round",
      });
    })
    .then(async (f, ctx) => {
      assert.equal(ctx.release1Status, 200, "round-1 release with its own token must succeed");
      assert.equal(ctx.error?.status, 409, `forged round: expected 409, got ${ctx.error?.status} (${ctx.error?.code})`);
      assert.equal(ctx.error?.code, "work_claim_conflict");
      const current = await readClaim(ctx.registry, "anchor-history-edge");
      assert.equal(current.value.state, "claimed", "round-2 claim must survive the forged replay");
      assert.equal(current.value.owner, "holder");
    })
    .build(),
]);
