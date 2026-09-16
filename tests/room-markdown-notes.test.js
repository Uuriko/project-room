// K016: collaborative markdown notes. Pure note tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createNotes, NoteError } from "../server/room-notes.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof NoteError && error.code === code);

test("get/edit/history lifecycle", () => {
  const notes = createNotes();
  const initial = notes.get("room1");
  assert.equal(initial.content, "");
  assert.equal(initial.revision, 0);
  const edited = notes.edit("room1", { baseRevision: 0, content: "# Hello", authorId: "ada" });
  assert.equal(edited.revision, 1);
  assert.ok(Object.isFrozen(edited));
  const history = notes.history("room1");
  assert.equal(history.length, 1);
  assert.equal(history[0].content, "");
});
test("revision conflict is refused", () => {
  const notes = createNotes();
  notes.edit("room1", { baseRevision: 0, content: "v1", authorId: "ada" });
  throwsCode(() => notes.edit("room1", { baseRevision: 0, content: "v2", authorId: "bob" }),
    "invalid_note"); // stale base
});
test("malformed inputs are refused", () => {
  const notes = createNotes();
  throwsCode(() => notes.edit("r", { baseRevision: 0, content: "x".repeat(100001), authorId: "a" }),
    "invalid_note");
});
