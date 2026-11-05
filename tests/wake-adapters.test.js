// Wake adapters (server/wake-adapters.mjs).
// Contract: off unless ROOM_WAKE_ADAPTERS is set; outbound bodies carry ids
// only; bursts coalesce per agent and room; unread wakes are re-sent a
// bounded number of times; an ack stops re-waking.
import test from "node:test";
import assert from "node:assert/strict";
import { WakeCoalescer, buildAdapterBody, createWakeAdapters, inferAdapterKind, wakeAdaptersEnabled } from "../server/wake-adapters.mjs";

test("flag is off by default and on only for explicit values", () => {
  assert.equal(wakeAdaptersEnabled({}), false);
  assert.equal(wakeAdaptersEnabled({ ROOM_WAKE_ADAPTERS: "0" }), false);
  for (const v of ["1", "true", "on"]) assert.equal(wakeAdaptersEnabled({ ROOM_WAKE_ADAPTERS: v }), true);
  assert.equal(createWakeAdapters({}).enabled, false);
});

test("adapter kind is inferred from the target url", () => {
  assert.equal(inferAdapterKind("https://api.github.com/repos/o/r/dispatches"), "github_dispatch");
  assert.equal(inferAdapterKind("https://api.anthropic.com/v1/claude_code/routines/abc/fire"), "claude_routine");
  assert.equal(inferAdapterKind("https://relay.example.com/wake"), "generic");
  assert.equal(inferAdapterKind("not a url"), "generic");
});

test("bodies are content-free: ids only, unsafe values dropped", () => {
  const signal = { signalId: "sig_1", roomId: "room-a", reason: "mention", body: "secret text", title: "x" };
  for (const kind of ["github_dispatch", "claude_routine", "generic"]) {
    const text = JSON.stringify(buildAdapterBody({ kind, agentId: "ai_1", signal }));
    assert.ok(!text.includes("secret text"), kind);
  }
  const gh = buildAdapterBody({ kind: "github_dispatch", agentId: "ai_1", signal });
  assert.equal(gh.event_type, "room-wake");
  assert.deepEqual(Object.keys(gh.client_payload).sort(), ["agentId", "attempt", "coalesced", "context", "reason", "roomId", "signalId"]);
  const bad = buildAdapterBody({ kind: "generic", agentId: "ai_1", signal: { signalId: "<script>", roomId: "a b" } });
  assert.equal(bad.signalId, null); assert.equal(bad.roomId, null); assert.equal(bad.reason, "wake");
  assert.throws(() => buildAdapterBody({ kind: "nope", agentId: "ai_1" }));
  assert.throws(() => buildAdapterBody({ kind: "generic", agentId: "" }));
});

test("bursts coalesce per agent and room, and the next wake carries the count", () => {
  let now = 0; const c = new WakeCoalescer(() => now, { windowMs: 1000 });
  assert.equal(c.offer("a", { roomId: "r" }).send, true);
  assert.equal(c.offer("a", { roomId: "r" }).send, false);
  assert.equal(c.offer("a", { roomId: "r" }).send, false);
  assert.equal(c.offer("a", { roomId: "r2" }).send, true, "other room is separate");
  assert.equal(c.offer("b", { roomId: "r" }).send, true, "other agent is separate");
  now = 1500;
  assert.deepEqual(c.offer("a", { roomId: "r" }), { send: true, count: 3 });
});

test("unread wakes are re-sent up to maxRewakes; an ack stops them", () => {
  let now = 0; const c = new WakeCoalescer(() => now, { windowMs: 10, rewakeAfterMs: 100, maxRewakes: 2 });
  c.offer("a", { roomId: "r", signalId: "s1" }); c.offer("b", { roomId: "r", signalId: "s2" });
  now = 50; assert.equal(c.dueRewakes().length, 0);
  now = 100; c.markRead("b", null);
  const first = c.dueRewakes();
  assert.equal(first.length, 1); assert.equal(first[0].agentId, "a"); assert.equal(first[0].signal.reason, "rewake"); assert.equal(first[0].attempt, 1);
  now = 200; assert.equal(c.dueRewakes().length, 1);
  now = 300; assert.equal(c.dueRewakes().length, 0, "bounded");
});

test("evicts oldest keys past maxKeys", () => {
  const c = new WakeCoalescer(() => 0, { maxKeys: 2 });
  c.offer("a", {}); c.offer("b", {}); c.offer("c", {});
  assert.equal(c.keys.size, 2);
});

test("context pointer names where to read, and liveness moves pending -> unresponsive -> stale", () => {
  const body = buildAdapterBody({ kind: "generic", agentId: "ai_1", signal: { signalId: "s", roomId: "r" } });
  assert.equal(body.context.tool, "room_needs_me"); assert.equal(body.context.roomId, "r");
  let now = 0; const c = new WakeCoalescer(() => now);
  assert.equal(c.status("a", "r"), "idle");
  c.offer("a", { roomId: "r" });
  assert.equal(c.status("a", "r"), "pending");
  now = 10_000; assert.equal(c.status("a", "r"), "unresponsive");
  now = 30 * 60_000; assert.equal(c.status("a", "r"), "stale");
  c.markRead("a", "r"); assert.equal(c.status("a", "r"), "acked");
});

test('a fresh coalesced generation has its own bounded retry budget and ack', () => {
  let now = 0;
  const c = new WakeCoalescer(() => now);
  const signal = signalId => ({ roomId: 'r', signalId, reason: 'mention' });
  c.offer('a', signal('old'));
  for (now = 300000; now <= 600000; now += 300000) assert.equal(c.dueRewakes().length, 1);
  now = 600001;
  assert.equal(c.offer('a', signal('fresh')).send, false, 'keep the burst window');
  const generationStatus = c.status('a', 'r');
  now = 900001;
  const next = c.dueRewakes();
  assert.equal(next.length, 1); assert.equal(next[0].signal.signalId, 'fresh');
  assert.equal(generationStatus, 'pending');
  assert.equal(next[0].attempt, 1); assert.equal(next[0].count, 2);
  now = 1200001; assert.equal(c.dueRewakes()[0].attempt, 2);
  now = 1200002; c.offer('a', signal('fresh'));
  now = 1500002; assert.equal(c.dueRewakes().length, 0, 'same signal does not renew exhausted retries');
  now = 1500003; c.offer('a', signal('acked-next')); c.markRead('a', 'r');
  now = 1800003; assert.equal(c.dueRewakes().length, 0, 'ack stops the new generation');
});
