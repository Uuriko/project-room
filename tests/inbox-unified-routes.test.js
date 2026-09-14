// Unified inbox UI routes (B27): the needs-you selector, owner-managed connection
// commands over HTTP, and replying to a Telegram source through the deployment's
// channel transport (fixture when the bindings are not set, live otherwise).
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";
import { RecordedTelegramBot, telegramSourceId } from "../server/channel-adapters/telegram.mjs";
import { telegramConfig, TelegramLiveStatus } from "../server/channel-adapters/telegram-config.mjs";
import { TelegramTransport } from "../server/channel-adapters/telegram-transport.mjs";
import { prepareTelegramFixturePage } from "../server/channel-import.mjs";
import { SyntheticInboxTransport, FixtureChannelSender } from "../server/inbox-transport.mjs";
import { inboxNeedsYou } from "../server/inbox.mjs";
import { createRoomServer } from "../server/http.mjs";

const FAKE_TOKEN = "123456789:AAFakeFakeFakeFakeFakeFakeFakeFakeFa", FAKE_SECRET = "fixture-webhook-secret-0123456789";
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.telegram = telegramContractFixture(); f.email = emailContractFixture(); f.sessions = {};
  for (const role of ["owner", "guest"]) {
    const account = f.store.accountForMember("commons", role), key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
    f.sessions[role] = { token: slot.token, account, ...f.store.loginAccountSession(slot.token, key, 0) };
  }
  f.auth = f.sessions.owner; f.telegram.connection.accountId = f.auth.account.id; f.email.connection.accountId = f.auth.account.id;
  f.apply = (request, role = "owner") => f.store.connections.apply(f.sessions[role].token, request, f.sessions[role].sessionBinding);
  f.configure = profile => f.apply({ action: "connection.configure", requestId: randomUUID(), connectionId: profile.id, expectedRevision: 0, profile: structuredClone(profile) });
  f.inbox = request => f.store.inbox.apply(f.auth.token, request, f.auth.sessionBinding);
  f.sourceId = messageId => telegramSourceId(f.telegram.connection, messageId);
  f.importTelegram = async (updates = f.telegram.updates) => {
    const reader = new RecordedTelegramBot({ connection: f.telegram.connection, updates, limit: 100 });
    f.apply(await prepareTelegramFixturePage({ store: f.store, token: f.auth.token, binding: f.auth.sessionBinding, connectionId: f.telegram.connection.id, reader }));
  };
  f.importEmail = (patch = {}) => {
    const raw = f.email; const message = { ...raw.message, ...patch };
    const envelope = normalizeGraphEmail(raw.connection, message, { ...raw.options, attachmentObservation: { ...raw.options.attachmentObservation, messageId: message.id, messageRevision: message.changeKey } });
    const state = f.store.email.state(f.auth.token, raw.connection.id, message.parentFolderId, f.auth.sessionBinding);
    f.apply({ action: "page.apply", requestId: randomUUID(), connectionId: raw.connection.id, connectionRevision: 1, folderId: message.parentFolderId,
      expectedRevision: state.folder?.revision ?? 0, expectedCursor: state.expectedCursor, cursor: randomUUID(), complete: true, reset: state.needsReset,
      observations: [{ kind: "message", expectedSourceRevision: 0, envelope }] });
    return envelope.sourceId;
  };
  f.list = () => f.store.inbox.list(f.auth.token, f.auth.sessionBinding, { includeChannels: true }).sources;
  f.read = id => f.store.inbox.read(f.auth.token, id, f.auth.sessionBinding, { emailView: true, excerptView: true }).source;
  f.queuedReply = (sourceId, body = "Thanks, reading it now.") => {
    f.inbox({ action: "draft.save", requestId: "draft-" + sourceId, sourceId, sourceRevision: 1, expectedRevision: 0, body });
    const preview = f.store.inbox.sendContext(f.auth.token, sourceId, f.auth.sessionBinding).preview;
    return f.inbox({ action: "send.reserve", requestId: "send-" + sourceId, sourceId, sourceRevision: 1, draftRevision: 1, previewVersion: preview.previewVersion }).receipt.send;
  };
  f.server = async (options = {}) => {
    const server = createRoomServer({ store: f.store, resolveClientAddress: () => "203.0.113.5", ...options });
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

test("needs-you: email addressed To the mailbox, Telegram private chats, bot mentions and replies to the bot's own messages", async t => {
  const f = fixture(t); f.configure(f.telegram.connection); f.configure(f.email.connection);
  const chat = f.telegram.chat, avery = { id: 5000000001, is_bot: false, first_name: "Avery" };
  await f.importTelegram([
    f.telegram.updates[0],
    { update_id: 900002, message: { message_id: 42, date: 1788948060, chat, from: avery, text: "Hey @fixture_room_bot, can you summarize?" } },
    { update_id: 900003, message: { message_id: 43, date: 1788948120, chat, from: avery, text: "unrelated @fixture_room_bot_2 handle" } },
    { update_id: 900004, message: { message_id: 5, date: 1788948180, chat: { id: 5000000001, type: "private", first_name: "Avery" }, from: avery, text: "Direct message to the bot" } },
    { update_id: 900005, message: { message_id: 44, date: 1788948240, chat, from: avery, reply_to_message: { message_id: 41 }, text: "Replying to Avery, not the bot" } },
    { update_id: 900006, message: { message_id: 45, date: 1788948300, chat, from: avery, reply_to_message: { message_id: 90 }, text: "Replying to the bot" } }
  ]);
  const by = messageId => f.list().find(r => r.id === f.sourceId(messageId));
  assert.equal(by("-1001000000001:41").needsYou, false, "a group message that does not address the bot");
  assert.equal(by("-1001000000001:42").needsYou, true, "mentions the bot handle");
  assert.equal(by("-1001000000001:43").needsYou, false, "a longer handle sharing the prefix is not a mention");
  assert.equal(by("5000000001:5").needsYou, true, "a private chat with the bot");
  assert.equal(by("-1001000000001:44").needsYou, false, "a reply to a human");
  assert.equal(by("-1001000000001:45").needsYou, false, "a reply to a message the bot has not sent yet");
  // The bot sends a reply that Telegram records as message 90; a later reply to it addresses the owner.
  const send = f.queuedReply(f.sourceId("-1001000000001:41"));
  const transport = request => f.store.inbox.transport(f.auth.token, request, f.auth.sessionBinding).receipt.send;
  const dispatched = transport({ action: "send.dispatch", requestId: "d1", sourceId: send.sourceId, sendId: send.id, expectedRevision: 0 });
  transport({ action: "send.observe", requestId: "o1", sourceId: send.sourceId, sendId: send.id, expectedRevision: dispatched.revision, outcome: "accepted", providerId: "telegram:-1001000000001:90" });
  assert.equal(by("-1001000000001:45").needsYou, true, "a reply to a message the bot sent");
  assert.equal(f.read(f.sourceId("-1001000000001:45")).needsYou, true); assert.equal(f.read(f.sourceId("-1001000000001:41")).needsYou, false);
  assert.equal(f.read(f.sourceId("-1001000000001:41")).capabilities.send, true);
  // Email: To counts, CC alone does not; an alias in To counts too.
  const to = f.importEmail(); assert.equal(by === null ? null : f.list().find(r => r.id === to).needsYou, true);
  assert.equal(f.read(to).needsYou, true);
  const ccOnly = f.importEmail({ id: "cc-only-message", toRecipients: [{ emailAddress: { name: "Other", address: "other@example.test" } }], ccRecipients: [{ emailAddress: f.email.connection.identity }] });
  assert.equal(f.list().find(r => r.id === ccOnly).needsYou, false);
  const alias = f.importEmail({ id: "alias-message", toRecipients: [{ emailAddress: { name: "M", address: "M@EXAMPLE.TEST" } }] });
  assert.equal(f.list().find(r => r.id === alias).needsYou, true);
  assert.equal(f.list().find(r => r.adapter === "synthetic")?.needsYou ?? false, false);
  // Pure selector edge cases.
  assert.equal(inboxNeedsYou({ adapter: "synthetic" }), false);
  assert.equal(inboxNeedsYou({ adapter: "telegram", envelope: { connection: { identity: { handle: "" } }, message: { to: [{ kind: "group" }], replyTo: null }, body: { content: "@" } } }), false);
});

test("connection commands over HTTP: session, CSRF, origin, owner-only, configure and disconnect only, rate limited, no secrets", async t => {
  const f = fixture(t), status = new TelegramLiveStatus();
  const hosted = await f.server({ telegram: telegramConfig({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_WEBHOOK_SECRET: FAKE_SECRET }), telegramStatus: status });
  const path = "/api/inbox/connections/commands", profile = structuredClone(f.telegram.connection);
  const configure = { action: "connection.configure", requestId: "c-1", connectionId: profile.id, expectedRevision: 0, profile };
  let response = await fetch(hosted.origin + path, { method: "POST", body: JSON.stringify(configure), headers: { "Content-Type": "application/json", Origin: hosted.origin, "X-Session-Binding": f.auth.sessionBinding } });
  assert.equal(response.status, 401);
  response = await fetch(hosted.origin + path, { method: "POST", body: JSON.stringify(configure), headers: { "Content-Type": "application/json", Origin: hosted.origin, Authorization: "Bearer " + f.keys.owner, "X-Session-Binding": f.auth.sessionBinding } });
  assert.equal(response.status, 401); assert.equal((await response.json()).error.code, "account_session_required");
  response = await hosted.post(path, configure, f.auth, { "X-CSRF-Token": "" }); assert.equal(response.status, 403); assert.equal((await response.json()).error.code, "csrf_denied");
  response = await hosted.post(path, configure, f.auth, { Origin: "https://evil.example" }); assert.equal(response.status, 403); assert.equal((await response.json()).error.code, "origin_denied");
  // Only configure and disconnect travel here; webhook hashes and import pages never do.
  response = await hosted.post(path, { action: "connection.webhook", requestId: "w-1", connectionId: profile.id, expectedRevision: 0, secretHash: "0".repeat(64) });
  assert.equal(response.status, 422); assert.equal((await response.json()).error.code, "invalid_channel_connection");
  response = await hosted.post(path, { action: "page.apply", requestId: "p-1", connectionId: profile.id }); assert.equal(response.status, 422);
  response = await hosted.post(path, [configure]); assert.ok([400, 422].includes(response.status), "an array body is refused");
  response = await hosted.post(path, { ...configure, connectionId: "bad id!" }); assert.equal(response.status, 422);
  response = await hosted.post(path, { ...configure, extra: 1 }); assert.equal(response.status, 422);
  // Another account cannot register a profile for this account, and sees 404 for its connections.
  response = await hosted.post(path, configure, f.sessions.guest); assert.equal(response.status, 422); assert.equal((await response.json()).error.code, "channel_account_mismatch");
  // Owner adds the bot: 201 with the record and the live block, never a token, secret or hash.
  response = await hosted.post(path, configure); let value = await response.json();
  assert.equal(response.status, 201, JSON.stringify(value)); assert.equal(value.duplicate, false);
  assert.deepEqual(value.receipt, { requestId: "c-1", action: "connection.configure", connectionId: profile.id, revision: 1, state: "active" });
  assert.equal(value.connection.state, "active"); assert.equal(value.live.state, "configured"); assert.equal(value.live.webhook, "unset");
  for (const secret of [FAKE_TOKEN, FAKE_SECRET, "secretHash"]) assert.equal(JSON.stringify(value).includes(secret), false, secret);
  response = await hosted.post(path, configure); value = await response.json(); assert.equal(response.status, 200); assert.equal(value.duplicate, true);
  // A guest disconnecting the owner's connection: not found, nothing disclosed.
  response = await hosted.post(path, { action: "connection.disconnect", requestId: "g-1", connectionId: profile.id, expectedRevision: 0 }, f.sessions.guest);
  assert.equal(response.status, 404); assert.equal((await response.json()).error.code, "channel_connection_not_found");
  // Email fixture mailbox: the Graph-shaped profile is accepted and carries no live block.
  const mailbox = { accountId: f.auth.account.id, id: "mailbox", revision: 1, provider: "microsoft-graph", mailboxId: "john@example.test", identity: { name: "John", address: "john@example.test" }, aliases: [] };
  response = await hosted.post(path, { action: "connection.configure", requestId: "m-1", connectionId: "mailbox", expectedRevision: 0, profile: mailbox }); value = await response.json();
  assert.equal(response.status, 201, JSON.stringify(value)); assert.equal(value.connection.channel, "email"); assert.equal(value.live, null); assert.equal(value.mode, "fixture");
  // Remove = disconnect: the record stays, state disconnected, revision moves.
  response = await hosted.post(path, { action: "connection.disconnect", requestId: "d-1", connectionId: profile.id, expectedRevision: 1 }); value = await response.json();
  assert.equal(response.status, 201, JSON.stringify(value)); assert.equal(value.connection.state, "disconnected"); assert.equal(value.receipt.revision, 2); assert.equal(value.receipt.state, "disconnected");
  response = await hosted.post(path, { action: "connection.disconnect", requestId: "d-2", connectionId: profile.id, expectedRevision: 1 }); assert.equal(response.status, 409);
  assert.equal((await hosted.get("/api/inbox/connections")).status, 200);
  assert.equal((await (await hosted.get("/api/inbox/connections")).json()).connections.length, 2);
  // Re-adding the same bot re-activates it under the next revision.
  response = await hosted.post(path, { action: "connection.configure", requestId: "c-2", connectionId: profile.id, expectedRevision: 2, profile: { ...profile, revision: 3 } }); value = await response.json();
  assert.equal(response.status, 201, JSON.stringify(value)); assert.equal(value.connection.state, "active"); assert.equal(value.connection.revision, 3);
  let limited = null;
  for (let i = 0; i < 30 && !limited; i++) { const r = await hosted.post(path, { action: "connection.disconnect", requestId: "burst-" + i, connectionId: "missing-" + i, expectedRevision: 0 }); if (r.status === 429) limited = r; }
  assert.ok(limited, "the burst hits the limit"); assert.equal((await limited.json()).error.code, "rate_limited");
});

test("channel sends: a Telegram reply dispatches through the fixture sender when not configured and through the live transport when it is; email has none", async t => {
  const f = fixture(t); f.configure(f.telegram.connection); f.configure(f.email.connection);
  await f.importTelegram(f.telegram.updates.slice(0, 2));
  const emailId = f.importEmail(), tgId = f.sourceId("-1001000000001:41"), status = new TelegramLiveStatus();
  const path = "/api/inbox/channel-sends";
  // Not configured: the fixture sender answers, and the browser is told it is a fixture.
  const bare = await f.server({ telegramStatus: status });
  let response = await bare.get("/api/inbox/sources/" + tgId + "/sends"); let value = await response.json();
  assert.deepEqual(value.channelSend, { provider: "telegram-bot", mode: "fixture" }); assert.equal(value.simulationAvailable, false);
  response = await bare.get("/api/inbox/sources/" + emailId + "/sends"); value = await response.json(); assert.equal(value.channelSend, null);
  response = await bare.get("/api/inbox/sources/" + tgId + "/send-context"); assert.equal(response.status, 409, "no saved draft yet");
  const send = f.queuedReply(tgId);
  response = await bare.get("/api/inbox/sources/" + tgId + "/send-context"); value = await response.json(); assert.deepEqual(value.channelSend, { provider: "telegram-bot", mode: "fixture" });
  // Authority and body shape.
  response = await fetch(bare.origin + path, { method: "POST", body: JSON.stringify({ action: "dispatch", sourceId: tgId, sendId: send.id }), headers: { "Content-Type": "application/json", Origin: bare.origin, "X-Session-Binding": f.auth.sessionBinding } });
  assert.equal(response.status, 401);
  response = await bare.post(path, { action: "dispatch", sourceId: tgId, sendId: send.id }, f.auth, { "X-CSRF-Token": "" }); assert.equal(response.status, 403);
  response = await bare.post(path, { action: "dispatch", sourceId: tgId, sendId: send.id }, f.sessions.guest); assert.equal(response.status, 404);
  response = await bare.post(path, { action: "send", sourceId: tgId, sendId: send.id }); assert.equal(response.status, 422); assert.equal((await response.json()).error.code, "invalid_inbox_send");
  response = await bare.post(path, { action: "dispatch", sourceId: tgId, sendId: send.id, extra: 1 }); assert.equal(response.status, 422);
  response = await bare.post(path, { action: "dispatch", sourceId: emailId, sendId: "x" }); assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "channel_sending_unavailable");
  f.inbox({ action: "source.save", requestId: "note", sourceId: "note", expectedRevision: 0, data: { adapter: "synthetic", sender: "maya@example.test", recipient: "you@example.test", subject: "Sample", paragraphs: ["Hello"] } });
  response = await bare.post(path, { action: "dispatch", sourceId: "note", sendId: "x" }); assert.equal(response.status, 409, "synthetic samples use the simulation route");
  // Dispatch: accepted by the fixture, recorded in the send journal and on the connection's live status.
  response = await bare.post(path, { action: "dispatch", sourceId: tgId, sendId: send.id }); value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value)); assert.equal(value.send.status, "accepted"); assert.match(value.send.providerId, /^fixture:reply-[a-f0-9]{64}$/);
  assert.deepEqual(value.channelSend, { provider: "telegram-bot", mode: "fixture" }); assert.equal(value.lastSendResult.outcome, "accepted"); assert.equal(value.lastSendResult.code, "fixture");
  assert.equal(value.sends.length, 1); assert.equal(value.sends[0].revision, 2);
  response = await bare.post(path, { action: "dispatch", sourceId: tgId, sendId: send.id }); value = await response.json(); assert.equal(value.send.status, "accepted", "a second dispatch never sends again");
  response = await bare.post(path, { action: "reconcile", sourceId: tgId, sendId: send.id }); value = await response.json(); assert.equal(value.send.status, "accepted");
  response = await bare.get("/api/inbox/connections/" + f.telegram.connection.id); value = await response.json();
  assert.deepEqual({ outcome: value.live.lastSendResult.outcome, code: value.live.lastSendResult.code }, { outcome: "accepted", code: "fixture" });
  // A disconnected connection offers no transport.
  f.apply({ action: "connection.disconnect", requestId: "off", connectionId: f.telegram.connection.id, expectedRevision: 1 });
  response = await bare.get("/api/inbox/sources/" + tgId + "/sends"); value = await response.json(); assert.equal(value.channelSend, null);
  assert.equal(f.read(tgId).capabilities.send, false);
  response = await bare.post(path, { action: "reconcile", sourceId: tgId, sendId: send.id }); assert.equal(response.status, 409);
  f.apply({ action: "connection.configure", requestId: "on", connectionId: f.telegram.connection.id, expectedRevision: 2, profile: { ...f.telegram.connection, revision: 3 } });
  // Configured: the live transport posts sendMessage through the injected fetch.
  const config = telegramConfig({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_WEBHOOK_SECRET: FAKE_SECRET }), calls = [];
  let answer = () => jsonResponse(200, { ok: true, result: { message_id: 777, chat: { id: -1001000000001 } } });
  const liveStatus = new TelegramLiveStatus(), transports = new Map();
  const live = await f.server({ telegram: config, telegramStatus: liveStatus, channelTransports: ({ provider, accountId, connectionId }) => {
    if (provider !== "telegram-bot") return null;
    const key = accountId + "/" + connectionId;
    if (!transports.has(key)) transports.set(key, { mode: "live", transport: new SyntheticInboxTransport(f.store.inbox, new TelegramTransport({ config, status: liveStatus, accountId, connectionId,
      sleep: async () => {}, fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return answer(); } })) });
    return transports.get(key);
  } });
  const second = f.sourceId("-1001000000001:42");
  const reply2 = f.queuedReply(second, "Got the brief.");
  response = await live.get("/api/inbox/sources/" + second + "/sends"); value = await response.json(); assert.deepEqual(value.channelSend, { provider: "telegram-bot", mode: "live" });
  response = await live.post(path, { action: "dispatch", sourceId: second, sendId: reply2.id }); value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value)); assert.equal(value.send.status, "accepted"); assert.equal(value.send.providerId, "telegram:-1001000000001:777");
  assert.equal(value.channelSend.mode, "live"); assert.equal(value.lastSendResult.outcome, "accepted"); assert.equal(value.lastSendResult.code, null);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, "https://api.telegram.org/bot" + FAKE_TOKEN + "/sendMessage");
  assert.deepEqual(calls[0].body, { chat_id: -1001000000001, text: "Got the brief.", reply_parameters: { message_id: 42, allow_sending_without_reply: true } });
  assert.equal(JSON.stringify(value).includes(FAKE_TOKEN), false);
  // Telegram unreachable: the attempt stays unknown and the response names the failure for the browser.
  answer = () => { throw new TypeError("fetch failed"); };
  const third = f.sourceId("-1001000000001:41"); f.inbox({ action: "draft.save", requestId: "draft-again", sourceId: third, sourceRevision: 1, expectedRevision: 1, body: "Second reply" });
  const preview = f.store.inbox.sendContext(f.auth.token, third, f.auth.sessionBinding).preview;
  const reply3 = f.inbox({ action: "send.reserve", requestId: "send-again", sourceId: third, sourceRevision: 1, draftRevision: 2, previewVersion: preview.previewVersion }).receipt.send;
  response = await live.post(path, { action: "dispatch", sourceId: third, sendId: reply3.id }); value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value)); assert.equal(value.send.status, "unknown"); assert.deepEqual({ outcome: value.lastSendResult.outcome, code: value.lastSendResult.code }, { outcome: "failed", code: "network" });
  // Telegram refuses the text: a definitive rejected receipt.
  answer = () => jsonResponse(400, { ok: false, description: "Bad Request: chat not found" });
  response = await live.post(path, { action: "reconcile", sourceId: third, sendId: reply3.id }); value = await response.json(); assert.equal(value.send.status, "unknown", "reconcile has no receipt to replay");
  const fourth = f.sourceId("-1001000000001:42"); f.inbox({ action: "draft.save", requestId: "draft-4", sourceId: fourth, sourceRevision: 1, expectedRevision: 1, body: "Another" });
  const preview4 = f.store.inbox.sendContext(f.auth.token, fourth, f.auth.sessionBinding).preview;
  const reply4 = f.inbox({ action: "send.reserve", requestId: "send-4", sourceId: fourth, sourceRevision: 1, draftRevision: 2, previewVersion: preview4.previewVersion }).receipt.send;
  response = await live.post(path, { action: "dispatch", sourceId: fourth, sendId: reply4.id }); value = await response.json();
  assert.equal(value.send.status, "rejected"); assert.equal(value.lastSendResult.outcome, "rejected"); assert.equal(value.lastSendResult.code, "bad_request_chat_not_found");
  // The fixture sender rehearses a rejection too.
  const rejecting = new FixtureChannelSender({ kind: "telegram-bot" }); rejecting.mode = "rejected";
  const receipt = await rejecting.submit({ operationId: "op-1", envelope: { previewVersion: "v1" } });
  assert.deepEqual(receipt, { operationId: "op-1", previewVersion: "v1", outcome: "rejected", providerId: null, code: "fixture_rejected" });
  await assert.rejects(rejecting.submit({ operationId: "op-1", envelope: { previewVersion: "v2" } }), { code: "conflicting_inbox_observation" });
  assert.throws(() => createRoomServer({ store: f.store, channelTransports: "telegram" }), /resolver/);
});
