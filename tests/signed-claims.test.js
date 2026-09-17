// B024: signed agent claims. Pure sign/verify tests.
import test from "node:test";
import assert from "node:assert/strict";
import { signClaim, verifyClaim, ClaimError } from "../server/signed-claims.mjs";

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
