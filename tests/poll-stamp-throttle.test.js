// PERF-F-S2: poll-activity stamp throttling.
// Contract: recordPollActivity (via notePoll / heartbeat) rewrites a
// liveness stamp only once the existing stamp is at least
// POLL_STAMP_THROTTLE_MS (60s) old. The stamp's consumer
// (wakeStatusOf / wakeStatusList) works on a 24h window, so minute-level
// freshness loses nothing; the unthrottled shape wrote twice per wake
// long-poll cycle — 288 SQLite writes per seat-hour at a 25s wait.
// Regression this pins: a refactor that drops the throttle restores the
// write wall; a throttle that never rewrites (or rewrites only the
// global row) starves liveness for actively polling agents.
// Synthetic fixtures only — in-memory DB, injected clock.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AgentHeartbeats,
  agentHeartbeatSchema,
  POLL_STAMP_THROTTLE_MS,
} from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at });
  t.after(() => db.close());
  return { db, hb, advance: ms => { at += ms; }, at: () => at };
}

assert.equal(POLL_STAMP_THROTTLE_MS, 60_000);

test("a poll inside 60s of the last stamp does not rewrite it", t => {
  const { hb, advance } = unit(t);
  hb.heartbeat({ agentId: "ai_throttled", hostId: "h" });
  advance(25_000);
  hb.notePoll({ agentId: "ai_throttled" });
  assert.equal(hb.wakeStatusOf("ai_throttled").lastPolledAt, T0,
    "25s-old stamp is fresh: the poll's write is skipped");
  advance(25_000);
  hb.notePoll({ agentId: "ai_throttled" });
  assert.equal(hb.wakeStatusOf("ai_throttled").lastPolledAt, T0,
    "50s-old stamp is still fresh: the second poll in the cycle is skipped too");
  assert.equal(hb.wakeStatusOf("ai_throttled").wakeable, true,
    "the agent stays wakeable on the un-rewritten stamp");
});

test("a stamp older than 60s still writes — no liveness starvation", t => {
  const { hb, advance, at } = unit(t);
  hb.heartbeat({ agentId: "ai_starved", hostId: "h" });
  advance(25_000);
  hb.notePoll({ agentId: "ai_starved" }); // throttled, stamp stays at T0
  advance(36_000); // the stored stamp is now 61s old
  hb.notePoll({ agentId: "ai_starved" });
  assert.equal(hb.wakeStatusOf("ai_starved").lastPolledAt, at(),
    "a >60s-stale stamp is rewritten by the next poll");
  assert.equal(at(), T0 + 61_000);
});

test("a stamp exactly 60s old writes (the wake-live boundary)", t => {
  const { hb, advance, at } = unit(t);
  hb.heartbeat({ agentId: "ai_edge", hostId: "h" });
  advance(POLL_STAMP_THROTTLE_MS);
  hb.notePoll({ agentId: "ai_edge" });
  assert.equal(hb.wakeStatusOf("ai_edge").lastPolledAt, at());
});

test("room-scoped stamps throttle per room row, independently of the global row", t => {
  const { hb, advance } = unit(t);
  hb.heartbeat({ agentId: "ai_scoped", hostId: "h" });
  hb.notePoll({ agentId: "ai_scoped", roomId: "room-a" });
  assert.equal(hb.roomActivityOf("ai_scoped").length, 1);
  assert.equal(hb.roomActivityOf("ai_scoped")[0].lastPolledAt, T0);
  advance(30_000);
  hb.notePoll({ agentId: "ai_scoped", roomId: "room-a" });
  assert.equal(hb.roomActivityOf("ai_scoped")[0].lastPolledAt, T0,
    "30s-old room stamp is not rewritten");
  hb.notePoll({ agentId: "ai_scoped", roomId: "room-b" });
  assert.equal(hb.roomActivityOf("ai_scoped").find(row => row.roomId === "room-b")?.lastPolledAt, T0 + 30_000,
    "a different room's first stamp writes immediately");
  advance(31_000); // room-a stamp now 61s old
  hb.notePoll({ agentId: "ai_scoped", roomId: "room-a" });
  assert.equal(hb.roomActivityOf("ai_scoped").find(row => row.roomId === "room-a")?.lastPolledAt, T0 + 61_000,
    "the stale room stamp writes again");
});
