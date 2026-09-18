// Task 47a: fixture-vs-live parity for the channel journal path.
//
// The inbound pipeline has two ways to feed updates to the importer:
//   1. recorded: the owner supplies updates directly (syncTelegramConnection with `updates`)
//   2. webhook: Telegram delivers updates secret-verified into pending_channel_updates,
//      and a later owner sync drains them (syncTelegramConnection with `updates: null`)
//
// Everything downstream of the journal is shared code, but the journal write
// itself is not: this file proves both paths take the identical journal path to
// the identical import. A silent divergence here would make every fixture-based
// test and every live delivery disagree about what the inbox contains.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { syncTelegramConnection, ChannelWebhookInbox } from "../server/channel-import.mjs";
import { auditRecovery } from "../server/recovery.mjs";

const webhookSecret = "parity-webhook-secret-0123456789";

function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.telegram = telegramContractFixture();
  const account = f.store.accountForMember("commons", "owner"), key = f.store.issueAccountAccessKey(account.id),
    slot = f.store.createAccountSessionSlot();
  f.auth = { token: slot.token, account, ...f.store.loginAccountSession(slot.token, key, 0) };
  f.telegram.connection.accountId = f.auth.account.id;
  f.apply = request => f.store.connections.apply(f.auth.token, request, f.auth.sessionBinding);
  f.configure = () => f.apply({ action: "connection.configure", requestId: randomUUID(), connectionId: f.telegram.connection.id,
    expectedRevision: 0, profile: structuredClone(f.telegram.connection) });
  f.hook = () => {
    const webhooks = new ChannelWebhookInbox(f.store);
    f.apply({ action: "connection.webhook", requestId: "hook-" + randomUUID(), connectionId: f.telegram.connection.id,
      expectedRevision: 1, secretHash: ChannelWebhookInbox.hash(webhookSecret) });
    return webhooks;
  };
  f.sync = (requestId, updates, webhooks = null) => syncTelegramConnection({ store: f.store, token: f.auth.token,
    binding: f.auth.sessionBinding, connectionId: f.telegram.connection.id, requestId, updates, webhooks });
  f.sources = () => {
    const rows = []; let cursor = null;
    for (;;) {
      const page = f.store.inbox.list(f.auth.token, f.auth.sessionBinding, { includeChannels: true, cursor, limit: 100 });
      rows.push(...page.sources);
      if (!page.nextCursor) return rows;
      cursor = page.nextCursor;
    }
  };
  return f;
}

// Account ids are per-fixture secrets; everything else in the journal path must
// be identical across the two fixtures for the same delivered updates.
const normalizeRequest = request => {
  const clone = structuredClone(request);
  delete clone.requestId;
  for (const observation of clone.observations)
    if (observation.envelope?.connection) delete observation.envelope.connection.accountId;
  return clone;
};
const normalizeImports = imports => imports.map(({ inboxRequestId, ...rest }) => rest);
const sourceProjection = rows => rows
  .map(row => ({ id: row.id, adapter: row.adapter, subject: row.subject, revision: row.source?.revision ?? row.revision }))
  .sort((a, b) => a.id < b.id ? -1 : 1);

test("recorded updates and webhook deliveries take the identical journal path to the same import", async t => {
  const updates = telegramContractFixture().updates;
  assert.ok(updates.length >= 4, "the contract fixture carries a mixed page of updates");

  // Path A: secret-verified webhook delivery journals the updates, the owner drains them.
  const a = fixture(t); a.configure(); const webhooks = a.hook();
  const received = webhooks.receive({ connectionId: a.telegram.connection.id, secret: webhookSecret, body: { updates } });
  assert.deepEqual(received, { accountId: a.auth.account.id, connectionId: a.telegram.connection.id,
    received: updates.length, accepted: updates.length, rejected: 0, pending: updates.length });
  assert.deepEqual(webhooks.journal(a.auth.account.id, a.telegram.connection.id),
    { pending: updates.length, imported: 0, failed: 0 });
  assert.deepEqual(webhooks.pending(a.auth.account.id, a.telegram.connection.id), updates,
    "the journaled payload is the delivered update, byte for byte");
  assert.equal(a.store.inbox.verify().sources, 0, "delivery journals; it never imports by itself");
  const drained = await a.sync("drain-1", null, webhooks);
  assert.equal(drained.source, "webhook");
  assert.deepEqual(webhooks.journal(a.auth.account.id, a.telegram.connection.id),
    { pending: 0, imported: updates.length, failed: 0 }, "the drain acknowledges exactly the slice it consumed");

  // Path B: the same updates supplied as a recording, no journal involved.
  const b = fixture(t); b.configure();
  const recorded = await b.sync("rec-1", structuredClone(updates));
  assert.equal(recorded.source, "recording");

  // Parity: identical page envelope, identical import receipt, identical inbox.
  assert.deepEqual(normalizeRequest(drained.request), normalizeRequest(recorded.request),
    "the drained page rebuilds the same page.apply request as the recording");
  assert.deepEqual(normalizeImports(drained.receipt.imports), normalizeImports(recorded.receipt.imports),
    "the drain imports exactly what the recording imports");
  assert.deepEqual(sourceProjection(a.sources()), sourceProjection(b.sources()),
    "both paths leave the identical inbox behind");
});

test("webhook redelivery of already-imported updates is a no-op on both paths", async t => {
  const a = fixture(t); a.configure(); const webhooks = a.hook();
  const updates = telegramContractFixture().updates;
  webhooks.receive({ connectionId: a.telegram.connection.id, secret: webhookSecret, body: { updates } });
  await a.sync("drain-1", null, webhooks);
  const before = sourceProjection(a.sources());
  const again = webhooks.receive({ connectionId: a.telegram.connection.id, secret: webhookSecret, body: { updates } });
  assert.deepEqual(again, { accountId: a.auth.account.id, connectionId: a.telegram.connection.id,
    received: updates.length, accepted: 0, rejected: 0, pending: 0 },
    "rows that exist in any journal status are left exactly as they are");
  const redrain = await a.sync("drain-2", null, webhooks);
  assert.equal(redrain.source, "webhook"); assert.deepEqual(redrain.receipt.imports, [], "an empty drain imports nothing");
  assert.deepEqual(sourceProjection(a.sources()), before, "the inbox is unchanged by the redelivery");
});

test("an update the adapter refuses is parked failed on the webhook path, refused on the recorded path", async t => {
  // Intentional divergence, pinned down: refusing a webhook delivery (4xx) would
  // make Telegram redeliver it and stall its own queue behind the poison update,
  // while a caller-supplied recording can simply be told it is malformed.
  const poison = { update_id: 900100, message: { chat: { id: 1, type: "secret" }, message_id: 1, date: 1 } };

  const a = fixture(t); a.configure(); const webhooks = a.hook();
  const received = webhooks.receive({ connectionId: a.telegram.connection.id, secret: webhookSecret, body: { updates: [poison] } });
  assert.deepEqual(received, { accountId: a.auth.account.id, connectionId: a.telegram.connection.id,
    received: 1, accepted: 1, rejected: 1, pending: 0 }, "rejected updates park straight in failed, never pending");
  assert.deepEqual(webhooks.journal(a.auth.account.id, a.telegram.connection.id), { pending: 0, imported: 0, failed: 1 });
  const drained = await a.sync("drain-1", null, webhooks);
  assert.deepEqual(drained.receipt.imports, [], "the parked update never occupies a sync page");
  assert.deepEqual(webhooks.journal(a.auth.account.id, a.telegram.connection.id), { pending: 0, imported: 0, failed: 1 });
  assert.deepEqual(a.sources(), [], "nothing was imported from the poison delivery");

  const b = fixture(t); b.configure(); const before = auditRecovery(b.store);
  await assert.rejects(b.sync("rec-1", [poison]), { code: "invalid_channel_update" },
    "the recorded path refuses the malformed page outright");
  assert.deepEqual(auditRecovery(b.store), before, "the refused recording leaves no side effects");
});
