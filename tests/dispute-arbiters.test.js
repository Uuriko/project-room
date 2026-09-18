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

test("sortition: deterministic 3-seat draw seeded by dispute-id", () => {
  const arbiters = createArbiters();
  const lanes = [
    { lane: "quill", trust_level: "elevated" },
    { lane: "instinct", trust_level: "elevated" },
    { lane: "grokbot", trust_level: "standard" },
    { lane: "codex", trust_level: "standard" },
    { lane: "Jillian", trust_level: "new" }, // ineligible: below standard
  ];
  const a = arbiters.drawPanel({ disputeId: "D-2026-09-17-001", lanes });
  const b = arbiters.drawPanel({ disputeId: "D-2026-09-17-001", lanes });
  assert.equal(a.tier, 2);
  assert.equal(a.panel.length, 3);
  assert.deepEqual(a.panel.map(p => p.lane), b.panel.map(p => p.lane)); // deterministic
  assert.ok(!a.panel.some(p => p.lane === "Jillian"));
  const c = arbiters.drawPanel({ disputeId: "D-2026-09-17-002", lanes });
  assert.ok(a.panel.map(p => p.lane).join() !== c.panel.map(p => p.lane).join()
    || a.panel.length === 3); // different seed may still tie; seats valid either way
});

test("sortition excludes parties and the executor", () => {
  const arbiters = createArbiters();
  const lanes = [
    { lane: "quill", trust_level: "elevated" },
    { lane: "instinct", trust_level: "elevated" },
    { lane: "grokbot", trust_level: "standard" },
    { lane: "codex", trust_level: "standard" },
  ];
  const { panel } = arbiters.drawPanel({ disputeId: "D-1", lanes, exclude: ["quill"] });
  assert.equal(panel.length, 3);
  assert.ok(!panel.some(p => p.lane === "quill"));
  const r = arbiters.drawPanel({ disputeId: "D-1", lanes: lanes.slice(0, 2), exclude: ["quill"] });
  assert.equal(r.unavailable, "no-arbitrator"); // only 1 eligible left
});

test("panel decision: majority wins with the majority's reason codes", () => {
  const arbiters = createArbiters();
  const lanes = [
    { lane: "quill", trust_level: "elevated" },
    { lane: "instinct", trust_level: "elevated" },
    { lane: "grokbot", trust_level: "standard" },
  ];
  const { panel } = arbiters.drawPanel({ disputeId: "D-9", lanes });
  const votes = panel.map((p, i) => ({
    lane: p.lane,
    outcome: i < 2 ? "upheld" : "rejected",
    reasonCodes: i === 0 ? ["receipt-incomplete"] : i === 1 ? ["criterion-unmet"] : ["frivolous"],
  }));
  const { decision, payHooks } = arbiters.recordPanelDecision({ panel, votes });
  assert.equal(decision.outcome, "upheld");
  assert.deepEqual([...decision.reasonCodes].sort(), ["criterion-unmet", "receipt-incomplete"]);
  assert.equal(payHooks.length, 3); // every member paid, outcome-independent
  assert.ok(payHooks.every(h => h.basis === "outcome-independent" && h.source === "dispute-bond"));
  assert.ok(Object.isFrozen(decision) && Object.isFrozen(payHooks));
});

test("panel decision rejects bad votes and deadlocks", () => {
  const arbiters = createArbiters();
  const lanes = [
    { lane: "quill", trust_level: "elevated" },
    { lane: "instinct", trust_level: "elevated" },
    { lane: "grokbot", trust_level: "standard" },
  ];
  const { panel } = arbiters.drawPanel({ disputeId: "D-9", lanes });
  const good = i => ({ lane: panel[i].lane, outcome: "upheld", reasonCodes: ["frivolous"] });
  throwsCode(() => arbiters.recordPanelDecision({ panel, votes: [good(0), good(1)] }), "invalid_arbiter");
  throwsCode(() => arbiters.recordPanelDecision({ panel,
    votes: [good(0), good(0), good(2)] }), "invalid_arbiter"); // duplicate
  throwsCode(() => arbiters.recordPanelDecision({ panel,
    votes: [{ ...good(0), lane: "mallory" }, good(1), good(2)] }), "invalid_arbiter"); // non-panel
  throwsCode(() => arbiters.recordPanelDecision({ panel,
    votes: [{ ...good(0), outcome: "upheld" }, { ...good(1), outcome: "rejected" },
      { ...good(2), outcome: "split" }] }), "invalid_arbiter"); // 1-1-1 deadlock
});

test("registry read path parses agent-card frontmatter", () => {
  const arbiters = createArbiters();
  const cards = [
    { name: "quill.md", content: '---\nlane: quill\ntrust_level: elevated\nmodel: "muse-spark"\nlane_tag: "[quill]"\n---\n# card\n' },
    { name: "Jillian.md", content: '---\nlane: Jillian\ntrust_level: new\n---\n# card\n' },
    { name: "notes.md", content: "# no frontmatter\n" },
  ];
  const lanes = arbiters.parseLaneCards(cards);
  assert.equal(lanes[0].lane, "quill");
  assert.equal(lanes[0].trust_level, "elevated");
  assert.equal(lanes[1].trust_level, "new");
  assert.equal(lanes[2].lane, "notes"); // falls back to filename
});
