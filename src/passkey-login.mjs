// F019 — passkey (WebAuthn) login option.
//
// Completes the F017 sessions + F018 TOTP auth story: an owner can register
// a platform/roaming authenticator as a passkey and then sign in with it
// instead of (or alongside) TOTP.
//
// Pure logic, no store/schema/network/timer changes. WebAuthn ceremony
// steps are plain functions with explicit inputs: randomness and time are
// injectable (`random`, `now` options), and credential storage is entirely
// the caller's — every function that needs a credential takes a `store`
// object, so tests and wiring drive it deterministically:
//
//   store = {
//     getCredential(credentialId /* base64url */) -> record | undefined,
//     saveCredential(record) -> void,            // optional for these helpers
//     updateSignCount(credentialId, signCount),  // called after a verified assertion
//   }
//
//   Credential record shape (produced by verifyRegistrationResponse):
//     { id, rawId, rpId, publicKeyCose /* base64url */, publicKeyJwk,
//       signCount, aaguid /* base64url */, fmt, transports, createdAt }
//
// API:
//   base64urlEncode(bytes) / base64urlDecode(str)      — hand-rolled, no deps
//   generateChallenge(sizeBytes = 32, { random })       — base64url challenge
//   issueChallenge({ sizeBytes, ttlMs, random, now })  — { challenge, issuedAt, expiresAt }
//   isChallengeFresh(record, { now })                 — never throws
//   createRegistrationOptions({ rpId, rpName, user, challenge?, ... })
//   createAuthenticationOptions({ rpId, challenge?, allowCredentials?, ... })
//   parseClientDataJSON(encoded)                       — throws TypeError on malformed
//   verifyClientData({ clientDataJSON, expectedType, expectedChallenge, expectedOrigin })
//   cborDecode(bytes)                                  — minimal decoder (ints, bytes, text, arrays, maps)
//   parseAuthData(bytes)                               — rpIdHash, flags, signCount, attested data
//   coseKeyToJwk(coseBytes)                            — COSE ES256 -> JWK
//   defaultVerifySignature({ publicKeyCose, publicKeyJwk, data, signature }) — ES256 via node:crypto, never throws
//   verifyRegistrationResponse({ response, expected, now?, attestationVerifier? })
//   verifyAuthenticationAssertion({ assertion, expected, store, now?, requireUserVerification?, verifySignature? })
//
// Suggested wiring (follow-up slice): registration options served to the
// browser, the response posted back and verified here, the credential
// record persisted in the account store; authentication challenges issued
// single-use (consumed on first verify) and the resulting login minted as
// an F017 session. Attestation formats other than "none" need an
// `attestationVerifier` supplied by wiring (or a follow-up slice); the
// default rejects them rather than silently trusting unverified attestation.

import { randomBytes, createHash, createPublicKey, verify, timingSafeEqual } from "node:crypto";

export const WEBAUTHN_CREATE_TYPE = "webauthn.create";
export const WEBAUTHN_GET_TYPE = "webauthn.get";
export const CHALLENGE_BYTES = 32;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const REGISTRATION_TIMEOUT_MS = 60_000;
export const AUTHENTICATION_TIMEOUT_MS = 60_000;

// Authenticator-data flag bits (WebAuthn §6.1).
export const FLAG_USER_PRESENT = 0x01;
export const FLAG_USER_VERIFIED = 0x04;
export const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;
export const FLAG_EXTENSION_DATA = 0x80;

const isNonEmptyString = value => typeof value === "string" && value.length > 0;
const toBuffer = value => (Buffer.isBuffer(value) ? value : Buffer.from(value));

// Encode bytes as base64url (RFC 4648 §5): no padding, -_ alphabet.
export function base64urlEncode(bytes) {
  return toBuffer(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Decode base64url. Throws TypeError on characters outside the alphabet or
// malformed padding — never silently accepts garbage.
export function base64urlDecode(encoded) {
  if (typeof encoded !== "string") throw new TypeError("base64url input must be a string");
  if (!/^[A-Za-z0-9\-_]*$/.test(encoded)) {
    throw new TypeError("invalid base64url characters");
  }
  const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

// Constant-time string comparison for challenge / id checks. Returns false
// (rather than throwing) when the shapes differ.
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

const sha256 = bytes => createHash("sha256").update(toBuffer(bytes)).digest();

// Generate a fresh random challenge, base64url-encoded. `random` defaults
// to node's CSPRNG; tests inject a deterministic function.
export function generateChallenge(sizeBytes = CHALLENGE_BYTES, { random = randomBytes } = {}) {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw new RangeError("sizeBytes must be a positive integer");
  }
  return base64urlEncode(random(sizeBytes));
}

// Issue a challenge record the wiring slice can persist and consume
// single-use. Options: { sizeBytes = 32, ttlMs = 5min, random, now }.
export function issueChallenge({ sizeBytes = CHALLENGE_BYTES, ttlMs = CHALLENGE_TTL_MS, random = randomBytes, now = Date.now() } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be a positive number");
  const issuedAt = Number(now);
  if (!Number.isFinite(issuedAt)) throw new TypeError("now must be a finite number");
  return {
    challenge: generateChallenge(sizeBytes, { random }),
    issuedAt,
    expiresAt: issuedAt + ttlMs,
  };
}

// True when the challenge record exists and has not expired. Never throws —
// malformed records are simply not fresh.
export function isChallengeFresh(record, { now = Date.now() } = {}) {
  if (record == null || typeof record !== "object") return false;
  if (!isNonEmptyString(record.challenge)) return false;
  const expiresAt = Number(record.expiresAt);
  const nowMs = Number(now);
  return Number.isFinite(expiresAt) && Number.isFinite(nowMs) && nowMs <= expiresAt;
}

const normalizeUserId = id => {
  if (typeof id === "string") return base64urlEncode(Buffer.from(id, "utf8"));
  return base64urlEncode(toBuffer(id));
};

function assertRpId(rpId) {
  if (!isNonEmptyString(rpId)) throw new TypeError("rpId must be a non-empty string");
}

// Registration (credential creation) options for navigator.credentials.create().
// The returned `challenge` is what the wiring slice must persist (single-use)
// and pass as expected.challenge to verifyRegistrationResponse.
// Options: { rpId, rpName = rpId, user: { id, name, displayName },
//   challenge?, timeout?, excludeCredentials?, attestation = "none",
//   authenticatorSelection?, random? }.
export function createRegistrationOptions({
  rpId,
  rpName = rpId,
  user,
  challenge,
  timeout = REGISTRATION_TIMEOUT_MS,
  excludeCredentials = [],
  attestation = "none",
  authenticatorSelection,
  random = randomBytes,
}) {
  assertRpId(rpId);
  if (user == null || typeof user !== "object") throw new TypeError("user must be an object");
  if (!isNonEmptyString(user.name)) throw new TypeError("user.name must be a non-empty string");
  const issued = isNonEmptyString(challenge) ? challenge : generateChallenge(CHALLENGE_BYTES, { random });
  const options = {
    challenge: issued,
    rp: { id: rpId, name: isNonEmptyString(rpName) ? rpName : rpId },
    user: {
      id: normalizeUserId(user.id),
      name: user.name,
      displayName: isNonEmptyString(user.displayName) ? user.displayName : user.name,
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 }, // ES256
      { type: "public-key", alg: -257 }, // RS256
    ],
    timeout,
    excludeCredentials: (Array.isArray(excludeCredentials) ? excludeCredentials : []).map(cred => ({
      type: "public-key",
      id: typeof cred === "string" ? cred : cred.id,
      ...(cred != null && typeof cred === "object" && Array.isArray(cred.transports) ? { transports: cred.transports } : {}),
    })),
    attestation,
  };
  if (authenticatorSelection != null && typeof authenticatorSelection === "object") {
    options.authenticatorSelection = authenticatorSelection;
  }
  return { options, challenge: issued };
}

// Authentication (assertion) options for navigator.credentials.get().
// Options: { rpId, challenge?, timeout?, allowCredentials = [],
//   userVerification = "preferred", random? }.
export function createAuthenticationOptions({
  rpId,
  challenge,
  timeout = AUTHENTICATION_TIMEOUT_MS,
  allowCredentials = [],
  userVerification = "preferred",
  random = randomBytes,
}) {
  assertRpId(rpId);
  const issued = isNonEmptyString(challenge) ? challenge : generateChallenge(CHALLENGE_BYTES, { random });
  return {
    options: {
      challenge: issued,
      timeout,
      rpId,
      allowCredentials: (Array.isArray(allowCredentials) ? allowCredentials : []).map(cred => ({
        type: "public-key",
        id: typeof cred === "string" ? cred : cred.id,
        ...(cred != null && typeof cred === "object" && Array.isArray(cred.transports) ? { transports: cred.transports } : {}),
      })),
      userVerification,
    },
    challenge: issued,
  };
}

// Parse the base64url-encoded clientDataJSON from a credential response.
// Throws TypeError when the encoding is bad, the JSON is malformed, or the
// result is not an object.
export function parseClientDataJSON(encoded) {
  let parsed;
  try {
    parsed = JSON.parse(base64urlDecode(encoded).toString("utf8"));
  } catch {
    throw new TypeError("clientDataJSON is not valid base64url JSON");
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("clientDataJSON must decode to an object");
  }
  return parsed;
}

// Verify the client-data ceremony: type, challenge (constant-time), and
// origin. `expectedType` is "webauthn.create" or "webauthn.get". Throws
// Error on any mismatch; returns the parsed client data on success.
export function verifyClientData({ clientDataJSON, expectedType, expectedChallenge, expectedOrigin }) {
  const data = parseClientDataJSON(clientDataJSON);
  if (data.type !== expectedType) {
    throw new Error(`unexpected client data type: ${JSON.stringify(data.type)}`);
  }
  if (!constantTimeEqual(data.challenge, expectedChallenge)) {
    throw new Error("challenge mismatch");
  }
  if (data.origin !== expectedOrigin) {
    throw new Error(`unexpected origin: ${JSON.stringify(data.origin)}`);
  }
  return data;
}

// Minimal CBOR decoder: unsigned/negative ints, byte strings, text strings,
// arrays, definite-length maps. Enough for attestationObject and COSE keys.
// Throws TypeError on truncated or unsupported input.
function cborRead(input, offset) {
  if (offset >= input.length) throw new TypeError("truncated CBOR");
  const initial = input[offset];
  const major = initial >> 5;
  const info = initial & 0x1f;
  offset += 1;
  const readLength = () => {
    if (info < 24) return [info, offset];
    if (info === 24) return [input[offset], offset + 1];
    if (info === 25) return [input.readUInt16BE(offset), offset + 2];
    if (info === 26) return [input.readUInt32BE(offset), offset + 4];
    if (info === 27) return [Number(input.readBigUInt64BE(offset)), offset + 8];
    throw new TypeError("indefinite-length CBOR is not supported");
  };
  if (major === 0) {
    const [value, next] = readLength();
    return [value, next];
  }
  if (major === 1) {
    const [value, next] = readLength();
    return [-1 - value, next];
  }
  if (major === 2 || major === 3) {
    const [length, next] = readLength();
    if (next + length > input.length) throw new TypeError("truncated CBOR string");
    const slice = input.subarray(next, next + length);
    return [major === 2 ? Buffer.from(slice) : slice.toString("utf8"), next + length];
  }
  if (major === 4) {
    const [length, start] = readLength();
    const items = [];
    let cursor = start;
    for (let i = 0; i < length; i += 1) {
      const [item, next] = cborRead(input, cursor);
      items.push(item);
      cursor = next;
    }
    return [items, cursor];
  }
  if (major === 5) {
    const [length, start] = readLength();
    const map = new Map();
    let cursor = start;
    for (let i = 0; i < length; i += 1) {
      const [key, afterKey] = cborRead(input, cursor);
      const [value, afterValue] = cborRead(input, afterKey);
      map.set(key, value);
      cursor = afterValue;
    }
    return [map, cursor];
  }
  throw new TypeError("unsupported CBOR major type");
}

export function cborDecode(bytes) {
  const [value] = cborRead(toBuffer(bytes), 0);
  return value;
}

// Parse authenticator data (WebAuthn §6.1): rpIdHash || flags || signCount
// [|| attestedCredentialData || extensions]. Returns
// { rpIdHash, flags: { userPresent, userVerified, attestedCredentialData,
//   extensionData }, signCount, aaguid?, credentialId?, credentialPublicKey? }.
// Throws TypeError on truncated input.
export function parseAuthData(authData) {
  const input = toBuffer(authData);
  if (input.length < 37) throw new TypeError("authenticator data is too short");
  const rpIdHash = input.subarray(0, 32);
  const flagsByte = input[32];
  const flags = {
    userPresent: (flagsByte & FLAG_USER_PRESENT) !== 0,
    userVerified: (flagsByte & FLAG_USER_VERIFIED) !== 0,
    attestedCredentialData: (flagsByte & FLAG_ATTESTED_CREDENTIAL_DATA) !== 0,
    extensionData: (flagsByte & FLAG_EXTENSION_DATA) !== 0,
  };
  const signCount = input.readUInt32BE(33);
  const result = { rpIdHash, flags, signCount };
  if (flags.attestedCredentialData) {
    let offset = 37;
    if (input.length < offset + 18) throw new TypeError("attested credential data is truncated");
    result.aaguid = input.subarray(offset, offset + 16);
    offset += 16;
    const credentialIdLength = input.readUInt16BE(offset);
    offset += 2;
    if (input.length < offset + credentialIdLength) throw new TypeError("credential id is truncated");
    result.credentialId = input.subarray(offset, offset + credentialIdLength);
    offset += credentialIdLength;
    const [publicKey, next] = cborRead(input, offset);
    if (!(publicKey instanceof Map)) throw new TypeError("credential public key is not a COSE map");
    result.credentialPublicKey = input.subarray(offset, next);
  }
  return result;
}

// Convert a COSE_Key (CBOR) for ES256 (kty EC2, alg ES256, crv P-256) to a
// JWK the wiring slice (or defaultVerifySignature) can use with node:crypto.
// Throws TypeError/RangeError on anything that is not a P-256 ES256 key.
export function coseKeyToJwk(coseBytes) {
  const decoded = cborDecode(coseBytes);
  if (!(decoded instanceof Map)) throw new TypeError("COSE key must decode to a map");
  const kty = decoded.get(1);
  const alg = decoded.get(3);
  const crv = decoded.get(-1);
  const x = decoded.get(-2);
  const y = decoded.get(-3);
  if (kty !== 2) throw new RangeError(`unsupported COSE kty: ${JSON.stringify(kty)} (only EC2)`);
  if (alg !== -7) throw new RangeError(`unsupported COSE alg: ${JSON.stringify(alg)} (only ES256/-7)`);
  if (crv !== 1) throw new RangeError(`unsupported COSE crv: ${JSON.stringify(crv)} (only P-256)`);
  if (!Buffer.isBuffer(x) || x.length !== 32 || !Buffer.isBuffer(y) || y.length !== 32) {
    throw new TypeError("COSE P-256 key must carry 32-byte x and y coordinates");
  }
  return { kty: "EC", crv: "P-256", x: base64urlEncode(x), y: base64urlEncode(y) };
}

// Default assertion signature verifier: ES256 over
// authenticatorData || SHA-256(clientDataJSON), via node:crypto with
// ieee-p1363 (raw R||S) signatures. Never throws — returns false on any
// failure (bad key, bad signature shape, crypto error). Override with the
// `verifySignature` option for other algorithms.
export function defaultVerifySignature({ publicKeyCose, publicKeyJwk, data, signature }) {
  try {
    const jwk = publicKeyJwk != null ? publicKeyJwk : coseKeyToJwk(publicKeyCose);
    if (jwk == null || jwk.kty !== "EC" || jwk.crv !== "P-256") return false;
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
    const sig = toBuffer(signature);
    if (sig.length !== 64) return false;
    return verify("sha256", toBuffer(data), { key, dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    return false;
  }
}

function assertChallengeFresh(expected, now) {
  if (expected == null || typeof expected !== "object") throw new TypeError("expected must be an object");
  if (!isNonEmptyString(expected.challenge)) throw new TypeError("expected.challenge must be a non-empty string");
  if (expected.expiresAt !== undefined && Number.isFinite(Number(expected.expiresAt)) && Number(now) > Number(expected.expiresAt)) {
    throw new Error("challenge expired");
  }
  assertRpId(expected.rpId);
  if (!isNonEmptyString(expected.origin)) throw new TypeError("expected.origin must be a non-empty string");
}

function checkRpIdHash(rpIdHash, rpId) {
  if (rpIdHash.length !== 32 || !timingSafeEqual(rpIdHash, sha256(rpId))) {
    throw new Error("rpId hash mismatch");
  }
}

// Verify a registration (credential creation) response and return the
// credential record to persist. `response` mirrors
// PublicKeyCredential: { id, rawId, type: "public-key",
//   response: { clientDataJSON, attestationObject }, transports? }.
// `expected`: { challenge, rpId, origin, expiresAt? }.
// `attestationVerifier({ fmt, authData, clientDataHash, attStmt })` defaults
// to accepting only fmt "none" (empty attStmt); anything else must be
// verified by wiring-supplied code. Throws Error/TypeError on any failure.
export function verifyRegistrationResponse({
  response,
  expected,
  now = Date.now(),
  attestationVerifier,
}) {
  if (response == null || typeof response !== "object") throw new TypeError("response must be an object");
  assertChallengeFresh(expected, now);
  if (response.type !== "public-key") throw new Error(`unexpected credential type: ${JSON.stringify(response.type)}`);
  const inner = response.response;
  if (inner == null || typeof inner !== "object") throw new TypeError("response.response must be an object");

  const clientData = verifyClientData({
    clientDataJSON: inner.clientDataJSON,
    expectedType: WEBAUTHN_CREATE_TYPE,
    expectedChallenge: expected.challenge,
    expectedOrigin: expected.origin,
  });

  const attestationObject = cborDecode(base64urlDecode(inner.attestationObject));
  if (!(attestationObject instanceof Map)) throw new TypeError("attestationObject must decode to a map");
  const fmt = attestationObject.get("fmt");
  const authDataBytes = attestationObject.get("authData");
  const attStmt = attestationObject.get("attStmt");
  if (typeof fmt !== "string") throw new TypeError("attestation fmt must be a string");
  if (!Buffer.isBuffer(authDataBytes)) throw new TypeError("attestation authData must be bytes");
  if (!(attStmt instanceof Map)) throw new TypeError("attestation attStmt must be a map");

  const authData = parseAuthData(authDataBytes);
  if (!authData.flags.userPresent) throw new Error("user presence flag not set");
  if (!authData.flags.attestedCredentialData || authData.credentialId == null || authData.credentialPublicKey == null) {
    throw new Error("registration missing attested credential data");
  }
  checkRpIdHash(authData.rpIdHash, expected.rpId);

  const clientDataHash = sha256(base64urlDecode(inner.clientDataJSON));
  if (fmt === "none") {
    if (attStmt.size !== 0) throw new Error('fmt "none" requires an empty attStmt');
  } else if (typeof attestationVerifier === "function") {
    const ok = attestationVerifier({ fmt, authData: authDataBytes, clientDataHash, attStmt });
    if (ok !== true) throw new Error(`attestation format not verified: ${fmt}`);
  } else {
    throw new Error(`attestation format requires a verifier: ${fmt}`);
  }

  const credentialId = base64urlEncode(authData.credentialId);
  if (isNonEmptyString(response.id) && !constantTimeEqual(response.id, credentialId)) {
    throw new Error("credential id mismatch between response.id and attested data");
  }

  const createdAt = Number(now);
  return {
    id: credentialId,
    rawId: credentialId,
    rpId: expected.rpId,
    publicKeyCose: base64urlEncode(authData.credentialPublicKey),
    publicKeyJwk: coseKeyToJwk(authData.credentialPublicKey),
    signCount: authData.signCount,
    aaguid: base64urlEncode(authData.aaguid),
    fmt,
    transports: Array.isArray(response.transports) ? [...response.transports] : [],
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    userHandle: clientData.userHandle ?? null,
  };
}

// Verify an authentication assertion and return { credentialId, userHandle,
// signCount }. `assertion` mirrors PublicKeyCredential:
// { id, rawId, type: "public-key",
//   response: { clientDataJSON, authenticatorData, signature, userHandle? } }.
// `expected`: { challenge, rpId, origin, expiresAt? }.
// `store.getCredential(credentialId)` must return the record from
// verifyRegistrationResponse (or equivalent); `store.updateSignCount` is
// called on success when present. Counter rule: the assertion's signCount
// must exceed the stored one, except the 0/0 case (authenticator not
// counting) — anything else is a replay or a cloned authenticator and
// throws. `verifySignature` defaults to ES256 via defaultVerifySignature.
// Throws Error/TypeError on any failure; the store is never touched on
// failure.
export function verifyAuthenticationAssertion({
  assertion,
  expected,
  store,
  now = Date.now(),
  requireUserVerification = false,
  verifySignature = defaultVerifySignature,
}) {
  if (assertion == null || typeof assertion !== "object") throw new TypeError("assertion must be an object");
  assertChallengeFresh(expected, now);
  if (store == null || typeof store.getCredential !== "function") {
    throw new TypeError("store.getCredential must be a function");
  }
  if (assertion.type !== "public-key") throw new Error(`unexpected credential type: ${JSON.stringify(assertion.type)}`);
  const inner = assertion.response;
  if (inner == null || typeof inner !== "object") throw new TypeError("assertion.response must be an object");

  verifyClientData({
    clientDataJSON: inner.clientDataJSON,
    expectedType: WEBAUTHN_GET_TYPE,
    expectedChallenge: expected.challenge,
    expectedOrigin: expected.origin,
  });

  const authDataBytes = base64urlDecode(inner.authenticatorData);
  const authData = parseAuthData(authDataBytes);
  checkRpIdHash(authData.rpIdHash, expected.rpId);
  if (!authData.flags.userPresent) throw new Error("user presence flag not set");
  if (requireUserVerification && !authData.flags.userVerified) {
    throw new Error("user verification required but flag not set");
  }

  const credentialId = isNonEmptyString(assertion.id)
    ? assertion.id
    : base64urlEncode(base64urlDecode(assertion.rawId));
  const record = store.getCredential(credentialId);
  if (record == null || typeof record !== "object") throw new Error("unknown credential");
  if (record.rpId !== expected.rpId) throw new Error("credential rpId mismatch");

  const storedCount = Number(record.signCount ?? 0);
  const seenCount = authData.signCount;
  const counterOk = seenCount > storedCount || (seenCount === 0 && storedCount === 0);
  if (!counterOk) {
    throw new Error("assertion signCount not greater than stored value (possible replay or cloned authenticator)");
  }

  const clientDataBytes = base64urlDecode(inner.clientDataJSON);
  const signedData = Buffer.concat([authDataBytes, sha256(clientDataBytes)]);
  const signatureOk = verifySignature({
    publicKeyCose: record.publicKeyCose != null ? base64urlDecode(record.publicKeyCose) : undefined,
    publicKeyJwk: record.publicKeyJwk,
    data: signedData,
    signature: base64urlDecode(inner.signature),
  });
  if (signatureOk !== true) throw new Error("assertion signature invalid");

  if (typeof store.updateSignCount === "function") {
    store.updateSignCount(credentialId, seenCount);
  }
  return {
    credentialId,
    userHandle: typeof inner.userHandle === "string" ? inner.userHandle : null,
    signCount: seenCount,
  };
}
