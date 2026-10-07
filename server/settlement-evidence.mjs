// Settlement evidence credential (settlement-evidence/1).
//
// Binds three things a stranger needs to check a settlement into one
// operator-signed bundle:
//   1. the movement chain — room-bounty-receipt/1 receipts, funding first,
//      each independently verifiable;
//   2. the evaluator's verdict — signed by the EVALUATOR's own key (not the
//      operator's), with per-criterion citations pinned to a rubric hash;
//   3. the recorded settlement — kind, worker/refund legs, reason.
//
// A third party verifies the whole bundle offline: this spec, the operator's
// public key (out-of-band binding), and the evaluator's public key
// (out-of-band; lane key registry is a follow-up). No trust in the room
// server is required at any step.
//
// Credits-only boundary (inherited from server/bounty-receipts.mjs):
// bundles name credit lots (milli-credit decimal strings). They NEVER
// reference assets, chains, transactions, or cash value.
//
// Pure: node:crypto only (via bounty-receipts.mjs helpers), no I/O, no
// dependencies. Additive: zero changes to existing modules.
import { randomBytes } from "node:crypto";
import {
  canonicalJson,
  parseStrict,
  signBytes,
  verifyBytes,
  verifyBountyReceipt,
  validIssuedAt,
} from "./bounty-receipts.mjs";

export const SETTLEMENT_EVIDENCE_VERSION = "settlement-evidence/1";

// Source of truth: server/bounty-escrow.mjs SETTLEMENT_KINDS. Kept local so
// this verifier stays pure (no escrow/store import); the vocabulary is
// frozen — a new kind is a spec bump, never a silent addition.
const SETTLEMENT_KINDS = new Set(["verified-complete", "failed", "unverified", "partial"]);

// Terminal receipt type -> legal settlement kinds. The recorded settlement
// must agree with the movement that closed the chain.
const TERMINAL_KINDS = {
  "payout-released": new Set(["verified-complete"]),
  "refund-issued": new Set(["failed", "unverified"]),
  "attributed": new Set(["verified-complete"]),
};

const EVALUATOR_KINDS = new Set(["human", "agent", "rule"]);
const DECISIONS = new Set(["approved", "rejected"]);
const CITATION_VERDICTS = new Set(["pass", "fail"]);
const INDEPENDENCE = new Set(["independent", "self"]);

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const EVIDENCE_ID = /^settlement-evidence:[0-9a-f]{32}$/;
const DECIMAL0 = /^(0|[1-9][0-9]*)$/; // milli-credit amounts, zero allowed on legs

class EvidenceError extends Error {
  constructor(code, message) { super(message); this.name = "EvidenceError"; this.code = code; }
}
const fail = (code, message) => { throw new EvidenceError(code, message); };
const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

// Number ban (settlement-evidence/1 inherits room-bounty-receipt/1 §4): a
// JSON number has multiple legal serializations, so any number inside the
// signed portion is rejected before anything else.
const assertNoNumbers = (value, path) => {
  if (typeof value === "number" || typeof value === "bigint")
    fail("number_ban", `JSON number forbidden in signed body at ${path}`);
  if (Array.isArray(value)) value.forEach((v, n) => assertNoNumbers(v, `${path}[${n}]`));
  else if (isPlainObject(value))
    for (const k of Object.keys(value)) assertNoNumbers(value[k], `${path}.${k}`);
};

const nonEmpty = (v, max, label) => {
  if (typeof v !== "string" || v.length < 1 || v.length > max)
    fail("invalid_evidence", `${label} must be a 1..${max}-character string`);
};

const exactKeys = (obj, keys, label) => {
  const got = Object.keys(obj).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((k, n) => k !== want[n]))
    fail("invalid_evidence", `${label} must have exactly keys [${want.join(", ")}]`);
};

const checkHex = (v, re, label) => {
  if (typeof v !== "string" || !re.test(v))
    fail("invalid_evidence", `${label} must match ${re}`);
};

const checkTime = (v, label) => {
  if (!validIssuedAt(v)) fail("invalid_evidence", `${label} must be a real RFC 3339 UTC timestamp`);
};

// --- verdict shape ------------------------------------------------------------
function validateVerdict(v) {
  if (!isPlainObject(v)) fail("invalid_evidence", "verdict must be an object");
  assertNoNumbers(v, "verdict");
  exactKeys(v, ["evaluator", "decision", "citations", "rubricVersion", "rubricHash",
    "deliverableSha256", "attestedAt", "independence", "signature"], "verdict");
  const e = v.evaluator;
  if (!isPlainObject(e)) fail("invalid_evidence", "verdict.evaluator must be an object");
  exactKeys(e, ["kind", "id", "pubkey"], "verdict.evaluator");
  if (!EVALUATOR_KINDS.has(e.kind)) fail("invalid_evidence", "verdict.evaluator.kind must be human|agent|rule");
  nonEmpty(e.id, 256, "verdict.evaluator.id");
  checkHex(e.pubkey, HEX64, "verdict.evaluator.pubkey");
  if (!DECISIONS.has(v.decision)) fail("invalid_evidence", 'verdict.decision must be "approved" or "rejected"');
  if (!Array.isArray(v.citations) || v.citations.length === 0)
    fail("invalid_evidence", "verdict.citations must be a non-empty array");
  const seenCriteria = new Set();
  for (const [n, c] of v.citations.entries()) {
    if (!isPlainObject(c)) fail("invalid_evidence", `verdict.citations[${n}] must be an object`);
    exactKeys(c, ["criterionId", "verdict"], `verdict.citations[${n}]`);
    nonEmpty(c.criterionId, 128, `verdict.citations[${n}].criterionId`);
    if (!CITATION_VERDICTS.has(c.verdict))
      fail("invalid_evidence", `verdict.citations[${n}].verdict must be "pass" or "fail"`);
    if (seenCriteria.has(c.criterionId))
      fail("invalid_evidence", `verdict.citations has duplicate criterionId ${JSON.stringify(c.criterionId)}`);
    seenCriteria.add(c.criterionId);
  }
  // Decision/citation coherence: the verdict must agree with its own evidence.
  const allPass = v.citations.every(c => c.verdict === "pass");
  if (v.decision === "approved" && !allPass)
    fail("invalid_evidence", "verdict.incoherent: decision approved but a citation failed");
  if (v.decision === "rejected" && allPass)
    fail("invalid_evidence", "verdict.incoherent: decision rejected but every citation passed");
  nonEmpty(v.rubricVersion, 64, "verdict.rubricVersion");
  checkHex(v.rubricHash, HEX64, "verdict.rubricHash");
  if (v.deliverableSha256 !== null) checkHex(v.deliverableSha256, HEX64, "verdict.deliverableSha256");
  checkTime(v.attestedAt, "verdict.attestedAt");
  if (!INDEPENDENCE.has(v.independence))
    fail("invalid_evidence", 'verdict.independence must be "independent" or "self"');
  checkHex(v.signature, HEX128, "verdict.signature");
}

// --- bundle shape ---------------------------------------------------------------
function validateEvidenceShape(ev) {
  if (!isPlainObject(ev)) fail("invalid_evidence", "bundle must be an object");
  // Number ban first — before signature verification.
  assertNoNumbers(ev, "bundle");
  exactKeys(ev, ["schemaVersion", "evidenceId", "roomId", "bountyId", "issuedAt",
    "receipts", "verdict", "settlement", "issuer", "signature"], "bundle");
  if (ev.schemaVersion !== SETTLEMENT_EVIDENCE_VERSION)
    fail("invalid_evidence", `schemaVersion must be exactly ${SETTLEMENT_EVIDENCE_VERSION}`);
  checkHex(ev.evidenceId, EVIDENCE_ID, "evidenceId");
  nonEmpty(ev.roomId, 128, "roomId");
  nonEmpty(ev.bountyId, 64, "bountyId");
  checkTime(ev.issuedAt, "issuedAt");
  if (!Array.isArray(ev.receipts) || ev.receipts.length === 0)
    fail("invalid_evidence", "receipts must be a non-empty array");
  validateVerdict(ev.verdict);
  if (Date.parse(ev.verdict.attestedAt) > Date.parse(ev.issuedAt))
    fail("invalid_evidence", "verdict.attestedAt must not be after bundle issuedAt");
  const s = ev.settlement;
  if (!isPlainObject(s)) fail("invalid_evidence", "settlement must be an object");
  exactKeys(s, ["kind", "workerMillis", "refundMillis", "reason", "settledAt"], "settlement");
  if (!SETTLEMENT_KINDS.has(s.kind))
    fail("invalid_evidence", `settlement.kind must be one of ${[...SETTLEMENT_KINDS].join("|")}`);
  for (const k of ["workerMillis", "refundMillis"])
    if (typeof s[k] !== "string" || !DECIMAL0.test(s[k]))
      fail("invalid_evidence", `settlement.${k} must be a decimal string of milli-credits`);
  nonEmpty(s.reason, 500, "settlement.reason");
  checkTime(s.settledAt, "settlement.settledAt");
  if (Date.parse(s.settledAt) > Date.parse(ev.issuedAt))
    fail("invalid_evidence", "settlement.settledAt must not be after bundle issuedAt");
  const iss = ev.issuer;
  if (!isPlainObject(iss)) fail("invalid_evidence", "issuer must be an object");
  exactKeys(iss, ["pubkey", "role", "ref"], "issuer");
  checkHex(iss.pubkey, HEX64, "issuer.pubkey");
  if (iss.role !== "escrow-keeper") fail("invalid_evidence", 'issuer.role must be "escrow-keeper"');
  nonEmpty(iss.ref, 256, "issuer.ref");
  checkHex(ev.signature, HEX128, "signature");
  // Chain head: the first receipt is the funding movement.
  if (ev.receipts[0]?.type !== "escrow-locked")
    fail("invalid_evidence", "receipts[0].type must be escrow-locked (the funding movement)");
  for (const [n, r] of ev.receipts.entries()) {
    if (!isPlainObject(r)) fail("invalid_evidence", `receipts[${n}] must be an object`);
    if (r.roomId !== ev.roomId || r.bountyId !== ev.bountyId)
      fail("invalid_evidence", `receipts[${n}] roomId/bountyId must match the bundle`);
  }
  // Terminal movement <-> settlement kind consistency, with amount linkage.
  const terminal = ev.receipts[ev.receipts.length - 1];
  const legal = TERMINAL_KINDS[terminal.type];
  if (!legal || !legal.has(s.kind))
    fail("invalid_evidence",
      `settlement.inconsistent: terminal receipt type ${JSON.stringify(terminal.type)} cannot close a ${JSON.stringify(s.kind)} settlement`);
  if (terminal.type === "payout-released") {
    if (s.workerMillis !== terminal.payload.netAmountMillis)
      fail("invalid_evidence", "settlement.workerMillis must equal the payout netAmountMillis");
  } else if (terminal.type === "refund-issued") {
    if (s.workerMillis !== "0")
      fail("invalid_evidence", "settlement.workerMillis must be \"0\" for a refund settlement");
    if (s.refundMillis !== terminal.amountMillis)
      fail("invalid_evidence", "settlement.refundMillis must equal the refund amountMillis");
  } else if (s.workerMillis !== terminal.amountMillis) {
    fail("invalid_evidence", "settlement.workerMillis must equal the terminal receipt amountMillis");
  }
}

// --- issue ------------------------------------------------------------------------

// The evaluator signs their verdict with their own key. The room never signs
// for the evaluator.
export function signVerdict(fields, evaluatorSeedHex) {
  if (!isPlainObject(fields)) fail("invalid_input", "verdict fields must be an object");
  if (typeof evaluatorSeedHex !== "string" || !HEX64.test(evaluatorSeedHex))
    fail("invalid_key", "evaluator seed must be 64 lowercase hex characters");
  validateVerdict({ ...fields, signature: "0".repeat(128) }); // shape first, signature last
  const signature = signBytes(canonicalJson(fields), evaluatorSeedHex);
  return Object.freeze({ ...fields,
    evaluator: Object.freeze({ ...fields.evaluator }),
    citations: Object.freeze(fields.citations.map(c => Object.freeze({ ...c }))),
    signature });
}

export function issueSettlementEvidence({ receipts, verdict, settlement, issuer, issuedAt, seedHex }) {
  if (!Array.isArray(receipts) || receipts.length === 0)
    fail("invalid_input", "receipts must be a non-empty array");
  if (typeof seedHex !== "string" || !HEX64.test(seedHex))
    fail("invalid_key", "operator seed must be 64 lowercase hex characters");
  checkTime(issuedAt, "issuedAt");
  const unsigned = {
    schemaVersion: SETTLEMENT_EVIDENCE_VERSION,
    evidenceId: `settlement-evidence:${randomBytes(16).toString("hex")}`,
    roomId: receipts[0].roomId,
    bountyId: receipts[0].bountyId,
    issuedAt,
    receipts,
    verdict,
    settlement,
    issuer,
  };
  validateEvidenceShape({ ...unsigned, signature: "0".repeat(128) }); // shape first, signature last
  const signature = signBytes(canonicalJson(unsigned), seedHex);
  return Object.freeze({ ...unsigned,
    receipts: Object.freeze([...unsigned.receipts]),
    verdict: Object.freeze({ ...unsigned.verdict }),
    settlement: Object.freeze({ ...unsigned.settlement }),
    issuer: Object.freeze({ ...unsigned.issuer }),
    signature });
}

// --- verify --------------------------------------------------------------------------
// Verify a settlement evidence bundle as a third party. Accepts a bundle
// object or its JSON text (text is parsed strictly — duplicate keys
// rejected). Never throws for an invalid bundle: returns { ok: false,
// reason }. Options:
//   expectedOperatorKey — the operator key this context trusts (out-of-band
//     binding; a valid signature under any other key is "someone signed
//     this", not authentication).
//   expectedEvaluatorKey — same fail-closed binding for the evaluator's key.
//   seen — a Set of evidence/receipt ids for replay protection; verified ids
//     are added.
//   journal — { entryHash(entryId) } to check receipt entry linkage.
export function verifySettlementEvidence(bundle, { expectedOperatorKey = null,
  expectedEvaluatorKey = null, seen = null, journal = null } = {}) {
  const invalid = reason => ({ ok: false, reason });
  let ev;
  try {
    ev = typeof bundle === "string" ? parseStrict(bundle) : bundle;
    validateEvidenceShape(ev);
  } catch (error) {
    return invalid(error instanceof EvidenceError ? `${error.code}: ${error.message}` : `invalid_evidence: ${error.message}`);
  }
  if (seen !== null && seen !== undefined) {
    if (!(seen instanceof Set)) return invalid("invalid_input: seen must be a Set");
    if (seen.has(ev.evidenceId)) return invalid("duplicate_evidence: evidenceId already verified");
  }
  // Operator signature over the canonical bundle bytes.
  const unsigned = { ...ev };
  delete unsigned.signature;
  let bytes;
  try {
    bytes = canonicalJson(unsigned);
  } catch (error) {
    return invalid(`number_ban: ${error.message}`);
  }
  if (!verifyBytes(bytes, ev.signature, ev.issuer.pubkey))
    return invalid("bad_signature: Ed25519 operator verification failed");
  if (expectedOperatorKey !== null && expectedOperatorKey !== undefined) {
    if (typeof expectedOperatorKey !== "string" || ev.issuer.pubkey !== expectedOperatorKey.toLowerCase())
      return invalid("unexpected_signer: valid signature, but not from the expected operator key");
  }
  // Evaluator signature over the canonical verdict bytes — the judge speaks
  // for themselves; the room cannot invent or edit a verdict.
  const verdictUnsigned = { ...ev.verdict };
  delete verdictUnsigned.signature;
  let verdictBytes;
  try {
    verdictBytes = canonicalJson(verdictUnsigned);
  } catch (error) {
    return invalid(`number_ban: ${error.message}`);
  }
  if (!verifyBytes(verdictBytes, ev.verdict.signature, ev.verdict.evaluator.pubkey))
    return invalid("bad_verdict_signature: Ed25519 evaluator verification failed");
  if (expectedEvaluatorKey !== null && expectedEvaluatorKey !== undefined) {
    if (typeof expectedEvaluatorKey !== "string"
      || ev.verdict.evaluator.pubkey !== expectedEvaluatorKey.toLowerCase())
      return invalid("unexpected_evaluator: valid verdict signature, but not from the expected evaluator key");
  }
  // Every wrapped receipt verifies (shape + signature + replay + journal),
  // bound to the bundle's operator key.
  const receiptIds = [];
  for (const [n, r] of ev.receipts.entries()) {
    const v = verifyBountyReceipt(r, { expectedPubkey: ev.issuer.pubkey, seen, journal });
    if (!v.ok) return invalid(`receipt[${n}]: ${v.reason}`);
    receiptIds.push(v.receiptId);
  }
  if (seen instanceof Set) {
    seen.add(ev.evidenceId);
    for (const id of receiptIds) seen.add(id);
  }
  return { ok: true, evidenceId: ev.evidenceId, receiptIds,
    decision: ev.verdict.decision, settlementKind: ev.settlement.kind,
    independence: ev.verdict.independence,
    signer: ev.issuer.pubkey, evaluator: ev.verdict.evaluator.pubkey };
}

export { EvidenceError };
