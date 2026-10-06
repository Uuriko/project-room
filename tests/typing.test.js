import test from "node:test";
import assert from "node:assert/strict";
import { recordBeat, currentTypists, typingKey, TYPING_TTL_MS } from "../server/typing.mjs";

// Authoring-gate answers: typing is ephemeral by contract — heartbeats must
// expire without any explicit stop, must never be visible to the typist
// themselves, and the registry must stay memory-bounded (prunes on read).
// No existing coverage: server/typing.mjs is new.

const member = (id, displayName = id) => ({ id, displayName, kind: "human" });

test("heartbeat makes the member visible to others", () => {
  const state = new Map();
  assert.equal(recordBeat(state, "room1", member("a", "Ava"), 1000), true);
  const typists = currentTypists(state, "room1", "b", 1000);
  assert.deepEqual(typists, [{ memberId: "a", displayName: "Ava", kind: "human" }]);
});

test("the typist never sees themselves typing", () => {
  const state = new Map();
  recordBeat(state, "room1", member("a"), 1000);
  assert.deepEqual(currentTypists(state, "room1", "a", 1000), []);
});

test("heartbeats expire after the TTL with no explicit stop", () => {
  const state = new Map();
  recordBeat(state, "room1", member("a"), 1000);
  assert.deepEqual(currentTypists(state, "room1", "b", 1000 + TYPING_TTL_MS + 1), []);
});

test("a fresh heartbeat extends visibility", () => {
  const state = new Map();
  recordBeat(state, "room1", member("a"), 1000);
  recordBeat(state, "room1", member("a"), 1000 + TYPING_TTL_MS - 1);
  assert.equal(currentTypists(state, "room1", "b", 1000 + TYPING_TTL_MS).length, 1);
});

test("expired rooms are pruned from the registry", () => {
  const state = new Map();
  recordBeat(state, "room1", member("a"), 1000);
  currentTypists(state, "room1", "b", 1000 + TYPING_TTL_MS + 1);
  assert.equal(state.has("room1"), false);
});

test("typists are sorted by display name and keyed by member id", () => {
  const state = new Map();
  recordBeat(state, "room1", member("z", "Zed"), 1000);
  recordBeat(state, "room1", member("a", "Ava"), 1000);
  const typists = currentTypists(state, "room1", "b", 1000);
  assert.deepEqual(typists.map(t => t.displayName), ["Ava", "Zed"]);
  assert.equal(typingKey(typists), "a,z");
  assert.equal(typingKey([]), "");
});

test("recordBeat rejects missing room or member", () => {
  const state = new Map();
  assert.equal(recordBeat(state, "", member("a"), 1000), false);
  assert.equal(recordBeat(state, "room1", null, 1000), false);
  assert.equal(state.size, 0);
});
