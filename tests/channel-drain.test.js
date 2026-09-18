// Task 9 — scheduled auto-drain of pending_channel_updates. Covers the
// drainer driving the real drain path (drain), update_id dedup through it,
// and poison-update parking on schedule (with and without an import
// authority), plus scan filtering and the scheduler's never-die contract.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { ChannelWebhookInbox, syncTelegramConnection, channelSyncLimits } from "../server/channel-import.mjs";
import { channelJournalLimits } from "../server/channel-journal.mjs";
import { ChannelDrainer, createChannelDrainScheduler, channelDrainLimits } from "../server/channel-drain.mjs";

const secret = "fixture-webhook-secret-0123456789";
function fixture(t, { authority = true } = {}) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.telegram = telegramContractFixture();
  const account = f.store.accountForMember("commons", "owner"), key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
  f.auth = { token: slot.token, account, ...f.store.loginAccountSession(slot.token, key, 0) };
  f.telegram.connection.accountId = account.id; f.connectionId = f.telegram.connection.id;
  const apply = request => f.store.connections.apply(f.auth.token, request, f.auth.sessionBinding);
  apply({ action: "connection.configure", requestId: randomUUID(), connectionId: f.connectionId, expectedRevision: 0, profile: structuredClone(f.telegram.connection) });
  apply({ action: "connection.webhook", requestId: "hook", connectionId: f.connectionId, expectedRevision: 1, secretHash: ChannelWebhookInbox.hash(secret) });
  f.webhooks = new ChannelWebhookInbox(f.store);
  f.receive = updates => f.webhooks.receive({ connectionId: f.connectionId, secret, body: { updates } });
  // The import authority the scheduler does NOT have in production (B20):
  // here it is the owner's real session, proving the drainer drives the
  // genuine drain path with secret-verification, dedup and poison-parking
  // intact.
  const importSlice = authority
    ? ({ store, webhooks, connectionId, requestId }) => syncTelegramConnection({ store, token: f.auth.token, binding: f.auth.sessionBinding, connectionId, requestId, updates: null, webhooks })
    : null;
  f.drainer = (overrides = {}) => new ChannelDrainer({ store: f.store, webhooks: f.webhooks, importSlice, ...overrides });
  f.rows = () => f.store.db.prepare("SELECT update_id,status,attempts,last_error FROM pending_channel_updates ORDER BY update_id").all();
  f.message = (id, text = "Update " + id, chat = f.telegram.chat) => ({ update_id: id, message: { message_id: id, date: 1788948000 + id, chat, from: { id: 5000000001, is_bot: false, first_name: "Avery" }, text } });
  f.poison = id => f.message(id, "secret chat", { id: 77, type: "secret" });
  return f;
}

test("a scheduled tick drains verified updates into the inbox through the real drain path", async t => {
  const f = fixture(t);
  assert.deepEqual(f.receive([f.message(2000), f.message(2001)]), { accountId: f.auth.account.id, connectionId: f.connectionId, received: 2, accepted: 2, rejected: 0, pending: 2 });
  const summary = await f.drainer().tick();
  assert.equal(summary.connections, 1); assert.equal(summary.drained, 1); assert.equal(summary.deferred, 0); assert.equal(summary.errors, 0);
  assert.equal(summary.results[0].status, "drained"); assert.equal(summary.results[0].imported, 2);
  assert.deepEqual(f.webhooks.journal(f.auth.account.id, f.connectionId), { pending: 0, imported: 2, failed: 0 });
  assert.equal(f.store.inbox.verify().sources, 2, "both updates landed in the inbox");
  const idle = await f.drainer().tick();
  assert.equal(idle.connections, 0, "a second tick finds nothing pending");
});

test("update_id dedup holds through the scheduled drain: redeliveries never double-import", async t => {
  const f = fixture(t);
  const update = f.message(2100);
  assert.equal(f.receive([update]).accepted, 1);
  assert.equal(f.receive([update]).accepted, 0, "duplicate delivery dedupes at receive time");
  await f.drainer().tick();
  assert.equal(f.store.inbox.verify().sources, 1);
  assert.equal(f.receive([update]).accepted, 0, "redelivery after import is a no-op in every status");
  const summary = await f.drainer().tick();
  assert.equal(summary.connections, 0, "nothing pending to drain again");
  assert.equal(f.store.inbox.verify().sources, 1, "still exactly one inbox source");
});

test("without an import authority the drainer honestly defers, and secret verification still guards receive", async t => {
  const f = fixture(t, { authority: false });
  f.receive([f.message(2200)]);
  const summary = await f.drainer().tick();
  assert.equal(summary.connections, 1); assert.equal(summary.drained, 0); assert.equal(summary.deferred, 1);
  assert.equal(summary.results[0].status, "deferred"); assert.equal(summary.results[0].code, "channel_drain_unavailable");
  assert.deepEqual(f.webhooks.journal(f.auth.account.id, f.connectionId), { pending: 1, imported: 0, failed: 0 }, "nothing imported without authority");
  assert.throws(() => f.webhooks.receive({ connectionId: f.connectionId, secret: "wrong-secret-0123456789abcdef", body: { updates: [f.message(2201)] } }),
    { status: 401, code: "channel_webhook_denied" }, "a bad secret is still denied");
});

test("the scheduled poison screen parks a repeatedly-failing update without an import authority", async t => {
  const f = fixture(t, { authority: false });
  // Journaled pending behind receive()'s own check (an adapter contract that
  // tightened later): the scheduled screen is the backstop.
  f.store.channelUpdates.record(f.auth.account.id, f.connectionId, [f.message(2300), f.poison(2301), f.message(2302)], { backlog: 500 });
  for (let n = 1; n <= channelJournalLimits.maxAttempts; n++) {
    const summary = await f.drainer().tick();
    // The screen re-flags the still-pending poison update every tick: that is
    // how its attempts accumulate toward the bound.
    assert.equal(summary.parked, 1, "the poison update is screened on every tick until it parks");
    const row = f.rows()[1];
    assert.equal(row.attempts, n, `attempt ${n} recorded`);
    assert.equal(row.status, n === channelJournalLimits.maxAttempts ? "failed" : "pending");
  }
  assert.deepEqual(f.webhooks.journal(f.auth.account.id, f.connectionId), { pending: 2, imported: 0, failed: 1 });
  assert.deepEqual(f.webhooks.pending(f.auth.account.id, f.connectionId).map(u => u.update_id), [2300, 2302], "the parked update is no longer offered");
  const extra = await f.drainer().tick();
  assert.equal(f.rows()[1].attempts, channelJournalLimits.maxAttempts, "attempts stop at the bound: never retried forever");
  assert.equal(extra.parked, 0);
});

test("with an import authority the drainer imports around poison and parks it via the same bound", async t => {
  const f = fixture(t);
  f.store.channelUpdates.record(f.auth.account.id, f.connectionId, [f.message(2400), f.poison(2401), f.message(2402)], { backlog: 500 });
  const first = await f.drainer().tick();
  assert.equal(first.results[0].imported, 2, "good updates around the poison import on the first drain");
  // One attempt from the scheduled screen plus one from the drain's own
  // poison backstop: the same bounded accounting, never double jeopardy past
  // the bound.
  assert.deepEqual(f.rows().map(r => [r.update_id, r.status, r.attempts]), [[2400, "imported", 0], [2401, "pending", 2], [2402, "imported", 0]]);
  await f.drainer().tick(); await f.drainer().tick();
  const row = f.rows()[1];
  assert.equal(row.status, "failed"); assert.ok(row.attempts <= channelJournalLimits.maxAttempts, "attempts never pass the bound");
  assert.deepEqual(f.webhooks.journal(f.auth.account.id, f.connectionId), { pending: 0, imported: 2, failed: 1 });
  assert.equal(f.store.inbox.verify().sources, 2);
});

test("the scan skips connections that are not active telegram connections", async t => {
  const f = fixture(t, { authority: false });
  // A second telegram connection that the owner disconnects: its pending rows
  // must not be drained or screened.
  const second = structuredClone(f.telegram.connection);
  second.id = "telegram-second"; second.revision = 1; second.externalId = "7000000002";
  f.store.connections.apply(f.auth.token, { action: "connection.configure", requestId: randomUUID(), connectionId: second.id, expectedRevision: 0, profile: second }, f.auth.sessionBinding);
  f.store.connections.apply(f.auth.token, { action: "connection.webhook", requestId: "hook-2", connectionId: second.id, expectedRevision: 1, secretHash: ChannelWebhookInbox.hash(secret) }, f.auth.sessionBinding);
  f.store.channelUpdates.record(f.auth.account.id, second.id, [f.message(2500)], { backlog: 500 });
  f.store.connections.apply(f.auth.token, { action: "connection.disconnect", requestId: "off", connectionId: second.id, expectedRevision: 1 }, f.auth.sessionBinding);
  f.receive([f.message(2501)]);
  const summary = await f.drainer().tick();
  assert.equal(summary.connections, 1, "only the active connection is scanned");
  assert.equal(summary.results[0].connectionId, f.connectionId);
  assert.deepEqual(f.webhooks.journal(f.auth.account.id, second.id), { pending: 1, imported: 0, failed: 0 }, "the disconnected connection keeps its backlog untouched");
});

test("a failing import is reported per connection and never kills the tick", async t => {
  const f = fixture(t, { authority: false });
  f.receive([f.message(2600)]);
  const drainer = f.drainer({ importSlice: () => { throw Object.assign(new Error("boom"), { code: "importer_unavailable", status: 500 }); } });
  const summary = await drainer.tick();
  assert.equal(summary.errors, 1); assert.equal(summary.results[0].status, "error"); assert.equal(summary.results[0].code, "importer_unavailable");
  assert.deepEqual(f.webhooks.journal(f.auth.account.id, f.connectionId), { pending: 1, imported: 0, failed: 0 }, "the failed slice stays pending for the next attempt");
});

test("concurrent drains for one connection never overlap", async t => {
  const f = fixture(t, { authority: false });
  f.receive([f.message(2700)]);
  let calls = 0;
  const drainer = f.drainer({ importSlice: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 50)); return { receipt: { imports: [] }, source: "webhook" }; } });
  const [first, second] = await Promise.all([drainer.drainConnection({ accountId: f.auth.account.id, connectionId: f.connectionId }),
    drainer.drainConnection({ accountId: f.auth.account.id, connectionId: f.connectionId })]);
  assert.equal(calls, 1, "the import ran once");
  assert.deepEqual([first.status, second.status].sort(), ["drained", "skipped"]);
  assert.equal([first, second].find(r => r.status === "skipped").code, "drain_inflight");
});

test("the scheduler follows the repo pattern: unref'd interval, start/stop, never-die ticks", async t => {
  const f = fixture(t, { authority: false });
  f.receive([f.message(2800)]);
  const seen = [];
  const drainer = f.drainer({ importSlice: () => { throw new Error("always fails"); } });
  const scheduler = createChannelDrainScheduler({ drainer, intervalMs: 20, onTick: summary => seen.push(summary) });
  assert.equal(scheduler.isRunning(), false);
  scheduler.start(); scheduler.start();
  assert.equal(scheduler.isRunning(), true);
  await new Promise(resolve => setTimeout(resolve, 120));
  scheduler.stop(); scheduler.stop();
  assert.equal(scheduler.isRunning(), false);
  assert.ok(scheduler.getTickCount() >= 1, "ticks ran on the interval");
  assert.ok(seen.length >= 1 && seen.every(s => s.errors === 1), "every failing tick was reported, none propagated");
  assert.throws(() => createChannelDrainScheduler({ drainer: {}, intervalMs: 20 }), TypeError);
  assert.throws(() => createChannelDrainScheduler({ drainer, intervalMs: Number.NaN }), TypeError);
  const disabled = createChannelDrainScheduler({ drainer, intervalMs: 0 });
  disabled.start(); assert.equal(disabled.isRunning(), false, "interval <= 0 disables the scheduler");
  assert.equal(channelDrainLimits.intervalMs, 60000, "default cadence lands verified updates within about a minute");
  assert.ok(channelDrainLimits.sliceLimit <= channelSyncLimits.webhookUpdates, "the drain slice respects the webhook page cap");
});
