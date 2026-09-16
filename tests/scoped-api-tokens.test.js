// G012: scoped API tokens. Pure scope tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createTokenScopes, TokenError } from "../server/token-scopes.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof TokenError && error.code === code);

test("register/grants/revoke lifecycle", () => {
  const scopes = createTokenScopes();
  const token = scopes.register({ tokenId: "t1", ownerId: "ada", scopes: ["growth:read", "analytics:*"] });
  assert.ok(Object.isFrozen(token));
  assert.equal(scopes.grants("t1", "growth:read"), true);
  assert.equal(scopes.grants("t1", "growth:write"), false);
  assert.equal(scopes.grants("t1", "analytics:export"), true); // wildcard
  assert.equal(scopes.grants("ghost", "growth:read"), false);
  scopes.revoke("t1");
  assert.equal(scopes.grants("t1", "growth:read"), false);
});
test("tokensForOwner lists without secrets", () => {
  const scopes = createTokenScopes();
  scopes.register({ tokenId: "t1", ownerId: "ada", scopes: ["growth:read"] });
  scopes.register({ tokenId: "t2", ownerId: "bob", scopes: ["growth:read"] });
  const ada = scopes.tokensForOwner("ada");
  assert.equal(ada.length, 1);
  assert.equal(ada[0].tokenId, "t1");
});
test("malformed inputs are refused", () => {
  const scopes = createTokenScopes();
  throwsCode(() => scopes.register({ tokenId: "t", ownerId: "a", scopes: ["BAD SCOPE"] }), "invalid_token");
  throwsCode(() => scopes.register({ tokenId: "t", ownerId: "a", scopes: [] }), "invalid_token");
  throwsCode(() => scopes.revoke("ghost"), "invalid_token");
});
