// Canonical signed external evidence for work.completed (integration map slice #5).
//
// The work.completed evidence contract (PR #743) has two paths. The native
// room_text path is already strong (sha256 of the exact message bytes,
// verified by the room). The external path was weak: a freeform
// evidenceUrl plus a freeform version string — anyone could claim anything.
// This module brings the external path up to the same bar using the
// already-tested primitives from the landed slices:
//
// - Canonical byte-exact encoding: RFC 8785 as restated in
//   server/bounty-receipts.mjs (slice #1), including the hard ban on JSON
//   numbers inside signed bodies. The signing bytes are
//   canonicalJson(everything except `signature`), byte-identical for every
//   conforming implementation.
// - Trust root: server/agent-key-registry.mjs (slice #9). The signer binds
//   to a ROOM identity card only — never to a real-world identity. A
//   signature verifies only against a registry key whose validity window
//   covers the evidence's issuedAt, so rotation and revocation are honored.
//
// What this is NOT: the room never fetches evidenceUrl and never judges
// the external content. The signature attests "identity X asserts that the
// bytes hashing to contentHash are the evidence for this completion".
// Verifiers holding the content recompute the sha256; verifiers holding the
// evidence object check the signature offline against the registry.
//
// Wire formats (documented for offline verifiers):
//   evidenceId        "room-evidence:ex:<32 lowercase hex>" (128-bit nonce,
//                     replay protection — one attestation, one completion)
//   signerIdentityId  agent identity id as registered ([A-Za-z0-9_-]{1,64})
//   issuedAt          canonical RFC 3339 UTC ("…:56Z" or "…:56.789Z")
//   contentHash       "sha256:<64 lowercase hex>" of the external content bytes
//   signature         128 lowercase hex Ed25519 over the canonical bytes
//   registry pubkeys  canonical base64 of 32 bytes (as stored by the key
//                     registry); converted to hex internally for verification
//
// Pure except for the injected seams: node:crypto only, no I/O. The key
// registry is injected ({ keysFor }), replay state is injected ({ has }).
// The store-level glue (verifyCompletionEvidence) binds those seams to the
// room database on the live command path.
//
// Credits-only boundary: evidence names content hashes and room identities
// only. Nothing here references assets, chains, transactions, or cash value.
import { randomBytes, createHash } from "node:crypto";
import {
  canonicalJson,
  parseStrict,
  signBytes,
  verifyBytes,
  validIssuedAt,
} from "./bounty-receipts.mjs";
import { isValidPublicKey } from "./agent-card-signing.mjs";

export const EVIDENCE_SCHEMA_VERSION = "room-signed-evidence/1";
export const EVIDENCE_KINDS = Object.freeze(["external"]);

class EvidenceError extends Error {
  constructor(code, message) { super(message); this.name = "EvidenceError"; this.code = code; }
}
const fail = (code, message) => { throw new EvidenceError(code, message); };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const EVIDENCE_ID = /^room-evidence:ex:[0-9a-f]{32}$/;
const IDENTITY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;

const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

// The number ban (bounty-receipts §4): a JSON number has multiple legal
// serializations, so any number inside the signed portion is rejected
// before signature verification — including before it.
const assertNoNumbers = (value, path) => {
  if (typeof value === "number" || typeof value === "bigint")
    fail("number_ban", `JSON number forbidden in signed body at ${path}`);
  if (Array.isArray(value)) value.forEach((v, n) => assertNoNumbers(v, `${path}[${n}]`));
  else if (isPlainObject(value))
    for (const key of Object.keys(value)) assertNoNumbers(value[key], `${path}.${key}`);
};

const nonEmpty = (value, max, label) => {
  if (typeof value !== "string" || value.length < 1 || value.length > max)
    fail("invalid_evidence", `${label} must be a 1..${max}-character string`);
};

const REQUIRED_KEYS = ["schemaVersion", "evidenceId", "kind", "signerIdentityId", "issuedAt", "contentHash", "signature"];
const OPTIONAL_KEYS = ["contentType", "evidenceUrl", "label"];

// Structural validation only — no cryptography, no registry. Throws
// EvidenceError. Exported so the work.completed applier can check shape
// without needing the trust root.
export function assertEvidenceShape(r) {
  if (!isPlainObject(r)) fail("invalid_evidence", "evidence must be an object");
  assertNoNumbers(r, "evidence");
  for (const key of REQUIRED_KEYS)
    if (!Object.hasOwn(r, key)) fail("invalid_evidence", `evidence is missing required key ${JSON.stringify(key)}`);
  for (const key of Object.keys(r))
    if (!REQUIRED_KEYS.includes(key) && !OPTIONAL_KEYS.includes(key))
      fail("invalid_evidence", `evidence has unexpected key ${JSON.stringify(key)}`);
  if (r.schemaVersion !== EVIDENCE_SCHEMA_VERSION)
    fail("invalid_evidence", `schemaVersion must be exactly ${EVIDENCE_SCHEMA_VERSION}`);
  if (typeof r.evidenceId !== "string" || !EVIDENCE_ID.test(r.evidenceId))
    fail("invalid_evidence", "evidenceId must be room-evidence:ex:<32 hex>");
  if (!EVIDENCE_KINDS.includes(r.kind))
    fail("invalid_evidence", `kind must be one of ${EVIDENCE_KINDS.join(", ")}`);
  if (typeof r.signerIdentityId !== "string" || !IDENTITY_ID.test(r.signerIdentityId))
    fail("invalid_evidence", "signerIdentityId must match [A-Za-z0-9_-]{1,64}");
  if (!validIssuedAt(r.issuedAt))
    fail("invalid_evidence", "issuedAt must be a real RFC 3339 UTC timestamp");
  if (typeof r.contentHash !== "string" || !CONTENT_HASH.test(r.contentHash))
    fail("invalid_evidence", 'contentHash must be "sha256:<64 hex>"');
  if (r.contentType !== undefined) nonEmpty(r.contentType, 128, "contentType");
  if (r.evidenceUrl !== undefined) nonEmpty(r.evidenceUrl, 2048, "evidenceUrl");
  if (r.label !== undefined) nonEmpty(r.label, 256, "label");
  if (typeof r.signature !== "string" || !HEX128.test(r.signature))
    fail("invalid_evidence", "signature must be 128 lowercase hex");
}

// sha256 of the external content bytes, in the room's evidence idiom.
export const sha256Hex = data => createHash("sha256").update(data).digest("hex");
export const contentHashOf = data => `sha256:${sha256Hex(data)}`;

// Issue a signed evidence object. The caller holds the identity's private
// seed (shown once at identity issuance); this module never stores keys.
// seedHex is the 64-hex Ed25519 seed — the same wire format as
// bounty-receipts' importSeed (convert the base64 issuance privateKey with
// Buffer.from(privateKey, "base64").toString("hex")).
export function issueSignedEvidence({ kind = "external", signerIdentityId, issuedAt,
  contentHash, contentType, evidenceUrl, label, seedHex }) {
  if (typeof seedHex !== "string" || !HEX64.test(seedHex))
    fail("invalid_key", "seedHex must be 64 lowercase hex characters (32-byte Ed25519 seed)");
  const unsigned = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceId: `room-evidence:ex:${randomBytes(16).toString("hex")}`,
    kind, signerIdentityId, issuedAt, contentHash,
    ...(contentType !== undefined ? { contentType } : {}),
    ...(evidenceUrl !== undefined ? { evidenceUrl } : {}),
    ...(label !== undefined ? { label } : {}),
  };
  assertEvidenceShape({ ...unsigned, signature: "0".repeat(128) }); // shape first, signature last
  const signature = signBytes(canonicalJson(unsigned), seedHex);
  return Object.freeze({ ...unsigned, signature });
}

// Verify a signed evidence object. Accepts the object or its JSON text
// (text is parsed strictly — duplicate keys rejected). Never throws for an
// invalid object: returns { ok: false, code, reason }. Options:
//   registry — the trust root: { keysFor(identityId) } returning rows with
//     { publicKey, validFrom, validUntil, revokedAt }. The signature must
//     verify under a key whose validity window covers issuedAt.
//   seen — optional { has(evidenceId) } / { add(evidenceId) } replay guard;
//     verified ids are added.
export function verifySignedEvidence(evidence, { registry, seen = null } = {}) {
  const invalid = (code, reason) => ({ ok: false, code, reason });
  let r;
  try {
    r = typeof evidence === "string" ? parseStrict(evidence) : evidence;
    assertEvidenceShape(r);
  } catch (error) {
    return invalid(error instanceof EvidenceError ? error.code : "invalid_evidence", error.message);
  }
  if (seen !== null && seen !== undefined) {
    if (typeof seen.has !== "function") return invalid("invalid_input", "seen must expose has(evidenceId)");
    if (seen.has(r.evidenceId)) return invalid("duplicate_evidence", `evidence ${r.evidenceId} was already verified`);
  }
  if (!registry || typeof registry.keysFor !== "function")
    return invalid("invalid_input", "a key registry exposing keysFor(identityId) is required");
  let rows;
  try {
    rows = registry.keysFor(r.signerIdentityId) ?? [];
  } catch (error) {
    return invalid("registry_error", `key lookup failed: ${error.message}`);
  }
  if (!Array.isArray(rows) || rows.length === 0)
    return invalid("unknown_signer", `no registered key for identity ${r.signerIdentityId}`);
  const issuedMs = Date.parse(r.issuedAt);
  const inWindow = row => Number.isInteger(row.validFrom) && row.validFrom <= issuedMs
    && (row.validUntil === null || row.validUntil === undefined || issuedMs < row.validUntil);
  const candidates = rows.filter(row => inWindow(row)
    && (row.revokedAt === null || row.revokedAt === undefined || issuedMs < row.revokedAt));
  if (candidates.length === 0) {
    const revoked = rows.some(row => inWindow(row)
      && row.revokedAt !== null && row.revokedAt !== undefined && issuedMs >= row.revokedAt);
    return revoked
      ? invalid("revoked_key", `the signing key for ${r.signerIdentityId} was revoked before ${r.issuedAt}`)
      : invalid("expired_key", `no registered key for ${r.signerIdentityId} covers issuedAt ${r.issuedAt} (rotated out or not yet valid)`);
  }
  const unsigned = { ...r };
  delete unsigned.signature;
  let bytes;
  try {
    bytes = canonicalJson(unsigned);
  } catch (error) {
    return invalid("number_ban", error.message);
  }
  for (const row of candidates) {
    // Registry keys are canonical base64 of 32 bytes; the Ed25519 verifier
    // takes hex. A malformed registry row simply never matches (fail closed).
    if (typeof row.publicKey !== "string" || !isValidPublicKey(row.publicKey)) continue;
    const pubkeyHex = Buffer.from(row.publicKey, "base64").toString("hex");
    if (verifyBytes(bytes, r.signature, pubkeyHex)) {
      if (seen !== null && seen !== undefined && typeof seen.add === "function") seen.add(r.evidenceId);
      return { ok: true, evidenceId: r.evidenceId, kind: r.kind,
        signerIdentityId: r.signerIdentityId, contentHash: r.contentHash };
    }
  }
  return invalid("bad_signature", "Ed25519 verification failed against every key valid at issuedAt");
}

// Store-level glue for the work.completed live command path. Throws
// EvidenceError when the completion's external evidence is missing or does
// not verify; the room's command handler turns that into a rejected
// command. Replay is checked against the room's event log: an evidenceId
// may attest at most one completion per room.
export function verifyCompletionEvidence(db, keyRegistry, roomId, data) {
  const evidence = data?.signedEvidence;
  if (!isPlainObject(evidence))
    fail("missing_signed_evidence",
      "External work evidence must be a signed evidence object (room-signed-evidence/1) bound to the signer's room identity key — unsigned external evidence is rejected");
  const result = verifySignedEvidence(evidence, { registry: keyRegistry });
  if (!result.ok) fail(result.code, result.reason);
  const replay = db.prepare(
    "SELECT 1 FROM events WHERE room_id=? AND json_extract(body,'$.type')='work.completed'"
    + " AND json_extract(body,'$.data.signedEvidence.evidenceId')=? LIMIT 1"
  ).get(roomId, result.evidenceId);
  if (replay) fail("duplicate_evidence", `evidence ${result.evidenceId} already attests a completion in this room`);
  return result;
}

export { EvidenceError };
