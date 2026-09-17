// B018: task router. Pure routing tests.
import test from "node:test";
import assert from "node:assert/strict";
import { scoreFit, routeTask, suggestAgent, RouterError } from "../server/task-router.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof RouterError && error.code === code);

const agents = [
  { agentId: "ada", capabilities: ["web", "search", "nlp"] },
  { agentId: "bob", capabilities: ["web"] },
  { agentId: "carol", capabilities: ["vision"] },
];

test("scoreFit computes capability overlap", () => {
  assert.equal(scoreFit({ requiredCapabilities: ["web", "search"], agentCapabilities: ["web"] }), 0.5);
  assert.equal(scoreFit({ requiredCapabilities: ["web"], agentCapabilities: ["web", "nlp"] }), 1);
  assert.equal(scoreFit({ requiredCapabilities: ["x"], agentCapabilities: ["y"] }), 0);
});
test("routeTask ranks by score, ties break deterministically", () => {
  const ranked = routeTask({ requiredCapabilities: ["web", "search"], agents });
  assert.deepEqual(ranked.map(r => r.agentId), ["ada", "bob", "carol"]);
  assert.equal(ranked[0].score, 1);
  assert.equal(ranked[1].score, 0.5);
  assert.equal(ranked[2].score, 0);
  assert.ok(Object.isFrozen(ranked));
});
test("suggestAgent returns best fit or null", () => {
  const best = suggestAgent({ requiredCapabilities: ["web"], agents });
  assert.equal(best.agentId, "ada"); // tie ada/bob at 1.0, ada wins alphabetically
  assert.equal(suggestAgent({ requiredCapabilities: ["quantum"], agents }), null);
});
test("malformed inputs are refused", () => {
  throwsCode(() => routeTask({ requiredCapabilities: [], agents }), "invalid_router");
  throwsCode(() => routeTask({ requiredCapabilities: ["x"], agents: [] }), "invalid_router");
});
