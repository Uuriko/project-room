import test from "node:test";
import assert from "node:assert/strict";
import {
  declareSeeker, describeOpening, matchWork,
  MOTIVES, FIRST_MATCH_MAX_MINUTES, MIN_TIER,
} from "../server/work-matchmaking.mjs";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const clock = () => NOW;

const seeker = (over = {}) => declareSeeker({
  seekerId: "ai_stranger", motives: ["paid"], capabilities: ["javascript", "tests"],
  appetiteMinutes: 120, trustTier: 1, ...over,
});
const opening = (over = {}) => describeOpening({
  openingId: "op-1", roomId: "muse-room", title: "Fix the cap",
  rewardKind: "paid", rewardAmount: 100, requires: ["javascript"],
  sizeMinutes: 60, trustFloor: 0, ...over,
});

test("a seeker declares motive, capability, appetite and tier", () => {
  const s = seeker();
  assert.deepEqual(s.motives, ["paid"]);
  assert.deepEqual(s.capabilities, ["javascript", "tests"]);
  assert.equal(Object.isFrozen(s), true);
});

test("motives are checked against the vocabulary the openings use", () => {
  assert.throws(() => seeker({ motives: ["glory"] }), /unknown motive glory/);
  for (const m of MOTIVES) assert.equal(declareSeeker({ seekerId: "a", motives: [m], appetiteMinutes: 30 }).motives[0], m);
});

test("declarations are normalised so both sides meet without translation", () => {
  const s = seeker({ capabilities: ["  JavaScript ", "javascript", "Rust"] });
  assert.deepEqual(s.capabilities, ["javascript", "rust"]);
  const o = opening({ requires: ["JAVASCRIPT"] });
  assert.deepEqual(o.requires, ["javascript"]);
  assert.equal(matchWork({ seeker: s, openings: [o], now: clock }).match.openingId, "op-1");
});

test("work offered for fun cannot carry a reward amount", () => {
  assert.throws(() => opening({ rewardKind: "fun", rewardAmount: 50 }), /cannot carry a reward amount/);
  assert.equal(opening({ rewardKind: "fun", rewardAmount: 0 }).rewardAmount, 0);
});

test("unpaid work is first class: a hobby seeker is matched to it", () => {
  const result = matchWork({
    seeker: seeker({ motives: ["fun"], trustTier: 0 }),
    openings: [opening({ openingId: "hobby", rewardKind: "fun", rewardAmount: 0, sizeMinutes: 30 })],
    now: clock,
  });
  assert.equal(result.match.openingId, "hobby");
  assert.match(result.match.why, /unpaid/);
});

test("work-trade is matched on its own motive and never confused with paid", () => {
  const openings = [
    opening({ openingId: "cash", rewardKind: "paid" }),
    opening({ openingId: "trade", rewardKind: "work-trade", rewardAmount: 5 }),
  ];
  const result = matchWork({ seeker: seeker({ motives: ["work-trade"] }), openings, now: clock });
  assert.equal(result.match.openingId, "trade");
  assert.equal(result.rejected.find(r => r.openingId === "cash").code, "motive");
});

test("one match comes back, never a list", () => {
  const openings = [opening({ openingId: "a" }), opening({ openingId: "b", rewardAmount: 400 })];
  const result = matchWork({ seeker: seeker(), openings, now: clock });
  assert.equal(result.match.openingId, "b");
  assert.deepEqual(result.alternatives, ["a"]);
});

test("every rejection says why, so a non-match is never unexplained", () => {
  const openings = [
    opening({ openingId: "shut", open: false }),
    opening({ openingId: "late", deadline: "2026-09-29T00:00:00.000Z" }),
    opening({ openingId: "hard", requires: ["rust", "kubernetes"] }),
    opening({ openingId: "long", sizeMinutes: 600 }),
    opening({ openingId: "guarded", trustFloor: 3 }),
  ];
  const result = matchWork({ seeker: seeker(), openings, now: clock });
  assert.equal(result.match, null);
  const byId = Object.fromEntries(result.rejected.map(r => [r.openingId, r]));
  assert.equal(byId.shut.code, "closed");
  assert.equal(byId.late.code, "expired");
  assert.equal(byId.hard.code, "capability");
  assert.match(byId.hard.reason, /kubernetes, rust/);
  assert.equal(byId.long.code, "appetite");
  assert.equal(byId.guarded.code, "trust");
  assert.equal(result.rejected.length, 5);
});

test("a stranger's first piece of work is capped in size", () => {
  const big = opening({ openingId: "big", sizeMinutes: FIRST_MATCH_MAX_MINUTES + 1, trustFloor: 0 });
  const stranger = seeker({ trustTier: MIN_TIER, appetiteMinutes: 600 });
  const capped = matchWork({ seeker: stranger, openings: [big], now: clock });
  assert.equal(capped.match, null);
  assert.equal(capped.rejected[0].code, "first-match-cap");
  // the same work is open to someone who has finished something here
  assert.equal(matchWork({ seeker: seeker({ trustTier: 1, appetiteMinutes: 600 }), openings: [big], now: clock }).match.openingId, "big");
});

test("the trust floor holds work back from a stranger regardless of capability", () => {
  const result = matchWork({
    seeker: seeker({ trustTier: 0, capabilities: ["javascript", "rust", "tests"] }),
    openings: [opening({ openingId: "prod", trustFloor: 2, sizeMinutes: 30 })],
    now: clock,
  });
  assert.equal(result.match, null);
  assert.equal(result.rejected[0].code, "trust");
});

test("the same inputs always produce the same match", () => {
  const openings = [
    opening({ openingId: "z", rewardAmount: 100, sizeMinutes: 60 }),
    opening({ openingId: "a", rewardAmount: 100, sizeMinutes: 60 }),
  ];
  const first = matchWork({ seeker: seeker(), openings, now: clock });
  const again = matchWork({ seeker: seeker(), openings: [...openings].reverse(), now: clock });
  assert.equal(first.match.openingId, "a");
  assert.equal(again.match.openingId, "a");
});

test("paid work is preferred over unpaid when the seeker asked for both", () => {
  const result = matchWork({
    seeker: seeker({ motives: ["paid", "fun"] }),
    openings: [opening({ openingId: "free", rewardKind: "fun", rewardAmount: 0, sizeMinutes: 10 }), opening({ openingId: "cash" })],
    now: clock,
  });
  assert.equal(result.match.openingId, "cash");
});

test("a seeker who matched nothing is told which constraint excluded the most", () => {
  const openings = [
    opening({ openingId: "a", requires: ["rust"] }),
    opening({ openingId: "b", requires: ["go"] }),
    opening({ openingId: "c", sizeMinutes: 900 }),
  ];
  const result = matchWork({ seeker: seeker(), openings, now: clock });
  assert.equal(result.nearest.code, "capability");
  assert.equal(result.nearest.count, 2);
  assert.match(result.nearest.hint, /capabilities/);
});

test("nothing on offer is an empty answer, not an error", () => {
  const result = matchWork({ seeker: seeker(), openings: [], now: clock });
  assert.equal(result.match, null);
  assert.equal(result.nearest, null);
  assert.deepEqual(result.rejected, []);
});

test("the matcher is pure: outputs frozen, clock injected, no status codes", () => {
  const result = matchWork({ seeker: seeker(), openings: [opening()], now: clock });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.match), true);
  assert.throws(() => matchWork({ seeker: seeker(), openings: [opening()] }), /now must be a clock function/);
  try { declareSeeker({ seekerId: "a", motives: ["nope"], appetiteMinutes: 5 }); }
  catch (err) { assert.equal(err.code, "unknown motive nope" in err ? null : err.code); assert.equal("status" in err, false); }
});
