// B012: agent onboarding checklist. Pure checklist tests.
import test from "node:test";
import assert from "node:assert/strict";
import { standardSteps, createOnboarding, ChecklistError } from "../server/onboarding-checklist.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ChecklistError && error.code === code);

test("complete/status tracks progress and missing steps", () => {
  const onboarding = createOnboarding();
  assert.equal(standardSteps().length, 5);
  let status = onboarding.complete("ada", "identity");
  assert.equal(status.progress, "1/5");
  assert.equal(status.complete, false);
  assert.deepEqual(status.missing, ["connect", "capabilities", "scopes", "verify"]);
  assert.ok(Object.isFrozen(status) && Object.isFrozen(status.items));
  for (const step of ["connect", "capabilities", "scopes", "verify"]) {
    status = onboarding.complete("ada", step);
  }
  assert.equal(status.complete, true);
  assert.deepEqual(status.missing, []);
});
test("reset clears progress", () => {
  const onboarding = createOnboarding();
  onboarding.complete("bob", "identity");
  onboarding.reset("bob");
  assert.equal(onboarding.status("bob").progress, "0/5");
});
test("malformed inputs are refused", () => {
  const onboarding = createOnboarding();
  throwsCode(() => onboarding.complete("a", "nope"), "invalid_checklist");
  throwsCode(() => onboarding.complete("", "identity"), "invalid_checklist");
});
