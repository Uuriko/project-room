// HUNT-CHAOS regression: auditRecovery must NAME a room whose stored
// projection cannot be read (null / wrong-shaped JSON) in its
// reconciliation report, not leak a bare TypeError from whichever
// sub-audit trips first. Structural requireState failures keep their
// abort-with-plain-message behaviour. Repro source: the lane's
// projection battery (P2 'null', P5 '{"room":{"id":"alpha"}}').
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { auditRecovery } from "../server/recovery.mjs";

function build(path, rooms = ["alpha"]) {
  const store = new RoomStore(path);
  for (const room of rooms) {
    store.initialize(initialRoom(room));
    const key = store.issueAccessKey(room, "owner");
    store.command(key, room, { id: `cmd-${room}-m1`, type: "message.posted", data: { body: `${room} hello`, messageId: `${room}-m1` } });
  }
  store.close();
}
function corrupt(path, sql, ...params) {
  const store = new RoomStore(path);
  store.db.prepare(sql).run(...params);
  store.close();
}
const open = path => new RoomStore(path);
const dbFile = () => join(mkdtempSync(join(tmpdir(), "project-room-audit-unreadable-")), "room.sqlite");

test("healthy store: audit passes", () => {
  const path = dbFile(); build(path);
  const store = open(path);
  try { assert.equal(auditRecovery(store).rooms, 1); } finally { store.close(); }
});

test("null projection: refusal names the room as unreadable, no bare TypeError", () => {
  const path = dbFile(); build(path);
  corrupt(path, "UPDATE rooms SET projection='null' WHERE id='alpha'");
  const store = open(path);
  try {
    assert.throws(() => auditRecovery(store), error => {
      assert.match(error.message, /room alpha: unreadable room \(TypeError\)/);
      assert.ok(Array.isArray(error.drift) && error.drift.some(d => d.room === "alpha"));
      return true;
    });
  } finally { store.close(); }
});

test("room-only projection: refusal names the room as unreadable", () => {
  const path = dbFile(); build(path);
  corrupt(path, "UPDATE rooms SET projection=? WHERE id='alpha'", JSON.stringify({ room: { id: "alpha" } }));
  const store = open(path);
  try {
    assert.throws(() => auditRecovery(store), error => {
      assert.match(error.message, /room alpha: unreadable room/);
      return true;
    });
  } finally { store.close(); }
});

test("one refusal names a drifted room and an unreadable room together", () => {
  const path = dbFile(); build(path, ["alpha", "beta"]);
  const store = open(path);
  const row = store.db.prepare("SELECT projection FROM rooms WHERE id='alpha'").get();
  const state = JSON.parse(row.projection);
  state.messages = state.messages.slice(1);
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='alpha'").run(JSON.stringify(state));
  store.db.prepare("UPDATE rooms SET projection='null' WHERE id='beta'").run();
  store.close();
  const reopened = open(path);
  try {
    assert.throws(() => auditRecovery(reopened), error => {
      const named = (error.drift ?? []).map(d => d.room).sort();
      assert.deepEqual(named, ["alpha", "beta"]);
      assert.match(error.message, /room beta: unreadable room/);
      return true;
    });
  } finally { reopened.close(); }
});

test("structural corruption still aborts with the plain requireState message", () => {
  const path = dbFile(); build(path);
  // Projection whose embedded room id disagrees with the row: rebuild
  // succeeds, drift is recorded, then the room-id requireState fires —
  // its abort behaviour (plain message, no drift payload) is unchanged.
  const store = open(path);
  const row = store.db.prepare("SELECT projection FROM rooms WHERE id='alpha'").get();
  const state = JSON.parse(row.projection);
  state.room.id = "omega";
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='alpha'").run(JSON.stringify(state));
  store.close();
  const reopened = open(path);
  try {
    assert.throws(() => auditRecovery(reopened), error => {
      assert.equal(error.message, "Recovery data requires operator reconciliation");
      assert.equal(error.drift, undefined);
      return true;
    });
  } finally { reopened.close(); }
});

test("a deleted event names the room instead of leaking the replay error", () => {
  const path = dbFile(); build(path);
  corrupt(path, "DELETE FROM events WHERE room_id='alpha' AND sequence=2");
  const store = open(path);
  try {
    assert.throws(() => auditRecovery(store), error => {
      assert.match(error.message, /room alpha: unreadable room \(Error\): Event sequence is not contiguous/);
      return true;
    });
  } finally { store.close(); }
});
