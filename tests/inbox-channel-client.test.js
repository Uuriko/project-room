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
  const rows = [{ id: "note", revision: 1, adapter: "synthetic", sender: "a", recipient: "b", subject: "Sample", updatedAt: 1, connection: null },
    { id: "tg", revision: 2, adapter: "telegram", sender: "Avery", recipient: "Fixture Room Bot", subject: "Fixture planning", updatedAt: 2,
      connection: { id: "telegram-fixture", channel: "telegram", provider: "telegram-bot", state: "active" } }];
  const ok = setup(async () => reply({ contractVersion: 1, viewer, sources: rows }));
  assert.equal((await ok.list()).sources.length, 2);
  for (const change of [r => r[1].connection = null, r => r[0].connection = r[1].connection, r => r[1].connection.state = "paused",
    r => r[1].connection.secret = "x", r => r[1].adapter = "sms"]) {
    const value = structuredClone(rows); change(value);
    await assert.rejects(setup(async () => reply({ contractVersion: 1, viewer, sources: value })).list(), { code: "invalid_inbox_response" });
  }
});
test("the Telegram reading view and send preview are accepted only in their negotiated shapes", async () => {
  const source = { id: "tg", revision: 1, adapter: "telegram", sender: "Avery Quinn", recipient: "Fixture Room Bot", subject: "Fixture planning", paragraphs: ["Shall we?"],
    capabilities: { draft: true, share: true, send: false }, channel: { view: "channel-excerpt-v1", accountId: "owner", channel: "telegram", provider: "telegram-bot",
      connectionState: "active", format: "text", kind: "message", edited: false, chat: "Fixture planning", attachmentCount: 0 } };
  const ok = setup(async path => { assert.equal(path, "/api/inbox/sources/tg?view=email-excerpt-v1"); return reply({ contractVersion: 1, viewer, source, draft: null }); });
  assert.equal((await ok.read("tg")).source.capabilities.share, true);
  for (const change of [s => s.channel.view = "channel-text-v1", s => s.channel.accountId = "other", s => s.capabilities.send = true, s => s.paragraphs = ["a", "b"],
    s => s.channel.format = "html", s => s.channel.kind = "callback_query", s => s.capabilities.share = false, s => s.paragraphs = ["line\r\n"], s => s.channel.attachmentCount = 21]) {
    const value = structuredClone(source); change(value);
    await assert.rejects(setup(async () => reply({ contractVersion: 1, viewer, source: value, draft: null })).read("tg"), { code: "invalid_inbox_response" });
  }
  const envelope = { adapter: "telegram", provider: "telegram-bot", accountId: "owner", authEpoch: 2, sourceId: "tg", sourceRevision: 1, draftRevision: 1,
    from: "Fixture Room Bot", to: ["Fixture planning"], subject: "", body: "Sounds good", attachments: [], target: { chatId: "-1001", replyToMessageId: "41", threadId: "-1001" } };
  const preview = { ...envelope, previewVersion: (await inboxTextVersion(JSON.stringify(envelope))).slice(7) };
  const sendContext = setup(async () => reply({ contractVersion: 1, viewer, sourceId: "tg", preview, simulationAvailable: false }));
  assert.equal((await sendContext.sendContext("tg")).preview.target.chatId, "-1001");
  for (const change of [p => p.target.chatId = "-1002", p => p.provider = "synthetic", p => p.subject = "x", p => p.body = "changed", p => delete p.target]) {
    const value = structuredClone(preview); change(value);
    await assert.rejects(setup(async () => reply({ contractVersion: 1, viewer, sourceId: "tg", preview: value, simulationAvailable: false })).sendContext("tg"), { code: "invalid_inbox_response" });
  }
});
