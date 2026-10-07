// Contract: applyEvent clones the (frozen, cached) room state before the
// reducer mutates it. cloneRoomState must be a behavior-identical,
// independent, mutable deep copy of structuredClone for JSON-shaped states —
// but share immutable primitives by reference so a multi-MB room does not
// pay a full byte copy per event.
import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES, applyEvent, cloneRoomState, event, emptyRoomState } from "../src/events.js";

const ROOM_ID = "room-clone";

function roomState() {
  let state = emptyRoomState();
  const post = (id, actorId, data) => {
    state = applyEvent(state, event({ id, idempotencyKey: `key-${id}`, roomId: ROOM_ID,
      type: EVENT_TYPES.MESSAGE_POSTED, actorId, at: "2026-10-07T00:00:00.000Z", data }));
  };
  state = applyEvent(state, event({ id: "e-create", idempotencyKey: "key-e-create", roomId: ROOM_ID,
    type: EVENT_TYPES.ROOM_CREATED, actorId: "owner", at: "2026-10-07T00:00:00.000Z",
    data: { roomId: ROOM_ID, ownerId: "owner", title: "t", purpose: "p" } }));
  state = applyEvent(state, event({ id: "e-owner", idempotencyKey: "key-e-owner", roomId: ROOM_ID,
    type: EVENT_TYPES.MEMBER_ADDED, actorId: "owner", at: "2026-10-07T00:00:00.000Z",
    data: { memberId: "owner", displayName: "Owner", kind: "human", permissions: ["steer", "manage_members"] } }));
  post("e-1", "owner", { messageId: "m-1", body: "hello ".repeat(1000) });
  post("e-2", "owner", { messageId: "m-2", body: "world", replyToId: "m-1" });
  return state;
}

test("cloneRoomState deep-equals structuredClone on a room state", () => {
  const state = roomState();
  assert.deepEqual(cloneRoomState(state), structuredClone(state));
});

test("cloneRoomState output is independent and mutable; input stays frozen", () => {
  const state = roomState();
  const frozen = (function deepFreeze(value) {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
    if (Array.isArray(value)) value.forEach(deepFreeze); else Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  })(state);
  const copy = cloneRoomState(frozen);
  // Large immutable strings are shared, not copied.
  assert.equal(copy.messages[0].body, frozen.messages[0].body);
  // Mutations on the copy never reach the input, including nested objects.
  copy.messages[0].body = "changed";
  copy.messages[0].reactions = { "👍": ["owner"] };
  copy.messages.push({ id: "m-new" });
  copy.members.owner.displayName = "changed";
  copy.room.title = "changed";
  assert.equal(frozen.messages[0].body, "hello ".repeat(1000));
  assert.equal(frozen.messages.length, 2);
  assert.equal(frozen.members.owner.displayName, "Owner");
  assert.equal(frozen.room.title, "t");
  assert.ok(Object.isFrozen(frozen));
  assert.ok(!Object.isFrozen(copy));
});

test("cloneRoomState falls back to structuredClone for exotic values", () => {
  const date = new Date(1234567890000);
  const map = new Map([["a", { deep: true }]]);
  const copy = cloneRoomState({ date, map, plain: { x: 1 } });
  assert.ok(copy.date instanceof Date);
  assert.equal(copy.date.getTime(), 1234567890000);
  assert.ok(copy.map instanceof Map);
  assert.deepEqual(copy.map.get("a"), { deep: true });
  copy.map.get("a").deep = false;
  assert.equal(map.get("a").deep, true);
  assert.deepEqual(copy.plain, { x: 1 });
});

test("applyEvent on a frozen state leaves the input untouched", () => {
  const state = roomState();
  const before = JSON.stringify(state);
  const next = applyEvent(state, event({ id: "e-3", idempotencyKey: "key-e-3", roomId: ROOM_ID,
    type: EVENT_TYPES.MESSAGE_POSTED, actorId: "owner", at: "2026-10-07T00:00:01.000Z",
    data: { messageId: "m-3", body: "third" } }));
  assert.equal(next.messages.length, state.messages.length + 1);
  assert.equal(next.messages.at(-1).body, "third");
  assert.equal(JSON.stringify(state), before);
});
