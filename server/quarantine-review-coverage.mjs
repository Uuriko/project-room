// Review-coverage dashboard for the spam-quarantine queue (the review UI
// actions Confirm / Dismiss / Split, PR #562; the durable journal, #557/#560).
//
// Per signal that fired on a held row, this reports how far owner review has
// gotten: how many holds are still awaiting review, how many were reviewed,
// the Confirm (released into the inbox) / Dismiss (confirmed spam) / Split
// (detached off its thread, orthogonal to the verdict — a split held item
// still needs Confirm or Dismiss) breakdown, and the coverage ratio reviewed
// over all holds. The ratio is the same definition as the shadow analysis
// tooling's reviewCoverage (server/spam-shadow-report.mjs, #567): reviewed
// holds over total holds, a zero denominator yielding null rather than 0.
//
// Input is plain journal rows (the SpamQuarantineJournal view shape: each
// row's `reason` is the flag's {key, weight, detail} signal list) plus the
// set of split quarantine ids (quarantine_thread_splits). Pure functions over
// plain records: reproducible from fixture data or a live store export.
// Frozen outputs; coded errors; no network, no store writes.

export class ReviewCoverageError extends Error {
  constructor(code, message) { super(message); this.name = "ReviewCoverageError"; this.code = code; }
}
const fail = (code, message) => { throw new ReviewCoverageError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_review_coverage_input", message); };

const ratio = (numerator, denominator) => denominator === 0 ? null : numerator / denominator;

const signalOf = signal => {
  check(signal !== null && typeof signal === "object" && !Array.isArray(signal), "reason signals must be {key, weight, detail}");
  check(typeof signal.key === "string" && signal.key.length > 0, "signal.key must be a non-empty string");
  check(typeof signal.weight === "number" && Number.isFinite(signal.weight), "signal.weight must be a finite number");
  check(typeof signal.detail === "string", "signal.detail must be a string");
  return { key: signal.key, weight: signal.weight, detail: signal.detail };
};
const rowOf = row => {
  check(row !== null && typeof row === "object" && !Array.isArray(row), "rows must be quarantine journal view objects");
  check(typeof row.id === "string" && row.id.length > 0, "row.id must be a non-empty string");
  check(["held", "released", "dismissed"].includes(row.status), "row.status must be held, released or dismissed");
  check(Array.isArray(row.reason), "row.reason must be the journal signal list");
  check(typeof row.quarantinedAt === "number" && Number.isFinite(row.quarantinedAt) && row.quarantinedAt >= 0,
    "row.quarantinedAt must be a finite ms-epoch time");
  if (row.score !== undefined && row.score !== null)
    check(typeof row.score === "number" && row.score >= 0 && row.score <= 100, "row.score must be 0..100 when present");
  return {
    id: row.id, status: row.status, quarantinedAt: row.quarantinedAt,
    score: row.score ?? null, reason: Object.freeze(row.reason.map(signalOf)),
  };
};
const splitsOf = splits => {
  check(splits === undefined || splits === null || splits instanceof Set || Array.isArray(splits),
    "splits must be a Set or array of quarantine ids");
  const list = splits instanceof Set ? [...splits] : (splits ?? []);
  for (const id of list) check(typeof id === "string" && id.length > 0, "split ids must be non-empty strings");
  return new Set(list);
};

// Per-signal review coverage over quarantine journal rows.
//   held      rows still awaiting review that carry the signal
//   confirmed reviewed Confirm: released into the inbox (owner verdict: not spam)
//   dismissed reviewed Dismiss: confirmed spam (record stays, message stays out)
//   reviewed  confirmed + dismissed
//   split     rows carrying the signal split off their thread. Split is a
//             thread action, not a verdict: a split row keeps its review
//             state, so split overlaps with held/confirmed/dismissed.
//   reviewCoverage  reviewed / (held + reviewed) — the #567 reviewCoverage
//             ratio definition applied per signal; null only when a signal
//             fires on no rows at all (no such row reaches the table).
// Rows are counted once per signal they carry: a row with three signals
// contributes one count to each of the three signal rows (shareOfHolds
// therefore sums past 1 across signals).
export function reviewCoverageBySignal({ rows, splits = null, now = Date.now() } = {}) {
  check(Array.isArray(rows), "rows must be an array");
  check(typeof now === "number" && Number.isFinite(now) && now >= 0, "now must be a finite ms-epoch time");
  const clean = rows.map(rowOf);
  const splitIds = splitsOf(splits);
  const bySignal = new Map();
  const touch = key => {
    if (!bySignal.has(key)) bySignal.set(key,
      { held: 0, confirmed: 0, dismissed: 0, split: 0, total: 0, scoreSum: 0, weightSum: 0 });
    return bySignal.get(key);
  };
  for (const row of clean) {
    const isSplit = splitIds.has(row.id);
    for (const signal of row.reason) {
      const stats = touch(signal.key);
      stats.total++;
      if (row.status === "held") stats.held++;
      else if (row.status === "released") stats.confirmed++;
      else stats.dismissed++;
      if (isSplit) stats.split++;
      if (row.score !== null) stats.scoreSum += row.score;
      stats.weightSum += signal.weight;
    }
  }
  const totalHolds = clean.length;
  const perSignal = Object.freeze([...bySignal.entries()]
    .map(([key, stats]) => {
      const reviewed = stats.confirmed + stats.dismissed;
      return Object.freeze({
        key,
        held: stats.held,
        confirmed: stats.confirmed,
        dismissed: stats.dismissed,
        reviewed,
        split: stats.split,
        total: stats.total,
        // The #567 reviewCoverage metric, per signal.
        reviewCoverage: ratio(reviewed, stats.total),
        shareOfHolds: ratio(stats.total, totalHolds),
        avgScore: stats.total === 0 ? null : Math.round((stats.scoreSum / stats.total) * 10) / 10,
        avgWeight: stats.total === 0 ? null : Math.round((stats.weightSum / stats.total) * 10) / 10,
      });
    })
    // Least-covered first: the signals most in need of owner attention lead.
    .sort((a, b) => (a.reviewCoverage ?? 2) - (b.reviewCoverage ?? 2)
      || b.total - a.total || a.key.localeCompare(b.key)));
  const totals = clean.reduce((acc, row) => {
    acc[row.status === "held" ? "held" : row.status === "released" ? "confirmed" : "dismissed"]++;
    if (splitIds.has(row.id)) acc.split++;
    return acc;
  }, { held: 0, confirmed: 0, dismissed: 0, split: 0 });
  const reviewedTotal = totals.confirmed + totals.dismissed;
  return Object.freeze({
    generatedAt: now,
    totals: Object.freeze({ ...totals,
      reviewed: reviewedTotal, total: clean.length,
      reviewCoverage: ratio(reviewedTotal, clean.length) }),
    // The coverage gap list: signals firing on live holds that no owner has
    // reviewed yet. A signal here is not evidence it is wrong — only that
    // its verdicts have no human check.
    zeroCoverageSignals: Object.freeze(perSignal.filter(s => s.held > 0 && s.reviewed === 0).map(s => s.key)),
    perSignal,
  });
}

