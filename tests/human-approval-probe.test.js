// Probe for docs/HUMAN-APPROVAL-CONTRACT.md. Pins current behavior of the
// agent-draft approval queue; the last test pins a gap, not a guarantee.
import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalQueue } from "../server/inbox-approval.mjs";

const agent = { kind: "agent", id: "claude", label: "Claude" };
const john = { kind: "human", id: "john", label: "John" };
const dasha = { kind: "human", id: "dasha", label: "Dasha" };
const draft = body => ({ subject: "Re: kickoff", body });
const fresh = () => {
  const q = createApprovalQueue({ clock: () => 1000, id: (() => { let n = 0; return () => `p${++n}`; })() });
  return { q, p: q.propose("thread:1", { draft: draft("v1"), byAgent: agent, channel: "email" }) };
};

test("an agent identity cannot approve, including its own draft", () => {
  const { q, p } = fresh();
  assert.throws(() => q.approve(p.proposalId, { by: agent }), { code: "approval_not_human" });
});

test("a verdict is terminal and one-use", () => {
  const { q, p } = fresh();
  q.approve(p.proposalId, { by: john });
  assert.throws(() => q.approve(p.proposalId, { by: john }));
  assert.throws(() => q.reject(p.proposalId, { by: john, reason: "late" }));
});

test("gap: approve is not bound to the version the human saw", () => {
  const { q, p } = fresh();
  q.requestEdits(p.proposalId, { by: john, edits: "shorter" });
  q.resubmit(p.proposalId, { draft: draft("v2 never shown to dasha"), byAgent: agent });
  // Dasha last saw v1; approve takes no expected version, so it clears v2.
  const out = q.approve(p.proposalId, { by: dasha });
  assert.equal(out.status, "approved");
  assert.equal(out.version, 2);
});
