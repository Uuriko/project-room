// Every seeker in this file lies. The original suite's seekers all declare
// honestly, which is why 15 green tests said nothing about whether the filter
// could be walked around. These are written to fail against cad19a0.
import test from "node:test";
import assert from "node:assert/strict";
import {
  declareSeeker, describeOpening, matchWork, MIN_TIER, MAX_TIER, FIRST_MATCH_MAX_MINUTES,
} from "../server/work-matchmaking.mjs";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const clock = () => NOW;
const stranger = () => ({});          // resolves to MIN_TIER
const resolver = map => id => map[id] ?? MIN_TIER;

const liar = (over = {}) => declareSeeker({
  seekerId: "ai_liar", motives: ["paid"], capabilities: ["prod", "sql"],
  appetiteMinutes: 600, trustTier: MAX_TIER, ...over,
});
const guarded = (over = {}) => describeOpening({
  openingId: "prod-migration", roomId: "muse-room", title: "production database migration",
  rewardKind: "paid", rewardAmount: 5000, requires: ["prod"],
  sizeMinutes: 480, trustFloor: MAX_TIER, ...over,
});

test("a claimed tier does not open work the receipts do not support", () => {
  const result = matchWork({
    seeker: liar(), openings: [guarded()], now: clock,
    resolveTier: resolver(stranger()),
  });
  assert.equal(result.match, null, "a stranger claiming tier 3 must not match tier-3 work");
  assert.equal(result.rejected[0].code, "trust");
});

test("the rejection does not leak how high the claim would have had to be", () => {
  const result = matchWork({
    seeker: liar(), openings: [guarded()], now: clock, resolveTier: resolver(stranger()),
  });
  assert.doesNotMatch(result.rejected[0].reason, /\b3\b/,
    "naming the floor tells an attacker exactly what to forge next");
});

test("a claimed tier does not lift the first-match size cap", () => {
  const big = describeOpening({
    openingId: "big", roomId: "r", title: "long job", rewardKind: "paid", rewardAmount: 10,
    sizeMinutes: FIRST_MATCH_MAX_MINUTES + 1, trustFloor: MIN_TIER,
  });
  const result = matchWork({
    seeker: liar({ capabilities: [] }), openings: [big], now: clock, resolveTier: resolver(stranger()),
  });
  assert.equal(result.match, null);
  assert.equal(result.rejected[0].code, "first-match-cap");
});

test("no resolver means nobody is elevated: fail closed, not open", () => {
  const result = matchWork({ seeker: liar(), openings: [guarded()], now: clock });
  assert.equal(result.match, null, "a caller that forgot to wire the trust read must trust nobody");
  assert.equal(result.rejected[0].code, "trust");
});

test("the resolved tier is authoritative even when it beats the claim", () => {
  const modest = liar({ seekerId: "ai_veteran", trustTier: MIN_TIER });
  const result = matchWork({
    seeker: modest, openings: [guarded()], now: clock,
    resolveTier: resolver({ ai_veteran: MAX_TIER }),
  });
  assert.equal(result.match.openingId, "prod-migration", "receipts decide, in both directions");
});

test("a resolver that throws fails the call, it does not fall through to a match", () => {
  assert.throws(() => matchWork({
    seeker: liar(), openings: [guarded()], now: clock,
    resolveTier: () => { throw new Error("store down"); },
  }), /trust/i);
});

test("a resolver returning nonsense is a failure, not a tier", () => {
  for (const bad of [99, -1, "3", 1.5, null, undefined, NaN]) {
    assert.throws(() => matchWork({
      seeker: liar(), openings: [guarded()], now: clock, resolveTier: () => bad,
    }), /tier/i, `resolver returning ${String(bad)} must not be believed`);
  }
});

test("the declaration keeps the claim, and the filter never reads it", () => {
  const s = liar();
  assert.equal(s.claimedTier, MAX_TIER, "the claim is kept, as a claim");
  assert.equal("trustTier" in s, false, "nothing named trustTier should survive on a declaration");
});

test("one malformed opening costs that opening, never the batch", () => {
  const good = describeOpening({
    openingId: "good", roomId: "r", title: "fine", rewardKind: "paid", rewardAmount: 1, sizeMinutes: 30,
  });
  const result = matchWork({
    seeker: liar({ capabilities: [] }),
    openings: [{ openingId: "raw", open: true, rewardKind: "paid", sizeMinutes: 30, trustFloor: 0, deadline: null }, good],
    now: clock, resolveTier: resolver(stranger()),
  });
  assert.equal(result.match.openingId, "good", "the sound record still matches");
  assert.equal(result.rejected.find(r => r.openingId === "raw").code, "malformed");
});

test("a seeker that skipped the declaration is refused, not crashed through", () => {
  assert.throws(() => matchWork({
    seeker: { seekerId: "fake", motives: ["paid"], appetiteMinutes: 600 },
    openings: [guarded()], now: clock, resolveTier: resolver(stranger()),
  }), /declared seeker/);
});

test("the hint names something the seeker can act on", () => {
  const mk = (id, over) => describeOpening({
    openingId: id, roomId: "r", title: "t", rewardKind: "paid", rewardAmount: 1, sizeMinutes: 30, ...over,
  });
  const result = matchWork({
    seeker: liar({ capabilities: [] }),
    openings: [mk("c1", { open: false }), mk("c2", { open: false }), mk("c3", { open: false }), mk("live", { requires: ["rust"] })],
    now: clock, resolveTier: resolver(stranger()),
  });
  assert.equal(result.nearest.code, "capability", "closed work is not the seeker's problem to fix");
  assert.equal(result.nearest.count, 1);
});

test("when everything was closed or expired, say that rather than name a constraint", () => {
  const shut = describeOpening({
    openingId: "shut", roomId: "r", title: "t", rewardKind: "paid", rewardAmount: 1, sizeMinutes: 30, open: false,
  });
  const result = matchWork({
    seeker: liar({ capabilities: [] }), openings: [shut], now: clock, resolveTier: resolver(stranger()),
  });
  assert.equal(result.nearest.code, "gone");
  assert.match(result.nearest.hint, /nothing open/i);
});
