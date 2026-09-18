// Task 10 — durable Telegram live status. The durable class keeps the same
// received()/sent()/snapshot() contract as the in-memory TelegramLiveStatus
// and survives a store reopen; invalid inputs surface as 422s, not silent
// writes; the table is registered as an unfenced additive table.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { RoomStore } from "../server/store.mjs";
import { DurableTelegramLiveStatus } from "../server/channel-live-status.mjs";
import { TelegramLiveStatus } from "../server/channel-adapters/telegram-config.mjs";
import { unfencedAdditiveTables, applicationTables } from "../server/writer-fence.mjs";

const ACC = "acc-1", CONN = "conn-1";
function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.reopen = () => { f.store.close(); f.store = new RoomStore(f.filename); return f.store; };
  return f;
}

test("durable live status records deliveries and sends, then survives a store reopen", t => {
  const f = fixture(t);
  const status = f.store.telegramLiveStatus;
  assert.ok(status instanceof DurableTelegramLiveStatus);
  assert.deepEqual(status.snapshot(ACC, CONN), { lastUpdateReceivedAt: null, receivedUpdates: 0, lastSendResult: null });

  status.received(ACC, CONN, { at: 1700000001000, count: 3 });
  status.received(ACC, CONN, { at: 1700000002000, count: 2 });
  assert.deepEqual(status.snapshot(ACC, CONN), { lastUpdateReceivedAt: 1700000002000, receivedUpdates: 5, lastSendResult: null });

  status.sent(ACC, CONN, { at: 1700000003000, outcome: "accepted" });
  status.sent(ACC, CONN, { at: 1700000004000, outcome: "failed", code: "network" });
  assert.deepEqual(status.snapshot(ACC, CONN).lastSendResult, { at: 1700000004000, outcome: "failed", code: "network" });

  // Direct sends (null connection id) land on their own row and do not disturb the connection row.
  status.sent(ACC, null, { at: 1700000005000, outcome: "sent", code: "direct" });
  assert.deepEqual(status.snapshot(ACC, null).lastSendResult, { at: 1700000005000, outcome: "sent", code: "direct" });
  assert.deepEqual(status.snapshot(ACC, CONN).lastSendResult, { at: 1700000004000, outcome: "failed", code: "network" });

  // Restart: a new process sees the same facts from the store, not from memory.
  const reopened = f.reopen();
  assert.deepEqual(reopened.telegramLiveStatus.snapshot(ACC, CONN),
    { lastUpdateReceivedAt: 1700000002000, receivedUpdates: 5, lastSendResult: { at: 1700000004000, outcome: "failed", code: "network" } });
  assert.deepEqual(reopened.telegramLiveStatus.snapshot(ACC, null).lastSendResult, { at: 1700000005000, outcome: "sent", code: "direct" });
});

test("durable snapshot shape matches the in-memory TelegramLiveStatus for the same ops", t => {
  const f = fixture(t);
  const durable = f.store.telegramLiveStatus, memory = new TelegramLiveStatus();
  const ops = [
    s => s.received(ACC, CONN, { at: 1700000001000, count: 4 }),
    s => s.received(ACC, CONN, { at: 1700000002000, count: 1 }),
    s => s.sent(ACC, CONN, { at: 1700000003000, outcome: "accepted" }),
    s => s.sent(ACC, null, { at: 1700000004000, outcome: "sent", code: "direct" })
  ];
  for (const op of ops) { op(durable); op(memory); }
  assert.deepEqual(durable.snapshot(ACC, CONN), memory.snapshot(ACC, CONN));
  assert.deepEqual(durable.snapshot(ACC, null), memory.snapshot(ACC, null));
});

test("invalid inputs fail loudly, and the journal registration is additive and unfenced", t => {
  const f = fixture(t);
  const status = f.store.telegramLiveStatus;
  assert.throws(() => status.received("", CONN, { at: 1, count: 1 }), { code: "invalid_live_status" });
  assert.throws(() => status.received(ACC, CONN, { at: 1, count: -1 }), { code: "invalid_live_status" });
  assert.throws(() => status.sent(ACC, CONN, { at: -5, outcome: "accepted" }), { code: "invalid_live_status" });
  assert.throws(() => status.sent(ACC, CONN, { at: 1, outcome: "" }), { code: "invalid_live_status" });
  // The table is in the schema and in the additive, unfenced registry.
  const tables = f.store.db.prepare("SELECT name FROM sqlite_master WHERE name='telegram_live_status'").all();
  assert.equal(tables.length, 1);
  assert.ok(unfencedAdditiveTables.includes("telegram_live_status"));
  assert.ok(applicationTables.includes("telegram_live_status"));
  assert.ok(status.verifySchema());
  assert.ok(status.verify() >= 0);
  // An older file without the table must not migrate silently.
  f.store.db.exec("DROP TABLE telegram_live_status");
  assert.equal(status.verifySchema({ allowAbsent: true }), false);
});
