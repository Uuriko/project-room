import test from "node:test";
import assert from "node:assert/strict";
import { composeDiscordMessage, discordThreadTarget, DiscordError } from "../server/discord-outbound.mjs";
import { composeSlackMessage, slackThreadTarget, SlackError } from "../server/slack-outbound.mjs";

const roomMessage = () => ({ messageId: "room-msg-1", authorId: "avery", text: "Ship the login slice today" });

test("composeDiscordMessage builds a frozen Discord payload with embeds", () => {
  const payload = composeDiscordMessage({ message: roomMessage() });
  assert.equal(payload.content, "**avery**: Ship the login slice today");
  assert.equal(payload.embeds.length, 1);
  assert.deepEqual(payload.embeds[0], { description: "Ship the login slice today", footer: { text: "room-msg-1" } });
  assert.ok(Object.isFrozen(payload) && Object.isFrozen(payload.embeds) && Object.isFrozen(payload.embeds[0]));
  assert.equal("channel_id" in payload, false, "no target channel without thread/channel context");
});

test("composeDiscordMessage honors thread targets, reply references and attachment embeds", () => {
  const threaded = composeDiscordMessage({ message: roomMessage(), threadId: "800000000000000001" });
  assert.equal(threaded.channel_id, "800000000000000001", "thread posts target the thread channel");
  const channeled = composeDiscordMessage({ message: roomMessage(), channelId: "800000000000000002" });
  assert.equal(channeled.channel_id, "800000000000000002");
  const reply = composeDiscordMessage({ message: { ...roomMessage(), replyTo: "900000000000000001" } });
  assert.deepEqual(reply.message_reference, { message_id: "900000000000000001" });
  const attached = composeDiscordMessage({ message: { ...roomMessage(),
    attachments: [{ name: "brief.txt", url: "https://files.example/brief.txt", contentType: "text/plain" }] } });
  assert.equal(attached.embeds.length, 2);
  assert.deepEqual(attached.embeds[1], { title: "brief.txt", url: "https://files.example/brief.txt", description: "text/plain" });
  assert.deepEqual(discordThreadTarget({ threadId: "800000000000000001" }), { channel_id: "800000000000000001" });
  assert.throws(() => discordThreadTarget({ threadId: "nope" }), DiscordError);
  for (const change of [m => { m.text = ""; }, m => { m.authorId = null; }, m => { m.text = "x".repeat(2001); }]) {
    const message = roomMessage(); change(message);
    assert.throws(() => composeDiscordMessage({ message }), DiscordError);
  }
  assert.throws(() => composeDiscordMessage({ message: roomMessage(), threadId: "nope" }), DiscordError);
});

test("composeSlackMessage builds a frozen Slack payload with blocks", () => {
  const payload = composeSlackMessage({ message: roomMessage() });
  assert.equal(payload.text, "[avery] Ship the login slice today");
  assert.equal(payload.blocks.length, 1);
  assert.deepEqual(payload.blocks[0], { type: "section", text: { type: "mrkdwn", text: "Ship the login slice today" } });
  assert.ok(Object.isFrozen(payload) && Object.isFrozen(payload.blocks) && Object.isFrozen(payload.blocks[0]));
  assert.equal("thread_ts" in payload, false, "no thread_ts without thread context");
});

test("composeSlackMessage honors thread_ts, channel targets and attachment blocks", () => {
  const threaded = composeSlackMessage({ message: roomMessage(), threadTs: "1780000000.000099" });
  assert.equal(threaded.thread_ts, "1780000000.000099");
  const channeled = composeSlackMessage({ message: roomMessage(), channelId: "C22222222" });
  assert.equal(channeled.channel, "C22222222");
  const fromMessage = composeSlackMessage({ message: { ...roomMessage(), threadId: "1780000000.000099", channelId: "C22222222" } });
  assert.equal(fromMessage.thread_ts, "1780000000.000099");
  assert.equal(fromMessage.channel, "C22222222");
  const attached = composeSlackMessage({ message: { ...roomMessage(), attachments: [{ name: "brief.txt" }] } });
  assert.equal(attached.blocks.length, 2);
  assert.deepEqual(attached.blocks[1], { type: "section", text: { type: "mrkdwn", text: "*brief.txt*" } });
  assert.deepEqual(slackThreadTarget({ threadTs: "1780000000.000099" }), { thread_ts: "1780000000.000099" });
  assert.throws(() => slackThreadTarget({ threadTs: "nope" }), SlackError);
  for (const change of [m => { m.text = ""; }, m => { m.messageId = null; }, m => { m.channelId = "lowercase"; }]) {
    const message = roomMessage(); change(message);
    assert.throws(() => composeSlackMessage({ message }), SlackError);
  }
  assert.throws(() => composeSlackMessage({ message: roomMessage(), threadTs: "nope" }), SlackError);
});
