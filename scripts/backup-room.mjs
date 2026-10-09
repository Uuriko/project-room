import { parseArgs } from "node:util";
import { backupRoom } from "../server/backup.mjs";

let values;
try {
  ({ values } = parseArgs({ options: { db: { type: "string" }, to: { type: "string" } } }));
} catch {
  process.stderr.write("Usage: node scripts/backup-room.mjs --to <destination> [--db <path>] (or ROOM_DB)\n");
  process.exit(2);
}
process.umask(0o077);
// Missing backup paths are a usage error, not a failed verification —
// no backup was attempted, so the verification wording below does not apply.
if (!values.to || !(values.db || process.env.ROOM_DB)) {
  process.stderr.write("Usage: node scripts/backup-room.mjs --to <destination> [--db <path>] (or ROOM_DB)\n");
  process.exit(2);
}
try {
  const result = await backupRoom(values.db || process.env.ROOM_DB, values.to);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write("Backup failed verification. Live data was not replaced. Inspect the private destination before retrying.\n");
  process.exitCode = 1;
}
