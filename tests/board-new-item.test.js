// S3 regression (also F-parity-1): the create API accepts a note, but the
// New item form never sent one. newItemCreateBody is the exact boundary the
// submit handler calls, so this guards the note wiring where it is built.
import test from "node:test";
import assert from "node:assert/strict";
import { newItemCreateBody, sameNewItemBody } from "../src/board-ui.js";

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

// Create idempotency: the id is the create's operation identity. A retry of
// an unchanged form-fill must reuse the first attempt's id — the server
// refuses a second item under one id (work_claim_exists), while a fresh id
// on every submit guaranteed a duplicate whenever the first response was
// lost. (HUNT-FRONTEND F1.)
test("a retry reuses the pending id instead of minting a duplicate", () => {
  const data = form({ title: "Fix the leak", note: "wrench", files: "a.md" });
  const first = newItemCreateBody(data);
  const retry = newItemCreateBody(data, first.id);
  assert.equal(retry.id, first.id);
  assert.deepEqual({ ...retry, id: null }, { ...first, id: null });
});

test("without a reuse id each call mints a fresh id", () => {
  const data = form({ title: "Fix the leak" });
  assert.notEqual(newItemCreateBody(data).id, newItemCreateBody(data).id);
});

test("sameNewItemBody treats only an unchanged form-fill as the same create", () => {
  const base = newItemCreateBody(form({ title: "Fix the leak", note: "wrench", files: "a.md, b.md" }));
  assert.equal(sameNewItemBody(base, newItemCreateBody(form({ title: "Fix the leak", note: "wrench", files: "a.md, b.md" }), base.id)), true);
  assert.equal(sameNewItemBody(base, newItemCreateBody(form({ title: "Fix the leak!" }))), false, "edited title is a new item");
  assert.equal(sameNewItemBody(base, newItemCreateBody(form({ title: "Fix the leak", note: "edited", files: "a.md, b.md" }))), false, "edited note is a new item");
  assert.equal(sameNewItemBody(base, newItemCreateBody(form({ title: "Fix the leak", note: "wrench", files: "a.md" }))), false, "edited files are a new item");
  assert.equal(sameNewItemBody(base, null), false);
  assert.equal(sameNewItemBody(null, base), false);
});
