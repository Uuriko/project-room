// Agent reputation/staking (B019). A pure reputation tracker: record
// positive/negative signals per agent, compute a bounded score, and track
// staked amounts. Scores decay toward neutral over time via an explicit
// decay step (caller supplies the elapsed factor). All state is
// caller-owned (a Map); the module is pure and dependency-free. Frozen
// outputs; malformed inputs throw ReputationError. Chain/payout wiring
// is a later slice.
class ReputationError extends Error { constructor(code, message) { super(message); this.name = "ReputationError"; this.code = code; } }
const fail = (code, message) => { throw new ReputationError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_reputation", message); };
// Create a reputation tracker. store is a caller-owned Map (agentId -> record).
export function createReputation({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const reputations = store ?? new Map();
  const recordFor = agentId => {
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
    if (!reputations.has(agentId)) {
      reputations.set(agentId, Object.freeze({ agentId, score: 0, positive: 0, negative: 0,
        staked: 0 }));
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
  return Object.freeze({ signal, stake, decay, leaderboard, size: () => reputations.size,
    get: agentId => recordFor(agentId) });
}
export { ReputationError };
