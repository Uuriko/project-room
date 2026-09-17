import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { RoomStore } from "../server/store.mjs";

// Trusted local operator tool; no account identities, invitation contents, or secrets
// are printed. Opening read-only never runs a migration or repairs a projection.
const { values } = parseArgs({ options: { db: { type: "string" }, help: { type: "boolean" } } });
if (values.help) {
  console.log(`node scripts/audit-invitations.mjs [--db <path>] [--help]

Verifies the invitation audit journal for consistency (read-only).
No repair is attempted; a schema-v8 database is required.

Options:
  --db <path>   SQLite database path (default: $ROOM_DB or .data/room.sqlite)
  --help        Show this help.`);
  process.exit(0);
}
let store;
try {
  store = new RoomStore(resolve(values.db || process.env.ROOM_DB || ".data/room.sqlite"), { readOnly: true });
  const result = store.verifyInvitationAudit();
  process.stdout.write(`${JSON.stringify({ ...result, completeJournalHistory: result.legacyBaselines === 0 })}\n`);
} catch {
  process.stderr.write("Invitation audit could not establish consistency. No repair was attempted. Keep the service closed and reconcile with a consistent backup; a schema-v8 database is required.\n");
  process.exitCode = 1;
} finally { store?.close(); }
