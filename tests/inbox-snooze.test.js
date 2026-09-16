// A013: inbox snooze. Pure record tests; fixed `now` makes them deterministic.
import test from "node:test";
import assert from "node:assert/strict";
import { snoozeMessage, snoozeFor, isSnoozed, dueSnoozes, unsnooze, parseSnoozeDelay, SnoozeError } from "../server/inbox-snooze.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof SnoozeError && error.code === code);
const NOW = "2026-09-16T12:00:00Z";

test("snoozeMessage parks a message in the future", () => {
  const record = snoozeMessage({ messageId: "m-1", snoozedUntil: "2026-09-16T14:00:00Z", snoozedBy: "john" }, { now: NOW });
  assert.equal(record.status, "snoozed");
  assert.equal(record.folder, "inbox");
  assert.equal(record.snoozedBy, "john");
  assert.ok(Object.isFrozen(record));
  assert.ok(isSnoozed(record, { now: NOW }));
  assert.ok(!isSnoozed(record, { now: "2026-09-16T15:00:00Z" }));
});
test("snoozedUntil must be in the future", () => {
  throwsCode(() => snoozeMessage({ messageId: "m-1", snoozedUntil: NOW }, { now: NOW }), "invalid_snooze");
  throwsCode(() => snoozeMessage({ messageId: "m-1", snoozedUntil: "2026-09-16T11:00:00Z" }, { now: NOW }), "invalid_snooze");
  throwsCode(() => snoozeMessage({ messageId: "" , snoozedUntil: "2026-09-16T14:00:00Z" }, { now: NOW }), "invalid_snooze");
});
test("snoozeFor takes a delay like 2h", () => {
  const record = snoozeFor({ messageId: "m-2", delay: "2h" }, { now: NOW });
  assert.equal(record.snoozedUntil, "2026-09-16T14:00:00.000Z");
  throwsCode(() => snoozeFor({ messageId: "m-2", delay: "2x" }, { now: NOW }), "invalid_snooze");
  throwsCode(() => snoozeFor({ messageId: "m-2", delay: "0m" }, { now: NOW }), "invalid_snooze");
  assert.equal(parseSnoozeDelay("30m"), 1800000);
  assert.equal(parseSnoozeDelay("1w"), 604800000);
});
test("dueSnoozes returns only the records whose time has come", () => {
  const records = [
    snoozeMessage({ messageId: "m-1", snoozedUntil: "2026-09-16T14:00:00Z" }, { now: NOW }),
    snoozeMessage({ messageId: "m-2", snoozedUntil: "2026-09-16T18:00:00Z" }, { now: NOW }),
    unsnooze(snoozeMessage({ messageId: "m-3", snoozedUntil: "2026-09-16T18:00:00Z" }, { now: NOW }), { now: NOW }),
  ];
  assert.deepEqual(dueSnoozes(records, { now: "2026-09-16T15:00:00Z" }).map(r => r.messageId), ["m-1"]);
  assert.deepEqual(dueSnoozes(records, { now: NOW }), []);
});
test("unsnooze brings a message back early", () => {
  const record = snoozeMessage({ messageId: "m-4", snoozedUntil: "2026-09-16T18:00:00Z" }, { now: NOW });
  const returned = unsnooze(record, { now: "2026-09-16T13:00:00Z" });
  assert.equal(returned.status, "returned");
  assert.equal(returned.returnedAt, "2026-09-16T13:00:00Z");
  assert.ok(!isSnoozed(returned, { now: NOW }));
  throwsCode(() => unsnooze(returned, { now: NOW }), "invalid_snooze");
  throwsCode(() => isSnoozed({ status: "lost" }, { now: NOW }), "invalid_snooze");
});
