// B019: agent reputation/staking. Pure tracker tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createReputation, ReputationError, REPUTATION_DECAY_HALF_LIFE_MS } from "../server/reputation.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ReputationError && error.code === code);

test("signal/stake/decay/leaderboard", () => {
  const rep = createReputation();
  rep.signal("ada", { kind: "positive", weight: 10 });
  rep.signal("ada", { kind: "negative", weight: 3 });
  assert.equal(rep.get("ada").score, 7);
  rep.stake("ada", 100);
  assert.equal(rep.get("ada").staked, 100);
  rep.signal("bob", { kind: "positive", weight: 20 });
  const board = rep.leaderboard(2);
  assert.deepEqual(board.map(r => r.agentId), ["bob", "ada"]);
  assert.ok(Object.isFrozen(board[0]));
  rep.decay(0.5);
  assert.equal(rep.get("bob").score, 10); // 20 * 0.5
});
test("scores are bounded at ±100", () => {
  const rep = createReputation();
  rep.signal("x", { kind: "positive", weight: 1000 });
  assert.equal(rep.get("x").score, 100);
  rep.signal("x", { kind: "negative", weight: 1000 });
  assert.equal(rep.get("x").score, -100);
});
test("decay() does not double-decay time-aware scores (#2947)", () => {
  const HL = REPUTATION_DECAY_HALF_LIFE_MS;
  const t0 = 1_700_000_000_000;
  const rep = createReputation();
  // Build a time-aware score of 80 at t0: 72 legacy points, then a typed
  // signal (+8) that stamps updatedMs = t0 without decaying the legacy base.
  rep.signal("ada", { kind: "positive", weight: 72 });
  rep.signalTyped("ada", "payout_released", { at: t0 });
  assert.equal(rep.get("ada").score, 80);
  assert.equal(rep.get("ada").updatedMs, t0);
  // Sanity: one half-life of pure time decay halves the score.
  assert.equal(rep.scoreAt("ada", t0 + HL), 40);
  // The explicit decay step for that same interval: 80 -> 40.
  rep.decay(0.5);
  assert.equal(rep.get("ada").score, 40);
  // Regression: scoreAt must not charge the same interval a second time
  // (the old code returned 20 here because updatedMs was left at t0).
  assert.equal(rep.scoreAt("ada", t0 + HL), 40);
  // Time decay resumes from the advanced timestamp: one more half-life -> 20.
  assert.equal(rep.scoreAt("ada", t0 + 2 * HL), 20);
  // Negative time-aware scores decay toward 0 symmetrically, also once.
  const rep2 = createReputation();
  rep2.signal("bob", { kind: "negative", weight: 68 });
  rep2.signalTyped("bob", "dispute_lost", { at: t0 }); // -68 - 12 = -80 at t0
  rep2.decay(0.5);
  assert.equal(rep2.get("bob").score, -40);
  assert.equal(rep2.scoreAt("bob", t0 + HL), -40);
  // Legacy records stay timeless: decay scales them, updatedMs remains null.
  const rep3 = createReputation();
  rep3.signal("cy", { kind: "positive", weight: 50 });
  rep3.decay(0.5);
  assert.equal(rep3.get("cy").score, 25);
  assert.equal(rep3.get("cy").updatedMs, null);
  assert.equal(rep3.scoreAt("cy", t0 + 10 * HL), 25);
  // decay(0) is a no-op for time-aware records, timestamp included.
  const rep4 = createReputation();
  rep4.signalTyped("dee", "payout_released", { at: t0 });
  rep4.decay(0);
  assert.equal(rep4.get("dee").score, 8);
  assert.equal(rep4.get("dee").updatedMs, t0);
});
test("malformed inputs are refused", () => {
  const rep = createReputation();
  throwsCode(() => rep.signal("a", { kind: "meh", weight: 1 }), "invalid_reputation");
  throwsCode(() => rep.signal("a", { kind: "positive", weight: 0 }), "invalid_reputation");
  throwsCode(() => rep.stake("a", -5), "invalid_reputation");
  throwsCode(() => rep.decay(2), "invalid_reputation");
});
