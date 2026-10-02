// Ed25519 compact JWS for Room lease tokens. The public key arrives as
// ROOM_RESOURCE_LEASE_PUBLIC_JWK once RES-0 ships. Replay of a still-valid
// token is allowed; Room pushes revocations separately.

import { b64urlToBytes } from "./bytes.mjs";
import { relayError } from "./errors.mjs";
import { LEASE_TOKEN_TTL_MS } from "./protocol.mjs";

const keys = new Map();

function decodeJson(part) {
  const bytes = b64urlToBytes(part);
  if (!bytes) return null;
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { return null; }
}

async function publicKey(jwkText) {
  const cached = keys.get(jwkText);
  if (cached) return cached;
  let parsed;
  try { parsed = JSON.parse(jwkText); }
  catch { throw relayError(503, "lease_verifier_unconfigured", "ROOM_RESOURCE_LEASE_PUBLIC_JWK is not valid JSON"); }
  if (!parsed || parsed.kty !== "OKP" || parsed.crv !== "Ed25519" || typeof parsed.x !== "string") {
    throw relayError(503, "lease_verifier_unconfigured", "ROOM_RESOURCE_LEASE_PUBLIC_JWK must be an Ed25519 public JWK");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", x: parsed.x },
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  keys.set(jwkText, key);
  return key;
}

function stringClaim(claims, name, max) {
  const value = claims[name];
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw relayError(401, "lease_token_rejected", `The lease token ${name} claim is invalid`);
  }
  return value;
}

export async function verifyLeaseToken(jwkText, token, now) {
  if (!jwkText) throw relayError(503, "lease_verifier_unconfigured", "ROOM_RESOURCE_LEASE_PUBLIC_JWK is not set");
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) throw relayError(401, "lease_token_rejected", "The lease token signature was refused");
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  const signature = b64urlToBytes(parts[2]);
  if (!header || header.alg !== "EdDSA" || !claims || !signature) {
    throw relayError(401, "lease_token_rejected", "The lease token signature was refused");
  }
  const key = await publicKey(jwkText);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, signature, signed);
  if (!ok) throw relayError(401, "lease_token_rejected", "The lease token signature was refused");
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    throw relayError(401, "lease_token_rejected", "The lease token exp claim is invalid");
  }
  const expMs = claims.exp * 1000;
  if (expMs <= now) throw relayError(401, "lease_token_expired", "The lease token has expired");
  if (expMs > now + LEASE_TOKEN_TTL_MS) throw relayError(401, "lease_token_ttl", "The lease token lives longer than 15 minutes");
  if (!Number.isSafeInteger(claims.epoch) || claims.epoch < 0) {
    throw relayError(401, "lease_token_rejected", "The lease token epoch is invalid");
  }
  if (!Array.isArray(claims.caps) || claims.caps.some(cap => typeof cap !== "string" || cap.length < 1 || cap.length > 64)) {
    throw relayError(401, "lease_token_rejected", "The lease token caps claim is invalid");
  }
  return {
    iss: stringClaim(claims, "iss", 200),
    aud: stringClaim(claims, "aud", 200),
    sub: stringClaim(claims, "sub", 128),
    room: stringClaim(claims, "room", 128),
    claim: stringClaim(claims, "claim", 128),
    slot: stringClaim(claims, "slot", 64),
    caps: [...claims.caps],
    epoch: claims.epoch,
    exp: claims.exp,
    jti: stringClaim(claims, "jti", 128),
  };
}
