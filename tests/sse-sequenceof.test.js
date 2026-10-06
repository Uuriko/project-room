// Regression test for the SSE contract's sequenceOf null-id handling.
// Synthetic id-less SSE events (e.g. `typing`) must not be misread as
// sequence 0 — Number(null) is 0, which corrupted the ordering and
// Last-Event-ID resume gates.

import test from "node:test";
import assert from "node:assert/strict";
import { sequenceOf } from "../scripts/qa3/lib/sequence.mjs";

test("id-less frame without a body sequence yields null, not 0", () => {
  // The synthetic typing event shape: no id:, JSON body without sequence.
  const typingFrame = { id: null, event: "typing", text: '{"typists":[]}', json: { typists: [] } };
  assert.equal(sequenceOf(typingFrame), null);
});

test("frames with numeric ids still yield their sequence", () => {
  assert.equal(sequenceOf({ id: "42", event: "room-event", text: "{}", json: {} }), 42);
  assert.equal(sequenceOf({ id: "0", event: "room-event", text: "{}", json: {} }), 0);
});

test("id-less frame with a body sequence yields the body sequence", () => {
  const frame = { id: null, event: "room-event", text: "{}", json: { sequence: 7 } };
  assert.equal(sequenceOf(frame), 7);
});
