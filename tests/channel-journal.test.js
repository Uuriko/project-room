// B20: durable journal for channel webhook updates. Pending updates survive a
// store reopen, redeliveries are no-ops, a drained page marks exactly what it
// consumed imported, and failed attempts are recorded with a bound.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { RoomStore, ServiceError } from "../server/store.mjs";
import { ChannelWebhookInbox, syncTelegramConnection, channelSyncLimits } from "../server/channel-import.mjs";
import { channelJournalLimits } from "../server/channel-journal.mjs";
import { applicationTables } from "../server/writer-fence.mjs";
import { auditRecovery } from "../server/recovery.mjs";

const secret = "fixture-webhook-secret-0123456789";
function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.telegram = telegramContractFixture();
  const account = f.store.accountForMember("commons", "owner"), key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
  f.auth = { token: slot.token, account, ...f.store.loginAccountSession(slot.token, key, 0) };
  f.telegram.connection.accountId = account.id; f.connectionId = f.telegram.connection.id;
  f.store.connections.apply(f.auth.token, { action: "connection.configure", requestId: randomUUID(), connectionId: f.connectionId, expectedRevision: 0, profile: structuredClone(f.telegram.connection) }, f.auth.sessionBinding);
  f.store.connections.apply(f.auth.token, { action: "connection.webhook", requestId: "hook", connectionId: f.connectionId, expectedRevision: 1, secretHash: ChannelWebhookInbox.hash(secret) }, f.auth.sessionBinding);
  f.webhooks = new ChannelWebhookInbox(f.store);
  f.receive = (updates, webhooks = f.webhooks) => webhooks.receive({ connectionId: f.connectionId, secret, body: { updates } });
  f.sync = (webhooks = f.webhooks, requestId = randomUUID()) => syncTelegramConnection({ store: f.store, token: f.auth.token, binding: f.auth.sessionBinding, connectionId: f.connectionId, requestId, updates: null, webhooks });
  f.rows = () => f.store.db.prepare("SELECT update_id,status,attempts,last_error,payload FROM pending_channel_updates ORDER BY update_id").all();
  f.message = (id, text = "Update " + id, chat = f.telegram.chat) => ({ update_id: id, message: { message_id: id, date: 1788948000 + id, chat, from: { id: 5000000001, is_bot: false, first_name: "Avery" }, text } });
  f.reopen = () => { f.store.close(); f.store = new RoomStore(f.filename); f.webhooks = new ChannelWebhookInbox(f.store); return f.webhooks; };
  return f;
}

test("journaled webhook updates survive a store reopen, and the drained page marks exactly what it consumed imported", async t => {
  const f = fixture(t);
  assert.deepEqual(f.receive([f.message(2000), f.message(2001)]), { accountId: f.auth.account.id, connectionId: f.connectionId, received: 2, accepted: 2, rejected: 0, pending: 2 });
  assert.deepEqual(f.webhooks.journal(f.auth.account.id, f.connectionId), { pending: 2, imported: 0, failed: 0 });
  // Restart: a new process sees the same backlog from the store, not from memory.
  const webhooks = f.reopen();
  assert.deepEqual(webhooks.pending(f.auth.account.id, f.connectionId).map(u => u.update_id), [2000, 2001]);
  assert.deepEqual(webhooks.pending(f.auth.account.id, f.connectionId, { limit: 1 }).map(u => u.update_id), [2000]);
  const result = await f.sync(webhooks);
  assert.equal(result.source, "webhook"); assert.equal(result.receipt.imports.length, 2);
  assert.deepEqual(webhooks.journal(f.auth.account.id, f.connectionId), { pending: 0, imported: 2, failed: 0 });
  assert.deepEqual(f.rows().map(r => [r.update_id, r.status, r.attempts, r.last_error]), [[2000, "imported", 0, null], [2001, "imported", 0, null]]);
  assert.equal(JSON.parse(f.rows()[0].payload).message.text, "Update 2000", "the journal retains the raw update");
  // A page larger than the reader's cap acknowledges only the updates it consumed; the rest wait.
  f.receive(Array.from({ length: 80 }, (_, i) => f.message(3000 + i)));
  const page = await f.sync(webhooks);
  assert.equal(page.receipt.imports.length, channelSyncLimits.pageMessages); assert.equal(page.request.complete, false); assert.equal(page.request.cursor, "3050");
  assert.deepEqual(webhooks.journal(f.auth.account.id, f.connectionId), { pending: 30, imported: 52, failed: 0 });
  assert.deepEqual(webhooks.pending(f.auth.account.id, f.connectionId).map(u => u.update_id), Array.from({ length: 30 }, (_, i) => 3050 + i));
  assert.equal((await f.sync(webhooks)).receipt.imports.length, 30);
  assert.deepEqual(f.store.channelUpdates.verify(), { pending: 0, imported: 82, failed: 0 });
  const audit = auditRecovery(f.store);
  assert.equal(audit.tables.find(row => row.table === "pending_channel_updates").rows, 82);
  assert.ok(applicationTables.includes("pending_channel_updates"));
});

test("a redelivered update id is a no-op in every status, and the backlog and payload bounds refuse a delivery unchanged", async t => {
  const f = fixture(t);
  const first = f.message(2000);
  assert.equal(f.receive([first]).accepted, 1);
  assert.deepEqual(f.receive([first, f.message(2001)]), { accountId: f.auth.account.id, connectionId: f.connectionId, received: 2, accepted: 1, rejected: 0, pending: 2 });
  assert.equal(f.rows().length, 2);
  assert.equal((await f.sync()).receipt.imports.length, 2);
  // Redelivery after import: nothing pending again, nothing imported twice.
  assert.deepEqual(f.receive([first]), { accountId: f.auth.account.id, connectionId: f.connectionId, received: 1, accepted: 0, rejected: 0, pending: 0 });
  assert.equal((await f.sync()).receipt.imports.length, 0);
  assert.deepEqual(f.webhooks.journal(f.auth.account.id, f.connectionId), { pending: 0, imported: 2, failed: 0 });
  assert.equal(f.store.inbox.verify().sources, 2);
  // Backlog: the pending count after the write is bounded and a refused delivery journals nothing.
  for (let start = 0; start < channelSyncLimits.webhookBacklog; start += 100) f.receive(Array.from({ length: 100 }, (_, i) => f.message(10000 + start + i)));
  assert.equal(f.webhooks.journal(f.auth.account.id, f.connectionId).pending, channelSyncLimits.webhookBacklog);
  assert.throws(() => f.receive([f.message(20000)]), { code: "channel_webhook_backlog", status: 409 });
  assert.equal(f.webhooks.journal(f.auth.account.id, f.connectionId).pending, channelSyncLimits.webhookBacklog);
  assert.equal(f.rows().some(r => r.update_id === 20000), false);
  assert.throws(() => f.store.channelUpdates.record(f.auth.account.id, f.connectionId, [f.message(30000, "x".repeat(channelJournalLimits.payloadBytes))], { backlog: 1000 }), { code: "invalid_channel_update" });
  assert.throws(() => f.store.channelUpdates.record(f.auth.account.id, f.connectionId, [{ update_id: -1 }], { backlog: 1000 }), { code: "invalid_channel_update" });
  assert.throws(() => f.store.channelUpdates.record(f.auth.account.id, "nope", [f.message(1)], { backlog: 1000 }), /FOREIGN KEY/);
  assert.throws(() => f.store.channelUpdates.imported(f.auth.account.id, f.connectionId, []), { code: "invalid_channel_update" });
  assert.equal(f.rows().length, channelSyncLimits.webhookBacklog + 2);
  assert.doesNotThrow(() => auditRecovery(f.store));
});

test("an update that cannot be imported records its error and attempt count, parks after the bound, and never blocks its neighbours", async t => {
  const f = fixture(t);
  const poison = f.message(2001, "secret chat", { id: 77, type: "secret" });
  // Journaled pending behind receive()'s own check (an adapter contract that tightened later): the drain is the backstop.
  f.store.channelUpdates.record(f.auth.account.id, f.connectionId, [f.message(2000), poison, f.message(2002)], { backlog: 500 });
  const first = await f.sync();
  assert.equal(first.receipt.imports.length, 2, "good updates around the poison import on the first drain");
  assert.deepEqual(f.rows().map(r => [r.update_id, r.status, r.attempts, r.last_error]), [[2000, "imported", 0, null], [2001, "pending", 1, "unsupported_telegram_chat"], [2002, "imported", 0, null]]);
  for (let attempt = 2; attempt <= channelJournalLimits.maxAttempts; attempt++) {
    assert.equal((await f.sync()).receipt.imports.length, 0);
    const row = f.rows()[1];
    assert.equal(row.attempts, attempt); assert.equal(row.status, attempt === channelJournalLimits.maxAttempts ? "failed" : "pending");
  }
  assert.deepEqual(f.webhooks.journal(f.auth.account.id, f.connectionId), { pending: 0, imported: 2, failed: 1 });
  assert.deepEqual(f.webhooks.pending(f.auth.account.id, f.connectionId), [], "a parked update is no longer offered");
  assert.equal((await f.sync()).receipt.imports.length, 0);
  assert.equal(f.rows()[1].attempts, channelJournalLimits.maxAttempts, "attempts stop at the bound");
  assert.equal(f.receive([poison]).accepted, 0, "redelivering a parked update does not revive it");
  // receive() parks a malformed message-kind update on arrival (202, never 4xx: a refusal would only make the
  // provider redeliver it), so it never occupies the backlog or a sync attempt; well-formed neighbours stay pending.
  const early = f.message(2500, "bad chat", { id: 78, type: "secret" });
  assert.deepEqual(f.receive([f.message(2499), early, { update_id: 2501, callback_query: { id: "cb", data: "skipped" } }]),
    { accountId: f.auth.account.id, connectionId: f.connectionId, received: 3, accepted: 3, rejected: 1, pending: 2 });
  assert.deepEqual(f.rows().filter(r => r.update_id >= 2499).map(r => [r.update_id, r.status, r.attempts, r.last_error]),
    [[2499, "pending", 0, null], [2500, "failed", channelJournalLimits.maxAttempts, "unsupported_telegram_chat"], [2501, "pending", 0, null]]);
  assert.equal(f.receive([early]).accepted, 0, "a parked arrival is idempotent too");
  assert.equal((await f.sync()).receipt.imports.length, 1, "the callback query is consumed by the page, not imported");
  assert.deepEqual(f.webhooks.journal(f.auth.account.id, f.connectionId), { pending: 0, imported: 4, failed: 2 });
  // Journal state survives a restart exactly.
  const before = f.rows(); f.reopen();
  assert.deepEqual(f.rows(), before);
  assert.deepEqual(f.store.channelUpdates.verify(), { pending: 0, imported: 4, failed: 2 });
  // A failure of the page itself counts one attempt on the whole slice, but a state conflict (409) counts nothing.
  f.receive([f.message(4000), f.message(4001)]);
  const apply = f.store.email.apply;
  f.store.email.apply = () => { throw new ServiceError(409, "stale_email_page", "Sync progress changed."); };
  await assert.rejects(f.sync(), { code: "stale_email_page" });
  assert.deepEqual(f.rows().filter(r => r.update_id >= 4000).map(r => [r.status, r.attempts, r.last_error]), [["pending", 0, null], ["pending", 0, null]]);
  f.store.email.apply = () => { throw new ServiceError(500, "importer_unavailable", "Importer failed."); };
  await assert.rejects(f.sync(), { code: "importer_unavailable" });
  assert.deepEqual(f.rows().filter(r => r.update_id >= 4000).map(r => [r.status, r.attempts, r.last_error]), [["pending", 1, "importer_unavailable"], ["pending", 1, "importer_unavailable"]]);
  f.store.email.apply = apply;
  assert.equal((await f.sync()).receipt.imports.length, 2);
  assert.deepEqual(f.webhooks.journal(f.auth.account.id, f.connectionId), { pending: 0, imported: 6, failed: 2 });
  assert.doesNotThrow(() => auditRecovery(f.store));
});

test("schema: a v34 file from before the journal opens read-only and gains the table on a writable open; a partial schema is refused", t => {
  const f = fixture(t);
  f.receive([f.message(2000)]);
  f.store.close();
  const raw = new DatabaseSync(f.filename);
  raw.exec("DROP INDEX pending_channel_updates_status; DROP TABLE pending_channel_updates;");
  raw.close();
  // Read-only never migrates: an older backup is still a valid v34 file.
  const older = new RoomStore(f.filename, { readOnly: true });
  assert.equal(older.channelUpdates.verifySchema({ allowAbsent: true }), false);
  assert.throws(() => older.channelUpdates.verifySchema(), /operator reconciliation/);
  older.close();
  // A writable open adds the table without a schema version change.
  f.store = new RoomStore(f.filename);
  assert.equal(f.store.channelUpdates.verifySchema(), true);
  assert.equal(f.store.storagePlatform.version(f.store.db), 36);
  assert.deepEqual(f.store.channelUpdates.verify(), { pending: 0, imported: 0, failed: 0 });
  assert.deepEqual(auditRecovery(f.store).tables.map(row => row.table).sort(), [...applicationTables].sort());
  f.store.close();
  // Half a schema (table without its index) is refused read-only, never repaired there.
  const partial = new DatabaseSync(f.filename);
  partial.exec("DROP INDEX pending_channel_updates_status;");
  partial.close();
  assert.throws(() => new RoomStore(f.filename, { readOnly: true }), /Channel update journal schema requires operator reconciliation/);
  // A writable open recreates a missing object (IF NOT EXISTS), but a changed definition is reconciliation work.
  const changed = new DatabaseSync(f.filename);
  changed.exec("CREATE INDEX pending_channel_updates_status ON pending_channel_updates(status)");
  changed.close();
  assert.throws(() => new RoomStore(f.filename), /Channel update journal schema requires operator reconciliation/);
  assert.throws(() => new RoomStore(f.filename, { readOnly: true }), /Channel update journal schema requires operator reconciliation/);
  const repaired = new DatabaseSync(f.filename);
  repaired.exec("DROP INDEX pending_channel_updates_status;");
  repaired.close();
  f.store = new RoomStore(f.filename);
  assert.equal(f.store.channelUpdates.verifySchema(), true);
});
