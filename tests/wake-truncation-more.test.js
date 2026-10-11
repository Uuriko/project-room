// MAX_PENDING_WAKES truncation flag (WAVE-500 guild 5, worker B6).
// Every read path that caps the pending-wake page at 50 signals must
// surface `more` so a host can ack-and-advance to the rest of the queue.
//
// Authoring gate (repo test-audit): each test names the observable
// contract, the credible regression, why existing coverage misses it, and
// confirms no test-only production seam was added.
//
// 1. pendingWakePage boundary at exactly 50 — contract: a full but
//    complete page reports more:false. Regression: an off-by-one probe
//    (LIMIT 50 instead of 51) reporting more:true on a complete page.
// 2. pendingWakePage boundary at 51 — contract: 50 oldest returned with
//    more:true. Regression: probe logic silently swallowing the 51st.
// 3. notePoll surfaces more — contract: GET /api/agent-wakes/poll (the
//    default path for hosts with no wakeUrl) reports truncation the same
//    way POST /api/agent-heartbeats does. Regression (REAL BUG): notePoll
//    returned only the signal array, so a poll-only host with 51+ pending
//    could never learn a second page existed.
// 4. ack advances a truncated page — contract: the 51st signal is
//    reachable by acking the first page (there is no cursor/offset
//    param). Regression: a "fix" that adds paging without keeping
//    ack-to-advance would break pull-only hosts.
//
// Synthetic fixtures only — in-memory SQLite, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AgentHeartbeats, agentHeartbeatSchema, HEARTBEAT_STALE_AFTER_MS } from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at }, { staleAfterMs: HEARTBEAT_STALE_AFTER_MS });
  t.after(() => db.close());
  const enqueueN = (agentId, n) => {
    for (let i = 1; i <= n; i++) {
      at += 1;
      hb.enqueueWake({ agentId, kind: "mention", roomId: "commons", messageId: `m-${i}` });
    }
  };
  return { hb, enqueueN };
}

test("pendingWakePage: exactly 50 pending returns all 50 with more:false", t => {
  const { hb, enqueueN } = unit(t);
  hb.heartbeat({ agentId: "ai_exact", hostId: "h" });
  enqueueN("ai_exact", 50);
  const page = hb.pendingWakePage("ai_exact");
  assert.equal(page.signals.length, 50);
  assert.equal(page.more, false);
  assert.equal(page.signals[0].messageId, "m-1", "oldest first");
  assert.equal(page.signals[49].messageId, "m-50");
});

test("pendingWakePage: 51 pending returns the 50 oldest with more:true", t => {
  const { hb, enqueueN } = unit(t);
  hb.heartbeat({ agentId: "ai_over", hostId: "h" });
  enqueueN("ai_over", 51);
  const page = hb.pendingWakePage("ai_over");
  assert.equal(page.signals.length, 50);
  assert.equal(page.more, true);
  assert.equal(page.signals[0].messageId, "m-1", "oldest first");
  assert.equal(page.signals[49].messageId, "m-50");
  assert.ok(!page.signals.some(s => s.messageId === "m-51"), "the 51st stays queued");
});

test("notePoll surfaces more:true when the poll page is truncated at 50", t => {
  const { hb, enqueueN } = unit(t);
  hb.heartbeat({ agentId: "ai_poller", hostId: "h" });
  enqueueN("ai_poller", 51);
  const poll = hb.notePoll({ agentId: "ai_poller" });
  assert.equal(poll.registered, true);
  assert.equal(poll.pendingWakes.length, 50);
  assert.equal(poll.more, true, "the poll read must report truncation like heartbeat() does");
});

test("notePoll surfaces more:false when the poll page holds the whole queue", t => {
  const { hb, enqueueN } = unit(t);
  hb.heartbeat({ agentId: "ai_poller50", hostId: "h" });
  enqueueN("ai_poller50", 50);
  const poll = hb.notePoll({ agentId: "ai_poller50" });
  assert.equal(poll.pendingWakes.length, 50);
  assert.equal(poll.more, false);
});

test("acking the first page reveals the 51st on the next poll", t => {
  const { hb, enqueueN } = unit(t);
  hb.heartbeat({ agentId: "ai_advance", hostId: "h" });
  enqueueN("ai_advance", 51);
  const first = hb.notePoll({ agentId: "ai_advance" });
  assert.equal(first.pendingWakes.length, 50);
  hb.ackWakes({ agentId: "ai_advance", signalIds: first.pendingWakes.map(s => s.signalId) });
  const second = hb.notePoll({ agentId: "ai_advance" });
  assert.equal(second.pendingWakes.length, 1);
  assert.equal(second.pendingWakes[0].messageId, "m-51");
  assert.equal(second.more, false);
});
