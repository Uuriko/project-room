// H1 relief valve: the 4MiB rooms.projection cap used to be a hard 409
// dead-end — no telemetry, no warning, no recovery. This file proves the
// dead-end first (the characterization test needs no relief code), then pins
// the relief: per-write projection telemetry, edge-triggered warnings at
// 70/85/95% of the cap (room-visible + logged), and one archival paging pass
// that lets a would-be 409 write land when short bodies can page out.
//
// Fail-first note: tests that import ../server/projection-relief.mjs fail
// until the module exists. The dead-end test below it does not import the
// module, so it runs — and passes — before the fix, proving the 409.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, PILOT_LIMITS } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const relief = () => import("../server/projection-relief.mjs");

// A moving clock keeps the per-member message rate limit out of the way.
const clock = () => { let at = Date.parse("2026-10-06T00:00:00Z"); return () => (at += 120000); };

function open(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-relief-"));
  const file = join(directory, "room.sqlite");
  const store = new RoomStore(file, options);
  store.initialize(initialRoom());
  const owner = () => store.issueAccessKey("commons", "owner");
  const post = (messageId, body) => store.command(owner(), "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId, body } });
  const raw = () => store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, owner, post, raw };
}

// Simulate a near-cap room without posting 4 MiB: the write path reads the
// room through store.room(), so a capacityFixture key on the returned state
// counts toward the stored row exactly like real state would. The patch is
// installed once; setPressure retargets it, stripping the previous fixture
// so targets are absolute, never cumulative.
function pressureRig(store) {
  const realRoom = store.room.bind(store);
  let fixtureSize = 0;
  const nakedBytes = () => {
    const { capacityFixture, ...rest } = realRoom("commons").state;
    return Buffer.byteLength(JSON.stringify(rest));
  };
  store.room = id => {
    const result = realRoom(id);
    const { capacityFixture, ...rest } = result.state;
    return { sequence: result.sequence,
      state: fixtureSize > 0 ? { ...rest, capacityFixture: "x".repeat(fixtureSize) } : rest };
  };
  // With bodiesAtRest off and no bodyRefs, storedProjection is byte-for-byte
  // JSON.stringify(state), so the naked size plus fixture predicts pressure.
  const setPressure = targetRatio => {
    fixtureSize = Math.max(0, Math.floor(targetRatio * PILOT_LIMITS.projectionBytes) - nakedBytes());
  };
  return { realRoom, setPressure };
}

const warningsOf = store =>
  store.db.prepare("SELECT threshold, ratio FROM projection_warnings WHERE room_id='commons' ORDER BY threshold").all();

test("dead-end, pre-relief: a write relief cannot save still 409s and changes nothing", t => {
  // No relief import: this runs before the fix and proves the 409 dead-end.
  const room = open(t, { bodiesAtRest: false, now: clock() });
  // 59_000-char bodies are above the at-rest threshold, so the relief valve
  // must not page them: the cap still means the cap for genuinely big state.
  const bigBody = "z".repeat(59000);
  room.post("b0", bigBody);
  const { realRoom, setPressure } = pressureRig(room.store);
  // Pre-write pressure just under the cap; b1's ~59 KiB then breaches it.
  setPressure((PILOT_LIMITS.projectionBytes - 58000) / PILOT_LIMITS.projectionBytes);
  const before = room.raw();
  const beforeSeq = realRoom("commons").sequence;
  let error = null;
  try { room.post("b1", bigBody); } catch (e) { error = e; }
  assert.ok(error, "expected the write to be refused");
  assert.equal(error.code, "pilot_limit");
  assert.match(error.message, /Room projection limit reached/);
  assert.equal(room.raw(), before, "the refused write stored nothing");
  assert.equal(realRoom("commons").sequence, beforeSeq, "the sequence did not advance");
});

test("telemetry: every room write records its stored projection size", async t => {
  await relief(); // fails until the module exists
  const room = open(t, { now: clock() });
  room.post("m1", "hello");
  room.post("m2", "world");
  const rows = room.store.db.prepare(
    "SELECT sequence, bytes, pressure_bytes, ratio FROM projection_telemetry WHERE room_id='commons' ORDER BY sequence").all();
  assert.equal(rows.length, 2, "one telemetry row per write");
  for (const row of rows) {
    assert.ok(row.bytes > 0, "bytes recorded");
    assert.ok(row.ratio > 0 && row.ratio < 0.7, `ratio ${row.ratio} below the first warning`);
    assert.equal(row.pressure_bytes, row.bytes, "no relief ran, so pressure equals stored size");
  }
  assert.equal(rows[1].bytes, Buffer.byteLength(room.raw()), "telemetry bytes match the stored row");
  assert.deepEqual(warningsOf(room.store), [], "no warnings below 70%");
});

test("warnings fire at 70/85/95% exactly once each, then never again", async t => {
  const { PROJECTION_WARN_THRESHOLDS } = await relief();
  assert.deepEqual([...PROJECTION_WARN_THRESHOLDS], [0.7, 0.85, 0.95]);
  const room = open(t, { bodiesAtRest: false, now: clock() });
  room.post("m1", "hello");
  // Walk the room up through each threshold with the fixture, one write each.
  const { setPressure } = pressureRig(room.store);
  setPressure(0.75);
  room.post("w70", "x");
  assert.deepEqual(warningsOf(room.store).map(w => w.threshold), [0.7]);
  setPressure(0.88);
  room.post("w85", "x");
  assert.deepEqual(warningsOf(room.store).map(w => w.threshold), [0.7, 0.85]);
  setPressure(0.97);
  room.post("w95", "x");
  assert.deepEqual(warningsOf(room.store).map(w => w.threshold), [0.7, 0.85, 0.95]);
  // Edge-triggered: another write at ~97% fires nothing new.
  room.post("w95b", "x");
  assert.deepEqual(warningsOf(room.store).map(w => w.threshold), [0.7, 0.85, 0.95]);
  // Room-visible: the store read model surfaces every warning.
  const health = room.store.projectionHealth("commons");
  assert.equal(health.roomId, "commons");
  assert.equal(health.capBytes, PILOT_LIMITS.projectionBytes);
  assert.deepEqual(health.thresholds, [0.7, 0.85, 0.95]);
  assert.equal(health.warnings.length, 3);
});

test("relief: paging short bodies out lets a would-be 409 write land", async t => {
  await relief(); // fails until the module exists
  const room = open(t, { bodiesAtRest: false, now: clock() });
  // Fill with short (<256 char) bodies: the only thing the relief valve pages.
  const short = i => `short-${i}:` + "y".repeat(120);
  for (let i = 0; i < 30; i++) room.post(`s${i}`, short(i));
  // Pressure at the cap line: the next short post would breach it.
  const { realRoom, setPressure } = pressureRig(room.store);
  setPressure(1.0);
  const seqBefore = realRoom("commons").sequence;
  const result = room.post("s-final", short(999)); // 409s without the relief valve
  assert.equal(result.sequence, seqBefore + 1, "the write landed instead of 409ing");
  const stored = JSON.parse(room.raw());
  const paged = stored.messages.filter(m => typeof m.bodyRef === "string");
  assert.ok(paged.length > 0, "short bodies paged out to projection_bodies");
  assert.ok(stored.messages.every(m => !("body" in m) || m.body.length < 256 || "bodyRef" in m),
    "no long inline body was left behind by the relief pass");
  // Reads are unchanged: full bodies hydrate, replay included.
  const live = room.store.room("commons").state.messages;
  assert.equal(live.find(m => m.id === "s-final").body, short(999));
  assert.equal(live.find(m => m.id === "s0").body, short(0));
  assert.equal(JSON.stringify(room.store.rebuildProjection("commons").state.messages), JSON.stringify(live));
  // The near-miss warned on pressure even though the stored row shrank.
  const thresholds = warningsOf(room.store).map(w => w.threshold);
  assert.ok(thresholds.includes(0.95), `expected a 95% pressure warning, got ${JSON.stringify(thresholds)}`);
  const sample = room.store.db.prepare(
    "SELECT bytes, pressure_bytes FROM projection_telemetry WHERE room_id='commons' ORDER BY sequence DESC LIMIT 1").get();
  assert.ok(sample.pressure_bytes > PILOT_LIMITS.projectionBytes, "pressure recorded above the cap");
  assert.ok(sample.bytes <= PILOT_LIMITS.projectionBytes, "stored row back under the cap after paging");
  const health = room.store.projectionHealth("commons");
  assert.ok(health.warnings.some(w => w.threshold === 0.95), "the 95% warning is room-visible");
});

test("telemetry failure cannot break a room write", async t => {
  await relief(); // fails until the module exists
  const room = open(t, { now: clock() });
  room.store.db.exec("DROP TABLE projection_telemetry; DROP TABLE projection_warnings;");
  const result = room.post("m1", "hello"); // must not throw: telemetry is fail-closed
  assert.ok(result.sequence >= 1, "the write landed despite the telemetry outage");
});
