// Work checklists (K004). A pure checklist module: items have ordered
// steps; each step can be checked off with an optional note. The module
// computes progress (fraction complete) and validates that steps are
// checked in any order (no forced sequence). All state is caller-owned
// (a Map of checklistId -> { steps }); the module is pure and
// dependency-free. Frozen outputs; malformed inputs throw ChecklistError.
// Store/UI wiring is a later slice.
class ChecklistError extends Error { constructor(code, message) { super(message); this.name = "ChecklistError"; this.code = code; } }
const fail = (code, message) => { throw new ChecklistError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_checklist", message); };
// Create a checklist store. store is a caller-owned Map (id -> checklist).
export function createChecklists({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const lists = store ?? new Map();
  const checkId = id => check(typeof id === "string" && id.length > 0, "id must be a non-empty string");
  // Create a checklist with ordered step labels.
  const create = (id, steps) => {
    checkId(id);
    check(Array.isArray(steps) && steps.length > 0, "steps must be a non-empty array");
    check(steps.every(s => typeof s === "string" && s.length > 0), "every step must be a non-empty string");
    check(!lists.has(id), `checklist "${id}" already exists`);
    const list = { id, steps: steps.map((label, i) => Object.freeze({ index: i, label, done: false, note: null })) };
    lists.set(id, list);
    return snapshot(id);
  };
  const snapshot = id => {
    checkId(id); check(lists.has(id), `unknown checklist "${id}"`);
    const list = lists.get(id);
    const done = list.steps.filter(s => s.done).length;
    return Object.freeze({ id, steps: Object.freeze(list.steps.map(s => Object.freeze({ ...s }))),
      done, total: list.steps.length, progress: Math.round((done / list.steps.length) * 100) / 100 });
  };
  // Check off a step by index, with an optional note.
  const checkOff = (id, index, { note } = {}) => {
    checkId(id); check(lists.has(id), `unknown checklist "${id}"`);
    const list = lists.get(id);
    check(Number.isInteger(index) && index >= 0 && index < list.steps.length, `step index ${index} out of range`);
    check(note === undefined || (typeof note === "string" && note.length <= 500), "note must be ≤500 chars");
    const step = list.steps[index];
    check(!step.done, `step ${index} is already checked off`);
    list.steps[index] = Object.freeze({ ...step, done: true, note: note ?? null });
    return snapshot(id);
  };
  // Uncheck a step.
  const uncheck = (id, index) => {
    checkId(id); check(lists.has(id), `unknown checklist "${id}"`);
    const list = lists.get(id);
    check(Number.isInteger(index) && index >= 0 && index < list.steps.length, `step index ${index} out of range`);
    const step = list.steps[index];
    check(step.done, `step ${index} is not checked off`);
    list.steps[index] = Object.freeze({ ...step, done: false, note: null });
    return snapshot(id);
  };
  return Object.freeze({ create, snapshot, checkOff, uncheck, size: () => lists.size });
}
export { ChecklistError };
