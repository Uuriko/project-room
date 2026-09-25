// Project Room Receipt Standard v1 — reference implementation.
//
// An open attestation format for agent work: any framework can emit receipts,
// Project Room is the reference verifier. Spec: spec/receipt-standard-v1.md.
//
// Crypto discipline is reused verbatim from the room's signed claims
// (server/bounty-receipts.mjs): byte-exact canonical JSON, strict
// duplicate-key-rejecting parse, JSON-number ban inside signed bodies,
// Ed25519 over the canonical bytes. This module adds the v1 shape, the
// MUST-check verification contract (freshness window, fail-closed identity
// binding, replay protection), and the adapter from the room's unsigned work
// receipts. It does not modify bounty-receipts.mjs.
//
// Pure: node:crypto only, no I/O, no dependencies.
import { createHash, randomBytes } from "node:crypto";
import {
  canonicalJson,
  generateReceiptKeyPair,
  parseStrict,
  ReceiptError,
  signBytes,
  validIssuedAt,
  verifyBytes,
} from "./bounty-receipts.mjs";

export const RECEIPT_STANDARD_VERSION = "project-room-receipt/1";
export const RECEIPT_STATUSES = Object.freeze(["done", "partial", "blocked"]);
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;

const fail = (code, message) => { throw new ReceiptError(code, message); };

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const DECIMAL = /^[0-9]+$/;
const RECEIPT_ID = /^prr1:[0-9a-f]{32}$/;

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

const assertNoNumbers = (value, path) => {
  if (typeof value === "number" || typeof value === "bigint")
    fail("number_ban", `JSON number forbidden in signed body at ${path}`);
  if (Array.isArray(value)) value.forEach((v, n) => assertNoNumbers(v, `${path}[${n}]`));
  else if (isPlainObject(value))
    for (const k of Object.keys(value)) assertNoNumbers(value[k], `${path}.${k}`);
};

const nonEmpty = (v, max, label) => {
  if (typeof v !== "string" || v.length < 1 || v.length > max)
    fail("invalid_receipt", `${label} must be a 1..${max}-character string`);
};

const exactKeys = (obj, keys, label) => {
  if (!isPlainObject(obj)) fail("invalid_receipt", `${label} must be an object`);
  const got = Object.keys(obj).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((k, n) => k !== want[n]))
    fail("invalid_receipt", `${label} must have exactly keys [${want.join(", ")}]`);
};

export const sha256Hex = bytes => createHash("sha256").update(bytes).digest("hex");

// --- shape validation (MUST 1–4) ----------------------------------------------

function checkIssuer(issuer) {
  exactKeys(issuer, ["pubkey", "agentId", "roomId"], "issuer");
  if (!HEX64.test(issuer.pubkey)) fail("invalid_receipt", "issuer.pubkey must be 64 lowercase hex");
  nonEmpty(issuer.agentId, 256, "issuer.agentId");
  nonEmpty(issuer.roomId, 128, "issuer.roomId");
}

function checkSurface(surface) {
  exactKeys(surface, ["roomId", "workItemId", "claimId", "resources"].filter(k => k in surface || k === "roomId" || k === "resources"), "surface");
  nonEmpty(surface.roomId, 128, "surface.roomId");
  if (surface.workItemId !== undefined) nonEmpty(surface.workItemId, 128, "surface.workItemId");
  if (surface.claimId !== undefined) nonEmpty(surface.claimId, 128, "surface.claimId");
  if (!Array.isArray(surface.resources)) fail("invalid_receipt", "surface.resources must be an array");
  for (const [n, r] of surface.resources.entries()) {
    exactKeys(r, ["kind", "ref", "sha256"].filter(k => k in r || k === "kind" || k === "ref"), `surface.resources[${n}]`);
    nonEmpty(r.kind, 64, `surface.resources[${n}].kind`);
    nonEmpty(r.ref, 512, `surface.resources[${n}].ref`);
    if (r.sha256 !== undefined && !HEX64.test(r.sha256))
      fail("invalid_receipt", `surface.resources[${n}].sha256 must be 64 lowercase hex`);
  }
}

function checkDeliverables(deliverables) {
  if (!Array.isArray(deliverables)) fail("invalid_receipt", "deliverables must be an array");
  for (const [n, d] of deliverables.entries()) {
    exactKeys(d, ["name", "bytes", "sha256"], `deliverables[${n}]`);
    nonEmpty(d.name, 256, `deliverables[${n}].name`);
    if (!DECIMAL.test(d.bytes)) fail("invalid_receipt", `deliverables[${n}].bytes must be a decimal string`);
    if (!HEX64.test(d.sha256)) fail("invalid_receipt", `deliverables[${n}].sha256 must be 64 lowercase hex`);
  }
}

function checkDeclaration(declaration) {
  exactKeys(declaration, ["summary", "claims"], "declaration");
  nonEmpty(declaration.summary, 2000, "declaration.summary");
  if (!Array.isArray(declaration.claims)) fail("invalid_receipt", "declaration.claims must be an array");
  for (const [n, c] of declaration.claims.entries()) nonEmpty(c, 1000, `declaration.claims[${n}]`);
}

function checkObservations(observations) {
  if (!Array.isArray(observations)) fail("invalid_receipt", "observations must be an array");
  for (const [n, o] of observations.entries()) {
    exactKeys(o, ["kind", "detail"], `observations[${n}]`);
    nonEmpty(o.kind, 64, `observations[${n}].kind`);
    nonEmpty(o.detail, 2000, `observations[${n}].detail`);
  }
}

function validateBodyShape(b) {
  assertNoNumbers(b, "receipt");
  exactKeys(b, ["schemaVersion", "receiptId", "issuer", "issuedAt", "nonce", "surface",
    "status", "deliverables", "declaration", "observations", "limitations", "signature"], "receipt");
  if (b.schemaVersion !== RECEIPT_STANDARD_VERSION)
    fail("unknown_version", `schemaVersion must be exactly ${RECEIPT_STANDARD_VERSION}`);
  if (!RECEIPT_ID.test(b.receiptId)) fail("invalid_receipt", "receiptId must be prr1:<32 lowercase hex>");
  checkIssuer(b.issuer);
  if (!validIssuedAt(b.issuedAt)) fail("invalid_receipt", "issuedAt must be a real RFC 3339 UTC timestamp");
  if (!HEX32.test(b.nonce)) fail("invalid_receipt", "nonce must be 32 lowercase hex");
  checkSurface(b.surface);
  if (!RECEIPT_STATUSES.includes(b.status))
    fail("invalid_receipt", `status must be one of ${RECEIPT_STATUSES.join("|")}`);
  checkDeliverables(b.deliverables);
  checkDeclaration(b.declaration);
  checkObservations(b.observations);
  if (!Array.isArray(b.limitations) || b.limitations.length === 0)
    fail("invalid_receipt", "limitations must be a non-empty array — every receipt prices its own ignorance");
  for (const [n, l] of b.limitations.entries()) nonEmpty(l, 1000, `limitations[${n}]`);
  if (!HEX128.test(b.signature)) fail("invalid_receipt", "signature must be 128 lowercase hex");
}

// --- emit ---------------------------------------------------------------------

const checkSeedHex = seedHex => {
  if (typeof seedHex !== "string" || !HEX64.test(seedHex))
    fail("invalid_key", "seed must be 64 lowercase hex characters (32-byte Ed25519 seed)");
};

// Emit a v1 receipt. Throws ReceiptError on invalid input.
// issuer: { pubkeyHex, agentId, roomId }; the seedHex signs; pubkeyHex must be
// the seed's public key (checked at emit so a mismatched pair fails here,
// not at some later verifier).
// now: reference time (ms) for the emit-time sanity verification. Defaults to
// the wall clock; pass an explicit value for deterministic emits (tests,
// backfills) so the sanity check does not depend on when the code runs.
export function emitReceipt({ issuer, surface, status, deliverables = [], declaration,
  observations = [], limitations, seedHex, issuedAt = null, nonce = null, receiptId = null,
  now = null }) {
  checkSeedHex(seedHex);
  if (!isPlainObject(issuer)) fail("invalid_input", "issuer must be an object");
  const body = {
    schemaVersion: RECEIPT_STANDARD_VERSION,
    receiptId: receiptId ?? `prr1:${randomBytes(16).toString("hex")}`,
    issuer: { pubkey: issuer.pubkeyHex, agentId: issuer.agentId, roomId: issuer.roomId },
    issuedAt: issuedAt ?? new Date().toISOString(),
    nonce: nonce ?? randomBytes(16).toString("hex"),
    surface: {
      roomId: surface.roomId,
      ...(surface.workItemId !== undefined ? { workItemId: surface.workItemId } : {}),
      ...(surface.claimId !== undefined ? { claimId: surface.claimId } : {}),
      resources: (surface.resources ?? []).map(r => ({
        kind: r.kind, ref: r.ref, ...(r.sha256 !== undefined ? { sha256: r.sha256 } : {}),
      })),
    },
    status,
    deliverables: deliverables.map(d => ({ name: d.name, bytes: String(d.bytes), sha256: d.sha256 })),
    declaration: { summary: declaration.summary, claims: [...(declaration.claims ?? [])] },
    observations: observations.map(o => ({ kind: o.kind, detail: o.detail })),
    limitations: [...limitations],
  };
  // Shape first (without signature), then sign the exact canonical bytes.
  validateBodyShape({ ...body, signature: "0".repeat(128) });
  const signature = signBytes(canonicalJson(body), seedHex);
  const receipt = Object.freeze({ ...body, signature });
  // Sanity: the emitted receipt verifies against its own issuer key, using the
  // caller's reference time when provided (null falls back to the wall clock).
  const check = verifyReceipt(receipt, { expectedPubkey: body.issuer.pubkey, allowUnboundIssuer: false, now });
  if (!check.ok) fail("emit_failed", `emitted receipt does not verify: ${check.reason}`);
  return receipt;
}

// --- verify -------------------------------------------------------------------
//
// Never throws for an invalid receipt: returns { ok: false, reason }.
// Options:
//   expectedPubkey — the issuer key this context trusts. Without it the
//     receipt fails closed (untrusted_issuer) unless allowUnboundIssuer:true
//     explicitly opts into integrity-only verification.
//   expectedRoomId / expectedAgentId — context binding (room A receipts do not
//     verify in room B's context).
//   seen — Set of receiptIds for replay protection; verified ids are added.
//   now / maxAgeMs / clockSkewMs — freshness window (defaults: now, 24h, 5min).
//   fetchContent — (name) => Buffer|Uint8Array; when supplied, every
//     deliverable's bytes are recomputed and MUST match the signed hash.
export function verifyReceipt(receipt, { expectedPubkey = null, expectedRoomId = null,
  expectedAgentId = null, seen = null, now = null, maxAgeMs = DEFAULT_MAX_AGE_MS,
  clockSkewMs = DEFAULT_CLOCK_SKEW_MS, fetchContent = null, allowUnboundIssuer = false } = {}) {
  const invalid = reason => ({ ok: false, reason });
  let r;
  try {
    r = typeof receipt === "string" ? parseStrict(receipt) : receipt;
    if (!isPlainObject(r)) return invalid("invalid_receipt: receipt must be an object");
    validateBodyShape(r);
  } catch (error) {
    const code = error instanceof ReceiptError ? error.code : "invalid_receipt";
    return invalid(`${code}: ${error.message}`);
  }
  const at = now ?? Date.now();
  const issuedMs = Date.parse(r.issuedAt);
  if (issuedMs > at + clockSkewMs) return invalid("future_receipt: issuedAt is beyond the clock-skew window");
  if (issuedMs < at - maxAgeMs) return invalid("stale_receipt: issuedAt is outside the freshness window");
  if (seen !== null && seen !== undefined) {
    if (!(seen instanceof Set)) return invalid("invalid_input: seen must be a Set");
    if (seen.has(r.receiptId)) return invalid("duplicate_receipt: receiptId already verified");
  }
  const { signature, ...unsigned } = r;
  let bytes;
  try {
    bytes = canonicalJson(unsigned);
  } catch (error) {
    return invalid(`number_ban: ${error.message}`);
  }
  if (!verifyBytes(bytes, signature, r.issuer.pubkey))
    return invalid("bad_signature: Ed25519 verification failed");
  if (expectedPubkey !== null && expectedPubkey !== undefined) {
    if (typeof expectedPubkey !== "string" || r.issuer.pubkey !== expectedPubkey.toLowerCase())
      return invalid("unexpected_signer: valid signature, but not from the expected issuer key");
  } else if (!allowUnboundIssuer) {
    return invalid("untrusted_issuer: no expectedPubkey — a valid signature under an unknown key proves someone signed this, not who");
  }
  if (expectedRoomId !== null && expectedRoomId !== undefined
    && (r.issuer.roomId !== expectedRoomId || r.surface.roomId !== expectedRoomId))
    return invalid("context_mismatch: receipt is not bound to the expected room");
  if (expectedAgentId !== null && expectedAgentId !== undefined && r.issuer.agentId !== expectedAgentId)
    return invalid("context_mismatch: receipt is not bound to the expected agent");
  if (fetchContent !== null && fetchContent !== undefined) {
    for (const d of r.deliverables) {
      let content;
      try {
        content = fetchContent(d.name);
      } catch (error) {
        return invalid(`content_mismatch: content fetch for ${d.name} failed: ${error.message}`);
      }
      if (content === null || content === undefined)
        return invalid(`content_mismatch: no content available for deliverable ${d.name}`);
      const buf = Buffer.from(content);
      if (String(buf.length) !== d.bytes || sha256Hex(buf) !== d.sha256)
        return invalid(`content_mismatch: deliverable ${d.name} does not match its signed bytes/sha256`);
    }
  }
  if (seen instanceof Set) seen.add(r.receiptId);
  return { ok: true, receiptId: r.receiptId, status: r.status,
    issuer: { pubkey: r.issuer.pubkey, agentId: r.issuer.agentId, roomId: r.issuer.roomId } };
}

// --- adapter: room work receipts (rc_*) -> standard v1 --------------------------
//
// The room's existing receipts are unsigned projections of done work items
// (server/work-claim-routes.mjs receiptOf). This adapter wraps one in a v1
// receipt WITHOUT rewriting room flows: the projection's limits are declared
// in limitations, and the original rc_ id is preserved as a surface resource.
export function roomWorkReceiptToStandard(roomReceipt, { issuer, seedHex, roomId = null,
  extraLimitations = [], issuedAt = null, now = null } = {}) {
  if (!isPlainObject(roomReceipt)) fail("invalid_input", "roomReceipt must be an object");
  for (const k of ["receiptId", "workItemId", "summary", "createdBy", "createdAt"])
    if (roomReceipt[k] === undefined) fail("invalid_input", `roomReceipt.${k} is required`);
  const createdIso = new Date(Number(roomReceipt.createdAt)).toISOString();
  return emitReceipt({
    issuer,
    seedHex,
    issuedAt,
    now,
    surface: {
      roomId: roomId ?? issuer.roomId,
      workItemId: String(roomReceipt.workItemId),
      resources: [
        { kind: "room-receipt", ref: String(roomReceipt.receiptId) },
        ...[...(roomReceipt.blobs ?? [])].map(b => ({ kind: "blob", ref: String(b) })),
      ],
    },
    status: "done",
    deliverables: [],
    declaration: { summary: String(roomReceipt.summary).slice(0, 2000), claims: [] },
    observations: [{
      kind: "room-projection",
      detail: `projected from room receipt ${roomReceipt.receiptId} (work item ${roomReceipt.workItemId}), completed ${createdIso} by ${roomReceipt.createdBy}`,
    }],
    limitations: [
      "Projected from an unsigned room record; the underlying work was attested by room flows, not by this signature",
      ...extraLimitations,
    ],
  });
}

export { generateReceiptKeyPair, ReceiptError };
