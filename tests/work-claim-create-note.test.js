// SEC2: createWork() must bound the create note. The note lands on the
// "created" history stamp and is served on every board list, so an unbounded
// note is a storage/amplification vector for any direct API caller (the
// S3 New-item form caps at 4000 chars, but the API path had no cap).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWork } from "../server/work-claims.mjs";

const T0 = Date.parse("2026-10-04T20:00:00.000Z");
const mk = note => createWork({ id: "n1", title: "T", note }, { now: T0 });

test("createWork accepts a short string note and stores it on the created stamp", () => {
  const item = mk("context for whoever picks this up");
  assert.equal(item.history[0].action, "created");
  assert.equal(item.history[0].note, "context for whoever picks this up");
});

test("createWork accepts a missing or null note", () => {
  assert.equal(mk(undefined).history[0].note, null);
  assert.equal(mk(null).history[0].note, null);
});

test("createWork accepts a note at the 4000-char form bound", () => {
  assert.equal(mk("x".repeat(4000)).history[0].note.length, 4000);
});

test("createWork rejects an over-long note", () => {
  assert.throws(() => mk("x".repeat(4001)), /at most 4000/);
});

test("createWork rejects a non-string note", () => {
  assert.throws(() => mk({ text: "hi" }), /must be a string/);
  assert.throws(() => mk(42), /must be a string/);
});
