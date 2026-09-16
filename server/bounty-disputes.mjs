// Bounty dispute flow (K007). A pure dispute state machine: disputes are
// denominated in the bounty itself and the dispute cost is capped at 25%
// of the bounty (per the settlement v2 design). A dispute moves through
// opened -> evidence -> resolved, with an explicit cap check before any
// cost is recorded. All state is caller-owned (a Map); the module is pure
// and dependency-free. Frozen outputs; malformed inputs throw
// DisputeError. Escrow/chain wiring is a later slice.
const MAX_DISPUTE_COST_RATIO = 0.25;
const STATES = Object.freeze(["opened", "evidence", "resolved"]);
class DisputeError extends Error { constructor(code, message) { super(message); this.name = "DisputeError"; this.code = code; } }
const fail = (code, message) => { throw new DisputeError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_dispute", message); };
// Create a dispute manager. store is a caller-owned Map (disputeId -> dispute).
export function createDisputes({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const disputes = store ?? new Map();
  const checkId = id => check(typeof id === "string" && id.length > 0, "id must be a non-empty string");
  // Open a dispute against a bounty. bountyAmount is in the bounty's own units.
  const open = ({ disputeId, bountyId, bountyAmount, raisedBy, reason }) => {
    checkId(disputeId);
    check(typeof bountyId === "string" && bountyId.length > 0, "bountyId must be a non-empty string");
    check(Number.isFinite(bountyAmount) && bountyAmount > 0, "bountyAmount must be positive");
    check(typeof raisedBy === "string" && raisedBy.length > 0, "raisedBy must be a non-empty string");
    check(typeof reason === "string" && reason.length > 0 && reason.length <= 2000, "reason must be 1-2000 chars");
    check(!disputes.has(disputeId), `dispute "${disputeId}" already exists`);
    const cap = Math.floor(bountyAmount * MAX_DISPUTE_COST_RATIO);
    const dispute = Object.freeze({ disputeId, bountyId, bountyAmount,
      maxDisputeCost: cap, state: "opened", raisedBy, reason,
      evidence: Object.freeze([]), recordedCost: 0, resolution: null });
    disputes.set(disputeId, dispute);
    return dispute;
  };
  const get = disputeId => {
    checkId(disputeId); check(disputes.has(disputeId), `unknown dispute "${disputeId}"`);
    return disputes.get(disputeId);
  };
  // Submit evidence (moves opened -> evidence).
  const submitEvidence = (disputeId, { by, summary }) => {
    const current = get(disputeId);
    check(current.state === "opened", `dispute "${disputeId}" is ${current.state}, not opened`);
    check(typeof by === "string" && by.length > 0, "by must be a non-empty string");
    check(typeof summary === "string" && summary.length > 0 && summary.length <= 2000, "summary must be 1-2000 chars");
    const updated = Object.freeze({ ...current, state: "evidence",
      evidence: Object.freeze([...current.evidence, Object.freeze({ by, summary })]) });
    disputes.set(disputeId, updated);
    return updated;
  };
  // Record a dispute cost. Refuses when it would exceed the 25% cap.
  const recordCost = (disputeId, amount) => {
    const current = get(disputeId);
    check(current.state !== "resolved", `dispute "${disputeId}" is already resolved`);
    check(Number.isFinite(amount) && amount > 0, "amount must be positive");
    const next = current.recordedCost + amount;
    if (next > current.maxDisputeCost)
      fail("dispute_cost_capped", `cost ${next} exceeds cap ${current.maxDisputeCost} (25% of bounty)`);
    const updated = Object.freeze({ ...current, recordedCost: next });
    disputes.set(disputeId, updated);
    return updated;
  };
  // Resolve a dispute with an outcome.
  const resolve = (disputeId, { outcome, note }) => {
    const current = get(disputeId);
    check(current.state !== "resolved", `dispute "${disputeId}" is already resolved`);
    check(["upheld", "rejected", "split"].includes(outcome), 'outcome must be "upheld", "rejected", or "split"');
    check(note === undefined || (typeof note === "string" && note.length <= 2000), "note must be ≤2000 chars");
    const updated = Object.freeze({ ...current, state: "resolved",
      resolution: Object.freeze({ outcome, note: note ?? null }) });
    disputes.set(disputeId, updated);
    return updated;
  };
  return Object.freeze({ open, get, submitEvidence, recordCost, resolve,
    size: () => disputes.size, MAX_DISPUTE_COST_RATIO, STATES });
}
export { DisputeError };
