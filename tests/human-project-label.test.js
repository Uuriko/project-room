// 8333: the Project dialog used to map every state other than
// completed/working/blocked to "Planned", so proposed and accepted items
// lied about where they stood.
import test from "node:test";
import assert from "node:assert/strict";
import { humanProjectLabel } from "../src/human-experience.js";

test("project dialog labels distinguish every real work state", () => {
  assert.equal(humanProjectLabel({ state: "proposed" }), "Proposed");
  assert.equal(humanProjectLabel({ state: "accepted" }), "Ready to start");
  assert.equal(humanProjectLabel({ state: "working" }), "In progress · reported");
  assert.equal(humanProjectLabel({ state: "blocked" }), "Needs input");
  assert.equal(humanProjectLabel({ state: "completed" }), "Needs review");
  const done = { state: "completed", receipt: { eventId: "01J9ZQ8W6K3M2N4P5R7T9V0X1Z", evidenceVersion: 2 } };
  assert.equal(humanProjectLabel(done), "Done");
  assert.equal(humanProjectLabel({ state: "superseded" }), "Planned", "unknown states still fall back");
  assert.equal(humanProjectLabel({}), "Planned");
});
