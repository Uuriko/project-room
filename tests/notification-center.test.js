// #1601 (IS-UX-1): in-app notification center. A mountable component for the
// human client: renders the notification feed (server/notifications.mjs shape)
// grouped by kind with an unread count, an empty state, and ack buttons.
// Pure render helpers are DOM-free; mount() takes a container and is tested
// with a fake root. NOTE: the wiring into the room UI (index.html / src/app.js)
// is owned by jill-lane7 — this module only documents the mount point.
import test from "node:test";
import assert from "node:assert/strict";
import {
  kindLabel,
  unreadCount,
  groupForCenter,
  renderCenterHtml,
  mountNotificationCenter
} from "../src/notification-center.js";

const notifications = [
  { kind: "mention", messageId: "m1", actorId: "alice", sequence: 11, at: 1, changes: 1 },
  { kind: "work_update", workItemId: "w1", actorId: "erin", sequence: 15, at: 5, changes: 3 },
  { kind: "assignment", workItemId: "w2", actorId: "dave", sequence: 16, at: 6, changes: 1 }
];

test("kind labels are human words", () => {
  assert.equal(kindLabel("mention"), "Mentions");
  assert.equal(kindLabel("reply"), "Replies");
  assert.equal(kindLabel("assignment"), "Assignments");
  assert.equal(kindLabel("work_update"), "Work updates");
  assert.equal(kindLabel("access_request"), "Access requests");
  assert.equal(kindLabel("access_decision"), "Access decisions");
  assert.equal(kindLabel("mystery"), "Updates");
});

test("unread count prefers the feed unread field", () => {
  assert.equal(unreadCount({ unread: 7, notifications }), 7);
  assert.equal(unreadCount({ notifications }), 3);
  assert.equal(unreadCount({}), 0);
});

test("grouping preserves canonical kind order", () => {
  const groups = groupForCenter(notifications);
  assert.deepEqual(groups.map(g => g.kind), ["mention", "assignment", "work_update"]);
  assert.equal(groups[0].items.length, 1);
});

test("rendered html names actors, escapes them, and offers an empty state", () => {
  const html = renderCenterHtml({ notifications, roomName: "commons" });
  assert.ok(html.includes("alice"), "names the actor");
  assert.ok(html.includes("notification-center"), "carries the component class");
  assert.ok(html.includes('data-kind="mention"'), "groups are marked");
  const evil = renderCenterHtml({ notifications: [{ kind: "mention", messageId: "m", actorId: "<img src=x>", sequence: 1, at: 1, changes: 1 }] });
  assert.ok(!evil.includes("<img src=x>"), "actor ids are escaped");
  const empty = renderCenterHtml({ notifications: [] });
  assert.ok(empty.includes("caught up") || empty.includes("nothing"), "empty state reassures");
});

test("mount renders into the container and refreshes on demand", async () => {
  let calls = 0;
  const root = { innerHTML: "", listeners: new Map(),
    addEventListener(name, fn) { this.listeners.set(name, fn); } };
  const feed = { unread: 2, notifications };
  const center = mountNotificationCenter(root, { fetchFeed: async () => { calls += 1; return feed; } });
  await center.refresh();
  assert.equal(calls, 1);
  assert.ok(root.innerHTML.includes("alice"), "feed rendered into the container");
  assert.ok(root.innerHTML.includes('data-unread="2"'), "unread count is exposed");
  await center.refresh();
  assert.equal(calls, 2);
});

test("mount ack buttons call onAck with the item identity", async () => {
  const acked = [];
  const root = { innerHTML: "", listeners: new Map(),
    addEventListener(name, fn) { this.listeners.set(name, fn); },
    querySelectorAll() { return []; } };
  const center = mountNotificationCenter(root, {
    fetchFeed: async () => ({ unread: 1, notifications }),
    onAck: item => acked.push(item)
  });
  await center.refresh();
  await center.ack(notifications[0]);
  assert.equal(acked.length, 1);
  assert.equal(acked[0].messageId, "m1");
});
