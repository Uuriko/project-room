// HTTP integration tests for the direct channel-send write path:
// POST /api/inbox/channel-sends {channel, to, subject, body, threadId?}.
// Gmail and Telegram provider endpoints are mocked; no network calls, no real
// credentials, no message bodies in logs. Unconnected channels fail honestly.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { telegramConfig } from "../server/channel-adapters/telegram-config.mjs";
import { GmailSender, buildGmailRawMessage, buildTelegramDirectRequest, sendTelegramDirect } from "../server/inbox-transport.mjs";
import { validateDirectSend, recordDirectSend, completeDirectSend, getDirectSend, markDirectSendDispatch, ensureDirectSendTable } from "../server/inbox-outbox.mjs";

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
  assert.deepEqual(req, { method: "sendMessage", body: { chat_id: "-123", text: "hi" } });
});

test("buildTelegramDirectRequest rejects ids above 2^53 and keeps leading zeros (M-25)", () => {
  // Number("9007199254740993") silently corrupts to 9007199254740992; the
  // BigInt round-trip must refuse the id instead of sending the wrong chat.
  assert.throws(() => buildTelegramDirectRequest({ to: "9007199254740993", text: "hi" }),
    error => error.code === "invalid_direct_send");
  // 2^53 itself is exactly representable and stays valid.
  const maxSafe = buildTelegramDirectRequest({ to: "9007199254740991", text: "hi" });
  assert.equal(maxSafe.body.chat_id, "9007199254740991");
  // Leading zeros survive as the digit string (Number() would strip them).
  const padded = buildTelegramDirectRequest({ to: "00123", text: "hi" });
  assert.equal(padded.body.chat_id, "00123");
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

test("requestId makes an uncertain retry replay the journaled send without a second provider delivery", async t => {
  // ch-2039 challenge follow-up: before the fix, two identical direct-send
  // POSTs (e.g. a retry after a dropped response) delivered twice — the
  // journal had no idempotency key and each request minted a fresh send id.
  const f = fixture(t);
  let providerCalls = 0;
  const { post } = await serve(t, f, telegramOptions(async () => {
    providerCalls++;
    return Response.json({ ok: true, result: { message_id: 4242 } });
  }));
  const data = { channel: "telegram", to: "123456", subject: "", body: "retry me", requestId: randomUUID() };
  const first = await post(data);
  assert.equal(first.status, 200);
  const firstSend = (await first.json()).send;
  assert.equal(firstSend.status, "sent");
  // Uncertain retry: the first response was lost, so the caller replays the
  // same request — same requestId, same content.
  const second = await post(data);
  assert.equal(second.status, 200);
  const secondSend = (await second.json()).send;
  assert.equal(secondSend.id, firstSend.id, "retry replays the original send, not a new one");
  assert.equal(providerCalls, 1, "provider must be hit once");
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM direct_channel_sends WHERE account_id=? AND status='sent'").get(f.accountId).n, 1);
});

test("same requestId with different content is a 409, never a second send", async t => {
  const f = fixture(t);
  let providerCalls = 0;
  const { post } = await serve(t, f, telegramOptions(async () => {
    providerCalls++;
    return Response.json({ ok: true, result: { message_id: 4242 } });
  }));
  const requestId = randomUUID();
  const first = await post({ channel: "telegram", to: "123456", subject: "", body: "original", requestId });
  assert.equal(first.status, 200);
  const clash = await post({ channel: "telegram", to: "123456", subject: "", body: "different body", requestId });
  assert.equal(clash.status, 409);
  assert.equal((await clash.json()).error.code, "direct_send_idempotency_conflict");
  assert.equal(providerCalls, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM direct_channel_sends WHERE account_id=?").get(f.accountId).n, 1);
});

test("concurrent same-requestId direct sends collapse to one provider delivery", async t => {
  const f = fixture(t);
  let providerCalls = 0;
  const { post } = await serve(t, f, telegramOptions(async () => {
    providerCalls++;
    await new Promise(resolve => setTimeout(resolve, 30)); // widen the race window
    return Response.json({ ok: true, result: { message_id: 4242 } });
  }));
  const data = { channel: "telegram", to: "123456", subject: "", body: "double click", requestId: randomUUID() };
  const [r1, r2] = await Promise.all([post(data), post(data)]);
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  assert.equal((await r1.json()).send.id, (await r2.json()).send.id, "both callers see the same send");
  assert.equal(providerCalls, 1, "provider must be hit once");
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM direct_channel_sends WHERE account_id=? AND status='sent'").get(f.accountId).n, 1);
});

test("a journaled failure replays on retry instead of re-sending", async t => {
  const f = fixture(t);
  let providerCalls = 0;
  const { post } = await serve(t, f, telegramOptions(async () => { providerCalls++; throw new Error("network down"); }));
  const data = { channel: "telegram", to: "123456", subject: "", body: "try again", requestId: randomUUID() };
  const first = await post(data);
  assert.equal(first.status, 502);
  // The failure is terminal for its key: the retry replays the journaled
  // failure receipt instead of delivering again on uncertainty.
  const second = await post(data);
  assert.equal(second.status, 200);
  const replayed = (await second.json()).send;
  assert.equal(replayed.status, "failed");
  assert.equal(replayed.id, f.store.db.prepare("SELECT id FROM direct_channel_sends WHERE account_id=?").get(f.accountId).id);
  assert.equal(providerCalls, 1);
});

test("sends without a requestId keep one-row-per-request behavior", async t => {
  // The idempotency key is opt-in: keyless callers get no dedupe, as before.
  const f = fixture(t);
  let providerCalls = 0;
  const { post } = await serve(t, f, telegramOptions(async () => {
    providerCalls++;
    return Response.json({ ok: true, result: { message_id: 4242 } });
  }));
  const data = { channel: "telegram", to: "123456", subject: "", body: "no key" };
  assert.equal((await post(data)).status, 200);
  assert.equal((await post(data)).status, 200);
  assert.equal(providerCalls, 2);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM direct_channel_sends WHERE account_id=? AND status='sent'").get(f.accountId).n, 2);
});

test("an invalid requestId is rejected before anything is journaled", async t => {
  const f = fixture(t);
  const { post } = await serve(t, f, telegramOptions(telegramOkFetch));
  const res = await post({ channel: "telegram", to: "123456", subject: "", body: "bad key", requestId: "../evil" });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, "invalid_direct_send");
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM direct_channel_sends WHERE account_id=?").get(f.accountId).n, 0);
});

// Crash-recovery for direct sends (buildqa 2026-10-09 follow-up): a retry
// with the same requestId must resume a send that was journaled but never
// dispatched (crash between recordDirectSend and the provider call) instead
// of returning the stuck "pending" row forever. A send whose dispatch
// already started has an unknown outcome and is never re-driven blindly
// (no double delivery).

test("markDirectSendDispatch claims the dispatch exactly once", async t => {
  const f = fixture(t);
  const at = Date.now();
  const row = recordDirectSend(f.store.db, { id: randomUUID(), accountId: f.accountId, channel: "telegram",
    to: "123456", subject: "", bodyHash: createHash("sha256").update("claim", "utf8").digest("hex"),
    threadId: null, requestId: randomUUID(), at });
  assert.equal(row.dispatch_started_at, null, "a fresh journal entry has no dispatch marker");
  assert.equal(markDirectSendDispatch(f.store.db, row.id, at + 1), 1, "first claim wins");
  assert.equal(markDirectSendDispatch(f.store.db, row.id, at + 2), 0, "second claim loses, marker untouched");
  assert.equal(getDirectSend(f.store.db, row.id).dispatch_started_at, at + 1);
  assert.equal(markDirectSendDispatch(f.store.db, "no-such-send", at + 3), 0, "unknown send claims nothing");
});

test("ensureDirectSendTable backfills dispatch_started_at on a legacy table", async t => {
  // Warm-wake convergence: a room whose table predates this change must gain
  // the column without losing rows (the priced-tool-500 class of bug).
  const f = fixture(t);
  f.store.db.exec("DROP TABLE IF EXISTS direct_channel_sends");
  f.store.db.exec(`CREATE TABLE direct_channel_sends (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, channel TEXT NOT NULL,
    recipient TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '',
    body_hash TEXT NOT NULL, thread_id TEXT,
    status TEXT NOT NULL, provider_id TEXT, error_code TEXT,
    request_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  const id = randomUUID();
  f.store.db.prepare(`INSERT INTO direct_channel_sends
    (id, account_id, channel, recipient, subject, body_hash, thread_id, status, provider_id, error_code, request_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, f.accountId, "telegram", "1", "", "a".repeat(64),
    null, "sent", "4242", null, null, 1000, 2000);
  ensureDirectSendTable(f.store.db);
  const cols = new Set(f.store.db.prepare("PRAGMA table_info(direct_channel_sends)").all().map(c => c.name));
  assert.ok(cols.has("dispatch_started_at"), "migration adds the column to legacy tables");
  const row = getDirectSend(f.store.db, id);
  assert.equal(row.status, "sent", "existing rows survive the migration");
  assert.equal(row.dispatch_started_at, null, "a settled legacy row needs no marker");
  // Idempotent: a second run changes nothing.
  ensureDirectSendTable(f.store.db);
  assert.equal(getDirectSend(f.store.db, id).status, "sent");
});

test("a retry resumes a send that was journaled but never dispatched", async t => {
  // The crashed state: recordDirectSend ran, the process died before the
  // provider call, so no dispatch marker exists. The retry must drive the
  // delivery instead of returning the stuck pending row forever.
  const f = fixture(t);
  let providerCalls = 0;
  const { post } = await serve(t, f, telegramOptions(async () => {
    providerCalls++;
    return Response.json({ ok: true, result: { message_id: 4242 } });
  }));
  const requestId = randomUUID();
  const body = "resume me";
  const sendId = randomUUID();
  recordDirectSend(f.store.db, { id: sendId, accountId: f.accountId, channel: "telegram",
    to: "123456", subject: "", bodyHash: createHash("sha256").update(body, "utf8").digest("hex"),
    threadId: null, requestId, at: Date.now() });
  const retry = await post({ channel: "telegram", to: "123456", subject: "", body, requestId });
  assert.equal(retry.status, 200);
  const send = (await retry.json()).send;
  assert.equal(send.id, sendId, "resume drives the original journaled send");
  assert.equal(send.status, "sent");
  assert.equal(send.providerId, "4242");
  assert.equal(providerCalls, 1, "the resumed send delivers exactly once");
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM direct_channel_sends WHERE account_id=?").get(f.accountId).n, 1);
});

test("a retry never re-drives a send whose dispatch already started", async t => {
  // Crash after the provider call began: the outcome is unknown. The retry
  // must return the pending row as-is — re-driving could double-deliver.
  const f = fixture(t);
  let providerCalls = 0;
  const { post } = await serve(t, f, telegramOptions(async () => {
    providerCalls++;
    return Response.json({ ok: true, result: { message_id: 4242 } });
  }));
  const requestId = randomUUID();
  const body = "unknown outcome";
  const sendId = randomUUID();
  const at = Date.now();
  recordDirectSend(f.store.db, { id: sendId, accountId: f.accountId, channel: "telegram",
    to: "123456", subject: "", bodyHash: createHash("sha256").update(body, "utf8").digest("hex"),
    threadId: null, requestId, at });
  assert.equal(markDirectSendDispatch(f.store.db, sendId, at), 1, "dispatch had started before the crash");
  const retry = await post({ channel: "telegram", to: "123456", subject: "", body, requestId });
  assert.equal(retry.status, 200);
  const send = (await retry.json()).send;
  assert.equal(send.id, sendId);
  assert.equal(send.status, "pending", "outcome-unknown stays pending, never silently resolved");
  assert.equal(providerCalls, 0, "outcome-unknown sends are never re-driven");
});

test("a pending row that predates the dispatch marker is replayed, never re-driven", async t => {
  // Old code left no marker, so a pending legacy row may already have reached
  // the provider. The migration marks it started; a same-key retry replays the
  // pending row and the provider is not called again.
  const f = fixture(t);
  let providerCalls = 0;
  const { post } = await serve(t, f, telegramOptions(async () => {
    providerCalls++;
    return Response.json({ ok: true, result: { message_id: 4242 } });
  }));
  const requestId = randomUUID();
  const body = "legacy pending";
  const sendId = randomUUID();
  recordDirectSend(f.store.db, { id: sendId, accountId: f.accountId, channel: "telegram",
    to: "123456", subject: "", bodyHash: createHash("sha256").update(body, "utf8").digest("hex"),
    threadId: null, requestId, at: Date.now() });
  // Simulate a pre-migration table: no marker column, then migrate again.
  f.store.db.exec("ALTER TABLE direct_channel_sends DROP COLUMN dispatch_started_at");
  ensureDirectSendTable(f.store.db);
  assert.notEqual(getDirectSend(f.store.db, sendId).dispatch_started_at, null, "migration marks the legacy pending row started");
  const retry = await post({ channel: "telegram", to: "123456", subject: "", body, requestId });
  assert.equal(retry.status, 200);
  const send = (await retry.json()).send;
  assert.equal(send.id, sendId);
  assert.equal(send.status, "pending", "replayed as-is");
  assert.equal(providerCalls, 0, "the provider is never called for a legacy pending row");
});
