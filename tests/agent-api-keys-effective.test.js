import test from "node:test";
import assert from "node:assert/strict";
import { createAgentApiKeys } from "../server/agent-api-keys.mjs";

let n = 0;
const make = extra => createAgentApiKeys({ random: () => `secret-${++n}-0123456789abcdef`, ...extra });
const ISSUE = { identityId: "ai_eff1", scopes: ["rooms:*", "work:write"] };

test("effective grant is key scope AND current connection permissions", () => {
  const keys = make();
  const { keyId } = keys.issue(ISSUE);
  assert.equal(keys.grants(keyId, "rooms:read"), true);
  assert.equal(keys.grants(keyId, "rooms:read", { currentScopes: ["rooms:read"] }), true);
  assert.equal(keys.grants(keyId, "rooms:write", { currentScopes: ["rooms:read"] }), false);
  assert.equal(keys.grants(keyId, "work:write", { currentScopes: [] }), false);
  assert.equal(keys.grants(keyId, "work:write", { currentScopes: ["work:*"] }), true);
});

test("current permissions never widen a key", () => {
  const keys = make();
  const { keyId } = keys.issue({ identityId: "ai_eff2", scopes: ["rooms:read"] });
  assert.equal(keys.grants(keyId, "rooms:write", { currentScopes: ["rooms:*", "rooms:write"] }), false);
  assert.throws(() => keys.grants(keyId, "rooms:read", { currentScopes: "rooms:read" }));
});

test("rotate and revoke report the change so held claims can be released", () => {
  const seen = [];
  const keys = make({ onCredentialChange: change => seen.push(change) });
  const { keyId } = keys.issue(ISSUE);
  keys.rotate(keyId);
  keys.revoke(keyId);
  assert.deepEqual(seen, [
    { keyId, identityId: "ai_eff1", reason: "rotated" },
    { keyId, identityId: "ai_eff1", reason: "revoked" },
  ]);
});

test("onCredentialChange must be a function when given", () => {
  assert.throws(() => createAgentApiKeys({ onCredentialChange: "yes" }));
});
