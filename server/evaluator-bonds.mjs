// Evaluator bond registry — prototype (ACP wave, lane 10).
//
// Independent evaluators post slashable bonds denominated in ABSTRACT BOND
// UNITS. No real tokens, no mainnet, no money movement. Bonds lock per
// verdict, slash on provably wrong verdicts (commit-reveal contradiction or
// bonded-majority contradiction), release on honest completion, and slashes
// are appealable exactly once (loser-pays, fresh resolver, terminal).
//
// Invariants (from claim-bonds-spec-2026-10-04.md and IB-014):
// - automation never slashes: every slash rides a signed record (a hash
//   proof or a bonded-majority tally with evaluator identities)
// - slashed funds go to the pool sink, never to other evaluators
// - bonds earn nothing; settlement is pull-only (release/withdraw)
//
// Pure module: in-memory state via createEvaluatorBondRegistry(). No DB
// tables, no HTTP routes, no server imports — additive and backward
// compatible by construction. Commit preimage format is
// sha256(verdict + "\n" + salt), hex-encoded.
import { createHash } from "node:crypto";

export class EvaluatorBondError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const fail = (code, message, status) => { throw new EvaluatorBondError(code, message, status); };

// Absolute floor: dust rounds still require a non-zero bond.
export const MIN_BOND_FLOOR = 1;
// Appeal bond = 25% of the slashed amount (DISPUTE_BOND_RATIO precedent).
export const APPEAL_BOND_RATIO = 0.25;

const isId = (v) => typeof v === "string" && v.length > 0 && v.length <= 200;
const isUnits = (v) => Number.isInteger(v) && v > 0;
const commitHashFor = (verdict, salt) =>
  createHash("sha256").update(`${verdict}\n${salt}`).digest("hex");

// Minimum quorum that must agree to slash a dissenter: at least a second
// bonded evaluator, 2/3 supermajority above that, never more than n.
export function quorumFor(evaluatorCount) {
  if (!Number.isInteger(evaluatorCount) || evaluatorCount < 1) fail("invalid_evaluator_count", "evaluatorCount must be a positive integer");
  return Math.min(evaluatorCount, Math.max(2, Math.ceil((2 * evaluatorCount) / 3)));
}

// Cheapest per-evaluator bond that makes the canonical bribe attack
// unprofitable: corrupting q evaluators must cost more than the verdict
// value V. B_min = max(ABS_MIN, ceil(V / q) - r).
export function quoteMinimumBond({ verdictValueUnits, evaluatorCount, completionRewardUnits = 0 } = {}) {
  if (!isUnits(verdictValueUnits)) fail("invalid_verdict_value", "verdictValueUnits must be a positive integer");
  if (!Number.isInteger(completionRewardUnits) || completionRewardUnits < 0)
    fail("invalid_reward", "completionRewardUnits must be a non-negative integer");
  const q = quorumFor(evaluatorCount);
  return Math.max(MIN_BOND_FLOOR, Math.ceil(verdictValueUnits / q) - completionRewardUnits);
}

// Max attacker profit at a given bond: V - q*(B + r). <= 0 means unprofitable.
export function attackMargin({ verdictValueUnits, evaluatorCount, bondUnits, completionRewardUnits = 0 } = {}) {
  if (!isUnits(verdictValueUnits)) fail("invalid_verdict_value", "verdictValueUnits must be a positive integer");
  if (!isUnits(bondUnits)) fail("invalid_bond", "bondUnits must be a positive integer");
  const q = quorumFor(evaluatorCount);
  return verdictValueUnits - q * (bondUnits + completionRewardUnits);
}

export function createEvaluatorBondRegistry() {
  const evaluators = new Map(); // id -> { posted, locked, slashedTotal }
  const verdicts = new Map();   // verdictId -> round record
  const slashes = new Map();    // slashId -> slash record
  const journal = [];
  let pool = 0;
  let seq = 0;
  let slashSeq = 0;

  const log = (kind, data = {}) => {
    journal.push({ seq: ++seq, at: Date.now(), kind, ...data });
  };
  const getEval = (evaluatorId) => {
    const e = evaluators.get(evaluatorId);
    if (!e) fail("unknown_evaluator", `evaluator "${evaluatorId}" is not registered`);
    return e;
  };
  const availableOf = (e) => e.posted - e.locked - e.slashedTotal;
  const getRound = (verdictId) => {
    const r = verdicts.get(verdictId);
    if (!r) fail("unknown_verdict", `verdict "${verdictId}" is not assigned`);
    return r;
  };
  const lockOf = (round, evaluatorId) => {
    const lock = round.locks.get(evaluatorId);
    if (!lock) fail("not_assigned", `evaluator "${evaluatorId}" is not on verdict "${round.verdictId}"`);
    return lock;
  };

  // Shared slash path: the only code that moves a lock to slashed.
  const applySlash = (round, lock, evaluatorId, reason) => {
    const e = getEval(evaluatorId);
    const slashedUnits = lock.lockUnits;
    e.locked -= slashedUnits;
    e.slashedTotal += slashedUnits;
    pool += slashedUnits;
    lock.state = "slashed";
    const slashId = `slash-${++slashSeq}`;
    const record = {
      slashId, verdictId: round.verdictId, evaluatorId, reason,
      slashedUnits, appealBondUnits: 0, state: "open",
    };
    slashes.set(slashId, record);
    log("bond.slashed", { slashId, verdictId: round.verdictId, evaluatorId, reason, slashedUnits });
    return { slashId, evaluatorId, reason, slashedUnits };
  };

  return {
    registerEvaluator({ evaluatorId, bondUnits } = {}) {
      if (!isId(evaluatorId)) fail("invalid_evaluator", "evaluatorId must be a non-empty string");
      if (!isUnits(bondUnits)) fail("invalid_bond", "bondUnits must be a positive integer");
      if (evaluators.has(evaluatorId)) fail("already_registered", `evaluator "${evaluatorId}" is already registered`);
      evaluators.set(evaluatorId, { posted: bondUnits, locked: 0, slashedTotal: 0 });
      log("evaluator.registered", { evaluatorId, bondUnits });
      return { evaluatorId, posted: bondUnits };
    },

    topUpBond({ evaluatorId, bondUnits } = {}) {
      if (!isId(evaluatorId)) fail("invalid_evaluator", "evaluatorId must be a non-empty string");
      if (!isUnits(bondUnits)) fail("invalid_bond", "bondUnits must be a positive integer");
      const e = getEval(evaluatorId);
      e.posted += bondUnits;
      log("bond.topped_up", { evaluatorId, bondUnits, posted: e.posted });
      return { evaluatorId, posted: e.posted };
    },

    withdrawBond({ evaluatorId, bondUnits } = {}) {
      if (!isUnits(bondUnits)) fail("invalid_bond", "bondUnits must be a positive integer");
      const e = getEval(evaluatorId);
      if (bondUnits > availableOf(e))
        fail("insufficient_available", `only ${availableOf(e)} units available, ${bondUnits} requested`);
      e.posted -= bondUnits;
      log("bond.withdrawn", { evaluatorId, bondUnits });
      return { evaluatorId, withdrawn: bondUnits };
    },

    getEvaluator(evaluatorId) {
      const e = getEval(evaluatorId);
      return {
        evaluatorId,
        posted: e.posted,
        locked: e.locked,
        slashedTotal: e.slashedTotal,
        available: availableOf(e),
      };
    },

    assignVerdict({ verdictId, evaluatorIds, verdictValueUnits, completionRewardUnits = 0 } = {}) {
      if (!isId(verdictId)) fail("invalid_verdict", "verdictId must be a non-empty string");
      if (!Array.isArray(evaluatorIds) || evaluatorIds.length === 0)
        fail("invalid_verdict", "evaluatorIds must be a non-empty array");
      if (new Set(evaluatorIds).size !== evaluatorIds.length) fail("duplicate_evaluator", "evaluatorIds must be unique");
      if (verdicts.has(verdictId)) fail("already_assigned", `verdict "${verdictId}" is already assigned`);
      const floor = quoteMinimumBond({ verdictValueUnits, evaluatorCount: evaluatorIds.length, completionRewardUnits });
      // Validate every seat before locking any: assignment is atomic.
      for (const id of evaluatorIds) {
        const e = getEval(id);
        if (availableOf(e) < floor)
          fail("insufficient_bond", `evaluator "${id}" has ${availableOf(e)} available, needs ${floor}`);
      }
      const locks = new Map();
      for (const id of evaluatorIds) {
        const e = getEval(id);
        e.locked += floor;
        locks.set(id, { state: "locked", lockUnits: floor, commitHash: null, verdict: null });
        log("bond.locked", { verdictId, evaluatorId: id, lockUnits: floor });
      }
      verdicts.set(verdictId, {
        verdictId, evaluatorIds: [...evaluatorIds], verdictValueUnits,
        lockUnits: floor, quorum: quorumFor(evaluatorIds.length),
        locks, tallied: false,
      });
      log("verdict.assigned", { verdictId, evaluatorIds: [...evaluatorIds], lockUnits: floor });
      return { verdictId, lockUnits: floor };
    },

    commitVerdict({ verdictId, evaluatorId, commitHash } = {}) {
      const round = getRound(verdictId);
      const lock = lockOf(round, evaluatorId);
      if (lock.state !== "locked") fail("already_committed", `evaluator "${evaluatorId}" already committed on "${verdictId}"`);
      if (typeof commitHash !== "string" || commitHash.length === 0)
        fail("invalid_commit", "commitHash must be a non-empty string");
      lock.commitHash = commitHash;
      lock.state = "committed";
      log("verdict.committed", { verdictId, evaluatorId });
      return { verdictId, evaluatorId };
    },

    revealVerdict({ verdictId, evaluatorId, verdict, salt } = {}) {
      const round = getRound(verdictId);
      const lock = lockOf(round, evaluatorId);
      if (lock.state !== "committed") fail("no_commit", `evaluator "${evaluatorId}" has no open commit on "${verdictId}"`);
      if (typeof verdict !== "string" || verdict.length === 0) fail("invalid_verdict", "verdict must be a non-empty string");
      if (typeof salt !== "string") fail("invalid_reveal", "salt must be a string");
      if (commitHashFor(verdict, salt) !== lock.commitHash) {
        const s = applySlash(round, lock, evaluatorId, "commitment_breach");
        return { slashed: true, ...s };
      }
      lock.verdict = verdict;
      lock.state = "revealed";
      log("verdict.revealed", { verdictId, evaluatorId, verdict });
      return { slashed: false, verdictId, evaluatorId, verdict };
    },

    tallyRound({ verdictId } = {}) {
      const round = getRound(verdictId);
      if (round.tallied) fail("already_tallied", `verdict "${verdictId}" is already tallied`);
      round.tallied = true;
      const slashed = [];
      // Committed but never revealed: liveness fault, slash at tally.
      for (const [id, lock] of round.locks) {
        if (lock.state === "committed") slashed.push(applySlash(round, lock, id, "no_reveal"));
      }
      const revealed = [...round.locks]
        .filter(([, lock]) => lock.state === "revealed")
        .map(([id, lock]) => ({ evaluatorId: id, verdict: lock.verdict }));
      let outcome;
      let majorityVerdict = null;
      if (round.evaluatorIds.length === 1) {
        outcome = "single";
      } else if (revealed.length < 2) {
        outcome = "inconclusive";
      } else {
        const counts = new Map();
        for (const r of revealed) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
        let best = 0;
        for (const [verdict, count] of counts) {
          if (count > best) { best = count; majorityVerdict = verdict; }
        }
        if (best >= round.quorum) {
          outcome = best === revealed.length ? "unanimous" : "majority";
          for (const r of revealed) {
            if (r.verdict !== majorityVerdict) {
              const lock = round.locks.get(r.evaluatorId);
              slashed.push(applySlash(round, lock, r.evaluatorId, "majority_contradiction"));
            }
          }
        } else {
          outcome = "contested";
        }
      }
      log("round.tallied", { verdictId, outcome, majorityVerdict, slashed: slashed.map((s) => s.slashId) });
      return { verdictId, outcome, majorityVerdict, slashed };
    },

    releaseVerdict({ verdictId, evaluatorId } = {}) {
      const round = getRound(verdictId);
      const lock = lockOf(round, evaluatorId);
      if (lock.state === "slashed") fail("nothing_to_release", `no releasable lock for "${evaluatorId}" on "${verdictId}"`);
      if (!round.tallied) fail("not_tallied", `verdict "${verdictId}" is not tallied yet`);
      if (lock.state !== "revealed") fail("not_releasable", `lock for "${evaluatorId}" on "${verdictId}" is not released-eligible`);
      const e = getEval(evaluatorId);
      e.locked -= lock.lockUnits;
      lock.state = "released";
      log("bond.released", { verdictId, evaluatorId, releasedUnits: lock.lockUnits });
      return { verdictId, evaluatorId, releasedUnits: lock.lockUnits };
    },

    appealSlash({ slashId, appellantId, appealBondUnits } = {}) {
      const slash = slashes.get(slashId);
      if (!slash) fail("unknown_slash", `slash "${slashId}" does not exist`);
      if (slash.state !== "open") fail("appeal_closed", `slash "${slashId}" is terminal (${slash.state})`);
      if (appellantId !== slash.evaluatorId) fail("not_appellant", "only the slashed evaluator may appeal");
      if (!isUnits(appealBondUnits)) fail("invalid_bond", "appealBondUnits must be a positive integer");
      const required = Math.ceil(slash.slashedUnits * APPEAL_BOND_RATIO);
      if (appealBondUnits < required)
        fail("insufficient_appeal_bond", `appeal bond must be at least ${required} units (25% of slash)`);
      const e = getEval(appellantId);
      if (appealBondUnits > availableOf(e))
        fail("insufficient_available", `only ${availableOf(e)} units available for the appeal bond`);
      e.posted -= appealBondUnits;
      slash.appealBondUnits = appealBondUnits;
      slash.state = "appealed";
      log("slash.appealed", { slashId, appellantId, appealBondUnits });
      return { slashId, appealBondUnits };
    },

    resolveAppeal({ slashId, uphold, resolverId } = {}) {
      const slash = slashes.get(slashId);
      if (!slash) fail("unknown_slash", `slash "${slashId}" does not exist`);
      if (slash.state !== "appealed") fail("appeal_not_open", `slash "${slashId}" has no open appeal`);
      const round = getRound(slash.verdictId);
      if (!isId(resolverId)) fail("invalid_resolver", "resolverId must be a non-empty string");
      if (round.evaluatorIds.includes(resolverId))
        fail("conflicted_resolver", "appeal resolver must be fresh to the round");
      const e = getEval(slash.evaluatorId);
      if (uphold === true) {
        // Slash reversed: bond restored, appeal bond returned, pool debited.
        e.slashedTotal -= slash.slashedUnits;
        pool -= slash.slashedUnits;
        e.posted += slash.appealBondUnits;
        slash.state = "reversed";
        log("slash.appeal_upheld", { slashId, resolverId, restoredUnits: slash.slashedUnits });
        return { slashId, outcome: "slash_reversed" };
      }
      if (uphold === false) {
        // Slash stands: loser pays — appeal bond goes to the pool.
        pool += slash.appealBondUnits;
        slash.state = "denied";
        log("slash.appeal_denied", { slashId, resolverId, forfeitedUnits: slash.appealBondUnits });
        return { slashId, outcome: "slash_upheld" };
      }
      fail("invalid_appeal", "uphold must be true or false");
    },

    poolBalance() { return pool; },
    journal() { return journal.map((e) => ({ ...e })); },
  };
}
