import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { RecordedTelegramBot, telegramSourceId } from "../server/channel-adapters/telegram.mjs";
import { telegramConfig, hashWebhookSecret, redactTelegram, TelegramLiveStatus, telegramLiveView } from "../server/channel-adapters/telegram-config.mjs";
import { TelegramTransport, telegramSendAdapter, telegramSendRequest, telegramRetryDelay } from "../server/channel-adapters/telegram-transport.mjs";
import { runSetWebhook, setWebhookPlan, webhookUrl } from "../scripts/telegram-set-webhook.mjs";
import { prepareTelegramFixturePage, ChannelWebhookInbox } from "../server/channel-import.mjs";
import { SyntheticInboxTransport } from "../server/inbox-transport.mjs";
import { createRoomServer } from "../server/http.mjs";

// Obviously fake bindings: the shape Telegram uses, never a real token.
const FAKE_TOKEN = "123456789:AAFakeFakeFakeFakeFakeFakeFakeFakeFa";
const FAKE_SECRET = "fixture-webhook-secret-0123456789";
const env = (overrides = {}) => ({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_WEBHOOK_SECRET: FAKE_SECRET, ...overrides });
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sink = () => { const out = { text: "", write(chunk) { out.text += chunk; return true; } }; return out; };

function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.telegram = telegramContractFixture(); f.sessions = {};
  for (const role of ["owner", "guest"]) {
    const account = f.store.accountForMember("commons", role), key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
    f.sessions[role] = { token: slot.token, account, ...f.store.loginAccountSession(slot.token, key, 0) };
  }
  f.auth = f.sessions.owner; f.telegram.connection.accountId = f.auth.account.id;
  f.apply = (request, role = "owner") => f.store.connections.apply(f.sessions[role].token, request, f.sessions[role].sessionBinding);
  f.configure = profile => f.apply({ action: "connection.configure", requestId: randomUUID(), connectionId: profile.id, expectedRevision: 0, profile: structuredClone(profile) });
  f.reader = () => new RecordedTelegramBot({ connection: f.telegram.connection, updates: f.telegram.updates, limit: 100 });
  f.inbox = request => f.store.inbox.apply(f.auth.token, request, f.auth.sessionBinding);
  f.sourceId = messageId => telegramSourceId(f.telegram.connection, messageId);
  // A queued Telegram reply attempt, ready for a transport.
  f.queuedReply = async () => {
    f.configure(f.telegram.connection);
    const reader = f.reader(); f.apply(await prepareTelegramFixturePage({ store: f.store, token: f.auth.token, binding: f.auth.sessionBinding, connectionId: f.telegram.connection.id, reader }));
    const sourceId = f.sourceId("-1001000000001:42");
    f.inbox({ action: "draft.save", requestId: "draft", sourceId, sourceRevision: 1, expectedRevision: 0, body: "Thanks, reading it now." });
    const preview = f.store.inbox.sendContext(f.auth.token, sourceId, f.auth.sessionBinding).preview;
    const reserved = f.inbox({ action: "send.reserve", requestId: "send", sourceId, sourceRevision: 1, draftRevision: 1, previewVersion: preview.previewVersion });
    return { sourceId, sendId: reserved.receipt.send.id, reader, preview };
  };
  f.server = async (options = {}) => {
    const server = createRoomServer({ store: f.store, ...options });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const origin = "http://127.0.0.1:" + server.address().port;
    const headers = auth => ({ Cookie: "account_session=" + auth.token, "X-Session-Binding": auth.sessionBinding });
    const post = (path, data, auth = f.auth, extra = {}) => fetch(origin + path, { method: "POST", body: JSON.stringify(data),
      headers: { ...headers(auth), Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": auth.csrf, ...extra } });
    return { server, origin, headers, post, get: (path, auth = f.auth) => fetch(origin + path, { headers: headers(auth) }) };
  };
  return f;
}

test("the config reader reports not configured, invalid and configured states without ever exposing values", () => {
  const missing = telegramConfig({});
  assert.equal(missing.state, "not_configured"); assert.equal(missing.configured, false);
  assert.deepEqual(missing.missing, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"]);
  assert.throws(() => missing.botToken(), /not configured/); assert.throws(() => missing.methodUrl("sendMessage"), /not configured/);
  const half = telegramConfig({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN });
  assert.equal(half.state, "not_configured"); assert.deepEqual(half.missing, ["TELEGRAM_WEBHOOK_SECRET"]);
  const invalid = telegramConfig(env({ TELEGRAM_BOT_TOKEN: "not-a-token", TELEGRAM_WEBHOOK_SECRET: "short" }));
  assert.equal(invalid.state, "invalid"); assert.deepEqual(invalid.invalid, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"]);
  assert.equal(telegramConfig(env({ TELEGRAM_API_BASE: "http://plain.example" })).state, "invalid");
  const ok = telegramConfig(env({ TELEGRAM_BOT_TOKEN: " " + FAKE_TOKEN + "\n" }));
  assert.equal(ok.state, "configured"); assert.equal(ok.botToken(), FAKE_TOKEN); assert.equal(ok.webhookSecret(), FAKE_SECRET);
  assert.equal(ok.webhookSecretHash(), hashWebhookSecret(FAKE_SECRET)); assert.match(ok.webhookSecretHash(), /^[a-f0-9]{64}$/);
  assert.equal(ok.methodUrl("sendMessage"), "https://api.telegram.org/bot" + FAKE_TOKEN + "/sendMessage");
  assert.equal(ok.methodPath("sendMessage"), "/bot<redacted>/sendMessage");
  for (const config of [ok, invalid, missing]) {
    const serialized = JSON.stringify(config);
    assert.equal(serialized.includes(FAKE_TOKEN), false); assert.equal(serialized.includes(FAKE_SECRET), false); assert.equal(serialized.includes("hash"), false);
  }
  assert.equal(redactTelegram("POST https://api.telegram.org/bot" + FAKE_TOKEN + "/sendMessage failed"), "POST https://api.telegram.org/bot<redacted>/sendMessage failed");
  const status = new TelegramLiveStatus(); status.received("acct", "tg", { at: 1_700_000_000_000, count: 2 }); status.sent("acct", "tg", { at: 1_700_000_001_000, outcome: "accepted" });
  const record = { accountId: "acct", id: "tg", channel: "telegram" };
  const view = telegramLiveView({ config: ok, connection: { webhook: { secretHash: ok.webhookSecretHash(), updatedAt: 1_699_999_999_000 } }, record, status, importAvailable: true });
  assert.deepEqual(view, { contractVersion: 1, channel: "telegram", state: "configured", bindings: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_API_BASE"], missing: [], invalid: [],
    webhook: "matches", webhookSetAt: "2023-11-14T22:13:19.000Z", lastUpdateReceivedAt: "2023-11-14T22:13:20.000Z", receivedUpdates: 2,
    lastSendResult: { at: "2023-11-14T22:13:21.000Z", outcome: "accepted", code: null }, importAvailable: true,
    rotation: { contractVersion: 1, state: "none", windowExpiresAt: null } });
  assert.equal(telegramLiveView({ config: ok, connection: { webhook: { secretHash: "0".repeat(64), updatedAt: 1 } }, record }).webhook, "differs");
  assert.equal(telegramLiveView({ config: missing, connection: { webhook: { secretHash: "0".repeat(64), updatedAt: 1 } }, record }).webhook, "set");
  assert.equal(telegramLiveView({ config: missing, connection: {}, record }).webhook, "unset");
  assert.equal(telegramLiveView({ config: ok, connection: {}, record: { ...record, channel: "email" } }), null);
});

test("the setWebhook script builds the webhook URL, redacts dry runs, and registers or deletes through an injected fetch", async () => {
  assert.equal(webhookUrl("https://room.example.test", "telegram-main"), "https://room.example.test/api/inbox/webhooks/telegram-main");
  assert.equal(webhookUrl("https://room.example.test/api/inbox/webhooks/telegram-main"), "https://room.example.test/api/inbox/webhooks/telegram-main");
  assert.throws(() => webhookUrl("http://room.example.test", "telegram-main"), /https/);
  assert.throws(() => webhookUrl("https://room.example.test"), /--connection/);
  assert.throws(() => webhookUrl("https://room.example.test/other/path"), /webhook URL/);
  assert.throws(() => webhookUrl("https://room.example.test/api/inbox/webhooks/a", "b"), /webhook URL/);
  assert.throws(() => setWebhookPlan({ config: telegramConfig({}), publicUrl: "https://room.example.test", connectionId: "tg" }), /not configured/);
  const calls = [], fetchStub = async (url, init) => { calls.push({ url, init }); return jsonResponse(200, { ok: true, result: true, description: "Webhook was set" }); };
  let out = sink(), err = sink();
  let code = await runSetWebhook(["https://room.example.test", "--connection", "telegram-main", "--dry-run"], { env: env(), fetch: fetchStub, stdout: out, stderr: err });
  assert.equal(code, 0); assert.equal(calls.length, 0, "dry run sends nothing");
  const printed = JSON.parse(out.text);
  assert.equal(printed.dryRun, true); assert.equal(printed.url, "https://api.telegram.org/bot<redacted>/setWebhook");
  assert.equal(printed.body.secret_token, "<redacted>"); assert.deepEqual(printed.body.allowed_updates, ["message", "edited_message", "channel_post"]);
  assert.equal(out.text.includes(FAKE_TOKEN), false); assert.equal(out.text.includes(FAKE_SECRET), false);
  out = sink(); code = await runSetWebhook(["https://room.example.test", "--connection", "telegram-main"], { env: env(), fetch: fetchStub, stdout: out, stderr: err });
  assert.equal(code, 0); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/bot" + FAKE_TOKEN + "/setWebhook"); assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.url, "https://room.example.test/api/inbox/webhooks/telegram-main"); assert.equal(body.secret_token, FAKE_SECRET); assert.equal(body.drop_pending_updates, false);
  assert.deepEqual(JSON.parse(out.text), { method: "setWebhook", webhookUrl: "https://room.example.test/api/inbox/webhooks/telegram-main", ok: true, status: 200, description: "Webhook was set", result: true });
  out = sink(); code = await runSetWebhook(["--delete", "--drop-pending"], { env: env(), fetch: fetchStub, stdout: out, stderr: err });
  assert.equal(code, 0); assert.equal(calls[1].url, "https://api.telegram.org/bot" + FAKE_TOKEN + "/deleteWebhook"); assert.deepEqual(JSON.parse(calls[1].init.body), { drop_pending_updates: true });
  err = sink(); assert.equal(await runSetWebhook(["https://room.example.test", "--connection", "x"], { env: {}, fetch: fetchStub, stdout: sink(), stderr: err }), 2);
  assert.match(err.text, /not configured: set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET/);
  assert.equal(await runSetWebhook([], { env: env(), fetch: fetchStub, stdout: sink(), stderr: sink() }), 2);
  assert.equal(await runSetWebhook(["http://room.example.test", "--connection", "x"], { env: env(), fetch: fetchStub, stdout: sink(), stderr: sink() }), 2);
  assert.equal(await runSetWebhook(["https://room.example.test", "--connection", "x", "--bogus"], { env: env(), fetch: fetchStub, stdout: sink(), stderr: sink() }), 2);
  const refused = async () => jsonResponse(401, { ok: false, error_code: 401, description: "Unauthorized " + FAKE_TOKEN });
  out = sink(); assert.equal(await runSetWebhook(["https://room.example.test", "--connection", "x"], { env: env(), fetch: refused, stdout: out, stderr: sink() }), 1);
  assert.equal(JSON.parse(out.text).ok, false); assert.equal(out.text.includes(FAKE_TOKEN), false);
  const failing = async () => { throw new Error("connect ECONNREFUSED bot" + FAKE_TOKEN); };
  err = sink(); assert.equal(await runSetWebhook(["https://room.example.test", "--connection", "x"], { env: env(), fetch: failing, stdout: sink(), stderr: err }), 1);
  assert.match(err.text, /request failed/); assert.equal(err.text.includes(FAKE_TOKEN), false);
  assert.equal(await runSetWebhook(["--help"], { env: {}, fetch: fetchStub, stdout: sink(), stderr: sink() }), 0);
  assert.equal(calls.length, 2);
});

test("the live transport posts sendMessage once per outbox key, honors retry_after, and maps failures to channel codes", async t => {
  const f = fixture(t), { sourceId, sendId, reader, preview } = await f.queuedReply(), config = telegramConfig(env());
  assert.deepEqual(telegramSendRequest(preview), { method: "sendMessage", body: { chat_id: -1001000000001, text: "Thanks, reading it now.", reply_parameters: { message_id: 42, allow_sending_without_reply: true } } });
  assert.equal(telegramSendRequest({ ...preview, target: { ...preview.target, threadId: "-1001000000001/77" } }).body.message_thread_id, 77);
  assert.throws(() => telegramSendRequest({ ...preview, adapter: "synthetic" }), { code: "telegram_transport_mismatch" });
  assert.throws(() => telegramSendRequest({ ...preview, body: "x".repeat(4097) }), { code: "telegram_transport_mismatch" });
  assert.equal(telegramRetryDelay({ attempt: 0 }), 500); assert.equal(telegramRetryDelay({ attempt: 2 }), 2000); assert.equal(telegramRetryDelay({ attempt: 1, retryAfter: 3 }), 3000); assert.equal(telegramRetryDelay({ attempt: 9, retryAfter: 60 }), 5000);
  assert.equal(telegramSendAdapter({ config: telegramConfig({}), fixture: reader }), reader, "the fixture bot is the default when not configured");
  assert.throws(() => new TelegramTransport({ config: telegramConfig({}), fetch: async () => {} }), TypeError);
  const attempt = async (responder, options = {}) => {
    const calls = [], sleeps = [], status = new TelegramLiveStatus();
    const fetchStub = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return responder(calls.length); };
    const transport = telegramSendAdapter({ config, fixture: reader, fetch: fetchStub, sleep: async ms => { sleeps.push(ms); }, status, accountId: f.auth.account.id, connectionId: f.telegram.connection.id, ...options });
    assert.ok(transport instanceof TelegramTransport);
    return { transport, calls, sleeps, status, driver: new SyntheticInboxTransport(f.store.inbox, transport) };
  };
  // Success: one POST with the token in the URL only; the send becomes accepted with a provider id.
  let run = await attempt(() => jsonResponse(200, { ok: true, result: { message_id: 57, chat: { id: -1001000000001 } } }));
  let send = await run.driver.dispatch(f.auth.token, sourceId, sendId, f.auth.sessionBinding);
  assert.equal(send.status, "accepted"); assert.equal(send.providerId, "telegram:-1001000000001:57");
  assert.equal(run.calls.length, 1); assert.equal(run.calls[0].url, "https://api.telegram.org/bot" + FAKE_TOKEN + "/sendMessage");
  assert.deepEqual(run.calls[0].body, { chat_id: -1001000000001, text: "Thanks, reading it now.", reply_parameters: { message_id: 42, allow_sending_without_reply: true } });
  assert.equal(JSON.stringify(run.calls[0].body).includes(FAKE_TOKEN), false);
  assert.equal(run.status.snapshot(f.auth.account.id, f.telegram.connection.id).lastSendResult.outcome, "accepted");
  // Idempotent retry: the same operation key replays the receipt without another POST, a different preview conflicts.
  const operationId = run.driver.correlation(send);
  assert.deepEqual(await run.transport.submit({ operationId, envelope: preview }), { operationId, previewVersion: preview.previewVersion, outcome: "accepted", providerId: "telegram:-1001000000001:57" });
  assert.equal(run.calls.length, 1);
  await assert.rejects(run.transport.submit({ operationId, envelope: { ...preview, previewVersion: "f".repeat(64) } }), { code: "conflicting_inbox_observation" });
  assert.equal((await run.transport.lookup({ operationId })).outcome, "accepted"); assert.equal(await run.transport.lookup({ operationId: "reply-unknown" }), null);
  assert.equal((await run.driver.reconcile(f.auth.token, sourceId, sendId, f.auth.sessionBinding)).status, "accepted");
  // Concurrent submits of one key share one HTTP attempt.
  run = await attempt(() => jsonResponse(200, { ok: true, result: { message_id: 58 } }));
  const twice = await Promise.all([run.transport.submit({ operationId: "reply-c", envelope: preview }), run.transport.submit({ operationId: "reply-c", envelope: preview })]);
  assert.deepEqual(twice[0], twice[1]); assert.equal(run.calls.length, 1);
  // 429 with retry_after: sleep exactly the hinted seconds (capped), then succeed.
  run = await attempt(n => n === 1 ? jsonResponse(429, { ok: false, error_code: 429, description: "Too Many Requests: retry after 2", parameters: { retry_after: 2 } }) : jsonResponse(200, { ok: true, result: { message_id: 59 } }));
  assert.deepEqual(await run.transport.submit({ operationId: "reply-429", envelope: preview }), { operationId: "reply-429", previewVersion: preview.previewVersion, outcome: "accepted", providerId: "telegram:-1001000000001:59" });
  assert.equal(run.calls.length, 2); assert.deepEqual(run.sleeps, [2000]);
  run = await attempt(() => jsonResponse(429, { ok: false, error_code: 429, parameters: { retry_after: 120 } }));
  await assert.rejects(run.transport.submit({ operationId: "reply-429x", envelope: preview }), error => error.code === "channel_sending_unavailable" && error.status === 503 && error.headers["Retry-After"] === 120);
  assert.equal(run.calls.length, 4); assert.deepEqual(run.sleeps, [5000, 5000, 5000], "hinted waits are capped");
  assert.equal(await run.transport.lookup({ operationId: "reply-429x" }), null, "nothing is recorded for an unfinished attempt");
  // 5xx: exponential backoff, then a bounded failure; the attempt stays unknown, never re-queued or guessed.
  run = await attempt(() => jsonResponse(502, { ok: false, error_code: 502, description: "Bad Gateway" }), { maxAttempts: 3 });
  await assert.rejects(run.transport.submit({ operationId: "reply-5xx", envelope: preview }), { code: "channel_sending_unavailable", status: 503 });
  assert.equal(run.calls.length, 3); assert.deepEqual(run.sleeps, [500, 1000]);
  assert.deepEqual(run.status.snapshot(f.auth.account.id, f.telegram.connection.id).lastSendResult.code, "server_error");
  run = await attempt(n => n < 3 ? jsonResponse(500, { ok: false }) : jsonResponse(200, { ok: true, result: { message_id: 60 } }));
  assert.equal((await run.transport.submit({ operationId: "reply-5xx-ok", envelope: preview })).outcome, "accepted"); assert.equal(run.calls.length, 3);
  // Network failure: retried, then unavailable; the send journal keeps the attempt unknown for reconciliation.
  const second = await (async () => {
    f.inbox({ action: "draft.save", requestId: "draft-2", sourceId: f.sourceId("-1001000000001:41"), sourceRevision: 1, expectedRevision: 0, body: "Second reply" });
    const p = f.store.inbox.sendContext(f.auth.token, f.sourceId("-1001000000001:41"), f.auth.sessionBinding).preview;
    return { sourceId: p.sourceId, sendId: f.inbox({ action: "send.reserve", requestId: "send-2", sourceId: p.sourceId, sourceRevision: 1, draftRevision: 1, previewVersion: p.previewVersion }).receipt.send.id };
  })();
  run = await attempt(() => { throw new TypeError("fetch failed"); }, { maxAttempts: 2 });
  send = await run.driver.dispatch(f.auth.token, second.sourceId, second.sendId, f.auth.sessionBinding);
  assert.equal(send.status, "unknown"); assert.equal(run.calls.length, 2); assert.deepEqual(run.sleeps, [500]);
  assert.equal((await run.driver.reconcile(f.auth.token, second.sourceId, second.sendId, f.auth.sessionBinding)).status, "unknown");
  // Definitive answers: 400/403 reject the attempt; 401 means the token is wrong.
  run = await attempt(() => jsonResponse(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" }));
  const rejected = await run.transport.submit({ operationId: "reply-400", envelope: preview });
  assert.deepEqual(rejected, { operationId: "reply-400", previewVersion: preview.previewVersion, outcome: "rejected", providerId: null, code: "bad_request_chat_not_found" });
  assert.equal(run.calls.length, 1); assert.deepEqual(await run.transport.lookup({ operationId: "reply-400" }), rejected);
  run = await attempt(() => jsonResponse(401, { ok: false, error_code: 401, description: "Unauthorized" }));
  await assert.rejects(run.transport.submit({ operationId: "reply-401", envelope: preview }), { code: "channel_connection_unavailable", status: 409 });
  assert.equal(run.calls.length, 1);
  assert.equal(reader.sent().length, 0, "the fixture bot never saw a live send");
  assert.doesNotThrow(() => f.store.inbox.verify());
});

test("the owner-authenticated import trigger works off loopback, enforces session, CSRF and rate limits, and reports live status", async t => {
  const f = fixture(t); f.configure(f.telegram.connection);
  const webhooks = new ChannelWebhookInbox(f.store);
  // A hosted deployment: remote visitors, live bindings set, webhook inbox present.
  const hosted = await f.server({ channelWebhooks: webhooks, resolveClientAddress: () => "203.0.113.5", telegram: telegramConfig(env()) });
  const path = "/api/inbox/connections/" + f.telegram.connection.id, trigger = path + "/reconnect";
  let response = await hosted.get(path); let value = await response.json();
  assert.equal(response.status, 200); assert.equal(value.syncAvailable, false); assert.equal(value.webhook, false); assert.equal(value.webhookSetAt, null);
  assert.deepEqual(value.live, { contractVersion: 1, channel: "telegram", state: "configured", bindings: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_API_BASE"], missing: [], invalid: [],
    webhook: "unset", webhookSetAt: null, lastUpdateReceivedAt: null, receivedUpdates: 0, lastSendResult: null, importAvailable: true,
    rotation: { contractVersion: 1, state: "none", windowExpiresAt: null } });
  // Authority: no session 401, bearer 401, another account's session 404, missing CSRF 403, wrong origin 403.
  response = await fetch(hosted.origin + trigger, { method: "POST", body: JSON.stringify({ requestId: "t-1" }), headers: { "Content-Type": "application/json", Origin: hosted.origin, "X-Session-Binding": f.auth.sessionBinding } });
  assert.equal(response.status, 401);
  response = await fetch(hosted.origin + trigger, { method: "POST", body: JSON.stringify({ requestId: "t-1" }), headers: { "Content-Type": "application/json", Origin: hosted.origin, Authorization: "Bearer " + f.keys.owner, "X-Session-Binding": f.auth.sessionBinding } });
  assert.equal(response.status, 401); assert.equal((await response.json()).error.code, "account_session_required");
  response = await hosted.post(trigger, { requestId: "t-1" }, f.sessions.guest); assert.equal(response.status, 404); assert.equal((await response.json()).error.code, "channel_connection_not_found");
  response = await hosted.post(trigger, { requestId: "t-1" }, f.auth, { "X-CSRF-Token": "" }); assert.equal(response.status, 403); assert.equal((await response.json()).error.code, "csrf_denied");
  response = await hosted.post(trigger, { requestId: "t-1" }, f.auth, { Origin: "https://evil.example" }); assert.equal(response.status, 403); assert.equal((await response.json()).error.code, "origin_denied");
  response = await hosted.post(trigger, { requestId: "t-1", extra: true }); assert.equal(response.status, 422);
  response = await hosted.post(trigger, { requestId: "not valid!" }); assert.equal(response.status, 422);
  response = await hosted.post("/api/inbox/connections/missing/reconnect", { requestId: "t-1" }); assert.equal(response.status, 404);
  assert.equal(f.store.connections.connection(f.auth.account.id, f.telegram.connection.id).webhook, undefined);
  // Owner: the first trigger registers the binding's secret hash and drains nothing yet.
  response = await hosted.post(trigger, { requestId: "t-1" }); value = await response.json();
  assert.equal(response.status, 201, JSON.stringify(value)); assert.equal(value.registered, true); assert.equal(value.imported, 0); assert.equal(value.source, "webhook");
  assert.equal(value.live.webhook, "matches"); assert.equal(value.webhook, true); assert.match(value.webhookSetAt, /^\d{4}-/);
  assert.equal(f.store.connections.connection(f.auth.account.id, f.telegram.connection.id).webhook.secretHash, hashWebhookSecret(FAKE_SECRET));
  assert.equal(JSON.stringify(value).includes(hashWebhookSecret(FAKE_SECRET)), false); assert.equal(JSON.stringify(value).includes(FAKE_SECRET), false); assert.equal(JSON.stringify(value).includes(FAKE_TOKEN), false);
  // Telegram delivers with the binding's secret; the card sees the delivery and the owner imports it from anywhere.
  response = await fetch(hosted.origin + "/api/inbox/webhooks/" + f.telegram.connection.id, { method: "POST", body: JSON.stringify({ updates: f.telegram.updates.slice(0, 2) }),
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": FAKE_SECRET } });
  assert.equal(response.status, 202);
  response = await hosted.get(path); value = await response.json();
  assert.match(value.live.lastUpdateReceivedAt, /^\d{4}-/); assert.equal(value.live.receivedUpdates, 2);
  response = await hosted.post(trigger, { requestId: "t-2" }); value = await response.json();
  assert.equal(response.status, 201, JSON.stringify(value)); assert.equal(value.registered, false); assert.equal(value.imported, 2); assert.equal(value.receipt.imports.length, 2);
  assert.equal(f.store.inbox.list(f.auth.token, f.auth.sessionBinding, { includeChannels: true }).sources.length, 2);
  response = await hosted.post(trigger, { requestId: "t-2" }); value = await response.json();
  assert.equal(response.status, 200); assert.equal(value.duplicate, true); assert.equal(value.source, "journal");
  // The loopback-only recorded sync stays refused remotely; the trigger is the hosted path.
  response = await hosted.post(path + "/sync", { requestId: "s-1", updates: null }); assert.equal(response.status, 403); assert.equal((await response.json()).error.code, "channel_sync_local_only");
  // Rate limit: per account, 30 per minute.
  let limited = null;
  for (let i = 0; i < 30 && !limited; i++) { const r = await hosted.post(trigger, { requestId: "burst-" + i }); if (r.status === 429) limited = r; }
  assert.ok(limited, "the burst hits the limit"); assert.equal((await limited.json()).error.code, "rate_limited");
  assert.equal((await hosted.get(path)).status, 200, "reads are not affected");
  // Not configured, no webhook inbox: the card says so and the trigger has nothing to do.
  const bare = await f.server({ resolveClientAddress: () => "203.0.113.9" });
  response = await bare.get(path); value = await response.json();
  assert.equal(value.live.state, "not_configured"); assert.deepEqual(value.live.missing, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"]); assert.equal(value.live.webhook, "set"); assert.equal(value.live.importAvailable, false);
  response = await bare.post(trigger, { requestId: "bare-1" }); assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "channel_webhook_unavailable");
  // Not configured but a webhook inbox exists (local fixture flow): the trigger drains without registering.
  const local = await f.server({ channelWebhooks: webhooks });
  response = await local.post(trigger, { requestId: "local-1" }); value = await response.json();
  assert.equal(response.status, 201, JSON.stringify(value)); assert.equal(value.registered, false); assert.equal(value.imported, 0); assert.equal(value.live.state, "not_configured");
  assert.throws(() => createRoomServer({ store: f.store, telegram: { token: FAKE_TOKEN } }), /telegramConfig/);
  // Email connections carry no live block and cannot be triggered.
  const { emailContractFixture } = await import("../scripts/email-contract-fixture.mjs");
  const email = emailContractFixture(); email.connection.accountId = f.auth.account.id; f.configure(email.connection);
  response = await local.get("/api/inbox/connections/" + email.connection.id); assert.equal((await response.json()).live, null);
  response = await local.post("/api/inbox/connections/" + email.connection.id + "/reconnect", { requestId: "e-1" }); assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "channel_sync_unsupported");
  // A disconnected connection is never re-registered.
  f.apply({ action: "connection.disconnect", requestId: "off", connectionId: f.telegram.connection.id, expectedRevision: 1 });
  response = await hosted.get(path); assert.equal((await response.json()).connection.state, "disconnected");
});
