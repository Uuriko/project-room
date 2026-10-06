import test from "node:test";
import assert from "node:assert/strict";
import { policyKey, policyCommand } from "../src/room-instructions.js";
import { EVENT_TYPES as T, ROOM_POLICY_FIELDS } from "../src/events.js";

test("policyKey maps the stored booleans to the four select states", () => {
  assert.equal(policyKey({ requireIndependentReview: false, requireOwnerDecision: false }), "none");
  assert.equal(policyKey({ requireIndependentReview: true, requireOwnerDecision: false }), "review");
  assert.equal(policyKey({ requireIndependentReview: false, requireOwnerDecision: true }), "decision");
  assert.equal(policyKey({ requireIndependentReview: true, requireOwnerDecision: true }), "both");
});

test("policyCommand emits a room.policy_set command with the matching field data", () => {
  const expected = {
    none: { requireIndependentReview: false, requireOwnerDecision: false },
    review: { requireIndependentReview: true, requireOwnerDecision: false },
    decision: { requireIndependentReview: false, requireOwnerDecision: true },
    both: { requireIndependentReview: true, requireOwnerDecision: true },
  };
  for (const [key, data] of Object.entries(expected)) {
    const command = policyCommand(key);
    assert.equal(command.type, T.ROOM_POLICY_SET);
    assert.deepEqual(command.data, data);
    // The field order in the command must track ROOM_POLICY_FIELDS, or the
    // booleans land under the wrong server fields.
    assert.deepEqual(Object.keys(command.data), [...ROOM_POLICY_FIELDS]);
  }
});

test("policyCommand mints a fresh command id on every call", () => {
  const first = policyCommand("review");
  const second = policyCommand("review");
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(first.id, second.id);
});

test("policyCommand rejects an unknown policy key", () => {
  assert.throws(() => policyCommand("sometimes"), /Choose a review policy/);
});

test("policy key round-trips through the command it generates", () => {
  // The owner selects a key, Apply sends the command, and the stored policy
  // maps back to the same key the select showed.
  for (const key of ["none", "review", "decision", "both"]) {
    assert.equal(policyKey(policyCommand(key).data), key);
  }
});
