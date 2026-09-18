// Shadow-period precision report for auto-quarantine (AUTO-QUARANTINE-POLICY.md v1, §5).
//
// The 14-day shadow journals what WOULD have been held — one
// receipt.shadowQuarantine decision per scored import (server/spam-shadow.mjs)
// — while the durable spam_quarantine journal (server/spam-quarantine-journal.mjs)
// keeps the owner review backlog with the verdict vocabulary:
//   dismissed = the owner confirmed it as spam (a true positive for the hold logic)
//   released  = the owner judged it ham (a false positive for the hold logic)
//   held      = still awaiting review (pending, or expired if past the window)
//
// This module is the join: shadow-held candidate records ↔ review outcomes,
// as pure functions over plain records, so the report is reproducible from
// fixture data or from a live store export. Frozen outputs; coded errors;
// no network, no store writes.
//
// Label contract (one label per decision):
//   true_positive     wouldHold + dismissed          — confirmed spam
//   false_positive    wouldHold + released           — ham wrongly held
//   pending_review    wouldHold + held, inside the review window
//   expired_unreviewed wouldHold + held, past the review window — outcome never arrived
//   unjournaled       wouldHold + no journal row     — the review backlog missed it
//                                                  (a data gap, not a verdict)
//   false_negative    !wouldHold + dismissed         — spam the hold logic missed
//   true_negative     !wouldHold + released|held     — correctly passed through
//
// Metrics (precision/FPR are measured over reviewed would-be holds only, so
// pending and expired items never dilute them):
//   precision         TP / (TP + FP)
//   falsePositiveRate FP / (TP + FP)
//   recall            TP / (TP + FN) — FN = dismissed messages the shadow
//                     logic would NOT have held (gated or under threshold)
// A zero denominator yields null, never 0: "no reviewed holds" is honest
// absence of evidence, not evidence of perfection.

export class ShadowReportError extends Error {
  constructor(code, message) { super(message); this.name = "ShadowReportError"; this.code = code; }
}
const fail = (code, message) => { throw new ShadowReportError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_shadow_report_input", message); };

export const shadowReportLabels = Object.freeze([
  "true_positive", "false_positive", "pending_review", "expired_unreviewed",
  "unjournaled", "false_negative", "true_negative",
]);
export const shadowReviewStatuses = Object.freeze(["held", "released", "dismissed"]);
// Default review window: the policy's 14-day shadow period. A hold still
// unreviewed past the window is expired_unreviewed, not pending.
export const shadowReviewWindowMs = 14 * 24 * 3600 * 1000;

const featureOf = feature => {
  check(feature !== null && typeof feature === "object" && !Array.isArray(feature), "features must be {key, weight, detail}[]");
  check(typeof feature.key === "string" && feature.key.length > 0, "feature.key must be a non-empty string");
  check(typeof feature.weight === "number" && Number.isFinite(feature.weight), "feature.weight must be a finite number");
  check(typeof feature.detail === "string", "feature.detail must be a string");
  return { key: feature.key, weight: feature.weight, detail: feature.detail };
};
const decisionOf = decision => {
  check(decision !== null && typeof decision === "object" && !Array.isArray(decision), "decision must be an object");
  check(typeof decision.messageId === "string" && decision.messageId.length > 0, "decision.messageId must be a non-empty string");
  check(typeof decision.score === "number" && Number.isFinite(decision.score), "decision.score must be a finite number");
  check(typeof decision.wouldHold === "boolean", "decision.wouldHold must be a boolean");
  check(Array.isArray(decision.features), "decision.features must be an array");
  check(typeof decision.at === "number" && Number.isFinite(decision.at) && decision.at >= 0, "decision.at must be a finite ms-epoch time");
  for (const scope of ["accountId", "sourceId", "channel", "connectionId", "gateBlock", "policyVersion"]) {
    const value = decision[scope];
    check(value === undefined || value === null || typeof value === "string", `decision.${scope} must be a string when present`);
  }
  return {
    messageId: decision.messageId, channel: decision.channel ?? null, connectionId: decision.connectionId ?? null,
    accountId: decision.accountId ?? null, sourceId: decision.sourceId ?? null,
    policyVersion: decision.policyVersion ?? null,
    score: decision.score, threshold: typeof decision.threshold === "number" ? decision.threshold : null,
    wouldHold: decision.wouldHold, gateBlock: decision.gateBlock ?? null,
    features: Object.freeze(decision.features.map(featureOf)), at: decision.at,
  };
};
const reviewOf = review => {
  check(review !== null && typeof review === "object" && !Array.isArray(review), "review must be an object");
  check(typeof review.messageId === "string" && review.messageId.length > 0, "review.messageId must be a non-empty string");
  check(shadowReviewStatuses.includes(review.status), "review.status must be held, released or dismissed");
  check(typeof review.quarantinedAt === "number" && Number.isFinite(review.quarantinedAt) && review.quarantinedAt >= 0,
    "review.quarantinedAt must be a finite ms-epoch time");
  for (const scope of ["accountId", "sourceId", "channel", "connectionId", "reviewedBy"]) {
    const value = review[scope];
    check(value === undefined || value === null || typeof value === "string", `review.${scope} must be a string when present`);
  }
  return {
    messageId: review.messageId, channel: review.channel ?? null, connectionId: review.connectionId ?? null,
    accountId: review.accountId ?? null, sourceId: review.sourceId ?? null,
    status: review.status, score: typeof review.score === "number" ? review.score : null,
    quarantinedAt: review.quarantinedAt,
    reviewedAt: typeof review.reviewedAt === "number" ? review.reviewedAt : null,
    reviewedBy: review.reviewedBy ?? null,
  };
};

// The join key. Gap #2 (PR #562) scopes holds to (accountId, sourceId,
// messageId) because identical provider ids recur across accounts; older
// journal rows backfill NULL scope and shadow decisions carry scope only when
// the importer knew it. Scoped decisions join on the full triple, unscoped
// ones on messageId alone. When several journal rows match a messageId, the
// latest-updated (deterministic tiebreak: quarantinedAt, then row id) wins
// and the match is flagged ambiguous only if the verdicts disagree.
const scopeKey = (accountId, sourceId, messageId) =>
  accountId !== null && accountId !== undefined && sourceId !== null && sourceId !== undefined
    ? `${accountId}\u0000${sourceId}\u0000${messageId}` : messageId;

function indexReviews(reviews) {
  const scoped = new Map(), unscoped = new Map();
  for (const review of reviews) {
    const key = scopeKey(review.accountId, review.sourceId, review.messageId);
    if (review.accountId !== null && review.sourceId !== null) {
      if (!scoped.has(key)) scoped.set(key, []);
      scoped.get(key).push(review);
    }
    if (!unscoped.has(review.messageId)) unscoped.set(review.messageId, []);
    unscoped.get(review.messageId).push(review);
  }
  // Latest-updated first; quarantine-row ids are qz-<n>, monotonic in write order.
  const order = (a, b) => (b.reviewedAt ?? b.quarantinedAt) - (a.reviewedAt ?? a.quarantinedAt)
    || b.quarantinedAt - a.quarantinedAt;
  for (const list of [...scoped.values(), ...unscoped.values()]) list.sort(order);
  return { scoped, unscoped };
}

function matchReview(decision, index) {
  const key = scopeKey(decision.accountId, decision.sourceId, decision.messageId);
  let candidates = null, scoped = false;
  if (decision.accountId !== null && decision.sourceId !== null && index.scoped.has(key)) {
    candidates = index.scoped.get(key); scoped = true;
  } else if (index.unscoped.has(decision.messageId)) {
    candidates = index.unscoped.get(decision.messageId);
  }
  if (!candidates || candidates.length === 0) return { review: null, scoped, ambiguous: false };
  const review = candidates[0];
  return { review, scoped,
    ambiguous: candidates.length > 1 && new Set(candidates.map(r => r.status)).size > 1 };
}

// Label one shadow decision from its matched review. now/reviewWindowMs turn
// a still-held match into pending_review vs expired_unreviewed.
function labelJoined({ decision, review, scoped, ambiguous, now, reviewWindowMs }) {
  let label, verdict = null;
  if (!review) {
    label = decision.wouldHold ? "unjournaled" : "true_negative";
  } else if (review.status === "dismissed") {
    label = decision.wouldHold ? "true_positive" : "false_negative";
    verdict = "confirmed_spam";
  } else if (review.status === "released") {
    label = decision.wouldHold ? "false_positive" : "true_negative";
    verdict = "ham";
  } else {
    // still held: no outcome yet
    if (decision.wouldHold) label = review.quarantinedAt + reviewWindowMs < now ? "expired_unreviewed" : "pending_review";
    else label = "true_negative";
  }
  return Object.freeze({ decision: Object.freeze(decision), review: review ? Object.freeze(review) : null,
    label, verdict, scopedMatch: scoped, ambiguous });
}

// Join every shadow decision to its review outcome. reviews are the durable
// journal rows (spam_quarantine views). Unscoped decisions join on messageId;
// scoped decisions prefer the full triple (see scopeKey).
export function joinShadowOutcomes({ decisions, reviews, now = Date.now(), reviewWindowMs = shadowReviewWindowMs } = {}) {
  check(Array.isArray(decisions), "decisions must be an array");
  check(Array.isArray(reviews), "reviews must be an array");
  check(typeof now === "number" && Number.isFinite(now) && now >= 0, "now must be a finite ms-epoch time");
  check(typeof reviewWindowMs === "number" && Number.isFinite(reviewWindowMs) && reviewWindowMs > 0,
    "reviewWindowMs must be a positive number of ms");
  const cleanDecisions = decisions.map(decisionOf);
  const cleanReviews = reviews.map(reviewOf);
  const index = indexReviews(cleanReviews);
  return Object.freeze(cleanDecisions.map(decision => {
    const { review, scoped, ambiguous } = matchReview(decision, index);
    return labelJoined({ decision, review, scoped, ambiguous, now, reviewWindowMs });
  }));
}

const ratio = (numerator, denominator) => denominator === 0 ? null : numerator / denominator;

// The precision report: metrics, per-signal breakdown, gate-block analysis,
// and the labeled rows for drill-down.
export function shadowPrecisionReport({ decisions, reviews, now = Date.now(), reviewWindowMs = shadowReviewWindowMs } = {}) {
  const rows = joinShadowOutcomes({ decisions, reviews, now, reviewWindowMs });
  const counts = Object.fromEntries(shadowReportLabels.map(label => [label, 0]));
  for (const row of rows) counts[row.label]++;

  const reviewedHolds = counts.true_positive + counts.false_positive;
  const wouldBeHolds = rows.filter(r => r.decision.wouldHold).length;
  const metrics = Object.freeze({
    wouldBeHolds, reviewedHolds,
    truePositives: counts.true_positive, falsePositives: counts.false_positive,
    falseNegatives: counts.false_negative,
    // Precision and the false-positive rate are measured over reviewed
    // would-be holds only — pending, expired, and unjournaled rows never
    // dilute them. Policy §5's ~5% release bar compares falsePositiveRate.
    precision: ratio(counts.true_positive, reviewedHolds),
    falsePositiveRate: ratio(counts.false_positive, reviewedHolds),
    recall: ratio(counts.true_positive, counts.true_positive + counts.false_negative),
    reviewCoverage: ratio(reviewedHolds, wouldBeHolds),
    expiredUnreviewed: counts.expired_unreviewed,
    unjournaled: counts.unjournaled,
  });

  // Per-signal breakdown: for each signal key that fired on a would-be hold,
  // how it fared among the holds John reviewed. A signal with precision far
  // below the mean is a weight-tuning candidate (policy §5 item 3).
  const signalStats = new Map();
  for (const row of rows) {
    if (!row.decision.wouldHold) continue;
    for (const feature of row.decision.features) {
      if (!signalStats.has(feature.key)) signalStats.set(feature.key, { wouldBeHolds: 0, reviewed: 0, truePositives: 0, falsePositives: 0 });
      const stats = signalStats.get(feature.key);
      stats.wouldBeHolds++;
      if (row.label === "true_positive") { stats.reviewed++; stats.truePositives++; }
      else if (row.label === "false_positive") { stats.reviewed++; stats.falsePositives++; }
    }
  }
  const perSignal = Object.freeze([...signalStats.entries()]
    .map(([key, stats]) => Object.freeze({ key, ...stats,
      precision: ratio(stats.truePositives, stats.truePositives + stats.falsePositives),
      shareOfHolds: ratio(stats.wouldBeHolds, wouldBeHolds) }))
    .sort((a, b) => b.wouldBeHolds - a.wouldBeHolds || a.key.localeCompare(b.key)));

  // Gate-block analysis: high-scoring messages the shadow logic would NOT
  // have held, grouped by the gate that blocked them. A gate with many
  // dismissed (false-negative) rows is over-blocking; a gate with many
  // released rows is doing its job.
  const gateBlocks = {};
  for (const row of rows) {
    if (row.decision.wouldHold) continue;
    const threshold = row.decision.threshold;
    const key = threshold !== null && row.decision.score >= threshold
      ? (row.decision.gateBlock ?? "gate_block_missing")
      : "below_threshold";
    if (!gateBlocks[key]) gateBlocks[key] = { count: 0, dismissed: 0, released: 0, held: 0, neverJournaled: 0 };
    const bucket = gateBlocks[key];
    bucket.count++;
    if (!row.review) bucket.neverJournaled++;
    else if (row.review.status === "dismissed") bucket.dismissed++;
    else if (row.review.status === "released") bucket.released++;
    else bucket.held++;
  }
  return Object.freeze({
    generatedAt: now, reviewWindowMs,
    // Decisions carry their policy version (spam-shadow.mjs); a window
    // spanning a policy bump is flagged here, not silently blended.
    policyVersions: Object.freeze([...new Set(rows.map(r => r.decision.policyVersion ?? null).filter(Boolean))]),
    metrics, counts: Object.freeze(counts),
    perSignal, gateBlocks: Object.freeze(gateBlocks),
    ambiguousMatches: rows.filter(r => r.ambiguous).length,
    rows,
  });
}
