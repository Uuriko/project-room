// Wires result cards (server/result-card.mjs) to the durable approval queue
// (store.collab, server/inbox-collab-store.mjs). Two reads:
//
//   agentFeedbackFeed  - what an agent reads next: every human verdict on its
//                        own drafts (approve note, reject reason, requested
//                        edits), oldest first, with a cursor. This is how a
//                        reject reason reaches the agent instead of dying in
//                        the UI.
//   needsYouResultCards - pending drafts as result cards for the needs-you
//                        list: step trail, waiting on the owner, "Nothing
//                        sent yet".
//
// Reads only; no writes, no network.
import { buildResultCard, feedbackForAgent } from "./result-card.mjs";

const VERDICTS = new Set(["approved", "rejected", "changes_requested"]);
const MAX_ITEMS = 50;

const approvalsOf = (store, roomId, status = null) => store.collab.listApprovals(roomId, { status });

export function agentFeedbackFeed(store, roomId, agentId, { since = null, limit = MAX_ITEMS } = {}) {
  if (typeof agentId !== "string" || !agentId) throw new TypeError("agentId is required");
  const cap = Math.max(1, Math.min(MAX_ITEMS, Number(limit) || MAX_ITEMS));
  const rows = approvalsOf(store, roomId)
    .filter(p => p.byAgent?.id === agentId && VERDICTS.has(p.status))
    .filter(p => since == null || p.updatedAt > since)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.proposalId.localeCompare(b.proposalId))
    .slice(0, cap);
  const items = rows.map(p => Object.freeze({
    proposalId: p.proposalId, threadId: p.threadId, version: p.version, at: p.updatedAt, ...feedbackForAgent(p),
  }));
  return Object.freeze({ items: Object.freeze(items), cursor: items.length ? items[items.length - 1].at : since });
}

export function resultCardForProposal(proposal) {
  const steps = [{ label: `Drafted by ${proposal.byAgent?.label ?? proposal.byAgent?.id ?? "agent"}${proposal.version > 1 ? ` (v${proposal.version})` : ""}` }];
  if (proposal.status === "pending") steps.push({ label: "Approve", status: "waiting", waitingOn: "owner" });
  else if (proposal.status === "changes_requested") steps.push({ label: "Revise", status: "waiting", waitingOn: "agent" });
  else steps.push({ label: proposal.status === "approved" ? "Approved" : "Rejected", status: proposal.status === "approved" ? "done" : "failed" });
  const card = buildResultCard({
    title: proposal.draft?.subject || `Draft for ${proposal.channel}`,
    summary: proposal.draft?.body ? proposal.draft.body.slice(0, 600) : null,
    steps, approval: proposal,
  });
  return Object.freeze({ proposalId: proposal.proposalId, threadId: proposal.threadId, card });
}

export function needsYouResultCards(store, roomId) {
  return Object.freeze(approvalsOf(store, roomId, "pending").map(resultCardForProposal));
}
