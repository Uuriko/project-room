// Shared store fixture for store-backed fuzz drivers (F5, F6, F12).
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../../../scripts/acceptance-fixture.mjs";
import { telegramContractFixture } from "../../../scripts/telegram-contract-fixture.mjs";
import { ChannelWebhookInbox } from "../../../server/channel-import.mjs";
import { DurableTelegramLiveStatus, telegramLiveStatusSchema } from "../../../server/channel-live-status.mjs";

const secret = "fixture-webhook-secret-0123456789";

export function makeStoreFixture() {
  const f = createAcceptanceFixture();
  f.filename = join(f.directory, "room.sqlite");
  const account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id);
  const slot = f.store.createAccountSessionSlot();
  const auth = { token: slot.token, account, ...f.store.loginAccountSession(slot.token, key, 0) };
  const tg = telegramContractFixture();
  tg.connection.accountId = account.id;
  const connectionId = tg.connection.id;
  f.store.connections.apply(auth.token, { action: "connection.configure", requestId: randomUUID(), connectionId, expectedRevision: 0, profile: structuredClone(tg.connection) }, auth.sessionBinding);
  f.store.connections.apply(auth.token, { action: "connection.webhook", requestId: "hook", connectionId, expectedRevision: 1, secretHash: ChannelWebhookInbox.hash(secret) }, auth.sessionBinding);
  f.store.db.exec(telegramLiveStatusSchema);
  return {
    store: f.store, accountId: account.id, connectionId, secret,
    webhooks: new ChannelWebhookInbox(f.store),
    live: new DurableTelegramLiveStatus(f.store),
    close() { try { f.store.close(); } catch {} rmSync(f.directory, { recursive: true, force: true }); },
  };
}
export { secret };
