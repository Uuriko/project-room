// B017: owner pause/resume. Pure lifecycle tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createLifecycle, LifecycleError, STATES } from "../server/agent-lifecycle.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof LifecycleError && error.code === code);

test("pause/resume/canAct lifecycle", () => {
  const lifecycle = createLifecycle();
  assert.deepEqual(STATES, ["active", "paused"]);
  assert.equal(lifecycle.canAct("ada"), true); // default active
  const paused = lifecycle.pause("ada", { by: "owner" });
  assert.equal(paused.state, "paused");
  assert.ok(Object.isFrozen(paused));
  assert.equal(lifecycle.canAct("ada"), false);
  assert.deepEqual(lifecycle.pausedAgents(), ["ada"]);
  const resumed = lifecycle.resume("ada", { by: "owner" });
  assert.equal(resumed.state, "active");
  assert.equal(lifecycle.canAct("ada"), true);
  assert.deepEqual(lifecycle.pausedAgents(), []);
});
test("invalid transitions are refused", () => {
  const lifecycle = createLifecycle();
  throwsCode(() => lifecycle.resume("bob", { by: "owner" }), "invalid_lifecycle"); // not paused
  lifecycle.pause("bob", { by: "owner" });
  throwsCode(() => lifecycle.pause("bob", { by: "owner" }), "invalid_lifecycle"); // already paused
});
test("malformed inputs are refused", () => {
  const lifecycle = createLifecycle();
  throwsCode(() => lifecycle.pause("", { by: "owner" }), "invalid_lifecycle");
  throwsCode(() => lifecycle.pause("a", { by: "" }), "invalid_lifecycle");
});
