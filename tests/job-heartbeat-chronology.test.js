// Chronology guard for the outcome fold (inherited defect, reproduced
// by Codex at main c1c92c5b, accepted for cure alongside the attempt-ID
// heartbeat in PR #5571).
//
// applyOutcomes folded outcomes in array order with no chronology
// guard: an outcome older than the recorded state rewrote that state
// as if it were the newest run. A newer failure followed by an older
// success moved lastRunAt BACKWARD and reset consecutiveFailures to
// 0 — a failing job presented as freshly succeeded. The fold is now
// monotonic: an outcome older than the recorded lastRunAt folds
// nothing (its exact-ID attempt resolution still runs; see the
// attempt-ID cure in tests/job-heartbeat-attempt.test.js).

import test from "node:test";
import assert from "node:assert/strict";
import { applyAttempts, applyOutcomes } from "../cloudflare/job-heartbeat.mjs";

const T0 = 1_800_000_000_000; // arbitrary fixed epoch ms; all clocks explicit
const OLDER = T0 + 60_000;
const NEWER = T0 + 120_000;

test("newer failure then older success in one fold: lastRunAt does not move backward, consecutiveFailures is not reset", () => {
  const stored = applyOutcomes({}, [
    { job: "integrity", ok: false, at: NEWER, error: "newer boom", durationMs: 5 },
    { job: "integrity", ok: true, at: OLDER, durationMs: 5, summary: { checked: 1 } }
  ]);
  assert.equal(stored.integrity.lastRunAt, NEWER, "the older success must not rewind the run clock");
  assert.equal(stored.integrity.consecutiveFailures, 1, "the older success must not erase the newer failure");
  assert.equal(stored.integrity.lastErrorAt, NEWER);
  assert.equal("lastSuccessAt" in stored.integrity, false, "no success was ever the newest outcome");
});

test("an older success arriving in a later fold does not rewind stored state either", () => {
  let stored = applyOutcomes({}, [{ job: "integrity", ok: true, at: T0, durationMs: 5, summary: { checked: 1 } }]);
  stored = applyOutcomes(stored, [{ job: "integrity", ok: false, at: NEWER, error: "newer boom", durationMs: 5 }]);
  stored = applyOutcomes(stored, [{ job: "integrity", ok: true, at: OLDER, durationMs: 5, summary: { checked: 2 } }]);
  assert.equal(stored.integrity.lastRunAt, NEWER);
  assert.equal(stored.integrity.consecutiveFailures, 1);
  assert.equal(stored.integrity.lastSuccessAt, T0, "the stale success does not freshen the success clock");
});

test("newer success then older failure in one fold: the older failure does not rewind state", () => {
  const stored = applyOutcomes({}, [
    { job: "integrity", ok: true, at: NEWER, durationMs: 5, summary: { checked: 1 } },
    { job: "integrity", ok: false, at: OLDER, error: "older boom", durationMs: 5 }
  ]);
  assert.equal(stored.integrity.lastRunAt, NEWER, "the older failure must not rewind the run clock");
  assert.equal(stored.integrity.consecutiveFailures, 0, "the older failure must not fail a job whose newest outcome succeeded");
  assert.equal(stored.integrity.lastSuccessAt, NEWER);
  assert.equal(stored.integrity.lastError ?? null, null, "the older error does not overwrite the newer state");
});

test("an older failure after a newer failure neither rewinds nor double-counts", () => {
  const stored = applyOutcomes({}, [
    { job: "integrity", ok: false, at: NEWER, error: "newer boom", durationMs: 5 },
    { job: "integrity", ok: false, at: OLDER, error: "older boom", durationMs: 5 }
  ]);
  assert.equal(stored.integrity.lastRunAt, NEWER);
  assert.equal(stored.integrity.consecutiveFailures, 1);
  assert.match(stored.integrity.lastError, /newer boom/);
});

test("chronological folds are unchanged: a failure then a later success still resets the streak", () => {
  const stored = applyOutcomes({}, [
    { job: "integrity", ok: false, at: OLDER, error: "boom", durationMs: 5 },
    { job: "integrity", ok: true, at: NEWER, durationMs: 5, summary: { checked: 1 } }
  ]);
  assert.equal(stored.integrity.lastRunAt, NEWER);
  assert.equal(stored.integrity.lastSuccessAt, NEWER);
  assert.equal(stored.integrity.consecutiveFailures, 0);
});

test("an outcome at exactly the recorded lastRunAt is not stale and still folds", () => {
  const stored = applyOutcomes({}, [
    { job: "integrity", ok: false, at: NEWER, error: "boom", durationMs: 5 },
    { job: "integrity", ok: true, at: NEWER, durationMs: 5, summary: { checked: 1 } }
  ]);
  assert.equal(stored.integrity.consecutiveFailures, 0, "equal timestamps keep the pre-existing fold semantics");
  assert.equal(stored.integrity.lastSuccessAt, NEWER);
});

test("a stale outcome still resolves its own attempt on an exact ID match, without rewinding health state", () => {
  let stored = applyOutcomes({}, [{ job: "integrity", ok: true, at: T0, durationMs: 5, summary: { checked: 1 } }]);
  stored = applyAttempts(stored, [{ job: "integrity", at: OLDER, attemptId: "attempt-1" }]);
  stored = applyOutcomes(stored, [{ job: "integrity", ok: false, at: NEWER, error: "newer boom", durationMs: 5 }]);
  // attempt-1's own completion arrives late, older than the recorded state.
  stored = applyOutcomes(stored, [{ job: "integrity", ok: true, at: OLDER, attemptId: "attempt-1", durationMs: 5, summary: { checked: 2 } }]);
  assert.equal(stored.integrity.attemptOutcome, "committed", "the attempt-ID cure is preserved: the matching completion resolves its attempt");
  assert.equal(stored.integrity.lastRunAt, NEWER, "but its stale success folds nothing");
  assert.equal(stored.integrity.consecutiveFailures, 1);
  assert.equal(stored.integrity.lastSuccessAt, T0);
});
