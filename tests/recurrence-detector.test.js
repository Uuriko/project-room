// W005: recurrence detector. Pure detector tests.
import test from "node:test";
import assert from "node:assert/strict";
import { detectRecurrence, RecurrenceError } from "../server/recurrence.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof RecurrenceError && error.code === code);

test("detects recurring themes", () => {
  const clusters = detectRecurrence({ lessons: [
    { lessonId: "l1", title: "Deploy checklist", content: "Always verify the deployment pipeline before shipping to production." },
    { lessonId: "l2", title: "Deploy verification", content: "Verify the deployment pipeline and run smoke tests before shipping." },
    { lessonId: "l3", title: "Lunch spots", content: "Great tacos near the office." },
  ]});
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].count, 2);
  assert.deepEqual(clusters[0].lessonIds, ["l1", "l2"]);
  assert.ok(Object.isFrozen(clusters));
});
test("no clusters when nothing recurs", () => {
  const clusters = detectRecurrence({ lessons: [
    { lessonId: "l1", title: "Apples", content: "Fruit is healthy." },
    { lessonId: "l2", title: "Zebras", content: "Striped animals." },
  ]});
  assert.equal(clusters.length, 0);
});
test("malformed inputs are refused", () => {
  throwsCode(() => detectRecurrence({ lessons: "nope" }), "invalid_recurrence");
  throwsCode(() => detectRecurrence({ lessons: [], minCount: 1 }), "invalid_recurrence");
});
