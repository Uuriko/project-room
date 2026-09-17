// G009: retention cohorts. Pure cohort tests; no store.
import test from "node:test";
import assert from "node:assert/strict";
import { retentionCohorts, CohortError } from "../server/growth-cohorts.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof CohortError && error.code === code);
const events = () => [
  { type: "member.joined", actorId: "a", at: "2026-09-07T10:00:00Z" }, // Monday cohort
  { type: "room.post", actorId: "a", at: "2026-09-08T10:00:00Z" },   // same week
  { type: "room.post", actorId: "a", at: "2026-09-14T10:00:00Z" },   // next week
  { type: "member.joined", actorId: "b", at: "2026-09-08T10:00:00Z" }, // same cohort, churns
];

test("retentionCohorts buckets weekly and reports week-N retention", () => {
  const cohorts = retentionCohorts(events(), { weeks: 2 });
  assert.equal(cohorts.length, 1);
  assert.equal(cohorts[0].cohort, "2026-09-07");
  assert.equal(cohorts[0].size, 2);
  assert.deepEqual(cohorts[0].retention, [100, 50]);
  assert.ok(Object.isFrozen(cohorts) && Object.isFrozen(cohorts[0].retention));
});
test("multiple cohorts stay separate", () => {
  const cohorts = retentionCohorts([
    { type: "member.joined", actorId: "a", at: "2026-09-07T10:00:00Z" },
    { type: "member.joined", actorId: "b", at: "2026-09-14T10:00:00Z" },
  ], { weeks: 1 });
  assert.deepEqual(cohorts.map(c => c.cohort), ["2026-09-07", "2026-09-14"]);
  assert.deepEqual(retentionCohorts([], {}), []);
});
test("malformed inputs are refused", () => {
  throwsCode(() => retentionCohorts("nope"), "invalid_cohort_input");
  throwsCode(() => retentionCohorts([{ actorId: "a", at: "bad" }]), "invalid_cohort_input");
  throwsCode(() => retentionCohorts([], { weeks: 99 }), "invalid_cohort_input");
});
