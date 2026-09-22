// B024: signed agent claims. Pure sign/verify tests.
import test from "node:test";
import assert from "node:assert/strict";
import { signClaim, verifyClaim, signPubkeyClaim, verifyPubkeyClaim, ClaimError } from "../server/signed-claims.mjs";
import { generateKeyPair } from "../server/agent-card-signing.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ClaimError && error.code === code);
const SECRET = "a".repeat(32);

test("signClaim/verifyClaim round-trip", () => {
  const t = 1000;
  const token = signClaim({ agentId: "ada", action: "room.join",
    payload: { room: "r1" }, secret: SECRET, ttlMs: 60000, now: () => t });
  assert.ok(typeof token === "string" && token.includes("."));
  const claim = verifyClaim({ token, secret: SECRET, now: () => t });
  assert.equal(claim.agentId, "ada");
  assert.equal(claim.action, "room.join");
  assert.deepEqual(claim.payload, { room: "r1" });
  assert.ok(Object.isFrozen(claim));
});
test("expired claims are rejected", () => {
  let t = 0;
  const token = signClaim({ agentId: "a", action: "x", payload: {},
    secret: SECRET, ttlMs: 1000, now: () => t });
  t = 2000;
  throwsCode(() => verifyClaim({ token, secret: SECRET, now: () => t }), "invalid_claim");
});
test("tampered tokens are rejected", () => {
  const token = signClaim({ agentId: "a", action: "x", payload: {}, secret: SECRET });
  const [body, sig] = token.split(".");
  // Tamper the FIRST signature char: it always encodes real bits, so the
  // decoded signature always changes. (The last base64url char's low bits
  // are padding — swapping it can decode to identical bytes and flake.)
  const tampered = `${body}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
  throwsCode(() => verifyClaim({ token: tampered, secret: SECRET }), "invalid_claim");
  throwsCode(() => verifyClaim({ token, secret: "b".repeat(32) }), "invalid_claim");
});
test("malformed inputs are refused", () => {
  throwsCode(() => signClaim({ agentId: "a", action: "x", payload: {}, secret: "short" }), "invalid_claim");
  throwsCode(() => verifyClaim({ token: "not-a-token", secret: SECRET }), "invalid_claim");
});

// ---- Ed25519 public-key mode (integration map slice 9) ----

const keyEntry = (keyPair, { validFrom = 0, validUntil = null, revokedAt = null } = {}) =>
  ({ publicKey: keyPair.publicKey, validFrom, validUntil, revokedAt });

test("signPubkeyClaim/verifyPubkeyClaim round-trip", () => {
  const kp = generateKeyPair();
  const t = 1000;
  const token = signPubkeyClaim({ agentId: "ada", action: "room.join",
    payload: { room: "r1" }, privateKey: kp.privateKey, ttlMs: 60000, now: () => t });
  assert.ok(token.startsWith("ed1."));
  const claim = verifyPubkeyClaim({ token, keysFor: [keyEntry(kp)], now: () => t });
  assert.equal(claim.agentId, "ada");
  assert.equal(claim.action, "room.join");
  assert.deepEqual(claim.payload, { room: "r1" });
  assert.ok(Object.isFrozen(claim));
});

test("pubkey verify accepts a keysFor resolver function", () => {
  const kp = generateKeyPair();
  const token = signPubkeyClaim({ agentId: "ada", action: "x", payload: {},
    privateKey: kp.privateKey, now: () => 500 });
  const seen = [];
  const claim = verifyPubkeyClaim({ token, keysFor: agentId => { seen.push(agentId); return [keyEntry(kp)]; }, now: () => 500 });
  assert.equal(claim.agentId, "ada");
  assert.deepEqual(seen, ["ada"]);
});

test("pubkey mode: tampered body, wrong key, and HMAC tokens are rejected", () => {
  const kp = generateKeyPair();
  const other = generateKeyPair();
  const t = 1000;
  const token = signPubkeyClaim({ agentId: "a", action: "x", payload: {},
    privateKey: kp.privateKey, ttlMs: 60000, now: () => t });
  const [prefix, bodyB64, sig] = token.split(".");
  // Tamper the FIRST signature char (always encodes real bits).
  const tamperedSig = `${prefix}.${bodyB64}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
  throwsCode(() => verifyPubkeyClaim({ token: tamperedSig, keysFor: [keyEntry(kp)], now: () => t }), "invalid_claim");
  // A different registered key cannot verify this signature.
  throwsCode(() => verifyPubkeyClaim({ token, keysFor: [keyEntry(other)], now: () => t }), "invalid_claim");
  // HMAC tokens are not Ed25519 tokens and vice versa.
  throwsCode(() => verifyPubkeyClaim({ token: "bogus", keysFor: [keyEntry(kp)] }), "invalid_claim");
  const hmac = signClaim({ agentId: "a", action: "x", payload: {}, secret: SECRET, now: () => t });
  throwsCode(() => verifyPubkeyClaim({ token: hmac, keysFor: [keyEntry(kp)], now: () => t }), "invalid_claim");
  throwsCode(() => verifyClaim({ token, secret: SECRET }), "invalid_claim");
});

test("pubkey mode: claim issued outside the key validity window is rejected", () => {
  const kp = generateKeyPair();
  // Key valid [1000, 2000): a claim issued at 500 or 2000 must fail.
  const entries = [keyEntry(kp, { validFrom: 1000, validUntil: 2000 })];
  const early = signPubkeyClaim({ agentId: "a", action: "x", payload: {}, privateKey: kp.privateKey, now: () => 500 });
  throwsCode(() => verifyPubkeyClaim({ token: early, keysFor: entries, now: () => 1500 }), "invalid_claim");
  const late = signPubkeyClaim({ agentId: "a", action: "x", payload: {}, privateKey: kp.privateKey, ttlMs: 10 ** 9, now: () => 2000 });
  throwsCode(() => verifyPubkeyClaim({ token: late, keysFor: entries, now: () => 2001 }), "invalid_claim");
  // A claim issued inside the window verifies.
  const good = signPubkeyClaim({ agentId: "a", action: "x", payload: {}, privateKey: kp.privateKey, ttlMs: 10 ** 9, now: () => 1500 });
  assert.equal(verifyPubkeyClaim({ token: good, keysFor: entries, now: () => 2500 }).issuedAt, 1500);
});

test("pubkey mode: claim issued after revocation is rejected, earlier claims still verify", () => {
  const kp = generateKeyPair();
  const entries = [keyEntry(kp, { revokedAt: 3000 })];
  const before = signPubkeyClaim({ agentId: "a", action: "x", payload: {}, privateKey: kp.privateKey, ttlMs: 10 ** 9, now: () => 2000 });
  assert.equal(verifyPubkeyClaim({ token: before, keysFor: entries, now: () => 4000 }).issuedAt, 2000);
  const after = signPubkeyClaim({ agentId: "a", action: "x", payload: {}, privateKey: kp.privateKey, ttlMs: 10 ** 9, now: () => 3000 });
  throwsCode(() => verifyPubkeyClaim({ token: after, keysFor: entries, now: () => 3001 }), "invalid_claim");
});

test("pubkey mode: unknown keys are rejected", () => {
  const kp = generateKeyPair();
  const token = signPubkeyClaim({ agentId: "a", action: "x", payload: {}, privateKey: kp.privateKey, now: () => 1000 });
  throwsCode(() => verifyPubkeyClaim({ token, keysFor: [], now: () => 1000 }), "invalid_claim");
  throwsCode(() => verifyPubkeyClaim({ token, keysFor: () => [], now: () => 1000 }), "invalid_claim");
});

test("pubkey mode: expired claims are rejected and bad keys refused at sign time", () => {
  const kp = generateKeyPair();
  let t = 0;
  const token = signPubkeyClaim({ agentId: "a", action: "x", payload: {},
    privateKey: kp.privateKey, ttlMs: 1000, now: () => t });
  t = 2000;
  throwsCode(() => verifyPubkeyClaim({ token, keysFor: [keyEntry(kp)], now: () => t }), "invalid_claim");
  throwsCode(() => signPubkeyClaim({ agentId: "a", action: "x", payload: {}, privateKey: "not-a-key" }), "invalid_claim");
});
