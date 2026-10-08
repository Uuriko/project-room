// Trace comparator for the parity suite.
//
// compareTraces(legacyTrace, herdrTrace) -> string[] of human-readable
// diffs. Empty means the two runs produced IDENTICAL room-observable
// outcomes: claim states, journal entries, API response shapes (claim card,
// session card, heartbeat presence record), and event sequences.
//
// The `backend` tag is stripped before comparison — it is the only field
// allowed to differ. Everything else must be deep-equal. Timestamps are
// NOT normalized: both runs share the virtual clock schedule, so any
// timestamp divergence is a real divergence.
import assert from "node:assert/strict";

const COMPARED_STEP_FIELDS = Object.freeze(["op", "claim", "sessionCard", "journalDelta", "heartbeat", "events"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Recursive differ producing JSON-pointer-ish paths.
function* diffDeep(a, b, path) {
  if (Object.is(a, b)) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      yield `${path}: array length differs (${a.length} vs ${b.length})`;
      return;
    }
    for (let i = 0; i < a.length; i++) yield* diffDeep(a[i], b[i], `${path}[${i}]`);
    return;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!(key in a)) { yield `${path}.${key}: missing in legacy run`; continue; }
      if (!(key in b)) { yield `${path}.${key}: missing in herdr run`; continue; }
      yield* diffDeep(a[key], b[key], `${path}.${key}`);
    }
    return;
  }
  let aRepr, bRepr;
  try { aRepr = JSON.stringify(a) ?? String(a); } catch { aRepr = String(a); }
  try { bRepr = JSON.stringify(b) ?? String(b); } catch { bRepr = String(b); }
  yield `${path}: legacy=${aRepr} herdr=${bRepr}`;
}

function stripBackend(trace) {
  const { backend: _backend, ...rest } = trace;
  return rest;
}

export function compareTraces(legacyTrace, herdrTrace) {
  const diffs = [];
  if (legacyTrace.backend === herdrTrace.backend) {
    diffs.push(`both traces carry the same backend tag (${legacyTrace.backend}) — expected legacy vs herdr`);
  }
  const a = stripBackend(legacyTrace);
  const b = stripBackend(herdrTrace);
  // Step fields are compared explicitly so a missing field reads as a
  // divergence rather than silently passing.
  if (a.steps.length !== b.steps.length) {
    diffs.push(`steps: step count differs (${a.steps.length} vs ${b.steps.length})`);
  }
  const n = Math.min(a.steps.length, b.steps.length);
  for (let i = 0; i < n; i++) {
    for (const field of COMPARED_STEP_FIELDS) {
      if (!(field in a.steps[i])) diffs.push(`steps[${i}].${field}: missing in legacy run`);
      else if (!(field in b.steps[i])) diffs.push(`steps[${i}].${field}: missing in herdr run`);
      else diffs.push(...diffDeep(a.steps[i][field], b.steps[i][field], `steps[${i}].${field}`));
    }
  }
  diffs.push(...diffDeep(a.journal, b.journal, "journal"));
  diffs.push(...diffDeep(a.eventSequence, b.eventSequence, "eventSequence"));
  return diffs;
}

// Shared assertion helper used by the parity tests.
export function assertParity(legacyTrace, herdrTrace) {
  const diffs = compareTraces(legacyTrace, herdrTrace);
  assert.deepEqual(diffs, [], `parity divergences:\n${diffs.join("\n")}`);
}
