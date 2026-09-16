// B019: agent reputation/staking. Pure tracker tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createReputation, ReputationError } from "../server/reputation.mjs";

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
test("malformed inputs are refused", () => {
  const rep = createReputation();
  throwsCode(() => rep.signal("a", { kind: "meh", weight: 1 }), "invalid_reputation");
  throwsCode(() => rep.signal("a", { kind: "positive", weight: 0 }), "invalid_reputation");
  throwsCode(() => rep.stake("a", -5), "invalid_reputation");
  throwsCode(() => rep.decay(2), "invalid_reputation");
});
