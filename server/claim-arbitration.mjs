// Deterministic claim-arbitration rule beyond earliest-timestamp.
//
// When several agents hold competing claims for the same item/lease and the
// contention must be resolved by timestamp, this module picks ONE winner with
// a total, deterministic order:
//
//   1. Earliest minute bucket wins.  A claim's timestamp is floored to its
//      UTC minute: Math.floor(ms / 60000). The smallest bucket wins.
//   2. Same-minute tie-break: lexicographic claim-id order (UTF-16 code-unit
//      comparison, the smallest id wins). No randomness, no wall-clock reads,
//      no input-order dependence — the same claim set always yields the same
//      winner, on any runtime, in any process, in any input order.
//
// WHY the tie-break matters: simulation (g1-sim) of timestamp-based
// arbitration found that with 200 competing claims, 64% of rounds contained
// two or more claims landing in the SAME minute. Minute ties are the common
// case, not the edge case — a rule that only breaks ties at exact-millisecond
// equality would leave most ties undecided, falling back to input order,
// which is nondeterministic across replicas. The minute bucket + id
// tie-break makes the order total and input-order-independent.
//
// WHY lexicographic id rather than a hash: claim ids are unique, opaque, and
// bounded by the board's [A-Za-z0-9_-]{1,128} charset, so code-unit ordering
// is already a total order. It is spec-deterministic (ECMA-262 string
// comparison, no locale, no collation), reviewable in one line, and needs no
// crypto. A stable hash would be equally deterministic but buys nothing.
//
// SCOPE: the live work-claims board grants a claim to whoever arrives first
// (a second claim is 409 work_claim_conflict) — this module does NOT touch
// that path. It is the documented rule for any FUTURE timestamp-based
// fallback. Ship the function, tests, and docs; wire it into a call site only
// when a timestamp-fallback path exists. None exists today.
//
// Pure, dependency-free, deterministic; frozen outputs.
class ClaimArbitrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ClaimArbitrationError";
    this.code = code;
  }
}
const fail = (code, message) => { throw new ClaimArbitrationError(code, message); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

export { ClaimArbitrationError };

// One UTC minute in milliseconds. Timestamps are bucketed at this
// granularity before the id tie-break applies.
export const MINUTE_MS = 60_000;

// Normalize a claimedAt value to epoch milliseconds. Accepts ISO-8601
// strings, epoch-ms numbers, and Date instances. Rejects everything else.
function toEpochMs(claimedAt) {
  if (typeof claimedAt === "number") {
    check(Number.isFinite(claimedAt), "claim_bad_timestamp", "claimedAt must be a finite epoch-ms number");
    return claimedAt;
  }
  if (typeof claimedAt === "string") {
    const ms = Date.parse(claimedAt);
    check(Number.isFinite(ms), "claim_bad_timestamp", `claimedAt is not a parseable timestamp: ${claimedAt}`);
    return ms;
  }
  if (claimedAt instanceof Date) {
    const ms = claimedAt.getTime();
    check(Number.isFinite(ms), "claim_bad_timestamp", "claimedAt Date holds an invalid time");
    return ms;
  }
  fail("claim_bad_timestamp", "claimedAt must be an ISO string, epoch-ms number, or Date");
}

// The UTC minute bucket a timestamp falls in. Two timestamps share a bucket
// exactly when they fall in the same wall-clock minute.
export function minuteBucketMs(claimedAt) {
  return Math.floor(toEpochMs(claimedAt) / MINUTE_MS);
}

function normalizeClaims(claims) {
  check(Array.isArray(claims), "claims_not_an_array", "claims must be an array");
  check(claims.length >= 1, "no_competing_claims", "claims must contain at least one claim");
  return claims.map((claim, index) => {
    check(claim !== null && typeof claim === "object" && !Array.isArray(claim),
      "claim_bad_shape", `claims[${index}] must be an object`);
    check(typeof claim.id === "string" && claim.id.length > 0,
      "claim_missing_id", `claims[${index}] needs a non-empty string id`);
    return {
      claim,
      bucket: minuteBucketMs(claim.claimedAt),
    };
  });
}

// Deterministic total order: earliest minute bucket first, then smallest
// claim id by UTF-16 code-unit comparison (spec-deterministic, no locale).
// V8's sort is stable, so identical (bucket, id) pairs keep input order —
// but claim ids are unique on the board, so that never decides a winner.
const byArbitrationOrder = (a, b) =>
  (a.bucket - b.bucket) ||
  (a.claim.id < b.claim.id ? -1 : a.claim.id > b.claim.id ? 1 : 0);

// Full deterministic ranking, winner first. Returns frozen shallow copies of
// the input claims (extra fields pass through); never mutates the input.
export function rankClaims(claims) {
  const ranked = normalizeClaims(claims).slice().sort(byArbitrationOrder);
  return Object.freeze(ranked.map(({ claim }) => Object.freeze({ ...claim })));
}

// The single winning claim for a set of competitors: the first of the
// deterministic ranking. Same input set → same winner, always.
export function arbitrateClaims(claims) {
  return rankClaims(claims)[0];
}
