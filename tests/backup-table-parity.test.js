// QA200-MUT-22 Probe A hardening: backup/restore table-by-table parity.
//
// Authoring gate (test-audit):
// 1. Invariant: backupRoom produces a faithful full copy — every user
//    table's rows must be identical between source and backup. A silent
//    per-table row drop is a corrupt backup that restore would present as
//    healthy.
// 2. Credible regression: backup transport switched to a partial or
//    table-filtered copy; a future allowlist/incremental backup excludes
//    tables; misuse of the sqlite backup API.
// 3. Existing coverage gap: the watermark pins only the `events` count and
//    `rooms` id/sequence; REL-14 digests cover events + attachment bytes;
//    backup-drill compares those only. Mutation probe (2026-10-08): with
//    backupRoom silently dropping every `messages` row, all 31 tests in
//    backup-verify + room-backup-export + rel14-backup-bytes passed.
// 4. No production seam: public backupRoom plus read-only sqlite comparison.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { backupRoom } from "../server/backup.mjs";

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A closed room with rows spread across tables the watermark does NOT pin:
// messages, attachments, credentials, member rows.
function liveDb(t) {
  const filename = join(tempDir(t, "parity-room-"), "room.sqlite");
  const store = new RoomStore(filename);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  for (let i = 0; i < 3; i++) {
    store.command(owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
      data: { messageId: randomUUID(), body: `parity message ${i}` } });
  }
  store.command(owner, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "parity-member", displayName: "Parity", kind: "agent", permissions: [] } });
  const memberKey = store.issueAccessKey("commons", "parity-member");
  assert.ok(memberKey, "member key issued");
  store.roomAttachments.stage(owner, "commons", { id: "parity-file", filename: "parity.txt",
    mediaType: "text/plain", data: Buffer.from("parity-bytes").toString("base64") });
  assert.ok(store.db.prepare("SELECT count(*) AS n FROM messages").get().n >= 3, "messages table populated");
  assert.ok(store.db.prepare("SELECT count(*) AS n FROM room_attachments").get().n >= 1, "attachments table populated");
  store.close();
  return filename;
}

function tableSnapshot(db) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(r => r.name);
  const snapshot = {};
  for (const name of tables) {
    const rows = db.prepare(`SELECT * FROM "${name}"`).all()
      .map(row => JSON.stringify(row)).sort();
    snapshot[name] = {
      count: rows.length,
      sha256: createHash("sha256").update(rows.join("\n")).digest("hex"),
    };
  }
  return snapshot;
}

function openReadOnly(t, filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  t.after(() => db.close());
  return db;
}

test("backup is a faithful full copy: every table's rows match the source", async t => {
  const source = liveDb(t);
  const result = await backupRoom(source, tempDir(t, "parity-dest-"));
  assert.equal(result.verified, true, "backup self-verification passes");

  const before = tableSnapshot(openReadOnly(t, source));
  const after = tableSnapshot(openReadOnly(t, result.filename));

  const beforeTables = Object.keys(before).sort();
  const afterTables = Object.keys(after).sort();
  assert.deepEqual(afterTables, beforeTables, "backup carries the same tables as the source");

  const drifted = beforeTables.filter(name =>
    before[name].count !== after[name].count || before[name].sha256 !== after[name].sha256);
  assert.deepEqual(drifted, [], `tables with row drift: ${drifted.map(name =>
    `${name} (source ${before[name].count} rows -> backup ${after[name].count} rows)`).join(", ")}`);
});
