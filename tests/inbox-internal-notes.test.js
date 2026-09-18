// LANE C (quill/inbox-agent-collab): internal side-notes — private thread
// context plus the contract that keeps it out of channel payloads.
import test from "node:test";
import assert from "node:assert/strict";
import { NoteError, assertNoInternal, createInternalNotes, internalFieldNames,
  stripInternal } from "../server/inbox-internal-notes.mjs";

const agent = { kind: "agent", id: "claude" };
const human = { kind: "human", id: "john" };
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.ok(error instanceof NoteError); assert.equal(error.code, code); return; }
  assert.fail(`expected ${code} but nothing threw`);
};
const fixedClock = (times = [1000]) => { let i = 0; return () => times[Math.min(i++, times.length - 1)]; };
const ids = (() => { let n = 0; return () => `note-${++n}`; })();

test("addNote stamps internal: true, author, timestamps; output is frozen", () => {
  const notes = createInternalNotes({ clock: fixedClock([1000]), id: ids });
  const note = notes.addNote("thread:1", { author: agent, body: "Tried the polite opener.", tag: "attempt" });
  assert.equal(note.noteId, "note-1");
  assert.equal(note.threadId, "thread:1");
  assert.equal(note.internal, true);
  assert.equal(note.tag, "attempt");
  assert.equal(note.createdAt, "1970-01-01T00:00:01.000Z");
  assert.equal(note.updatedAt, null);
  assert.equal(note.deleted, false);
  assert.ok(Object.isFrozen(note) && Object.isFrozen(note.author));
});
test("listNotes is per-thread and hides deleted notes unless asked", () => {
  const notes = createInternalNotes({ clock: fixedClock([1000, 2000, 3000]), id: ids });
  const first = notes.addNote("thread:1", { author: agent, body: "one" });
  notes.addNote("thread:2", { author: human, body: "other thread" });
  notes.deleteNote(first.noteId, { author: agent });
  assert.equal(notes.listNotes("thread:1").length, 0);
  assert.equal(notes.listNotes("thread:1", { includeDeleted: true }).length, 1);
  assert.equal(notes.listNotes("thread:2").length, 1);
});
test("only the original author may edit or delete", () => {
  const notes = createInternalNotes({ clock: fixedClock([1000, 2000]), id: ids });
  const note = notes.addNote("thread:1", { author: agent, body: "draft" });
  expectCode(() => notes.editNote(note.noteId, { author: human, body: "hijack" }), "note_forbidden");
  expectCode(() => notes.deleteNote(note.noteId, { author: human }), "note_forbidden");
  const edited = notes.editNote(note.noteId, { author: agent, body: "revised" });
  assert.equal(edited.body, "revised");
  assert.ok(edited.updatedAt !== null);
});
test("editing a deleted note is refused; unknown notes are note_not_found", () => {
  const notes = createInternalNotes({ clock: fixedClock([1000, 2000]), id: ids });
  const note = notes.addNote("thread:1", { author: agent, body: "gone" });
  notes.deleteNote(note.noteId, { author: agent });
  expectCode(() => notes.editNote(note.noteId, { author: agent, body: "x" }), "note_invalid");
  expectCode(() => notes.editNote("note-missing", { author: agent, body: "x" }), "note_not_found");
});
test("assertNoInternal passes clean payloads and throws on internal material", () => {
  assert.equal(assertNoInternal({ subject: "Hi", body: "hello" }), true);
  assert.equal(assertNoInternal([1, { nested: { ok: true } }]), true);
  expectCode(() => assertNoInternal({ internalNotes: [{ body: "leak" }] }), "note_contract_violation");
  expectCode(() => assertNoInternal({ envelope: { internal: true, body: "x" } }), "note_contract_violation");
  expectCode(() => assertNoInternal({ deep: { deeper: { sideNotes: [] } } }), "note_contract_violation");
});
test("stripInternal removes flagged nodes and banned fields without mutating the input", () => {
  const payload = { subject: "Hi", internalNotes: [{ body: "secret" }],
    attachments: [{ name: "a", internal: true, body: "x" }, { name: "b" }] };
  const stripped = stripInternal(payload);
  assert.deepEqual(stripped, { subject: "Hi", attachments: [{ name: "b" }] });
  assert.ok(Object.isFrozen(stripped));
  assert.equal(payload.attachments.length, 2, "input is not mutated");
  assert.equal(assertNoInternal(stripped), true);
});
test("validation rejects bad bodies, tags and threads", () => {
  const notes = createInternalNotes({ id: ids });
  expectCode(() => notes.addNote("thread:1", { author: agent, body: "" }), "note_invalid");
  expectCode(() => notes.addNote("thread:1", { author: agent, body: "x".repeat(4001) }), "note_invalid");
  expectCode(() => notes.addNote("thread:1", { author: agent, body: "ok", tag: "BAD TAG" }), "note_invalid");
  expectCode(() => notes.addNote("", { author: agent, body: "ok" }), "note_invalid");
});
test("internal field names are a frozen denylist", () => {
  assert.ok(internalFieldNames.includes("internalNotes") && internalFieldNames.includes("internal_notes"));
  assert.ok(Object.isFrozen(internalFieldNames));
});
