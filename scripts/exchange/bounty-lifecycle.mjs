// Bounty lifecycle state machine (hard task 102).
//
// draft → funded → claimed → submitted → in_review → paid
//                                  ↘ disputed → resolved_paid | resolved_refunded
// Terminal: paid, resolved_paid, resolved_refunded, cancelled, expired.
// Timeouts (task 112): claim TTL, submission TTL, review TTL, funding window.
//
// Pure functions over plain bounty records — no I/O, no clock reads inside
// the transition core (the caller passes `at`). Design doc:
// docs/exchange/102-bounty-lifecycle.md. Timeout policy:
// docs/exchange/112-bounty-escrow-timeouts.md
export const STATES = Object.freeze([
  "draft", "funded", "claimed", "submitted", "in_review",
  "paid", "disputed", "resolved_paid", "resolved_refunded",
  "cancelled", "expired",
]);

export const TERMINAL = new Set(["paid", "resolved_paid", "resolved_refunded", "cancelled", "expired"]);

// Default timeouts (ms). Tunable per bounty; these are the policy defaults.
export const DEFAULT_TIMEOUTS = Object.freeze({
  fundingWindowMs: 14 * 24 * 3600 * 1000,  // draft → expired if never funded
  claimTtlMs: 7 * 24 * 3600 * 1000,        // claimed → funded if never submitted
  submissionTtlMs: 14 * 24 * 3600 * 1000,  // claimed → funded if submission window lapses (from claim)
  reviewTtlMs: 7 * 24 * 3600 * 1000,       // in_review → auto-paid if reviewers go silent
  disputeTtlMs: 14 * 24 * 3600 * 1000,     // disputed → resolved_refunded if no arbiter decision
});

export class BountyError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new BountyError(code, message); };

// Transition table: event → { from: [...], to, guard? }.
const TRANSITIONS = {
  fund:            { from: ["draft"], to: "funded" },
  cancel_draft:    { from: ["draft"], to: "cancelled" },
  sponsor_cancel:  { from: ["funded"], to: "cancelled" },
  claim:           { from: ["funded"], to: "claimed" },
  release_claim:   { from: ["claimed"], to: "funded" },
  submit:          { from: ["claimed"], to: "submitted" },
  start_review:    { from: ["submitted"], to: "in_review" },
  request_changes: { from: ["in_review"], to: "claimed" },
  approve:         { from: ["in_review"], to: "paid" },
  dispute:         { from: ["in_review", "submitted"], to: "disputed" },
  resolve_pay:     { from: ["disputed"], to: "resolved_paid" },
  resolve_refund:  { from: ["disputed"], to: "resolved_refunded" },
  // Timeout-driven transitions (applied by applyTimeouts, not directly).
  expire_unfunded: { from: ["draft"], to: "expired" },
  claim_timeout:   { from: ["claimed"], to: "funded" },
  review_timeout:  { from: ["in_review"], to: "paid" },
  dispute_timeout: { from: ["disputed"], to: "resolved_refunded" },
};

export function canTransition(bounty, event) {
  const t = TRANSITIONS[event];
  if (!t) return false;
  return t.from.includes(bounty.state);
}

export function transition(bounty, event, { at = Date.now(), actor = null } = {}) {
  const t = TRANSITIONS[event];
  if (!t) fail("unknown_event", `unknown bounty event: ${event}`);
  if (!t.from.includes(bounty.state)) {
    fail("invalid_transition", `cannot ${event} from state ${bounty.state}`);
  }
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(bounty.timeouts ?? {}) };
  const next = { ...bounty, state: t.to, updatedAt: at, history: [...(bounty.history ?? []), { event, from: bounty.state, to: t.to, at, actor }] };
  // Stamp the deadline clocks that the new state starts.
  if (t.to === "draft") next.fundingDeadline = at + timeouts.fundingWindowMs;
  if (t.to === "claimed") { next.claimDeadline = at + timeouts.claimTtlMs; next.submissionDeadline = at + timeouts.submissionTtlMs; }
  if (t.to === "in_review") next.reviewDeadline = at + timeouts.reviewTtlMs;
  if (t.to === "disputed") next.disputeDeadline = at + timeouts.disputeTtlMs;
  if (t.to === "funded" && bounty.state === "draft") next.fundingDeadline = null;
  return next;
}

export function createBounty({ id, title, amount, sponsor, timeouts = {}, at = Date.now() }) {
  if (!id || !title || !sponsor) fail("invalid_bounty", "id, title, and sponsor are required");
  if (!Number.isSafeInteger(amount) || amount <= 0) fail("invalid_bounty", "amount must be a positive integer of credits");
  return {
    id, title, amount, sponsor,
    state: "draft",
    timeouts: { ...DEFAULT_TIMEOUTS, ...timeouts },
    fundingDeadline: at + (timeouts.fundingWindowMs ?? DEFAULT_TIMEOUTS.fundingWindowMs),
    claimDeadline: null, submissionDeadline: null, reviewDeadline: null, disputeDeadline: null,
    claimant: null, createdAt: at, updatedAt: at, history: [{ event: "create", from: null, to: "draft", at, actor: sponsor }],
  };
}

// Apply every timeout whose deadline has passed at `at`. Returns { bounty, fired }
// where fired names the timeout transitions applied, in order. Pure.
export function applyTimeouts(bounty, at = Date.now()) {
  let b = bounty;
  const fired = [];
  const due = (deadline) => deadline != null && at >= deadline;
  // Order matters: a bounty can cascade through at most one timeout per call
  // site is wrong — loop until quiescent, but each state has at most one
  // outgoing timeout, so a single pass in state order is enough.
  if (b.state === "draft" && due(b.fundingDeadline)) { b = transition(b, "expire_unfunded", { at }); fired.push("expire_unfunded"); }
  else if (b.state === "claimed" && (due(b.claimDeadline) || due(b.submissionDeadline))) { b = transition(b, "claim_timeout", { at }); fired.push("claim_timeout"); }
  else if (b.state === "in_review" && due(b.reviewDeadline)) { b = transition(b, "review_timeout", { at }); fired.push("review_timeout"); }
  else if (b.state === "disputed" && due(b.disputeDeadline)) { b = transition(b, "dispute_timeout", { at }); fired.push("dispute_timeout"); }
  return { bounty: b, fired };
}

export function isTerminal(bounty) { return TERMINAL.has(bounty.state); }
