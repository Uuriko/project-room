// Result cards: the shape an agent's finished (or waiting) work takes in a
// room. Borrowed from team-agent products that post every result as one card:
// a short step trail, who the work is waiting on, and whether anything has
// left the room yet. Pure and deterministic; no I/O.
//
// The card answers three questions at a glance:
//   1. What did the agent do?   -> steps[] with done/running/waiting/failed
//   2. Who is it waiting on?    -> waitingOn (null when nothing is pending)
//   3. Did anything go out?     -> sent: "Nothing sent yet" until a human
//                                  approves and the send is recorded
// Reject always carries a reason, and feedbackForAgent() turns a verdict
// into the message the agent gets back, so the correction reaches it.

export class ResultCardError extends Error {
  constructor(code, message) { super(message); this.name = "ResultCardError"; this.code = code; }
}
const fail = (code, message) => { throw new ResultCardError(code, message); };

export const stepStatuses = Object.freeze(["done", "running", "waiting", "failed", "skipped"]);
export const MAX_STEPS = 8;
const NOTHING_SENT = "Nothing sent yet";

const text = (value, max, field) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail("card_invalid", `${field} must be 1..${max} characters`);
  return value.trim();
};

function stepOf(step, index) {
  if (!step || typeof step !== "object") fail("card_invalid", `steps[${index}] must be an object`);
  const status = step.status ?? "done";
  if (!stepStatuses.includes(status)) fail("card_invalid", `steps[${index}].status must be one of ${stepStatuses.join(",")}`);
  const out = { label: text(step.label, 120, `steps[${index}].label`), status };
  if (status === "waiting") out.waitingOn = text(step.waitingOn, 80, `steps[${index}].waitingOn`);
  return Object.freeze(out);
}

// approval: optional inbox-approval proposal (status + history). sentAt:
// set only when the outbound send actually happened.
export function buildResultCard({ title, summary, steps = [], approval = null, sentAt = null, outbound = true } = {}) {
  if (!Array.isArray(steps)) fail("card_invalid", "steps must be an array");
  if (steps.length > MAX_STEPS) fail("card_invalid", `at most ${MAX_STEPS} steps; group the rest`);
  const trail = steps.map(stepOf);
  const waitingStep = trail.find(s => s.status === "waiting");
  const status = approval?.status ?? null;

  let waitingOn = waitingStep ? waitingStep.waitingOn : null;
  if (!waitingOn && (status === "pending")) waitingOn = "owner";
  if (status === "changes_requested") waitingOn = "agent";

  let sent = null;
  if (outbound) sent = sentAt != null ? `Sent ${new Date(sentAt).toISOString()}` : NOTHING_SENT;

  const actions = [];
  if (status === "pending") actions.push("approve", "request_edits", "reject");
  else if (!approval && waitingStep) actions.push("approve", "reject");

  const failed = trail.some(s => s.status === "failed");
  const state = failed ? "failed"
    : status === "rejected" ? "rejected"
    : waitingOn ? "waiting"
    : trail.some(s => s.status === "running") ? "running"
    : "done";

  return Object.freeze({
    title: text(title, 140, "title"),
    summary: summary == null ? null : text(summary, 600, "summary"),
    state, steps: Object.freeze(trail), waitingOn, sent,
    actions: Object.freeze(actions),
    rejectRequiresReason: actions.includes("reject"),
  });
}

// Plain-text rendering for agents, MCP results and email digests.
export function renderResultCardText(card) {
  const mark = { done: "[x]", running: "[~]", waiting: "[ ]", failed: "[!]", skipped: "[-]" };
  const lines = [card.title];
  if (card.summary) lines.push(card.summary);
  for (const s of card.steps) lines.push(`${mark[s.status]} ${s.label}${s.waitingOn ? ` - waiting on ${s.waitingOn}` : ""}`);
  if (card.waitingOn) lines.push(`Waiting on: ${card.waitingOn}`);
  if (card.sent) lines.push(card.sent);
  return lines.join("\n");
}

// Turn a human verdict on a proposal into what the proposing agent reads
// next. Reject without a reason is refused upstream (inbox-approval); here
// we just surface it so the agent can save it as a correction if repeated.
export function feedbackForAgent(proposal) {
  if (!proposal || typeof proposal !== "object") fail("card_invalid", "proposal is required");
  const last = proposal.history?.[proposal.history.length - 1] ?? {};
  switch (proposal.status) {
    case "approved": return Object.freeze({ kind: "approved", text: last.note ? `Approved: ${last.note}` : "Approved.", by: last.by?.id ?? null });
    case "rejected": return Object.freeze({ kind: "rejected", text: `Rejected: ${last.reason}`, reason: last.reason, by: last.by?.id ?? null, suggestCorrection: true });
    case "changes_requested": return Object.freeze({ kind: "changes_requested", text: `Edits requested: ${proposal.requestedEdits?.edits ?? ""}`.trim(), by: proposal.requestedEdits?.by?.id ?? null, suggestCorrection: true });
    default: return null;
  }
}
