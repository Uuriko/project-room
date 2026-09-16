// B022: Discord bridge. Pure mapper tests.
import test from "node:test";
import assert from "node:assert/strict";
import { toDiscord, fromDiscord, DiscordError } from "../server/discord-bridge.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof DiscordError && error.code === code);

test("toDiscord builds a payload", () => {
  const payload = toDiscord({ message: { messageId: "m1", authorId: "ada",
    text: "Hello", channelId: "111", replyTo: "999" } });
  assert.ok(payload.content.includes("**ada**"));
  assert.equal(payload.channel_id, "111");
  assert.equal(payload.message_reference.message_id, "999");
  assert.ok(Object.isFrozen(payload) && Object.isFrozen(payload.embeds));
});
test("toDiscord enforces the 2000-char limit", () => {
  throwsCode(() => toDiscord({ message: { messageId: "m", authorId: "a",
    text: "x".repeat(2001) } }), "invalid_discord");
});
test("fromDiscord normalizes a gateway event", () => {
  const message = fromDiscord({ event: { t: "MESSAGE_CREATE",
    d: { id: "5", content: "Hi", author: { id: "U9" }, channel_id: "111",
      message_reference: { message_id: "4" } } } });
  assert.equal(message.authorId, "U9");
  assert.equal(message.text, "Hi");
  assert.equal(message.channel, "discord");
  assert.equal(message.replyTo, "4");
  assert.ok(Object.isFrozen(message));
});
test("malformed inputs are refused", () => {
  throwsCode(() => fromDiscord({ event: { t: "READY" } }), "invalid_discord");
});
