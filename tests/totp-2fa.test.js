// F018 — tests for src/totp-2fa.mjs.
//
// Covers the RFC 6238 appendix B SHA-1 test vectors, base32 round-trips,
// enrollment round-trip (generateSecret -> generateCode -> verifyCode),
// wrong-code rejection, clock-skew window behavior (±1 passes, ±2 fails),
// and input validation. Deterministic: every time-dependent assertion
// pins `time` explicitly.

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  TOTP_STEP_SECONDS,
  base32Encode,
  base32Decode,
  generateSecret,
  generateCode,
  verifyCode,
  provisioningUri,
} from "../src/totp-2fa.mjs";

// RFC 6238 appendix B: SHA-1 test secret "12345678901234567890" (ASCII),
// time step 30s, T0 = 0. Secret base32 (computed by hand-rolled encoder):
// GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));
assert.equal(RFC_SECRET, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");

const randomBuffer = size => randomBytes(size);

const RFC_VECTORS = [
  { timeMs: 59_000, expected: "94287082" },
  { timeMs: 1_111_111_109_000, expected: "07081804" },
  { timeMs: 1_111_111_111_000, expected: "14050471" },
  { timeMs: 1_234_567_890_000, expected: "89005924" },
  { timeMs: 2_000_000_000_000, expected: "69279037" },
  { timeMs: 20_000_000_000_000, expected: "65353130" },
];

test("RFC 6238 appendix B SHA-1 vectors (8-digit)", () => {
  for (const { timeMs, expected } of RFC_VECTORS) {
    assert.equal(generateCode(RFC_SECRET, { digits: 8, time: timeMs }), expected, `time ${timeMs}`);
  }
});

test("6-digit codes are the 8-digit code truncated per RFC 4226 §5.4", () => {
  for (const { timeMs, expected } of RFC_VECTORS) {
    assert.equal(generateCode(RFC_SECRET, { digits: 6, time: timeMs }), expected.slice(-6), `time ${timeMs}`);
  }
});

test("base32 round-trips arbitrary bytes", () => {
  for (const bytes of [Buffer.from([0]), Buffer.from("hello"), Buffer.alloc(20, 0xff), randomBuffer(37)]) {
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  }
  // Case-insensitive, padding optional.
  assert.deepEqual(base32Decode("gezdgnbvgy3tqojq"), base32Decode("GEZDGNBVGY3TQOJQ"));
});

test("base32Decode rejects non-alphabet characters", () => {
  assert.throws(() => base32Decode("NOT-BASE32!"), TypeError);
  assert.throws(() => base32Decode(""), TypeError);
});

test("enrollment round-trip: generateSecret -> generateCode -> verifyCode", () => {
  const secret = generateSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.notEqual(generateSecret(), secret, "secrets are random");
  const now = Date.now();
  const code = generateCode(secret, { time: now });
  assert.equal(code.length, 6);
  assert.ok(verifyCode(code, secret, { time: now }), "current code verifies");
});

test("wrong codes are rejected", () => {
  const secret = generateSecret();
  const now = Date.now();
  const good = generateCode(secret, { time: now });
  const wrong = String((Number(good) + 1) % 1_000_000).padStart(6, "0");
  assert.notEqual(wrong, good);
  assert.equal(verifyCode(wrong, secret, { time: now }), false);
  assert.equal(verifyCode("000000", secret, { time: now }), false);
  assert.equal(verifyCode("not-a-code", secret, { time: now }), false);
  assert.equal(verifyCode("", secret, { time: now }), false);
  assert.equal(verifyCode(good, secret, { time: now }), true, "sanity: right code passes");
});

test("window tolerance: ±1 step passes, ±2 steps fails", () => {
  const secret = generateSecret();
  const stepMs = TOTP_STEP_SECONDS * 1000;
  const now = 1_700_000_000_000;
  const code = generateCode(secret, { time: now });
  assert.ok(verifyCode(code, secret, { time: now, window: 1 }), "same step");
  assert.ok(verifyCode(code, secret, { time: now - stepMs, window: 1 }), "one step early");
  assert.ok(verifyCode(code, secret, { time: now + stepMs, window: 1 }), "one step late");
  assert.equal(verifyCode(code, secret, { time: now - 2 * stepMs, window: 1 }), false, "two steps early");
  assert.equal(verifyCode(code, secret, { time: now + 2 * stepMs, window: 1 }), false, "two steps late");
  // Window 0 disables skew tolerance.
  assert.equal(verifyCode(code, secret, { time: now + stepMs, window: 0 }), false);
  // Larger windows widen acceptance symmetric to the step grid.
  const far = generateCode(secret, { time: now - 2 * stepMs });
  assert.ok(verifyCode(far, secret, { time: now, window: 2 }), "±2 window accepts two steps away");
});

test("verifyCode never throws on malformed input — it returns false", () => {
  for (const args of [
    ["123456", "!!!"],
    ["123456", ""],
    ["123456", null],
    [null, generateSecret()],
    ["123456", generateSecret(), { digits: 5 }],
  ]) {
    let result;
    assert.doesNotThrow(() => {
      result = verifyCode(...args);
    });
    assert.equal(result, false);
  }
});

test("generateCode validates its inputs", () => {
  assert.throws(() => generateCode("", {}), TypeError);
  assert.throws(() => generateCode("!!!", {}), TypeError);
  assert.throws(() => generateCode(generateSecret(), { digits: 7 }), RangeError);
});

test("provisioningUri builds a valid otpauth:// URI", () => {
  const secret = generateSecret();
  const uri = provisioningUri({ issuer: "project-room", account: "owner@example.com", secret });
  assert.ok(uri.startsWith("otpauth://totp/project-room:owner%40example.com?"));
  const url = new URL(uri);
  assert.equal(url.searchParams.get("secret"), secret.replace(/=+$/, ""));
  assert.equal(url.searchParams.get("issuer"), "project-room");
  assert.equal(url.searchParams.get("algorithm"), "SHA1");
  assert.equal(url.searchParams.get("digits"), "6");
  assert.equal(url.searchParams.get("period"), "30");
  assert.throws(() => provisioningUri({ account: "", secret }), TypeError);
  assert.throws(() => provisioningUri({ account: "a", secret: "bad!!" }), TypeError);
});
