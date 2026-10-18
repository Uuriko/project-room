// Reference model of the bounty escrow machine, post-#3726 transition
// table — the "real" side's oracle for tests/bounty-escrow-stateful.test.js
// and the fixture base for tests/bounty-escrow-differ.test.js (F-32 / C-5).
//
// The model is written from the transition tables and settlement code in
// server/bounty-escrow.mjs at the base SHA named in the harness header,
// cross-checked against the adjudicated semantics of the 2026-10-15
// differential-escrow run (21 divergence classes; D1-D24). It is a
// milli-credit ledger + lifecycle machine over the same public module API
// the harness drives (post/fund/claim/submit/accept/reject/dispute/decide/
// finalize/closeEpoch/transfer). It deliberately does NOT model:
//   - the reputation band projection (server/bounty-reputation.mjs): the
//     generator caps amounts at the 5-credit probation ceiling, so the
//     probation claim cap can never bind and bands cannot affect any op
//     in the command space;
//   - receipts, events, rubric pins, sybil packets: none of them move
//     money or bounty state;
//   - snooze/decline-reason text, watchers: state-only surfaces the
//     snapshot does not compare.
//
// Options { legacy3726, legacy3727 } resurrect the pre-fix shapes as
// differ fixtures ONLY (see the differ test): legacy3726 admits the
// submitted -> disputed edge and lets a release ruling vest the award out
// of the poster's lock; legacy3727 lets a dispute open with an empty
// decider seat. Neither option is ever used against the real machine.

export const LANES = Object.freeze([
  "id:agent/jill",     // poster lane
  "id:agent/grokbot",  // worker lane
  "id:agent/instinct", // verifier / decider lane
  "id:agent/codex",    // challenger lane
]);
export const [POSTER, WORKER, VERIFIER, CHALLENGER] = LANES;
export const POOL = "pool";

export const GENESIS_MILLIS = 100_000;
export const CLAIM_BOND_MILLIS = 1_000;
export const FLAKE_DECAY_MS = 30 * 24 * 3600 * 1000;
export const FLAKE_COOLDOWN_MS = 7 * 24 * 3600 * 1000;
export const DISPUTE_TIMEOUT_MS = 14 * 24 * 3600 * 1000;
export const CHALLENGE_WINDOW_SMALL_MS = 24 * 3600 * 1000;
export const CHALLENGE_WINDOW_MS = 3 * 24 * 3600 * 1000;

// The post-#3726 transition table, transcribed from STATE_TRANSITION_TRACK
// in server/bounty-escrow.mjs (base). "submitted" has NO disputed edge.
export const TRANSITIONS = Object.freeze({
  proposed: Object.freeze(["funded", "cancelled"]),
  funded: Object.freeze(["claimed", "refunded"]),
  claimed: Object.freeze(["submitted", "refunded"]),
  submitted: Object.freeze(["accepted", "refunded"]),
  accepted: Object.freeze(["approved", "disputed"]),
  disputed: Object.freeze(["approved", "refunded"]),
  approved: Object.freeze(["paid"]),
  paid: Object.freeze([]),
  refunded: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export const OUTCOMES = Object.freeze(["upheld", "rejected", "split", "frivolous"]);
export const REASON_CODES = Object.freeze([
  "receipt-incomplete", "criterion-unmet", "evidence-insufficient",
  "duplicate-work", "identity-mismatch", "frivolous",
  "verifier-conflict", "no-arbitrator",
]);

const ok = () => ({ ok: true });
const refuse = (code) => ({ ok: false, code });
const emptyLots = () => ({ payable: 0, locked: 0, attributed: 0, approved: 0 });

export class EscrowModel {
  constructor({ now = 0, legacy3726 = false, legacy3727 = false } = {}) {
    this.now = now;
    this.legacy3726 = legacy3726;
    this.legacy3727 = legacy3727;
    this.accounts = new Map();
    for (const lane of LANES) this.accounts.set(lane, { ...emptyLots(), payable: GENESIS_MILLIS });
    this.accounts.set(POOL, emptyLots());
    this.bounties = []; // index-addressed, mirroring the harness's real ids
    this.strikes = new Map(LANES.map((lane) => [lane, []]));
  }

  account(lane) { return this.accounts.get(lane); }

  move(fromLane, fromLot, toLane, toLot, millis) {
    if (millis <= 0) return;
    this.account(fromLane)[fromLot] -= millis;
    this.account(toLane)[toLot] += millis;
  }

  strikesAt(lane, now = this.now) {
    return this.strikes.get(lane).filter((ms) => ms > now - FLAKE_DECAY_MS);
  }

  flake(lane) {
    const live = this.strikesAt(lane);
    const rung = Math.min(live.length, 3);
    const latest = live.length ? Math.max(...live) : null;
    const cooldownUntilMs = rung >= 3 && latest !== null ? latest + FLAKE_COOLDOWN_MS : null;
    return {
      strikes: live.length, rung,
      bondMultiplier: rung >= 2 ? 2 : 1,
      cooldownUntilMs: cooldownUntilMs !== null && this.now < cooldownUntilMs ? cooldownUntilMs : null,
    };
  }

  addStrike(lane) { this.strikes.get(lane).push(this.now); }

  bounty(index) { return this.bounties[index] ?? null; }

  // The claim bond actually locked for this bounty returns or forfeits
  // exactly once, at settlement.
  settleClaimBond(b, forfeit) {
    if (!b.claimant || b.claimBondMillis <= 0) return;
    this.move(b.claimant, "locked", forfeit ? POOL : b.claimant, "payable", b.claimBondMillis);
    b.claimBondMillis = 0;
  }

  post({ poster, verifier = null, decider = null, amountMillis, deadlineMs }) {
    if (!Number.isInteger(amountMillis) || amountMillis < 1 || amountMillis > 1_000_000_000)
      return refuse("invalid_amount");
    if (!Number.isFinite(deadlineMs) || deadlineMs <= this.now) return refuse("invalid_input");
    if (verifier !== null && (verifier === poster || !LANES.includes(verifier))) return refuse("invalid_input");
    if (decider !== null && (decider === poster || !LANES.includes(decider))) return refuse("invalid_input");
    this.bounties.push({
      poster, verifier, deciderName: decider, amountMillis,
      state: "proposed", claimant: null, deadlineMs,
      challengeEndsMs: null, disputeOpenedMs: null, dispute: null,
      claimBondMillis: 0, everAccepted: false, resolutionKind: null,
      settled: false, // a free-miss settlement record exists (reject replays)
      vestedMillis: 0, // this bounty's share of the claimant's approved lot
    });
    return ok();
  }

  fund(index, actor) {
    const b = this.bounty(index); if (!b) return refuse("unknown_bounty");
    if (b.state !== "proposed") return refuse("invalid_state");
    if (actor !== b.poster) return refuse("not_authorized");
    if (this.account(b.poster).payable < b.amountMillis) return refuse("insufficient_funds");
    this.move(b.poster, "payable", b.poster, "locked", b.amountMillis);
    b.state = "funded";
    return ok();
  }

  decline(index, actor) {
    const b = this.bounty(index); if (!b) return refuse("unknown_bounty");
    if (b.state !== "proposed") return refuse("invalid_state");
    if (actor !== b.poster) return refuse("not_authorized");
    b.state = "cancelled"; b.resolutionKind = "declined";
    return ok();
  }

  claim(index, claimant) {
    const b = this.bounty(index); if (!b) return refuse("unknown_bounty");
    if (claimant === b.poster) return refuse("not_authorized");
    if (b.state === "claimed") return refuse("already_claimed");
    if (b.state !== "funded") return refuse("invalid_state");
    if (!(this.now < b.deadlineMs)) return refuse("invalid_state");
    const flake = this.flake(claimant);
    if (flake.cooldownUntilMs !== null) return refuse("claim_cooldown");
    const bond = CLAIM_BOND_MILLIS * flake.bondMultiplier;
    if (this.account(claimant).payable < bond) return refuse("insufficient_funds");
    this.move(claimant, "payable", claimant, "locked", bond);
    b.claimant = claimant; b.claimBondMillis = bond; b.state = "claimed";
    return ok();
  }

  submit(index, claimant) {
    const b = this.bounty(index); if (!b) return refuse("unknown_bounty");
    if (b.state !== "claimed") return refuse("invalid_state");
    if (b.claimant !== claimant) return refuse("not_authorized");
    if (!(this.now < b.deadlineMs)) return refuse("invalid_state");
    b.state = "submitted";
    return ok();
  }

  accept(index, acceptor) {
    const b = this.bounty(index); if (!b) return refuse("unknown_bounty");
    if (b.state !== "submitted") return refuse("invalid_state");
    if (acceptor !== b.poster) return refuse("not_authorized"); // human mode: poster only
    if (acceptor === b.claimant) return refuse("not_authorized");
    this.move(b.poster, "locked", b.claimant, "attributed", b.amountMillis);
    b.state = "accepted"; b.everAccepted = true;
    b.challengeEndsMs = this.now + (b.amountMillis < 1000 ? CHALLENGE_WINDOW_SMALL_MS : CHALLENGE_WINDOW_MS);
    return ok();
  }

  reject(index, rejector) {
    const b = this.bounty(index); if (!b) return refuse("unknown_bounty");
    if (rejector !== b.poster) return refuse("not_authorized");
    if (rejector === b.claimant) return refuse("not_authorized");
    // Idempotent replay: ANY bounty with a settlement record (rejected,
    // unverified, timeout, dispute-settled, swept) returns its verdict
    // with no new movement — authorization still precedes the replay.
    if (b.settled) return ok();
    if (b.state !== "submitted") return refuse("invalid_state");
    this.move(b.poster, "locked", b.poster, "payable", b.amountMillis);
    this.addStrike(b.claimant);
    this.settleClaimBond(b, true);
    b.state = "refunded"; b.resolutionKind = "rejected"; b.settled = true;
    return ok();
  }

  dispute(index, challenger, bondMillis) {
    const b = this.bounty(index); if (!b) return refuse("unknown_bounty");
    if (b.dispute) return refuse("dispute_exists");
    // #3726 (Option A): disputes open only on accepted work. The legacy
    // fixture admits the submitted edge the fix removed.
    const openable = b.state === "accepted" || (this.legacy3726 && b.state === "submitted");
    if (!openable) return refuse("invalid_state");
    if (b.challengeEndsMs !== null && this.now >= b.challengeEndsMs) return refuse("invalid_state");
    if (challenger === b.claimant) return refuse("not_authorized");
    if (!Number.isInteger(bondMillis) || bondMillis < 1 || bondMillis > 1_000_000_000)
      return refuse("invalid_amount");
    const required = Math.ceil(b.amountMillis * 0.25);
    if (bondMillis !== required) return refuse("invalid_bond");
    // Seat-or-refuse (#3727): the designated decider (disputeDecider ??
    // verifier) must exist and be independent of claimant and challenger.
    const designated = b.deciderName ?? b.verifier;
    let decider = null;
    if (this.legacy3727) {
      decider = designated; // pre-fix: the seat was allowed to stay empty
    } else {
      if (designated === null || designated === b.claimant || designated === challenger)
        return refuse("dispute_unavailable");
      decider = designated;
    }
    if (this.account(challenger).payable < bondMillis) return refuse("insufficient_funds");
    this.move(challenger, "payable", challenger, "locked", bondMillis);
    b.dispute = { challenger, bondMillis, decider, fromSubmitted: b.state === "submitted" };
    b.disputeOpenedMs = this.now;
    b.state = "disputed";
    return ok();
  }

  decide(index, decider, outcome, reasonCodes = ["criterion-unmet"]) {
    const b = this.bounty(index); if (!b) return refuse("unknown_bounty");
    if (b.state !== "disputed" || !b.dispute) return refuse("invalid_state");
    if (b.dispute.decider !== decider) return refuse("not_authorized");
    if (b.dispute.challenger === decider) return refuse("not_authorized");
    // The dispute machine validates outcome, then the closed reason-code
    // set; both surface at the escrow boundary as invalid_input.
    if (!OUTCOMES.includes(outcome)) return refuse("invalid_input");
    if (!Array.isArray(reasonCodes) || reasonCodes.length === 0
        || reasonCodes.some((code) => !REASON_CODES.includes(code))) return refuse("invalid_input");
    this.settleDispute(b, outcome, "decided");
    return ok();
  }

  // Shared settlement for decide + keeper timeout. `terminal` is
  // "decided" | "timeout". Money legs per _settleDispute at base.
  settleDispute(b, outcome, terminal) {
    const d = b.dispute;
    const amount = b.amountMillis;
    const worker = b.claimant;
    const fromSubmitted = d.fromSubmitted === true;
    if (outcome === "upheld") {
      // CANCEL: award refunds to the poster (from the attributed lot, or
      // from the poster's lock for a legacy from-submitted dispute),
      // challenger bond returns, claim bond forfeits to the pool, strike.
      if (fromSubmitted) this.move(b.poster, "locked", b.poster, "payable", amount);
      else this.move(worker, "attributed", b.poster, "payable", amount);
      this.move(d.challenger, "locked", d.challenger, "payable", d.bondMillis);
      this.settleClaimBond(b, true);
      if (worker) this.addStrike(worker);
      b.state = "refunded"; b.resolutionKind = "cancel";
    } else if (outcome === "split") {
      const workerHalf = Math.floor(amount / 2), posterHalf = amount - workerHalf;
      if (fromSubmitted) this.move(b.poster, "locked", worker, "attributed", amount);
      if (workerHalf > 0) this.move(worker, "attributed", worker, "approved", workerHalf);
      b.vestedMillis = workerHalf;
      this.move(worker, "attributed", b.poster, "payable", posterHalf);
      this.move(d.challenger, "locked", d.challenger, "payable", d.bondMillis);
      b.state = "approved"; b.resolutionKind = "split";
    } else {
      // RELEASE (rejected / frivolous / timeout-default): the award vests.
      if (fromSubmitted) this.move(b.poster, "locked", worker, "attributed", amount);
      this.move(worker, "attributed", worker, "approved", amount);
      b.vestedMillis = amount;
      if (terminal === "timeout" && !d.decider) {
        // #3727 legacy row: undecidable from the start — bond comes home.
        this.move(d.challenger, "locked", d.challenger, "payable", d.bondMillis);
      } else if (outcome === "frivolous" || terminal === "timeout") {
        // Frivolous forfeits to the pool; a timeout default is a
        // no-verdict settlement and follows the forfeiture precedent
        // (#3702: compensating the claimant made an undecidable dispute
        // a money pump).
        this.move(d.challenger, "locked", POOL, "payable", d.bondMillis);
      } else {
        // Decided release: the bond compensates the worker for the delay.
        this.move(d.challenger, "locked", worker, "payable", d.bondMillis);
      }
      b.state = "approved"; b.resolutionKind = "release";
    }
    b.dispute = null; b.disputeOpenedMs = null; b.settled = true;
  }

  keeperPass(b) {
    const now = this.now;
    if (b.state === "proposed" && now >= b.deadlineMs) {
      b.state = "cancelled"; b.resolutionKind = "expired-unfunded";
      return "expired-unfunded";
    }
    if (b.state === "accepted" && b.challengeEndsMs !== null && now >= b.challengeEndsMs) {
      this.move(b.claimant, "attributed", b.claimant, "approved", b.amountMillis);
      b.vestedMillis = b.amountMillis;
      b.state = "approved"; b.resolutionKind = "auto-approve";
      return "approved";
    }
    if (b.state === "submitted" && now >= b.deadlineMs) {
      // Free-miss: submitted on time, never verified — bond returns.
      this.move(b.poster, "locked", b.poster, "payable", b.amountMillis);
      this.settleClaimBond(b, false);
      b.state = "refunded"; b.resolutionKind = "unverified"; b.settled = true;
      return "refunded";
    }
    if ((b.state === "funded" || b.state === "claimed") && now >= b.deadlineMs) {
      this.move(b.poster, "locked", b.poster, "payable", b.amountMillis);
      if (b.state === "claimed" && b.claimant) {
        this.addStrike(b.claimant);
        this.settleClaimBond(b, true);
      }
      b.state = "refunded"; b.resolutionKind = "timeout"; b.settled = true;
      return "refunded";
    }
    if (b.state === "disputed" && b.dispute && b.disputeOpenedMs !== null
        && now - b.disputeOpenedMs > DISPUTE_TIMEOUT_MS) {
      this.settleDispute(b, "timeout-default", "timeout");
      return "released";
    }
    return null;
  }

  finalize(index) {
    const b = this.bounty(index); if (!b) return refuse("unknown_bounty");
    const action = this.keeperPass(b);
    if (action === null) return refuse("invalid_state");
    return { ok: true, action };
  }

  closeEpoch() {
    // Rows are snapshotted first: a bounty approved by this pass is NOT
    // swept until a later epoch (differ D12).
    const snapshot = this.bounties.map((b, i) => [b, b.state, i]);
    for (const [b, stateAtStart] of snapshot) {
      if (stateAtStart === "approved") this.sweep(b);
      else if (["proposed", "funded", "claimed", "accepted", "disputed"].includes(stateAtStart))
        this.keeperPass(b);
    }
    return ok();
  }

  sweep(b) {
    // Sweep what THIS bounty vested (a split leaves only the worker's
    // half); the account-level approved lot is the sum over bounties.
    const approvedMillis = b.vestedMillis;
    const fee = Math.floor(approvedMillis * 1 / 100);
    const earner = approvedMillis - fee;
    if (approvedMillis > 0) {
      this.move(b.claimant, "approved", b.claimant, "payable", earner);
      if (fee > 0) this.move(b.claimant, "approved", POOL, "payable", fee);
    }
    b.vestedMillis = 0;
    this.settleClaimBond(b, false);
    b.state = "paid"; b.settled = true;
    return { paidMillis: earner, feeMillis: fee };
  }

  transfer(from, to, amountMillis) {
    // Order mirrors transfer(): recipient gate (pool is escrow-internal),
    // then self-transfer, then amount, then payable.
    if (to === POOL) return refuse("not_authorized");
    if (from === to) return refuse("invalid_input");
    if (!Number.isInteger(amountMillis) || amountMillis < 1 || amountMillis > 1_000_000_000)
      return refuse("invalid_amount");
    if (this.account(from).payable < amountMillis) return refuse("insufficient_funds");
    this.move(from, "payable", to, "payable", amountMillis);
    return ok();
  }

  tick(ms) { this.now += ms; return ok(); }

  snapshot() {
    const accounts = {};
    for (const [lane, lots] of this.accounts) accounts[lane] = { ...lots };
    return {
      accounts,
      bounties: this.bounties.map((b) => ({
        state: b.state, claimant: b.claimant, poster: b.poster,
        disputeOpen: b.dispute !== null,
        decider: b.dispute ? b.dispute.decider : undefined,
        challenger: b.dispute ? b.dispute.challenger : undefined,
        everAccepted: b.everAccepted,
      })),
      strikes: Object.fromEntries(LANES.map((lane) => [lane, this.strikesAt(lane).length])),
    };
  }
}

// --- invariants (D-1 history-invariant form) ---------------------------------
// Checked after EVERY op, on a snapshot of the shape EscrowModel.snapshot()
// produces (the harness adapts the real machine's reads to the same shape).
// Returns a list of violation strings; empty = the history is legal.
//
//   I1 conservation: every milli-credit is in exactly one lot; the total
//      across all lanes + pool is the genesis total, forever.
//   I2 non-negative lots: no lot of any account is ever negative.
//   I3 HISTORY (the #3726 invariant): a bounty in `approved` or `paid`
//      has everAccepted === true. `approved`/`paid` are legal states by
//      legal-looking paths (dispute release, epoch sweep), so only the
//      history flag can say the vesting was gated on an acceptance.
//   I4 dispute seat (#3727): a bounty with an open dispute has a seated
//      decider who is a room lane, distinct from claimant and challenger.
//      (The snapshot carries the open dispute's decider + parties via the
//      harness adapter; the model snapshot sets `decider` the same way.)
//   I5 transition legality: the CURRENT state is one of BOUNTY_STATES and,
//      when the previous snapshot is supplied, the state pair is an edge
//      of the post-#3726 table (or a self-loop: most ops do not move a
//      given bounty).
export const BOUNTY_STATES = Object.freeze([
  "proposed", "funded", "claimed", "submitted", "accepted", "disputed",
  "approved", "paid", "refunded", "cancelled",
]);

export function checkInvariants(snapshot, previous = null) {
  const violations = [];
  let total = 0;
  for (const [lane, lots] of Object.entries(snapshot.accounts)) {
    for (const [lot, millis] of Object.entries(lots)) {
      total += millis;
      if (!(millis >= 0)) violations.push(`I2: ${lane}.${lot} is ${millis}`);
    }
  }
  const expected = GENESIS_MILLIS * LANES.length;
  if (total !== expected) violations.push(`I1: total ${total} != genesis ${expected}`);
  snapshot.bounties.forEach((b, i) => {
    if (!BOUNTY_STATES.includes(b.state)) violations.push(`I5: bounty ${i} in unknown state ${b.state}`);
    if ((b.state === "approved" || b.state === "paid") && b.everAccepted !== true)
      violations.push(`I3: bounty ${i} reached ${b.state} without acceptance (everAccepted=false)`);
    if (b.disputeOpen === true) {
      if (!b.decider || !LANES.includes(b.decider))
        violations.push(`I4: bounty ${i} has an open dispute with no seated decider`);
      else {
        if (b.decider === b.claimant) violations.push(`I4: bounty ${i} decider is the claimant`);
        if (b.decider === b.challenger) violations.push(`I4: bounty ${i} decider is the challenger`);
      }
    }
    if (previous) {
      const before = previous.bounties[i];
      if (before && before.state !== b.state
          && !(TRANSITIONS[before.state] ?? []).includes(b.state))
        violations.push(`I5: bounty ${i} moved ${before.state} -> ${b.state}, not an edge of the post-#3726 table`);
    }
  });
  return violations;
}
