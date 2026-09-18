// LANE C (quill/inbox-agent-collab): human-in-the-loop approval queue for
// agent-drafted outbound — propose/approve/edit/reject with a full audit
// trail.
import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalError, approvalStatuses, createApprovalQueue } from "../server/inbox-approval.mjs";

const agent = { kind: "agent", id: "claude", label: "Claude" };
const human = { kind: "human", id: "john", label: "John" };
const draft = { subject: "Re: kickoff", body: "Sounds good — Tuesday?" };
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.ok(error instanceof ApprovalError); assert.equal(error.code, code); return; }
  assert.fail(`expected ${code} but nothing threw`);
};
const fixedClock = (times = [1000]) => { let i = 0; return () => times[Math.min(i++, times.length - 1)]; };
const ids = (() => { let n = 0; return () => `proposal-${++n}`; })();
const propose = (queue, overrides = {}) => queue.propose("thread:1",
  { draft, byAgent: agent, channel: "email", ...overrides });

test("propose creates a pending, versioned proposal; nothing sends", () => {
  const queue = createApprovalQueue({ clock: fixedClock([1000]), id: ids });
  const proposal = propose(queue);
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.version, 1);
  assert.deepEqual(proposal.draft, draft);
  assert.equal(proposal.channel, "email");
  assert.deepEqual(proposal.byAgent, agent);
  assert.equal(proposal.history.length, 1);
  assert.equal(proposal.history[0].status, "pending");
  assert.ok(Object.isFrozen(proposal) && Object.isFrozen(proposal.draft) && Object.isFrozen(proposal.history));
});
test("a human approves; the approval lands on the audit trail", () => {
  const queue = createApprovalQueue({ clock: fixedClock([1000, 2000]), id: ids });
  const proposal = propose(queue);
  const approved = queue.approve(proposal.proposalId, { by: human, note: "Ship it." });
  assert.equal(approved.status, "approved");
  assert.equal(approved.history.at(-1).status, "approved");
  assert.equal(approved.history.at(-1).note, "Ship it.");
  assert.deepEqual(approved.history.at(-1).by, human);
});
test("requestEdits → resubmit returns to pending with a bumped version", () => {
  const queue = createApprovalQueue({ clock: fixedClock([1000, 2000, 3000, 4000]), id: ids });
  const proposal = propose(queue);
  const edits = queue.requestEdits(proposal.proposalId, { by: human, edits: "Soften the opening line." });
  assert.equal(edits.status, "changes_requested");
  assert.equal(edits.requestedEdits.edits, "Soften the opening line.");
  const resubmitted = queue.resubmit(proposal.proposalId, { draft: { body: "Revised opening — Tuesday?" }, byAgent: agent });
  assert.equal(resubmitted.status, "pending");
  assert.equal(resubmitted.version, 2);
  assert.equal(resubmitted.draft.body, "Revised opening — Tuesday?");
  assert.equal(resubmitted.draft.subject, null);
  assert.equal(resubmitted.requestedEdits, null);
  const approved = queue.approve(proposal.proposalId, { by: human });
  assert.equal(approved.status, "approved");
  assert.equal(queue.audit(proposal.proposalId).map(h => h.status).join(","),
    "pending,changes_requested,pending,approved");
});
test("reject needs a reason and ends the proposal", () => {
  const queue = createApprovalQueue({ clock: fixedClock([1000, 2000]), id: ids });
  const proposal = propose(queue);
  expectCode(() => queue.reject(proposal.proposalId, { by: human }), "approval_invalid");
  const rejected = queue.reject(proposal.proposalId, { by: human, reason: "Wrong thread." });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.history.at(-1).reason, "Wrong thread.");
});
test("illegal transitions are refused, never silently rewritten", () => {
  const queue = createApprovalQueue({ clock: fixedClock([1000, 2000, 3000, 4000, 5000]), id: ids });
  const proposal = propose(queue);
  queue.approve(proposal.proposalId, { by: human });
  expectCode(() => queue.approve(proposal.proposalId, { by: human }), "approval_transition");
  expectCode(() => queue.reject(proposal.proposalId, { by: human, reason: "x" }), "approval_transition");
  expectCode(() => queue.resubmit(proposal.proposalId, { draft, byAgent: agent }), "approval_transition");
  const second = propose(queue);
  queue.requestEdits(second.proposalId, { by: human, edits: "fix" });
  expectCode(() => queue.approve("proposal-missing", { by: human }), "approval_not_found");
  expectCode(() => queue.requestEdits(second.proposalId, { by: human, edits: "again" }), "approval_transition");
});
test("agents cannot clear their own drafts", () => {
  const queue = createApprovalQueue({ id: ids });
  const proposal = propose(queue);
  expectCode(() => queue.approve(proposal.proposalId, { by: agent }), "approval_not_human");
  expectCode(() => queue.requestEdits(proposal.proposalId, { by: agent, edits: "x" }), "approval_not_human");
  expectCode(() => queue.reject(proposal.proposalId, { by: agent, reason: "x" }), "approval_not_human");
  expectCode(() => queue.propose("thread:1", { draft, byAgent: human, channel: "email" }), "approval_invalid");
});
test("list filters by status/thread; pendingCount counts the open queue", () => {
  const queue = createApprovalQueue({ clock: fixedClock([1000, 2000, 3000]), id: ids });
  const first = propose(queue);
  propose(queue, {});
  queue.approve(first.proposalId, { by: human });
  assert.equal(queue.list({ status: "pending" }).length, 1);
  assert.equal(queue.list({ threadId: "thread:1" }).length, 2);
  assert.equal(queue.pendingCount(), 1);
  expectCode(() => queue.list({ status: "vapor" }), "approval_invalid");
});
test("exported statuses stay frozen", () => {
  assert.deepEqual([...approvalStatuses], ["pending", "changes_requested", "approved", "rejected"]);
  assert.ok(Object.isFrozen(approvalStatuses));
});
