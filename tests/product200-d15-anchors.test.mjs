// PRODUCT-200 reliability anchors D1–D4 (worker D1-5/50, consolidated).
//
// Fail-first regression anchors for QA-200 P0/P1s. Each anchor pins the
// invariant the bug violated; anchors that needed a fix carry the fix in
// the same change (anchor+fix together).
//
// D1 — stale-release replay: second-path variants of A3's #2156 anchor
//      (route-level re-claim replay). D1a pins the timeout-retry shape
//      (identical release payload double-submitted, no re-claim between);
//      D1b pins the pure releaseWork contract.
// D2 — same-millisecond re-claim with a GENUINELY identical claimedAt
//      across rounds (A3's #2156 edge only forged the token by hand) —
//      history length alone must discriminate.
// D3 — release replay carrying a forged or missing round token is
//      rejected and never applied.
// D4 — board write paths emit work_claim.updated events (QA-200's "zero
//      events" P1 narrowed: the route paths DO emit — Dot's refutation,
//      now pinned — while the projection mirror's create leg bypassed
//      emission; anchor+fix).
// D5 (concurrent identical keyless updates apply once) is not part of this
// change: main's opt-in requestId (A4) is the idempotency mechanism and its
// invariant pins that keyless updates are each a distinct write.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { claimHistoryLength, releaseWork, ClaimError } from "../server/work-claims.mjs";
import { mirrorProjectionClaim } from "../server/work-claim-mirror.mjs";

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};

function roomFixture(t, { now } = {}) {
  const store = new RoomStore(":memory:");
  if (now !== undefined) store.now = now;
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", {
    id: "add-holder", type: "member.added",
    data: { memberId: "holder", displayName: "holder", kind: "agent", permissions: ["accept_work", "complete_work"] },
  });
  t.after(() => store.close());
  const call = async (memberId, route, { id = null, body = undefined } = {}) => {
    const method = body === undefined ? "GET" : "POST";
    try {
      const out = await handleWorkClaims({
        req: { method, body }, res: {},
        url: new URL("https://room.example/api/rooms/commons/work-claims"),
        store, roomId: "commons",
        auth: { member: { id: memberId, kind: "agent", permissions: [] } },
        workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims,
      });
      return { status: out.status, code: out.value?.error?.code ?? null, value: out.value };
    } catch (error) {
      if (!Number.isInteger(error.status)) throw error;
      return { status: error.status, code: error.code, message: error.message };
    }
  };
  const events = action => store.db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE room_id='commons' AND json_extract(body,'$.type')='work_claim.updated'"
    + (action ? " AND json_extract(body,'$.data.action')=?" : "")
  ).get(...(action ? [action] : [])).n;
  return { store, call, events };
}

const roundOf = item => ({
  expectedClaimedAt: item.claimedAt,
  expectedHistoryLength: claimHistoryLength(item),
});

async function createAndClaim(f, id, by = "holder") {
  const created = await f.call(by, "create", { body: { id, title: id } });
  assert.equal(created.status, 201, `create: ${created.code} ${created.message ?? ""}`);
  const claimed = await f.call(by, "claim", { id, body: { leaseHours: 2 } });
  assert.equal(claimed.status, 200, `claim: ${claimed.code} ${claimed.message ?? ""}`);
  return claimed.value;
}

const readClaim = (f, id) => f.call("holder", "read", { id });

const releaseWith = (f, id, token, extra = {}) =>
  f.call("holder", "release", { id, body: { ...token, reason: "release", ...extra } });

// ── D1a: timeout-retry double-submit — the identical release payload fired
// twice with no re-claim between. The replay must be REFUSED and never
// re-applied: the round is gone, so #2194's deliberate ownership-first
// ordering answers 403 work_not_owner before the round check runs (a
// round-check-first ordering would answer 409 — either refusal satisfies
// the invariant). ──────────────────────────────────────────────────
test("D1a: replaying the identical release payload after it landed is refused, never re-applied", async t => {
  const f = roomFixture(t);
  const round1 = await createAndClaim(f, "d1a");
  const token1 = roundOf(round1);
  const first = await releaseWith(f, "d1a", token1);
  assert.equal(first.status, 200, `first release: ${first.code} ${first.message ?? ""}`);
  assert.equal(first.value.state, "unclaimed");
  const before = claimHistoryLength((await readClaim(f, "d1a")).value);
  const replay = await releaseWith(f, "d1a", token1);
  assert.ok(replay.status >= 400 && replay.status < 500,
    `stale release replay must be refused, got ${replay.status}`);
  assert.ok(replay.code === "work_not_owner" || replay.code === "work_claim_conflict",
    `refusal code must name the stale round, got ${replay.code}`);
  const current = (await readClaim(f, "d1a")).value;
  assert.equal(current.state, "unclaimed", "the replay must not resurrect or mutate the claim");
  assert.equal(claimHistoryLength(current), before, "no history may be appended by a refused replay");
});

// ── D1b: pure releaseWork contract — stale round throws, current round
// releases. ─────────────────────────────────────────────────────────────
test("D1b: releaseWork binds the round — stale token throws work_claim_conflict", async t => {
  const f = roomFixture(t);
  const round1 = await createAndClaim(f, "d1b");
  const token1 = roundOf(round1);
  const nowMs = Date.now();
  const released = releaseWork(round1, "holder", { ...token1, note: "round 1 done", now: nowMs });
  assert.equal(released.state, "unclaimed");
  // Round 2: a legitimate re-claim of the same item.
  const { claimWork } = await import("../server/work-claims.mjs");
  const round2 = claimWork(released, "holder", { now: nowMs + 5, leaseHours: 2 });
  assert.equal(round2.state, "claimed");
  assert.throws(
    () => releaseWork(round2, "holder", { ...token1, note: "stale", now: nowMs + 6 }),
    error => error instanceof ClaimError && error.code === "work_claim_conflict",
    "stale round-1 token against round 2 must throw work_claim_conflict",
  );
  const token2 = roundOf(round2);
  const released2 = releaseWork(round2, "holder", { ...token2, note: "round 2 done", now: nowMs + 7 });
  assert.equal(released2.state, "unclaimed", "the current round token still releases");
});

// ── D2: TRUE same-millisecond re-claim — claimedAt is genuinely identical
// across rounds (store.now pinned), so only the history length can
// discriminate the stale round-1 release. ───────────────────────────────
test("D2: same-millisecond re-claim — history length discriminates when claimedAt cannot", async t => {
  const FIXED_MS = 1_790_000_000_000;
  const f = roomFixture(t, { now: () => FIXED_MS });
  const round1 = await createAndClaim(f, "d2");
  const token1 = roundOf(round1);
  const first = await releaseWith(f, "d2", token1);
  assert.equal(first.status, 200, `round-1 release: ${first.code}`);
  const round2 = (await f.call("holder", "claim", { id: "d2", body: { leaseHours: 2 } })).value;
  assert.equal(round2.state, "claimed");
  const token2 = roundOf(round2);
  assert.equal(token2.expectedClaimedAt, token1.expectedClaimedAt,
    "setup: claimedAt must be genuinely identical across the two rounds for this anchor");
  assert.notEqual(token2.expectedHistoryLength, token1.expectedHistoryLength,
    "setup: history length must differ across rounds");
  const replay = await releaseWith(f, "d2", token1);
  assert.equal(replay.status, 409, `stale replay with colliding claimedAt: expected 409, got ${replay.status} (${replay.code})`);
  assert.equal(replay.code, "work_claim_conflict");
  const current = (await readClaim(f, "d2")).value;
  assert.equal(current.state, "claimed", "round-2 claim must survive");
  assert.equal(current.owner, "holder");
  assert.equal(current.claimedAt, token2.expectedClaimedAt, "round-2 claimedAt untouched");
});

// ── D3a: forged round token (valid shape, wrong claimedAt) → 409, never
// applied. ──────────────────────────────────────────────────────────────
test("D3a: release with a forged claimedAt is refused with 409 and never applied", async t => {
  const f = roomFixture(t);
  const round1 = await createAndClaim(f, "d3a");
  const token1 = roundOf(round1);
  const before = claimHistoryLength(round1);
  const forged = await f.call("holder", "release", { id: "d3a", body: {
    expectedClaimedAt: "2030-01-01T00:00:00.000Z",
    expectedHistoryLength: token1.expectedHistoryLength,
    reason: "forged",
  } });
  assert.equal(forged.status, 409, `forged token: expected 409, got ${forged.status} (${forged.code})`);
  assert.equal(forged.code, "work_claim_conflict");
  const current = (await readClaim(f, "d3a")).value;
  assert.equal(current.state, "claimed", "the claim must survive a forged release");
  assert.equal(current.owner, "holder");
  assert.equal(claimHistoryLength(current), before, "no history may be appended by a refused release");
});

// ── D3b: missing round token (legacy payload) → 422, never applied. ────
test("D3b: release without round tokens is refused with 422 and never applied", async t => {
  const f = roomFixture(t);
  const round1 = await createAndClaim(f, "d3b");
  const before = claimHistoryLength(round1);
  const legacy = await f.call("holder", "release", { id: "d3b", body: { reason: "legacy client" } });
  assert.equal(legacy.status, 422, `missing tokens: expected 422, got ${legacy.status} (${legacy.code})`);
  const current = (await readClaim(f, "d3b")).value;
  assert.equal(current.state, "claimed", "the claim must survive a tokenless release");
  assert.equal(claimHistoryLength(current), before, "no history may be appended by a refused release");
});

// ── D4a: the route board write paths emit work_claim.updated events — the
// QA-200 "zero events" P1 narrowed to evidence: these paths DO emit. ─────
test("D4a: every route board mutation appends a work_claim.updated room event", async t => {
  const f = roomFixture(t);
  const start = f.events();
  await createAndClaim(f, "d4a");
  assert.equal(f.events("created"), 1, "create must emit a 'created' work_claim.updated event");
  assert.ok(f.events("claimed") >= 1, "claim must emit a 'claimed' event");
  const upd = await f.call("holder", "update", { id: "d4a", body: { state: "in_progress", note: "go" } });
  assert.equal(upd.status, 200, `update: ${upd.code}`);
  assert.ok(f.events("state_changed") >= 1, "state update must emit a 'state_changed' event");
  const rel = await releaseWith(f, "d4a", roundOf(upd.value));
  assert.equal(rel.status, 200, `release: ${rel.code}`);
  assert.ok(f.events("released") >= 1, "release must emit a 'released' event");
  assert.ok(f.events() > start, "the event stream must grow with board mutations");
});

// ── D4b: the projection mirror's create leg wrote the board with ZERO
// events (direct store.write bypassing emission). Fail-first: the create
// mutation must emit its own event at the mutation site. ────────────────
test("D4b: projection-mirror claim.acquired emits a created event for the new board item", async t => {
  const f = roomFixture(t);
  const at = new Date().toISOString();
  const before = f.events();
  const item = mirrorProjectionClaim(f.store, "commons", "holder", {
    type: "claim.acquired", at, data: { workItemId: "proj-acquire-1" },
  });
  assert.ok(item, "mirror must return the board item");
  assert.equal(item.state, "claimed");
  const created = f.events("created");
  const claimed = f.events("claimed");
  assert.equal(created, 1, `mirror create leg: expected 1 'created' event, got ${created} (total ${f.events() - before})`);
  assert.equal(claimed, 1, `mirror claim leg: expected 1 'claimed' event, got ${claimed}`);
});
