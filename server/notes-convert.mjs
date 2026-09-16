// Meeting notes to work items (K022). A pure converter: parse markdown
// meeting notes and extract work-item candidates (checkboxes, action
// lines, assignee mentions). Returns work-item drafts compatible with the
// work-item template gallery. The module is pure and dependency-free.
// Frozen outputs; malformed inputs throw NotesError. UI wiring is a later
// slice.
class NotesError extends Error { constructor(code, message) { super(message); this.name = "NotesError"; this.code = code; } }
const fail = (code, message) => { throw new NotesError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_notes", message); };
const CHECKBOX_RE = /^[-*]\s*\[([ xX])\]\s*(.+)$/;
const ACTION_RE = /^(action|todo)\s*[:\-]\s*(.+)$/i;
const MENTION_RE = /@([a-zA-Z0-9_-]+)/;
// Convert markdown meeting notes into work-item drafts.
// Returns [{ title, assignees, source }] — source is the original line.
export function notesToWorkItems({ markdown }) {
  check(typeof markdown === "string", "markdown must be a string");
  check(markdown.length <= 200000, "markdown exceeds 200k character limit");
  const drafts = [];
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let title = null;
    const checkbox = line.match(CHECKBOX_RE);
    if (checkbox) {
      if (checkbox[1].toLowerCase() === "x") continue; // already done
      title = checkbox[2].trim();
    } else {
      const action = line.match(ACTION_RE);
      if (action) title = action[2].trim();
    }
    if (!title) continue;
    const assignees = [...title.matchAll(new RegExp(MENTION_RE.source, "g"))].map(m => m[1]);
    const cleanTitle = title.replace(new RegExp(MENTION_RE.source, "g"), "").replace(/\s+/g, " ").trim();
    check(cleanTitle.length > 0, "work item title must not be empty");
    drafts.push(Object.freeze({ title: cleanTitle, assignees: Object.freeze(assignees),
      source: line }));
  }
  return Object.freeze(drafts);
}
export { NotesError };
