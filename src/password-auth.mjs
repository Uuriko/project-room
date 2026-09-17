// Email+password credential crypto (slice 2, RC-2026-09-17-011). Pure
// hashing/verification: the store keeps only the opaque verifier string, so
// plaintext passwords never reach the database. Nothing here logs passwords,
// salts, or hashes.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 32;
export const SALT_BYTES = 16;
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

const VERIFIER_PREFIX = "scrypt";

const toBase64Url = bytes => bytes.toString("base64url");

// Hash a password into an opaque verifier string:
//   scrypt$16384$8$1$<base64url salt>$<base64url derived key>
// The params travel with the verifier so the format stays self-describing;
// verifyPassword only honors the exact parameter set above.
export function hashPassword(password, { random = randomBytes } = {}) {
  if (typeof password !== "string" || password.length === 0) throw new Error("A password string is required");
  const salt = random(SALT_BYTES);
  if (!Buffer.isBuffer(salt) || salt.length !== SALT_BYTES) throw new Error("The salt must be 16 random bytes");
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `${VERIFIER_PREFIX}$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

// Parse a verifier into its parameters. Returns null for anything that is
// not a well-formed scrypt verifier — callers treat that as "no match"
// rather than an error. The parameters must match this module's exactly:
// a verifier string is trusted input only insofar as we minted it, so any
// deviation (including a costlier N smuggled into the string) is rejected
// instead of honored.
const parseVerifier = verifier => {
  if (typeof verifier !== "string") return null;
  const parts = verifier.split("$");
  if (parts.length !== 6 || parts[0] !== VERIFIER_PREFIX) return null;
  const [, n, r, p, saltB64, hashB64] = parts;
  const N = Number(n), rr = Number(r), pp = Number(p);
  if (N !== SCRYPT_N || rr !== SCRYPT_R || pp !== SCRYPT_P) return null;
  let salt, hash;
  try {
    salt = Buffer.from(saltB64, "base64url");
    hash = Buffer.from(hashB64, "base64url");
  } catch {
    return null;
  }
  // Bounded so a crafted verifier string cannot demand absurd memory/time.
  if (salt.length !== SALT_BYTES || hash.length === 0 || hash.length > 64) return null;
  return { N, r: rr, p: pp, salt, hash };
};

// Re-derive and compare with crypto.timingSafeEqual. Returns false (never
// throws) on malformed verifiers or wrong passwords.
export function verifyPassword(password, verifier) {
  if (typeof password !== "string") return false;
  const parsed = parseVerifier(verifier);
  if (!parsed) return false;
  const { N, r, p, salt, hash } = parsed;
  let derived;
  try {
    derived = scryptSync(password, salt, hash.length, { N, r, p });
  } catch {
    return false;
  }
  if (derived.length !== hash.length) return false;
  return timingSafeEqual(derived, hash);
}

// Password policy: length only, honest messages, no complexity theater.
// Returns null when the password is acceptable, otherwise { code, message }.
export function checkPasswordPolicy(password) {
  if (typeof password !== "string") return { code: "invalid_password", message: "A password is required" };
  if (password.length < PASSWORD_MIN_LENGTH)
    return { code: "password_too_short", message: `Use at least ${PASSWORD_MIN_LENGTH} characters` };
  if (password.length > PASSWORD_MAX_LENGTH)
    return { code: "password_too_long", message: `Use at most ${PASSWORD_MAX_LENGTH} characters` };
  return null;
}

// Well-formed placeholder verifier used by the login routes when an account
// has no password set (or no account exists for the email). Verifying against
// it always costs one full scrypt derivation, so a wrong-password response
// never reveals whether the email is registered.
//
// This is a fixed string literal (not minted at module load) because the
// Workers runtime forbids random generation during module evaluation; the
// value is a real scrypt verifier for an unguessable placeholder, so it
// behaves identically to a minted one.
export const DUMMY_PASSWORD_VERIFIER = "scrypt$16384$8$1$TQ4ug3qQaXHk4bKZFJ5Dlw$m2yyt62ODf_PX6D77r-zd8oDuFchuzwdfF9TXBDsjuY";
