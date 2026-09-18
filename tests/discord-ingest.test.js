import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyDiscordSignature, discordEventKind, mentionUserIds, threadContext,
  ingestDiscordEvent, ingestDiscordEvents } from "../server/discord-ingest.mjs";
import { ContractError } from "../server/channel-connection.mjs";

const connection = { accountId: "account-fixture", id: "discord-fixture", revision: 1,
  channel: "discord", provider: "discord-bot", externalId: "app-123456",
  identity: { kind: "bot", id: "111111111111111111", handle: "@roombot", displayName: "Room Bot" },
  capabilities: { read: true, send: true, threads: true, edit: true } };
const create = (s = 1001) => ({ op: 0, t: "MESSAGE_CREATE", s, d: {
  id: "900000000000000001", channel_id: "800000000000000001", guild_id: "700000000000000001",
  author: { id: "500000000000000001", username: "avery_q", global_name: "Avery Quinn", bot: false },
  content: "Hey <@!500000000000000002>, review this", timestamp: "2026-09-18T10:00:00.000000+00:00",
  edited_timestamp: null, mentions: [{ id: "500000000000000002", username: "bob", bot: false }], attachments: [] } });

test("Ed25519 signature verification is pure: key in, boolean out", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const timestamp = "1726656000", body = JSON.stringify({ type: 0 });
  const signature = sign(null, Buffer.from(timestamp + body, "utf8"), privateKey).toString("hex");
  assert.equal(verifyDiscordSignature({ publicKey: raw, signature, timestamp, body }), true);
  assert.equal(verifyDiscordSignature({ publicKey: raw, signature, timestamp, body: body + "!" }), false, "tampered body fails");
  assert.equal(verifyDiscordSignature({ publicKey: raw, signature, timestamp: "1726656001", body }), false, "tampered timestamp fails");
  assert.equal(verifyDiscordSignature({ publicKey: raw, signature: "00".repeat(64), timestamp, body }), false, "garbage signature fails");
  for (const change of [p => { p.publicKey = "zz"; }, p => { p.signature = "v0=abc"; }, p => { p.timestamp = 42; }, p => { p.body = null; }]) {
    const params = { publicKey: raw, signature, timestamp, body }; change(params);
    assert.throws(() => verifyDiscordSignature(params), ContractError);
  }
});

test("event kinds classify dispatches; unknown dispatches are null", () => {
  assert.equal(discordEventKind(create()), "message_create");
  assert.equal(discordEventKind({ ...create(), t: "MESSAGE_UPDATE" }), "message_update");
  assert.equal(discordEventKind({ ...create(), t: "MESSAGE_DELETE" }), "message_delete");
  assert.equal(discordEventKind({ ...create(), t: "MESSAGE_REACTION_ADD" }), "reaction_add");
  assert.equal(discordEventKind({ ...create(), t: "MESSAGE_REACTION_REMOVE" }), "reaction_remove");
  assert.equal(discordEventKind({ op: 0, t: "TYPING_START", s: 1, d: {} }), null);
  assert.equal(discordEventKind({ op: 10, t: "MESSAGE_CREATE", s: 1, d: {} }), null);
  assert.equal(discordEventKind(null), null);
});

test("mentions merge the mentions array with <@id> content tokens", () => {
  assert.deepEqual(mentionUserIds(create()), ["500000000000000002"]);
  const bare = create(); bare.d.mentions = [];
  assert.deepEqual(mentionUserIds(bare), ["500000000000000002"], "content tokens survive a missing mentions array");
  const none = create(); none.d.mentions = []; none.d.content = "no mentions here";
  assert.deepEqual(mentionUserIds(none), []);
  assert.deepEqual(mentionUserIds(null), []);
});

test("thread context resolves reply references and recorded thread parents", () => {
  const reply = create(); reply.d.message_reference = { message_id: "900000000000000000", channel_id: "800000000000000001" };
  assert.deepEqual(threadContext(reply), { replyToMessageId: "800000000000000001:900000000000000000" });
  assert.deepEqual(threadContext(reply, { threads: { "800000000000000001": "700000000000000010" } }),
    { replyToMessageId: "800000000000000001:900000000000000000", parentChannelId: "700000000000000010" });
  assert.equal(threadContext(create()), null);
  assert.equal(threadContext(null), null);
});

test("single-event ingest: hydrates, retracts, reactions, skips", () => {
  const hydrated = ingestDiscordEvent(connection, create());
  assert.equal(hydrated.action, "hydrate"); assert.equal(hydrated.kind, "message_create");
  assert.equal(hydrated.messageId, "800000000000000001:900000000000000001");
  assert.equal(hydrated.envelope.channel, "discord");
  assert.deepEqual(hydrated.mentions, ["500000000000000002"]);
  const deleted = { op: 0, t: "MESSAGE_DELETE", s: 1002, d: { id: "900000000000000001", channel_id: "800000000000000001" } };
  assert.deepEqual(ingestDiscordEvent(connection, deleted),
    { action: "retract", kind: "message_delete", messageId: "800000000000000001:900000000000000001" });
  const reaction = { op: 0, t: "MESSAGE_REACTION_ADD", s: 1003, d: { user_id: "500000000000000002",
    channel_id: "800000000000000001", message_id: "900000000000000001", emoji: { id: null, name: "👍" } } };
  const reacted = ingestDiscordEvent(connection, reaction);
  assert.deepEqual(reacted, { action: "reaction", kind: "reaction_add", messageId: "800000000000000001:900000000000000001",
    emoji: "👍", userId: "500000000000000002", added: true });
  const custom = { op: 0, t: "MESSAGE_REACTION_REMOVE", s: 1004, d: { user_id: "500000000000000002",
    channel_id: "800000000000000001", message_id: "900000000000000001", emoji: { id: "123", name: "party" } } };
  const unreacted = ingestDiscordEvent(connection, custom);
  assert.equal(unreacted.emoji, "party:123"); assert.equal(unreacted.added, false);
  const skipped = ingestDiscordEvent(connection, { op: 0, t: "TYPING_START", s: 1005, d: {} });
  assert.deepEqual(skipped, { action: "skip", kind: null, reason: "unsupported_event" });
});

test("batch ingest pages by sequence with a moving cursor", () => {
  const reaction = { op: 0, t: "MESSAGE_REACTION_ADD", s: 1002, d: { user_id: "500000000000000002",
    channel_id: "800000000000000001", message_id: "900000000000000001", emoji: { id: null, name: "👍" } } };
  const deleted = { op: 0, t: "MESSAGE_DELETE", s: 1003, d: { id: "900000000000000001", channel_id: "800000000000000001" } };
  const typing = { op: 0, t: "TYPING_START", s: 1004, d: {} };
  const events = [create(1001), reaction, deleted, typing];
  const first = ingestDiscordEvents(connection, events, { limit: 2 });
  assert.equal(first.contractVersion, 1);
  assert.deepEqual(first.changes.map(c => [c.sequence, c.action]), [[1001, "hydrate"], [1002, "reaction"]]);
  assert.equal(first.cursor, "1003"); assert.equal(first.complete, false);
  const second = ingestDiscordEvents(connection, events, { cursor: first.cursor, limit: 2 });
  assert.deepEqual(second.changes.map(c => [c.sequence, c.action]), [[1003, "retract"]], "skips advance the cursor silently");
  assert.equal(second.cursor, "1005"); assert.equal(second.complete, true);
  const empty = ingestDiscordEvents(connection, events, { cursor: second.cursor });
  assert.deepEqual(empty.changes, []); assert.equal(empty.cursor, second.cursor); assert.equal(empty.complete, true);
  assert.throws(() => ingestDiscordEvents(connection, events, { cursor: "nope" }), { code: "invalid_discord_cursor" });
});
