// Dispute arbitration, Tier 1 — designated verifier (dispute-resolution
// design slice 5). A pure, dependency-free module: given a claim's named
// verifier_id and the executor's identity domains, it seats an independent
// verifier or falls through to an honest unavailable(no-arbitrator) result.
//
// Separation of duties (PR #480): a verifier under the same runtime,
// credential chain, or delegated execution chain as the executor does not
// count as independent.
//
// Pay is outcome-independent (the ACP approve-bias lesson: an evaluator paid
// only on approval never rejects). Economic disputes pay the arbiter from
// the dispute bond; coordination disputes record `verify` weight on the
// contribution ledger. Amounts are settled by the economic wiring slice;
// this module records the entitlement as a pay hook. The enforcer/escrow
// executes; arbiters never move funds directly.
import { REASON_CODES, OUTCOMES, DisputeError } from "./bounty-disputes.mjs";

const fail = (code, message) => { throw new DisputeError(code, message); };
const norm = v => (typeof v === "string" && v.length > 0 ? v : null);

export function createArbiters() {
  // Separation-of-duties check. verifier/executor are identity descriptors:
  // { lane, runtime?, credentialChain?, delegatedChain? }.
  const isIndependent = (verifier = {}, executor = {}) => {
    const vLane = norm(verifier.lane);
    const eLane = norm(executor.lane);
    if (!vLane) return { independent: false, reason: "verifier has no lane identity" };
    if (vLane && vLane === eLane)
      return { independent: false, reason: "verifier is the executor" };
    for (const domain of ["runtime", "credentialChain", "delegatedChain"]) {
      const v = norm(verifier[domain]);
      const e = norm(executor[domain]);
      if (v && e && v === e)
        return { independent: false, reason: `shared ${domain}` };
    }
    const vDel = norm(verifier.delegatedChain);
    const eDel = norm(executor.delegatedChain);
    if (vDel && eDel && (vDel.includes(eDel) || eDel.includes(vDel)))
      return { independent: false, reason: "delegated chain overlap" };
    return { independent: true, reason: "independent" };
  };

  // Seat the claim's named verifier for Tier 1.
  // lanes: [{ lane, trust_level?, runtime?, credentialChain?, delegatedChain? }]
  // Returns a seated decider, or { unavailable: "no-arbitrator", reason } —
  // an honest-unavailable fall-through, never a silent drop.
  const resolveTier1 = ({ verifierId, executor = {}, lanes = [] } = {}) => {
    if (!norm(verifierId)) fail("invalid_arbiter", "verifierId must be a non-empty string");
    if (!Array.isArray(lanes)) fail("invalid_arbiter", "lanes must be an array");
    const card = lanes.find(l => l && l.lane === verifierId);
    if (!card)
      return { unavailable: "no-arbitrator", reason: `verifier "${verifierId}" is not an enrolled lane` };
    const check = isIndependent(card, executor);
    if (!check.independent)
      return { unavailable: "no-arbitrator", reason: `verifier "${verifierId}" is not independent: ${check.reason}` };
    return { tier: 1, decider: Object.freeze({ tier: 1, lane: card.lane, verifierId }) };
  };

  // Record a Tier-1 ruling with its outcome-independent pay hook.
  // kind: "economic" | "coordination".
  const recordTier1Decision = ({ decider, outcome, reasonCodes, kind = "economic" } = {}) => {
    if (!decider || typeof decider !== "object" || decider.tier !== 1 || !norm(decider.lane))
      fail("invalid_arbiter", "decider must be a seated tier-1 decider");
    if (!OUTCOMES.includes(outcome))
      fail("invalid_arbiter", `outcome must be one of ${OUTCOMES.join(", ")}`);
    if (!Array.isArray(reasonCodes) || reasonCodes.length === 0)
      fail("invalid_arbiter", "reasonCodes must be a non-empty array");
    for (const code of reasonCodes)
      if (!REASON_CODES.includes(code)) fail("invalid_arbiter", `unknown reason code "${code}"`);
    if (!["economic", "coordination"].includes(kind))
      fail("invalid_arbiter", 'kind must be "economic" or "coordination"');
    const decision = Object.freeze({ tier: 1, lane: decider.lane, outcome,
      reasonCodes: Object.freeze([...reasonCodes]) });
    const payHook = Object.freeze({ arbiter: decider.lane, basis: "outcome-independent",
      source: kind === "economic" ? "dispute-bond" : "verify-weight", amount: null });
    return Object.freeze({ decision, payHook });
  };

  return Object.freeze({ isIndependent, resolveTier1, recordTier1Decision });
}
