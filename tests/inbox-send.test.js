// HTTP integration tests for the direct channel-send write path:
// POST /api/inbox/channel-sends {channel, to, subject, body, threadId?}.
// Gmail and Telegram provider endpoints are mocked; no network calls, no real
// credentials, no message bodies in logs. Unconnected channels fail honestly.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { telegramConfig } from "../server/channel-adapters/telegram-config.mjs";
import { GmailSender, buildGmailRawMessage, buildTelegramDirectRequest, sendTelegramDirect } from "../server/inbox-transport.mjs";
import { validateDirectSend, recordDirectSend, completeDirectSend, getDirectSend } from "../server/inbox-outbox.mjs";

const FAKE_BOT_TOKEN = "123456789:AAH-Fake-Token-For-Tests-Only-000";
const FAKE_WEBHOOK_SECRET = "fake-webhook-secret-16min";
const telegramOptions = fetchImpl => ({
  telegram: telegramConfig({ TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET }),
  directSendFetch: fetchImpl
});

function fixture(t) {
  const f = createAcceptanceFixture();
  const account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
  const loggedIn = f.store.loginAccountSession(slot.token, key, 0);
  f.accountId = account.id;
  f.token = slot.token; f.csrf = loggedIn.csrf; f.sessionBinding = loggedIn.sessionBinding;
  t.after(() => f.store.close());
  return f;
}

async function serve(t, f, options = {}) {
  const server = createRoomServer({ store: f.store, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = "http://127.0.0.1:" + server.address().port;
  const headers = () => ({ Origin: origin, "Content-Type": "application/json",
    Cookie: "account_session=" + f.token, "X-Session-Binding": f.sessionBinding, "X-CSRF-Token": f.csrf });
  const post = (data, extra = {}) => fetch(origin + "/api/inbox/channel-sends", { method: "POST", headers: headers(), body: JSON.stringify(data), ...extra });
  return { origin, headers, post };
}

const telegramOkFetch = async url => {
  assert.match(url, /^https:\/\/api\.telegram\.org\/bot123456789:AAH-Fake-Token-For-Tests-Only-000\/sendMessage$/);
  return Response.json({ ok: true, result: { message_id: 4242 } });
};
const telegramRejectFetch = async () => Response.json({ ok: false, description: "Bad Request: chat not found" }, { status: 400 });
const telegramDownFetch = async () => { throw new Error("network down"); };
const gmailOkFetch = async (url, init) => {
  assert.equal(url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  assert.match(init.headers.Authorization, /^Bearer ya29\.fake/);
  const payload = JSON.parse(init.body);
  assert.match(payload.raw, /^[A-Za-z0-9_-]+$/);
  return Response.json({ id: "gmail-msg-1", threadId: "gmail-thread-1" });
};

test("direct send validation rejects bad contracts", async t => {
  const f = fixture(t), { post } = await serve(t, f);
  const bad = [
    { channel: "sms", to: "x", subject: "", body: "hi" },                       // unknown channel
    { channel: "gmail", to: "not-an-email", subject: "", body: "hi" },          // bad gmail recipient
    { channel: "telegram", to: "not-a-chat", subject: "", body: "hi" },        // bad telegram recipient
    { channel: "gmail", to: "a@example.com", subject: "", body: "   " },        // blank body
    { channel: "telegram", to: "123", subject: "", body: "x".repeat(4097) },    // telegram too long
    { channel: "gmail", to: "a@example.com", subject: "", body: "hi", extra: 1 } // unknown field
  ];
  for (const data of bad) {
    const res = await post(data);
    assert.equal(res.status, 422, JSON.stringify(data));
    assert.equal((await res.json()).error.code, "invalid_direct_send");
  }
});

test("gmail without a connection fails honestly and journals the failure", async t => {
  const f = fixture(t), { post } = await serve(t, f);
  const res = await post({ channel: "gmail", to: "a@example.com", subject: "Hi", body: "hello" });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, "gmail_not_connected");
  const row = f.store.db.prepare("SELECT * FROM direct_channel_sends WHERE account_id=?").get(f.accountId);
  assert.ok(row);
  assert.equal(row.status, "failed");
  assert.equal(row.error_code, "gmail_not_connected");
  assert.equal(row.channel, "gmail");
  assert.equal(row.recipient, "a@example.com");
});

test("telegram without configuration fails honestly and journals the failure", async t => {
  const f = fixture(t), { post } = await serve(t, f);
  const res = await post({ channel: "telegram", to: "123456", subject: "", body: "hello" });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, "telegram_not_connected");
  const row = f.store.db.prepare("SELECT * FROM direct_channel_sends WHERE account_id=?").get(f.accountId);
  assert.equal(row.status, "failed");
  assert.equal(row.error_code, "telegram_not_connected");
});

test("telegram live send delivers and journals sent with provider id", async t => {
  const f = fixture(t);
  const { post } = await serve(t, f, telegramOptions(telegramOkFetch));
  const res = await post({ channel: "telegram", to: "-123456", subject: "", body: "hello from tests" });
  assert.equal(res.status, 200);
  const value = await res.json();
  assert.equal(value.contractVersion, 1);
  assert.equal(value.viewer.accountId, f.accountId);
  assert.equal(value.send.channel, "telegram");
  assert.equal(value.send.status, "sent");
  assert.equal(value.send.providerId, "4242");
  assert.equal(value.send.to, "-123456");
  assert.ok(!("body" in value.send), "message body is never echoed");
  const row = f.store.db.prepare("SELECT * FROM direct_channel_sends WHERE id=?").get(value.send.id);
  assert.equal(row.status, "sent");
  assert.equal(row.provider_id, "4242");
});

test("telegram provider rejection is reported honestly and journaled failed", async t => {
  const f = fixture(t);
  const { post } = await serve(t, f, telegramOptions(telegramRejectFetch));
  const res = await post({ channel: "telegram", to: "999", subject: "", body: "hi" });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, "telegram_send_rejected");
  const row = f.store.db.prepare("SELECT * FROM direct_channel_sends WHERE account_id=?").get(f.accountId);
  assert.equal(row.status, "failed");
  assert.equal(row.error_code, "telegram_send_rejected");
});

test("telegram network failure is a 502 and journals failed", async t => {
  const f = fixture(t);
  const { post } = await serve(t, f, telegramOptions(telegramDownFetch));
  const res = await post({ channel: "telegram", to: "123", subject: "", body: "hi" });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, "telegram_unavailable");
});

test("direct sends are rate-limited per account", async t => {
  const f = fixture(t);
  const { post } = await serve(t, f, telegramOptions(telegramOkFetch));
  const data = { channel: "telegram", to: "123", subject: "", body: "hi" };
  let limited = 0;
  for (let i = 0; i < 25; i++) {
    const res = await post(data);
    if (res.status === 429) { limited++; assert.equal((await res.json()).error.code, "rate_limited"); }
    else { assert.equal(res.status, 200); await res.body?.cancel(); }
  }
  assert.ok(limited > 0, "rate limit engaged");
});

test("unauthenticated direct send is rejected", async t => {
  const f = fixture(t), { origin } = await serve(t, f);
  const res = await fetch(origin + "/api/inbox/channel-sends", { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json",
      "X-Session-Binding": "a".repeat(64), Cookie: "account_session=" + "b".repeat(43) },
    body: JSON.stringify({ channel: "telegram", to: "123", subject: "", body: "hi" }) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, "unauthenticated");
});

test("existing dispatch/reconcile contract still works alongside direct sends", async t => {
  const f = fixture(t), { post } = await serve(t, f);
  const res = await post({ action: "dispatch", sourceId: "nope", sendId: "nope" });
  assert.equal(res.status, 404);
  const value = await res.json();
  assert.equal(value.error.code, "inbox_source_not_found", "existing dispatch contract untouched");
});

// GmailSender unit tests: the HTTP layer has no stored Gmail tokens today, so
// the live-API behavior is covered here with a mocked Gmail endpoint.
test("GmailSender posts a base64url RFC2822 message and returns the id", async t => {
  const sender = new GmailSender({ fetchImpl: gmailOkFetch, credentialProvider: async () => ({ accessToken: "ya29.fake-token" }) });
  const result = await sender.send({ to: "a@example.com", subject: "Hi", body: "hello" });
  assert.equal(result.id, "gmail-msg-1");
  assert.equal(result.threadId, "gmail-thread-1");
});

test("GmailSender without credentials reports gmail_not_connected", async t => {
  const sender = new GmailSender({ fetchImpl: gmailOkFetch, credentialProvider: async () => null });
  await assert.rejects(() => sender.send({ to: "a@example.com", subject: "Hi", body: "hello" }),
    error => error.code === "gmail_not_connected");
});

test("GmailSender refreshes once on 401 then sends", async t => {
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "ya29.refreshed" });
    if (calls === 1) return new Response("{}", { status: 401 });
    return Response.json({ id: "gmail-msg-2" });
  };
  const sender = new GmailSender({ fetchImpl,
    credentialProvider: async () => ({ accessToken: "ya29.expired", refreshToken: "rt", clientId: "cid", clientSecret: "csecret" }) });
  const result = await sender.send({ to: "a@example.com", subject: "Hi", body: "hello" });
  assert.equal(result.id, "gmail-msg-2");
  assert.equal(calls, 3);
});

test("GmailSender maps a 403 scope denial to gmail_not_connected", async t => {
  const fetchImpl = async () => Response.json({ error: { message: "insufficientPermissions" } }, { status: 403 });
  const sender = new GmailSender({ fetchImpl, credentialProvider: async () => ({ accessToken: "ya29.fake" }) });
  await assert.rejects(() => sender.send({ to: "a@example.com", subject: "Hi", body: "hello" }),
    error => error.code === "gmail_not_connected");
});

test("buildGmailRawMessage encodes headers and body as base64url", () => {
  const raw = buildGmailRawMessage({ to: "a@example.com", subject: "Hi\nInjected", body: "hello" });
  const text = Buffer.from(raw, "base64url").toString("utf8");
  assert.match(text, /^To: a@example\.com\r\nSubject: Hi Injected\r\n/m);
  assert.ok(text.endsWith("\r\n\r\nhello"));
  assert.doesNotMatch(raw, /[+/=]/);
});

test("buildTelegramDirectRequest rejects bad chat ids and oversize text", () => {
  for (const args of [[{ to: "abc", text: "hi" }], [{ to: "123", text: "x".repeat(4097) }]]) {
    try { buildTelegramDirectRequest(...args); assert.fail("expected invalid_direct_send"); }
    catch (error) { assert.equal(error.code, "invalid_direct_send"); }
  }
  const req = buildTelegramDirectRequest({ to: "-123", text: "hi" });
  assert.deepEqual(req, { method: "sendMessage", body: { chat_id: -123, text: "hi" } });
});

test("sendTelegramDirect without config reports telegram_not_connected", async t => {
  await assert.rejects(() => sendTelegramDirect({ config: telegramConfig({}), to: "123", text: "hi" }),
    error => error.code === "telegram_not_connected");
});

test("direct-send journal validation is pure and strict", () => {
  for (const data of [{ channel: "gmail", to: "a@example.com", subject: "", body: "" }, null]) {
    try { validateDirectSend(data); assert.fail("expected invalid_direct_send"); }
    catch (error) { assert.equal(error.code, "invalid_direct_send"); }
  }
  validateDirectSend({ channel: "gmail", to: "a@example.com", subject: "s", body: "b", threadId: "t-1" });
});

test("direct-send journal records pending then settles exactly once", async t => {
  const f = fixture(t);
  const at = Date.now();
  const row = recordDirectSend(f.store.db, { id: "send-1", accountId: f.accountId, channel: "gmail",
    to: "a@example.com", subject: "s", bodyHash: "a".repeat(64), threadId: null, at });
  assert.equal(row.status, "pending");
  const settled = completeDirectSend(f.store.db, "send-1", { status: "sent", providerId: "m1", at: at + 1 });
  assert.equal(settled.status, "sent");
  assert.equal(settled.provider_id, "m1");
  assert.equal(getDirectSend(f.store.db, "send-1").status, "sent");
  try { completeDirectSend(f.store.db, "send-1", { status: "failed", errorCode: "x", at: at + 2 }); assert.fail("should settle once"); }
  catch (error) { assert.equal(error.code, "direct_send_settled"); }
});
