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
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { PILOT_LIMITS } from "../server/pilot-limits.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { auditRecovery } from "../server/recovery.mjs";
import { readConversation } from "../server/conversation-sync.mjs";
import { BODY_AT_REST_MIN_CHARS, hydrateRecordText } from "../server/projection-at-rest.mjs";

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

// --- Source pins -----------------------------------------------------------
// Both pins scan whole files, never single lines: a check, its fail() call,
// an SQL string, and its .run(...) routinely wrap across lines (the style
// already used at server/access-requests.mjs:554), and a per-line scan that
// requires co-location on one physical line is bypassed by that ordinary
// formatting (issue #2901). The scanners are pure functions of source text so
// the regression test below can pin them against synthetic fixtures.

function serverSources() {
  const serverDir = fileURLToPath(new URL("../server/", import.meta.url));
  const files = [];
  const walk = dir => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (path.endsWith(".mjs")) files.push(path); } };
  walk(serverDir);
  return files.map(path => ({ label: path.slice(serverDir.length), source: readFileSync(path, "utf8") }));
}

const lineNumberAt = (source, index) => source.slice(0, index).split("\n").length;

// The fail() rejecting a projectionBytes check may sit on following lines and
// its message may be wrapped or concatenated, so search a window of source
// after each cap token for the first pilot_limit fail and check its message.
// Cap uses that do not reject with a 409 (continue, return, headroom math)
// have no such fail in the window and are not offenders.
const CAP_FAIL_PATTERN = /fail\(\s*409\s*,\s*["']pilot_limit["']\s*,\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)(?:\s*\+\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`))*)/;
const RECOVERY_PATTERN = /room owner|ask its owner|try again later/i;

function projectionCapOffenders(label, source) {
  const offenders = [];
  const reported = new Set();
  let index = source.indexOf("PILOT_LIMITS.projectionBytes");
  while (index !== -1) {
    const fail = CAP_FAIL_PATTERN.exec(source.slice(index, index + 1000));
    if (fail && !RECOVERY_PATTERN.test(fail[1]) && !reported.has(index + fail.index)) {
      reported.add(index + fail.index);
      offenders.push(`${label}:${lineNumberAt(source, index + fail.index)}`);
    }
    index = source.indexOf("PILOT_LIMITS.projectionBytes", index + 1);
  }
  return offenders;
}

// A rooms.projection write bypasses the serializer when its statement (up to
// the terminating ";") stringifies state inline, or when a `projection`
// binding is assigned a direct JSON.stringify — in either formatting, on one
// line or wrapped across several.
function serializerOffenders(label, source) {
  const offenders = [];
  let match;
  const writePattern = /(?:UPDATE\s+rooms\s+SET|INTO\s+rooms\s*\()/g;
  while ((match = writePattern.exec(source)) !== null) {
    const end = source.indexOf(";", match.index);
    const statement = source.slice(match.index, end === -1 ? match.index + 1000 : Math.min(end + 1, match.index + 1000));
    if (/projection/.test(statement) && /JSON\.stringify\(/.test(statement)) {
      offenders.push(`${label}:${lineNumberAt(source, match.index)}`);
    }
  }
  const directPattern = /\b(?:const|let|var)\s+projection\s*=\s*JSON\.stringify\(/g;
  while ((match = directPattern.exec(source)) !== null) {
    offenders.push(`${label}:${lineNumberAt(source, match.index)}`);
  }
  return offenders;
}

test("every PILOT_LIMITS.projectionBytes 409 names a recovery (no dead-end cap message)", () => {
  // 2026-10-07 muse-room incident follow-up: PR #1810 fixed the 6
  // "Room projection limit reached" sites but left 7 sibling
  // PILOT_LIMITS.projectionBytes checks (guest-invites.mjs, guest-agent-links.mjs,
  // share-links.mjs) rejecting with "Room storage limit reached" and no recovery.
  // Every projection-cap rejection must tell the user what to do, so a new site
  // added without recovery text fails this test.
  const offenders = [];
  for (const { label, source } of serverSources()) offenders.push(...projectionCapOffenders(label, source));
  assert.deepEqual(offenders, [],
    `projection-cap 409 without a named recovery: ${offenders.join(", ")}`);
});

test("every rooms.projection write goes through the serializer", () => {
  const offenders = [];
  for (const { label, source } of serverSources()) offenders.push(...serializerOffenders(label, source));
  assert.deepEqual(offenders, []);
  assert.ok(BODY_AT_REST_MIN_CHARS >= 256);
});

test("the source pins catch multi-line code, not just single-line statements", () => {
  // Regression for #2901: both pins used to scan line-by-line, so each shape
  // below evaded them. The scanners must flag the multi-line bypasses, keep
  // flagging the single-line ones, and stay quiet for legitimate code.
  const multilineCap = [
    "if (Buffer.byteLength(projection) > PILOT_LIMITS.projectionBytes) {",
    "  fail(409, \"pilot_limit\", \"Room storage limit reached; no data was changed.\");",
    "}",
  ].join("\n");
  assert.deepEqual(projectionCapOffenders("fixture.mjs", multilineCap), ["fixture.mjs:2"]);
  const singleLineCap = "if (Buffer.byteLength(projection) > PILOT_LIMITS.projectionBytes) fail(409, \"pilot_limit\", \"Room storage limit reached\");";
  assert.deepEqual(projectionCapOffenders("fixture.mjs", singleLineCap), ["fixture.mjs:1"]);
  const wrappedCapWithRecovery = [
    "if (Buffer.byteLength(projection) > PILOT_LIMITS.projectionBytes)",
    "  fail(",
    "    409,",
    "    \"pilot_limit\",",
    "    \"Room projection limit reached; no data was changed. \" +",
    "      \"Ask the room owner to raise the limit, or try again later.\");",
  ].join("\n");
  assert.deepEqual(projectionCapOffenders("fixture.mjs", wrappedCapWithRecovery), []);
  const nonRejection = "if (Buffer.byteLength(projection) > PILOT_LIMITS.projectionBytes) continue;";
  assert.deepEqual(projectionCapOffenders("fixture.mjs", nonRejection), []);
  const multilineWrite = [
    "db.prepare(\"UPDATE rooms SET sequence=?, projection=? WHERE id=?\")",
    "  .run(sequence, JSON.stringify(state), roomId);",
  ].join("\n");
  assert.deepEqual(serializerOffenders("fixture.mjs", multilineWrite), ["fixture.mjs:1"]);
  const multilineDirect = "const projection =\n  JSON.stringify(state);";
  assert.deepEqual(serializerOffenders("fixture.mjs", multilineDirect), ["fixture.mjs:1"]);
  const serializerWrite = [
    "db.prepare(\"UPDATE rooms SET sequence=?, projection=? WHERE id=?\")",
    "  .run(sequence, this.store.storedProjection(roomId, state), roomId);",
  ].join("\n");
  assert.deepEqual(serializerOffenders("fixture.mjs", serializerWrite), []);
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

test("certified indexed reads return full bodies while the stored row stays slim", t => {
  // Phase 1a x certified index interaction: the indexed path skips
  // hydrateRecordText by design, so the messages table must always carry
  // complete records even when rooms.projection is slimmed. If a future
  // change slims the indexed records too, readers would see bodyRef.
  const room = open(t, { bodiesAtRest: true });
  const text = big("indexed");
  room.post("m", text);
  room.post("short", "hello");
  const stored = JSON.parse(room.raw());
  assert.match(stored.messages.find(m => m.id === "m").bodyRef, /^[0-9a-f]{64}$/,
    "precondition: the stored projection row is slimmed");
  for (let page = 0; page < 20; page++) if (room.store.backfillMessages({ limit: 400 }).done) break;
  assert.equal(room.store.checkMessagesParity().checked, 1, "precondition: the certified index covers the head");
  const page = readConversation(room.store, room.owner(), "commons", { limit: 10 });
  assert.equal(page.messages.find(m => m.id === "m")?.body, text);
  assert.equal(page.messages.some(m => "bodyRef" in m), false, "indexed records must never leak bodyRef to readers");
});

test("the unindexed conversation read recovers a tampered body row from the log", t => {
  // Out-of-band corruption, not just a missing row: the body row exists but
  // its content no longer matches the sha the projection references. The
  // recover fallback (8956bc3b2) must serve the true body from the event log.
  const room = open(t, { bodiesAtRest: true });
  const text = big("tampered");
  room.post("m", text);
  const sha = JSON.parse(room.raw()).messages.find(m => m.id === "m").bodyRef;
  assert.match(sha, /^[0-9a-f]{64}$/, "precondition: the stored record is slimmed");
  room.store.db.prepare("UPDATE projection_bodies SET body=? WHERE room_id='commons' AND sha=?")
    .run("x".repeat(6000), sha);
  const page = readConversation(room.store, room.owner(), "commons", { limit: 10 });
  assert.equal(page.messages.find(m => m.id === "m")?.body, text);
});

test("hydrateRecordText without a recovery source fails closed on a missing body", t => {
  // Fail-closed contract: with no recover function a missing body row is a
  // hard error, never an empty body or a leaked bodyRef.
  const room = open(t, { bodiesAtRest: true });
  room.post("m", big("gone"));
  const record = JSON.parse(room.raw()).messages.find(m => m.id === "m");
  assert.ok(typeof record.bodyRef === "string", "precondition: the stored record is slimmed");
  room.store.db.prepare("DELETE FROM projection_bodies").run();
  assert.throws(() => hydrateRecordText(room.store.db, "commons", JSON.stringify(record)),
    /projection_corrupt/, "a missing body with no recovery source throws");
  const inline = JSON.stringify({ id: "s", body: "hi" });
  assert.equal(hydrateRecordText(room.store.db, "commons", inline), inline,
    "records without a bodyRef pass through untouched");
});
