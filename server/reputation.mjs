// Agent reputation/staking (B019). A pure reputation tracker: record
// positive/negative signals per agent, compute a bounded score, and track
// staked amounts. Scores decay toward neutral over time via an explicit
// decay step (caller supplies the elapsed factor). All state is
// caller-owned (a Map); the module is pure and dependency-free. Frozen
// outputs; malformed inputs throw ReputationError.
//
// Typed bounty signals (integration-map slice #4) extend the generic
// tracker with a time-aware path: signalTyped() applies a named signal
// with exponential decay (30-day half-life, ported from the canary-
// reputation design) and records when it landed, so scoreAt()/bandFor()
// can answer "what is this agent's standing now". The legacy signal()
// path is untouched: records without a timestamp are never time-decayed.
// Slice #4 also consumes #792's human-verdict signals: acceptance_overturned
// (a verifier's pinned-rubric acceptance overturned by an upheld dispute,
// slice #6) and sybil_confirmed (an arbiter confirmed the lane's membership
// in a correlated cluster, slice #10). Scores are reputation points,
// never money — they gate claim eligibility and routing visibility only,
// never payouts, never bans.
class ReputationError extends Error { constructor(code, message) { super(message); this.name = "ReputationError"; this.code = code; } }
const fail = (code, message) => { throw new ReputationError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_reputation", message); };
// 30-day exponential decay half-life for time-aware signals.
export const REPUTATION_DECAY_HALF_LIFE_MS = 30 * 24 * 3600 * 1000;
export const REPUTATION_BANDS = Object.freeze({ TRUSTED: "trusted", STANDARD: "standard", PROBATION: "probation" });
export const TRUSTED_BAND_MIN = 40;   // score >= 40 -> trusted
export const PROBATION_BAND_MAX = -20; // score < -20 -> probation; exactly -20 stays standard
export function bandOf(score) {
  check(Number.isFinite(score), "score must be finite");
  if (score >= TRUSTED_BAND_MIN) return REPUTATION_BANDS.TRUSTED;
  if (score < PROBATION_BAND_MAX) return REPUTATION_BANDS.PROBATION;
  return REPUTATION_BANDS.STANDARD;
}
// Signed weights for the room's bounty-derived signals. Positive builds
// standing, negative erodes it; dispute outcomes move the most because
// they are judged verdicts, not participation.
export const BOUNTY_SIGNAL_WEIGHTS = Object.freeze({
  payout_released: 8,      // bounty paid out to the earner
  submission_accepted: 4, // verifier/poster accepted the work
  dispute_won: 2,         // dispute ruled in the agent's favor
  dispute_split: -4,      // split ruling: both sides share the loss
  claim_flaked: -6,       // claimed then timed out without submitting
  acceptance_overturned: -8, // slice #4 + #6: the agent's acceptance verdict was
                             // overturned by an upheld dispute (verifier track record)
  dispute_lost: -12,      // dispute ruled against the agent
  bond_forfeited: -10,    // bond slashed to the pool (work judged bad / frivolous challenge)
  sybil_confirmed: -12,   // slice #4 + #10: an arbiter confirmed the lane's
                          // membership in a correlated (sybil) cluster
});
export function decayedScore(score, fromMs, toMs) {
  check(Number.isFinite(score), "score must be finite");
  check(Number.isInteger(fromMs) && fromMs >= 0, "fromMs must be a non-negative integer");
  check(Number.isInteger(toMs) && toMs >= 0, "toMs must be a non-negative integer");
  const elapsed = Math.max(0, toMs - fromMs);
  if (elapsed === 0) return score;
  return score * Math.pow(0.5, elapsed / REPUTATION_DECAY_HALF_LIFE_MS);
}
// Create a reputation tracker. store is a caller-owned Map (agentId -> record).
export function createReputation({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const reputations = store ?? new Map();
  const recordFor = agentId => {
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
    if (!reputations.has(agentId)) {
      reputations.set(agentId, Object.freeze({ agentId, score: 0, positive: 0, negative: 0,
        staked: 0, updatedMs: null }));
    }
    return reputations.get(agentId);
  };
  // Record a signal. weight must be positive.
  const signal = (agentId, { kind, weight }) => {
    check(kind === "positive" || kind === "negative", 'kind must be "positive" or "negative"');
    check(Number.isFinite(weight) && weight > 0, "weight must be positive");
    const current = recordFor(agentId);
    const delta = kind === "positive" ? weight : -weight;
    const score = Math.max(-100, Math.min(100, current.score + delta));
    const updated = Object.freeze({ ...current, score,
      positive: current.positive + (kind === "positive" ? 1 : 0),
      negative: current.negative + (kind === "negative" ? 1 : 0) });
    reputations.set(agentId, updated);
    return updated;
  };
  // Record a typed bounty signal at time `at` (ms epoch, defaults to now).
  // The prior score is first decayed to `at`, then the signed weight applies.
  // Unknown agents start at 0.
  const signalTyped = (agentId, signalType, { at } = {}) => {
    check(typeof signalType === "string" && Object.hasOwn(BOUNTY_SIGNAL_WEIGHTS, signalType),
      `unknown signal type "${signalType}"`);
    const ts = at === undefined ? Date.now() : at;
    check(Number.isInteger(ts) && ts >= 0, "at must be a non-negative integer ms timestamp");
    const weight = BOUNTY_SIGNAL_WEIGHTS[signalType];
    const current = recordFor(agentId);
    const base = current.updatedMs === null ? current.score : decayedScore(current.score, current.updatedMs, ts);
    const score = Math.max(-100, Math.min(100, base + weight));
    const updated = Object.freeze({ ...current, score, updatedMs: ts,
      positive: current.positive + (weight > 0 ? 1 : 0),
      negative: current.negative + (weight < 0 ? 1 : 0) });
    reputations.set(agentId, updated);
    return updated;
  };
  // Score decayed to nowMs (legacy records without a timestamp return as-is).
  const scoreAt = (agentId, nowMs) => {
    check(Number.isInteger(nowMs) && nowMs >= 0, "nowMs must be a non-negative integer");
    const current = recordFor(agentId);
    return current.updatedMs === null ? current.score : decayedScore(current.score, current.updatedMs, nowMs);
  };
  // Standing band decayed to nowMs (defaults to now).
  const bandFor = (agentId, { nowMs } = {}) => {
    const now = nowMs === undefined ? Date.now() : nowMs;
    return bandOf(scoreAt(agentId, now));
  };
  // Stake an amount. Must be positive; adds to existing stake.
  const stake = (agentId, amount) => {
    check(Number.isFinite(amount) && amount > 0, "amount must be positive");
    const current = recordFor(agentId);
    const updated = Object.freeze({ ...current, staked: current.staked + amount });
    reputations.set(agentId, updated);
    return updated;
  };
  // Apply decay: score moves toward 0 by factor (0 = no decay, 1 = full reset).
  const decay = factor => {
    check(Number.isFinite(factor) && factor >= 0 && factor <= 1, "factor must be 0-1");
    const updated = [];
    for (const [agentId, current] of reputations) {
      const next = Object.freeze({ ...current, score: current.score * (1 - factor) });
      reputations.set(agentId, next);
      updated.push(next);
    }
    return Object.freeze(updated);
  };
  // Get top agents by score.
  const leaderboard = (limit = 10) => {
    check(Number.isInteger(limit) && limit > 0, "limit must be positive");
    const sorted = [...reputations.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    return Object.freeze(sorted.map(r => Object.freeze({ ...r })));
  };
  return Object.freeze({ signal, signalTyped, scoreAt, bandFor, stake, decay, leaderboard,
    size: () => reputations.size, get: agentId => recordFor(agentId) });
}
export { ReputationError };
