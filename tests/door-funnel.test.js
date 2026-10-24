import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readDoorFunnel, computeDoorFunnel, clampDoorFunnelWeeks, DOOR_FUNNEL_MAX_WEEKS } from "../server/door-funnel.mjs";

// Wednesday 2026-10-21 11:00 America/Los_Angeles. Los Angeles Mondays in
// scope: Oct 5 / Oct 12 / Oct 19, each starting 07:00Z (PDT).
const NOW = Date.parse("2026-10-21T18:00:00.000Z");
const STARTS = ["2026-10-05T07:00:00.000Z", "2026-10-12T07:00:00.000Z", "2026-10-19T07:00:00.000Z"];

let seq = 0;
function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE events (room_id TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, PRIMARY KEY(room_id, sequence));
           CREATE TABLE agent_identities (identity_id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);`);
  return db;
}
function join(db, roomId, at, type = "member.added", memberId = "mbr_secret_1") {
  seq += 1;
  db.prepare("INSERT INTO events (room_id, sequence, id, body) VALUES (?, ?, ?, ?)")
    .run(roomId, seq, `evt_${seq}`, JSON.stringify({ type, roomId, actorId: "owner_secret", at, data: { memberId, displayName: "Secret Joiner", kind: "agent", identityId: "ai_secretidentity" } }));
}
function event(db, roomId, at, type) {
  seq += 1;
  db.prepare("INSERT INTO events (room_id, sequence, id, body) VALUES (?, ?, ?, ?)")
    .run(roomId, seq, `evt_${seq}`, JSON.stringify({ type, roomId, actorId: "owner_secret", at, data: {} }));
}
function mint(db, createdAt, id = `ai_mint_${createdAt}`) {
  db.prepare("INSERT INTO agent_identities (identity_id, secret_hash, display_name, created_at) VALUES (?, ?, ?, ?)")
    .run(id, `hash_${id}`, "Minty Secret", createdAt);
}
const directoryOf = rooms => ({ list: () => ({ rooms, nextCursor: null }) });
const storeOf = (db, rooms) => ({ db, roomDirectory: directoryOf(rooms) });
const LISTED = [{ roomId: "room-a", memberCount: 30 }, { roomId: "room-b", memberCount: 87 }];

function seededDb() {
  const db = makeDb();
  join(db, "room-a", "2026-10-19T07:00:00.000Z"); // boundary: current week
  join(db, "room-a", "2026-10-20T15:00:00.000Z", "member.joined_via_invitation");
  join(db, "room-a", "2026-10-19T06:59:59.000Z"); // Sunday 23:59:59 PDT: previous week
  join(db, "room-a", "2026-10-06T12:00:00.000Z");
  event(db, "room-a", "2026-10-20T16:00:00.000Z", "message.posted"); // not a join
  join(db, "room-b", "2026-10-13T12:00:00.000Z");
  join(db, "room-secret", "2026-10-20T15:00:00.000Z"); // unlisted room
  mint(db, Date.parse("2026-10-20T00:00:00.000Z"));
  mint(db, Date.parse("2026-10-21T00:00:00.000Z"));
  mint(db, Date.parse("2026-10-12T07:00:00.000Z")); // boundary: previous week
  mint(db, Date.parse("2026-09-01T00:00:00.000Z")); // outside a 3-week window
  return db;
}

test("weekly joins aggregate per listed room from the join events", () => {
  const out = readDoorFunnel(storeOf(seededDb(), LISTED), { weeks: 3, now: NOW });
  assert.deepEqual(out.weeks.map(w => w.startsAt), STARTS);
  assert.deepEqual(out.weeks.map(w => w.joins), [
    { "room-a": 1, "room-b": 0 },
    { "room-a": 1, "room-b": 1 },
    { "room-a": 2, "room-b": 0 },
  ]);
});

test("mints are counted from agent_identities.created_at in the same weeks", () => {
  const out = readDoorFunnel(storeOf(seededDb(), LISTED), { weeks: 3, now: NOW });
  assert.deepEqual(out.weeks.map(w => w.mints), [0, 1, 2]);
});

test("weeks parameter clamps to 1..12 with 12 as the default", () => {
  assert.equal(clampDoorFunnelWeeks(99), DOOR_FUNNEL_MAX_WEEKS);
  assert.equal(clampDoorFunnelWeeks(0), 1);
  assert.equal(clampDoorFunnelWeeks("abc"), 12);
  assert.equal(clampDoorFunnelWeeks(undefined), 12);
  const db = makeDb();
  assert.equal(readDoorFunnel(storeOf(db, []), { weeks: 99, now: NOW }).weeks.length, 12);
  assert.equal(readDoorFunnel(storeOf(db, []), { now: NOW }).weeks.length, 12);
});

test("empty store renders the full shape with zeros, never absence", () => {
  const out = readDoorFunnel(storeOf(makeDb(), LISTED), { weeks: 2, now: NOW });
  assert.equal(out.schema, "project-room-door-funnel/1");
  assert.equal(out.generatedAt, "2026-10-21T18:00:00.000Z");
  assert.deepEqual(out.weeks.map(w => w.joins), [{ "room-a": 0, "room-b": 0 }, { "room-a": 0, "room-b": 0 }]);
  assert.deepEqual(out.weeks.map(w => w.mints), [0, 0]);
  assert.deepEqual(out.directory, { listedRooms: 2, totalMembers: 117, rooms: LISTED });
});

test("a listed room with no joins renders 0 and an unlisted room never appears", () => {
  const out = readDoorFunnel(storeOf(seededDb(), LISTED), { weeks: 3, now: NOW });
  for (const week of out.weeks) {
    assert.ok(Object.hasOwn(week.joins, "room-b"));
    assert.ok(!Object.hasOwn(week.joins, "room-secret"));
  }
  assert.equal(out.weeks[2].joins["room-b"], 0);
  assert.ok(!JSON.stringify(out).includes("room-secret"));
});

test("existence-hiding: no member, identity, or joiner data anywhere in the output", () => {
  const out = readDoorFunnel(storeOf(seededDb(), LISTED), { weeks: 3, now: NOW });
  const text = JSON.stringify(out);
  for (const secret of ["mbr_secret_1", "Secret Joiner", "ai_secretidentity", "ai_mint_", "Minty Secret", "owner_secret", "secret_hash"]) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
  assert.deepEqual(Object.keys(out).sort(), ["classifier", "directory", "generatedAt", "schema", "weeks"]);
  for (const week of out.weeks) assert.deepEqual(Object.keys(week).sort(), ["joins", "mints", "startsAt"]);
});

test("anonymous-readable shape: the read takes no credential and claims no fleet/outside split", () => {
  // The route serves this read with no auth argument at all; the module's
  // only inputs are the store, the week count, and the clock.
  const out = readDoorFunnel(storeOf(seededDb(), LISTED), { weeks: 3, now: NOW });
  assert.equal(out.classifier.available, false);
  assert.match(out.classifier.reason, /No fleet marker/);
  const text = JSON.stringify(out.weeks);
  assert.ok(!text.includes("fleet"));
  assert.ok(!text.includes("outside"));
});

test("a missing source refuses the whole read instead of silently zeroing a leg", () => {
  const bare = new DatabaseSync(":memory:"); // no events / agent_identities tables
  assert.throws(
    () => computeDoorFunnel(bare, { listedRooms: LISTED, weeks: 3, now: NOW }),
    error => error.code === "door_funnel_unavailable" && error.status === 500,
  );
  assert.throws(
    () => readDoorFunnel({ db: makeDb() }, { now: NOW }),
    error => error.code === "door_funnel_unavailable",
  );
});
