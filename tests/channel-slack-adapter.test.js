import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSlackEvent, readSlackEnvelope, slackSourceId, slackEvents, qualifySlackCursor,
  RecordedSlackEvents, bind, slackLimits } from "../server/channel-adapters/slack.mjs";
import { ContractError } from "../server/channel-connection.mjs";
import { readChannelEnvelope, adapterFor } from "../server/channel-adapters/index.mjs";

const connection = { accountId: "account-fixture", id: "slack-fixture", revision: 1,
  channel: "slack", provider: "slack-app", externalId: "A123456",
  identity: { kind: "bot", id: "B123456", handle: "@roombot", displayName: "Room Bot" },
  capabilities: { read: true, send: true, threads: true, edit: true } };
const message = () => ({ event_id: "Ev0000000001", event_time: 1780000000,
  event: { type: "message", user: "U11111111", text: "Shall we work on this together?",
    ts: "1780000000.000100", channel: "C22222222",
    files: [{ id: "F33333333", name: "brief.txt", mimetype: "text/plain", size: 128 }] } });
const changed = () => ({ event_id: "Ev0000000002", event_time: 1780000300,
  event: { type: "message", subtype: "message_changed", channel: "C22222222", ts: "1780000300.000200",
    message: { user: "U11111111", text: "Shall we work on this together? (edited)", ts: "1780000000.000100",
      edited: { user: "U11111111", ts: "1780000300.000200" } },
    previous_message: { user: "U11111111", text: "Shall we work on this together?", ts: "1780000000.000100" } } });

test("a message event normalizes into a bounded envelope; message_changed is a new version of the same source", () => {
  const first = normalizeSlackEvent(connection, message());
  assert.equal(first.channel, "slack"); assert.equal(first.contractVersion, 1);
  assert.equal(first.sourceId, slackSourceId(connection, "C22222222:1780000000.000100"));
  assert.match(first.sourceId, /^slack-[a-f0-9]{64}$/);
  assert.deepEqual(first.message, { id: "C22222222:1780000000.000100", revision: "Ev0000000001",
    threadId: "C22222222:1780000000.000100", kind: "message", sentAt: new Date(1780000000 * 1000).toISOString(),
    editedAt: null, from: { kind: "user", id: "U11111111", handle: "", displayName: "" },
    to: [{ kind: "channel", id: "C22222222", handle: "", displayName: "" }], subject: null, replyTo: null });
  assert.deepEqual(first.body, { format: "text", content: "Shall we work on this together?" });
  assert.deepEqual(first.attachments, [{ id: "F33333333", kind: "document", name: "brief.txt", contentType: "text/plain", size: 128 }]);
  const edited = normalizeSlackEvent(connection, changed());
  assert.equal(edited.sourceId, first.sourceId, "an edit is a new version of the same source");
  assert.notEqual(edited.sourceVersion, first.sourceVersion);
  assert.equal(edited.message.kind, "edited_message");
  assert.equal(edited.message.revision, "Ev0000000002");
  assert.ok(edited.message.editedAt !== null);
  for (const envelope of [first, edited]) {
    assert.deepEqual(readSlackEnvelope(envelope), envelope);
    assert.deepEqual(readChannelEnvelope(structuredClone(envelope)), envelope);
  }
  assert.equal(adapterFor("slack-app").channel, "slack");
});

test("thread replies, bot messages and image attachments normalize", () => {
  const reply = message(); reply.event.thread_ts = "1780000000.000099";
  const normalized = normalizeSlackEvent(connection, reply);
  assert.equal(normalized.message.threadId, "C22222222:1780000000.000099");
  assert.equal(normalized.message.replyTo, "C22222222:1780000000.000099");
  const bot = message(); bot.event.subtype = "bot_message"; delete bot.event.user; bot.event.bot_id = "B99999999";
  assert.equal(normalizeSlackEvent(connection, bot).message.from.kind, "bot");
  const photo = message(); photo.event.files = [{ id: "F44444444", name: "pic.png", mimetype: "image/png", size: 90000 }];
  assert.deepEqual(normalizeSlackEvent(connection, photo).attachments,
    [{ id: "F44444444", kind: "photo", name: "pic.png", contentType: "image/png", size: 90000 }]);
});

test("malformed events and envelopes throw contract errors", () => {
  const deleted = { event_id: "Ev9", event_time: 1780000000,
    event: { type: "message", subtype: "message_deleted", channel: "C22222222", deleted_ts: "1780000000.000100", ts: "1780000000.000300" } };
  assert.throws(() => normalizeSlackEvent(connection, deleted), { code: "unsupported_slack_event" });
  for (const change of [e => { e.event.ts = "tomorrow"; }, e => { e.event.user = 42; }, e => { e.event.channel = ""; },
    e => { e.event.text = "x".repeat(20000); }, e => { e.event_id = ""; }]) {
    const event = message(); change(event);
    assert.throws(() => normalizeSlackEvent(connection, event), ContractError);
  }
  const other = { ...connection, provider: "discord-bot", channel: "discord" };
  assert.throws(() => normalizeSlackEvent(other, message()), { code: "unsupported_channel" });
  const envelope = normalizeSlackEvent(connection, message());
  for (const change of [e => { e.sourceVersion = "0".repeat(64); }, e => { e.channel = "discord"; },
    e => { e.message.subject = "nope"; }, e => { e.body.format = "html"; }, e => { e.extra = 1; },
    e => { e.attachments.push(e.attachments[0]); }]) {
    const value = structuredClone(envelope); change(value);
    assert.throws(() => readSlackEnvelope(value), ContractError);
  }
});

test("recorded events page by index; deletes are retract changes; the bound adapter hydrates", async () => {
  const deleted = { event_id: "Ev0000000003", event_time: 1780000600,
    event: { type: "message", subtype: "message_deleted", channel: "C22222222", deleted_ts: "1780000000.000100", ts: "1780000600.000300" } };
  const reaction = { event_id: "Ev0000000004", event_time: 1780000700,
    event: { type: "reaction_added", user: "U11111111", reaction: "thumbsup", item: { type: "message", channel: "C22222222", ts: "1780000000.000100" } } };
  const events = [message(), changed(), deleted, reaction];
  const reader = new RecordedSlackEvents({ connection, events, limit: 2 });
  assert.equal(reader.kind, "slack-app");
  const adapter = bind({ reader, connection });
  assert.deepEqual([adapter.channel, adapter.provider, adapter.scope()], ["slack", "slack-app", "updates"]);
  const first = await adapter.changes({ cursor: null });
  assert.deepEqual(first.changes.map(c => [c.messageId, c.action]),
    [["C22222222:1780000000.000100", "hydrate"], ["C22222222:1780000000.000100", "hydrate"]]);
  assert.equal(first.cursor, "2"); assert.equal(first.complete, false);
  const second = await adapter.changes({ cursor: first.cursor });
  assert.deepEqual(second.changes.map(c => c.action), ["retract"], "reaction events are skipped by the change feed");
  assert.equal(second.cursor, "4"); assert.equal(second.complete, false, "a full page may hide more events");
  const third = await adapter.changes({ cursor: second.cursor });
  assert.deepEqual(third.changes, []); assert.equal(third.cursor, "4"); assert.equal(third.complete, true);
  const hydrated = await adapter.hydrate("C22222222:1780000000.000100");
  assert.equal(hydrated.event_id, "Ev0000000002", "hydrate returns the latest event for the message");
  assert.equal(adapter.normalize(hydrated).message.kind, "edited_message");
  assert.equal(await adapter.hydrate("C22222222:0.0"), null);
  assert.equal(qualifySlackCursor("2"), "2");
  assert.throws(() => qualifySlackCursor("x"), { code: "invalid_slack_cursor" });
  assert.throws(() => bind({ reader: {}, connection }), { code: "slack_fixture_reader_required" });
});

test("the recorded transport submit/lookup mirrors the telegram transport", async () => {
  const reader = new RecordedSlackEvents({ connection, events: [message()] });
  const envelope = { provider: "slack-app", adapter: "slack", operationId: "op-1", previewVersion: "v1" };
  const receipt = await reader.submit({ operationId: "op-1", envelope });
  assert.equal(receipt.outcome, "accepted");
  assert.deepEqual(await reader.lookup({ operationId: "op-1" }), receipt);
  await assert.rejects(reader.submit({ operationId: "op-2", envelope: { provider: "discord-bot", adapter: "discord" } }),
    { code: "slack_transport_mismatch" });
  assert.deepEqual(reader.sent(), [envelope]);
  assert.ok(slackLimits.updates > 0);
});
