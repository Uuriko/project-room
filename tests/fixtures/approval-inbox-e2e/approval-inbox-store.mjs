// VENDORED FIXTURE — do not edit. Delete when the sibling slice's PR merges.
// Source: sibling working tree jill/wave500-g10-inbox-store (uncommitted),
// copied 2026-10-10 ~20:20 PDT. Pinned copy for the wave500-g10 e2e
// integration proof only. After merge, delete this directory and re-point
// tests/approval-inbox-e2e.test.js at ../server/.

// Approval inbox store: SQLite persistence for the unified approval inbox.
//
// The inbox is the one live surface for pending HUMAN decisions — cards the
// system genuinely cannot resolve itself. A card carries the exact change,
// its context links, and its options with their consequences. Only a human
// identity may decide: that 403 lives in the routes layer, and this store
// stays a pure library (like createFeedbackStore's authority hooks).
//
// Tables are created lazily with CREATE TABLE IF NOT EXISTS by the module
// itself (see server/agent-heartbeats.mjs); the schema is additive only —
// no ALTERs on existing tables. Clock and id generation are injected so
// tests stay deterministic.
import { randomUUID } from "node:crypto";

export const APPROVAL_KINDS = Object.freeze(["money", "identity", "deploy", "permission", "publish", "other"]);
export const APPROVAL_DECISIONS = Object.freeze(["approve", "approve-session", "deny-stop"]);
// "changes" is reserved for the requester-revision flow owned by a later
// routes slice; the store never writes it, and "expired" is written only by
// expireCards(). All other writes go pending -> approved | rejected.
export const APPROVAL_STATUSES = Object.freeze(["pending", "approved", "rejected", "changes", "expired"]);

export const approvalInboxSchema = `
  CREATE TABLE IF NOT EXISTS approval_inbox_cards (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('money','identity','deploy','permission','publish','other')),
    title TEXT NOT NULL,
    what TEXT NOT NULL,
    context_json TEXT NOT NULL DEFAULT '{}',
    options_json TEXT NOT NULL DEFAULT '[]',
    requested_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','changes','expired'))
  );
  CREATE INDEX IF NOT EXISTS approval_inbox_cards_status ON approval_inbox_cards(status, created_at);
  CREATE INDEX IF NOT EXISTS approval_inbox_cards_kind ON approval_inbox_cards(kind, status);
  CREATE TABLE IF NOT EXISTS approval_inbox_decisions (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('approve','approve-session','deny-stop')),
    decided_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(card_id)
  );
`;

export class ApprovalInboxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApprovalInboxError";
    this.code = code;
  }
}
const fail = (code, message) => { throw new ApprovalInboxError(code, message); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

// Lazy schema install: additive only, safe on every construction, and safe
// to call mid-use (CREATE TABLE/INDEX IF NOT EXISTS never drops data).
export function ensureApprovalInboxSchema(db) {
  db.exec(approvalInboxSchema);
  return db;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const isNonEmptyString = (value, max) =>
  typeof value === "string" && value.length > 0 && value.length <= max;

const checkCardId = id =>
  check(typeof id === "string" && ID_PATTERN.test(id),
    "invalid_card", "id must match [A-Za-z0-9_-]{1,128}");
const checkKind = (kind, code = "invalid_card") =>
  check(APPROVAL_KINDS.includes(kind), code, `kind must be one of ${APPROVAL_KINDS.join(", ")}`);
const checkActor = (value, what, code = "invalid_card") =>
  check(isNonEmptyString(value, 128), code, `${what} must be a 1-128 char string`);
const checkDecision = decision =>
  check(APPROVAL_DECISIONS.includes(decision), "invalid_decision",
    `decision must be one of ${APPROVAL_DECISIONS.join(", ")}`);

const checkLink = link => {
  check(link && typeof link === "object" && !Array.isArray(link),
    "invalid_card", "context.links entries must be objects");
  check(isNonEmptyString(link.label, 200), "invalid_card", "context link label must be 1-200 chars");
  check(isNonEmptyString(link.url, 2000), "invalid_card", "context link url must be 1-2000 chars");
  return Object.freeze({ label: link.label, url: link.url });
};

// Context is free-form but typed: { links: [{label, url}], note }.
const normalizeContext = context => {
  if (context === null || context === undefined) return Object.freeze({});
  if (typeof context === "string") return Object.freeze({ note: context });
  check(typeof context === "object" && !Array.isArray(context),
    "invalid_card", "context must be an object, a links array, or a string");
  const out = {};
  if (context.links !== undefined) {
    check(Array.isArray(context.links), "invalid_card", "context.links must be an array");
    out.links = Object.freeze(context.links.map(checkLink));
  }
  if (context.note !== undefined) {
    check(isNonEmptyString(context.note, 4000), "invalid_card", "context.note must be 1-4000 chars");
    out.note = context.note;
  }
  return Object.freeze(out);
};

const checkOption = option => {
  check(option && typeof option === "object" && !Array.isArray(option),
    "invalid_card", "options entries must be objects");
  check(isNonEmptyString(option.label, 200), "invalid_card", "option label must be 1-200 chars");
  check(typeof option.consequence === "string" && option.consequence.length <= 2000,
    "invalid_card", "option consequence must be a string up to 2000 chars");
  return Object.freeze({ label: option.label, consequence: option.consequence });
};

const decisionView = row => Object.freeze({
  id: row.id, cardId: row.card_id, decision: row.decision,
  decidedBy: row.decided_by, createdAt: row.created_at,
});

const cardView = (row, decisionRow) => Object.freeze({
  id: row.id, kind: row.kind, title: row.title, what: row.what,
  context: Object.freeze(JSON.parse(row.context_json)),
  options: Object.freeze(JSON.parse(row.options_json).map(option => Object.freeze(option))),
  requestedBy: row.requested_by,
  createdAt: row.created_at, expiresAt: row.expires_at,
  status: row.status,
  decision: decisionRow ? decisionView(decisionRow) : null,
});

const DECISION_TO_STATUS = Object.freeze({
  "approve": "approved",
  "approve-session": "approved",
  "deny-stop": "rejected",
});

export class ApprovalInboxStore {
  constructor({ db, now, newId } = {}) {
    check(db && typeof db.prepare === "function" && typeof db.exec === "function",
      "invalid_store", "db must be a node:sqlite DatabaseSync");
    check(now === undefined || typeof now === "function", "invalid_store", "now must be a function");
    check(newId === undefined || typeof newId === "function", "invalid_store", "newId must be a function");
    this.db = db;
    this._now = now ?? (() => Date.now());
    this._newId = newId ?? (() => randomUUID());
    ensureApprovalInboxSchema(db);
  }

  now() { return this._now(); }

  // File a new decision card. Starts pending; expiresAt (when set) must be
  // in the future — a card born expired is a caller bug, not a sweep job.
  createCard({ id, kind, title, what, context, options = [], requestedBy, expiresAt = null } = {}) {
    const at = this.now();
    const cardId = id ?? this._newId();
    checkCardId(cardId);
    checkKind(kind);
    check(isNonEmptyString(title, 200), "invalid_card", "title must be 1-200 chars");
    check(isNonEmptyString(what, 4000), "invalid_card", "what must be 1-4000 chars");
    checkActor(requestedBy, "requestedBy");
    check(options === undefined || Array.isArray(options), "invalid_card", "options must be an array");
    const optionsJson = JSON.stringify((options ?? []).map(checkOption));
    const contextJson = JSON.stringify(normalizeContext(context));
    if (expiresAt !== null && expiresAt !== undefined) {
      check(Number.isFinite(expiresAt) && expiresAt > at,
        "invalid_card", "expiresAt must be a future timestamp");
    }
    try {
      this.db.prepare(`INSERT INTO approval_inbox_cards
        (id, kind, title, what, context_json, options_json, requested_by, created_at, expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
        .run(cardId, kind, title, what, contextJson, optionsJson, requestedBy, at, expiresAt ?? null);
    } catch (error) {
      // node:sqlite surfaces constraint violations as a generic
      // ERR_SQLITE_ERROR carrying the SQLite message — match the text.
      if (String(error?.message ?? "").includes("UNIQUE constraint failed: approval_inbox_cards.id")) {
        fail("duplicate_card", `card ${cardId} already exists`);
      }
      throw error;
    }
    return this.getCard(cardId);
  }

  // One card plus its decision (null when undecided). Null when unknown.
  getCard(id) {
    checkCardId(id);
    const row = this.db.prepare("SELECT * FROM approval_inbox_cards WHERE id=?").get(id);
    if (!row) return null;
    const decisionRow = this.db.prepare("SELECT * FROM approval_inbox_decisions WHERE card_id=?").get(id);
    return cardView(row, decisionRow);
  }

  // Newest first (created_at DESC, id ASC tiebreak — deterministic).
  listCards({ status, kind, requestedBy, limit = 50, offset = 0 } = {}) {
    const clauses = [];
    const params = [];
    if (status !== undefined && status !== null) {
      const statuses = Array.isArray(status) ? status : [status];
      for (const value of statuses) {
        check(APPROVAL_STATUSES.includes(value), "invalid_filter",
          `status must be one of ${APPROVAL_STATUSES.join(", ")}`);
      }
      clauses.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    if (kind !== undefined && kind !== null) {
      checkKind(kind, "invalid_filter");
      clauses.push("kind=?");
      params.push(kind);
    }
    if (requestedBy !== undefined && requestedBy !== null) {
      checkActor(requestedBy, "requestedBy", "invalid_filter");
      clauses.push("requested_by=?");
      params.push(requestedBy);
    }
    check(Number.isInteger(limit) && limit > 0 && limit <= 200, "invalid_filter", "limit must be 1..200");
    check(Number.isInteger(offset) && offset >= 0, "invalid_filter", "offset must be a non-negative integer");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT * FROM approval_inbox_cards ${where} ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    const decisions = new Map(this.db.prepare(
      `SELECT * FROM approval_inbox_decisions WHERE card_id IN (SELECT id FROM approval_inbox_cards ${where})`)
      .all(...params).map(row => [row.card_id, row]));
    return Object.freeze(rows.map(row => cardView(row, decisions.get(row.id) ?? null)));
  }

  // Record a human decision on a pending card. Only pending cards move:
  // repeating the same decision by the same decider replays idempotently
  // (safe to retry after a transport failure); any other second decision
  // is a conflict and is refused — decisions are never overwritten.
  decideCard(cardId, { decision, decidedBy } = {}) {
    checkCardId(cardId);
    checkDecision(decision);
    check(isNonEmptyString(decidedBy, 128), "invalid_decision", "decidedBy must be 1-128 chars");
    const card = this.getCard(cardId);
    if (!card) fail("not_found", `card ${cardId} not found`);
    if (card.status !== "pending") {
      const existing = card.decision;
      if (existing && existing.decision === decision && existing.decidedBy === decidedBy) {
        return Object.freeze({ card, decision: existing });
      }
      fail("invalid_transition", `card ${cardId} is already ${card.status}`);
    }
    const at = this.now();
    const decisionId = this._newId();
    checkCardId(decisionId);
    this.db.prepare(`INSERT INTO approval_inbox_decisions
      (id, card_id, decision, decided_by, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(decisionId, cardId, decision, decidedBy, at);
    this.db.prepare("UPDATE approval_inbox_cards SET status=? WHERE id=?")
      .run(DECISION_TO_STATUS[decision], cardId);
    const updated = this.getCard(cardId);
    return Object.freeze({ card: updated, decision: updated.decision });
  }

  // Sweep pending cards past their expiry. Expiry is a system clock event,
  // not a decision — no decision row is written.
  expireCards() {
    const at = this.now();
    const due = this.db.prepare(
      `SELECT id FROM approval_inbox_cards
       WHERE status='pending' AND expires_at IS NOT NULL AND expires_at <= ?
       ORDER BY expires_at ASC`)
      .all(at).map(row => row.id);
    if (due.length > 0) {
      this.db.prepare(
        `UPDATE approval_inbox_cards SET status='expired'
         WHERE status='pending' AND expires_at IS NOT NULL AND expires_at <= ?`)
        .run(at);
    }
    return Object.freeze({ expired: Object.freeze(due) });
  }
}
