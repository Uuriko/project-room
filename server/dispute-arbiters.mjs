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

  // --- Tier 2: steward sortition -------------------------------------------
  // FNV-1a 32-bit hash (deterministic across runtimes) + mulberry32 PRNG:
  // the panel draw is fully determined by the dispute id.
  const fnv1a = str => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  };
  const mulberry32 = seed => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const PANEL_SIZE = 3;
  const ELIGIBLE_TRUST = new Set(["standard", "elevated"]);

  // Read path for the lane registry: parse agent-card frontmatter from
  // lanes/*.md contents into lane descriptors.
  // cards: [{ name, content }] — content is the card markdown.
  const parseLaneCards = (cards = []) => {
    if (!Array.isArray(cards)) fail("invalid_arbiter", "cards must be an array");
    return cards.map(({ name, content }) => {
      if (typeof content !== "string") fail("invalid_arbiter", `card "${name}" has no content`);
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const fields = {};
      if (match) for (const line of match[1].split(/\r?\n/)) {
        const kv = line.match(/^([a-z_]+):\s*(.+?)\s*$/);
        if (kv) fields[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1");
      }
      return { lane: fields.lane ?? String(name).replace(/\.md$/, ""),
        trust_level: fields.trust_level ?? "new",
        model: fields.model ?? "unknown", lane_tag: fields.lane_tag ?? null };
    });
  };

  // Draw a 3-seat steward panel, deterministically seeded by dispute-id.
  // lanes: [{ lane, trust_level, ... }]. exclude: lanes that are parties to
  // the dispute or the claim's executor. Eligibility: trust standard+,
  // not excluded. Rotating, per-case, no token.
  const drawPanel = ({ disputeId, lanes = [], exclude = [] } = {}) => {
    if (!norm(disputeId)) fail("invalid_arbiter", "disputeId must be a non-empty string");
    if (!Array.isArray(lanes)) fail("invalid_arbiter", "lanes must be an array");
    const excluded = new Set(exclude);
    const eligible = lanes.filter(l => l && ELIGIBLE_TRUST.has(l.trust_level)
      && norm(l.lane) && !excluded.has(l.lane));
    if (eligible.length < PANEL_SIZE)
      return { unavailable: "no-arbitrator",
        reason: `only ${eligible.length} eligible lanes for a ${PANEL_SIZE}-seat panel` };
    const rand = mulberry32(fnv1a(disputeId));
    const order = [...eligible];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const panel = Object.freeze(order.slice(0, PANEL_SIZE).map(l =>
      Object.freeze({ tier: 2, lane: l.lane })));
    return { tier: 2, panel, seed: fnv1a(disputeId) >>> 0 };
  };

  // Record a panel ruling: majority decides, with the majority's reason
  // codes. Each member is paid from the bond outcome-independently.
  // votes: [{ lane, outcome, reasonCodes }] — one per seated panel member.
  const recordPanelDecision = ({ panel, votes = [], kind = "economic" } = {}) => {
    if (!Array.isArray(panel) || panel.length !== PANEL_SIZE)
      fail("invalid_arbiter", `panel must have exactly ${PANEL_SIZE} seats`);
    if (!Array.isArray(votes) || votes.length !== PANEL_SIZE)
      fail("invalid_arbiter", "every panel member must vote");
    const seen = new Set();
    for (const v of votes) {
      if (!v || !norm(v.lane)) fail("invalid_arbiter", "each vote needs a lane");
      if (!panel.some(p => p.lane === v.lane)) fail("invalid_arbiter", `vote from non-panel lane "${v.lane}"`);
      if (seen.has(v.lane)) fail("invalid_arbiter", `duplicate vote from "${v.lane}"`);
      seen.add(v.lane);
      if (!OUTCOMES.includes(v.outcome))
        fail("invalid_arbiter", `outcome must be one of ${OUTCOMES.join(", ")}`);
      if (!Array.isArray(v.reasonCodes) || v.reasonCodes.length === 0)
        fail("invalid_arbiter", "each vote needs a non-empty reasonCodes array");
      for (const code of v.reasonCodes)
        if (!REASON_CODES.includes(code)) fail("invalid_arbiter", `unknown reason code "${code}"`);
    }
    const tally = new Map();
    for (const v of votes) tally.set(v.outcome, (tally.get(v.outcome) ?? 0) + 1);
    const [outcome, count] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    if (count < 2) fail("invalid_arbiter", "panel deadlocked: no majority outcome");
    const reasonCodes = Object.freeze([...new Set(votes
      .filter(v => v.outcome === outcome)
      .flatMap(v => v.reasonCodes))]);
    const decision = Object.freeze({ tier: 2, outcome, reasonCodes,
      votes: Object.freeze(votes.map(v => Object.freeze({ lane: v.lane, outcome: v.outcome,
        reasonCodes: Object.freeze([...v.reasonCodes]) }))) });
    const payHooks = Object.freeze(panel.map(p => Object.freeze({
      arbiter: p.lane, basis: "outcome-independent",
      source: kind === "economic" ? "dispute-bond" : "verify-weight", amount: null })));
    if (!["economic", "coordination"].includes(kind))
      fail("invalid_arbiter", 'kind must be "economic" or "coordination"');
    return Object.freeze({ decision, payHooks });
  };

  return Object.freeze({ isIndependent, resolveTier1, recordTier1Decision,
    parseLaneCards, drawPanel, recordPanelDecision });
}
