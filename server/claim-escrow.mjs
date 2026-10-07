// Claim escrow → evaluator → release (lane 7, acp-build-escrow-flow).
// Adapts Virtuals ACP's escrow/evaluator/release mechanics to the room's
// work-claim lifecycle. A pure state machine that rides ALONGSIDE a work
// claim (claim id <-> escrow record); it never touches work-claims.mjs.
//
// State machine:
//   unescrowed --lockBond--> bond_locked --submitWork--> work_submitted
//   bond_locked --withdraw--> refunded            (claimant backs out early)
//   bond_locked --expire--> expired                (lease lapsed, bond refunded)
//   work_submitted --seatEvaluator--> in_evaluation
//   in_evaluation --approve--> released            (bond returns to claimant)
//   in_evaluation --reject--> slashed              (bond moves to the room pool)
//   in_evaluation --expire--> expired              (evaluator timeout, bond refunded)
// Terminal: released, slashed, refunded, expired.
//
// MONEY POLICY: bonds are denominated in abstract paper units only —
// "credit" or "dasha-paper". The module converts nothing, touches no chain,
// no wallet, no mainnet. Real value movement needs John's explicit tap and
// stops at the design line in research_notes/acp-2026-10-07/.
// Invariants (the claim-bonds spec's standing rules):
//   1. Automation may freeze, never burn: only a signed evaluator verdict
//      (reject) slashes; expiry and withdraw always refund.
//   2. The bond snapshot is taken at lockBond and never repriced.
//   3. The seated evaluator is independent: never the claimant, never in
//      the caller-supplied excluded set (claim-round attesters/reviewers).
//   4. Exactly one onEscrowSettled packet per escrow, fired event-driven on
//      the terminal transition — never keeper-polled.
// Disputes are NOT a state here: a rejected verdict can be appealed via the
// separate bounty-disputes ladder; its onDisputeFinalized packet is the
// single channel back in. Pure, dependency-free, frozen outputs. All state
// is caller-owned (a Map); malformed inputs and illegal transitions throw
// EscrowError.
const STATES = Object.freeze([
  "unescrowed", "bond_locked", "work_submitted", "in_evaluation",
  "released", "slashed", "refunded", "expired",
]);
const TERMINAL = new Set(["released", "slashed", "refunded", "expired"]);
const TRANSITIONS = {
  unescrowed: ["bond_locked"],
  bond_locked: ["work_submitted", "refunded", "expired"],
  work_submitted: ["in_evaluation"],
  in_evaluation: ["released", "slashed", "expired"],
  released: [], slashed: [], refunded: [], expired: [],
};
// Paper-only denominations. Anything else is refused at create.
const DENOMINATIONS = Object.freeze(["credit", "dasha-paper"]);
// Fixed verdict vocabulary (the dispute grammar stays in bounty-disputes).
const VERDICT_CODES = Object.freeze([
  "criteria-met", "criteria-unmet", "evidence-insufficient",
  "duplicate-work", "identity-mismatch", "frivolous",
]);
const BLOB_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_HISTORY = 100;

class EscrowError extends Error {
  constructor(code, message) { super(message); this.name = "EscrowError"; this.code = code; }
}
const fail = (code, message) => { throw new EscrowError(code, message); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };
const illegal = (escrowId, from, to) =>
  fail("invalid_transition", `escrow "${escrowId}" cannot move ${from} -> ${to}`);
const nonEmptyString = (v, what, max = 256) =>
  check(typeof v === "string" && v.length > 0 && v.length <= max, "invalid_escrow", `${what} must be 1..${max} characters`);
const isoOf = value => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  check(Number.isFinite(ms), "invalid_escrow", "timestamp must be an ISO string");
  return new Date(ms).toISOString();
};

export function createClaimEscrows({ store, onEscrowSettled } = {}) {
  check(store === undefined || store instanceof Map, "invalid_escrow", "store must be a Map if given");
  check(onEscrowSettled === undefined || typeof onEscrowSettled === "function",
    "invalid_escrow", "onEscrowSettled must be a function if given");
  const escrows = store ?? new Map();

  const get = escrowId => {
    nonEmptyString(escrowId, "escrowId");
    check(escrows.has(escrowId), "invalid_escrow", `unknown escrow "${escrowId}"`);
    return escrows.get(escrowId);
  };
  const set = record => escrows.set(record.escrowId, record);
  const stamp = (record, atMs, actor, action, note) => {
    const full = [...record.history, Object.freeze({ at: new Date(atMs).toISOString(), actor, action, note: note ?? null })];
    const dropped = Math.max(0, full.length - MAX_HISTORY);
    return Object.freeze({ ...record,
      history: Object.freeze(dropped > 0 ? full.slice(dropped) : full),
      historyOmitted: (record.historyOmitted ?? 0) + dropped });
  };
  const move = (record, to, { actor, note, patch = {} } = {}) => {
    const allowed = TRANSITIONS[record.state] ?? [];
    if (!allowed.includes(to)) illegal(record.escrowId, record.state, to);
    const moved = Object.freeze({ ...record, state: to, ...patch });
    const stamped = stamp(moved, Date.now(), actor, `state:${to}`, note);
    set(stamped);
    return notifyIfTerminal(stamped);
  };
  // The single eventual settlement callback: fires exactly once per escrow,
  // inline on the terminal transition. The machine never gets stuck and
  // terminal states are final, so this cannot double-fire.
  const notifyIfTerminal = record => {
    if (!TERMINAL.has(record.state) || record.notified) return record;
    const notified = Object.freeze({ ...record, notified: true });
    set(notified);
    if (onEscrowSettled) {
      const packet = Object.freeze({ escrowId: notified.escrowId, claimId: notified.claimId,
        terminal: notified.state, bondSnapshot: notified.bondSnapshot,
        denomination: notified.denomination, evaluator: notified.evaluator,
        verdict: notified.verdict });
      onEscrowSettled(packet);
    }
    return notified;
  };
  const requireClaimant = (record, by) => {
    nonEmptyString(by, "by");
    if (by !== record.claimant) fail("not_claimant", `escrow "${record.escrowId}" belongs to ${record.claimant}`);
  };
  const requireEvaluator = (record, by) => {
    nonEmptyString(by, "by");
    if (record.evaluator === null || by !== record.evaluator)
      fail("not_evaluator", `only the seated evaluator may sign the verdict for "${record.escrowId}"`);
  };

  // Create an escrow record bound to a work claim. Nothing is locked yet.
  const create = ({ escrowId, claimId, claimant, bondUnits, denomination, leaseExpiresAt, note } = {}) => {
    nonEmptyString(escrowId, "escrowId");
    nonEmptyString(claimId, "claimId");
    nonEmptyString(claimant, "claimant", 128);
    check(!escrows.has(escrowId), "invalid_escrow", `escrow "${escrowId}" already exists`);
    check(Number.isSafeInteger(bondUnits) && bondUnits > 0, "invalid_escrow", "bondUnits must be a positive integer");
    check(DENOMINATIONS.includes(denomination), "invalid_escrow",
      `denomination must be one of ${DENOMINATIONS.join(", ")} — paper units only, never real funds`);
    if (note !== undefined && note !== null)
      check(typeof note === "string" && note.length <= 4000, "invalid_escrow", "note must be at most 4000 characters");
    const record = Object.freeze({ escrowId, claimId, claimant, bondUnits, denomination,
      leaseExpiresAt: leaseExpiresAt === undefined || leaseExpiresAt === null ? null : isoOf(leaseExpiresAt),
      state: "unescrowed", bondSnapshot: null, evaluator: null, verdict: null,
      history: Object.freeze([]), historyOmitted: 0, notified: false });
    set(stamp(record, Date.now(), claimant, "created", note));
    return get(escrowId);
  };

  // Lock the bond: unescrowed -> bond_locked. The snapshot is taken here and
  // never repriced afterwards.
  const lockBond = (escrowId, { by } = {}) => {
    const record = get(escrowId);
    requireClaimant(record, by);
    return move(record, "bond_locked", { actor: by, patch: { bondSnapshot: record.bondUnits } });
  };

  // Claimant submits finished work: bond_locked -> work_submitted. The
  // evidence hash is a sha256 receipt-blob pointer (the room's bytes32
  // analog: a commitment to the work, never the work itself). Optional —
  // some claims submit with only the done transition on the claim record.
  const submitWork = (escrowId, { by, evidenceHash, note } = {}) => {
    const record = get(escrowId);
    requireClaimant(record, by);
    if (evidenceHash !== undefined && evidenceHash !== null)
      check(typeof evidenceHash === "string" && BLOB_PATTERN.test(evidenceHash),
        "invalid_escrow", "evidenceHash must match sha256:<64 lowercase hex>");
    return move(record, "work_submitted", { actor: by, note,
      patch: { evidenceHash: evidenceHash ?? null } });
  };

  // Seat the independent evaluator: work_submitted -> in_evaluation.
  // Evaluator selection (random draw, reputation-weighted) is the caller's
  // job; this machine enforces independence: the evaluator is never the
  // claimant and never in the excluded set (claim-round attesters/reviewers
  // the caller passes in).
  const seatEvaluator = (escrowId, { evaluator, by, excluded } = {}) => {
    const record = get(escrowId);
    nonEmptyString(evaluator, "evaluator", 128);
    if (by !== undefined) nonEmptyString(by, "by", 128);
    const excludedSet = new Set(Array.isArray(excluded) ? excluded : []);
    if (evaluator === record.claimant || excludedSet.has(evaluator))
      fail("evaluator_not_independent",
        `evaluator "${evaluator}" is not independent of claimant ${record.claimant}`);
    return move(record, "in_evaluation", { actor: by ?? "escrow-keeper", patch: { evaluator } });
  };

  const verdictCodesOf = reasonCodes => {
    check(Array.isArray(reasonCodes) && reasonCodes.length > 0 && reasonCodes.length <= 10,
      "invalid_escrow", "reasonCodes must be a non-empty array of at most 10 codes");
    for (const code of reasonCodes)
      check(VERDICT_CODES.includes(code), "invalid_escrow", `unknown verdict code "${code}"`);
    return Object.freeze([...reasonCodes]);
  };
  // The seated evaluator signs the verdict. approve -> released (bond
  // returns to the claimant); reject -> slashed (bond moves to the room
  // pool). Only a signed verdict may burn — automation can freeze, never
  // slash (IB-014 invariant). State legality is checked before evaluator
  // identity: from any non-evaluation state the verdict is an illegal
  // transition, whoever signs it.
  const verdict = (escrowId, to, { by, reasonCodes }) => {
    const record = get(escrowId);
    if (record.state !== "in_evaluation") illegal(record.escrowId, record.state, to);
    requireEvaluator(record, by);
    const codes = verdictCodesOf(reasonCodes);
    return move(record, to, { actor: by,
      patch: { verdict: Object.freeze({ outcome: to === "released" ? "approve" : "reject", reasonCodes: codes, by }) } });
  };
  const approve = (escrowId, opts = {}) => verdict(escrowId, "released", opts);
  const reject = (escrowId, opts = {}) => verdict(escrowId, "slashed", opts);

  // Claimant withdraws before submitting: bond_locked -> refunded. After
  // submit the claim is owed a verdict and cannot be un-submitted.
  const withdraw = (escrowId, { by } = {}) => {
    const record = get(escrowId);
    requireClaimant(record, by);
    return move(record, "refunded", { actor: by });
  };

  // Mechanical expiry, attributed to the keeper (the RULE_ACTOR pattern):
  // bond_locked -> expired (lapsed before submit) or in_evaluation ->
  // expired (evaluator timeout). Expiry always refunds — the claimant is the
  // funder here, so ACP's "client reclaims" maps to "bond returns".
  // Legality is checked before any write: an illegal expire never mutates.
  const expire = (escrowId, { at } = {}) => {
    const record = get(escrowId);
    const allowed = TRANSITIONS[record.state] ?? [];
    if (!allowed.includes("expired")) illegal(record.escrowId, record.state, "expired");
    const atMs = at === undefined ? Date.now() : Date.parse(isoOf(at));
    const moved = Object.freeze({ ...record, state: "expired" });
    const stamped = stamp(moved, atMs, "escrow-keeper", "state:expired", "lease lapsed — bond refunded");
    set(stamped);
    return notifyIfTerminal(stamped);
  };

  return Object.freeze({ create, lockBond, submitWork, seatEvaluator, approve,
    reject, withdraw, expire, get, size: () => escrows.size,
    STATES, DENOMINATIONS, VERDICT_CODES });
}
export { EscrowError, STATES, DENOMINATIONS, VERDICT_CODES };
