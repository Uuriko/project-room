// Bounty dispute flow (K007 + dispute-resolution design slice 2). A pure
// dispute state machine: disputes are denominated in the bounty itself and
// the dispute cost is capped at 25% of the bounty (settlement v2 design).
//
// Escalation ladder:
//   opened -> challenged -> evidence -> adjudicating -> decided -> resolved
//                                      decided -> appealed -> adjudicating (tier+1)
//   opened/challenged/evidence/adjudicating/appealed -> withdrawn
//
// - opened: dispute raised with standing; bond snapshot taken (economic) or
//   bond: "none" (coordination).
// - challenged: the target receipt/accept is frozen while the dispute runs.
// - evidence: parties post EVIDENCE: entries.
// - adjudicating: a decider is seated (mechanical ADJUDICATE:), time-boxed.
// - decided: ruling issued with reason codes. Terminal unless appealed.
// - appealed: escalation to the next tier with a doubled bond (loser-pays).
// - resolved: final. withdrawn: disputant withdrew, bond forfeit.
// - unavailable(<reason>): honest-unavailable overlay, not a state — the
//   dispute is recorded but cannot proceed until an arbitrator exists.
//
// All state is caller-owned (a Map); the module is pure and dependency-free.
// Frozen outputs; malformed inputs and illegal transitions throw
// DisputeError. Escrow/chain wiring is a later slice.
const MAX_DISPUTE_COST_RATIO = 0.25;
const STATES = Object.freeze([
  "opened", "challenged", "evidence", "adjudicating",
  "decided", "appealed", "resolved", "withdrawn",
]);
// Fixed reason-code vocabulary (docs/ROOM-PROTOCOL.md § dispute grammar).
const REASON_CODES = Object.freeze([
  "receipt-incomplete", "criterion-unmet", "evidence-insufficient",
  "duplicate-work", "identity-mismatch", "frivolous",
  "verifier-conflict", "no-arbitrator",
]);
const OUTCOMES = Object.freeze(["upheld", "rejected", "split", "frivolous"]);
const TERMINAL = new Set(["resolved", "withdrawn"]);
const MIN_BOND_RATIO = 0.05; // open bond = max($1, 5% of bounty)

class DisputeError extends Error {
  constructor(code, message) { super(message); this.name = "DisputeError"; this.code = code; }
}
const fail = (code, message) => { throw new DisputeError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_dispute", message); };
const illegal = (disputeId, from, to) =>
  fail("invalid_transition", `dispute "${disputeId}" cannot move ${from} -> ${to}`);
const nonEmptyString = (v, what) =>
  check(typeof v === "string" && v.length > 0, `${what} must be a non-empty string`);

// Create a dispute manager. store is a caller-owned Map (disputeId -> dispute).
export function createDisputes({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const disputes = store ?? new Map();
  const checkId = id => nonEmptyString(id, "id");
  const get = disputeId => {
    checkId(disputeId); check(disputes.has(disputeId), `unknown dispute "${disputeId}"`);
    return disputes.get(disputeId);
  };
  const set = dispute => disputes.set(dispute.disputeId, dispute);
  const requireState = (dispute, ...allowed) => {
    if (!allowed.includes(dispute.state)) illegal(dispute.disputeId, dispute.state, allowed.join("|"));
  };

  // Open a dispute against a bounty. bountyAmount is in the bounty's own units.
  // Economic disputes post a bond (max($1, 5% of bounty), snapshotted at open
  // and never repriced); coordination disputes carry bond: "none".
  const open = ({ disputeId, bountyId, bountyAmount, raisedBy, reason, kind = "economic", bond }) => {
    checkId(disputeId);
    nonEmptyString(bountyId, "bountyId");
    check(Number.isFinite(bountyAmount) && bountyAmount > 0, "bountyAmount must be positive");
    nonEmptyString(raisedBy, "raisedBy");
    check(typeof reason === "string" && reason.length > 0 && reason.length <= 2000, "reason must be 1-2000 chars");
    check(["economic", "coordination"].includes(kind), 'kind must be "economic" or "coordination"');
    check(!disputes.has(disputeId), `dispute "${disputeId}" already exists`);
    let bondSnapshot;
    if (kind === "economic") {
      const minimum = Math.max(1, Math.floor(bountyAmount * MIN_BOND_RATIO));
      if (bond === undefined || bond === null || bond === "none")
        fail("bond-missing", `economic dispute requires a bond of at least ${minimum} (5% of bounty)`);
      check(Number.isFinite(bond) && bond >= minimum, `bond must be at least ${minimum} (5% of bounty)`);
      bondSnapshot = bond;
    } else {
      check(bond === undefined || bond === "none", 'coordination dispute carries bond: "none"');
      bondSnapshot = "none";
    }
    const cap = Math.floor(bountyAmount * MAX_DISPUTE_COST_RATIO);
    const dispute = Object.freeze({ disputeId, bountyId, bountyAmount, kind,
      bondSnapshot, maxDisputeCost: cap, state: "opened", tier: 0,
      raisedBy, reason, evidence: Object.freeze([]), decider: null,
      escalations: Object.freeze([]), recordedCost: 0, forfeitedBond: 0,
      resolution: null, unavailable: null });
    set(dispute);
    return dispute;
  };

  // Raise the challenge: opened -> challenged. The target receipt/accept is
  // frozen while the dispute runs (the room-watch sweep skips it).
  const challenge = (disputeId, { by } = {}) => {
    const current = get(disputeId);
    requireState(current, "opened");
    nonEmptyString(by, "by");
    const updated = Object.freeze({ ...current, state: "challenged", challengedBy: by });
    set(updated);
    return updated;
  };

  // Submit evidence. First entry moves challenged -> evidence; later entries
  // stay in evidence.
  const submitEvidence = (disputeId, { by, summary }) => {
    const current = get(disputeId);
    requireState(current, "challenged", "evidence");
    nonEmptyString(by, "by");
    check(typeof summary === "string" && summary.length > 0 && summary.length <= 2000, "summary must be 1-2000 chars");
    const updated = Object.freeze({ ...current, state: "evidence",
      evidence: Object.freeze([...current.evidence, Object.freeze({ by, summary })]) });
    set(updated);
    return updated;
  };

  // Seat a decider: evidence -> adjudicating. Mechanical (ADJUDICATE:), never
  // by a party to the dispute.
  const seatDecider = (disputeId, { decider }) => {
    const current = get(disputeId);
    requireState(current, "evidence");
    nonEmptyString(decider, "decider");
    const updated = Object.freeze({ ...current, state: "adjudicating", decider });
    set(updated);
    return updated;
  };

  // Issue a ruling: adjudicating -> decided. A frivolous ruling forfeits the
  // bond and carries no appeal as of right.
  const decide = (disputeId, { outcome, reasonCodes, decider }) => {
    const current = get(disputeId);
    requireState(current, "adjudicating");
    check(OUTCOMES.includes(outcome), 'outcome must be "upheld", "rejected", "split", or "frivolous"');
    check(Array.isArray(reasonCodes) && reasonCodes.length > 0, "reasonCodes must be a non-empty array");
    for (const code of reasonCodes) check(REASON_CODES.includes(code), `unknown reason code "${code}"`);
    if (decider !== undefined) nonEmptyString(decider, "decider");
    let forfeitedBond = current.forfeitedBond;
    if (outcome === "frivolous" && typeof current.bondSnapshot === "number")
      forfeitedBond += current.bondSnapshot;
    const resolution = Object.freeze({ outcome,
      reasonCodes: Object.freeze([...reasonCodes]),
      decider: decider ?? current.decider });
    // Annotate the latest escalation with the decision (loser-pays is
    // computed in the economic wiring slice).
    const escalations = current.escalations.map((e, i) =>
      i === current.escalations.length - 1 && e.decision === undefined
        ? Object.freeze({ ...e, decision: outcome }) : e);
    const updated = Object.freeze({ ...current, state: "decided", resolution,
      forfeitedBond, escalations: Object.freeze(escalations) });
    set(updated);
    return updated;
  };

  // Bond required to appeal into the next tier: 2x the current tier's bond.
  const requiredAppealBond = dispute =>
    dispute.kind === "coordination" ? "none" : dispute.bondSnapshot * 2 ** (dispute.tier + 1);

  // Appeal a decision: decided -> appealed. A frivolous ruling has no appeal
  // as of right.
  const appeal = (disputeId, { by, bond }) => {
    const current = get(disputeId);
    requireState(current, "decided");
    nonEmptyString(by, "by");
    if (current.resolution.outcome === "frivolous")
      fail("frivolous", `dispute "${disputeId}" was ruled frivolous: no appeal as of right`);
    const required = requiredAppealBond(current);
    if (required === "none") {
      check(bond === undefined || bond === "none", 'coordination appeal carries bond: "none"');
    } else {
      if (!Number.isFinite(bond))
        fail("bond-missing", `appeal requires a bond of at least ${required} (2x tier-${current.tier} bond)`);
      check(bond >= required, `appeal bond ${bond} is below the required ${required} (2x tier-${current.tier} bond)`);
    }
    const escalations = Object.freeze([...current.escalations,
      Object.freeze({ tier: current.tier + 1, appellant: by,
        bond: required === "none" ? "none" : bond })]);
    const updated = Object.freeze({ ...current, state: "appealed", escalations,
      decider: null });
    set(updated);
    return updated;
  };

  // Move an appealed dispute into the next adjudication tier:
  // appealed -> adjudicating (tier+1).
  const escalate = (disputeId, { decider }) => {
    const current = get(disputeId);
    requireState(current, "appealed");
    nonEmptyString(decider, "decider");
    const updated = Object.freeze({ ...current, state: "adjudicating",
      tier: current.tier + 1, decider, resolution: null });
    set(updated);
    return updated;
  };

  // Optimistic finality: an unappealed decision finalizes to resolved.
  // Enforcement executes exactly once (escrow wiring is a later slice).
  const finalize = disputeId => {
    const current = get(disputeId);
    requireState(current, "decided");
    const updated = Object.freeze({ ...current, state: "resolved" });
    set(updated);
    return updated;
  };

  // Disputant withdraws: bond forfeit (UMA _computeBurnedBond shape).
  const withdraw = (disputeId, { by } = {}) => {
    const current = get(disputeId);
    requireState(current, "opened", "challenged", "evidence", "adjudicating", "appealed");
    if (by !== undefined) nonEmptyString(by, "by");
    const forfeitedBond = typeof current.bondSnapshot === "number"
      ? current.forfeitedBond + current.bondSnapshot : current.forfeitedBond;
    const updated = Object.freeze({ ...current, state: "withdrawn", forfeitedBond,
      withdrawnBy: by ?? null });
    set(updated);
    return updated;
  };

  // Record a dispute cost. Refuses when it would exceed the 25% cap — the cap
  // spans the whole escalation because every tier shares one dispute record.
  const recordCost = (disputeId, amount) => {
    const current = get(disputeId);
    if (TERMINAL.has(current.state) || current.state === "decided")
      illegal(current.disputeId, current.state, "recordCost");
    check(Number.isFinite(amount) && amount > 0, "amount must be positive");
    const next = current.recordedCost + amount;
    if (next > current.maxDisputeCost)
      fail("dispute_cost_capped", `cost ${next} exceeds cap ${current.maxDisputeCost} (25% of bounty)`);
    const updated = Object.freeze({ ...current, recordedCost: next });
    set(updated);
    return updated;
  };

  // Honest-unavailable overlay: recorded but not a state; the dispute is
  // frozen with a visible flag until an arbitrator exists.
  const markUnavailable = (disputeId, reason) => {
    const current = get(disputeId);
    check(!TERMINAL.has(current.state), `dispute "${disputeId}" is ${current.state}`);
    nonEmptyString(reason, "reason");
    const updated = Object.freeze({ ...current, unavailable: reason });
    set(updated);
    return updated;
  };
  const clearUnavailable = disputeId => {
    const current = get(disputeId);
    const updated = Object.freeze({ ...current, unavailable: null });
    set(updated);
    return updated;
  };

  return Object.freeze({ open, challenge, submitEvidence, seatDecider, decide,
    appeal, escalate, finalize, withdraw, recordCost, markUnavailable,
    clearUnavailable, get, requiredAppealBond,
    size: () => disputes.size, MAX_DISPUTE_COST_RATIO, STATES, REASON_CODES, OUTCOMES });
}
export { DisputeError, REASON_CODES, OUTCOMES };
