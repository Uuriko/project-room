// WAVE-500 guild 6, worker 16: version fencing on approval verdicts (R36-1
// resubmit slice; Tab owns the main fix, this file is tests only).
//
// The bug: approve() takes no version, so a human who reviewed draft v1 can
// silently approve the agent's resubmitted draft v2. Dot's flagged contract:
// approve(proposalId, { by, note?, version? }) must fence on the version — a
// stale or future version is a conflict (409), not a silent write.
// Route-side precedent: inbox-collab-routes maps conflict-class approval
// codes to HTTP 409 (approval_transition, assign_conflict, collision_lock_*).
// The proposed module-level code is `approval_conflict` with
// detail { expected, actual }.
//
// Related finding these tests pin down first: resubmit() returns a version-2
// record but never persists it — get()/list() still show version 1 with the
// old draft and stale requestedEdits (the mirror image of the M-4 bug, which
// fixed requestEdits the same way). A fence can only compare against the
// stored record, so persistence of the bumped version is a prerequisite.
import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalError, createApprovalQueue } from "../server/inbox-approval.mjs";

const agent = { kind: "agent", id: "claude", label: "Claude" };
const human = { kind: "human", id: "john", label: "John" };
const v1 = { subject: "Re: kickoff", body: "Sounds good - Tuesday?" };
const v2 = { subject: "Re: kickoff", body: "Revised opening - Tuesday?" };
const expectConflict = fn => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof ApprovalError, `expected ApprovalError, got ${error}`);
    assert.equal(error.code, "approval_conflict", `expected approval_conflict, got ${error.code}`);
    return error;
  }
  assert.fail("expected approval_conflict but nothing threw");
};
const fixedClock = (times = [1000]) => { let i = 0; return () => times[Math.min(i++, times.length - 1)]; };
const makeIds = () => { let n = 0; return () => `vfence-${++n}`; };
// propose v1 -> requestEdits -> resubmit v2; returns the proposal id. Each
// test reads the stored record via queue.get() so assertions track what the
// fence would compare against.
const setupResubmitted = queue => {
  const proposal = queue.propose("thread:1", { draft: v1, byAgent: agent, channel: "email" });
  queue.requestEdits(proposal.proposalId, { by: human, edits: "Soften the opening line." });
  queue.resubmit(proposal.proposalId, { draft: v2, byAgent: agent });
  return proposal.proposalId;
};

test("resubmit persists the bumped version, new draft, and cleared edits", () => {
  const queue = createApprovalQueue({ clock: fixedClock([1000, 2000, 3000, 4000]), id: makeIds() });
  const id = setupResubmitted(queue);
  const stored = queue.get(id);
  assert.equal(stored.status, "pending");
  assert.equal(stored.version, 2, "stored version must advance on resubmit");
  assert.equal(stored.draft.body, v2.body, "stored draft must be the resubmitted draft");
  assert.equal(stored.requestedEdits, null, "resubmit answers the edits; none stay pending");
});

test("stale-version approve conflicts instead of silently approving the new draft", () => {
  const queue = createApprovalQueue({ clock: fixedClock([1000, 2000, 3000, 4000, 5000]), id: makeIds() });
  const id = setupResubmitted(queue);
  const stale = queue.get(id).version - 1;
  // The human only ever saw the older draft; approving against it must not
  // land on the resubmitted draft.
  expectConflict(() => queue.approve(id, { by: human, version: stale }));
  const after = queue.get(id);
  assert.equal(after.status, "pending", "stale approve must not change the status");
  assert.equal(after.draft.body, v2.body, "stale approve must not swap the draft");
});

test("future-version approve conflicts too", () => {
  const queue = createApprovalQueue({ clock: fixedClock([1000, 2000]), id: makeIds() });
  const proposal = queue.propose("thread:1", { draft: v1, byAgent: agent, channel: "email" });
  const future = queue.get(proposal.proposalId).version + 100;
  expectConflict(() => queue.approve(proposal.proposalId, { by: human, version: future }));
  assert.equal(queue.get(proposal.proposalId).status, "pending");
});

test("the conflict names both versions", () => {
  const queue = createApprovalQueue({ clock: fixedClock([1000, 2000, 3000, 4000, 5000]), id: makeIds() });
  const id = setupResubmitted(queue);
  const actual = queue.get(id).version;
  const error = expectConflict(() => queue.approve(id, { by: human, version: actual - 1 }));
  assert.ok(error.detail, "conflict must carry detail");
  assert.equal(error.detail.expected, actual - 1);
  assert.equal(error.detail.actual, actual);
});

test("current-version approve succeeds", () => {
  const queue = createApprovalQueue({ clock: fixedClock([1000, 2000, 3000, 4000, 5000]), id: makeIds() });
  const id = setupResubmitted(queue);
  const current = queue.get(id).version;
  const approved = queue.approve(id, { by: human, version: current });
  assert.equal(approved.status, "approved");
  assert.equal(approved.version, current);
  // Draft-body freshness on the stored record is the persistence test's job;
  // this test guards only that fencing never rejects the current version.
});

test("two approves of the same version: exactly one wins", () => {
  const queue = createApprovalQueue({ clock: fixedClock([1000, 2000, 3000]), id: makeIds() });
  const proposal = queue.propose("thread:1", { draft: v1, byAgent: agent, channel: "email" });
  const version = queue.get(proposal.proposalId).version;
  const first = queue.approve(proposal.proposalId, { by: human, version });
  assert.equal(first.status, "approved");
  // The second approve of the same version loses with a conflict-class error:
  // approval_conflict once the fence lands, approval_transition today.
  try {
    queue.approve(proposal.proposalId, { by: human, version });
  } catch (error) {
    assert.ok(error instanceof ApprovalError);
    assert.ok(["approval_conflict", "approval_transition"].includes(error.code),
      `expected approval_conflict or approval_transition, got ${error.code}`);
    assert.equal(queue.get(proposal.proposalId).status, "approved");
    return;
  }
  assert.fail("second approve of the same version must not win");
});
