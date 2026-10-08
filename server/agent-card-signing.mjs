// Ed25519 signing for agent directory cards (RC-2026-09-18-014).
//
// Research recommendation A4: directory cards are signed (JWS-style) so any
// agent can verify offline that a card was published by the holder of the
// named agent's key. This module is pure: node:crypto only, no dependencies,
// no I/O. Callers own key storage; the private key never leaves the signer.
//
// Wire formats:
//   publicKey  base64 of the 32-byte Ed25519 public key (canonical base64)
//   privateKey base64 of the 32-byte Ed25519 seed (canonical base64)
//   signature  base64 of the 64-byte Ed25519 signature (canonical base64)
//
// The signed payload is the canonical card body: { agentId, name,
// description, url?, capabilities, skills?, version } with keys sorted
// recursively and no whitespace. The envelope fields (publicKey, signature,
// visibility) are never part of the signed bytes, so a verifier recomputes
// exactly what the signer signed. Binding agentId into the payload stops a
// signed card being transplanted under a different agentId.
//
// Key rotation is a chain of custody: the OLD key signs a rotation statement
// { type, agentId, newPublicKey, card } authorizing the new key. Losing the
// old key is recovered out-of-band (the identity owner's credential), never
// by self-assertion.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

class SigningError extends Error {
  constructor(code, message) { super(message); this.name = "SigningError"; this.code = code; }
}

// Card body fields covered by the signature. Everything else on the card
// object (publicKey, signature, server-added metadata) is envelope.
// joinRequest (RC-2026-09-25-912) binds a self-serve guest request to its
// room + idempotency key; cards signed before it existed verify unchanged
// because absent fields are skipped.
const CARD_BODY_FIELDS = ["name", "description", "url", "capabilities", "skills", "version", "joinRequest"];

const fail = (code, message) => { throw new SigningError(code, message); };

// Fixed PKCS#8 DER prefix for an Ed25519 private key (RFC 8410): lets us
// import a raw 32-byte seed without keeping the full DER around.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const decodeBase64 = (value, expectedLength, label) => {
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid_signing_input", `${label} must be a base64 string`);
  }
  const bytes = Buffer.from(value, "base64");
  // Require the canonical base64 spelling (no stray whitespace, correct
  // padding) so keys and signatures compare byte-identically everywhere.
  if (bytes.length !== expectedLength || bytes.toString("base64") !== value) {
    fail("invalid_signing_input", `${label} must be canonical base64 of ${expectedLength} bytes`);
  }
  return bytes;
};

const importPublicKey = publicKey => {
  const raw = decodeBase64(publicKey, 32, "publicKey");
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
};

const importPrivateKey = privateKey => {
  const seed = decodeBase64(privateKey, 32, "privateKey");
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
};

// Recursively sort object keys; arrays keep their order (capability order
// is part of what the signature covers). undefined values are dropped.
// Exported: offline verifiers (e.g. the attested-ballot recount in
// server/attested-votes.mjs) canonicalize payloads the same way.
export const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const child = canonicalize(value[key]);
      if (child !== undefined) out[key] = child;
    }
    return out;
  }
  return value;
};

// Normalize the optional card fields exactly the way the public directory
// document does (server/agent-directory.mjs cardDoc): url defaults to null,
// skills defaults to []. Without this, a card signed with those fields
// omitted verifies against the submitted shape but fails offline verification
// against the normalized public document readers actually see.
const normalizeCardBody = card => ({ ...card, url: card.url ?? null, skills: card.skills ?? [] });

// The exact bytes a card signature covers. agentId is bound into the
// payload; only CARD_BODY_FIELDS of the card are covered.
export function canonicalCardBytes({ agentId, card }) {
  if (typeof agentId !== "string" || agentId.length === 0) {
    fail("invalid_signing_input", "agentId must be a non-empty string");
  }
  if (card === null || typeof card !== "object" || Array.isArray(card)) {
    fail("invalid_signing_input", "card must be an object");
  }
  const body = { agentId };
  const normalized = normalizeCardBody(card);
  for (const field of CARD_BODY_FIELDS) {
    if (normalized[field] !== undefined) body[field] = normalized[field];
  }
  return Buffer.from(JSON.stringify(canonicalize(body)), "utf8");
}

// The exact bytes a key-rotation statement covers: the old key authorizes
// the new key for the given agentId and card body.
export function rotationBytes({ agentId, card, newPublicKey }) {
  if (typeof agentId !== "string" || agentId.length === 0) {
    fail("invalid_signing_input", "agentId must be a non-empty string");
  }
  if (!isValidPublicKey(newPublicKey)) {
    fail("invalid_signing_input", "newPublicKey must be a valid Ed25519 public key");
  }
  const cardBody = {};
  const normalized = card !== null && typeof card === "object" ? normalizeCardBody(card) : {};
  for (const field of CARD_BODY_FIELDS) {
    if (normalized[field] !== undefined) cardBody[field] = normalized[field];
  }
  const payload = {
    type: "agent-card-key-rotation",
    agentId,
    newPublicKey,
    card: canonicalize(cardBody),
  };
  return Buffer.from(JSON.stringify(canonicalize(payload)), "utf8");
}

export function isValidPublicKey(publicKey) {
  try { importPublicKey(publicKey); return true; }
  catch { return false; }
}

// Generate a fresh Ed25519 key pair. The private seed must be stored by the
// caller; it is never returned by any read path.
export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64"),
    privateKey: Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url").toString("base64"),
  };
}

// Sign a card body. Throws SigningError on bad inputs; never returns a
// partial signature.
export function signCard({ agentId, card, privateKey }) {
  const key = importPrivateKey(privateKey);
  return sign(null, canonicalCardBytes({ agentId, card }), key).toString("base64");
}

// Verify a card signature. Returns false (never throws) for any malformed
// or non-matching input: verifiers treat "no" as the safe answer.
export function verifyCardSignature({ agentId, card, publicKey, signature }) {
  try {
    const key = importPublicKey(publicKey);
    const sig = Buffer.from(typeof signature === "string" ? signature : "", "base64");
    if (sig.length !== 64) return false;
    return verify(null, canonicalCardBytes({ agentId, card }), key, sig);
  } catch {
    return false;
  }
}

// Sign a key-rotation statement with the OLD (currently pinned) key.
export function signKeyRotation({ agentId, card, newPublicKey, oldPrivateKey }) {
  const key = importPrivateKey(oldPrivateKey);
  return sign(null, rotationBytes({ agentId, card, newPublicKey }), key).toString("base64");
}

// Verify a key-rotation statement against the OLD (currently pinned) key.
// Returns false (never throws) for any malformed or non-matching input.
export function verifyKeyRotation({ agentId, card, newPublicKey, oldPublicKey, rotationSignature }) {
  try {
    const key = importPublicKey(oldPublicKey);
    const sig = Buffer.from(typeof rotationSignature === "string" ? rotationSignature : "", "base64");
    if (sig.length !== 64) return false;
    return verify(null, rotationBytes({ agentId, card, newPublicKey }), key, sig);
  } catch {
    return false;
  }
}

// Sign arbitrary bytes with an Ed25519 private key (seed, canonical base64).
// Throws SigningError on bad inputs. The generic counterpart to signCard:
// clients (e.g. ballot voters) sign canonical payloads the server verifies
// with verifySignatureBytes.
export function signBytes({ privateKey, bytes }) {
  const key = importPrivateKey(privateKey);
  if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) {
    fail("invalid_signing_input", "bytes must be a Buffer or Uint8Array");
  }
  return sign(null, bytes, key).toString("base64");
}

// Verify an Ed25519 signature over arbitrary bytes. Returns false (never
// throws) for any malformed or non-matching input: verifiers treat "no" as
// the safe answer. The generic counterpart to verifyCardSignature — this is
// the one crypto addition the attested-ballot protocol needs.
export function verifySignatureBytes({ publicKey, signature, bytes }) {
  try {
    const key = importPublicKey(publicKey);
    const sig = Buffer.from(typeof signature === "string" ? signature : "", "base64");
    if (sig.length !== 64) return false;
    if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) return false;
    return verify(null, bytes, key, sig);
  } catch {
    return false;
  }
}

export { SigningError };

// ---------------------------------------------------------------------------
// A2A v1.0 §8.4 JWS Agent Card signatures (RC-2026-09-27-2715).
//
// The house scheme above signs a canonical subset of the card with raw
// Ed25519. A2A v1.0 instead signs the whole card (minus `signatures`) as a
// JWS (RFC 7515) over a JCS (RFC 8785) canonical payload:
//
//   signing input = ASCII(BASE64URL(UTF8(protected)) || "." || BASE64URL(payload))
//
// Both schemes share the room's Ed25519 key; the JWS `alg` is "EdDSA"
// (RFC 8037 — node:crypto Ed25519 with a null digest is PureEdDSA, exactly
// what JWS EdDSA requires). This module stays pure: node:crypto only, no
// dependencies, no I/O.
//
// The existing canonicalize() (recursive key sort, no whitespace, arrays keep
// order) IS JCS for card payloads: cards contain only strings, booleans,
// arrays, and objects — no floats or exotic types — and the only property
// dropped from the payload is `signatures`. Note on spec §8.4's "remove
// properties with default values": that rule is defined against the A2A proto
// schema via ProtoJSON explicit presence (an explicitly-set optional field
// KEEPS its default value — e.g. `pushNotifications: false` is included when
// present). The room's discovery card is not a proto message, so there is no
// proto schema to judge defaults against; every property present in the
// served card is significant, and the payload is the served card minus
// `signatures`, nothing else. A verifier MUST apply the same rule —
// verifyCardJws does — or signatures will not match.
// ---------------------------------------------------------------------------

const b64urlEncode = buffer => buffer.toString("base64url");

const b64urlDecode = (value, label) => {
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid_signing_input", `${label} must be a base64url string`);
  }
  return Buffer.from(value, "base64url");
};

// The exact bytes a JWS signature covers: the card minus the `signatures`
// field, canonicalized per RFC 8785. Throws SigningError on bad input.
export function jwsPayloadBytes(card) {
  if (card === null || typeof card !== "object" || Array.isArray(card)) {
    fail("invalid_signing_input", "card must be an object");
  }
  const { signatures: _dropped, ...rest } = card;
  return Buffer.from(JSON.stringify(canonicalize(rest)), "utf8");
}

// Build the JWS Protected Header and return it base64url-encoded. Per A2A
// v1.0 §8.4 the header MUST carry `alg` and `kid`; `typ` SHOULD be "JOSE";
// `jku` (JWKS URL for key discovery) MAY be included.
export function jwsProtectedHeader({ keyId, jku }) {
  if (typeof keyId !== "string" || keyId.length === 0) {
    fail("invalid_signing_input", "keyId must be a non-empty string");
  }
  const header = { alg: "EdDSA", typ: "JOSE", kid: keyId };
  if (jku !== undefined) {
    if (typeof jku !== "string" || jku.length === 0) {
      fail("invalid_signing_input", "jku must be a non-empty string when present");
    }
    header.jku = jku;
  }
  return b64urlEncode(Buffer.from(JSON.stringify(header), "utf8"));
}

// The JWS signing input for a card: ASCII(protected + "." + base64url(payload)).
// Returns { protected, input } so signers keep the exact protected bytes.
export function jwsSigningInput({ card, keyId, jku }) {
  const payload = jwsPayloadBytes(card);
  const protectedHeader = jwsProtectedHeader({ keyId, jku });
  return {
    protected: protectedHeader,
    input: Buffer.from(`${protectedHeader}.${b64urlEncode(payload)}`, "ascii"),
  };
}

// Sign a card as an A2A v1.0 AgentCardSignature { protected, signature }.
// Throws SigningError on bad inputs; never returns a partial signature.
export function signCardJws({ card, privateKey, keyId, jku }) {
  const key = importPrivateKey(privateKey);
  const { protected: protectedHeader, input } = jwsSigningInput({ card, keyId, jku });
  return {
    protected: protectedHeader,
    signature: sign(null, input, key).toString("base64url"),
  };
}

// Verify an A2A v1.0 AgentCardSignature against the card and public key.
// Returns false (never throws) for any malformed or non-matching input:
// verifiers treat "no" as the safe answer. Verification uses the JWS's own
// `protected` bytes verbatim — the signature covers those exact bytes — and
// recomputes the payload from the presented card minus `signatures`.
export function verifyCardJws({ card, publicKey, jws }) {
  try {
    if (jws === null || typeof jws !== "object" || Array.isArray(jws)) return false;
    const protectedHeader = jws.protected;
    if (typeof protectedHeader !== "string" || protectedHeader.length === 0) return false;
    const headerJson = JSON.parse(b64urlDecode(protectedHeader, "protected").toString("utf8"));
    if (headerJson.alg !== "EdDSA") return false;
    const key = importPublicKey(publicKey);
    const sig = b64urlDecode(jws.signature, "signature");
    if (sig.length !== 64) return false;
    const payload = jwsPayloadBytes(card);
    const input = Buffer.from(`${protectedHeader}.${b64urlEncode(payload)}`, "ascii");
    return verify(null, input, key, sig);
  } catch {
    return false;
  }
}

// The room's pinned public key as a JWK (RFC 7517) for the JWKS key-discovery
// document. Throws SigningError on bad inputs.
export function publicKeyToJwk({ publicKey, keyId }) {
  if (typeof keyId !== "string" || keyId.length === 0) {
    fail("invalid_signing_input", "keyId must be a non-empty string");
  }
  const raw = decodeBase64(publicKey, 32, "publicKey");
  return { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url"), kid: keyId };
}
