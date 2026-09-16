// Track C slice C6 — tests for src/growth-fanout.js and its wiring in
// src/growth-emit.js. New-file-only coverage: filters, isolation, and the
// fan-out contract; the emit module's existing behavior is untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES, event, replay } from "../src/events.js";
import { seedEvents } from "../src/seed.js";
import { defineEvent } from "../src/growth-events.js";
import { createCollector } from "../src/growth-collector.js";
import { createFanout } from "../src/growth-fanout.js";
import { getGrowthFanout, applyEventWithGrowth } from "../src/growth-emit.js";

const actor = { id: "agent-1", kind: "agent" };
const messageSent = (n = 1) =>
  defineEvent("message.sent", {
    actor,
    source: "system",
    fields: { roomId: "r-1", messageId: `m-${n}` }
  });
const roomCreated = () =>
  defineEvent("room.created", {
    actor: { id: "potter", kind: "human" },
    source: "system",
    fields: { roomId: "r-1", roomKind: "personal" }
  });

test("C6 subscribe returns a subId string and subscriberCount tracks", () => {
  const fanout = createFanout();
  assert.equal(fanout.subscriberCount(), 0);
  const id = fanout.subscribe({ types: ["message.sent"] }, () => {});
  assert.equal(typeof id, "string");
  assert.equal(fanout.subscriberCount(), 1);
  fanout.subscribe(() => true, () => {});
  assert.equal(fanout.subscriberCount(), 2);
});

test("C6 subscribe throws on non-function handler and invalid filters", () => {
  const fanout = createFanout();
  assert.throws(() => fanout.subscribe({ types: ["message.sent"] }, null), TypeError);
  assert.throws(() => fanout.subscribe({ types: ["message.sent"] }, "nope"), TypeError);
  assert.throws(() => fanout.subscribe("message.sent", () => {}), TypeError);
  assert.throws(() => fanout.subscribe({ types: "message.sent" }, () => {}), TypeError);
  assert.throws(() => fanout.subscribe({ types: [] }, () => {}), TypeError);
  assert.throws(() => fanout.subscribe({ types: [""] }, () => {}), TypeError);
  assert.throws(() => fanout.subscribe({ nope: 1 }, () => {}), TypeError);
  assert.throws(() => fanout.subscribe(null, () => {}), TypeError);
});

test("C6 type filters match only the listed types", () => {
  const fanout = createFanout();
  const seen = [];
  fanout.subscribe({ types: ["message.sent"] }, e => seen.push(e.type));
  assert.equal(fanout.notify(messageSent()), 1);
  assert.equal(fanout.notify(roomCreated()), 0);
  assert.deepEqual(seen, ["message.sent"]);
});

test("C6 predicate filters receive the envelope and gate delivery", () => {
  const fanout = createFanout();
  const seen = [];
  fanout.subscribe(env => env.type === "message.sent" && env.actor.kind === "agent", e => seen.push(e.fields.messageId));
  assert.equal(fanout.notify(messageSent(7)), 1);
  assert.equal(fanout.notify(roomCreated()), 0);
  assert.deepEqual(seen, ["m-7"]);
});

test("C6 unsubscribe removes the subscription", () => {
  const fanout = createFanout();
  let calls = 0;
  const id = fanout.subscribe(() => true, () => { calls += 1; });
  assert.equal(fanout.notify(messageSent()), 1);
  assert.equal(fanout.unsubscribe(id), true);
  assert.equal(fanout.subscriberCount(), 0);
  assert.equal(fanout.notify(messageSent()), 0);
  assert.equal(calls, 1);
  assert.equal(fanout.unsubscribe(id), false);
  assert.equal(fanout.unsubscribe("sub-missing"), false);
});

test("C6 a throwing handler does not break other subscribers or the caller", () => {
  const fanout = createFanout();
  const good = [];
  fanout.subscribe(() => true, () => { throw new Error("boom"); });
  fanout.subscribe(() => true, e => good.push(e.type));
  fanout.subscribe({ types: ["room.created"] }, e => good.push(`filtered:${e.type}`));
  const notified = fanout.notify(messageSent());
  assert.equal(notified, 2);
  assert.deepEqual(good, ["message.sent"]);
  assert.equal(fanout.getHandlerFailures(), 1);
});

test("C6 a throwing filter is counted and skips that subscriber", () => {
  const fanout = createFanout();
  const good = [];
  fanout.subscribe(() => { throw new Error("filter boom"); }, () => good.push("bad"));
  fanout.subscribe(() => true, () => good.push("good"));
  assert.equal(fanout.notify(messageSent()), 1);
  assert.deepEqual(good, ["good"]);
  assert.equal(fanout.getHandlerFailures(), 1);
});

test("C6 notify with an invalid envelope is a no-op returning 0", () => {
  const fanout = createFanout();
  let calls = 0;
  fanout.subscribe(() => true, () => { calls += 1; });
  for (const bad of [null, undefined, "x", 42, [], {}, { type: "nope" }]) {
    assert.equal(fanout.notify(bad), 0);
  }
  assert.equal(calls, 0);
  assert.equal(fanout.getHandlerFailures(), 0);
});

test("C6 handlers receive the same frozen envelope reference and cannot mutate it", () => {
  const fanout = createFanout();
  const envelope = messageSent();
  let received = null;
  fanout.subscribe(() => true, e => { received = e; });
  fanout.notify(envelope);
  assert.equal(received, envelope);
  assert.ok(Object.isFrozen(received));
  assert.throws(() => { received.type = "hacked"; }, TypeError);
  assert.equal(envelope.type, "message.sent");
});

test("C6 createFanout instances are independent", () => {
  const a = createFanout();
  const b = createFanout();
  let calls = 0;
  a.subscribe(() => true, () => { calls += 1; });
  b.notify(messageSent());
  assert.equal(calls, 0);
  assert.equal(a.getHandlerFailures(), 0);
});

test("C6 getGrowthFanout exposes the shared hub wired into applyEventWithGrowth", () => {
  const fanout = getGrowthFanout();
  assert.equal(typeof fanout.subscribe, "function");
  assert.equal(typeof fanout.notify, "function");
  const seen = [];
  const subId = fanout.subscribe({ types: ["message.sent"] }, e => seen.push(e.type));
  try {
    const collector = createCollector();
    const state = replay(seedEvents);
    const ROOM = "room-project-room-v0";
    const result = applyEventWithGrowth(
      state,
      event({
        id: "ev-c6",
        type: EVENT_TYPES.MESSAGE_POSTED,
        actorId: "potter",
        roomId: ROOM,
        at: "2026-09-15T19:00:00.000Z",
        data: { messageId: "msg-c6", body: "hello world" }
      }),
      collector
    );
    assert.equal(result.growthOk, true);
    assert.deepEqual(seen, ["message.sent"]);
  } finally {
    fanout.unsubscribe(subId);
  }
});

test("C6 mention envelopes also reach subscribers through applyEventWithGrowth", () => {
  const fanout = getGrowthFanout();
  const mentioned = [];
  const subId = fanout.subscribe({ types: ["agent.mentioned"] }, e => mentioned.push(e.fields.mentionedAgentId));
  try {
    const collector = createCollector();
    const state = replay(seedEvents);
    const ROOM = "room-project-room-v0";
    // Seed data contains an agent member; find one to mention.
    const agentId = Object.keys(state.members).find(id => state.members[id]?.kind === "agent");
    assert.ok(agentId, "seed data should include an agent member");
    const display = state.members[agentId].displayName ?? agentId;
    const result = applyEventWithGrowth(
      state,
      event({
        id: "ev-c6-mention",
        type: EVENT_TYPES.MESSAGE_POSTED,
        actorId: "potter",
        roomId: ROOM,
        at: "2026-09-15T19:01:00.000Z",
        data: { messageId: "msg-c6m", body: `ping @${display} please` }
      }),
      collector
    );
    assert.equal(result.growthOk, true);
    assert.deepEqual(mentioned, [agentId]);
  } finally {
    fanout.unsubscribe(subId);
  }
});
