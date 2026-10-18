// Work-episode extract assembler (data programme W2, capture step 1).
//
// Reads a trailer-verified whole-store snapshot (the NDJSON stream
// server/room-export.mjs produces) and assembles canonical work
// episodes — task -> claim -> delivery -> verdict -> settlement ->
// dispute, joined on ids that already exist — as `work-episode/1`
// records (docs/WORK-EPISODES.md). The journal/store stays the only
// writer: this module is a pure read-side transform over a frozen
// snapshot. It never queries the serving store, never writes a table,
// and emits rows only (internal/auditor posture, raw ids — disclosure
// anonymisation is a later pipeline step, W4).
//
// Verdicts inside an episode are decision-rows/1 rows. The row
// semantics are the ones docs/DECISION-ROWS.md (#4051) pins; the three
// builders below are mirrored from server/decision-rows.mjs
// @ ebd5e5f8a over snapshot rows (that module reads a live store; a
// snapshot has no store). PARITY OBLIGATION: when #4051 lands, FINISH
// swaps the mirrored builders for the imported ones and diffs outputs
// over one snapshot — the builders' outputs are pinned by this
// module's tests until then. Criteria outcomes (#4056) ride inside the
// verdict entries as `criteriaOutcomes` when the underlying record
// carries them (attestation citations, executed checks); the field is
// null, never absent, when the record carries none.
//
// Provenance (#3612, PR #4041) is pinned to #4041's placement: stamps
// are carried VERBATIM from the record that bears them (verdict
// attestation/resolution, submission evidence, public-work receipt,
// review state, or a bounty_journal leg's provenance_json — a nullable
// column outside the journal hash core). A stamp is never
// reconstructed, guessed, or backfilled; records written before the
// stamps existed assemble with an all-null provenance and a null
// provenanceSource.
//
// Integrity: the snapshot is refused unless its trailer verifies
// (event-log digest + per-table content digests, via the exporter's
// own helpers). The bounty_journal hash chain is additionally
// re-verified entry by entry during ingest (GQ-1): a chain break
// aborts the run unless the caller explicitly allows it, in which case
// the break is named in the report and every affected settlement is
// still emitted — labelled by the report, never silently trusted.
//
// Incremental operation: assembly is deterministic per surface over
// that surface's source tables. Given the state file a previous run
// wrote (per-table trailer digests + per-episode content hashes), a
// run reassembles only surfaces whose source tables changed, and
// emits only episodes that are new or whose content changed. The
// union of emitted + carried episodes is byte-identical to a full
// run's episode set — the tests pin that property.
//
// Measurement is part of the design, not a report afterthought: every
// run emits the data programme's trigger counters (SCALE-READINESS
// R3/B7) alongside the episode counts — settled outcomes, verified
// settled outcomes, the self-dealing-excluded count (rules SD-1..3),
// the DISTINCT-OPERATOR count the trigger actually fires on, and the
// non-fleet-party counts (null unless a fleet roster is supplied; a
// snapshot contains no roster and the assembler does not invent one).

import { createHash } from "node:crypto";
import { createTableDigests, verifyTrailer, contentVerificationLevel, assertTrailerShape } from "./room-export.mjs";
import { journalEntryHash } from "./bounty-escrow.mjs";
import { canonicalJson } from "../src/audit-receipts.mjs";

export const EPISODE_SCHEMA = "work-episode/1";
export const EXTRACT_STATE_VERSION = 1;

const sha256Hex = value => createHash("sha256").update(value, "utf8").digest("hex");
const str = value => (typeof value === "string" && value.length > 0 ? value : null);
const iso = value => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null);
const isoFromMs = value => (Number.isSafeInteger(value) ? new Date(value).toISOString() : null);
const parseJson = (text, fallback = null) => {
  if (typeof text !== "string") return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
};
const bounded = (value, max = 500) => {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim().replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

// --- Provenance stamps (#4041 placement) ----------------------------------

// The full stamp as stored. Facts (sessionInstanceId,
// authorizingPrincipalId) were server-derived at write time; the
// claimed* triple is the producing runtime's self-report, pinned at
// write time — never a platform attestation. Malformed stamps read as
// absent here and are counted by the caller (counted, never repaired).
export function stampOf(...candidates) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const stamp = candidate.provenance && typeof candidate.provenance === "object" && !Array.isArray(candidate.provenance)
      ? candidate.provenance
      : (typeof candidate.sessionInstanceId === "string" || typeof candidate.authorizingPrincipalId === "string"
        || typeof candidate.claimedModelVersion === "string" ? candidate : null);
    if (!stamp) continue;
    const out = {
      sessionInstanceId: str(stamp.sessionInstanceId),
      authorizingPrincipalId: str(stamp.authorizingPrincipalId),
      claimedModelVersion: str(stamp.claimedModelVersion),
      claimedHarnessVersion: str(stamp.claimedHarnessVersion),
      claimedEnvironment: str(stamp.claimedEnvironment),
    };
    if (out.sessionInstanceId || out.authorizingPrincipalId || out.claimedModelVersion
      || out.claimedHarnessVersion || out.claimedEnvironment) return Object.freeze(out);
  }
  return null;
}

const EMPTY_PROVENANCE = Object.freeze({
  sessionInstanceId: null, authorizingPrincipalId: null,
  claimedModelVersion: null, claimedHarnessVersion: null, claimedEnvironment: null,
});

// decision-rows/1 flattens exactly three provenance fields onto a row.
// Mirrored from server/decision-rows.mjs provenanceFields @ ebd5e5f8a.
function provenanceFields(...candidates) {
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

// --- decision-rows/1 verdict builders (mirrored, see header) ---------------

const DECISION_ROW_FIELD_NAMES = Object.freeze([
  "schema", "rowId", "roomId", "surface", "recordId", "subjectId", "decisionKind",
  "outcome", "accepted", "rubricVersion", "criteriaSummary", "verifierId",
  "decidedAt", "submittedAt", "sessionInstanceId", "authorizingPrincipalId", "claimedModelVersion",
]);

function decisionRow(base, criteriaOutcomes = null) {
  const out = {};
  for (const name of DECISION_ROW_FIELD_NAMES) out[name] = base[name] ?? null;
  out.schema = "decision-rows/1";
  out.criteriaOutcomes = criteriaOutcomes;
  return Object.freeze(out);
}

const citationOutcomes = attestation => (attestation && Array.isArray(attestation.citations)
  ? attestation.citations.filter(c => c && typeof c.criterionId === "string")
    .map(c => Object.freeze({ criterionId: c.criterionId, verdict: c.verdict ?? null }))
  : null);
const checkOutcomes = verification => (verification && Array.isArray(verification.executedChecks)
  ? verification.executedChecks.filter(c => c && typeof c.name === "string")
    .map(c => Object.freeze({ name: c.name, result: c.result ?? null }))
  : null);
const checksSummary = verification => (verification && Array.isArray(verification.executedChecks)
  ? verification.executedChecks.filter(c => c && typeof c.name === "string").map(c => `${c.name}:${c.result ?? "?"}`).join(", ") || null
  : null);

// One public-work receipt + its review record (parsed state_json, or
// null when never reviewed). Mirrors rowsFromPublicWork @ ebd5e5f8a.
export function verdictRowsFromPublicWork({ roomId, receipt, review }) {
  if (!receipt || typeof receipt !== "object") return [];
  const subjectId = str(receipt.identityId);
  const submittedAt = iso(receipt.createdAt) ?? isoFromMs(receipt.created_at);
  const rubricVersion = receipt.termsVersion === undefined || receipt.termsVersion === null ? null : String(receipt.termsVersion);
  const recordId = str(receipt.receiptId);
  if (!recordId || !review || typeof review !== "object") return [];
  if (review.decision && typeof review.decision === "object") {
    const decision = review.decision;
    const outcome = str(decision.decision) ?? "unknown";
    return [decisionRow({
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
    return [decisionRow({
      rowId: `public-work:${recordId}:verification`,
      roomId, surface: "public-work", recordId, subjectId,
      decisionKind: "verification", outcome, accepted: null,
      rubricVersion,
      criteriaSummary: bounded(checksSummary(verification) ?? verification.reason),
      verifierId: str(verification.actorId),
      decidedAt: iso(verification.at), submittedAt,
      ...provenanceFields(verification, review),
    }, checkOutcomes(verification))];
  }
  return [];
}

// One bounty view (see bountyViewOf for the snapshot-row mapping).
// Mirrors rowsFromBounty @ ebd5e5f8a, branch order included.
export function verdictRowsFromBounty({ roomId, bounty }) {
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
    ? attestation.citations.filter(c => c && typeof c.criterionId === "string").map(c => `${c.criterionId}:${c.verdict ?? "?"}`).join(", ") || null
    : null;

  if (resolution && resolution.kind === "rejected") {
    return [decisionRow({
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
    const outcomeText = str(resolution.outcome) ?? str(resolution.kind) ?? "decided";
    const accepted = outcomeText === "upheld" || outcomeText === "release" || outcomeText === "split" ? true
      : outcomeText === "overturned" || outcomeText === "cancel" ? false : null;
    return [decisionRow({
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
    return [decisionRow({
      rowId: `bounty:${recordId}:acceptance`,
      roomId, surface: "bounty", recordId, subjectId,
      decisionKind: "acceptance", outcome: "accepted", accepted: true,
      rubricVersion: attestation && attestation.rubricVersion !== undefined && attestation.rubricVersion !== null
        ? String(attestation.rubricVersion) : rubricVersion,
      criteriaSummary: bounded(citations),
      verifierId: str(attestation?.recordedBy) ?? str(bounty.verifier) ?? str(bounty.poster),
      decidedAt: iso(attestation?.recordedAt) ?? stateChangedAt, submittedAt,
      ...provenanceFields(attestation, bounty.evidence),
    }, citationOutcomes(attestation))];
  }
  if (bounty.state === "refunded") {
    return [decisionRow({
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
    return [decisionRow({
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

// One board work-claim item (parsed item_json). Mirrors
// rowsFromBoardClaim @ ebd5e5f8a.
export function verdictRowsFromBoardClaim({ roomId, item }) {
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
    rows.push(decisionRow({
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
    rows.push(decisionRow({
      rowId: `board:${recordId}:acceptance`,
      roomId, surface: "board", recordId, subjectId,
      decisionKind: "acceptance",
      outcome: state === "changes_requested" ? "changes_requested" : "accepted",
      accepted: state === "verified" || state === "self_attested" ? true : state === "changes_requested" ? false : null,
      rubricVersion, criteriaSummary: bounded(checksSummary(verification)),
      verifierId: str(verification.by) ?? str(item.reviewedBy),
      decidedAt: iso(verification.at), submittedAt,
      ...provenanceFields(verification),
    }, checkOutcomes(verification)));
  }
  return rows;
}

// --- Snapshot ingest --------------------------------------------------------

const RETAINED_TABLES = new Set([
  "bounty_records", "bounty_events", "bounty_journal", "bounty_disputes",
  "project_offers", "public_work_tasks", "public_work_receipts",
  "public_work_reviews", "public_work_settlements", "work_claims",
]);

// Source tables per surface, cross-surface dependencies included: a
// public-work episode's settlement is read off the linked bounty, so
// the bounty money tables are public-work inputs too. A surface is
// reassembled when ANY of its tables' trailer digests moved.
export const SURFACE_TABLES = Object.freeze({
  bounty: Object.freeze(["bounty_records", "bounty_events", "bounty_journal", "bounty_disputes"]),
  "public-work": Object.freeze(["project_offers", "public_work_tasks", "public_work_receipts",
    "public_work_reviews", "public_work_settlements", "bounty_records", "bounty_journal"]),
  board: Object.freeze(["work_claims"]),
});

// Project a journal row down to what assembly joins on, AFTER the
// chain check has read the full row. Keeps a 100k-bounty snapshot's
// legs (the widest retained table) as small as the join allows.
const projectJournalLeg = row => ({
  seq: row.seq, entry_id: row.entry_id, account_id: row.account_id,
  kind: row.kind, bounty_id: row.bounty_id ?? null,
  amount: row.amount, receipt_id: row.receipt_id ?? null,
  provenance_json: row.provenance_json ?? null,
});

async function* lineStream(source) {
  if (typeof source === "string") { yield* source.split("\n"); return; }
  if (Array.isArray(source)) { yield* source; return; }
  if (source && (typeof source[Symbol.asyncIterator] === "function" || typeof source[Symbol.iterator] === "function")) {
    yield* source; return;
  }
  throw new Error("assembleWorkEpisodes needs snapshot lines (string, array, or async iterable)");
}

// Single streaming pass: trailer digests accumulate over EVERY row
// exactly as the exporter accumulated them; only episode-source rows
// are retained (events as bare tuples); journal legs are chain-checked
// in stream order (the export dumps rowid order, which is seq order
// for the AUTOINCREMENT journal) and then projected.
async function ingest(source) {
  const digests = createTableDigests();
  const retained = new Map([...RETAINED_TABLES].map(table => [table, []]));
  const eventTuples = [];
  const chainHeads = new Map();
  let watermark = null, trailer = null, malformedStamps = 0;
  let chain = { checked: 0, ok: true, break: null };

  for await (const rawLine of lineStream(source)) {
    const line = typeof rawLine === "string" ? rawLine : String(rawLine);
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { throw new Error("Snapshot line is not JSON"); }
    if (record?.kind === "watermark") {
      if (watermark) throw new Error("Snapshot has more than one watermark");
      watermark = record;
      continue;
    }
    if (record?.kind === "trailer") {
      if (trailer) throw new Error("Snapshot has more than one trailer");
      assertTrailerShape(record);
      trailer = record;
      continue;
    }
    if (typeof record?.table !== "string" || !record.row || typeof record.row !== "object" || Array.isArray(record.row))
      throw new Error("Snapshot line is not a table row");
    const { table, row } = record;
    digests.add(table, row);
    if (table === "events") { eventTuples.push({ room_id: row.room_id, sequence: row.sequence, id: row.id }); continue; }
    if (table === "bounty_journal") {
      chain.checked += 1;
      if (chain.ok) {
        const key = `${row.room_id}\n${row.account_id}`;
        const head = chainHeads.get(key);
        let reason = null;
        try { if (journalEntryHash(row) !== row.hash) reason = "entry hash does not recompute"; }
        catch { reason = "entry hash cannot be recomputed"; }
        if (!reason && head !== undefined && row.prev_hash !== head) reason = "prev_hash does not continue the account chain";
        if (reason) chain = { ...chain, ok: false, break: { seq: row.seq, entryId: row.entry_id, reason } };
        else chainHeads.set(key, row.hash);
      }
      retained.get(table).push(projectJournalLeg(row));
      continue;
    }
    if (row.provenance_json != null && parseJson(row.provenance_json) === null && typeof row.provenance_json === "string" && row.provenance_json.trim() !== "null")
      malformedStamps += 1;
    if (retained.has(table)) retained.get(table).push(row);
  }
  if (!watermark || watermark.version !== 1) throw new Error("Snapshot is missing its watermark");
  if (!trailer) throw new Error("Snapshot has no trailer: not trailer-verified, refusing to assemble episodes");
  verifyTrailer(trailer, new Map([["events", eventTuples]]));
  const tableDigests = digests.finish();
  const verification = contentVerificationLevel(trailer, tableDigests);
  return { watermark, trailer, verification, retained, chain, malformedStamps, tableDigests };
}

// --- Surface views ------------------------------------------------------------

// Raw bounty_records row -> the view shape the verdict builder and the
// episode assembler read. Mirrors the raw-row fallback mapping in
// DecisionRows.collect @ ebd5e5f8a.
function bountyViewOf(row) {
  return {
    bountyId: row.bounty_id, roomId: row.room_id, title: row.title ?? null,
    criteria: row.criteria ?? null, amountMillis: row.amount_millis ?? null,
    poster: row.poster ?? null, verifier: row.verifier ?? null,
    disputeDecider: row.dispute_decider ?? null, claimant: row.claimant ?? null,
    state: row.state ?? null, createdAt: row.created_at ?? null, updatedAt: row.updated_at ?? null,
    stateChangedAt: isoFromMs(row.state_changed_ms),
    deadlineAt: isoFromMs(row.deadline_ms), challengeEndsAt: isoFromMs(row.challenge_ends_ms),
    disputeId: row.dispute_id ?? null, disputeOpenedAt: isoFromMs(row.dispute_opened_ms),
    evidence: parseJson(row.evidence_json), attestation: parseJson(row.attestation_json),
    resolution: parseJson(row.resolution_json),
    rubric: {
      version: row.rubric_version ?? null, hash: row.rubric_hash ?? null,
      json: parseJson(row.rubric_json),
    },
    submissionHash: row.submission_hash ?? null,
  };
}

const byKey = (rows, key) => {
  const map = new Map();
  for (const row of rows) if (row && row[key] != null) map.set(row[key], row);
  return map;
};
const groupBy = (rows, key) => {
  const map = new Map();
  for (const row of rows) {
    if (!row || row[key] == null) continue;
    const list = map.get(row[key]) ?? [];
    list.push(row);
    map.set(row[key], list);
  }
  for (const list of map.values()) list.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return map;
};

function settlementOf({ legs, claimantRef, outcome, bountyId = null }) {
  if (!legs || !legs.length) return null;
  let netMillis = 0, payoutMillis = 0, feeMillis = 0;
  const receiptIds = [];
  for (const leg of legs) {
    if (claimantRef && leg.account_id === claimantRef) netMillis += leg.amount;
    if (leg.kind === "payout" && leg.amount > 0) payoutMillis += leg.amount;
    if (leg.kind === "fee" && leg.amount > 0) feeMillis += leg.amount;
    if (leg.receipt_id && !receiptIds.includes(leg.receipt_id)) receiptIds.push(leg.receipt_id);
  }
  return Object.freeze({
    ...(bountyId ? { bountyId } : {}),
    journalEntryIds: Object.freeze(legs.map(leg => leg.entry_id)),
    netMillis, payoutMillis, feeMillis,
    outcome: outcome ?? null,
    receiptIds: Object.freeze(receiptIds),
  });
}

function episodeBase({ surface, recordId, roomId }) {
  return {
    schema: EPISODE_SCHEMA,
    episodeId: `${surface}:${recordId}`,
    roomId: roomId ?? null,
    surface,
    task: null, claim: null, delivery: null,
    verdicts: Object.freeze([]),
    settlement: null, dispute: null,
    provenance: EMPTY_PROVENANCE, provenanceSource: null,
    outcomeLabel: null,
    retentionClass: "work",
    schemaVersions: Object.freeze({ decisionRows: "decision-rows/1", episode: EPISODE_SCHEMA }),
    assembly: null,
  };
}

function finishEpisode(episode, missing, selfDealing = []) {
  episode.assembly = Object.freeze({
    complete: missing.length === 0, missing: Object.freeze(missing),
    selfDealing: Object.freeze(selfDealing),
  });
  if (episode.verdicts.length || episode.settlement) episode.retentionClass = "decision";
  return Object.freeze(episode);
}

// Self-dealing screen (SCALE-READINESS R3/B7). The data trigger counts
// DISTINCT OPERATORS over verified settled outcomes with self-dealing
// excluded, because a two-identity ring can manufacture a "verified
// settled outcome" for ~1% of the award in fees. Only traces the
// snapshot itself carries are screened — three rules, all named, all
// computed from the bounty record and its journal legs:
//   SD-1  claimant ref == poster ref (same named party both sides);
//   SD-2  a payout leg credits an account that funded the bounty (an
//         escrow-lock debit leg's account) — the money round-trips;
//   SD-3  the claimant ref IS a funding account (lane/account alias of
//         SD-1 where the record's names differ).
// A ring that keeps poster, claimant, funding account, and payout
// account four ways distinct leaves no trace in the store and is NOT
// claimed detectable here; the counters in the extract report state
// exactly these rules so the trigger never rests on a stronger claim
// than the data supports.
export function selfDealingRules({ poster = null, claimant = null, legs = [] }) {
  const fundingAccounts = new Set();
  const payoutAccounts = new Set();
  for (const leg of legs) {
    if (leg.kind === "escrow-lock" && leg.amount < 0) fundingAccounts.add(leg.account_id);
    if (leg.kind === "payout" && leg.amount > 0) payoutAccounts.add(leg.account_id);
  }
  const rules = [];
  if (claimant && poster && claimant === poster) rules.push("SD-1");
  for (const account of payoutAccounts) if (fundingAccounts.has(account)) { rules.push("SD-2"); break; }
  if (claimant && fundingAccounts.has(claimant)) rules.push("SD-3");
  return rules;
}

// --- Bounty episodes -----------------------------------------------------------

function bountyEpisodes(retained, orphans) {
  const records = retained.get("bounty_records");
  const eventsByBounty = groupBy(retained.get("bounty_events"), "bounty_id");
  const legsByBounty = groupBy(retained.get("bounty_journal"), "bounty_id");
  const disputes = byKey(retained.get("bounty_disputes"), "dispute_id");
  // Settlement-mirror bounties (paid public-work) carry criteria TEXT
  // but no rubric pin of their own — public-work-settlement's
  // postBounty passes title + criteria only. Their pin is the linked
  // offer's terms: task row's terms_version, joined via
  // public_work_settlements. The criteriaPin check below credits that
  // pin for mirrors and counts how many settled episodes relied on it
  // (stats.mirrorTermsPinned) so the substitution is never silent.
  const tasksByOffer = byKey(retained.get("public_work_tasks"), "offer_id");
  const mirrorTerms = new Map();
  for (const link of retained.get("public_work_settlements")) {
    if (!link?.bounty_id) continue;
    const task = tasksByOffer.get(link.offer_id);
    mirrorTerms.set(link.bounty_id, task ? task.terms_version : null);
  }
  const recordIds = new Set(records.map(row => row.bounty_id));
  for (const bountyId of legsByBounty.keys())
    if (!recordIds.has(bountyId)) orphans.push({ kind: "journal-legs", id: bountyId, reason: "journal legs name a bounty with no bounty_records row" });

  const episodes = [];
  const settledDetail = [];
  const stats = { records: records.length, settled: 0, settledComplete: 0, mirrorTermsPinned: 0, missingReasons: {} };
  for (const row of [...records].sort((a, b) => (a.bounty_id < b.bounty_id ? -1 : 1))) {
    const view = bountyViewOf(row);
    const episode = episodeBase({ surface: "bounty", recordId: view.bountyId, roomId: view.roomId });
    episode.task = Object.freeze({
      specHash: view.criteria ? sha256Hex(view.criteria) : null,
      criteriaHash: view.rubric.hash ?? null,
      rubricVersion: view.rubric.version != null ? String(view.rubric.version) : null,
      rewardMillis: view.amountMillis, termsVersion: null,
    });
    const events = eventsByBounty.get(view.bountyId) ?? [];
    const atOf = state => { const hit = events.find(e => e.after_state === state); return hit ? iso(hit.at) : null; };
    if (view.claimant) {
      episode.claim = Object.freeze({
        claimantRef: view.claimant, claimedAt: atOf("claimed"),
        leaseHours: null, deliveryGeneration: null,
      });
    }
    const evidence = view.evidence && typeof view.evidence === "object" ? view.evidence : null;
    if (view.submissionHash || evidence) {
      episode.delivery = Object.freeze({
        artefactHash: view.submissionHash ?? str(evidence?.submissionHash) ?? str(evidence?.artifactSha256) ?? str(evidence?.hash),
        artefactKind: "evidence",
        submittedAt: atOf("submitted") ?? iso(evidence?.submittedAt) ?? null,
        prUrl: str(evidence?.prUrl) ?? str(evidence?.url),
      });
    }
    episode.verdicts = Object.freeze(verdictRowsFromBounty({ roomId: view.roomId, bounty: view }));
    const legs = legsByBounty.get(view.bountyId) ?? [];
    episode.settlement = settlementOf({ legs, claimantRef: view.claimant, outcome: view.state });
    if (view.disputeId || disputes.has(view.disputeId)) {
      const body = disputes.has(view.disputeId) ? parseJson(disputes.get(view.disputeId).body) : null;
      const resolution = view.resolution && typeof view.resolution === "object" ? view.resolution : null;
      episode.dispute = Object.freeze({
        disputeId: view.disputeId ?? str(body?.disputeId) ?? str(body?.id),
        outcome: str(resolution?.outcome) ?? str(body?.outcome),
        reasonCodes: Object.freeze(resolution?.reasonCodes ?? body?.reasonCodes ?? []),
        deciderRef: str(resolution?.decidedBy) ?? str(body?.decider) ?? str(body?.deciderId) ?? view.disputeDecider,
        openedAt: view.disputeOpenedAt ?? iso(body?.openedAt),
        resolvedAt: iso(resolution?.decidedAt) ?? iso(resolution?.settledAt) ?? iso(body?.resolvedAt) ?? iso(body?.decidedAt),
      });
    }
    // Provenance precedence: the verdict's stamp, then the submission
    // stamp, then a settlement leg's stamp (#4041 placements).
    let stamp = stampOf(view.attestation, view.resolution);
    let source = stamp ? "verdict" : null;
    if (!stamp) { stamp = stampOf(evidence); source = stamp ? "submission" : null; }
    if (!stamp) {
      for (const leg of legs) {
        const parsed = leg.provenance_json ? parseJson(leg.provenance_json) : null;
        if (parsed) { stamp = stampOf(parsed); if (stamp) { source = "settlement"; break; } }
      }
    }
    if (stamp) { episode.provenance = stamp; episode.provenanceSource = source; }

    const missing = [];
    const dealing = selfDealingRules({ poster: view.poster, claimant: view.claimant, legs });
    if (view.state === "paid") {
      stats.settled += 1;
      const ownPin = Boolean(episode.task.criteriaHash) || episode.task.rubricVersion != null;
      const mirrorPin = mirrorTerms.get(view.bountyId) != null;
      if (!ownPin && !mirrorPin) missing.push("criteriaPin");
      else if (!ownPin && mirrorPin) stats.mirrorTermsPinned += 1;
      if (!episode.claim) missing.push("claimant");
      if (!episode.delivery) missing.push("delivery");
      if (!episode.verdicts.some(v => v.decisionKind === "acceptance" && v.accepted === true)) missing.push("verdict");
      if (!episode.settlement || !(episode.settlement.payoutMillis > 0)) missing.push("settlement");
      if (!missing.length) stats.settledComplete += 1;
      for (const reason of missing) stats.missingReasons[reason] = (stats.missingReasons[reason] ?? 0) + 1;
      settledDetail.push({
        bountyId: view.bountyId, poster: view.poster, claimant: view.claimant,
        complete: missing.length === 0, selfDealing: dealing.length > 0,
      });
    }
    episodes.push(finishEpisode(episode, missing, dealing));
  }
  return { episodes, stats, settledDetail };
}

// --- Public-work episodes ---------------------------------------------------------

function publicWorkEpisodes(retained, orphans) {
  const offers = byKey(retained.get("project_offers"), "offer_id");
  const tasks = byKey(retained.get("public_work_tasks"), "offer_id");
  const settlements = byKey(retained.get("public_work_settlements"), "offer_id");
  const reviews = byKey(retained.get("public_work_reviews"), "receipt_id");
  const records = byKey(retained.get("bounty_records"), "bounty_id");
  const legsByBounty = groupBy(retained.get("bounty_journal"), "bounty_id");
  const receipts = [...retained.get("public_work_receipts")].sort((a, b) => (a.receipt_id < b.receipt_id ? -1 : 1));
  const receiptIds = new Set(receipts.map(row => row.receipt_id));
  for (const receiptId of reviews.keys())
    if (!receiptIds.has(receiptId)) orphans.push({ kind: "review", id: receiptId, reason: "public_work_reviews row names a receipt with no public_work_receipts row" });

  const episodes = [];
  const stats = { records: receipts.length, complete: 0, missingReasons: {} };
  for (const row of receipts) {
    const receiptObj = parseJson(row.receipt_json) ?? {};
    const receipt = {
      ...receiptObj,
      receiptId: str(receiptObj.receiptId) ?? row.receipt_id,
      identityId: str(receiptObj.identityId) ?? row.identity_id ?? null,
      termsVersion: receiptObj.termsVersion ?? null,
      created_at: row.created_at,
    };
    const task = tasks.get(row.offer_id) ?? null;
    const offer = offers.get(row.offer_id) ?? null;
    const roomId = task?.room_id ?? offer?.room_id ?? null;
    const episode = episodeBase({ surface: "public-work", recordId: row.receipt_id, roomId });
    const terms = offer ? parseJson(offer.terms) : null;
    const reward = terms && typeof terms === "object" ? terms.reward : null;
    episode.task = Object.freeze({
      specHash: terms ? sha256Hex(canonicalJson(terms)) : null,
      criteriaHash: str(terms?.criteriaHash),
      rubricVersion: task ? String(task.terms_version) : (receipt.termsVersion != null ? String(receipt.termsVersion) : null),
      rewardMillis: reward && reward.unit === "credit" && Number.isSafeInteger(Number(reward.amountMinor)) ? Number(reward.amountMinor) : null,
      termsVersion: task ? task.terms_version : (receipt.termsVersion ?? null),
    });
    episode.claim = Object.freeze({
      claimantRef: receipt.identityId, claimedAt: null, leaseHours: null,
      deliveryGeneration: Number.isSafeInteger(row.generation) ? row.generation : (receiptObj.generation ?? null),
    });
    episode.delivery = Object.freeze({
      artefactHash: str(receiptObj.artifact?.sha256) ?? row.artifact_sha256 ?? null,
      artefactKind: "text",
      submittedAt: iso(receiptObj.createdAt) ?? isoFromMs(row.created_at),
      prUrl: null,
    });
    const review = reviews.has(row.receipt_id) ? parseJson(reviews.get(row.receipt_id).state_json) : null;
    episode.verdicts = Object.freeze(verdictRowsFromPublicWork({ roomId, receipt, review }));
    const link = settlements.get(row.offer_id) ?? null;
    let dealing = [];
    if (link) {
      const legs = legsByBounty.get(link.bounty_id) ?? [];
      const linked = records.get(link.bounty_id) ?? null;
      episode.settlement = settlementOf({ legs, claimantRef: link.claimant_lane ?? null, outcome: linked?.state ?? null, bountyId: link.bounty_id });
      dealing = selfDealingRules({
        poster: linked?.poster ?? link.poster_lane ?? null,
        claimant: linked?.claimant ?? link.claimant_lane ?? null, legs,
      });
    }
    let stamp = stampOf(receiptObj);
    let source = stamp ? "submission" : null;
    if (!stamp && review) { stamp = stampOf(review.decision, review.verification); source = stamp ? "verdict" : null; }
    if (stamp) { episode.provenance = stamp; episode.provenanceSource = source; }

    const missing = [];
    if (!task && !offer) missing.push("task");
    if (!episode.verdicts.length) missing.push("verdict");
    if (!missing.length) stats.complete += 1;
    for (const reason of missing) stats.missingReasons[reason] = (stats.missingReasons[reason] ?? 0) + 1;
    episodes.push(finishEpisode(episode, missing, dealing));
  }
  return { episodes, stats };
}

// --- Board episodes -----------------------------------------------------------

function boardEpisodes(retained, orphans) {
  const rows = [...retained.get("work_claims")].sort((a, b) => (a.claim_id < b.claim_id ? -1 : 1));
  const episodes = [];
  const stats = { records: rows.length, complete: 0, missingReasons: {} };
  for (const row of rows) {
    const item = parseJson(row.item_json);
    if (!item || typeof item !== "object") {
      orphans.push({ kind: "board-claim", id: row.claim_id, reason: "work_claims item_json does not parse" });
      continue;
    }
    const roomId = row.room_id ?? null;
    const episode = episodeBase({ surface: "board", recordId: str(item.id) ?? row.claim_id, roomId });
    episode.task = Object.freeze({
      specHash: sha256Hex(canonicalJson({ title: item.title ?? null, acceptanceCriteria: item.acceptanceCriteria ?? null })),
      criteriaHash: null,
      rubricVersion: str(item.reviewPolicy),
      rewardMillis: null, termsVersion: null,
    });
    const claimedAt = iso(item.claimedAt);
    const leaseExpiresAt = iso(item.leaseExpiresAt);
    episode.claim = Object.freeze({
      claimantRef: str(item.owner),
      claimedAt,
      leaseHours: claimedAt && leaseExpiresAt
        ? Math.round(((Date.parse(leaseExpiresAt) - Date.parse(claimedAt)) / 3600000) * 1000) / 1000 : null,
      deliveryGeneration: Number.isSafeInteger(item.deliveryGeneration) ? item.deliveryGeneration
        : (Number.isSafeInteger(item.generation) ? item.generation : null),
    });
    const delivery = item.delivery && typeof item.delivery === "object" ? item.delivery : null;
    const pr = item.pullRequest && typeof item.pullRequest === "object" ? item.pullRequest : null;
    if (delivery || pr) {
      episode.delivery = Object.freeze({
        artefactHash: str(delivery?.artifactSha256) ?? str(delivery?.sha256) ?? str(delivery?.hash),
        artefactKind: "board-delivery",
        submittedAt: iso(delivery?.at) ?? iso(delivery?.submittedAt) ?? iso(item.deliveredAt),
        prUrl: str(pr?.url) ?? (typeof item.pullRequest === "string" ? item.pullRequest : null),
      });
    }
    episode.verdicts = Object.freeze(verdictRowsFromBoardClaim({ roomId, item }));
    let stamp = stampOf(item.verification);
    let source = stamp ? "verdict" : null;
    if (!stamp) { stamp = stampOf(item); source = stamp ? "record" : null; }
    if (stamp) { episode.provenance = stamp; episode.provenanceSource = source; }

    const missing = [];
    if (!episode.claim?.claimantRef) missing.push("claimant");
    if (!episode.delivery && !episode.verdicts.some(v => v.decisionKind === "acceptance")) missing.push("delivery");
    if (!episode.verdicts.length) missing.push("verdict");
    if (!missing.length) stats.complete += 1;
    for (const reason of missing) stats.missingReasons[reason] = (stats.missingReasons[reason] ?? 0) + 1;
    episodes.push(finishEpisode(episode, missing));
  }
  return { episodes, stats };
}

// --- Assembly -----------------------------------------------------------------

const SURFACE_BUILDERS = Object.freeze({
  bounty: bountyEpisodes, "public-work": publicWorkEpisodes, board: boardEpisodes,
});

const digestsEqual = (a, b) => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.rows === b.rows && a.sha256 === b.sha256;
};

// The data programme's revisit trigger, as counters (SCALE-READINESS
// R3/B7): >=1,000 verified settled outcomes counting DISTINCT
// OPERATORS, self-dealing excluded, with >=2 non-fleet parties. The
// naive episode/settled counts are emitted alongside — never instead —
// so the honest metric cannot be confused with the manufacturable
// one. Counters are a pure function of the bounty surface's tables:
// when an incremental run does not reassemble that surface, the
// previous run's counters carry forward verbatim (source: "carried").
export const TRIGGER_THRESHOLD = 1000;

function triggerCountersOf(settledDetail, fleetRoster) {
  const verified = settledDetail.filter(entry => entry.complete);
  const honest = verified.filter(entry => !entry.selfDealing);
  const operators = new Set(honest.map(entry => entry.claimant).filter(Boolean));
  const posters = new Set(honest.map(entry => entry.poster).filter(Boolean));
  let nonFleet = { rosterSupplied: false, outcomesWithNonFleetParty: null, distinctNonFleetOperators: null };
  if (fleetRoster) {
    const roster = fleetRoster instanceof Set ? fleetRoster : new Set(fleetRoster);
    const parties = new Set();
    let outcomes = 0;
    for (const entry of honest) {
      let hasNonFleet = false;
      for (const ref of [entry.poster, entry.claimant]) {
        if (ref && !roster.has(ref)) { parties.add(ref); hasNonFleet = true; }
      }
      if (hasNonFleet) outcomes += 1;
    }
    nonFleet = { rosterSupplied: true, outcomesWithNonFleetParty: outcomes, distinctNonFleetOperators: parties.size };
  }
  return {
    definition: "settled outcome = one bounty in state 'paid' (a paid public-work task settles through its mirror bounty, so it counts exactly once, here); verified = the episode assembles complete; self-dealing excluded by rules SD-1..SD-3 (see selfDealingRules); operators are claimant refs; non-fleet is measured against the roster supplied to the run",
    settledOutcomes: settledDetail.length,
    verifiedSettledOutcomes: verified.length,
    selfDealingFlaggedAmongVerified: verified.length - honest.length,
    verifiedExcludingSelfDealing: honest.length,
    distinctOperators: operators.size,
    distinctPosterOperators: posters.size,
    nonFleet,
    trigger: { metric: "distinctOperators", threshold: TRIGGER_THRESHOLD, value: operators.size, fires: operators.size >= TRIGGER_THRESHOLD },
  };
}

// Assemble work episodes from a snapshot. `source` is the NDJSON
// snapshot as a string, an array of lines, or an (async) iterable of
// lines (the CLI streams a file). `state` is the object a previous
// run returned as nextState (or null for a full run). `fleetRoster`
// is an optional iterable of party refs considered fleet-internal for
// the trigger counters' non-fleet measurement; without it those two
// counters are null, never estimated. Returns the episodes this run
// EMITS (new or changed), the run report (including the trigger
// counters), and nextState to persist for the next incremental run.
export async function assembleWorkEpisodes({ source, state = null, allowChainBreak = false, fleetRoster = null } = {}) {
  const started = Date.now();
  const snap = await ingest(source);
  if (!snap.chain.ok && !allowChainBreak) {
    throw new Error(`bounty_journal hash chain breaks at seq ${snap.chain.break.seq} (${snap.chain.break.reason}); refusing to assemble settlements over a broken chain. Re-run with allowChainBreak to emit with the break named in the report.`);
  }
  const priorDigests = state?.tableDigests ?? null;
  const priorEpisodes = state?.episodes ?? {};
  const orphans = [];
  const emitted = [];
  const nextEpisodes = { ...priorEpisodes };
  const surfaceReports = {};
  let assembledCount = 0, carriedCount = 0;
  let triggerCounters = state?.triggerCounters ?? null;
  let triggerSource = triggerCounters ? "carried" : null;

  for (const [surface, tables] of Object.entries(SURFACE_TABLES)) {
    const changed = !priorDigests || tables.some(table => !digestsEqual(priorDigests[table], snap.tableDigests[table]));
    if (!changed) {
      carriedCount += Object.keys(priorEpisodes).filter(id => id.startsWith(`${surface}:`)).length;
      surfaceReports[surface] = { changed: false };
      continue;
    }
    const built = SURFACE_BUILDERS[surface](snap.retained, orphans);
    const { episodes, stats } = built;
    if (surface === "bounty") {
      triggerCounters = triggerCountersOf(built.settledDetail ?? [], fleetRoster);
      triggerSource = "computed";
    }
    assembledCount += episodes.length;
    for (const key of Object.keys(nextEpisodes)) if (key.startsWith(`${surface}:`)) delete nextEpisodes[key];
    let newCount = 0, changedCount = 0;
    for (const episode of episodes) {
      const hash = sha256Hex(canonicalJson(episode));
      nextEpisodes[episode.episodeId] = hash;
      if (priorEpisodes[episode.episodeId] === undefined) { emitted.push(episode); newCount += 1; }
      else if (priorEpisodes[episode.episodeId] !== hash) { emitted.push(episode); changedCount += 1; }
    }
    surfaceReports[surface] = { changed: true, ...stats, emittedNew: newCount, emittedChanged: changedCount };
  }

  const report = {
    schema: "work-episode-extract-report/1",
    snapshot: {
      backedUpAt: snap.watermark.backedUpAt ?? null,
      sanitizePolicy: snap.watermark.sanitizePolicy ?? null,
      verification: snap.verification,
      events: snap.trailer.events,
    },
    journalChain: snap.chain,
    malformedStamps: snap.malformedStamps,
    surfaces: surfaceReports,
    triggerCounters: triggerCounters ? { ...triggerCounters, source: triggerSource } : null,
    totals: {
      episodesKnown: Object.keys(nextEpisodes).length,
      assembled: assembledCount, carried: carriedCount,
      emitted: emitted.length,
    },
    orphans: orphans.slice(0, 100),
    assemblyMs: Date.now() - started,
  };
  const nextState = {
    version: EXTRACT_STATE_VERSION,
    tableDigests: snap.tableDigests,
    episodes: nextEpisodes,
    triggerCounters,
    snapshot: { backedUpAt: report.snapshot.backedUpAt, eventsHash: snap.trailer.eventsHash },
  };
  return { episodes: emitted, report, nextState };
}

export const episodeHash = episode => sha256Hex(canonicalJson(episode));
