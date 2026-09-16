// Agent onboarding checklist (B012). A pure checklist builder: define the
// required onboarding steps for an agent, track which are complete, and
// report what's missing. Steps have ids, labels, and optional details.
// All state is caller-owned (a Map); the module is pure and
// dependency-free. Frozen outputs; malformed inputs throw ChecklistError.
// Onboarding UI wiring is a later slice.
class ChecklistError extends Error { constructor(code, message) { super(message); this.name = "ChecklistError"; this.code = code; } }
const fail = (code, message) => { throw new ChecklistError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_checklist", message); };
// Define the standard onboarding steps.
export function standardSteps() {
  return Object.freeze([
    Object.freeze({ stepId: "identity", label: "Create agent identity", details: "Register a unique agent id" }),
    Object.freeze({ stepId: "connect", label: "Connect to room", details: "Establish a live connection" }),
    Object.freeze({ stepId: "capabilities", label: "Publish capability card", details: "Declare lanes and tools" }),
    Object.freeze({ stepId: "scopes", label: "Grant MCP scopes", details: "Assign minimum necessary scopes" }),
    Object.freeze({ stepId: "verify", label: "Verify first action", details: "Complete a test task" }),
  ]);
}
// Create an onboarding tracker. store is a caller-owned Map (agentId -> Set of completed stepIds).
export function createOnboarding({ store, steps } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const stepList = steps ?? standardSteps();
  check(Array.isArray(stepList) && stepList.length > 0, "steps must be a non-empty array");
  const stepIds = new Set(stepList.map(s => s.stepId));
  check(stepIds.size === stepList.length, "stepIds must be unique");
  const completed = store ?? new Map();
  // Mark a step complete for an agent.
  const complete = (agentId, stepId) => {
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
    check(stepIds.has(stepId), `unknown step "${stepId}"`);
    if (!completed.has(agentId)) completed.set(agentId, new Set());
    completed.get(agentId).add(stepId);
    return status(agentId);
  };
  // Get the checklist status for an agent.
  const status = agentId => {
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
    const done = completed.get(agentId) ?? new Set();
    const items = stepList.map(step => Object.freeze({ ...step, complete: done.has(step.stepId) }));
    const missing = items.filter(i => !i.complete).map(i => i.stepId);
    return Object.freeze({ agentId, items: Object.freeze(items),
      complete: missing.length === 0, missing: Object.freeze(missing),
      progress: `${done.size}/${stepList.length}` });
  };
  // Reset an agent's progress.
  const reset = agentId => {
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
    completed.delete(agentId);
  };
  return Object.freeze({ complete, status, reset, steps: () => stepList });
}
export { ChecklistError };
