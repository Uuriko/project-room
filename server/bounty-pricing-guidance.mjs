// Bounty pricing guidance at post time (#3524).
//
// What a poster sees before naming an amount: what comparable settled work
// in THIS room actually paid, drawn only from the room's own settled
// receipt history — the settlement verdict stamped onto bounty_records
// (resolution_json.settlement, written by _recordSettlement in
// server/bounty-escrow.mjs on every terminal path, and the same record the
// public lot receipts compose from in server/public-read-model.mjs).
//
// Comparability rule, kept simple and honest: same room + settled + paid
// out. There is no work-kind/category field on a bounty record (the `label`
// column only ever carries the display words "Duplicate"/"Expired"), so no
// finer slicing is claimed. A bounty counts as a paid sample only when its
// recorded settlement actually paid the worker (workerMillis > 0):
// verified-complete settlements pay the award net of the room-pool fee and
// partial (dispute-split) settlements pay the worker's share, while failed
// and unverified settlements pay zero and are NOT paid-range samples —
// counting them would quote a "typical paid range" anchored at zero for
// work that was never paid. Bounties with no settlement verdict at all
// (proposed, funded, claimed, submitted, accepted, disputed, approved, or
// terminal rows that predate settlement records) are excluded entirely.
//
// Cold start is a first-class state, not an error: a room with no settled,
// paid-out history returns state "no-settled-history" with null ranges and
// NO invented numbers. Guidance is read-only and advisory; nothing in this
// module writes, and callers must never let a guidance failure block or
// alter posting (the routes layer computes it inside a try/catch and
// serves null instead).

export const PRICING_GUIDANCE_SCHEMA = "bounty-pricing-guidance/1";

// Credits are millis-backed (MILLIS_PER_CREDIT = 1000 in
// server/bounty-escrow.mjs). A median of two middle values can land on a
// half-milli; round to the nearest milli so every quoted number is a real
// ledger amount (3 decimals).
const toCredits = millis => Math.round(millis) / 1000;

const parseJson = (text, fallback) => {
  if (typeof text !== "string" || !text) return fallback;
  try { return JSON.parse(text) ?? fallback; } catch { return fallback; }
};

// One raw bounty_records row (resolution_json / rubric_json text columns)
// -> a paid sample, or null when the row is not settled-and-paid history.
function paidSample(row) {
  if (!row || typeof row !== "object") return null;
  const resolution = row.resolution && typeof row.resolution === "object"
    ? row.resolution : parseJson(row.resolution_json, null);
  const settlement = resolution && typeof resolution === "object" ? resolution.settlement : null;
  if (!settlement || typeof settlement !== "object") return null;
  const workerMillis = settlement.workerMillis;
  if (!Number.isSafeInteger(workerMillis) || workerMillis <= 0) return null;
  const rubric = row.rubric && typeof row.rubric === "object"
    ? row.rubric : parseJson(row.rubric_json, null);
  const criteriaCount = Array.isArray(rubric?.criteria) ? rubric.criteria.length
    : Array.isArray(rubric) ? rubric.length : null;
  return {
    paidMillis: workerMillis,
    criteriaCount,
    approvalMode: typeof row.approvalMode === "string" && row.approvalMode
      ? row.approvalMode
      : typeof row.approval_mode === "string" && row.approval_mode ? row.approval_mode : null,
  };
}

const rangeOf = values => values.length
  ? { min: Math.min(...values), max: Math.max(...values) } : null;

// Pure computation over one room's bounty rows (raw bounty_records rows or
// any object carrying resolution/resolution_json + rubric/rubric_json).
// The caller owns the room scoping (the SQL WHERE room_id=?); every row
// passed in is treated as belonging to that one room.
export function pricingGuidanceFromSettledRows(rows) {
  const samples = (Array.isArray(rows) ? rows : []).map(paidSample).filter(Boolean);
  if (!samples.length) {
    return Object.freeze({
      schema: PRICING_GUIDANCE_SCHEMA,
      source: "settled-receipts",
      state: "no-settled-history",
      sampleCount: 0,
      paidRangeCredits: null,
      rubricCriteriaCount: null,
      approvalModes: Object.freeze([]),
    });
  }
  const paid = samples.map(sample => sample.paidMillis).sort((a, b) => a - b);
  const mid = Math.floor(paid.length / 2);
  const medianMillis = paid.length % 2 ? paid[mid] : (paid[mid - 1] + paid[mid]) / 2;
  const criteria = rangeOf(samples.map(sample => sample.criteriaCount).filter(Number.isInteger));
  return Object.freeze({
    schema: PRICING_GUIDANCE_SCHEMA,
    source: "settled-receipts",
    state: "ok",
    sampleCount: samples.length,
    paidRangeCredits: Object.freeze({
      min: toCredits(paid[0]),
      median: toCredits(medianMillis),
      max: toCredits(paid[paid.length - 1]),
    }),
    rubricCriteriaCount: criteria ? Object.freeze(criteria) : null,
    approvalModes: Object.freeze([...new Set(samples.map(sample => sample.approvalMode).filter(Boolean))].sort()),
  });
}
