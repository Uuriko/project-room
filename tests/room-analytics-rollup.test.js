// K030: per-room analytics rollup. Pure rollup tests.
import test from "node:test";
import assert from "node:assert/strict";
import { rollup, RollupError, EVENT_TYPES } from "../server/room-rollup.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof RollupError && error.code === code);

test("rolls up events by room and day", () => {
  const stats = rollup({ events: [
    { type: "message", roomId: "r1", timestamp: "2026-09-16T10:00:00Z", userId: "ada" },
    { type: "message", roomId: "r1", timestamp: "2026-09-16T11:00:00Z", userId: "bob" },
    { type: "reaction", roomId: "r1", timestamp: "2026-09-16T12:00:00Z", userId: "ada" },
    { type: "message", roomId: "r1", timestamp: "2026-09-17T10:00:00Z", userId: "ada" },
    { type: "join", roomId: "r2", timestamp: "2026-09-16T10:00:00Z", userId: "ada" },
  ]});
  assert.equal(stats.length, 3);
  const r1d1 = stats.find(s => s.roomId === "r1" && s.day === "2026-09-16");
  assert.equal(r1d1.messages, 2);
  assert.equal(r1d1.reactions, 1);
  assert.equal(r1d1.activeUsers, 2);
  assert.ok(Object.isFrozen(stats));
  assert.ok(EVENT_TYPES.includes("poll"));
});
test("malformed inputs are refused", () => {
  throwsCode(() => rollup({ events: "nope" }), "invalid_rollup");
  throwsCode(() => rollup({ events: [{ type: "nope", roomId: "r", timestamp: "2026-09-16T10:00:00Z" }] }),
    "invalid_rollup");
});
