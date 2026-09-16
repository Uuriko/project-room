// Agent sandbox (B019). A pure dry-run manager: when an agent is in
// sandbox mode, its writes are staged (recorded as pending) rather than
// applied. The owner can review staged writes and either apply or discard
// them. All state is caller-owned (a Map); the module is pure and
// dependency-free. Frozen outputs; malformed inputs throw SandboxError.
// Write-interception wiring is a later slice.
class SandboxError extends Error { constructor(code, message) { super(message); this.name = "SandboxError"; this.code = code; } }
const fail = (code, message) => { throw new SandboxError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_sandbox", message); };
// Create a sandbox manager. store is a caller-owned Map (agentId -> { sandboxed, staged }).
export function createSandbox({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const agents = store ?? new Map();
  let stageCounter = 0;
  const entryFor = agentId => {
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
    if (!agents.has(agentId)) {
      agents.set(agentId, { sandboxed: false, staged: [] });
    }
    return agents.get(agentId);
  };
  // Put an agent in sandbox mode.
  const enable = agentId => {
    const entry = entryFor(agentId);
    check(!entry.sandboxed, `agent "${agentId}" is already sandboxed`);
    agents.set(agentId, { ...entry, sandboxed: true });
    return Object.freeze({ agentId, sandboxed: true });
  };
  // Take an agent out of sandbox mode (staged writes are discarded).
  const disable = agentId => {
    const entry = entryFor(agentId);
    check(entry.sandboxed, `agent "${agentId}" is not sandboxed`);
    agents.set(agentId, { sandboxed: false, staged: [] });
    return Object.freeze({ agentId, sandboxed: false, discarded: entry.staged.length });
  };
  // Stage a write instead of applying it. Returns the staged record.
  const stageWrite = (agentId, { operation, target, details }) => {
    const entry = entryFor(agentId);
    check(entry.sandboxed, `agent "${agentId}" is not sandboxed; write would apply directly`);
    check(typeof operation === "string" && operation.length > 0, "operation must be a non-empty string");
    check(typeof target === "string" && target.length > 0, "target must be a non-empty string");
    const staged = Object.freeze({ stageId: `stage-${++stageCounter}`,
      agentId, operation, target, details: Object.freeze({ ...(details ?? {}) }) });
    agents.set(agentId, { ...entry, staged: [...entry.staged, staged] });
    return staged;
  };
  // List staged writes for an agent.
  const stagedWrites = agentId => Object.freeze([...entryFor(agentId).staged]);
  // Apply (return and clear) staged writes. The caller applies them.
  const applyStaged = agentId => {
    const entry = entryFor(agentId);
    const writes = [...entry.staged];
    agents.set(agentId, { ...entry, staged: [] });
    return Object.freeze(writes);
  };
  const isSandboxed = agentId => entryFor(agentId).sandboxed;
  return Object.freeze({ enable, disable, stageWrite, stagedWrites, applyStaged, isSandboxed });
}
export { SandboxError };
