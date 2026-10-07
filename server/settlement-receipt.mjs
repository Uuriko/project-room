// Signed settlement receipt schema + issuer/verifier (200-hard-tasks #4).
// The receipt a provider returns per settled job: signature, amount, job id,
// timestamp, chain/asset binding, and a nonce for replay protection.
// Crypto discipline is reused from the room's signed claims
// (server/bounty-receipts.mjs): byte-exact canonical JSON, Ed25519 over the
// canonical bytes, JSON-number ban inside signed bodies. Pure: node:crypto
// only, no I/O.
import {
  canonicalJson,
  parseStrict,
  generateReceiptKeyPair,
  signBytes,
  verifyBytes,
  validIssuedAt,
  ReceiptError,
} from "./bounty-receipts.mjs";
import { randomBytes } from "node:crypto";

export const SETTLEMENT_RECEIPT_VERSION = "settlement-receipt/1";
export const RECEIPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // receipts stay verifiable 7 days
export const RECEIPT_CLOCK_SKEW_MS = 5 * 60 * 1000;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const NONCE = /^[0-9a-f]{32}$/;

const fail = (code, message) => {
  throw new ReceiptError(code, message);
};

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const assertNoNumbers = (value, path) => {
  if (typeof value === "number" || typeof value === "bigint") fail("number_ban", `JSON number forbidden in signed body at ${path}`);
  if (Array.isArray(value)) value.forEach((v, n) => assertNoNumbers(v, `${path}[${n}]`));
  else if (isPlainObject(value)) for (const k of Object.keys(value)) assertNoNumbers(value[k], `${path}.${k}`);
};

// The signed body: everything except `signature`.
export function receiptBody({ jobId, envelopeId, providerId, chainId, assetMint, amountRaw, issuedAtIso, nonce }) {
  return { version: SETTLEMENT_RECEIPT_VERSION, jobId, envelopeId, providerId, chainId, assetMint, amountRaw, issuedAtIso, nonce };
}

export function validateReceiptShape(receipt) {
  if (!isPlainObject(receipt)) fail("invalid_receipt", "receipt must be an object");
  const body = { ...receipt };
  const signature = body.signature;
  delete body.signature;
  const want = ["version", "jobId", "envelopeId", "providerId", "chainId", "assetMint", "amountRaw", "issuedAtIso", "nonce"].sort();
  const got = Object.keys(body).sort();
  if (got.length !== want.length || got.some((k, i) => k !== want[i])) {
    fail("invalid_receipt", `receipt body must have exactly keys [${want.join(", ")}]`);
  }
  if (body.version !== SETTLEMENT_RECEIPT_VERSION) fail("invalid_receipt", `unsupported version ${body.version}`);
  for (const f of ["jobId", "envelopeId", "providerId", "chainId", "assetMint"]) {
    if (typeof body[f] !== "string" || !body[f]) fail("invalid_receipt", `${f} must be a non-empty string`);
  }
  if (!/^\d+$/.test(body.amountRaw) || BigInt(body.amountRaw) <= 0n) {
    fail("invalid_receipt", "amountRaw must be a positive integer string");
  }
  if (!NONCE.test(body.nonce)) fail("invalid_receipt", "nonce must be 32 lowercase hex");
  if (!HEX128.test(signature)) fail("invalid_receipt", "signature must be 128 lowercase hex");
  assertNoNumbers(body, "receipt");
  return body;
}

export function issueSettlementReceipt({ seedHex, jobId, envelopeId, providerId, chainId, assetMint, amountRaw, issuedAtIso = new Date().toISOString(), nonce = null }) {
  if (!HEX64.test(seedHex || "")) fail("invalid_key", "seedHex must be 64 lowercase hex");
  const body = receiptBody({
    jobId, envelopeId, providerId, chainId, assetMint, amountRaw, issuedAtIso,
    nonce: nonce || randomBytes(16).toString("hex"),
  });
  validateReceiptShape({ ...body, signature: "0".repeat(128) });
  const signature = signBytes(canonicalJson(body), seedHex);
  return Object.freeze({ ...body, signature });
}

// Verify a settlement receipt.
// expected: { pubkeyHex, jobId?, amountRaw?, chainId?, maxAgeMs?, now? }
// seen: optional Set of nonces for replay protection (adds the nonce on success).
export function verifySettlementReceipt(receipt, { expectedPubkey, jobId = null, amountRaw = null, chainId = null, maxAgeMs = RECEIPT_MAX_AGE_MS, now = Date.now(), seen = null } = {}) {
  if (!HEX64.test(expectedPubkey || "")) fail("invalid_key", "expectedPubkey must be 64 lowercase hex");
  let body;
  try {
    body = validateReceiptShape(receipt);
  } catch (e) {
    return { ok: false, reason: `shape: ${e.message}`, code: e.code || "invalid_receipt" };
  }
  const { signature, ...unsigned } = receipt;
  if (!verifyBytes(canonicalJson(unsigned), signature, expectedPubkey)) {
    return { ok: false, reason: "bad signature", code: "bad_signature" };
  }
  if (jobId !== null && body.jobId !== jobId) {
    return { ok: false, reason: `job id mismatch: got ${body.jobId}, expected ${jobId}`, code: "job_mismatch" };
  }
  if (amountRaw !== null && body.amountRaw !== String(amountRaw)) {
    return { ok: false, reason: `amount mismatch: got ${body.amountRaw}, expected ${amountRaw}`, code: "amount_mismatch" };
  }
  if (chainId !== null && body.chainId !== chainId) {
    return { ok: false, reason: `chain mismatch: got ${body.chainId}, expected ${chainId}`, code: "chain_mismatch" };
  }
  const age = now - Date.parse(body.issuedAtIso);
  if (!Number.isFinite(age)) return { ok: false, reason: "unparseable issuedAtIso", code: "bad_timestamp" };
  if (age < -RECEIPT_CLOCK_SKEW_MS) return { ok: false, reason: "issued in the future", code: "future_timestamp" };
  if (age > maxAgeMs) return { ok: false, reason: `expired: age ${Math.round(age / 1000)}s > ${maxAgeMs / 1000}s`, code: "expired" };
  if (seen) {
    if (seen.has(body.nonce)) return { ok: false, reason: "replayed nonce", code: "replay" };
    seen.add(body.nonce);
  }
  return { ok: true, body };
}

export { generateReceiptKeyPair, parseStrict, validIssuedAt, ReceiptError };
