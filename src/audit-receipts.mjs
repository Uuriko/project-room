// F020: hash-chained signed audit receipts (follow-on to F004 audit log UI).
//
// Each receipt wraps one F004 audit entry (the { sequence, event } row shape
// from src/audit-log-ui.mjs, whose event is { id, type, roomId, actorId, at,
// data }) and links it into a tamper-evident chain:
//
//   receipt = { seq, prevHash, entry, timestamp, hash, signature }
//
//   hash      = SHA-256( prevHash || canonicalJson(entry) || timestamp )
//   signature = HMAC-SHA256( hash, key )
//
// The genesis receipt (seq 0) uses a prevHash of 64 zeros. The signing key is
// always supplied by the caller — it is never hardcoded and never read from
// the environment inside this module. Pure logic only: no schema, no network,
// no store access.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const GENESIS_PREV_HASH = "0".repeat(64);

// Canonical JSON with stable key ordering: the same logical entry always
// hashes to the same bytes regardless of property insertion order. Objects
// are serialized with their keys sorted (recursively); arrays keep their
// order. Dates serialize as ISO strings, matching JSON.stringify behavior.
// Throws a TypeError on values that have no JSON representation (undefined,
// functions, symbols, bigint) so silent data loss can never sneak into a
// receipt hash.
export function canonicalJson(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number is not JSON-serializable");
    return JSON.stringify(value);
  }
  if (t === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (t === "object") {
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    const keys = Object.keys(value).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
  }
  throw new TypeError(`canonicalJson: ${t} is not JSON-serializable`);
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function keyBytes(key) {
  if (typeof key === "string") {
    if (key.length === 0) throw new TypeError("issueReceipt/verify: signing key must not be empty");
    return Buffer.from(key, "utf8");
  }
  if (key instanceof Uint8Array) {
    if (key.length === 0) throw new TypeError("issueReceipt/verify: signing key must not be empty");
    return Buffer.from(key.buffer, key.byteOffset, key.byteLength);
  }
  throw new TypeError("issueReceipt/verify: signing key must be a string or Uint8Array");
}

function entryBytes(entry) {
  if (entry === null || typeof entry !== "object") throw new TypeError("receipt entry must be a non-null object");
  return canonicalJson(entry);
}

function computeHash(prevHash, entry, timestamp) {
  return sha256Hex(prevHash + entryBytes(entry) + timestamp);
}

function computeSignature(hash, key) {
  return createHmac("sha256", keyBytes(key)).update(hash, "utf8").digest("hex");
}

function isHex64(s) {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

// Issue the next receipt in the chain. prevReceipt is the previous receipt
// object or null for the genesis receipt. timestamp defaults to the current
// UTC instant (ISO string); pass it explicitly for deterministic builds.
export function issueReceipt(prevReceipt, entry, key, timestamp) {
  const prevHash = prevReceipt === null || prevReceipt === undefined
    ? GENESIS_PREV_HASH
    : prevReceipt.hash;
  if (!isHex64(prevHash)) throw new TypeError("issueReceipt: previous receipt hash must be a 64-char hex string");
  const seq = prevReceipt === null || prevReceipt === undefined ? 0 : prevReceipt.seq + 1;
  if (!Number.isInteger(seq) || seq < 0) throw new TypeError("issueReceipt: previous receipt seq must be a non-negative integer");
  const at = timestamp === undefined || timestamp === null ? new Date().toISOString() : String(timestamp);
  const hash = computeHash(prevHash, entry, at);
  const signature = computeSignature(hash, key);
  return { seq, prevHash, entry, timestamp: at, hash, signature };
}

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Verify one receipt: its prevHash matches the expected previous hash,
// its content hash recomputes, and its signature validates against the key.
export function verifyReceipt(receipt, prevHash, key) {
  if (receipt === null || typeof receipt !== "object") return false;
  if (receipt.prevHash !== prevHash) return false;
  if (typeof receipt.timestamp !== "string" || receipt.timestamp.length === 0) return false;
  if (!isHex64(receipt.prevHash) || !isHex64(receipt.hash) || !isHex64(receipt.signature)) return false;
  let expectedHash;
  try {
    expectedHash = computeHash(receipt.prevHash, receipt.entry, receipt.timestamp);
  } catch {
    return false;
  }
  if (!safeEqualHex(receipt.hash, expectedHash)) return false;
  let expectedSignature;
  try {
    expectedSignature = computeSignature(receipt.hash, key);
  } catch {
    return false;
  }
  return safeEqualHex(receipt.signature, expectedSignature);
}

// Verify a whole chain in order. Returns the index of the first receipt that
// fails (wrong prevHash link, broken seq continuity, content tamper, or bad
// signature), or -1 when the entire chain verifies. An empty chain verifies
// vacuously. The first receipt must be a genesis receipt (seq 0 with a
// prevHash of 64 zeros); every later receipt must continue the seq and link
// onto the previous receipt's hash.
export function verifyChain(receipts, key) {
  if (!Array.isArray(receipts)) return 0;
  for (let i = 0; i < receipts.length; i++) {
    const receipt = receipts[i];
    if (receipt === null || typeof receipt !== "object") return i;
    if (i === 0) {
      if (receipt.seq !== 0) return 0;
      if (!verifyReceipt(receipt, GENESIS_PREV_HASH, key)) return 0;
    } else {
      const prev = receipts[i - 1];
      if (receipt.seq !== prev.seq + 1) return i;
      if (!verifyReceipt(receipt, prev.hash, key)) return i;
    }
  }
  return -1;
}
