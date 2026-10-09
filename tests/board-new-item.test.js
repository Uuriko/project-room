// S3 regression (also F-parity-1): the create API accepts a note, but the
// New item form never sent one. newItemCreateBody is the exact boundary the
// submit handler calls, so this guards the note wiring where it is built.
import test from "node:test";
import assert from "node:assert/strict";
import { newItemCreateBody } from "../src/board-ui.js";

const form = (entries) => new Map(Object.entries(entries).map(([k, v]) => [k, v]));

test("note is included in the create body when provided", () => {
  const body = newItemCreateBody(form({ title: "Fix the leak", note: "Behind the sink, bring a wrench." }));
  assert.ok(body, "empty title returned null unexpectedly");
  assert.equal(body.title, "Fix the leak");
  assert.equal(body.note, "Behind the sink, bring a wrench.");
  assert.match(body.id, /^[a-z0-9-]{1,128}$/);
});

test("note is omitted when empty or absent", () => {
  assert.ok(!("note" in newItemCreateBody(form({ title: "Tidy up", note: "   " }))), "blank note leaked through");
  assert.ok(!("note" in newItemCreateBody(form({ title: "Tidy up" }))), "missing note leaked through");
});

test("files still flow through alongside the note", () => {
  const body = newItemCreateBody(form({ title: "Docs", note: "Read me", files: "a.md, b.md" }));
  assert.deepEqual(body.files, ["a.md", "b.md"]);
  assert.equal(body.note, "Read me");
});

test("empty title returns null so nothing is submitted", () => {
  assert.equal(newItemCreateBody(form({ title: "  ", note: "orphan" })), null);
  assert.equal(newItemCreateBody(form({})), null);
});

// FIX-45: files is required on creation — the form always sends it, with a
// blank field as an explicit [] ("touches no files"), never omitted.
test("files is always sent: blank field becomes an explicit empty declaration", () => {
  const blank = newItemCreateBody(form({ title: "Call John" }));
  assert.deepEqual(blank.files, []);
  const filled = newItemCreateBody(form({ title: "Fix", files: "a.md" }));
  assert.deepEqual(filled.files, ["a.md"]);
});
