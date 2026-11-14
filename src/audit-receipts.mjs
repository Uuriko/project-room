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
//
// Implementation (PERF-50 B3-a): the fast path deep-sorts a validated copy
// ("presort") and lets the native JSON.stringify emit the bytes — several
// times faster than per-node string building, with byte-identical output.
// The presort enforces this serializer's stricter contract itself
// (non-finite numbers and non-JSON values throw, Dates become their ISO
// string), because JSON.stringify would otherwise silently render them as
// null / drop them. Two shapes a plain-object copy cannot reproduce are
// detected during the presort and fall back to the original recursive
// serializer (canonicalJsonRecursive below) for the whole value:
//   - objects with integer-like keys: a JS object orders those keys
//     numerically, not in the sorted UTF-16 order the canonical form
//     requires, so no presorted copy can carry the right order;
//   - sparse arrays: the recursive form renders a hole as an empty slot
//     ("[1,,3]"), where JSON.stringify would render null.
class CanonicalFallback extends Error {}

// Returns the value JSON.stringify must emit for `value`: the value itself
// when its subtree is already in canonical order (plain data only — a
// subtree JSON.stringify would treat specially, via a prototype toJSON or
// a wrapper object, is always rebuilt), otherwise a sorted plain copy
// sharing every unchanged child.
function presortCanonical(value) {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number is not JSON-serializable");
    return value;
  }
  if (Array.isArray(value)) {
    let out = null;
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) throw new CanonicalFallback();
      const child = presortCanonical(value[i]);
      if (out !== null) out[i] = child;
      else if (child !== value[i]) { out = value.slice(); out[i] = child; }
    }
    if (out !== null) return out;
    // Reuse the array itself only when stringify cannot divert on it.
    return typeof value.toJSON === "function" ? value.slice() : value;
  }
  if (t === "object") {
    if (value instanceof Date) return value.toISOString();
    const keys = Object.keys(value);
    let ordered = true;
    for (let i = 1; i < keys.length; i++) if (keys[i] < keys[i - 1]) { ordered = false; break; }
    const emitKeys = ordered ? keys : keys.slice().sort();
    const children = new Array(emitKeys.length);
    let changed = !ordered;
    for (let i = 0; i < emitKeys.length; i++) {
      const k = emitKeys[i];
      const c0 = k.charCodeAt(0);
      if (c0 >= 48 && c0 <= 57 && String(k >>> 0) === k) throw new CanonicalFallback();
      children[i] = presortCanonical(value[k]);
      if (children[i] !== value[k]) changed = true;
    }
    // Reuse the object itself only when nothing changed AND it is plain
    // (Object.prototype or null prototype) with no callable toJSON for
    // stringify to divert on; anything else is rebuilt as a plain copy.
    if (!changed) {
      const proto = Object.getPrototypeOf(value);
      if ((proto === Object.prototype || proto === null) && typeof value.toJSON !== "function")
        return value;
    }
    const out = {};
    for (let i = 0; i < emitKeys.length; i++) out[emitKeys[i]] = children[i];
    return out;
  }
  throw new TypeError(`canonicalJson: ${t} is not JSON-serializable`);
}

// The original recursive serializer, retained verbatim as the fallback for
// the shapes named above. Its output defines the canonical bytes.
function canonicalJsonRecursive(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number is not JSON-serializable");
    return JSON.stringify(value);
  }
  if (t === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return "[" + value.map(canonicalJsonRecursive).join(",") + "]";
  if (t === "object") {
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    const keys = Object.keys(value).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJsonRecursive(value[k])).join(",") + "}";
  }
  throw new TypeError(`canonicalJson: ${t} is not JSON-serializable`);
}

export function canonicalJson(value) {
  try {
    return JSON.stringify(presortCanonical(value));
  } catch (e) {
    if (e instanceof CanonicalFallback) return canonicalJsonRecursive(value);
    throw e;
  }
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
//
// Optional head anchors (issue #1847, red-team attack A6): without them, any
// authentic prefix of a chain verifies -1, so truncation is undetectable
// in-module. Pass { expectedLength } to require an exact receipt count, and/or
// { expectedHeadHash } to require the final receipt's hash to match a known
// checkpoint. A length mismatch returns the first missing/unexpected index:
// min(receipts.length, expectedLength). A head-hash mismatch returns the head
// index (receipts.length - 1), or 0 for an empty chain.
export function verifyChain(receipts, key, opts) {
  if (!Array.isArray(receipts)) return 0;
  const expectedLength =
    opts != null && typeof opts.expectedLength === "number" ? opts.expectedLength : undefined;
  const expectedHeadHash =
    opts != null && typeof opts.expectedHeadHash === "string" ? opts.expectedHeadHash : undefined;
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
  if (expectedLength !== undefined && receipts.length !== expectedLength) {
    return Math.min(receipts.length, expectedLength);
  }
  if (expectedHeadHash !== undefined) {
    if (receipts.length === 0) return 0;
    const head = receipts[receipts.length - 1];
    if (!safeEqualHex(head.hash, expectedHeadHash)) return receipts.length - 1;
  }
  return -1;
}
