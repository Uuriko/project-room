// W004: lesson submission flow. Pure manager tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createLessons, LessonError } from "../server/lessons.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof LessonError && error.code === code);

test("submit/list/review lifecycle", () => {
  const lm = createLessons();
  const lesson = lm.submit({ agentId: "quill", title: "Test Lesson",
    content: "Always do X before Y.", tags: ["deploy"] });
  assert.ok(lesson.lessonId.startsWith("lesson-"));
  assert.equal(lesson.status, "pending");
  assert.ok(Object.isFrozen(lesson));
  assert.equal(lm.list({ status: "pending" }).length, 1);
  const approved = lm.review(lesson.lessonId, { approved: true, reviewerId: "john" });
  assert.equal(approved.status, "approved");
  assert.equal(lm.list({ status: "pending" }).length, 0);
});
test("malformed inputs are refused", () => {
  const lm = createLessons();
  throwsCode(() => lm.submit({ agentId: "a", title: "", content: "x" }), "invalid_lesson");
  throwsCode(() => lm.review("ghost", { approved: true, reviewerId: "r" }), "invalid_lesson");
});
