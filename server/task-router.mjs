// Task router (B018). A pure task router: given a work item's required
// capabilities and agents' capability cards, score each agent by
// capability overlap and return a ranked list. Ties break by agent id for
// determinism. The module is pure and dependency-free. Frozen outputs;
// malformed inputs throw RouterError. Work-queue wiring is a later slice.
class RouterError extends Error { constructor(code, message) { super(message); this.name = "RouterError"; this.code = code; } }
const fail = (code, message) => { throw new RouterError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_router", message); };
// Score an agent's fit for a work item. Returns 0-1.
export function scoreFit({ requiredCapabilities, agentCapabilities }) {
  check(Array.isArray(requiredCapabilities) && requiredCapabilities.length > 0,
    "requiredCapabilities must be a non-empty array");
  check(Array.isArray(agentCapabilities), "agentCapabilities must be an array");
  const agentSet = new Set(agentCapabilities);
  const matched = requiredCapabilities.filter(c => agentSet.has(c)).length;
  return matched / requiredCapabilities.length;
}
// Rank agents for a work item. Each agent is { agentId, capabilities }.
// Returns ranked [{ agentId, score }] with score 0-1, highest first.
export function routeTask({ requiredCapabilities, agents }) {
  check(Array.isArray(requiredCapabilities) && requiredCapabilities.length > 0,
    "requiredCapabilities must be a non-empty array");
  check(Array.isArray(agents) && agents.length > 0, "agents must be a non-empty array");
  const ranked = agents.map(agent => {
    check(agent !== null && typeof agent === "object", "each agent must be an object");
    check(typeof agent.agentId === "string" && agent.agentId.length > 0, "agent must have agentId");
    check(Array.isArray(agent.capabilities), "agent must have capabilities array");
    return Object.freeze({ agentId: agent.agentId,
      score: scoreFit({ requiredCapabilities, agentCapabilities: agent.capabilities }) });
  });
  ranked.sort((a, b) => b.score - a.score || (a.agentId < b.agentId ? -1 : 1));
  return Object.freeze(ranked);
}
// Suggest the single best-fit agent (or null if none score above 0).
export function suggestAgent({ requiredCapabilities, agents }) {
  const ranked = routeTask({ requiredCapabilities, agents });
  const best = ranked[0];
  return best.score > 0 ? best : null;
}
export { RouterError };
