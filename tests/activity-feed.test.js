// B025: machine-readable activity feed. Pure feed tests.
import test from "node:test";
import assert from "node:assert/strict";
import { toFeedRecord, buildFeed, FeedError } from "../server/activity-feed.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof FeedError && error.code === code);

const events = [
  { eventId: "e3", eventType: "message.posted", timestamp: "2026-09-16T03:00:00Z", actorId: "ada", data: { text: "hi" } },
  { eventId: "e2", eventType: "room.created", timestamp: "2026-09-16T02:00:00Z", actorId: "bob", data: {} },
  { eventId: "e1", eventType: "message.posted", timestamp: "2026-09-16T01:00:00Z", actorId: "ada", data: { text: "yo" } },
];

test("buildFeed paginates with cursor", () => {
  const page1 = buildFeed({ events, limit: 2 });
  assert.equal(page1.events.length, 2);
  assert.equal(page1.events[0].eventId, "e3");
  assert.equal(page1.nextCursor, "e2");
  assert.equal(page1.hasMore, true);
  assert.ok(Object.isFrozen(page1) && Object.isFrozen(page1.events));
  const page2 = buildFeed({ events, cursor: page1.nextCursor, limit: 2 });
  assert.equal(page2.events.length, 1);
  assert.equal(page2.events[0].eventId, "e1");
  assert.equal(page2.nextCursor, null);
});
test("buildFeed filters by type and actor", () => {
  const byType = buildFeed({ events, eventTypes: ["room.created"] });
  assert.equal(byType.total, 1);
  assert.equal(byType.events[0].eventId, "e2");
  const byActor = buildFeed({ events, actorId: "ada" });
  assert.equal(byActor.total, 2);
});
test("malformed inputs are refused", () => {
  throwsCode(() => buildFeed({ events, cursor: "ghost" }), "invalid_feed");
  throwsCode(() => buildFeed({ events, limit: 0 }), "invalid_feed");
  throwsCode(() => toFeedRecord({ event: { eventId: "x" } }), "invalid_feed");
});
