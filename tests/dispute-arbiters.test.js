// Dispute-resolution slice 5: Tier-1 designated verifier path tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createArbiters } from "../server/dispute-arbiters.mjs";
import { DisputeError } from "../server/bounty-disputes.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof DisputeError && error.code === code);

const LANES = [
  { lane: "quill", trust_level: "elevated", runtime: "rt-quill-1", credentialChain: "cred-john-a", delegatedChain: "john>quill" },
  { lane: "instinct", trust_level: "elevated", runtime: "rt-instinct-1", credentialChain: "cred-john-b", delegatedChain: "john>instinct" },
  { lane: "grokbot", trust_level: "elevated", runtime: "rt-quill-1", credentialChain: "cred-john-c", delegatedChain: "john>grokbot" },
];
const EXECUTOR = { lane: "quill", runtime: "rt-quill-1", credentialChain: "cred-john-a", delegatedChain: "john>quill" };

test("independent verifier seats cleanly", () => {
  const arbiters = createArbiters();
  const seated = arbiters.resolveTier1({ verifierId: "instinct", executor: EXECUTOR, lanes: LANES });
  assert.equal(seated.tier, 1);
  assert.equal(seated.decider.lane, "instinct");
  assert.ok(Object.isFrozen(seated.decider));
});

test("executor cannot verify its own claim", () => {
  const arbiters = createArbiters();
  const r = arbiters.resolveTier1({ verifierId: "quill", executor: EXECUTOR, lanes: LANES });
  assert.equal(r.unavailable, "no-arbitrator");
  assert.match(r.reason, /not independent/);
});

test("shared runtime / credential / delegated chain is ineligible", () => {
  const arbiters = createArbiters();
  // grokbot shares rt-quill-1 with the executor
  const r = arbiters.resolveTier1({ verifierId: "grokbot", executor: EXECUTOR, lanes: LANES });
  assert.equal(r.unavailable, "no-arbitrator");
  assert.match(r.reason, /shared runtime/);
  const sameCred = { lane: "codex", runtime: "rt-x", credentialChain: "cred-john-a", delegatedChain: "john>codex" };
  assert.equal(arbiters.isIndependent(sameCred, EXECUTOR).reason, "shared credentialChain");
  const overlap = { lane: "codex", runtime: "rt-x", credentialChain: "cred-z", delegatedChain: "john>quill>codex" };
  assert.equal(arbiters.isIndependent(overlap, EXECUTOR).reason, "delegated chain overlap");
});

test("unknown verifier falls through to unavailable, not a silent drop", () => {
  const arbiters = createArbiters();
  const r = arbiters.resolveTier1({ verifierId: "nobody", executor: EXECUTOR, lanes: LANES });
  assert.equal(r.unavailable, "no-arbitrator");
  assert.match(r.reason, /not an enrolled lane/);
  throwsCode(() => arbiters.resolveTier1({ executor: EXECUTOR, lanes: LANES }), "invalid_arbiter");
});

test("tier-1 decision records an outcome-independent pay hook", () => {
  const arbiters = createArbiters();
  const { decider } = arbiters.resolveTier1({ verifierId: "instinct", executor: EXECUTOR, lanes: LANES });
  for (const outcome of ["upheld", "rejected"]) {
    const { decision, payHook } = arbiters.recordTier1Decision({
      decider, outcome, reasonCodes: ["receipt-incomplete"], kind: "economic" });
    assert.equal(decision.outcome, outcome);
    assert.equal(payHook.arbiter, "instinct");
    assert.equal(payHook.basis, "outcome-independent");
    assert.equal(payHook.source, "dispute-bond");
  }
  const coord = arbiters.recordTier1Decision({ decider, outcome: "split",
    reasonCodes: ["criterion-unmet"], kind: "coordination" });
  assert.equal(coord.payHook.source, "verify-weight");
  assert.ok(Object.isFrozen(coord.decision) && Object.isFrozen(coord.payHook));
});

test("malformed tier-1 decisions are refused", () => {
  const arbiters = createArbiters();
  const { decider } = arbiters.resolveTier1({ verifierId: "instinct", executor: EXECUTOR, lanes: LANES });
  throwsCode(() => arbiters.recordTier1Decision({ decider: { tier: 2, lane: "x" },
    outcome: "upheld", reasonCodes: ["frivolous"] }), "invalid_arbiter");
  throwsCode(() => arbiters.recordTier1Decision({ decider, outcome: "maybe",
    reasonCodes: ["frivolous"] }), "invalid_arbiter");
  throwsCode(() => arbiters.recordTier1Decision({ decider, outcome: "upheld",
    reasonCodes: ["made-up"] }), "invalid_arbiter");
  throwsCode(() => arbiters.recordTier1Decision({ decider, outcome: "upheld",
    reasonCodes: ["frivolous"], kind: "barter" }), "invalid_arbiter");
});
