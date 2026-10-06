// Phase 1a: large message bodies live outside rooms.projection at rest.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, PILOT_LIMITS } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { auditRecovery } from "../server/recovery.mjs";
import { readConversation } from "../server/conversation-sync.mjs";
import { BODY_AT_REST_MIN_CHARS } from "../server/projection-at-rest.mjs";

function open(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-at-rest-"));
  const file = join(directory, "room.sqlite");
  let store = new RoomStore(file, options);
  store.initialize(initialRoom());
  const owner = () => store.issueAccessKey("commons", "owner");
  const post = (messageId, body) => store.command(owner(), "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId, body } });
  const raw = () => store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
  const bodies = () => store.db.prepare("SELECT sha, body FROM projection_bodies WHERE room_id='commons'").all();
  const reopen = (next = options) => { store.close(); store = new RoomStore(file, next); return store; };
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, owner, post, raw, bodies, reopen };
}

const big = (tag, n = 6000) => `${tag}:` + "x".repeat(n);

test("off by default: the stored row is the full state and no body rows exist", t => {
  const room = open(t);
  room.post("long", big("long"));
  assert.match(room.raw(), /long:xxxx/);
  assert.doesNotMatch(room.raw(), /bodyRef/);
  assert.equal(room.bodies().length, 0);
});

test("on: large bodies leave the row, every reader still sees the full message", t => {
  const room = open(t, { bodiesAtRest: true });
  const text = big("patch");
  room.post("long", text);
  room.post("short", "hello");
  const stored = JSON.parse(room.raw());
  const long = stored.messages.find(m => m.id === "long");
  assert.equal("body" in long, false);
  assert.match(long.bodyRef, /^[0-9a-f]{64}$/);
  assert.equal(stored.messages.find(m => m.id === "short").body, "hello", "small bodies stay inline");
  assert.equal(room.bodies().length, 1);
  assert.ok(Buffer.byteLength(room.raw()) < 2000, `stored row ${Buffer.byteLength(room.raw())} bytes`);
  // In memory, after a restart, and through replay: identical, key order included.
  const live = room.store.room("commons").state.messages;
  assert.equal(live.find(m => m.id === "long").body, text);
  room.reopen();
  const restarted = room.store.room("commons").state;
  assert.equal(JSON.stringify(restarted.messages), JSON.stringify(live));
  assert.equal(JSON.stringify(room.store.rebuildProjection("commons").state.messages), JSON.stringify(live));
  auditRecovery(room.store);
});

test("edits and deletes release the old text at rest", t => {
  const room = open(t, { bodiesAtRest: true });
  const first = big("first"), second = big("second");
  room.post("m", first);
  room.store.command(room.owner(), "commons", { id: randomUUID(), type: T.MESSAGE_EDITED, data: { messageId: "m", body: second, expectedMessageRevision: 0 } });
  assert.equal(room.store.room("commons").state.messages.find(m => m.id === "m").body, second);
  assert.deepEqual(room.bodies().map(row => row.body), [second], "the replaced body row is released");
  room.store.command(room.owner(), "commons", { id: randomUUID(), type: T.MESSAGE_DELETED, data: { messageId: "m", expectedMessageRevision: 1, reason: "remove" } });
  assert.equal(room.bodies().length, 0, "deleted text is not kept at rest");
  auditRecovery(room.store);
});

test("the room size cap counts the stored row, so long patches stop filling it", t => {
  const count = Math.ceil(PILOT_LIMITS.projectionBytes / 60000) + 2;
  const fill = room => {
    for (let i = 0; i < count; i += 1) {
      try { room.post(`p${i}`, big(`p${i}`, 59000)); }
      catch (error) { return { stoppedAt: i, code: error.code }; }
    }
    return { stoppedAt: null };
  };
  // A moving clock keeps the per-member message rate limit out of the way.
  const clock = () => { let at = Date.parse("2026-10-06T00:00:00Z"); return () => (at += 120000); };
  assert.equal(fill(open(t, { now: clock() })).code, "pilot_limit", "without bodies at rest the room fills up");
  const slim = open(t, { bodiesAtRest: true, now: clock() });
  assert.equal(fill(slim).stoppedAt, null);
  assert.ok(Buffer.byteLength(slim.raw()) < 64 * 1024);
});

test("a body row lost outside the serializer is restored from the event log", t => {
  const room = open(t, { bodiesAtRest: true });
  const text = big("keep");
  room.post("m", text);
  room.reopen();
  room.store.db.prepare("DELETE FROM projection_bodies").run();
  assert.equal(room.store.room("commons").state.messages.find(m => m.id === "m").body, text);
});

test("the unindexed conversation read returns full bodies", t => {
  const room = open(t, { bodiesAtRest: true });
  const text = big("read");
  room.post("m", text);
  const page = readConversation(room.store, room.owner(), "commons", { limit: 10 });
  assert.equal(page.messages.find(m => m.id === "m")?.body, text);
  assert.equal(page.messages.some(m => "bodyRef" in m), false);
});

test("turning it off writes full bodies back on the next write", t => {
  const room = open(t, { bodiesAtRest: true });
  const text = big("back");
  room.post("m", text);
  room.reopen({ bodiesAtRest: false });
  room.post("n", "next");
  assert.match(room.raw(), /back:xxxx/);
  assert.doesNotMatch(room.raw(), /bodyRef/);
  assert.equal(room.bodies().length, 0, "rows are released once nothing references them");
});

test("every rooms.projection write goes through the serializer", () => {
  const files = [];
  const walk = dir => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (path.endsWith(".mjs")) files.push(path); } };
  walk(new URL("../server", import.meta.url).pathname);
  const offenders = [];
  for (const file of files) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      const roomsWrite = /(UPDATE rooms SET|INTO rooms\()[^"`]*projection/.test(line) && /JSON\.stringify\(/.test(line);
      const projectionText = /\bconst projection = JSON\.stringify\(/.test(line);
      if (roomsWrite || projectionText) offenders.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
  assert.ok(BODY_AT_REST_MIN_CHARS >= 256);
});
