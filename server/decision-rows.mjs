// Auditor-grade decision rows (#3616, accountability R-5/R-11).
//
// A versioned, stable-schema projection of the per-verdict records the room
// already keeps — public-work reviews, bounty verdicts/settlements, and
// board claim reviews — as NDJSON an independent auditor can consume
// without mining whole-store dumps or event bodies. This module is a pure
// read/projection: it never writes, never aggregates rows away (one row per
// verdict, never pre-aggregated counts), and never invents a field the
// underlying record does not carry (absent values are null).
//
// NEVER-COLLECT (R-5): the schema below is the whole field set. It carries
// no demographic or protected-class attribute, and none may be added to
// decision-rows/1 — the demographic join belongs to the deployer/auditor,
// who holds the subject-id mapping. A new field is a new schema version
// (decision-rows/2), never a silent widening of this one; the test suite
// pins the exact key set of every row.

export const DECISION_ROWS_SCHEMA = "decision-rows/1";

// Field definitions for decision-rows/1, in row order. `type` is the JSON
// type every row carries for the field; nullable fields may be null.
export const DECISION_ROW_FIELDS = Object.freeze([
  Object.freeze({ name: "schema", type: "string", definition: "Schema name + version; always \"decision-rows/1\" in this version." }),
  Object.freeze({ name: "rowId", type: "string", definition: "Stable per-verdict row id, unique within a room: <source prefix>:<subjectId>:<decisionKind>[:<verifierId>:<decidedAt>] for repeated-verdict sources." }),
  Object.freeze({ name: "roomId", type: "string", definition: "Room the verdict belongs to." }),
  Object.freeze({ name: "source", type: "string", definition: "Verdict source: \"public-work\" (public-work review), \"bounty\" (bounty verdict/settlement), or \"board-claim\" (board work-claim review/verification)." }),
  Object.freeze({ name: "decisionKind", type: "string", definition: "Which verdict on the source record this row projects: \"verification\", \"decision\", \"acceptance\", \"rejection\", \"dispute\", \"settlement\", or \"review\"." }),
  Object.freeze({ name: "subjectId", type: "string", definition: "Deployer-controlled id of the decided subject: the public-work receipt id, bounty id, or board claim id. The deployer owns the mapping from this id to any person; the platform stores no demographic attribute to join here." }),
  Object.freeze({ name: "rubricVersion", type: "string|null", definition: "Rubric/policy version the verdict ran under, as a string: the pinned bounty rubric version, the public-work receipt terms version, or the board claim review policy. Null when the source record carries no version." }),
  Object.freeze({ name: "rubricHash", type: "string|null", definition: "Hash of the pinned rubric the verdict cited, where the source records one (bounty verdicts); otherwise null." }),
  Object.freeze({ name: "outcome", type: "string", definition: "The verdict's own outcome vocabulary, unmodified: e.g. PASS/FAIL, accepted/rejected/revision_requested, the settlement kind, the dispute outcome, approve/changes_requested/comment, verified/self_attested." }),
  Object.freeze({ name: "accepted", type: "boolean|null", definition: "Normalised acceptance for rate computation: true for an accepting verdict, false for a rejecting verdict, null for verdicts that are neither (revision requested, comment, self-attested, split/partial settlement, automated record). Auditors compute acceptance rates from rows with accepted non-null, or from `outcome` directly." }),
  Object.freeze({ name: "criteriaSummary", type: "string|null", definition: "Short criteria summary from the verdict record: per-criterion citations (\"criterionId:verdict\"), executed-check results, or the recorded reason. Truncated to 500 characters." }),
  Object.freeze({ name: "decidedAt", type: "string", definition: "ISO timestamp of the verdict." }),
  Object.freeze({ name: "verifierId", type: "string|null", definition: "Member/lane id of the verifier, reviewer, acceptor, decider, or settler who rendered the verdict, as recorded. Null when the source record names none." }),
]);

export const DECISION_ROW_FIELD_NAMES = Object.freeze(DECISION_ROW_FIELDS.map(field => field.name));

const SUMMARY_MAX = 500;
const text = value => (typeof value === "string" && value.length > 0 ? value : null);
const summary = value => {
  const valueText = text(value);
  return valueText === null ? null : valueText.slice(0, SUMMARY_MAX);
};
const versionText = value => (value === null || value === undefined || value === "" ? null : String(value));
const citationsSummary = citations => (Array.isArray(citations) && citations.length > 0
  ? citations.map(citation => `${citation?.criterionId ?? "?"}:${citation?.verdict ?? "?"}`).join("; ").slice(0, SUMMARY_MAX)
  : null);

function row({ roomId, source, decisionKind, subjectId, rubricVersion = null, rubricHash = null,
  outcome, accepted, criteriaSummary = null, decidedAt, verifierId = null, rowSuffix = "" }) {
  return Object.freeze({
    schema: DECISION_ROWS_SCHEMA,
    rowId: `${source}:${subjectId}:${decisionKind}${rowSuffix}`,
    roomId, source, decisionKind, subjectId,
    rubricVersion: versionText(rubricVersion),
    rubricHash: text(rubricHash),
    outcome, accepted,
    criteriaSummary: summary(criteriaSummary),
    decidedAt, verifierId: text(verifierId),
  });
}

const ACCEPTED_BY_OUTCOME = new Map([
  ["accepted", true], ["approved", true], ["PASS", true], ["verified", true],
  ["approve", true], ["verified-complete", true], ["release", true],
  ["rejected", false], ["FAIL", false], ["refunded", false], ["changes_requested", false],
  ["failed", false], ["unverified", false], ["cancel", false],
]);
const acceptedFor = outcome => (ACCEPTED_BY_OUTCOME.has(outcome) ? ACCEPTED_BY_OUTCOME.get(outcome) : null);

// --- public-work reviews -------------------------------------------------
// Source record: public_work_reviews.state_json { verification, decision }
// plus the receipt's termsVersion (the policy version the review ran
// under). A review with neither verification nor decision is pending —
// no verdict exists, so it yields no row.
export function decisionRowsFromPublicWorkReview({ roomId, receiptId, state, termsVersion = null }) {
  if (!state || typeof state !== "object") return [];
  const rows = [];
  if (state.verification && text(state.verification.at)) {
    rows.push(row({
      roomId, source: "public-work", decisionKind: "verification", subjectId: receiptId,
      rubricVersion: termsVersion, outcome: String(state.verification.verdict ?? ""),
      accepted: acceptedFor(state.verification.verdict),
      criteriaSummary: state.verification.reason,
      decidedAt: state.verification.at, verifierId: state.verification.actorId,
    }));
  }
  if (state.decision && text(state.decision.at)) {
    rows.push(row({
      roomId, source: "public-work", decisionKind: "decision", subjectId: receiptId,
      rubricVersion: termsVersion, outcome: String(state.decision.decision ?? ""),
      accepted: acceptedFor(state.decision.decision),
      criteriaSummary: state.decision.reason,
      decidedAt: state.decision.at, verifierId: state.decision.actorId,
    }));
  }
  return rows;
}

// --- bounty verdicts / settlements ---------------------------------------
// Source record: one bounty_records row with parsed attestation /
// resolution. Each recorded verdict fact is its own row: the acceptance
// attestation, a rejection, a dispute ruling, and the free-miss settlement
// record. Automated non-verdicts (auto-approve, timeout) yield no row.
export function decisionRowsFromBountyRecord({ roomId, bountyId, attestation = null, resolution = null,
  rubricVersion = null, rubricHash = null, criteria = null, updatedAt = null }) {
  const rows = [];
  const version = attestation?.rubricVersion ?? rubricVersion;
  const hash = attestation?.rubricHash ?? rubricHash;
  if (attestation && Array.isArray(attestation.citations)) {
    rows.push(row({
      roomId, source: "bounty", decisionKind: "acceptance", subjectId: bountyId,
      rubricVersion: version, rubricHash: hash, outcome: "accepted", accepted: true,
      criteriaSummary: citationsSummary(attestation.citations) ?? criteria,
      decidedAt: text(attestation.recordedAt) ?? updatedAt, verifierId: attestation.recordedBy,
    }));
  }
  if (resolution?.kind === "rejected" && text(resolution.rejectedAt)) {
    rows.push(row({
      roomId, source: "bounty", decisionKind: "rejection", subjectId: bountyId,
      rubricVersion: version, rubricHash: hash, outcome: "rejected", accepted: false,
      criteriaSummary: resolution.reason,
      decidedAt: resolution.rejectedAt, verifierId: resolution.rejectedBy,
    }));
  }
  if (resolution && ["release", "split", "cancel"].includes(resolution.kind) && text(resolution.decidedAt)) {
    const outcome = text(resolution.outcome) ?? resolution.kind;
    rows.push(row({
      roomId, source: "bounty", decisionKind: "dispute", subjectId: bountyId,
      rubricVersion: resolution.rubricCheck?.rubricVersion ?? version,
      rubricHash: resolution.rubricCheck?.rubricHash ?? hash,
      outcome, accepted: outcome === "split" || resolution.kind === "split" ? null : acceptedFor(resolution.kind),
      criteriaSummary: citationsSummary(resolution.rubricCheck?.citations) ?? `dispute ${outcome}`,
      decidedAt: resolution.decidedAt, verifierId: resolution.rubricCheck?.by,
    }));
  }
  const settlement = resolution?.settlement;
  if (settlement && text(settlement.settledAt)) {
    rows.push(row({
      roomId, source: "bounty", decisionKind: "settlement", subjectId: bountyId,
      rubricVersion: version, rubricHash: hash,
      outcome: String(settlement.kind ?? ""), accepted: acceptedFor(settlement.kind),
      criteriaSummary: settlement.reason,
      decidedAt: settlement.settledAt, verifierId: settlement.settledBy?.id,
    }));
  } else if (resolution?.kind === "unverified" && text(resolution.settledAt)) {
    rows.push(row({
      roomId, source: "bounty", decisionKind: "settlement", subjectId: bountyId,
      rubricVersion: version, rubricHash: hash, outcome: "unverified", accepted: false,
      decidedAt: resolution.settledAt,
    }));
  }
  return rows;
}

// --- board claim reviews ---------------------------------------------------
// Source record: one work_claims item. Each recorded review is a verdict
// row; the verification fact is a row of its own. The claim's reviewPolicy
// is its policy version.
export function decisionRowsFromClaimItem({ roomId, item }) {
  if (!item || typeof item !== "object" || typeof item.id !== "string") return [];
  const rows = [];
  for (const review of Array.isArray(item.reviews) ? item.reviews : []) {
    if (!review || !text(review.at) || !text(review.memberId)) continue;
    rows.push(row({
      roomId, source: "board-claim", decisionKind: "review", subjectId: item.id,
      rubricVersion: item.reviewPolicy, outcome: String(review.verdict ?? ""),
      accepted: acceptedFor(review.verdict), criteriaSummary: review.summary,
      decidedAt: review.at, verifierId: review.memberId,
      rowSuffix: `:${review.memberId}:${review.at}`,
    }));
  }
  const verification = item.verification;
  if (verification && text(verification.at)) {
    const executed = Array.isArray(verification.executedChecks) && verification.executedChecks.length > 0
      ? verification.executedChecks.map(check => `${check?.name ?? "?"}:${check?.result ?? "?"}`).join("; ")
      : null;
    const deliveryCriteria = Array.isArray(item.delivery?.criteria) && item.delivery.criteria.length > 0
      ? item.delivery.criteria.map(entry => `${entry?.criterion ?? "?"}:${entry?.status ?? "?"}`).join("; ")
      : null;
    rows.push(row({
      roomId, source: "board-claim", decisionKind: "verification", subjectId: item.id,
      rubricVersion: item.reviewPolicy, outcome: String(verification.state ?? ""),
      accepted: acceptedFor(verification.state), criteriaSummary: executed ?? deliveryCriteria,
      decidedAt: verification.at, verifierId: verification.by,
    }));
  }
  return rows;
}

// --- collection over the store DB -----------------------------------------
const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const parseJson = value => {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
};
// work_claims rows ride the persisted-row envelope ({ v, kind, data });
// legacy rows are the bare item. Unwrap without dropping fields.
const claimItemOf = textValue => {
  const parsed = parseJson(textValue);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return (typeof parsed.v === "number" && parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data))
    ? parsed.data : parsed;
};

// One row per verdict across the three sources, in a stable order
// (decidedAt, then rowId). Tables a deployment has not created yet simply
// contribute no rows.
export function collectDecisionRows(db, roomId) {
  const rows = [];
  if (hasTable(db, "public_work_reviews")) {
    const records = hasTable(db, "public_work_receipts")
      ? db.prepare(`SELECT pr.receipt_id AS receipt_id, pr.state_json AS state_json, r.receipt_json AS receipt_json
          FROM public_work_reviews pr LEFT JOIN public_work_receipts r ON r.receipt_id = pr.receipt_id
          WHERE pr.room_id = ? ORDER BY pr.receipt_id`).all(roomId)
      : db.prepare("SELECT receipt_id, state_json, NULL AS receipt_json FROM public_work_reviews WHERE room_id = ? ORDER BY receipt_id").all(roomId);
    for (const record of records) {
      const receipt = parseJson(record.receipt_json);
      rows.push(...decisionRowsFromPublicWorkReview({
        roomId, receiptId: record.receipt_id,
        state: parseJson(record.state_json), termsVersion: receipt?.termsVersion ?? null,
      }));
    }
  }
  if (hasTable(db, "bounty_records")) {
    const records = db.prepare(`SELECT bounty_id, criteria, attestation_json, resolution_json,
        rubric_version, rubric_hash, updated_at FROM bounty_records WHERE room_id = ? ORDER BY bounty_id`).all(roomId);
    for (const record of records) {
      rows.push(...decisionRowsFromBountyRecord({
        roomId, bountyId: record.bounty_id,
        attestation: parseJson(record.attestation_json), resolution: parseJson(record.resolution_json),
        rubricVersion: record.rubric_version, rubricHash: record.rubric_hash,
        criteria: record.criteria, updatedAt: record.updated_at,
      }));
    }
  }
  if (hasTable(db, "work_claims")) {
    const records = db.prepare("SELECT claim_id, item_json FROM work_claims WHERE room_id = ? ORDER BY claim_id").all(roomId);
    for (const record of records) {
      const item = claimItemOf(record.item_json);
      if (item) rows.push(...decisionRowsFromClaimItem({ roomId, item }));
    }
  }
  rows.sort((a, b) => (a.decidedAt < b.decidedAt ? -1 : a.decidedAt > b.decidedAt ? 1
    : a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0));
  return rows;
}

// The export document: one header line naming the schema, the room, the
// export time and the requester, then one row per line. An auditor reads
// the rows from this text alone — no other store access.
export function decisionRowsExportText(db, roomId, { exportedAt, requester } = {}) {
  const rows = collectDecisionRows(db, roomId);
  const header = {
    kind: "decision-rows", schema: DECISION_ROWS_SCHEMA, version: 1, roomId,
    exportedAt: exportedAt ?? new Date().toISOString(), requester: requester ?? null, rows: rows.length,
  };
  return { header, rows, text: [JSON.stringify(header), ...rows.map(entry => JSON.stringify(entry))].join("\n") + "\n" };
}

// The filed acceptance, as a reusable auditor computation: acceptance
// rates by rubric/policy version from decision rows alone. Rows whose
// accepted is null are counted as decisions but excluded from the rate.
export function acceptanceRatesByRubricVersion(rows) {
  const byVersion = new Map();
  for (const entry of rows ?? []) {
    const key = entry?.rubricVersion ?? "unversioned";
    const bucket = byVersion.get(key) ?? { rubricVersion: key, decisions: 0, accepted: 0, rejected: 0, acceptanceRate: null };
    bucket.decisions += 1;
    if (entry?.accepted === true) bucket.accepted += 1;
    else if (entry?.accepted === false) bucket.rejected += 1;
    byVersion.set(key, bucket);
  }
  for (const bucket of byVersion.values()) {
    const judged = bucket.accepted + bucket.rejected;
    bucket.acceptanceRate = judged > 0 ? bucket.accepted / judged : null;
  }
  return [...byVersion.values()].sort((a, b) => (a.rubricVersion < b.rubricVersion ? -1 : 1));
}
