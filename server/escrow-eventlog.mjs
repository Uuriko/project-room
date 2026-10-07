// Escrow event log / audit ledger (lane 9, acp-build-escrow-eventlog).
//
// The complement to lane 7's escrow STATE machine (server/claim-escrow.mjs,
// PR #1787). Lane 7 owns escrow state (who may transition what, when); this
// module owns the tamper-evident SETTLEMENT TRAIL: an append-only,
// hash-chained event ledger so a stranger can verify what happened to an
// escrow without trusting the server. It moves no state, seats no
// evaluators, holds no bonds. Custody != state != audit trail.
//
// Event vocabulary (fixed):
//   escrow_created -> bond_locked -> work_submitted ->
//   verdict_committed -> verdict_revealed -> settled
//   bond_locked|work_submitted|verdict_committed -> expired -> settled
//   bond_locked -> settled                        (claimant withdraws)
// `settled` is terminal and exactly once per escrow. The verdict
// commit-reveal step is this module's own addition: lane 7's machine has no
// commit step, and the log rejects any reveal whose preimage does not match
// the recorded commitment, so an evaluator's verdict cannot be front-run or
// quietly rewritten between decision and reveal.
//
// MONEY POLICY: bond figures are abstract paper units only — "credit" or
// "dasha-paper", mirroring lane 7. The module converts nothing, touches no
// chain, no wallet, no mainnet. Real value movement needs John's explicit
// tap and stops at the design line in research_notes/acp-2026-10-07/.
//
// HONEST LIMITATION: a hash chain is tamper-EVIDENT, not tamper-PROOF. An
// attacker who rewrites the whole tail recomputes a clean chain. Detecting
// a full rewrite needs an external anchor — the recommended follow-up is
// for settlement-evidence (lane 8) to publish each escrow's settled head
// hash as a receipt tag so strangers can compare chain heads against it.
//
// Pure, dependency-free (node:crypto only), frozen outputs. All state is
// caller-owned (a Map); malformed inputs and illegal appends throw
// EventLogError.
import { createHash } from "node:crypto";

const EVENT_TYPES = Object.freeze([
  "escrow_created", "bond_locked", "work_submitted",
  "verdict_committed", "verdict_revealed", "expired", "settled",
]);
// Genesis: the prevHash of every stream's first entry.
const GENESIS_PREV_HASH = "0".repeat(64);
// Paper-only denominations. Anything else is refused at escrow_created.
const DENOMINATIONS = Object.freeze(["credit", "dasha-paper"]);
// Verdict grammar. Copied verbatim from lane 7's server/claim-escrow.mjs
// (VERDICT_CODES there is canonical); duplicated here so this module stays
// dependency-free and its PR independent of PR #1787's merge state.
const VERDICT_CODES = Object.freeze([
  "criteria-met", "criteria-unmet", "evidence-insufficient",
  "duplicate-work", "identity-mismatch", "frivolous",
]);
const OUTCOMES = Object.freeze(["approve", "reject"]);
const TERMINALS = Object.freeze(["released", "slashed", "refunded", "expired"]);
const DISPOSITIONS = Object.freeze(["claimant", "room_pool"]);
// Mechanical expiry is always attributed to the keeper (the RULE_ACTOR
// pattern, as in lane 7's machine).
const KEEPER = "escrow-keeper";
const EXPIRED_FROM = Object.freeze(["bond_locked", "work_submitted", "verdict_committed"]);
const EXPIRE_CAUSES = Object.freeze(["lease_lapsed", "evaluator_timeout"]);
const BLOB_PATTERN = /^sha256:[0-9a-f]{64}$/;
// Allowed predecessors per event type. escrow_created opens a stream;
// settled closes it.
const PREDECESSORS = {
  bond_locked: ["escrow_created"],
  work_submitted: ["bond_locked"],
  verdict_committed: ["work_submitted"],
  verdict_revealed: ["verdict_committed"],
  expired: [...EXPIRED_FROM],
  settled: ["bond_locked", "verdict_revealed", "expired"],
};

class EventLogError extends Error {
  constructor(code, message) { super(message); this.name = "EventLogError"; this.code = code; }
}
const fail = (code, message) => { throw new EventLogError(code, message); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };
const nonEmptyString = (v, what, max = 256) =>
  check(typeof v === "string" && v.length > 0 && v.length <= max, "invalid_payload", `${what} must be 1..${max} characters`);
const positiveInt = (v, what) =>
  check(Number.isSafeInteger(v) && v > 0, "invalid_payload", `${what} must be a positive integer`);
const isoOf = value => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  check(Number.isFinite(ms), "invalid_timestamp", "timestamp must be an ISO string");
  return new Date(ms).toISOString();
};
// Deterministic serialization: object keys sorted recursively, arrays keep
// order. The hash commits to exactly this byte sequence.
const canonical = value => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
};
const sha256hex = s => createHash("sha256").update(s, "utf8").digest("hex");
const entryHashOf = ({ seq, escrowId, type, actor, at, payload, prevHash }) =>
  `sha256:${sha256hex(canonical({ seq, escrowId, type, actor, at, payload, prevHash }))}`;
const freezeDeep = value => {
  if (Array.isArray(value)) { value.forEach(freezeDeep); return Object.freeze(value); }
  if (value !== null && typeof value === "object") {
    for (const k of Object.keys(value)) freezeDeep(value[k]);
    return Object.freeze(value);
  }
  return value;
};

// The verdict commitment scheme: sha256 over the canonical preimage.
// Exported so a real evaluator can compute the commitment client-side
// before submitting it (the commit step is pointless if only the log can
// compute commitments).
export function verdictCommitment({ outcome, reasonCodes, secret } = {}) {
  check(OUTCOMES.includes(outcome), "invalid_payload", "outcome must be approve or reject");
  check(Array.isArray(reasonCodes) && reasonCodes.length > 0 && reasonCodes.length <= 10,
    "invalid_payload", "reasonCodes must be a non-empty array of at most 10 codes");
  for (const code of reasonCodes)
    check(VERDICT_CODES.includes(code), "invalid_payload", `unknown verdict code "${code}"`);
  nonEmptyString(secret, "secret");
  const sorted = [...reasonCodes].sort();
  return `sha256:${sha256hex(canonical({ outcome, reasonCodes: sorted, secret }))}`;
}

export function createEscrowEventLogs({ store } = {}) {
  check(store === undefined || store instanceof Map, "invalid_payload", "store must be a Map if given");
  const logs = store ?? new Map();

  const streamOf = escrowId => {
    nonEmptyString(escrowId, "escrowId");
    check(logs.has(escrowId), "unknown_escrow", `unknown escrow "${escrowId}"`);
    return logs.get(escrowId);
  };
  const claimOf = entries => entries[0].payload; // escrow_created opens every stream

  const validateCreated = payload => {
    nonEmptyString(payload.claimId, "claimId");
    nonEmptyString(payload.claimant, "claimant", 128);
    positiveInt(payload.bondUnits, "bondUnits");
    check(DENOMINATIONS.includes(payload.denomination), "invalid_payload",
      `denomination must be one of ${DENOMINATIONS.join(", ")} — paper units only, never real funds`);
  };
  const validateBondLocked = (payload, claimant) => {
    positiveInt(payload.bondSnapshot, "bondSnapshot");
    nonEmptyString(payload.by, "by", 128);
    check(payload.by === claimant, "invalid_payload",
      `bond_locked must be signed by the claimant ${claimant}`);
  };
  const validateWorkSubmitted = (payload, claimant) => {
    nonEmptyString(payload.by, "by", 128);
    check(payload.by === claimant, "invalid_payload",
      `work_submitted must be signed by the claimant ${claimant}`);
    check(typeof payload.evidenceHash === "string" && BLOB_PATTERN.test(payload.evidenceHash),
      "invalid_payload", "evidenceHash must match sha256:<64 lowercase hex>");
  };
  const validateVerdictCommitted = payload => {
    nonEmptyString(payload.evaluator, "evaluator", 128);
    check(typeof payload.commitment === "string" && BLOB_PATTERN.test(payload.commitment),
      "invalid_payload", "commitment must match sha256:<64 lowercase hex>");
  };
  // The reveal binds to the immediately preceding commit: same evaluator,
  // and the preimage recomputes to the recorded commitment. A changed
  // verdict, a wrong secret, or a different evaluator all fail closed.
  const validateVerdictRevealed = (payload, committed) => {
    nonEmptyString(payload.evaluator, "evaluator", 128);
    check(payload.evaluator === committed.evaluator, "commitment_mismatch",
      `reveal is signed by "${payload.evaluator}" but the commitment was made by "${committed.evaluator}"`);
    const recomputed = verdictCommitment({
      outcome: payload.outcome, reasonCodes: payload.reasonCodes, secret: payload.secret });
    check(recomputed === committed.commitment, "commitment_mismatch",
      "reveal preimage does not match the recorded commitment");
  };
  const validateExpired = (payload, last, actor) => {
    check(actor === KEEPER, "invalid_actor",
      `expired is mechanical and must be attributed to "${KEEPER}"`);
    check(payload.from === last.type, "invalid_payload",
      `expired names from "${payload.from}" but the stream is at "${last.type}"`);
    check(EXPIRE_CAUSES.includes(payload.cause), "invalid_payload",
      `cause must be one of ${EXPIRE_CAUSES.join(", ")}`);
  };
  // settled carries the money direction; the log enforces it matches the
  // terminal and that the verdict on record (if any) agrees with it.
  const validateSettled = (payload, last) => {
    check(TERMINALS.includes(payload.terminal), "invalid_payload",
      `terminal must be one of ${TERMINALS.join(", ")}`);
    check(DISPOSITIONS.includes(payload.disposition), "invalid_payload",
      `disposition must be one of ${DISPOSITIONS.join(", ")}`);
    positiveInt(payload.bondSnapshot, "bondSnapshot");
    const verdict = payload.verdict ?? null;
    const cause = payload.cause ?? null;
    if (cause !== null) nonEmptyString(cause, "cause");
    if (payload.terminal === "released" || payload.terminal === "slashed") {
      check(verdict !== null && typeof verdict === "object", "invalid_payload",
        `${payload.terminal} requires the revealed verdict`);
      const want = payload.terminal === "released" ? "approve" : "reject";
      check(verdict.outcome === want, "invalid_payload",
        `${payload.terminal} requires an ${want} verdict on record`);
      check(last.type === "verdict_revealed" && last.payload.outcome === want, "invalid_payload",
        `${payload.terminal} requires a ${want} verdict_revealed immediately before settled`);
      check(payload.disposition === (payload.terminal === "released" ? "claimant" : "room_pool"),
        "invalid_payload", `${payload.terminal} must dispose the bond to ${
          payload.terminal === "released" ? "the claimant" : "the room pool"}`);
      check(cause === null, "invalid_payload", `${payload.terminal} carries a verdict, not a cause`);
    } else {
      // refunded | expired: bond returns to the claimant, no verdict.
      check(verdict === null, "invalid_payload", `${payload.terminal} carries no verdict`);
      check(payload.disposition === "claimant", "invalid_payload",
        `${payload.terminal} always refunds to the claimant`);
      if (payload.terminal === "refunded") {
        check(last.type === "expired" || (last.type === "bond_locked" && cause === "withdraw"),
          "invalid_payload", "refunded settles an expiry or a pre-submit withdraw");
      } else {
        check(last.type === "expired" && cause === last.payload.cause, "invalid_payload",
          "expired terminal settles the recorded expiry");
      }
    }
  };

  // Append one event to an escrow's stream. Returns the frozen entry.
  const append = (escrowId, { type, actor, payload, at } = {}) => {
    nonEmptyString(escrowId, "escrowId");
    check(EVENT_TYPES.includes(type), "unknown_event", `unknown event type "${type}"`);
    nonEmptyString(actor, "actor", 128);
    check(payload !== null && typeof payload === "object" && !Array.isArray(payload),
      "invalid_payload", "payload must be an object");
    const atMs = at === undefined ? Date.now() : Date.parse(isoOf(at));

    const existing = logs.get(escrowId);
    if (type === "escrow_created") {
      check(!existing, "duplicate_genesis", `escrow "${escrowId}" already has an escrow_created event`);
      validateCreated(payload);
    } else {
      check(existing, "invalid_stream", `escrow "${escrowId}" has no escrow_created event`);
      const last = existing[existing.length - 1];
      if (last.type === "settled")
        fail("settled_final", `escrow "${escrowId}" is settled — the stream is closed`);
      check((PREDECESSORS[type] ?? []).includes(last.type), "invalid_stream",
        `event "${type}" cannot follow "${last.type}"`);
      check(atMs >= Date.parse(last.at), "time_went_backwards",
        `event at ${new Date(atMs).toISOString()} precedes the stream head ${last.at}`);
      const claimant = claimOf(existing).claimant;
      if (type === "bond_locked") validateBondLocked(payload, claimant);
      else if (type === "work_submitted") validateWorkSubmitted(payload, claimant);
      else if (type === "verdict_committed") validateVerdictCommitted(payload);
      else if (type === "verdict_revealed") validateVerdictRevealed(payload, last.payload);
      else if (type === "expired") validateExpired(payload, last, actor);
      else if (type === "settled") validateSettled(payload, last);
    }

    const seq = existing ? existing.length : 0;
    const prevHash = existing ? existing[existing.length - 1].hash : GENESIS_PREV_HASH;
    const frozenPayload = freezeDeep({ ...payload });
    const entry = Object.freeze({ seq, escrowId, type, actor,
      at: new Date(atMs).toISOString(), payload: frozenPayload, prevHash,
      hash: entryHashOf({ seq, escrowId, type, actor,
        at: new Date(atMs).toISOString(), payload: frozenPayload, prevHash }) });
    const stream = existing ?? [];
    stream.push(entry);
    logs.set(escrowId, stream);
    return entry;
  };

  const entries = escrowId => Object.freeze([...streamOf(escrowId)]);
  const head = escrowId => {
    const stream = streamOf(escrowId);
    return stream[stream.length - 1];
  };

  // Recompute the chain. Returns { ok:true, entries, head } or
  // { ok:false, brokenAt, reason } naming the first broken link.
  const verify = escrowId => {
    const stream = streamOf(escrowId);
    for (let i = 0; i < stream.length; i++) {
      const e = stream[i];
      const bad = (reason) => ({ ok: false, brokenAt: i, reason: `${reason} at seq ${i}` });
      if (e.seq !== i) return bad("bad_seq");
      const wantPrev = i === 0 ? GENESIS_PREV_HASH : stream[i - 1].hash;
      if (e.prevHash !== wantPrev) return bad("bad_prev_hash");
      if (e.hash !== entryHashOf(e)) return bad("bad_hash");
      if (i > 0 && Date.parse(e.at) < Date.parse(stream[i - 1].at)) return bad("time_went_backwards");
    }
    return { ok: true, entries: stream.length, head: stream[stream.length - 1].hash };
  };
  const verifyAll = () => [...logs.keys()].map(escrowId => ({ escrowId, ...verify(escrowId) }));

  return Object.freeze({ append, entries, head, verify, verifyAll,
    size: () => logs.size, EVENT_TYPES, GENESIS_PREV_HASH, DENOMINATIONS, VERDICT_CODES });
}
export { EventLogError, EVENT_TYPES, GENESIS_PREV_HASH, DENOMINATIONS, VERDICT_CODES };
