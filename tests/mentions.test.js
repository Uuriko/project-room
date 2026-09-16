// A021: mentions and push notifications. Pure parser/router tests.
import test from "node:test";
import assert from "node:assert/strict";
import { extractMentions, createNotificationRouter, MentionError } from "../server/mentions.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof MentionError && error.code === code);

test("extractMentions finds unique mentions in order", () => {
  assert.deepEqual(extractMentions("Hey @ada and @bob, @ada look here."), ["ada", "bob"]);
  assert.deepEqual(extractMentions("no mentions here"), []);
  assert.deepEqual(extractMentions("email me at a@b.com"), []); // not a mention
  assert.ok(Object.isFrozen(extractMentions("@x")));
});
test("router creates notifications, skips self-mentions", () => {
  const router = createNotificationRouter();
  const created = router.route({ messageId: "m1", roomId: "r1", senderId: "ada",
    text: "cc @bob and @ada" });
  assert.equal(created.length, 1); // @ada is the sender
  assert.equal(created[0].agentId, "bob");
  assert.equal(created[0].state, "queued");
  assert.ok(Object.isFrozen(created));
  const queued = router.queuedFor("bob");
  assert.equal(queued.length, 1);
  const sent = router.markSent(created[0].notificationId);
  assert.equal(sent.state, "sent");
  assert.equal(router.queuedFor("bob").length, 0);
});
test("malformed inputs are refused", () => {
  throwsCode(() => extractMentions(null), "invalid_mention");
  const router = createNotificationRouter();
  throwsCode(() => router.route({ messageId: "", roomId: "r", senderId: "s", text: "x" }),
    "invalid_mention");
  throwsCode(() => router.markSent("ghost"), "invalid_mention");
});
