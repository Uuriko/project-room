// Board planning fields (Linear parity): priority, estimate, due date, cycle
// and milestone on a Board task. Off unless ROOM_BOARD_PLANNING_FIELDS=1.
// Only type checks: a wrong type is refused so a typo cannot silently store
// garbage. No ranges or policy beyond that.
export const PLANNING_FIELDS = Object.freeze(["priority", "estimate", "dueAt", "cycleId", "milestone"]);
export const PLANNING_SORTS = Object.freeze(["priority", "dueAt", "estimate"]);
export const PLANNING_QUERY = Object.freeze(["priority", "cycleId", "milestone", "dueBefore", "sort"]);
export const boardPlanningEnabled = (env = process.env) => env?.ROOM_BOARD_PLANNING_FIELDS === "1";

const text = v => typeof v === "string" && v.trim().length > 0 && v.length <= 200;
const num = v => typeof v === "number" && Number.isFinite(v);
const CHECKS = {
  priority: [num, "priority must be a number (lower is more urgent)"],
  estimate: [num, "estimate must be a number"],
  dueAt: [v => typeof v === "string" && Number.isFinite(Date.parse(v)), "dueAt must be an ISO date-time"],
  cycleId: [text, "cycleId must be a non-empty string"],
  milestone: [text, "milestone must be a non-empty string"],
};

// Returns { patch } (null values clear a field) or { error }.
export function planningPatchOf(raw) {
  const patch = {};
  for (const key of PLANNING_FIELDS) {
    if (!Object.hasOwn(raw ?? {}, key)) continue;
    const value = raw[key];
    if (value === null) { patch[key] = null; continue; }
    const [ok, message] = CHECKS[key];
    if (!ok(value)) return { error: message };
    patch[key] = key === "dueAt" ? new Date(Date.parse(value)).toISOString() : value;
  }
  return { patch };
}
export const hasPlanningInput = raw => PLANNING_FIELDS.some(key => Object.hasOwn(raw ?? {}, key));

export function applyPlanning(item, patch) {
  const next = { ...(item.planning ?? {}) };
  for (const [key, value] of Object.entries(patch)) { if (value === null) delete next[key]; else next[key] = value; }
  const { planning: _old, ...rest } = item;
  return Object.keys(next).length ? { ...rest, planning: next } : rest;
}

// Stored shape: drop anything that no longer passes the checks.
export function storedPlanningOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { patch, error } = planningPatchOf(value);
  if (error) return null;
  const out = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
  return Object.keys(out).length ? out : null;
}

// List filters and sort. Missing values sort last.
export function planningQueryOf(params) {
  const q = {};
  for (const key of PLANNING_QUERY) if (params.has(key)) q[key] = params.get(key);
  if (q.priority !== undefined && !num(Number(q.priority))) return { error: "priority must be a number" };
  if (q.dueBefore !== undefined && !Number.isFinite(Date.parse(q.dueBefore))) return { error: "dueBefore must be an ISO date-time" };
  if (q.sort !== undefined && !PLANNING_SORTS.includes(q.sort)) return { error: `sort one of ${PLANNING_SORTS.join(", ")}` };
  return { query: q };
}
export function filterPlanning(items, q) {
  return items.filter(item => {
    const p = item.planning ?? {};
    if (q.priority !== undefined && p.priority !== Number(q.priority)) return false;
    if (q.cycleId !== undefined && p.cycleId !== q.cycleId) return false;
    if (q.milestone !== undefined && p.milestone !== q.milestone) return false;
    if (q.dueBefore !== undefined && !(p.dueAt && Date.parse(p.dueAt) <= Date.parse(q.dueBefore))) return false;
    return true;
  });
}
export function sortPlanning(items, key) {
  const val = item => { const v = item.planning?.[key]; return v === undefined ? null : key === "dueAt" ? Date.parse(v) : v; };
  return [...items].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
    return x - y;
  });
}
