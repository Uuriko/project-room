// ask-batch.test.mjs — self-test for scripts/ask-batch.mjs (docs/ASK-BATCHING.md).
// Run: node --test scripts/ask-batch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAskBlock, formatRoom, formatReceipt } from "./ask-batch.mjs";

const good = {
  v: 1,
  workerId: "wave500-coord-cost-w13",
  waveId: "wave-500",
  questions: [
    { id: "q1", tag: "blocking", text: "Baseline harness: sample idle-loop CPU per worker or per wave?" },
    { id: "q2", tag: "blocking", text: "Board shows a protocol claim on ask-dispatch — overlap with ask-batching?" },
    { id: "q3", tag: "advisory", text: "Savings estimate: round-trip counts, wall-clock ms, or both?" },
    { id: "q4", tag: "advisory", text: "Should the validator lint question wording? Out of scope for v1?" },
  ],
};

test("valid block passes with no errors", () => {
  const { errors } = validateAskBlock(structuredClone(good));
  assert.deepEqual(errors, []);
});

test("rejects >5 questions", () => {
  const b = structuredClone(good);
  b.questions.push(
    { id: "q5", tag: "advisory", text: "Fifth question, still fine." },
    { id: "q6", tag: "advisory", text: "Sixth question breaks the cap." },
  );
  const { errors } = validateAskBlock(b);
  assert.ok(errors.some((e) => e.includes("exceeds max 5")), errors.join("; "));
});

test("rejects question text >140 chars", () => {
  const b = structuredClone(good);
  b.questions[0].text = "x".repeat(141);
  const { errors } = validateAskBlock(b);
  assert.ok(errors.some((e) => e.includes("exceeds max 140")), errors.join("; "));
});

test("rejects bad tag", () => {
  const b = structuredClone(good);
  b.questions[0].tag = "urgent";
  const { errors } = validateAskBlock(b);
  assert.ok(errors.some((e) => e.includes('.tag')), errors.join("; "));
});

test("rejects duplicate ids", () => {
  const b = structuredClone(good);
  b.questions[1].id = "q1";
  const { errors } = validateAskBlock(b);
  assert.ok(errors.some((e) => e.includes("duplicate id")), errors.join("; "));
});

test("rejects duplicate texts (normalized: case/whitespace-insensitive)", () => {
  const b = structuredClone(good);
  b.questions[1] = { id: "q2", tag: "blocking", text: "  baseline HARNESS:  sample idle-loop cpu per worker or per wave? " };
  const { errors } = validateAskBlock(b);
  assert.ok(errors.some((e) => e.includes("duplicate of an earlier question")), errors.join("; "));
});

test("rejects empty questions array and non-object block", () => {
  assert.ok(validateAskBlock({ ...good, questions: [] }).errors.length > 0);
  assert.ok(validateAskBlock(null).errors.length > 0);
  assert.ok(validateAskBlock({ ...good, v: 2 }).errors.some((e) => e.includes("v:")));
});

test("formatRoom renders tag counts and all questions", () => {
  const out = formatRoom(good);
  assert.ok(out.startsWith("ASK [wave500-coord-cost-w13] wave-500 — 2 blocking · 2 advisory"));
  for (const q of good.questions) assert.ok(out.includes(`[${q.tag}] ${q.id}: ${q.text}`));
});

test("formatReceipt: blocking first, <=3 items, <=140 chars each, JSON array", () => {
  const items = JSON.parse(formatReceipt(good));
  assert.ok(Array.isArray(items));
  assert.ok(items.length <= 3);
  assert.ok(items.every((s) => s.length <= 140));
  assert.ok(items[0].startsWith("[blocking]"));
  assert.ok(items.every((s) => s.startsWith("[blocking] ") || s.startsWith("[advisory] ")));
});

test("formatReceipt truncates long text to fit 140 chars", () => {
  const b = structuredClone(good);
  b.questions[0].text = "y".repeat(140); // 140 + "[blocking] " prefix = 151 > 140
  const items = JSON.parse(formatReceipt(b));
  assert.ok(items[0].length <= 140);
  assert.ok(items[0].startsWith("[blocking] "));
});

test("override caps are honored", () => {
  const b = structuredClone(good);
  const { errors } = validateAskBlock(b, { maxQuestions: 3 });
  assert.ok(errors.some((e) => e.includes("exceeds max 3")));
});
