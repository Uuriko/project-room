import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replay } from "../src/events.js";
import { seedEvents } from "../src/seed.js";
import { REQUIRED_COLUMNS, exportRoom, listRooms, readEvents, readInvitations, openRoomDatabase } from "../server/room-export.mjs";
import { loopHealth } from "../src/growth-metrics.js";
import { trueInviteCoefficient } from "../server/invitation-funnel.mjs";

const storeSource = () => readFileSync(new URL("../server/store.mjs", import.meta.url), "utf8");

// Build a store with the same table shapes the real one declares. The pin test
// below is what keeps this honest: if server/store.mjs renames a column, that
// test fails rather than this fixture quietly diverging from production.
function fixtureStore(t, { rooms = ["commons"], events = seedEvents, invitations = [] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-export-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "room.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE rooms (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, projection TEXT NOT NULL);
    CREATE TABLE events (room_id TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, PRIMARY KEY(room_id, sequence));
    CREATE TABLE membership_invitations (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, intended_member_id TEXT NOT NULL,
      intended_role TEXT NOT NULL, issuer_member_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, status TEXT NOT NULL, accepted_at INTEGER, joined_event_id TEXT);
  `);
  const room = db.prepare("INSERT INTO rooms (id, sequence, projection) VALUES (?,?,?)");
  for (const id of rooms) room.run(id, 0, "{}");
  const insert = db.prepare("INSERT INTO events (room_id, sequence, id, body) VALUES (?,?,?,?)");
  events.forEach((event, index) => insert.run(rooms[0], index + 1, event.id, JSON.stringify(event)));
  const invite = db.prepare(`INSERT INTO membership_invitations
    (id, room_id, intended_member_id, intended_role, issuer_member_id, created_at, expires_at, status, accepted_at, joined_event_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const row of invitations) {
    invite.run(row.id, rooms[0], row.intended_member_id, "member", row.issuer_member_id,
      row.created_at, row.expires_at, row.status, row.accepted_at ?? null, row.joined_event_id ?? null);
  }
  db.close();
  return path;
}

test("the columns this reader depends on still exist in the real schema", () => {
  // Without this pin the fixture above could drift from production and every
  // report would come back confidently empty.
  const source = storeSource();
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const declaration = source.match(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table} \\(([\\s\\S]*?)\\n?\\s*\\);`));
    assert.ok(declaration, `server/store.mjs no longer declares ${table}`);
    for (const column of columns) {
      assert.match(declaration[1], new RegExp(`\\b${column}\\b`), `${table}.${column} is gone from the real schema`);
    }
  }
});

test("a real store replays to the same Room the event array does", (t) => {
  const path = fixtureStore(t);
  const exported = exportRoom(path);
  assert.equal(exported.roomId, "commons");
  assert.equal(exported.events.length, seedEvents.length);
  // The whole point: reading from disk must land on exactly the same Room.
  assert.deepEqual(replay(exported.events), replay(seedEvents));
  assert.deepEqual(loopHealth(replay(exported.events), { now: Date.parse("2026-09-05T12:00:00.000Z") }).membership,
    loopHealth(replay(seedEvents), { now: Date.parse("2026-09-05T12:00:00.000Z") }).membership);
});

test("invitations come back in the shape the funnel expects", (t) => {
  const now = Date.now(), DAY = 86_400_000;
  const path = fixtureStore(t, { invitations: [
    { id: "inv-1", intended_member_id: "nina", issuer_member_id: "potter", created_at: now - 3 * DAY,
      expires_at: now + DAY, status: "accepted", accepted_at: now - 2 * DAY, joined_event_id: "evt-x" },
    { id: "inv-2", intended_member_id: "pia", issuer_member_id: "potter", created_at: now - 9 * DAY,
      expires_at: now - DAY, status: "pending" }
  ] });
  const exported = exportRoom(path);
  assert.equal(exported.invitations.length, 2);
  const result = trueInviteCoefficient(exported.invitations, replay(exported.events), { now });
  assert.equal(result.funnel.issued, 2);
  assert.equal(result.funnel.accepted, 1);
  assert.equal(result.funnel.expired, 1, "a pending invitation past expiry reads as expired");
});

test("the busiest room is the default and a named room can be chosen", (t) => {
  const path = fixtureStore(t, { rooms: ["commons", "side-room"] });
  const rooms = listRooms(openRoomDatabase(path));
  assert.deepEqual(rooms.map((room) => room.id), ["commons", "side-room"], "most events first");
  assert.equal(exportRoom(path).roomId, "commons");
  assert.equal(exportRoom(path, { roomId: "side-room" }).roomId, "side-room");
  assert.equal(exportRoom(path, { roomId: "side-room" }).events.length, 0);
  assert.throws(() => exportRoom(path, { roomId: "nope" }), /No room "nope"/);
});

test("reading never writes to the store", (t) => {
  const path = fixtureStore(t);
  const before = statSync(path);
  exportRoom(path);
  const after = statSync(path);
  assert.equal(after.size, before.size, "file size changed during a read");
  assert.equal(after.mtimeMs, before.mtimeMs, "the store was modified by a read");
  // And the handle really is read-only.
  const db = openRoomDatabase(path);
  assert.throws(() => db.exec("INSERT INTO rooms (id, sequence, projection) VALUES ('x',0,'{}')"), /readonly|read-only/i);
  db.close();
});

test("an empty or unfamiliar store reports nothing rather than throwing", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "room-export-empty-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "empty.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE unrelated (x TEXT);");
  db.close();
  const exported = exportRoom(path);
  assert.deepEqual(exported, { rooms: [], roomId: null, events: [], invitations: [] });
});

test("a corrupt event body is skipped, not fatal", (t) => {
  const path = fixtureStore(t, { events: seedEvents.slice(0, 3) });
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO events (room_id, sequence, id, body) VALUES (?,?,?,?)").run("commons", 99, "broken", "{not json");
  db.close();
  const events = readEvents(openRoomDatabase(path), "commons");
  assert.equal(events.length, 3, "the readable history survives one bad row");
});
