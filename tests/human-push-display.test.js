import test from "node:test";
import assert from "node:assert/strict";
import { notificationFromPush, pushSuperseded, pushTag } from "../src/human-push-display.js";

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

test("pushTag matches the notification tag", () => {
  assert.equal(pushTag({ roomId: "commons" }), "room:commons");
  assert.equal(pushTag({}), "room");
  assert.equal(pushTag({ roomId: "" }), "room");
  const note = notificationFromPush({ v: 1, roomId: "commons", counts: { mention: 1 } });
  assert.equal(note.tag, pushTag({ roomId: "commons" }));
});

test("an older push never replaces a newer notification for the same room", () => {
  // Push services deliver concurrently: the payload names the newest event
  // its counts were evaluated through (sequence). An older sequence that
  // arrives after a newer one is superseded, or the lock screen shows stale
  // counts over the fresh notification.
  const shown = new Map();
  const push = (sequence, roomId = "commons") => ({ v: 1, roomId, sequence, counts: { mention: 1 } });
  assert.equal(pushSuperseded(push(9), shown), false, "first sequence shows");
  assert.equal(pushSuperseded(push(7), shown), true, "older sequence is superseded");
  assert.equal(pushSuperseded(push(10), shown), false, "newer sequence shows and records");
  assert.equal(pushSuperseded(push(10), shown), false, "equal sequence is not superseded");
  assert.equal(pushSuperseded(push(8), shown), true, "older than the recorded newest is superseded");
  assert.equal(pushSuperseded(push(5, "other"), shown), false, "sequences are tracked per tag");
  assert.equal(
    pushSuperseded({ v: 1, roomId: "commons", counts: { mention: 1 } }, shown),
    false, "a payload with no sequence is never suppressed");
});
