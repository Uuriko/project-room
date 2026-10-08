// fuzz-03: stale compare-and-release token fuzz (WAVE-400).
//
// Target: the expectedClaimedAt / expectedHistoryLength round-token checks in
// server/work-claims.mjs (appendWorkPullRequest), plus the release path
// (updateWork state->"unclaimed", the route at work-claim-routes.mjs
// "release"), which takes NO round token in this tree (#2088 not merged).
//
// Invariants under test:
//   1. A stale token NEVER mutates or destroys a fresh claim (must throw
//      ClaimError: work_claim_conflict or equivalent).
//   2. A missing token is rejected (never treated as match-all).
//   3. Wrong-typed tokens are rejected (422-class invalid_claim_input).
//   4. The item is byte-identical after every rejected hostile attempt.
//   5. The release path: a stale/duplicate release must not silently destroy
//      a fresh re-claim (E5). Tested as a fixed repro, not fuzzed away.
//
// TEST-ONLY: reads server/work-claims.mjs, mutates nothing outside this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWork, claimWork, updateWork, renewWork, reassignWork, attestWork,
  recordReview, appendWorkPullRequest, claimHistoryLength, releaseExpired,
  ClaimError, ACTIVE_CLAIM_STATES,
} from "../server/work-claims.mjs";

// ---- seeded RNG (hand-rolled mulberry32) ----
const seed = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`fuzz-03 stale-token seed: ${seed}`);
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(seed);
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const chance = p => rnd() < p;

// ---- virtual clock: every op gets an explicit `now` ----
let nowMs = 1_790_000_000_000;
const tick = (ms = 1) => { nowMs += ms; return nowMs; };

const AGENTS = ["fuzzA", "fuzzB", "fuzzC", "fuzzMgr"];
const prUrl = n => `https://github.com/Uuriko/project-room/pull/${n}`;
const isoShift = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

function freshClaimed(id, owner, t) {
  let w = createWork({ id }, { now: t, agentId: "sys" });
  w = claimWork(w, owner, { now: t, agentId: owner });
  return w;
}
const tokensOf = w => ({ claimedAt: w.claimedAt, historyLength: claimHistoryLength(w) });
const snap = w => JSON.stringify(w);

// Differential oracle: what the implementation MUST do for a token attempt.
// Mirrors the documented check order in appendWorkPullRequest.
function oracle(w, caller, tokA, tokH, t) {
  const tokOk = typeof tokA === "string" && tokA.length <= 100 && Number.isFinite(Date.parse(tokA))
    && Number.isSafeInteger(tokH) && tokH >= 0;
  if (!tokOk) return "invalid_claim_input";
  if (!ACTIVE_CLAIM_STATES.includes(w.state) || !w.owner || w.supersededBy) return "work_claim_conflict";
  if (w.owner !== caller) return "work_not_owner";
  if (w.leaseExpiresAt !== null && Date.parse(w.leaseExpiresAt) <= t) return "claim_lease_lapsed";
  if (w.claimedAt !== tokA || claimHistoryLength(w) !== tokH) return "work_claim_conflict";
  return "ok";
}

// Apply one random round-advancing (or no-op) mutation. Returns { w, owner }.
function randomOp(w, owner, t, id) {
  const others = AGENTS.filter(a => a !== owner);
  const op = pick([
    "renew", "note", "start", "pause", "block", "attest", "review",
    "reassign", "appendValid", "releaseReclaim", "expireReclaim", "noopAttest",
  ]);
  try {
    switch (op) {
      case "renew":
        if (w.leaseExpiresAt === null) return { w, owner };
        return { w: renewWork(w, owner, { now: t }), owner };
      case "note":
        return { w: updateWork(w, owner, { note: `fuzz note ${ri(1, 1e6)}`, now: t }), owner };
      case "start":
        if (w.state !== "claimed") return { w, owner };
        return { w: updateWork(w, owner, { state: "in_progress", now: t }), owner };
      case "pause":
        if (w.state !== "in_progress" && w.state !== "blocked") return { w, owner };
        return { w: updateWork(w, owner, { state: "claimed", now: t }), owner };
      case "block":
        if (w.state !== "claimed" && w.state !== "in_progress") return { w, owner };
        return { w: updateWork(w, owner, { state: "blocked", now: t }), owner };
      case "attest":
        return { w: attestWork(w, owner, { note: `ack ${ri(1, 1e6)}`, now: t }), owner };
      case "noopAttest": {
        // identical note twice: second is a no-op, history length unchanged
        const w1 = attestWork(w, owner, { note: "same-note", now: t });
        const w2 = attestWork(w1, owner, { note: "same-note", now: t + 1 });
        return { w: w2, owner };
      }
      case "review": {
        const reviewer = pick(others);
        return { w: recordReview(w, reviewer, { verdict: pick(["comment", "approve", "changes_requested"]),
          summary: `fuzz review ${ri(1, 1e6)}`, now: t }), owner };
      }
      case "reassign": {
        const target = pick(others);
        return { w: reassignWork(w, owner, target, { now: t }), owner: target };
      }
      case "appendValid": {
        const tok = tokensOf(w);
        return { w: appendWorkPullRequest(w, owner, { pullRequest: prUrl(ri(1, 9999)),
          expectedClaimedAt: tok.claimedAt, expectedHistoryLength: tok.historyLength, now: t }), owner };
      }
      case "releaseReclaim": {
        let w2 = w;
        if (w2.state === "in_progress" || w2.state === "blocked") {
          w2 = updateWork(w2, owner, { state: "claimed", now: t }); // route pauses first
        }
        w2 = updateWork(w2, owner, { state: "unclaimed", note: "fuzz release", now: t });
        const next = pick(others);
        return { w: claimWork(w2, next, { now: t + 1 }), owner: next };
      }
      case "expireReclaim": {
        // force the lease to lapse, sweep, reclaim
        const w2 = releaseExpired([w], Date.parse(w.leaseExpiresAt ?? "9999-01-01T00:00:00.000Z") + 1);
        if (w2[0].state !== "unclaimed") return { w, owner };
        const next = pick(others);
        return { w: claimWork(w2[0], next, { now: t }), owner: next };
      }
      default:
        return { w, owner };
    }
  } catch {
    return { w, owner }; // op refused (e.g. lease lapsed) — state unchanged
  }
}

// Build one hostile token variant from a captured token pair.
function hostileTokens(tok, w, other) {
  const kind = pick([
    "stale", "missing", "null", "wrongTypeAt", "wrongTypeHl",
    "forgedAt", "forgedHl", "forgedBoth", "crossItem", "emptyStringAt",
  ]);
  switch (kind) {
    case "stale": return { kind, tokA: tok.claimedAt, tokH: tok.historyLength };
    case "missing": return { kind, tokA: undefined, tokH: undefined };
    case "null": return { kind, tokA: null, tokH: null };
    case "emptyStringAt": return { kind, tokA: "", tokH: tok.historyLength };
    case "wrongTypeAt":
      return { kind, tokA: pick([12345, NaN, {}, [], true, "not-a-date", "x".repeat(101)]), tokH: tok.historyLength };
    case "wrongTypeHl":
      return { kind, tokA: tok.claimedAt, tokH: pick(["3", 2.5, -1, NaN, null, 2 ** 53, {}, []] ) };
    case "forgedAt":
      return { kind, tokA: isoShift(tok.claimedAt, pick([1, -1, 1000, -1000, 3600000])), tokH: tok.historyLength };
    case "forgedHl":
      return { kind, tokA: tok.claimedAt, tokH: Math.max(0, tok.historyLength + pick([-3, -1, 1, 3, 50])) };
    case "forgedBoth":
      return { kind, tokA: isoShift(tok.claimedAt, ri(-5000, 5000) || 7), tokH: ri(0, 40) };
    case "crossItem":
      return { kind, tokA: other.claimedAt, tokH: claimHistoryLength(other) };
    default: return { kind: "stale", tokA: tok.claimedAt, tokH: tok.historyLength };
  }
}

let attempts = 0, rejected = 0, acceptedLegit = 0, crossItemCollisions = 0;

test("hostile appendWorkPullRequest token fuzz", () => {
  const ROUNDS = 6200;
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = tick(ri(1, 50));
    const owner0 = pick(AGENTS);
    let w = freshClaimed(`fz-${i}`, owner0, t0);
    // a second item for cross-item token attempts
    let other = freshClaimed(`fz-other-${i}`, pick(AGENTS), t0 + (chance(0.5) ? 0 : ri(1, 1000)));
    const tok = tokensOf(w); // the "stale read"
    let owner = owner0;

    // advance the round with 0..4 random ops (the stale read ages)
    const nOps = ri(0, 4);
    for (let k = 0; k < nOps; k++) {
      const t = tick(ri(1, 20));
      const r = randomOp(w, owner, t, `fz-${i}`);
      w = r.w; owner = r.owner;
    }

    // hostile attempt
    const t = tick(1);
    const hv = hostileTokens(tok, w, other);
    // caller: usually the (possibly new) owner, sometimes the stale previous owner or a stranger
    const caller = chance(0.7) ? owner : (chance(0.5) ? owner0 : pick(AGENTS));
    const before = snap(w);
    const want = oracle(w, caller, hv.tokA, hv.tokH, t);
    attempts++;
    let err = null, out = null;
    try {
      out = appendWorkPullRequest(w, caller, { pullRequest: prUrl(ri(10000, 19999)),
        expectedClaimedAt: hv.tokA, expectedHistoryLength: hv.tokH, now: t });
    } catch (e) { err = e; }
    if (want === "ok") {
      // legitimate accept: tokens genuinely match the live round (includes the
      // value-collision case where cross-item tokens coincide by value)
      assert.equal(err, null, `round ${i} kind=${hv.kind}: expected accept, got ${err?.code}: ${err?.message}`);
      assert.ok(out, "accept must return an item");
      acceptedLegit++;
      if (hv.kind === "crossItem" && hv.tokA === w.claimedAt) crossItemCollisions++;
    } else {
      assert.ok(err instanceof ClaimError, `round ${i} kind=${hv.kind}: expected ClaimError, got ${err}`);
      assert.equal(err.code, want, `round ${i} kind=${hv.kind}: expected ${want}, got ${err.code}`);
      rejected++;
      // INVARIANT: a rejected stale/hostile attempt leaves the fresh owner's
      // state byte-identical.
      assert.equal(snap(w), before, `round ${i} kind=${hv.kind}: rejected attempt mutated the item`);
    }
  }
  console.log(`fuzz-03 append: ${attempts} attempts, ${rejected} rejected, ${acceptedLegit} legit accepts, cross-item value collisions: ${crossItemCollisions}`);
});

test("E5 still present: stale manager release destroys a fresh re-claim (no round token on the release path)", () => {
  // Mirrors server/work-claim-routes.mjs "release" (lines ~1160-1182):
  //   load fresh item -> authorityOver(item) true for a manage_claims holder ->
  //   updateWork(item, caller, { state: "unclaimed", authority: true })
  // updateWork takes NO expectedClaimedAt/expectedHistoryLength, so a delayed
  // duplicate of the manager's own earlier release silently destroys whoever
  // claimed the work after them. #2088 (compare-and-release on /release) is
  // not merged in this tree, so the hole is live.
  const t0 = tick(100);
  let w = freshClaimed("e5-release", "fuzzMgr", t0);
  const round1 = tokensOf(w);
  // manager releases (round 1 ends)
  w = updateWork(w, "fuzzMgr", { state: "unclaimed", note: "done for now", now: tick(10) });
  assert.equal(w.state, "unclaimed");
  assert.equal(w.owner, null);
  // another agent claims the freed work (round 2, fresh)
  w = claimWork(w, "fuzzB", { now: tick(10) });
  const round2 = tokensOf(w);
  assert.notEqual(round2.claimedAt, round1.claimedAt);
  assert.equal(w.owner, "fuzzB");
  const beforeFresh = snap(w);
  // the manager's STALE release retry arrives (delayed duplicate). The route
  // loads the CURRENT item (owner fuzzB), authorityOver -> true, and calls:
  const destroyed = updateWork(w, "fuzzMgr", { state: "unclaimed", note: "stale retry", now: tick(10), authority: true });
  // BUG DEMONSTRATED: no throw, no 409 — the fresh claim is gone.
  assert.equal(destroyed.state, "unclaimed", "stale manager release released the fresh claim");
  assert.equal(destroyed.owner, null, "fresh owner fuzzB was silently cleared");
  assert.notEqual(snap(destroyed), beforeFresh, "fresh claim state was destroyed by the stale release");
  console.log("fuzz-03 E5 repro: stale manager release destroyed a fresh re-claim (no token checked)");
});

test("release path: stale release by a non-manager is refused (owner gate holds)", () => {
  const t0 = tick(100);
  let w = freshClaimed("e5-nonmgr", "fuzzA", t0);
  w = updateWork(w, "fuzzA", { state: "unclaimed", note: "r", now: tick(10) });
  w = claimWork(w, "fuzzB", { now: tick(10) });
  const before = snap(w);
  // stale previous owner's retry WITHOUT authority -> refused. Note: the pure
  // machine reports the owner gate as invalid_claim_input; the HTTP route
  // checks ownership first and maps this to 403 work_not_owner
  // (work-claim-routes.mjs update/release handlers).
  assert.throws(
    () => updateWork(w, "fuzzA", { state: "unclaimed", note: "stale retry", now: tick(10) }),
    err => err instanceof ClaimError && err.code === "invalid_claim_input");
  assert.equal(snap(w), before, "refused stale release must not mutate the item");
});

test("release path: stale manager release after in_progress pause also destroys (route pauses first)", () => {
  const t0 = tick(100);
  let w = freshClaimed("e5-inprog", "fuzzMgr", t0);
  w = updateWork(w, "fuzzMgr", { state: "in_progress", now: tick(5) });
  w = updateWork(w, "fuzzMgr", { state: "claimed", note: "paused for release", now: tick(5) }); // route pauses first
  w = updateWork(w, "fuzzMgr", { state: "unclaimed", note: "r", now: tick(5) });
  w = claimWork(w, "fuzzB", { now: tick(5) });
  w = updateWork(w, "fuzzB", { state: "in_progress", now: tick(5) });
  assert.equal(w.owner, "fuzzB");
  // route's release handler pauses in_progress -> claimed, then releases, all with authority
  let item = updateWork(w, "fuzzMgr", { state: "claimed", note: "paused for release", now: tick(5), authority: true });
  item = updateWork(item, "fuzzMgr", { state: "unclaimed", note: "stale retry", now: tick(5), authority: true });
  assert.equal(item.owner, null, "BUG: stale manager release destroyed fuzzB's in_progress claim");
  assert.equal(item.state, "unclaimed");
});

test("done criteria: attempt budget met", () => {
  assert.ok(attempts >= 5000, `expected >= 5000 hostile attempts, ran ${attempts}`);
  console.log(`fuzz-03 DONE: seed=${seed} attempts=${attempts} rejected=${rejected} legitAccepts=${acceptedLegit}`);
});
