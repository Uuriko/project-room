// K020: natural-language reminder parsing. Pure parser tests.
import test from "node:test";
import assert from "node:assert/strict";
import { parseReminder, ReminderError } from "../server/reminder-parse.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ReminderError && error.code === code);
// Wednesday 2026-09-16 10:00 UTC
const NOW = new Date("2026-09-16T10:00:00Z");

test("parses 'in N minutes/hours'", () => {
  const r = parseReminder({ text: "remind me in 30 minutes to call mom", now: NOW });
  assert.equal(r.at, "2026-09-16T10:30:00.000Z");
  assert.ok(r.message.includes("call mom"));
  assert.ok(Object.isFrozen(r));
});
test("parses weekday + time", () => {
  const r = parseReminder({ text: "remind me Friday 9am to ship", now: NOW });
  assert.equal(r.at, "2026-09-18T09:00:00.000Z"); // Friday
});
test("parses tomorrow", () => {
  const r = parseReminder({ text: "remind me tomorrow at 2pm", now: NOW });
  assert.equal(r.at, "2026-09-17T14:00:00.000Z");
});
test("returns null when no time found", () => {
  assert.equal(parseReminder({ text: "remind me sometime", now: NOW }), null);
  assert.equal(parseReminder({ text: "hello world", now: NOW }), null);
});
test("malformed inputs are refused", () => {
  throwsCode(() => parseReminder({ text: "", now: NOW }), "invalid_reminder");
  throwsCode(() => parseReminder({ text: "remind me", now: "nope" }), "invalid_reminder");
});
