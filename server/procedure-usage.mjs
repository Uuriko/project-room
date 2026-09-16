// Procedure usage analytics (W011). A pure analytics aggregator: given
// procedure usage events, compute per-procedure stats (uses, unique
// users, last used, success rate). The module is pure and dependency-
// free. Frozen outputs; malformed inputs throw UsageError. Dashboard
// wiring is a later slice.
class UsageError extends Error { constructor(code, message) { super(message); this.name = "UsageError"; this.code = code; } }
const fail = (code, message) => { throw new UsageError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_usage", message); };
// Aggregate procedure usage.
// events: [{ procedureId, userId, timestamp (ISO), success (bool) }]
export function usageAnalytics({ events }) {
  check(Array.isArray(events), "events must be an array");
  const procs = new Map();
  for (const e of events) {
    check(typeof e.procedureId === "string" && e.procedureId.length > 0,
      "procedureId must be non-empty");
    check(typeof e.timestamp === "string" && !Number.isNaN(Date.parse(e.timestamp)),
      "timestamp must be a valid ISO string");
    if (!procs.has(e.procedureId)) {
      procs.set(e.procedureId, { procedureId: e.procedureId, uses: 0,
        users: new Set(), successes: 0, lastUsedAt: null });
    }
    const p = procs.get(e.procedureId);
    p.uses++;
    if (e.userId) p.users.add(e.userId);
    if (e.success) p.successes++;
    if (!p.lastUsedAt || e.timestamp > p.lastUsedAt) p.lastUsedAt = e.timestamp;
  }
  const result = [...procs.values()].map(p => Object.freeze({
    procedureId: p.procedureId, uses: p.uses, uniqueUsers: p.users.size,
    successRate: p.uses > 0 ? Math.round((p.successes / p.uses) * 100) / 100 : 0,
    lastUsedAt: p.lastUsedAt }));
  result.sort((a, b) => b.uses - a.uses);
  return Object.freeze(result);
}
export { UsageError };
