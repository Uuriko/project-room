// Deployed Workers freeze Date.now() during synchronous execution: it only
// advances after I/O. A job loop bounded only by `Date.now() > deadline`
// therefore never stops early in production, and one long synchronous
// pass holds the single Room DO past the 2.5s readiness probe. These tests
// freeze the clock the same way and prove each job loop still stops at a
// deterministic work bound.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { runPatrolTick, PATROL_TICK_ROOMS, ensurePatrolSchema } from "../server/patrol.mjs";
import { backfillPublicReadModel } from "../server/public-read-model.mjs";

function freezeClock(t) {
  const frozen = Date.now(), real = Date.now;
  Date.now = () => frozen;
  t.after(() => { Date.now = real; });
  return frozen;
}
function storeWithRooms(count) {
  const path = join(mkdtempSync(join(tmpdir(), "project-room-bounds-")), "room.sqlite");
  const store = new RoomStore(path);
  store.path = path;
  for (let i = 0; i < count; i++) {
    const roomId = `room-${String(i).padStart(3, "0")}`;
    store.initialize(initialRoom(roomId));
    const key = store.issueAccessKey(roomId, "owner");
    store.command(key, roomId, { id: `cmd-${roomId}`, type: "message.posted", data: { body: "hello", messageId: `m-${roomId}` } });
  }
  return store;
}

test("patrol stops at a per-tick room bound under a frozen clock, and later ticks rotate to the rest", t => {
  const rooms = PATROL_TICK_ROOMS * 2 + 3;
  const store = storeWithRooms(rooms);
  const now = freezeClock(t);
  const seen = new Set();
  const first = runPatrolTick(store, { deadline: now + 5000 });
  assert.equal(first.rooms, PATROL_TICK_ROOMS, "the frozen deadline never trips; the work bound must");
  assert.equal(first.budgetExceeded, 1);
  for (let tick = 0; tick < 5; tick++) runPatrolTick(store, { deadline: now + 5000 });
  for (const row of store.db.prepare("SELECT room_id, sequence FROM patrol_cursor").all()) if (row.sequence > 0) seen.add(row.room_id);
  assert.equal(seen.size >= rooms, true, `every room is patrolled across ticks (no starvation): ${seen.size}/${rooms}`);
  const caughtUp = runPatrolTick(store, { deadline: now + 5000 });
  assert.equal(caughtUp.rooms, 0);
  assert.equal(caughtUp.budgetExceeded, undefined);
});

test("the patrol's fair continuation survives a store reopen (DO restart)", t => {
  const store = storeWithRooms(PATROL_TICK_ROOMS + 4);
  const now = freezeClock(t);
  runPatrolTick(store, { deadline: now + 5000 });
  const path = store.path;
  store.close();
  const reopened = new RoomStore(path);
  const second = runPatrolTick(reopened, { deadline: now + 5000 });
  assert.equal(second.rooms, 4, "resumes after the last tailed room instead of restarting at the first");
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM patrol_cursor WHERE sequence > 0").get().n, PATROL_TICK_ROOMS + 4);
});

test("an explicit single-room patrol is not limited by the tick room bound", t => {
  const store = storeWithRooms(2);
  const now = freezeClock(t);
  assert.equal(runPatrolTick(store, { deadline: now + 5000, roomId: "room-001" }).rooms, 1);
});

test("public read-model backfill stops at its batch bound under a frozen clock", t => {
  const store = storeWithRooms(45);
  const now = freezeClock(t);
  const batch = backfillPublicReadModel(store, { deadline: now + 5000 });
  assert.ok(batch.rooms <= 20, `one batch is bounded by rows, not time: ${batch.rooms}`);
  assert.equal(batch.done, false);
});

// Examined work, not just returned rows: count every statement step and row a
// tick performs at growing backlogs. Bounded ticks do the same statement work
// at any backlog; only the one-row-per-room rooms listing grows.
function countWork(store) {
  const prepare = store.db.prepare.bind(store.db), work = { statements: 0, rows: 0 };
  store.db.prepare = sql => new Proxy(prepare(sql), { get(target, key) {
    const value = target[key];
    if (typeof value !== "function") return value;
    return (...args) => { work.statements++; const out = value.apply(target, args);
      if (key === "all") work.rows += out.length; else if (key === "get" && out) work.rows++; return out; };
  } });
  return work;
}
test("patrol tick statement invocations stay constant as the backlog grows (counts statements and returned rows, not SQLite rows examined or CPU)", t => {
  const now = freezeClock(t), measured = [];
  for (const rooms of [PATROL_TICK_ROOMS + 2, PATROL_TICK_ROOMS * 6]) {
    const store = storeWithRooms(rooms), work = countWork(store);
    runPatrolTick(store, { deadline: now + 5000 });
    measured.push({ rooms, ...work });
  }
  assert.equal(measured[0].statements, measured[1].statements, JSON.stringify(measured));
  assert.ok(measured[1].rows - measured[0].rows <= measured[1].rooms - measured[0].rooms + 2, JSON.stringify(measured));
});

// Fairness must hold while early rooms stay behind (more events than one
// batch; the batch is shrunk to 1 here), otherwise skipping caught-up rooms hides a missing rotation.
function backloggedStore(heavy, light) {
  const store = storeWithRooms(0), path = store.path;
  const add = (roomId, events) => {
    store.initialize(initialRoom(roomId));
    const key = store.issueAccessKey(roomId, "owner");
    for (let i = 0; i < events; i++) store.command(key, roomId, { id: `c-${roomId}-${i}`, type: "message.posted", data: { body: "b", messageId: `m-${roomId}-${i}` } });
  };
  for (let i = 0; i < heavy; i++) add(`a-heavy-${i}`, 4);
  for (let i = 0; i < light; i++) add(`z-light-${i}`, 1);
  return { store, path };
}
const tailed = store => new Set(store.db.prepare("SELECT room_id FROM patrol_cursor WHERE sequence > 0").all().map(row => row.room_id));
test("rotation serves later rooms while earlier rooms are still more than a batch behind, across reopen and a deleted remembered room", t => {
  const { store, path } = backloggedStore(PATROL_TICK_ROOMS, 3);
  const now = freezeClock(t);
  runPatrolTick(store, { deadline: now + 5000, limit: 1 });
  assert.equal([...tailed(store)].some(id => id.startsWith("z-")), false);
  store.close();
  const reopened = new RoomStore(path);
  runPatrolTick(reopened, { deadline: now + 5000, limit: 1 });
  assert.equal([...tailed(reopened)].filter(id => id.startsWith("z-")).length, 3, "later rooms are served next tick, even after a restart");
  // The remembered room disappearing must not reset or wedge the rotation.
  const remembered = reopened.db.prepare("SELECT last_room FROM patrol_rotation WHERE id=1").get().last_room;
  reopened.db.prepare("UPDATE patrol_rotation SET last_room=? WHERE id=1").run(`${remembered}-deleted`);
  const after = runPatrolTick(reopened, { deadline: now + 5000, limit: 1 });
  assert.ok(after.rooms > 0 && after.rooms <= PATROL_TICK_ROOMS);
});

// The rotation row commits before the room's event/findings transaction. A
// crash between the two (simulated: rotation names a room whose cursor never
// moved) is only a scheduling advance: the room's cursor must not be
// acknowledged, and the room must still be tailed when the rotation wraps.
test("an interrupted attempt advances scheduling only; the room is tailed on wrap without a false cursor acknowledgement", t => {
  const { store, path } = backloggedStore(PATROL_TICK_ROOMS, 3);
  const now = freezeClock(t);
  const victim = "z-light-0";
  ensurePatrolSchema(store);
  store.db.prepare("INSERT INTO patrol_rotation(id, last_room) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_room=excluded.last_room").run(victim);
  store.close();
  const reopened = new RoomStore(path);
  const cursor = () => reopened.db.prepare("SELECT sequence FROM patrol_cursor WHERE room_id=?").get(victim)?.sequence ?? 0;
  runPatrolTick(reopened, { deadline: now + 5000, limit: 1 });
  assert.equal(cursor(), 0, "the interrupted room has no acknowledged progress");
  for (let i = 0; i < 4 && cursor() === 0; i++) runPatrolTick(reopened, { deadline: now + 5000, limit: 1 });
  assert.ok(cursor() > 0, "the interrupted room is tailed once the rotation wraps");
});

// patrol_rotation is a lazy application table: an export taken after a tick
// must restore (restore builds lazy schemas from code-owned DDL only).
test("an export taken after a bounded patrol tick restores with its rotation row", async () => {
  const { exportNdjsonText } = await import("../server/room-export.mjs");
  const { replayNdjsonInto } = await import("../server/restore-ndjson.mjs");
  const store = storeWithRooms(3);
  runPatrolTick(store);
  const before = store.db.prepare("SELECT last_room FROM patrol_rotation").all();
  assert.equal(before.length, 1);
  const restored = new RoomStore(":memory:");
  try {
    assert.equal(replayNdjsonInto(exportNdjsonText(store.db), restored).verified, true);
    assert.deepEqual(restored.db.prepare("SELECT last_room FROM patrol_rotation").all(), before);
  } finally { restored.close(); store.close(); }
});
