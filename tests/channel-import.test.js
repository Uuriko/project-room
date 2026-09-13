import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";
import { RecordedTelegramBot, telegramSourceId } from "../server/channel-adapters/telegram.mjs";
import { prepareTelegramFixturePage, syncTelegramConnection, ChannelWebhookInbox, telegramFolderId } from "../server/channel-import.mjs";
import { SyntheticInboxTransport } from "../server/inbox-transport.mjs";
import { SyntheticMailFixture } from "../scripts/synthetic-mail-fixture.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { auditRecovery } from "../server/recovery.mjs";

function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.telegram = telegramContractFixture(); f.email = emailContractFixture();
  f.sessions = {};
  for (const role of ["owner", "guest"]) {
    const account = f.store.accountForMember("commons", role), key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
    f.sessions[role] = { token: slot.token, account, ...f.store.loginAccountSession(slot.token, key, 0) };
  }
  f.auth = f.sessions.owner; f.telegram.connection.accountId = f.auth.account.id; f.email.connection.accountId = f.auth.account.id;
  f.apply = (request, role = "owner") => f.store.connections.apply(f.sessions[role].token, request, f.sessions[role].sessionBinding);
  f.configure = profile => f.apply({ action: "connection.configure", requestId: randomUUID(), connectionId: profile.id, expectedRevision: 0, profile: structuredClone(profile) });
  f.reader = (limit = 100) => new RecordedTelegramBot({ connection: f.telegram.connection, updates: f.telegram.updates, limit });
  f.prepare = (reader, extra = {}) => prepareTelegramFixturePage({ store: f.store, token: f.auth.token, binding: f.auth.sessionBinding, connectionId: f.telegram.connection.id, reader, ...extra });
  f.list = () => f.store.inbox.list(f.auth.token, f.auth.sessionBinding, { includeChannels: true }).sources;
  f.sourceId = messageId => telegramSourceId(f.telegram.connection, messageId);
  f.read = (id, options) => f.store.inbox.read(f.auth.token, id, f.auth.sessionBinding, options);
  f.inbox = request => f.store.inbox.apply(f.auth.token, request, f.auth.sessionBinding);
  f.emailPage = () => {
    const envelope = normalizeGraphEmail(f.email.connection, f.email.message, f.email.options);
    return { action: "page.apply", requestId: randomUUID(), connectionId: f.email.connection.id, connectionRevision: 1, folderId: f.email.message.parentFolderId,
      expectedRevision: 0, expectedCursor: null, cursor: randomUUID(), reset: true, complete: true, observations: [{ kind: "message", expectedSourceRevision: 0, envelope }] };
  };
  return f;
}
test("a recorded Telegram page imports beside email through the same importer; edits become new source versions", async t => {
  const f = fixture(t); f.configure(f.telegram.connection); f.configure(f.email.connection); f.apply(f.emailPage());
  const before = auditRecovery(f.store), reader = f.reader(4);
  const first = await f.prepare(reader, { requestId: "page-1" });
  assert.deepEqual(auditRecovery(f.store), before, "preparing has no side effects");
  assert.equal(first.folderId, telegramFolderId); assert.equal(first.complete, false); assert.equal(first.cursor, "900005");
  const applied = f.apply(first);
  assert.deepEqual(applied.receipt.imports.map(i => i.sourceRevision), [1, 1, 1]);
  assert.equal(f.apply(first).duplicate, true);
  const second = await f.prepare(reader, { requestId: "page-2" });
  assert.equal(second.expectedCursor, "900005"); assert.equal(second.complete, true);
  assert.deepEqual(second.observations.map(o => o.expectedSourceRevision), [1, 0]);
  f.apply(second);
  const edited = f.read(f.sourceId("-1001000000001:41"));
  assert.equal(edited.source.revision, 2); assert.equal(edited.source.adapter, "telegram"); assert.equal(edited.source.envelope.message.kind, "edited_message");
  const rows = f.list();
  assert.equal(rows.length, 5); assert.equal(rows.filter(r => r.adapter === "telegram").length, 4);
  assert.deepEqual(rows.find(r => r.adapter === "email").connection, { id: f.email.connection.id, channel: "email", provider: "microsoft-graph", state: "active" });
  assert.deepEqual(rows.find(r => r.id === edited.source.id).connection, { id: f.telegram.connection.id, channel: "telegram", provider: "telegram-bot", state: "active" });
  assert.equal(rows.find(r => r.id === edited.source.id).subject, "Fixture planning");
  assert.deepEqual(f.store.inbox.list(f.auth.token, f.auth.sessionBinding).sources, [], "old clients still see no channel sources");
  assert.deepEqual(f.store.inbox.list(f.sessions.guest.token, f.sessions.guest.sessionBinding, { includeChannels: true }).sources, []);
  const view = f.read(edited.source.id, { emailView: true, excerptView: true }).source;
  assert.equal(view.channel.view, "channel-excerpt-v1"); assert.equal(view.channel.connectionState, "active"); assert.equal(view.channel.edited, true);
  assert.deepEqual(view.capabilities, { draft: true, share: true, send: false });
  assert.deepEqual(view.paragraphs, ["Shall we work on this together?\n\nPrivate budget: 4300."]);
  for (const secret of ["7000000001", "-1001000000001", "900005", "file_id", "BQACAgIAAxkBAAIFixtureDoc"]) assert.equal(JSON.stringify(view).includes(secret), false, secret);
  const attached = f.read(f.sourceId("-1001000000001:42"), { emailView: true }).source;
  assert.equal(attached.channel.attachmentCount, 1); assert.equal(attached.channel.view, "channel-text-v1");
  const context = f.store.inbox.shareContext(f.auth.token, edited.source.id, "commons", f.auth.sessionBinding);
  const shared = f.inbox({ action: "source.excerpt", requestId: "share-1", sourceId: edited.source.id, sourceRevision: 2, roomId: "commons",
    audienceVersion: context.audienceVersion, selection: { start: 0, end: 31 } });
  assert.equal(f.store.room("commons").state.messages.find(m => m.id === shared.receipt.messageId).body, "Shared message excerpt\n\nShall we work on this together?");
  assert.deepEqual(f.store.connections.verify(), { connections: 2, folders: 2, sources: 5 });
  assert.equal(f.store.inbox.verify().sources, 5);
  f.store.close(); f.store = new RoomStore(f.filename);
  assert.equal(f.apply(second).duplicate, true); assert.equal(f.store.inbox.verify().sources, 5);
  assert.throws(() => f.inbox({ action: "source.import", requestId: "forged", sourceId: edited.source.id, expectedRevision: 2, data: { adapter: "telegram", envelope: edited.source.envelope } }), { code: "email_importer_required" });
  assert.throws(() => f.inbox({ action: "source.import", requestId: "forged", sourceId: edited.source.id, expectedRevision: 2, data: { adapter: "email", envelope: edited.source.envelope } }), { code: "invalid_inbox_source" });
});
test("telegram observations are scoped to their connection, account and channel", async t => {
  const f = fixture(t); f.configure(f.telegram.connection);
  const request = await f.prepare(f.reader(), { requestId: "page" }), before = auditRecovery(f.store);
  const other = structuredClone(request); other.observations[0].envelope.connection.accountId = f.sessions.guest.account.id;
  assert.throws(() => f.apply(other), { status: 422 });
  const wrongScope = structuredClone(request); wrongScope.folderId = "elsewhere";
  assert.throws(() => f.apply(wrongScope), { code: "email_observation_scope_changed" });
  const tampered = structuredClone(request); tampered.observations[0].envelope.body.content = "changed";
  assert.throws(() => f.apply(tampered), { status: 422 });
  const relabeled = { ...request, requestId: "relabel", observations: request.observations.map(o => ({ ...o, envelope: { ...o.envelope, channel: "email" } })) };
  assert.throws(() => f.apply(relabeled), { status: 422 });
  assert.deepEqual(auditRecovery(f.store), before);
  const foreign = new RecordedTelegramBot({ connection: { ...f.telegram.connection, externalId: "7000000009" }, updates: f.telegram.updates });
  await assert.rejects(f.prepare(foreign), { code: "telegram_recording_scope_changed" });
  assert.throws(() => f.configure({ ...f.telegram.connection, id: "second" }), { code: "email_mailbox_exists" });
  assert.throws(() => f.apply({ action: "connection.configure", requestId: randomUUID(), connectionId: f.telegram.connection.id, expectedRevision: 1,
    profile: { ...f.telegram.connection, revision: 2, extra: true } }), { code: "invalid_email_import" });
  f.apply(request);
  const sourceId = f.sourceId("-1001000000001:41");
  assert.throws(() => f.inbox({ action: "source.save", requestId: "flip", sourceId, expectedRevision: 1, data: { adapter: "synthetic", sender: "a", recipient: "b", subject: "c", paragraphs: ["d"] } }),
    { code: "inbox_source_origin_changed" });
  assert.equal(f.store.connections.connections(f.auth.token, f.auth.sessionBinding).connections[0].state, "active");
});
test("a saved Telegram reply previews the bot's target chat and sends only over a matching fixture transport", async t => {
  const f = fixture(t); f.configure(f.telegram.connection); const reader = f.reader(); f.apply(await f.prepare(reader));
  const sourceId = f.sourceId("-1001000000001:42");
  assert.throws(() => f.store.inbox.sendContext(f.auth.token, sourceId, f.auth.sessionBinding), { code: "stale_inbox_reply" });
  f.inbox({ action: "draft.save", requestId: "draft", sourceId, sourceRevision: 1, expectedRevision: 0, body: "Thanks, reading it now." });
  const preview = f.store.inbox.sendContext(f.auth.token, sourceId, f.auth.sessionBinding).preview;
  assert.equal(preview.adapter, "telegram"); assert.equal(preview.provider, "telegram-bot");
  assert.equal(preview.from, "Fixture Room Bot"); assert.deepEqual(preview.to, ["Fixture planning"]);
  assert.deepEqual(preview.target, { chatId: "-1001000000001", replyToMessageId: "42", threadId: "-1001000000001" });
  const reserved = f.inbox({ action: "send.reserve", requestId: "send", sourceId, sourceRevision: 1, draftRevision: 1, previewVersion: preview.previewVersion });
  assert.equal(reserved.receipt.send.status, "queued");
  const mail = new SyntheticMailFixture(join(f.directory, "mail.sqlite")); t.after(() => mail.close());
  const wrong = new SyntheticInboxTransport(f.store.inbox, mail);
  await assert.rejects(wrong.dispatch(f.auth.token, sourceId, reserved.receipt.send.id, f.auth.sessionBinding), { code: "inbox_transport_mismatch" });
  assert.equal(mail.count(), 0);
  const transport = new SyntheticInboxTransport(f.store.inbox, reader);
  const sent = await transport.dispatch(f.auth.token, sourceId, reserved.receipt.send.id, f.auth.sessionBinding);
  assert.equal(sent.status, "accepted"); assert.equal(reader.sent().length, 1); assert.equal(reader.sent()[0].target.chatId, "-1001000000001");
  assert.equal((await transport.reconcile(f.auth.token, sourceId, reserved.receipt.send.id, f.auth.sessionBinding)).status, "accepted");
  const sends = f.store.inbox.sends(f.auth.token, sourceId, f.auth.sessionBinding).sends;
  assert.deepEqual(sends.map(s => s.status), ["accepted"]);
  assert.throws(() => new SyntheticInboxTransport(f.store.inbox, { submit() {}, lookup() {} }), TypeError);
  assert.doesNotThrow(() => f.store.inbox.verify());
  const emailSource = (() => { f.configure(f.email.connection); f.apply(f.emailPage()); return f.list().find(r => r.adapter === "email").id; })();
  f.inbox({ action: "draft.save", requestId: "email-draft", sourceId: emailSource, sourceRevision: 1, expectedRevision: 0, body: "Email reply" });
  assert.throws(() => f.store.inbox.sendContext(f.auth.token, emailSource, f.auth.sessionBinding), { code: "email_sending_unavailable" });
});
test("HTTP connection routes, recorded sync and webhook delivery are account, secret and loopback scoped", async t => {
  const f = fixture(t); f.configure(f.telegram.connection);
  const webhooks = new ChannelWebhookInbox(f.store);
  const secret = "fixture-webhook-secret-0123456789";
  f.apply({ action: "connection.webhook", requestId: "hook", connectionId: f.telegram.connection.id, expectedRevision: 1, secretHash: ChannelWebhookInbox.hash(secret) });
  assert.throws(() => f.apply({ action: "connection.webhook", requestId: "hook-2", connectionId: f.telegram.connection.id, expectedRevision: 1, secretHash: "short" }), { code: "invalid_email_import" });
  const server = createRoomServer({ store: f.store, channelWebhooks: webhooks });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = "http://127.0.0.1:" + server.address().port;
  const headers = auth => ({ Cookie: "account_session=" + auth.token, "X-Session-Binding": auth.sessionBinding });
  const post = (path, data, auth = f.auth, extra = {}) => fetch(origin + path, { method: "POST", body: JSON.stringify(data),
    headers: { ...headers(auth), Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": auth.csrf, ...extra } });
  let response = await fetch(origin + "/api/inbox/connections", { headers: headers(f.auth) });
  assert.equal(response.status, 200); let value = await response.json();
  assert.equal(value.contractVersion, 1); assert.equal(value.viewer.accountId, f.auth.account.id);
  assert.deepEqual(value.connections, [{ ...f.telegram.connection, state: "active" }]);
  assert.equal(JSON.stringify(value).includes("secretHash"), false);
  response = await fetch(origin + "/api/inbox/connections", { headers: headers(f.sessions.guest) });
  assert.deepEqual((await response.json()).connections, []);
  response = await fetch(origin + "/api/inbox/connections", { headers: { Authorization: "Bearer " + f.keys.owner } });
  assert.equal(response.status, 401);
  response = await fetch(origin + "/api/inbox/connections/" + f.telegram.connection.id, { headers: headers(f.auth) });
  value = await response.json(); assert.equal(response.status, 200);
  assert.equal(value.connection.channel, "telegram"); assert.equal(value.mode, "fixture"); assert.equal(value.webhook, true); assert.equal(value.syncAvailable, true);
  response = await fetch(origin + "/api/inbox/connections/" + f.telegram.connection.id, { headers: headers(f.sessions.guest) });
  assert.equal(response.status, 404); assert.equal((await response.json()).error.code, "email_connection_not_found");
  response = await fetch(origin + "/api/inbox/connections/nope", { headers: headers(f.auth) }); assert.equal(response.status, 404);
  // Webhook: secret header, then body shape; the account is found from the connection.
  const update = f.telegram.updates[0];
  response = await fetch(origin + "/api/inbox/webhooks/" + f.telegram.connection.id, { method: "POST", body: JSON.stringify(update), headers: { "Content-Type": "application/json" } });
  assert.equal(response.status, 401); assert.equal((await response.json()).error.code, "channel_webhook_denied");
  const hook = (body, token = secret, id = f.telegram.connection.id) => fetch(origin + "/api/inbox/webhooks/" + id, { method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": token } });
  assert.equal((await hook(update, "fixture-webhook-secret-0123456780")).status, 401);
  assert.equal((await hook(update, secret, "unknown-connection")).status, 401);
  response = await hook({ not: "an update" }, secret); assert.equal(response.status, 422); assert.equal((await response.json()).error.code, "invalid_channel_update");
  response = await hook(update); assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { contractVersion: 1, connectionId: f.telegram.connection.id, received: 1, pending: 1 });
  response = await hook({ updates: [update, f.telegram.updates[1]] }); assert.equal((await response.json()).pending, 2, "redelivery dedupes by update_id");
  assert.equal(f.store.inbox.verify().sources, 0, "webhook delivery imports nothing by itself");
  const wrongRole = await fetch(origin + "/api/inbox/webhooks/" + f.telegram.connection.id, { headers: { "X-Telegram-Bot-Api-Secret-Token": secret } });
  assert.equal(wrongRole.status, 405);
  // Sync: account session, CSRF, loopback, exact body; null drains verified webhook updates.
  const syncPath = "/api/inbox/connections/" + f.telegram.connection.id + "/sync";
  response = await post(syncPath, { requestId: "sync-1", updates: null }, f.auth, { "X-CSRF-Token": "" }); assert.equal(response.status, 403);
  response = await post(syncPath, { requestId: "sync-1" }); assert.equal(response.status, 422);
  response = await post(syncPath, { requestId: "sync-1", updates: null }, f.sessions.guest); assert.equal(response.status, 404);
  response = await post(syncPath, { requestId: "sync-1", updates: null }); value = await response.json();
  assert.equal(response.status, 201, JSON.stringify(value)); assert.equal(value.source, "webhook"); assert.equal(value.receipt.imports.length, 2); assert.equal(value.connection.state, "active");
  assert.equal(webhooks.pending(f.auth.account.id, f.telegram.connection.id).length, 0);
  response = await post(syncPath, { requestId: "sync-1", updates: null }); value = await response.json();
  assert.equal(response.status, 200); assert.equal(value.duplicate, true); assert.equal(value.source, "journal");
  response = await post("/api/inbox/connections/other/sync", { requestId: "sync-1", updates: [] }); assert.equal(response.status, 404);
  response = await post(syncPath, { requestId: "sync-2", updates: f.telegram.updates.slice(2) }); value = await response.json();
  assert.equal(response.status, 201, JSON.stringify(value)); assert.equal(value.source, "recording"); assert.equal(value.receipt.imports.length, 3);
  response = await post(syncPath, { requestId: "sync-3", updates: [{ update_id: 1, message: { chat: { id: 1, type: "private" }, message_id: 1, date: 1, from: { id: 1 } } }] });
  value = await response.json(); assert.equal(response.status, 201); assert.deepEqual(value.receipt.imports, [], "updates behind the stored offset are dropped, not re-imported");
  response = await post(syncPath, { requestId: "sync-3b", updates: [{ update_id: 900100, message: { chat: { id: 1, type: "secret" }, message_id: 1, date: 1 } }] });
  assert.equal(response.status, 422, "unqualified updates are refused"); assert.equal((await response.json()).error.code, "invalid_channel_update");
  response = await post(syncPath, { requestId: "sync-4", updates: [{ bogus: true }] }); assert.equal(response.status, 422);
  assert.equal(f.list().filter(r => r.adapter === "telegram").length, 4);
  // Remote clients cannot import recordings, even with a valid session.
  const remote = createRoomServer({ store: f.store, channelWebhooks: webhooks, resolveClientAddress: () => "203.0.113.5" });
  await new Promise(resolve => remote.listen(0, "127.0.0.1", resolve));
  t.after(async () => { remote.closeStreams(); remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); });
  const remoteOrigin = "http://127.0.0.1:" + remote.address().port;
  response = await fetch(remoteOrigin + syncPath, { method: "POST", body: JSON.stringify({ requestId: "sync-5", updates: [] }),
    headers: { ...headers(f.auth), Origin: remoteOrigin, "Content-Type": "application/json", "X-CSRF-Token": f.auth.csrf } });
  assert.equal(response.status, 403); assert.equal((await response.json()).error.code, "channel_sync_local_only");
  response = await fetch(remoteOrigin + "/api/inbox/connections/" + f.telegram.connection.id, { headers: headers(f.auth) });
  assert.equal((await response.json()).syncAvailable, false);
  // Without a configured webhook inbox the route is inert and sync cannot drain.
  const plain = createRoomServer({ store: f.store });
  await new Promise(resolve => plain.listen(0, "127.0.0.1", resolve));
  t.after(async () => { plain.closeStreams(); plain.closeAllConnections(); await new Promise(resolve => plain.close(resolve)); });
  const plainOrigin = "http://127.0.0.1:" + plain.address().port;
  response = await fetch(plainOrigin + "/api/inbox/webhooks/" + f.telegram.connection.id, { method: "POST", body: JSON.stringify(update),
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret } });
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "channel_webhook_unavailable");
  response = await fetch(plainOrigin + syncPath, { method: "POST", body: JSON.stringify({ requestId: "sync-6", updates: null }),
    headers: { ...headers(f.auth), Origin: plainOrigin, "Content-Type": "application/json", "X-CSRF-Token": f.auth.csrf } });
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "channel_webhook_unavailable");
  // Disconnected connections stop accepting webhook deliveries and report their state.
  f.apply({ action: "connection.disconnect", requestId: "off", connectionId: f.telegram.connection.id, expectedRevision: 1 });
  assert.equal((await hook(update)).status, 401);
  response = await fetch(origin + "/api/inbox/connections", { headers: headers(f.auth) });
  assert.equal((await response.json()).connections[0].state, "disconnected");
  assert.equal(f.list()[0].connection.state, "disconnected");
  assert.deepEqual(f.store.connections.verify(), { connections: 1, folders: 1, sources: 4 });
});
test("the sync helper refuses non-Telegram connections and rejects malformed recordings without side effects", async t => {
  const f = fixture(t); f.configure(f.email.connection); f.configure(f.telegram.connection);
  const before = auditRecovery(f.store);
  await assert.rejects(syncTelegramConnection({ store: f.store, token: f.auth.token, binding: f.auth.sessionBinding, connectionId: f.email.connection.id, requestId: "x", updates: [] }),
    { code: "channel_sync_unsupported" });
  await assert.rejects(syncTelegramConnection({ store: f.store, token: f.auth.token, binding: f.auth.sessionBinding, connectionId: f.telegram.connection.id, requestId: "x", updates: "nope" }),
    { code: "invalid_channel_update" });
  await assert.rejects(syncTelegramConnection({ store: f.store, token: f.auth.token, binding: f.auth.sessionBinding, connectionId: f.telegram.connection.id, requestId: "x", updates: null }),
    { code: "channel_webhook_unavailable" });
  await assert.rejects(syncTelegramConnection({ store: f.store, token: f.auth.token, binding: f.auth.sessionBinding, connectionId: "missing", requestId: "x", updates: [] }),
    { code: "email_connection_not_found" });
  assert.deepEqual(auditRecovery(f.store), before);
});
