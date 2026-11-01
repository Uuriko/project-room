// Patrol's idempotency look-back must not re-read a room's whole preceding
// history on every batch: with a fixed 200-event tail, the rows the look-back
// reads stay flat as history grows. Duplicates across batches are still
// found, including for rooms patrolled before the key index existed.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { runPatrolTick, ensurePatrolSchema, PATROL_BATCH } from "../server/patrol.mjs";

function roomWithEvents(count, { keyAt = () => null } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "project-room-idem-")), "room.sqlite");
  const store = new RoomStore(path);
  store.initialize(initialRoom("idem"));
  const base = store.db.prepare("SELECT sequence FROM rooms WHERE id='idem'").get().sequence;
  keyAt = keyAt.bind(null, base);
  const insert = store.db.prepare("INSERT INTO events VALUES(?,?,?,?)");
  store.db.exec("BEGIN");
  for (let i = 1; i <= count; i++) {
    const sequence = base + i, id = `ev-${sequence}`;
    insert.run("idem", sequence, id, JSON.stringify({ id, roomId: "idem", sequence, type: "test.noop", idempotencyKey: keyAt(sequence) ?? `k-${sequence}` }));
  }
  store.db.prepare("UPDATE rooms SET sequence=? WHERE id='idem'").run(base + count);
  store.db.exec("COMMIT");
  return { store, path, base };
}
// Record every statement the final batch runs that reads a room's events at
// or before the batch start: that is the scan whose cost grows with history.
// (Returned-row counts would not show it: the scan returns only matches.)
function historyScans(store, run) {
  const real = store.db.prepare.bind(store.db);
  const seen = [];
  store.db.prepare = sql => { if (/FROM events WHERE room_id=\? AND sequence<=\?/.test(sql)) seen.push(sql); return real(sql); };
  try { run(); } finally { store.db.prepare = real; }
  return seen.length;
}
const steady = store => { for (let i = 0; i < 400; i++) { const r = runPatrolTick(store, { roomId: "idem" }); if (!r.rooms && !r.checked) break; } };

test("with coverage, the final batch's look-back reads no preceding history, at any history size", () => {
  for (const history of [400, 1600]) {
    const { store } = roomWithEvents(history + PATROL_BATCH);
    for (let i = 0; i < history / PATROL_BATCH; i++) runPatrolTick(store, { roomId: "idem" });
    assert.equal(historyScans(store, () => runPatrolTick(store, { roomId: "idem" })), 0, `history ${history}`);
    store.close();
  }
});

test("a key reused across batches is still filed as idempotency_duplicate", () => {
  const { store, base } = roomWithEvents(3 * PATROL_BATCH, { keyAt: (b, s) => (s === b + 2 * PATROL_BATCH + 7 ? `k-${b + 5}` : null) });
  steady(store);
  const dup = store.db.prepare("SELECT sequence, detail FROM patrol_findings WHERE kind='idempotency_duplicate'").all();
  assert.deepEqual(dup.map(row => [row.sequence, JSON.parse(row.detail).firstSequence]), [[base + 2 * PATROL_BATCH + 7, base + 5]]);
});

test("a room patrolled before the key index existed still finds an old duplicate and gains coverage", () => {
  const { store, base } = roomWithEvents(4 * PATROL_BATCH, { keyAt: (b, s) => (s === b + 3 * PATROL_BATCH + 9 ? `k-${b + 3}` : null) });
  runPatrolTick(store, { roomId: "idem" });
  runPatrolTick(store, { roomId: "idem" });
  // Simulate the pre-index state: the cursor moved, but no keys were indexed.
  ensurePatrolSchema(store);
  store.db.exec("DELETE FROM patrol_idem_keys; DELETE FROM patrol_idem_coverage;");
  steady(store);
  const dup = store.db.prepare("SELECT sequence, detail FROM patrol_findings WHERE kind='idempotency_duplicate'").all();
  assert.deepEqual(dup.map(row => [row.sequence, JSON.parse(row.detail).firstSequence]), [[base + 3 * PATROL_BATCH + 9, base + 3]]);
  const through = store.db.prepare("SELECT through FROM patrol_idem_coverage WHERE room_id='idem'").get()?.through;
  assert.equal(through, base + 4 * PATROL_BATCH, "coverage catches up to the cursor");
});

test("a gap just before the batch start does not stall legacy coverage", () => {
  const { store } = roomWithEvents(3 * PATROL_BATCH);
  runPatrolTick(store, { roomId: "idem" });
  const cursor = store.db.prepare("SELECT sequence FROM patrol_cursor WHERE room_id='idem'").get().sequence;
  ensurePatrolSchema(store);
  store.db.exec("DELETE FROM patrol_idem_keys; DELETE FROM patrol_idem_coverage;");
  // The last few events before the cursor are missing from the log.
  store.db.prepare("DELETE FROM events WHERE room_id='idem' AND sequence>? AND sequence<?").run(cursor - 5, cursor);
  runPatrolTick(store, { roomId: "idem" });
  const through = store.db.prepare("SELECT through FROM patrol_idem_coverage WHERE room_id='idem'").get()?.through;
  assert.equal(through, cursor + PATROL_BATCH);
});

// Patrol's continuation and key-index tables are lazy application tables:
// an export taken after a tick must restore (every restore path builds
// lazy schemas from code-owned DDL, never from the export).
test("an export taken after patrol ticks restores, keeping rotation; the derived key index is skipped and rebuilt", async () => {
  const { exportNdjsonText } = await import("../server/room-export.mjs");
  const { replayNdjsonInto } = await import("../server/restore-ndjson.mjs");
  const store = new RoomStore(join(mkdtempSync(join(tmpdir(), "project-room-idem-export-")), "room.sqlite"));
  store.initialize(initialRoom("idem"));
  const key = store.issueAccessKey("idem", "owner");
  for (let i = 0; i < 3; i++) store.command(key, "idem", { id: `c-${i}`, type: "message.posted", data: { body: "b", messageId: `m-${i}` } });
  runPatrolTick(store, { limit: 2 });
  runPatrolTick(store, { limit: 2 });
  const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const before = ["patrol_rotation", "patrol_idem_keys", "patrol_idem_coverage"].map(table => count(store.db, table));
  assert.ok(before.every(n => n > 0), `fixture populates every table: ${before}`);
  const restored = new RoomStore(":memory:");
  try {
    const result = replayNdjsonInto(exportNdjsonText(store.db), restored);
    assert.equal(result.verified, true);
    assert.equal(count(restored.db, "patrol_rotation"), before[0], "rotation carries");
    assert.deepEqual([result.skippedTables.patrol_idem_keys, result.skippedTables.patrol_idem_coverage], [before[1], before[2]],
      "the derived key index is reported as skipped, never silently dropped");
    ensurePatrolSchema(restored);
    assert.equal(count(restored.db, "patrol_idem_coverage"), 0, "a restore starts uncovered");
  } finally { restored.close(); store.close(); }
});

const cursorOf = store => store.db.prepare("SELECT sequence FROM patrol_cursor WHERE room_id='idem'").get()?.sequence ?? 0;
const coverageOf = store => store.db.prepare("SELECT through FROM patrol_idem_coverage WHERE room_id='idem'").get()?.through;
const dupsOf = store => store.db.prepare("SELECT sequence, detail FROM patrol_findings WHERE kind='idempotency_duplicate' ORDER BY sequence").all()
  .map(row => [row.sequence, JSON.parse(row.detail).firstSequence]);

// Dot 25528: legacy catch-up interrupted mid-backfill (store closed and
// reopened) resumes from the persisted coverage, and a key first used in
// the not-yet-indexed part of history but reused in the tail is still found.
test("legacy catch-up survives a reopen mid-backfill and finds a duplicate spanning the backfill/tail boundary", () => {
  const { store, path, base } = roomWithEvents(7 * PATROL_BATCH, { keyAt: (b, s) => (s === b + 6 * PATROL_BATCH + 4 ? `k-${b + 650}` : null) });
  for (let i = 0; i < 4; i++) runPatrolTick(store, { roomId: "idem" });
  ensurePatrolSchema(store);
  store.db.exec("DELETE FROM patrol_idem_keys; DELETE FROM patrol_idem_coverage;");
  runPatrolTick(store, { roomId: "idem" });
  const partial = coverageOf(store);
  assert.ok(partial < cursorOf(store) - PATROL_BATCH, `first slice is bounded (${partial})`);
  assert.ok(partial < base + 650, "the reused key's first use is not yet indexed");
  store.close();
  const reopened = new RoomStore(path);
  assert.equal(coverageOf(reopened), partial, "coverage persisted across the reopen");
  steady(reopened);
  assert.deepEqual(dupsOf(reopened), [[base + 6 * PATROL_BATCH + 4, base + 650]]);
  assert.equal(coverageOf(reopened), cursorOf(reopened), "coverage reaches the cursor");
  reopened.close();
});

// Stale coverage must never certify absence: a replaced log (the cursor's
// event id no longer matches) resets the key index and coverage with the
// other shadows, so a duplicate in the new history is found.
test("a replaced log invalidates coverage; the rebuilt index finds the new history's duplicate", () => {
  const { store, base } = roomWithEvents(3 * PATROL_BATCH);
  steady(store);
  assert.equal(coverageOf(store), cursorOf(store));
  // Replace the log: same sequences, new ids, and a key reused across batches.
  store.db.exec("BEGIN");
  const rewrite = store.db.prepare("UPDATE events SET id=?, body=? WHERE room_id='idem' AND sequence=?");
  for (let s = base + 1; s <= base + 3 * PATROL_BATCH; s++) {
    const id = `new-${s}`, key = s === base + 2 * PATROL_BATCH + 3 ? `n-${base + 11}` : `n-${s}`;
    rewrite.run(id, JSON.stringify({ id, roomId: "idem", sequence: s, type: "test.noop", idempotencyKey: key }), s);
  }
  store.db.exec("COMMIT");
  runPatrolTick(store, { roomId: "idem" });
  assert.ok(!store.db.prepare("SELECT 1 FROM patrol_idem_keys WHERE room_id='idem' AND idem_key LIKE 'k-%'").get(), "old keys dropped on reset");
  steady(store);
  assert.ok(dupsOf(store).some(([seq, first]) => seq === base + 2 * PATROL_BATCH + 3 && first === base + 11));
  assert.equal(coverageOf(store), cursorOf(store));
  store.close();
});

// The key index, coverage and cursor commit together: a failure at the
// cursor write leaves none of them advanced, and the retry completes.
test("a failed commit leaves keys, coverage and cursor exactly as before", () => {
  const { store } = roomWithEvents(3 * PATROL_BATCH);
  runPatrolTick(store, { roomId: "idem" });
  const snap = () => [cursorOf(store), coverageOf(store), store.db.prepare("SELECT COUNT(*) AS n, MAX(first_sequence) AS m FROM patrol_idem_keys").get()];
  const before = snap();
  const real = store.db.prepare.bind(store.db);
  let injected = 0;
  store.db.prepare = sql => { if (/INSERT INTO patrol_cursor/.test(sql)) { injected++; throw new Error("injected"); } return real(sql); };
  try { runPatrolTick(store, { roomId: "idem" }); } catch (error) { assert.match(String(error), /injected/); } finally { store.db.prepare = real; }
  assert.equal(injected, 1, "the commit reached the cursor write");
  assert.deepEqual(snap(), before);
  runPatrolTick(store, { roomId: "idem" });
  assert.equal(cursorOf(store), before[0] + PATROL_BATCH);
  assert.equal(coverageOf(store), cursorOf(store));
  store.close();
});

// Dot 25563: importEvents is the supported way history changes under a
// patrolled room, and it may keep the cursor's event id. An earlier key
// edited by the import, then reused, must be found exactly as the legacy
// look-back finds it: the import invalidates the key index and coverage.
test("importEvents that edits an earlier key under the cursor invalidates coverage; the reuse is found", () => {
  const store = new RoomStore(join(mkdtempSync(join(tmpdir(), "project-room-idem-import-")), "room.sqlite"));
  store.initialize(initialRoom("idem"));
  const key = store.issueAccessKey("idem", "owner");
  for (let i = 0; i < 6; i++) store.command(key, "idem", { id: `c-${i}`, type: "message.posted", data: { body: "b", messageId: `m-${i}` } });
  steady(store);
  assert.equal(coverageOf(store), cursorOf(store), "coverage is trusted before the import");
  const lines = store.db.prepare("SELECT sequence, body FROM events WHERE room_id='idem' ORDER BY sequence").all()
    .map(row => ({ sequence: row.sequence, event: JSON.parse(row.body) }));
  const edited = lines.find(line => typeof line.event.idempotencyKey === "string" && line.sequence > 1 && line.sequence < lines.length - 1);
  assert.ok(edited, "fixture has a keyed event below the cursor");
  edited.event.idempotencyKey = "edited-key";
  const cursorEventId = store.db.prepare("SELECT event_id FROM patrol_cursor WHERE room_id='idem'").get().event_id;
  store.importEvents(key, "idem", lines);
  assert.equal(store.db.prepare("SELECT id FROM events WHERE room_id='idem' AND sequence=?").get(cursorOf(store))?.id, cursorEventId,
    "the import kept the cursor's event id, so the cursor rule alone would not reset");
  const head = store.db.prepare("SELECT sequence FROM rooms WHERE id='idem'").get().sequence + 1;
  store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run("idem", head, `ev-${head}`,
    JSON.stringify({ id: `ev-${head}`, roomId: "idem", sequence: head, type: "test.noop", idempotencyKey: "edited-key" }));
  store.db.prepare("UPDATE rooms SET sequence=? WHERE id='idem'").run(head);
  steady(store);
  assert.ok(dupsOf(store).some(([seq, first]) => seq === head && first === edited.sequence), JSON.stringify(dupsOf(store)));
  store.close();
});

// Dot 25585: export pages are not one snapshot. Pause the export after the
// patrol_idem_coverage page and before the alphabetically later
// patrol_idem_keys page, run a supported import that keeps event ids (it
// clears the source's keys and coverage), then resume. The stream now holds
// old coverage over an emptied key index. The restore must not trust that
// coverage: a reuse of an earlier key after the restore is still found.
test("an import interleaved mid-export cannot leave a restore with stale coverage over an empty key index", async () => {
  const { exportNdjsonLines } = await import("../server/room-export.mjs");
  const { replayNdjsonInto } = await import("../server/restore-ndjson.mjs");
  const store = new RoomStore(join(mkdtempSync(join(tmpdir(), "project-room-idem-interleave-")), "room.sqlite"));
  store.initialize(initialRoom("idem"));
  const key = store.issueAccessKey("idem", "owner");
  for (let i = 0; i < 6; i++) store.command(key, "idem", { id: `c-${i}`, type: "message.posted", data: { body: "b", messageId: `m-${i}` } });
  steady(store);
  assert.equal(coverageOf(store), cursorOf(store), "coverage is trusted before the export");
  const original = store.db.prepare("SELECT sequence, body FROM events WHERE room_id='idem' ORDER BY sequence").all()
    .map(row => ({ sequence: row.sequence, event: JSON.parse(row.body) }));
  const reused = original.find(line => typeof line.event.idempotencyKey === "string" && line.sequence > 1);
  assert.ok(reused, "fixture has a keyed event below the cursor");
  const iterator = exportNdjsonLines(store.db, { pageRows: 1 });
  const lines = [];
  let paused = false;
  for (;;) {
    const step = iterator.next();
    assert.equal(step.done, false, "the export reaches the coverage page");
    lines.push(step.value);
    if (JSON.parse(step.value).table === "patrol_idem_coverage") { paused = true; break; }
  }
  assert.ok(paused && !lines.some(line => JSON.parse(line).table === "patrol_idem_keys"), "paused between coverage and keys");
  const edited = original.map(line => line.sequence === reused.sequence ? { ...line, event: { ...line.event, idempotencyKey: "edited-key" } } : line);
  store.importEvents(key, "idem", edited);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM patrol_idem_keys WHERE room_id='idem'").get().n, 0, "the import emptied the source index");
  for (let step = iterator.next(); !step.done; step = iterator.next()) lines.push(step.value);
  const exported = lines.join("");
  assert.ok(exported.includes('"table":"patrol_idem_coverage"'), "the stream carries the old coverage");
  const restored = new RoomStore(":memory:");
  try {
    const result = replayNdjsonInto(exported, restored, { audit: "report" });
    assert.equal(result.verified, true);
    ensurePatrolSchema(restored);
    assert.equal(restored.db.prepare("SELECT COUNT(*) AS n FROM patrol_idem_coverage").get().n, 0, "stale coverage did not land");
    const firstKey = JSON.parse(restored.db.prepare("SELECT body FROM events WHERE room_id='idem' AND sequence=?").get(reused.sequence).body).idempotencyKey;
    const head = restored.db.prepare("SELECT sequence FROM rooms WHERE id='idem'").get().sequence + 1;
    restored.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run("idem", head, `ev-${head}`,
      JSON.stringify({ id: `ev-${head}`, roomId: "idem", sequence: head, type: "test.noop", idempotencyKey: firstKey }));
    restored.db.prepare("UPDATE rooms SET sequence=? WHERE id='idem'").run(head);
    steady(restored);
    assert.ok(dupsOf(restored).some(([seq, first]) => seq === head && first === reused.sequence), JSON.stringify(dupsOf(restored)));
  } finally { restored.close(); store.close(); }
});

// Dot 25625: a target with zero rooms but stale derived rows (keys and
// coverage left from an earlier use) must not certify the restored history,
// on both the buffered and the streaming restore paths.
for (const mode of ["buffered", "streaming"]) {
  test(`a ${mode} restore into a target with stale derived patrol rows starts uncovered and finds the duplicate`, async () => {
    const { exportNdjsonText } = await import("../server/room-export.mjs");
    const { replayNdjsonInto, createBackupReplaySession } = await import("../server/restore-ndjson.mjs");
    const store = new RoomStore(join(mkdtempSync(join(tmpdir(), `project-room-idem-stale-${mode}-`)), "room.sqlite"));
    store.initialize(initialRoom("idem"));
    const key = store.issueAccessKey("idem", "owner");
    for (let i = 0; i < 6; i++) store.command(key, "idem", { id: `c-${i}`, type: "message.posted", data: { body: "b", messageId: `m-${i}` } });
    steady(store);
    const exported = exportNdjsonText(store.db);
    const restored = new RoomStore(":memory:");
    try {
      ensurePatrolSchema(restored);
      // Stale cache: full coverage over an index that lacks every real key.
      restored.db.prepare("INSERT INTO patrol_idem_coverage (room_id, through) VALUES ('idem', 1000000)").run();
      restored.db.prepare("INSERT INTO patrol_idem_keys (room_id, idem_key, first_sequence) VALUES ('idem', 'stale-key', 1)").run();
      if (mode === "buffered") replayNdjsonInto(exported, restored, { audit: "report" });
      else { const session = createBackupReplaySession(restored, { audit: "report" }); session.writeText(exported); session.finish(); }
      assert.equal(restored.db.prepare("SELECT COUNT(*) AS n FROM patrol_idem_coverage").get().n, 0, "stale coverage cleared");
      assert.equal(restored.db.prepare("SELECT COUNT(*) AS n FROM patrol_idem_keys").get().n, 0, "stale keys cleared");
      const first = restored.db.prepare("SELECT sequence, body FROM events WHERE room_id='idem' ORDER BY sequence").all()
        .map(row => ({ sequence: row.sequence, k: JSON.parse(row.body).idempotencyKey })).find(row => typeof row.k === "string" && row.sequence > 1);
      const head = restored.db.prepare("SELECT sequence FROM rooms WHERE id='idem'").get().sequence + 1;
      restored.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run("idem", head, `ev-${head}`,
        JSON.stringify({ id: `ev-${head}`, roomId: "idem", sequence: head, type: "test.noop", idempotencyKey: first.k }));
      restored.db.prepare("UPDATE rooms SET sequence=? WHERE id='idem'").run(head);
      steady(restored);
      assert.ok(dupsOf(restored).some(([seq, f]) => seq === head && f === first.sequence), JSON.stringify(dupsOf(restored)));
    } finally { restored.close(); store.close(); }
  });
}
