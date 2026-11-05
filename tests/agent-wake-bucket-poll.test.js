// Wake-loop guard over the real HTTP poll (review ask on #5745).
//
// Contract: when the per-(agent, room) bucket is empty, a held
// GET /api/agent-wakes/poll is not released early, but the post-wait read
// still returns every queued signal, including the throttled one, and ack
// drains them all. The cost is bounded by the poll's own waitMs (room-acp
// holds 25000 ms on its first page), never a lost signal.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import { wakeBucketLimits } from "../server/agent-wake-bucket.mjs";

async function serve(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const identity = f.store.identities.create("wake-bucket-agent");
  linkWithProof(f.store, f.keys.owner, "commons", identity, { memberId: "loopagent", displayName: "Loop Agent", permissions: ["accept_work"] });
  const call = (path, init = {}) => fetch(`${origin}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${identity.secret}` } }).then(r => r.json());
  await call("/api/agent-heartbeats", { method: "POST", body: JSON.stringify({ hostId: "loop-host", mode: "wakeable" }) });
  const hb = f.store.agentHeartbeats;
  const enqueue = messageId => hb.enqueueWake({ agentId: identity.identityId, kind: "mention", roomId: "commons", messageId });
  const poll = waitMs => call(`/api/agent-wakes/poll?hostId=loop-host&waitMs=${waitMs}`);
  const ack = signalIds => call("/api/agent-heartbeats/ack", { method: "POST", body: JSON.stringify({ signalIds }) });
  return { identity, hb, enqueue, poll, ack, call, fixture: f };
}

const timed = async promise => { const start = performance.now(); const value = await promise; return { value, ms: performance.now() - start }; };
const later = (ms, fn) => new Promise(resolve => setTimeout(() => resolve(fn()), ms));

test("in budget: a held poll is released as soon as a wake is queued", async t => {
  const f = await serve(t);
  const held = timed(f.poll(3000));
  await later(100, () => assert.equal(f.enqueue("m-in").throttled, undefined));
  const { value, ms } = await held;
  assert.ok(ms < 1500, `released early (${Math.round(ms)} ms)`);
  assert.deepEqual(value.pendingWakes.map(w => w.messageId), ["m-in"]);
});

test("over budget: the held poll rides out waitMs, then returns every queued signal and ack drains them", async t => {
  const f = await serve(t);
  // Spend the bucket with queued in-budget wakes the agent has not handled yet.
  const spent = [];
  for (let i = 0; i < wakeBucketLimits.capacity; i += 1) spent.push(f.enqueue(`m-${i}`));
  assert.ok(spent.every(r => r.throttled === undefined));
  const first = await f.poll(0);
  assert.equal(first.pendingWakes.length, wakeBucketLimits.capacity);
  const acked = await f.ack(first.pendingWakes.map(w => w.signalId));
  assert.equal(acked.acknowledged.length, wakeBucketLimits.capacity, "no ack lost");
  // The agent re-polls with nothing pending; the next wake is over budget.
  const WAIT = 1200;
  const held = timed(f.poll(WAIT));
  await later(100, () => { const r = f.enqueue("m-over"); assert.equal(r.enqueued, true); assert.equal(r.throttled, true); });
  const { value, ms } = await held;
  assert.ok(ms >= WAIT - 100, `not released early (${Math.round(ms)} ms of ${WAIT})`);
  assert.deepEqual(value.pendingWakes.map(w => w.messageId), ["m-over"], "the throttled signal is delivered by the same poll");
  const drained = await f.ack(value.pendingWakes.map(w => w.signalId));
  assert.equal(drained.acknowledged.length, 1);
  assert.deepEqual((await f.poll(0)).pendingWakes, [], "nothing left behind");
  t.diagnostic(`extra wait for an over-budget wake: ${Math.round(ms - 100)} ms at waitMs=${WAIT}; bounded by waitMs (room-acp first page holds 25000 ms)`);
});

// Behavior, not just the code path: a real mention posted in a reply wakes
// the agent's held poll within one poll cycle, and a ping-pong of replies
// that keep mentioning it gets throttled after the bucket is spent.
const mentionReply = (f, keys, store, n, replyToId) => store.command(keys.owner, "commons", {
  id: `pp-${n}`, type: "message.posted",
  data: { messageId: `pp-${n}`, body: `<@loopagent> ping ${n}`, ...(replyToId ? { replyToId } : {}) } });

test("a real mention in a reply releases the held poll within one poll cycle", async t => {
  const f = await serve(t);
  const held = timed(f.poll(3000));
  await later(100, () => mentionReply(f, f.fixture.keys, f.fixture.store, 0));
  const { value, ms } = await held;
  assert.ok(ms < 1500, `woken within one cycle (${Math.round(ms)} ms of 3000)`);
  assert.ok(value.pendingWakes.some(w => w.messageId === "pp-0"), "wake names the mentioning message");
});

for (const delayedFirstResponse of [false, true]) test(`ping-pong: actual bucket decisions cap replies${delayedFirstResponse ? " despite a slow poll response" : ""}`, async t => {
  const f = await serve(t);
  // Freeze only token refill, not HTTP timers, so a slow CI host cannot refill
  // the bucket while this finite burst is being asserted.
  const bucketAt = f.fixture.store.now();
  f.hb.wakeBucket.now = () => bucketAt;
  const decisions = new Map();
  const enqueue = f.hb.enqueueWake.bind(f.hb);
  f.hb.enqueueWake = args => {
    const result = enqueue(args);
    if (result.enqueued && args.agentId === f.identity.identityId) decisions.set(args.messageId, result);
    return result;
  };
  const addWaiter = f.hb.addWakeWaiter.bind(f.hb);
  const WAIT = 400;
  let throttledAt = null;
  for (let i = 1; i <= wakeBucketLimits.capacity + 1; i += 1) {
    let ready, wakeReleased = false;
    const registered = new Promise(resolve => { ready = resolve; });
    f.hb.addWakeWaiter = (agentId, hostId, options) => {
      const release = addWaiter(agentId, hostId, { ...options, onWake: () => {
        wakeReleased = true; options.onWake();
      } });
      ready(); return release;
    };
    const held = timed(f.poll(WAIT).then(async value => {
      // Reproduce a slow host/network response after the server made its
      // decision. Elapsed time alone must never relabel it as throttled.
      if (delayedFirstResponse && i === 1) await later(WAIT, () => {});
      return value;
    }));
    await registered;
    mentionReply(f, f.fixture.keys, f.fixture.store, i, i > 1 ? `pp-${i - 1}` : undefined);
    const { value, ms } = await held;
    const decision = decisions.get(`pp-${i}`);
    assert.ok(decision?.enqueued, `turn ${i} produced a new wake`);
    assert.ok(value.pendingWakes.some(w => w.messageId === `pp-${i}`), `turn ${i} signal still delivered`);
    const ids = value.pendingWakes.map(w => w.signalId);
    assert.deepEqual((await f.ack(ids)).acknowledged.sort(), ids.sort(), `turn ${i} ack drains every delivered signal`);
    if (decision.throttled) {
      assert.equal(wakeReleased, false, "over-budget mention must not release the held waiter");
      assert.ok(ms >= WAIT - 50, `over-budget poll still holds for waitMs (${Math.round(ms)} ms)`);
      throttledAt = i; break;
    }
    assert.equal(wakeReleased, true, `in-budget turn ${i} releases its registered waiter`);
  }
  assert.equal(throttledAt, wakeBucketLimits.capacity + 1, "first capacity turns release the waiter, the next is throttled");
  assert.deepEqual((await f.poll(0)).pendingWakes, [], "ack leaves no signal behind");
  t.diagnostic(`actual bucket throttled at turn ${throttledAt}; delayed first response=${delayedFirstResponse}; every signal delivered and acknowledged`);
});

// Root review on #5745: a wake queued BEFORE the next poll, while the bucket
// is empty, used to return at once, so turns were not capped. Now a page of
// only over-budget signals holds for waitMs once, then delivers them.
test("over budget, queued before the poll: the poll still holds, so model turns are capped", async t => {
  const f = await serve(t);
  for (let i = 0; i < wakeBucketLimits.capacity; i += 1) f.enqueue(`q-${i}`);
  await f.ack((await f.poll(0)).pendingWakes.map(w => w.signalId));
  assert.equal(f.enqueue("q-over").throttled, true);
  const WAIT = 800;
  const { value, ms } = await timed(f.poll(WAIT));
  assert.ok(ms >= WAIT - 100, `held, not immediate (${Math.round(ms)} ms of ${WAIT})`);
  assert.deepEqual(value.pendingWakes.map(w => w.messageId), ["q-over"], "delivered after the hold");
  // Held at most once: a re-poll before ack returns at once.
  const again = await timed(f.poll(WAIT));
  assert.ok(again.ms < 300, `second poll not held again (${Math.round(again.ms)} ms)`);
  assert.deepEqual(again.value.pendingWakes.map(w => w.messageId), ["q-over"]);
  // waitMs=0 never holds.
  assert.equal(f.enqueue("q-over-2").throttled, true);
  const zero = await timed(f.poll(0));
  assert.ok(zero.ms < 300);
  t.diagnostic(`turn cap: over-budget turn waited ${Math.round(ms)} ms at waitMs=${WAIT}; sustained rate bounded by refill ${wakeBucketLimits.refillPerMinute}/min or one turn per waitMs`);
});

test("pingpong with pre-queued wakes: turns past the burst each cost a full waitMs", async t => {
  const f = await serve(t);
  const WAIT = 300, turns = wakeBucketLimits.capacity + 4;
  const start = performance.now(); let slow = 0;
  for (let i = 0; i < turns; i += 1) {
    f.enqueue(`pq-${i}`); // reply lands before the agent polls again
    const { value, ms } = await timed(f.poll(WAIT));
    await f.ack(value.pendingWakes.map(w => w.signalId));
    if (ms >= WAIT - 50) slow += 1;
  }
  assert.equal(slow, turns - wakeBucketLimits.capacity, "every turn past capacity is held");
  t.diagnostic(`${turns} turns in ${Math.round(performance.now() - start)} ms; ${slow} held turns`);
});


for (const kind of ["ask", "assignment"]) test(`${kind} bypasses an exhausted chat bucket for an actually held poll`, async t => {
  const f = await serve(t);
  for (let i = 0; i < wakeBucketLimits.capacity; i++) f.enqueue(`burst-${i}`);
  await f.ack((await f.poll(0)).pendingWakes.map(w => w.signalId));
  // Wait for actual waiter registration, not an arbitrary sleep before enqueue.
  let ready;
  const registered = new Promise(resolve => { ready = resolve; });
  const add = f.hb.addWakeWaiter.bind(f.hb);
  f.hb.addWakeWaiter = (...args) => { const release = add(...args); ready(); return release; };
  const held = timed(f.poll(2500));
  await registered;
  const queued = f.hb.enqueueWake({ agentId: f.identity.identityId, roomId: "commons", kind, messageId: `obligation-${kind}` });
  const { value, ms } = await held;
  assert.ok(ms < 1500, `obligation should release held poll, waited ${ms}ms`);
  assert.equal(queued.throttled, undefined);
  assert.ok(value.pendingWakes.some(w => w.signalId === queued.signal.signalId));
  assert.deepEqual((await f.ack([queued.signal.signalId])).acknowledged, [queued.signal.signalId]);
  assert.equal(f.enqueue("ordinary-still-over").throttled, true, "ordinary quota was not raised");
});

test("heartbeat delivery clears throttle bookkeeping without acknowledging", async t => {
  const f = await serve(t);
  for (let i = 0; i < wakeBucketLimits.capacity; i++) f.enqueue(`spent-${i}`);
  await f.ack((await f.poll(0)).pendingWakes.map(w => w.signalId));
  const first = f.enqueue("delivered-by-heartbeat").signal;
  const beat = await f.call("/api/agent-heartbeats", { method: "POST", body: JSON.stringify({ hostId: "loop-host", mode: "wakeable" }) });
  assert.ok(beat.pendingWakes.some(w => w.signalId === first.signalId));
  assert.equal(f.hb.holdForWakeBudget(f.identity.identityId, [first]), false, "heartbeat-delivered signal should not be delayed again");
  assert.ok(f.hb.pendingWakes(f.identity.identityId).some(w => w.signalId === first.signalId), "heartbeat is not an ack");
 });

test("only successful scoped ack clears throttle bookkeeping", async t => {
  const f = await serve(t);
  for (let i = 0; i < wakeBucketLimits.capacity; i++) f.enqueue(`spent-${i}`);
  await f.ack((await f.poll(0)).pendingWakes.map(w => w.signalId));
  const second = f.enqueue("ack-scoped").signal;
  assert.deepEqual(f.hb.ackWakes({ agentId: f.identity.identityId, signalIds: [second.signalId], roomId: "wrong-room" }).acknowledged, []);
  assert.equal(f.hb.holdForWakeBudget(f.identity.identityId, [second]), true, "wrong-room ack cannot clear the mark");
  const third = f.enqueue("ack-real").signal;
  assert.deepEqual((await f.ack([third.signalId])).acknowledged, [third.signalId]);
  assert.equal(f.hb.holdForWakeBudget(f.identity.identityId, [third]), false, "successful ack removes bookkeeping");
  assert.ok(f.hb.pendingWakes(f.identity.identityId).some(w => w.signalId === second.signalId));
});
