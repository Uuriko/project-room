import { parseArgs } from "node:util";
import { backupRoom } from "../server/backup.mjs";

const { values } = parseArgs({ options: { db: { type: "string" }, to: { type: "string" } } });
process.umask(0o077);
try {
  if (!values.to || !(values.db || process.env.ROOM_DB)) throw new Error("Missing backup paths");
  const result = await backupRoom(values.db || process.env.ROOM_DB, values.to);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write("Backup failed verification. Live data was not replaced. Inspect the private destination before retrying.\n");
  process.exitCode = 1;
}
