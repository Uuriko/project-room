// #1601 (IS-UX-1): human digest content builder. Pure, deterministic, no I/O.
// Turns notification-feed items (server/notifications.mjs shape) into the
// section rows renderNotificationEmail expects for the "brief" kind, and the
// line items it expects for the "batch" kind. Feed items carry no titles,
// so headlines are derived from kind + actorId + ids; bodies stay clipped.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDigestSections,
  buildDigestLines,
  itemHeadline,
  sectionHeading,
  DIGEST_KIND_ORDER
} from "../server/human-digest-content.mjs";

const feed = [
  { kind: "mention", messageId: "m1", actorId: "alice", sequence: 11, at: 1, changes: 1 },
  { kind: "mention", messageId: "m2", actorId: "bob", sequence: 12, at: 2, changes: 1 },
  { kind: "reply", messageId: "m3", actorId: "carol", sequence: 13, at: 3, changes: 1 },
  { kind: "assignment", workItemId: "w1", actorId: "dave", sequence: 14, at: 4, changes: 1 },
  { kind: "work_update", workItemId: "w1", actorId: "erin", sequence: 15, at: 5, changes: 3 },
  { kind: "access_request", actorId: "frank", sequence: 16, at: 6, changes: 1 },
  { kind: "access_decision", actorId: "owner", sequence: 17, at: 7, changes: 1 },
  { kind: "mystery_kind", actorId: "mallory", sequence: 18, at: 8, changes: 1 }
];

test("kind order is stable and covers the feed kinds", () => {
  assert.deepEqual([...DIGEST_KIND_ORDER], ["mention", "reply", "assignment", "work_update", "access_request", "access_decision"]);
});

test("sections group by kind in canonical order, unknown kinds dropped", () => {
  const sections = buildDigestSections({ items: feed, roomName: "commons" });
  assert.deepEqual(sections.map(s => s.kind), ["mention", "reply", "assignment", "work_update", "access_request", "access_decision"]);
  const mention = sections.find(s => s.kind === "mention");
  assert.equal(mention.heading, "Mentions (2)");
  assert.ok(mention.text.includes("alice") && mention.text.includes("bob"), "names the actors");
  assert.ok(mention.roomName === "commons" || mention.text.includes("commons"), "names the room");
});

test("work updates collapse to one section line naming the work item", () => {
  const sections = buildDigestSections({ items: feed });
  const update = sections.find(s => s.kind === "work_update");
  assert.equal(update.heading, "Work update (1)");
  assert.ok(update.text.includes("w1"), "names the work item");
  assert.ok(update.text.includes("3"), "carries the change count");
});

test("empty feed builds no sections", () => {
  assert.deepEqual(buildDigestSections({ items: [] }), []);
  assert.deepEqual(buildDigestSections({}), []);
});

test("headlines are human-readable and never leak control characters", () => {
  assert.equal(itemHeadline(feed[0]), "alice mentioned you");
  assert.equal(itemHeadline(feed[2]), "carol replied to you");
  assert.equal(itemHeadline(feed[3]), "dave assigned you work (w1)");
  assert.equal(itemHeadline(feed[4]), "erin updated work w1 (3 changes)");
  assert.equal(itemHeadline(feed[5]), "frank requested access");
  assert.equal(itemHeadline(feed[6]), "owner decided an access request");
  const evil = itemHeadline({ kind: "mention", actorId: "a\nb\rc", messageId: "m" });
  assert.ok(!/[\r\n]/.test(evil), "control characters are stripped");
});

test("batch lines map feed items to renderer line items", () => {
  const lines = buildDigestLines({ items: feed.slice(0, 3) });
  assert.equal(lines.length, 3);
  assert.equal(lines[0].reason, "alice mentioned you");
  assert.ok(typeof lines[0].title === "string" && lines[0].title.length > 0);
  assert.deepEqual(buildDigestLines({ items: [] }), []);
});

test("sectionHeading counts items", () => {
  assert.equal(sectionHeading("mention", 2), "Mentions (2)");
  assert.equal(sectionHeading("reply", 1), "Reply (1)");
});
