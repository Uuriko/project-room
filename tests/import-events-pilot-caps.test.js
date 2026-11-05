import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, PILOT_LIMITS } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, event } from "../src/events.js";

// RES-0126 (L05-C2): importEvents replaced a room's whole history with no
// pilot-cap check at all, so an import could land a projection over the
// 5 MiB cap (executed probe: 6,883,108 bytes over the 5,242,880 cap) and
// member/work counts past their caps — states command() refuses with
// 409 pilot_limit. The import path now enforces the same caps, with the
// same error shapes, on the replayed state before anything is written.

function open(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-import-caps-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function at(offset) {
  return new Date(Date.UTC(2026, 9, 2) + offset * 1000).toISOString();
}

function ev(roomId, id, type, data, offset, actorId = "owner") {
  return event({ type, actorId, roomId, id, idempotencyKey: `${id}-key`, at: at(offset), data });
}

function lines(events) {
  return events.map((entry, index) => ({ sequence: index + 1, event: entry }));
}

function setup(t) {
  const store = open(t);
  store.initialize(initialRoom("commons"));
  const owner = store.issueAccessKey("commons", "owner");
  return { store, owner };
}

function roomRow(store) {
  return store.db.prepare("SELECT sequence, LENGTH(projection) AS projectionBytes FROM rooms WHERE id='commons'").get();
}

function assertPilotLimit(error, message) {
  assert.equal(error.status, 409);
  assert.equal(error.code, "pilot_limit");
  assert.equal(error.message, message);
  return true;
}

const BOUNDED_MESSAGE = "Bounded pilot capacity reached; no data was changed";
const PROJECTION_MESSAGE = "Room projection limit reached; no data was changed. Ask the room owner to have older messages archived to free space.";

test("importEvents refuses a projection over the projection cap and changes no data", t => {
  const { store, owner } = setup(t);
  const before = roomRow(store);
  const body = "x".repeat(900);
  const events = [...initialRoom("commons")];
  for (let i = 0; i < 6500; i += 1) {
    events.push(ev("commons", `ev-${i}`, T.MESSAGE_POSTED, { messageId: `m${i}`, body }, 10 + i));
  }
  assert.throws(() => store.importEvents(owner, "commons", lines(events)),
    error => assertPilotLimit(error, PROJECTION_MESSAGE));
  assert.deepEqual(roomRow(store), before, "a refused import leaves sequence and projection untouched");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE room_id='commons'").get().n, 2);
});

test("importEvents refuses more active members than the member cap", t => {
  const { store, owner } = setup(t);
  const before = roomRow(store);
  const events = [...initialRoom("commons")];
  // The owner plus PILOT_LIMITS.membersPerRoom more members is over the cap.
  for (let i = 0; i < PILOT_LIMITS.membersPerRoom; i += 1) {
    events.push(ev("commons", `add-${i}`, T.MEMBER_ADDED,
      { memberId: `member-${i}`, displayName: `Member ${i}`, kind: "human", permissions: [] }, 10 + i));
  }
  assert.throws(() => store.importEvents(owner, "commons", lines(events)),
    error => assertPilotLimit(error, BOUNDED_MESSAGE));
  assert.deepEqual(roomRow(store), before);
});

test("importEvents refuses more work items than the work-item cap", t => {
  const { store, owner } = setup(t);
  const before = roomRow(store);
  const events = [...initialRoom("commons")];
  for (let i = 0; i < PILOT_LIMITS.workItemsPerRoom + 1; i += 1) {
    events.push(ev("commons", `propose-${i}`, T.WORK_PROPOSED,
      { workItemId: `w${i}`, title: `Item ${i}`, definitionOfDone: "Done", accountableMemberId: "owner", mode: "read" }, 10 + i));
  }
  assert.throws(() => store.importEvents(owner, "commons", lines(events)),
    error => assertPilotLimit(error, BOUNDED_MESSAGE));
  assert.deepEqual(roomRow(store), before);
});

test("importEvents at exactly the member cap still succeeds, as does a small import", t => {
  const { store, owner } = setup(t);
  const atCap = [...initialRoom("commons")];
  // Owner + (cap - 1) added members = exactly membersPerRoom active members.
  for (let i = 0; i < PILOT_LIMITS.membersPerRoom - 1; i += 1) {
    atCap.push(ev("commons", `add-${i}`, T.MEMBER_ADDED,
      { memberId: `member-${i}`, displayName: `Member ${i}`, kind: "human", permissions: [] }, 10 + i));
  }
  const result = store.importEvents(owner, "commons", lines(atCap));
  assert.equal(result.imported, atCap.length);
  assert.equal(Object.values(store.room("commons").state.members).filter(m => m.active !== false).length,
    PILOT_LIMITS.membersPerRoom);

  const small = [...initialRoom("commons"),
    ev("commons", "ev-note", T.MESSAGE_POSTED, { messageId: "note", body: "from import" }, 20)];
  const smallResult = store.importEvents(owner, "commons", lines(small));
  assert.equal(smallResult.imported, small.length);
  assert.equal(store.room("commons").state.messages.at(-1).body, "from import");
});
