// Stale procedure detector (W010). A pure detector: given procedures
// with last-used timestamps, identify those unused for 90+ days for
// review. The module is pure and dependency-free. Frozen outputs;
// malformed inputs throw StaleError. Review UI is a later slice.
class StaleError extends Error { constructor(code, message) { super(message); this.name = "StaleError"; this.code = code; } }
const fail = (code, message) => { throw new StaleError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_stale", message); };
const STALE_DAYS = 90;
// Detect stale procedures.
// procedures: [{ procedureId, title, lastUsedAt (ISO|null), createdAt (ISO) }]
// Returns { stale, fresh } partitioned lists.
export function detectStale({ procedures, now, staleDays }) {
  check(Array.isArray(procedures), "procedures must be an array");
  check(typeof now === "string" && !Number.isNaN(Date.parse(now)), "now must be an ISO date string");
  check(staleDays === undefined || (Number.isInteger(staleDays) && staleDays > 0),
    "staleDays must be positive if given");
  const threshold = staleDays || STALE_DAYS;
  const nowMs = Date.parse(now);
  const stale = [];
  const fresh = [];
  for (const p of procedures) {
    check(typeof p.procedureId === "string" && p.procedureId.length > 0,
      "procedureId must be non-empty");
    // Never-used procedures use createdAt as the reference.
    const ref = p.lastUsedAt || p.createdAt;
    check(typeof ref === "string" && !Number.isNaN(Date.parse(ref)),
      "lastUsedAt or createdAt must be a valid ISO string");
    const ageDays = (nowMs - Date.parse(ref)) / 86400000;
    const entry = Object.freeze({ procedureId: p.procedureId, title: p.title || p.procedureId,
      lastUsedAt: p.lastUsedAt || null, ageDays: Math.floor(ageDays) });
    (ageDays >= threshold ? stale : fresh).push(entry);
  }
  stale.sort((a, b) => b.ageDays - a.ageDays); // stalest first
  return Object.freeze({ stale: Object.freeze(stale), fresh: Object.freeze(fresh),
    staleCount: stale.length, freshCount: fresh.length, staleDays: threshold });
}
export { StaleError, STALE_DAYS };
