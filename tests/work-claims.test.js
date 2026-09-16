// B006/B007: work claim + update. Pure state-machine tests; no store.
import test from "node:test";
import assert from "node:assert/strict";
import { claimWork, updateWork, reassignWork, workOwnedBy, unclaimedWork, ClaimError, STATES } from "../server/work-claims.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ClaimError && error.code === code);

test("claim → start → finish is the happy path", () => {
  const claimed = claimWork({ id: "a012" }, "quill");
  assert.equal(claimed.state, "claimed");
  assert.equal(claimed.owner, "quill");
  const started = updateWork(claimed, "quill", { state: "in_progress" });
  assert.equal(started.state, "in_progress");
  const done = updateWork(started, "quill", { state: "done", note: "shipped" });
  assert.equal(done.state, "done");
  assert.equal(done.history.length, 3);
  assert.ok(Object.isFrozen(done) && Object.isFrozen(done.history));
});
test("double-claim and foreign updates are refused", () => {
  const claimed = claimWork({ id: "a012" }, "quill");
  throwsCode(() => claimWork(claimed, "grok"), "invalid_claim_input");
  throwsCode(() => updateWork(claimed, "grok", { state: "in_progress" }), "invalid_claim_input");
  throwsCode(() => reassignWork(claimed, "grok", "instinct"), "invalid_claim_input");
  const done = updateWork(updateWork(claimed, "quill", { state: "in_progress" }), "quill", { state: "done" });
  throwsCode(() => updateWork(done, "quill", { note: "late" }), "invalid_claim_input");
});
test("illegal transitions are refused; release and reassign work", () => {
  const claimed = claimWork({ id: "b" }, "quill");
  throwsCode(() => updateWork(claimed, "quill", { state: "done" }), "invalid_claim_input");
  const released = updateWork(claimed, "quill", { state: "unclaimed" });
  assert.equal(released.owner, null);
  const reclaimed = claimWork(released, "grok");
  const reassigned = reassignWork(reclaimed, "grok", "instinct");
  assert.equal(reassigned.owner, "instinct");
  assert.equal(reassigned.state, "claimed");
});
test("query helpers filter a list", () => {
  const items = [
    claimWork({ id: "w1" }, "quill"),
    claimWork({ id: "w2" }, "grok"),
    { id: "w3" },
  ];
  assert.deepEqual(workOwnedBy(items, "quill").map(w => w.id), ["w1"]);
  assert.deepEqual(unclaimedWork(items).map(w => w.id), ["w3"]);
  throwsCode(() => claimWork({ id: "x" }, ""), "invalid_claim_input");
  assert.ok(STATES.includes("blocked"));
});
