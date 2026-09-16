// Per-agent-identity MCP auth scopes (B008). A pure scope checker: each
// agent identity holds a set of granted scopes (e.g. "mcp:read",
// "mcp:write:room-lobby"); before an MCP tool call runs, the checker
// verifies the agent's scopes cover the tool's required scopes, including
// wildcard and namespaced matches. All state is caller-owned (a Map of
// agentId -> Set of scopes); the module is pure and dependency-free.
// Frozen outputs; malformed inputs throw ScopeError. Enforcement wiring
// in the MCP route is a later slice.
// Scope grammar: segments separated by ":". A granted scope covers a
// required scope when every required segment matches or the granted
// scope has a "*" in that position (and the granted scope is not longer
// than the required scope).
class ScopeError extends Error { constructor(code, message) { super(message); this.name = "ScopeError"; this.code = code; } }
const fail = (code, message) => { throw new ScopeError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_scope", message); };

const SCOPE_RE = /^[a-z0-9*_-]+(?::[a-z0-9*_-]+)*$/;
const checkScope = scope => check(typeof scope === "string" && SCOPE_RE.test(scope), `invalid scope "${scope}"`);
// Does granted cover required?
export function scopeCovers(granted, required) {
  checkScope(granted); checkScope(required);
  const g = granted.split(":"), r = required.split(":");
  if (g.length > r.length) return false;
  return g.every((segment, i) => segment === "*" || segment === r[i]);
}
// Create a scope registry. store is a caller-owned Map (agentId -> Set<scope>).
export function createScopeRegistry({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const grants = store ?? new Map();
  const checkId = id => check(typeof id === "string" && id.length > 0, "agentId must be a non-empty string");
  // Grant scopes to an agent. Returns the agent's full scope set.
  const grant = (agentId, scopes) => {
    checkId(agentId);
    check(Array.isArray(scopes) && scopes.length > 0, "scopes must be a non-empty array");
    scopes.forEach(checkScope);
    const current = grants.get(agentId) ?? new Set();
    for (const scope of scopes) current.add(scope);
    grants.set(agentId, current);
    return Object.freeze([...current].sort());
  };
  // Revoke scopes. Returns the remaining set.
  const revoke = (agentId, scopes) => {
    checkId(agentId);
    check(Array.isArray(scopes), "scopes must be an array");
    check(grants.has(agentId), `unknown agent "${agentId}"`);
    const current = grants.get(agentId);
    for (const scope of scopes) current.delete(scope);
    return Object.freeze([...current].sort());
  };
  // Check whether an agent may call a tool requiring `required` scopes.
  // Returns { allowed, missing }.
  const authorize = (agentId, required) => {
    checkId(agentId);
    check(Array.isArray(required) && required.length > 0, "required must be a non-empty array");
    required.forEach(checkScope);
    const held = grants.get(agentId) ?? new Set();
    const missing = required.filter(r => ![...held].some(g => scopeCovers(g, r)));
    return Object.freeze({ allowed: missing.length === 0, missing: Object.freeze(missing) });
  };
  const scopesOf = agentId => {
    checkId(agentId);
    return Object.freeze([...(grants.get(agentId) ?? new Set())].sort());
  };
  return Object.freeze({ grant, revoke, authorize, scopesOf, size: () => grants.size });
}
export { ScopeError };
