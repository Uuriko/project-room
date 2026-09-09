import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { RoomStore } from "../server/store.mjs";

// Trusted local operator tool; no account identities, invitation contents, or secrets
// are printed. Opening read-only never runs a migration or repairs a projection.
const { values } = parseArgs({ options: { db: { type: "string" } } });
let store;
try {
  store = new RoomStore(resolve(values.db || process.env.ROOM_DB || ".data/room.sqlite"), { readOnly: true });
  const result = store.verifyInvitationAudit();
  process.stdout.write(`${JSON.stringify({ ...result, completeJournalHistory: result.legacyBaselines === 0 })}\n`);
} catch {
  process.stderr.write("Invitation audit could not establish consistency. No repair was attempted. Keep the service closed and reconcile with a consistent backup; a schema-v8 database is required.\n");
  process.exitCode = 1;
} finally { store?.close(); }
