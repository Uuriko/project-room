// r56: the largest string/BLOB this store's SQLite accepts, learned without
// writing anything. A SQLite-backed Durable Object refuses a value or row past
// SQLITE_LIMIT_LENGTH with SQLITE_TOOBIG, and that limit comes from the
// runtime build Cloudflare is running, not from compatibility_date: workerd
// raised it from 2,200,000 B to 4 MiB in v1.20260820.1 and to 8 MiB + 34 B in
// v1.20260925.1, behind no flag (research r55). Cloudflare's limits page still
// says 2 MB, and nothing on prod showed which build it runs, so the backfill's
// park point (which depends on it) was a guess.
//
// zeroblob(N) is checked against the same limit and is lazy (no N-byte buffer
// is built for length()), so `SELECT length(zeroblob(?))` answers "does an
// N-byte value fit" with no table, no row and no write. A binary search finds
// the exact limit in about 31 reads. sqlite_version() is not authorized
// inside a Durable Object, so this is the runtime fact that is readable.

const MAX_PROBE_BYTES = 2 ** 30; // above SQLite's default 1,000,000,000

export function isValueTooBig(error) {
  return error?.code === "pilot_limit"
    || /SQLITE_TOOBIG|string or blob too big|platform row limit/i.test(String(error?.message ?? error));
}

// Pure search. `fits(n)` returns true when an n-byte value is accepted and
// false when it is refused; it may throw for anything else, which makes the
// answer unknown (null) instead of a wrong number.
export function searchValueLimit(fits, { max = MAX_PROBE_BYTES } = {}) {
  if (!fits(1)) return null;
  if (fits(max)) return { valueLimitBytes: null, atLeastBytes: max };
  let lo = 1;
  let hi = max - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (fits(mid)) lo = mid; else hi = mid - 1;
  }
  return { valueLimitBytes: lo };
}

const cache = new WeakMap();

// Reads only. Memoized per database handle: the limit is fixed for the life
// of a runtime process, so /api/version pays the ~31 reads once.
export function sqliteValueLimit(db, options = {}) {
  if (!db || typeof db.prepare !== "function") return null;
  if (cache.has(db)) return cache.get(db);
  let answer = null;
  try {
    const statement = db.prepare("SELECT length(zeroblob(?)) AS n");
    answer = searchValueLimit(bytes => {
      try { return Number(statement.get(bytes)?.n) === bytes; }
      catch (error) { if (isValueTooBig(error)) return false; throw error; }
    }, options);
  } catch {
    answer = null;
  }
  cache.set(db, answer);
  return answer;
}

// The measured limit as one number, or null when it is unknown. A probe
// that only proved a floor (the search hit its own ceiling) reports that
// floor: it is a measured fact, not a guess.
export function probedValueLimitBytes(db) {
  const probe = sqliteValueLimit(db);
  return probe?.valueLimitBytes ?? probe?.atLeastBytes ?? null;
}

// The application projection guard: the largest room projection the app
// will write, whatever the platform allows. PILOT_LIMITS.projectionBytes
// in store.mjs carries this value; the literal lives here, beside the
// probe, so every consumer of the wall derives from one source.
export const PROJECTION_CAP_CEILING_BYTES = 4 * 1024 * 1024;

// The effective cap keeps a tenth of the measured platform limit in
// reserve: a projection shares its row with other columns, and the
// platform limit has moved twice with no flag day, so the app stops
// early rather than meeting a smaller runtime limit mid-write.
export const PROJECTION_CAP_PROBE_MARGIN = 0.9;

// Pure table: measured limit -> effective projection cap. An unknown or
// non-positive limit falls back to the ceiling — today's constant —
// because unknown is never a guess (the probe's own contract above).
export function projectionCapForValueLimit(valueLimitBytes, ceilingBytes = PROJECTION_CAP_CEILING_BYTES) {
  if (!Number.isFinite(valueLimitBytes) || valueLimitBytes <= 0) return ceilingBytes;
  return Math.min(ceilingBytes, Math.floor(valueLimitBytes * PROJECTION_CAP_PROBE_MARGIN));
}

// The effective projection cap for the store behind a database handle.
export function effectiveProjectionCapBytes(db, ceilingBytes = PROJECTION_CAP_CEILING_BYTES) {
  return projectionCapForValueLimit(probedValueLimitBytes(db), ceilingBytes);
}

// The cap a store enforces: the value its constructor derived from the
// probe, or — for a store-like object that never derived one — derived
// here from its handle, or the ceiling when nothing can be probed.
export function storeProjectionCapBytes(store, ceilingBytes = PROJECTION_CAP_CEILING_BYTES) {
  const derived = Number(store?.projectionCapBytes);
  if (Number.isFinite(derived) && derived > 0) return derived;
  if (store?.db) return effectiveProjectionCapBytes(store.db, ceilingBytes);
  return ceilingBytes;
}
