// Wake waiter release robustness (guild 5 worker B1 — wake coalescing bug-hunt).
//
// Authoring gate (repo test-audit): each test names the observable contract,
// the credible regression, why existing coverage misses it, and confirms no
// test-only production seam was added.
//
// 1. A throwing waiter must not wedge the other waiters — contract: one
//    poisoned host's onWake (a bug in the HTTP poll layer's closure, an
//    already-closed response) never starves the agent's other hosts of
//    their wake. Regression: _releaseWakeWaiter called onWake inside the
//    scan loop with no per-waiter guard, so the first throw aborted the
//    loop and every later waiter's slot stayed wedged — the agent looked
//    "woken" while its second host slept forever. Existing coverage (test 3
//    in agent-wake-poll.test.js) only pins coalesced duplicates not
//    releasing waiters; no test ever made a waiter throw.
// 2. Coalesced duplicates never release a waiter (verification probe) —
//    contract: enqueueWake's UNIQUE(agent_id, message_id) coalescing means
//    the second enqueue of the same message returns enqueued:false and the
//    poll waiter keeps waiting for genuinely new work. Regression: a
//    refactor that releases the waiter on every enqueue call (wake storms
//    on re-deliveries). Existing coverage: agent-wake-poll.test.js #3
//    covers this at the unit level; this re-pins it in the two-host shape
//    so the poison test's sibling behavior can't regress silently.
// 3. Different agents may share one messageId (verification probe) —
//    contract: the UNIQUE key is (agent_id, message_id), so a mention that
//    names two agents wakes both. Regression: a uniqueness scope narrowed
//    to message_id alone would drop the second agent's wake.
// 4. null and empty messageIds are rejected (verification probe) —
//    contract: enqueueWake 422s on a null or empty messageId, so the UNIQUE
//    index can never see NULL (SQLite treats NULLs as distinct and would
//    never coalesce them). Regression: a loosened validator silently
//    inserting NULL rows that never coalesce.
// 5. Back-to-back double enqueue coalesces (verification probe) —
//    contract: two synchronous enqueueWake calls for the same message yield
//    enqueued:true then enqueued:false with both returning the same
//    signal. Regression: a race-shaped refactor (read-then-write without
//    the single atomic INSERT OR IGNORE) admitting duplicates.
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
  return { hb, advance: ms => { at += ms; } };
}

test("a throwing waiter does not wedge the agent's other waiters", t => {
  const { hb } = unit(t);
  hb.heartbeat({ agentId: "ai_agent", hostId: "host-a" });
  hb.heartbeat({ agentId: "ai_agent", hostId: "host-b" });
  let goodWoken = 0;
  hb.addWakeWaiter("ai_agent", "host-a", {
    onWake() { throw new Error("poisoned poll layer"); },
  });
  hb.addWakeWaiter("ai_agent", "host-b", { onWake() { goodWoken++; } });
  const first = hb.enqueueWake({ agentId: "ai_agent", kind: "mention", roomId: "muse-room", messageId: "msg-1" });
  assert.equal(first.enqueued, true);
  assert.equal(goodWoken, 1, "the healthy host must still be woken when another host's waiter throws");
});

test("a coalesced duplicate never releases the poll waiter", t => {
  const { hb } = unit(t);
  hb.heartbeat({ agentId: "ai_agent", hostId: "host-a" });
  hb.heartbeat({ agentId: "ai_agent", hostId: "host-b" });
  let wokeA = 0, wokeB = 0;
  hb.addWakeWaiter("ai_agent", "host-a", { onWake() { wokeA++; } });
  hb.addWakeWaiter("ai_agent", "host-b", { onWake() { wokeB++; } });
  const first = hb.enqueueWake({ agentId: "ai_agent", kind: "mention", roomId: "muse-room", messageId: "msg-1" });
  assert.equal(first.enqueued, true);
  assert.equal(wokeA, 1);
  assert.equal(wokeB, 1);
  // Both hosts re-register (the poll loop's shape): now the duplicate arrives.
  hb.addWakeWaiter("ai_agent", "host-a", { onWake() { wokeA++; } });
  hb.addWakeWaiter("ai_agent", "host-b", { onWake() { wokeB++; } });
  const dup = hb.enqueueWake({ agentId: "ai_agent", kind: "mention", roomId: "muse-room", messageId: "msg-1" });
  assert.equal(dup.enqueued, false);
  assert.equal(dup.signal.signalId, first.signal.signalId);
  assert.equal(wokeA, 1, "coalesced duplicate must not release the waiter");
  assert.equal(wokeB, 1, "coalesced duplicate must not release the waiter");
});

test("different agents may share one messageId", t => {
  const { hb } = unit(t);
  hb.heartbeat({ agentId: "ai_one", hostId: "h" });
  hb.heartbeat({ agentId: "ai_two", hostId: "h" });
  const one = hb.enqueueWake({ agentId: "ai_one", kind: "mention", roomId: "muse-room", messageId: "msg-shared" });
  const two = hb.enqueueWake({ agentId: "ai_two", kind: "mention", roomId: "muse-room", messageId: "msg-shared" });
  assert.equal(one.enqueued, true);
  assert.equal(two.enqueued, true);
  assert.notEqual(one.signal.signalId, two.signal.signalId);
});

test("null and empty messageIds are rejected with 422", t => {
  const { hb } = unit(t);
  assert.throws(() => hb.enqueueWake({ agentId: "ai_agent", kind: "mention", messageId: null }), { code: "invalid_wake" });
  assert.throws(() => hb.enqueueWake({ agentId: "ai_agent", kind: "mention", messageId: "" }), { code: "invalid_wake" });
});

test("back-to-back double enqueue coalesces to the same signal", t => {
  const { hb } = unit(t);
  const first = hb.enqueueWake({ agentId: "ai_agent", kind: "mention", roomId: "muse-room", messageId: "msg-race" });
  const second = hb.enqueueWake({ agentId: "ai_agent", kind: "mention", roomId: "muse-room", messageId: "msg-race" });
  assert.equal(first.enqueued, true);
  assert.equal(second.enqueued, false);
  assert.equal(second.signal.signalId, first.signal.signalId);
  assert.equal(hb.pendingWakes("ai_agent").length, 1);
});
