// Seeded interleaving generator — shared machine for the #3676 / #3677
// harness family (PR-0, PREP-3676-3677 §S.1 item 3 / §B.3).
//
// #3676's R8 concurrent-duplicate test and #3677's mutation interleavings
// are the same machine with different op sets: a deterministic, seeded
// ordering of operations. Concurrency is modelled by the ORDER of ops in
// the generated trace (duplicates submitted before the first completes,
// mutations landing between walk pages), never by timers.
//
// Discipline: no wall-clock anywhere in this module — it reads no clock
// and schedules no timers. Every run is reproducible from its seed, and
// the seed is attached to any failure this module raises.

// mulberry32: small, well-known seeded PRNG; deterministic across runs
// and platforms for a given 32-bit seed.
export function createSeededRng(seed) {
  let state = (typeof seed === "string" ? seedFromString(seed) : seed) >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFromString(text) {
  let hash = 0x811C9DC5;
  for (let i = 0; i < String(text).length; i++) {
    hash ^= String(text).charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// Op sets. An op is a name plus an optional payload factory (rng, index).
export const SUBMIT_DUPLICATE_OPS = Object.freeze([
  "submit", "submitDuplicate", "submitDuplicate", "submitForeignScope",
  "submitDifferentPayload", "readEffectCount",
]);
export const MUTATION_WALK_OPS = Object.freeze([
  "walkNext", "insertBeforeCursor", "insertAfterCursor", "deleteUnvisited",
  "deleteVisited", "moveItem", "visibilityFlip", "walkNext",
]);

// Generate a trace: `count` ops drawn from `ops` with the seeded rng.
// Weighted draw when an op entry is { name, weight }; plain names weigh 1.
export function generateInterleaving({ seed, count = 16, ops }) {
  if (!Array.isArray(ops) || ops.length === 0) throw new TypeError("ops must be a non-empty array");
  const rng = createSeededRng(seed);
  const weighted = ops.map(op => typeof op === "string" ? { name: op, weight: 1 } : op);
  const totalWeight = weighted.reduce((sum, op) => sum + (op.weight ?? 1), 0);
  const trace = [];
  for (let index = 0; index < count; index++) {
    let pick = rng() * totalWeight;
    let chosen = weighted[weighted.length - 1];
    for (const op of weighted) {
      pick -= op.weight ?? 1;
      if (pick < 0) { chosen = op; break; }
    }
    trace.push({ index, op: chosen.name, ...(chosen.make ? chosen.make(rng, index) : {}) });
  }
  return { seed, trace };
}

// Execute a trace against handlers { [opName]: (step) => any }. A handler
// failure is rethrown with the seed and step attached, and the message
// names the seed — print it, rerun with it, reproduce it.
export function runInterleaving({ seed, trace, handlers }) {
  const results = [];
  for (const step of trace) {
    const handler = handlers[step.op];
    if (typeof handler !== "function") {
      const err = new Error(`seed ${seed}: no handler for op "${step.op}" at step ${step.index}`);
      err.seed = seed; err.step = step;
      throw err;
    }
    try {
      results.push(handler(step));
    } catch (cause) {
      const err = new Error(`seed ${seed}: op "${step.op}" failed at step ${step.index}: ${cause?.message ?? cause}`);
      err.seed = seed; err.step = step; err.cause = cause;
      throw err;
    }
  }
  return results;
}
