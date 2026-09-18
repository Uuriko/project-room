// Task 45 (TASKS.md): token-leak regression test. GitHub secret-scanning
// alert #1 burned a real Telegram bot token into the repo; the scanner side
// of that fix is pinned in tests/secret-scan.test.js. These tests close the
// runtime side: the room's own configured bot token must never reach its
// journals, logs, or API responses. The burned token's VALUE never appears
// here — only its shape, generated at runtime (GitHub push protection).
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { scanText, PATTERNS } from "../server/secret-scan.mjs";
import { telegramConfig, redactTelegram, TelegramLiveStatus, telegramLiveView } from "../server/channel-adapters/telegram-config.mjs";
import { LiveTelegramPoller } from "../server/channel-adapters/telegram-poller.mjs";
import { TelegramTransport } from "../server/channel-adapters/telegram-transport.mjs";
import { ChannelWebhookInbox } from "../server/channel-import.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

// The burned token's shape (alert #1): 9-digit bot id + 34-char secret.
// Generated at runtime so this file never contains a literal shaped string.
const fakeBotToken = () => {
  const botId = String(100000000 + Math.floor(Math.random() * 899999999));
  const secret = randomBytes(26).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "x").slice(0, 34);
  return `${botId}:${secret}`;
};
const shapeSource = PATTERNS.find(p => p.id === "telegram-bot-token").regex.source;
const shaped = text => (String(text).match(new RegExp(shapeSource, "g")) ?? []).length;
const tokenFindings = text => scanText(String(text)).filter(f => f.rule === "telegram-bot-token");
const webhookSecret = () => randomBytes(24).toString("base64url");
const configured = token => telegramConfig({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: webhookSecret() });
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("the runtime fixture exercises the real bot-token shape", () => {
  const token = fakeBotToken();
  assert.equal(shaped(token), 1, "fixture must be exactly one token-shaped string");
  assert.ok(tokenFindings(token).length >= 1, "the secret scanner must flag the fixture shape");
});

test("redactTelegram strips the token in every surface form", () => {
  const token = fakeBotToken();
  const variants = [
    token, // bare, as in a log line
    `https://api.telegram.org/bot${token}/sendMessage`, // Bot API URL form
    `Bad Request: invalid bot token ${token}`, // provider error description
    `bot${token}`, // the bot-prefixed compact form
  ];
  for (const variant of variants) {
    const redacted = redactTelegram(variant);
    assert.equal(shaped(redacted), 0, `redacted surface must carry no token-shaped string: ${redacted}`);
    assert.ok(redacted.includes("<redacted>"), "redaction marker must be visible");
  }
});

test("a serialized config never carries the token value", () => {
  const token = fakeBotToken(), secret = webhookSecret();
  const config = telegramConfig({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret });
  assert.equal(config.configured, true);
  assert.equal(shaped(JSON.stringify(config)), 0, "JSON.stringify(config) must not leak the token");
  assert.equal(config.methodPath("getUpdates"), "/bot<redacted>/getUpdates", "log/dry-run method paths are redacted");
  assert.equal(config.botToken(), token, "the live accessor still returns the token for real calls");
  const hash = config.webhookSecretHash();
  assert.match(hash, /^[0-9a-f]{64}$/, "the webhook secret leaves the process only as a sha256 hash");
  assert.equal(shaped(hash), 0);
});

test("live status snapshots and the connection card carry no token-shaped strings", () => {
  const token = fakeBotToken(), config = configured(token);
  const { connection } = telegramContractFixture();
  const status = new TelegramLiveStatus();
  status.received(connection.accountId, connection.id, { at: 1_700_000_000_000, count: 2 });
  status.sent(connection.accountId, connection.id, { at: 1_700_000_000_001, outcome: "accepted", code: null });
  assert.equal(shaped(JSON.stringify(status.snapshot(connection.accountId, connection.id))), 0, "live-status rows are counts and timestamps only");
  const view = telegramLiveView({ config, connection, record: connection, status, importAvailable: false });
  assert.equal(shaped(JSON.stringify(view)), 0, "the connection card shows binding names and states, never values");
});

test("the webhook journal path never stores the configured token", async t => {
  const token = fakeBotToken();
  void token; // The room holds this token; it must never reach the journal below.
  const hookSecret = "fixture-webhook-secret-0123456789";
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.telegram = telegramContractFixture();
  const account = f.store.accountForMember("commons", "owner"), key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
  const auth = { token: slot.token, account, ...f.store.loginAccountSession(slot.token, key, 0) };
  f.telegram.connection.accountId = account.id;
  const connectionId = f.telegram.connection.id;
  f.store.connections.apply(auth.token, { action: "connection.configure", requestId: randomUUID(), connectionId, expectedRevision: 0, profile: structuredClone(f.telegram.connection) }, auth.sessionBinding);
  f.store.connections.apply(auth.token, { action: "connection.webhook", requestId: randomUUID(), connectionId, expectedRevision: 1, secretHash: ChannelWebhookInbox.hash(hookSecret) }, auth.sessionBinding);
  const webhooks = new ChannelWebhookInbox(f.store);
  const message = (id, text) => ({ update_id: id, message: { message_id: id, date: 1788948000 + id, chat: f.telegram.chat, from: { id: 5000000001, is_bot: false, first_name: "Avery" }, text } });
  const received = webhooks.receive({ connectionId, secret: hookSecret, body: { updates: [message(7001, "Hello from the room")] } });
  assert.equal(received.accepted, 1);
  // Journal rows: payload and error text.
  for (const row of f.store.db.prepare("SELECT update_id, status, payload, last_error FROM pending_channel_updates").all()) {
    assert.equal(shaped(row.payload), 0, `journal payload for update ${row.update_id} must carry no token-shaped string`);
    assert.equal(shaped(String(row.last_error)), 0, `journal last_error for update ${row.update_id} must carry no token-shaped string`);
  }
  // The pending backlog the drainer reads.
  for (const payload of webhooks.pending(account.id, connectionId)) assert.equal(shaped(JSON.stringify(payload)), 0, "drained backlog payloads carry no token-shaped string");
  // The stored connection: secretHash only, never the plaintext secret or a token.
  const stored = f.store.db.prepare("SELECT data_json FROM private_email_connections WHERE id=?").get(connectionId);
  assert.equal(shaped(stored.data_json), 0, "the stored connection carries hashes, not secrets");
  // Room-controlled failure recording uses contract codes, not raw provider text.
  webhooks.fail(account.id, connectionId, [7001], "channel_sync_unsupported");
  const failed = f.store.db.prepare("SELECT last_error FROM pending_channel_updates WHERE update_id=7001").get();
  assert.equal(shaped(String(failed.last_error)), 0, "journaled failure codes carry no token-shaped string");
});

test("poller error surfaces redact the token before callers see it", async () => {
  const token = fakeBotToken();
  const config = configured(token), { connection } = telegramContractFixture();
  const fetch = async () => jsonResponse(400, { ok: false, description: `Bad Request: invalid bot token ${token}` });
  const poller = new LiveTelegramPoller({ config, connection, fetch, sleep: () => {}, now: () => 1_700_000_000_000,
    longPollSecs: 1, timeoutSlackMs: 50, baseDelayMs: 0, maxDelayMs: 10 });
  await assert.rejects(poller.getUpdates(), error => {
    assert.equal(error.code, "channel_poller_unavailable");
    assert.equal(shaped(error.message), 0, "poller errors must never carry the raw token");
    assert.ok(error.message.includes("<redacted>"), "the provider description is redacted, not dropped");
    return true;
  });
});

test("transport error surfaces never carry the token value", async () => {
  const token = fakeBotToken();
  const config = configured(token);
  const envelope = { adapter: "telegram", provider: "telegram-bot", previewVersion: "pv1",
    target: { chatId: "123", replyToMessageId: null, threadId: "thread" }, body: "hello" };
  const run = (status, description) => new TelegramTransport({ config, fetch: async () => jsonResponse(status, { ok: false, description }),
    sleep: () => {}, now: () => 1_700_000_000_000 });
  // A 400 whose provider description echoes the token: the receipt code is a
  // slug of the redacted description.
  const rejected = await run(400, `Bad Request: chat not found (token ${token})`).submit({ operationId: randomUUID(), envelope });
  assert.equal(rejected.outcome, "rejected");
  assert.equal(shaped(JSON.stringify(rejected)), 0, "send receipts must carry no token-shaped string");
  assert.ok(rejected.code.includes("redacted"), "the redaction marker survives the code slug");
  // A 401: the room answers with its own fixed message, never the provider's text.
  await assert.rejects(run(401, `Unauthorized: bad token ${token}`).submit({ operationId: randomUUID(), envelope }), error => {
    assert.equal(error.code, "channel_connection_unavailable");
    assert.equal(shaped(error.message), 0, "the 401 message names the binding, never the token value");
    return true;
  });
});
