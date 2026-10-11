// server/approval-inbox-metrics.mjs
//
// WAVE-500 guild 10, slice 13/50 — health metrics for the unified approval
// inbox (Bolter teardown steal: one live surface for pending HUMAN decisions
// as cards, replacing the scattered tap list).
//
// Traceability rule (from the teardown): every dashboard number links to its
// source occurrence. So every metric returns { value, query }, where query is
// a card-list filter spec for filterCards() that reproduces the number — no
// dead numbers. Untraceable rows (no id, or a missing/invalid createdAt where
// one is required) are dropped, never counted.
//
// Pure: each function takes a card array and an optional { now }. No store,
// no network, no hidden clock — decoupled from the card source (sibling
// slice 1), so fixtures control time.
//
// Card shape (duck-typed; unknown fields ignored):
//   id        string        card identity (rows without one are dropped)
//   kind      string        decision kind, e.g. "tap" | "approval" | "review"
//   createdAt number        ms epoch the card entered the inbox
//   decidedAt number|null  ms epoch the human decided; null while pending
// A card is pending when it has no finite decidedAt.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const AGE_BUCKETS = Object.freeze(["<1d", "1-3d", "3-7d", ">7d"]);

const isFiniteNumber = value => typeof value === "number" && Number.isFinite(value);
const hasId = card => card !== null && typeof card === "object"
  && typeof card.id === "string" && card.id.length > 0;
const createdAtOf = card => (isFiniteNumber(card.createdAt) ? card.createdAt : null);
const decidedAtOf = card => (isFiniteNumber(card.decidedAt) ? card.decidedAt : null);
const isDecided = card => decidedAtOf(card) !== null;
const isPending = card => !isDecided(card);

// Query = plain JSON filter spec. Fields:
//   pending, decided   boolean — card state (both true = no state constraint)
//   kind               string — exact kind match
//   createdAtPresent   true — require a finite createdAt
//   decidedAtGte/Lte   number — decidedAt bounds (decided cards only)
//   durationValid      true — require decidedAt >= createdAt
//   ageMs: { gte, lt } — (now - createdAt) bounds, evaluated against opts.now
//   sort: "createdAt", order: "asc"|"desc", limit: n
export function filterCards(cards, query = {}, { now = Date.now() } = {}) {
  const list = Array.isArray(cards) ? cards : [];
  const unconstrained = query.pending === true && query.decided === true;
  let out = list.filter(card => {
    if (!hasId(card)) return false;
    if (!unconstrained) {
      if (query.pending === true && !isPending(card)) return false;
      if (query.pending === false && isPending(card)) return false;
      if (query.decided === true && !isDecided(card)) return false;
      if (query.decided === false && isDecided(card)) return false;
    }
    if (typeof query.kind === "string" && card.kind !== query.kind) return false;
    if (query.createdAtPresent === true && createdAtOf(card) === null) return false;
    const decidedAt = decidedAtOf(card);
    if (isFiniteNumber(query.decidedAtGte) && !(decidedAt !== null && decidedAt >= query.decidedAtGte)) return false;
    if (isFiniteNumber(query.decidedAtLte) && !(decidedAt !== null && decidedAt <= query.decidedAtLte)) return false;
    if (query.durationValid === true) {
      const createdAt = createdAtOf(card);
      if (!(createdAt !== null && decidedAt !== null && decidedAt >= createdAt)) return false;
    }
    if (query.ageMs !== null && typeof query.ageMs === "object") {
      const createdAt = createdAtOf(card);
      if (createdAt === null) return false;
      const age = now - createdAt;
      if (isFiniteNumber(query.ageMs.gte) && age < query.ageMs.gte) return false;
      if (isFiniteNumber(query.ageMs.lt) && age >= query.ageMs.lt) return false;
    }
    return true;
  });
  if (query.sort === "createdAt") {
    const dir = query.order === "desc" ? -1 : 1;
    out = [...out].sort((a, b) => dir * (createdAtOf(a) - createdAtOf(b)));
  }
  if (isFiniteNumber(query.limit) && query.limit >= 0) out = out.slice(0, Math.floor(query.limit));
  return out;
}

const PENDING_QUERY = Object.freeze({ pending: true });

// Pending cards grouped by kind. Cards with no usable kind are untraceable
// for a by-kind number and are dropped.
export function pendingByKind(cards, opts = {}) {
  const pending = filterCards(cards, PENDING_QUERY, opts);
  const value = {};
  for (const card of pending) {
    if (typeof card.kind !== "string" || card.kind.length === 0) continue;
    value[card.kind] = (value[card.kind] ?? 0) + 1;
  }
  return { value, query: { ...PENDING_QUERY } };
}

const bucketOf = ageMs => (ageMs < DAY_MS ? AGE_BUCKETS[0]
  : ageMs < 3 * DAY_MS ? AGE_BUCKETS[1]
    : ageMs < 7 * DAY_MS ? AGE_BUCKETS[2] : AGE_BUCKETS[3]);

// Pending cards by age: <1d, 1-3d, 3-7d, >7d. Boundary ages land in the older
// bucket. Cards without createdAt are untraceable for age and are dropped.
export function pendingByAgeBucket(cards, { now = Date.now() } = {}) {
  const pending = filterCards(cards, { pending: true, createdAtPresent: true }, { now });
  const value = { "<1d": 0, "1-3d": 0, "3-7d": 0, ">7d": 0 };
  for (const card of pending) value[bucketOf(now - createdAtOf(card))] += 1;
  return { value, query: { pending: true, createdAtPresent: true } };
}

// Age in ms of the oldest pending card; null when none. The query names the
// single oldest pending card — its age reproduces the value.
export function oldestPendingAge(cards, { now = Date.now() } = {}) {
  const query = { pending: true, createdAtPresent: true, sort: "createdAt", order: "asc", limit: 1 };
  const [oldest] = filterCards(cards, query, { now });
  if (!oldest) return { value: null, query };
  return { value: now - createdAtOf(oldest), query };
}

const dayStartUtcOf = nowMs => {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

// Decisions made since UTC midnight (of opts.now). Future-dated decidedAt is
// anomalous and excluded by the query itself.
export function decidedToday(cards, { now = Date.now() } = {}) {
  const dayStart = dayStartUtcOf(now);
  const query = { decided: true, decidedAtGte: dayStart, decidedAtLte: now };
  return { value: filterCards(cards, query, { now }).length, query };
}

const medianOf = sorted => {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Median ms from card creation to human decision, over decided cards with a
// valid (non-negative) duration. Null when no decided cards qualify.
export function medianTimeToDecision(cards, opts = {}) {
  const query = { decided: true, createdAtPresent: true, durationValid: true };
  const decided = filterCards(cards, query, opts);
  const durations = decided.map(card => decidedAtOf(card) - createdAtOf(card)).sort((a, b) => a - b);
  return { value: medianOf(durations), query };
}

// All five metrics in one call, for the dashboard.
export function approvalInboxMetrics(cards, opts = {}) {
  return {
    pendingByKind: pendingByKind(cards, opts),
    pendingByAgeBucket: pendingByAgeBucket(cards, opts),
    oldestPendingAge: oldestPendingAge(cards, opts),
    decidedToday: decidedToday(cards, opts),
    medianTimeToDecision: medianTimeToDecision(cards, opts),
  };
}
