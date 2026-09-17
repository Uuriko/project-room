// G006: per-agent contribution stats. Pure stats tests; no store.
import test from "node:test";
import assert from "node:assert/strict";
import { contributionStats, leaderboard, ContribError } from "../server/growth-contrib.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ContribError && error.code === code);
const events = () => [
  { type: "room.post", actorId: "quill", at: "2026-09-14T10:00:00Z" },
  { type: "room.post", actorId: "quill", at: "2026-09-15T10:00:00Z" },
  { type: "inbox.triage", actorId: "quill", at: "2026-09-15T11:00:00Z" },
  { type: "room.post", actorId: "grok", at: "2026-09-15T12:00:00Z" },
];

test("contributionStats aggregates per agent", () => {
  const stats = contributionStats(events());
  assert.deepEqual(stats.map(s => [s.actorId, s.total]), [["quill", 3], ["grok", 1]]);
  assert.deepEqual(stats[0].byType, { "inbox.triage": 1, "room.post": 2 });
  assert.equal(stats[0].activeDays, 2);
  assert.equal(stats[0].firstSeen, "2026-09-14T10:00:00Z");
  assert.equal(stats[0].lastSeen, "2026-09-15T11:00:00Z");
  assert.ok(Object.isFrozen(stats) && Object.isFrozen(stats[0].byType));
});
test("leaderboard ranks the top agents", () => {
  const board = leaderboard(events(), { top: 1 });
  assert.equal(board.length, 1);
  assert.equal(board[0].actorId, "quill");
  assert.equal(board[0].rank, 1);
  assert.deepEqual(leaderboard([], {}), []);
});
test("malformed inputs are refused", () => {
  throwsCode(() => contributionStats("nope"), "invalid_contrib_input");
  throwsCode(() => contributionStats([{ type: "x" }], {}), "invalid_contrib_input");
  throwsCode(() => leaderboard(events(), { top: 0 }), "invalid_contrib_input");
});
