// Scoped API tokens (G012). A pure token-scope manager: define tokens with
// scoped permissions (e.g. "growth:read"), check whether a token grants a
// required scope, and list tokens by owner. Token values are opaque strings
// supplied by the caller; this module never generates or stores secrets.
// All state is caller-owned (a Map); the module is pure and dependency-
// free. Frozen outputs; malformed inputs throw TokenError. HTTP auth
// middleware wiring is a later slice.
class TokenError extends Error { constructor(code, message) { super(message); this.name = "TokenError"; this.code = code; } }
const fail = (code, message) => { throw new TokenError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_token", message); };
// Create a token-scope manager. store is a caller-owned Map (tokenId -> token).
export function createTokenScopes({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const tokens = store ?? new Map();
  // Register a token record. tokenId is the opaque lookup key (not the secret).
  const register = ({ tokenId, ownerId, scopes }) => {
    check(typeof tokenId === "string" && tokenId.length > 0, "tokenId must be a non-empty string");
    check(typeof ownerId === "string" && ownerId.length > 0, "ownerId must be a non-empty string");
    check(Array.isArray(scopes) && scopes.length > 0, "scopes must be a non-empty array");
    check(scopes.every(s => typeof s === "string" && s.length > 0 && /^[a-z0-9:_*-]+$/.test(s)),
      "every scope must be a lowercase scope string");
    check(!tokens.has(tokenId), `token "${tokenId}" is already registered`);
    const token = { tokenId, ownerId, scopes: Object.freeze([...scopes]) };
    tokens.set(tokenId, token);
    return Object.freeze({ ...token });
  };
  // Revoke a token.
  const revoke = tokenId => {
    check(typeof tokenId === "string" && tokenId.length > 0, "tokenId must be a non-empty string");
    check(tokens.has(tokenId), `unknown token "${tokenId}"`);
    tokens.delete(tokenId);
    return Object.freeze({ tokenId, revoked: true });
  };
  // Check whether a token grants a scope. Supports prefix wildcards ("growth:*").
  const grants = (tokenId, requiredScope) => {
    check(typeof requiredScope === "string" && requiredScope.length > 0,
      "requiredScope must be a non-empty string");
    const token = tokens.get(tokenId);
    if (!token) return false;
    return token.scopes.some(scope => {
      if (scope === requiredScope) return true;
      if (scope.endsWith(":*")) {
        const prefix = scope.slice(0, -1); // keep trailing ":"
        return requiredScope.startsWith(prefix);
      }
      return false;
    });
  };
  // List token ids for an owner (never the secret values).
  const tokensForOwner = ownerId => {
    check(typeof ownerId === "string" && ownerId.length > 0, "ownerId must be a non-empty string");
    return Object.freeze([...tokens.values()]
      .filter(t => t.ownerId === ownerId)
      .map(t => Object.freeze({ tokenId: t.tokenId, scopes: t.scopes })));
  };
  return Object.freeze({ register, revoke, grants, tokensForOwner });
}
export { TokenError };
