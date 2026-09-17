import test from "node:test";
import assert from "node:assert/strict";
import { createCollector, DEFAULT_MAX_EVENTS, DEFAULT_QUERY_LIMIT } from "../src/growth-collector.js";
import { defineEvent } from "../src/growth-events.js";

const at = minute => `2026-09-15T16:${String(minute).padStart(2, "0")}:00.000Z`;
const human = { id: "zoe", kind: "human" };
const agent = { id: "agent-7", kind: "agent" };

const messageSent = (over = {}) =>
  defineEvent("message.sent", {
    actor: human,
    source: "web",
    occurredAt: at(0),
    fields: { roomId: "r1", messageId: "m1" },
    ...over
  });

test("C2 record accepts valid events with monotonic ids and updates stats", () => {
  const c = createCollector();
  const a = c.record(messageSent());
  const b = c.record(defineEvent("reaction.added", { actor: agent, source: "web", occurredAt: at(1), fields: { roomId: "r1", messageId: "m1", reaction: "thumbsup" } }));
  assert.deepEqual(a, { ok: true, id: 1 });
  assert.deepEqual(b, { ok: true, id: 2 });
  const s = c.stats();
  assert.equal(s.total, 2);
  assert.equal(s.recorded, 2);
  assert.equal(s.dropped, 0);
  assert.deepEqual(s.perType, { "message.sent": 1, "reaction.added": 1 });
  assert.deepEqual(s.perActor, { human: 1, agent: 1 });
  assert.equal(s.oldest, at(0));
  assert.equal(s.newest, at(1));
  assert.equal(s.capacity, DEFAULT_MAX_EVENTS);
});

test("C2 record rejects invalid events without storing them", () => {
  const c = createCollector();
  const bad = c.record({ type: "message.sent", schemaVersion: "1.0", occurredAt: at(0), actor: human, source: "web", privacyClass: "public-in-room", fields: { roomId: "r1" } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /missing required field "messageId"/);
  assert.equal(c.stats().total, 0);
  assert.equal(c.stats().recorded, 0);
  assert.equal(c.record(null).ok, false);
  assert.equal(c.record("nope").ok, false);
});

test("C2 record rejects the never-collect privacy class", () => {
  const c = createCollector();
  const tampered = { ...messageSent(), privacyClass: "never-collect" };
  const res = c.record(tampered);
  assert.equal(res.ok, false);
  assert.match(res.reason, /privacy class/i);
  assert.equal(c.stats().total, 0);
});

test("C2 ring buffer evicts oldest on overflow and counts drops", () => {
  const c = createCollector({ maxEvents: 3 });
  for (let i = 0; i < 5; i += 1) {
    const res = c.record(messageSent({ occurredAt: at(i), fields: { roomId: "r1", messageId: `m${i}` } }));
    assert.equal(res.ok, true);
    assert.equal(res.id, i + 1);
  }
  const s = c.stats();
  assert.equal(s.total, 3);
  assert.equal(s.recorded, 5);
  assert.equal(s.dropped, 2);
  assert.equal(s.recorded, s.total + s.dropped);
  const got = c.query({});
  assert.equal(got.length, 3);
  assert.deepEqual(got.map(e => e.fields.messageId), ["m4", "m3", "m2"]);
  assert.equal(s.oldest, at(2));
  assert.equal(s.newest, at(4));
});

test("C2 query filters by type", () => {
  const c = createCollector();
  c.record(messageSent());
  c.record(defineEvent("work.proposed", { actor: human, source: "web", occurredAt: at(1), fields: { roomId: "r1", workItemId: "w1" } }));
  const got = c.query({ type: "work.proposed" });
  assert.equal(got.length, 1);
  assert.equal(got[0].type, "work.proposed");
  assert.equal(c.query({ type: "room.created" }).length, 0);
});

test("C2 query filters by actor id or actor kind", () => {
  const c = createCollector();
  c.record(messageSent());
  c.record(messageSent({ actor: agent, occurredAt: at(1) }));
  const byId = c.query({ actor: "agent-7" });
  assert.equal(byId.length, 1);
  assert.equal(byId[0].actor.id, "agent-7");
  const byKind = c.query({ actor: "human" });
  assert.equal(byKind.length, 1);
  assert.equal(byKind[0].actor.kind, "human");
});

test("C2 query filters by time window and returns newest first", () => {
  const c = createCollector();
  for (let i = 0; i < 4; i += 1) c.record(messageSent({ occurredAt: at(i), fields: { roomId: "r1", messageId: `m${i}` } }));
  const window = c.query({ since: at(1), until: at(2) });
  assert.deepEqual(window.map(e => e.fields.messageId), ["m2", "m1"]);
  const from = c.query({ since: at(3) });
  assert.deepEqual(from.map(e => e.fields.messageId), ["m3"]);
  const all = c.query({});
  assert.deepEqual(all.map(e => e.fields.messageId), ["m3", "m2", "m1", "m0"]);
});

test("C2 query limit is capped", () => {
  const c = createCollector();
  for (let i = 0; i < 5; i += 1) c.record(messageSent({ occurredAt: at(i), fields: { roomId: "r1", messageId: `m${i}` } }));
  assert.equal(c.query({ limit: 2 }).length, 2);
  assert.equal(c.query({}).length, 5);
  assert.ok(c.query({}).length <= DEFAULT_QUERY_LIMIT);
  assert.throws(() => c.query({ limit: 0 }), /positive integer/);
  assert.throws(() => c.query({ limit: 1.5 }), /positive integer/);
  assert.throws(() => c.query({ since: "not-a-time" }), /timestamp/);
  assert.throws(() => c.query({ until: "" }), /timestamp/);
});

test("C2 default-deny flows through C1 validation on record", () => {
  const c = createCollector();
  const base = { type: "message.sent", schemaVersion: "1.0", occurredAt: at(0), actor: human, source: "web", privacyClass: "public-in-room" };
  const unknown = c.record({ ...base, fields: { roomId: "r1", messageId: "m1", debug: true } });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /does not collect field "debug"/);
  const body = c.record({ ...base, fields: { roomId: "r1", messageId: "m1", body: "hello" } });
  assert.equal(body.ok, false);
  assert.match(body.reason, /does not collect|sensitive/);
  const secret = c.record({ ...base, fields: { roomId: "r1", messageId: "m1", apiKey: "x" } });
  assert.equal(secret.ok, false);
  assert.match(secret.reason, /does not collect|sensitive/);
  assert.equal(c.stats().total, 0);
});

test("C2 createCollector requires a positive integer capacity", () => {
  assert.throws(() => createCollector({ maxEvents: 0 }), /positive integer/);
  assert.throws(() => createCollector({ maxEvents: -5 }), /positive integer/);
  assert.throws(() => createCollector({ maxEvents: 2.5 }), /positive integer/);
  assert.throws(() => createCollector({ maxEvents: "many" }), /positive integer/);
  const one = createCollector({ maxEvents: 1 });
  one.record(messageSent({ occurredAt: at(0) }));
  one.record(messageSent({ occurredAt: at(1), fields: { roomId: "r1", messageId: "m2" } }));
  assert.equal(one.stats().total, 1);
  assert.equal(one.stats().dropped, 1);
  assert.equal(one.query({})[0].fields.messageId, "m2");
});

test("C2 empty collector has null timestamps and zero counters", () => {
  const s = createCollector().stats();
  assert.equal(s.total, 0);
  assert.equal(s.recorded, 0);
  assert.equal(s.dropped, 0);
  assert.deepEqual(s.perType, {});
  assert.deepEqual(s.perActor, {});
  assert.equal(s.oldest, null);
  assert.equal(s.newest, null);
  assert.deepEqual(createCollector().query({}), []);
});

test("C2 collector surface is frozen", () => {
  const c = createCollector();
  assert.ok(Object.isFrozen(c));
  const res = c.record(messageSent());
  assert.ok(Object.isFrozen(res));
});
