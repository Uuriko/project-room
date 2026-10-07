// Claim <-> escrow/evaluator-wedge adapter (ACP build lane 11).
//
// A pure sidecar for the work-claim state machine (server/work-claims.mjs):
// it projects the ACP job ladder (offer -> fund -> evaluate -> release/refund,
// see research_notes/acp-2026-10-07/lane2-lifecycle.md) onto claim items
// WITHOUT adding claim states, touching the machine, or doing I/O.
//
// The adapter never moves value: every function returns frozen journal
// instructions ({ at, kind, claimId, actor, units, note }) for a store layer
// to apply. Settlement is pull-only; automation may freeze, never slash
// (slashing lives in the evaluator-bond registry behind signed tallies).
//
// Backward compatibility is structural: every function treats a claim with
// no `escrow` field as legacy. Projections and settlement return the legacy
// answer ("none" / true / null); only the explicit constructors
// (offer/lock/seat) throw on misuse, so a wiring bug fails closed instead
// of silently minting escrow state. Units are abstract integers — no token,
// no chain, no wallet.
//
// This module does no I/O and imports no server modules (the
// server/claim-coordination.mjs pattern), so it cannot create import cycles.

export const ESCROW_STATUSES = Object.freeze(
  ["offered", "funded", "locked", "evaluating", "released", "refunded"]);
const TERMINAL_STATUSES = new Set(["released", "refunded"]);
const ACTIVE_STATUSES = new Set(["offered", "funded", "locked", "evaluating"]);

export const MIN_EVALUATORS = 2; // lane-2 finding #1: evaluator=self is griefing; n=1 is rejected at offer
export const MAX_EVALUATORS = 9;
export const MAX_BUDGET_UNITS = 1_000_000_000;
export const MAX_FEE_BPS = 10_000; // 100%
export const DEFAULT_EVALUATOR_FEE_BPS = 100; // 1% — policy default; the offer may override
export const DEFAULT_PLATFORM_FEE_BPS = 100; // 1% — policy default; the offer may override

export class EscrowError extends Error {
  constructor(code, message) { super(message); this.name = "EscrowError"; this.code = code; }
}
const fail = (code, message) => { throw new EscrowError(code, message); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };
const isoOf = ms => new Date(ms).toISOString();

const intOf = (value, what, code = "invalid_escrow_input") => {
  check(Number.isSafeInteger(value), code, `${what} must be a safe integer`);
  return value;
};

// Validate the optional `escrow` body field carried on claim creation.
// Returns a frozen normalized input, or null when the caller passed nothing
// (the legacy create path). evaluatorCount < 2 is refused: a one-evaluator
// round is the ACP self-evaluation griefing hole (lane-2 failure #1).
export function escrowInputOf(value) {
  if (value === undefined || value === null) return null;
  check(value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid_escrow_input", "escrow must be an object");
  const budgetUnits = intOf(value.budgetUnits, "escrow.budgetUnits");
  check(budgetUnits > 0 && budgetUnits <= MAX_BUDGET_UNITS,
    "invalid_escrow_input", `escrow.budgetUnits must be 1..${MAX_BUDGET_UNITS}`);
  check(value.evaluatorCount !== undefined, "invalid_escrow_input", "escrow.evaluatorCount is required");
  const evaluatorCount = intOf(value.evaluatorCount, "escrow.evaluatorCount");
  check(evaluatorCount >= MIN_EVALUATORS && evaluatorCount <= MAX_EVALUATORS,
    "invalid_escrow_input", `escrow.evaluatorCount must be ${MIN_EVALUATORS}..${MAX_EVALUATORS}`);
  const evaluatorFeeBps = value.evaluatorFeeBps === undefined
    ? DEFAULT_EVALUATOR_FEE_BPS : intOf(value.evaluatorFeeBps, "escrow.evaluatorFeeBps");
  const platformFeeBps = value.platformFeeBps === undefined
    ? DEFAULT_PLATFORM_FEE_BPS : intOf(value.platformFeeBps, "escrow.platformFeeBps");
  for (const [name, bps] of [["escrow.evaluatorFeeBps", evaluatorFeeBps], ["escrow.platformFeeBps", platformFeeBps]]) {
    check(bps >= 0 && bps <= MAX_FEE_BPS, "invalid_escrow_input", `${name} must be 0..${MAX_FEE_BPS}`);
  }
  check(evaluatorFeeBps + platformFeeBps <= MAX_FEE_BPS,
    "invalid_escrow_input", "escrow fees must total at most 100%");
  const expiresInMs = value.expiresInMs === undefined || value.expiresInMs === null
    ? null : intOf(value.expiresInMs, "escrow.expiresInMs");
  if (expiresInMs !== null) check(expiresInMs > 0, "invalid_escrow_input", "escrow.expiresInMs must be positive");
  return Object.freeze({ budgetUnits, evaluatorCount, evaluatorFeeBps, platformFeeBps, expiresInMs });
}

const escrowOf = item => {
  const escrow = item?.escrow ?? null;
  if (escrow === null || escrow === undefined) return null;
  check(escrow !== null && typeof escrow === "object" && !Array.isArray(escrow),
    "invalid_escrow_input", "claim escrow must be an object");
  check(ESCROW_STATUSES.includes(escrow.status), "invalid_escrow_input",
    `claim escrow.status must be one of ${ESCROW_STATUSES.join(", ")}`);
  return escrow;
};

// Project the ACP ladder status for a claim. Legacy claims (no escrow
// field) report "none". Terminal statuses must agree with the claim
// machine: released only on done, refunded only on unclaimed — a mismatch
// is a corrupt half-applied settlement and fails closed.
export function escrowStatusOf(item) {
  const escrow = escrowOf(item);
  if (!escrow) return "none";
  if (escrow.status === "released") {
    check(item.state === "done", "escrow_state_mismatch",
      `escrow is released but claim "${item.id}" is ${item.state}, not done`);
  }
  if (escrow.status === "refunded") {
    check(item.state === "unclaimed", "escrow_state_mismatch",
      `escrow is refunded but claim "${item.id}" is ${item.state}, not unclaimed`);
  }
  return escrow.status;
}

const journalEntry = ({ at, kind, claimId, actor, units, note }) => Object.freeze({
  at, kind, claimId, actor: actor ?? null, units, note: note ?? null,
});

// Attach an escrow offer at claim creation (ACP REQUEST). The budget is
// encumbered, not locked: nothing moves until a worker takes the lease.
// A null input is the legacy create path — the item is returned unchanged.
export function offerEscrow(item, input, { actorId = null, now = Date.now() } = {}) {
  const validated = escrowInputOf(input);
  if (!validated) return { item, journal: Object.freeze([]) };
  check(item?.state === "unclaimed", "invalid_escrow_input",
    `escrow can only be offered on unclaimed work (claim "${item?.id}" is ${item?.state})`);
  check(escrowStatusOf(item) === "none", "escrow_already_offered",
    `claim "${item.id}" already carries escrow`);
  const at = isoOf(now);
  const escrow = Object.freeze({ status: "offered",
    budgetUnits: validated.budgetUnits, evaluatorCount: validated.evaluatorCount,
    evaluatorFeeBps: validated.evaluatorFeeBps, platformFeeBps: validated.platformFeeBps,
    expiresInMs: validated.expiresInMs, offeredAt: at, offeredBy: actorId });
  const entry = journalEntry({ at, kind: "escrow_offered", claimId: item.id,
    actor: actorId, units: validated.budgetUnits,
    note: `budget ${validated.budgetUnits} units encumbered; ${validated.evaluatorCount} evaluators` });
  return { item: Object.freeze({ ...item, escrow }), journal: Object.freeze([entry]) };
}

// Fund the escrow at lease acquisition (ACP TRANSACTION). Called after the
// claim route's claimWork succeeds; the worker's lease IS the escrow lock
// window (expiry is the only liveness primitive). Single-shot and
// worker-bound: replays and foreign workers fail closed.
export function lockEscrowOnClaim(item, workerId, { now = Date.now() } = {}) {
  check(typeof workerId === "string" && workerId.length > 0, "invalid_escrow_input", "workerId is required");
  const escrow = escrowOf(item);
  check(escrow && escrow.status === "offered", "escrow_not_offered",
    `claim "${item?.id}" has no offered escrow to fund`);
  check(item.state === "claimed", "invalid_escrow_input",
    `escrow funds only on a claimed lease (claim "${item.id}" is ${item.state})`);
  check(item.owner === workerId, "escrow_not_owner",
    `escrow funder must hold the lease (claim "${item.id}" is owned by ${item.owner ?? "nobody"})`);
  const at = isoOf(now);
  const next = Object.freeze({ ...escrow, status: "funded", fundedAt: at, fundedBy: workerId });
  const entry = journalEntry({ at, kind: "escrow_funded", claimId: item.id,
    actor: workerId, units: escrow.budgetUnits, note: `budget locked for lease held by ${workerId}` });
  return { item: Object.freeze({ ...item, escrow: next }), journal: Object.freeze([entry]) };
}

// Seat the evaluator verdict round (ACP EVALUATION begins). Pins the round
// id on the escrow block so the done-transition gate only accepts this
// round's tally — a stale or foreign round cannot close the claim.
export function seatEvaluation(item, roundId, { now = Date.now() } = {}) {
  check(typeof roundId === "string" && roundId.length > 0 && roundId.length <= 128,
    "invalid_escrow_input", "roundId must be a 1..128 character id");
  const escrow = escrowOf(item);
  check(escrow && (escrow.status === "funded" || escrow.status === "locked"), "escrow_not_active",
    `claim "${item?.id}" has no fundable escrow to evaluate`);
  const at = isoOf(now);
  const next = Object.freeze({ ...escrow, status: "evaluating", roundId, evaluatingAt: at });
  const entry = journalEntry({ at, kind: "escrow_evaluating", claimId: item.id,
    actor: item.owner ?? null, units: escrow.budgetUnits, note: `verdict round ${roundId} seated` });
  return { item: Object.freeze({ ...item, escrow: next }), journal: Object.freeze([entry]) };
}

const tallyOf = tally => {
  check(tally !== null && typeof tally === "object" && !Array.isArray(tally),
    "invalid_escrow_input", "tally must be an object");
  const approvals = intOf(tally.approvals, "tally.approvals");
  const quorum = intOf(tally.quorum, "tally.quorum");
  check(approvals >= 0 && quorum >= 1, "invalid_escrow_input", "tally needs approvals >= 0 and quorum >= 1");
  check(typeof tally.roundId === "string" && tally.roundId.length > 0,
    "invalid_escrow_input", "tally.roundId is required");
  return { approvals, quorum, roundId: tally.roundId };
};

// The done-transition gate (shadow in P0, enforcing in P1). Legacy claims
// always pass — the gate only exists for escrow-backed work. An escrow claim
// closes only from the evaluating state, on the seated round's quorum of
// approvals; anything else (no round seated, below quorum, foreign round,
// missing tally) refuses.
export function verdictGate(item, tally) {
  const escrow = escrowOf(item);
  if (!escrow) return true;
  if (escrow.status !== "evaluating") return false;
  let parsed;
  try { parsed = tallyOf(tally); } catch { return false; }
  if (!escrow.roundId || parsed.roundId !== escrow.roundId) return false;
  return parsed.approvals >= parsed.quorum;
}

// Extend the PR-settlement flow: consume the settlePullRequest output and
// return the escrow settlement. Merged releases the split (provider
// remainder + evaluator fee + platform fee, integer math, remainder to the
// provider so the legs always sum to the budget). Closed refunds the client
// in full — the mirror of the claim's own closed->unclaimed release.
// Returns null when the claim carries no escrow (legacy path untouched).
export function settleEscrowFromPull(settlement, { now = Date.now() } = {}) {
  const item = settlement?.item ?? null;
  const status = escrowStatusOf(item);
  if (status === "none") return null;
  const action = settlement?.action;
  check(action === "pr_merged" || action === "pr_closed", "invalid_escrow_input",
    `settleEscrowFromPull needs a pr_merged/pr_closed settlement, got ${action}`);
  const escrow = escrowOf(item);
  check(ACTIVE_STATUSES.has(escrow.status), "escrow_not_active",
    `claim "${item.id}" escrow is ${escrow.status} — nothing to settle`);
  const at = isoOf(now);
  if (action === "pr_merged") {
    // Integer-only fee math: each fee is floored, the provider takes the
    // remainder, so provider + evaluator + platform === budgetUnits always.
    const evaluator = Math.floor(escrow.budgetUnits * escrow.evaluatorFeeBps / MAX_FEE_BPS);
    const platform = Math.floor(escrow.budgetUnits * escrow.platformFeeBps / MAX_FEE_BPS);
    const provider = escrow.budgetUnits - evaluator - platform;
    const split = Object.freeze({ provider, evaluator, platform });
    const next = Object.freeze({ ...escrow, status: "released", releasedAt: at, split });
    const legs = [
      ["escrow_released_provider", item.owner ?? null, provider, `release ${provider} units to provider`],
      ["escrow_released_evaluator", null, evaluator, `release ${evaluator} units evaluator fee`],
      ["escrow_released_platform", null, platform, `release ${platform} units platform fee`],
    ].map(([kind, actor, units, note]) => journalEntry({ at, kind, claimId: item.id, actor, units, note }));
    return { item: Object.freeze({ ...item, escrow: next }), journal: Object.freeze(legs) };
  }
  const next = Object.freeze({ ...escrow, status: "refunded", refundedAt: at, refundReason: "pr_closed" });
  const entry = journalEntry({ at, kind: "escrow_refunded", claimId: item.id,
    actor: escrow.offeredBy ?? null, units: escrow.budgetUnits,
    note: `pull request closed unmerged — refund ${escrow.budgetUnits} units to client` });
  return { item: Object.freeze({ ...item, escrow: next }), journal: Object.freeze([entry]) };
}

// Refund on lease expiry (ACP EXPIRED): the sweep's onRelease hook calls
// this for the released claim. Only active escrow refunds; legacy and
// already-settled claims return null. Expiry is the only liveness
// primitive — every stall ends here, never in a locked-forever state.
export function refundEscrowOnExpiry(item, { now = Date.now() } = {}) {
  const status = escrowStatusOf(item);
  if (status === "none" || TERMINAL_STATUSES.has(status)) return null;
  const escrow = escrowOf(item);
  const at = isoOf(now);
  const next = Object.freeze({ ...escrow, status: "refunded", refundedAt: at, refundReason: "expired" });
  const entry = journalEntry({ at, kind: "escrow_refunded", claimId: item.id,
    actor: escrow.offeredBy ?? null, units: escrow.budgetUnits,
    note: `lease expired — refund ${escrow.budgetUnits} units to client` });
  return { item: Object.freeze({ ...item, escrow: next }), journal: Object.freeze([entry]) };
}

// Receipt tags for the done transition: the receipts surface already
// indexes tags/blobs, so settlement records ride the existing fields.
export function receiptTagsFor(item) {
  const status = escrowStatusOf(item);
  if (status === "released") return Object.freeze(["escrow:settled"]);
  if (status === "refunded") return Object.freeze(["escrow:refunded"]);
  return Object.freeze([]);
}
