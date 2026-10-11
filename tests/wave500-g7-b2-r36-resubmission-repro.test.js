// WAVE-500 guild-7 worker B2 (retry) — FAIL-FIRST repro for the R36-1
// resubmission hazard Dot flagged: resubmit() persists the pending transition
// (move()) BEFORE validating the replacement draft (draftOf()), so an
// invalid resubmission throws approval_invalid while leaving the queue
// mutated — status leaked to pending, a pending history entry appended, the
// agent then stranded (a valid resubmit is refused as an illegal transition).
//
// Contract under test: an invalid resubmission is atomic — either the
// proposal moves to pending with the new draft, or nothing changes.
import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalError, createApprovalQueue } from "../server/inbox-approval.mjs";

const agent = { kind: "agent", id: "claude", label: "Claude" };
const human = { kind: "human", id: "john", label: "John" };
const draft = { subject: "Re: kickoff", body: "Sounds good — Tuesday?" };
const fixedClock = (times = [1000]) => { let i = 0; return () => times[Math.min(i++, times.length - 1)]; };
const ids = (() => { let n = 0; return () => `repro-${++n}`; })();
const propose = queue => queue.propose("thread:1", { draft, byAgent: agent, channel: "email" });
const toChangesRequested = queue => {
  const proposal = propose(queue);
  queue.requestEdits(proposal.proposalId, { by: human, edits: "Soften the opening." });
  return queue.get(proposal.proposalId);
};
const expectInvalid = fn => assert.throws(fn,
  error => error instanceof ApprovalError && error.code === "approval_invalid");

const INVALID_DRAFTS = [
  ["null draft", null],
  ["non-object draft", "not a draft"],
  ["draft carrying an unknown key", { body: "ok", attachment: "x" }],
  ["draft body over the 8000-char limit", { body: "x".repeat(8001) }],
];

for (const [label, badDraft] of INVALID_DRAFTS) {
  test(`R36-1: an invalid resubmission (${label}) throws and leaves the proposal untouched`, () => {
    const queue = createApprovalQueue({ clock: fixedClock([1000, 2000, 3000]), id: ids });
    const before = toChangesRequested(queue);
    expectInvalid(() => queue.resubmit(before.proposalId, { draft: badDraft, byAgent: agent }));
    const after = queue.get(before.proposalId);
    assert.equal(after.status, "changes_requested",
      `resubmit rejected the ${label} but the status leaked to "${after.status}"`);
    assert.deepEqual(after.draft, draft, "old draft must survive a rejected resubmission");
    assert.equal(after.version, 1, "version must not bump on a rejected resubmission");
    assert.equal(after.history.length, before.history.length,
      "no history entry may be appended by a rejected resubmission");
    assert.equal(after.requestedEdits.edits, "Soften the opening.",
      "the edit request must stay in place for the agent to answer");
  });
}

test("R36-1: after an invalid resubmission the agent can still resubmit a valid draft", () => {
  const queue = createApprovalQueue({ clock: fixedClock([1000, 2000, 3000, 4000]), id: ids });
  const before = toChangesRequested(queue);
  expectInvalid(() => queue.resubmit(before.proposalId, { draft: null, byAgent: agent }));
  const resubmitted = queue.resubmit(before.proposalId,
    { draft: { body: "Softer opening — Tuesday?" }, byAgent: agent });
  assert.equal(resubmitted.status, "pending");
  assert.equal(resubmitted.version, 2);
  assert.equal(resubmitted.draft.body, "Softer opening — Tuesday?");
  assert.equal(resubmitted.requestedEdits, null);
  assert.equal(queue.audit(before.proposalId).map(h => h.status).join(","),
    "pending,changes_requested,pending");
});
