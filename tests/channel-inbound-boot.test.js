import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { ChannelWebhookInbox } from "../server/channel-import.mjs";
import { defaultServerArgs } from "../server/boot-options.mjs";
import { createRoomServer } from "../server/http.mjs";

// The default boot path (server.mjs) builds its server arguments through
// defaultServerArgs. This test pins the one behavior that makes Telegram
// inbound usable outside Cloudflare: a valid webhook delivery is journaled
// (202) instead of answered 409 channel_webhook_unavailable.
test("the default boot path wires a webhook inbox: valid delivery journals, bad secret is denied", async t => {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const telegram = telegramContractFixture();
  const sessions = {};
  for (const role of ["owner", "guest"]) {
    const account = f.store.accountForMember("commons", role), key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
    sessions[role] = { token: slot.token, account, ...f.store.loginAccountSession(slot.token, key, 0) };
  }
  const auth = sessions.owner;
  telegram.connection.accountId = auth.account.id;
  const apply = request => f.store.connections.apply(auth.token, request, auth.sessionBinding);
  apply({ action: "connection.configure", requestId: randomUUID(), connectionId: telegram.connection.id, expectedRevision: 0, profile: structuredClone(telegram.connection) });
  const secret = "fixture-webhook-secret-0123456789";
  apply({ action: "connection.webhook", requestId: "hook", connectionId: telegram.connection.id, expectedRevision: 1, secretHash: ChannelWebhookInbox.hash(secret) });

  const args = defaultServerArgs({ store: f.store });
  assert.ok(args.channelWebhooks instanceof ChannelWebhookInbox, "boot args carry a webhook inbox");
  const server = createRoomServer(args);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = "http://127.0.0.1:" + server.address().port;
  const hook = (body, token = secret, id = telegram.connection.id) => fetch(origin + "/api/inbox/webhooks/" + id, { method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": token } });

  let response = await hook(telegram.updates[0]);
  assert.equal(response.status, 202, "a valid delivery is accepted, not 409 channel_webhook_unavailable");
  assert.deepEqual(await response.json(), { contractVersion: 1, connectionId: telegram.connection.id, received: 1, pending: 1 });
  assert.equal((await hook(telegram.updates[0], "fixture-webhook-secret-0123456780")).status, 401, "bad secret is denied");
  response = await hook(telegram.updates[0]);
  assert.equal((await response.json()).pending, 1, "duplicate delivery dedupes by update_id");
});
