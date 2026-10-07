// Claim-escrow dispute adapter.
//
// Lane 7's claim escrow machine (server/claim-escrow.mjs) is a single-party
// bond machine: the claimant posts the bond, an independent evaluator signs
// the verdict, approve -> released (bond back to claimant), reject ->
// slashed (bond to the room pool). It has no dispute/freeze transitions —
// disputes are an overlay: the dispute layer freezes settlement by
// convention, and the settlement layer honors the dispute's finalOutcome
// directive over the machine's raw state.
//
// This adapter exposes the dispute-capable escrow view that
// server/escrow-disputes.mjs expects — get/dispute/resolveDispute — over a
// lane-7 machine instance:
//
//   - parties: the module needs a payer|payee pair. partiesOf(record)
//     defaults to { payer: record.claimant, payee: "room-pool" }: on slash
//     the bond moves to the pool, so a claimant disputing a slash wants
//     "refund" (bond back to the payer). Callers with a real counterparty
//     pass their own partiesOf.
//   - arbiter: arbiterOf(record) defaults to the seated evaluator (tier-0
//     is the evaluator re-ruling); pass a steward id for a distinct arbiter.
//   - state: the view reports "disputed" while frozen, "resolved" once the
//     arbiter/panel has ruled (with disputeOutcome), and the machine's raw
//     state otherwise. Disputable states are "in_evaluation" (pre-verdict)
//     and "slashed" (post-verdict challenge).
//   - resolveDispute drives the machine only when it is legal AND the
//     ruler is the seated evaluator (the machine's requireEvaluator rule):
//     release -> approve, refund -> reject, both from in_evaluation. Panel
//     overturns and post-terminal rulings never touch the machine — the
//     settlement layer applies the dispute directive as compensation.
//
// Paper units only. The adapter moves no value itself.

const ROOM_POOL = "room-pool";
const DISPUTABLE_MACHINE_STATES = new Set(["in_evaluation", "slashed"]);

class ClaimEscrowDisputeAdapterError extends Error {
  constructor(code, message) { super(message); this.name = "ClaimEscrowDisputeAdapterError"; this.code = code; }
}
const fail = (code, message) => { throw new ClaimEscrowDisputeAdapterError(code, message); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };
const nonEmptyString = (v, what, max = 256) =>
  check(typeof v === "string" && v.length > 0 && v.length <= max,
    "invalid_adapter", `${what} must be 1..${max} characters`);

export function createClaimEscrowDisputeAdapter({ machine, partiesOf, arbiterOf } = {}) {
  check(machine && typeof machine.get === "function"
    && typeof machine.approve === "function" && typeof machine.reject === "function",
    "invalid_adapter", "machine must expose get/approve/reject (lane-7 claim escrow)");
  check(partiesOf === undefined || typeof partiesOf === "function",
    "invalid_adapter", "partiesOf must be a function if given");
  check(arbiterOf === undefined || typeof arbiterOf === "function",
    "invalid_adapter", "arbiterOf must be a function if given");
  const resolveParties = partiesOf ?? (record => ({ payer: record.claimant, payee: ROOM_POOL }));
  const resolveArbiter = arbiterOf ?? (record => record.evaluator);

  const frozen = new Map();     // escrowId -> { by, reason, at }
  const resolutions = new Map(); // escrowId -> { by, outcome, note, at }

  const viewOf = escrowId => {
    const record = machine.get(escrowId);
    const { payer, payee } = resolveParties(record);
    nonEmptyString(payer, "payer", 128);
    nonEmptyString(payee, "payee", 128);
    const view = {
      escrowId: record.escrowId,
      payer, payee,
      evaluator: record.evaluator,
      arbiter: resolveArbiter(record),
      amount: record.bondSnapshot ?? record.bondUnits,
      machineState: record.state,
      state: record.state,
    };
    if (resolutions.has(escrowId)) {
      const r = resolutions.get(escrowId);
      return Object.freeze({ ...view, state: "resolved", disputeOutcome: r.outcome });
    }
    if (frozen.has(escrowId)) return Object.freeze({ ...view, state: "disputed" });
    return Object.freeze(view);
  };

  const get = escrowId => {
    nonEmptyString(escrowId, "escrowId");
    return viewOf(escrowId);
  };

  // Freeze settlement on the escrow. Overlay only: the machine keeps its
  // state; the settlement layer must consult isFrozen()/get() before acting.
  const dispute = (escrowId, { by, reason } = {}) => {
    nonEmptyString(escrowId, "escrowId");
    nonEmptyString(by, "by", 128);
    nonEmptyString(reason, "reason", 2000);
    const record = machine.get(escrowId);
    if (!DISPUTABLE_MACHINE_STATES.has(record.state))
      fail("invalid_transition",
        `escrow "${escrowId}" is ${record.state}, not disputable (in_evaluation | slashed)`);
    check(!frozen.has(escrowId), "already_disputed", `escrow "${escrowId}" is already frozen by a dispute`);
    frozen.set(escrowId, Object.freeze({ by, reason, at: new Date().toISOString() }));
    return get(escrowId);
  };

  // Record the ruling. Drives the machine only when the ruler is the seated
  // evaluator and the machine is still in_evaluation (the machine's
  // requireEvaluator rule); every other case is a settlement-layer
  // directive, honored via onDisputeFinalized.
  const resolveDispute = (escrowId, { by, outcome, note } = {}) => {
    nonEmptyString(escrowId, "escrowId");
    nonEmptyString(by, "by", 128);
    check(outcome === "release" || outcome === "refund", "invalid_adapter",
      `outcome must be "release" or "refund"`);
    if (note !== undefined && note !== null)
      check(typeof note === "string" && note.length <= 4000, "invalid_adapter",
        "note must be at most 4000 characters");
    check(frozen.has(escrowId), "not_disputed", `escrow "${escrowId}" has no open dispute`);
    const record = machine.get(escrowId);
    if (record.state === "in_evaluation" && record.evaluator !== null && by === record.evaluator) {
      if (outcome === "release") machine.approve(escrowId, { by, reasonCodes: ["criteria-met"] });
      else machine.reject(escrowId, { by, reasonCodes: ["criteria-unmet"] });
    }
    resolutions.set(escrowId, Object.freeze({ by, outcome, note: note ?? null,
      at: new Date().toISOString() }));
    frozen.delete(escrowId);
    return get(escrowId);
  };

  const isFrozen = escrowId => {
    nonEmptyString(escrowId, "escrowId");
    return frozen.has(escrowId);
  };

  return Object.freeze({ get, dispute, resolveDispute, isFrozen,
    size: () => machine.size(), ROOM_POOL, DISPUTABLE_MACHINE_STATES });
}
export { ClaimEscrowDisputeAdapterError, ROOM_POOL };
