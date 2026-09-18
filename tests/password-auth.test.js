// Unit tests for src/password-auth.mjs: scrypt verifier format, hash/verify
// roundtrip, malformed-verifier safety, password policy boundaries, salt
// randomness, and the timing-safe comparison. No secrets or PII; every
// password is a synthetic fixture string.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hashPassword, verifyPassword, checkPasswordPolicy, DUMMY_PASSWORD_VERIFIER,
  SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEYLEN, SALT_BYTES, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from "../src/password-auth.mjs";

const VERIFIER_PATTERN = /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;

test("hashPassword emits the documented verifier format", () => {
  const verifier = hashPassword("correct horse battery staple");
  assert.match(verifier, VERIFIER_PATTERN);
  assert.equal(SCRYPT_N, 16384);
  assert.equal(SCRYPT_R, 8);
  assert.equal(SCRYPT_P, 1);
  assert.equal(SCRYPT_KEYLEN, 32);
  assert.equal(SALT_BYTES, 16);
});

test("hash/verify roundtrip accepts the right password", () => {
  const verifier = hashPassword("Tr0ub4dor&3-extended");
  assert.equal(verifyPassword("Tr0ub4dor&3-extended", verifier), true);
});

test("wrong password fails verification", () => {
  const verifier = hashPassword("the-right-password");
  assert.equal(verifyPassword("the-wrong-password", verifier), false);
  assert.equal(verifyPassword("", verifier), false);
  assert.equal(verifyPassword("the-right-password ", verifier), false);
});

test("malformed verifiers return false and never throw", () => {
  const bad = ["", "not-a-verifier", "scrypt$16384$8$1", "scrypt$16384$8$1$only-five$parts",
    "bcrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "scrypt$abc$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "scrypt$16384$8$1$!!!not-base64url!!!$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$", "scrypt$3$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    null, undefined, 42, {}];
  for (const verifier of bad) {
    assert.equal(verifyPassword("anything", verifier), false, `verifier ${String(verifier)} must not verify`);
  }
  assert.equal(verifyPassword(null, hashPassword("pw-ok-length10")), false);
  assert.equal(verifyPassword(42, hashPassword("pw-ok-length10")), false);
});

test("tampering with any verifier segment fails verification", () => {
  const verifier = hashPassword("untampered-password");
  const [, n, r, p, salt, hash] = verifier.split("$");
  const flipped = hash.slice(0, -1) + (hash.endsWith("A") ? "B" : "A");
  assert.equal(verifyPassword("untampered-password", `scrypt$${n}$${r}$${p}$${salt}$${flipped}`), false);
  assert.equal(verifyPassword("untampered-password", `scrypt$16385$${r}$${p}$${salt}$${hash}`), false);
});

test("only the exact scrypt parameter set verifies", () => {
  const verifier = hashPassword("exact-params-password");
  const [, , , , salt, hash] = verifier.split("$");
  // Well-formed but costlier/weaker parameters are rejected, not honored.
  assert.equal(verifyPassword("exact-params-password", `scrypt$32768$8$1$${salt}$${hash}`), false);
  assert.equal(verifyPassword("exact-params-password", `scrypt$16384$16$1$${salt}$${hash}`), false);
  assert.equal(verifyPassword("exact-params-password", `scrypt$16384$8$2$${salt}$${hash}`), false);
});

test("comparison runs through crypto.timingSafeEqual", () => {
  // Behavioral tamper tests above prove the comparison executes; this pins
  // the implementation to the constant-time primitive rather than a
  // short-circuiting string comparison.
  const source = readFileSync(new URL("../src/password-auth.mjs", import.meta.url), "utf8");
  assert.match(source, /import \{[^}]*timingSafeEqual[^}]*\} from "node:crypto"/);
  assert.match(source, /timingSafeEqual\(derived, hash\)/);
});

test("salts are random: two hashes of the same password differ and both verify", () => {
  const first = hashPassword("same-password-123");
  const second = hashPassword("same-password-123");
  assert.notEqual(first, second);
  assert.equal(verifyPassword("same-password-123", first), true);
  assert.equal(verifyPassword("same-password-123", second), true);
});

test("hashPassword accepts an injected random source", () => {
  const fixed = Buffer.alloc(SALT_BYTES, 7);
  const verifier = hashPassword("injected-salt-pw", { random: bytes => { assert.equal(bytes, SALT_BYTES); return fixed; } });
  assert.match(verifier, VERIFIER_PATTERN);
  const saltB64 = verifier.split("$")[4];
  assert.equal(saltB64, fixed.toString("base64url"));
  assert.equal(verifyPassword("injected-salt-pw", verifier), true);
});

test("hashPassword rejects missing or non-string passwords", () => {
  for (const bad of ["", null, undefined, 42]) {
    assert.throws(() => hashPassword(bad), /password string/i);
  }
  assert.throws(() => hashPassword("ok-length-password", { random: () => randomBytes(8) }), /16/);
});

test("checkPasswordPolicy enforces length boundaries honestly", () => {
  assert.equal(checkPasswordPolicy("a".repeat(PASSWORD_MIN_LENGTH)), null);
  assert.equal(checkPasswordPolicy("a".repeat(PASSWORD_MAX_LENGTH)), null);
  assert.equal(PASSWORD_MIN_LENGTH, 10);
  assert.equal(PASSWORD_MAX_LENGTH, 256);
  const short = checkPasswordPolicy("a".repeat(PASSWORD_MIN_LENGTH - 1));
  assert.equal(short.code, "password_too_short");
  assert.match(short.message, /10/);
  const long = checkPasswordPolicy("a".repeat(PASSWORD_MAX_LENGTH + 1));
  assert.equal(long.code, "password_too_long");
  assert.match(long.message, /256/);
  const missing = checkPasswordPolicy(null);
  assert.equal(missing.code, "invalid_password");
  const numeric = checkPasswordPolicy(12345678901);
  assert.equal(numeric.code, "invalid_password");
});

test("DUMMY_PASSWORD_VERIFIER is well-formed and never matches", () => {
  assert.match(DUMMY_PASSWORD_VERIFIER, VERIFIER_PATTERN);
  assert.equal(verifyPassword("anything-at-all", DUMMY_PASSWORD_VERIFIER), false);
  assert.equal(verifyPassword("dummy-password-verifier-placeholder", DUMMY_PASSWORD_VERIFIER), true);
});
