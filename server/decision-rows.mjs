// Decision-row export (#3616, accountability R-5 + R-11).
//
// A documented, stable-schema export of per-subject decision rows:
// one row per verdict across the three verdict surfaces —
//   * public-work reviews   (server/public-work-reviews.mjs)
//   * bounty verdicts       (server/bounty-escrow.mjs)
//   * board claim reviews   (server/work-claims.mjs, room workItems)
//
// The schema is versioned as `decision-rows/1` and documented in
// docs/DECISION-ROWS.md. The field definitions below (DECISION_ROW_FIELDS)
// are the machine-readable twin of that document; a test pins them
// together, so the schema cannot drift silently.
//
// HARD CONSTRAINT (R-5): the platform collects no protected-class
// attributes, and this export introduces none — no such fields and no
// proxies for them. The subject id is the deployer-controlled identity /
// member / lane id already on the verdict record; any demographic join
// belongs entirely to the deployer/auditor, outside this export.
//
// Provenance (#3612, PR #4041): verdict records written after the
// provenance stamps land carry a nested `provenance` object
// ({ sessionInstanceId, authorizingPrincipalId, claimedModelVersion,
// claimedHarnessVersion, claimedEnvironment }). Rows flatten the three
// charter-named fields — sessionInstanceId, authorizingPrincipalId,
// claimedModelVersion — WHEN PRESENT. Legacy records without a stamp
// export those fields as null, never fabricated.
//
// R-11: the export is owner-gated, and both the export itself and
// member-side evidence reads are access-logged (evidence_access_log):
// reader, record/surface, at — plus, for an export, the schema version
// and row count. The export additionally appends the room's
// `room.exported` audit event (see server/http.mjs / history-visibility)
// naming schema version, row count and requester.

import { ServiceError } from "./service-error.mjs";

export const DECISION_ROWS_SCHEMA = "decision-rows/1";

// Field definitions for decision-rows/1. `name` is the exact key on every
// exported row; every row carries every key (null when not applicable),
// so a consumer never has to probe for key presence.
export const DECISION_ROW_FIELDS = Object.freeze([
  Object.freeze({ name: "schema", type: "string", nullable: false, description: "Schema version of this row; always 'decision-rows/1'." }),
  Object.freeze({ name: "rowId", type: "string", nullable: false, description: "Stable id of this decision row, unique within the export (surface + record id + decision kind)." }),
  Object.freeze({ name: "roomId", type: "string", nullable: false, description: "Room the verdict was recorded in." }),
  Object.freeze({ name: "surface", type: "string", nullable: false, description: "Verdict surface: 'public-work', 'bounty', or 'board'." }),
  Object.freeze({ name: "recordId", type: "string", nullable: false, description: "Id of the underlying record on its surface (receipt id, bounty id, or work claim id)." }),
  Object.freeze({ name: "subjectId", type: "string", nullable: true, description: "Deployer-controlled id of the subject of the decision: the contributor identity (public-work), the claimant lane (bounty), or the claim owner (board). Null only when the record carries no subject." }),
  Object.freeze({ name: "decisionKind", type: "string", nullable: false, description: "'acceptance' (the terminal accept/reject verdict), 'verification' (an independent PASS/FAIL check), or 'review' (a board reviewer verdict that is not itself the completion verdict)." }),
  Object.freeze({ name: "outcome", type: "string", nullable: false, description: "The verdict as recorded on its surface, e.g. accepted, rejected, revision_requested, PASS, FAIL, approve, changes_requested, comment, verified, self_attested, disputed." }),
  Object.freeze({ name: "accepted", type: "boolean", nullable: true, description: "For decisionKind='acceptance' rows only: true when the work was accepted, false when rejected / sent back. Null on verification and review rows, and on non-terminal acceptance outcomes (e.g. revision_requested, disputed)." }),
  Object.freeze({ name: "rubricVersion", type: "string", nullable: true, description: "Version of the rubric/policy that governed the verdict, as a string: public-work terms version, bounty pinned rubric version, or board review policy. Null when the record pins none." }),
  Object.freeze({ name: "criteriaSummary", type: "string", nullable: true, description: "Short summary of the criteria the verdict cited: cited criterion verdicts, executed check results, or the recorded reason. Bounded text; never a free-form dump of the underlying work." }),
  Object.freeze({ name: "verifierId", type: "string", nullable: true, description: "Identity/member/lane id of whoever rendered this verdict. Null when no verifier is recorded." }),
  Object.freeze({ name: "decidedAt", type: "string", nullable: true, description: "ISO timestamp of the verdict, as recorded. Null when the record carries none." }),
  Object.freeze({ name: "submittedAt", type: "string", nullable: true, description: "ISO timestamp of the submission / claim round the verdict judged, when the record carries one; otherwise null." }),
  Object.freeze({ name: "sessionInstanceId", type: "string", nullable: true, description: "Provenance (#3612): server-derived runtime instance/session that produced the verdict record, when stamped; null on legacy records." }),
  Object.freeze({ name: "authorizingPrincipalId", type: "string", nullable: true, description: "Provenance (#3612): principal who authorized the work/verdict, when stamped; null on legacy records." }),
  Object.freeze({ name: "claimedModelVersion", type: "string", nullable: true, description: "Provenance (#3612): the producing runtime's self-reported model version (a claim, not a platform attestation), when stamped; null when not reported." }),
]);

const FIELD_NAMES = DECISION_ROW_FIELDS.map(field => field.name);

export const decisionRowsSchema = `
CREATE TABLE IF NOT EXISTS evidence_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  reader_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('export','evidence_read')),
  surface TEXT,
  record_id TEXT,
  schema_version TEXT,
  row_count INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_access_log_room ON evidence_access_log(room_id, id);`;

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

const str = value => (typeof value === "string" && value.length > 0 ? value : null);
const iso = value => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null);
const isoFromMs = value => (Number.isSafeInteger(value) ? new Date(value).toISOString() : null);

// Flatten a #3612 provenance stamp, wherever it rides on a verdict
// record. Accepts the nested object directly; anything malformed or
// absent reads as all-null (never fabricated).
export function provenanceFields(...candidates) {
  for (const candidate of candidates) {
    const stamp = candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? (candidate.provenance && typeof candidate.provenance === "object" ? candidate.provenance : candidate)
      : null;
    if (!stamp) continue;
    const fields = {
      sessionInstanceId: str(stamp.sessionInstanceId),
      authorizingPrincipalId: str(stamp.authorizingPrincipalId),
      claimedModelVersion: str(stamp.claimedModelVersion),
    };
    if (fields.sessionInstanceId || fields.authorizingPrincipalId || fields.claimedModelVersion) return fields;
  }
  return { sessionInstanceId: null, authorizingPrincipalId: null, claimedModelVersion: null };
}

const bounded = (value, max = 500) => {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim().replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function row(base) {
  const out = {};
  for (const name of FIELD_NAMES) out[name] = base[name] ?? null;
  out.schema = DECISION_ROWS_SCHEMA;
  return Object.freeze(out);
}

// --- Surface builders (pure; unit-testable without a store) --------------

// One public-work receipt + its review record (the parsed state_json of
// public_work_reviews, or null when never reviewed). A decision, when
// present, is the acceptance row; a verification without a decision is a
// verification row. An unreviewed receipt yields no rows.
export function rowsFromPublicWork({ roomId, receipt, review }) {
  if (!receipt || typeof receipt !== "object") return [];
  const subjectId = str(receipt.identityId);
  const submittedAt = iso(receipt.createdAt) ?? isoFromMs(receipt.created_at);
  const rubricVersion = receipt.termsVersion === undefined || receipt.termsVersion === null ? null : String(receipt.termsVersion);
  const recordId = str(receipt.receiptId);
  if (!recordId || !review || typeof review !== "object") return [];
  if (review.decision && typeof review.decision === "object") {
    const decision = review.decision;
    const outcome = str(decision.decision) ?? "unknown";
    return [row({
      rowId: `public-work:${recordId}:acceptance`,
      roomId, surface: "public-work", recordId, subjectId,
      decisionKind: "acceptance", outcome,
      accepted: outcome === "accepted" ? true : outcome === "rejected" ? false : null,
      rubricVersion,
      criteriaSummary: bounded(decision.reason),
      verifierId: str(decision.actorId),
      decidedAt: iso(decision.at), submittedAt,
      ...provenanceFields(decision, review),
    })];
  }
  if (review.verification && typeof review.verification === "object") {
    const verification = review.verification;
    const outcome = str(verification.verdict) ?? "unknown";
    const checks = Array.isArray(verification.executedChecks)
      ? verification.executedChecks.filter(c => c && typeof c.name === "string").map(c => `${c.name}:${c.result ?? "?"}`).join(", ")
      : null;
    return [row({
      rowId: `public-work:${recordId}:verification`,
      roomId, surface: "public-work", recordId, subjectId,
      decisionKind: "verification", outcome, accepted: null,
      rubricVersion,
      criteriaSummary: bounded(checks ?? verification.reason),
      verifierId: str(verification.actorId),
      decidedAt: iso(verification.at), submittedAt,
      ...provenanceFields(verification, review),
    })];
  }
  return [];
}

// One bounty record (the _viewBounty/_mutable shape: claimant, verifier,
// poster, state, rubric {version}, attestation, resolution, evidence,
// createdAt, updatedAt, stateChangedAt). The acceptance row is the
// latest terminal verdict the record carries: an attestation (accepted),
// a rejection resolution, a dispute resolution, or — as a fallback — a
// terminal state with no richer verdict record. Non-terminal bounties
// (proposed/funded/claimed/submitted) yield no rows.
export function rowsFromBounty({ roomId, bounty }) {
  if (!bounty || typeof bounty !== "object") return [];
  const recordId = str(bounty.bountyId);
  if (!recordId) return [];
  const subjectId = str(bounty.claimant);
  const rubricVersion = bounty.rubric && bounty.rubric.version !== undefined && bounty.rubric.version !== null
    ? String(bounty.rubric.version)
    : (bounty.rubricVersion !== undefined && bounty.rubricVersion !== null ? String(bounty.rubricVersion) : null);
  const submittedAt = iso(bounty.createdAt);
  const stateChangedAt = iso(bounty.stateChangedAt) ?? iso(bounty.updatedAt);
  const attestation = bounty.attestation && typeof bounty.attestation === "object" ? bounty.attestation : null;
  const resolution = bounty.resolution && typeof bounty.resolution === "object" ? bounty.resolution : null;
  const citations = attestation && Array.isArray(attestation.citations)
    ? attestation.citations.filter(c => c && typeof c.criterionId === "string").map(c => `${c.criterionId}:${c.verdict ?? "?"}`).join(", ")
    : null;

  if (resolution && resolution.kind === "rejected") {
    return [row({
      rowId: `bounty:${recordId}:acceptance`,
      roomId, surface: "bounty", recordId, subjectId,
      decisionKind: "acceptance", outcome: "rejected", accepted: false,
      rubricVersion, criteriaSummary: bounded(resolution.reason),
      verifierId: str(resolution.rejectedBy),
      decidedAt: iso(resolution.rejectedAt) ?? stateChangedAt, submittedAt,
      ...provenanceFields(resolution, attestation, bounty.evidence),
    })];
  }
  if (resolution && (typeof resolution.outcome === "string" || resolution.kind === "split" || resolution.kind === "release" || resolution.kind === "cancel")) {
    // Dispute re-decision: the resolution is the terminal verdict.
    // `accepted` derives from resolution.kind — the work's fate under
    // the settlement (server/bounty-escrow.mjs _settleDispute:
    // settleKind = outcome "upheld" -> "cancel", "split" -> "split",
    // anything else -> "release"; settlement kind failed / partial /
    // verified-complete respectively). resolution.outcome names the
    // CHALLENGE's fate instead — "upheld" means the challenge won and
    // the bounty was refunded, "rejected" means the challenge lost and
    // the worker was paid — so reading `accepted` off the outcome
    // inverts both directions. The recorded outcome still rides the
    // row's `outcome` field verbatim.
    const outcomeText = str(resolution.outcome) ?? str(resolution.kind) ?? "decided";
    const accepted = resolution.kind === "cancel" ? false
      : resolution.kind === "release" || resolution.kind === "split" ? true : null;
    return [row({
      rowId: `bounty:${recordId}:acceptance`,
      roomId, surface: "bounty", recordId, subjectId,
      decisionKind: "acceptance", outcome: outcomeText, accepted,
      rubricVersion, criteriaSummary: bounded(resolution.reason ?? resolution.kind),
      verifierId: str(resolution.decidedBy) ?? str(resolution.settledBy?.id) ?? str(bounty.disputeDecider),
      decidedAt: iso(resolution.decidedAt) ?? iso(resolution.settledAt) ?? stateChangedAt, submittedAt,
      ...provenanceFields(resolution, attestation, bounty.evidence),
    })];
  }
  if (attestation || bounty.state === "accepted" || bounty.state === "approved") {
    return [row({
      rowId: `bounty:${recordId}:acceptance`,
      roomId, surface: "bounty", recordId, subjectId,
      decisionKind: "acceptance", outcome: "accepted", accepted: true,
      rubricVersion: attestation && attestation.rubricVersion !== undefined && attestation.rubricVersion !== null
        ? String(attestation.rubricVersion) : rubricVersion,
      criteriaSummary: bounded(citations),
      verifierId: str(attestation?.recordedBy) ?? str(bounty.verifier) ?? str(bounty.poster),
      decidedAt: iso(attestation?.recordedAt) ?? stateChangedAt, submittedAt,
      ...provenanceFields(attestation, bounty.evidence),
    })];
  }
  if (bounty.state === "refunded") {
    return [row({
      rowId: `bounty:${recordId}:acceptance`,
      roomId, surface: "bounty", recordId, subjectId,
      decisionKind: "acceptance", outcome: "rejected", accepted: false,
      rubricVersion, criteriaSummary: bounded(resolution?.reason),
      verifierId: str(bounty.verifier) ?? str(bounty.poster),
      decidedAt: stateChangedAt, submittedAt,
      ...provenanceFields(resolution, bounty.evidence),
    })];
  }
  if (bounty.state === "disputed") {
    return [row({
      rowId: `bounty:${recordId}:acceptance`,
      roomId, surface: "bounty", recordId, subjectId,
      decisionKind: "acceptance", outcome: "disputed", accepted: null,
      rubricVersion, criteriaSummary: null,
      verifierId: str(bounty.disputeDecider),
      decidedAt: stateChangedAt, submittedAt,
      ...provenanceFields(attestation, bounty.evidence),
    })];
  }
  return [];
}

// One board work item (server/work-claims.mjs shape: id, owner,
// reviewPolicy, reviews[], verification, claimedAt). Each recorded
// review is a 'review' row; the verification fact, when present, is the
// completion ('acceptance') row — verified/self_attested accept the
// delivery, changes_requested sends it back.
export function rowsFromBoardClaim({ roomId, item }) {
  if (!item || typeof item !== "object") return [];
  const recordId = str(item.id);
  if (!recordId) return [];
  const subjectId = str(item.owner);
  const rubricVersion = str(item.reviewPolicy);
  const submittedAt = iso(item.claimedAt);
  const rows = [];
  for (const review of Array.isArray(item.reviews) ? item.reviews : []) {
    if (!review || typeof review !== "object") continue;
    const outcome = str(review.verdict) ?? "unknown";
    rows.push(row({
      rowId: `board:${recordId}:review:${str(review.memberId) ?? "unknown"}:${iso(review.at) ?? "undated"}`,
      roomId, surface: "board", recordId, subjectId,
      decisionKind: "review", outcome, accepted: null,
      rubricVersion, criteriaSummary: bounded(review.summary),
      verifierId: str(review.memberId),
      decidedAt: iso(review.at), submittedAt,
      ...provenanceFields(review),
    }));
  }
  const verification = item.verification && typeof item.verification === "object" ? item.verification : null;
  if (verification && str(verification.state)) {
    const state = verification.state;
    const checks = Array.isArray(verification.executedChecks)
      ? verification.executedChecks.filter(c => c && typeof c.name === "string").map(c => `${c.name}:${c.result ?? "?"}`).join(", ")
      : null;
    rows.push(row({
      rowId: `board:${recordId}:acceptance`,
      roomId, surface: "board", recordId, subjectId,
      decisionKind: "acceptance",
      outcome: state === "changes_requested" ? "changes_requested" : "accepted",
      accepted: state === "verified" || state === "self_attested" ? true : state === "changes_requested" ? false : null,
      rubricVersion, criteriaSummary: bounded(checks),
      verifierId: str(verification.by) ?? str(item.reviewedBy),
      decidedAt: iso(verification.at), submittedAt,
      ...provenanceFields(verification),
    }));
  }
  return rows;
}

// Acceptance rates by rubric version, computed from exported rows
// alone — the auditor computation the acceptance test exercises.
// Only decisionKind='acceptance' rows with accepted !== null count.
export function acceptanceRatesByRubricVersion(rows) {
  const byVersion = new Map();
  for (const entry of rows ?? []) {
    if (!entry || entry.decisionKind !== "acceptance" || typeof entry.accepted !== "boolean") continue;
    const key = entry.rubricVersion ?? "(none)";
    const bucket = byVersion.get(key) ?? { rubricVersion: key, decided: 0, accepted: 0 };
    bucket.decided += 1;
    if (entry.accepted) bucket.accepted += 1;
    byVersion.set(key, bucket);
  }
  return [...byVersion.values()]
    .sort((a, b) => (a.rubricVersion < b.rubricVersion ? -1 : 1))
    .map(bucket => Object.freeze({ ...bucket, acceptanceRate: bucket.decided ? bucket.accepted / bucket.decided : null }));
}

// --- Store-facing service --------------------------------------------------

export class DecisionRows {
  constructor(store) { this.store = store; this.db = store?.db ?? null; }

  hasTable(name) {
    if (!this.db) return false;
    try { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
    catch { return false; }
  }

  // The access log is additive: create it on first use so a database
  // that predates #3616 gains it without an operator migration.
  ensure() {
    if (!this.db) fail(503, "decision_rows_unavailable", "Decision-row export requires a database-backed store");
    this.db.exec(decisionRowsSchema);
    return true;
  }
  verifySchema({ allowAbsent = false } = {}) {
    if (!this.hasTable("evidence_access_log")) return !allowAbsent ? this.ensure() : false;
    return true;
  }

  // R-11: record one access. kind='export' also carries schemaVersion
  // and rowCount; kind='evidence_read' carries surface + recordId.
  // Best-effort callers (evidence-read surfaces) use logAccessQuietly.
  logAccess({ roomId, readerId, kind, surface = null, recordId = null, schemaVersion = null, rowCount = null, at = null }) {
    this.ensure();
    const when = iso(at) ?? new Date(typeof this.store?.now === "function" ? this.store.now() : Date.now()).toISOString();
    const info = this.db.prepare(`INSERT INTO evidence_access_log
      (room_id, reader_id, kind, surface, record_id, schema_version, row_count, at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(roomId, readerId, kind, surface, recordId, schemaVersion, Number.isSafeInteger(rowCount) ? rowCount : null, when);
    return { id: Number(info.lastInsertRowid), roomId, readerId, kind, surface, recordId, schemaVersion, rowCount, at: when };
  }
  logEvidenceRead({ roomId, readerId, surface, recordId = null }) {
    return this.logAccess({ roomId, readerId, kind: "evidence_read", surface, recordId });
  }
  // Evidence reads must not fail because the access log did — but a
  // silent drop would defeat R-11, so route handlers that can fail
  // closed (the export) use logAccess directly; read surfaces use this
  // and the failure is surfaced in the server log by the caller.
  logAccessQuietly(entry) {
    try { return this.logAccess(entry); } catch { return null; }
  }

  listAccessLog(roomId, { limit = 100 } = {}) {
    this.ensure();
    const boundedLimit = Number.isSafeInteger(limit) && limit > 0 && limit <= 500 ? limit : 100;
    return this.db.prepare(`SELECT id, room_id AS roomId, reader_id AS readerId, kind, surface,
        record_id AS recordId, schema_version AS schemaVersion, row_count AS rowCount, at
      FROM evidence_access_log WHERE room_id=? ORDER BY id DESC LIMIT ?`).all(roomId, boundedLimit)
      .map(entry => ({ ...entry, rowCount: entry.rowCount ?? null }));
  }

  collect(roomId) {
    const rows = [];
    // Public-work: receipts joined to their tasks (room scope) and reviews.
    if (this.hasTable("public_work_receipts") && this.hasTable("public_work_tasks")) {
      const reviewSelect = this.hasTable("public_work_reviews")
        ? "SELECT r.receipt_id AS receiptId, r.receipt_json AS receiptJson, v.state_json AS reviewJson FROM public_work_receipts r JOIN public_work_tasks t ON t.offer_id=r.offer_id LEFT JOIN public_work_reviews v ON v.receipt_id=r.receipt_id WHERE t.room_id=? ORDER BY r.receipt_id"
        : "SELECT r.receipt_id AS receiptId, r.receipt_json AS receiptJson, NULL AS reviewJson FROM public_work_receipts r JOIN public_work_tasks t ON t.offer_id=r.offer_id WHERE t.room_id=? ORDER BY r.receipt_id";
      for (const entry of this.db.prepare(reviewSelect).all(roomId)) {
        let receipt = null, review = null;
        try { receipt = JSON.parse(entry.receiptJson); } catch { receipt = null; }
        try { review = entry.reviewJson ? JSON.parse(entry.reviewJson) : null; } catch { review = null; }
        if (receipt && !iso(receipt.createdAt) && receipt.created_at === undefined) {
          // Receipt JSON carries no submission time on some legacy rows;
          // the receipts table's created_at (epoch ms) is the record's own.
          const stamp = this.db.prepare("SELECT created_at AS createdAt FROM public_work_receipts WHERE receipt_id=?").get(entry.receiptId);
          if (stamp) receipt = { ...receipt, created_at: stamp.createdAt };
        }
        rows.push(...rowsFromPublicWork({ roomId, receipt, review }));
      }
    }
    // Bounty: one row per bounty carrying a verdict (see builder).
    if (this.hasTable("bounty_records") && this.store?.bountyEscrow) {
      for (const entry of this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? ORDER BY bounty_id").all(roomId)) {
        let bounty = null;
        try { bounty = this.store.bountyEscrow._viewBounty(entry, roomId); } catch { bounty = null; }
        if (bounty) rows.push(...rowsFromBounty({ roomId, bounty }));
      }
    } else if (this.hasTable("bounty_records")) {
      for (const entry of this.db.prepare("SELECT * FROM bounty_records WHERE room_id=? ORDER BY bounty_id").all(roomId)) {
        const bounty = {
          bountyId: entry.bounty_id, claimant: entry.claimant, verifier: entry.verifier, poster: entry.poster,
          disputeDecider: entry.dispute_decider ?? null, state: entry.state,
          createdAt: entry.created_at, updatedAt: entry.updated_at,
          stateChangedAt: isoFromMs(entry.state_changed_ms),
          rubric: { version: entry.rubric_version ?? null },
          attestation: entry.attestation_json ? JSON.parse(entry.attestation_json) : null,
          resolution: entry.resolution_json ? JSON.parse(entry.resolution_json) : null,
          evidence: entry.evidence_json ? JSON.parse(entry.evidence_json) : null,
        };
        rows.push(...rowsFromBounty({ roomId, bounty }));
      }
    }
    // Board: claims live in the durable work-claim registry
    // (server/work-claim-sqlite.mjs). A store without the registry
    // (a test double) falls back to the room projection's work items,
    // whose claim-shaped entries carry the same review/verification
    // fields.
    let boardItems = null;
    try { boardItems = typeof this.store?.workClaims?.list === "function" ? this.store.workClaims.list(roomId) : null; }
    catch { boardItems = null; }
    if (!Array.isArray(boardItems)) {
      try {
        const state = this.store?.room?.(roomId)?.state;
        boardItems = Object.values(state?.workItems ?? {});
      } catch { boardItems = []; }
    }
    for (const item of boardItems) rows.push(...rowsFromBoardClaim({ roomId, item }));
    rows.sort((a, b) => (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0));
    return rows;
  }

  // Owner-gated export. The caller (HTTP) has authenticated the member;
  // this enforces the owner gate, materialises the rows, and writes the
  // access-log export event BEFORE returning the payload — a failed log
  // write fails the export, mirroring the room export's discipline.
  // The room.exported room-log event is appended by the HTTP layer via
  // recordDecisionExport (history-visibility), which needs the caller's
  // session token; this method returns what that event must name.
  // Gate + materialise, without writing any audit record. The HTTP
  // layer writes both audit records (room.exported, then the access
  // log via recordExportAudit) from this exact payload before sending
  // it, so the audited row count is the sent row count.
  prepareExport(roomId, requesterId) {
    const state = this.store?.room?.(roomId)?.state;
    if (!state) fail(404, "room_not_found", "Room not found");
    if (requesterId !== state.room?.ownerId) fail(403, "owner_required", "Only the room owner can export decision rows");
    const rows = typeof this.store?.readTransaction === "function"
      ? this.store.readTransaction(() => this.collect(roomId))
      : this.collect(roomId);
    const generatedAt = new Date(typeof this.store?.now === "function" ? this.store.now() : Date.now()).toISOString();
    return Object.freeze({
      schema: DECISION_ROWS_SCHEMA,
      roomId, generatedAt, requestedBy: requesterId, rowCount: rows.length,
      fields: DECISION_ROW_FIELDS, rows,
    });
  }
  recordExportAudit(payload) {
    const audit = this.logAccess({ roomId: payload.roomId, readerId: payload.requestedBy, kind: "export", surface: "decision-rows",
      schemaVersion: DECISION_ROWS_SCHEMA, rowCount: payload.rowCount, at: payload.generatedAt });
    return Object.freeze({ ...payload, auditEventId: audit.id });
  }
  exportRoom(roomId, requesterId) {
    return this.recordExportAudit(this.prepareExport(roomId, requesterId));
  }
}
