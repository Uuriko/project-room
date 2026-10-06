// Contract tests for every channel adapter in server/channel-adapters/.
// Invented fixture data only: no real accounts, tokens, numbers, or people.
//
// What this file owns (and nothing else does):
//  1. The registry contract (index.mjs): provider -> adapter resolution,
//     the first-provider rule per channel, and dispatch error mapping.
//  2. The microsoft-graph bind driver (email.mjs): the only registry adapter
//     whose bound driver (changes/hydrate/submit/lookup) had no test.
//  3. The telegram fixture send contract (submit/lookup): idempotent replay,
//     correlation conflicts, rejected mode, and provider mismatch mapping.
//
// Per-adapter normalize/envelope coverage lives in the dedicated adapter
// tests (telegram-adapter, gmail-adapter, whatsapp-adapter,
// channel-sms-adapter, channel-messenger-adapter, email-contract,
// email-routing-inbound). Relay adapters (slack-webhook, discord-webhook,
// webhook-secret) and the live telegram transport are covered by
// notify-relays.test.js and telegram-live.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { ContractError, channelProviders } from "../server/channel-connection.mjs";
import { channelAdapters, adapterFor, adapterForChannel, readChannelEnvelope } from "../server/channel-adapters/index.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { gmailContractFixture } from "../scripts/gmail-contract-fixture.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import * as graphEmail from "../server/channel-adapters/email.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";
import { emailSourceId } from "../server/email-envelope.mjs";
import { RecordedGraphMailbox } from "../server/graph-fixture-sync.mjs";
import { normalizeGmailMessage } from "../server/channel-adapters/gmail.mjs";
import { normalizeTelegramUpdate, RecordedTelegramBot, bind as bindTelegram } from "../server/channel-adapters/telegram.mjs";
import { normalizeWhatsappUpdate } from "../server/channel-adapters/whatsapp.mjs";
import { normalizeSmsWebhook } from "../server/channel-adapters/sms.mjs";
import { normalizeMessengerEvent } from "../server/channel-adapters/messenger.mjs";

// --- Registry contract -------------------------------------------------

test("registry: every provider resolves to its channel's adapter; the first provider owns channel dispatch", () => {
  for (const [channel, providers] of Object.entries(channelProviders)) {
    for (const provider of providers) {
      const adapter = adapterFor(provider);
      assert.equal(adapter.channel, channel, `${provider} must serve channel ${channel}`);
      assert.equal(adapter.provider, provider);
      assert.equal(channelAdapters.get(provider), adapter);
    }
    assert.equal(adapterForChannel(channel).provider, providers[0],
      `channel dispatch for ${channel} must use its first provider, never a later one`);
  }
  assert.equal(adapterForChannel("email").provider, "microsoft-graph",
    "the email channel dispatches to microsoft-graph, not gmail-api");
  assert.throws(() => adapterFor("pager-network"),
    error => error instanceof ContractError && error.code === "unsupported_channel");
  assert.throws(() => adapterForChannel("pager"),
    error => error instanceof ContractError && error.code === "unsupported_channel");
});

const whatsappConnection = { accountId: "account-fixture", id: "whatsapp-fixture", revision: 1,
  channel: "whatsapp", provider: "whatsapp-cloud", externalId: "109876543210987",
  identity: { kind: "bot", id: "109876543210987", handle: "", displayName: "15551234567" },
  capabilities: { read: true, send: false, threads: false, edit: false } };
const smsConnection = { accountId: "account-fixture", id: "sms-fixture", revision: 1,
  channel: "sms", provider: "sms-gateway", externalId: "+15550001111",
  identity: { kind: "user", id: "+15550001111", handle: "+15550001111", displayName: "Fixture line" },
  capabilities: { read: true, send: true, threads: false, edit: false } };
const messengerConnection = { accountId: "account-fixture", id: "messenger-fixture", revision: 1,
  channel: "messenger", provider: "messenger-api", externalId: "111222333444555",
  identity: { kind: "user", id: "111222333444555", handle: "", displayName: "page:111222333444555" },
  capabilities: { read: true, send: true, threads: false, edit: false } };

test("registry: readChannelEnvelope dispatches every channel's real envelope to its own adapter", () => {
  const graph = emailContractFixture();
  const gmail = gmailContractFixture();
  const telegram = telegramContractFixture();
  const envelopes = [
    normalizeGraphEmail(graph.connection, graph.message, graph.options),
    normalizeGmailMessage(gmail.connection, gmail.messages[0].response.message, { labelId: gmail.labelId }),
    normalizeTelegramUpdate(telegram.connection, telegram.updates[0]),
    normalizeWhatsappUpdate(whatsappConnection, { value: { messaging_product: "whatsapp",
      metadata: { display_phone_number: "15551234567", phone_number_id: "109876543210987" } },
      message: { from: "15557654321", id: "wamid.fixture0001", timestamp: "1788948000", type: "text",
        text: { body: "Hello from the fixture" } } }),
    normalizeSmsWebhook(smsConnection, { MessageSid: "SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      From: "+15550002222", To: "+15550001111", Body: "Hello from the fixture" }),
    normalizeMessengerEvent(messengerConnection, "111222333444555",
      { sender: { id: "999888777666555" }, recipient: { id: "111222333444555" }, timestamp: 1788948000000,
        message: { mid: "mid.fixture-1", text: "Hello from the fixture" } }),
  ];
  for (const envelope of envelopes) {
    assert.deepEqual(readChannelEnvelope(structuredClone(envelope)), envelope,
      `${envelope.channel} envelopes must round-trip through the registry dispatch`);
  }
});

test("registry: dispatch preserves the adapter's own error codes instead of masking them", () => {
  const { connection, updates } = telegramContractFixture();
  const broken = structuredClone(normalizeTelegramUpdate(connection, updates[0]));
  delete broken.body;
  assert.throws(() => readChannelEnvelope(broken),
    error => error instanceof ContractError && error.code === "invalid_telegram_message",
    "a malformed telegram envelope must surface the adapter's code, not unsupported_channel");
  assert.throws(() => readChannelEnvelope({ channel: "pager", contractVersion: 1 }), { code: "unsupported_channel" });
  assert.throws(() => readChannelEnvelope({}), { code: "unsupported_channel" });
});

// --- microsoft-graph bind driver ----------------------------------------

const graphRecording = () => {
  const f = emailContractFixture();
  return { f, recording: { connection: f.connection,
    pages: [{ cursor: null, response: { status: 200, body: { value: [{ id: f.message.id }],
      "@odata.deltaLink": "https://graph.example.test/delta?token=one" } } }],
    messages: [{ id: f.message.id, response: { status: 200, message: f.message, options: f.options } }] } };
};
const bindGraph = (recording, connection) =>
  graphEmail.bind({ reader: new RecordedGraphMailbox(recording), connection, folderId: "AQMkFixtureInbox=" });

test("microsoft-graph: bind refuses non-fixture readers and declares its registry identity", () => {
  const { f, recording } = graphRecording();
  assert.equal(graphEmail.channel, "email");
  assert.equal(graphEmail.provider, "microsoft-graph");
  assert.throws(() => graphEmail.bind({ reader: { page: async () => ({}), message: async () => ({}) },
    connection: f.connection, folderId: "AQMkFixtureInbox=" }),
    error => error instanceof ContractError && error.code === "email_fixture_reader_required",
    "a duck-typed reader must not slip past the fixture check");
  const adapter = bindGraph(recording, f.connection);
  assert.equal(adapter.channel, "email");
  assert.equal(adapter.provider, "microsoft-graph");
  assert.equal(adapter.scope(), "AQMkFixtureInbox=", "the bound scope is the requested folder");
});

test("microsoft-graph: changes pages the recorded mailbox; failed pages are contract errors", async () => {
  const { f, recording } = graphRecording();
  const adapter = bindGraph(recording, f.connection);
  const page = await adapter.changes({ cursor: null });
  assert.deepEqual(page.changes, [{ messageId: f.message.id, action: "hydrate" }]);
  assert.equal(page.cursor, "https://graph.example.test/delta?token=one");
  assert.equal(page.complete, true);
  const failed = structuredClone(recording);
  failed.pages = [{ cursor: null, response: { status: 503 } }];
  failed.messages = [];
  await assert.rejects(bindGraph(failed, f.connection).changes({ cursor: null }),
    { code: "email_fixture_page_failed" });
});

test("microsoft-graph: hydrate returns the message, null on gone, contract errors otherwise", async () => {
  const { f, recording } = graphRecording();
  const hydrated = await bindGraph(recording, f.connection).hydrate(f.message.id);
  assert.equal(hydrated.message.id, f.message.id);
  const gone = structuredClone(recording);
  gone.messages = [{ id: f.message.id, response: { status: 404, code: "ErrorItemNotFound" } }];
  assert.equal(await bindGraph(gone, f.connection).hydrate(f.message.id), null);
  const unknown = structuredClone(recording);
  unknown.messages = [{ id: f.message.id, response: { status: 404, code: "Unknown" } }];
  await assert.rejects(bindGraph(unknown, f.connection).hydrate(f.message.id),
    { code: "email_fixture_hydration_failed" });
  const mismatched = structuredClone(recording);
  mismatched.messages = [{ id: f.message.id, response: { status: 200, message: { ...f.message, id: "other-id" }, options: f.options } }];
  await assert.rejects(bindGraph(mismatched, f.connection).hydrate(f.message.id),
    { code: "email_fixture_hydration_failed" });
});

test("microsoft-graph: submit and lookup stay unavailable, and helpers delegate to the shared email contract", async () => {
  const { f, recording } = graphRecording();
  const adapter = bindGraph(recording, f.connection);
  await assert.rejects(adapter.submit(), { code: "channel_sending_unavailable" });
  await assert.rejects(adapter.lookup(), { code: "channel_sending_unavailable" });
  const envelope = adapter.normalize({ message: f.message, options: f.options });
  assert.deepEqual(envelope, normalizeGraphEmail(f.connection, f.message, f.options));
  assert.equal(adapter.sourceId(f.message.id), emailSourceId(f.connection, f.message.id));
  assert.equal(graphEmail.scope(envelope), envelope.message.folderId);
});

// --- telegram fixture send contract -------------------------------------

test("telegram fixture: submit records one receipt per operation key and replays it idempotently", async () => {
  const { connection } = telegramContractFixture();
  const reader = new RecordedTelegramBot({ connection, updates: [] });
  const adapter = bindTelegram({ reader, connection });
  const envelope = { provider: "telegram-bot", adapter: "telegram", previewVersion: "v1" };
  const receipt = await adapter.submit({ operationId: "op-1", envelope });
  assert.equal(receipt.outcome, "accepted");
  assert.equal(receipt.operationId, "op-1");
  assert.equal(receipt.providerId, "op-1");
  assert.deepEqual(await adapter.lookup({ operationId: "op-1" }), receipt);
  assert.deepEqual(await adapter.submit({ operationId: "op-1", envelope }), receipt,
    "a retried submit with the same key and version replays the recorded receipt instead of posting again");
  assert.equal(await adapter.lookup({ operationId: "missing" }), null);
});

test("telegram fixture: version conflicts, rejected mode and provider mismatches map to errors", async () => {
  const { connection } = telegramContractFixture();
  const reader = new RecordedTelegramBot({ connection, updates: [] });
  const adapter = bindTelegram({ reader, connection });
  const envelope = version => ({ provider: "telegram-bot", adapter: "telegram", previewVersion: version });
  await adapter.submit({ operationId: "op-1", envelope: envelope("v1") });
  await assert.rejects(adapter.submit({ operationId: "op-1", envelope: envelope("v2") }), /Telegram correlation conflict/,
    "the same key may never record two different replies");
  reader.mode = "rejected";
  const rejected = await adapter.submit({ operationId: "op-2", envelope: envelope("v1") });
  assert.equal(rejected.outcome, "rejected");
  assert.equal(rejected.providerId, null);
  await assert.rejects(adapter.submit({ operationId: "op-3",
    envelope: { provider: "sms-gateway", adapter: "telegram", previewVersion: "v1" } }),
    { code: "telegram_transport_mismatch" });
});
