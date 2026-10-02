// Operator credential. The surface does not exist unless
// ROOM_OPERATOR_TOKEN_SHA256 is set to the hex SHA-256 of a random token of
// at least 32 bytes. A missing or wrong token answers 404, the same code as
// an unknown path, so the route is not an oracle.

import { createHash, timingSafeEqual } from "node:crypto";

export const OPERATOR_TOKEN_ENV = "ROOM_OPERATOR_TOKEN_SHA256";
const TOKEN_MIN_BYTES = 32;
const TOKEN_MAX_CHARS = 256;

export function operatorEnv() {
  return globalThis.process?.env ?? {};
}

// Null when the surface is off: unset, blank, or not a SHA-256 hex digest.
export function configuredOperatorTokenHash(env = operatorEnv()) {
  const raw = env?.[OPERATOR_TOKEN_ENV];
  if (typeof raw !== "string") return null;
  const hex = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return hex;
}

export function operatorSurfaceEnabled(env = operatorEnv()) {
  return configuredOperatorTokenHash(env) !== null;
}

export function presentedOperatorToken(authorization) {
  if (typeof authorization !== "string") return null;
  const match = /^Operator (\S+)$/.exec(authorization);
  if (!match) return null;
  const token = match[1];
  if (token.length > TOKEN_MAX_CHARS || Buffer.byteLength(token) < TOKEN_MIN_BYTES) return null;
  return token;
}

// True when the presented token's SHA-256 matches the configured digest.
// A missing or short token is false. Both digests are 32 bytes, so the
// comparison does not throw.
export function operatorTokenMatches(token, env = operatorEnv()) {
  const expectedHex = configuredOperatorTokenHash(env);
  if (!expectedHex || typeof token !== "string") return false;
  const actual = createHash("sha256").update(token).digest();
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Room and account cookies are not an operator credential. A request that
// carries one without an Operator authorization header is refused.
export function carriesRoomOrAccountCookie(cookieHeader) {
  if (typeof cookieHeader !== "string" || cookieHeader.length === 0) return false;
  return /(?:^|;\s*)(?:__Host-)?(?:[A-Za-z0-9_-]+_)?(?:room_session|account_session)=/.test(cookieHeader);
}
