// Phase 1a: large message bodies live outside rooms.projection at rest.
// Test-audit authoring gate for integration: the ON owner also certifies the
// independently stored indexed records after restart. Raw bodyRef comparison
// wrongly refuses parity (reproduced before the repair); prior owner tests only
// exercised unindexed reads. Existing production backfill/parity APIs suffice,
// with no test-only seam. The final broad writer guard is retained as a cheap
// architecture contract; behavioral storage/lifecycle checks are its primary proof.
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
  const room = open(t, { bodiesAtRest: false });
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
  // Indexed readers have a separate storage contract from the raw projection.
  // A parity audit must compare their full public records after slimming.
  for (let page = 0; page < 20; page++) if (room.store.backfillMessages({ limit: 400 }).done) break;
  assert.equal(room.store.checkMessagesParity().checked, 1);
});

test("on: mid-size bodies (>= BODY_AT_REST_MIN_CHARS) leave the row too; short ones stay inline", t => {
  const room = open(t, { bodiesAtRest: true });
  const mid = "m".repeat(BODY_AT_REST_MIN_CHARS + 44);
  const short = "s".repeat(BODY_AT_REST_MIN_CHARS - 1);
  room.post("mid", mid);
  room.post("short", short);
  const stored = JSON.parse(room.raw());
  assert.match(stored.messages.find(m => m.id === "mid").bodyRef, /^[0-9a-f]{64}$/);
  assert.equal(stored.messages.find(m => m.id === "short").body, short);
  assert.ok(BODY_AT_REST_MIN_CHARS <= 256, "most real room posts (256-511 chars) must leave the row");
  room.reopen();
  assert.equal(room.store.room("commons").state.messages.find(m => m.id === "mid").body, mid);
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
  // Size the fill from the bytes actually posted (not a rounder figure), so the
  // posted volume always exceeds the cap whatever PILOT_LIMITS.projectionBytes is.
  const bodyChars = 59000;
  const postedBytes = Buffer.byteLength(big("p0", bodyChars));
  const count = Math.ceil(PILOT_LIMITS.projectionBytes / postedBytes) + 2;
  const fill = (room, from = 0) => {
    for (let i = from; i < count; i += 1) {
      try { room.post(`p${i}`, big(`p${i}`, bodyChars)); }
      catch (error) { return { stoppedAt: i, code: error.code }; }
    }
    return { stoppedAt: null };
  };
  // A moving clock keeps the per-member message rate limit out of the way.
  const clock = () => { let at = Date.parse("2026-10-06T00:00:00Z"); return () => (at += 120000); };
  // Without bodies at rest, fast-forward to just under the cap with a synthetic
  // inline filler (re-serialising ~1,100 real posts of a 64 MiB row is
  // quadratic), then the last few real posts must hit the cap.
  const fat = open(t, { bodiesAtRest: false, now: clock() });
  const headroomPosts = 8;
  const room = fat.store.room.bind(fat.store);
  fat.store.room = id => { const result = room(id); return { sequence: result.sequence,
    state: { ...result.state, capacityFixture: "x".repeat(PILOT_LIMITS.projectionBytes - headroomPosts * postedBytes) } }; };
  const capped = fill(fat, count - headroomPosts - 2);
  assert.equal(capped.code, "pilot_limit", "without bodies at rest the room fills up");
  assert.ok(capped.stoppedAt < count, "the cap is reached before the posted volume runs out");
  // With bodies at rest the full volume, which exceeds the cap, fits.
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

test("rehydrateAllProjections writes every room back with full bodies, for a rollback", t => {
  const room = open(t, { bodiesAtRest: true });
  const text = big("rollback");
  room.post("m", text);
  room.reopen({ bodiesAtRest: false });
  assert.equal(room.store.rehydrateAllProjections(), 1);
  assert.match(room.raw(), /rollback:xxxx/);
  assert.doesNotMatch(room.raw(), /bodyRef/);
  assert.equal(room.bodies().length, 0);
  auditRecovery(room.store);
});

test("the unindexed conversation read recovers a lost body row from the log", t => {
  const room = open(t, { bodiesAtRest: true });
  const text = big("recover");
  room.post("m", text);
  room.store.db.prepare("DELETE FROM projection_bodies").run();
  const page = readConversation(room.store, room.owner(), "commons", { limit: 10 });
  assert.equal(page.messages.find(m => m.id === "m")?.body, text);
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

test("incident 2026-10-07: the 4 MiB guard refuses growth and bodies-at-rest restores writes without losing text", t => {
  const clock = () => { let at = Date.parse("2026-10-06T00:00:00Z"); return () => (at += 120000); };
  const bodyBytes = 45000;
  const count = Math.ceil(PILOT_LIMITS.projectionBytes / bodyBytes) + 2;
  const fat = open(t, { bodiesAtRest: false, now: clock() });
  let refused = false;
  for (let i = 0; i < count; i += 1) {
    const before = fat.raw();
    try { fat.post(`m${i}`, big(`m${i}`, bodyBytes)); }
    catch (error) {
      assert.equal(error.code, "pilot_limit");
      assert.equal(fat.raw(), before, "refused growth must not alter the stored projection");
      refused = true;
      break;
    }
  }
  assert.equal(refused, true, "inline bodies must reach the configured guard");
  assert.ok(Buffer.byteLength(fat.raw()) <= PILOT_LIMITS.projectionBytes);
  const messages = fat.store.room("commons").state.messages;
  assert.ok(messages.length > 0, "the recovery fixture contains retained message bodies");

  // The release lane enables ROOM_BODIES_AT_REST=1. The next write slims
  // the stored row while retaining every previously accepted full body.
  fat.reopen({ bodiesAtRest: true, now: clock() });
  fat.post("recovery", big("recovery", bodyBytes));
  assert.ok(Buffer.byteLength(fat.raw()) < PILOT_LIMITS.projectionBytes);
  fat.reopen({ bodiesAtRest: true, now: clock() });
  const recovered = fat.store.room("commons").state.messages;
  assert.deepEqual(recovered.filter(m => m.id !== "recovery"), messages,
    "all retained messages remain readable after slimming and restart");
  assert.equal(recovered.find(m => m.id === "recovery").body, big("recovery", bodyBytes));
  auditRecovery(fat.store);
});

test("the projection-cap rejection names the recovery (ask the owner, or retry later)", t => {
  // 2026-10-07 muse-room incident: every state-changing write 409'd with
  // "Room projection limit reached; no data was changed" — a dead end that
  // named no recovery. The message must tell the user what to do.
  const clock = () => { let at = Date.parse("2026-10-06T00:00:00Z"); return () => (at += 120000); };
  const room = open(t, { bodiesAtRest: false, now: clock() });
  const bodyChars = 59000;
  const postedBytes = Buffer.byteLength(big("p0", bodyChars));
  const headroomPosts = 1;
  const store = room.store;
  const boundRoom = store.room.bind(store);
  store.room = id => { const result = boundRoom(id); return { sequence: result.sequence,
    state: { ...result.state, capacityFixture: "x".repeat(PILOT_LIMITS.projectionBytes - headroomPosts * postedBytes) } }; };
  let failure = null;
  try { room.post("p0", big("p0", bodyChars)); } catch (error) { failure = error; }
  assert.ok(failure, "the projection cap refuses the write");
  assert.equal(failure.code, "pilot_limit");
  assert.match(failure.message, /no data was changed/, "keeps the no-write guarantee");
  assert.match(failure.message, /room owner/i, "names asking the room owner as the recovery");
  assert.match(failure.message, /try again later/i, "names retrying later as the recovery");
});
