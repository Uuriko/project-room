import { backup, DatabaseSync } from "node:sqlite";
import { chmodSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RoomStore } from "./store.mjs";
import { auditRecovery } from "./recovery.mjs";
import { markRestoredUnreconciled } from "./restore-reconcile.mjs";

// REL-14: content digests, so a restore proves byte equality instead of
// matching row counts only. events: every row in (room_id, sequence) order.
// attachments: every room_attachments row with a hash of its stored bytes;
// `mismatched` counts rows whose bytes no longer hash to their sha256 column.
export function backupDigests(db) {
  const events = createHash("sha256");
  let eventRows = 0;
  for (const row of db.prepare("SELECT room_id, sequence, id, body FROM events ORDER BY room_id, sequence").iterate()) {
    events.update(JSON.stringify([row.room_id, row.sequence, row.id, row.body]) + "\n");
    eventRows++;
  }
  const files = createHash("sha256");
  let fileRows = 0, fileBytes = 0, mismatched = 0;
  const hasFiles = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='room_attachments'").get();
  if (hasFiles) {
    for (const row of db.prepare("SELECT room_id, id, state, byte_length, sha256, bytes FROM room_attachments ORDER BY room_id, id").iterate()) {
      const content = row.bytes == null ? null : createHash("sha256").update(row.bytes).digest("hex");
      if (content !== null && content !== row.sha256) mismatched++;
      files.update(JSON.stringify([row.room_id, row.id, row.state, row.byte_length, row.sha256, content]) + "\n");
      fileRows++;
      fileBytes += row.bytes == null ? 0 : row.bytes.length;
    }
  }
  return { events: { rows: eventRows, sha256: events.digest("hex") },
    attachments: { rows: fileRows, bytes: fileBytes, mismatched, sha256: files.digest("hex") } };
}

// Fresh private destination only; never overwrite or restore into the live DB.
export async function backupRoom(source, destinationDirectory) {
  const input = realpathSync(source);
  const directory = realpathSync(destinationDirectory);
  if (!statSync(input).isFile() || !statSync(directory).isDirectory()) throw new Error("Backup requires an existing database and destination directory");
  const destination = mkdtempSync(join(directory, "room-backup-"));
  chmodSync(destination, 0o700);
  const filename = join(destination, "room.sqlite");
  const db = new DatabaseSync(input, { readOnly: true });
  try { await backup(db, filename); } finally { db.close(); }
  chmodSync(filename, 0o600);
  let restored;
  try {
    restored = new RoomStore(filename, { readOnly: true });
    const recovery = auditRecovery(restored);
    const audit = restored.verifyInvitationAudit();
    // B5: every backup carries a watermark so a later restore can prove which
    // authority the snapshot knew about. Anything revoked after backedUpAt is
    // resurrected by a restore and must be reconciled, never trusted silently.
    const rooms = restored.db.prepare("SELECT id, sequence FROM rooms ORDER BY id").all();
    const events = restored.db.prepare("SELECT count(*) AS n FROM events").get().n;
    const digests = backupDigests(restored.db);
    if (digests.attachments.mismatched) throw new Error(`Backup holds ${digests.attachments.mismatched} attachment(s) whose bytes do not match their sha256`);
    const watermark = { version: 1, backedUpAt: Date.now(), rooms, events, digests };
    const sidecar = join(destination, "room-backup.json");
    writeFileSync(sidecar, JSON.stringify(watermark, null, 2));
    chmodSync(sidecar, 0o600);
    // IR-2: the copy is a restore source, so it carries the boot-lock
    // stamp — any store booted from this file is restored-unreconciled
    // until the gate (or the operator's acknowledgement) reconciles it.
    // The live source DB is never stamped. The digests above are
    // computed before the stamp and do not cover the state table.
    const stampDb = new DatabaseSync(filename);
    try { markRestoredUnreconciled(stampDb, watermark.backedUpAt); } finally { stampDb.close(); }
    return { filename, watermark: sidecar, verified: true, ...audit, recovery };
  } finally { restored?.close(); }
}

// The reconciliation — IR-1's class table, the pre-restore authority
// extract, the IR-2 gate and the boot-lock state — lives in
// server/restore-reconcile.mjs, which is runtime-safe: the gate runs it
// inside the Durable Object restore paths, where this module's
// node:sqlite cannot load. The two IR-1 names are re-exported so
// node-side callers (the restore rehearsal, the coverage suite) keep
// their import surface.
export { reconcileRestoredAuthority, RECONCILE_CLASS_KINDS } from "./restore-reconcile.mjs";
