// Refusal journal + obligation stamps (#3617, accountability R-7/R-8).
//
// R-8: refusals are first-class records. Before this module, a refused
// action on most surfaces left nothing durable behind: public-work command
// refusals wrote nothing (public_work_requests journals only successful
// outcomes), bounty claim/review/payment refusals returned an error with
// no queryable record, and board (work-claim) refusals — including the
// claim-fencing 409s — existed only as the HTTP response. The ONE surface
// that recorded a refusal was the probation-gate denial packet
// (bounty_reputation_packets, server/bounty-escrow.mjs): an immutable
// record, written in its own transaction so it survives the refused
// action's rollback, stamping the ceiling in force. This module is that
// pattern, generalized:
//
// - `refusal_journal` is a separate, purely additive record store (its own
//   table, registered in unfencedAdditiveTables like the packet tables).
//   It is NOT the bounty journal: refusal rows carry no amount and must
//   never enter the bounty journal's hash core, whose conservation
//   verification is load-bearing.
// - A refusal is recorded AFTER the refusing transaction has rolled back
//   (or outside it), never inside it — the packet precedent. Callers use
//   recordRefusalBestEffort at the surface boundary so a journaling fault
//   can never mask or replace the refusal itself.
// - Every record names the policy version that refused it
//   (RECORDS_POLICY_VERSION) and, when the refusal was a ceiling refusal,
//   the ceiling in force (ceilingMillis) — mirroring the packet's
//   max_claim_millis stamp.
//
// R-7: obligation-creating records (settlements, bounty journal legs,
// claim grants) carry an obligation stamp { ceilingMillis, policyVersion,
// ratified } built by obligationStamp() below. `ratified` is sourced from
// the acting actor at action time — "human" only for a human actor, every
// mechanical or agent execution is "auto" — so no reader has to infer
// ratification from an actor kind after the fact. In the bounty journal
// the stamp rides the nullable obligation_stamp_json column, deliberately
// OUTSIDE the journal hash core (the PR #4041 provenance_json precedent):
// stamping a leg never rewrites what its hash attests, and pre-stamp rows
// stay NULL and keep verifying against their original hashes.
import { randomUUID } from "node:crypto";

export const RECORDS_POLICY_VERSION = 1;

export const REFUSAL_SURFACES = Object.freeze(["bounty", "public-work", "board"]);

export const refusalJournalSchema = `
  CREATE TABLE IF NOT EXISTS refusal_journal (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    refusal_id TEXT NOT NULL UNIQUE,
    room_id TEXT,
    surface TEXT NOT NULL CHECK(surface IN ('bounty','public-work','board')),
    actor_kind TEXT,
    actor_id TEXT,
    refused_action TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    policy_version INTEGER NOT NULL,
    ceiling_millis INTEGER,
    subject_id TEXT,
    detail_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS refusal_journal_room ON refusal_journal(room_id, seq);
  CREATE INDEX IF NOT EXISTS refusal_journal_actor ON refusal_journal(actor_id, seq);
`;

class RefusalJournalError extends Error {
  constructor(code, message) { super(message); this.name = "RefusalJournalError"; this.code = code; }
}
const fail = (code, message) => { throw new RefusalJournalError(code, message); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

const textOf = (value, field, { required = false, max = 512 } = {}) => {
  if (value === null || value === undefined) {
    check(!required, "invalid_refusal", `${field} is required`);
    return null;
  }
  check(typeof value === "string" && value.length >= 1 && value.length <= max,
    "invalid_refusal", `${field} must be a 1..${max} character string`);
  return value;
};

// "human" only when a human actor created the obligation; rule-driven and
// agent executions are auto-executed. Sourced from the actor at action
// time, never inferred by readers later.
export function ratifiedOf(actor) {
  return actor?.kind === "human" ? "human" : "auto";
}

// The R-7 stamp carried by obligation-creating records. ceilingMillis is
// the commitment ceiling in force for the acting party when the action
// executed (null only when a surface has no milli-credit ceiling).
export function obligationStamp({ ceilingMillis = null, actor = null, policyVersion = RECORDS_POLICY_VERSION } = {}) {
  check(ceilingMillis === null || (Number.isSafeInteger(ceilingMillis) && ceilingMillis >= 0),
    "invalid_stamp", "ceilingMillis must be a non-negative integer or null");
  check(Number.isSafeInteger(policyVersion) && policyVersion >= 1,
    "invalid_stamp", "policyVersion must be a positive integer");
  return Object.freeze({ ceilingMillis, policyVersion, ratified: ratifiedOf(actor) });
}

export function ensureRefusalJournal(db) {
  db.exec(refusalJournalSchema);
}

const viewOf = row => Object.freeze({
  refusalId: row.refusal_id, roomId: row.room_id, surface: row.surface,
  actor: row.actor_id === null && row.actor_kind === null ? null
    : Object.freeze({ kind: row.actor_kind, id: row.actor_id }),
  refusedAction: row.refused_action, reasonCode: row.reason_code,
  policyVersion: row.policy_version, ceilingMillis: row.ceiling_millis,
  subjectId: row.subject_id,
  detail: row.detail_json ? JSON.parse(row.detail_json) : null,
  createdAt: row.created_at,
});

// Write one immutable refusal record. Throws RefusalJournalError on invalid
// input; surface callers that must never mask the original refusal use
// recordRefusalBestEffort instead.
export function recordRefusal(db, { roomId = null, surface, actor = null, actorId = null,
  refusedAction, reasonCode, policyVersion = RECORDS_POLICY_VERSION,
  ceilingMillis = null, subjectId = null, detail = null, at = null } = {}) {
  check(REFUSAL_SURFACES.includes(surface), "invalid_refusal",
    `surface must be one of ${REFUSAL_SURFACES.join(", ")}`);
  textOf(refusedAction, "refusedAction", { required: true, max: 128 });
  textOf(reasonCode, "reasonCode", { required: true, max: 128 });
  textOf(roomId, "roomId", { max: 512 });
  textOf(subjectId, "subjectId", { max: 512 });
  check(Number.isSafeInteger(policyVersion) && policyVersion >= 1,
    "invalid_refusal", "policyVersion must be a positive integer");
  check(ceilingMillis === null || (Number.isSafeInteger(ceilingMillis) && ceilingMillis >= 0),
    "invalid_refusal", "ceilingMillis must be a non-negative integer or null");
  const kind = actor?.kind ?? null;
  const id = actor?.id ?? actorId;
  textOf(kind, "actor.kind", { max: 64 });
  textOf(id, "actor.id", { max: 512 });
  let detailJson = null;
  if (detail !== null && detail !== undefined) {
    try { detailJson = JSON.stringify(detail); } catch { fail("invalid_refusal", "detail must be JSON-safe"); }
    check(typeof detailJson === "string" && Buffer.byteLength(detailJson) <= 8192,
      "invalid_refusal", "detail is too large to journal");
  }
  const createdAt = at ?? new Date().toISOString();
  check(typeof createdAt === "string" && Number.isFinite(Date.parse(createdAt)),
    "invalid_refusal", "at must be an ISO timestamp");
  ensureRefusalJournal(db);
  const refusalId = `ref_${randomUUID()}`;
  db.prepare(`INSERT INTO refusal_journal
    (refusal_id, room_id, surface, actor_kind, actor_id, refused_action, reason_code,
     policy_version, ceiling_millis, subject_id, detail_json, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(refusalId, roomId, surface, kind, id, refusedAction, reasonCode,
      policyVersion, ceilingMillis, subjectId, detailJson, createdAt);
  return viewOf(db.prepare("SELECT * FROM refusal_journal WHERE refusal_id=?").get(refusalId));
}

// Record a refusal without ever throwing: the refusal response the caller
// is about to raise is the primary outcome, and a journaling fault (a
// read-only transaction, a pre-convergence database) must not replace it.
// Returns the record, or null when journaling was not possible.
export function recordRefusalBestEffort(db, input) {
  try { return recordRefusal(db, input); } catch { return null; }
}

// The per-room / per-actor query. Filters combine (room AND actor AND
// surface); newest first; limit is bounded so a caller cannot pull an
// unbounded journal by accident.
export function listRefusals(db, { roomId = null, actorId = null, surface = null, limit = 100 } = {}) {
  check(roomId !== null || actorId !== null, "invalid_query",
    "listRefusals requires a roomId or an actorId");
  if (surface !== null) check(REFUSAL_SURFACES.includes(surface), "invalid_query",
    `surface must be one of ${REFUSAL_SURFACES.join(", ")}`);
  check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500,
    "invalid_query", "limit must be an integer in 1..500");
  const exists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='refusal_journal'").get();
  if (!exists) return Object.freeze([]);
  const where = [], params = [];
  if (roomId !== null) { where.push("room_id=?"); params.push(roomId); }
  if (actorId !== null) { where.push("actor_id=?"); params.push(actorId); }
  if (surface !== null) { where.push("surface=?"); params.push(surface); }
  const rows = db.prepare(
    `SELECT * FROM refusal_journal WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`)
    .all(...params, limit);
  return Object.freeze(rows.map(viewOf));
}

export class RefusalJournal {
  constructor(db) { this.db = db; }
  record(input) { return recordRefusal(this.db, input); }
  recordBestEffort(input) { return recordRefusalBestEffort(this.db, input); }
  listForRoom(roomId, { actorId = null, surface = null, limit = 100 } = {}) {
    return listRefusals(this.db, { roomId, actorId, surface, limit });
  }
  listForActor(actorId, { roomId = null, surface = null, limit = 100 } = {}) {
    return listRefusals(this.db, { roomId, actorId, surface, limit });
  }
}
