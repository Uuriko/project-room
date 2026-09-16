// Lesson submission flow (W004). A pure lesson validator and submitter:
// any agent can submit a lesson with title, content, and tags. Validates
// schema, normalizes, and returns a submission receipt. All state is
// caller-owned (a Map); the module is pure and dependency-free. Frozen
// outputs; malformed inputs throw LessonError. Review UI is a later slice.
class LessonError extends Error { constructor(code, message) { super(message); this.name = "LessonError"; this.code = code; } }
const fail = (code, message) => { throw new LessonError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_lesson", message); };
// Create a lesson submission manager. store is a caller-owned Map (lessonId -> lesson).
export function createLessons({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const lessons = store ?? new Map();
  let lessonCounter = 0;
  // Submit a lesson.
  const submit = ({ agentId, title, content, tags }) => {
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be non-empty");
    check(typeof title === "string" && title.trim().length > 0, "title must be non-empty");
    check(title.trim().length <= 200, "title must be 200 chars or less");
    check(typeof content === "string" && content.trim().length > 0, "content must be non-empty");
    check(content.trim().length <= 10000, "content must be 10000 chars or less");
    check(tags === undefined || (Array.isArray(tags) && tags.every(t => typeof t === "string")),
      "tags must be an array of strings if given");
    const lessonId = `lesson-${++lessonCounter}`;
    const lesson = Object.freeze({ lessonId, agentId, title: title.trim(),
      content: content.trim(), tags: Object.freeze([...(tags || [])]),
      status: "pending", submittedAt: new Date().toISOString() });
    lessons.set(lessonId, lesson);
    return lesson;
  };
  // List lessons (optionally filtered by status).
  const list = ({ status } = {}) => {
    check(status === undefined || ["pending", "approved", "rejected"].includes(status),
      "status must be pending, approved, or rejected if given");
    const result = [...lessons.values()].filter(l => !status || l.status === status);
    return Object.freeze(result);
  };
  // Review a lesson (approve/reject).
  const review = (lessonId, { approved, reviewerId }) => {
    check(typeof lessonId === "string", "lessonId must be a string");
    check(typeof approved === "boolean", "approved must be a boolean");
    check(typeof reviewerId === "string" && reviewerId.length > 0, "reviewerId must be non-empty");
    check(lessons.has(lessonId), `unknown lesson "${lessonId}"`);
    const lesson = lessons.get(lessonId);
    check(lesson.status === "pending", "only pending lessons can be reviewed");
    const updated = Object.freeze({ ...lesson, status: approved ? "approved" : "rejected",
      reviewerId, reviewedAt: new Date().toISOString() });
    lessons.set(lessonId, updated);
    return updated;
  };
  return Object.freeze({ submit, list, review });
}
export { LessonError };
