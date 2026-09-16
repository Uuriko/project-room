// B021: Slack bridge. Pure mapper tests.
import test from "node:test";
import assert from "node:assert/strict";
import { toSlack, fromSlack, SlackError } from "../server/slack-bridge.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof SlackError && error.code === code);

test("toSlack builds a payload", () => {
  const payload = toSlack({ message: { messageId: "m1", authorId: "ada",
    text: "Hello", channelId: "C123", threadId: "123.456" } });
  assert.ok(payload.text.includes("[ada]"));
  assert.equal(payload.channel, "C123");
  assert.equal(payload.thread_ts, "123.456");
  assert.equal(payload.blocks[0].type, "section");
  assert.ok(Object.isFrozen(payload) && Object.isFrozen(payload.blocks));
});
test("fromSlack normalizes an event", () => {
  const message = fromSlack({ event: { type: "message", user: "U1",
    text: "Hi", ts: "123.456", channel: "C123", thread_ts: "100.0" } });
  assert.equal(message.authorId, "U1");
  assert.equal(message.text, "Hi");
  assert.equal(message.channel, "slack");
  assert.equal(message.threadId, "100.0");
  assert.ok(Object.isFrozen(message));
});
test("malformed inputs are refused", () => {
  throwsCode(() => toSlack({ message: { messageId: "m" } }), "invalid_slack");
  throwsCode(() => fromSlack({ event: { type: "reaction_added" } }), "invalid_slack");
});
