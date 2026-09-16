// K022: meeting notes to work items. Pure converter tests.
import test from "node:test";
import assert from "node:assert/strict";
import { notesToWorkItems, NotesError } from "../server/notes-convert.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof NotesError && error.code === code);

test("extracts checkboxes and action lines", () => {
  const markdown = `# Standup
- [ ] Fix the login bug @ada
- [x] Already done
- [ ] Update docs
Action: deploy Friday @bob
Just a normal line`;
  const drafts = notesToWorkItems({ markdown });
  assert.equal(drafts.length, 3);
  assert.equal(drafts[0].title, "Fix the login bug");
  assert.deepEqual(drafts[0].assignees, ["ada"]);
  assert.equal(drafts[1].title, "Update docs");
  assert.equal(drafts[2].title, "deploy Friday");
  assert.deepEqual(drafts[2].assignees, ["bob"]);
  assert.ok(Object.isFrozen(drafts));
});
test("malformed inputs are refused", () => {
  throwsCode(() => notesToWorkItems({ markdown: 123 }), "invalid_notes");
});
