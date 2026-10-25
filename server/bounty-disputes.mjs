// Bounty dispute flow (K007 + dispute-resolution design slice 2). A pure
// dispute state machine: disputes are denominated in the bounty itself and
// the dispute cost is capped at 25% of the bounty (settlement v2 design).
//
// The machine hooks the acceptance track only (integration-map candidate
// #2): it re-decides the verdict on work, never moves credit lots itself.
// Its single onDisputeFinalized packet carries track: "acceptance"; the
// escrow freezes finality while a dispute runs and records the verdict
// before any finality move.
//
// Ladder:
//   opened -> challenged -> evidence -> adjudicating -> decided -> resolved
//
// - opened: dispute raised with standing; bond snapshot taken (economic) or
//   bond: "none" (coordination).
// - challenged: the target receipt/accept is frozen while the dispute runs.
// - evidence: parties post EVIDENCE: entries.
// - adjudicating: a decider is seated (mechanical ADJUDICATE:), time-boxed.
// - decided: ruling issued with reason codes.
// - resolved: final (an unappealed decision finalizes).
// - unavailable(<reason>): honest-unavailable overlay, not a state — the
//   dispute is recorded but cannot proceed until an arbitrator exists.
//
// R-1 (#3726 rider): the appeal/withdraw rungs (appeal, escalate, withdraw,
// requiredAppealBond) were removed — no production consumer ever called them
// (the escrow drives open/challenge/evidence/seat/decide/finalize only), and
// unreachable money-adjacent surface is a liability, not an option. The
// `tier`/`escalations` record fields remain for persisted-row shape
// compatibility and are always 0/[] in practice.
//
// All state is caller-owned (a Map); the module is pure and dependency-free.
// Frozen outputs; malformed inputs and illegal transitions throw
// DisputeError. The escrow sees exactly one eventual onDisputeFinalized
// callback per dispute (event-driven, never keeper-polled).
const MAX_DISPUTE_COST_RATIO = 0.25;
const STATES = Object.freeze([
  "opened", "challenged", "evidence", "adjudicating",
  "decided", "resolved",
]);
// Fixed reason-code vocabulary (docs/ROOM-PROTOCOL.md § dispute grammar).
const REASON_CODES = Object.freeze([
  "receipt-incomplete", "criterion-unmet", "evidence-insufficient",
  "duplicate-work", "identity-mismatch", "frivolous",
  "verifier-conflict", "no-arbitrator",
]);
const OUTCOMES = Object.freeze(["upheld", "rejected", "split", "frivolous"]);
const TERMINAL = new Set(["resolved"]);
const MIN_BOND_RATIO = 0.05; // machine-level floor only: open bond >= max($1, 5% of bounty).
// NOT the production bond rule (#3307): the sole production caller,
// BountyEscrow.disputeBounty, requires exactly 25% of the bounty.

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
// onDisputeFinalized, when given, is the single eventual escrow callback
// (Kleros rule() / slop.cash shape): it fires exactly once per dispute when
// the dispute reaches a terminal state, carrying the full frozen record so
// the escrow can branch payout on outcome (upheld/rejected/split). It is
// event-driven — fired inline by the transition, never keeper-polled — and
// there is no parallel escrow authority: this one callback is the only
// channel. If the handler throws, the dispute is still terminal (the machine
// never gets stuck) and the error propagates to the caller.
export function createDisputes({ store, onDisputeFinalized } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  check(onDisputeFinalized === undefined || typeof onDisputeFinalized === "function",
    "onDisputeFinalized must be a function if given");
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

  // Build the final packet and fire the escrow callback exactly once. The
  // packet is always an acceptance-track verdict (integration-map candidate
  // #2): the dispute machine hooks the acceptance track only, and the escrow
  // asserts packet.track before settling — the packet can never drive a
  // finality move on its own.
  const notifyFinalized = (dispute, terminal) => {
    if (dispute.notified) return dispute;
    const notified = Object.freeze({ ...dispute, notified: true });
    set(notified);
    if (onDisputeFinalized) {
      const packet = Object.freeze({ disputeId: notified.disputeId,
        bountyId: notified.bountyId, kind: notified.kind, terminal,
        track: "acceptance",
        outcome: notified.resolution ? notified.resolution.outcome : null,
        reasonCodes: notified.resolution
          ? notified.resolution.reasonCodes : Object.freeze([]),
        tier: notified.tier, bondSnapshot: notified.bondSnapshot,
        forfeitedBond: notified.forfeitedBond, recordedCost: notified.recordedCost,
        escalations: notified.escalations });
      onDisputeFinalized(packet);
    }
    return notified;
  };

  // Open a dispute against a bounty. bountyAmount is in the bounty's own units.
  // Economic disputes post a bond (machine floor: max($1, 5% of bounty);
  // the production caller disputeBounty requires exactly 25% — #3307),
  // snapshotted at open and never repriced); coordination disputes carry
  // bond: "none".
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

  // Issue a ruling: adjudicating -> decided. A frivolous ruling forfeits
  // the bond to the pool (applied by the escrow settlement).
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
    const updated = Object.freeze({ ...current, state: "decided", resolution,
      forfeitedBond });
    set(updated);
    return updated;
  };

  // Finality: a decision finalizes to resolved. Fires the single
  // onDisputeFinalized callback for the adjudicated path.
  const finalize = disputeId => {
    const current = get(disputeId);
    requireState(current, "decided");
    const updated = Object.freeze({ ...current, state: "resolved" });
    set(updated);
    return notifyFinalized(updated, "resolved");
  };

  // Record a dispute cost. Refuses when it would exceed the 25% cap of the
  // bounty (the cap spans the whole dispute record).
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
    finalize, recordCost, markUnavailable,
    clearUnavailable, get,
    size: () => disputes.size, MAX_DISPUTE_COST_RATIO, STATES, REASON_CODES, OUTCOMES });
}
export { DisputeError, REASON_CODES, OUTCOMES };
