// B014: structured work handoff. Pure contract tests; no store, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { workHandoff, startHandoff, handoffStatuses, HandoffError } from "../server/work-handoff.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof HandoffError && error.code === code);
const base = () => ({ id: "handoff-1", from: "quill", to: "grok", at: "2026-09-16T07:00:00Z",
  objective: "Merge the WhatsApp adapter", status: "in_progress", summary: "Adapter built and tested; PR open.",
  next: ["wait for CI", "merge on green"], blockers: [],
  files: [{ path: "server/channel-adapters/whatsapp.mjs", kind: "code", sha: "a".repeat(40) }],
  validation: "1636 tests, 1635 pass, 0 fail; check.mjs clean" });

test("a complete handoff validates and freezes", () => {
  const handoff = workHandoff(base());
  assert.equal(handoff.status, "in_progress");
  assert.equal(handoff.files[0].kind, "code");
  assert.ok(Object.isFrozen(handoff) && Object.isFrozen(handoff.next) && Object.isFrozen(handoff.files));
  assert.throws(() => { handoff.status = "done"; }, TypeError);
});
test("a blocked handoff must name its blockers", () => {
  throwsCode(() => workHandoff({ ...base(), status: "blocked", blockers: [] }), "invalid_work_handoff");
  const handoff = workHandoff({ ...base(), status: "blocked", blockers: ["waiting on John's OAuth tap"] });
  assert.equal(handoff.status, "blocked");
});
test("a review-ready handoff must say how it was validated", () => {
  throwsCode(() => workHandoff({ ...base(), status: "ready_for_review", validation: null }), "invalid_work_handoff");
  const handoff = workHandoff({ ...base(), status: "ready_for_review" });
  assert.equal(handoff.status, "ready_for_review");
});
test("all five statuses are accepted", () => {
  assert.deepEqual(handoffStatuses, ["not_started", "in_progress", "blocked", "ready_for_review", "done"]);
  for (const status of handoffStatuses) {
    const record = { ...base(), status, blockers: status === "blocked" ? ["x"] : [], validation: status === "ready_for_review" ? "checked" : "v" };
    assert.equal(workHandoff(record).status, status);
  }
});
test("startHandoff builds the skeleton the handing agent fills in", () => {
  const skeleton = startHandoff({ id: "h-2", from: "instinct", to: "quill", objective: "Review the gate contract" });
  assert.equal(skeleton.from, "instinct");
  assert.equal(skeleton.status, "in_progress");
  assert.ok(/^\d{4}-\d\d-\d\dT/.test(skeleton.at));
});
test("malformed handoffs are refused", () => {
  throwsCode(() => workHandoff(null), "invalid_work_handoff");
  throwsCode(() => workHandoff({ ...base(), status: "shipped" }), "invalid_work_handoff");
  throwsCode(() => workHandoff({ ...base(), extra: true }), "invalid_work_handoff");
  throwsCode(() => workHandoff({ ...base(), at: "yesterday" }), "invalid_work_handoff");
  throwsCode(() => workHandoff({ ...base(), files: [{ path: "x", kind: "exe" }] }), "invalid_work_handoff");
  throwsCode(() => workHandoff({ ...base(), files: [{ path: "x", kind: "code", sha: "zzz" }] }), "invalid_work_handoff");
  throwsCode(() => workHandoff({ ...base(), objective: "" }), "invalid_work_handoff");
  throwsCode(() => workHandoff({ ...base(), next: ["x".repeat(2049)] }), "invalid_work_handoff");
});
