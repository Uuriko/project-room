// Analytics data retention (G020). A pure retention-policy module: define
// per-category retention windows, compute which records are expired, and
// build a purge plan. All inputs are caller-supplied; the module is pure
// and dependency-free. Times are ISO strings; the caller supplies "now".
// Frozen outputs; malformed inputs throw RetentionError. Actual deletion
// wiring is a later slice.
class RetentionError extends Error { constructor(code, message) { super(message); this.name = "RetentionError"; this.code = code; } }
const fail = (code, message) => { throw new RetentionError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_retention", message); };
// Create a retention manager. policies is { [category]: retentionDays }.
export function createRetention({ policies }) {
  check(policies !== null && typeof policies === "object", "policies must be an object");
  for (const [category, days] of Object.entries(policies)) {
    check(typeof category === "string" && category.length > 0, "category must be a non-empty string");
    check(Number.isInteger(days) && days > 0, `retentionDays for "${category}" must be a positive integer`);
  }
  const frozenPolicies = Object.freeze({ ...policies });
  // Check if a record is expired. record is { category, timestamp (ISO) }.
  const isExpired = (record, { now }) => {
    check(record !== null && typeof record === "object", "record must be an object");
    check(typeof record.category === "string" && record.category.length > 0,
      "record must have a category");
    check(typeof record.timestamp === "string" && !Number.isNaN(Date.parse(record.timestamp)),
      "record must have an ISO timestamp");
    check(typeof now === "string" && !Number.isNaN(Date.parse(now)), "now must be an ISO date string");
    const days = frozenPolicies[record.category];
    check(days !== undefined, `no retention policy for category "${record.category}"`);
    const ageMs = Date.parse(now) - Date.parse(record.timestamp);
    return ageMs > days * 86400000;
  };
  // Build a purge plan: partition records into keep/purge.
  const purgePlan = ({ records, now }) => {
    check(Array.isArray(records), "records must be an array");
    const keep = [];
    const purge = [];
    for (const record of records) {
      (isExpired(record, { now }) ? purge : keep).push(record);
    }
    return Object.freeze({ keep: Object.freeze(keep), purge: Object.freeze(purge),
      keepCount: keep.length, purgeCount: purge.length });
  };
  return Object.freeze({ policies: frozenPolicies, isExpired, purgePlan });
}
export { RetentionError };
