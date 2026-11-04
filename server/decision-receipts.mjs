// Signed pre-execution decision receipts (Option B).
//
// The bounty outcome receipts in server/bounty-receipts.mjs attest, after
// the fact, that a movement happened. That alone cannot distinguish a
// genuine escrow movement from a fabricated agent self-report: anyone can
// shape a receipt, and only the operator key makes it evidence. Option B
// moves the signature UPSTREAM: before a value-moving transition executes,
// the escrow keeper signs a DECISION receipt (room-decision-receipt/1)
// authorising exactly one movement — its act (the outcome receipt type),
// its target (roomId, bountyId, lotId), its disposition, and its amount.
// The outcome receipt issued after execution carries the binding pair
// (payload.decisionId + payload.decisionDigest), and
// verifyDecisionOutcomePair() checks the whole chain offline:
//
//   decision shape + signature valid, under the EXPECTED operator key
//   (executor-side signing only — a decision signed by an agent's own key
//   fails the expected-key check, exactly like a self-signed outcome);
//   outcome passes verifyBountyReceipt (composed, journal-checked when a
//   journal is supplied);
//   binding: the outcome's decisionId equals the decision's id and its
//   decisionDigest equals sha256 of the decision's canonical unsigned
//   bytes, so neither half can be swapped for another signed artefact;
//   agreement: outcome type / roomId / bountyId / lotId / amountMillis
//   equal the decision's act / target / amountMillis;
//   single-use: a decisionId already in the caller's `consumed` set fails
//   with decision_consumed; a successful verification consumes it.
//
// LIMITATIONS (stated, not implied away): the consumed set is an
// in-process Set supplied by the caller — there is NO durable consumed
// record yet (the persistence leg is deferred with the receipt-storage
// schema change), so single-use holds within one process lifetime and one
// verifier instance. There is no key history or rotation: verification
// pins expectedPubkey out-of-band, the same trust model verifyBountyReceipt
// already documents. Production stays unarmed until the operator supplies
// the signer seed via ROOM_RECEIPT_SIGNER_SEED (see
// receiptSignerFromEnv in bounty-receipts.mjs).
//
// Credits-only, like the outcome receipts: decisions name credit lots and
// milli-credit amounts as decimal strings, never assets or cash. The
// canonical encoding, number ban, and Ed25519 primitives are shared with
// bounty-receipts.mjs — one codec, two artefacts.
//
// Pure: node:crypto only, no I/O, no dependencies.
import { createHash, randomBytes } from "node:crypto";
import {
  RECEIPT_TYPES,
  ReceiptError,
  canonicalJson,
  parseStrict,
  signBytes,
  validIssuedAt,
  verifyBountyReceipt,
  verifyBytes,
} from "./bounty-receipts.mjs";

export const DECISION_SCHEMA_VERSION = "room-decision-receipt/1";

const fail = (code, message) => { throw new ReceiptError(code, message); };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const DECIMAL = /^[1-9][0-9]*$/; // positive milli-credit amounts, no leading zeros
const DECISION_ID = /^room-decision:[0-9a-f]{32}$/;
const LOT_ID = /^lot_[0-9a-f]{16}$/;
const ACTOR_KINDS = new Set(["human", "agent", "rule"]);

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
    fail("invalid_decision", `${label} must be a 1..${max}-character string`);
};

const exactKeys = (obj, keys, label) => {
  const got = Object.keys(obj).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((k, n) => k !== want[n]))
    fail("invalid_decision", `${label} must have exactly keys [${want.join(", ")}]`);
};

function validateDecisionShape(d) {
  if (!isPlainObject(d)) fail("invalid_decision", "decision receipt must be an object");
  // Number ban first, as with outcome receipts: a JSON number inside the
  // signed portion is rejected before anything else.
  assertNoNumbers(d, "decision");
  exactKeys(d, ["schemaVersion", "decisionId", "act", "target", "disposition", "amountMillis",
    "actor", "issuer", "decidedAt", "nonce", "signature"], "decision");
  if (d.schemaVersion !== DECISION_SCHEMA_VERSION)
    fail("invalid_decision", `schemaVersion must be exactly ${DECISION_SCHEMA_VERSION}`);
  if (typeof d.decisionId !== "string" || !DECISION_ID.test(d.decisionId))
    fail("invalid_decision", "decisionId must be room-decision:<32 hex>");
  if (!Object.hasOwn(RECEIPT_TYPES, d.act))
    fail("invalid_decision", `act must be a bounty receipt type, got ${JSON.stringify(d.act)}`);
  if (!isPlainObject(d.target)) fail("invalid_decision", "target must be an object");
  exactKeys(d.target, ["roomId", "bountyId", "lotId"], "target");
  if (typeof d.target.roomId !== "string" || d.target.roomId.length === 0 || d.target.roomId.length > 128)
    fail("invalid_decision", "target.roomId must be a non-empty string (max 128 chars)");
  nonEmpty(d.target.bountyId, 64, "target.bountyId");
  if (typeof d.target.lotId !== "string" || !LOT_ID.test(d.target.lotId))
    fail("invalid_decision", "target.lotId must be lot_<16 hex>");
  nonEmpty(d.disposition, 512, "disposition");
  if (typeof d.amountMillis !== "string" || !DECIMAL.test(d.amountMillis))
    fail("invalid_decision", "amountMillis must be a positive decimal string");
  if (!isPlainObject(d.actor)) fail("invalid_decision", "actor must be an object");
  exactKeys(d.actor, ["kind", "id"], "actor");
  if (!ACTOR_KINDS.has(d.actor.kind)) fail("invalid_decision", "actor.kind must be human|agent|rule");
  nonEmpty(d.actor.id, 256, "actor.id");
  if (!isPlainObject(d.issuer)) fail("invalid_decision", "issuer must be an object");
  exactKeys(d.issuer, ["pubkey", "role", "ref"], "issuer");
  if (!HEX64.test(d.issuer.pubkey)) fail("invalid_decision", "issuer.pubkey must be 64 lowercase hex");
  if (d.issuer.role !== "escrow-keeper") fail("invalid_decision", 'issuer.role must be "escrow-keeper"');
  nonEmpty(d.issuer.ref, 256, "issuer.ref");
  if (!validIssuedAt(d.decidedAt)) fail("invalid_decision", "decidedAt must be a real RFC 3339 UTC timestamp");
  if (typeof d.nonce !== "string" || !HEX32.test(d.nonce))
    fail("invalid_decision", "nonce must be 32 lowercase hex characters");
  if (typeof d.signature !== "string" || !HEX128.test(d.signature))
    fail("invalid_decision", "signature must be 128 lowercase hex");
}

// sha256 hex of the decision's canonical unsigned bytes — the digest an
// outcome receipt binds itself to via payload.decisionDigest. Accepts a
// signed or unsigned body; the signature field never takes part.
export function decisionDigest(body) {
  if (!isPlainObject(body)) fail("invalid_input", "decisionDigest requires a decision body object");
  const unsigned = { ...body };
  delete unsigned.signature;
  return createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
}

// Issue a signed decision receipt. Called by BountyEscrow BEFORE the
// journal appends of the movement it authorises — the signature must
// precede execution, or the artefact proves nothing about authorisation.
export function issueDecisionReceipt({ act, target, disposition, amountMillis, actor, issuer, decidedAt, seedHex }) {
  if (!Object.hasOwn(RECEIPT_TYPES, act))
    fail("invalid_input", `unknown act ${JSON.stringify(act)} — a decision authorises one bounty receipt type`);
  if (typeof seedHex !== "string" || !HEX64.test(seedHex))
    fail("invalid_key", "seed must be 64 lowercase hex characters (32-byte Ed25519 seed)");
  const unsigned = {
    schemaVersion: DECISION_SCHEMA_VERSION,
    decisionId: `room-decision:${randomBytes(16).toString("hex")}`,
    act,
    target,
    disposition,
    amountMillis: String(amountMillis),
    actor, issuer,
    decidedAt,
    nonce: randomBytes(16).toString("hex"),
  };
  validateDecisionShape({ ...unsigned, signature: "0".repeat(128) }); // shape first, signature last
  const signature = signBytes(canonicalJson(unsigned), seedHex);
  return Object.freeze({ ...unsigned,
    target: Object.freeze({ ...unsigned.target }),
    actor: Object.freeze({ ...unsigned.actor }),
    issuer: Object.freeze({ ...unsigned.issuer }),
    signature });
}

// Verify a decision receipt on its own. Never throws for an invalid
// decision: returns { ok: false, reason }. With expectedPubkey, the issuer
// must be exactly that key — executor-side authority only.
export function verifyDecisionReceipt(decision, { expectedPubkey = null } = {}) {
  const invalid = reason => ({ ok: false, reason });
  let d;
  try {
    d = typeof decision === "string" ? parseStrict(decision) : decision;
    validateDecisionShape(d);
  } catch (error) {
    return invalid(error instanceof ReceiptError ? `${error.code}: ${error.message}` : `invalid_decision: ${error.message}`);
  }
  const unsigned = { ...d };
  delete unsigned.signature;
  let bytes;
  try {
    bytes = canonicalJson(unsigned);
  } catch (error) {
    return invalid(`number_ban: ${error.message}`);
  }
  if (!verifyBytes(bytes, d.signature, d.issuer.pubkey))
    return invalid("bad_signature: Ed25519 verification failed");
  if (expectedPubkey !== null && expectedPubkey !== undefined) {
    if (typeof expectedPubkey !== "string" || d.issuer.pubkey !== expectedPubkey.toLowerCase())
      return invalid("unexpected_signer: valid signature, but not from the expected operator key");
  }
  return { ok: true, decisionId: d.decisionId, act: d.act, signer: d.issuer.pubkey };
}

// Verify a decision + outcome pair. Never throws for an invalid pair:
// returns { ok: false, reason }. Options:
//   expectedPubkey — the operator key this context trusts; BOTH the
//     decision and the outcome must be issued under it.
//   consumed — a Set of decisionIds for single-use enforcement; an
//     already-consumed decision fails with decision_consumed, and a
//     successful verification adds the id. Per-process only (see header).
//   journal — passed through to verifyBountyReceipt so the outcome's
//     entry linkage is checked against the ledger.
export function verifyDecisionOutcomePair(decision, outcome, { expectedPubkey = null, consumed = null, journal = null } = {}) {
  const invalid = reason => ({ ok: false, reason });
  let d, o;
  try {
    d = typeof decision === "string" ? parseStrict(decision) : decision;
    validateDecisionShape(d);
    o = typeof outcome === "string" ? parseStrict(outcome) : outcome;
  } catch (error) {
    return invalid(error instanceof ReceiptError ? `${error.code}: ${error.message}` : `invalid_decision: ${error.message}`);
  }
  if (consumed !== null && consumed !== undefined && !(consumed instanceof Set))
    return invalid("invalid_input: consumed must be a Set");
  if (consumed instanceof Set && consumed.has(d.decisionId))
    return invalid("decision_consumed: decisionId already consumed by an earlier verification");
  const dv = verifyDecisionReceipt(d, { expectedPubkey });
  if (!dv.ok) return dv;
  const ov = verifyBountyReceipt(o, { expectedPubkey, journal });
  if (!ov.ok) return invalid(ov.reason);
  // Binding: the outcome must name THIS decision, by id and by digest of
  // its canonical unsigned bytes.
  const payload = isPlainObject(o) ? o.payload : null;
  if (!isPlainObject(payload) || typeof payload.decisionId !== "string" || typeof payload.decisionDigest !== "string")
    return invalid("unbound_outcome: outcome payload carries no decisionId/decisionDigest binding");
  if (payload.decisionId !== d.decisionId)
    return invalid("decision_mismatch: outcome decisionId does not match the decision");
  if (payload.decisionDigest !== decisionDigest(d))
    return invalid("decision_mismatch: outcome decisionDigest does not match the decision body");
  // Agreement: the executed movement must be the authorised one.
  if (o.type !== d.act)
    return invalid("decision_mismatch: outcome type does not match the decision act");
  if (o.roomId !== d.target.roomId || o.bountyId !== d.target.bountyId || o.lotId !== d.target.lotId)
    return invalid("decision_mismatch: outcome target does not match the decision target");
  if (o.amountMillis !== d.amountMillis)
    return invalid("decision_mismatch: outcome amount does not match the decision amount");
  if (consumed instanceof Set) consumed.add(d.decisionId);
  return { ok: true, decisionId: d.decisionId, receiptId: o.receiptId, act: d.act, signer: d.issuer.pubkey };
}
