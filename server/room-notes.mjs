// Collaborative markdown notes (K016). A pure note manager: one markdown
// note per room, with optimistic-concurrency edits (base revision must
// match). Tracks revision history. All state is caller-owned (a Map); the
// module is pure and dependency-free. Frozen outputs; malformed inputs
// throw NoteError. Editor UI wiring is a later slice.
class NoteError extends Error { constructor(code, message) { super(message); this.name = "NoteError"; this.code = code; } }
const fail = (code, message) => { throw new NoteError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_note", message); };
// Create a note manager. store is a caller-owned Map (roomId -> { content, revision, history }).
export function createNotes({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const notes = store ?? new Map();
  const getNote = roomId => {
    check(typeof roomId === "string" && roomId.length > 0, "roomId must be a non-empty string");
    if (!notes.has(roomId)) {
      notes.set(roomId, { roomId, content: "", revision: 0, history: [] });
    }
    return notes.get(roomId);
  };
  // Get the current note.
  const get = roomId => {
    const note = getNote(roomId);
    return Object.freeze({ roomId, content: note.content, revision: note.revision });
  };
  // Edit the note. baseRevision must match current (optimistic concurrency).
  const edit = (roomId, { baseRevision, content, authorId }) => {
    const note = getNote(roomId);
    check(Number.isInteger(baseRevision) && baseRevision >= 0, "baseRevision must be a non-negative integer");
    check(typeof content === "string", "content must be a string");
    check(content.length <= 100000, "content exceeds 100k character limit");
    check(typeof authorId === "string" && authorId.length > 0, "authorId must be a non-empty string");
    check(baseRevision === note.revision,
      `revision conflict: expected ${note.revision}, got ${baseRevision}`);
    note.history.push(Object.freeze({ revision: note.revision, content: note.content, authorId }));
    note.content = content;
    note.revision++;
    return Object.freeze({ roomId, content, revision: note.revision });
  };
  // List revision history (newest first).
  const history = roomId => Object.freeze([...getNote(roomId).history].reverse());
  return Object.freeze({ get, edit, history });
}
export { NoteError };
