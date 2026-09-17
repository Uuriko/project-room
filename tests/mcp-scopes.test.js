// B008: per-agent-identity MCP auth scopes. Pure registry tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createScopeRegistry, scopeCovers, ScopeError } from "../server/mcp-scopes.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ScopeError && error.code === code);

test("scopeCovers handles exact, wildcard, and namespaced matches", () => {
  assert.equal(scopeCovers("mcp:read", "mcp:read"), true);
  assert.equal(scopeCovers("mcp:*", "mcp:write:room-lobby"), true);
  assert.equal(scopeCovers("mcp:write:room-lobby", "mcp:write:room-lobby"), true);
  assert.equal(scopeCovers("mcp:read", "mcp:write"), false);
  assert.equal(scopeCovers("mcp:write:room-lobby", "mcp:write"), false); // longer grant never covers
  assert.equal(scopeCovers("*", "anything:at:all"), true);
});
test("grant, authorize, revoke lifecycle", () => {
  const registry = createScopeRegistry();
  registry.grant("quill", ["mcp:read", "mcp:write:room-lobby"]);
  const ok = registry.authorize("quill", ["mcp:read"]);
  assert.deepEqual([ok.allowed, ok.missing], [true, []]);
  const denied = registry.authorize("quill", ["mcp:write:room-other"]);
  assert.equal(denied.allowed, false);
  assert.deepEqual(denied.missing, ["mcp:write:room-other"]);
  registry.revoke("quill", ["mcp:read"]);
  assert.deepEqual(registry.scopesOf("quill"), ["mcp:write:room-lobby"]);
  assert.ok(Object.isFrozen(ok) && Object.isFrozen(denied.missing));
});
test("malformed inputs are refused", () => {
  throwsCode(() => scopeCovers("BAD SCOPE", "mcp:read"), "invalid_scope");
  const registry = createScopeRegistry();
  throwsCode(() => registry.grant("x", []), "invalid_scope");
  throwsCode(() => registry.authorize("x", []), "invalid_scope");
});
