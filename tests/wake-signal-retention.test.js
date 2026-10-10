// Wake-signal retention (lane5: staying plugged in): an undelivered wake
// signal is a doorbell, not an archive — the message itself stays readable
// via the room event log / return-brief long after the ping stops mattering.
// Signals older than the TTL never surface in pending pages, and a sweep
// deletes stale undelivered rows plus long-acknowledged rows so the table
// stays bounded for agents that go away for a week and come back.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AgentHeartbeats,
  agentHeartbeatSchema,
  HEARTBEAT_STALE_AFTER_MS,
  WAKE_SIGNAL_TTL_MS,
  WAKE_SIGNAL_DELIVERED_RETENTION_MS,
} from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;
const DAY = 24 * 3600 * 1000;

function unit(t, options = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at }, { staleAfterMs: HEARTBEAT_STALE_AFTER_MS, ...options });
  t.after(() => db.close());
  return { hb, db, advance: ms => { at += ms; }, at: () => at };
}

const agent = "ai_returner";

test("retention constants: 7-day signal TTL, 2-day delivered retention", () => {
  assert.equal(WAKE_SIGNAL_TTL_MS, 7 * DAY);
  assert.equal(WAKE_SIGNAL_DELIVERED_RETENTION_MS, 2 * DAY);
});

test("stale undelivered signals never surface in pending pages", t => {
  const { hb, db } = unit(t, { wakeTtlMs: 1000 });
  hb.enqueueWake({ agentId: agent, kind: "mention", roomId: "r1", messageId: "fresh" });
  // A week-old doorbell inserted out-of-band (e.g. written before the TTL
  // shipped): it must not surface even though the sweep hasn't run.
  db.prepare(`INSERT INTO agent_wake_signals
    (signal_id, agent_id, kind, room_id, message_id, created_at, delivered_at)
    VALUES ('ws_stale', ?, 'mention', 'r1', 'old', ?, NULL)`)
    .run(agent, T0 - 8 * DAY);
  const page = hb.pendingWakePage(agent);
  assert.deepEqual(page.signals.map(s => s.messageId), ["fresh"]);
  assert.equal(page.more, false);
});

test("enqueueWake opportunistically sweeps the agent's stale signals", t => {
  const { hb, db, advance } = unit(t, { wakeTtlMs: 1000 });
  hb.enqueueWake({ agentId: agent, kind: "mention", roomId: "r1", messageId: "old" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_wake_signals").get().n, 1);
  advance(2000);
  hb.enqueueWake({ agentId: agent, kind: "mention", roomId: "r1", messageId: "new" });
  const rows = db.prepare("SELECT message_id AS m FROM agent_wake_signals").all();
  assert.deepEqual(rows.map(r => r.m), ["new"], "stale undelivered row swept on enqueue");
});

test("sweepStaleWakes keeps fresh and recently-acked signals", t => {
  const { hb, db } = unit(t, { wakeTtlMs: 1000, deliveredRetentionMs: 2000 });
  // Rows written out-of-band so the sweep-on-enqueue path doesn't preempt them.
  const ins = (id, msg, created, delivered) => db.prepare(`INSERT INTO agent_wake_signals
    (signal_id, agent_id, kind, room_id, message_id, created_at, delivered_at)
    VALUES (?, ?, 'mention', 'r1', ?, ?, ?)`).run(id, agent, msg, created, delivered);
  ins("ws_old", "old", T0 - 5000, null);                 // stale undelivered
  ins("ws_fresh", "fresh", T0, null);                    // fresh undelivered
  ins("ws_acked_recent", "acked", T0 - 5000, T0 - 500);  // acked 0.5s ago — inside retention
  ins("ws_acked_old", "acked_old", T0 - 9000, T0 - 5000);// acked 5s ago — past retention
  const swept = hb.sweepStaleWakes({ agentId: agent });
  assert.equal(swept.sweptStale, 1, "stale undelivered row swept");
  assert.equal(swept.sweptDelivered, 1, "long-acked row purged");
  assert.deepEqual(
    db.prepare("SELECT message_id AS m FROM agent_wake_signals ORDER BY created_at").all().map(r => r.m),
    ["acked", "fresh"], "fresh undelivered and recently-acked rows survive");
});

test("sweepStaleWakes is scoped to the agent", t => {
  const { hb, db, advance } = unit(t, { wakeTtlMs: 1000 });
  hb.enqueueWake({ agentId: agent, kind: "mention", roomId: "r1", messageId: "m1" });
  hb.enqueueWake({ agentId: "ai_other", kind: "mention", roomId: "r1", messageId: "m2" });
  advance(2000);
  hb.sweepStaleWakes({ agentId: agent });
  assert.deepEqual(
    db.prepare("SELECT agent_id AS a FROM agent_wake_signals").all().map(r => r.a),
    ["ai_other"], "other agent's stale rows untouched by a scoped sweep");
});

test("a week-away agent's first heartbeat returns only live doorbells", t => {
  const { hb, advance } = unit(t); // default 7-day TTL
  hb.heartbeat({ agentId: agent, hostId: "h1", mode: "pull-only" });
  hb.enqueueWake({ agentId: agent, kind: "mention", roomId: "r1", messageId: "week-old" });
  advance(8 * DAY); // agent goes away for a week+
  hb.enqueueWake({ agentId: agent, kind: "mention", roomId: "r1", messageId: "today" });
  const resume = hb.heartbeat({ agentId: agent, hostId: "h1", mode: "pull-only" });
  assert.deepEqual(resume.pendingWakes.map(s => s.messageId), ["today"]);
  assert.equal(resume.more, false);
});
