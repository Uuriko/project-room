// RRC §A: room.title_set — the owner renames a room (title and/or purpose)
// in the existing *_set event family. History is preserved: the projection
// records prior titles and the event log is never rewritten, so a receipt
// issued before the rename keeps the title it was issued under (the
// public_receipts mirror stores room_title as an issuance-time snapshot and
// this event writes no receipt rows). Replay from genesis reproduces the
// final title.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  EVENT_TYPES as T, PERMISSIONS, applyEvent, emptyRoomState, replay, roomTitleHistory
} from "../src/events.js";
import { validateCommand, COMMAND_TYPES } from "../server/store.mjs";
import { classifyCommand } from "../server/action-classes.mjs";

const ROOM = "room-title-test";
const BASE = Date.UTC(2026, 9, 27, 0, 0, 0);
let seq = 0;
const ev = (type, actorId, data, atMs) => ({
  id: `e${seq}`, idempotencyKey: `k${seq}`, roomId: ROOM, type, actorId,
  at: new Date(BASE + (atMs ?? seq * 1000)).toISOString(), causationId: null, data, ...(seq += 1, {})
});
const genesis = () => [
  ev(T.ROOM_CREATED, "owner", { roomId: ROOM, title: "Original Name", purpose: "Original purpose.", ownerId: "owner" }),
  ev(T.MEMBER_ADDED, "owner", { memberId: "owner", displayName: "Owner", kind: "human", permissions: [...PERMISSIONS] }),
  ev(T.MEMBER_ADDED, "owner", { memberId: "ada", displayName: "Ada", kind: "human", permissions: ["steer", "accept_work"] })
];

test("owner sets a new title; projection follows, history keeps the prior title", () => {
  const events = genesis();
  const before = replay(events);
  const renamed = ev(T.ROOM_TITLE_SET, "owner", { title: "Renamed Room" }, BASE + 10_000);
  const after = applyEvent(before, renamed);
  assert.equal(after.room.title, "Renamed Room");
  assert.equal(after.room.purpose, "Original purpose.");
  assert.equal(after.room.titleSet.previousTitle, "Original Name");
  assert.equal(after.room.titleSet.previousPurpose, "Original purpose.");
  assert.equal(after.room.titleSet.setById, "owner");
  assert.equal(after.room.titleSet.revision, 1);
  const history = roomTitleHistory(after);
  assert.equal(history.length, 1);
  assert.equal(history[0].title, "Original Name");
  assert.equal(history[0].purpose, "Original purpose.");
  assert.equal(history[0].replacedById, "owner");
  // The logged creation event still carries the issuance-time title:
  // history (and any receipt snapshot taken from it) is not rewritten.
  assert.equal(after.eventLog[0].data.title, "Original Name");
  assert.equal(replay(events).room.title, "Original Name");
});

test("purpose-only set leaves the title; replay from genesis reproduces the final state", () => {
  const events = genesis();
  events.push(ev(T.ROOM_TITLE_SET, "owner", { title: "Second Name" }, BASE + 10_000));
  events.push(ev(T.ROOM_TITLE_SET, "owner", { purpose: "New purpose." }, BASE + 130_000));
  const sequential = events.reduce((state, next) => applyEvent(state, next), emptyRoomState());
  assert.equal(sequential.room.title, "Second Name");
  assert.equal(sequential.room.purpose, "New purpose.");
  assert.equal(sequential.room.titleSet.revision, 2);
  assert.equal(roomTitleHistory(sequential).length, 2);
  assert.equal(roomTitleHistory(sequential)[1].title, "Second Name");
  const replayed = replay(events);
  assert.deepEqual(replayed.room, sequential.room);
});

test("a non-owner rename is refused naming the authority required", () => {
  const state = replay(genesis());
  assert.throws(
    () => applyEvent(state, ev(T.ROOM_TITLE_SET, "ada", { title: "Ada's Room" }, BASE + 10_000)),
    /Only the Room owner may set the room title/);
  assert.equal(state.room.title, "Original Name");
});

test("renames are paced per room: a second set inside the cooldown is refused", () => {
  const events = genesis();
  events.push(ev(T.ROOM_TITLE_SET, "owner", { title: "Second Name" }, BASE + 10_000));
  const state = replay(events);
  assert.throws(
    () => applyEvent(state, ev(T.ROOM_TITLE_SET, "owner", { title: "Third Name" }, BASE + 20_000)),
    /at most once per minute/);
  const later = applyEvent(state, ev(T.ROOM_TITLE_SET, "owner", { title: "Third Name" }, BASE + 130_000));
  assert.equal(later.room.title, "Third Name");
});

test("a title_set with neither field, or an over-long title, is refused", () => {
  const state = replay(genesis());
  assert.throws(() => applyEvent(state, ev(T.ROOM_TITLE_SET, "owner", {}, BASE + 10_000)), /title or purpose/);
  assert.throws(
    () => applyEvent(state, ev(T.ROOM_TITLE_SET, "owner", { title: "x".repeat(121) }, BASE + 10_000)),
    /title must be 1 to 120 characters/);
});

test("an archived room refuses a rename as archived, not silently applied", () => {
  const events = genesis();
  events.push(ev(T.ROOM_ARCHIVED, "owner", {}));
  const state = replay(events);
  assert.throws(
    () => applyEvent(state, ev(T.ROOM_TITLE_SET, "owner", { title: "Ghost Name" }, BASE + 10_000)),
    /Room is archived/);
});

test("command surface: shape and classification", () => {
  assert.ok(COMMAND_TYPES.includes("room.title_set"));
  assert.equal(classifyCommand("room.title_set"), "act");
  validateCommand({ id: randomUUID(), type: "room.title_set", data: { title: "New Name" } });
  assert.throws(
    () => validateCommand({ id: randomUUID(), type: "room.title_set", data: { name: "New Name" } }),
    err => err.status === 422 && /Unexpected field: name/.test(err.message));
});
