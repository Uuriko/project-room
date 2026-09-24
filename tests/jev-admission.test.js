// Jev-harness admission gate: pure scorer tests (docs/JEV-GATES.md).
//
// Fixtures: fresh vs established identities, sybil-like names, duplicate
// joins, signed-card paths. Also asserts shadow semantics: the decision is
// a WOULD-BE (enforced:false) and the output is frozen/deterministic.
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateAdmission,
  jevAdmissionPaths,
  jevAdmissionReviewThreshold,
  jevAdmissionRejectThreshold,
  jevAdmissionWeights,
  jevVelocityWindowMs,
  JevError,
} from "../server/jev-admission.mjs";

const base = (overrides = {}) => ({
  displayName: "Nova",
  path: "join:first-room",
  at: 1_700_000_000_000,
  ...overrides,
});

test("established identity with a distinct name admits with a low score", () => {
  const decision = evaluateAdmission(base({
    identityId: "ai_established",
    identityAgeMs: 30 * 24 * 60 * 60 * 1000,
    existingDisplayNames: ["Quill", "Grok Bot"],
  }));
  assert.equal(decision.decision, "admit");
  assert.ok(decision.score < jevAdmissionReviewThreshold, `score ${decision.score}`);
  assert.equal(decision.enforced, false);
  assert.equal(decision.gate, "admission");
  assert.equal(decision.policyVersion, "v1");
});

test("fresh identity scores higher than an established one, all else equal", () => {
  const fresh = evaluateAdmission(base({ identityAgeMs: 5_000 }));
  const old = evaluateAdmission(base({ identityAgeMs: 10 * 24 * 60 * 60 * 1000 }));
  assert.ok(fresh.score > old.score, `fresh ${fresh.score} vs old ${old.score}`);
});

test("sybil-like name close to an existing member pushes toward review", () => {
  const decision = evaluateAdmission(base({
    identityAgeMs: 10_000,
    displayName: "Quil",
    existingDisplayNames: ["Quill"],
  }));
  const sybil = decision.signals.find(s => s.key === "sybilName");
  assert.ok(sybil.value > 0.7, `similarity component ${sybil.value}: ${sybil.detail}`);
});

test("machine-pattern names (digit tail, repetition, low entropy) score high on sybilName", () => {
  for (const name of ["bot12938475", "xxxxaaaa0000", "agent000001"]) {
    const decision = evaluateAdmission(base({ displayName: name }));
    const sybil = decision.signals.find(s => s.key === "sybilName");
    assert.ok(sybil.value >= 0.75, `${name}: ${sybil.value} (${sybil.detail})`);
  }
});

test("duplicate joins raise joinVelocity toward the ceiling", () => {
  const calm = evaluateAdmission(base({ recentJoins: { byIdentity: 0, byIp: 1 } }));
  const storm = evaluateAdmission(base({ recentJoins: { byIdentity: 4, byIp: 9 } }));
  const velocity = storm.signals.find(s => s.key === "joinVelocity");
  assert.equal(velocity.value, 1);
  assert.ok(storm.score > calm.score);
});

test("combined attack profile reaches would-be reject", () => {
  const decision = evaluateAdmission(base({
    identityAgeMs: 3_000,
    displayName: "Quil",
    existingDisplayNames: ["Quill"],
    recentJoins: { byIdentity: 3, byIp: 6 },
  }));
  assert.ok(decision.score >= jevAdmissionRejectThreshold, `score ${decision.score}`);
  assert.equal(decision.decision, "reject");
  assert.equal(decision.enforced, false); // shadow: never enforced
});

test("signed-card component: valid card lowers risk, invalid card maxes it", () => {
  const path = "guest-invite:redeem";
  const valid = evaluateAdmission(base({ path, card: { present: true, valid: true } }));
  const invalid = evaluateAdmission(base({ path, card: { present: true, valid: false } }));
  const missing = evaluateAdmission(base({ path, card: { present: false, valid: false } }));
  const cardOf = d => d.signals.find(s => s.key === "card");
  assert.equal(cardOf(valid).value, 0);
  assert.equal(cardOf(invalid).value, 1);
  assert.equal(cardOf(missing).value, 0.6);
  assert.ok(invalid.score > missing.score && missing.score > valid.score);
});

test("card component is inactive on card-less paths", () => {
  const decision = evaluateAdmission(base({ path: "join:first-room", card: null }));
  assert.ok(!decision.signals.some(s => s.key === "card"));
});

test("decision mapping honors the documented thresholds", () => {
  assert.equal(jevAdmissionReviewThreshold, 0.45);
  assert.equal(jevAdmissionRejectThreshold, 0.75);
  assert.ok(jevAdmissionPaths.includes("access-request:approve"));
  assert.ok(jevAdmissionPaths.includes("guest-agent-link:join"));
});

test("weights sum to a stable legend", () => {
  const sum = Object.values(jevAdmissionWeights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(jevVelocityWindowMs > 0);
});

test("output is frozen and deterministic", () => {
  const input = base({ identityId: "ai_x", identityAgeMs: 60_000, recentJoins: { byIdentity: 1, byIp: 2 } });
  const a = evaluateAdmission(input), b = evaluateAdmission(input);
  assert.deepEqual(a, b);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.signals));
  assert.throws(() => { a.score = 0; }, TypeError);
});

test("invalid inputs fail with coded errors", () => {
  assert.throws(() => evaluateAdmission(base({ path: "nope" })), err => err instanceof JevError && err.code === "invalid_admission_input");
  assert.throws(() => evaluateAdmission(base({ displayName: "" })), JevError);
  assert.throws(() => evaluateAdmission(base({ recentJoins: { byIdentity: -1 } })), JevError);
  assert.throws(() => evaluateAdmission(base({ card: { present: "yes" } })), JevError);
});
