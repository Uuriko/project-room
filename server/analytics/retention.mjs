// Sampling and retention. Nothing is sampled under 100k stored rows in a
// UTC day. Above that, only public_artifact_viewed is sampled, and the
// kept weights sum to the true view count. Rows are pruned only after export.

import { setDaily, utcDay } from "./schema.mjs";

export const DAILY_CAP = 100_000;
export const RETENTION_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
export const RETENTION_MAX_ROWS = 2_000_000;

export function samplingFactor(storedToday, cap = DAILY_CAP) {
  if (storedToday < cap) return 1;
  let n = 1;
  while (storedToday / n >= cap && n < 2 ** 20) n *= 2;
  return n;
}

// Weights line up with `viewCount` views, in order. 0 means sampled out.
// The positive weights sum to viewCount. N, when sampling, is a power of two.
export function viewSamplingPlan(viewCount, { storedOtherToday = 0, cap = DAILY_CAP } = {}) {
  const weights = Array(viewCount).fill(0);
  if (viewCount <= 0) return weights;
  if (storedOtherToday + viewCount < cap) return weights.fill(1);
  let n = 1;
  const keptAt = factor => Math.ceil(viewCount / factor);
  while (storedOtherToday + keptAt(n) >= cap && n < viewCount) n *= 2;
  if (storedOtherToday >= cap) n = Math.max(n, viewCount);
  let last = -1;
  if (n >= viewCount) {
    weights[viewCount - 1] = viewCount;
    return weights;
  }
  for (let i = 0; i < viewCount; i += 1) {
    if ((i + 1) % n === 0) {
      weights[i] = n;
      last = i;
    }
  }
  const remainder = viewCount % n;
  if (remainder !== 0 && last >= 0) weights[last] += remainder;
  else if (remainder !== 0) weights[viewCount - 1] = viewCount;
  return weights;
}

export function planRetention(candidates, { storedOtherToday = 0, cap = DAILY_CAP } = {}) {
  const views = [];
  for (let i = 0; i < candidates.length; i += 1) {
    if (candidates[i].name === "public_artifact_viewed") views.push(i);
  }
  const viewWeights = viewSamplingPlan(views.length, { storedOtherToday, cap });
  return candidates.map((row, index) => {
    if (row.name !== "public_artifact_viewed") return { keep: true, weight: 1, sampledOut: false };
    const weight = viewWeights[views.indexOf(index)] ?? 0;
    return { keep: weight > 0, weight, sampledOut: weight === 0 };
  });
}

export function dayBounds(now) {
  const day = new Date(now).toISOString().slice(0, 10);
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return { day, start, end: start + 86400000 };
}

export function storedRowsOnDay(db, now) {
  const bounds = dayBounds(now);
  const stored = db.prepare("SELECT count(*) AS n FROM analytics_events WHERE at>=? AND at<?").get(bounds.start, bounds.end).n;
  const views = db.prepare("SELECT count(*) AS n FROM analytics_events WHERE name='public_artifact_viewed' AND at>=? AND at<?").get(bounds.start, bounds.end).n;
  return { ...bounds, stored, views, other: stored - views };
}

export function pruneAnalytics(db, { now = Date.now(), maxRows = RETENTION_MAX_ROWS, retentionMs = RETENTION_DAYS_MS } = {}) {
  const cutoff = now - retentionMs;
  const blocked = db.prepare(`SELECT count(*) AS n FROM analytics_events
    WHERE exported_at IS NULL AND at < ?`).get(cutoff).n;
  const deleted = db.prepare(`DELETE FROM analytics_events
    WHERE exported_at IS NOT NULL AND (
      at < ?
      OR id NOT IN (SELECT id FROM analytics_events ORDER BY at DESC, id DESC LIMIT ?)
    )`).run(cutoff, maxRows).changes;
  // The NOT IN subquery also matches unexported rows inside the newest window,
  // so the exported_at predicate is what keeps unexported history. Count rows
  // that are past the cap or past the age and still unexported.
  const overCap = db.prepare(`SELECT count(*) AS n FROM analytics_events
    WHERE exported_at IS NULL AND id NOT IN (
      SELECT id FROM analytics_events ORDER BY at DESC, id DESC LIMIT ?
    )`).get(maxRows).n;
  const blockedUnexported = blocked + overCap;
  setDaily(db, utcDay(now), "prune_blocked_unexported", blockedUnexported);
  return { deleted, pruneBlockedUnexported: blockedUnexported };
}
