// REL-14 (hard work loop, Fo 3742): backups must restore byte for byte, on
// events and on room files, and verification must notice when they don't.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { registerWriter } from "../server/writer-fence.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { backupRoom, backupDigests } from "../server/backup.mjs";
import { exportNdjsonText, replayNdjson } from "../server/room-export.mjs";
import { verifyRestoredBackup } from "../scripts/backup-verify.mjs";

const run = promisify(execFile);
const checkout = fileURLToPath(new URL("..", import.meta.url));
const FILE_BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A closed room with messages and one staged room file holding every byte value.
function roomWithFile(t) {
  const filename = join(tempDir(t, "rel14-room-"), "room.sqlite");
  const store = new RoomStore(filename);
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  for (let i = 0; i < 3; i++) store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: `rel14 message ${i}` } });
  store.roomAttachments.stage(key, "commons", { id: "rel14-file", filename: "rel14.bin",
    mediaType: "application/octet-stream", data: FILE_BYTES.toString("base64") });
  const digests = backupDigests(store.db);
  store.close();
  return { filename, digests };
}

test("NDJSON export of a room holding a file replays, and events and file bytes come back equal", t => {
  const { filename, digests } = roomWithFile(t);
  const live = new RoomStore(filename, { readOnly: true });
  const text = exportNdjsonText(live.db);
  live.close();
  const target = join(tempDir(t, "rel14-replay-"), "replayed.sqlite");
  const result = replayNdjson(text, target);
  assert.equal(result.verified, true);
  const replayed = new RoomStore(target, { readOnly: true });
  t.after(() => replayed.close());
  assert.deepEqual(backupDigests(replayed.db), digests);
  const row = replayed.db.prepare("SELECT bytes FROM room_attachments WHERE id='rel14-file'").get();
  assert.ok(Buffer.from(row.bytes).equals(FILE_BYTES));
});

test("replay refuses an object cell that is not an encoded BLOB, by name", t => {
  const { filename } = roomWithFile(t);
  const live = new RoomStore(filename, { readOnly: true });
  const text = exportNdjsonText(live.db).replace(/\{"\$base64":"[^"]*"\}/, '{"0":1,"1":2}');
  live.close();
  assert.throws(() => replayNdjson(text, join(tempDir(t, "rel14-bad-"), "r.sqlite")), /not an encoded BLOB/);
});

// Instinct-3 4534: a tampered $base64 must not verify. Same length, one byte
// flipped, so only the sha256 check can catch it; then a shorter BLOB, then junk.
test("replay refuses a tampered BLOB by its stored sha256 and byte_length", t => {
  const { filename } = roomWithFile(t);
  const live = new RoomStore(filename, { readOnly: true });
  const text = exportNdjsonText(live.db);
  live.close();
  const swap = bytes => text.replace(/\{"\$base64":"[^"]*"\}/, JSON.stringify({ $base64: bytes.toString("base64") }));
  const flipped = Buffer.from(FILE_BYTES); flipped[7] ^= 0xff;
  assert.throws(() => replayNdjson(swap(flipped), join(tempDir(t, "rel14-tamper-"), "r.sqlite")), /bytes do not match its sha256/);
  assert.throws(() => replayNdjson(swap(FILE_BYTES.subarray(1)), join(tempDir(t, "rel14-short-"), "r.sqlite")), /bytes do not match its byte_length/);
  const junk = text.replace(/\{"\$base64":"([^"]*)"\}/, (_, b) => JSON.stringify({ $base64: b.slice(0, 8) + "*" + b.slice(8) }));
  assert.throws(() => replayNdjson(junk, join(tempDir(t, "rel14-junk-"), "r.sqlite")), /not canonical base64/);
});

async function backupOf(t, filename) {
  const result = await backupRoom(filename, tempDir(t, "rel14-dest-"));
  assert.equal(result.verified, true);
  return result;
}

test("a clean backup verifies with byte checks, and its watermark carries the live digests", async t => {
  const { filename, digests } = roomWithFile(t);
  const result = await backupOf(t, filename);
  const verification = await verifyRestoredBackup({ backupFilename: result.filename, watermarkPath: result.watermark });
  assert.equal(verification.ok, true, JSON.stringify(verification.checks.filter(c => !c.ok)));
  assert.deepEqual(verification.watermark.digests, digests);
  for (const name of ["events-bytes-match-watermark", "attachments-bytes-match-watermark", "attachment-bytes-intact"])
    assert.ok(verification.checks.some(c => c.name === name && c.ok), name);
});

test("verification fails when an event body changes but the event count does not", async t => {
  const { filename } = roomWithFile(t);
  const result = await backupOf(t, filename);
  // Tamper as a supported writer would (the writer fence refuses anyone else).
  const db = new DatabaseSync(result.filename);
  registerWriter(db);
  db.prepare("UPDATE events SET body = replace(body, 'rel14 message 1', 'rel14 message X') WHERE body LIKE '%rel14 message 1%'").run();
  db.close();
  const verification = await verifyRestoredBackup({ backupFilename: result.filename, watermarkPath: result.watermark });
  assert.equal(verification.ok, false);
  assert.ok(verification.checks.some(c => c.name === "events-bytes-match-watermark" && !c.ok));
});

test("verification fails when room file bytes change at the same length", async t => {
  const { filename } = roomWithFile(t);
  const result = await backupOf(t, filename);
  const db = new DatabaseSync(result.filename);
  registerWriter(db);
  const flipped = Buffer.from(FILE_BYTES); flipped[7] ^= 0xff;
  db.prepare("UPDATE room_attachments SET bytes = ? WHERE id = 'rel14-file'").run(flipped);
  db.close();
  const verification = await verifyRestoredBackup({ backupFilename: result.filename, watermarkPath: result.watermark });
  assert.equal(verification.ok, false);
  assert.ok(verification.checks.some(c => c.name === "attachment-bytes-intact" && !c.ok));
  assert.ok(verification.checks.some(c => c.name === "attachments-bytes-match-watermark" && !c.ok));
});

test("the drill covers room files and proves byte equality", async () => {
  const { stdout } = await run(process.execPath, [join(checkout, "scripts", "backup-drill.mjs")], { cwd: checkout });
  const line = stdout.trim().split("\n").filter(l => l.startsWith('{"ok"')).pop();
  const report = JSON.parse(line);
  assert.equal(report.ok, true);
  assert.equal(report.before.files, 1);
  assert.deepEqual(report.after, report.before);
});
