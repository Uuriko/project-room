// OKR tracker (K025). A pure objectives-and-key-results manager: define
// objectives with key results (target/current values), update progress,
// and compute objective scores. All state is caller-owned (a Map); the
// module is pure and dependency-free. Frozen outputs; malformed inputs
// throw OkrError. Room/dashboard wiring is a later slice.
class OkrError extends Error { constructor(code, message) { super(message); this.name = "OkrError"; this.code = code; } }
const fail = (code, message) => { throw new OkrError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_okr", message); };
// Create an OKR manager. store is a caller-owned Map (objectiveId -> objective).
export function createOkrs({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const objectives = store ?? new Map();
  let objectiveCounter = 0;
  let krCounter = 0;
  const getObjective = objectiveId => {
    check(typeof objectiveId === "string" && objectiveId.length > 0, "objectiveId must be a non-empty string");
    check(objectives.has(objectiveId), `unknown objective "${objectiveId}"`);
    return objectives.get(objectiveId);
  };
  // Create an objective.
  const createObjective = ({ title, ownerId }) => {
    check(typeof title === "string" && title.trim().length > 0, "title must be a non-empty string");
    check(typeof ownerId === "string" && ownerId.length > 0, "ownerId must be a non-empty string");
    const objectiveId = `obj-${++objectiveCounter}`;
    const objective = { objectiveId, title: title.trim(), ownerId, keyResults: [] };
    objectives.set(objectiveId, objective);
    return Object.freeze({ objectiveId, title: objective.title, ownerId, keyResults: Object.freeze([]) });
  };
  // Add a key result to an objective.
  const addKeyResult = (objectiveId, { description, target, unit }) => {
    const objective = getObjective(objectiveId);
    check(typeof description === "string" && description.trim().length > 0,
      "description must be a non-empty string");
    check(typeof target === "number" && target > 0, "target must be a positive number");
    check(unit === undefined || (typeof unit === "string" && unit.length > 0),
      "unit must be a non-empty string if given");
    const kr = { krId: `kr-${++krCounter}`, description: description.trim(),
      target, current: 0, unit: unit ?? null };
    objective.keyResults.push(kr);
    return Object.freeze({ ...kr });
  };
  // Update a key result's current value.
  const updateProgress = (objectiveId, { krId, current }) => {
    const objective = getObjective(objectiveId);
    check(typeof krId === "string" && krId.length > 0, "krId must be a non-empty string");
    check(typeof current === "number" && current >= 0, "current must be a non-negative number");
    const kr = objective.keyResults.find(k => k.krId === krId);
    check(kr !== undefined, `unknown key result "${krId}"`);
    kr.current = current;
    return Object.freeze({ ...kr, progress: Math.min(1, current / kr.target) });
  };
  // Score an objective (average of key-result progress).
  const score = objectiveId => {
    const objective = getObjective(objectiveId);
    check(objective.keyResults.length > 0, `objective "${objectiveId}" has no key results`);
    const progresses = objective.keyResults.map(kr => Math.min(1, kr.current / kr.target));
    const average = progresses.reduce((a, b) => a + b, 0) / progresses.length;
    return Object.freeze({ objectiveId, score: average,
      keyResults: Object.freeze(objective.keyResults.map(kr =>
        Object.freeze({ ...kr, progress: Math.min(1, kr.current / kr.target) }))) });
  };
  return Object.freeze({ createObjective, addKeyResult, updateProgress, score });
}
export { OkrError };
