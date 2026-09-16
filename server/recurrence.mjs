// Recurrence detector (W005). A pure detector: given lessons, identify
// recurring themes that should be promoted to procedures. Uses simple
// keyword overlap to find clusters. The module is pure and dependency-
// free. Frozen outputs; malformed inputs throw RecurrenceError. Promotion
// UI is a later slice.
class RecurrenceError extends Error { constructor(code, message) { super(message); this.name = "RecurrenceError"; this.code = code; } }
const fail = (code, message) => { throw new RecurrenceError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_recurrence", message); };
// Tokenize text for keyword comparison.
function keywords(text) {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 3));
}
// Detect recurring lesson themes.
// lessons: [{ lessonId, title, content }]
// Returns [{ theme, lessonIds, count }] for themes with 2+ lessons.
export function detectRecurrence({ lessons, minCount }) {
  check(Array.isArray(lessons), "lessons must be an array");
  check(minCount === undefined || (Number.isInteger(minCount) && minCount >= 2),
    "minCount must be >= 2 if given");
  const threshold = minCount || 2;
  const clusters = [];
  const used = new Set();
  for (let i = 0; i < lessons.length; i++) {
    if (used.has(i)) continue;
    const lesson = lessons[i];
    check(typeof lesson.lessonId === "string", "lessonId must be a string");
    check(typeof lesson.content === "string", "content must be a string");
    const kw = keywords(lesson.title + " " + lesson.content);
    const group = [lesson];
    used.add(i);
    for (let j = i + 1; j < lessons.length; j++) {
      if (used.has(j)) continue;
      const other = lessons[j];
      const otherKw = keywords(other.title + " " + other.content);
      const overlap = [...kw].filter(k => otherKw.has(k)).length;
      const similarity = overlap / Math.max(kw.size, otherKw.size, 1);
      if (similarity > 0.3) {
        group.push(other);
        used.add(j);
      }
    }
    if (group.length >= threshold) {
      // Extract common theme from shared keywords.
      const common = [...kw].filter(k =>
        group.every(l => keywords(l.title + " " + l.content).has(k)));
      clusters.push(Object.freeze({ theme: common.slice(0, 5).join(", ") || "recurring theme",
        lessonIds: Object.freeze(group.map(l => l.lessonId)), count: group.length }));
    }
  }
  clusters.sort((a, b) => b.count - a.count);
  return Object.freeze(clusters);
}
export { RecurrenceError };
