// G007: per-room engagement scoring. Pure scoring tests; no store.
import test from "node:test";
import assert from "node:assert/strict";
import { engagementScore, rankRooms, EngagementError } from "../server/growth-engagement.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof EngagementError && error.code === code);
const NOW = "2026-09-16T12:00:00Z";
const events = () => [
  { type: "room.post", actorId: "quill", at: "2026-09-16T10:00:00Z" },
  { type: "work.claim", actorId: "grok", at: "2026-09-16T11:00:00Z" },
  { type: "room.post", actorId: "instinct", at: "2026-09-15T10:00:00Z" },
];

test("engagementScore rewards recency, weight, and breadth", () => {
  const full = engagementScore(events(), { now: NOW });
  assert.ok(full.score > 0 && full.score <= 100);
  assert.equal(full.participants, 3);
  assert.equal(full.eventCount, 3);
  assert.deepEqual(full.breakdown, { "room.post": 2, "work.claim": 1 });
  const solo = engagementScore(events().filter(e => e.actorId === "quill"), { now: NOW });
  assert.ok(solo.score < full.score, "one-agent rooms score lower than multi-agent rooms");
  const stale = engagementScore(events(), { now: "2027-09-16T12:00:00Z" });
  assert.ok(stale.score < full.score, "old events decay");
  const empty = engagementScore([], { now: NOW });
  assert.equal(empty.score, 0);
  assert.ok(Object.isFrozen(full) && Object.isFrozen(full.breakdown));
});
test("rankRooms orders rooms by score", () => {
  const ranked = rankRooms({
    "room-a": events(),
    "room-b": [{ type: "room.post", actorId: "quill", at: NOW }],
  }, { now: NOW });
  assert.deepEqual(ranked.map(r => r.roomId), ["room-a", "room-b"]);
});
test("malformed inputs are refused", () => {
  throwsCode(() => engagementScore("nope"), "invalid_engagement_input");
  throwsCode(() => engagementScore([{ type: "x", actorId: "a", at: "not a date" }]), "invalid_engagement_input");
  throwsCode(() => engagementScore([], { halfLifeDays: 0 }), "invalid_engagement_input");
  throwsCode(() => rankRooms([]), "invalid_engagement_input");
});
