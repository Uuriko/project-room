// Placeholder to prove the annotation-escaping contract fails before the fix.
import test from "node:test";
import assert from "node:assert/strict";
import { driftAnnotations } from "../scripts/review-mechanical-report.mjs";

test("driftAnnotations escapes workflow-command special characters", () => {
  const lines = driftAnnotations({ drift: ["we:ird,%.mjs"] });
  assert.equal(lines.length, 1);
  // Property escaping: : -> %3A, , -> %2C, % -> %25.
  assert.ok(lines[0].startsWith("::warning file=we%3Aird%2C%25.mjs::"));
});

test("driftAnnotations escapes CR/LF in the message", () => {
  const lines = driftAnnotations({ drift: ["a\r\nb.mjs"] });
  assert.ok(lines[0].includes("a%0D%0Ab.mjs"));
});

test("driftAnnotations returns one line per drifted file", () => {
  const lines = driftAnnotations({ drift: ["a.mjs", "b.mjs"] });
  assert.equal(lines.length, 2);
  assert.ok(lines.every(l => l.startsWith("::warning file=")));
});

test("driftAnnotations is empty when there is no drift", () => {
  assert.deepEqual(driftAnnotations({ drift: [] }), []);
});
