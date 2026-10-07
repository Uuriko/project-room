// Escrow dispute + appeals layer (lane 12, acp-build-disputes).
//
// Lane 9's escrow machine (server/escrow.mjs, PR #1785) settles a dispute on
// a SINGLE arbiter's signature (disputed --resolveDispute--> resolved is
// terminal) and its dispute() is free -- no stake. That reproduces ACP's two
// dispute holes: the dispute path is a gratis griefing API, and one
// signature is final with no appeal. This module owns what the machine
// leaves out, without editing it:
//
//   - dispute bonds: openDispute requires exactly 25% of the escrow amount
//     (DISPUTE_BOND_RATIO, the server/bounty-escrow.mjs precedent) BEFORE
//     the machine's dispute() is called, so a failed bond check mutates
//     nothing. Appeal requires exactly 2x (loser-pays escalation).
//   - appeals: the arbiter's ruling opens an appeal window; the aggrieved
//     party may appeal to a second independent 3-seat panel, majority
//     rules, exactly one escalation, then terminal.
//   - finality: every path ends in exactly one onDisputeFinalized
//     directive carrying finalOutcome, the overturn flag, and bond
//     movements. The machine's `resolved` is NOT the dispute's final --
//     when a panel overturns the arbiter, the settlement layer honors
//     this module's directive.
//
// The module records decisions; it never moves value. Bond movements are
// emitted as instructions for the ledger (custody != state). All amounts
// are abstract paper units -- no chain, no wallet, no mainnet. Real value
// movement needs John's explicit tap and stops at this design line.
//
// KNOWN GAP (lane 9): the machine has no stall transition out of
// `disputed`. resolveStalled() finalizes the dispute with the conservative
// default (refund -- funds return to the payer, matching the machine's own
// sweep bias), but the machine record still reads `disputed`. Until lane 9
// adds the transition, the settlement layer must honor this module's
// directive over the machine's raw state for stalled disputes.
//
// Pure and dependency-free except REASON_CODES (the room's dispute
// grammar, a pure constant import -- no cycle risk). All state is
// caller-owned (a Map); outputs are frozen; malformed inputs and illegal
// transitions throw EscrowDisputeError.
import { REASON_CODES } from "./bounty-disputes.mjs";

const DISPUTE_BOND_RATIO = 0.25; // tier-0: exactly 25% of the escrow amount
const APPEAL_BOND_RATIO = 0.5;   // tier-1: exactly 50% (2x the tier-0 bond)
const PANEL_SIZE = 3;
const OUTCOMES = Object.freeze(["release", "refund"]);
const DISPUTEABLE = new Set(["funded", "in_evaluation"]); // the machine's set
const STATES = Object.freeze(["disputed", "ruled", "appealed", "final"]);
const TERMINAL = new Set(["final"]);

class EscrowDisputeError extends Error {
  constructor(code, message) { super(message); this.name = "EscrowDisputeError"; this.code = code; }
}
const fail = (code, message) => { throw new EscrowDisputeError(code, message); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };
const nonEmptyString = (v, what, max = 2000) =>
  check(typeof v === "string" && v.length > 0 && v.length <= max,
    "invalid_dispute", `${what} must be 1..${max} characters`);
const isoOf = ms => new Date(ms).toISOString();
const validReasonCodes = codes => {
  check(Array.isArray(codes) && codes.length > 0 && codes.length <= 10,
    "invalid_dispute", "reasonCodes must be a non-empty array of at most 10 codes");
  for (const code of codes)
    check(REASON_CODES.includes(code), "invalid_dispute", `unknown reason code "${code}"`);
  return Object.freeze([...codes]);
};

export function createEscrowDisputes({
  escrows, store, onDisputeOpened, onDisputeFinalized,
  appealWindowMs = 24 * 3600 * 1000,
  disputeTimeoutMs = 14 * 24 * 3600 * 1000,
  disputeBondRatio = DISPUTE_BOND_RATIO,
  appealBondRatio = APPEAL_BOND_RATIO,
  nowMs = () => Date.now(),
} = {}) {
  check(escrows && typeof escrows.get === "function"
    && typeof escrows.dispute === "function" && typeof escrows.resolveDispute === "function",
    "invalid_dispute", "escrows must expose get/dispute/resolveDispute (lane-9 machine)");
  check(store === undefined || store instanceof Map, "invalid_dispute", "store must be a Map if given");
  for (const [hook, name] of [[onDisputeOpened, "onDisputeOpened"], [onDisputeFinalized, "onDisputeFinalized"]])
    check(hook === undefined || typeof hook === "function", "invalid_dispute", `${name} must be a function if given`);
  const disputes = store ?? new Map();

  const get = escrowId => {
    nonEmptyString(escrowId, "escrowId", 256);
    check(disputes.has(escrowId), "unknown_dispute", `no dispute for escrow "${escrowId}"`);
    return disputes.get(escrowId);
  };
  const set = record => disputes.set(record.escrowId, record);
  const requireState = (record, ...allowed) => {
    if (!allowed.includes(record.state))
      fail("invalid_transition", `dispute for "${record.escrowId}" cannot act in state ${record.state}`);
  };
  // What the disputer/appellant wanted: payer wants refund, payee wants release.
  const desiredOf = (record, party) =>
    party === record.payer ? "refund" : "release";

  const notifyOpened = record => {
    if (onDisputeOpened) onDisputeOpened(Object.freeze({
      escrowId: record.escrowId, disputeId: record.disputeId,
      evaluator: record.evaluator, payer: record.payer, payee: record.payee,
      amount: record.amount, raisedBy: record.raisedBy, reason: record.reason,
      openedAt: record.raisedAt,
    }));
  };
  const notifyFinalized = record => {
    if (record.notified) return record;
    const finalized = Object.freeze({ ...record, notified: true });
    set(finalized);
    if (onDisputeFinalized) onDisputeFinalized(Object.freeze({
      escrowId: finalized.escrowId, disputeId: finalized.disputeId,
      raisedBy: finalized.raisedBy,
      arbiterOutcome: finalized.arbiterRuling ? finalized.arbiterRuling.outcome : null,
      finalOutcome: finalized.finalOutcome, overturned: finalized.overturned,
      panelMajority: finalized.tier === 1, tier: finalized.tier,
      bondMovements: finalized.bondMovements, finalizedAt: finalized.finalizedAt,
    }));
    return finalized;
  };
  // Shared finalizer: every terminal path funnels through here, exactly once.
  const finalize = (record, { finalOutcome, overturned = false, bondMovements, tier }) => {
    check(!TERMINAL.has(record.state), "already_final", `dispute for "${record.escrowId}" is already final`);
    const final = Object.freeze({ ...record, state: "final", finalOutcome,
      overturned, bondMovements: Object.freeze(bondMovements), tier,
      finalizedAt: isoOf(nowMs()), notified: false });
    set(final);
    return notifyFinalized(final);
  };
  const forfeit = (party, amount, reason) =>
    Object.freeze({ party, amount, direction: "forfeit-to-pool", reason });
  const release = (party, amount, reason) =>
    Object.freeze({ party, amount, direction: "return-to-party", reason });

  // Open a dispute. The bond is validated BEFORE the machine is touched, so
  // a failed check mutates nothing. Standing (payer|payee) is pre-checked
  // here for a clean error; the machine re-enforces it as backstop.
  const openDispute = (escrowId, { by, bond, reason } = {}) => {
    nonEmptyString(escrowId, "escrowId", 256);
    nonEmptyString(by, "by", 256);
    nonEmptyString(reason, "reason");
    check(!disputes.has(escrowId), "dispute_exists", `escrow "${escrowId}" already has a dispute`);
    const escrow = escrows.get(escrowId);
    if (by !== escrow.payer && by !== escrow.payee)
      fail("not_authorized", `only the payer or payee may dispute escrow "${escrowId}"`);
    if (!DISPUTEABLE.has(escrow.state))
      fail("invalid_transition", `escrow "${escrowId}" is ${escrow.state}, not disputable`);
    const required = Math.ceil(escrow.amount * disputeBondRatio);
    check(bond === required, "bond_invalid",
      `dispute bond must be exactly ${required} (25% of the escrow amount)`);
    escrows.dispute(escrowId, { by, reason }); // machine: -> disputed (frozen)
    const record = Object.freeze({ disputeId: `dsp-${escrowId}`, escrowId,
      raisedBy: by, reason, payer: escrow.payer, payee: escrow.payee,
      evaluator: escrow.evaluator, amount: escrow.amount,
      bondSnapshot: required, raisedAt: isoOf(nowMs()), state: "disputed",
      arbiterRuling: null, appeal: null, appealWindowEndsAt: null,
      finalOutcome: null, overturned: false,
      bondMovements: Object.freeze([]), tier: 0, finalizedAt: null, notified: false });
    set(record);
    notifyOpened(record);
    return record;
  };

  // The designated arbiter rules. Calls the machine's resolveDispute (-> its
  // terminal `resolved`) and opens the appeal window. A frivolous ruling is
  // final immediately: no appeal as of right.
  const ruleDispute = (escrowId, { arbiter, outcome, reasonCodes, note } = {}) => {
    const record = get(escrowId);
    requireState(record, "disputed");
    nonEmptyString(arbiter, "arbiter", 256);
    nonEmptyString(note, "note");
    const escrow = escrows.get(escrowId);
    if (arbiter !== escrow.arbiter)
      fail("not_arbiter", `only the designated arbiter may rule on "${escrowId}"`);
    check(OUTCOMES.includes(outcome), "invalid_dispute",
      `outcome must be one of ${OUTCOMES.join(", ")}`);
    const codes = validReasonCodes(reasonCodes);
    escrows.resolveDispute(escrowId, { by: arbiter, outcome, note });
    const frivolous = codes.includes("frivolous");
    const ruledAt = isoOf(nowMs());
    if (frivolous)
      return finalize({ ...record,
        arbiterRuling: Object.freeze({ arbiter, outcome, reasonCodes: codes, note, ruledAt, frivolous: true }) },
        { finalOutcome: outcome, bondMovements: [forfeit(record.raisedBy, record.bondSnapshot, "frivolous")], tier: 0 });
    const ruled = Object.freeze({ ...record, state: "ruled",
      arbiterRuling: Object.freeze({ arbiter, outcome, reasonCodes: codes, note, ruledAt, frivolous: false }),
      appealWindowEndsAt: isoOf(nowMs() + appealWindowMs) });
    set(ruled);
    return ruled;
  };

  // Appeal the arbiter's ruling to a second independent panel. Only the
  // aggrieved party (the ruling's loser) holds the appeal right; the bond
  // is exactly 2x the tier-0 bond. The caller draws the panel (the
  // dispute-arbiters drawPanel contract); this module validates the draw.
  const appealDispute = (escrowId, { by, bond, panel } = {}) => {
    const record = get(escrowId);
    nonEmptyString(by, "by", 256);
    if (record.arbiterRuling && record.arbiterRuling.frivolous)
      fail("frivolous", `dispute for "${escrowId}" was ruled frivolous: no appeal as of right`);
    if (record.appeal)
      fail("appeal_exhausted", `dispute for "${escrowId}" already used its single escalation`);
    if (TERMINAL.has(record.state))
      fail("already_final", `dispute for "${escrowId}" is already final`);
    requireState(record, "ruled");
    if (nowMs() > Date.parse(record.appealWindowEndsAt))
      fail("appeal_window_closed", `appeal window for "${escrowId}" has lapsed`);
    const aggrieved = record.arbiterRuling.outcome === "release" ? record.payer : record.payee;
    if (by !== aggrieved)
      fail("no_standing", `only the aggrieved party (${aggrieved}) may appeal "${escrowId}"`);
    const required = Math.ceil(record.amount * appealBondRatio);
    check(bond === required, "bond_invalid",
      `appeal bond must be exactly ${required} (2x the dispute bond)`);
    check(Array.isArray(panel) && panel.length === PANEL_SIZE, "panel_invalid",
      `panel must have exactly ${PANEL_SIZE} seats`);
    const seen = new Set();
    for (const lane of panel) {
      check(typeof lane === "string" && lane.length > 0, "panel_invalid", "panel seats must be non-empty strings");
      check(!seen.has(lane), "panel_invalid", `duplicate panel seat "${lane}"`);
      seen.add(lane);
    }
    const excluded = new Set([record.payer, record.payee, record.evaluator,
      record.arbiterRuling.arbiter]);
    for (const lane of panel)
      if (excluded.has(lane))
        fail("panel_not_independent", `panel seat "${lane}" is not independent of the dispute`);
    const appealed = Object.freeze({ ...record, state: "appealed",
      appeal: Object.freeze({ appellant: by, bond: required,
        panel: Object.freeze([...panel]), appealedAt: isoOf(nowMs()), ruling: null }) });
    set(appealed);
    return appealed;
  };

  // The panel rules by majority. Votes are tallied here (>=2 of 3 wins);
  // exactly one escalation, then terminal. A panel overturn of the arbiter
  // is flagged: the settlement layer must honor finalOutcome over the
  // machine's raw `resolved` state.
  const ruleAppeal = (escrowId, { votes, reasonCodes } = {}) => {
    const record = get(escrowId);
    requireState(record, "appealed");
    check(Array.isArray(votes) && votes.length === PANEL_SIZE, "vote_invalid",
      `need exactly ${PANEL_SIZE} votes`);
    const seen = new Set();
    const tally = new Map();
    for (const vote of votes) {
      const lane = vote && vote.lane;
      check(typeof lane === "string" && record.appeal.panel.includes(lane)
        && !seen.has(lane), "vote_invalid", `invalid or duplicate vote by "${lane}"`);
      seen.add(lane);
      check(OUTCOMES.includes(vote.outcome), "vote_invalid",
        `vote outcome must be one of ${OUTCOMES.join(", ")}`);
      tally.set(vote.outcome, (tally.get(vote.outcome) ?? 0) + 1);
    }
    const winner = [...tally.entries()].find(([, count]) => count >= 2);
    check(winner, "panel_deadlocked", "panel produced no majority outcome");
    const codes = validReasonCodes(reasonCodes);
    const finalOutcome = winner[0];
    const overturned = finalOutcome !== record.arbiterRuling.outcome;
    const disputerWon = finalOutcome === desiredOf(record, record.raisedBy);
    const appellantWon = finalOutcome === desiredOf(record, record.appeal.appellant);
    const movements = [
      disputerWon
        ? release(record.raisedBy, record.bondSnapshot, "challenge-succeeded")
        : forfeit(record.raisedBy, record.bondSnapshot, "challenge-failed"),
      appellantWon
        ? release(record.appeal.appellant, record.appeal.bond, "appeal-succeeded")
        : forfeit(record.appeal.appellant, record.appeal.bond, "appeal-failed"),
    ];
    const withRuling = { ...record,
      appeal: Object.freeze({ ...record.appeal,
        ruling: Object.freeze({ outcome: finalOutcome, reasonCodes: codes,
          votes: Object.freeze(votes.map(v => Object.freeze({ ...v }))),
          ruledAt: isoOf(nowMs()) }) }) };
    return finalize(withRuling, { finalOutcome, overturned, bondMovements: movements, tier: 1 });
  };

  // No appeal in the window: the arbiter's ruling is final. Loser-pays on
  // the tier-0 bond against the disputer's desired outcome.
  const lapseAppealWindow = (escrowId, { at } = {}) => {
    const record = get(escrowId);
    if (TERMINAL.has(record.state)) fail("already_final", `dispute for "${escrowId}" is already final`);
    requireState(record, "ruled");
    const atMs = at === undefined ? nowMs() : Date.parse(at);
    check(Number.isFinite(atMs), "invalid_dispute", "at must be a parseable timestamp");
    if (atMs < Date.parse(record.appealWindowEndsAt))
      fail("appeal_window_open", `appeal window for "${escrowId}" has not lapsed`);
    const finalOutcome = record.arbiterRuling.outcome;
    const won = finalOutcome === desiredOf(record, record.raisedBy);
    return finalize(record, { finalOutcome,
      bondMovements: [won
        ? release(record.raisedBy, record.bondSnapshot, "challenge-succeeded")
        : forfeit(record.raisedBy, record.bondSnapshot, "challenge-failed")],
      tier: 0 });
  };

  // Withdraw after the ruling: the ruling stands, all staked bonds are
  // forfeited (abandonment is priced like withdrawal). Pre-ruling
  // withdrawal is refused -- the machine has no un-dispute transition, so
  // the arbiter always rules; withdrawal cannot strand the machine.
  const withdrawDispute = (escrowId, { by } = {}) => {
    const record = get(escrowId);
    nonEmptyString(by, "by", 256);
    if (TERMINAL.has(record.state)) fail("already_final", `dispute for "${escrowId}" is already final`);
    if (record.state === "disputed")
      fail("withdraw_too_early", `dispute for "${escrowId}" has no ruling yet: the arbiter must rule first`);
    requireState(record, "ruled", "appealed");
    const parties = new Set([record.raisedBy,
      ...(record.appeal ? [record.appeal.appellant] : [])]);
    if (!parties.has(by))
      fail("not_authorized", `only the disputer or appellant may withdraw "${escrowId}"`);
    const movements = [forfeit(record.raisedBy, record.bondSnapshot, "withdrawn")];
    if (record.appeal)
      movements.push(forfeit(record.appeal.appellant, record.appeal.bond, "withdrawn"));
    return finalize(record, { finalOutcome: record.arbiterRuling.outcome,
      bondMovements: movements, tier: record.appeal ? 1 : 0 });
  };

  // Liveness backstop: no ruling (or no panel ruling) within the timeout.
  // Conservative default: refund -- funds return to the payer, matching the
  // machine's own sweep bias (funded past deadline -> refunded). Bonds are
  // forfeited as abandoned. NOTE the lane-9 gap: the machine stays
  // `disputed`; the settlement layer must honor this directive.
  const resolveStalled = (escrowId, { at } = {}) => {
    const record = get(escrowId);
    if (TERMINAL.has(record.state)) fail("already_final", `dispute for "${escrowId}" is already final`);
    requireState(record, "disputed", "ruled", "appealed");
    const atMs = at === undefined ? nowMs() : Date.parse(at);
    check(Number.isFinite(atMs), "invalid_dispute", "at must be a parseable timestamp");
    if (atMs - Date.parse(record.raisedAt) < disputeTimeoutMs)
      fail("stall_window_open", `dispute for "${escrowId}" has not stalled past the timeout`);
    if (record.state === "ruled")
      return lapseAppealWindow(escrowId, { at: isoOf(atMs) });
    const movements = [forfeit(record.raisedBy, record.bondSnapshot, "abandoned")];
    if (record.appeal)
      movements.push(forfeit(record.appeal.appellant, record.appeal.bond, "abandoned"));
    return finalize(record, { finalOutcome: "refund", bondMovements: movements, tier: record.appeal ? 1 : 0 });
  };

  return Object.freeze({ openDispute, ruleDispute, appealDispute, ruleAppeal,
    lapseAppealWindow, withdrawDispute, resolveStalled, get,
    size: () => disputes.size,
    DISPUTE_BOND_RATIO, APPEAL_BOND_RATIO, STATES, OUTCOMES });
}
export { EscrowDisputeError, DISPUTE_BOND_RATIO, APPEAL_BOND_RATIO, STATES, OUTCOMES };
