import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDiscordEvent, readDiscordEnvelope, discordSourceId, discordEvents, qualifyDiscordCursor,
  RecordedDiscordGateway, bind, discordLimits } from "../server/channel-adapters/discord.mjs";
import { ContractError } from "../server/channel-connection.mjs";
import { readChannelEnvelope, adapterFor } from "../server/channel-adapters/index.mjs";

const connection = { accountId: "account-fixture", id: "discord-fixture", revision: 1,
  channel: "discord", provider: "discord-bot", externalId: "app-123456",
  identity: { kind: "bot", id: "111111111111111111", handle: "@roombot", displayName: "Room Bot" },
  capabilities: { read: true, send: true, threads: true, edit: true } };
const create = () => ({ op: 0, t: "MESSAGE_CREATE", s: 1001, d: {
  id: "900000000000000001", channel_id: "800000000000000001", guild_id: "700000000000000001",
  author: { id: "500000000000000001", username: "avery_q", global_name: "Avery Quinn", bot: false },
  content: "Shall we work on this together?", timestamp: "2026-09-18T10:00:00.123456+00:00",
  edited_timestamp: null, message_reference: undefined, mentions: [],
  attachments: [{ id: "600000000000000001", filename: "brief.txt", content_type: "text/plain", size: 128 }] } });
const update = () => { const e = create(); e.t = "MESSAGE_UPDATE"; e.s = 1002;
  e.d.content = "Shall we work on this together? (edited)"; e.d.edited_timestamp = "2026-09-18T10:05:00.000000+00:00"; return e; };

test("MESSAGE_CREATE normalizes into a bounded envelope; MESSAGE_UPDATE is a new version of the same source", () => {
  const first = normalizeDiscordEvent(connection, create());
  assert.equal(first.channel, "discord"); assert.equal(first.contractVersion, 1);
  assert.equal(first.sourceId, discordSourceId(connection, "800000000000000001:900000000000000001"));
  assert.match(first.sourceId, /^discord-[a-f0-9]{64}$/);
  assert.deepEqual(first.message, { id: "800000000000000001:900000000000000001", revision: "1001",
    threadId: "800000000000000001", kind: "message", sentAt: "2026-09-18T10:00:00.123Z", editedAt: null,
    from: { kind: "user", id: "500000000000000001", handle: "@avery_q", displayName: "Avery Quinn" },
    to: [{ kind: "channel", id: "800000000000000001", handle: "", displayName: "" }], subject: null, replyTo: null });
  assert.deepEqual(first.body, { format: "text", content: "Shall we work on this together?" });
  assert.deepEqual(first.attachments, [{ id: "600000000000000001", kind: "document", name: "brief.txt", contentType: "text/plain", size: 128 }]);
  const edited = normalizeDiscordEvent(connection, update());
  assert.equal(edited.sourceId, first.sourceId, "an edit is a new version of the same source");
  assert.notEqual(edited.sourceVersion, first.sourceVersion);
  assert.equal(edited.message.kind, "edited_message");
  assert.equal(edited.message.editedAt, "2026-09-18T10:05:00.000Z");
  assert.equal(edited.message.revision, "1002");
  for (const envelope of [first, edited]) {
    assert.deepEqual(readDiscordEnvelope(envelope), envelope);
    assert.deepEqual(readChannelEnvelope(structuredClone(envelope)), envelope);
  }
  assert.equal(adapterFor("discord-bot").channel, "discord");
});

test("replies, mentions, DMs, bots and image attachments normalize", () => {
  const reply = create(); reply.d.message_reference = { message_id: "900000000000000000", channel_id: "800000000000000001" };
  reply.d.mentions = [{ id: "500000000000000002", username: "bob", bot: false }];
  const normalized = normalizeDiscordEvent(connection, reply);
  assert.equal(normalized.message.replyTo, "800000000000000001:900000000000000000");
  assert.deepEqual(normalized.message.to, [{ kind: "user", id: "500000000000000002", handle: "@bob", displayName: "bob" }]);
  const dm = create(); delete dm.d.guild_id;
  assert.equal(normalizeDiscordEvent(connection, dm).message.to[0].kind, "user", "DMs normalize to the peer user");
  const botAuthor = create(); botAuthor.d.author = { id: "111111111111111111", username: "roombot", bot: true };
  assert.equal(normalizeDiscordEvent(connection, botAuthor).message.from.kind, "bot");
  const photo = create(); photo.d.attachments = [{ id: "600000000000000002", filename: "pic.png", content_type: "image/png", size: 90000 }];
  assert.deepEqual(normalizeDiscordEvent(connection, photo).attachments,
    [{ id: "600000000000000002", kind: "photo", name: "pic.png", contentType: "image/png", size: 90000 }]);
});

test("malformed dispatches and envelopes throw contract errors", () => {
  const reaction = { op: 0, t: "MESSAGE_REACTION_ADD", s: 1003, d: {} };
  assert.throws(() => normalizeDiscordEvent(connection, reaction), { code: "unsupported_discord_event" });
  for (const change of [e => { e.d.timestamp = "not-a-time"; }, e => { e.d.author = null; }, e => { e.s = -1; },
    e => { e.d.channel_id = "nope"; }, e => { e.d.content = "x".repeat(20000); }]) {
    const event = create(); change(event);
    assert.throws(() => normalizeDiscordEvent(connection, event), ContractError);
  }
  const other = { ...connection, provider: "slack-app", channel: "slack" };
  assert.throws(() => normalizeDiscordEvent(other, create()), { code: "unsupported_channel" });
  const envelope = normalizeDiscordEvent(connection, create());
  for (const change of [e => { e.sourceVersion = "0".repeat(64); }, e => { e.channel = "slack"; },
    e => { e.message.subject = "nope"; }, e => { e.body.format = "html"; }, e => { e.extra = 1; },
    e => { e.attachments.push(e.attachments[0]); }, e => { e.message.to.push(e.message.to[0]); }]) {
    const value = structuredClone(envelope); change(value);
    assert.throws(() => readDiscordEnvelope(value), ContractError);
  }
  const scoped = { ...connection, accountId: "someone-else" };
  assert.notEqual(normalizeDiscordEvent(scoped, create()).sourceId, envelope.sourceId, "source identity is account scoped");
});

test("a recorded gateway pages by sequence; deletes are retract changes; the bound adapter hydrates", async () => {
  const events = [create(), update()];
  const deleted = { op: 0, t: "MESSAGE_DELETE", s: 1003, d: { id: "900000000000000001", channel_id: "800000000000000001" } };
  const typing = { op: 0, t: "TYPING_START", s: 1004, d: {} };
  events.push(deleted, typing);
  const reader = new RecordedDiscordGateway({ connection, events, limit: 2 });
  assert.equal(reader.kind, "discord-bot");
  const adapter = bind({ reader, connection });
  assert.deepEqual([adapter.channel, adapter.provider, adapter.scope()], ["discord", "discord-bot", "updates"]);
  const first = await adapter.changes({ cursor: null });
  assert.equal(first.contractVersion, 1);
  assert.deepEqual(first.changes.map(c => [c.messageId, c.action]),
    [["800000000000000001:900000000000000001", "hydrate"], ["800000000000000001:900000000000000001", "hydrate"]],
    "typing dispatches are skipped, never imported");
  assert.equal(first.cursor, "1003"); assert.equal(first.complete, false);
  const second = await adapter.changes({ cursor: first.cursor });
  assert.deepEqual(second.changes.map(c => c.action), ["retract"]);
  assert.equal(second.cursor, "1005"); assert.equal(second.complete, false, "a full page may hide more events");
  const third = await adapter.changes({ cursor: second.cursor });
  assert.deepEqual(third.changes, []); assert.equal(third.cursor, "1005"); assert.equal(third.complete, true);
  const hydrated = await adapter.hydrate("800000000000000001:900000000000000001");
  assert.equal(hydrated.s, 1002, "hydrate returns the latest dispatch for the message");
  assert.deepEqual(adapter.normalize(hydrated).message.kind, "edited_message");
  assert.equal(await adapter.hydrate("800000000000000001:1"), null);
  assert.equal(adapter.sourceId("800000000000000001:900000000000000001"), discordSourceId(connection, "800000000000000001:900000000000000001"));
  assert.throws(() => bind({ reader: {}, connection }), { code: "discord_fixture_reader_required" });
});

test("discordEvents validates cursors and batch bounds", () => {
  assert.throws(() => discordEvents(connection, { events: [create()] }, { offset: "abc" }), { code: "invalid_discord_cursor" });
  assert.throws(() => discordEvents(connection, { events: [create()] }, { offset: "-1" }), { code: "invalid_discord_cursor" });
  assert.equal(qualifyDiscordCursor("1001"), "1001");
  assert.throws(() => qualifyDiscordCursor("1.5"), { code: "invalid_discord_cursor" });
  const empty = discordEvents(connection, { events: [] }, { offset: "1005" });
  assert.deepEqual(empty.changes, []); assert.equal(empty.cursor, "1005"); assert.equal(empty.complete, true);
});

test("the recorded gateway submit/lookup mirrors the telegram transport", async () => {
  const reader = new RecordedDiscordGateway({ connection, events: [create()] });
  const envelope = { provider: "discord-bot", adapter: "discord", operationId: "op-1", previewVersion: "v1" };
  const receipt = await reader.submit({ operationId: "op-1", envelope });
  assert.equal(receipt.outcome, "accepted"); assert.equal(receipt.providerId, "op-1");
  assert.deepEqual(await reader.lookup({ operationId: "op-1" }), receipt);
  assert.equal(await reader.lookup({ operationId: "nope" }), null);
  await assert.rejects(reader.submit({ operationId: "op-2", envelope: { provider: "slack-app", adapter: "slack" } }),
    { code: "discord_transport_mismatch" });
  await assert.rejects(reader.submit({ operationId: "op-1", envelope: { ...envelope, previewVersion: "v2" } }), /correlation conflict/);
  assert.deepEqual(reader.sent(), [envelope]);
  const rejected = new RecordedDiscordGateway({ connection, events: [] });
  rejected.mode = "rejected";
  assert.equal((await rejected.submit({ operationId: "op-9", envelope })).outcome, "rejected");
  assert.ok(discordLimits.updates > 0);
});
