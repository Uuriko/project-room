import test from "node:test";
import assert from "node:assert/strict";
import { seedEvents } from "../src/seed.js";
import { EVENT_TYPES } from "../src/events.js";

const knownTypes = new Set(Object.values(EVENT_TYPES));

test("seed event ids and idempotency keys are unique", () => {
  const ids = seedEvents.map(event => event.id);
  assert.equal(new Set(ids).size, ids.length);
  const keys = seedEvents.map(event => event.idempotencyKey);
  assert.equal(new Set(keys).size, keys.length);
});

test("every causation id resolves to a seeded event", () => {
  const ids = new Set(seedEvents.map(event => event.id));
  for (const event of seedEvents) {
    if (event.causationId === null || event.causationId === undefined) continue;
    assert.ok(ids.has(event.causationId), `${event.id} points at unknown ${event.causationId}`);
  }
});

test("every seed event carries a known event type and the room id", () => {
  for (const event of seedEvents) {
    assert.ok(knownTypes.has(event.type), `${event.id} has unknown type ${event.type}`);
    assert.equal(event.roomId, "room-project-room-v0");
  }
});

test("seed timestamps are valid and non-decreasing", () => {
  let previous = "";
  for (const event of seedEvents) {
    assert.ok(!Number.isNaN(Date.parse(event.at)), `${event.id} has unparseable at ${event.at}`);
    assert.ok(event.at >= previous, `${event.id} is out of order`);
    previous = event.at;
  }
});

test("the seed tells a complete bootstrap story", () => {
  // One room, its owner human, and at least the agent members the rooms rely on.
  const created = seedEvents.filter(event => event.type === EVENT_TYPES.ROOM_CREATED);
  assert.equal(created.length, 1);
  const members = seedEvents.filter(event => event.type === EVENT_TYPES.MEMBER_ADDED);
  const kinds = new Set(members.map(event => event.data.kind));
  assert.ok(kinds.has("human"));
  assert.ok(kinds.has("agent"));
  assert.ok(members.every(event => typeof event.data.memberId === "string" && event.data.memberId));
});
