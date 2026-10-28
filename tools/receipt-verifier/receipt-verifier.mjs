// Standalone Project Room receipt verifier (Receipt Standard v0.1, §4).
//
// A third party verifies a Project Room receipt OFFLINE, without trusting or
// contacting the room server, from the published spec alone. This module is
// dependency-free (Node >= 18, `node:crypto` only), performs NO I/O and NO
// network access, and NEVER handles private key material — it verifies with
// public keys only. (JWKS *fetching* lives in the CLI wrapper; this module
// accepts an already-fetched JWKS document.)
//
// Families:
//   bounty          room-bounty-receipt/1   — Ed25519 over byte-exact
//                                             canonical JSON (dasha-receipt/1
//                                             §4, as in server/bounty-receipts.mjs)
//   vetting         vetting/1               — same crypto discipline + a
//                                             freshness window (7d / 5min skew)
//   signed-evidence room-signed-evidence/1  — same discipline + a caller-
//                                             supplied key registry carrying
//                                             validity windows and revocation
//   public-work     public-work-receipt/1   — UNSIGNED by design
//                                             (verification: "hash_only"); the
//                                             receiptId is a content hash and
//                                             is only checked when the caller
//                                             explicitly opts into integrity-
//                                             only mode.
//
// Trust discipline (spec §4.2): fail closed. A valid signature under an
// unknown key proves *someone* signed, not *who* — without a pinned key, a
// JWKS trust set, or a registry, signed families are rejected with
// `untrusted_issuer`. Integrity-only mode (accept any signer, report who) is
// an explicit caller opt-in and is labelled in every verdict it produces.
//
// Verification answers *well-formed? attributable? fresh and unreplayed?* —
// never *true?* A signed receipt makes a claim attributable; truth stays
// with reviewers, tests, and disputes.
//
// The per-family validation below mirrors the shipped server modules
// (server/bounty-receipts.mjs, server/vetting-receipts.mjs,
// server/signed-evidence.mjs, server/public-work-claims.mjs) but is an
// independent implementation: it imports nothing from the server tree, so
// it can be copied out of the repo and run standalone.
import { createHash, createPublicKey, verify } from "node:crypto";

export const VERIFIER_NAME = "room-receipt-verify";
export const VERIFIER_SPEC = "project-room-receipt-standard/0.1 §4";

class VerifierError extends Error {
  constructor(code, message) { super(message); this.name = "VerifierError"; this.code = code; }
}
const fail = (code, message) => { throw new VerifierError(code, message); };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

// --- canonical JSON (byte-exact, dasha-receipt/1 §4) -------------------------
//
// Objects: members sorted by key in UTF-16 code-unit order; no whitespace.
// Strings: escape ONLY `"` `\` and U+0000–U+001F (\b \f \n \r \t shorthands,
// else \u00xx lowercase hex). NEVER escape `/`. NEVER escape non-ASCII.
// Numbers: FORBIDDEN in signed bodies — rejected before any signature check.

const compareKeys = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
};

const escapeString = value => {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += value[i];
  }
  return `${out}"`;
};

export function canonicalJson(value) {
  if (value === null) return Buffer.from("null", "utf8");
  if (value === true) return Buffer.from("true", "utf8");
  if (value === false) return Buffer.from("false", "utf8");
  if (typeof value === "string") return Buffer.from(escapeString(value), "utf8");
  if (typeof value === "number" || typeof value === "bigint")
    fail("number_ban", "JSON numbers are forbidden in signed bodies — use decimal strings");
  if (Array.isArray(value))
    return Buffer.from(`[${value.map(v => canonicalJson(v).toString("utf8")).join(",")}]`, "utf8");
  if (typeof value === "object") {
    const parts = Object.keys(value).sort(compareKeys)
      .map(k => `${escapeString(k)}:${canonicalJson(value[k]).toString("utf8")}`);
    return Buffer.from(`{${parts.join(",")}}`, "utf8");
  }
  fail("invalid_json_value", `cannot canonicalize ${typeof value}`);
}

// Loose canonical JSON in the src/audit-receipts.mjs idiom (JSON.stringify
// scalars, recursively sorted keys). Public-work receiptIds are content
// hashes over THIS encoding — numbers are legal there because the family is
// unsigned; the two encodings must never be substituted for each other.
export function canonicalJsonLoose(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number") {
    if (!Number.isFinite(value)) fail("invalid_receipt", "non-finite number has no canonical form");
    return JSON.stringify(value);
  }
  if (t === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return "[" + value.map(canonicalJsonLoose).join(",") + "]";
  if (t === "object") {
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    const keys = Object.keys(value).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJsonLoose(value[k])).join(",") + "}";
  }
  fail("invalid_receipt", `cannot canonicalize ${t}`);
}

// --- strict JSON parse (duplicate-key rejection) -----------------------------

export function parseStrict(text) {
  if (typeof text !== "string") fail("invalid_input", "receipt text must be a string");
  let i = 0;
  const err = msg => fail("invalid_json", `invalid JSON at offset ${i}: ${msg}`);
  const ws = () => { while (i < text.length && " \t\n\r".includes(text[i])) i++; };
  const expect = ch => { if (text[i] !== ch) err(`expected ${JSON.stringify(ch)}`); i++; };
  function parseValue() {
    ws();
    if (i >= text.length) err("unexpected end of input");
    const c = text[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "t") { literal("true"); return true; }
    if (c === "f") { literal("false"); return false; }
    if (c === "n") { literal("null"); return null; }
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    return err(`unexpected character ${JSON.stringify(c)}`);
  }
  function literal(word) {
    if (!text.startsWith(word, i)) err(`expected ${word}`);
    i += word.length;
  }
  function parseObject() {
    expect("{"); ws();
    const obj = {};
    if (text[i] === "}") { i++; return obj; }
    for (;;) {
      ws();
      if (text[i] !== '"') err("expected string key");
      const key = parseString();
      if (Object.hasOwn(obj, key)) err(`duplicate object key ${JSON.stringify(key)}`);
      ws(); expect(":"); obj[key] = parseValue(); ws();
      if (text[i] === ",") { i++; continue; }
      expect("}");
      return obj;
    }
  }
  function parseArray() {
    expect("["); ws();
    const arr = [];
    if (text[i] === "]") { i++; return arr; }
    for (;;) {
      arr.push(parseValue()); ws();
      if (text[i] === ",") { i++; continue; }
      expect("]");
      return arr;
    }
  }
  function parseString() {
    expect('"');
    let out = "";
    for (;;) {
      if (i >= text.length) err("unterminated string");
      const c = text[i++];
      if (c === '"') return out;
      if (c !== "\\") { out += c; continue; }
      if (i >= text.length) err("unterminated escape");
      const e = text[i++];
      if (e === '"') out += '"';
      else if (e === "\\") out += "\\";
      else if (e === "/") out += "/";
      else if (e === "b") out += "\b";
      else if (e === "f") out += "\f";
      else if (e === "n") out += "\n";
      else if (e === "r") out += "\r";
      else if (e === "t") out += "\t";
      else if (e === "u") {
        const hex = text.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) err("bad \\u escape");
        i += 4;
        const unit = parseInt(hex, 16);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (text.slice(i, i + 2) !== "\\u") err("lone high surrogate");
          const lowHex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) err("bad \\u escape");
          const low = parseInt(lowHex, 16);
          if (low < 0xdc00 || low > 0xdfff) err("lone high surrogate");
          i += 6;
          out += String.fromCharCode(unit, low);
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          err("lone low surrogate");
        } else {
          out += String.fromCharCode(unit);
        }
      } else err(`bad escape \\${e}`);
    }
  }
  function parseNumber() {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) err("bad number");
    i += m[0].length;
    return Number(m[0]);
  }
  const value = parseValue();
  ws();
  if (i !== text.length) err("trailing characters");
  return value;
}

// --- shared validation helpers ------------------------------------------------

const assertNoNumbers = (value, path) => {
  if (typeof value === "number" || typeof value === "bigint")
    fail("number_ban", `JSON number forbidden in signed body at ${path}`);
  if (Array.isArray(value)) value.forEach((v, n) => assertNoNumbers(v, `${path}[${n}]`));
  else if (isPlainObject(value))
    for (const k of Object.keys(value)) assertNoNumbers(value[k], `${path}.${k}`);
};

const nonEmpty = (v, max, label, code = "invalid_receipt") => {
  if (typeof v !== "string" || v.length < 1 || v.length > max)
    fail(code, `${label} must be a 1..${max}-character string`);
};

const exactKeys = (obj, keys, label, code = "invalid_receipt") => {
  if (!isPlainObject(obj)) fail(code, `${label} must be an object`);
  const got = Object.keys(obj).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((k, n) => k !== want[n]))
    fail(code, `${label} must have exactly keys [${want.join(", ")}]`);
};

export const validIssuedAt = s => {
  // RFC 3339 UTC, seconds precision or exactly-3-digit millis, real
  // calendar time. Canonical spellings only: "…:56Z" or "…:56.789Z".
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(s)) return false;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return false;
  const d = new Date(ms), pad = n => String(n).padStart(2, "0");
  const canon = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const frac = d.getUTCMilliseconds();
  return s === `${canon}Z` || (frac === 0 && s === `${canon}.000Z`)
    || (frac !== 0 && s === `${canon}.${String(frac).padStart(3, "0")}Z`);
};

// --- Ed25519 (public keys only — this module never sees a seed) ---------------

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const importPubkey = pubkeyHex => createPublicKey({
  key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pubkeyHex, "hex")]),
  format: "der", type: "spki",
});

const verifyBytes = (bytes, signatureHex, pubkeyHex) => {
  try {
    if (typeof signatureHex !== "string" || !HEX128.test(signatureHex)) return false;
    if (typeof pubkeyHex !== "string" || !HEX64.test(pubkeyHex)) return false;
    return verify(null, Buffer.from(bytes), importPubkey(pubkeyHex), Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
};

const sha256Hex = data => createHash("sha256").update(data).digest("hex");

// --- caller-supplied trust / replay / journal plumbing -------------------------

// Extract Ed25519 public keys (lowercase hex) from a JWKS document of the
// shape published at /.well-known/jwks.json ({ keys: [{ kty: "OKP",
// crv: "Ed25519", x: <base64url raw key>, kid }] }). Non-Ed25519 or
// malformed entries are skipped — a key that cannot be parsed can never
// become trusted by accident.
export function jwksPubkeyHexes(jwks) {
  const list = Array.isArray(jwks) ? jwks : (isPlainObject(jwks) ? jwks.keys : null);
  if (!Array.isArray(list)) fail("invalid_input", "jwks must be a JWKS object ({ keys: [...] }) or an array of JWKs");
  const out = [];
  for (const k of list) {
    if (!isPlainObject(k)) continue;
    if (k.kty !== undefined && k.kty !== "OKP") continue;
    if (k.crv !== undefined && k.crv !== "Ed25519") continue;
    if (typeof k.x === "string") {
      const raw = Buffer.from(k.x, "base64url");
      if (raw.length === 32) out.push(raw.toString("hex"));
    }
  }
  return out;
}

// Collect the caller's trust set: a pinned key (strongest, out-of-band) and
// / or a JWKS discovery set. Returns { keys:Set<hex>, pinned:hex|null }.
const collectTrustedKeys = options => {
  const keys = new Set();
  let pinned = null;
  const addPinned = v => {
    if (typeof v !== "string" || !HEX64.test(v.toLowerCase()))
      fail("invalid_input", "expectedPubkey must be 64 lowercase hex characters");
    pinned = v.toLowerCase();
    keys.add(pinned);
  };
  if (options.expectedPubkey !== undefined && options.expectedPubkey !== null) addPinned(options.expectedPubkey);
  if (options.key !== undefined && options.key !== null) addPinned(options.key);
  if (options.trustedPubkeys !== undefined && options.trustedPubkeys !== null) {
    if (!Array.isArray(options.trustedPubkeys)) fail("invalid_input", "trustedPubkeys must be an array of pubkey hex strings");
    for (const h of options.trustedPubkeys) {
      if (typeof h !== "string" || !HEX64.test(h.toLowerCase()))
        fail("invalid_input", "trustedPubkeys entries must be 64 lowercase hex characters");
      keys.add(h.toLowerCase());
    }
  }
  if (options.jwks !== undefined && options.jwks !== null)
    for (const h of jwksPubkeyHexes(options.jwks)) keys.add(h);
  return { keys, pinned };
};

// Replay guard adapter: accepts a Set, an array of ids, or a { has, add }
// object (the signed-evidence seam shape). Returns null when absent.
const seenAdapter = seen => {
  if (seen === null || seen === undefined) return null;
  if (seen instanceof Set) return { has: id => seen.has(id), add: id => { seen.add(id); } };
  if (Array.isArray(seen)) {
    const set = new Set(seen);
    return { has: id => set.has(id), add: id => { set.add(id); seen.push(id); } };
  }
  if (typeof seen.has === "function")
    return { has: id => seen.has(id), add: id => { if (typeof seen.add === "function") seen.add(id); } };
  fail("invalid_input", "seen must be a Set, an array, or an object exposing has(id)");
};

// Journal lookup adapter for the bounty chain check: accepts a function
// (entryId) -> hash, a { entryHash(entryId) } object (the server seam), a
// Map, a plain { entryId: hash } map, or { entries: { entryId: hash } }.
const journalHash = (journal, entryId) => {
  if (typeof journal === "function") return journal(entryId);
  if (journal instanceof Map) return journal.get(entryId);
  if (isPlainObject(journal)) {
    if (typeof journal.entryHash === "function") return journal.entryHash(entryId);
    if (isPlainObject(journal.entries)) return journal.entries[entryId];
    return journal[entryId];
  }
  fail("invalid_input", "journal must be a function, Map, { entryHash }, or an entryId -> hash map");
};

const rejected = (code, message, extra = {}) => ({ ok: false, code, reason: `${code}: ${message}`, ...extra });

// --- family: bounty (room-bounty-receipt/1) ------------------------------------

const BOUNTY_SCHEMA_VERSION = "room-bounty-receipt/1";
const BOUNTY_CREDIT_UNIT = "milli-credit";
const BOUNTY_TYPES = Object.freeze({
  "escrow-locked": "el",
  "bond-locked": "bl",
  "attributed": "at",
  "payout-released": "pr",
  "refund-issued": "rf",
});
const DECIMAL_POSITIVE = /^[1-9][0-9]*$/;
const ENTRY_ID = /^ent_[0-9a-f]{16}$/;
const LOT_ID = /^lot_[0-9a-f]{16}$/;
const ACTOR_KINDS = new Set(["human", "agent", "rule"]);
const LOT_STATES = new Set(["payable", "locked", "attributed", "approved"]);

const checkBountyEntries = payload => {
  if (!Array.isArray(payload.entries) || payload.entries.length !== 2
    || !payload.entries.every(e => typeof e === "string" && ENTRY_ID.test(e)))
    fail("invalid_receipt", "payload.entries must be exactly two journal entry ids");
  if (!Array.isArray(payload.entryHashes) || payload.entryHashes.length !== 2
    || !payload.entryHashes.every(h => typeof h === "string" && HEX64.test(h)))
    fail("invalid_receipt", "payload.entryHashes must be exactly two sha256 hex digests");
};

const BOUNTY_PAYLOAD_SCHEMAS = {
  "escrow-locked": {
    keys: ["entries", "entryHashes", "fromAccount", "fromLotState"],
    check: p => {
      checkBountyEntries(p);
      nonEmpty(p.fromAccount, 256, "payload.fromAccount");
      if (!LOT_STATES.has(p.fromLotState)) fail("invalid_receipt", "payload.fromLotState must be a lot state");
    },
  },
  "bond-locked": {
    keys: ["entries", "entryHashes", "bondKind", "fromAccount"],
    check: p => {
      checkBountyEntries(p);
      if (p.bondKind !== "claim" && p.bondKind !== "dispute")
        fail("invalid_receipt", 'payload.bondKind must be "claim" or "dispute"');
      nonEmpty(p.fromAccount, 256, "payload.fromAccount");
    },
  },
  "attributed": {
    keys: ["entries", "entryHashes", "claimant"],
    optional: ["eventSeq"],
    check: p => {
      checkBountyEntries(p);
      nonEmpty(p.claimant, 256, "payload.claimant");
      if (p.eventSeq !== undefined && (typeof p.eventSeq !== "string" || !DECIMAL_POSITIVE.test(p.eventSeq)))
        fail("invalid_receipt", "payload.eventSeq must be a decimal string");
    },
  },
  "payout-released": {
    keys: ["entries", "entryHashes", "netAmountMillis", "feeAmountMillis", "grossAmountMillis", "paidTo", "poolAccount"],
    check: (p, amountMillis) => {
      checkBountyEntries(p);
      for (const k of ["netAmountMillis", "grossAmountMillis"])
        if (typeof p[k] !== "string" || !DECIMAL_POSITIVE.test(p[k]))
          fail("invalid_receipt", `payload.${k} must be a decimal string`);
      if (typeof p.feeAmountMillis !== "string" || !/^(0|[1-9][0-9]*)$/.test(p.feeAmountMillis))
        fail("invalid_receipt", "payload.feeAmountMillis must be a decimal string");
      if (BigInt(p.netAmountMillis) !== BigInt(amountMillis))
        fail("invalid_receipt", "payload.netAmountMillis must equal the receipt amount (the payout movement)");
      if (BigInt(p.netAmountMillis) + BigInt(p.feeAmountMillis) !== BigInt(p.grossAmountMillis))
        fail("invalid_receipt", "payload.netAmountMillis + feeAmountMillis must equal payload.grossAmountMillis");
      nonEmpty(p.paidTo, 256, "payload.paidTo");
      nonEmpty(p.poolAccount, 256, "payload.poolAccount");
    },
  },
  "refund-issued": {
    keys: ["entries", "entryHashes", "reason", "refundTo"],
    check: p => {
      checkBountyEntries(p);
      if (!["timeout", "dispute-cancel", "split", "verification-rejected", "unverified"].includes(p.reason))
        fail("invalid_receipt", 'payload.reason must be "timeout", "dispute-cancel", "split", "verification-rejected" or "unverified"');
      nonEmpty(p.refundTo, 256, "payload.refundTo");
    },
  },
};

function validateBountyShape(r) {
  if (!isPlainObject(r)) fail("invalid_receipt", "receipt must be an object");
  assertNoNumbers(r, "receipt");
  exactKeys(r, ["schemaVersion", "receiptId", "type", "roomId", "bountyId", "lotId", "amountMillis",
    "creditUnit", "actor", "issuer", "issuedAt", "payload", "signature"], "receipt");
  if (r.schemaVersion !== BOUNTY_SCHEMA_VERSION)
    fail("unknown_version", `schemaVersion must be exactly ${BOUNTY_SCHEMA_VERSION}`);
  const short = BOUNTY_TYPES[r.type];
  if (!short) fail("invalid_receipt", `unknown receipt type ${JSON.stringify(r.type)}`);
  if (typeof r.receiptId !== "string"
    || !new RegExp(`^room-bounty-receipt:(${Object.values(BOUNTY_TYPES).join("|")}):[0-9a-f]{32}$`).test(r.receiptId))
    fail("invalid_receipt", "receiptId must be room-bounty-receipt:<short>:<32 hex>");
  if (!r.receiptId.startsWith(`room-bounty-receipt:${short}:`))
    fail("invalid_receipt", "receiptId short must match the receipt type");
  nonEmpty(r.bountyId, 64, "bountyId");
  if (typeof r.roomId !== "string" || r.roomId.length === 0 || r.roomId.length > 128)
    fail("invalid_receipt", "roomId must be a non-empty string (max 128 chars)");
  if (r.creditUnit !== BOUNTY_CREDIT_UNIT)
    fail("invalid_receipt", `creditUnit must be exactly ${JSON.stringify(BOUNTY_CREDIT_UNIT)}`);
  if (typeof r.lotId !== "string" || !LOT_ID.test(r.lotId)) fail("invalid_receipt", "lotId must be lot_<16 hex>");
  if (typeof r.amountMillis !== "string" || !DECIMAL_POSITIVE.test(r.amountMillis))
    fail("invalid_receipt", "amountMillis must be a positive decimal string");
  if (!isPlainObject(r.actor)) fail("invalid_receipt", "actor must be an object");
  exactKeys(r.actor, ["kind", "id"], "actor");
  if (!ACTOR_KINDS.has(r.actor.kind)) fail("invalid_receipt", "actor.kind must be human|agent|rule");
  nonEmpty(r.actor.id, 256, "actor.id");
  if (!isPlainObject(r.issuer)) fail("invalid_receipt", "issuer must be an object");
  exactKeys(r.issuer, ["pubkey", "role", "ref"], "issuer");
  if (!HEX64.test(r.issuer.pubkey)) fail("invalid_receipt", "issuer.pubkey must be 64 lowercase hex");
  if (r.issuer.role !== "escrow-keeper") fail("invalid_receipt", 'issuer.role must be "escrow-keeper"');
  nonEmpty(r.issuer.ref, 256, "issuer.ref");
  if (!validIssuedAt(r.issuedAt)) fail("invalid_receipt", "issuedAt must be a real RFC 3339 UTC timestamp");
  if (!isPlainObject(r.payload)) fail("invalid_receipt", "payload must be an object");
  const schema = BOUNTY_PAYLOAD_SCHEMAS[r.type];
  exactKeys(r.payload, [...schema.keys, ...(schema.optional ?? [])]
    .filter(k => k in r.payload || schema.keys.includes(k)), "payload");
  schema.check(r.payload, r.amountMillis);
  if (typeof r.signature !== "string" || !HEX128.test(r.signature))
    fail("invalid_receipt", "signature must be 128 lowercase hex");
}

function verifyBounty(r, options) {
  validateBountyShape(r);
  const seen = seenAdapter(options.seen);
  if (seen && seen.has(r.receiptId))
    return rejected("duplicate_receipt", "receiptId already verified", { family: "bounty", receiptId: r.receiptId });

  // Trust resolution BEFORE crypto (spec §2.5 step 7): fail closed when no
  // trusted key can be resolved, unless the caller explicitly opted into
  // integrity-only mode.
  const integrityOnly = options.integrityOnly === true;
  let keySource = "integrity-only";
  if (!integrityOnly) {
    const { keys, pinned } = collectTrustedKeys(options);
    if (pinned && r.issuer.pubkey !== pinned)
      return rejected("unexpected_signer", "valid receipt shape, but the issuer key is not the pinned operator key",
        { family: "bounty", receiptId: r.receiptId });
    if (keys.size === 0)
      return rejected("untrusted_issuer",
        "no trusted key supplied (pin --key or supply a JWKS) — a valid signature under an unknown key proves someone signed this, not who",
        { family: "bounty", receiptId: r.receiptId });
    if (!keys.has(r.issuer.pubkey))
      return rejected("untrusted_issuer", "the issuer key is not in the trusted key set",
        { family: "bounty", receiptId: r.receiptId });
    keySource = pinned ? "pinned" : "jwks";
  }

  const { signature, ...unsigned } = r;
  if (!verifyBytes(canonicalJson(unsigned), signature, r.issuer.pubkey))
    return rejected("bad_signature", "Ed25519 verification failed", { family: "bounty", receiptId: r.receiptId });

  if (options.expectedRoomId !== undefined && options.expectedRoomId !== null
    && r.roomId !== options.expectedRoomId)
    return rejected("context_mismatch", `receipt is bound to room ${JSON.stringify(r.roomId)}, not the expected room`,
      { family: "bounty", receiptId: r.receiptId });

  if (options.journal !== undefined && options.journal !== null) {
    for (let n = 0; n < r.payload.entries.length; n++) {
      let hash;
      try {
        hash = journalHash(options.journal, r.payload.entries[n]);
      } catch (error) {
        if (error instanceof VerifierError) throw error;
        return rejected("journal_mismatch", `entry lookup failed: ${error.message}`,
          { family: "bounty", receiptId: r.receiptId });
      }
      if (hash !== r.payload.entryHashes[n])
        return rejected("journal_mismatch", `entry ${r.payload.entries[n]} hash does not match the journal`,
          { family: "bounty", receiptId: r.receiptId });
    }
  }

  if (seen) seen.add(r.receiptId);
  return {
    ok: true, family: "bounty", receiptId: r.receiptId, type: r.type,
    signer: r.issuer.pubkey, verification: "signature", keySource,
    ...(integrityOnly ? { integrityOnly: true, mode: "integrity-only" } : {}),
  };
}

// --- family: vetting (vetting/1) ------------------------------------------------

const VETTING_RECEIPT_TYPE = "vetting/1";
const VETTING_DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const VETTING_DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const VETTING_RECEIPT_ID = /^vetting-receipt:[0-9a-f]{32}$/;
const DECIMAL_ANY = /^(0|[1-9][0-9]*)$/;
const SCORE_BPS = /^[0-9]{1,5}$/;
const VETTING_VERDICTS = Object.freeze(["pass", "fail"]);

function validateVettingShape(r) {
  if (!isPlainObject(r)) fail("invalid_receipt", "receipt must be an object");
  assertNoNumbers(r, "receipt");
  exactKeys(r, ["receiptType", "receiptId", "trialTaskId", "demigodReqId", "candidateId",
    "scope", "rubricScores", "verdict", "evaluator", "issuedAt", "signature"], "receipt");
  if (r.receiptType !== VETTING_RECEIPT_TYPE)
    fail("unknown_version", `receiptType must be exactly ${JSON.stringify(VETTING_RECEIPT_TYPE)}`);
  if (typeof r.receiptId !== "string" || !VETTING_RECEIPT_ID.test(r.receiptId))
    fail("invalid_receipt", "receiptId must be vetting-receipt:<32 lowercase hex>");
  nonEmpty(r.trialTaskId, 128, "trialTaskId");
  nonEmpty(r.demigodReqId, 128, "demigodReqId");
  // Identity binding: the room identity that did the work. Fail-closed — a
  // receipt without a bound candidate is rejected, never defaulted.
  nonEmpty(r.candidateId, 256, "candidateId");
  exactKeys(r.scope, ["hoursMax", "deliverableShape"], "scope");
  if (typeof r.scope.hoursMax !== "string" || !DECIMAL_ANY.test(r.scope.hoursMax))
    fail("invalid_receipt", "scope.hoursMax must be a decimal string");
  nonEmpty(r.scope.deliverableShape, 2000, "scope.deliverableShape");
  if (!Array.isArray(r.rubricScores) || r.rubricScores.length === 0)
    fail("invalid_receipt", "rubricScores must be a non-empty array");
  r.rubricScores.forEach((s, n) => {
    exactKeys(s, ["criterion", "scoreBps"], `rubricScores[${n}]`);
    nonEmpty(s.criterion, 128, `rubricScores[${n}].criterion`);
    if (typeof s.scoreBps !== "string" || !SCORE_BPS.test(s.scoreBps) || Number(s.scoreBps) > 10000)
      fail("invalid_receipt", `rubricScores[${n}].scoreBps must be a decimal string 0..10000`);
  });
  if (!VETTING_VERDICTS.includes(r.verdict))
    fail("invalid_receipt", `verdict must be one of ${VETTING_VERDICTS.join("|")}`);
  exactKeys(r.evaluator, ["kind", "id"], "evaluator");
  if (!ACTOR_KINDS.has(r.evaluator.kind))
    fail("invalid_receipt", `evaluator.kind must be one of ${[...ACTOR_KINDS].join("|")}`);
  nonEmpty(r.evaluator.id, 256, "evaluator.id");
  if (!validIssuedAt(r.issuedAt)) fail("invalid_receipt", "issuedAt must be a real RFC 3339 UTC timestamp");
  if (typeof r.signature !== "string" || !HEX128.test(r.signature))
    fail("invalid_receipt", "signature must be 128 lowercase hex");
}

function verifyVetting(r, options) {
  validateVettingShape(r);
  // Freshness (family-defined; mirrors server/vetting-receipts.mjs order:
  // freshness is checked before replay and before trust).
  const now = options.now === undefined || options.now === null
    ? Date.now()
    : (options.now instanceof Date ? options.now.getTime() : options.now);
  if (typeof now !== "number" || !Number.isFinite(now))
    fail("invalid_input", "now must be a millisecond timestamp");
  const maxAgeMs = options.maxAgeMs ?? VETTING_DEFAULT_MAX_AGE_MS;
  const clockSkewMs = options.clockSkewMs ?? VETTING_DEFAULT_CLOCK_SKEW_MS;
  const issuedMs = Date.parse(r.issuedAt);
  if (issuedMs > now + clockSkewMs)
    return rejected("future_receipt", "issuedAt is beyond the clock-skew window", { family: "vetting", receiptId: r.receiptId });
  if (issuedMs < now - maxAgeMs)
    return rejected("stale_receipt", "issuedAt is outside the freshness window", { family: "vetting", receiptId: r.receiptId });

  const seen = seenAdapter(options.seen);
  if (seen && seen.has(r.receiptId))
    return rejected("duplicate_receipt", "receiptId already verified", { family: "vetting", receiptId: r.receiptId });

  // Fail-closed: the receipt carries NO signer key, so without the caller's
  // trusted room key there is nothing to verify against. Integrity-only mode
  // cannot apply here — there is no embedded signer to "accept any" of.
  if (options.integrityOnly === true)
    return rejected("untrusted_issuer",
      "vetting receipts carry no issuer key; integrity-only mode cannot apply — supply the room's published key",
      { family: "vetting", receiptId: r.receiptId });
  const { keys, pinned } = collectTrustedKeys(options);
  if (keys.size === 0)
    return rejected("untrusted_issuer",
      "no trusted room key — a valid signature under an unknown key proves someone signed this, not who",
      { family: "vetting", receiptId: r.receiptId });

  const { signature, ...unsigned } = r;
  const bytes = canonicalJson(unsigned);
  let signer = null;
  if (pinned) {
    if (verifyBytes(bytes, signature, pinned)) signer = pinned;
  } else {
    for (const key of keys) if (verifyBytes(bytes, signature, key)) { signer = key; break; }
  }
  if (!signer)
    return rejected("bad_signature", "Ed25519 verification failed against the trusted key set",
      { family: "vetting", receiptId: r.receiptId });

  if (options.expectedCandidateId !== undefined && options.expectedCandidateId !== null
    && r.candidateId !== options.expectedCandidateId)
    return rejected("context_mismatch", "receipt is not bound to the expected candidate",
      { family: "vetting", receiptId: r.receiptId });
  if (options.expectedTrialTaskId !== undefined && options.expectedTrialTaskId !== null
    && r.trialTaskId !== options.expectedTrialTaskId)
    return rejected("context_mismatch", "receipt is not bound to the expected trial task",
      { family: "vetting", receiptId: r.receiptId });

  if (seen) seen.add(r.receiptId);
  return {
    ok: true, family: "vetting", receiptId: r.receiptId, type: r.receiptType,
    signer, verification: "signature", keySource: pinned ? "pinned" : "jwks",
    verdict: r.verdict, candidateId: r.candidateId, trialTaskId: r.trialTaskId,
  };
}

// --- family: signed evidence (room-signed-evidence/1) ----------------------------

const EVIDENCE_SCHEMA_VERSION = "room-signed-evidence/1";
const EVIDENCE_ID = /^room-evidence:ex:[0-9a-f]{32}$/;
const IDENTITY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;
const EVIDENCE_REQUIRED_KEYS = ["schemaVersion", "evidenceId", "kind", "signerIdentityId", "issuedAt", "contentHash", "signature"];
const EVIDENCE_OPTIONAL_KEYS = ["contentType", "evidenceUrl", "label"];

function validateEvidenceShape(r) {
  if (!isPlainObject(r)) fail("invalid_evidence", "evidence must be an object");
  assertNoNumbers(r, "evidence");
  for (const key of EVIDENCE_REQUIRED_KEYS)
    if (!Object.hasOwn(r, key)) fail("invalid_evidence", `evidence is missing required key ${JSON.stringify(key)}`);
  for (const key of Object.keys(r))
    if (!EVIDENCE_REQUIRED_KEYS.includes(key) && !EVIDENCE_OPTIONAL_KEYS.includes(key))
      fail("invalid_evidence", `evidence has unexpected key ${JSON.stringify(key)}`);
  if (r.schemaVersion !== EVIDENCE_SCHEMA_VERSION)
    fail("invalid_evidence", `schemaVersion must be exactly ${EVIDENCE_SCHEMA_VERSION}`);
  if (typeof r.evidenceId !== "string" || !EVIDENCE_ID.test(r.evidenceId))
    fail("invalid_evidence", "evidenceId must be room-evidence:ex:<32 hex>");
  if (r.kind !== "external")
    fail("invalid_evidence", 'kind must be "external"');
  if (typeof r.signerIdentityId !== "string" || !IDENTITY_ID.test(r.signerIdentityId))
    fail("invalid_evidence", "signerIdentityId must match [A-Za-z0-9_-]{1,64}");
  if (!validIssuedAt(r.issuedAt))
    fail("invalid_evidence", "issuedAt must be a real RFC 3339 UTC timestamp");
  if (typeof r.contentHash !== "string" || !CONTENT_HASH.test(r.contentHash))
    fail("invalid_evidence", 'contentHash must be "sha256:<64 hex>"');
  if (r.contentType !== undefined) nonEmpty(r.contentType, 128, "contentType", "invalid_evidence");
  if (r.evidenceUrl !== undefined) nonEmpty(r.evidenceUrl, 2048, "evidenceUrl", "invalid_evidence");
  if (r.label !== undefined) nonEmpty(r.label, 256, "label", "invalid_evidence");
  if (typeof r.signature !== "string" || !HEX128.test(r.signature))
    fail("invalid_evidence", "signature must be 128 lowercase hex");
}

// Registry times accept millisecond numbers or RFC 3339 strings; registry
// keys accept lowercase hex or base64/base64url of the raw 32 bytes (the
// server registry stores canonical base64).
const registryTime = v => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : undefined; // undefined = malformed row
  }
  return undefined;
};

const registryPubkeyHex = row => {
  const raw = row.publicKey ?? row.pubkey ?? row.publicKeyHex ?? row.pubkeyHex;
  if (typeof raw !== "string") return null;
  if (HEX64.test(raw)) return raw;
  try {
    const bytes = Buffer.from(raw, "base64");
    return bytes.length === 32 ? bytes.toString("hex") : null;
  } catch {
    return null;
  }
};

// Normalize the caller's registry into rows for one signer. Accepted
// shapes: { keysFor(identityId) } (the server seam), a Map, a plain
// { identityId: row | [rows] } map, an array of rows (rows may carry
// signerIdentityId / identityId; rows without one are treated as belonging
// to the requested signer — the single-signer fixture shape), or
// { keys: [...] } wrapping that array.
const registryRowsFor = (registry, signerIdentityId) => {
  if (registry === null || registry === undefined) return null; // no trust root supplied
  let rows = null;
  if (typeof registry.keysFor === "function") rows = registry.keysFor(signerIdentityId);
  else if (registry instanceof Map) rows = registry.get(signerIdentityId);
  else if (Array.isArray(registry)) rows = registry;
  else if (isPlainObject(registry)) {
    if (Array.isArray(registry.keys)) rows = registry.keys;
    else rows = registry[signerIdentityId];
  }
  if (rows === null || rows === undefined) return [];
  const list = Array.isArray(rows) ? rows : [rows];
  return list.filter(row => {
    if (!isPlainObject(row)) return false;
    const owner = row.signerIdentityId ?? row.identityId;
    return owner === undefined || owner === null || owner === signerIdentityId;
  });
};

function verifySignedEvidence(r, options) {
  validateEvidenceShape(r);
  const seen = seenAdapter(options.seen);
  if (seen && seen.has(r.evidenceId))
    return rejected("duplicate_evidence", "evidenceId was already verified", { family: "signed-evidence", receiptId: r.evidenceId });

  const registry = options.registry ?? options.keyRegistry;
  const rows = registryRowsFor(registry, r.signerIdentityId);
  if (rows === null)
    return rejected("untrusted_issuer",
      "no key registry supplied — signed evidence verifies only against the signer's registered keys",
      { family: "signed-evidence", receiptId: r.evidenceId });
  if (rows.length === 0)
    return rejected("unknown_signer", `no registered key for identity ${r.signerIdentityId}`,
      { family: "signed-evidence", receiptId: r.evidenceId });

  const issuedMs = Date.parse(r.issuedAt);
  const normalized = rows.map(row => ({
    pubkeyHex: registryPubkeyHex(row),
    validFrom: registryTime(row.validFrom ?? row.valid_from),
    validUntil: registryTime(row.validUntil ?? row.valid_until),
    revokedAt: registryTime(row.revokedAt ?? row.revoked_at),
  })).filter(row => row.validFrom !== undefined && row.validUntil !== undefined && row.revokedAt !== undefined);
  const inWindow = row => row.validFrom !== null && row.validFrom <= issuedMs
    && (row.validUntil === null || issuedMs < row.validUntil);
  const candidates = normalized.filter(row => inWindow(row)
    && (row.revokedAt === null || issuedMs < row.revokedAt));
  if (candidates.length === 0) {
    const revoked = normalized.some(row => inWindow(row)
      && row.revokedAt !== null && issuedMs >= row.revokedAt);
    return revoked
      ? rejected("revoked_key", `the signing key for ${r.signerIdentityId} was revoked before ${r.issuedAt}`,
        { family: "signed-evidence", receiptId: r.evidenceId })
      : rejected("expired_key", `no registered key for ${r.signerIdentityId} covers issuedAt ${r.issuedAt} (rotated out or not yet valid)`,
        { family: "signed-evidence", receiptId: r.evidenceId });
  }

  const { signature, ...unsigned } = r;
  const bytes = canonicalJson(unsigned);
  for (const row of candidates) {
    if (!row.pubkeyHex) continue; // malformed registry rows never match (fail closed)
    if (verifyBytes(bytes, signature, row.pubkeyHex)) {
      if (seen) seen.add(r.evidenceId);
      return {
        ok: true, family: "signed-evidence", receiptId: r.evidenceId, type: r.schemaVersion,
        signer: r.signerIdentityId, signerPubkey: row.pubkeyHex,
        verification: "signature", keySource: "registry", contentHash: r.contentHash,
      };
    }
  }
  return rejected("bad_signature", "Ed25519 verification failed against every key valid at issuedAt",
    { family: "signed-evidence", receiptId: r.evidenceId });
}

// --- family: public work (public-work-receipt/1, hash-only) ----------------------

const PUBLIC_WORK_SCHEMA = "public-work-receipt/1";
const PUBLIC_WORK_ID = /^pwr_[0-9a-f]{64}$/;

// The content hash the receiptId commits to (server/public-work-claims.mjs):
// sha256 over the loose canonical JSON of the submission tuple.
export function publicWorkReceiptId({ taskId, identityId, generation, sha256, checksReported }) {
  return "pwr_" + sha256Hex(canonicalJsonLoose({
    offerId: taskId, identityId, generation, sha256, checksReported,
  }));
}

function validatePublicWorkShape(r) {
  if (!isPlainObject(r)) fail("invalid_receipt", "receipt must be an object");
  exactKeys(r, ["schema", "receiptId", "taskId", "title", "termsVersion", "namespaceId", "generation",
    "identityId", "agentName", "state", "artifact", "checksReported", "verification", "createdAt"], "receipt");
  if (r.schema !== PUBLIC_WORK_SCHEMA)
    fail("unknown_version", `schema must be exactly ${PUBLIC_WORK_SCHEMA}`);
  if (typeof r.receiptId !== "string" || !PUBLIC_WORK_ID.test(r.receiptId))
    fail("invalid_receipt", "receiptId must be pwr_<64 lowercase hex> (the submission content hash)");
  nonEmpty(r.taskId, 256, "taskId");
  nonEmpty(r.title, 2048, "title");
  if (!Number.isInteger(r.termsVersion) || r.termsVersion < 1)
    fail("invalid_receipt", "termsVersion must be an integer >= 1");
  nonEmpty(r.namespaceId, 256, "namespaceId");
  if (!Number.isInteger(r.generation) || r.generation < 1)
    fail("invalid_receipt", "generation must be an integer >= 1");
  nonEmpty(r.identityId, 256, "identityId");
  nonEmpty(r.agentName, 256, "agentName");
  if (r.state !== "submitted") fail("invalid_receipt", 'state must be "submitted"');
  exactKeys(r.artifact, ["sha256", "bytes"], "artifact");
  if (typeof r.artifact.sha256 !== "string" || !HEX64.test(r.artifact.sha256))
    fail("invalid_receipt", "artifact.sha256 must be 64 lowercase hex");
  if (!Number.isInteger(r.artifact.bytes) || r.artifact.bytes < 0 || r.artifact.bytes > 65536)
    fail("invalid_receipt", "artifact.bytes must be an integer 0..65536");
  if (!Array.isArray(r.checksReported) || r.checksReported.length > 20
    || !r.checksReported.every(c => typeof c === "string" && c.length >= 1 && c.length <= 1000))
    fail("invalid_receipt", "checksReported must be an array of at most 20 non-empty strings (<= 1000 chars)");
  if (r.verification !== "hash_only")
    fail("invalid_receipt", 'verification must be "hash_only"');
  if (!validIssuedAt(r.createdAt)) fail("invalid_receipt", "createdAt must be a real RFC 3339 UTC timestamp");
}

function verifyPublicWork(r, options) {
  validatePublicWorkShape(r);
  // Hash-only is an explicit caller opt-in (spec §4.2): this family carries
  // no signature and no issuer key, so a "verification" that does not say
  // so would overstate what was checked.
  if (options.integrityOnly !== true)
    return rejected("integrity_only_required",
      'public-work receipts are unsigned (verification: "hash_only"); pass integrityOnly / --integrity-only to check the content hash without issuer attestation',
      { family: "public-work", receiptId: r.receiptId });

  const seen = seenAdapter(options.seen);
  if (seen && seen.has(r.receiptId))
    return rejected("duplicate_receipt", "receiptId already verified", { family: "public-work", receiptId: r.receiptId });

  const expectedId = publicWorkReceiptId({
    taskId: r.taskId, identityId: r.identityId, generation: r.generation,
    sha256: r.artifact.sha256, checksReported: r.checksReported,
  });
  if (expectedId !== r.receiptId)
    return rejected("hash_mismatch", "receiptId does not equal the submission content hash",
      { family: "public-work", receiptId: r.receiptId });

  const artifact = options.artifactBytes ?? options.artifactText;
  if (artifact !== undefined && artifact !== null) {
    const bytes = Buffer.isBuffer(artifact) || artifact instanceof Uint8Array
      ? Buffer.from(artifact) : Buffer.from(String(artifact), "utf8");
    if (sha256Hex(bytes) !== r.artifact.sha256 || bytes.length !== r.artifact.bytes)
      return rejected("hash_mismatch", "supplied artifact bytes do not match artifact.sha256 / artifact.bytes",
        { family: "public-work", receiptId: r.receiptId });
  }

  if (seen) seen.add(r.receiptId);
  return {
    ok: true, family: "public-work", receiptId: r.receiptId, type: r.schema,
    signer: null, verification: "hash_only", integrityOnly: true, mode: "integrity-only",
  };
}

// --- dispatch ---------------------------------------------------------------------

const FAMILY_ALIASES = Object.freeze({
  bounty: "bounty",
  "room-bounty-receipt/1": "bounty",
  vetting: "vetting",
  "vetting/1": "vetting",
  "signed-evidence": "signed-evidence",
  "room-signed-evidence/1": "signed-evidence",
  "public-work": "public-work",
  "public-work-receipt/1": "public-work",
});

function detectFamily(r) {
  if (typeof r.schemaVersion === "string" && r.schemaVersion.startsWith("room-bounty-receipt")) return "bounty";
  if (typeof r.schemaVersion === "string" && r.schemaVersion.startsWith("room-signed-evidence")) return "signed-evidence";
  if (typeof r.receiptType === "string" && r.receiptType.startsWith("vetting")) return "vetting";
  if (typeof r.schema === "string" && r.schema.startsWith("public-work-receipt")) return "public-work";
  if (typeof r.schema === "string" && r.schema === "project-room-public-receipt/1") return "public-projection";
  if (typeof r.receiptId === "string") {
    if (r.receiptId.startsWith("room-bounty-receipt:")) return "bounty";
    if (r.receiptId.startsWith("vetting-receipt:")) return "vetting";
    if (r.receiptId.startsWith("room-evidence:")) return "signed-evidence";
    if (PUBLIC_WORK_ID.test(r.receiptId)) return "public-work";
    if (/^(?:pwr_|wcr_|wir_)/.test(r.receiptId)) return "public-projection";
  }
  if (typeof r.evidenceId === "string" && r.evidenceId.startsWith("room-evidence:")) return "signed-evidence";
  if (typeof r.schemaVersion === "string" || typeof r.receiptType === "string" || typeof r.schema === "string")
    return "unknown";
  return null;
}

// Verify one receipt. Accepts the receipt object or its exact JSON text
// (text is strict-parsed: duplicate keys and trailing data are rejected).
// Never throws for a malformed or untrusted receipt — it returns a verdict:
//
//   { ok: true, family, receiptId, type, signer, verification, ... }
//   { ok: false, family?, receiptId?, code, reason: "<code>: <message>" }
//
// Options (all optional; see the family contracts above):
//   family            force a family ("bounty" | "vetting" |
//                     "signed-evidence" | "public-work")
//   expectedPubkey / key   pinned Ed25519 pubkey hex (strongest trust)
//   jwks              a JWKS document object (already fetched — this module
//                     performs no network access) as a discovery trust set
//   trustedPubkeys    array of pubkey hex strings
//   integrityOnly      explicit opt-in: accept any signer (signed families
//                     still verify the signature under the receipt's own
//                     key and report who signed) / enable hash-only mode
//                     (public-work). Always labelled in the verdict.
//   seen              Set | array | { has, add } replay guard
//   journal           bounty journal lookup (see journalHash shapes)
//   registry / keyRegistry   signed-evidence key registry (see
//                     registryRowsFor shapes)
//   expectedRoomId    bounty context binding
//   expectedCandidateId / expectedTrialTaskId   vetting context binding
//   now / maxAgeMs / clockSkewMs                vetting freshness
//   artifactText / artifactBytes                public-work artifact check
export function verifyReceipt(input, options = {}) {
  if (!isPlainObject(options)) return rejected("invalid_input", "options must be an object");
  let r;
  try {
    r = typeof input === "string" ? parseStrict(input) : input;
  } catch (error) {
    return error instanceof VerifierError
      ? rejected(error.code, error.message)
      : rejected("invalid_json", String(error?.message ?? error));
  }
  if (!isPlainObject(r)) return rejected("invalid_receipt", "receipt must be a JSON object");

  let family = null;
  try {
    if (options.family !== undefined && options.family !== null) {
      family = FAMILY_ALIASES[options.family] ?? null;
      if (!family) return rejected("invalid_input", `unknown family ${JSON.stringify(options.family)}`);
    } else {
      family = detectFamily(r);
    }
  } catch (error) {
    return rejected("invalid_input", String(error?.message ?? error));
  }

  // The public receipt projection (/receipts/<id>.json) is unsigned
  // server-attested data. It must never be reported as verified (spec §4.4).
  if (family === "public-projection")
    return rejected("server_attested",
      "the public receipt projection is unsigned and server-attested; it is a display surface, not verifiable evidence",
      { family: "public-projection", receiptId: typeof r.id === "string" ? r.id : r.receiptId });
  if (family === "unknown")
    return rejected("unknown_version", "unrecognized receipt schema/version", {});
  if (!family)
    return rejected("invalid_receipt", "cannot determine the receipt family from its fields", {});

  try {
    switch (family) {
      case "bounty": return verifyBounty(r, options);
      case "vetting": return verifyVetting(r, options);
      case "signed-evidence": return verifySignedEvidence(r, options);
      case "public-work": return verifyPublicWork(r, options);
      default: return rejected("invalid_input", `unhandled family ${family}`);
    }
  } catch (error) {
    if (error instanceof VerifierError)
      return rejected(error.code, error.message, { family, receiptId: r.receiptId ?? r.evidenceId });
    return rejected("invalid_input", String(error?.message ?? error), { family });
  }
}

export { VerifierError };
