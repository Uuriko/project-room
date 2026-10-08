// REL-09: stale wake signals fill the poll queue (50 pending mention signals
// measured on prod, oldest >24h, every poll returning the same page).
// ROOM_WAKE_SIGNAL_TTL_HOURS (off by default) hides signals older than the
// TTL from the poll page. Nothing is deleted or acked; the flag off keeps
// current behavior; a bad value is a 500 invalid_heartbeat_config. The page
// also reports wakeQueueStats {pending, oldestCreatedAt, stale, ttlMs}.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AgentHeartbeats, agentHeartbeatSchema } from "../server/agent-heartbeats.mjs";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const HOUR = 3600 * 1000;
const ENV_KEY = "ROOM_WAKE_SIGNAL_TTL_HOURS";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  const clock = { now: NOW };
  const hb = new AgentHeartbeats({ db, now: () => clock.now });
  const saved = process.env[ENV_KEY];
  t.after(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
    db.close();
  });
  return { hb, clock };
}

function enqueueAt(hb, clock, atMs, messageId) {
  clock.now = atMs;
  return hb.enqueueWake({ agentId: "ai_x", kind: "mention", roomId: "r", messageId }).signal;
}

test("flag off returns every unacknowledged signal (current behavior)", t => {
  const { hb, clock } = fixture(t);
  delete process.env[ENV_KEY];
  enqueueAt(hb, clock, NOW - 48 * HOUR, "old");
  enqueueAt(hb, clock, NOW - 1 * HOUR, "new");
  const page = hb.pendingWakePage("ai_x");
  assert.equal(page.signals.length, 2);
  assert.deepEqual(page.wakeQueueStats, {
    pending: 2,
    oldestCreatedAt: NOW - 48 * HOUR,
    stale: 0,
    ttlMs: null,
  });
});

test("flag on hides signals older than the TTL but keeps recent ones", t => {
  const { hb, clock } = fixture(t);
  process.env[ENV_KEY] = "24";
  enqueueAt(hb, clock, NOW - 48 * HOUR, "old");
  enqueueAt(hb, clock, NOW - 1 * HOUR, "new");
  const page = hb.pendingWakePage("ai_x");
  assert.equal(page.signals.length, 1);
  assert.equal(page.signals[0].messageId, "new");
  assert.deepEqual(page.wakeQueueStats, {
    pending: 2,
    oldestCreatedAt: NOW - 48 * HOUR,
    stale: 1,
    ttlMs: 24 * HOUR,
  });
});

test("hidden signals are not deleted: ack still clears them", t => {
  const { hb, clock } = fixture(t);
  process.env[ENV_KEY] = "24";
  const old = enqueueAt(hb, clock, NOW - 48 * HOUR, "old");
  enqueueAt(hb, clock, NOW - 1 * HOUR, "new");
  assert.equal(hb.pendingWakePage("ai_x").signals.length, 1);
  const { acknowledged } = hb.ackWakes({ agentId: "ai_x", signalIds: [old.signalId] });
  assert.deepEqual(acknowledged, [old.signalId]);
  const page = hb.pendingWakePage("ai_x");
  assert.equal(page.wakeQueueStats.pending, 1);
  assert.equal(page.wakeQueueStats.stale, 0);
});

test("a bad flag value is a 500 invalid_heartbeat_config", t => {
  const { hb, clock } = fixture(t);
  enqueueAt(hb, clock, NOW - 1 * HOUR, "new");
  for (const bad of ["banana", "-3", "0"]) {
    process.env[ENV_KEY] = bad;
    assert.throws(
      () => hb.pendingWakePage("ai_x"),
      err => err.status === 500 && err.code === "invalid_heartbeat_config",
      `ROOM_WAKE_SIGNAL_TTL_HOURS=${JSON.stringify(bad)}`
    );
  }
});

test("nothing stale with the flag on: stats stay clean", t => {
  const { hb, clock } = fixture(t);
  process.env[ENV_KEY] = "24";
  enqueueAt(hb, clock, NOW - 1 * HOUR, "new");
  const page = hb.pendingWakePage("ai_x");
  assert.equal(page.signals.length, 1);
  assert.deepEqual(page.wakeQueueStats, {
    pending: 1,
    oldestCreatedAt: NOW - 1 * HOUR,
    stale: 0,
    ttlMs: 24 * HOUR,
  });
});

test("empty queue reports zeroed stats", t => {
  const { hb } = fixture(t);
  process.env[ENV_KEY] = "24";
  const page = hb.pendingWakePage("ai_x");
  assert.equal(page.signals.length, 0);
  assert.deepEqual(page.wakeQueueStats, {
    pending: 0,
    oldestCreatedAt: null,
    stale: 0,
    ttlMs: 24 * HOUR,
  });
});
