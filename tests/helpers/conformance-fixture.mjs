// Shared store fixture for the #3676 / #3677 conformance harness family
// (PR-0). One helper boots the test store in TMPDIR scratch, seeded with
// the room / member / actor / resource fixtures both later harnesses use:
//
//   PR-1 (#3677 mutation-walk) seeds its walk datasets over these ids.
//   PR-2 (#3676 replay-matrix) submits against these ids, and its R6
//   crash row reopens the SAME on-disk store via fixture.reopen() — the
//   journal must survive the child process, so the store is a real file
//   under os.tmpdir() (which follows TMPDIR), never ":memory:".
//
// No wall-clock dependence: ids and seed data are fixed constants.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../../server/store.mjs";
import { initialRoom } from "../../server/bootstrap.mjs";
import { EVENT_TYPES as T, PERMISSIONS, event } from "../../src/events.js";

export const CONFORMANCE_FIXTURE = Object.freeze({
  roomId: "commons",
  otherRoomId: "other-room",
  ownerId: "owner",
  actorId: "actor-1",
  actorDisplayName: "Conformance Actor",
  secondActorId: "actor-2",
  secondActorDisplayName: "Conformance Second Actor",
  memberId: "member-1",
  memberDisplayName: "Conformance Member",
  resourceId: "resource-1",
  resourceKind: "work-item",
  idempotencyKey: "conformance-key-1",
  requestId: "conformance-req-1",
});

function seedEvents(fixture) {
  const events = [...initialRoom(fixture.roomId, fixture.ownerId)];
  for (const [memberId, displayName, kind] of [
    [fixture.actorId, fixture.actorDisplayName, "agent"],
    [fixture.secondActorId, fixture.secondActorDisplayName, "agent"],
    [fixture.memberId, fixture.memberDisplayName, "human"],
  ]) {
    events.push(event({
      type: T.MEMBER_ADDED, actorId: fixture.ownerId, roomId: fixture.roomId,
      data: { memberId, displayName, kind, permissions: [...PERMISSIONS] },
    }));
  }
  return events;
}

// Boots a RoomStore over a fresh TMPDIR directory. Pass the node:test
// context `t` to register cleanup automatically, or call close() yourself.
export function createConformanceFixture(t = null, overrides = {}) {
  const fixture = { ...CONFORMANCE_FIXTURE, ...overrides };
  const directory = mkdtempSync(join(tmpdir(), "conformance-fixture-"));
  const filename = join(directory, "room.sqlite");
  let store = new RoomStore(filename);
  store.initialize(seedEvents(fixture));
  let closed = false;
  const api = {
    fixture, directory, filename, store,
    get db() { return store.db; },
    // Close and reopen over the same file (restart / crash-row shape).
    reopen() {
      store.close();
      store = new RoomStore(filename);
      api.store = store;
      return store;
    },
    close() {
      if (closed) return;
      closed = true;
      try { store.close(); } catch { /* already closed */ }
      rmSync(directory, { recursive: true, force: true });
    },
  };
  if (t && typeof t.after === "function") t.after(() => api.close());
  return api;
}
