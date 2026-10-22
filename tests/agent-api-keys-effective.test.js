import test from "node:test";
import assert from "node:assert/strict";
import { createAgentApiKeys, ApiKeyError } from "../server/agent-api-keys.mjs";

// Issue #4475: effective grant = key scope AND current permissions;
// rotation/revocation reports the change via onCredentialChange.
const fresh = (overrides = {}) => {
  let n = 0;
  return createAgentApiKeys({
    clock: () => 1_700_000_000_000,
    random: () => `unique-test-secret-0123456789-${++n}`,
    ...overrides,
  });
};
const SCOPES = ["rooms:read", "rooms:write", "heartbeats:report"];

test("grants intersects the key scope with current permissions (charter specimen a)", () => {
  const keys = fresh();
  const issued = keys.issue({ identityId: "ai_eff", scopes: SCOPES });
  // Both cover the scope -> granted.
  assert.equal(keys.grants(issued.keyId, "rooms:write", { currentScopes: SCOPES }), true);
  // A permission removed AFTER issuance shrinks the grant without reissuing
  // the key: the key record still carries rooms:write, the grant is gone.
  assert.equal(keys.grants(issued.keyId, "rooms:write", { currentScopes: ["rooms:read", "heartbeats:report"] }), false);
  assert.equal(keys.grants(issued.keyId, "rooms:read", { currentScopes: ["rooms:read"] }), true);
  // Current permissions can never widen a key: a scope the key lacks stays
  // ungranted even when the caller's current permissions name it.
  assert.equal(keys.grants(issued.keyId, "directory:publish", { currentScopes: ["directory:publish"] }), false);
  // Wildcards compose on both sides of the intersection.
  assert.equal(keys.grants(issued.keyId, "rooms:write", { currentScopes: ["rooms:*"] }), true);
  const wild = keys.issue({ identityId: "ai_eff", scopes: ["rooms:*"] });
  assert.equal(keys.grants(wild.keyId, "rooms:write", { currentScopes: ["rooms:write"] }), true);
  assert.equal(keys.grants(wild.keyId, "rooms:write", { currentScopes: ["heartbeats:report"] }), false);
});

test("grants without currentScopes keeps today's key-only behaviour", () => {
  const keys = fresh();
  const issued = keys.issue({ identityId: "ai_legacy", scopes: SCOPES });
  assert.equal(keys.grants(issued.keyId, "rooms:write"), true);
  assert.equal(keys.grants(issued.keyId, "rooms:write", {}), true);
  assert.equal(keys.grants(issued.keyId, "directory:publish"), false);
});

test("grants validates currentScopes; an empty current set grants nothing", () => {
  const keys = fresh();
  const issued = keys.issue({ identityId: "ai_val", scopes: SCOPES });
  assert.equal(keys.grants(issued.keyId, "rooms:read", { currentScopes: [] }), false);
  assert.throws(() => keys.grants(issued.keyId, "rooms:read", { currentScopes: "rooms:read" }), ApiKeyError);
  assert.throws(() => keys.grants(issued.keyId, "rooms:read", { currentScopes: ["BAD SCOPE"] }), ApiKeyError);
  assert.throws(() => keys.grants(issued.keyId, "rooms:read", { currentScopes: [42] }), ApiKeyError);
});

test("onCredentialChange fires after rotate and revoke, naming key, identity, reason, scopes", () => {
  const events = [];
  const keys = fresh({ onCredentialChange: e => events.push(e) });
  const issued = keys.issue({ identityId: "ai_cb", scopes: SCOPES });
  assert.equal(events.length, 0); // issuance is not a credential change
  keys.rotate(issued.keyId);
  assert.equal(events.length, 1);
  assert.equal(events[0].keyId, issued.keyId);
  assert.equal(events[0].identityId, "ai_cb");
  assert.equal(events[0].reason, "rotated");
  assert.deepEqual([...events[0].scopes], SCOPES);
  keys.revoke(issued.keyId);
  assert.equal(events.length, 2);
  assert.equal(events[1].reason, "revoked");
  assert.equal(events[1].keyId, issued.keyId);
});

test("rotation response names the effective-grant delta (charter specimen b)", () => {
  const keys = fresh();
  const issued = keys.issue({ identityId: "ai_rot", scopes: SCOPES });
  const current = ["rooms:read"]; // rooms:write + heartbeats:report removed since issuance
  // Probe BEFORE rotation: only rooms:read is effectively granted.
  const before = SCOPES.filter(s => keys.grants(issued.keyId, s, { currentScopes: current }));
  assert.deepEqual(before, ["rooms:read"]);
  const rotated = keys.rotate(issued.keyId, { currentScopes: current });
  // The rotation response names the delta: which key scopes current
  // permissions no longer cover (dropped) and which remain effective.
  assert.deepEqual([...rotated.grantChange.droppedScopes].sort(), ["heartbeats:report", "rooms:write"]);
  assert.deepEqual([...rotated.grantChange.effectiveScopes], ["rooms:read"]);
  // Probe AFTER rotation: the effective grant matches the named delta.
  const after = SCOPES.filter(s => keys.grants(issued.keyId, s, { currentScopes: current }));
  assert.deepEqual(after, [...rotated.grantChange.effectiveScopes]);
  // Without currentScopes the response carries no grantChange (unchanged shape).
  const plain = keys.rotate(issued.keyId);
  assert.ok(!("grantChange" in plain));
});

test("no path resurrects a revoked permission (charter specimen c)", () => {
  const store = new Map();
  let n = 0;
  const opts = { store, clock: () => 1_700_000_000_000, random: () => `shared-store-secret-012345-${++n}` };
  const a = createAgentApiKeys(opts);
  const issued = a.issue({ identityId: "ai_revoke", scopes: SCOPES });
  const rotated = a.rotate(issued.keyId);
  a.revoke(issued.keyId);
  // Direct paths: verify and grants stay dead, even with full current scopes.
  assert.equal(a.verify(rotated.secret), null);
  assert.equal(a.verify(issued.secret), null);
  assert.equal(a.grants(issued.keyId, "rooms:read", { currentScopes: SCOPES }), false);
  // Rotation cannot resurrect a revoked key.
  assert.throws(() => a.rotate(issued.keyId), ApiKeyError);
  // A second manager over the same store (the cached-grant analogue) agrees:
  // revocation is read from shared state, not from a stale local copy.
  const b = createAgentApiKeys(opts);
  assert.equal(b.verify(rotated.secret), null);
  assert.equal(b.grants(issued.keyId, "rooms:read", { currentScopes: SCOPES }), false);
  assert.equal(b.keysForIdentity("ai_revoke")[0].revoked, true);
});

test("onCredentialChange is optional and validated", () => {
  const keys = fresh(); // no callback: rotate/revoke behave exactly as before
  const issued = keys.issue({ identityId: "ai_nocb", scopes: SCOPES });
  assert.ok(keys.rotate(issued.keyId).secret);
  assert.equal(keys.revoke(issued.keyId).revoked, true);
  assert.throws(() => createAgentApiKeys({ onCredentialChange: "nope" }), ApiKeyError);
});

test("expiry still gates the intersected grant", () => {
  const store = new Map();
  let n = 0;
  const random = () => `expiry-secret-0123456789-${++n}`;
  const a = createAgentApiKeys({ store, clock: () => 1_700_000_000_000, random });
  const issued = a.issue({ identityId: "ai_exp2", scopes: SCOPES, expiresAt: 1_700_000_000_001 });
  assert.equal(a.grants(issued.keyId, "rooms:read", { currentScopes: SCOPES }), true);
  const b = createAgentApiKeys({ store, clock: () => 1_700_000_000_002, random });
  assert.equal(b.grants(issued.keyId, "rooms:read", { currentScopes: SCOPES }), false);
});
