// C4-1: bodies-at-rest enablement for hot rooms. The shipped flag was
// all-or-nothing per store and reached production only through the deploy
// workflow's --var pin; these tests pin the per-room selection on top of
// it: an explicit room list, auto-selection of rooms whose stored
// projection reaches the hot threshold, stickiness across restarts, cold
// rooms untouched, and the flag-off rollback path.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { HOT_ROOM_PROJECTION_BYTES, bodiesAtRestOptionsFromEnv, parseRoomIdList } from "../server/projection-at-rest.mjs";

function open(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-hot-rooms-"));
  const file = join(directory, "room.sqlite");
  let store = new RoomStore(file, options);
  const post = (room, messageId, body) => store.command(store.issueAccessKey(room, "owner"), room,
    { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId, body } });
  const raw = room => store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(room).projection;
  const rows = room => store.db.prepare("SELECT COUNT(*) AS n FROM projection_bodies WHERE room_id=?").get(room).n;
  const reopen = (next = options) => { store.close(); store = new RoomStore(file, next); return store; };
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, post, raw, rows, reopen };
}

// A moving clock keeps the per-member message rate limit out of the way.
const clock = () => { let at = Date.parse("2026-10-06T00:00:00Z"); return () => (at += 120000); };
const body = (tag, n = 870) => `${tag}:` + "x".repeat(n);

test("policy: env parsing is the one reader of the ROOM_BODIES_AT_REST* vars", () => {
  assert.deepEqual([...parseRoomIdList(" a, b  c,,d ")], ["a", "b", "c", "d"]);
  assert.deepEqual([...parseRoomIdList(["x", "x", " y "])], ["x", "y"]);
  assert.equal(parseRoomIdList(null).size, 0);
  assert.deepEqual(
    bodiesAtRestOptionsFromEnv({ ROOM_BODIES_AT_REST: "1", ROOM_BODIES_AT_REST_HOT: "1", ROOM_BODIES_AT_REST_ROOMS: "r1,r2" }),
    { bodiesAtRest: true, bodiesAtRestRooms: new Set(["r1", "r2"]), bodiesAtRestHot: true });
  assert.deepEqual(bodiesAtRestOptionsFromEnv({}),
    { bodiesAtRest: false, bodiesAtRestRooms: new Set(), bodiesAtRestHot: false });
  assert.equal(HOT_ROOM_PROJECTION_BYTES, 1024 * 1024, "a quarter of the 4 MiB cap; the largest production room (1,130,818 B) crosses it, fleet-average rooms never do");
});

test("config: wrangler carries the hot-room switch so it does not ride only on the deploy pin", () => {
  const config = readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8");
  const pins = config.match(/"ROOM_BODIES_AT_REST_HOT": "1"/g) ?? [];
  assert.ok(pins.length >= 2, "top-level and production vars both carry ROOM_BODIES_AT_REST_HOT=1");
});

test("listed rooms engage from the first write; unlisted rooms stay inline", t => {
  const room = open(t, { now: clock(), bodiesAtRestRooms: "commons" });
  room.store.initialize(initialRoom());
  room.store.initialize(initialRoom("side"));
  const text = body("listed");
  room.post("commons", "m", text);
  room.post("side", "m", text);
  assert.match(room.raw("commons"), /bodyRef/);
  assert.equal(room.rows("commons"), 1);
  assert.doesNotMatch(room.raw("side"), /bodyRef/);
  assert.equal(room.rows("side"), 0);
  assert.equal(room.store.room("commons").state.messages.find(m => m.id === "m").body, text);
  assert.equal(room.store.room("side").state.messages.find(m => m.id === "m").body, text);
});

test("hot rooms select themselves at the threshold, stay selected after restart, and read back byte-equal", t => {
  const options = { now: clock(), bodiesAtRestHot: true, bodiesAtRestHotBytes: 32 * 1024 };
  const room = open(t, options);
  room.store.initialize(initialRoom());
  room.store.initialize(initialRoom("side"));
  const bodies = [];
  for (let i = 0; i < 60; i++) { const text = body(`h${i}`); bodies.push(text); room.post("commons", `h${i}`, text); }
  for (let i = 0; i < 5; i++) room.post("side", `s${i}`, body(`s${i}`));
  assert.equal(room.store.bodiesAtRestFor("commons"), true);
  assert.match(room.raw("commons"), /bodyRef/);
  assert.ok(room.rows("commons") > 0);
  assert.equal(room.store.bodiesAtRestFor("side"), false, "the cold room in the same store is not selected");
  assert.doesNotMatch(room.raw("side"), /bodyRef/);
  assert.equal(room.rows("side"), 0);
  assert.ok(Buffer.byteLength(room.raw("commons")) < 32 * 1024, "slimming took the room back under the threshold");
  // Restart: the slimmed projection is under the threshold, so only the
  // existing body rows can re-select the room — and they do.
  room.reopen();
  assert.equal(room.store.bodiesAtRestFor("commons"), true, "selection is sticky across a restart");
  const after = body("after-restart");
  room.post("commons", "h60", after);
  assert.match(JSON.parse(room.raw("commons")).messages.find(m => m.id === "h60").bodyRef, /^[0-9a-f]{64}$/);
  const live = room.store.room("commons").state.messages;
  for (let i = 0; i < 60; i++) assert.equal(live.find(m => m.id === `h${i}`).body, bodies[i], `byte-equal read-back for h${i}`);
  assert.equal(live.find(m => m.id === "h60").body, after);
});

test("growth: inline at ~1,000 B/event before the threshold, a few hundred after it", t => {
  const room = open(t, { now: clock(), bodiesAtRestHot: true, bodiesAtRestHotBytes: 128 * 1024 });
  room.store.initialize(initialRoom());
  const bytes = () => Buffer.byteLength(room.raw("commons"));
  for (let i = 0; i < 50; i++) room.post("commons", `g${i}`, body(`g${i}`));
  const at50 = bytes();
  for (let i = 50; i < 100; i++) room.post("commons", `g${i}`, body(`g${i}`));
  const inlineSlope = (bytes() - at50) / 50;
  assert.ok(inlineSlope > 800, `before selection the room grows inline (${inlineSlope} B/event)`);
  assert.equal(room.rows("commons"), 0);
  for (let i = 100; i < 260; i++) room.post("commons", `g${i}`, body(`g${i}`));
  const at260 = bytes();
  assert.ok(room.rows("commons") > 0, "the room selected itself once its stored projection crossed the threshold");
  for (let i = 260; i < 310; i++) room.post("commons", `g${i}`, body(`g${i}`));
  const restedSlope = (bytes() - at260) / 50;
  assert.ok(restedSlope > 0 && restedSlope < 450, `after selection growth is in the bodies-at-rest class (${restedSlope} B/event)`);
});

test("turning hot selection off re-inlines the room on the next write (rollback)", t => {
  const room = open(t, { now: clock(), bodiesAtRestHot: true, bodiesAtRestHotBytes: 32 * 1024 });
  room.store.initialize(initialRoom());
  const text = body("rollback");
  for (let i = 0; i < 40; i++) room.post("commons", `r${i}`, body(`r${i}`));
  room.post("commons", "keep", text);
  assert.ok(room.rows("commons") > 0);
  room.reopen({ now: clock(), bodiesAtRestHot: false });
  assert.equal(room.store.bodiesAtRestFor("commons"), false);
  room.post("commons", "next", "hello");
  assert.doesNotMatch(room.raw("commons"), /bodyRef/);
  assert.equal(room.rows("commons"), 0, "body rows are released once nothing references them");
  assert.equal(room.store.room("commons").state.messages.find(m => m.id === "keep").body, text);
});

test("env defaults: a store opened with no options picks the selection up from the environment", t => {
  const previous = { hot: process.env.ROOM_BODIES_AT_REST_HOT, rooms: process.env.ROOM_BODIES_AT_REST_ROOMS };
  process.env.ROOM_BODIES_AT_REST_HOT = "1";
  process.env.ROOM_BODIES_AT_REST_ROOMS = "commons";
  try {
    const room = open(t, { now: clock() });
    assert.equal(room.store.bodiesAtRestHot, true);
    assert.equal(room.store.bodiesAtRestFor("commons"), true, "listed via env");
    assert.equal(room.store.bodiesAtRestFor("other"), false);
  } finally {
    if (previous.hot === undefined) delete process.env.ROOM_BODIES_AT_REST_HOT; else process.env.ROOM_BODIES_AT_REST_HOT = previous.hot;
    if (previous.rooms === undefined) delete process.env.ROOM_BODIES_AT_REST_ROOMS; else process.env.ROOM_BODIES_AT_REST_ROOMS = previous.rooms;
  }
});
