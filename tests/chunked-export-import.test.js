import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exportNdjsonText, exportNdjsonStream, exportNdjsonConsistentStream, BACKUP_SNAPSHOT_TOO_LARGE } from "../server/room-export.mjs";
import { assembleChunkedExport, exportChunkedToDirectory, readChunkedManifest, CHUNKED_EXPORT_PART_MISMATCH, CHUNKED_EXPORT_RESUME_SOURCE_CHANGED } from "../server/chunked-export.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const sha = value => createHash("sha256").update(value).digest("hex");
const restoreScript = fileURLToPath(new URL("../scripts/restore-room-backup.mjs", import.meta.url));

// A small but complete room: an owner, a completed task with a receipt,
// and filler traffic, built through the real command path.
function openFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "chunked-export-"));
  const store = new RoomStore(join(directory, "live.sqlite"));
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  const command = (type, data, id = randomUUID()) => store.command(key, "commons", { id, type, data });
  command(T.WORK_PROPOSED, { workItemId: "w1", title: "Chunked result", definitionOfDone: "A result", accountableMemberId: "owner", mode: "read", independentVerificationRequired: false, ownerDecisionRequired: false });
  command(T.WORK_ACCEPTED, { workItemId: "w1" });
  command(T.WORK_STARTED, { workItemId: "w1" });
  const messageId = randomUUID();
  const posted = command(T.MESSAGE_POSTED, { messageId, body: "Chunked export evidence body", workItemId: "w1" });
  command(T.WORK_COMPLETED, { workItemId: "w1", summary: "Chunked result", nextAction: "Read", evidenceKind: "room_text", evidenceMessageId: messageId, evidenceMessageEventId: posted.event.id, evidenceVersion: `sha256:${sha("Chunked export evidence body")}`, previousCompletionEventId: null, producerId: "owner" });
  for (let i = 0; i < 12; i += 1) command(T.MESSAGE_POSTED, { body: `filler message ${i} ${"x".repeat(512)}` });
  return { directory, store, key };
}

function tableCounts(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n]));
}

test("the guarded paths refuse a store past their bound with backup_snapshot_too_large", t => {
  const { store } = openFixture(t);
  assert.throws(() => exportNdjsonStream(store.db, { maxBytes: 1024 }), error => error.message === BACKUP_SNAPSHOT_TOO_LARGE);
  assert.throws(() => exportNdjsonConsistentStream(store, { maxSnapshotBytes: 1024 }), error => error.message === BACKUP_SNAPSHOT_TOO_LARGE);
});

test("chunked export emits the identical stream as staged parts and imports through the offline restore script", t => {
  const { directory, store } = openFixture(t);
  const partsDir = join(directory, "parts");
  mkdirSync(partsDir, { recursive: true });
  const result = exportChunkedToDirectory(store, partsDir, { partBytes: 2048 });
  assert.equal(result.status, "complete");
  assert.ok(result.parts > 4, `expected several parts, got ${result.parts}`);
  assert.equal(existsSync(join(partsDir, "progress.json")), false);

  const manifest = readChunkedManifest(partsDir);
  assert.equal(manifest.kind, "room-chunked-export-manifest");
  assert.equal(manifest.watermark.events, store.db.prepare("SELECT count(*) AS n FROM events").get().n);
  assert.equal(manifest.trailer.kind, "trailer");
  assert.ok(manifest.trailer.tables.events.rows > 0);

  // The reassembled parts are the single-file export, byte for byte,
  // apart from the watermark's backedUpAt timestamp.
  const assembledPath = join(directory, "assembled.ndjson");
  const assembled = assembleChunkedExport(partsDir, assembledPath);
  assert.equal(assembled.bytes, manifest.bytes);
  assert.equal(assembled.sha256, manifest.sha256);
  const direct = exportNdjsonText(store.db);
  const stripWatermark = text => text.split("\n").slice(1).join("\n");
  assert.equal(stripWatermark(readFileSync(assembledPath, "utf8")), stripWatermark(direct));

  // Import through the offline restore path the migration will use.
  const restoredPath = join(directory, "restored", "room.sqlite");
  const cli = execFileSync(process.execPath, [restoreScript, "--from-parts", partsDir, "--to", restoredPath, "--room", "commons"], { encoding: "utf8" });
  const receipt = JSON.parse(cli);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.contentVerification, "full");
  assert.equal(receipt.trailer, "verified");
  assert.equal(receipt.audit.ok, true);
  assert.equal(receipt.chunked.parts, result.parts);
  assert.equal(receipt.chunked.sha256, manifest.sha256);

  const restored = new RoomStore(restoredPath, { readOnly: true });
  try {
    // Per-table record counts match the source for every table the
    // replay loads (skipped tables are named in the restore receipt).
    const before = tableCounts(store.db);
    const after = tableCounts(restored.db);
    for (const [table, count] of Object.entries(before)) {
      if (receipt.skippedTables && Object.hasOwn(receipt.skippedTables, table)) continue;
      if (table === "room_backup_export_parts") continue;
      assert.equal(after[table], count, `table ${table}`);
    }
    // The completed task and its receipt read back identically.
    const expectedItem = store.room("commons").state.workItems.w1;
    const restoredItem = restored.room("commons").state.workItems.w1;
    assert.deepEqual(restoredItem, expectedItem);
    assert.equal(sha(JSON.stringify(restoredItem.receipt)), sha(JSON.stringify(expectedItem.receipt)));
    // Access boundaries: membership is restored as exported, not
    // widened — the restored member set and the account↔member mapping
    // are exactly the exported ones.
    assert.deepEqual(restored.room("commons").state.members, store.room("commons").state.members);
    assert.deepEqual(
      restored.db.prepare("SELECT * FROM member_accounts ORDER BY member_id, account_id").all(),
      store.db.prepare("SELECT * FROM member_accounts ORDER BY member_id, account_id").all());
  } finally { restored.close(); }
});

test("chunked export is resumable: an interrupted run finishes without re-writing parts, and refuses a changed source", t => {
  const { directory, store, key } = openFixture(t);
  const partsDir = join(directory, "parts");
  mkdirSync(partsDir, { recursive: true });
  const first = exportChunkedToDirectory(store, partsDir, { partBytes: 2048, maxPartsPerRun: 2 });
  assert.equal(first.status, "incomplete");
  assert.equal(first.parts, 2);
  assert.equal(existsSync(join(partsDir, "manifest.json")), false);
  assert.equal(existsSync(join(partsDir, "progress.json")), true);
  const partZeroBefore = readFileSync(join(partsDir, "part-000000.ndjson"));

  const done = exportChunkedToDirectory(store, partsDir, { partBytes: 2048 });
  assert.equal(done.status, "complete");
  assert.deepEqual(readFileSync(join(partsDir, "part-000000.ndjson")), partZeroBefore);

  // A fresh interrupted export whose source then changes must refuse to
  // splice the two snapshots together.
  const changedDir = join(directory, "changed");
  mkdirSync(changedDir, { recursive: true });
  const partial = exportChunkedToDirectory(store, changedDir, { partBytes: 2048, maxPartsPerRun: 1 });
  assert.equal(partial.status, "incomplete");
  store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { body: "written between interruption and resume" } });
  assert.throws(() => exportChunkedToDirectory(store, changedDir, { partBytes: 2048 }),
    error => error.message === CHUNKED_EXPORT_RESUME_SOURCE_CHANGED);
});

test("assembly refuses a tampered part by name", t => {
  const { directory, store } = openFixture(t);
  const partsDir = join(directory, "parts");
  mkdirSync(partsDir, { recursive: true });
  exportChunkedToDirectory(store, partsDir, { partBytes: 2048 });
  const partPath = join(partsDir, "part-000001.ndjson");
  const bytes = readFileSync(partPath);
  bytes[0] ^= 0xff;
  writeFileSync(partPath, bytes);
  assert.throws(() => assembleChunkedExport(partsDir, join(directory, "out.ndjson")),
    error => error.message === CHUNKED_EXPORT_PART_MISMATCH);
  assert.equal(existsSync(join(partsDir, "manifest.json")), true);
});
