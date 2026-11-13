// P3: staged export parts accumulated in the Durable Object's own store and
// then blocked the backup that would have swept them.
//
// 1. cloudflare/room-backup.mjs byteChunks() released the reader lock when the
//    backup consumer left a stream early (a failed KV part write, a verification
//    refusal inside the loop) but never cancelled the stream, so the stream's
//    cancel() -> clear() never ran: the export's staged rows stayed, and the
//    export id stayed in the isolate's active set, which the sweep honours.
// 2. The only sweep runs inside the NEXT materialize, but
//    exportNdjsonConsistentStream refused on the size guard BEFORE materializing,
//    and storeDatabaseBytes counted the staging table itself (and free pages left
//    by earlier deletes). A store inflated by orphaned staging therefore tripped the
//    guard, which prevented the sweep that would have shrunk it.
// Every test here fails on origin/main (5844f827) and passes with the fix.
// All stores are disposable temp stores; nothing here touches live data.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  exportNdjsonConsistentStream, storeDatabaseBytes,
  BACKUP_EXPORT_PARTS_TABLE, BACKUP_SNAPSHOT_TOO_LARGE
} from "../server/room-export.mjs";
import { writeKvBackup } from "../cloudflare/room-backup.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function openStore(t, messages = 4, bodyPad = 400) {
  const directory = mkdtempSync(join(tmpdir(), "staged-parts-leak-"));
  const store = new RoomStore(join(directory, "live.sqlite"));
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  for (let i = 0; i < messages; i += 1) {
    store.command(key, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: `m-${i}`, body: `message ${i} ${"x".repeat(bodyPad)}` } });
  }
  return store;
}

const stagedStats = store => {
  const exists = store.db.prepare("SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name=?").get(BACKUP_EXPORT_PARTS_TABLE);
  if (!exists) return { rows: 0, exports: 0, bytes: 0 };
  const row = store.db.prepare(`SELECT count(*) AS rows, count(DISTINCT export_id) AS exports, coalesce(sum(length(bytes)), 0) AS bytes FROM "${BACKUP_EXPORT_PARTS_TABLE}"`).get();
  return { rows: Number(row.rows), exports: Number(row.exports), bytes: Number(row.bytes) };
};

// An in-memory KV whose put fails from the Nth call on.
function flakyKv(failFrom) {
  const data = new Map();
  let puts = 0;
  return {
    data,
    async put(key, value) { puts += 1; if (puts >= failFrom) throw new Error("kv unavailable"); data.set(key, value); },
    async get(key) { return data.get(key) ?? null; }
  };
}

test("a backup that fails mid-stream cancels its export, so no staged parts are left behind", async t => {
  const store = openStore(t, 6, 300);
  const body = exportNdjsonConsistentStream(store, { partBytes: 200 });
  assert.ok(stagedStats(store).rows >= 1, "the export is staged");
  // Tiny KV parts, and the second KV write fails while the stream is still being pulled.
  await assert.rejects(() => writeKvBackup(flakyKv(2), "room-backups/2026-11-13.ndjson", body, { partBytes: 256 }));
  assert.deepEqual(stagedStats(store), { rows: 0, exports: 0, bytes: 0 }, "the aborted export's staged rows must be cleared");
});

test("orphaned staged exports are swept before the size guard, so they cannot block the backup that would clear them", async t => {
  const store = openStore(t, 4, 400);
  const liveBytes = storeDatabaseBytes(store.db);
  // Three exports that were staged and then abandoned (isolate reset): not in this isolate's active set.
  for (const id of ["orphan-a", "orphan-b", "orphan-c"]) {
    store.db.prepare(`CREATE TABLE IF NOT EXISTS "${BACKUP_EXPORT_PARTS_TABLE}" (export_id TEXT NOT NULL DEFAULT '', part_index INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (export_id, part_index))`).run();
    for (let part = 0; part < 4; part += 1) store.db.prepare(`INSERT INTO "${BACKUP_EXPORT_PARTS_TABLE}" (export_id, part_index, bytes) VALUES (?, ?, ?)`).run(id, part, new Uint8Array(512 * 1024));
  }
  const before = { staged: stagedStats(store), databaseBytes: storeDatabaseBytes(store.db) };
  assert.equal(before.staged.exports, 3);
  assert.ok(before.databaseBytes > liveBytes + 5 * 1024 * 1024, "the orphans inflate the measured store");
  // A bound that fits the real data comfortably but not the orphan-inflated store.
  const maxSnapshotBytes = liveBytes + 1024 * 1024;
  assert.ok(before.databaseBytes > maxSnapshotBytes);
  const stream = exportNdjsonConsistentStream(store, { maxSnapshotBytes });
  const text = await new Response(stream).text();
  assert.match(text, /"kind":"trailer"/, "the export proceeds once the orphans are swept");
  const after = { staged: stagedStats(store), databaseBytes: storeDatabaseBytes(store.db) };
  assert.deepEqual(after.staged, { rows: 0, exports: 0, bytes: 0 });
  assert.ok(after.databaseBytes <= maxSnapshotBytes, `measured store ${after.databaseBytes} must fall back under ${maxSnapshotBytes}`);
  console.log(JSON.stringify({ evidence: "p3-size-before-after", liveBytesBeforeOrphans: liveBytes, before, after, boundBytes: maxSnapshotBytes }));
});

test("a genuinely oversized store still refuses before staging anything", t => {
  const store = openStore(t, 4, 400);
  assert.throws(() => exportNdjsonConsistentStream(store, { maxSnapshotBytes: 1024 }), new RegExp(BACKUP_SNAPSHOT_TOO_LARGE));
  assert.deepEqual(stagedStats(store), { rows: 0, exports: 0, bytes: 0 }, "a refusal writes no staging row");
});

test("an export that is still streaming keeps its parts while a second export sweeps", async t => {
  const store = openStore(t, 4, 400);
  const first = exportNdjsonConsistentStream(store, { partBytes: 200 });
  const reader = first.getReader();
  const head = await reader.read();
  assert.equal(head.done, false);
  const second = exportNdjsonConsistentStream(store, { partBytes: 200 });
  assert.equal(stagedStats(store).exports, 2, "the live export is not swept as an orphan");
  await new Response(second).text();
  for (;;) { const { done } = await reader.read(); if (done) break; }
  assert.deepEqual(stagedStats(store), { rows: 0, exports: 0, bytes: 0 });
});
