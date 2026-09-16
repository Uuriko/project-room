// Owner pause/resume (B017). A pure agent lifecycle manager: the owner
// can pause any enrolled agent (halting its actions) and resume it.
// Paused agents are blocked from acting via canAct(). All state is
// caller-owned (a Map); the module is pure and dependency-free. Frozen
// outputs; malformed inputs throw LifecycleError. Runtime enforcement
// wiring is a later slice.
class LifecycleError extends Error { constructor(code, message) { super(message); this.name = "LifecycleError"; this.code = code; } }
const fail = (code, message) => { throw new LifecycleError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_lifecycle", message); };
const STATES = ["active", "paused"];
// Create a lifecycle manager. store is a caller-owned Map (agentId -> state).
export function createLifecycle({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const states = store ?? new Map();
  const getState = agentId => {
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
    return states.get(agentId) ?? "active";
  };
  // Pause an agent (owner only).
  const pause = (agentId, { by }) => {
    const current = getState(agentId);
    check(typeof by === "string" && by.length > 0, "by (owner id) must be a non-empty string");
    check(current === "active", `agent "${agentId}" is already ${current}`);
    states.set(agentId, "paused");
    return Object.freeze({ agentId, state: "paused", pausedBy: by });
  };
  // Resume an agent (owner only).
  const resume = (agentId, { by }) => {
    const current = getState(agentId);
    check(typeof by === "string" && by.length > 0, "by (owner id) must be a non-empty string");
    check(current === "paused", `agent "${agentId}" is not paused`);
    states.set(agentId, "active");
    return Object.freeze({ agentId, state: "active", resumedBy: by });
  };
  // Check if an agent is allowed to act.
  const canAct = agentId => getState(agentId) === "active";
  // List all paused agents.
  const pausedAgents = () => Object.freeze([...states.entries()]
    .filter(([, state]) => state === "paused")
    .map(([agentId]) => agentId));
  return Object.freeze({ pause, resume, canAct, pausedAgents, state: getState });
}
export { LifecycleError, STATES };
