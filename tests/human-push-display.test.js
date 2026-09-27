import test from "node:test";
import assert from "node:assert/strict";
import { notificationFromPush } from "../src/human-push-display.js";

// Lock-screen copy. A payload that smuggles a message body, a display name,
// or a quiet-hours flag must not change the words the browser shows.

test("a push shows a count, never the message", () => {
  const secret = "the seahorse password is coral-99";
  const mention = notificationFromPush({
    v: 1, roomId: "commons", unread: 1, counts: { mention: 1 }, sequence: 4,
    body: secret, quietHours: "22:00-07:00", level: "all"
  });
  assert.equal(mention.title, "Mention");
  assert.equal(mention.body, "1 waiting in the room");
  assert.equal(JSON.stringify(mention).includes(secret), false);
  assert.equal(JSON.stringify(mention).includes("quiet"), false);
  assert.equal(mention.data.roomId, "commons");

  const dm = notificationFromPush({ v: 1, roomId: "commons", unread: 1, counts: { dm: 1 } });
  assert.equal(dm.title, "Direct message");
  assert.equal(dm.body, "1 waiting in the room");

  const both = notificationFromPush({ v: 1, roomId: "commons", unread: 2, counts: { mention: 1, dm: 1 } });
  assert.equal(both.title, "Mentions and DMs");
  assert.equal(both.body, "2 waiting in the room");

  const empty = notificationFromPush({ body: secret });
  assert.equal(empty.title, "Mentions and DMs");
  assert.equal(empty.body, "Something is waiting in the room");
  assert.equal(JSON.stringify(empty).includes(secret), false);
  assert.equal(empty.data.roomId, null);
});
