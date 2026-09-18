// Human-in-the-loop approval queue for agent-drafted outbound (lane C,
// inbox-agent-collab). An agent proposes a draft; nothing sends until a
// human approves it. The queue is the paper trail: propose → approve /
// requestEdits → resubmit → approve | reject, every edge journaled with who
// and when. Only human identities may approve, request edits, or reject — an
// agent can never clear its own draft.
//
// Pure, in-memory, dependency-free, deterministic; frozen outputs. Clock and
// id generator are injected so fixtures control time and ids.
import { randomUUID } from "node:crypto";
import { identityOf, threadIdOf } from "./inbox-assign.mjs";

export class ApprovalError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
const fail = (code, message, detail) => { throw new ApprovalError(code, message, detail); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

export const approvalStatuses = Object.freeze(["pending", "changes_requested", "approved", "rejected"]);
const terminalStatuses = new Set(["approved", "rejected"]);
const transitions = Object.freeze({
  pending: ["changes_requested", "approved", "rejected"],
  changes_requested: ["pending", "rejected"],
  approved: [],
  rejected: [],
});

const textOf = (value, max, field, { optional = false } = {}) => {
  if (value === undefined || value === null) {
    check(optional, "approval_invalid", `${field} is required`);
    return null;
  }
  check(typeof value === "string" && value.isWellFormed() && value.length >= 1 && value.length <= max,
    "approval_invalid", `${field} must be 1..${max} well-formed characters`);
  return value;
};
const humanOf = (value, field = "by") => {
  const who = identity(value, field);
  check(who.kind === "human", "approval_not_human", `${field} must be a human identity — agents cannot clear their own drafts.`);
  return who;
};
const isoOf = ms => new Date(ms).toISOString();

// identityOf/threadIdOf come from the assignment module; wrap them so this
// module's public surface throws only ApprovalError — one error contract per
// module, one catch for the caller.
const threadOf = value => {
  try { return threadIdOf(value); } catch (error) { fail("approval_invalid", error.message); }
};
const identity = (value, field) => {
  try { return identityOf(value, field); } catch (error) { fail("approval_invalid", error.message); }
};

const draftOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "approval_invalid", "draft must be an object");
  check(Object.keys(value).every(k => ["subject", "body"].includes(k)), "approval_invalid", "draft carries only subject/body");
  return Object.freeze({ subject: textOf(value.subject, 500, "draft.subject", { optional: true }),
    body: textOf(value.body, 8000, "draft.body") });
};
const freezeProposal = proposal => Object.freeze({ ...proposal,
  byAgent: Object.freeze({ ...proposal.byAgent }),
  draft: Object.freeze({ ...proposal.draft }),
  requestedEdits: proposal.requestedEdits ? Object.freeze({ ...proposal.requestedEdits,
    by: Object.freeze({ ...proposal.requestedEdits.by }) }) : null,
  history: Object.freeze(proposal.history.map(h => Object.freeze({ ...h, by: Object.freeze({ ...h.by }) }))),
});

export function createApprovalQueue({ clock = () => Date.now(), id = () => randomUUID() } = {}) {
  const proposals = new Map(); // proposalId -> proposal

  const getProposal = proposalId => {
    check(typeof proposalId === "string" && proposalId.length >= 1, "approval_invalid", "proposalId must be a non-empty string");
    const proposal = proposals.get(proposalId);
    if (!proposal) fail("approval_not_found", "No such approval proposal.", { proposalId });
    return proposal;
  };
  const move = (proposal, status, by, extra = {}) => {
    if (!transitions[proposal.status].includes(status))
      fail("approval_transition", `A ${proposal.status} proposal cannot move to ${status}.`,
        { from: proposal.status, to: status });
    const next = freezeProposal({ ...proposal, status, updatedAt: isoOf(clock()),
      history: [...proposal.history, { status, at: isoOf(clock()), by, ...extra }] });
    proposals.set(next.proposalId, next);
    return next;
  };

  // An agent proposes an outbound draft for human review. The draft is
  // inert here — proposing never sends anything.
  function propose(threadId, { draft, byAgent, channel } = {}) {
    const tid = threadOf(threadId);
    const agent = identity(byAgent, "byAgent");
    check(agent.kind === "agent", "approval_invalid", "byAgent must be an agent identity.");
    const proposal = freezeProposal({ proposalId: id(), threadId: tid, status: "pending", version: 1,
      draft: draftOf(draft), channel: textOf(channel, 64, "channel"), byAgent: agent,
      requestedEdits: null, createdAt: isoOf(clock()), updatedAt: isoOf(clock()),
      history: [{ status: "pending", at: isoOf(clock()), by: agent }] });
    proposals.set(proposal.proposalId, proposal);
    return proposal;
  }

  // Human verdicts. Every one is append-only on the proposal's history.
  function approve(proposalId, { by, note = null } = {}) {
    const proposal = getProposal(proposalId);
    const who = humanOf(by);
    return move(proposal, "approved", who, note === null || note === undefined
      ? {} : { note: textOf(note, 1000, "note") });
  }
  function requestEdits(proposalId, { by, edits, note = null } = {}) {
    const proposal = getProposal(proposalId);
    const who = humanOf(by);
    const next = move(proposal, "changes_requested", who, note === null || note === undefined
      ? {} : { note: textOf(note, 1000, "note") });
    return freezeProposal({ ...next, requestedEdits: Object.freeze({ edits: textOf(edits, 2000, "edits"), by: who,
      at: isoOf(clock()) }) });
  }
  // The agent answers changes_requested with a new draft version; the
  // proposal returns to pending for a fresh human verdict.
  function resubmit(proposalId, { draft, byAgent } = {}) {
    const proposal = getProposal(proposalId);
    const agent = identity(byAgent, "byAgent");
    check(agent.kind === "agent", "approval_invalid", "byAgent must be an agent identity.");
    const moved = move(proposal, "pending", agent);
    return freezeProposal({ ...moved, draft: draftOf(draft), version: proposal.version + 1, requestedEdits: null });
  }
  function reject(proposalId, { by, reason } = {}) {
    const proposal = getProposal(proposalId);
    const who = humanOf(by);
    return move(proposal, "rejected", who, { reason: textOf(reason, 1000, "reason") });
  }

  function get(proposalId) { return getProposal(proposalId); }
  function list({ status = null, threadId = null } = {}) {
    if (status !== null && status !== undefined)
      check(approvalStatuses.includes(status), "approval_invalid", `status must be one of ${approvalStatuses.join(",")}`);
    let rows = [...proposals.values()];
    if (status) rows = rows.filter(p => p.status === status);
    if (threadId) rows = rows.filter(p => p.threadId === threadOf(threadId));
    return Object.freeze(rows);
  }
  function audit(proposalId) { return getProposal(proposalId).history; }
  function pendingCount() { return [...proposals.values()].filter(p => p.status === "pending").length; }

  return Object.freeze({ propose, approve, requestEdits, resubmit, reject, get, list, audit, pendingCount,
    terminalStatuses });
}
