// Shared character policy. Callers refuse or fold with these results;
// this test owns the classification order and the fold itself.
import test from "node:test";
import assert from "node:assert/strict";
import { invisibleCharIssue, foldSearchText } from "../server/text-policy.mjs";

test("one invisible class is named, tags before bidi before zero-width", () => {
  assert.equal(invisibleCharIssue(""), null);
  assert.equal(invisibleCharIssue("notes.txt"), null);
  assert.equal(invisibleCharIssue("a\u{E0000}\u202E\u200B"), "Unicode tag characters (U+E0000-E007F)");
  assert.equal(invisibleCharIssue("a\u202E\u200B"), "bidirectional embedding, override or isolate characters (U+202A-202E, U+2066-2069)");
  assert.equal(invisibleCharIssue("a\u200B"), "zero-width characters");
  assert.equal(invisibleCharIssue("a\uFEFF"), "zero-width characters");
});

test("search fold equates café and İstanbul and drops a lone combining dot", () => {
  assert.equal(foldSearchText("cafe\u0301"), foldSearchText("CAFÉ"));
  assert.equal(foldSearchText("İstanbul"), foldSearchText("istanbul"));
  assert.equal(foldSearchText("Istanbul"), foldSearchText("İSTANBUL"));
  assert.equal(foldSearchText("\u0307"), "");
});
