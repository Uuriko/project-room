// H007: key rotation. Pure policy tests; no key material.
import test from "node:test";
import assert from "node:assert/strict";
import { rotationPlan, KeyRotationError, DEFAULTS } from "../server/key-rotation.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof KeyRotationError && error.code === code);
const NOW = "2026-09-16T12:00:00Z";

test("rotationPlan decides keep / rotate / revoke by age", () => {
  const { plans, totals } = rotationPlan([
    { name: "fresh", version: 1, createdAt: "2026-09-01T00:00:00Z" },                    // 15d → keep
    { name: "old", version: 3, createdAt: "2026-06-16T00:00:00Z" },                      // 92d → rotate (past 90d, within grace)
    { name: "ancient", version: 1, createdAt: "2025-01-01T00:00:00Z" },                   // >97d → revoke
    { name: "leaked", version: 2, createdAt: "2026-09-01T00:00:00Z", compromised: true }, // compromised → revoke
  ], { now: NOW });
  assert.deepEqual(plans.map(p => [p.name, p.action]),
    [["fresh", "keep"], ["old", "rotate"], ["ancient", "revoke"], ["leaked", "revoke"]]);
  assert.deepEqual(totals, { keep: 1, rotate: 1, revoke: 2 });
  assert.equal(plans[1].nextVersion, 4);
  assert.ok(Object.isFrozen(plans) && Object.isFrozen(totals));
  assert.equal(DEFAULTS.maxAgeDays, 90);
});
test("custom windows are honored", () => {
  const { plans } = rotationPlan(
    [{ name: "k", version: 1, createdAt: "2026-09-01T00:00:00Z" }],
    { now: NOW, maxAgeDays: 10, graceDays: 0 });
  assert.equal(plans[0].action, "revoke"); // 15d > 10d + 0d grace
});
test("malformed inputs are refused", () => {
  throwsCode(() => rotationPlan("nope"), "invalid_key_rotation");
  throwsCode(() => rotationPlan([{ name: "k", version: 0, createdAt: NOW }]), "invalid_key_rotation");
  throwsCode(() => rotationPlan([], { maxAgeDays: -1 }), "invalid_key_rotation");
});
