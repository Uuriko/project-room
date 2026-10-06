// Signed vetting receipts (Demigod x Project Room — RECORD-ONLY).
//
// Demigod (talent network) consumes these as candidate vetting evidence: a
// room evaluator attests that a candidate completed a trial task against a
// rubric, and Demigod verifies the attestation offline. RECORD-ONLY — no
// money moves, ever, in this build. Receipts name no assets, credits, or
// value; they attest work quality only.
//
// HANDOFF — Demigod fetches GET /trial-tasks/:id/receipt, verifies the
// signature against the room's published key, checks identity binding
// (receipt.candidateId is the room identity that did the work — match it
// against the expected candidate), enforces the freshness window, and
// enforces receiptId uniqueness for replay protection.
//
// Crypto discipline is reused verbatim from server/bounty-receipts.mjs (do
// NOT reimplement): byte-exact canonical JSON, strict duplicate-key-
// rejecting parse, JSON-number ban inside signed bodies, Ed25519 over the
// canonical bytes. Shape discipline mirrors server/receipt-standard.mjs.
//
// Pure: node:crypto only, no I/O, no dependencies.
import { createPublicKey, randomBytes } from "node:crypto";
import {
  canonicalJson,
  generateReceiptKeyPair,
  importSeed,
  parseStrict,
  ReceiptError,
  signBytes,
  validIssuedAt,
  verifyBytes,
} from "./bounty-receipts.mjs";

export const RECEIPT_TYPE_VETTING = "vetting/1";
// Vetting evidence is consumed over a hiring pipeline, so the freshness
// window is wider than the 24h work-receipt default; callers may tighten it
// with maxAgeMs. No money moves, so replay here is a stale-credential risk,
// not a double-spend risk.
export const DEFAULT_VETTING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;

const fail = (code, message) => { throw new ReceiptError(code, message); };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const RECEIPT_ID = /^vetting-receipt:[0-9a-f]{32}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SCORE_BPS = /^[0-9]{1,5}$/;
const KINDS = Object.freeze(["human", "agent", "rule"]);
const VERDICTS = Object.freeze(["pass", "fail"]);

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

const RECEIPT_KEYS = ["receiptType", "receiptId", "trialTaskId", "demigodReqId",
  "candidateId", "scope", "rubricScores", "verdict", "evaluator", "issuedAt", "signature"];

function checkScope(scope) {
  exactKeys(scope, ["hoursMax", "deliverableShape"], "scope");
  if (typeof scope.hoursMax !== "string" || !DECIMAL.test(scope.hoursMax))
    fail("invalid_receipt", "scope.hoursMax must be a decimal string");
  nonEmpty(scope.deliverableShape, 2000, "scope.deliverableShape");
}

function checkRubricScores(scores) {
  if (!Array.isArray(scores) || scores.length === 0)
    fail("invalid_receipt", "rubricScores must be a non-empty array");
  for (const [n, s] of scores.entries()) {
    exactKeys(s, ["criterion", "scoreBps"], `rubricScores[${n}]`);
    nonEmpty(s.criterion, 128, `rubricScores[${n}].criterion`);
    // Basis points 0..10000 (10000 = 100%), always a string.
    if (typeof s.scoreBps !== "string" || !SCORE_BPS.test(s.scoreBps) || Number(s.scoreBps) > 10000)
      fail("invalid_receipt", `rubricScores[${n}].scoreBps must be a decimal string 0..10000`);
  }
}

function checkEvaluator(evaluator) {
  exactKeys(evaluator, ["kind", "id"], "evaluator");
  const validKind = KINDS.includes(evaluator.kind);
  if (!validKind)
    fail("invalid_receipt", `evaluator.kind must be one of ${KINDS.join("|")}`);
  nonEmpty(evaluator.id, 256, "evaluator.id");
}

function validateVettingShape(r) {
  // Number ban first: a JSON number has multiple legal serializations, so
  // any number inside the signed portion is rejected before signature
  // verification.
  assertNoNumbers(r, "receipt");
  exactKeys(r, RECEIPT_KEYS, "receipt");
  if (r.receiptType !== RECEIPT_TYPE_VETTING)
    fail("unknown_version", `receiptType must be exactly ${JSON.stringify(RECEIPT_TYPE_VETTING)}`);
  if (typeof r.receiptId !== "string" || !RECEIPT_ID.test(r.receiptId))
    fail("invalid_receipt", "receiptId must be vetting-receipt:<32 lowercase hex>");
  nonEmpty(r.trialTaskId, 128, "trialTaskId");
  nonEmpty(r.demigodReqId, 128, "demigodReqId");
  // Identity binding: the room identity that did the work. Fail-closed —
  // a receipt without a bound candidate is rejected, never defaulted.
  nonEmpty(r.candidateId, 256, "candidateId");
  checkScope(r.scope);
  checkRubricScores(r.rubricScores);
  if (!VERDICTS.includes(r.verdict))
    fail("invalid_receipt", `verdict must be one of ${VERDICTS.join("|")}`);
  checkEvaluator(r.evaluator);
  if (!validIssuedAt(r.issuedAt)) fail("invalid_receipt", "issuedAt must be a real RFC 3339 UTC timestamp");
  if (typeof r.signature !== "string" || !HEX128.test(r.signature))
    fail("invalid_receipt", "signature must be 128 lowercase hex");
}

const checkKeypair = keypair => {
  if (!isPlainObject(keypair)) fail("invalid_key", "keypair must be an object");
  if (typeof keypair.seedHex !== "string" || !HEX64.test(keypair.seedHex))
    fail("invalid_key", "keypair.seedHex must be 64 lowercase hex");
  if (typeof keypair.pubkeyHex !== "string" || !HEX64.test(keypair.pubkeyHex))
    fail("invalid_key", "keypair.pubkeyHex must be 64 lowercase hex");
  // The seed must actually be this keypair's seed — a mismatched pair fails
  // here, not at some later verifier.
  const derived = Buffer.from(createPublicKey(importSeed(keypair.seedHex))
    .export({ format: "jwk" }).x, "base64url").toString("hex");
  if (derived !== keypair.pubkeyHex.toLowerCase())
    fail("invalid_key", "keypair.seedHex does not derive keypair.pubkeyHex");
  return derived;
};

// --- issue --------------------------------------------------------------------
//
// Issue a signed vetting receipt. Throws ReceiptError on invalid input.
// keypair: { seedHex, pubkeyHex } as returned by generateReceiptKeyPair().
// now: reference time (ms) for the emit-time sanity verification; pass an
// explicit value for deterministic emits (tests, backfills).
export function issueVettingReceipt({ trialTaskId, demigodReqId, candidateId, scope,
  rubricScores, verdict, evaluator, issuedAt = null, receiptId = null, now = null }, keypair) {
  const pubkeyHex = checkKeypair(keypair);
  if (!isPlainObject(scope)) fail("invalid_input", "scope must be an object");
  if (!isPlainObject(evaluator)) fail("invalid_input", "evaluator must be an object");
  const body = {
    receiptType: RECEIPT_TYPE_VETTING,
    receiptId: receiptId ?? `vetting-receipt:${randomBytes(16).toString("hex")}`,
    trialTaskId,
    demigodReqId,
    candidateId,
    scope: { hoursMax: String(scope.hoursMax), deliverableShape: scope.deliverableShape },
    rubricScores: (rubricScores ?? []).map(s => ({ criterion: s.criterion, scoreBps: String(s.scoreBps) })),
    verdict,
    evaluator: { kind: evaluator.kind, id: evaluator.id },
    issuedAt: issuedAt ?? new Date().toISOString(),
  };
  // Shape first (without signature), then sign the exact canonical bytes.
  validateVettingShape({ ...body, signature: "0".repeat(128) });
  const signature = signBytes(canonicalJson(body), keypair.seedHex);
  const receipt = Object.freeze({ ...body,
    scope: Object.freeze({ ...body.scope }),
    rubricScores: Object.freeze(body.rubricScores.map(s => Object.freeze({ ...s }))),
    evaluator: Object.freeze({ ...body.evaluator }),
    signature });
  // Sanity: the emitted receipt verifies against its own issuer key, using
  // the caller's reference time when provided.
  const check = verifyVettingReceipt(receipt, { expectedPubkey: pubkeyHex, now });
  if (!check.ok) fail("emit_failed", `emitted receipt does not verify: ${check.reason}`);
  return receipt;
}

// --- verify -------------------------------------------------------------------
//
// Verify a vetting receipt. Accepts a receipt object or its JSON text (text
// is parsed strictly — duplicate keys rejected). Never throws for an
// invalid receipt: returns { ok: false, reason }.
//
// MUST-check contract:
//   - freshness window: issuedAt must be within maxAgeMs (default 7d) and
//     not beyond the clock-skew window (default 5min).
//   - fail-closed identity binding: verification requires the room's
//     published key (expectedPubkey) — without it the receipt is refused,
//     since a signature under an unknown key proves someone signed this,
//     not who; the receipt's candidateId must be non-empty (shape) and, when
//     expectedCandidateId / expectedTrialTaskId are given, must match.
//   - replay protection: caller passes a Set of seen receiptIds; verified
//     ids are added, repeats are rejected.
export function verifyVettingReceipt(receipt, pubkeyOrOptions = {}) {
  const invalid = reason => ({ ok: false, reason });
  let expectedPubkey, seen = null, now = null, maxAgeMs = DEFAULT_VETTING_MAX_AGE_MS,
    clockSkewMs = DEFAULT_CLOCK_SKEW_MS, expectedCandidateId = null, expectedTrialTaskId = null;
  if (typeof pubkeyOrOptions === "string") {
    expectedPubkey = pubkeyOrOptions;
  } else if (isPlainObject(pubkeyOrOptions)) {
    ({ expectedPubkey = null, seen = null, now = null, maxAgeMs = DEFAULT_VETTING_MAX_AGE_MS,
      clockSkewMs = DEFAULT_CLOCK_SKEW_MS, expectedCandidateId = null,
      expectedTrialTaskId = null } = pubkeyOrOptions);
  } else {
    return invalid("invalid_input: second argument must be a pubkey hex string or an options object");
  }
  let r;
  try {
    r = typeof receipt === "string" ? parseStrict(receipt) : receipt;
    if (!isPlainObject(r)) return invalid("invalid_receipt: receipt must be an object");
    validateVettingShape(r);
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
  // Fail-closed: the receipt carries no signer key, so without the caller's
  // trusted room key there is nothing to verify against.
  if (typeof expectedPubkey !== "string" || !HEX64.test(expectedPubkey))
    return invalid("untrusted_issuer: no trusted room key — a valid signature under an unknown key proves someone signed this, not who");
  const { signature, ...unsigned } = r;
  let bytes;
  try {
    bytes = canonicalJson(unsigned);
  } catch (error) {
    return invalid(`number_ban: ${error.message}`);
  }
  if (!verifyBytes(bytes, signature, expectedPubkey.toLowerCase()))
    return invalid("bad_signature: Ed25519 verification failed");
  if (expectedCandidateId !== null && expectedCandidateId !== undefined
    && r.candidateId !== expectedCandidateId)
    return invalid("context_mismatch: receipt is not bound to the expected candidate");
  if (expectedTrialTaskId !== null && expectedTrialTaskId !== undefined
    && r.trialTaskId !== expectedTrialTaskId)
    return invalid("context_mismatch: receipt is not bound to the expected trial task");
  if (seen instanceof Set) seen.add(r.receiptId);
  return { ok: true, receiptId: r.receiptId, receiptType: r.receiptType, verdict: r.verdict,
    candidateId: r.candidateId, trialTaskId: r.trialTaskId, demigodReqId: r.demigodReqId };
}

// --- Demigod consumer schema ----------------------------------------------------
//
// JSON-schema-ish descriptor Demigod's side uses to validate incoming
// receipts before signature verification. The description documents the
// handoff: Demigod fetches GET /trial-tasks/:id/receipt, verifies the
// signature against the room's published key, checks identity binding, and
// enforces receiptId uniqueness. Record-only: no money moves.
const CONSUMER_HANDOFF =
  "Demigod fetches GET /trial-tasks/:id/receipt, verifies the Ed25519 " +
  "signature over the canonical JSON body against the room's published key, " +
  "checks identity binding (receipt.candidateId is the room identity that did " +
  "the work; match it against the expected candidate), enforces the 7-day " +
  "freshness window, and enforces receiptId uniqueness for replay protection. " +
  "Record-only vetting evidence — no money moves.";

export function vettingReceiptConsumerSchema() {
  const str = (minLength, maxLength, pattern) => {
    const s = { type: "string", minLength, maxLength };
    if (pattern !== undefined) s.pattern = pattern;
    return s;
  };
  return Object.freeze({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://room.trydemigod.com/schemas/vetting-receipt/1",
    title: "Demigod vetting receipt",
    description: CONSUMER_HANDOFF,
    type: "object",
    additionalProperties: false,
    required: ["receiptType", "receiptId", "trialTaskId", "demigodReqId", "candidateId",
      "scope", "rubricScores", "verdict", "evaluator", "issuedAt", "signature"],
    properties: Object.freeze({
      receiptType: Object.freeze({ const: RECEIPT_TYPE_VETTING }),
      receiptId: Object.freeze(str(48, 48, "^vetting-receipt:[0-9a-f]{32}$")),
      trialTaskId: Object.freeze(str(1, 128)),
      demigodReqId: Object.freeze(str(1, 128)),
      candidateId: Object.freeze(str(1, 256)),
      scope: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["hoursMax", "deliverableShape"],
        properties: Object.freeze({
          hoursMax: Object.freeze(str(1, 20, "^(0|[1-9][0-9]*)$")),
          deliverableShape: Object.freeze(str(1, 2000)),
        }),
      }),
      rubricScores: Object.freeze({
        type: "array",
        minItems: 1,
        items: Object.freeze({
          type: "object",
          additionalProperties: false,
          required: ["criterion", "scoreBps"],
          properties: Object.freeze({
            criterion: Object.freeze(str(1, 128)),
            // Basis points 0..10000 (10000 = 100%), always a string.
            scoreBps: Object.freeze(str(1, 5, "^[0-9]{1,5}$")),
          }),
        }),
      }),
      verdict: Object.freeze({ enum: ["pass", "fail"] }),
      evaluator: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["kind", "id"],
        properties: Object.freeze({
          kind: Object.freeze({ enum: ["human", "agent", "rule"] }),
          id: Object.freeze(str(1, 256)),
        }),
      }),
      issuedAt: Object.freeze(str(20, 24, "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z$")),
      signature: Object.freeze(str(128, 128, "^[0-9a-f]{128}$")),
    }),
  });
}

export { generateReceiptKeyPair, ReceiptError };
