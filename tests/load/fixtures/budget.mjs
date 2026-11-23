// Shared numbers for the near-full room load test.
// The room write ceiling is the smaller of the 4 MiB projection cap and this
// runtime's SQLite value limit. The 10 GB figure is the Durable Object
// database limit (the operator line in server/jobs.mjs is 80% of it). A CI
// runner cannot allocate 9 GB, and a single room is refused at the projection
// ceiling long before the file reaches that size.

export const LOAD_BUDGET = Object.freeze({
  roomId: "load-room",
  fillRatio: 0.9,
  fillRatioMin: 0.88,
  fillRatioMax: 0.93,
  people: 4,
  agents: 4,
  writesPerActor: 2,
  snapshotReads: 8,
  p95BudgetMs: 5000,
  permitTtlMs: 5000,
  productionDatabaseLimitBytes: 10_000_000_000,
  projectionCapBytes: 4 * 1024 * 1024
});

// The ceiling a room write actually hits on this runtime.
export function roomStorageLimitBytes(projectionCap, valueLimitBytes) {
  if (!Number.isSafeInteger(projectionCap) || projectionCap < 1) throw new Error("projection cap missing");
  if (!Number.isSafeInteger(valueLimitBytes) || valueLimitBytes < 1) return projectionCap;
  return Math.min(projectionCap, valueLimitBytes);
}

export function fillInBand(bytes, limit, minRatio, maxRatio) {
  if (!Number.isFinite(bytes) || !Number.isFinite(limit) || limit <= 0) return false;
  const ratio = bytes / limit;
  return ratio + Number.EPSILON >= minRatio && ratio <= maxRatio + Number.EPSILON;
}

// samples are { t, version } in time order. version 0 is idle. A hold that
// is still open at the last sample is past TTL only once a sample lands
// more than ttlMs after it opened; the caller waits and samples again.
export function permitHold(samples, ttlMs) {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error("permit TTL missing");
  let openSince = null;
  let past = false;
  for (const sample of samples) {
    const held = sample?.version !== 0;
    if (held) {
      if (openSince === null) openSince = sample.t;
      if (sample.t - openSince > ttlMs) past = true;
    } else if (openSince !== null) {
      if (sample.t - openSince > ttlMs) past = true;
      openSince = null;
    }
  }
  return { past, openSince };
}
