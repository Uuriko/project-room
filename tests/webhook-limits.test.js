// Re-audit M1/M2: the provider webhook is rate limited per verified connection
// (Telegram delivers every bot from a few shared addresses) behind a high
// per-address guard, and takes a 64 KB JSON body while every other route keeps
// the 16 KB default (a Telegram reply embeds the whole replied-to message).
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { ChannelWebhookInbox, channelSyncLimits, syncTelegramConnection } from "../server/channel-import.mjs";
import { channelJournalLimits } from "../server/channel-journal.mjs";
import { createRoomServer } from "../server/http.mjs";

const secrets = ["fixture-webhook-secret-0123456789", "second-webhook-secret-9876543210"];

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.telegram = telegramContractFixture();
  const account = f.store.accountForMember("commons", "owner"), key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
  f.auth = { token: slot.token, account, ...f.store.loginAccountSession(slot.token, key, 0) };
  f.apply = request => f.store.connections.apply(f.auth.token, request, f.auth.sessionBinding);
  // Two bots owned by the same account: one connection's budget must not be the other's.
  const second = { ...structuredClone(f.telegram.connection), id: "telegram-second", externalId: "7000000002",
    identity: { kind: "bot", id: "7000000002", handle: "@second_room_bot", displayName: "Second Room Bot" } };
  f.connections = [f.telegram.connection, second].map(profile => ({ ...profile, accountId: f.auth.account.id }));
  f.webhooks = new ChannelWebhookInbox(f.store);
  for (const [index, profile] of f.connections.entries()) {
    f.apply({ action: "connection.configure", requestId: randomUUID(), connectionId: profile.id, expectedRevision: 0, profile: structuredClone(profile) });
    f.apply({ action: "connection.webhook", requestId: randomUUID(), connectionId: profile.id, expectedRevision: 1, secretHash: ChannelWebhookInbox.hash(secrets[index]) });
  }
  f.serve = async (options = {}) => {
    const server = createRoomServer({ store: f.store, channelWebhooks: f.webhooks, ...options });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const origin = "http://127.0.0.1:" + server.address().port;
    const hook = (body, { connection = 0, secret = secrets[connection], raw = null } = {}) => fetch(origin + "/api/inbox/webhooks/" + f.connections[connection].id,
      { method: "POST", body: raw ?? JSON.stringify(body), headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret } });
    return { server, origin, hook };
  };
  f.update = (updateId, extra = {}) => ({ update_id: updateId, message: { message_id: updateId, date: 1788948000 + updateId, chat: f.telegram.chat,
    from: { id: 5000000001, is_bot: false, first_name: "Avery" }, text: "Update " + updateId, ...extra } });
  f.pending = index => f.webhooks.pending(f.auth.account.id, f.connections[index].id).length;
  return f;
}

test("webhook deliveries are rate limited per verified connection, not per shared address", async t => {
  const f = fixture(t), { hook } = await f.serve();
  assert.equal(channelSyncLimits.webhookPerConnection, 60); assert.equal(channelSyncLimits.webhookPerAddress, 1200);
  for (let i = 1; i <= channelSyncLimits.webhookPerConnection; i++) {
    const response = await hook(f.update(i));
    assert.equal(response.status, 202, `delivery ${i} is within the connection's budget`);
  }
  let response = await hook(f.update(61));
  assert.equal(response.status, 429); assert.equal((await response.json()).error.code, "rate_limited");
  assert.equal(response.headers.get("x-ratelimit-limit"), "60");
  assert.equal(f.pending(0), 60, "the refused delivery journals nothing");
  // The same address carries the second bot's updates unhindered.
  response = await hook(f.update(1), { connection: 1 }); assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { contractVersion: 1, connectionId: f.connections[1].id, received: 1, pending: 1 });
  // The connection budget is counted after the secret matches: a wrong secret is still a plain 401, never a 429 that reveals the connection is busy.
  response = await hook(f.update(62), { secret: secrets[1] }); assert.equal(response.status, 401);
  response = await hook(f.update(62)); assert.equal(response.status, 429);
  // Unit level: a refused verification leaves the transaction without a journal write.
  assert.throws(() => f.webhooks.receive({ connectionId: f.connections[1].id, secret: secrets[1], body: f.update(2), verified: match => {
    assert.deepEqual(match, { accountId: f.auth.account.id, connectionId: f.connections[1].id }); throw new Error("refused");
  } }), /refused/);
  assert.equal(f.pending(1), 1);
  assert.throws(() => f.webhooks.receive({ connectionId: f.connections[1].id, secret: "wrong-secret-for-this-bot-000", body: f.update(2), verified: () => assert.fail("never verified") }), { status: 401 });
});

test("unverified senders hit the per-address guard first", async t => {
  const f = fixture(t), { hook } = await f.serve({ resolveClientAddress: () => "203.0.113.9" });
  const statuses = new Map();
  for (let start = 0; start < channelSyncLimits.webhookPerAddress; start += 100) {
    const batch = await Promise.all(Array.from({ length: 100 }, () => hook(f.update(1), { secret: "not-the-secret-of-any-bot-0123" })));
    for (const response of batch) statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  }
  assert.deepEqual([...statuses], [[401, channelSyncLimits.webhookPerAddress]], "every unverified request up to the guard is a plain 401");
  let response = await hook(f.update(1), { secret: "not-the-secret-of-any-bot-0123" });
  assert.equal(response.status, 429); assert.equal(response.headers.get("x-ratelimit-limit"), "1200");
  // The guard sits in front of verification, so a flooded address blocks its verified traffic too (Telegram retries after the minute).
  response = await hook(f.update(1)); assert.equal(response.status, 429);
  assert.equal(f.pending(0), 0);
});

test("the webhook takes a 64 KB Telegram update while sibling routes keep the 16 KB body cap", async t => {
  const f = fixture(t), { origin, hook } = await f.serve();
  assert.equal(channelSyncLimits.webhookBodyBytes, 65536); assert.equal(channelJournalLimits.payloadBytes, channelSyncLimits.webhookBodyBytes);
  // A reply to a 4096-character message: Telegram embeds the replied-to message with its entities.
  const quoted = { message_id: 41, date: 1788948000, chat: f.telegram.chat, from: { id: 5000000002, is_bot: false, first_name: "Lee" }, text: "q".repeat(4096),
    entities: Array.from({ length: 700 }, (_, i) => ({ type: "bold", offset: i * 5, length: 4 })) };
  const reply = f.update(7001, { text: "r".repeat(4096), reply_to_message: quoted, entities: Array.from({ length: 200 }, (_, i) => ({ type: "italic", offset: i * 20, length: 10 })) });
  const bytes = Buffer.byteLength(JSON.stringify(reply));
  assert.ok(bytes > 45000 && bytes < 50000, `shape-valid 48 KB update (${bytes} bytes)`);
  let response = await hook(reply);
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  assert.deepEqual(await response.json(), { contractVersion: 1, connectionId: f.connections[0].id, received: 1, pending: 1 });
  const imported = await syncTelegramConnection({ store: f.store, token: f.auth.token, binding: f.auth.sessionBinding, connectionId: f.connections[0].id, requestId: "big-1", updates: null, webhooks: f.webhooks });
  assert.equal(imported.source, "webhook"); assert.equal(imported.receipt.imports.length, 1);
  const source = f.store.inbox.list(f.auth.token, f.auth.sessionBinding, { includeChannels: true }).sources.find(row => row.adapter === "telegram");
  assert.equal(f.store.inbox.read(f.auth.token, source.id, f.auth.sessionBinding).source.envelope.message.replyTo, f.telegram.chat.id + ":41");
  // Above the webhook cap the route drains the body, then returns a readable 413.
  const huge = f.update(7002, { reply_to_message: { ...quoted, text: "q".repeat(70000) } });
  for (let attempt = 0; attempt < 5; attempt++) {
    response = await hook(huge); assert.equal(response.status, 413); assert.equal((await response.json()).error.code, "too_large");
  }
  assert.equal(f.pending(0), 0);
  // Every other JSON route keeps the 16 KB cap: the same 48 KB on the sibling sync route is refused, and a small body reaches the handler.
  const headers = { Cookie: "account_session=" + f.auth.token, "X-Session-Binding": f.auth.sessionBinding, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": f.auth.csrf };
  const sync = body => fetch(origin + "/api/inbox/connections/" + f.connections[0].id + "/sync", { method: "POST", body: JSON.stringify(body), headers });
  response = await sync({ requestId: "big-2", updates: [reply] });
  assert.equal(response.status, 413); assert.equal((await response.json()).error.code, "too_large");
  response = await sync({ requestId: "big-3", updates: [f.update(7003)] });
  assert.equal(response.status, 201, "a body within the default cap is processed");
  const justOver = { requestId: "big-4", updates: [f.update(7004, { text: "t".repeat(16300) })] };
  assert.ok(Buffer.byteLength(JSON.stringify(justOver)) > 16384 && Buffer.byteLength(JSON.stringify(justOver)) < 17000);
  response = await sync(justOver);
  assert.equal(response.status, 413, "the sibling cap is byte-exact at 16 KB, not the webhook's");
});

test("declared oversize returns 413 before a stalled client sends or ends its body", async t => {
  const f = fixture(t), { origin } = await f.serve();
  const headers = { Cookie: "account_session=" + f.auth.token, "X-Session-Binding": f.auth.sessionBinding,
    Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": f.auth.csrf, "Content-Length": "17000" };
  // Do not call end(): the peer advertises a body just above the 16 KB cap
  // but sends zero bytes. The response must arrive while the upload is open.
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(origin + "/api/inbox/connections/" + f.connections[0].id + "/sync", {
      method: "POST", headers
    }, res => {
      const code = res.statusCode;
      res.resume();
      res.on("end", () => { clearTimeout(timer); req.destroy(); resolve(code); });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error("stalled declared-oversize upload did not receive a prompt response")); }, 1500);
    req.on("error", error => { clearTimeout(timer); reject(error); });
    req.flushHeaders();
  });
  assert.equal(status, 413);
  assert.equal(f.pending(0), 0);
});
