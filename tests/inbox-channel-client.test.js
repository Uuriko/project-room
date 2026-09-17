import test from "node:test";
import assert from "node:assert/strict";
import { AccountClient } from "../src/client.js";
import { InboxClient, inboxTextVersion, validConnection } from "../src/inbox-client.js";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";

const session = { authenticated: true, account: { id: "owner", authEpoch: 2 }, sessionRevision: 4, sessionBinding: "a".repeat(64), csrf: "csrf" };
const viewer = { accountId: "owner", authEpoch: 2, sessionRevision: 4, sessionBinding: session.sessionBinding };
const reply = value => ({ ok: true, json: async () => value });
function setup(fetcher) {
  const account = new AccountClient({ fetcher }); account.session = structuredClone(session);
  return new InboxClient(account, { onAccessEnded: () => {} });
}
const record = () => ({ ...telegramContractFixture().connection, accountId: "owner", state: "active" });
test("connection records are validated strictly in the browser client", async () => {
  const c = record();
  assert.equal(validConnection(c, "owner"), true);
  for (const change of [r => r.accountId = "other", r => r.extra = 1, r => delete r.state, r => r.state = "paused", r => r.channel = "sms",
    r => r.capabilities.send = "yes", r => r.identity.secret = "x", r => r.revision = 0]) {
    const value = record(); change(value); assert.equal(validConnection(value, "owner"), false);
  }
  const list = setup(async path => { assert.equal(path, "/api/inbox/connections"); return reply({ contractVersion: 1, viewer, connections: [record()] }); });
  assert.equal((await list.connections()).connections[0].channel, "telegram");
  await assert.rejects(setup(async () => reply({ contractVersion: 1, viewer, connections: [{ ...record(), state: "paused" }] })).connections(), { code: "invalid_inbox_response" });
  const one = setup(async path => { assert.equal(path, "/api/inbox/connections/telegram-fixture"); return reply({ contractVersion: 1, viewer, connection: record(), mode: "fixture", webhook: false, syncAvailable: false }); });
  assert.equal((await one.connection("telegram-fixture")).mode, "fixture");
  await assert.rejects(setup(async () => reply({ contractVersion: 1, viewer, connection: record(), mode: "live", webhook: false, syncAvailable: false })).connection("telegram-fixture"), { code: "invalid_inbox_response" });
});
test("the inbox list carries a connection reference per channel source and none for samples", async () => {
  const rows = [{ id: "note", revision: 1, adapter: "synthetic", sender: "a", recipient: "b", subject: "Sample", updatedAt: 1, connection: null, needsYou: false },
    { id: "tg", revision: 2, adapter: "telegram", sender: "Avery", recipient: "Fixture Room Bot", subject: "Fixture planning", updatedAt: 2,
      connection: { id: "telegram-fixture", channel: "telegram", provider: "telegram-bot", state: "active" }, needsYou: true }];
  const ok = setup(async () => reply({ contractVersion: 1, viewer, sources: rows, nextCursor: null }));
  assert.equal((await ok.list()).sources.length, 2);
  assert.equal((await ok.list()).sources[1].needsYou, true);
  for (const change of [r => r[1].connection = null, r => r[0].connection = r[1].connection, r => r[1].connection.state = "paused",
    r => r[1].connection.secret = "x", r => r[1].adapter = "sms", r => delete r[1].needsYou, r => r[0].needsYou = true, r => r[1].needsYou = "yes"]) {
    const value = structuredClone(rows); change(value);
    await assert.rejects(setup(async () => reply({ contractVersion: 1, viewer, sources: value, nextCursor: null })).list(), { code: "invalid_inbox_response" });
  }
});
test("the Telegram reading view and send preview are accepted only in their negotiated shapes", async () => {
  const source = { id: "tg", revision: 1, adapter: "telegram", sender: "Avery Quinn", recipient: "Fixture Room Bot", subject: "Fixture planning", paragraphs: ["Shall we?"],
    capabilities: { draft: true, share: true, send: true }, needsYou: false, channel: { view: "channel-excerpt-v1", accountId: "owner", channel: "telegram", provider: "telegram-bot",
      connectionState: "active", format: "text", kind: "message", edited: false, chat: "Fixture planning", attachmentCount: 0 } };
  const ok = setup(async path => { assert.equal(path, "/api/inbox/sources/tg?view=email-excerpt-v1"); return reply({ contractVersion: 1, viewer, source, draft: null }); });
  assert.equal((await ok.read("tg")).source.capabilities.share, true);
  assert.equal((await ok.read("tg")).source.capabilities.send, true, "an active bot connection may offer replies");
  // send is a boolean; it may not be claimed for a connection that is not active.
  for (const change of [s => s.channel.view = "channel-text-v1", s => s.channel.accountId = "other", s => s.capabilities.send = "yes", s => { s.channel.connectionState = "disconnected"; }, s => delete s.needsYou, s => s.paragraphs = ["a", "b"],
    s => s.channel.format = "html", s => s.channel.kind = "callback_query", s => s.capabilities.share = false, s => s.paragraphs = ["line\r\n"], s => s.channel.attachmentCount = 21]) {
    const value = structuredClone(source); change(value);
    await assert.rejects(setup(async () => reply({ contractVersion: 1, viewer, source: value, draft: null })).read("tg"), { code: "invalid_inbox_response" });
  }
  const envelope = { adapter: "telegram", provider: "telegram-bot", accountId: "owner", authEpoch: 2, sourceId: "tg", sourceRevision: 1, draftRevision: 1,
    from: "Fixture Room Bot", to: ["Fixture planning"], subject: "", body: "Sounds good", attachments: [], target: { chatId: "-1001", replyToMessageId: "41", threadId: "-1001" } };
  const preview = { ...envelope, previewVersion: (await inboxTextVersion(JSON.stringify(envelope))).slice(7) };
  const sendContext = setup(async () => reply({ contractVersion: 1, viewer, sourceId: "tg", preview, simulationAvailable: false, channelSend: { provider: "telegram-bot", mode: "fixture" } }));
  assert.equal((await sendContext.sendContext("tg")).preview.target.chatId, "-1001");
  assert.equal((await sendContext.sendContext("tg")).channelSend.mode, "fixture");
  for (const change of [p => p.target.chatId = "-1002", p => p.provider = "synthetic", p => p.subject = "x", p => p.body = "changed", p => delete p.target]) {
    const value = structuredClone(preview); change(value);
    await assert.rejects(setup(async () => reply({ contractVersion: 1, viewer, sourceId: "tg", preview: value, simulationAvailable: false })).sendContext("tg"), { code: "invalid_inbox_response" });
  }
  // The channel transport descriptor is either absent/null or exactly { provider, mode }.
  for (const channelSend of [{ provider: "microsoft-graph", mode: "fixture" }, { provider: "telegram-bot", mode: "real" }, { provider: "telegram-bot", mode: "live", token: "x" }, "fixture"]) {
    await assert.rejects(setup(async () => reply({ contractVersion: 1, viewer, sourceId: "tg", preview, simulationAvailable: false, channelSend })).sendContext("tg"), { code: "invalid_inbox_response" });
  }
});
test("the channel send route response and connection commands are validated in the browser client", async () => {
  const { validConnectionCommand, validChannelSend } = await import("../src/inbox-client.js");
  assert.equal(validChannelSend(null), true); assert.equal(validChannelSend({ provider: "telegram-bot", mode: "live" }), true);
  assert.equal(validChannelSend({ provider: "telegram-bot" }), false);
  const profile = record(); delete profile.state;
  const configure = { action: "connection.configure", requestId: "r1", connectionId: profile.id, expectedRevision: 0, profile };
  assert.equal(validConnectionCommand(configure), true);
  assert.equal(validConnectionCommand({ ...configure, profile: { ...profile, revision: 3 } }), false, "profile revision must follow expectedRevision");
  assert.equal(validConnectionCommand({ ...configure, connectionId: "other" }), false);
  assert.equal(validConnectionCommand({ action: "connection.webhook", requestId: "r1", connectionId: profile.id, expectedRevision: 1, secretHash: "0".repeat(64) }), false, "webhook hashes never come from the browser");
  assert.equal(validConnectionCommand({ action: "page.apply", requestId: "r1", connectionId: profile.id, expectedRevision: 1 }), false);
  assert.equal(validConnectionCommand({ action: "connection.disconnect", requestId: "r1", connectionId: profile.id, expectedRevision: 1 }), true);
  assert.equal(validConnectionCommand({ action: "connection.disconnect", requestId: "r1", connectionId: profile.id, expectedRevision: 1, extra: true }), false);
  const mailbox = { accountId: "owner", id: "mailbox", revision: 1, provider: "microsoft-graph", mailboxId: "me@example.test", identity: { name: "Me", address: "me@example.test" }, aliases: [] };
  assert.equal(validConnectionCommand({ action: "connection.configure", requestId: "r2", connectionId: "mailbox", expectedRevision: 0, profile: mailbox }), true);
  const envelope = { adapter: "telegram", provider: "telegram-bot", accountId: "owner", authEpoch: 2, sourceId: "tg", sourceRevision: 1, draftRevision: 1,
    from: "Fixture Room Bot", to: ["Fixture planning"], subject: "", body: "Sounds good", attachments: [], target: { chatId: "-1001", replyToMessageId: "41", threadId: "-1001" } };
  const send = { id: "send-1", sourceId: "tg", revision: 2, status: "accepted", providerId: "fixture:reply-abc", createdAt: 1, updatedAt: 2,
    envelope: { ...envelope, previewVersion: (await inboxTextVersion(JSON.stringify(envelope))).slice(7) } };
  const response = { contractVersion: 1, viewer, sourceId: "tg", sends: [send], simulationAvailable: false, channelSend: { provider: "telegram-bot", mode: "fixture" }, send,
    lastSendResult: { at: "2026-09-14T09:00:00.000Z", outcome: "accepted", code: "fixture" } };
  const posted = []; const ok = setup(async (path, options) => { posted.push([path, JSON.parse(options.body)]); return reply(response); });
  assert.equal((await ok.channelSend("dispatch", "tg", "send-1")).send.status, "accepted");
  assert.deepEqual(posted[0], ["/api/inbox/channel-sends", { action: "dispatch", sourceId: "tg", sendId: "send-1" }]);
  for (const change of [v => v.channelSend = null, v => v.send.id = "send-2", v => v.lastSendResult = { at: "now", outcome: "accepted", code: null }, v => v.lastSendResult.outcome = "maybe"]) {
    const value = structuredClone(response); change(value);
    await assert.rejects(setup(async () => reply(value)).channelSend("dispatch", "tg", "send-1"), { code: "invalid_inbox_response" });
  }
  const applied = setup(async (path, options) => { const data = JSON.parse(options.body); assert.equal(path, "/api/inbox/connections/commands");
    return reply({ contractVersion: 1, viewer, connection: record(), mode: "fixture", webhook: false, syncAvailable: false, live: null, duplicate: false,
      receipt: { requestId: data.requestId, action: data.action, connectionId: data.connectionId, revision: 1, state: "active" } }); });
  assert.equal((await applied.applyConnection(configure)).receipt.state, "active");
  await assert.rejects(applied.applyConnection({ action: "connection.webhook", requestId: "r1", connectionId: profile.id, expectedRevision: 1, secretHash: "0".repeat(64) }), { code: "invalid_channel_connection" });
});
