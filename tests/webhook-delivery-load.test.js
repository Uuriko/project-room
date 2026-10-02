// Webhook delivery hydration and retention. The startup cache used to select
// the newest 100 rows per subscription with a correlated subquery and no
// index, which read the table once per row. These tests own that contract:
// the same rows come back, the planner uses the subscription index, and the
// cron prune keeps the newest 100 plus the retention window without touching
// pending or failed rows.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import {
  RECENT_WEBHOOK_DELIVERIES_SQL, WEBHOOK_DELIVERY_KEEP, WEBHOOK_DELIVERY_PRUNE_BATCH, WEBHOOK_DELIVERY_RETENTION_MS,
} from "../server/agent-plugin-store.mjs";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ORACLE_SQL = `SELECT delivery_id, subscription_id, created_at FROM agent_webhook_deliveries WHERE delivery_id IN (
  SELECT delivery_id FROM agent_webhook_deliveries d2
  WHERE d2.subscription_id = agent_webhook_deliveries.subscription_id
  ORDER BY created_at DESC LIMIT 100
) ORDER BY created_at ASC, rowid ASC`;

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "room-webhook-deliveries-"));
  const filename = join(dir, "room.sqlite");
  const store = new RoomStore(filename, { now: () => NOW });
  try { return fn(store, filename); }
  finally {
    try { store.close(); } catch { /* a reopened handle owns the close */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

function insertSub(db, id, journal = "[]") {
  db.prepare(`INSERT INTO agent_webhook_subs
    (subscription_id, agent_id, url, events_json, secret, enabled, created_at, journal_json)
    VALUES (?, 'agent', 'https://example.com/hook', '["message.posted"]', 'secret', 1, ?, ?)`)
    .run(id, 1, journal);
}

function insertDelivery(db, { id, sub, at, state = "delivered" }) {
  db.prepare(`INSERT INTO agent_webhook_deliveries
    (delivery_id, idempotency_key, subscription_id, agent_id, event_type, payload_json, signature, state, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, 'agent', 'message.posted', '{"data":{"n":1}}', 'sig', ?, 1, ?, ?, ?)`)
    .run(id, "key-" + id, sub, state, at, at, at);
}

test("startup hydration matches the newest 100 per subscription, oldest first", () => {
  withStore((store, filename) => {
    store.transaction(() => {
      insertSub(store.db, "busy");
      insertSub(store.db, "quiet");
      insertSub(store.db, "legacy", JSON.stringify([{ deliveryId: "from-journal", eventType: "message.posted", state: "delivered", attempts: 1, createdAt: 1 }]));
      for (let i = 0; i < 150; i++) insertDelivery(store.db, { id: "busy-" + i, sub: "busy", at: 1_000 + i });
      for (let i = 0; i < 40; i++) insertDelivery(store.db, { id: "quiet-" + i, sub: "quiet", at: 5_000 + i });
      // Ties at the boundary of the newest 100. rowid order must agree with
      // the previous created_at DESC LIMIT 100 selection.
      for (let i = 0; i < 3; i++) insertDelivery(store.db, { id: "tie-" + i, sub: "quiet", at: 5_039 });
    });
    const oracle = new Map();
    for (const row of store.db.prepare(ORACLE_SQL).all()) {
      const list = oracle.get(row.subscription_id) ?? [];
      list.push(row.delivery_id);
      oracle.set(row.subscription_id, list);
    }
    store.close();
    const reopened = new RoomStore(filename, { now: () => NOW });
    try {
      for (const id of reopened.agentPlugin.subs.keys()) reopened.agentPlugin.hydrateDeliveries(id);
      const ids = sub => reopened.agentPlugin.subs.get(sub).deliveries.map(delivery => delivery.deliveryId);
      assert.deepEqual(ids("busy"), oracle.get("busy"));
      assert.equal(ids("busy").length, WEBHOOK_DELIVERY_KEEP);
      assert.deepEqual(ids("quiet"), oracle.get("quiet"));
      assert.deepEqual(reopened.agentPlugin.subs.get("legacy").deliveries, [
        { deliveryId: "from-journal", eventType: "message.posted", state: "delivered", attempts: 1, createdAt: 1 },
      ]);
      const busyAt = reopened.agentPlugin.subs.get("busy").deliveries.map(delivery => delivery.createdAt);
      assert.deepEqual(busyAt, [...busyAt].sort((a, b) => a - b));
    } finally { reopened.close(); }
  });
});

test("delivery hydration uses the subscription index and not a correlated scan", () => {
  withStore(store => {
    const plan = store.db.prepare("EXPLAIN QUERY PLAN " + RECENT_WEBHOOK_DELIVERIES_SQL).all("sub")
      .map(row => row.detail).join("\n");
    assert.match(plan, /SEARCH agent_webhook_deliveries USING INDEX agent_webhook_deliveries_sub_created/);
    assert.doesNotMatch(plan, /CORRELATED/);
    assert.doesNotMatch(plan, /SCAN agent_webhook_deliveries/);
  });
});

test("reopening creates the delivery index on a database that already has rows", () => {
  withStore((store, filename) => {
    store.transaction(() => {
      insertSub(store.db, "sub");
      for (let i = 0; i < 10; i++) insertDelivery(store.db, { id: "row-" + i, sub: "sub", at: i + 1 });
    });
    store.db.exec("DROP INDEX agent_webhook_deliveries_sub_created");
    assert.equal(store.db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='index' AND name='agent_webhook_deliveries_sub_created'").get(), undefined);
    const before = store.db.prepare("SELECT COUNT(*) AS n FROM agent_webhook_deliveries").get().n;
    store.close();
    const reopened = new RoomStore(filename, { now: () => NOW });
    try {
      const index = reopened.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='agent_webhook_deliveries_sub_created'").get();
      assert.match(index.sql, /agent_webhook_deliveries\(subscription_id, created_at\)/);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM agent_webhook_deliveries").get().n, before);
      reopened.agentPlugin.hydrateDeliveries("sub");
      assert.equal(reopened.agentPlugin.subs.get("sub").deliveries.length, before);
    } finally { reopened.close(); }
  });
});

test("retention keeps the newest 100 and the window, and never pending or failed rows", () => {
  withStore(store => {
    const cutoff = NOW - WEBHOOK_DELIVERY_RETENTION_MS;
    const events = store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
    store.transaction(() => {
      insertSub(store.db, "busy");
      insertSub(store.db, "quiet");
      for (let i = 0; i < 150; i++) insertDelivery(store.db, { id: "recent-" + i, sub: "busy", at: NOW - DAY + i });
      for (let i = 0; i < 80; i++) insertDelivery(store.db, { id: "ancient-" + i, sub: "busy", at: NOW - 30 * DAY + i });
      insertDelivery(store.db, { id: "edge-keep", sub: "busy", at: cutoff, state: "dead_letter" });
      insertDelivery(store.db, { id: "edge-drop", sub: "busy", at: cutoff - 1, state: "dead_letter" });
      for (let i = 0; i < 3; i++) insertDelivery(store.db, { id: "pending-" + i, sub: "busy", at: NOW - 40 * DAY, state: "pending" });
      for (let i = 0; i < 3; i++) insertDelivery(store.db, { id: "failed-" + i, sub: "busy", at: NOW - 40 * DAY, state: "failed" });
      for (let i = 0; i < 40; i++) insertDelivery(store.db, { id: "quiet-" + i, sub: "quiet", at: NOW - 30 * DAY + i });
    });
    const pruned = store.agentPlugin.pruneWebhookDeliveries();
    assert.equal(pruned.deleted, 81);
    assert.equal(pruned.moreMayRemain, false);
    const count = (sub, state) => store.db.prepare(
      "SELECT COUNT(*) AS n FROM agent_webhook_deliveries WHERE subscription_id=? AND state=?").get(sub, state).n;
    const has = id => Boolean(store.db.prepare("SELECT 1 AS present FROM agent_webhook_deliveries WHERE delivery_id=?").get(id));
    assert.equal(count("busy", "delivered"), 150, "rows inside the window stay even past the newest 100");
    assert.equal(count("busy", "pending"), 3);
    assert.equal(count("busy", "failed"), 3);
    assert.equal(has("edge-keep"), true);
    assert.equal(has("edge-drop"), false);
    assert.equal(has("ancient-0"), false);
    assert.equal(count("quiet", "delivered"), 40, "a short history is kept even when every row is old");
    assert.equal(store.agentPlugin.pruneWebhookDeliveries().deleted, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, events);
    assert.throws(() => store.agentPlugin.pruneWebhookDeliveries({ now: 1.5 }), /retention clock/);
    assert.equal(count("quiet", "delivered"), 40);
  });
});

test("retention deletes old delivered rows in bounded batches and continues on the next tick", () => {
  withStore(store => {
    const total = WEBHOOK_DELIVERY_KEEP + WEBHOOK_DELIVERY_PRUNE_BATCH + 100;
    store.transaction(() => {
      insertSub(store.db, "batch");
      for (let i = 0; i < total; i++) insertDelivery(store.db, { id: "batch-" + i, sub: "batch", at: NOW - 30 * DAY + i });
    });
    const first = store.agentPlugin.pruneWebhookDeliveries();
    assert.equal(first.deleted, WEBHOOK_DELIVERY_PRUNE_BATCH);
    assert.equal(first.moreMayRemain, true);
    assert.equal(first.batchLimit, WEBHOOK_DELIVERY_PRUNE_BATCH);
    const second = store.agentPlugin.pruneWebhookDeliveries();
    assert.equal(second.deleted, 100);
    assert.equal(second.moreMayRemain, false);
    assert.equal(store.agentPlugin.pruneWebhookDeliveries().deleted, 0);
    const newest = store.db.prepare(
      "SELECT delivery_id FROM agent_webhook_deliveries WHERE subscription_id='batch' ORDER BY created_at DESC").all()
      .map(row => row.delivery_id);
    assert.deepEqual(newest, Array.from({ length: WEBHOOK_DELIVERY_KEEP }, (_, i) => "batch-" + (total - 1 - i)));
  });
});
