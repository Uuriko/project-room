// Append-only decision journal for the unified approval inbox (WAVE-500
// guild 10, slice 25/50). Every pending-human decision surfaces as a card;
// every decision on a card lands here as one immutable record: who decided,
// what, when, why (plus the run receipt id when one exists).
//
// Tamper-evidence: entries form a SHA-256 hash chain — each record stores the
// hash of the previous record, so a mutated or reordered entry fails verify().
// This is a ledger convenience, not consensus or signatures; anyone holding
// the store's write path could rewrite the whole chain, and verify() cannot
// detect that. No crypto-theater claims.
//
// Store choice (documented): this slice owns its journal table via the injected
// store contract below ({ append, readAll }), NOT the approval-queue's internal
// proposals Map in server/inbox-approval.mjs (HANDS OFF — slice 1's file, only
// read here). The approval route (slice 1) will call journal() when a human
// decides; the journal deliberately does NOT adjudicate human-vs-agent — it
// records what the caller attests in decidedBy.
//
// Retention note: journal entries are never archived or purged by the
// retention slice — the retention policy (server/audit-retention.mjs) classifies
// routine events, but the decision journal is the audit trail of record and
// stays append-only. If retention ever needs to move them, that is a new slice.
//
// Pure, dependency-free (node:crypto only), deterministic; frozen outputs.
// Clock and id generator are injected so fixtures control time and ids.
import { createHash, randomUUID } from "node:crypto";

export const journalDecisions = Object.freeze(["approved", "rejected", "changes_requested", "escalated"]);
const GENESIS_PREV = "GENESIS";
const CARD_ID_MAX = 200;
const NOTE_MAX = 2000;

export class JournalError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "JournalError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
const fail = (code, message, detail) => { throw new JournalError(code, message, detail); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

const textOf = (value, max, field, { optional = false, allowEmpty = false } = {}) => {
  if (value === undefined || value === null) {
    check(optional, "journal_invalid", `${field} is required`);
    return optional ? null : "";
  }
  check(typeof value === "string" && value.isWellFormed(), "journal_invalid",
    `${field} must be a well-formed string`);
  check(allowEmpty ? value.length <= max : value.length >= 1 && value.length <= max,
    "journal_invalid", `${field} must be ${allowEmpty ? "at most" : "1.."}${max} characters`);
  return value;
};
const decidedAtOf = (value, clock) => {
  const at = value === undefined || value === null ? clock() : value;
  const ms = typeof at === "number" ? at : new Date(at).getTime();
  check(!Number.isNaN(ms), "journal_invalid", "decidedAt must be a parseable timestamp");
  return new Date(ms).toISOString();
};

// Canonical bytes for the hash: fixed key order, no whitespace surprises.
const payloadOf = record => JSON.stringify({
  id: record.id, seq: record.seq, cardId: record.cardId, decision: record.decision,
  decidedBy: record.decidedBy, decidedAt: record.decidedAt, note: record.note,
  receiptId: record.receiptId, prevHash: record.prevHash,
});
const hashOf = record => createHash("sha256").update(payloadOf(record), "utf8").digest("hex");

// Injected store contract: { append(record), readAll() -> record[] in append order }.
// readAll must return every record ever appended, in order — append-only, no
// update/delete exists in this API by design.
export function createMemoryJournalStore() {
  const rows = [];
  return {
    append: record => { rows.push(record); },
    readAll: () => rows.slice(),
  };
}

export function createDecisionJournal({ store = createMemoryJournalStore(), clock = () => Date.now(), id = () => randomUUID() } = {}) {
  check(store !== null && typeof store === "object", "journal_invalid", "store must be an object");
  check(typeof store.append === "function" && typeof store.readAll === "function",
    "journal_invalid", "store must provide append(record) and readAll()");
  check(typeof clock === "function" && typeof id === "function", "journal_invalid", "clock and id must be functions");

  const journal = entry => {
    check(entry !== null && typeof entry === "object" && !Array.isArray(entry),
      "journal_invalid", "entry must be an object");
    const cardId = textOf(entry.cardId, CARD_ID_MAX, "cardId");
    check(journalDecisions.includes(entry.decision), "journal_invalid",
      `decision must be one of ${journalDecisions.join(", ")}`);
    const decidedBy = textOf(entry.decidedBy, CARD_ID_MAX, "decidedBy");
    const decidedAt = decidedAtOf(entry.decidedAt, clock);
    const note = textOf(entry.note ?? "", NOTE_MAX, "note", { optional: true, allowEmpty: true }) ?? "";
    const receiptId = entry.receiptId === undefined || entry.receiptId === null
      ? null : textOf(entry.receiptId, CARD_ID_MAX, "receiptId");
    const prior = store.readAll();
    const seq = prior.length + 1;
    const prevHash = prior.length === 0 ? GENESIS_PREV : prior[prior.length - 1].hash;
    const record = Object.freeze({
      id: id(), seq, cardId, decision: entry.decision, decidedBy, decidedAt,
      note, receiptId, prevHash, hash: null,
    });
    const sealed = Object.freeze({ ...record, hash: hashOf(record) });
    store.append(sealed);
    return sealed;
  };

  // Chronological entries; list(cardId) filters to one card's history.
  const list = cardId => {
    const rows = store.readAll();
    const filtered = cardId === undefined || cardId === null
      ? rows : rows.filter(r => r.cardId === cardId);
    return Object.freeze(filtered.map(r => Object.freeze({ ...r })));
  };

  // Chain-integrity check: seqs contiguous from 1, each hash recomputes, each
  // prevHash links to the previous record's hash. Returns a result — never
  // throws for tampered data.
  const verify = () => {
    const rows = store.readAll();
    for (let index = 0; index < rows.length; index++) {
      const record = rows[index];
      const expectedSeq = index + 1;
      if (record.seq !== expectedSeq) {
        return { ok: false, checked: rows.length, brokenAt: expectedSeq,
          reason: `sequence broken: expected seq ${expectedSeq}, got ${record.seq}` };
      }
      const expectedPrev = index === 0 ? GENESIS_PREV : rows[index - 1].hash;
      if (record.prevHash !== expectedPrev) {
        return { ok: false, checked: rows.length, brokenAt: record.seq,
          reason: `seq ${record.seq} prevHash does not match seq ${record.seq - 1} hash (link broken)` };
      }
      if (record.hash !== hashOf({ ...record, hash: null })) {
        return { ok: false, checked: rows.length, brokenAt: record.seq,
          reason: `seq ${record.seq} hash mismatch: record was altered after it was journaled` };
      }
    }
    return { ok: true, checked: rows.length };
  };

  return Object.freeze({ journal, list, verify });
}

export { GENESIS_PREV };
