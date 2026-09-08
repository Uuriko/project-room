import { backup, DatabaseSync } from "node:sqlite";
import { chmodSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { RoomStore } from "./store.mjs";

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
    if (restored.db.prepare("PRAGMA quick_check").get().quick_check !== "ok"
      || restored.db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Backup consistency check failed");
    const audit = restored.verifyInvitationAudit();
    return { filename, verified: true, ...audit };
  } finally { restored?.close(); }
}
