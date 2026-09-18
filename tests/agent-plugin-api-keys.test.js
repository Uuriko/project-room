import test from "node:test";
import assert from "node:assert/strict";
import { createAgentApiKeys, ApiKeyError, API_KEY_PREFIX } from "../server/agent-api-keys.mjs";

const fresh = (overrides = {}) => {
  let t = 1_700_000_000_000;
  return createAgentApiKeys({
    clock: () => t,
    random: () => "fixed-test-secret-0123456789abcdef",
    ...overrides,
  });
};
const ISSUE = { identityId: "ai_test123", scopes: ["rooms:read", "rooms:write"] };

test("issue generates a prefixed secret shown once and stores only the hash", t => {
  const keys = fresh();
  const issued = keys.issue(ISSUE);
  assert.ok(issued.keyId.startsWith(API_KEY_PREFIX));
  assert.equal(typeof issued.secret, "string");
  assert.equal(issued.secret, "fixed-test-secret-0123456789abcdef");
  assert.deepEqual([...issued.scopes], ISSUE.scopes);
  assert.equal(issued.identityId, "ai_test123");
  assert.ok(issued.createdAt > 0);
  assert.equal(issued.expiresAt, null);
  assert.equal(issued.revoked, false);
  // The secret is never on the listed records.
  const listed = keys.keysForIdentity("ai_test123");
  assert.equal(listed.length, 1);
  assert.ok(!("secret" in listed[0]) && !("keyHash" in listed[0]));
});

test("verify authenticates with the raw secret and updates lastUsedAt", t => {
  const keys = fresh();
  const issued = keys.issue(ISSUE);
  assert.ok(!("secret" in keys.verify(issued.secret)));
  assert.equal(keys.verify("wrong-secret"), null);
  const rec = keys.verify(issued.secret);
  assert.equal(rec.keyId, issued.keyId);
  assert.ok(rec.lastUsedAt > 0);
});

test("issue validates identity, scopes, expiry, and label", t => {
  const keys = fresh();
  assert.throws(() => keys.issue({ identityId: "", scopes: ["a:b"] }), ApiKeyError);
  assert.throws(() => keys.issue({ identityId: "ai_x", scopes: [] }), ApiKeyError);
  assert.throws(() => keys.issue({ identityId: "ai_x", scopes: ["BAD SCOPE"] }), ApiKeyError);
  assert.throws(() => keys.issue({ identityId: "ai_x", scopes: ["a:b"], expiresAt: -5 }), ApiKeyError);
  assert.throws(() => keys.issue({ identityId: "ai_x", scopes: ["a:b"], label: "x".repeat(81) }), ApiKeyError);
});

test("expired and revoked keys do not verify", t => {
  let n = 0;
  const keys = createAgentApiKeys({
    clock: () => 1_700_000_000_000,
    random: () => `unique-injected-secret-0123456789-${++n}`,
  });
  const exp = keys.issue({ ...ISSUE, identityId: "ai_exp", expiresAt: 1_700_000_000_001 });
  assert.ok(keys.verify(exp.secret)); // still valid at t
  // advance the clock past expiry
  const late = createAgentApiKeys({ clock: () => 1_700_000_000_002, random: () => "injected-secret-0000000002" });
  // late has no store entries (separate store); simulate expiry via shared store:
  const store = new Map();
  const a = createAgentApiKeys({ store, clock: () => 1_700_000_000_000, random: () => "injected-secret-0000000003" });
  const e2 = a.issue({ ...ISSUE, identityId: "ai_late", expiresAt: 1_700_000_000_001 });
  const b = createAgentApiKeys({ store, clock: () => 1_700_000_000_002, random: () => "injected-secret-0000000004" });
  assert.equal(b.verify(e2.secret), null);
  assert.equal(b.grants(e2.keyId, "rooms:read"), false);

  const r = keys.issue({ ...ISSUE, identityId: "ai_rev" });
  keys.revoke(r.keyId);
  assert.equal(keys.verify(r.secret), null);
  assert.equal(keys.grants(r.keyId, "rooms:read"), false);
  assert.throws(() => keys.revoke(r.keyId), ApiKeyError);
  assert.throws(() => keys.revoke("rak_missing"), ApiKeyError);
  assert.equal(late.verify("x"), null); // unknown secret on empty store
});

test("rotate invalidates the old secret and issues a new one", t => {
  const store = new Map();
  let n = 0;
  const keys = createAgentApiKeys({ store, random: () => `injected-test-secret-0123456789-${++n}` });
  const issued = keys.issue(ISSUE);
  assert.equal(issued.secret, "injected-test-secret-0123456789-1");
  const rotated = keys.rotate(issued.keyId);
  assert.equal(rotated.secret, "injected-test-secret-0123456789-2");
  assert.ok(!("secret" in keys.verify(rotated.secret)));
  assert.equal(keys.verify(issued.secret), null); // old secret dead
  assert.throws(() => keys.rotate("rak_missing"), ApiKeyError);
  keys.revoke(issued.keyId);
  assert.throws(() => keys.rotate(issued.keyId), /revoked/);
});

test("grants supports prefix wildcards; unknown keys deny", t => {
  const keys = fresh();
  const issued = keys.issue({ identityId: "ai_w", scopes: ["rooms:*", "mcp:exec"] });
  assert.ok(keys.grants(issued.keyId, "rooms:read"));
  assert.ok(keys.grants(issued.keyId, "rooms:write"));
  assert.ok(keys.grants(issued.keyId, "mcp:exec"));
  assert.ok(!keys.grants(issued.keyId, "mcp:read"));
  assert.ok(!keys.grants("rak_nope", "rooms:read"));
  assert.throws(() => keys.grants(issued.keyId, ""), ApiKeyError);
});

test("keysForIdentity only lists that identity's keys", t => {
  const keys = fresh();
  keys.issue({ ...ISSUE, identityId: "ai_a" });
  keys.issue({ ...ISSUE, identityId: "ai_b" });
  assert.equal(keys.keysForIdentity("ai_a").length, 1);
  assert.equal(keys.keysForIdentity("ai_b").length, 1);
  assert.equal(keys.keysForIdentity("ai_c").length, 0);
  assert.throws(() => keys.keysForIdentity(""), ApiKeyError);
});
