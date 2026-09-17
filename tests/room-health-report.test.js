// G004: weekly room health report. Pure report tests.
import test from "node:test";
import assert from "node:assert/strict";
import { healthReport, scoreHealth, HealthError } from "../server/health-report.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof HealthError && error.code === code);

test("generates ranked health report", () => {
  const report = healthReport({
    weekEnding: "2026-09-16",
    rooms: [
      { roomId: "r1", roomName: "Active", stats: { messages: 100, reactions: 50, activeUsers: 10, workItems: 5, joins: 2 },
        prevStats: { messages: 50, reactions: 20, activeUsers: 5, workItems: 2, joins: 1 } },
      { roomId: "r2", roomName: "Quiet", stats: { messages: 5, reactions: 0, activeUsers: 1, workItems: 0, joins: 0 } },
    ],
  });
  assert.equal(report.roomCount, 2);
  assert.equal(report.rooms[0].roomId, "r1"); // highest score first
  assert.equal(report.rooms[0].trend, "up");
  assert.equal(report.rooms[1].trend, "new");
  assert.ok(report.avgScore > 0);
  assert.ok(Object.isFrozen(report));
});
test("scoreHealth is bounded 0-100", () => {
  assert.ok(scoreHealth({ messages: 0, reactions: 0, activeUsers: 0, workItems: 0, joins: 0 }) >= 0);
  assert.ok(scoreHealth({ messages: 10000, reactions: 10000, activeUsers: 100, workItems: 100, joins: 100 }) <= 100);
});
test("malformed inputs are refused", () => {
  throwsCode(() => healthReport({ rooms: [], weekEnding: "nope" }), "invalid_health");
  throwsCode(() => healthReport({ rooms: "nope", weekEnding: "2026-09-16" }), "invalid_health");
});
