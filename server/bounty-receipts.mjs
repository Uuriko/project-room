// Signed bounty receipts (integration slice #1).
//
// Upgrades the bounty ledger's movement receipts from server-attested to
// independently verifiable: every value-moving bounty transition (fund,
// bond-lock, attribute, payout, refund) can carry an Ed25519-signed receipt
// whose canonical encoding is BYTE-IDENTICAL to the dasha-receipt/1 spec
// (RFC 8785 restated in RECEIPT-SCHEMA.md §4; hard ban on JSON numbers in
// signed bodies). Anyone holding the receipt and the operator's public key
// can verify it offline — no trust in the room server required.
//
// Credits-only boundary: receipts name credit lots (bountyId, lotId,
// milli-credit amounts as decimal strings). They NEVER reference assets,
// chains, transactions, or cash value. Amounts say "credits moved", never
// money.
//
// Key management: test keys only in this slice. Generate in-memory with
// generateReceiptKeyPair() or import a local 0600 file with importSeed() —
// the caller owns storage. The signer is injected into BountyEscrow via the
// `receipts` constructor option; when absent, transitions return
// `signed: []` and no journal entries are stamped. Production key
// provisioning (operator key registry, rotation, validity windows) is a
// later slice — see docs/bounty-receipts.md for the trust statement.
//
// Pure: node:crypto only, no I/O, no dependencies.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";

export const RECEIPT_SCHEMA_VERSION = "room-bounty-receipt/1";
export const CREDIT_UNIT = "milli-credit";

// Receipt types and their two-letter receiptId shorts. The short MUST match
// the type so a receipt cannot be replayed as a different kind.
export const RECEIPT_TYPES = Object.freeze({
  "escrow-locked": "el",   // fund: poster payable -> locked
  "bond-locked": "bl",     // claim / dispute bond: lane payable -> locked
  "attributed": "at",      // accept (or dispute release/split): award -> claimant attributed
  "payout-released": "pr", // epoch sweep: approved -> payable (+ 1% pool fee)
  "refund-issued": "rf",   // timeout / dispute-cancel / split: award -> poster payable
});

class ReceiptError extends Error {
  constructor(code, message) { super(message); this.name = "ReceiptError"; this.code = code; }
}
const fail = (code, message) => { throw new ReceiptError(code, message); };

// --- canonical JSON (byte-exact, dasha-receipt/1 §4) -------------------------
//
// Objects: members sorted by key, ordered by UTF-16 code units (JS strings
// ARE UTF-16, so charCodeAt compares units directly). No whitespace.
// Strings: UTF-8 output; escape ONLY `"` `\` and U+0000–U+001F (\b \f \n \r
// \t shorthands where defined, else \u00xx lowercase hex). NEVER escape `/`.
// NEVER escape non-ASCII. Literals true/false/null exactly.
// Numbers: FORBIDDEN in signed bodies — a verifier MUST reject any JSON
// number inside the signed portion before signature checking (multiple legal
// serializations of one value are a canonicalization hazard).

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

// --- strict JSON parse (duplicate-key rejection) -----------------------------
//
// JSON.parse silently keeps the LAST of duplicate keys; {"a":1,"a":2} has no
// canonical form, so a signer and verifier could disagree on what was
// signed. This parser rejects duplicates at parse time. Numbers are kept as
// JS numbers so the number ban can reject them with a precise error.

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

// --- Ed25519 (node:crypto, hex wire format per dasha-receipt/1) ---------------

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
// Fixed DER prefixes (RFC 8410): import raw 32-byte seeds/pubkeys without
// keeping full DER blobs around.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const checkSeedHex = seedHex => {
  if (typeof seedHex !== "string" || !HEX64.test(seedHex))
    fail("invalid_key", "seed must be 64 lowercase hex characters (32-byte Ed25519 seed)");
  return Buffer.from(seedHex, "hex");
};

const checkPubkeyHex = pubkeyHex => {
  if (typeof pubkeyHex !== "string" || !HEX64.test(pubkeyHex))
    fail("invalid_key", "public key must be 64 lowercase hex characters");
  return Buffer.from(pubkeyHex, "hex");
};

export function importSeed(seedHex) {
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, checkSeedHex(seedHex)]), format: "der", type: "pkcs8" });
}

export function importPubkey(pubkeyHex) {
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, checkPubkeyHex(pubkeyHex)]), format: "der", type: "spki" });
}

// Test keys only: generated in-memory, never persisted by this module.
export function generateReceiptKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    seedHex: Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url").toString("hex"),
    pubkeyHex: Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex"),
  };
}

export function signBytes(bytes, seedHex) {
  return sign(null, Buffer.from(bytes), importSeed(seedHex)).toString("hex");
}

export function verifyBytes(bytes, signatureHex, pubkeyHex) {
  try {
    if (typeof signatureHex !== "string" || !HEX128.test(signatureHex)) return false;
    const key = importPubkey(pubkeyHex);
    return verify(null, Buffer.from(bytes), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

// Build the operator signer injected into BountyEscrow. Validates the seed
// eagerly so a misconfigured key fails at boot, not at first payout.
export function createReceiptSigner({ seedHex, ref }) {
  checkSeedHex(seedHex);
  if (typeof ref !== "string" || ref.length < 1 || ref.length > 256)
    fail("invalid_input", "signer ref must be 1..256 characters");
  const x = createPublicKey(importSeed(seedHex)).export({ format: "jwk" }).x;
  const pubkeyHex = Buffer.from(x, "base64url").toString("hex");
  return Object.freeze({ seedHex, pubkeyHex, ref });
}

// --- receipt shape ------------------------------------------------------------

const HEX32 = /^[0-9a-f]{32}$/;
const DECIMAL = /^[1-9][0-9]*$/; // positive milli-credit amounts, no leading zeros
const ENTRY_ID = /^ent_[0-9a-f]{16}$/;
const LOT_ID = /^lot_[0-9a-f]{16}$/;
const ACTOR_KINDS = new Set(["human", "agent", "rule"]);
const LOT_STATES = new Set(["payable", "locked", "attributed", "approved"]);

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
  const got = Object.keys(obj).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((k, n) => k !== want[n]))
    fail("invalid_receipt", `${label} must have exactly keys [${want.join(", ")}]`);
};

const validIssuedAt = s => {
  // RFC 3339 UTC, seconds precision or exactly-3-digit millis, real
  // calendar time (no rollover like month 13). The spellings must be
  // canonical: "…:56Z" or "…:56.789Z", never "…:56.78Z".
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(s)) return false;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return false;
  const d = new Date(ms), pad = n => String(n).padStart(2, "0");
  const canon = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const frac = d.getUTCMilliseconds();
  // Zero millis accept both spellings ("…:56Z" and "…:56.000Z"); nonzero
  // millis require exactly three digits.
  return s === `${canon}Z` || (frac === 0 && s === `${canon}.000Z`)
    || (frac !== 0 && s === `${canon}.${String(frac).padStart(3, "0")}Z`);
};

const checkEntries = payload => {
  if (!Array.isArray(payload.entries) || payload.entries.length !== 2
    || !payload.entries.every(e => typeof e === "string" && ENTRY_ID.test(e)))
    fail("invalid_receipt", "payload.entries must be exactly two journal entry ids");
  if (!Array.isArray(payload.entryHashes) || payload.entryHashes.length !== 2
    || !payload.entryHashes.every(h => typeof h === "string" && HEX64.test(h)))
    fail("invalid_receipt", "payload.entryHashes must be exactly two sha256 hex digests");
};

const PAYLOAD_SCHEMAS = {
  "escrow-locked": {
    keys: ["entries", "entryHashes", "fromAccount", "fromLotState"],
    check: p => {
      checkEntries(p);
      nonEmpty(p.fromAccount, 256, "payload.fromAccount");
      if (!LOT_STATES.has(p.fromLotState)) fail("invalid_receipt", "payload.fromLotState must be a lot state");
    },
  },
  "bond-locked": {
    keys: ["entries", "entryHashes", "bondKind", "fromAccount"],
    check: p => {
      checkEntries(p);
      if (p.bondKind !== "claim" && p.bondKind !== "dispute")
        fail("invalid_receipt", 'payload.bondKind must be "claim" or "dispute"');
      nonEmpty(p.fromAccount, 256, "payload.fromAccount");
    },
  },
  "attributed": {
    keys: ["entries", "entryHashes", "claimant"],
    optional: ["eventSeq"],
    check: p => {
      checkEntries(p);
      nonEmpty(p.claimant, 256, "payload.claimant");
      if (p.eventSeq !== undefined && (typeof p.eventSeq !== "string" || !DECIMAL.test(p.eventSeq)))
        fail("invalid_receipt", "payload.eventSeq must be a decimal string");
    },
  },
  "payout-released": {
    keys: ["entries", "entryHashes", "netAmountMillis", "feeAmountMillis", "grossAmountMillis", "paidTo", "poolAccount"],
    check: (p, amountMillis) => {
      checkEntries(p);
      for (const k of ["netAmountMillis", "grossAmountMillis"])
        if (typeof p[k] !== "string" || !DECIMAL.test(p[k]))
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
      checkEntries(p);
      if (!["timeout", "dispute-cancel", "split"].includes(p.reason))
        fail("invalid_receipt", 'payload.reason must be "timeout", "dispute-cancel" or "split"');
      nonEmpty(p.refundTo, 256, "payload.refundTo");
    },
  },
};

function validateShape(r) {
  if (!isPlainObject(r)) fail("invalid_receipt", "receipt must be an object");
  // Number ban first (dasha-receipt/1 §4): a JSON number has multiple legal
  // serializations, so any number inside the signed portion is rejected
  // before anything else — including before signature verification.
  assertNoNumbers(r, "receipt");
  exactKeys(r, ["schemaVersion", "receiptId", "type", "roomId", "bountyId", "lotId", "amountMillis",
    "creditUnit", "actor", "issuer", "issuedAt", "payload", "signature"], "receipt");
  if (r.schemaVersion !== RECEIPT_SCHEMA_VERSION)
    fail("invalid_receipt", `schemaVersion must be exactly ${RECEIPT_SCHEMA_VERSION}`);
  const short = RECEIPT_TYPES[r.type];
  if (!short) fail("invalid_receipt", `unknown receipt type ${JSON.stringify(r.type)}`);
  if (typeof r.receiptId !== "string"
    || !new RegExp(`^room-bounty-receipt:(${Object.values(RECEIPT_TYPES).join("|")}):[0-9a-f]{32}$`).test(r.receiptId))
    fail("invalid_receipt", "receiptId must be room-bounty-receipt:<short>:<32 hex>");
  if (!r.receiptId.startsWith(`room-bounty-receipt:${short}:`))
    fail("invalid_receipt", "receiptId short must match the receipt type");
  nonEmpty(r.bountyId, 64, "bountyId");
  if (typeof r.roomId !== "string" || r.roomId.length === 0 || r.roomId.length > 128)
    fail("invalid_receipt", "roomId must be a non-empty string (max 128 chars)");
  if (r.creditUnit !== CREDIT_UNIT)
    fail("invalid_receipt", `creditUnit must be exactly ${JSON.stringify(CREDIT_UNIT)}`);
  if (typeof r.lotId !== "string" || !LOT_ID.test(r.lotId)) fail("invalid_receipt", "lotId must be lot_<16 hex>");
  if (typeof r.amountMillis !== "string" || !DECIMAL.test(r.amountMillis))
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
  const schema = PAYLOAD_SCHEMAS[r.type];
  exactKeys(r.payload, [...schema.keys, ...(schema.optional ?? [])].filter(k => k in r.payload || schema.keys.includes(k)), "payload");
  schema.check(r.payload, r.amountMillis);
  if (typeof r.signature !== "string" || !HEX128.test(r.signature))
    fail("invalid_receipt", "signature must be 128 lowercase hex");
}

// --- issue / verify -----------------------------------------------------------

export function issueBountyReceipt({ type, roomId, bountyId, lotId, amountMillis, actor, entries,
  entryHashes, payload, issuer, issuedAt, seedHex }) {
  const short = RECEIPT_TYPES[type];
  if (!short) fail("invalid_input", `unknown receipt type ${JSON.stringify(type)}`);
  if (typeof roomId !== "string" || roomId.length === 0 || roomId.length > 128)
    fail("invalid_input", "roomId must be a non-empty string (max 128 chars)");
  checkSeedHex(seedHex);
  const receiptId = `room-bounty-receipt:${short}:${randomBytes(16).toString("hex")}`;
  const unsigned = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    receiptId, type, roomId, bountyId, lotId,
    amountMillis: String(amountMillis),
    creditUnit: CREDIT_UNIT,
    actor, issuer,
    issuedAt,
    payload: { entries, entryHashes, ...payload },
  };
  validateShape({ ...unsigned, signature: "0".repeat(128) }); // shape first, signature last
  const bytes = canonicalJson(unsigned);
  const signature = signBytes(bytes, seedHex);
  return Object.freeze({ ...unsigned,
    payload: Object.freeze({ ...unsigned.payload,
      entries: Object.freeze([...unsigned.payload.entries]),
      entryHashes: Object.freeze([...unsigned.payload.entryHashes]) }),
    actor: Object.freeze({ ...unsigned.actor }),
    issuer: Object.freeze({ ...unsigned.issuer }),
    signature });
}

// Verify a receipt. Accepts a receipt object or its JSON text (text is
// parsed strictly — duplicate keys rejected). Never throws for an invalid
// receipt: returns { ok: false, reason }. Options:
//   expectedPubkey — the operator key this context trusts (out-of-band
//     binding; a valid signature under any other key is "someone signed
//     this", not authentication).
//   seen — a Set of receiptIds for replay protection; verified ids are added.
//   journal — { entryHash(entryId) } to check the receipt's entry linkage
//     against the ledger.
export function verifyBountyReceipt(receipt, { expectedPubkey = null, seen = null, journal = null } = {}) {
  const invalid = reason => ({ ok: false, reason });
  let r;
  try {
    r = typeof receipt === "string" ? parseStrict(receipt) : receipt;
    validateShape(r);
  } catch (error) {
    return invalid(error instanceof ReceiptError ? `${error.code}: ${error.message}` : `invalid_receipt: ${error.message}`);
  }
  if (seen !== null && seen !== undefined) {
    if (!(seen instanceof Set)) return invalid("invalid_input: seen must be a Set");
    if (seen.has(r.receiptId)) return invalid("duplicate_receipt: receiptId already verified");
  }
  const unsigned = { ...r };
  delete unsigned.signature;
  let bytes;
  try {
    bytes = canonicalJson(unsigned);
  } catch (error) {
    return invalid(`number_ban: ${error.message}`);
  }
  if (!verifyBytes(bytes, r.signature, r.issuer.pubkey)) return invalid("bad_signature: Ed25519 verification failed");
  if (expectedPubkey !== null && expectedPubkey !== undefined) {
    if (typeof expectedPubkey !== "string" || r.issuer.pubkey !== expectedPubkey.toLowerCase())
      return invalid("unexpected_signer: valid signature, but not from the expected operator key");
  }
  if (journal !== null && journal !== undefined) {
    for (let n = 0; n < r.payload.entries.length; n++) {
      let hash;
      try {
        hash = journal.entryHash(r.payload.entries[n]);
      } catch (error) {
        return invalid(`journal_mismatch: entry lookup failed: ${error.message}`);
      }
      if (hash !== r.payload.entryHashes[n])
        return invalid(`journal_mismatch: entry ${r.payload.entries[n]} hash does not match`);
    }
  }
  if (seen instanceof Set) seen.add(r.receiptId);
  return { ok: true, receiptId: r.receiptId, type: r.type, signer: r.issuer.pubkey };
}

export { ReceiptError };
